// c106 — "where is the demo, and is this presenter looking at it?"
//
// The real staff pages show the firm the presenter's session belongs to
// (DEV_TENANT_ID in dev mode, the signed tenant claim with a vendor). After a
// reset the demo lives in a NEW firm, so the walkthrough tells the presenter
// whether their session points at the current demo firm — and warns loudly
// when it points at a real firm, because then the "open the real page" links
// would show that firm's real data instead of the demo.

import { and, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import { staffByKey } from "./fixtures";
import { readDemoFlag, readFirmFacts } from "./guard";
import { currentDemoTenant, demoResetEnabled, type TenantRunner } from "./reset";

export type SessionKind = "current_demo" | "retired_demo" | "not_demo";

export interface DemoStatus {
  session: { tenantId: string; kind: SessionKind };
  current: { tenantId: string; generation: number; seededAt: Date | null; presenterUserId: string | null; presenterName: string; adminUserId: string | null; adminName: string } | null;
  resetEnabled: boolean;
}

/** Pure: classify the presenter's session firm. */
export function sessionKind(sessionTenantId: string, flag: { status: string } | null, currentTenantId: string | null): SessionKind {
  if (!flag) return "not_demo";
  if (currentTenantId && sessionTenantId === currentTenantId && flag.status === "active") return "current_demo";
  return "retired_demo";
}

async function sessionFlag(tx: TenantTx, tenantId: string) {
  const firm = await readFirmFacts(tx, tenantId);
  if (!firm || firm.isProduction) return null;
  return readDemoFlag(tx, tenantId);
}

export async function loadDemoStatus(run: TenantRunner, sessionTenantId: string, env = process.env): Promise<DemoStatus> {
  const presenter = staffByKey("partner");
  const admin = staffByKey("admin");
  const flag = await run(sessionTenantId, (tx) => sessionFlag(tx, sessionTenantId));
  const current = await currentDemoTenant(run, sessionTenantId);
  let presenterUserId: string | null = null;
  let adminUserId: string | null = null;
  if (current) {
    const idFor = (email: string) =>
      run(current.tenantId, async (tx) => {
        const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, current.tenantId), eq(users.email, email))).limit(1);
        return u?.id ?? null;
      });
    presenterUserId = await idFor(presenter.email);
    adminUserId = await idFor(admin.email);
  }
  return {
    session: { tenantId: sessionTenantId, kind: sessionKind(sessionTenantId, flag, current?.tenantId ?? null) },
    current: current
      ? { tenantId: current.tenantId, generation: current.generation, seededAt: current.seededAt, presenterUserId, presenterName: presenter.displayName, adminUserId, adminName: admin.displayName }
      : null,
    resetEnabled: demoResetEnabled(env),
  };
}
