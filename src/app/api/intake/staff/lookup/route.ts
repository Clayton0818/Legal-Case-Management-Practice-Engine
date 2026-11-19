// c122 — before a staff member creates an intake by hand: does the firm
// already have this person, with an intake still open? POST (not GET) so
// names, emails and phone numbers never land in URLs or access logs.
import { tenantRoute } from "@/tenancy/route";
import { findExistingContacts } from "@/engines/intake/staffEntry/service";
import { optionalStr, readJson, requireActingUserId } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return tenantRoute("POST /api/intake/staff/lookup", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    const staffUserId = await requireActingUserId(tx, tenantId, req);
    return {
      matches: await findExistingContacts(tx, {
        tenantId,
        staffUserId,
        name: optionalStr(body, "name"),
        email: optionalStr(body, "email"),
        phone: optionalStr(body, "phone"),
      }),
    };
  });
}
