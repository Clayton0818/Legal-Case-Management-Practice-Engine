// c123 — turning evidence into an answer, with or without a model. Pure.
//
// Two ways to answer, and the page says which one it used:
//  - 'records': no model. The records most related to the question are
//    listed, each one cited. Used while the shared 'vendor.ai_model' gate is
//    pending, and whenever no real model adapter is configured.
//  - 'ai': a model writes a short answer from the same records. Its output is
//    accepted only as JSON that cites records by ref; citations that don't
//    match a record are dropped, and an answer left with no valid citation is
//    replaced by "the records don't say". The model never sees anything that
//    isn't in the evidence list.

import type { EvidenceRecord } from "./records";

export type AnswerMode = "records" | "ai";

export interface AssistantAnswer {
  mode: AnswerMode;
  /** Plain-text answer. In 'records' mode, a one-line lead-in to the cited records. */
  text: string;
  /** Cited records, in the order they support the answer. */
  citations: EvidenceRecord[];
  /** True when the records don't contain the answer. */
  notFound: boolean;
  /** Shown under any answer that mentions a date. */
  dateNote: string | null;
}

export const NOT_FOUND_TEXT = "The matter's records don't answer this. Check the file or ask the responsible lawyer.";

export const DATE_NOTE =
  "Dates come from the matter's records. Anything not confirmed by a lawyer is only a proposal, and the assistant never sets or confirms a deadline.";

const DATE_LIKE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}|deadline|due)\b/i;

function dateNoteFor(text: string, citations: readonly EvidenceRecord[]): string | null {
  return DATE_LIKE.test(text) || citations.some((c) => c.kind === "event" || c.kind === "task") ? DATE_NOTE : null;
}

/** The no-model answer: the most related records, cited. Pure. */
export function recordsAnswer(relevant: readonly EvidenceRecord[]): AssistantAnswer {
  if (relevant.length === 0) return { mode: "records", text: NOT_FOUND_TEXT, citations: [], notFound: true, dateNote: null };
  const text = relevant.length === 1 ? "This record looks related to your question:" : `These ${relevant.length} records look related to your question:`;
  return { mode: "records", text, citations: [...relevant], notFound: false, dateNote: dateNoteFor("", relevant) };
}

/**
 * The instructions and evidence a model gets. Records are numbered by ref;
 * nothing else about the matter is included. Pure.
 */
export function buildPrompt(question: string, records: readonly EvidenceRecord[]): { system: string; user: string } {
  const system = [
    "You help staff at a law firm find facts in one matter's records.",
    "Answer ONLY from the records provided. If they don't contain the answer, say so.",
    "Never give legal advice, legal research, predictions or recommendations.",
    "Never state, compute or confirm a deadline; only repeat dates that appear in the records, with their confirmation status.",
    "Reply with JSON only: {\"answer\": string, \"citations\": [ref, ...], \"notFound\": boolean}.",
    "Every statement in the answer must be supported by a cited ref from the records. Keep the answer under 120 words.",
  ].join("\n");
  const lines = records.map((r) => `[${r.ref}] ${r.text}`);
  const user = `Records:\n${lines.join("\n")}\n\nQuestion: ${question}`;
  return { system, user };
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Accept a model's reply only in the agreed shape and only with real
 * citations. Anything else falls back to "the records don't say": an
 * uncited answer is never shown. Pure.
 */
export function parseModelAnswer(raw: string, records: readonly EvidenceRecord[]): AssistantAnswer {
  const parsed = extractJson(raw);
  const notFound: AssistantAnswer = { mode: "ai", text: NOT_FOUND_TEXT, citations: [], notFound: true, dateNote: null };
  if (!parsed || typeof parsed !== "object") return notFound;
  const obj = parsed as Record<string, unknown>;
  const answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
  const refs = Array.isArray(obj.citations) ? obj.citations.filter((c): c is string => typeof c === "string") : [];
  if (obj.notFound === true || !answer) return notFound;
  const byRef = new Map(records.map((r) => [r.ref, r]));
  const seen = new Set<string>();
  const citations: EvidenceRecord[] = [];
  for (const ref of refs) {
    const rec = byRef.get(ref);
    if (rec && !seen.has(ref)) {
      seen.add(ref);
      citations.push(rec);
    }
  }
  if (citations.length === 0) return notFound;
  const text = answer.length > 1200 ? `${answer.slice(0, 1200)}…` : answer;
  return { mode: "ai", text, citations, notFound: false, dateNote: dateNoteFor(text, citations) };
}
