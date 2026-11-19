// c74 — the aggregate lead-source conversion-funnel report. Staff only.
// Every number here is an aggregate across sessions (counts, rates,
// day-stats) — this route never returns a per-lead list, so there is
// nothing here that could leak one client's identity into a report view.
import { HttpError, tenantRoute } from "@/tenancy/route";
import { fetchLeadAttributionReport } from "@/engines/intake/attribution/queries";
import { requireActingStaff } from "../../_lib/http";

export const dynamic = "force-dynamic";

function parseDateParam(value: string | null, name: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `'${name}' must be an ISO date.`);
  return parsed;
}

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/attribution/report", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    const url = new URL(req.url);
    const from = parseDateParam(url.searchParams.get("from"), "from");
    const to = parseDateParam(url.searchParams.get("to"), "to");
    return fetchLeadAttributionReport(tx, tenantId, { from, to });
  });
}
