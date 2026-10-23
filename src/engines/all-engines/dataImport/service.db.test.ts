// c98 service round-trip against a REAL Postgres, inside ONE rolled-back
// transaction (import_batches/import_rows are an audit trail; nothing here
// is meant to persist past the test). Skipped without DATABASE_URL, and
// until the integration migration has created import_batches/import_rows.

import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, users } from "@/db/schema";
import {
  resetApprovalStateForTests,
  InMemoryApprovalSource,
  setApprovalSource,
  ensureApprovalsLoaded,
  PendingApprovalError,
} from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import { createImportBatch, executeImportBatch, getImportBatch, recordFirmSignoff, rejectImportBatch, type StagedRow } from "./service";

class Rollback extends Error {}

describeWithDb("c98 data-import service against Postgres", () => {
  it("stages, blocks sign-off on errors, signs off once clean, then executes", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.import_batches') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();

    resetApprovalStateForTests();

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Import Test Firm", slug: `import-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;
        const [admin] = await tx.insert(users).values({ tenantId, email: "import-admin@x.example", displayName: "Ida Admin", role: "firm_admin" }).returning({ id: users.id });
        const by = { type: "user" as const, userId: admin!.id };

        // One bad row (missing required name) alongside one good contact and one matter hand-off.
        const dirtyRows: StagedRow[] = [
          {
            rowNumber: 2,
            recordKind: "contact",
            rawFields: { Name: "" },
            mappedData: null,
            issues: [{ rowNumber: 2, recordKind: "contact", field: "fullName", severity: "error", code: "required_field_missing", message: "blank" }],
          },
          {
            rowNumber: 3,
            recordKind: "contact",
            rawFields: { Name: "Ana Lee" },
            mappedData: { externalId: "C-1", fullName: "Ana Lee" },
            issues: [],
          },
        ];
        const dirtyReport = { sourceKind: "spreadsheet" as const, generatedAt: new Date().toISOString(), counts: [], issues: dirtyRows.flatMap((r) => r.issues), readyToImport: false };
        const dirtyBatch = await createImportBatch(tx, { tenantId, sourceKind: "spreadsheet", rows: dirtyRows, report: dirtyReport, createdBy: by });
        await expect(recordFirmSignoff(tx, { tenantId, batchId: dirtyBatch.id, by })).rejects.toThrow(/still have errors/);

        // A clean batch: one contact + one matter (hand-off) + one trust balance (gated).
        const cleanRows: StagedRow[] = [
          { rowNumber: 2, recordKind: "contact", rawFields: { Name: "Ana Lee" }, mappedData: { externalId: "C-1", fullName: "Ana Lee" }, issues: [] },
          { rowNumber: 2, recordKind: "matter", rawFields: { Matter: "Lee v. Lee" }, mappedData: { clientExternalId: "C-1", matterName: "Lee v. Lee" }, issues: [] },
          { rowNumber: 2, recordKind: "trust_balance", rawFields: { Balance: "4500.00" }, mappedData: { clientExternalId: "C-1", balanceCents: 450000 }, issues: [] },
        ];
        const cleanReport = { sourceKind: "spreadsheet" as const, generatedAt: new Date().toISOString(), counts: [], issues: [], readyToImport: true };
        const batch = await createImportBatch(tx, { tenantId, sourceKind: "spreadsheet", rows: cleanRows, report: cleanReport, createdBy: by });

        // Executing before sign-off is refused.
        await expect(executeImportBatch(tx, { tenantId, batchId: batch.id, by })).rejects.toThrow(/not 'approved'/);

        await recordFirmSignoff(tx, { tenantId, batchId: batch.id, by, reason: "Reviewed the dry run, looks right" });
        expect((await getImportBatch(tx, tenantId, batch.id))?.status).toBe("approved");

        // Trust balance hand-off is blocked until the shared attorney+CPA gate is approved.
        await expect(executeImportBatch(tx, { tenantId, batchId: batch.id, by })).rejects.toThrow(PendingApprovalError);

        const approvals = new InMemoryApprovalSource();
        approvals.approve({ gateKey: RULE_GATES.trustAccounting.key, reviewerKind: "attorney", approvedByName: "A. Attorney" });
        approvals.approve({ gateKey: RULE_GATES.trustAccounting.key, reviewerKind: "cpa", approvedByName: "C. Accountant" });
        setApprovalSource(approvals);
        await ensureApprovalsLoaded(0);

        const summary = await executeImportBatch(tx, { tenantId, batchId: batch.id, by });
        expect(summary).toEqual({ contactsCreated: 1, handOffTasksCreated: 2, skipped: 0 });
        expect((await getImportBatch(tx, tenantId, batch.id))?.status).toBe("executed");

        // A separate rejected batch leaves its own trail and never touches the others.
        const toReject = await createImportBatch(tx, { tenantId, sourceKind: "clio", rows: [], report: { ...cleanReport, sourceKind: "clio" }, createdBy: by });
        const rejected = await rejectImportBatch(tx, { tenantId, batchId: toReject.id, by, reason: "Wrong export file attached" });
        expect(rejected.status).toBe("rejected");

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
