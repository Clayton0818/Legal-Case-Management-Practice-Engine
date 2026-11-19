// c122 against a REAL Postgres: a lawyer enters a walk-in the intake team
// missed, the duplicate lookup finds it afterwards, and the guided view moves
// through disclosures → conflict-check names → conflict check → case details,
// with case details refused until the check is clear. Skipped when
// DATABASE_URL is unset; everything runs in one rolled-back transaction.

import { afterEach, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { conflictCheckResults, firmConfigVersions, firms, users } from "@/db/schema";
import { resetApprovalStateForTests } from "@/compliance/approvals";
import { acknowledgeDisclosures, recordCaseDetails, recordConflictMinimum } from "../channels/service";
import { IntakeRuleError, IntakeValidationError } from "../common/errors";
import { createStaffEnteredIntake, findExistingContacts, getStaffIntakeView } from "./service";

class Rollback extends Error {}

afterEach(() => resetApprovalStateForTests());

describeWithDb("c122 staff-entered intake against Postgres", () => {
  it("creates a walk-in, finds it again, and walks the guided steps in order", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.intake_session_state') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip(); // intake tables not migrated yet

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Staff Entry Test Firm", slug: `staff-entry-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;
        const [config] = await tx.insert(firmConfigVersions).values({ tenantId, version: 1, config: {} }).returning({ id: firmConfigVersions.id });
        const [lawyer] = await tx.insert(users).values({ tenantId, email: "avery@staffentry.example", displayName: "Avery Lawyer", role: "attorney" }).returning({ id: users.id });
        const [viewer] = await tx.insert(users).values({ tenantId, email: "rae@staffentry.example", displayName: "Rae Reader", role: "read_only" }).returning({ id: users.id });

        // Only intake roles may enter an intake, and the form is validated first.
        await expect(createStaffEnteredIntake(tx, { tenantId, staffUserId: viewer!.id, channel: "walk_in", name: "Maria Example", phone: "512-555-0142" })).rejects.toThrow();
        await expect(createStaffEnteredIntake(tx, { tenantId, staffUserId: lawyer!.id, channel: "walk_in", name: "Maria Example" })).rejects.toBeInstanceOf(IntakeValidationError);

        const { intakeSessionId } = await createStaffEnteredIntake(tx, { tenantId, staffUserId: lawyer!.id, channel: "walk_in", name: "Maria Example", phone: "512-555-0142" });

        // The duplicate lookup now finds her by phone (any format) and by name, with the open intake.
        const byPhone = await findExistingContacts(tx, { tenantId, staffUserId: lawyer!.id, phone: "(512) 555 0142" });
        expect(byPhone).toHaveLength(1);
        expect(byPhone[0]!.matchedOn).toContain("phone");
        expect(byPhone[0]!.openIntakes.map((o) => o.intakeSessionId)).toEqual([intakeSessionId]);
        const byName = await findExistingContacts(tx, { tenantId, staffUserId: lawyer!.id, name: "maria  EXAMPLE" });
        expect(byName[0]!.matchedOn).toContain("name");
        expect(await findExistingContacts(tx, { tenantId, staffUserId: lawyer!.id, name: "Somebody Else" })).toEqual([]);

        let view = await getStaffIntakeView(tx, tenantId, intakeSessionId);
        expect(view.channel).toBe("walk_in");
        expect(view.contact?.phone).toBe("+15125550142");
        expect(view.responseTargetAt).not.toBeNull(); // the response clock started
        expect(view.steps.map((s) => s.status)).toEqual(["current", "upcoming", "upcoming", "upcoming"]);

        // Staff-entered disclosures must name who read them.
        await expect(acknowledgeDisclosures(tx, { tenantId, intakeSessionId })).rejects.toBeInstanceOf(IntakeValidationError);
        await acknowledgeDisclosures(tx, { tenantId, intakeSessionId, staffUserId: lawyer!.id });
        await recordConflictMinimum(tx, { tenantId, intakeSessionId, fullName: "Maria Example", otherPartyNames: ["Sam Example"], staffUserId: lawyer!.id });

        view = await getStaffIntakeView(tx, tenantId, intakeSessionId);
        expect(view.steps.map((s) => s.status)).toEqual(["done", "done", "waiting", "upcoming"]);
        expect(view.caseDetailsLocked).toBe(true);
        await expect(recordCaseDetails(tx, { tenantId, intakeSessionId, answers: { county: "Travis" }, staffUserId: lawyer!.id })).rejects.toBeInstanceOf(IntakeRuleError);

        // The conflict-check engine records a clear result; intake never decides it.
        await tx.insert(conflictCheckResults).values({ tenantId, intakeSessionId, roleSought: "client", outcome: "clear", matchedSources: {}, firmConfigVersionId: config!.id });
        view = await getStaffIntakeView(tx, tenantId, intakeSessionId);
        expect(view.steps.map((s) => s.status)).toEqual(["done", "done", "done", "current"]);

        await recordCaseDetails(tx, { tenantId, intakeSessionId, answers: { practiceArea: "family", county: "Travis" }, staffUserId: lawyer!.id });
        view = await getStaffIntakeView(tx, tenantId, intakeSessionId);
        expect(view.caseDetails).toEqual({ practiceArea: "family", county: "Travis" });
        expect(view.steps.every((s) => s.status === "done")).toBe(true);

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
