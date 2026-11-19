// c123 — the case assistant for one matter. The page only checks access and
// shows the matter; questions and briefings go through
// POST /api/all-engines/matters/[id]/assistant (audited).

import Link from "next/link";
import { notFound } from "next/navigation";
import { withStaff } from "../../_lib/load";
import { AssistantPanel } from "./assistant-panel";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MatterAssistantPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  if (!UUID_RE.test(matterId)) notFound();
  const { data, error } = await withStaff("assistant", async ({ tx, tenantId, staff }) => {
    const { assistantStatus, loadMatterEvidence, matterClientName } = await import("@/engines/all-engines/caseAssistant/service");
    const { AllEnginesError } = await import("@/engines/all-engines/common/errors");
    try {
      const evidence = await loadMatterEvidence(tx, tenantId, staff, matterId);
      const clientName = await matterClientName(tx, tenantId, matterId);
      return { found: true as const, recordCount: evidence.records.length, withheld: evidence.withheldDocuments, clientName, status: assistantStatus() };
    } catch (err) {
      if (err instanceof AllEnginesError && err.status === 404) return { found: false as const };
      throw err;
    }
  });
  if (!data) return <p className="text-sm text-red-700">{error}</p>;
  if (!data.found) notFound();

  return (
    <div className="space-y-4">
      <Link href="/admin/all-engines/assistant" className="text-sm text-slate-500 hover:underline">
        ← All matters
      </Link>
      <div>
        <p className="text-sm text-slate-500">Case assistant</p>
        <h1 className="text-lg font-semibold text-slate-900">{data.clientName ?? "Matter"}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Answers come from this matter&rsquo;s {data.recordCount} records you can see: its parties, calendar, tasks, flags and document list.
          {data.withheld > 0
            ? ` ${data.withheld} privileged, work-product or sealed document${data.withheld === 1 ? " is" : "s are"} never included.`
            : ""}
        </p>
      </div>
      {data.status.pendingPlaceholder ? (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          AI answers are off until the AI vendor is reviewed, so the assistant lists the records that match your question instead.
          <span className="mt-1 block font-mono text-xs">{data.status.pendingPlaceholder}</span>
        </p>
      ) : !data.status.aiAvailable ? (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">No AI model is connected yet, so the assistant lists the matching records instead.</p>
      ) : null}
      <AssistantPanel matterId={matterId} />
      <p className="text-xs text-slate-500">
        The assistant never gives legal advice or legal research, never predicts outcomes, and never sets or confirms a deadline. Every question and
        answer is recorded in the audit trail.
      </p>
    </div>
  );
}
