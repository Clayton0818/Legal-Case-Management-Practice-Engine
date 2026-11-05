import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { loadMobileAgenda } from "@/engines/all-engines/mobile/agenda";

export const dynamic = "force-dynamic";

/** The signed-in user's agenda for today: calendar events + tasks due (c100, calendar.view). */
export async function GET() {
  return allEnginesRoute("GET /api/all-engines/mobile/agenda", ({ tx, tenantId, staff }) => loadMobileAgenda(tx, tenantId, staff));
}
