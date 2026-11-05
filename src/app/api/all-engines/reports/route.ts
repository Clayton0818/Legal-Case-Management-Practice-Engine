import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { fetchCrossEngineReport, type ReportFilters } from "@/engines/all-engines/reports/queries";

export const dynamic = "force-dynamic";

function parseFilters(url: URL): ReportFilters {
  const params = url.searchParams;
  const lawyerUserId = params.get("lawyerUserId");
  const practiceArea = params.get("practiceArea");
  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  return {
    lawyerUserId: lawyerUserId || null,
    practiceArea: practiceArea || null,
    from: fromRaw ? new Date(fromRaw) : null,
    to: toRaw ? new Date(toRaw) : null,
  };
}

/**
 * Cross-engine report (c101), JSON. Query params: lawyerUserId, practiceArea,
 * from, to (ISO date strings). Internal only — see
 * src/engines/all-engines/reports/queries.ts for exactly what is and isn't
 * covered (billing/trust/lead-conversion metrics are explicitly blocked, not
 * silently omitted — see the report's own `blocked` field).
 */
export async function GET(req: Request) {
  const filters = parseFilters(new URL(req.url));
  return allEnginesRoute("GET /api/all-engines/reports", ({ tx, tenantId }) => fetchCrossEngineReport(tx, tenantId, filters));
}
