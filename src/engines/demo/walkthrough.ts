// c106 — the guided walkthrough shown at /demo. Pure data + tiny helpers.
//
// Honesty rules baked into every step (and checked by walkthrough.test.ts):
//  - anything awaiting attorney / CPA / vendor sign-off is listed under
//    `gates`; the page shows each gate's LIVE status and its visible
//    "[PENDING … REVIEW]" placeholder until it is approved — never as final;
//  - vendor integrations are listed under `simulated` and labelled
//    "simulated in demo";
//  - talking points never claim the AI gives legal advice, decides a
//    deadline or clears a conflict (a forbidden-phrase test guards this).
//
// Links may contain {matter:<key>} / {session:<key>} tokens, filled in from
// the live demo firm (snapshot.ts). A link whose token cannot be filled is
// shown disabled rather than pointing somewhere wrong.

export type LinkKind = "page" | "api";

export interface WalkthroughLink {
  label: string;
  href: string;
  kind: LinkKind;
}

export type SimulatedVendor =
  | "email"
  | "sms"
  | "calendar sync"
  | "video meetings"
  | "e-signature"
  | "document storage"
  | "virus scanning"
  | "OCR"
  | "bank feed"
  | "AI model"
  | "court mailbox / e-filing"
  | "payments";

export interface WalkthroughStep {
  id: string;
  title: string;
  /** What the audience is looking at, in two or three plain sentences. */
  explanation: string;
  links: WalkthroughLink[];
  talkingPoints: string[];
  /** Gate keys whose live status (and placeholder) the step shows. */
  gates: string[];
  simulated: SimulatedVendor[];
  /** Which snapshot panel to show alongside (snapshot.ts). */
  panel: SnapshotPanel;
}

export type SnapshotPanel =
  | "prospects"
  | "emergency"
  | "conflicts"
  | "booking"
  | "acceptance"
  | "opening"
  | "calendar"
  | "limitations"
  | "documents"
  | "trust"
  | "communication"
  | "court_notice"
  | "health"
  | "permissions"
  | "family_pack"
  | "ops";

