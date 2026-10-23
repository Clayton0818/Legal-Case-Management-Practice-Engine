// Database-backed orchestration for an import batch: stage it (with its
// dry-run report already computed by the pure modules in this folder),
// record the firm's required sign-off, then execute it.
//
// Engine-boundary note (src/engines/README.md): `parties` is a shared
// foundation table (contacts.ts: "Contacts are rows of `parties`…"), and
// src/engines/all-engines/allEngines.db.test.ts already inserts into both
// `parties` and `matters` directly from this engine, so this engine creates
// `contact` rows directly here. Every other record kind (matter, document,
// calendar_event, task, time_entry, invoice, trust_balance) is handed off as
// a `tasks` row for the engine that actually owns that kind of work to pick
// up and create with its own, authoritative field mapping — this module
// never writes into another engine's own tables. See the module doc comment
// on executeImportBatch for why `matter` is handed off too despite `matters`
// being a table this engine can technically reach: this file doesn't have a
// verified mapping for every column on that table (title/description/status
// defaults in particular), and guessing wrong on a write is worse than a
// one-hop hand-off.

import { and, eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/tenancy/withTenant";
import { importBatches, importRows } from "@/db/tables/all-engines";
import { parties } from "@/db/schema";
import { audit, createTask, normalizeName, type Actor } from "@/core";
import type { DryRunReport, ImportIssue, ImportRecordKind } from "./types";
import { hasErrors } from "./types";
import { requireTrustBalanceImportApproval } from "./reconciliation";

export type ImportBatchRow = typeof importBatches.$inferSelect;
export type ImportRowRow = typeof importRows.$inferSelect;

export interface StagedRow {
  rowNumber: number;
  recordKind: ImportRecordKind;
  rawFields: Record<string, string>;
  mappedData: Record<string, unknown> | null;
  issues: ImportIssue[];
}

function rowStatus(issues: readonly ImportIssue[]): "pending" | "error" | "warning" {
  if (hasErrors(issues)) return "error";
  if (issues.length > 0) return "warning";
  return "pending";
}

/** Stage a batch: one row per source record, plus the dry-run report computed by types.ts's summarizeForDryRun. */
export async function createImportBatch(
  tx: TenantTx,
  input: {
    tenantId: string;
    sourceKind: "clio" | "mycase" | "spreadsheet";
    rows: readonly StagedRow[];
    report: DryRunReport;
    createdBy: Actor;
  }
): Promise<ImportBatchRow> {
  const [batch] = await tx
    .insert(importBatches)
    .values({
      tenantId: input.tenantId,
      sourceKind: input.sourceKind,
      status: "dry_run_complete",
      dryRunReport: input.report as unknown as Record<string, unknown>,
      createdByUserId: input.createdBy.type === "user" ? input.createdBy.userId : null,
    })
    .returning();
  if (!batch) throw new Error("createImportBatch: insert failed.");

  if (input.rows.length > 0) {
    await tx.insert(importRows).values(
      input.rows.map((row) => ({
        tenantId: input.tenantId,
        batchId: batch.id,
        rowNumber: row.rowNumber,
        recordKind: row.recordKind,
        rawFields: row.rawFields,
        mappedData: row.mappedData,
        issues: row.issues as unknown as Record<string, unknown>[],
        status: rowStatus(row.issues),
      }))
    );
  }

  await audit(tx, {
    tenantId: input.tenantId,
    engine: "all-engines",
    action: "import.batch_staged",
    entityType: "import_batch",
    entityId: batch.id,
    actor: input.createdBy,
    payload: { sourceKind: input.sourceKind, rowCount: input.rows.length, readyToImport: input.report.readyToImport },
  });
  return batch;
}

export async function getImportBatch(tx: TenantTx, tenantId: string, batchId: string): Promise<ImportBatchRow | undefined> {
  const [row] = await tx.select().from(importBatches).where(and(eq(importBatches.tenantId, tenantId), eq(importBatches.id, batchId))).limit(1);
  return row;
}

async function countRowsByStatus(tx: TenantTx, tenantId: string, batchId: string, status: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(importRows)
    .where(and(eq(importRows.tenantId, tenantId), eq(importRows.batchId, batchId), eq(importRows.status, status)));
  return Number(row?.count ?? 0);
}

/**
 * The firm's required sign-off before anything is actually created (the
 * card's own "dry run, error report, and a firm sign-off step"). Refuses if
 * any row still carries an error — sign-off is for a clean (or
 * clean-with-warnings) batch, never a promise to fix errors later.
 */
export async function recordFirmSignoff(
  tx: TenantTx,
  input: { tenantId: string; batchId: string; by: Actor; reason?: string }
): Promise<ImportBatchRow> {
  const batch = await getImportBatch(tx, input.tenantId, input.batchId);
  if (!batch) throw new Error(`recordFirmSignoff: batch ${input.batchId} not found.`);
  if (batch.status !== "dry_run_complete") {
    throw new Error(`recordFirmSignoff: batch is '${batch.status}', not 'dry_run_complete'.`);
  }
  const errorCount = await countRowsByStatus(tx, input.tenantId, input.batchId, "error");
  if (errorCount > 0) {
    throw new Error(`recordFirmSignoff: ${errorCount} row(s) still have errors — fix and re-stage before sign-off.`);
  }

  const [updated] = await tx
    .update(importBatches)
    .set({
      status: "approved",
      signedOffByUserId: input.by.type === "user" ? input.by.userId : null,
      signedOffAt: new Date(),
      signoffReason: input.reason ?? null,
    })
    .where(and(eq(importBatches.tenantId, input.tenantId), eq(importBatches.id, input.batchId)))
    .returning();
  if (!updated) throw new Error("recordFirmSignoff: update failed.");

  await audit(tx, {
    tenantId: input.tenantId,
    engine: "all-engines",
    action: "import.firm_signoff",
    entityType: "import_batch",
    entityId: updated.id,
    actor: input.by,
    reason: input.reason ?? "Firm sign-off to proceed with import",
  });
  return updated;
}

export async function rejectImportBatch(
  tx: TenantTx,
  input: { tenantId: string; batchId: string; by: Actor; reason: string }
): Promise<ImportBatchRow> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("rejectImportBatch: a reason is required.");
  const [updated] = await tx
    .update(importBatches)
    .set({ status: "rejected", rejectedAt: new Date(), rejectedReason: reason })
    .where(and(eq(importBatches.tenantId, input.tenantId), eq(importBatches.id, input.batchId)))
    .returning();
  if (!updated) throw new Error(`rejectImportBatch: batch ${input.batchId} not found.`);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: "all-engines",
    action: "import.rejected",
    entityType: "import_batch",
    entityId: updated.id,
    actor: input.by,
    reason,
  });
  return updated;
}

