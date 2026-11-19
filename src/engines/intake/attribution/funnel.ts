// c74 — the conversion-funnel computation itself: inquiry -> qualified ->
// consult booked -> consult held -> retained, plus time-to-retain and
// lost-lead reasons, aggregated by source, practice area and intake staff.
//
// Pure (no database, no Date.now()) by design: src/engines/intake/
// attribution/queries.ts fetches the raw rows and reduces them into the
// flat per-session shapes below; everything from there is plain data
// transformation, unit-tested in funnel.test.ts without a database. See
// docs/go-to-market/lead-source-attribution.md for the model this
// implements and src/app/admin/intake/attribution/page.tsx for the one
// place it's rendered.

import { deriveAttributionSource, type AttributionSource, type LeadAttributionRecord } from "./model";

export const FUNNEL_STAGES = ["inquiry", "qualified", "consult_booked", "consult_held", "retained"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** One lead, flattened to exactly what the funnel needs. */
export interface LeadFunnelRow {
  intakeSessionId: string;
  source: AttributionSource;
  /** 'unspecified' when the matter (or the matter itself) doesn't have one yet. */
  practiceArea: string;
  /** The intake staff member most responsible for this lead, if one is known. */
  staffUserId: string | null;
  inquiryAt: Date;
  qualifiedAt: Date | null;
  consultBookedAt: Date | null;
  consultHeldAt: Date | null;
  retainedAt: Date | null;
  /** Null while the lead is still active, or once it's retained. */
  lostReason: string | null;
  /** Best-effort fee signal (the consultation's own fee, when the firm charges one) — NOT the matter's retainer/fee value, which lives in billing-trust's own tables. See the doc for why. */
  consultFeeCents: number | null;
}

/** One fit-rule evaluation (c73), as much as the funnel needs. */
export interface FitEvaluationFacts {
  createdAt: Date;
  outcome: string;
  reasons: readonly string[];
}

/** One consultation (c67), as much as the funnel needs. */
export interface ConsultationFacts {
  createdAt: Date;
  startsAt: Date;
  status: string;
  outcome: string | null;
  cancelReason: string | null;
  lawyerUserId: string | null;
  feeCents: number | null;
}

/** Everything buildLeadFunnelRow needs about one intake session, already joined by the query layer. */
export interface SessionFunnelInput {
  intakeSessionId: string;
  startedAt: Date;
  /** intake_session_state.status. */
  sessionStatus: string;
  matterId: string | null;
  /** matters.stage — null when no matter has been opened for this session yet. */
  matterStage: string | null;
  practiceArea: string | null;
  matterAssignedUserId: string | null;
  firstHumanContactByUserId: string | null;
  attribution: LeadAttributionRecord | null;
  fitEvaluations: readonly FitEvaluationFacts[];
  consultations: readonly ConsultationFacts[];
  /** intake_matter_openings.retainedAt for this session's matter, if one was opened. */
  retainedAt: Date | null;
  /** The reason on the most recently stopped follow-up run, if any. */
  followUpStoppedReason: string | null;
}

/** A slot-hold that was never confirmed, or a hold that expired unused — neither one is "booked". */
const UNBOOKED_CONSULT_STATUSES = new Set(["held", "expired"]);

export interface LostReasonInput {
  retainedAt: Date | null;
  matterStage: string | null;
  latestFitOutcome: string | null;
  latestFitReasons: readonly string[];
  mostRecentDeclinedConsultOutcome: string | null;
  mostRecentConsultStatus: string | null;
  mostRecentConsultCancelReason: string | null;
  followUpStoppedReason: string | null;
  sessionStatus: string;
}

/**
 * Why a lead didn't (yet) retain, in order of how authoritative the signal
 * is. A matter's own stage (set by the pipeline/service.ts system moves) is
 * the most reliable signal once a matter exists; the fit/consultation/
 * follow-up/session-status signals below cover leads that never got that
 * far. Returns null for a lead that is either retained or still active —
 * "lost" is a specific, not a default, state.
 */
export function deriveLostReason(input: LostReasonInput): string | null {
  if (input.retainedAt) return null;
  switch (input.matterStage) {
    case "declined_conflict":
      return "declined_conflict";
    case "did_not_schedule":
      return "did_not_schedule";
    case "did_not_hire_referred_out":
      return "did_not_hire_referred_out";
    case "closed":
      return "closed_without_retaining";
    default:
      break;
  }
  if (input.latestFitOutcome === "no_fit") {
    return input.latestFitReasons.length > 0 ? `no_fit: ${input.latestFitReasons.join("; ")}` : "no_fit";
  }
  if (input.mostRecentDeclinedConsultOutcome) return input.mostRecentDeclinedConsultOutcome;
  if (input.mostRecentConsultStatus === "no_show") return "consult_no_show";
  if (input.mostRecentConsultStatus === "cancelled") {
    return input.mostRecentConsultCancelReason ? `consult_cancelled: ${input.mostRecentConsultCancelReason}` : "consult_cancelled";
  }
  if (input.followUpStoppedReason) return input.followUpStoppedReason;
  if (input.sessionStatus === "not_an_inquiry") return "not_an_inquiry";
  if (input.sessionStatus === "closed") return "session_closed";
  return null;
}

function earliest(dates: readonly Date[]): Date | null {
  return dates.length === 0 ? null : new Date(Math.min(...dates.map((d) => d.getTime())));
}

/** Build one funnel row from the raw facts the query layer gathered for a single intake session. */
export function buildLeadFunnelRow(input: SessionFunnelInput): LeadFunnelRow {
  const sortedFitAsc = [...input.fitEvaluations].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const qualifiedAt = sortedFitAsc.find((f) => f.outcome === "fit")?.createdAt ?? null;
  const latestFit = sortedFitAsc[sortedFitAsc.length - 1] ?? null;

  const bookedConsults = input.consultations.filter((c) => !UNBOOKED_CONSULT_STATUSES.has(c.status));
  const consultBookedAt = earliest(bookedConsults.map((c) => c.createdAt));
  const earliestBooked = [...bookedConsults].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;

  const heldConsults = input.consultations.filter((c) => c.status === "completed");
  const consultHeldAt = earliest(heldConsults.map((c) => c.startsAt));

  const consultsDesc = [...input.consultations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const mostRecentDeclined = consultsDesc.find((c) => c.outcome === "declined_by_firm" || c.outcome === "client_declined");
  const mostRecentNoShowOrCancelled = consultsDesc.find((c) => c.status === "no_show" || c.status === "cancelled");

  const withFeeAsc = [...input.consultations].filter((c) => c.feeCents !== null).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const consultFeeCents = withFeeAsc[0]?.feeCents ?? null;

  const lostReason = deriveLostReason({
    retainedAt: input.retainedAt,
    matterStage: input.matterStage,
    latestFitOutcome: latestFit?.outcome ?? null,
    latestFitReasons: latestFit?.reasons ?? [],
    mostRecentDeclinedConsultOutcome: mostRecentDeclined?.outcome ?? null,
    mostRecentConsultStatus: mostRecentNoShowOrCancelled?.status ?? null,
    mostRecentConsultCancelReason: mostRecentNoShowOrCancelled?.cancelReason ?? null,
    followUpStoppedReason: input.followUpStoppedReason,
    sessionStatus: input.sessionStatus,
  });

  return {
    intakeSessionId: input.intakeSessionId,
    source: deriveAttributionSource(input.attribution),
    practiceArea: input.practiceArea ?? "unspecified",
    staffUserId: earliestBooked?.lawyerUserId ?? input.matterAssignedUserId ?? input.firstHumanContactByUserId ?? null,
    inquiryAt: input.startedAt,
    qualifiedAt,
    consultBookedAt,
    consultHeldAt,
    retainedAt: input.retainedAt,
    lostReason,
    consultFeeCents,
  };
}

export function buildLeadFunnelRows(inputs: readonly SessionFunnelInput[]): LeadFunnelRow[] {
  return inputs.map(buildLeadFunnelRow);
}

/** How many leads in `rows` reached each stage (reaching a stage means that stage's timestamp is set — not strictly "and every earlier stage too", since a referral can walk in already consult-booked). */
export function computeFunnelCounts(rows: readonly LeadFunnelRow[]): Record<FunnelStage, number> {
  return {
    inquiry: rows.length,
    qualified: rows.filter((r) => r.qualifiedAt !== null).length,
    consult_booked: rows.filter((r) => r.consultBookedAt !== null).length,
    consult_held: rows.filter((r) => r.consultHeldAt !== null).length,
    retained: rows.filter((r) => r.retainedAt !== null).length,
  };
}

export interface StepConversionRate {
  from: FunnelStage;
  to: FunnelStage;
  /** to-count / from-count; 0 when from-count is 0. */
  rate: number;
}

export function computeStepConversionRates(counts: Record<FunnelStage, number>): StepConversionRate[] {
  const rates: StepConversionRate[] = [];
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i++) {
    const from = FUNNEL_STAGES[i];
    const to = FUNNEL_STAGES[i + 1];
    if (from === undefined || to === undefined) continue;
    const fromCount = counts[from];
    rates.push({ from, to, rate: fromCount === 0 ? 0 : counts[to] / fromCount });
  }
  return rates;
}

/** retained / inquiry; 0 when there were no inquiries. */
export function computeOverallConversionRate(counts: Record<FunnelStage, number>): number {
  return counts.inquiry === 0 ? 0 : counts.retained / counts.inquiry;
}

export interface TimeToRetainStats {
  count: number;
  averageDays: number | null;
  medianDays: number | null;
}

export function computeTimeToRetainStats(rows: readonly LeadFunnelRow[]): TimeToRetainStats {
  const days = rows
    .filter((r): r is LeadFunnelRow & { retainedAt: Date } => r.retainedAt !== null)
    .map((r) => (r.retainedAt.getTime() - r.inquiryAt.getTime()) / 86_400_000)
    // A retainedAt earlier than the inquiry is bad data (clock skew, a
    // back-dated record), not a negative time-to-retain — excluded rather
    // than letting it drag the average down.
    .filter((d) => d >= 0);
  if (days.length === 0) return { count: 0, averageDays: null, medianDays: null };
  const sum = days.reduce((a, b) => a + b, 0);
  const sorted = [...days].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  const medianDays = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? upper) + upper) / 2 : upper;
  return { count: days.length, averageDays: sum / days.length, medianDays };
}