export const WALKTHROUGH: readonly WalkthroughStep[] = [
  {
    id: "chat-in",
    title: "1. A prospect chats in through the website widget",
    explanation:
      "Four fictional people have contacted the DEMO firm through the website chat. Every message is stored against an intake session, and the first replies — the channel disclosure and the acknowledgement — come only from wording a lawyer approves.",
    links: [
      { label: "Open the chat widget (as a prospect)", href: "/chat", kind: "page" },
      { label: "Widget embed settings", href: "/admin/ops/widget", kind: "page" },
      { label: "Intake queue", href: "/admin/intake", kind: "page" },
    ],
    talkingPoints: [
      "One queue for every channel: web chat, email, SMS, phone and walk-ins all land in the same place.",
      "Until a lawyer approves the disclosure wording, the chat shows a visible [PENDING ATTORNEY REVIEW] placeholder — we never ship unreviewed legal wording.",
      "The assistant collects facts and books time; it does not give legal advice, and it says so.",
      "A response clock starts on the first message with contact details, so nobody waits unseen.",
    ],
    gates: ["copy.intake.channel_disclosure", "copy.intake.ai_acknowledgement", "copy.platform.widget_notice"],
    simulated: ["sms", "email", "AI model"],
    panel: "prospects",
  },
  {
    id: "triage-emergency",
    title: "2. Intake triage and emergency detection",
    explanation:
      "Robin Fictor's first message mentions a threat of harm. Emergency detection runs on every message before anything else: the safety message is shown, the intake pauses and the on-call lawyer from the rota is alerted, with escalation if nobody acknowledges.",
    links: [
      { label: "Intake console (open emergencies)", href: "/admin/intake", kind: "page" },
      { label: "Open emergencies (API)", href: "/api/intake/emergencies", kind: "api" },
      { label: "On-call rota (API)", href: "/api/intake/rota", kind: "api" },
    ],
    talkingPoints: [
      "Detection is deliberately conservative: it would rather alert a person than miss a safety signal.",
      "It routes to people — the on-call lawyer and backup — it does not advise the person what to do legally.",
      "In this demo the AI triage model is pending its vendor agreement, so the intake coordinator records the practice area herself; the product shows who decided.",
    ],
    gates: ["rules.intake.emergency_detection", "copy.intake.safety_911", "rules.platform.safety_triggers", "vendor.ai_model"],
    simulated: ["AI model", "sms"],
    panel: "emergency",
  },
  {
    id: "conflicts",
    title: "3. The conflict check — clear, possible and definite",
    explanation:
      "Every named party is checked against the firm's imported history and current matters before any case details are collected. Sam Placewell comes back clear. Kai Prototon-Vale names a former client, so the check is possible and waits in the conflicts attorney's queue. Chris Sampleford is the other side of a current matter: a conflicts attorney declined it as not waivable.",
    links: [
      { label: "Conflict-check console", href: "/admin/conflict-check", kind: "page" },
      { label: "Conflicts attorney's queue (API)", href: "/api/conflict-check/queue", kind: "api" },
      { label: "Conflict log (API)", href: "/api/conflict-check/log", kind: "api" },
    ],
    talkingPoints: [
      "Software finds matches; a designated conflicts attorney decides. Nothing is ever cleared automatically.",
      "Maiden and former names are searched too — that is how the former client was found.",
      "The prospect is never told why the firm cannot help, or who the conflict is with.",
      "Automatic 'definite' classification uses a rule table that is still [PENDING ATTORNEY REVIEW]; until then the attorney's decision is what makes it definite.",
    ],
    gates: ["rules.conflicts", "copy.conflict-check.pending_review", "copy.conflict-check.definite_referral"],
    simulated: [],
    panel: "conflicts",
  },
  {
    id: "booking",
    title: "4. Booking a consultation",
    explanation:
      "Only after the conflict check is clear does booking open. The system offers real free slots from the eligible lawyer's own calendar, holds the slot while the person confirms, and books it.",
    links: [
      { label: "Booking options for Sam (API)", href: "/api/intake/sessions/{session:clear}/booking", kind: "api" },
      { label: "Intake console", href: "/admin/intake", kind: "page" },
    ],
    talkingPoints: [
      "Booking is refused while a conflict is possible or pending — the person is told the firm will follow up, without a reason.",
      "Consultation fees and confirmation wording wait for attorney approval and show as placeholders until then.",
      "External calendar sync (Microsoft 365 / Google) is simulated in this demo; the product uses its own calendar.",
    ],
    gates: ["copy.intake.consult_confirmation", "rules.intake.consult_fee_terms", "vendor.calendar_sync", "vendor.intake.video_meetings"],
    simulated: ["calendar sync", "video meetings", "email"],
    panel: "booking",
  },
  {
    id: "acceptance",
    title: "5. Case acceptance",
    explanation:
      "The firm's own fit rules sort inquiries into accept, borderline or decline. Sam's inquiry was borderline (the practice area was not known yet), so a lawyer looked at it and accepted it, with a written reason.",
    links: [
      { label: "Sam Placewell's matter", href: "/admin/matters/{matter:placewell}", kind: "page" },
      { label: "Intake console", href: "/admin/intake", kind: "page" },
      { label: "Fit rules (API)", href: "/api/intake/acceptance/rules", kind: "api" },
      { label: "Pipeline (API)", href: "/api/intake/pipeline", kind: "api" },
    ],
    talkingPoints: [
      "Borderline inquiries always go to a lawyer; the system never declines someone on its own while automatic declines are pending review.",
      "Every decision records who made it and why.",
    ],
    gates: ["rules.intake.auto_decline", "copy.intake.decline_notice", "rules.intake.referral_list"],
    simulated: [],
    panel: "acceptance",
  },
  {
    id: "opening",
    title: "6. Opening the matter — assignment and hand-offs",
    explanation:
      "The prospective matter was assigned to an eligible lawyer by the firm's routing rules. The matter-open panel lists what is still outstanding (signed engagement, fee arrangement, first payment). The final 'open matter' step is itself waiting for an attorney to approve the gate list, so in this demo it is visibly blocked.",
    links: [
      { label: "Sam Placewell's matter", href: "/admin/matters/{matter:placewell}", kind: "page" },
      { label: "Matter-open panel (API)", href: "/api/intake/matters/{matter:placewell}/open", kind: "api" },
      { label: "Matters queue", href: "/admin", kind: "page" },
    ],
    talkingPoints: [
      "Representation begins only when every gate is met — conflict cleared, engagement signed, fee arrangement, first payment.",
      "Hand-offs (welcome, portal invite, document checklist, calendar) start automatically once the matter opens.",
      "Engagement letters and e-signature are simulated here; fee-agreement terms are [PENDING ATTORNEY REVIEW].",
    ],
    gates: ["rules.intake.matter_open_gates", "rules.fee_agreement_terms", "copy.intake.matter_opened", "vendor.esignature"],
    simulated: ["e-signature", "payments", "email"],
    panel: "opening",
  },
  {
    id: "calendar",
    title: "7. Calendar and deadlines — the lawyer confirms",
    explanation:
      "The Sampleford divorce has a confirmed hearing, and two entries typed in by the paralegal that stay PROPOSED until a lawyer confirms them. The deadline calculator only proposes dates from a lawyer-approved rule set — and the court-rule calculations themselves are still pending attorney review, so the attempt is shown blocked.",
    links: [
      { label: "Calendar console", href: "/admin/calendar-core", kind: "page" },
      { label: "Awaiting lawyer confirmation (API)", href: "/api/calendar-core/confirmations", kind: "api" },
      { label: "Sampleford deadlines (API)", href: "/api/calendar-core/matters/{matter:sampleford}/deadlines", kind: "api" },
    ],
    talkingPoints: [
      "Anything not typed in by a lawyer starts as PROPOSED. Only a lawyer can confirm a deadline or court date — the database enforces it too.",
      "The system never decides a deadline. It can calculate a proposal from rules the firm's lawyer approved, and a lawyer confirms it.",
      "Calendar sync to Outlook / Google is simulated in this demo.",
    ],
    gates: ["rules.court_deadlines", "vendor.calendar_sync"],
    simulated: ["calendar sync"],
    panel: "calendar",
  },
  {
    id: "limitations",
    title: "8. Limitation dates — independent verification",
    explanation:
      "A lawyer typed in a limitation date on the Fictiva matter and a second lawyer verified it blind (without seeing the first entry). Another date on the Sampleford matter is still unverified, so the daily scan flags it.",
    links: [
      { label: "Limitation dates (API)", href: "/api/calendar-core/limitations", kind: "api" },
      { label: "Calendar console", href: "/admin/calendar-core", kind: "page" },
    ],
    talkingPoints: [
      "The product does not compute limitation periods. A lawyer enters the date; a second person verifies it independently.",
      "Unverified dates are flagged every day until someone verifies them, with reminders as the date approaches.",
    ],
    gates: ["rules.limitation_periods"],
    simulated: [],
    panel: "limitations",
  },
  {
    id: "documents",
    title: "9. Documents — folders, versions, search, access log",
    explanation:
      "Each matter gets the firm's folder template. Uploads are never overwritten: the petition has two versions. Text is searchable, and every view, download and search — including refused ones — is in the access log.",
    links: [
      { label: "Document console", href: "/admin/document", kind: "page" },
      { label: "Search 'mediation' (API)", href: "/api/document/search?q=mediation", kind: "api" },
      { label: "Access log (API)", href: "/api/document/access-log", kind: "api" },
      { label: "Sampleford documents (API)", href: "/api/document/matters/{matter:sampleford}/documents", kind: "api" },
    ],
    talkingPoints: [
      "Ethical screens apply to documents too: a screened lawyer cannot list, search or download them, and the refusal is logged.",
      "Storage, virus scanning and OCR are simulated in this demo (in-memory store, stub scanner); the production store waits for its vendor agreement.",
      "Retention periods are firm-set and [PENDING ATTORNEY REVIEW]; nothing is destroyed automatically.",
    ],
    gates: ["vendor.object_storage", "rules.retention_periods"],
    simulated: ["document storage", "virus scanning", "OCR"],
    panel: "documents",
  },
  {
    id: "trust",
    title: "10. Trust ledger and three-way reconciliation",
    explanation:
      "The DEMO IOLTA account has a client ledger per matter. The bookkeeper tried to record two retainer deposits — both are blocked, because any movement of trust money waits for an attorney AND a CPA to approve the trust rules. The bank statement was entered, and the three-way reconciliation shows exactly which bank lines are not yet in the books.",
    links: [
      { label: "Trust console", href: "/admin/billing-trust", kind: "page" },
      { label: "Trust accounts (API)", href: "/api/billing-trust/accounts", kind: "api" },
      { label: "Trust gates (API)", href: "/api/billing-trust/gates", kind: "api" },
    ],
    talkingPoints: [
      "The journal is append-only — even the database refuses edits and deletes. Corrections are reversals.",
      "A client's money can never cover another client's overdraft; the app and the database both refuse it.",
      "Bank feeds are simulated in this demo; statements are entered or uploaded by the bookkeeper.",
      "This is the clearest example of the approval system: the feature is built, and it stays switched off until the attorney and CPA sign off.",
    ],
    gates: ["rules.trust_accounting", "rules.billing-trust.rule_values", "vendor.billing-trust.bank_feed"],
    simulated: ["bank feed", "payments"],
    panel: "trust",
  },
  {
    id: "communication",
    title: "11. Client updates and reply clocks",
    explanation:
      "Dana Sampleford asked about a deadline three hours ago. A reply clock is running on the shorter deadline track (the firm's own settings: flag after 12 business hours, answer within 24). Pat Fictiva's question was answered by a lawyer, which stopped that clock. One update was sent after a lawyer wrote it; an automatically drafted update waits for a lawyer's approval.",
    links: [
      { label: "Alerts console", href: "/admin/calendar-alerts", kind: "page" },
      { label: "Open reply clocks (API)", href: "/api/calendar-alerts/reply-clocks", kind: "api" },
      { label: "Drafts awaiting approval (API)", href: "/api/calendar-alerts/updates/drafts", kind: "api" },
    ],
    talkingPoints: [
      "Only a human reply stops a clock — an automatic acknowledgement never counts as answering the client.",
      "Drafted updates are never sent until a lawyer approves them.",
      "Client emails carry no case details — just a link to the portal — and outbound email is simulated in this demo (held in the outbox).",
    ],
    gates: ["copy.calendar-alerts.reply_ack", "copy.calendar-alerts.deadline_reply_ack", "notify.client.generic_update", "vendor.email"],
    simulated: ["email", "sms"],
    panel: "communication",
  },
  {
    id: "court-notice",
    title: "12. Court-notice alerts",
    explanation:
      "A notice of setting arrived by email from the (fictional) court clerk's domain the firm trusts. It was matched to the Sampleford matter by cause number and raised a critical internal alert for the responsible lawyer.",
    links: [
      { label: "Court notices (API)", href: "/api/calendar-alerts/court-notices", kind: "api" },
      { label: "Alerts console", href: "/admin/calendar-alerts", kind: "page" },
    ],
    talkingPoints: [
      "Look-alike senders are treated as possible phishing and their contents are not shown.",
      "Any date in the notice becomes a PROPOSED entry for a lawyer to confirm — never a confirmed deadline.",
      "Mailbox and e-filing connections are simulated in this demo; the notice was entered manually.",
    ],
    gates: ["rules.calendar-alerts.court_notice_suggestions", "vendor.mailbox_access", "vendor.efiling"],
    simulated: ["court mailbox / e-filing"],
    panel: "court_notice",
  },
  {
    id: "health",
    title: "13. Case health and overdue work",
    explanation:
      "Each open matter gets a daily health score from signals like overdue tasks, waiting clients and approaching dates. The exhibit-list task is two days overdue, so the overdue scan flagged it — once, however often it runs.",
    links: [
      { label: "Alerts console", href: "/admin/calendar-alerts", kind: "page" },
      { label: "Ops — attention needed", href: "/admin/ops", kind: "page" },
      { label: "Case health dashboard (API)", href: "/api/calendar-alerts/health", kind: "api" },
      { label: "Overdue work (API)", href: "/api/calendar-alerts/overdue", kind: "api" },
    ],
    talkingPoints: [
      "The score explains itself: every point comes with the signal behind it.",
      "Firm timers use the firm's business hours; court-related safety nets use the real clock.",
    ],
    gates: [],
    simulated: [],
    panel: "health",
  },
  {
    id: "permissions",
    title: "14. Permissions",
    explanation:
      "Roles (owner, admin, lawyer, paralegal, intake, bookkeeper) set what each person can do, and every change is logged with a reason. The paralegal sees the Sampleford matter because she is on its team.",
    links: [
      { label: "Permission matrix", href: "/admin/all-engines/permissions", kind: "page" },
      { label: "Access change log (API)", href: "/api/all-engines/permissions/log", kind: "api" },
    ],
    talkingPoints: [
      "Some rights are attorney-only and cannot be granted to anyone else: confirming deadlines, clearing conflicts, approving trust disbursements.",
      "Restricted matters (for example a staff member's own case) are hidden even from admins.",
    ],
    gates: [],
    simulated: [],
    panel: "permissions",
  },
  {
    id: "family-pack",
    title: "15. The Family Law practice-area pack",
    explanation:
      "Family Law is the pilot pack: intake questions, stages, task lists and document checklists for divorce, custody and protective orders. The fictional partner reviewed the DRAFT stage and task-list templates and activated them for the demo firm.",
    links: [
      { label: "Practice areas", href: "/admin/all-engines/practice-areas", kind: "page" },
      { label: "Family Law pack", href: "/admin/all-engines/practice-areas/family", kind: "page" },
    ],
    talkingPoints: [
      "Pack content that touches law — waiting periods, child support guidelines, possession schedules, statutory forms — is [PENDING ATTORNEY REVIEW] and shows as a placeholder.",
      "Templates are workflow starting points the firm edits; they never calculate a court deadline.",
    ],
    gates: [
      "rules.all-engines.family.pack_content",
      "rules.all-engines.family.divorce_waiting_period",
      "rules.all-engines.family.child_support_guidelines",
      "rules.all-engines.family.possession_schedule",
    ],
    simulated: [],
    panel: "family_pack",
  },
  {
    id: "ops",
    title: "16. Admin and operations views",
    explanation:
      "The ops queue gathers everything that needs a person: overdue and due-soon tasks, open flags, held notifications and background jobs that are behind. The matters queue and insights round off the firm's view.",
    links: [
      { label: "Ops — attention needed", href: "/admin/ops", kind: "page" },
      { label: "Matters queue", href: "/admin", kind: "page" },
      { label: "Insights", href: "/admin/insights", kind: "page" },
    ],
    talkingPoints: [
      "Held emails show up here with the reason — for example, the email vendor approval is still pending.",
      "Every approval placeholder in the product is listed for the firm's reviewers; nothing pending is ever presented as final.",
    ],
    gates: ["vendor.email"],
    simulated: ["email"],
    panel: "ops",
  },
];