export interface ExecuteSummary {
  contactsCreated: number;
  handOffTasksCreated: number;
  skipped: number;
}

/**
 * Execute an approved batch: create `parties` rows directly for 'contact'
 * rows, and a hand-off `tasks` row for every other kind — see this file's
 * header comment for why. A 'trust_balance' row additionally requires the
 * shared `rules.trust_accounting` approval (attorney + CPA) before its
 * hand-off task is even created, since queuing a real client's trust number
 * for another engine to post is already "moving toward" that money moving,
 * and the card explicitly requires CPA-reviewed sign-off before any of this
 * reaches go-live.
 */
export async function executeImportBatch(
  tx: TenantTx,
  input: { tenantId: string; batchId: string; by: Actor; now?: Date }
): Promise<ExecuteSummary> {
  const batch = await getImportBatch(tx, input.tenantId, input.batchId);
  if (!batch) throw new Error(`executeImportBatch: batch ${input.batchId} not found.`);
  if (batch.status !== "approved") {
    throw new Error(`executeImportBatch: batch is '${batch.status}', not 'approved'.`);
  }
  const now = input.now ?? new Date();

  const rows = await tx.select().from(importRows).where(and(eq(importRows.tenantId, input.tenantId), eq(importRows.batchId, input.batchId)));

  // Check the trust-accounting gate BEFORE writing anything, so a blocked
  // batch never leaves half its contacts or hand-off tasks behind.
  if (rows.some((row) => row.recordKind === "trust_balance" && row.status !== "error")) {
    requireTrustBalanceImportApproval({ tenantId: input.tenantId, action: "data_import.trust_balance_import" });
  }

  const externalIdToPartyId = new Map<string, string>();
  let contactsCreated = 0;
  let handOffTasksCreated = 0;
  let skipped = 0;

  // Pass 1: contacts, so later rows (matters, etc.) can resolve a client
  // externalId to the party just created, inside the SAME transaction.
  for (const row of rows) {
    if (row.recordKind !== "contact") continue;
    if (row.status === "error") {
      skipped++;
      continue;
    }
    const data = (row.mappedData ?? {}) as { externalId?: string; fullName?: string; email?: string; phone?: string };
    if (!data.fullName) {
      skipped++;
      continue;
    }
    const [party] = await tx
      .insert(parties)
      .values({ tenantId: input.tenantId, fullName: data.fullName, normalizedName: normalizeName(data.fullName) })
      .returning({ id: parties.id });
    if (!party) throw new Error(`executeImportBatch: failed to create contact for row ${row.rowNumber}.`);
    if (data.externalId) externalIdToPartyId.set(data.externalId, party.id);
    await tx.update(importRows).set({ status: "imported", createdEntityId: party.id }).where(eq(importRows.id, row.id));
    contactsCreated++;
  }

  // Pass 2: everything else — hand off to the owning engine via a task.
  for (const row of rows) {
    if (row.recordKind === "contact") continue;
    if (row.status === "error") {
      skipped++;
      continue;
    }
    const data = (row.mappedData ?? {}) as Record<string, unknown> & { clientExternalId?: string };

    const resolvedPartyId = typeof data.clientExternalId === "string" ? externalIdToPartyId.get(data.clientExternalId) : undefined;

    const task = await createTask(
      tx,
      {
        tenantId: input.tenantId,
        kind: `all-engines.import.create_${row.recordKind}`,
        title: `Imported ${row.recordKind} needs creating (batch ${batch.id}, row ${row.rowNumber})`,
        owner: { type: "firm" },
        due: { hours: 0, clock: "business" },
        sourceCard: "c98",
        sourceRef: `import_batch:${batch.id}:row:${row.rowNumber}`,
        metadata: { ...data, resolvedPartyId: resolvedPartyId ?? null, importBatchId: batch.id, importRowId: row.id },
        engine: "all-engines",
      },
      { now }
    );
    await tx.update(importRows).set({ status: "handed_off", createdEntityId: task.id }).where(eq(importRows.id, row.id));
    handOffTasksCreated++;
  }

  await tx
    .update(importBatches)
    .set({ status: "executed", executedAt: now, executedByUserId: input.by.type === "user" ? input.by.userId : null })
    .where(and(eq(importBatches.tenantId, input.tenantId), eq(importBatches.id, input.batchId)));

  await audit(tx, {
    tenantId: input.tenantId,
    engine: "all-engines",
    action: "import.executed",
    entityType: "import_batch",
    entityId: batch.id,
    actor: input.by,
    payload: { contactsCreated, handOffTasksCreated, skipped },
  });

  return { contactsCreated, handOffTasksCreated, skipped };
}
