// c106 — read-only snapshot of the current DEMO firm for the /demo page.
// Every query runs in the demo firm's own transaction (RLS) and filters by
// tenant_id as well (defence in depth). Callers must have checked the firm
// with assertDemoTenant() in the same transaction first — loadDemoSnapshot
// does it itself.

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { documents, firms, intakeSessions, matters, parties, users } from "@/db/schema";
import { calendarEvents, flags, notificationOutbox, tasks } from "@/db/tables/foundation";
import { conflictChecks, conflictDecisions } from "@/db/tables/conflict-check";
import { intakeConsultations, intakeEmergencyAlerts, intakeSessionState } from "@/db/tables/intake";
import { limitationDates } from "@/db/tables/calendar-core";
import { clientUpdates, courtNotices, matterHealthSnapshots, replyClocks } from "@/db/tables/calendar-alerts";
import { trustAccounts, trustReconciliations, trustSubledgers } from "@/db/tables/billing-trust";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertDemoTenant } from "./guard";
import { summarizeReport, type SeedReport, type StepRecord, type StepStatus } from "./runner";
import { DEMO_PROSPECTS, DEMO_STAFF } from "./fixtures";

export interface DemoSnapshot {
  tenantId: string;
  firmName: string;
  generation: number;
  seededAt: Date | null;
  seedVersion: string;
  summary: Record<StepStatus, number>;
  blockedSteps: StepRecord[];
  failedSteps: StepRecord[];
  ids: { matter: Record<string, string>; session: Record<string, string> };
  staff: Array<{ name: string; title: string; role: string; email: string }>;
  prospects: Array<{ name: string; status: string; channel: string; safetyFlagged: boolean; startedAt: Date }>;
  emergencies: Array<{ track: string; category: string; acknowledged: boolean; escalationStep: number }>;
  conflicts: Array<{ name: string; outcome: string; status: string; decision: string | null; ruleTableApplied: boolean }>;
  consultations: Array<{ lawyer: string; startsAt: Date; status: string; outcome: string | null }>;
  matters: Array<{ id: string; client: string; stage: string; practiceArea: string | null; lawyer: string | null }>;
  events: Array<{ title: string; status: string; startsAt: Date; source: string; isDeadline: boolean }>;
  limitations: Array<{ claim: string; date: string; status: string }>;
  documents: Array<{ name: string; version: number; status: string }>;
  trust: {
    accounts: Array<{ name: string; bank: string }>;
    subledgers: Array<{ client: string | null; balanceCents: string; heldCents: string }>;
    reconciliations: Array<{ period: string; status: string; differences: number; rulesApproved: boolean }>;
  };
  replyClocks: Array<{ tier: string; status: string; promiseAt: Date; immediateAlert: boolean }>;
  updates: Array<{ status: string; authorType: string; body: string }>;
  courtNotices: Array<{ subject: string; classification: string; status: string; matched: boolean }>;
  health: Array<{ client: string; score: number | null; band: string }>;
  ops: { openFlags: number; overdueTasks: number; heldNotifications: number };
}

const prospectName = (name: string | null) => name ?? "(name not given yet)";

