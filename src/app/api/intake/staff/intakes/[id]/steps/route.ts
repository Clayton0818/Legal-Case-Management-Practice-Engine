// c122 — the guided intake page's actions, one per request. Each one calls
// the same service the shared steps endpoint uses (c65/c69), so the engine's
// rules apply unchanged: disclosures before the conflict-check names, and
// case details refused until the conflict check is clear. Staff-only: the
// acting staff member is always resolved and must hold an intake role.
import { HttpError, tenantRoute } from "@/tenancy/route";
import { acknowledgeDisclosures, recordCaseDetails, recordConflictMinimum } from "@/engines/intake/channels/service";
import { recordHumanContact } from "@/engines/intake/speedToLead/service";
import { parseOtherPartyNames, pickStaffCaseDetails } from "@/engines/intake/staffEntry/steps";
import { requireStaff, STAFF_ROLES } from "@/engines/intake/common/actors";
import { oneOf, readJson, requireActingUserId, str, stringArray, uuid } from "../../../../_lib/http";

export const dynamic = "force-dynamic";

const ACTIONS = ["acknowledge_disclosures", "conflict_minimum", "case_details", "human_contact"] as const;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/staff/intakes/[id]/steps", async ({ tx, tenantId }) => {
    const intakeSessionId = uuid(id, "intake id");
    const body = await readJson(req);
    const action = oneOf(body.action, ACTIONS, "action");
    const staffUserId = await requireActingUserId(tx, tenantId, req);
    await requireStaff(tx, tenantId, staffUserId, STAFF_ROLES, "work on an intake");
    switch (action) {
      case "acknowledge_disclosures":
        await acknowledgeDisclosures(tx, { tenantId, intakeSessionId, staffUserId });
        return { ok: true };
      case "conflict_minimum":
        await recordConflictMinimum(tx, {
          tenantId,
          intakeSessionId,
          fullName: str(body, "fullName"),
          otherPartyNames: parseOtherPartyNames(stringArray(body, "otherPartyNames", true).join("\n")),
          staffUserId,
        });
        return { ok: true };
      case "case_details": {
        const answers = body.answers;
        if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new HttpError(400, "'answers' must be an object.");
        await recordCaseDetails(tx, { tenantId, intakeSessionId, answers: pickStaffCaseDetails(answers as Record<string, unknown>), staffUserId });
        return { ok: true };
      }
      case "human_contact":
        await recordHumanContact(tx, { tenantId, intakeSessionId, userId: staffUserId, method: oneOf(body.method, ["in_person", "call_connected"] as const, "method") });
        return { ok: true };
    }
  });
}
