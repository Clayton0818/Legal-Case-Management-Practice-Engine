import { describe, expect, it } from "vitest";
import {
  InvoiceError,
  buildDraftInvoice,
  computeAmountDueFromTrust,
  markLawyerReviewed,
  markSent,
  nextInvoiceNumber,
  recomputeSubtotal,
  voidInvoice,
  writeDownLine,
  type Invoice,
} from "./invoices";

function draft() {
  return buildDraftInvoice({
    tenantId: "t1",
    matterId: "m1",
    number: 1,
    lineItems: [
      { kind: "time", description: "2.5 hrs drafting", amountCents: 75_000n },
      { kind: "cost", description: "Filing fee", amountCents: 25_000n },
    ],
  });
}

function draftWithIds(): Pick<Invoice, "status" | "lineItems"> {
  const d = draft();
  return { status: d.status, lineItems: d.lineItems.map((l, i) => ({ ...l, id: `line${i}` })) };
}

describe("nextInvoiceNumber", () => {
  it("increments from the last used number", () => {
    expect(nextInvoiceNumber(0)).toBe(1);
    expect(nextInvoiceNumber(41)).toBe(42);
  });

  it("rejects a negative or fractional input", () => {
    expect(() => nextInvoiceNumber(-1)).toThrow(InvoiceError);
    expect(() => nextInvoiceNumber(1.5)).toThrow(InvoiceError);
  });
});

describe("buildDraftInvoice", () => {
  it("builds a draft with a computed subtotal", () => {
    const inv = draft();
    expect(inv.status).toBe("draft");
    expect(inv.subtotalCents).toBe(100_000n);
    expect(inv.lineItems).toHaveLength(2);
  });

  it("refuses an invoice with no line items", () => {
    expect(() => buildDraftInvoice({ tenantId: "t1", matterId: "m1", number: 1, lineItems: [] })).toThrow(InvoiceError);
  });

  it("refuses a line item with a negative amount", () => {
    expect(() =>
      buildDraftInvoice({
        tenantId: "t1",
        matterId: "m1",
        number: 1,
        lineItems: [{ kind: "time", description: "x", amountCents: -1n }],
      })
    ).toThrow(InvoiceError);
  });
});

describe("writeDownLine", () => {
  it("writes a line down with a reason, and recomputes the subtotal", () => {
    const inv = draftWithIds();
    const updated = writeDownLine(inv, "line0", 50_000n, "client disputed two hours");
    expect(updated.find((l) => l.id === "line0")?.amountCents).toBe(50_000n);
    expect(updated.find((l) => l.id === "line0")?.writeDownReason).toBe("client disputed two hours");
    expect(recomputeSubtotal(updated)).toBe(75_000n);
  });

  it("requires a reason", () => {
    const inv = draftWithIds();
    expect(() => writeDownLine(inv, "line0", 50_000n, "")).toThrow(InvoiceError);
  });

  it("never allows writing a line UP above its original amount", () => {
    const inv = draftWithIds();
    expect(() => writeDownLine(inv, "line0", 999_999n, "oops")).toThrow(InvoiceError);
  });

  it("refuses to adjust a non-draft invoice", () => {
    const inv: Pick<Invoice, "status" | "lineItems"> = { ...draftWithIds(), status: "sent" };
    expect(() => writeDownLine(inv, "line0", 1n, "reason")).toThrow(InvoiceError);
  });
});

describe("markLawyerReviewed / markSent / voidInvoice", () => {
  it("requires lawyer review before sending", () => {
    expect(() => markSent({ status: "draft" })).toThrow(InvoiceError);
    const reviewed = markLawyerReviewed({ status: "draft" }, "lawyer1");
    expect(reviewed.status).toBe("lawyer_reviewed");
    expect(markSent({ status: "lawyer_reviewed" }).status).toBe("sent");
  });

  it("voids with a reason instead of deleting", () => {
    const voided = voidInvoice({ status: "sent" }, "duplicate invoice, see #43 instead");
    expect(voided.status).toBe("void");
    expect(voided.voidReason).toContain("duplicate");
  });

  it("refuses to void an already-void invoice, or void without a reason", () => {
    expect(() => voidInvoice({ status: "void" }, "reason")).toThrow(InvoiceError);
    expect(() => voidInvoice({ status: "sent" }, "")).toThrow(InvoiceError);
  });
});

describe("computeAmountDueFromTrust", () => {
  it("pays fully from trust when the balance covers it", () => {
    const split = computeAmountDueFromTrust(50_000n, 100_000n);
    expect(split.fromTrustCents).toBe(50_000n);
    expect(split.amountDueCents).toBe(0n);
  });

  it("splits between trust and direct billing when the balance falls short", () => {
    const split = computeAmountDueFromTrust(100_000n, 30_000n);
    expect(split.fromTrustCents).toBe(30_000n);
    expect(split.amountDueCents).toBe(70_000n);
  });

  it("bills entirely directly when there is no trust balance", () => {
    const split = computeAmountDueFromTrust(100_000n, 0n);
    expect(split.fromTrustCents).toBe(0n);
    expect(split.amountDueCents).toBe(100_000n);
  });

  it("rejects a negative trust balance", () => {
    expect(() => computeAmountDueFromTrust(100_000n, -1n)).toThrow(InvoiceError);
  });
});
