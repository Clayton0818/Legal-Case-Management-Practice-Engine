// c124 — one matter's group thread. The page checks access and loads the view;
// every change goes through /api/all-engines/matters/[id]/group (audited).

import Link from "next/link";
import { notFound } from "next/navigation";
import { withStaff } from "../../_lib/load";
import { GroupPanel } from "./group-panel";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MatterGroupPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  if (!UUID_RE.test(matterId)) notFound();
  const { data, error } = await withStaff("group-messages", async ({ tx, tenantId, staff }) => {
    const { loadGroupView } = await import("@/engines/all-engines/groupMessaging/service");
    const { AllEnginesError } = await import("@/engines/all-engines/common/errors");
    try {
      return { found: true as const, view: await loadGroupView(tx, tenantId, staff, matterId) };
    } catch (err) {
      if (err instanceof AllEnginesError && err.status === 404) return { found: false as const };
      throw err;
    }
  });
  if (!data) return <p className="text-sm text-red-700">{error}</p>;
  if (!data.found) notFound();
  const v = data.view;

  return (
    <div className="space-y-4">
      <Link href="/admin/all-engines/group-messages" className="text-sm text-slate-500 hover:underline">
        ← All matters
      </Link>
      <div>
        <p className="text-sm text-slate-500">Group messages</p>
        <h1 className="text-lg font-semibold text-slate-900">{v.clientName ?? "Matter"}</h1>
      </div>
      <GroupPanel
        matterId={matterId}
        view={JSON.parse(JSON.stringify(v))}
      />
      <p className="text-xs text-slate-500">
        Clients get a notice with no case details and read the message in the portal. Withdrawing any client&rsquo;s consent, or ending the joint
        representation, closes the thread at once. Every step is recorded in the audit trail.
      </p>
    </div>
  );
}
