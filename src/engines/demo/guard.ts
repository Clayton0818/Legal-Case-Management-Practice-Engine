// c106 — the hard guard: is this firm the fictional DEMO firm?
//
// The answer comes ONLY from the demo engine's own flag table
// (demo_tenants, read under RLS inside that firm's own transaction) plus the
// firm row's is_production = false. The firm's name is never consulted, and
// the "demo-" slug prefix is only a consistency check that can refuse, never
// a reason to allow. Every function that changes a demo firm calls
// assertDemoTenant() first, inside the same transaction.

import { and, eq } from "drizzle-orm";
import { firms } from "@/db/schema";
import { demoTenants, type DemoTenantStatus } from "@/db/tables/demo";
import type { TenantTx } from "@/tenancy/withTenant";
import { HttpError } from "@/tenancy/route";
import { DEMO_FIRM } from "./fixtures";

export class DemoGuardError extends HttpError {
  constructor(
    message: string,
    readonly code: DemoGuardRefusal
  ) {
    super(403, message);
    this.name = "DemoGuardError";
  }
}

export type DemoGuardRefusal =
  | "no_tenant"
  | "firm_missing"
  | "not_flagged"
  | "flag_mismatch"
  | "production_firm"
  | "slug_mismatch"
  | "retired";

export interface DemoFlagRow {
  tenantId: string;
  status: string;
  generation: number;
  label: string;
  seedVersion: string;
  createdAt: Date;
  seededAt: Date | null;
  retiredAt: Date | null;
  replacedByTenantId: string | null;
  seedReport: unknown;
}

export interface FirmFacts {
  id: string;
  slug: string;
  isProduction: boolean;
  status: string;
}

/** Pure: may the demo engine act on this firm? */
export function evaluateDemoGuard(input: {
  tenantId: string;
  firm: FirmFacts | null;
  flag: DemoFlagRow | null;
  allowRetired?: boolean;
}): { ok: true } | { ok: false; code: DemoGuardRefusal; message: string } {
  const refuse = (code: DemoGuardRefusal, message: string) => ({ ok: false as const, code, message });
  if (!input.tenantId) return refuse("no_tenant", "No firm was given.");
  if (!input.firm || input.firm.id !== input.tenantId) return refuse("firm_missing", "That firm does not exist.");
  if (!input.flag) return refuse("not_flagged", "This firm is not the demo firm. The demo reset only ever touches the flagged DEMO firm.");
  if (input.flag.tenantId !== input.tenantId) return refuse("flag_mismatch", "The demo flag belongs to a different firm.");
  if (input.firm.isProduction) return refuse("production_firm", "A production firm can never be a demo firm.");
  if (!input.firm.slug.startsWith(DEMO_FIRM.slugPrefix)) return refuse("slug_mismatch", "The flagged firm's slug is not a demo slug; refusing.");
  if ((input.flag.status as DemoTenantStatus) === "retired" && !input.allowRetired) {
    return refuse("retired", "This demo firm has been retired by a reset.");
  }
  return { ok: true };
}

export async function readFirmFacts(tx: TenantTx, tenantId: string): Promise<FirmFacts | null> {
  const [row] = await tx
    .select({ id: firms.id, slug: firms.slug, isProduction: firms.isProduction, status: firms.status })
    .from(firms)
    .where(eq(firms.id, tenantId))
    .limit(1);
  return row ?? null;
}

/** The demo flag for the transaction's own firm (RLS hides every other firm's row). */
export async function readDemoFlag(tx: TenantTx, tenantId: string): Promise<DemoFlagRow | null> {
  const [row] = await tx
    .select({
      tenantId: demoTenants.tenantId,
      status: demoTenants.status,
      generation: demoTenants.generation,
      label: demoTenants.label,
      seedVersion: demoTenants.seedVersion,
      createdAt: demoTenants.createdAt,
      seededAt: demoTenants.seededAt,
      retiredAt: demoTenants.retiredAt,
      replacedByTenantId: demoTenants.replacedByTenantId,
      seedReport: demoTenants.seedReport,
    })
    .from(demoTenants)
    .where(and(eq(demoTenants.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

/** Throws DemoGuardError (HTTP 403) unless `tenantId` is a flagged demo firm. */
export async function assertDemoTenant(tx: TenantTx, tenantId: string, opts: { allowRetired?: boolean } = {}): Promise<DemoFlagRow> {
  const firm = await readFirmFacts(tx, tenantId);
  const flag = await readDemoFlag(tx, tenantId);
  const verdict = evaluateDemoGuard({ tenantId, firm, flag, allowRetired: opts.allowRetired });
  if (!verdict.ok) throw new DemoGuardError(verdict.message, verdict.code);
  return flag!;
}
