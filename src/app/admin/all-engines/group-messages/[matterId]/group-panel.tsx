"use client";

// c124 — joint representation, consents and the thread for one matter.
// Nothing here decides anything; the server enforces every rule.
import { useState } from "react";

interface Client {
  partyId: string;
  fullName: string;
  isAdverse: boolean | null;
  consentGivenAt: string | null;
  consentWordingApproved: boolean | null;
}

interface View {
  joint: { markedAt: string; markedByName: string | null; note: string | null } | null;
  clients: Client[];
  state: { available: boolean; reasons: string[]; recipients: string[] };
  consentWording: { text: string; approved: boolean };
  messages: Array<{ id: string; authorType: string; authorName: string | null; body: string; recipientCount: number; createdAt: string }>;
  can: { decideJoint: boolean; edit: boolean };
}

const BUTTON = "rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";
const BUTTON_SMALL = "rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-800 disabled:opacity-50";

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function GroupPanel({ matterId, view }: { matterId: string; view: View }) {
  const url = `/api/all-engines/matters/${matterId}/group`;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState("");

  async function act(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = (await res.json().catch(() => null)) as { error?: string; message?: string; details?: string[] } | null;
      if (!res.ok) {
        const parts = [json?.message ?? json?.error ?? `Something went wrong (HTTP ${res.status}).`, ...(json?.details ?? [])];
        setError(parts.join(" "));
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  function endJoint() {
    const reason = window.prompt("Why is the joint representation ending?");
    if (reason && reason.trim()) void act({ action: "end_joint", reason });
  }

  function withdraw(partyId: string) {
    const reason = window.prompt("Record the client's withdrawal. Reason (optional):");
    if (reason !== null) void act({ action: "withdraw_consent", partyId, reason });
  }

  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">Joint representation</h2>
        {view.joint ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-slate-700">
              Marked by {view.joint.markedByName ?? "a lawyer"} on {when(view.joint.markedAt)}.{view.joint.note ? ` Note: ${view.joint.note}` : ""}
            </p>
            {view.can.decideJoint ? (
              <button type="button" className={BUTTON_SMALL} disabled={busy} onClick={endJoint}>
                End joint representation
              </button>
            ) : null}
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-slate-600">Not marked. Only a lawyer can decide that the firm represents these clients jointly.</p>
            {view.can.decideJoint ? (
              <button type="button" className={BUTTON_SMALL} disabled={busy} onClick={() => void act({ action: "mark_joint" })}>
                Mark as joint representation
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">Clients and consent to sharing</h2>
        <div className={`mt-2 rounded-md p-3 ${view.consentWording.approved ? "bg-slate-50 text-slate-700" : "bg-amber-50 text-amber-900"}`}>
          {!view.consentWording.approved ? <p className="mb-1 font-medium">Consent wording is pending attorney review.</p> : null}
          <p className="whitespace-pre-line">{view.consentWording.text}</p>
        </div>
        <ul className="mt-3 divide-y divide-slate-100">
          {view.clients.map((c) => (
            <li key={c.partyId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-slate-900">
                {c.fullName}
                {c.isAdverse ? <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">Adverse</span> : null}
              </span>
              {c.consentGivenAt ? (
                <span className="flex items-center gap-2 text-slate-600">
                  Consented {when(c.consentGivenAt)}
                  {c.consentWordingApproved === false ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">draft wording</span> : null}
                  {view.can.edit ? (
                    <button type="button" className={BUTTON_SMALL} disabled={busy} onClick={() => withdraw(c.partyId)}>
                      Withdraw
                    </button>
                  ) : null}
                </span>
              ) : view.can.edit && view.joint ? (
                <button type="button" className={BUTTON_SMALL} disabled={busy} onClick={() => void act({ action: "record_consent", partyId: c.partyId })}>
                  Record consent
                </button>
              ) : (
                <span className="text-slate-500">No consent yet</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">Thread</h2>
        {view.state.available ? (
          view.can.edit ? (
            <div className="mt-2 space-y-2">
              <label htmlFor="group-body" className="block text-slate-700">
                Message to all {view.state.recipients.length} clients
              </label>
              <textarea id="group-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} className="w-full rounded-md border border-slate-300 p-2" />
              <button type="button" className={BUTTON} disabled={busy || !body.trim()} onClick={() => void act({ action: "post", body })}>
                Send to the group
              </button>
            </div>
          ) : null
        ) : (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-900">
            {view.state.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {view.messages.length === 0 ? (
          <p className="mt-3 text-slate-500">No messages yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {view.messages.map((m) => (
              <li key={m.id} className="rounded-md border border-slate-200 p-3">
                <p className="text-xs text-slate-500">
                  {m.authorName ?? (m.authorType === "staff" ? "Staff" : "Client")} · {m.authorType === "staff" ? "firm" : "client"} · {when(m.createdAt)} · to {m.recipientCount}
                </p>
                <p className="mt-1 whitespace-pre-line text-slate-800">{m.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
