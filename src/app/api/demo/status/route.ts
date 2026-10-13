// GET /api/demo/status — where the current DEMO firm is, and whether the
// caller's session points at it (c106). Read-only; any signed-in staff member.

import { demoRoute } from "../_lib/run";
import { loadDemoStatus } from "@/engines/demo/status";

export const dynamic = "force-dynamic";

export async function GET() {
  return demoRoute("GET /api/demo/status", "matters.read", ({ run, tenantId }) => loadDemoStatus(run, tenantId));
}
