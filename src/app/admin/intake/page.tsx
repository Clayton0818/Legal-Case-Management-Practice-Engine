// Intake console (c65, c66, c69 + the approval status of every intake gate).
// Read-only overview: the one queue for every channel, open emergencies, and
// which intake features are still waiting for attorney / CPA / vendor sign-off.
// Actions go through /api/intake/**. Internal only — nothing here is client-facing.
import { getDevTenantId } from "@/tenancy/devTenant";
import { gateStatus } from "@/compliance/approvals";
import { INTAKE_GATE_KEYS, INTAKE_SHARED_GATE_KEYS } from "@/engines/intake/gates";
import { Card, Notice, PageHeader, SectionTitle, StatusPill } from "../_components/ui";

export const dynamic = "force-dynamic";

interface QueueRow {
  intakeSessionId: string;
  channel: string;
  status: string;
  fullName: string | null;
  safetyFlagged: boolean;
  emergencyUnacknowledged: boolean;
  responseTargetAt: Date | null;
  responseOutcome: string | null;
  fitOutcome: string | null;
  startedAt: Date;
}

async function loadData(): Promise<{ queue: QueueRow[]; emergencies: number; error: string | null }> {
  try {
    const tenantId = getDevTenantId();
    const [{ withTenant }, { ensureServerApprovals }, { listIntakeQueue }, { listOpenEmergencies }] = await Promise.all([
      import("@/tenancy/withTenant"),
      import("@/compliance/server"),
      import("@/engines/intake/channels/service"),
      import("@/engines/intake/emergency/service"),
    ]);
    await ensureServerApprovals();
    return await withTenant(tenantId, async (tx) => ({
      queue: (await listIntakeQueue(tx, tenantId, { limit: 50 })) as QueueRow[],
      emergencies: (await listOpenEmergencies(tx, tenantId)).length,
      error: null,
    }));
  } catch (err) {
    console.error("[admin/intake] failed to load:", err);
    return { queue: [], emergencies: 0, error: "Could not load the intake queue." };
  }
}

function fmt(d: Date | null): string {
  return d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

const TH = "px-4 py-3 text-xs font-semibold text-slate-500";
const TD = "px-4 py-3 text-slate-700";

export default async function IntakeConsolePage() {
  const { queue, emergencies, error } = await loadData();
  const gates = [...INTAKE_GATE_KEYS, ...INTAKE_SHARED_GATE_KEYS].map((key) => gateStatus(key));
  const pending = gates.filter((g) => !g.approved);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Client intake"
        title="Intake"
        description="Every channel lands in one queue. Emergencies are listed first."
        actions={<StatusPill tone={emergencies > 0 ? "danger" : "brand"}>{queue.length} open</StatusPill>}
      />

      {emergencies > 0 ? (
        <Notice tone="danger">
          {emergencies} open emergency alert{emergencies === 1 ? "" : "s"} — acknowledge in the emergency queue.
        </Notice>
      ) : null}

      <section>
        <SectionTitle>Queue</SectionTitle>
        {error ? (
          <div className="mb-3">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        <Card className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-100">
              <tr>
                <th className={TH}>Contact</th>
                <th className={TH}>Channel</th>
                <th className={TH}>Status</th>
                <th className={TH}>Respond by</th>
                <th className={TH}>Fit</th>
                <th className={TH}>Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {queue.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-slate-500" colSpan={6}>
                    No open inquiries.
                  </td>
                </tr>
              ) : (
                queue.map((r) => (
                  <tr key={r.intakeSessionId} className={r.emergencyUnacknowledged || r.safetyFlagged ? "bg-red-50" : "hover:bg-slate-50"}>
                    <td className="px-4 py-3 font-semibold text-slate-900">
                      {r.fullName ?? "Unknown contact"}
                      {r.safetyFlagged ? (
                        <span className="ml-2">
                          <StatusPill tone="danger">safety</StatusPill>
                        </span>
                      ) : null}
                    </td>
                    <td className={TD}>{r.channel.replace(/_/g, " ")}</td>
                    <td className={TD}>
                      <StatusPill tone="info">{r.status.replace(/_/g, " ")}</StatusPill>
                    </td>
                    <td className={TD}>{r.responseOutcome ? r.responseOutcome.replace(/_/g, " ") : fmt(r.responseTargetAt)}</td>
                    <td className={TD}>{r.fitOutcome ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-500">{fmt(r.startedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Card>
      </section>

      <section>
        <SectionTitle hint="Until each item is approved, its wording shows as a visible placeholder and gated actions are blocked and logged.">
          Waiting for sign-off ({pending.length} of {gates.length})
        </SectionTitle>
        <Card>
          <ul className="divide-y divide-slate-100 text-sm">
            {pending.map((g) => (
              <li key={g.gate.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <span className="text-slate-800">
                  {g.gate.description}
                  <span className="ml-2 font-mono text-xs text-slate-400">{g.gate.key}</span>
                </span>
                <span className="shrink-0">
                  <StatusPill tone="warning">{g.pendingReviewers.join(", ")}</StatusPill>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
