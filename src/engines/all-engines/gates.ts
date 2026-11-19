// Approval gates owned by the All-engines engine (c99, c102, c103, c104, c105).
//
// Nothing here is approved. Until a reviewer's sign-off is recorded
// (`npm run compliance -- approve …`):
//  - every client-facing sentence of a practice-area pack renders as a visible
//    "[PENDING ATTORNEY REVIEW …]" placeholder via legalCopy();
//  - every Texas family-law rule reference, every Immigration rule reference
//    and every Texas personal-injury rule reference blocks (requireApproval
//    throws PendingApprovalError) in whichever engine tries to apply it.
// Drafts are proposals for the reviewer, not approved wording and not legal
// advice. Shared gates (rules.court_deadlines, rules.limitation_periods,
// rules.fee_agreement_terms, rules.trust_accounting) are reused, not redefined.

import { defineGate, type Gate } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import { listPacks } from "./packs/registry";
import { uniqueCopyItems } from "./packs/copy";
import { FAMILY_RULE_KEYS } from "./packs/family";
import { IMMIGRATION_RULE_KEYS } from "./packs/immigration";
import { PERSONAL_INJURY_RULE_KEYS } from "./packs/personalInjury";

export { RULE_GATES };

// Client portal copy (c11, c112) lives with the portal (src/portal/gates.ts);
// re-exported here so loadAllGates() — the compliance CLI and the admin
// "pending approvals" page — lists it.
export { PORTAL_COPY_GATES, PORTAL_GATE_KEYS } from "@/portal/gates";

const ATTORNEY = ["attorney"] as const;
const ATTORNEY_AND_CPA = ["attorney", "cpa"] as const;

/** Texas family-law rule gates (c103). Values never live in code; these gate their use. */
export const FAMILY_RULE_GATES = {
  packContent: defineGate({
    key: FAMILY_RULE_KEYS.packContent,
    cardIds: ["c103"],
    reviewers: [...ATTORNEY],
    description: "Family Law pack as a whole (matter types, questions, party roles, checklists, stages, task lists) reviewed by a Texas family-law attorney",
  }),
  starterTemplates: defineGate({
    key: FAMILY_RULE_KEYS.starterTemplates,
    cardIds: ["c103", "c85", "c39"],
    reviewers: [...ATTORNEY],
    description: "Family Law starter templates (petitions, parenting plan, inventory, disclosures, final orders): content and licensing",
  }),
  divorceWaitingPeriod: defineGate({
    key: FAMILY_RULE_KEYS.divorceWaitingPeriod,
    cardIds: ["c103", "c92"],
    reviewers: [...ATTORNEY],
    description: "Texas waiting period before a divorce can be granted, and its exceptions (lawyer tool only)",
  }),
  residencyVenue: defineGate({
    key: FAMILY_RULE_KEYS.residencyVenue,
    cardIds: ["c103", "c73"],
    reviewers: [...ATTORNEY],
    description: "Texas residency and venue requirements for family cases (lawyer tool only; never an automatic decline)",
  }),
  childSupportGuidelines: defineGate({
    key: FAMILY_RULE_KEYS.childSupportGuidelines,
    cardIds: ["c103"],
    reviewers: [...ATTORNEY],
    description: "Texas child-support guideline calculation: percentages, income definitions, caps (lawyer worksheet only)",
  }),
  possessionSchedule: defineGate({
    key: FAMILY_RULE_KEYS.possessionSchedule,
    cardIds: ["c103", "c91"],
    reviewers: [...ATTORNEY],
    description: "Texas standard parenting-time (possession) schedule rules used to draft a calendar for the lawyer",
  }),
  protectiveOrderTiming: defineGate({
    key: FAMILY_RULE_KEYS.protectiveOrderTiming,
    cardIds: ["c103", "c66", "c92"],
    reviewers: [...ATTORNEY],
    description: "Protective-order hearing timing and temporary-order duration (real clock; lawyer tool only)",
  }),
  modificationEligibility: defineGate({
    key: FAMILY_RULE_KEYS.modificationEligibility,
    cardIds: ["c103"],
    reviewers: [...ATTORNEY],
    description: "When and on what grounds a custody/support order may be modified (prompts for the lawyer; the product never decides)",
  }),
  statutoryForms: defineGate({
    key: FAMILY_RULE_KEYS.statutoryForms,
    cardIds: ["c103", "c85"],
    reviewers: [...ATTORNEY],
    description: "Statutory warnings, notices and forms required in Texas family filings",
  }),
} as const;

