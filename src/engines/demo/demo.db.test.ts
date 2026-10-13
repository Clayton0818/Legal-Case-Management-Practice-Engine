// End-to-end check of the DEMO firm (c106) against a REAL Postgres, as the
// app_runtime role (RLS enforced):
//  - a demo firm is created and seeded through the engines' real services,
//    with every approval gate pending (as on staging today): no step fails,
//    gated steps are recorded as BLOCKED with their placeholder;
//  - the key records exist and are visible through RLS in the demo firm's own
//    transaction, and invisible from another firm;
//  - the reset refuses a non-demo firm before writing anything;
//  - a reset from the demo firm seeds a fresh one and retires the old one.
//
// Skipped when DATABASE_URL is unset (src/tenancy/testing.ts) and until the
// integration migration has created demo_tenants. Everything runs in ONE
// transaction that is rolled back (the trust journal, access log and audit
// trail are append-only, so nothing could be cleaned up otherwise).

import { afterEach, expect, it } from "vitest";
import { and, count, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { conflictCheckResults, firms, intakeSessions, matters, parties, users, documents } from "@/db/schema";
import { auditEvents, calendarEvents, flags, tasks } from "@/db/tables/foundation";
import { conflictChecks, conflictDecisions } from "@/db/tables/conflict-check";
import { intakeEmergencyAlerts, intakeConsultations } from "@/db/tables/intake";
import { limitationDates } from "@/db/tables/calendar-core";
import { clientUpdates, replyClocks, courtNotices } from "@/db/tables/calendar-alerts";
import { trustAccounts, trustSubledgers, trustReconciliations } from "@/db/tables/billing-trust";
import { demoTenants } from "@/db/tables/demo";
import { resetApprovalStateForTests, setApprovals, setBlockedActionSink } from "@/compliance/approvals";
import { DemoGuardError } from "./guard";
import { createDemoTenant, currentDemoTenant, resetDemo, retireDemoTenant, type TenantRunner } from "./reset";
import { DEMO_FIRM } from "./fixtures";
import { loadDemoSnapshot } from "./snapshot";

class Rollback extends Error {}

afterEach(() => resetApprovalStateForTests());

describeWithDb("demo firm (c106) against Postgres", () => {
  it("seeds through real services, is visible only via its own RLS scope, and resets only demo firms", { timeout: 120_000 }, async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.demo_tenants') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip(); // demo_tenants not migrated yet

    setBlockedActionSink(() => {});
    setApprovals([]); // every gate pending, as on staging today

    try {
      await rawDb.transaction(async (raw) => {
        const scoped = async (tenantId: string) => {
          await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
          return raw as unknown as TenantTx;
        };
        // Each "transaction" of the runner is a savepoint of the outer, rolled-back one.
        const run: TenantRunner = (tenantId, fn) =>
          raw.transaction(async (sp) => {
            await sp.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
            return fn(sp as unknown as TenantTx);
          });

        // A real (non-demo) firm, to prove the guard and the isolation.
        const [realFirm] = await raw.insert(firms).values({ name: "Real Firm (test)", slug: `real-test-${Date.now()}` }).returning({ id: firms.id });
        const realId = realFirm!.id;

        // ---- create + seed ------------------------------------------------
        const created = await createDemoTenant(run, { createdBy: "demo.db.test" });
        if (process.env.DEMO_DEBUG) console.log(created.report.steps.map((s) => `${s.status.padEnd(7)} ${s.key} ${s.gate ?? ""} ${s.status === "ok" ? "" : (s.detail ?? "").slice(0, 120)}`).join("\n"));
        const failed = created.report.steps.filter((s) => s.status === "failed");
        expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
        const blocked = created.report.steps.filter((s) => s.status === "blocked");
        // Gated actions are refused with the visible placeholder, never faked.
        for (const b of blocked) expect(b.detail).toMatch(/\[PENDING [A-Z +_]+ REVIEW — .*\(gate: /);
        expect(blocked.map((b) => b.gate)).toEqual(expect.arrayContaining(["rules.trust_accounting", "rules.intake.matter_open_gates", "rules.court_deadlines"]));

        const demoId = created.tenantId;
        let tx = await scoped(demoId);
        const [firm] = await tx.select().from(firms).where(eq(firms.id, demoId));
        expect(firm!.name).toContain("DEMO");
        expect(firm!.isProduction).toBe(false);
        expect(firm!.slug.startsWith(DEMO_FIRM.slugPrefix)).toBe(true);

        const n = async (table: PgTable, where: SQL | undefined) => Number((await tx.select({ c: count() }).from(table).where(where))[0]!.c);

        // People: fictional staff, example.com only.
        const staff = await tx.select({ email: users.email, role: users.role }).from(users).where(eq(users.tenantId, demoId));
        expect(staff.length).toBeGreaterThanOrEqual(6);
        expect(staff.every((u) => u.email.endsWith("@example.com"))).toBe(true);
        expect(staff.filter((u) => u.role === "attorney").length).toBeGreaterThanOrEqual(3);
        const people = await tx.select({ email: parties.email, phone: parties.phone }).from(parties).where(eq(parties.tenantId, demoId));
        expect(people.every((p) => !p.email || p.email.endsWith("@example.com"))).toBe(true);
        expect(people.every((p) => !p.phone || /55501\d\d$/.test(p.phone.replace(/\D/g, "")))).toBe(true);

        // Matters across stages, including the Family Law matter.
        const matterRows = await tx.select({ stage: matters.stage, area: matters.practiceArea }).from(matters).where(eq(matters.tenantId, demoId));
        expect(matterRows.filter((m) => m.stage === "retained" && m.area === "family").length).toBeGreaterThanOrEqual(2);
        expect(new Set(matterRows.map((m) => m.stage)).size).toBeGreaterThanOrEqual(3);

        // Prospects chatted in; one emergency raised.
        expect(await n(intakeSessions, eq(intakeSessions.tenantId, demoId))).toBeGreaterThanOrEqual(4);
        expect(await n(intakeEmergencyAlerts, eq(intakeEmergencyAlerts.tenantId, demoId))).toBeGreaterThanOrEqual(1);
        expect(await n(intakeConsultations, eq(intakeConsultations.tenantId, demoId))).toBeGreaterThanOrEqual(1);

        // Conflict checks: a clear one and possible ones, and a human decision on the "definite" example.
        const outcomes = (await tx.select({ outcome: conflictChecks.outcome }).from(conflictChecks).where(eq(conflictChecks.tenantId, demoId))).map((r) => r.outcome);
        expect(outcomes).toContain("clear");
        expect(outcomes).toContain("possible");
        expect(await n(conflictDecisions, eq(conflictDecisions.tenantId, demoId))).toBeGreaterThanOrEqual(1);
        expect(await n(conflictCheckResults, eq(conflictCheckResults.tenantId, demoId))).toBeGreaterThanOrEqual(3);

        // Calendar: proposed AND confirmed entries; limitation dates (one verified).
        const evs = await tx.select({ status: calendarEvents.status }).from(calendarEvents).where(eq(calendarEvents.tenantId, demoId));
        expect(evs.some((e) => e.status === "proposed")).toBe(true);
        expect(evs.some((e) => e.status === "confirmed")).toBe(true);
        const lims = await tx.select({ status: limitationDates.status }).from(limitationDates).where(eq(limitationDates.tenantId, demoId));
        expect(lims.map((l) => l.status)).toEqual(expect.arrayContaining(["verified", "unverified"]));

        // Tasks and flags.
        expect(await n(tasks, eq(tasks.tenantId, demoId))).toBeGreaterThanOrEqual(3);
        expect(await n(flags, and(eq(flags.tenantId, demoId), isNull(flags.resolvedAt)))).toBeGreaterThanOrEqual(2);

        // Documents (with a second version), trust, client updates, reply clocks, court notice.
        expect(await n(documents, eq(documents.tenantId, demoId))).toBeGreaterThanOrEqual(5);
        expect(await n(trustAccounts, eq(trustAccounts.tenantId, demoId))).toBe(1);
        expect(await n(trustSubledgers, eq(trustSubledgers.tenantId, demoId))).toBeGreaterThanOrEqual(2);
        expect(await n(trustReconciliations, eq(trustReconciliations.tenantId, demoId))).toBe(1);
        expect(await n(clientUpdates, eq(clientUpdates.tenantId, demoId))).toBeGreaterThanOrEqual(2);
        expect(await n(replyClocks, eq(replyClocks.tenantId, demoId))).toBeGreaterThanOrEqual(1);
        expect(await n(courtNotices, eq(courtNotices.tenantId, demoId))).toBe(1);
        // Blocked attempts are on the audit trail.
        expect(await n(auditEvents, and(eq(auditEvents.tenantId, demoId), eq(auditEvents.action, "approval.blocked")))).toBeGreaterThanOrEqual(1);

        const [flagRow] = await tx.select().from(demoTenants).where(eq(demoTenants.tenantId, demoId));
        expect(flagRow).toMatchObject({ status: "active", generation: 1 });

        // The walkthrough's live snapshot reads all of it back in the demo firm's scope.
        const snap = await loadDemoSnapshot(tx, demoId);
        if (process.env.DEMO_DEBUG) console.log(JSON.stringify(snap, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
        expect(snap.firmName).toContain("DEMO");
        expect(snap.conflicts.map((c) => c.name)).toEqual(expect.arrayContaining(["Sam Placewell", "Kai Prototon-Vale", "Chris Sampleford"]));
        expect(snap.conflicts.find((c) => c.name === "Sam Placewell")?.outcome).toBe("clear");
        expect(snap.conflicts.find((c) => c.name === "Kai Prototon-Vale")).toMatchObject({ outcome: "possible", decision: null });
        expect(snap.conflicts.find((c) => c.name === "Chris Sampleford")?.decision).toBe("declined");
        expect(snap.ids.matter.sampleford).toBeTruthy();
        expect(snap.ids.matter.placewell).toBeTruthy();
        expect(snap.ids.session.clear).toBeTruthy();
        expect(snap.emergencies.length).toBeGreaterThanOrEqual(1);
        expect(snap.trust.reconciliations[0]?.differences).toBeGreaterThan(0);
        await expect(loadDemoSnapshot(await scoped(realId), realId)).rejects.toBeInstanceOf(DemoGuardError);
        tx = await scoped(demoId);

        // ---- isolation: from the real firm, none of it is visible ---------
        tx = await scoped(realId);
        expect(await n(matters, eq(matters.tenantId, demoId))).toBe(0);
        expect(await n(demoTenants, eq(demoTenants.tenantId, demoId))).toBe(0);
        expect(await n(users, eq(users.tenantId, demoId))).toBe(0);

        // ---- the guard: a non-demo firm can never be reset or retired -----
        const firmsBefore = Number((await raw.select({ c: count() }).from(firms))[0]!.c);
        await expect(resetDemo(run, { requestedFromTenantId: realId, createdBy: "attacker" })).rejects.toBeInstanceOf(DemoGuardError);
        await expect(run(realId, (t) => retireDemoTenant(t, { tenantId: realId, replacedByTenantId: null, reason: "x" }))).rejects.toMatchObject({ code: "not_flagged" });
        expect(Number((await raw.select({ c: count() }).from(firms))[0]!.c)).toBe(firmsBefore);
        tx = await scoped(realId);
        expect((await tx.select({ status: firms.status }).from(firms).where(eq(firms.id, realId)))[0]!.status).not.toBe("offboarded");
        // The database refuses to plant a demo flag on an existing firm (MIGRATION NOTES trigger).
        await expect(
          raw.transaction(async (sp) => {
            await sp.execute(sql`select set_config('app.tenant_id', ${realId}, true)`);
            await sp.execute(sql`update firms set created_at = created_at - interval '1 day' where id = ${realId}`);
            await sp.insert(demoTenants).values({ tenantId: realId, label: "DEMO planted", seedVersion: "x", createdBy: "attacker" });
          })
        ).rejects.toThrow();

        // ---- reset from the demo firm: fresh firm, old one retired -------
        const reset = await resetDemo(run, { requestedFromTenantId: demoId, createdBy: "demo.db.test reset" });
        expect(reset.newTenantId).not.toBe(demoId);
        expect(reset.generation).toBe(2);
        expect(reset.retiredTenantIds).toEqual([demoId]);
        expect(reset.summary.failed).toBe(0);
        tx = await scoped(demoId);
        expect((await tx.select().from(demoTenants).where(eq(demoTenants.tenantId, demoId)))[0]).toMatchObject({ status: "retired", replacedByTenantId: reset.newTenantId });
        expect((await tx.select({ status: firms.status }).from(firms).where(eq(firms.id, demoId)))[0]!.status).toBe("offboarded");
        // The retired firm's append-only history is still there (nothing was deleted).
        expect(await n(auditEvents, eq(auditEvents.tenantId, demoId))).toBeGreaterThan(0);
        const current = await currentDemoTenant(run, realId);
        expect(current?.tenantId).toBe(reset.newTenantId);
        // A retired demo firm cannot be retired twice.
        await expect(run(demoId, (t) => retireDemoTenant(t, { tenantId: demoId, replacedByTenantId: null, reason: "again" }))).rejects.toMatchObject({ code: "retired" });

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
