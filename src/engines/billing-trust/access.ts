// Who may do what with trust money (c76).
//
// Wave 3: the DECISION is now the shared policy's can() (src/core/permissions.ts),
// with the rights in TRUST_ACTION_RIGHTS below. Who holds which role is still
// this engine's stand-in, read from the acting user's own `users` row, so
// today's behaviour is unchanged:
//
//   owner      = users.role 'firm_admin', or role_label 'owner'
//   bookkeeper = users.role_label 'bookkeeper' on a staff role (firm_admin, attorney, intake_staff)
//   lawyer     = users.role 'attorney'
//
//   read trust ledgers / reconciliations  owner, bookkeeper, lawyer
//   post entries, place/release holds,
//   import statements, prepare a reconciliation, open ledgers   owner, bookkeeper
//   sign off a reconciliation as 'bookkeeper'                   owner, bookkeeper
//   sign off a reconciliation as 'lawyer'                       lawyer
//
// 'read_only' and 'integration_service' users, and anyone not 'active', can
// do none of it.
//
// TODO(Clayton — OPEN TRUST-PERMISSION QUESTION, not settled here):
// The shared permission model (c99) and this engine disagree:
//   - c99 gives 'trust.record' to the bookkeeper only (owner eligible but not
//     by default) and gives the firm admin NO trust rights at all; this
//     engine lets the OWNER post, and treats users.role 'firm_admin' as the
//     owner. TRUST_STANDIN_CONFIG grants owner 'trust.record' to keep that.
//   - c99 has no "sign off a reconciliation as the lawyer" right; the
//     attorney-only 'trust.approve_disbursement' stands in for it.
//   - roles come from users.role / users.role_label here, NOT from the
//     shared firm_role_assignments / user_capabilities (so a bookkeeper
//     assigned on the permissions page cannot post yet), and the firm's
//     permission_overrides are not applied to trust.
// Clayton (with the attorney/CPA reviewers) must decide who may post trust
// entries and approve disbursements; then trustRolesFor() becomes the shared
// loadUserPolicyActor() and TRUST_STANDIN_CONFIG goes away.

import { and, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { FIRM, can as policyCan, type FirmRole, type PolicyActor, type PolicyConfig } from "@/core/permissions";
import type { TenantTx } from "@/tenancy/withTenant";
import { TrustRuleError, type SignoffRole } from "./types";

export type TrustAction = "read" | "post" | "reconcile" | "signoff_bookkeeper" | "signoff_lawyer";

export interface TrustActorRow {
  id: string;
  role: string;
  roleLabel: string | null;
  status: string;
  displayName: string;
}

export interface TrustActor extends TrustActorRow {
  permissions: ReadonlySet<TrustAction>;
}

const STAFF_ROLES = new Set(["firm_admin", "attorney", "intake_staff"]);

function label(row: TrustActorRow): string {
  return (row.roleLabel ?? "").trim().toLowerCase();
}

export function isOwner(row: TrustActorRow): boolean {
  return row.role === "firm_admin" || (STAFF_ROLES.has(row.role) && label(row) === "owner");
}

export function isBookkeeper(row: TrustActorRow): boolean {
  return STAFF_ROLES.has(row.role) && label(row) === "bookkeeper";
}

export function isLawyer(row: TrustActorRow): boolean {
  return row.role === "attorney";
}

/** The shared right each trust action needs. See the TODO above: chosen to keep today's behaviour. */
export const TRUST_ACTION_RIGHTS: Readonly<Record<TrustAction, string>> = {
  read: "trust.view",
  post: "trust.record",
  reconcile: "trust.reconcile",
  signoff_bookkeeper: "trust.reconcile",
  signoff_lawyer: "trust.approve_disbursement",
};

/** Stand-in policy config: the owner may record trust entries (today's behaviour; see the TODO above). */
export const TRUST_STANDIN_CONFIG: PolicyConfig = Object.freeze({
  overrides: Object.freeze([{ role: "owner", right: "trust.record", effect: "grant" as const }]),
});

/** Pure: this engine's stand-in role mapping, expressed as shared roles. */
export function trustRolesFor(row: TrustActorRow): FirmRole[] {
  const roles: FirmRole[] = [];
  if (isOwner(row)) roles.push("owner");
  if (isLawyer(row)) roles.push("lawyer");
  if (isBookkeeper(row)) roles.push("bookkeeper");
  return roles;
}

export function trustPolicyActor(row: TrustActorRow): PolicyActor {
  return { kind: "staff", userId: row.id, roles: trustRolesFor(row), status: row.status };
}

/** Pure: the trust actions a user row allows, decided by the shared can(). */
export function trustPermissions(row: TrustActorRow): Set<TrustAction> {
  const actor = trustPolicyActor(row);
  const out = new Set<TrustAction>();
  for (const [action, right] of Object.entries(TRUST_ACTION_RIGHTS) as [TrustAction, string][]) {
    if (policyCan(actor, right, FIRM, TRUST_STANDIN_CONFIG)) out.add(action);
  }
  return out;
}

export function toActor(row: TrustActorRow): TrustActor {
  return { ...row, permissions: trustPermissions(row) };
}

export function can(actor: TrustActor, action: TrustAction): boolean {
  return actor.permissions.has(action);
}

export function signoffAction(role: SignoffRole): TrustAction {
  return role === "lawyer" ? "signoff_lawyer" : "signoff_bookkeeper";
}

const ACTION_WORDS: Record<TrustAction, string> = {
  read: "view trust records",
  post: "record trust entries",
  reconcile: "prepare trust reconciliations",
  signoff_bookkeeper: "sign off a reconciliation as bookkeeper",
  signoff_lawyer: "sign off a reconciliation as the lawyer",
};

export function assertCan(actor: TrustActor, action: TrustAction): void {
  if (!can(actor, action)) {
    throw new TrustRuleError("NOT_ALLOWED", `Not allowed: only the firm owner or bookkeeper (or a lawyer, for lawyer sign-off) can ${ACTION_WORDS[action]}.`, {
      action,
    });
  }
}

/** Load the acting user from `users` (RLS-scoped, plus an explicit tenant filter). Unknown users get no permissions. */
export async function loadTrustActor(tx: TenantTx, tenantId: string, userId: string): Promise<TrustActor> {
  const [row] = await tx
    .select({ id: users.id, role: users.role, roleLabel: users.roleLabel, status: users.status, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  if (!row) return toActor({ id: userId, role: "none", roleLabel: null, status: "unknown", displayName: "Unknown user" });
  return toActor(row);
}
