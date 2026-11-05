import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { listMyTasks } from "@/engines/all-engines/mobile/tasks";

export const dynamic = "force-dynamic";

/** The signed-in user's own open tasks (c100, calendar.view). */
export async function GET() {
  return allEnginesRoute("GET /api/all-engines/mobile/tasks", ({ tx, tenantId, staff }) => listMyTasks(tx, tenantId, staff));
}