/**
 * Immigration rule gates (c104). Federal law (8 CFR, EOIR); values never
 * live in code. Several of these exist specifically because unlicensed
 * ("notario") immigration advice is a documented source of real harm and
 * Texas has its own rules against it — see
 * docs/product/features/all-engines/c104-immigration-pack.md.
 */
export const IMMIGRATION_RULE_GATES = {
  packContent: defineGate({
    key: IMMIGRATION_RULE_KEYS.packContent,
    cardIds: ["c104"],
    reviewers: [...ATTORNEY],
    description: "Immigration pack as a whole (matter types, questions, party roles, checklists, stages, task lists) reviewed by a licensed immigration attorney",
  }),
  starterTemplates: defineGate({
    key: IMMIGRATION_RULE_KEYS.starterTemplates,
    cardIds: ["c104", "c85", "c39"],
    reviewers: [...ATTORNEY],
    description: "Immigration starter templates (USCIS/EOIR forms, G-28/EOIR-28, supporting evidence index): content and licensing",
  }),
  formAndTrackEligibility: defineGate({
    key: IMMIGRATION_RULE_KEYS.formAndTrackEligibility,
    cardIds: ["c104"],
    reviewers: [...ATTORNEY],
    description: "Which immigration forms or process track may fit a case — a lawyer-only prompt; the product never tells a client whether they qualify or which form to file (notario/UPL risk)",
  }),
  uscisNoticeDeadlines: defineGate({
    key: IMMIGRATION_RULE_KEYS.uscisNoticeDeadlines,
    cardIds: ["c104", "c91"],
    reviewers: [...ATTORNEY],
    description: "USCIS Request for Evidence, biometrics and interview response/appearance timing (lawyer tool only)",
  }),
  eoirHearingCalendar: defineGate({
    key: IMMIGRATION_RULE_KEYS.eoirHearingCalendar,
    cardIds: ["c104", "c91", "c66"],
    reviewers: [...ATTORNEY],
    description: "Immigration court (EOIR) master calendar and merits hearing timing used to propose matter-calendar entries",
  }),
  naturalizationEligibilityTiming: defineGate({
    key: IMMIGRATION_RULE_KEYS.naturalizationEligibilityTiming,
    cardIds: ["c104"],
    reviewers: [...ATTORNEY],
    description: "Continuous residence, physical presence and other naturalization timing eligibility rules (lawyer worksheet only)",
  }),
  removalDefenseReliefEligibility: defineGate({
    key: IMMIGRATION_RULE_KEYS.removalDefenseReliefEligibility,
    cardIds: ["c104"],
    reviewers: [...ATTORNEY],
    description: "Available forms of relief from removal and their eligibility screening questions (prompts for the lawyer; the product never decides)",
  }),
  filingFeeAndWaiverSchedule: defineGate({
    key: IMMIGRATION_RULE_KEYS.filingFeeAndWaiverSchedule,
    cardIds: ["c104", "c52"],
    reviewers: [...ATTORNEY],
    description: "USCIS/EOIR filing-fee schedule and fee-waiver eligibility criteria",
  }),
} as const;

/**
 * Texas personal-injury rule gates (c105). Values never live in code; these
 * gate their use. The limitations period (rules.limitation_periods) and the
 * contingency-fee terms (rules.fee_agreement_terms) reuse the SHARED gates
 * already defined in src/compliance/gates.ts — both already list c105 among
 * their cardIds — rather than being redefined here. Only the lien-resolution
 * rule and the starter-template library are genuinely new to this pack.
 */
