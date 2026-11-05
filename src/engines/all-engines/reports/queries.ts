// c101 — "Reports across all engines", v1.
//
// SCOPE NOTE (read before extending this file): src/engines/README.md
// forbids an engine from importing another engine's own table file
// (@/db/tables/<other>) — cooperation only happens through src/db/schema.ts,
// src/db/tables/foundation.ts, or @/core/* modules. That boundary is why
// this report covers only metrics backed by genuinely SHARED data:
//
//   - matters by stage / practice area           -> @/db/schema matters
//   - overdue tasks                               -> @/db/tables/foundation tasks
//   - deadlines coming up                         -> @/db/tables/foundation calendarEvents
//   - conflict checks pending                     -> @/db/schema conflictCheckResults + intakeSessions
//
// The card (c101) also asks for billable hours/realization, unpaid invoices,
// trust balances (all live only in billing-trust's own tables,
// src/db/tables/billing-trust.ts) and lead conversion (c74, not yet built
// anywhere). None of those are computed here — see BLOCKED_METRICS below and
// the PR description for why, and for the cross-engine reporting read-model
// (each engine publishing a lightweight summary row into a new shared table)
// that would be needed to add them without breaking the engine boundary.

import { and, asc, eq, gte, isNull, lte, or, type SQL } from "drizzle-orm";
import { conflictCheckResults, intakeSessions, matters, matterStageEnum } from "@/db/schema";
import { calendarEvents, tasks } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";

export const MATTER_STAGE_VALUES = matterStageEnum.enumValues;
export type MatterStage = (typeof MATTER_STAGE_VALUES)[number];

export interface ReportFilters {
  /** Matches matters.assignedUserId (matter-based reports) or tasks.ownerUserId (task-based reports). */
  lawyerUserId?: string | null;
  practiceArea?: string | null;
  /** Inclusive lower bound, applied to each report's own date column (see each function). */
  from?: Date | null;
  /** Inclusive upper bound. */
  to?: Date | null;
}

export interface BlockedMetric {
  metric: string;
  reason: string;
}

/** Metrics c101 asks for that this v1 deliberately does not compute. See the file header. */
export const BLOCKED_METRICS: readonly BlockedMetric[] = [
  {
    metric: "billable_hours_and_realization",
    reason:
      "Lives only in billing-trust's own tables (src/engines/billing-trust, src/db/tables/billing-trust.ts timeEntries). " +
      "Reading it here would cross the engine-import boundary in src/engines/README.md. Needs a shared reporting read-model.",
  },
  {
    metric: "unpaid_invoices",
    reason: "Same as above — invoices live only in billing-trust's own tables.",
  },
  {
    metric: "trust_balances",
    reason: "Same as above — the trust ledger lives only in billing-trust's own tables.",
  },
  {
    metric: "lead_conversion",
    reason: "Depends on c74 (lead-source tracking), which is not built yet as of this PR — nothing to report on.",
  },
  {
    metric: "matter_health",
    reason:
      "c53's case-health meter is computed inside the calendar-alerts engine; not verified as a shared table in this PR, so left out " +
      "rather than guessed at. Worth confirming in a follow-up.",
  },
];

// ---------------------------------------------------------------------------
// Pure aggregation helpers (unit-testable without a database)
// ---------------------------------------------------------------------------

export interface StageCount {
  stage: MatterStage;
  count: number;
}

/** Every stage is included even at zero, so the shape is stable across firms (same convention as the c33 insights page). */
export function aggregateByStage(rows: readonly { stage: MatterStage }[]): StageCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1);
  return MATTER_STAGE_VALUES.map((stage) => ({ stage, count: counts.get(stage) ?? 0 }));
}

export interface PracticeAreaCount {
  practiceArea: string;
  count: number;
}

export function aggregateByPracticeArea(rows: readonly { practiceArea: string | null }[]): PracticeAreaCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.practiceArea ?? "unspecified";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([practiceArea, count]) => ({ practiceArea, count }))
    .sort((a, b) => b.count - a.count || a.practiceArea.localeCompare(b.practiceArea));
}

// ---------------------------------------------------------------------------
// Shared filter plumbing
// ---------------------------------------------------------------------------

