// Shared plumbing for tenant-scoped API routes (src/app/api/<slug>/**):
//
//   export const dynamic = "force-dynamic";
//   export async function GET() {
//     return tenantRoute("GET /api/document/checklist", ({ tx, tenantId }) => listChecklist(tx, tenantId));
//   }
//
//   // With a permission requirement (src/core/permissions.ts rights):
//   return tenantRoute("POST /api/x", handler, { right: "trust.record" });
//   return tenantRoute({ label: "POST /api/x", right: "trust.record" }, handler);
//
// - resolves the tenant from the request's session (src/auth/request.ts,
//   c34): the vendor's signed tenant claim, or DEV_TENANT_ID in dev mode —
//   routes do not change; handlers that need the caller's identity or a
//   permission call requirePrincipal(tx, tenantId, "<permission>");
// - imports withTenant() lazily, so `next build` never needs DATABASE_URL;
// - loads compliance approvals (fail safe) before the handler runs;
// - with `right`, resolves the signed-in staff member's roles
//   (users.role + user_capabilities + firm_role_assignments, and the firm's
//   permission_overrides; see src/core/permissionActor.ts), asks can(), and
//   on a denial writes an `access.denied` audit row and returns HTTP 403
//   without saying why (the reason is only in the audit row). The handler
//   receives the resolved actor as `ctx.policy`;
// - maps a PendingApprovalError to HTTP 423 with the visible placeholder, so
//   a gated action is visibly blocked rather than silently skipped.

import type { TenantTx } from "./withTenant";
import { PendingApprovalError } from "@/compliance/approvals";
import { FlagNotFoundError } from "@/core/flags";
import type { PolicyResource } from "@/core/permissions";
import type { ResolvedActor } from "@/core/permissionActor";

export interface TenantRouteContext {
  tx: TenantTx;
  tenantId: string;
  /** Set when the route declared a `right`: the actor the check ran against. */
  policy?: ResolvedActor;
}

export interface TenantRouteOptions {
  status?: number;
  /** A right from src/core/permissions.ts (e.g. 'trust.view'). Unknown rights are always denied. */
  right?: string;
  /** What the right is checked against (default: the firm). A function runs inside the transaction. */
  resource?: PolicyResource | ((ctx: { tx: TenantTx; tenantId: string }) => Promise<PolicyResource>);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The body of every permission refusal. Deliberately says nothing about which right or why. */
export const FORBIDDEN_BODY = Object.freeze({ error: "You do not have permission to do this." });

/** Pure: turn an error from a route handler into a JSON response. */
export function errorResponse(label: string, err: unknown): Response {
  if (err instanceof PendingApprovalError) {
    return Response.json(
      { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder },
      { status: 423 }
    );
  }
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof FlagNotFoundError) return Response.json({ error: "Flag not found." }, { status: 404 });
  console.error(`[${label}] failed:`, err);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}

export type RouteOutcome<T> = { denied: true } | { denied: false; value: T };

/** Pure: the HTTP response for a handler outcome. */
export function outcomeResponse<T>(outcome: RouteOutcome<T>, status = 200): Response {
  if (outcome.denied) return Response.json(FORBIDDEN_BODY, { status: 403 });
  return Response.json(outcome.value ?? null, { status });
}

/**
 * Inside an open tenant transaction: run the permission check (when `right`
 * is set), then the handler. A denial is RETURNED, not thrown, so the
 * `access.denied` audit row commits with the transaction.
 */
export async function runTenantHandler<T>(
  tx: TenantTx,
  tenantId: string,
  label: string,
  options: TenantRouteOptions,
  handler: (ctx: TenantRouteContext) => Promise<T>
): Promise<RouteOutcome<T>> {
  if (options.right === undefined) return { denied: false, value: await handler({ tx, tenantId }) };

  const [{ requirePrincipal }, { loadPolicyActor }, { decide, FIRM }, { audit }] = await Promise.all([
    import("@/auth/request"),
    import("@/core/permissionActor"),
    import("@/core/permissions"),
    import("@/core/audit"),
  ]);
  const principal = await requirePrincipal(tx, tenantId);
  const policy = await loadPolicyActor(tx, tenantId, {
    userId: principal.userId,
    role: principal.role,
    capabilities: principal.capabilities,
    status: "active",
  });
  const resource = typeof options.resource === "function" ? await options.resource({ tx, tenantId }) : (options.resource ?? FIRM);
  const decision = decide(policy.actor, options.right, resource, policy.config);
  if (!decision.allowed) {
    await audit(tx, {
      tenantId,
      engine: "core",
      action: "access.denied",
      actor: principal.userId ? { type: "user", userId: principal.userId } : { type: "system" },
      matterId: resource.type === "matter" ? resource.matterId : null,
      payload: { right: decision.right, reason: decision.reason, attempted: label, roles: policy.roles },
    });
    return { denied: true };
  }
  return { denied: false, value: await handler({ tx, tenantId, policy }) };
}

export async function tenantRoute<T>(
  labelOrOptions: string | (TenantRouteOptions & { label: string }),
  handler: (ctx: TenantRouteContext) => Promise<T>,
  opts: TenantRouteOptions = {}
): Promise<Response> {
  const { label, ...options } = typeof labelOrOptions === "string" ? { ...opts, label: labelOrOptions } : { ...opts, ...labelOrOptions };
  try {
    const { resolveRequestTenantId } = await import("@/auth/request");
    const tenantId = await resolveRequestTenantId();
    const [{ withTenant }, { ensureServerApprovals }] = await Promise.all([
      import("./withTenant"),
      import("@/compliance/server"),
    ]);
    await ensureServerApprovals();
    const outcome = await withTenant(tenantId, (tx) => runTenantHandler(tx, tenantId, label, options, handler));
    return outcomeResponse(outcome, options.status ?? 200);
  } catch (err) {
    return errorResponse(label, err);
  }
}
