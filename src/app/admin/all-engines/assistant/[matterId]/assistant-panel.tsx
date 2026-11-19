"use client";

// c123 — ask a question or get a briefing. Shows every cited record so the
// staff member can check the source. Nothing here decides anything.
import { useState } from "react";

interface Record {
  ref: string;
  kind: string;
  title: string;
  text: string;
}

interface Answer {
  mode: "records" | "ai";
  text: string;
  citations: Record[];
  notFound: boolean;
  dateNote: string | null;
}

interface AskResult {
  question: string;
  answer: Answer | null;
  refusal: string | null;
}

interface Briefing {
  sections: Array<{ heading: string; items: Record[] }>;
}

const KIND_LABEL: { [k: string]: string } = {
  matter: "Matter",
  party: "Person",
  event: "Calendar",
  task: "Task",
  flag: "Flag",
  document: "Document",
};

const BUTTON = "rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";
const BUTTON_SECONDARY = "rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 disabled:opacity-50";

async function post<T>(url: string, body: unknown): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
    if (res.ok) return { data: json, error: null };
    return { data: null, error: json?.message ?? json?.error ?? `Something went wrong (HTTP ${res.status}).` };
  } catch {
    return { data: null, error: "Couldn't reach the server. Check your connection and try again." };
  }
}

function Citations({ items }: { items: Record[] }) {
  return (
    <ul className="space-y-2">
      {items.map((r) => (
        <li key={r.ref} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
          <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">{KIND_LABEL[r.kind] ?? r.kind}</span>
          <span className="text-slate-800">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function AssistantPanel({ matterId }: { matterId: string }) {
  const url = `/api/all-engines/matters/${matterId}/assistant`;
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    setBusy(true);
    setError(null);
    setBriefing(null);
    const { data, error: err } = await post<AskResult>(url, { mode: "ask", question });
    setBusy(false);
    if (err) return setError(err);
    setResult(data);
  }

  async function catchUp() {
    setBusy(true);
    setError(null);
    setResult(null);
    const { data, error: err } = await post<Briefing>(url, { mode: "briefing" });
    setBusy(false);
    if (err) return setError(err);
    setBriefing(data);
  }

  return (
    <div className="space-y-4">
      <form
        className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <label className="block space-y-1">
          <span className="block text-sm font-medium text-slate-700">Ask about this matter</span>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={question}
            maxLength={500}
            placeholder="e.g. When is the next hearing?"
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy || !question.trim()} className={BUTTON}>
            {busy ? "Working…" : "Ask"}
          </button>
          <button type="button" disabled={busy} onClick={() => void catchUp()} className={BUTTON_SECONDARY}>
            Catch me up
          </button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {result ? (
        <section className="space-y-3">
          {result.refusal ? (
            <p className="rounded-md bg-slate-100 p-3 text-sm text-slate-800">{result.refusal}</p>
          ) : result.answer ? (
            <>
              <p className="text-sm text-slate-900">
                <span className="mr-2 rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
                  {result.answer.mode === "ai" ? "AI answer (check the sources)" : "Matching records"}
                </span>
                {result.answer.text}
              </p>
              {result.answer.citations.length > 0 ? <Citations items={result.answer.citations} /> : null}
              {result.answer.dateNote ? <p className="text-xs text-amber-800">{result.answer.dateNote}</p> : null}
            </>
          ) : null}
        </section>
      ) : null}

      {briefing ? (
        <section className="space-y-4">
          {briefing.sections.map((s) => (
            <div key={s.heading} className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-900">{s.heading}</h2>
              {s.items.length === 0 ? <p className="text-sm text-slate-500">Nothing here.</p> : <Citations items={s.items} />}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