export const PERSONAL_INJURY_RULE_GATES = {
  packContent: defineGate({
    key: PERSONAL_INJURY_RULE_KEYS.packContent,
    cardIds: ["c105"],
    reviewers: [...ATTORNEY_AND_CPA],
    description:
      "Personal Injury pack as a whole (matter types, questions, party roles, checklists, stages, task lists), including its settlement-statement and lien-resolution content, reviewed by a Texas personal-injury attorney and a CPA",
  }),
  starterTemplates: defineGate({
    key: PERSONAL_INJURY_RULE_KEYS.starterTemplates,
    cardIds: ["c105", "c39"],
    reviewers: [...ATTORNEY],
    description:
      "Personal Injury starter templates (contingency-fee engagement agreement, medical-records authorization, demand letter, written settlement statement, petitions): content and licensing",
  }),
  lienResolutionBeforeDisbursement: defineGate({
    key: PERSONAL_INJURY_RULE_KEYS.lienResolutionBeforeDisbursement,
    cardIds: ["c105", "c76", "c78"],
    reviewers: [...ATTORNEY_AND_CPA],
    description:
      "Process for identifying and resolving hospital, health-insurer and Medicare liens (including Medicare's conditional-payment reimbursement right) before any personal-injury settlement funds are disbursed from trust",
  }),
} as const;

/** One attorney copy gate per client-facing sentence in every registered pack. */
function definePackCopyGates(): Gate[] {
  const out: Gate[] = [];
  for (const pack of listPacks()) {
    for (const item of uniqueCopyItems(pack)) {
      out.push(
        defineGate({
          key: item.copyKey,
          cardIds: [pack.cardId, "c102"],
          reviewers: [...ATTORNEY],
          description: `${pack.label} pack: ${item.where} (client-facing)`,
          draft: item.draft,
        })
      );
    }
  }
  return out;
}

export const PACK_COPY_GATES: readonly Gate[] = definePackCopyGates();

/**
 * c124 group messaging. Client-facing wording only: whether to represent
 * several clients jointly is the lawyer's own decision, which the software
 * records but never makes. Until approved, each shows the visible
 * "[PENDING ATTORNEY REVIEW …]" placeholder; a consent recorded meanwhile
 * stores that the wording was not yet approved.
 */
export const GROUP_MESSAGING_GATES = {
  consentWording: defineGate({
    key: "copy.all-engines.joint_sharing_consent",
    cardIds: ["c124"],
    reviewers: [...ATTORNEY],
    description: "Consent a client gives to sharing information about the matter with the other clients on it (joint representation), read to or signed by each client",
    draft:
      "You and the other clients on this matter are represented together. Anything you tell the firm about the matter may be shared with them, " +
      "and messages the firm sends to the group go to all of you. If your interests come into conflict, the firm may not be able to keep " +
      "representing all of you. You can withdraw this consent at any time by telling the firm.",
  }),
  newMessageNotice: defineGate({
    key: "copy.all-engines.group_message_notice",
    cardIds: ["c124"],
    reviewers: [...ATTORNEY],
    description: "Email telling a client there is a new group message about their matter (no case details; read it in the portal)",
    draft: "Subject: New message from {firmName}\n\nThere is a new message about your matter. Please read it in {portalUrl}.",
  }),
} as const;

export const ALL_ENGINES_GATE_KEYS: readonly string[] = [
  ...Object.values(FAMILY_RULE_GATES).map((g) => g.key),
  ...Object.values(IMMIGRATION_RULE_GATES).map((g) => g.key),
  ...Object.values(PERSONAL_INJURY_RULE_GATES).map((g) => g.key),
  ...PACK_COPY_GATES.map((g) => g.key),
];

/** c124's own wording gates (kept apart from the practice-area pack keys above). */
export const GROUP_MESSAGING_GATE_KEYS: readonly string[] = Object.values(GROUP_MESSAGING_GATES).map((g) => g.key);

/** Shared gates this engine's packs depend on (shown on the admin pages). */
export const ALL_ENGINES_SHARED_GATE_KEYS: readonly string[] = [
  RULE_GATES.courtDeadlines.key,
  RULE_GATES.limitationPeriods.key,
  RULE_GATES.feeAgreementTerms.key,
  RULE_GATES.trustAccounting.key,
];
