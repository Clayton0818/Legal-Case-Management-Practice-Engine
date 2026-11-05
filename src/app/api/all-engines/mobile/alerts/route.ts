import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { readBody, reqUuid } from "@/engines/all-engines/common/body";
import { acknowledgeMyAlert, listMyAlerts } from "@/engines/all-engines/mobile/alerts";

export const dynamic = "force-dynamic";

/** The signed-in user's own open alerts (c100, flags.internal). */
export async function GET() {
  return allEnginesRoute("GET /api/all-engines/mobile/alerts", ({ tx, tenantId, staff }) => listMyAlerts(tx, tenantId, staff));
}

/** Acknowledge an alert: { flagId } (c100, flags.acknowledge). */
export async function POST(req: Request) {
  return allEnginesRoute("POST /api/all-engines/mobile/alerts", async ({ tx, tenantId, staff }) => {
    const body = await readBody(req);
    return acknowledgeMyAlert(tx, tenantId, staff, reqUuid(body, "flagId"));
  });
}