/** Phrases the demo must never use (it would imply legal advice or automated legal decisions). */
export const FORBIDDEN_CLAIMS: readonly RegExp[] = [
  /\bAI (?:gives|provides|offers) legal advice\b/i,
  /\b(?:AI|system|software|assistant) (?:decides|sets|determines) (?:the )?deadlines?\b/i,
  /\b(?:AI|system|software|assistant) (?:clears|cleared|approves) (?:the )?conflicts?\b/i,
  /\bautomatically clear(?:s|ed)? (?:the )?conflicts?\b/i,
  /\bguaranteed? (?:compliance|accuracy)\b/i,
  /\bfully (?:compliant|approved)\b/i,
];

/** Pure: every claim-bearing string in a step. */
export function stepText(step: WalkthroughStep): string[] {
  return [step.title, step.explanation, ...step.talkingPoints, ...step.links.map((l) => l.label)];
}

export interface LinkIds {
  matter: Partial<Record<string, string>>;
  session: Partial<Record<string, string>>;
}

/** Pure: fill {matter:x}/{session:x} tokens. Returns null when an id is missing (link shown disabled). */
export function resolveHref(href: string, ids: LinkIds): string | null {
  let missing = false;
  const out = href.replace(/\{(matter|session):([a-z_]+)\}/g, (_m, kind: "matter" | "session", key: string) => {
    const v = ids[kind][key];
    if (!v) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : out;
}
