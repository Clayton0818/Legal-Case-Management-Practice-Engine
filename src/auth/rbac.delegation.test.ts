// Wave 3: rbac.permissionsFor() now asks the shared policy (src/core/permissions.ts)
// about the decision permissions. This pins that NOTHING changed: the result
// equals the pre-wave-3 implementation (copied verbatim below) for every role,
// every capability subset (including ineligible/stale grants) and every status.

import { describe, expect, it } from "vitest";
import {
  ATTORNEY_ONLY,
  CAPABILITIES,
  CAPABILITY_ELIGIBLE_ROLES,
  CAPABILITY_PERMISSIONS,
  DECISION_RIGHTS,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  can,
  permissionsFor,
  type Capability,
  type Permission,
  type RbacSubject,
} from "./rbac";

/** The pre-wave-3 permissionsFor(), verbatim. */
function legacyPermissionsFor(subject: RbacSubject): Set<Permission> {
  const out = new Set<Permission>();
  if (subject.status && subject.status !== "active") return out;
  for (const p of ROLE_PERMISSIONS[subject.role] ?? []) out.add(p);
  for (const c of subject.capabilities) {
    if (!CAPABILITY_ELIGIBLE_ROLES[c]?.includes(subject.role)) continue;
    for (const p of CAPABILITY_PERMISSIONS[c]) out.add(p);
  }
  if (subject.role !== "attorney") for (const p of ATTORNEY_ONLY) out.delete(p);
  return out;
}

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((acc, item) => [...acc, ...acc.map((s) => [...s, item])], [[]]);
}

describe("rbac delegates decision permissions to the shared policy", () => {
  it("maps every attorney-only permission to a shared right", () => {
    for (const p of ATTORNEY_ONLY) expect(DECISION_RIGHTS[p]).toBeTruthy();
  });

  it("is identical to the pre-wave-3 behaviour for every role × capability set × status", () => {
    let checked = 0;
    for (const role of ROLES) {
      for (const capabilities of subsets<Capability>(CAPABILITIES)) {
        for (const status of [undefined, "active", "invited", "disabled"]) {
          const subject: RbacSubject = { role, capabilities, status };
          const expected = legacyPermissionsFor(subject);
          expect([...permissionsFor(subject)].sort(), `${role} ${capabilities.join("+")} ${status}`).toEqual([...expected].sort());
          for (const p of PERMISSIONS) expect(can(subject, p)).toBe(expected.has(p));
          checked++;
        }
      }
    }
    expect(checked).toBe(ROLES.length * 4 * 4);
  });
});
