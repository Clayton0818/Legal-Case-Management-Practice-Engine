// Route plumbing for /api/demo/** (c106). Same steps as the shared
// tenantRoute() — tenant from the session (c34), withTenant() imported
// lazily so `next build` never needs a database, approvals loaded fail-safe,
// errors mapped to JSON — but the demo needs SEVERAL tenant transactions per
// request (the caller's firm, the new demo firm, the retired one), so it
// hands the handler a TenantRunner instead of one transaction.
//
// It never takes a target firm from the request: the only firm id that comes
// in is the caller's own session tenant, and the demo engine refuses unless
// that firm carries the demo flag (src/engines/demo/guard.ts).

import { errorResponse, HttpError } from "@/tenancy/route";
import type { Permission } from "@/auth/rbac";
import type { Principal } from "@/auth/types";
import type { TenantRunner } from "@/engines/demo/reset";

export interface DemoRouteContext {
  run: TenantRunner;
  tenantId: string;
  principal: Principal;
}

export async function demoRoute<T>(
  label: string,
  permission: Permission,
  handler: (ctx: DemoRouteContext) => Promise<T>,
  opts: { status?: number } = {}
): Promise<Response> {
  try {
    const { resolveRequestTenantId, requirePrincipal } = await import("@/auth/request");
    const tenantId = await resolveRequestTenantId();
    const [{ withTenant }, { ensureServerApprovals }] = await Promise.all([import("@/tenancy/withTenant"), import("@/compliance/server")]);
    await ensureServerApprovals();
    const principal = await withTenant(tenantId, (tx) => requirePrincipal(tx, tenantId, permission));
    const run: TenantRunner = (id, fn) => withTenant(id, fn);
    const body = await handler({ run, tenantId, principal });
    return Response.json(body ?? null, { status: opts.status ?? 200 });
  } catch (err) {
    return errorResponse(label, err);
  }
}

export { HttpError };
