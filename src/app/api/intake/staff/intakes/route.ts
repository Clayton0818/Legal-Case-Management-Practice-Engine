// c122 — create an intake a staff member is entering by hand (walk-in, or a
// call taken outside the firm's phone system). Staff-only: unlike the shared
// /api/intake/inbound endpoint, this route always resolves the signed-in staff
// member (and, on a dev or demo deployment, the dev session's user), so the
// staff console works without the dev-only user header.
import { tenantRoute } from "@/tenancy/route";
import { createStaffEnteredIntake } from "@/engines/intake/staffEntry/service";
import { optionalStr, readJson, requireActingUserId, str } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return tenantRoute("POST /api/intake/staff/intakes", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    const staffUserId = await requireActingUserId(tx, tenantId, req);
    return createStaffEnteredIntake(tx, {
      tenantId,
      staffUserId,
      channel: str(body, "channel"),
      name: str(body, "name"),
      email: optionalStr(body, "email"),
      phone: optionalStr(body, "phone"),
      language: optionalStr(body, "language"),
    });
  });
}