export interface LostReasonCount {
  reason: string;
  count: number;
}

export function aggregateLostLeadReasons(rows: readonly LeadFunnelRow[]): LostReasonCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.lostReason) continue;
    counts.set(r.lostReason, (counts.get(r.lostReason) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export interface ConsultFeeValueStats {
  count: number;
  totalCents: number;
  averageCents: number | null;
}

/** Aggregate of the best-effort consultation fee signal — see LeadFunnelRow#consultFeeCents. */
export function aggregateConsultFeeValue(rows: readonly LeadFunnelRow[]): ConsultFeeValueStats {
  const withFee = rows.map((r) => r.consultFeeCents).filter((c): c is number => c !== null);
  const totalCents = withFee.reduce((a, b) => a + b, 0);
  return { count: withFee.length, totalCents, averageCents: withFee.length === 0 ? null : totalCents / withFee.length };
}

export interface FunnelBucket {
  key: string;
  counts: Record<FunnelStage, number>;
  stepConversionRates: StepConversionRate[];
  overallConversionRate: number;
  timeToRetain: TimeToRetainStats;
  lostReasons: LostReasonCount[];
  consultFeeValue: ConsultFeeValueStats;
}

export function buildFunnelBucket(key: string, rows: readonly LeadFunnelRow[]): FunnelBucket {
  const counts = computeFunnelCounts(rows);
  return {
    key,
    counts,
    stepConversionRates: computeStepConversionRates(counts),
    overallConversionRate: computeOverallConversionRate(counts),
    timeToRetain: computeTimeToRetainStats(rows),
    lostReasons: aggregateLostLeadReasons(rows),
    consultFeeValue: aggregateConsultFeeValue(rows),
  };
}

/** Group rows by `keyFn` and build a funnel bucket per group, busiest group first. */
export function groupLeadFunnelRows(rows: readonly LeadFunnelRow[], keyFn: (row: LeadFunnelRow) => string): FunnelBucket[] {
  const groups = new Map<string, LeadFunnelRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return Array.from(groups.entries())
    .map(([key, groupRows]) => buildFunnelBucket(key, groupRows))
    .sort((a, b) => b.counts.inquiry - a.counts.inquiry || a.key.localeCompare(b.key));
}

export interface AttributionFunnelReport {
  overall: FunnelBucket;
  bySource: FunnelBucket[];
  byPracticeArea: FunnelBucket[];
  /** Keyed by staffUserId, or the literal 'unassigned' when no staff member is known for that lead. */
  byStaff: FunnelBucket[];
}

export function buildAttributionFunnelReport(rows: readonly LeadFunnelRow[]): AttributionFunnelReport {
  return {
    overall: buildFunnelBucket("all", rows),
    bySource: groupLeadFunnelRows(rows, (r) => r.source),
    byPracticeArea: groupLeadFunnelRows(rows, (r) => r.practiceArea),
    byStaff: groupLeadFunnelRows(rows, (r) => r.staffUserId ?? "unassigned"),
  };
}
