// c123 — pick a matter to ask the case assistant about. Lists only matters
// the signed-in person may open (team, restrictions and screens apply).

import Link from "next/link";
import { withStaff } from "../_lib/load";

export const dynamic = "force-dynamic";

function words(v: string | null): string {
  return v ? v.replace(/_/g, " ") : "—";
}

export default async function AssistantPickerPage() {
  const { data, error } = await withStaff("assistant", async ({ tx, tenantId, staff }) => {
    const { listAssistantMatters, assistantStatus } = await import("@/engines/all-engines/caseAssistant/service");
    return { matters: await listAssistantMatters(tx, tenantId, staff), status: assistantStatus() };
  });
  if (!data) return <p className="text-sm text-red-700">{error}</p>;

  return (
    <div className="space-y-4">
      <Link href="/admin/all-engines" className="text-sm text-slate-500 hover:underline">
        ← Firm-wide settings
      </Link>
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Case assistant</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Ask a question about one matter, or get a catch-up briefing. Answers come only from that matter&rsquo;s records, with every source
          shown. It never gives legal advice and never sets or confirms a deadline.
        </p>
      </div>
      {data.status.pendingPlaceholder ? (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          AI answers are off until the AI vendor is reviewed. Until then the assistant shows the matching records instead.
          <span className="mt-1 block font-mono text-xs">{data.status.pendingPlaceholder}</span>
        </p>
      ) : null}
      {data.matters.length === 0 ? (
        <p className="text-sm text-slate-600">There are no matters you can open.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {data.matters.map((m) => (
            <li key={m.matterId}>
              <Link href={`/admin/all-engines/assistant/${m.matterId}`} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 hover:bg-slate-50">
                <span className="font-medium text-slate-900">{m.clientName}</span>
                <span className="text-sm text-slate-500">
                  {words(m.practiceArea)} · {words(m.stage)} · opened {new Date(m.openedAt).toLocaleDateString("en-US")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
