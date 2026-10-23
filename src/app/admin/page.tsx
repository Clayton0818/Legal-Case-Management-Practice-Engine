// Matters queue (board card c24). Tenant-scoped via withTenant() +
// getDevTenantId() per ADR-0001 §D5 — see src/tenancy/devTenant.ts for why
// this is a temporary stand-in for real auth rather than a new mechanism.
import Link from "next/link";
import { getDevTenantId } from "@/tenancy/devTenant";
import { listMattersForTenant } from "./_lib/queries";
import { formatDate, formatEnumLabel, stageBadgeClass } from "./_lib/format";

// Tenant-scoped data must never be served from Next's static/full route
// cache — a cached response for one firm must not be reused for another,
// and dev-tenant data can change between requests regardless.
export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const tenantId = getDevTenantId();
  // withTenant (and, transitively, src/tenancy/db.ts) is imported lazily,
  // not statically at module scope. db.ts throws at import time if
  // DATABASE_URL is unset, and `next build`'s "collecting page data" step
  // actually loads every route/page module to inspect it — a static
  // top-level import here would make DATABASE_URL a *build-time*
  // requirement (CI's build step deliberately runs without it; see
  // .github/workflows/ci.yml).
  const { withTenant } = await import("@/tenancy/withTenant");
  const matterRows = await withTenant(tenantId, (tx) => listMattersForTenant(tx, tenantId));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-600">Case management</p>
          <h1 className="font-display text-5xl leading-none tracking-tight text-slate-900 md:text-6xl">Matters</h1>
          <p className="mt-2 text-sm text-slate-600">
            {matterRows.length} matter{matterRows.length === 1 ? "" : "s"} for this firm.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/demo"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-champagne-ink shadow-sm hover:bg-slate-100"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-champagne" />
            Demo (fictional data) →
          </Link>
          <Link
            href="/admin/insights"
            className="inline-flex min-h-[44px] items-center rounded-full bg-espresso px-5 text-sm font-semibold text-ivory-text hover:bg-espresso-panel"
          >
            View insights →
          </Link>
        </div>
      </div>

      {matterRows.length === 0 ? (
        <div className="rounded-3xl bg-white p-8 text-sm text-slate-600 shadow-sm">No matters yet.</div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden overflow-x-auto rounded-3xl bg-white p-2 shadow-sm lg:block">
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  <th className="px-5 py-3.5 text-left text-xs font-medium text-slate-600">Party</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium text-slate-600">Practice area</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium text-slate-600">Stage</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium text-slate-600">Opened</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium text-slate-600">Assigned to</th>
                </tr>
              </thead>
              <tbody>
                {matterRows.map((matter) => (
                  <tr key={matter.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-5 py-4">
                      <Link href={`/admin/matters/${matter.id}`} className="font-semibold text-slate-900 hover:underline">
                        {matter.partyName ?? "Unknown party"}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-slate-700">{matter.practiceArea ?? "—"}</td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${stageBadgeClass(matter.stage)}`}>
                        {formatEnumLabel(matter.stage)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-slate-700">{formatDate(matter.openedAt)}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-slate-700">{matter.assignedUserName ?? "Unassigned"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Tablet + phone: cards */}
          <ul className="space-y-2.5 lg:hidden">
            {matterRows.map((matter) => (
              <li key={matter.id}>
                <Link
                  href={`/admin/matters/${matter.id}`}
                  className="flex flex-col gap-1.5 rounded-2xl bg-white p-4 shadow-sm transition hover:bg-slate-100 md:flex-row md:items-center md:justify-between md:gap-4 md:px-5"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-base font-semibold text-slate-900">{matter.partyName ?? "Unknown party"}</span>
                    <span className="text-sm text-slate-600">
                      {matter.practiceArea ?? "—"} · opened {formatDate(matter.openedAt)} · {matter.assignedUserName ?? "Unassigned"}
                    </span>
                  </span>
                  <span className={`inline-flex w-fit shrink-0 items-center rounded-full px-3 py-1 text-xs font-semibold ${stageBadgeClass(matter.stage)}`}>
                    {formatEnumLabel(matter.stage)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
