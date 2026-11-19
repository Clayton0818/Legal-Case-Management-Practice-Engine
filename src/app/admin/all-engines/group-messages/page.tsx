// c124 — pick a matter with two or more clients to open its group thread.
// Lists only matters the signed-in person may open.

import Link from "next/link";
import { withStaff } from "../_lib/load";

export const dynamic = "force-dynamic";

export default async function GroupMessagesPickerPage() {
  const { data, error } = await withStaff("group-messages", async ({ tx, tenantId, staff }) => {
    const { listGroupMatters } = await import("@/engines/all-engines/groupMessaging/service");
    return listGroupMatters(tx, tenantId, staff);
  });
  if (!data) return <p className="text-sm text-red-700">{error}</p>;

  return (
    <div className="space-y-4">
      <Link href="/admin/all-engines" className="text-sm text-slate-500 hover:underline">
        ← Firm-wide settings
      </Link>
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Group messages</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          For matters where the firm represents more than one client, such as spouses or business partners. A lawyer marks the matter as a joint
          representation, each client consents to sharing, and then the firm can write to all of them in one thread. Opposing parties never see it.
        </p>
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-slate-600">No matters you can open have two or more clients.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {data.map((m) => (
            <li key={m.matterId}>
              <Link href={`/admin/all-engines/group-messages/${m.matterId}`} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 hover:bg-slate-50">
                <span className="font-medium text-slate-900">{m.clientName}</span>
                <span className="text-sm text-slate-500">{m.clientCount} clients</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
