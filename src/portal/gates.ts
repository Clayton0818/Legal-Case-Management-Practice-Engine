// Client portal (c11, c112) — attorney copy gates for every new sentence the
// portal shows or emails to a client. Nothing here is approved: until a
// licensed Texas attorney signs off (npm run compliance -- approve …) each
// renders as a visible "[PENDING ATTORNEY REVIEW …]" placeholder, and the
// sign-in email is HELD (never sent). Drafts are proposals, not approved
// wording. Loaded into the gate list through src/engines/all-engines/gates.ts.
//
// Shared gates reused (never redefined here):
//   vendor.email                                   the sign-in email (signed DPA)
//   copy.calendar-alerts.portal_past_due_label     label on the client's own past-due to-do (c46)
//
// DV safety: no draft names the firm, the matter, the practice area or the
// court — an abuser who sees the inbox or the screen learns nothing.

import { defineGate } from "@/compliance/approvals";

const ATTORNEY = ["attorney"] as const;

export const PORTAL_COPY_GATES = {
  signInEmail: defineGate({
    key: "copy.all-engines.portal_sign_in_email",
    cardIds: ["c11", "c112", "c51"],
    reviewers: [...ATTORNEY],
    description: "Client portal sign-in email: one-time link, expiry, ignore-if-not-you (no firm, matter or case details)",
    draft:
      "Subject: Your secure sign-in link\n\n" +
      "Use this link to open your secure portal. It works once and expires in {minutes} minutes:\n\n" +
      "{link}\n\n" +
      "If you did not ask for this link, you can ignore this email.",
  }),
  signInIntro: defineGate({
    key: "copy.all-engines.portal_sign_in_intro",
    cardIds: ["c11"],
    reviewers: [...ATTORNEY],
    description: "Client portal sign-in page: what to enter and what happens next",
    draft:
      "Enter the email address your legal team has on file for you. " +
      "If it matches, we will email you a one-time link to sign in.",
  }),
  linkSent: defineGate({
    key: "copy.all-engines.portal_link_sent",
    cardIds: ["c11"],
    reviewers: [...ATTORNEY],
    description: "Neutral confirmation after a sign-in request (never says whether the address is on file)",
    draft:
      "If that address matches our records, a sign-in link is on its way. " +
      "It works once and expires in {minutes} minutes. Please check your inbox and spam folder.",
  }),
  linkExpired: defineGate({
    key: "copy.all-engines.portal_link_expired",
    cardIds: ["c11"],
    reviewers: [...ATTORNEY],
    description: "Shown when a sign-in link has expired, was already used, or the session timed out",
    draft: "That link or session is no longer valid. You can ask for a new sign-in link below.",
  }),
  quickExitHelp: defineGate({
    key: "copy.all-engines.portal_quick_exit_help",
    cardIds: ["c11", "c112"],
    reviewers: [...ATTORNEY],
    description: "Explains the Quick exit button (DV safety): signs out and opens an unrelated page",
    draft: "Need to leave quickly? Quick exit signs you out and opens a weather page.",
  }),
  matterOpen: defineGate({
    key: "copy.all-engines.portal_matter_open",
    cardIds: ["c11", "c112"],
    reviewers: [...ATTORNEY],
    description: "Client-safe status line for an open (retained) matter — no legal stage names or predictions",
    draft: "Your matter is open and your legal team is working on it.",
  }),
  documentsIntro: defineGate({
    key: "copy.all-engines.portal_documents_intro",
    cardIds: ["c112", "c49"],
    reviewers: [...ATTORNEY],
    description: "Intro to the client's 'Documents we need' list (c49 checklist, client items only)",
    draft:
      "These are documents your legal team has asked you for. " +
      "Please send them the way your legal team told you to, and tell us if anything is hard to find.",
  }),
} as const;

export const PORTAL_GATE_KEYS: readonly string[] = Object.values(PORTAL_COPY_GATES).map((g) => g.key);
