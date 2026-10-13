// Database side of the shared permission model (src/core/permissions.ts).
//
// Resolves WHO an actor is, in policy terms, from the three places roles live:
//   - users.role (+ status)             the c34 account type
//   - user_capabilities (active rows)   c34 grants: conflicts_attorney, bookkeeper
//   - firm_role_assignments (active)    c99 product roles: owner, paralegal, …
// plus the firm's permission_overrides. permissions.ts stays pure; this file
// is the only place that reads those tables for a permission decision, so
// tenantRoute({ right }) and every engine resolve roles the same way.
//
// Every query filters on tenant_id explicitly as well as running under RLS.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { users } from "@/db/schema";
import { firmRoleAssignments, permissionOverrides, userCapabilities } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";
import {
  baseRolesFor,
  combineRoles,
  isFirmRole,
  type FirmRole,
  type OverrideEffect,
  type PolicyActor,
  type PolicyConfig,
} from "./permissions";

// ---------------------------------------------------------------------------
// user_capabilities (c34) — the core read API engines asked for
// ---------------------------------------------------------------------------

/** Active (not revoked) c34 capabilities per user. Users with none are absent from the map. */
export async function activeCapabilitiesByUser(
  tx: TenantTx,
  tenantId: string,
  userIds: readonly string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select({ userId: userCapabilities.userId, capability: userCapabilities.capability })
    .from(userCapabilities)
    .where(and(eq(userCapabilities.tenantId, tenantId), inArray(userCapabilities.userId, [...userIds]), isNull(userCapabilities.revokedAt)));
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.capability]);
  return out;
}

/** Active c34 capabilities of one user. */
export async function activeCapabilities(tx: TenantTx, tenantId: string, userId: string): Promise<string[]> {
  return (await activeCapabilitiesByUser(tx, tenantId, [userId])).get(userId) ?? [];
}

// ---------------------------------------------------------------------------
// firm_role_assignments + permission_overrides (c99)
// ---------------------------------------------------------------------------

/** Active (not revoked) assigned product roles per user. Unknown role names are ignored. */
export async function assignedRolesByUser(
  tx: TenantTx,
  tenantId: string,
  userIds: readonly string[]
): Promise<Map<string, FirmRole[]>> {
  const out = new Map<string, FirmRole[]>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select({ userId: firmRoleAssignments.userId, role: firmRoleAssignments.role })
    .from(firmRoleAssignments)
    .where(and(eq(firmRoleAssignments.tenantId, tenantId), inArray(firmRoleAssignments.userId, [...userIds]), isNull(firmRoleAssignments.revokedAt)));
  for (const r of rows) {
    if (!isFirmRole(r.role)) continue;
    out.set(r.userId, [...(out.get(r.userId) ?? []), r.role]);
  }
  return out;
}

/** The firm's overrides of the role × right matrix. */
export async function loadPolicyConfig(tx: TenantTx, tenantId: string): Promise<PolicyConfig> {
  const rows = await tx
    .select({ role: permissionOverrides.role, right: permissionOverrides.right, effect: permissionOverrides.effect })
    .from(permissionOverrides)
    .where(eq(permissionOverrides.tenantId, tenantId));
  return { overrides: rows.map((r) => ({ role: r.role, right: r.right, effect: r.effect as OverrideEffect })) };
}

// ---------------------------------------------------------------------------
// The resolved actor
// ---------------------------------------------------------------------------

/** What is already known about the acting staff member (e.g. a c34 Principal). */
export interface ActorSource {
  /** null only for the synthetic dev principal (no users row, so no assigned roles). */
  userId: string | null;
  /** users.role */
  role: string | null;
  /** c34 capabilities; loaded from user_capabilities when omitted. */
  capabilities?: readonly string[];
  /** users.status; a Principal is always 'active'. */
  status?: string | null;
}

export interface ResolvedActor {
  userId: string | null;
  /** Roles implied by users.role + capabilities. */
  baseRoles: FirmRole[];
  /** Roles assigned in firm_role_assignments. */
  assignedRoles: FirmRole[];
  /** Both, canonical order. */
  roles: FirmRole[];
  actor: PolicyActor;
  config: PolicyConfig;
}

/** Build the policy actor for a staff member whose users row is already known. */
export async function loadPolicyActor(tx: TenantTx, tenantId: string, src: ActorSource): Promise<ResolvedActor> {
  const capabilities = src.capabilities ?? (src.userId ? await activeCapabilities(tx, tenantId, src.userId) : []);
  const baseRoles = baseRolesFor(src.role, capabilities);
  const assignedRoles = src.userId ? ((await assignedRolesByUser(tx, tenantId, [src.userId])).get(src.userId) ?? []) : [];
  const roles = combineRoles(baseRoles, assignedRoles);
  return {
    userId: src.userId,
    baseRoles,
    assignedRoles,
    roles,
    actor: { kind: "staff", userId: src.userId, roles, status: src.status ?? "active" },
    config: await loadPolicyConfig(tx, tenantId),
  };
}

/** Build the policy actor for any user id of this firm. An unknown user holds nothing. */
export async function loadUserPolicyActor(tx: TenantTx, tenantId: string, userId: string): Promise<ResolvedActor> {
  const [u] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  if (!u) {
    return {
      userId,
      baseRoles: [],
      assignedRoles: [],
      roles: [],
      actor: { kind: "staff", userId, roles: [], status: "unknown" },
      config: await loadPolicyConfig(tx, tenantId),
    };
  }
  return loadPolicyActor(tx, tenantId, { userId, role: u.role, status: u.status });
}
