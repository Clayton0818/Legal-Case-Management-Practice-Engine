// Ethical screens (c60), shared read API.
//
// Screens are written by the conflict-check engine (conflict_screens) and the
// document engine (document_access_blocks with reason 'ethical_screen'). Every
// engine reads them here, through the `active_ethical_screens` view
// (src/db/tables/foundation.ts), never from the engine tables directly. The
// view is security_invoker, so RLS on both base tables applies; every query
// below also filters on tenant_id explicitly.
//
// A screen beats every role, firm owner included (src/core/permissions.ts
// invariant 6): pass screenedUserIdsForMatter() into a MatterRef, or check
// isScreened() before showing anything of a matter.

import { and, eq } from "drizzle-orm";
import { activeEthicalScreens } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";

export type ActiveScreen = typeof activeEthicalScreens.$inferSelect;

/** Every screen in force on this user (matter and intake-session screens). */
export async function activeScreensForUser(tx: TenantTx, tenantId: string, userId: string): Promise<ActiveScreen[]> {
  return tx
    .select()
    .from(activeEthicalScreens)
    .where(and(eq(activeEthicalScreens.tenantId, tenantId), eq(activeEthicalScreens.userId, userId)));
}

/** Matter ids this user is screened from. */
export async function screenedMatterIdsForUser(tx: TenantTx, tenantId: string, userId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ matterId: activeEthicalScreens.matterId })
    .from(activeEthicalScreens)
    .where(and(eq(activeEthicalScreens.tenantId, tenantId), eq(activeEthicalScreens.userId, userId)));
  return new Set(rows.flatMap((r) => (r.matterId ? [r.matterId] : [])));
}

/** Users screened from this matter (feeds MatterRef.screenedUserIds). */
export async function screenedUserIdsForMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: activeEthicalScreens.userId })
    .from(activeEthicalScreens)
    .where(and(eq(activeEthicalScreens.tenantId, tenantId), eq(activeEthicalScreens.matterId, matterId)));
  return rows.map((r) => r.userId);
}

/** Is this user screened from this matter? */
export async function isScreened(tx: TenantTx, tenantId: string, userId: string, matterId: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: activeEthicalScreens.userId })
    .from(activeEthicalScreens)
    .where(
      and(eq(activeEthicalScreens.tenantId, tenantId), eq(activeEthicalScreens.userId, userId), eq(activeEthicalScreens.matterId, matterId))
    )
    .limit(1);
  return Boolean(row);
}
