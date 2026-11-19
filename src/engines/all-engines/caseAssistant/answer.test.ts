import { describe, expect, it } from "vitest";
import { buildPrompt, DATE_NOTE, NOT_FOUND_TEXT, parseModelAnswer, recordsAnswer } from "./answer";
import type { EvidenceRecord } from "./records";

const hearing: EvidenceRecord = { ref: "event:e1", kind: "event", title: "Hearing", text: 'Calendar event "Hearing" (hearing) on 2026-11-25, confirmed.', date: new Date("2026-11-25T16:00:00Z") };
const petition: EvidenceRecord = { ref: "document:d1", kind: "document", title: "Petition", text: 'Document "Petition" (petition), version 1, filed, added 2026-11-12.', date: new Date("2026-11-12T15:00:00Z") };
const records = [hearing, petition];

describe("c123 answers without a model", () => {
  it("lists the related records, cited, with the date reminder for calendar items", () => {
    const a = recordsAnswer([hearing]);
    expect(a).toMatchObject({ mode: "records", notFound: false, dateNote: DATE_NOTE });
    expect(a.citations.map((c) => c.ref)).toEqual(["event:e1"]);
  });

  it("says the records don't answer it when nothing matches", () => {
    expect(recordsAnswer([])).toMatchObject({ text: NOT_FOUND_TEXT, notFound: true, citations: [] });
  });
});

describe("c123 the model's instructions", () => {
  it("contains only the records given, by ref, and the no-advice / no-deadline rules", () => {
    const { system, user } = buildPrompt("When is the hearing?", [hearing]);
    expect(user).toContain("[event:e1]");
    expect(user).not.toContain("document:d1");
    expect(system).toMatch(/Never give legal advice/);
    expect(system).toMatch(/Never state, compute or confirm a deadline/);
  });
});

describe("c123 accepting a model's reply", () => {
  it("keeps a cited answer, and only the citations that match real records", () => {
    const a = parseModelAnswer(JSON.stringify({ answer: "The hearing is on 2026-11-25 and is confirmed.", citations: ["event:e1", "event:made-up"], notFound: false }), records);
    expect(a.mode).toBe("ai");
    expect(a.notFound).toBe(false);
    expect(a.citations.map((c) => c.ref)).toEqual(["event:e1"]);
    expect(a.dateNote).toBe(DATE_NOTE);
  });

  it("reads JSON inside a code fence", () => {
    const a = parseModelAnswer('```json\n{"answer":"The petition was filed.","citations":["document:d1"],"notFound":false}\n```', records);
    expect(a.citations.map((c) => c.ref)).toEqual(["document:d1"]);
  });

  it("never shows an answer that cites nothing real", () => {
    expect(parseModelAnswer(JSON.stringify({ answer: "Trial is in March.", citations: ["event:nope"] }), records)).toMatchObject({ notFound: true, text: NOT_FOUND_TEXT, citations: [] });
    expect(parseModelAnswer(JSON.stringify({ answer: "Trial is in March.", citations: [] }), records).notFound).toBe(true);
  });

  it("treats a malformed reply, or one that says it doesn't know, as not found", () => {
    expect(parseModelAnswer("The hearing is soon.", records).notFound).toBe(true);
    expect(parseModelAnswer(JSON.stringify({ answer: "Not in the records.", citations: ["event:e1"], notFound: true }), records).notFound).toBe(true);
  });
});
