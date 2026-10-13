// Wave 3: trustPermissions() now asks the shared can() (src/core/permissions.ts).
// This pins that today's trust behaviour is unchanged (owner and bookkeeper
// post/reconcile; lawyers view and sign off as lawyer) by comparing against the
// pre-wave-3 implementation, copied verbatim, for every role × label × status.

import { describe, expect, it } from "vitest";
import { isBookkeeper, isLawyer, isOwner, trustPermissions, type TrustAction, type TrustActorRow } from "./access";

function legacyTrustPermissions(row: TrustActorRow): Set<TrustAction> {
  const out = new Set<TrustAction>();
  if (row.status !== "active") return out;
  const poster = isOwner(row) || isBookkeeper(row);
  if (poster || isLawyer(row)) out.add("read");
  if (poster) {
    out.add("post");
    out.add("reconcile");
    out.add("signoff_bookkeeper");
  }
  if (isLawyer(row)) out.add("signoff_lawyer");
  return out;
}

const ROLES = ["firm_admin", "attorney", "intake_staff", "read_only", "integration_service", "none"];
const LABELS = [null, "", "owner", "Owner ", "bookkeeper", "BOOKKEEPER", "partner"];
const STATUSES = ["active", "invited", "disabled", "unknown"];

describe("billing-trust permissions through the shared policy", () => {
  it("match the pre-wave-3 stand-in exactly", () => {
    for (const role of ROLES) {
      for (const roleLabel of LABELS) {
        for (const status of STATUSES) {
          const row: TrustActorRow = { id: "00000000-0000-4000-8000-000000000001", role, roleLabel, status, displayName: "x" };
          expect([...trustPermissions(row)].sort(), `${role}/${roleLabel}/${status}`).toEqual([...legacyTrustPermissions(row)].sort());
        }
      }
    }
  });

  it("keeps the agreed shape: owner and bookkeeper post, lawyers view and sign off", () => {
    const row = (role: string, roleLabel: string | null = null): TrustActorRow => ({ id: "u", role, roleLabel, status: "active", displayName: "x" });
    expect([...trustPermissions(row("firm_admin"))].sort()).toEqual(["post", "read", "reconcile", "signoff_bookkeeper"]);
    expect([...trustPermissions(row("intake_staff", "bookkeeper"))].sort()).toEqual(["post", "read", "reconcile", "signoff_bookkeeper"]);
    expect([...trustPermissions(row("attorney"))].sort()).toEqual(["read", "signoff_lawyer"]);
    expect([...trustPermissions(row("read_only", "owner"))]).toEqual([]);
  });
});
