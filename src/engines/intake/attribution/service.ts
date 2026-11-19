// c74 — capture and read back one intake session's lead-source attribution.
// This is the database-touching half of src/engines/intake/attribution;
// the classification logic itself lives in ./model.ts (pure, tested).

import { and, eq } from "drizzle-orm";
import { intakeLeadAttribution } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { normalizeLeadAttributionInput, type LeadAttributionInput } from "./model";

export type LeadAttributionRow = typeof intakeLeadAttribution.$inferSelect;

/**
 * Record or correct one session's attribution. Idempotent per
 * (tenant, session) — a later capture (e.g. a vendor resolving a tracking
 * number's campaign after the fact, or a front-desk correction) updates the
 * same row rather than creating a second one. Never throws on a malformed
 * or empty input: normalizeLeadAttributionInput() turns anything it can't
 * use into null fields rather than rejecting the whole request, because
 * attribution capture must never be the reason an inquiry fails to save.
 */
export async function upsertLeadAttribution(
  tx: TenantTx,
  tenantId: string,
  intakeSessionId: string,
  input: LeadAttributionInput
): Promise<LeadAttributionRow> {
  const normalized = normalizeLeadAttributionInput(input);
  const [row] = await tx
    .insert(intakeLeadAttribution)
    .values({ tenantId, intakeSessionId, ...normalized })
    .onConflictDoUpdate({
      target: [intakeLeadAttribution.tenantId, intakeLeadAttribution.intakeSessionId],
      set: { ...normalized, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("upsertLeadAttribution: insert failed.");
  return row;
}

export async function getLeadAttribution(tx: TenantTx, tenantId: string, intakeSessionId: string): Promise<LeadAttributionRow | null> {
  const [row] = await tx
    .select()
    .from(intakeLeadAttribution)
    .where(and(eq(intakeLeadAttribution.tenantId, tenantId), eq(intakeLeadAttribution.intakeSessionId, intakeSessionId)))
    .limit(1);
  return row ?? null;
}