export async function loadDemoSnapshot(tx: TenantTx, tenantId: string, now: Date = new Date()): Promise<DemoSnapshot> {
  const flag = await assertDemoTenant(tx, tenantId);
  const report = (flag.seedReport ?? { steps: [] }) as SeedReport;
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const [firm] = await tx.select({ name: firms.name }).from(firms).where(eq(firms.id, tenantId));
  const t = tenantId;

  const staffRows = await tx.select({ id: users.id, name: users.displayName, role: users.role, email: users.email }).from(users).where(eq(users.tenantId, t)).orderBy(asc(users.createdAt));
  const userName = new Map(staffRows.map((u) => [u.id, u.name]));

  const prospects = await tx
    .select({ name: parties.fullName, status: intakeSessionState.status, channel: intakeSessionState.channel, safetyFlagged: intakeSessionState.safetyFlagged, startedAt: intakeSessions.startedAt })
    .from(intakeSessionState)
    .innerJoin(intakeSessions, eq(intakeSessions.id, intakeSessionState.intakeSessionId))
    .leftJoin(parties, eq(parties.id, intakeSessionState.partyId))
    .where(eq(intakeSessionState.tenantId, t))
    .orderBy(desc(intakeSessions.startedAt));

  const emergencies = await tx
    .select({ track: intakeEmergencyAlerts.track, category: intakeEmergencyAlerts.category, ack: intakeEmergencyAlerts.acknowledgedAt, step: intakeEmergencyAlerts.escalationStep })
    .from(intakeEmergencyAlerts)
    .where(eq(intakeEmergencyAlerts.tenantId, t));

  const checks = await tx
    .select({ id: conflictChecks.id, sessionId: conflictChecks.intakeSessionId, outcome: conflictChecks.outcome, status: conflictChecks.status, ruleTableApplied: conflictChecks.ruleTableApplied, createdAt: conflictChecks.createdAt })
    .from(conflictChecks)
    .where(and(eq(conflictChecks.tenantId, t), eq(conflictChecks.trigger, "intake")))
    .orderBy(asc(conflictChecks.createdAt));
  const decisions = checks.length
    ? await tx.select({ checkId: conflictDecisions.checkId, decision: conflictDecisions.decision }).from(conflictDecisions).where(and(eq(conflictDecisions.tenantId, t), inArray(conflictDecisions.checkId, checks.map((c) => c.id))))
    : [];
  const sessionIds = report.ids?.sessions ?? {};
  const nameBySession = new Map(Object.entries(sessionIds).map(([key, id]) => [id, DEMO_PROSPECTS.find((p) => p.key === key)?.fullName ?? key]));

  const consultations = await tx
    .select({ lawyer: intakeConsultations.lawyerUserId, startsAt: intakeConsultations.startsAt, status: intakeConsultations.status, outcome: intakeConsultations.outcome })
    .from(intakeConsultations)
    .where(eq(intakeConsultations.tenantId, t));

  const matterRows = await tx
    .select({ id: matters.id, client: parties.fullName, stage: matters.stage, practiceArea: matters.practiceArea, lawyer: matters.assignedUserId })
    .from(matters)
    .leftJoin(parties, eq(parties.id, matters.primaryPartyId))
    .where(eq(matters.tenantId, t))
    .orderBy(asc(matters.openedAt));
  const clientByMatter = new Map(matterRows.map((m) => [m.id, m.client ?? "?"]));

  const events = await tx
    .select({ title: calendarEvents.title, status: calendarEvents.status, startsAt: calendarEvents.startsAt, source: calendarEvents.source, isDeadline: calendarEvents.isDeadline })
    .from(calendarEvents)
    .where(eq(calendarEvents.tenantId, t))
    .orderBy(asc(calendarEvents.startsAt));

  const lims = await tx
    .select({ claim: limitationDates.claimDescription, date: limitationDates.limitationDate, status: limitationDates.status })
    .from(limitationDates)
    .where(eq(limitationDates.tenantId, t));

  const docs = await tx
    .select({ name: documents.name, version: documents.version, status: documents.status })
    .from(documents)
    .where(eq(documents.tenantId, t))
    .orderBy(asc(documents.name), asc(documents.version));

  const accounts = await tx.select({ name: trustAccounts.name, bank: trustAccounts.bankName }).from(trustAccounts).where(eq(trustAccounts.tenantId, t));
  const subs = await tx
    .select({ client: parties.fullName, balance: trustSubledgers.balanceCents, held: trustSubledgers.heldCents })
    .from(trustSubledgers)
    .leftJoin(parties, eq(parties.id, trustSubledgers.clientPartyId))
    .where(eq(trustSubledgers.tenantId, t));
  const recs = await tx
    .select({ period: trustReconciliations.period, status: trustReconciliations.status, differences: trustReconciliations.differences, rulesApproved: trustReconciliations.rulesApproved })
    .from(trustReconciliations)
    .where(eq(trustReconciliations.tenantId, t));

  const clocks = await tx
    .select({ tier: replyClocks.tier, status: replyClocks.status, promiseAt: replyClocks.promiseAt, immediate: replyClocks.immediateAlertAt })
    .from(replyClocks)
    .where(eq(replyClocks.tenantId, t));
  const updates = await tx
    .select({ status: clientUpdates.status, authorType: clientUpdates.authorType, body: clientUpdates.body })
    .from(clientUpdates)
    .where(eq(clientUpdates.tenantId, t))
    .orderBy(desc(clientUpdates.createdAt));
  const notices = await tx
    .select({ subject: courtNotices.subject, classification: courtNotices.classification, status: courtNotices.status, matterId: courtNotices.matterId })
    .from(courtNotices)
    .where(eq(courtNotices.tenantId, t));
  const health = await tx
    .selectDistinctOn([matterHealthSnapshots.matterId], { matterId: matterHealthSnapshots.matterId, score: matterHealthSnapshots.score, band: matterHealthSnapshots.band })
    .from(matterHealthSnapshots)
    .where(eq(matterHealthSnapshots.tenantId, t))
    .orderBy(matterHealthSnapshots.matterId, desc(matterHealthSnapshots.computedAt));

  const count = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);
  const openFlags = await count(tx.select({ n: sql<number>`count(*)::int` }).from(flags).where(and(eq(flags.tenantId, t), isNull(flags.resolvedAt))));
  const overdueTasks = await count(tx.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.tenantId, t), eq(tasks.status, "open"), lt(tasks.dueAt, now))));
  const heldNotifications = await count(
    tx.select({ n: sql<number>`count(*)::int` }).from(notificationOutbox).where(and(eq(notificationOutbox.tenantId, t), inArray(notificationOutbox.status, ["held", "pending"])))
  );

  return {
    tenantId,
    firmName: firm?.name ?? "DEMO",
    generation: flag.generation,
    seededAt: flag.seededAt,
    seedVersion: flag.seedVersion,
    summary: summarizeReport({ steps }),
    blockedSteps: steps.filter((s) => s.status === "blocked"),
    failedSteps: steps.filter((s) => s.status === "failed"),
    ids: { matter: { ...(report.ids?.matters ?? {}) }, session: { ...sessionIds } },
    staff: DEMO_STAFF.map((s) => ({ name: s.displayName, title: s.title, role: s.role, email: s.email })),
    prospects: prospects.map((p) => ({ name: prospectName(p.name), status: p.status, channel: p.channel, safetyFlagged: p.safetyFlagged, startedAt: p.startedAt })),
    emergencies: emergencies.map((e) => ({ track: e.track, category: e.category, acknowledged: e.ack !== null, escalationStep: e.step })),
    conflicts: checks.map((c) => ({
      name: (c.sessionId && nameBySession.get(c.sessionId)) || "Inquiry",
      outcome: c.outcome,
      status: c.status,
      decision: decisions.find((d) => d.checkId === c.id)?.decision ?? null,
      ruleTableApplied: c.ruleTableApplied,
    })),
    consultations: consultations.map((c) => ({ lawyer: userName.get(c.lawyer) ?? "Lawyer", startsAt: c.startsAt, status: c.status, outcome: c.outcome })),
    matters: matterRows.map((m) => ({ id: m.id, client: m.client ?? "?", stage: m.stage, practiceArea: m.practiceArea, lawyer: m.lawyer ? (userName.get(m.lawyer) ?? null) : null })),
    events: events.map((e) => ({ ...e, isDeadline: e.isDeadline })),
    limitations: lims.map((l) => ({ claim: l.claim, date: String(l.date), status: l.status })),
    documents: docs.map((d) => ({ name: d.name ?? "(unnamed)", version: d.version, status: d.status })),
    trust: {
      accounts,
      subledgers: subs.map((s) => ({ client: s.client, balanceCents: String(s.balance), heldCents: String(s.held) })),
      reconciliations: recs.map((r) => ({ period: r.period, status: r.status, differences: Array.isArray(r.differences) ? r.differences.length : 0, rulesApproved: r.rulesApproved })),
    },
    replyClocks: clocks.map((c) => ({ tier: c.tier, status: c.status, promiseAt: c.promiseAt, immediateAlert: c.immediate !== null })),
    updates: updates.map((u) => ({ status: u.status, authorType: u.authorType, body: u.body })),
    courtNotices: notices.map((n) => ({ subject: n.subject, classification: n.classification, status: n.status, matched: n.matterId !== null })),
    health: health.map((h) => ({ client: clientByMatter.get(h.matterId) ?? "?", score: h.score, band: h.band })),
    ops: { openFlags, overdueTasks, heldNotifications },
  };
}