function matterFilterConditions(tenantId: string, filters: ReportFilters, dateColumn: typeof matters.openedAt): SQL[] {
  const conditions: SQL[] = [eq(matters.tenantId, tenantId)];
  if (filters.lawyerUserId) conditions.push(eq(matters.assignedUserId, filters.lawyerUserId));
  if (filters.practiceArea) conditions.push(eq(matters.practiceArea, filters.practiceArea));
  if (filters.from) conditions.push(gte(dateColumn, filters.from));
  if (filters.to) conditions.push(lte(dateColumn, filters.to));
  return conditions;
}

// ---------------------------------------------------------------------------
// Matters by stage / practice area (date filter applies to matters.openedAt)
// ---------------------------------------------------------------------------

export async function fetchMattersByStage(tx: TenantTx, tenantId: string, filters: ReportFilters): Promise<StageCount[]> {
  const rows = await tx
    .select({ stage: matters.stage })
    .from(matters)
    .where(and(...matterFilterConditions(tenantId, filters, matters.openedAt)));
  return aggregateByStage(rows);
}

export async function fetchMattersByPracticeArea(tx: TenantTx, tenantId: string, filters: ReportFilters): Promise<PracticeAreaCount[]> {
  const rows = await tx
    .select({ practiceArea: matters.practiceArea })
    .from(matters)
    .where(and(...matterFilterConditions(tenantId, filters, matters.openedAt)));
  return aggregateByPracticeArea(rows);
}

// ---------------------------------------------------------------------------
// Overdue tasks (open, past due). Lawyer filter matches EITHER the task's own
// owner (ownerType 'user') or the matter it belongs to — a lawyer cares about
// both their own tasks and overdue work on matters assigned to them. Date
// filter applies to tasks.dueAt.
// ---------------------------------------------------------------------------

export interface OverdueTaskRow {
  taskId: string;
  title: string;
  kind: string;
  dueAt: Date;
  matterId: string | null;
  ownerUserId: string | null;
}

export async function fetchOverdueTasks(tx: TenantTx, tenantId: string, filters: ReportFilters, now: Date = new Date()): Promise<OverdueTaskRow[]> {
  const conditions: SQL[] = [eq(tasks.tenantId, tenantId), eq(tasks.status, "open"), lte(tasks.dueAt, now)];
  if (filters.from) conditions.push(gte(tasks.dueAt, filters.from));
  if (filters.to) conditions.push(lte(tasks.dueAt, filters.to));
  if (filters.practiceArea) conditions.push(eq(matters.practiceArea, filters.practiceArea));
  if (filters.lawyerUserId) {
    const lawyerId = filters.lawyerUserId;
    const lawyerCondition = or(eq(tasks.ownerUserId, lawyerId), eq(matters.assignedUserId, lawyerId));
    if (lawyerCondition) conditions.push(lawyerCondition);
  }

  const rows = await tx
    .select({
      taskId: tasks.id,
      title: tasks.title,
      kind: tasks.kind,
      dueAt: tasks.dueAt,
      matterId: tasks.matterId,
      ownerUserId: tasks.ownerUserId,
    })
    .from(tasks)
    .leftJoin(matters, eq(tasks.matterId, matters.id))
    .where(and(...conditions))
    .orderBy(asc(tasks.dueAt));

  return rows;
}

// ---------------------------------------------------------------------------
// Deadlines coming up (confirmed or proposed, not cancelled). Default
// window: now .. now + 30 days when no explicit from/to is given.
// ---------------------------------------------------------------------------

export interface UpcomingDeadlineRow {
  eventId: string;
  title: string;
  eventType: string;
  startsAt: Date;
  matterId: string | null;
  status: string;
}

const DEFAULT_DEADLINE_WINDOW_DAYS = 30;

