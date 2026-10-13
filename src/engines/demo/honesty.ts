// c106 — how the walkthrough shows approval status and simulated vendors.
// A pending gate is ALWAYS shown with its own visible placeholder text
// ("[PENDING ATTORNEY REVIEW — …]"), never as a finished feature.

import { gateStatus, placeholderFor, type ReviewerKind } from "@/compliance/approvals";
import type { SimulatedVendor } from "./walkthrough";

export interface GateView {
  key: string;
  description: string;
  approved: boolean;
  pendingReviewers: ReviewerKind[];
  /** The visible placeholder while pending; null once approved. */
  placeholder: string | null;
  label: string;
}

/** Live view of one gate (call after the gates are loaded and approvals refreshed). */
export function gateView(key: string): GateView {
  const s = gateStatus(key);
  return {
    key,
    description: s.gate.description,
    approved: s.approved,
    pendingReviewers: s.pendingReviewers,
    placeholder: s.approved ? null : placeholderFor(key),
    label: s.approved ? "Approved" : `Pending ${s.pendingReviewers.map((r) => r.replace(/_/g, " ")).join(" + ")} review`,
  };
}

/** Every vendor integration is a stub in the demo, whatever its gate says. */
export function simulatedLabel(vendor: SimulatedVendor): string {
  return `${vendor} — simulated in demo`;
}

export const HONESTY_STATEMENT = [
  "Everything on these pages is fictional: the firm, its people, its clients and its cases.",
  "The product does not give legal advice. It does not decide deadlines and it never clears a conflict — a lawyer does.",
  "Anything still waiting for attorney, CPA or vendor sign-off is shown with its [PENDING … REVIEW] placeholder, not as a finished feature.",
  "Email, SMS, calendar sync, document storage, OCR, e-signature, payments and bank feeds are simulated in this demo.",
] as const;
