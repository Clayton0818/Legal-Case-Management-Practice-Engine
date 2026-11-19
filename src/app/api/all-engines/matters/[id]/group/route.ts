// c124 — the group thread for a matter with more than one client (staff only).
//   GET                                          → the thread, clients, consents and whether it's open
//   POST { action: "mark_joint", note? }         → a lawyer marks the matter as a joint representation
//   POST { action: "end_joint", reason }         → a lawyer ends it (the thread closes at once)
//   POST { action: "record_consent", partyId }   → record one client's consent to sharing
//   POST { action: "withdraw_consent", partyId, reason? }
//   POST { action: "post", body }                → post to the thread (only when it's open)
// Rules live in src/engines/all-engines/groupMessaging/. Every change is audited.
import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { isUuid, optString, readBody, reqString, reqUuid } from "@/engines/all-engines/common/body";
import { AllEnginesError } from "@/engines/all-engines/common/errors";
import {
  endJointRepresentation,
  loadGroupView,
  markJointRepresentation,
  postGroupMessage,
  recordSharingConsent,
  withdrawSharingConsent,
} from "@/engines/all-engines/groupMessaging/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function matterId(id: string): string {
  if (!isUuid(id)) throw new AllEnginesError("Invalid matter id.", 400);
  return id;
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return allEnginesRoute("GET /api/all-engines/matters/:id/group", async ({ tx, tenantId, staff }) => loadGroupView(tx, tenantId, staff, matterId(id)));
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return allEnginesRoute("POST /api/all-engines/matters/:id/group", async ({ tx, tenantId, staff }) => {
    const mid = matterId(id);
    const body = await readBody(req);
    switch (body.action) {
      case "mark_joint":
        return markJointRepresentation(tx, { tenantId, staff, matterId: mid, note: optString(body, "note") });
      case "end_joint":
        return endJointRepresentation(tx, { tenantId, staff, matterId: mid, reason: reqString(body, "reason") });
      case "record_consent":
        return recordSharingConsent(tx, { tenantId, staff, matterId: mid, partyId: reqUuid(body, "partyId") });
      case "withdraw_consent":
        return withdrawSharingConsent(tx, { tenantId, staff, matterId: mid, partyId: reqUuid(body, "partyId"), reason: optString(body, "reason") });
      case "post":
        return postGroupMessage(tx, { tenantId, staff, matterId: mid, body: reqString(body, "body") });
      default:
        throw new AllEnginesError("'action' must be mark_joint, end_joint, record_consent, withdraw_consent or post.", 400);
    }
  });
}