export async function fetchUpcomingDeadlines(
  tx: TenantTx,
  tenantId: string,
  filters: ReportFilters,
  now: Date = new Date()
): Promise<UpcomingDeadlineRow[]> {
  const windowEnd = filters.to ?? new Date(now.getTime() + DEFAULT_DEADLINE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const windowStart = filters.from ?? now;

  const conditions: SQL[] = [
    eq(calendarEvents.tenantId, tenantId),
    eq(calendarEvents.isDeadline, true),
    gte(calendarEvents.startsAt, windowStart),
    lte(calendarEvents.startsAt, windowEnd),
  ];
  const notCancelled = or(eq(calendarEvents.status, "proposed"), eq(calendarEvents.status, "confirmed"));
  if (notCancelled) conditions.push(notCancelled);
  if (filters.practiceArea) conditions.push(eq(matters.practiceArea, filters.practiceArea));
  if (filters.lawyerUserId) conditions.push(eq(matters.assignedUserId, filters.lawyerUserId));

  const rows = await tx
    .select({
      eventId: calendarEvents.id,
      title: calendarEvents.title,
      eventType: calendarEvents.eventType,
      startsAt: calendarEvents.startsAt,
      matterId: calendarEvents.matterId,
      status: calendarEvents.status,
    })
    .from(calendarEvents)
    .leftJoin(matters, eq(calendarEvents.matterId, matters.id))
    .where(and(...conditions))
    .orderBy(asc(calendarEvents.startsAt));

  return rows;
}

// ---------------------------------------------------------------------------
// Conflict checks pending a human decision (outcome recorded, not yet
// resolved by a conflicts attorney — c59). Joins through intake_sessions to
// reach a matter for the lawyer/practice-area filters, since
// conflict_check_results carries intakeSessionId, not matterId, directly.
// Date filter applies to conflict_check_results.createdAt.
// ---------------------------------------------------------------------------

export interface PendingConflictCheckRow {
  resultId: string;
  roleSought: string;
  outcome: string;
  matterId: string | null;
  createdAt: Date;
}

export async function fetchPendingConflictChecks(tx: TenantTx, tenantId: string, filters: ReportFilters): Promise<PendingConflictCheckRow[]> {
  const conditions: SQL[] = [eq(conflictCheckResults.tenantId, tenantId), isNull(conflictCheckResults.resolvedAt)];
  if (filters.from) conditions.push(gte(conflictCheckResults.createdAt, filters.from));
  if (filters.to) conditions.push(lte(conflictCheckResults.createdAt, filters.to));
  if (filters.practiceArea) conditions.push(eq(matters.practiceArea, filters.practiceArea));
  if (filters.lawyerUserId) conditions.push(eq(matters.assignedUserId, filters.lawyerUserId));

  const rows = await tx
    .select({
      resultId: conflictCheckResults.id,
      roleSought: conflictCheckResults.roleSought,
      outcome: conflictCheckResults.outcome,
      matterId: intakeSessions.matterId,
      createdAt: conflictCheckResults.createdAt,
    })
    .from(conflictCheckResults)
    .innerJoin(intakeSessions, eq(conflictCheckResults.intakeSessionId, intakeSessions.id))
    .leftJoin(matters, eq(intakeSessions.matterId, matters.id))
    .where(and(...conditions))
    .orderBy(asc(conflictCheckResults.createdAt));

  return rows;
}

// ---------------------------------------------------------------------------
// Everything together, for the JSON report endpoint.
// ---------------------------------------------------------------------------

export interface CrossEngineReport {
  generatedAt: string;
  filters: ReportFilters;
  mattersByStage: StageCount[];
  mattersByPracticeArea: PracticeAreaCount[];
  overdueTasks: OverdueTaskRow[];
  deadlinesUpcoming: UpcomingDeadlineRow[];
  conflictChecksPending: PendingConflictCheckRow[];
  blocked: readonly BlockedMetric[];
}

export async function fetchCrossEngineReport(tx: TenantTx, tenantId: string, filters: ReportFilters): Promise<CrossEngineReport> {
  const [mattersByStage, mattersByPracticeArea, overdueTasks, deadlinesUpcoming, conflictChecksPending] = await Promise.all([
    fetchMattersByStage(tx, tenantId, filters),
    fetchMattersByPracticeArea(tx, tenantId, filters),
    fetchOverdueTasks(tx, tenantId, filters),
    fetchUpcomingDeadlines(tx, tenantId, filters),
    fetchPendingConflictChecks(tx, tenantId, filters),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    filters,
    mattersByStage,
    mattersByPracticeArea,
    overdueTasks,
    deadlinesUpcoming,
    conflictChecksPending,
    blocked: BLOCKED_METRICS,
  };
}
