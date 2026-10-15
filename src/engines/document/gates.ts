// Approval gates the Document engine depends on (c84, c39–c41, c49).
//
// Shared gates REUSED (never redefined here):
//   vendor.object_storage     (VENDOR_GATES.objectStorage)   — any vendor storage adapter, malware
//                                                              scanner and OCR call (c84, c49). The stub
//                                                              memory/local adapters keep bytes on our own
//                                                              infrastructure and need no vendor gate.
//   vendor.esignature         (VENDOR_GATES.esignature)      — sending a document out for e-signature
//                                                              (c39, c41). c4 is the vendor build; this
//                                                              engine only reuses the gate, never the vendor
//                                                              call itself (no vendor is wired yet, so every
//                                                              signature request fails closed with a pending
//                                                              placeholder — see signoff/service.ts).
//   rules.fee_agreement_terms (RULE_GATES.feeAgreementTerms) — the fee terms in the engagement agreement (c39).
//   rules.retention_periods   (RULE_GATES.retentionPeriods)  — applying a retention period to a
//                                                              matter's documents (c90 destruction review).
//
// Nothing here is approved. Drafts are proposals for the reviewing attorney,
// not approved wording.

import { defineGate } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";

export { RULE_GATES, VENDOR_GATES };

export const DOCUMENT_COPY_GATES = {
  /**
   * c84/c49 — shown to a client whose portal upload was refused (infected,
   * unreadable, wrong type, too large). Neutral; never names the reason a
   * scanner gave.
   */
  uploadRejected: defineGate({
    key: "copy.document.upload_rejected",
    cardIds: ["c84", "c49"],
    reviewers: ["attorney"],
    description: "Message to a client whose uploaded file could not be accepted",
    draft: "We couldn't accept this file. Please check it and upload it again, or contact {firmName} if the problem continues.",
  }),
  /**
   * c39 — tells the client their engagement agreement is ready to review and
   * sign. Says nothing about the agreement's terms (those are the gated
   * rules.fee_agreement_terms wording inside the document itself).
   */
  engagementAgreementReady: defineGate({
    key: "copy.document.engagement_agreement_ready",
    cardIds: ["c39"],
    reviewers: ["attorney"],
    description: "Message to a client that their engagement agreement is ready to sign",
    draft: "Your engagement agreement with {firmName} is ready. Please sign in to your secure client portal to review and sign it: {portalUrl}",
  }),
  /**
   * c41 — tells the client a document is ready for their review and
   * sign-off before filing. The AI delivers and collects the decision only;
   * it never explains what the document means or whether the client should
   * sign (UPL guardrail, c41) — that wording lives nowhere in this engine.
   */
  clientSignoffRequest: defineGate({
    key: "copy.document.client_signoff_request",
    cardIds: ["c41"],
    reviewers: ["attorney"],
    description: "Message to a client asking them to review and sign off a document before filing",
    draft:
      "A document from {firmName} is ready for your review before it is filed. Please sign in to your secure client portal to review it and let us know if you approve or have questions: {portalUrl}",
  }),
  /**
   * c39 — the engagement agreement's AI-use disclosure clause (c10 §4.6: the
   * firm's terms-of-service AI disclosure, repeated in the agreement itself
   * so the client sees it before they sign).
   */
  aiDisclosureNotice: defineGate({
    key: "copy.document.ai_disclosure_notice",
    cardIds: ["c39", "c10"],
    reviewers: ["attorney"],
    description: "Engagement-agreement clause disclosing the firm's use of AI (c10 §4.6)",
    draft:
      "{firmName} uses artificial-intelligence tools to help manage client intake and casework. These tools assist firm staff and attorneys; they do not replace an attorney's judgment, and no AI tool provides you with legal advice.",
  }),
} as const;

/** Every gate this engine reads, for the admin approvals page. */
export const DOCUMENT_GATE_KEYS: readonly string[] = [
  VENDOR_GATES.objectStorage.key,
  VENDOR_GATES.esignature.key,
  RULE_GATES.feeAgreementTerms.key,
  RULE_GATES.retentionPeriods.key,
  ...Object.values(DOCUMENT_COPY_GATES).map((g) => g.key),
];
