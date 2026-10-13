// c106 — create, find, retire and reset the DEMO firm.
//
// Reset = seed a FRESH demo firm, then retire the old one. Nothing is
// deleted: the trust journal, access logs and audit trail are append-only by
// design, and this module never tries to get around that. The retired firm
// keeps its (fictional) history, its demo_tenants row says 'retired', and its
// firms row goes to 'offboarded' so the worker stops ticking it.
//
// Safety:
//  - every tenant this module writes to is either a firm it has just created
//    in the same transaction, or one that passes assertDemoTenant() inside
//    that firm's own transaction — the flag in demo_tenants (never the name);
//  - resetDemo() takes no target id from the caller. It asks "which firm is
//    asking?", refuses unless that firm is itself a demo firm, and then acts
//    only on firms carrying the demo flag;
//  - the HTTP route additionally requires DEMO_RESET_ENABLED=1 and a staff
//    principal with settings.manage in the (demo) firm.
//
// Transactions are opened through an injected TenantRunner (withTenant in
// production) so tests can run the whole reset inside one rolled-back
// transaction.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { firms } from "@/db/schema";
import { demoTenants } from "@/db/tables/demo";
import { audit } from "@/core/audit";
import type { TenantTx } from "@/tenancy/withTenant";
import { DEMO_FIRM, DEMO_SEED_VERSION } from "./fixtures";
import { assertDemoTenant, DemoGuardError, readDemoFlag, type DemoFlagRow } from "./guard";
import { summarizeReport, type SeedReport, type StepStatus } from "./runner";
import { seedDemoTenant } from "./seed";

export const DEMO_ENGINE = "demo" as const;

export type TenantRunner = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

/** The env switch for the HTTP reset. Off unless explicitly enabled on a demo deployment. */
export function demoResetEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.DEMO_RESET_ENABLED === "1";
}

export interface CreatedDemo {
  tenantId: string;
  generation: number;
  report: SeedReport;
  summary: Record<StepStatus, number>;
}

/** Create and seed a brand-new demo firm (one transaction, scoped to the new firm). */
export async function createDemoTenant(
  run: TenantRunner,
  input: { createdBy: string; generation?: number; now?: Date; tenantId?: string }
): Promise<CreatedDemo> {
  const tenantId = input.tenantId ?? randomUUID();
  const generation = input.generation ?? 1;
  const now = input.now ?? new Date();
  return run(tenantId, async (tx) => {
    // `firms` is the tenant root (not tenant-scoped); a demo firm is never production.
    await tx.insert(firms).values({
      id: tenantId,
      name: DEMO_FIRM.name,
      slug: `${DEMO_FIRM.slugPrefix}${tenantId.slice(0, 8)}-g${generation}`,
      status: "active",
      isProduction: false,
    });
    await tx.insert(demoTenants).values({
      tenantId,
      label: DEMO_FIRM.label,
      status: "seeding",
      generation,
      seedVersion: DEMO_SEED_VERSION,
      createdBy: input.createdBy.slice(0, 200),
    });
    await assertDemoTenant(tx, tenantId); // belt and braces before writing anything else
    const { report } = await seedDemoTenant(tx, { tenantId, now });
    await tx
      .update(demoTenants)
      .set({ status: "active", seededAt: new Date(), seedReport: report as unknown as Record<string, unknown> })
      .where(eq(demoTenants.tenantId, tenantId));
    const summary = summarizeReport(report);
    await audit(tx, {
      tenantId,
      engine: DEMO_ENGINE,
      action: "demo.seeded",
      actor: { type: "system" },
      reason: `Demo firm created by ${input.createdBy}`,
      payload: { generation, seedVersion: DEMO_SEED_VERSION, ...summary },
    });
    return { tenantId, generation, report, summary };
  });
}

/** Retire a demo firm. Refuses (DemoGuardError) for anything that is not a flagged, active demo firm. */
export async function retireDemoTenant(
  tx: TenantTx,
  input: { tenantId: string; replacedByTenantId: string | null; reason: string; now?: Date }
): Promise<DemoFlagRow> {
  const flag = await assertDemoTenant(tx, input.tenantId);
  const now = input.now ?? new Date();
  await tx
    .update(demoTenants)
    .set({ status: "retired", retiredAt: now, retiredReason: input.reason.slice(0, 500), replacedByTenantId: input.replacedByTenantId })
    .where(and(eq(demoTenants.tenantId, input.tenantId), eq(demoTenants.status, flag.status)));
  await tx.update(firms).set({ status: "offboarded" }).where(and(eq(firms.id, input.tenantId), eq(firms.isProduction, false)));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: DEMO_ENGINE,
    action: "demo.retired",
    actor: { type: "system" },
    reason: input.reason,
    payload: { replacedByTenantId: input.replacedByTenantId },
  });
  return flag;
}

/**
 * Firms that might be demo firms (slug prefix, not production, not offboarded).
 * A HINT only — every candidate is confirmed by its own flag row afterwards.
 */
export async function listDemoCandidates(tx: TenantTx): Promise<string[]> {
  const rows = await tx
    .select({ id: firms.id })
    .from(firms)
    .where(and(like(firms.slug, `${DEMO_FIRM.slugPrefix}%`), eq(firms.isProduction, false), inArray(firms.status, ["active", "trial"])));
  return rows.map((r) => r.id);
}

/** Active demo firms, each confirmed by its own flag (read in that firm's own transaction). */
export async function findActiveDemoTenants(run: TenantRunner, scopeTenantId: string): Promise<DemoFlagRow[]> {
  const candidates = await run(scopeTenantId, (tx) => listDemoCandidates(tx));
  const out: DemoFlagRow[] = [];
  for (const id of candidates) {
    const flag = await run(id, (tx) => readDemoFlag(tx, id));
    if (flag && flag.status === "active") out.push(flag);
  }
  return out.sort((a, b) => b.generation - a.generation || b.createdAt.getTime() - a.createdAt.getTime());
}

/** The demo firm the walkthrough shows: the newest active one. */
export async function currentDemoTenant(run: TenantRunner, scopeTenantId: string): Promise<DemoFlagRow | null> {
  return (await findActiveDemoTenants(run, scopeTenantId))[0] ?? null;
}

export interface ResetResult {
  newTenantId: string;
  generation: number;
  retiredTenantIds: string[];
  summary: Record<StepStatus, number>;
}

/**
 * One-click reset. `requestedFromTenantId` is the firm of the signed-in
 * caller; it must itself be a (current or retired) demo firm, otherwise the
 * reset is refused before anything is written.
 */
export async function resetDemo(
  run: TenantRunner,
  input: { requestedFromTenantId: string; createdBy: string; now?: Date }
): Promise<ResetResult> {
  if (!input.requestedFromTenantId) throw new DemoGuardError("No firm was given.", "no_tenant");
  const caller = await run(input.requestedFromTenantId, (tx) => assertDemoTenant(tx, input.requestedFromTenantId, { allowRetired: true }));
  const active = await findActiveDemoTenants(run, input.requestedFromTenantId);
  const generation = Math.max(caller.generation, ...active.map((a) => a.generation)) + 1;
  const created = await createDemoTenant(run, { createdBy: input.createdBy, generation, now: input.now });
  const retired: string[] = [];
  for (const old of active) {
    await run(old.tenantId, (tx) =>
      retireDemoTenant(tx, { tenantId: old.tenantId, replacedByTenantId: created.tenantId, reason: `Reset by ${input.createdBy}`, now: input.now })
    );
    retired.push(old.tenantId);
  }
  return { newTenantId: created.tenantId, generation: created.generation, retiredTenantIds: retired, summary: created.summary };
}
