// c39 — pure-logic tests. The signed-document workflow itself (upload,
// e-signature gating, matter stage change, intake-session close) needs a
// real Postgres transaction and is covered end to end in
// src/engines/document/document-workflow.db.test.ts, skipped without
// DATABASE_URL (unavailable in this sandbox).

import { describe, it, expect, afterEach } from "vitest";
import {
  composeEngagementAgreementText,
  ENGAGEMENT_ELIGIBLE_STAGES,
  getSignatureAdapter,
  setSignatureAdapter,
  UnavailableSignatureAdapter,
  type SignatureRequestAdapter,
} from "./service";

describe("composeEngagementAgreementText", () => {
  it("includes the client, firm, fee terms and AI-disclosure text", () => {
    const text = composeEngagementAgreementText({
      firmName: "Acme Law",
      clientName: "Jamie Rivera",
      feeTermsText: "[PENDING ATTORNEY REVIEW — fee terms (gate: rules.fee_agreement_terms)]",
      aiDisclosureText: "[PENDING ATTORNEY REVIEW — ai disclosure (gate: copy.document.ai_disclosure_notice)]",
    });
    expect(text).toContain("Client: Jamie Rivera");
    expect(text).toContain("Firm: Acme Law");
    expect(text).toContain("FEE TERMS");
    expect(text).toContain("rules.fee_agreement_terms");
    expect(text).toContain("USE OF ARTIFICIAL INTELLIGENCE");
    expect(text).toContain("copy.document.ai_disclosure_notice");
  });
});

describe("ENGAGEMENT_ELIGIBLE_STAGES", () => {
  it("never includes a stage that already has a signed or dead matter", () => {
    expect(ENGAGEMENT_ELIGIBLE_STAGES).not.toContain("retained");
    expect(ENGAGEMENT_ELIGIBLE_STAGES).not.toContain("closed");
    expect(ENGAGEMENT_ELIGIBLE_STAGES).not.toContain("declined_conflict");
  });
});

describe("signature-request adapter seam", () => {
  afterEach(() => setSignatureAdapter(null));

  it("defaults to the fail-closed UnavailableSignatureAdapter", () => {
    expect(getSignatureAdapter()).toBeInstanceOf(UnavailableSignatureAdapter);
  });

  it("lets a real vendor adapter be swapped in, and resets with null", async () => {
    const calls: unknown[] = [];
    const fake: SignatureRequestAdapter = {
      name: "fake-vendor",
      async requestSignature(input) {
        calls.push(input);
        return { vendorRequestId: "req_123" };
      },
    };
    setSignatureAdapter(fake);
    expect(getSignatureAdapter()).toBe(fake);
    const result = await getSignatureAdapter().requestSignature({ tenantId: "t1", documentId: "d1", signerName: "Jamie", signerEmail: null });
    expect(result.vendorRequestId).toBe("req_123");
    expect(calls).toHaveLength(1);

    setSignatureAdapter(null);
    expect(getSignatureAdapter()).toBeInstanceOf(UnavailableSignatureAdapter);
  });
});
