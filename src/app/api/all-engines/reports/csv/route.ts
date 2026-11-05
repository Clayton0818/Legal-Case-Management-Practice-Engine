// CSV export for one section of the c101 cross-engine report. This does NOT
// go through tenantRoute()/allEnginesRoute() (../route.ts uses those): both
// always wrap the handler's return value with Response.json(), which would
// JSON-encode a CSV string (quoting it, escaping every embedded quote)
// instead of serving it as text/csv. So this route open-codes the same
// tenant-resolution + lazy-withTenant + fail-safe-approvals sequence
// tenantRoute() uses internally (see src/tenancy/route.ts), then returns a
// raw Response with the right content type instead.

import { errorResponse } from "@/tenancy/route";
import {
  fetchMattersByPracticeArea,
  fetchMattersByStage,
  fetchOverdueTasks,
  fetchPendingConflictChecks,
  fetchUpcomingDeadlines,
  type ReportFilters,
} from "@/engines/all-engines/reports/queries";
import { toCsv } from "@/engines/all-engines/reports/csvExport";
import type { TenantTx } from "@/tenancy/withTenant";

export const dynamic = "force-dynamic";

export const REPORT_SECTIONS = [
  "matters-by-stage",
  "matters-by-practice-area",
  "overdue-tasks",
  "deadlines-upcoming",
  "conflict-checks-pending",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export function isReportSection(value: string | null): value is ReportSection {
  return value !== null && (REPORT_SECTIONS as readonly string[]).includes(value);
}

async function buildSectionCsv(tx: TenantTx, tenantId: string, section: ReportSection, filters: ReportFilters): Promise<string> {
  switch (section) {
    case "matters-by-stage": {
      const rows = await fetchMattersByStage(tx, tenantId, filters);
      return toCsv(
        ["stage", "count"],
        rows.map((r) => [r.stage, r.count])
      );
    }
    case "matters-by-practice-area": {
      const rows = await fetchMattersByPracticeArea(tx, tenantId, filters);
      return toCsv(
        ["practice_area", "count"],
        rows.map((r) => [r.practiceArea, r.count])
      );
    }
    case "overdue-tasks": {
      const rows = await fetchOverdueTasks(tx, tenantId, filters);
      return toCsv(
        ["task_id", "title", "kind", "due_at", "matter_id", "owner_user_id"],
        rows.map((r) => [r.taskId, r.title, r.kind, r.dueAt.toISOString(), r.matterId, r.ownerUserId])
      );
    }
    case "deadlines-upcoming": {
      const rows = await fetchUpcomingDeadlines(tx, tenantId, filters);
      return toCsv(
        ["event_id", "title", "event_type", "starts_at", "matter_id", "status"],
        rows.map((r) => [r.eventId, r.title, r.eventType, r.startsAt.toISOString(), r.matterId, r.status])
      );
    }
    case "conflict-checks-pending": {
      const rows = await fetchPendingConflictChecks(tx, tenantId, filters);
      return toCsv(
        ["result_id", "role_sought", "outcome", "matter_id", "created_at"],
        rows.map((r) => [r.resultId, r.roleSought, r.outcome, r.matterId, r.createdAt.toISOString()])
      );
    }
    default: {
      // Unreachable: isReportSection() already narrowed `section` to ReportSection
      // before this is called. Kept only so an added REPORT_SECTIONS member
      // fails loudly here instead of silently returning an empty CSV.
      const exhaustiveCheck: never = section;
      throw new Error(`Unhandled report section: ${String(exhaustiveCheck)}`);
    }
  }
}

/** ?section=<ReportSection>&lawyerUserId=&practiceArea=&from=&to= -> text/csv. 400 for an unknown/missing section. */
export async function GET(req: Request): Promise<Response> {
  const label = "GET /api/all-engines/reports/csv";
  const url = new URL(req.url);
  const section = url.searchParams.get("section");
  if (!isReportSection(section)) {
    return Response.json({ error: `Unknown or missing 'section'. Expected one of: ${REPORT_SECTIONS.join(", ")}.` }, { status: 400 });
  }
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const filters: ReportFilters = {
    lawyerUserId: url.searchParams.get("lawyerUserId") || null,
    practiceArea: url.searchParams.get("practiceArea") || null,
    from: fromRaw ? new Date(fromRaw) : null,
    to: toRaw ? new Date(toRaw) : null,
  };

  try {
    const { resolveRequestTenantId } = await import("@/auth/request");
    const tenantId = await resolveRequestTenantId();
    const [{ withTenant }, { ensureServerApprovals }] = await Promise.all([import("@/tenancy/withTenant"), import("@/compliance/server")]);
    await ensureServerApprovals();
    const csv = await withTenant(tenantId, (tx) => buildSectionCsv(tx, tenantId, section, filters));
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${section}.csv"`,
      },
    });
  } catch (err) {
    return errorResponse(label, err);
  }
}
