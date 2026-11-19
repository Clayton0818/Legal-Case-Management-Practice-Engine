// c74 — fetches the raw rows behind the conversion-funnel report and
// reduces them into the flat shapes ./funnel.ts's pure functions take.
//
// Aggregation happens in application code rather than a single grouped SQL
// query, the same convention src/app/admin/_lib/queries.ts#getInsightsForTenant
// documents for the c33 insights page: a firm's own lead volume is small
// enough that this is simpler to read, keeps every number derived from the
// same fetch, and — the point that matters most here — keeps the actual
// funnel/conversion/lost-reason logic in plain, unit-tested TypeScript
// (funnel.test.ts) instead of buried in SQL nobody can unit-test.
//
// Internal only: every exported function here returns aggregate buckets or
// a single session's own attribution record — never a cross-session list
// of identifying lead details. See docs/go-to-market/lead-source-attribution.md.

import { and, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { intakeSessions, matters, users } from "@/db/schema";
import {
  intakeConsultations,
  intakeFitEvaluations,
  intakeFollowUpRuns,
  intakeLeadAttribution,
  intakeMatterOpenings,
  intakeSessionState,
} from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import {
  buildAttributionFunnelReport,
  buildLeadFunnelRows,
  type AttributionFunnelReport,
  type LeadFunnelRow,
  type SessionFunnelInput,
} from "./funnel";
import type { LeadAttributionRecord } from "./model";

export interface AttributionReportFilters {
  /** Inclusive lower bound on intake_sessions.started_at. */
  from?: Date | null;
  /** Inclusive upper bound on intake_sessions.started_at. */
  to?: Date | null;
}

interface MatterFacts {
  id: string;
  stage: string;
  practiceArea: string | null;
  assignedUserId: string | null;
}

async function fetchMattersByIds(tx: TenantTx, tenantId: string, matterIds: readonly string[]): Promise<MatterFacts[]> {
  if (matterIds.length === 0) return [];
  return tx
    .select({ id: matters.id, stage: matters.stage, practiceArea: matters.practiceArea, assignedUserId: matters.assignedUserId })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), inArray(matters.id, [...matterIds])));
}

async function fetchRetainedAtByMatterId(tx: TenantTx, tenantId: string, matterIds: readonly string[]): Promise<Map<string, Date>> {
  if (matterIds.length === 0) return new Map();
  const rows = await tx
    .select({ matterId: intakeMatterOpenings.matterId, retainedAt: intakeMatterOpenings.retainedAt })
    .from(intakeMatterOpenings)
    .where(and(eq(intakeMatterOpenings.tenantId, tenantId), inArray(intakeMatterOpenings.matterId, [...matterIds])));
  return new Map(rows.map((r) => [r.matterId, r.retainedAt]));
}

function groupBySessionId<T extends { intakeSessionId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.intakeSessionId) ?? [];
    list.push(row);
    grouped.set(row.intakeSessionId, list);
  }
  return grouped;
}

