"use client";

// c122 — the one action that is open on an intake right now. Every button
// posts to /api/intake/staff/intakes/[id]/steps, which re-checks the staff
// member and the engine's rules (disclosures first, case details locked
// until the conflict check is clear). This component never decides
// anything itself; after a successful action it reloads the page so the
// server renders the next step. (A full reload rather than router.refresh():
// in testing, a second soft refresh on the same page sometimes kept showing
// the previous step even though the action had been saved.)
import { useState } from "react";
import { postJson } from "../_lib/post";

type Mode = "contact" | "disclosures" | "conflict_names" | "conflict_check" | "case_details";

interface Props {
  intakeSessionId: string;
  mode: Mode;
  channel: string;
  contactName?: string;
  disclosure?: { text: string; approved: boolean };
  practiceAreas?: Array<{ id: string; label: string }>;
}

const INPUT = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none";
const LABEL = "block text-sm font-medium text-slate-700";
const BUTTON = "rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

export function StaffIntakeActions(props: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const { error: err } = await postJson(`/api/intake/staff/intakes/${props.intakeSessionId}/steps`, body);
    if (err) {
      setBusy(false);
      return setError(err);
    }
    // Stay busy (buttons disabled) until the reloaded page replaces this one.
    window.location.reload();
  }

  const errorBox = error ? (
    <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
      {error}
    </p>
  ) : null;

  switch (props.mode) {
    case "contact":
      return (
        <div className="space-y-2">
          <button
            type="button"
            disabled={busy}
            className={BUTTON}
            onClick={() => void act({ action: "human_contact", method: props.channel === "walk_in" ? "in_person" : "call_connected" })}
          >
            {props.channel === "walk_in" ? "I've met with them" : "I've spoken with them"}
          </button>
          {errorBox}
        </div>
      );
    case "disclosures":
      return <Disclosures disclosure={props.disclosure} busy={busy} onDone={() => void act({ action: "acknowledge_disclosures" })} errorBox={errorBox} />;
    case "conflict_names":
      return <ConflictNames contactName={props.contactName ?? ""} busy={busy} onSave={(fullName, otherPartyNames) => void act({ action: "conflict_minimum", fullName, otherPartyNames })} errorBox={errorBox} />;
    case "case_details":
      return <CaseDetails practiceAreas={props.practiceAreas ?? []} busy={busy} onSave={(answers) => void act({ action: "case_details", answers })} errorBox={errorBox} />;
    case "conflict_check":
      return null;
  }
}

function Disclosures({ disclosure, busy, onDone, errorBox }: { disclosure?: { text: string; approved: boolean }; busy: boolean; onDone: () => void; errorBox: React.ReactNode }) {
  const [read, setRead] = useState(false);
  return (
    <div className="space-y-3">
      <p className={LABEL}>Read this to them:</p>
      <blockquote className="whitespace-pre-wrap rounded-md border-l-4 border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">{disclosure?.text ?? ""}</blockquote>
      {disclosure && !disclosure.approved ? (
        <p className="text-xs text-amber-800">This wording is still waiting for attorney review, so the placeholder shows instead of the final text.</p>
      ) : null}
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />I read the disclosures to them, and they acknowledged them.
      </label>
      <button type="button" disabled={busy || !read} onClick={onDone} className={BUTTON}>
        {busy ? "Saving…" : "Record the disclosures"}
      </button>
      {errorBox}
    </div>
  );
}

function ConflictNames({ contactName, busy, onSave, errorBox }: { contactName: string; busy: boolean; onSave: (fullName: string, others: string[]) => void; errorBox: React.ReactNode }) {
  const [fullName, setFullName] = useState(contactName === "Unknown contact" ? "" : contactName);
  const [others, setOthers] = useState("");
  const [noOthers, setNoOthers] = useState(false);
  const names = others
    .split(/[\n;,]+/)
    .map((n) => n.trim())
    .filter(Boolean);
  const ready = fullName.trim().length > 0 && (names.length > 0 || noOthers);
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className={LABEL}>Their full name (and any former or maiden names)</span>
        <input className={INPUT} value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="off" />
      </label>
      <label className="block space-y-1">
        <span className={LABEL}>Other people involved: the other side, their spouse or partner, any business (one per line)</span>
        <textarea className={INPUT} rows={3} value={others} disabled={noOthers} onChange={(e) => setOthers(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input type="checkbox" checked={noOthers} onChange={(e) => setNoOthers(e.target.checked)} />
        There is no other party
      </label>
      <p className="text-xs text-slate-500">Names only. Don&apos;t record what happened until the conflict check is clear.</p>
      <button type="button" disabled={busy || !ready} onClick={() => onSave(fullName, noOthers ? [] : names)} className={BUTTON}>
        {busy ? "Saving…" : "Run the conflict check"}
      </button>
      {errorBox}
    </div>
  );
}

function CaseDetails({ practiceAreas, busy, onSave, errorBox }: { practiceAreas: Array<{ id: string; label: string }>; busy: boolean; onSave: (answers: Record<string, string>) => void; errorBox: React.ReactNode }) {
  const [practiceArea, setPracticeArea] = useState(practiceAreas.length === 1 ? (practiceAreas[0]?.id ?? "") : "");
  const [county, setCounty] = useState("");
  const [summary, setSummary] = useState("");
  const ready = Boolean(practiceArea || county.trim() || summary.trim());
  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={LABEL}>Practice area</span>
          <select className={INPUT} value={practiceArea} onChange={(e) => setPracticeArea(e.target.value)}>
            <option value="">Not sure yet</option>
            {practiceAreas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className={LABEL}>County</span>
          <input className={INPUT} value={county} onChange={(e) => setCounty(e.target.value)} autoComplete="off" />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className={LABEL}>What they need help with, in their words</span>
          <textarea className={INPUT} rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
      </div>
      <button type="button" disabled={busy || !ready} onClick={() => onSave({ practiceArea, county, practiceAreaFreeText: summary })} className={BUTTON}>
        {busy ? "Saving…" : "Save the case details"}
      </button>
      {errorBox}
    </div>
  );
}
