// c90 — pure tests for the closing checklist, destruction review and reopen,
// keyed to docs/product/features/document/c90-closing-a-file.md §10.

import { describe, it, expect } from "vitest";
import {
  canCloseMatter,
  destructionReviewOptions,
  evaluateClosing,
  planReopen,
  previewDestructionReviewDate,
  validateExtension,
  validateWaiver,
  type ClosingFacts,
} from "./checklist";

const attorney = new Set(["matters.close"]);
const paralegal = new Set<string>(["documents.upload"]);

const ready = (over: Partial<ClosingFacts> = {}): ClosingFacts => ({
  finalInvoice: "settled",
  trustBalanceCents: 0,
  trustHoldReason: null,
  trustAttestation: null,
  openTaskCount: 0,
  futureEventCount: 0,
  closingLetter: "delivered",
  originals: [],
  retentionYears: 5,
  waivers: {},
  ...over,
});

describe("evaluateClosing", () => {
  it("everything done: an attorney can close; a paralegal cannot", () => {
    const e = evaluateClosing(ready());
    expect(e.canClose).toBe(true);
    expect(canCloseMatter(attorney, e)).toEqual({ ok: true });
    expect(canCloseMatter(paralegal, e).ok).toBe(false);
  });

  it("criterion 1: $300 in trust with no hold reason blocks closing", () => {
    const e = evaluateClosing(ready({ trustBalanceCents: 30000 }));
    expect(e.canClose).toBe(false);
    expect(e.blockers[0]?.detail).toContain("Trust balance must be zero or a hold reason recorded");
    const d = canCloseMatter(attorney, e);
    expect(d.ok).toBe(false);
  });

  it("a recorded hold reason satisfies the trust item; a waiver never does", () => {
    expect(evaluateClosing(ready({ trustBalanceCents: 30000, trustHoldReason: "Disputed invoice #12" })).canClose).toBe(true);
    expect(evaluateClosing(ready({ trustBalanceCents: 30000, waivers: { trust_balance: "client said fine" } })).canClose).toBe(false);
    expect(validateWaiver(attorney, "trust_balance", "anything").ok).toBe(false);
  });

  it("a negative trust balance always blocks", () => {
    expect(evaluateClosing(ready({ trustBalanceCents: -1, trustHoldReason: "x" })).canClose).toBe(false);
  });

  it("without a live trust ledger, a lawyer's attestation is required", () => {
    expect(evaluateClosing(ready({ trustBalanceCents: null })).canClose).toBe(false);
    expect(evaluateClosing(ready({ trustBalanceCents: null, trustAttestation: { byUserId: "u1", at: new Date() } })).canClose).toBe(true);
  });

  it("criterion 3: an original held with no disposition blocks closing; 'other' needs a note", () => {
    const orig = { groupId: "g1", title: "Original will", disposition: null };
    expect(evaluateClosing(ready({ originals: [orig] })).canClose).toBe(false);
    expect(evaluateClosing(ready({ originals: [{ ...orig, disposition: "other" as const }] })).canClose).toBe(false);
    expect(evaluateClosing(ready({ originals: [{ ...orig, disposition: "other" as const, note: "Lost in 2019 flood; client told" }] })).canClose).toBe(true);
    expect(evaluateClosing(ready({ originals: [{ ...orig, disposition: "returned" as const }] })).canClose).toBe(true);
  });

  it("criterion 8: no retention period means no closing, and it cannot be waived", () => {
    expect(evaluateClosing(ready({ retentionYears: null })).canClose).toBe(false);
    expect(evaluateClosing(ready({ retentionYears: null, waivers: { retention_period: "later" } })).canClose).toBe(false);
    expect(validateWaiver(attorney, "retention_period", "later").ok).toBe(false);
  });

  it("other items can be waived by an attorney with a reason", () => {
    const e = evaluateClosing(ready({ closingLetter: "none", waivers: { closing_letter: "Client deceased; estate counsel notified by phone" } }));
    expect(e.canClose).toBe(true);
    expect(e.items.find((i) => i.key === "closing_letter")?.state).toBe("waived");
    expect(validateWaiver(attorney, "closing_letter", " ").ok).toBe(false);
    expect(validateWaiver(paralegal, "closing_letter", "reason").ok).toBe(false);
    expect(validateWaiver(attorney, "closing_letter", "reason").ok).toBe(true);
  });

  it("open tasks, future events, an unpaid invoice and an undelivered letter each block", () => {
    const e = evaluateClosing(ready({ openTaskCount: 2, futureEventCount: 1, finalInvoice: "open", closingLetter: "approved" }));
    expect(e.blockers.map((b) => b.key).sort()).toEqual(["closing_letter", "final_invoice", "future_events", "open_tasks"]);
  });
});

describe("retention preview", () => {
  it("criterion 2: closed 2026-10-01 with 5 years -> 2031-10-01", () => {
    expect(previewDestructionReviewDate(new Date("2026-10-01T15:00:00Z"), 5).toISOString().slice(0, 10)).toBe("2031-10-01");
  });
});

describe("destruction review", () => {
  it("criterion 5: a legal hold disables approval and shows the reason", () => {
    const o = destructionReviewOptions({ legalHolds: [{ groupId: "g1", reason: "Litigation hold from insurer" }], openDisputes: 0, originalsStillHeld: 0, rights: attorney });
    expect(o.approveDestruction).toEqual({ ok: false, reason: "Legal hold: Litigation hold from insurer" });
    expect(o.extend.ok).toBe(true);
  });

  it("only an attorney decides; originals still held block approval; disputes are warned about", () => {
    expect(destructionReviewOptions({ legalHolds: [], openDisputes: 0, originalsStillHeld: 0, rights: paralegal }).approveDestruction.ok).toBe(false);
    const o = destructionReviewOptions({ legalHolds: [], openDisputes: 1, originalsStillHeld: 1, rights: attorney });
    expect(o.approveDestruction.ok).toBe(false);
    expect(o.warnings).toHaveLength(2);
    expect(destructionReviewOptions({ legalHolds: [], openDisputes: 0, originalsStillHeld: 0, rights: attorney }).approveDestruction.ok).toBe(true);
  });

  it("extensions need whole years and a reason", () => {
    expect(validateExtension(2, "Minor child; review at 18")).toEqual([]);
    expect(validateExtension(0, "")).toHaveLength(2);
  });
});

describe("reopen", () => {
  it("criterion 7: an attorney reopens with a reason and pending review tasks are cancelled", () => {
    expect(planReopen(attorney, "New motion filed", ["task-1"])).toEqual({ ok: true, plan: { stage: "retained", clearClosedAt: true, cancelTaskIds: ["task-1"] } });
    expect(planReopen(attorney, " ", []).ok).toBe(false);
    expect(planReopen(paralegal, "x", []).ok).toBe(false);
  });
});