/** Fetch every raw fact the funnel needs and reduce it into one row per intake session. Returns [] rather than querying at all when no session matches the date filter. */
export async function fetchLeadFunnelRows(tx: TenantTx, tenantId: string, filters: AttributionReportFilters = {}): Promise<LeadFunnelRow[]> {
  const sessionConditions: SQL[] = [eq(intakeSessions.tenantId, tenantId)];
  if (filters.from) sessionConditions.push(gte(intakeSessions.startedAt, filters.from));
  if (filters.to) sessionConditions.push(lte(intakeSessions.startedAt, filters.to));

  const sessions = await tx
    .select({ id: intakeSessions.id, startedAt: intakeSessions.startedAt, matterId: intakeSessions.matterId })
    .from(intakeSessions)
    .where(and(...sessionConditions));

  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id);
  const matterIds = [...new Set(sessions.map((s) => s.matterId).filter((id): id is string => id !== null))];

  const [states, attributions, fitEvals, consultations, followUps, mattersRows, retainedAtByMatterId] = await Promise.all([
    tx
      .select({
        intakeSessionId: intakeSessionState.intakeSessionId,
        status: intakeSessionState.status,
        firstHumanContactByUserId: intakeSessionState.firstHumanContactByUserId,
      })
      .from(intakeSessionState)
      .where(and(eq(intakeSessionState.tenantId, tenantId), inArray(intakeSessionState.intakeSessionId, sessionIds))),
    tx
      .select({
        intakeSessionId: intakeLeadAttribution.intakeSessionId,
        landingPage: intakeLeadAttribution.landingPage,
        campaignTag: intakeLeadAttribution.campaignTag,
        isGoogleAds: intakeLeadAttribution.isGoogleAds,
        directoryName: intakeLeadAttribution.directoryName,
        referralSource: intakeLeadAttribution.referralSource,
        phoneTrackingNumber: intakeLeadAttribution.phoneTrackingNumber,
      })
      .from(intakeLeadAttribution)
      .where(and(eq(intakeLeadAttribution.tenantId, tenantId), inArray(intakeLeadAttribution.intakeSessionId, sessionIds))),
    tx
      .select({
        intakeSessionId: intakeFitEvaluations.intakeSessionId,
        createdAt: intakeFitEvaluations.createdAt,
        outcome: intakeFitEvaluations.outcome,
        reasons: intakeFitEvaluations.reasons,
      })
      .from(intakeFitEvaluations)
      .where(and(eq(intakeFitEvaluations.tenantId, tenantId), inArray(intakeFitEvaluations.intakeSessionId, sessionIds))),
    tx
      .select({
        intakeSessionId: intakeConsultations.intakeSessionId,
        createdAt: intakeConsultations.createdAt,
        startsAt: intakeConsultations.startsAt,
        status: intakeConsultations.status,
        outcome: intakeConsultations.outcome,
        cancelReason: intakeConsultations.cancelReason,
        lawyerUserId: intakeConsultations.lawyerUserId,
        feeCents: intakeConsultations.feeCents,
      })
      .from(intakeConsultations)
      .where(and(eq(intakeConsultations.tenantId, tenantId), inArray(intakeConsultations.intakeSessionId, sessionIds))),
    tx
      .select({
        intakeSessionId: intakeFollowUpRuns.intakeSessionId,
        status: intakeFollowUpRuns.status,
        stoppedReason: intakeFollowUpRuns.stoppedReason,
        startedAt: intakeFollowUpRuns.startedAt,
      })
      .from(intakeFollowUpRuns)
      .where(and(eq(intakeFollowUpRuns.tenantId, tenantId), inArray(intakeFollowUpRuns.intakeSessionId, sessionIds))),
    fetchMattersByIds(tx, tenantId, matterIds),
    fetchRetainedAtByMatterId(tx, tenantId, matterIds),
  ]);

  const stateBySession = new Map(states.map((s) => [s.intakeSessionId, s]));
  const attributionBySession = new Map(attributions.map((a) => [a.intakeSessionId, a]));
  const matterById = new Map(mattersRows.map((m) => [m.id, m]));
  const fitBySession = groupBySessionId(fitEvals);
  const consultBySession = groupBySessionId(consultations);
  const followUpBySession = groupBySessionId(followUps);

  const inputs: SessionFunnelInput[] = sessions.map((s) => {
    const matter = s.matterId ? matterById.get(s.matterId) ?? null : null;
    const state = stateBySession.get(s.id) ?? null;
    const attributionRow = attributionBySession.get(s.id) ?? null;
    const attribution: LeadAttributionRecord | null = attributionRow
      ? {
          landingPage: attributionRow.landingPage,
          campaignTag: attributionRow.campaignTag,
          isGoogleAds: attributionRow.isGoogleAds,
          directoryName: attributionRow.directoryName,
          referralSource: attributionRow.referralSource,
          phoneTrackingNumber: attributionRow.phoneTrackingNumber,
        }
      : null;

    const stoppedRuns = (followUpBySession.get(s.id) ?? [])
      .filter((r) => r.status === "stopped" && r.stoppedReason)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    return {
      intakeSessionId: s.id,
      startedAt: s.startedAt,
      sessionStatus: state?.status ?? "active",
      matterId: s.matterId,
      matterStage: matter?.stage ?? null,
      practiceArea: matter?.practiceArea ?? null,
      matterAssignedUserId: matter?.assignedUserId ?? null,
      firstHumanContactByUserId: state?.firstHumanContactByUserId ?? null,
      attribution,
      fitEvaluations: fitBySession.get(s.id) ?? [],
      consultations: consultBySession.get(s.id) ?? [],
      retainedAt: s.matterId ? retainedAtByMatterId.get(s.matterId) ?? null : null,
      followUpStoppedReason: stoppedRuns[0]?.stoppedReason ?? null,
    };
  });

  return buildLeadFunnelRows(inputs);
}

export interface AttributionReport extends AttributionFunnelReport {
  generatedAt: string;
  filters: AttributionReportFilters;
  /** Display names for every staffUserId referenced in byStaff, resolved in one extra query so the pure funnel layer never needs to know about `users`. */
  staffNames: Record<string, string>;
}

export async function fetchLeadAttributionReport(tx: TenantTx, tenantId: string, filters: AttributionReportFilters = {}): Promise<AttributionReport> {
  const rows = await fetchLeadFunnelRows(tx, tenantId, filters);
  const report = buildAttributionFunnelReport(rows);

  const staffIds = [...new Set(rows.map((r) => r.staffUserId).filter((id): id is string => id !== null))];
  const staffNames: Record<string, string> = {};
  if (staffIds.length > 0) {
    const staffRows = await tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, staffIds)));
    for (const u of staffRows) staffNames[u.id] = u.displayName;
  }

  return { ...report, generatedAt: new Date().toISOString(), filters, staffNames };
}
