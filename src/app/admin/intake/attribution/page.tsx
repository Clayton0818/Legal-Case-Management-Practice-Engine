// Lead-source & conversion-funnel dashboard (board card c74). Feeds the
// firm insights dashboard (c33, /admin/insights) conceptually — this is the
// intake engine's own view of the same idea, kept as a separate page
// because src/engines/README.md's engine-file boundary means this engine
// may not edit /admin/insights/page.tsx directly (that page, and
// src/app/admin/_lib/queries.ts, sit outside src/app/admin/intake/**). See
// this PR's description for the open question that follows from that.
//
// Internal/staff only, and every number on this page is an aggregate across
// sessions — counts, rates, day-stats. Nothing here lists an individual
// lead, and nothing here is reachable from any client-facing route.
import Link from "next/link";
import { getDevTenantId } from "@/tenancy/devTenant";
import { formatEnumLabel, formatPercent } from "../../_lib/format";
import { Card, Notice, PageHeader, SectionTitle, StatusPill } from "../../_components/ui";
import { FUNNEL_STAGES, type AttributionFunnelReport, type FunnelBucket } from "@/engines/intake/attribution/funnel";

export const dynamic = "force-dynamic";

interface PageData {
  report: (AttributionFunnelReport & { staffNames: Record<string, string> }) | null;
  error: string | null;
}

async function loadData(): Promise<PageData> {
  try {
    const tenantId = getDevTenantId();
    const [{ withTenant }, { fetchLeadAttributionReport }] = await Promise.all([
      import("@/tenancy/withTenant"),
      import("@/engines/intake/attribution/queries"),
    ]);
    const report = await withTenant(tenantId, (tx) => fetchLeadAttributionReport(tx, tenantId));
    return { report, error: null };
  } catch (err) {
    console.error("[admin/intake/attribution] failed to load:", err);
    return { report: null, error: "Could not load the lead-source report." };
  }
}

function formatDays(days: number | null): string {
  return days === null ? "—" : `${days.toFixed(1)}d`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[1.125rem] bg-white/70 p-4 ring-1 ring-slate-200">
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function FunnelBar({ label, count, total }: { label: string; count: number; total: number }) {
  const widthPct = total === 0 ? 0 : Math.max((count / total) * 100, count > 0 ? 4 : 0);
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-36 shrink-0 text-sm text-slate-700">{label}</span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-indigo-400" style={{ width: `${widthPct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-sm font-medium text-slate-800">{count}</span>
    </div>
  );
}

function bucketLabel(key: string, staffNames: Record<string, string>, kind: "source" | "practiceArea" | "staff"): string {
  if (kind === "staff") {
    if (key === "unassigned") return "Unassigned";
    return staffNames[key] ?? key;
  }
  return formatEnumLabel(key);
}

function BucketTable({
  title,
  buckets,
  staffNames,
  kind,
}: {
  title: string;
  buckets: FunnelBucket[];
  staffNames: Record<string, string>;
  kind: "source" | "practiceArea" | "staff";
}) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <Card className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200/70">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500">{title === "By intake staff" ? "Staff" : title === "By practice area" ? "Practice area" : "Source"}</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500">Inquiries</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500">Retained</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500">Conversion</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500">Avg. time to retain</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/70">
            {buckets.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={5}>
                  No data yet.
                </td>
              </tr>
            ) : (
              buckets.map((b) => (
                <tr key={b.key}>
                  <td className="px-4 py-3 font-semibold text-slate-900">{bucketLabel(b.key, staffNames, kind)}</td>
                  <td className="px-4 py-3 text-slate-700">{b.counts.inquiry}</td>
                  <td className="px-4 py-3 text-slate-700">{b.counts.retained}</td>
                  <td className="px-4 py-3 text-slate-700">{formatPercent(b.overallConversionRate)}</td>
                  <td className="px-4 py-3 text-slate-700">{formatDays(b.timeToRetain.averageDays)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

export default async function AttributionDashboardPage() {
  const { report, error } = await loadData();

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Intake · Go-to-market"
        title="Lead source & conversion"
        description="Where inquiries come from, and how far each source, practice area and staff member carries them through the funnel. Aggregate numbers only — no individual lead is named here."
        actions={
          <>
            <Link href="/admin/intake" className="text-sm text-slate-500 hover:underline">
              ← Intake queue
            </Link>
            <Link href="/admin/insights" className="text-sm text-slate-500 hover:underline">
              Firm insights ↗
            </Link>
          </>
        }
      />

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {report ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Inquiries" value={String(report.overall.counts.inquiry)} />
            <StatTile
              label="Retained"
              value={formatPercent(report.overall.overallConversionRate)}
              hint={`${report.overall.counts.retained} of ${report.overall.counts.inquiry}`}
            />
            <StatTile
              label="Avg. time to retain"
              value={formatDays(report.overall.timeToRetain.averageDays)}
              hint={report.overall.timeToRetain.count > 0 ? `median ${formatDays(report.overall.timeToRetain.medianDays)}` : undefined}
            />
            <StatTile
              label="Consult fee value (approx.)"
              value={report.overall.consultFeeValue.count > 0 ? formatCents(report.overall.consultFeeValue.totalCents) : "—"}
              hint="Consultation fees only — not the matter's retainer"
            />
          </div>

          <section>
            <SectionTitle hint="Each stage counts every lead that reached it, even one that skipped an earlier stage (e.g. a walk-in referral booked straight to a consult).">
              Funnel
            </SectionTitle>
            <Card className="p-6">
              {FUNNEL_STAGES.map((stage) => (
                <FunnelBar key={stage} label={formatEnumLabel(stage)} count={report.overall.counts[stage]} total={report.overall.counts.inquiry} />
              ))}
            </Card>
          </section>

          <BucketTable title="By source" buckets={report.bySource} staffNames={report.staffNames} kind="source" />
          <BucketTable title="By practice area" buckets={report.byPracticeArea} staffNames={report.staffNames} kind="practiceArea" />
          <BucketTable title="By intake staff" buckets={report.byStaff} staffNames={report.staffNames} kind="staff" />

          <section>
            <SectionTitle hint="Why a lead didn't retain, across every source.">Lost-lead reasons</SectionTitle>
            <Card className="overflow-x-auto">
              {report.overall.lostReasons.length === 0 ? (
                <p className="px-4 py-6 text-sm text-slate-500">No lost leads recorded yet.</p>
              ) : (
                <ul className="divide-y divide-slate-200/70 text-sm">
                  {report.overall.lostReasons.map((r) => (
                    <li key={r.reason} className="flex items-center justify-between px-4 py-3">
                      <span className="text-slate-800">{r.reason.replace(/_/g, " ")}</span>
                      <StatusPill tone="neutral">{r.count}</StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        </>
      ) : null}
    </div>
  );
}
