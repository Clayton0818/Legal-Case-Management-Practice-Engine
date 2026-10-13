// c106 — the fictional content of the DEMO firm. Pure data, no database.
//
// EVERYTHING HERE IS INVENTED. Rules (enforced by fixtures.test.ts):
//  - every email address is at example.com (RFC 2606 reserved domain);
//  - every phone number is in the 555-0100…555-0199 block reserved for fiction;
//  - the firm's name carries "DEMO" and "fictional";
//  - surnames are made-up words (Exampleton, Sampleford, …), never real
//    people or firms; courts and towns are "Example County" placeholders;
//  - nothing here is legal advice, a real deadline rule or a real limitation
//    period. Dates are typed in by the fictional lawyers, as a real lawyer
//    would, and the product marks anything it computes as PROPOSED.
//
// Bump DEMO_SEED_VERSION whenever this content changes.

import type { userRoleEnum } from "@/db/schema";

export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const DEMO_SEED_VERSION = "c106.1";
export const DEMO_EMAIL_DOMAIN = "example.com";
/** Fiction-reserved phone block (555-0100 … 555-0199). */
export const DEMO_PHONE_RE = /^\+1-512-555-01\d\d$/;

export const DEMO_FIRM = {
  name: "DEMO — Example & Sample Family Law (fictional)",
  /** Every demo firm's slug starts with this; a hint only, never the guard. */
  slugPrefix: "demo-",
  label: "DEMO firm — fictional data for product demonstrations",
  county: "Example County",
  court: "Example County District Court (fictional)",
  courtSenderDomain: "court.example.com",
} as const;

export const DEMO_BANNER = "DEMO — fictional data. Not a real firm, client or case. Nothing here is legal advice.";

export type StaffKey = "admin" | "partner" | "associate" | "associate2" | "intake" | "bookkeeper" | "paralegal";

export interface DemoStaff {
  key: StaffKey;
  displayName: string;
  email: string;
  phone: string;
  role: UserRole;
  /** users.role_label ('owner' / 'bookkeeper' are read by the trust engine). */
  roleLabel: string | null;
  title: string;
  languages: string[];
  seniority: number;
}

const phone = (n: number) => `+1-512-555-01${String(n).padStart(2, "0")}`;
const mail = (local: string) => `${local}@${DEMO_EMAIL_DOMAIN}`;

export const DEMO_STAFF: readonly DemoStaff[] = [
  { key: "admin", displayName: "Morgan Testwell", email: mail("morgan.testwell"), phone: phone(1), role: "firm_admin", roleLabel: "owner", title: "Firm administrator", languages: ["en"], seniority: 3 },
  { key: "partner", displayName: "Avery Exampleton", email: mail("avery.exampleton"), phone: phone(2), role: "attorney", roleLabel: "Partner", title: "Partner · designated conflicts attorney", languages: ["en"], seniority: 5 },
  { key: "associate", displayName: "Jordan Ruizwell", email: mail("jordan.ruizwell"), phone: phone(3), role: "attorney", roleLabel: "Associate", title: "Associate · family law", languages: ["en", "es"], seniority: 3 },
  { key: "associate2", displayName: "Riley Demoray", email: mail("riley.demoray"), phone: phone(4), role: "attorney", roleLabel: "Associate", title: "Associate · family law", languages: ["en"], seniority: 2 },
  { key: "intake", displayName: "Casey Mockford", email: mail("casey.mockford"), phone: phone(5), role: "intake_staff", roleLabel: "Intake coordinator", title: "Intake coordinator", languages: ["en", "es"], seniority: 1 },
  { key: "bookkeeper", displayName: "Taylor Prototon", email: mail("taylor.prototon"), phone: phone(6), role: "intake_staff", roleLabel: "bookkeeper", title: "Bookkeeper", languages: ["en"], seniority: 1 },
  { key: "paralegal", displayName: "Quinn Specimen", email: mail("quinn.specimen"), phone: phone(7), role: "intake_staff", roleLabel: "Paralegal", title: "Paralegal", languages: ["en"], seniority: 1 },
];

/** Matters the firm already had before the demo starts ("imported history"). */
export interface DemoExistingMatter {
  key: "sampleford" | "fictiva";
  title: string;
  client: { fullName: string; email: string; phone: string; aliases?: string[] };
  opposing: { fullName: string; relationship: string };
  children?: Array<{ fullName: string }>;
  responsible: StaffKey;
  team: StaffKey[];
  causeNumber: string;
  openedDaysAgo: number;
}

export const DEMO_EXISTING_MATTERS: readonly DemoExistingMatter[] = [
  {
    key: "sampleford",
    title: "Sampleford — divorce with children (fictional)",
    client: { fullName: "Dana Sampleford", email: mail("dana.sampleford"), phone: phone(20) },
    opposing: { fullName: "Chris Sampleford", relationship: "spouse" },
    children: [{ fullName: "R. Sampleford (minor child)" }],
    responsible: "associate",
    team: ["paralegal"],
    causeNumber: "DEMO-2026-FL-0101",
    openedDaysAgo: 40,
  },
  {
    key: "fictiva",
    title: "Fictiva — custody modification (fictional)",
    client: { fullName: "Pat Fictiva", email: mail("pat.fictiva"), phone: phone(21) },
    opposing: { fullName: "Lou Fictiva", relationship: "other parent" },
    responsible: "associate2",
    team: [],
    causeNumber: "DEMO-2025-FL-0457",
    openedDaysAgo: 120,
  },
];

/** People who chat in through the website widget during the walkthrough. */
export interface DemoProspect {
  key: "clear" | "possible" | "definite" | "emergency";
  fullName: string;
  email: string;
  phone: string;
  /** The first chat message (fictional). */
  message: string;
  otherPartyNames: string[];
  otherPartyRelationship: string;
  answers: Record<string, unknown>;
  story: string;
}

export const DEMO_PROSPECTS: readonly DemoProspect[] = [
  {
    key: "clear",
    fullName: "Sam Placewell",
    email: mail("sam.placewell"),
    phone: phone(30),
    message: "Hi, I'd like to talk to someone about getting a divorce. We have no kids.",
    otherPartyNames: ["Drew Placewell"],
    otherPartyRelationship: "spouse",
    answers: { county: "Example County", matterType: "divorce", hasChildren: false, language: "en" },
    story: "Conflict check comes back CLEAR, a consultation is booked, the lawyer accepts the case and the matter-open panel shows what is still outstanding.",
  },
  {
    key: "possible",
    fullName: "Kai Prototon-Vale",
    email: mail("kai.prototon-vale"),
    phone: phone(31),
    message: "I need help changing our custody order.",
    otherPartyNames: ["Morgan Fictiva-Lane"],
    otherPartyRelationship: "other parent",
    answers: { county: "Example County", matterType: "modification" },
    story: "The other parent matches a FORMER client from the imported history, so the check is POSSIBLE and waits in the conflicts attorney's queue. Nothing proceeds until a lawyer decides.",
  },
  {
    key: "definite",
    fullName: "Chris Sampleford",
    email: mail("chris.sampleford"),
    phone: phone(32),
    message: "My wife filed for divorce and I need a lawyer.",
    otherPartyNames: ["Dana Sampleford"],
    otherPartyRelationship: "spouse",
    answers: { county: "Example County", matterType: "divorce" },
    story: "The inquirer is the OPPOSING party in a current matter and names our current client. The conflicts attorney declines it (not waivable); the person is only told the firm cannot help, never why.",
  },
  {
    key: "emergency",
    fullName: "Robin Fictor",
    email: mail("robin.fictor"),
    phone: phone(33),
    message: "My ex threatened to hurt me tonight and I am scared. I need a protective order.",
    otherPartyNames: ["Jesse Fictor"],
    otherPartyRelationship: "former partner",
    answers: { county: "Example County", matterType: "protective_order" },
    story: "Emergency detection fires on the first message: the chat shows the safety message, the intake pauses and the on-call lawyer is escalated to.",
  },
];

/**
 * The firm's historical client list, imported through the conflict-check
 * engine's real CSV import (c96). Header = IMPORT_TEMPLATE_HEADER.
 * Morgan Lane (née Fictiva-Lane) is the former client behind the POSSIBLE example.
 */
export const DEMO_HISTORY_ROWS: readonly string[] = [
  `client,Dana Sampleford,person,,,,,,${mail("dana.sampleford")},${phone(20)},,DEMO-M-0101,Sampleford divorce,open,family,,,,`,
  "opposing_party,Chris Sampleford,person,,,,,,,,,DEMO-M-0101,Sampleford divorce,open,family,,,spouse,yes",
  `client,Pat Fictiva,person,,,,,,${mail("pat.fictiva")},${phone(21)},,DEMO-M-0457,Fictiva modification,open,family,,,,`,
  "opposing_party,Lou Fictiva,person,,,,,,,,,DEMO-M-0457,Fictiva modification,open,family,,,other parent,yes",
  `former_client,Morgan Lane,person,,Morgan Fictiva-Lane,,,,${mail("morgan.lane")},${phone(40)},,DEMO-M-0033,Lane divorce,closed,family,2021-02-01,2022-03-15,,`,
  "opposing_party,Toby Lane,person,,,,,,,,,DEMO-M-0033,Lane divorce,closed,family,,,former spouse,yes",
  "declined_consultation,Jo Exemplar,person,,,,,,,,,DEMO-C-0090,,,family,2024-06-02,,,",
];

/** Small fictional text documents uploaded through the document engine. */
export interface DemoDocument {
  matter: DemoExistingMatter["key"];
  folderKey: string;
  filename: string;
  documentType: string;
  versions: string[];
}

export const DEMO_DOCUMENTS: readonly DemoDocument[] = [
  {
    matter: "sampleford",
    folderKey: "pleadings",
    filename: "Original Petition for Divorce (DEMO draft).txt",
    documentType: "pleading",
    versions: [
      "DEMO DOCUMENT — FICTIONAL. In the Matter of the Marriage of Dana Sampleford and Chris Sampleford. Draft petition prepared by the firm. Children: one minor child. Requests temporary orders hearing.",
      "DEMO DOCUMENT — FICTIONAL. In the Matter of the Marriage of Dana Sampleford and Chris Sampleford. Second draft after client review: adds request for mediation before final trial. Children: one minor child.",
    ],
  },
  {
    matter: "sampleford",
    folderKey: "client_uploads",
    filename: "Financial information statement (DEMO).txt",
    documentType: "financial_disclosure",
    versions: [
      "DEMO DOCUMENT — FICTIONAL. Monthly income and expenses provided by the client. Example Bank checking account ending 0000. Mortgage on the family home in Example County.",
    ],
  },
  {
    matter: "sampleford",
    folderKey: "correspondence",
    filename: "Letter to opposing counsel re mediation (DEMO).txt",
    documentType: "letter",
    versions: ["DEMO DOCUMENT — FICTIONAL. Proposing three mediation dates and a mediator from the Example County roster."],
  },
  {
    matter: "fictiva",
    folderKey: "client_uploads",
    filename: "School calendar and parenting notes (DEMO).txt",
    documentType: "evidence",
    versions: ["DEMO DOCUMENT — FICTIONAL. Parenting time notes kept by the client for the custody modification. School pickup schedule at Example Elementary."],
  },
];

/** Client messages used for the reply-clock demo. */
export const DEMO_CLIENT_MESSAGES = {
  deadlineQuestion: "Hi — do I need to file anything before the hearing next week? I want to make sure I don't miss a deadline.",
  routineQuestion: "Just checking in: did the other side send their financial documents yet?",
  firmReply: "Thanks for asking — I'm looking at the file now and will call you this afternoon. (DEMO reply)",
} as const;

/** Fictional court email used for the court-notice alert demo (sender domain is example.com). */
export const DEMO_COURT_EMAIL = {
  fromAddress: `notices@${DEMO_FIRM.courtSenderDomain}`,
  fromDisplayName: "Example County District Clerk (fictional)",
  subject: "Notice of Setting — Cause No. DEMO-2026-FL-0101 (fictional)",
  bodyText:
    "DEMO NOTICE — FICTIONAL. The above cause is set for a status conference. Please confirm attendance with the court coordinator.",
} as const;

/** Every address and phone in the fixtures (for the fictional-data test). */
export function allFixtureContacts(): { emails: string[]; phones: string[] } {
  const emails: string[] = [];
  const phones: string[] = [];
  for (const s of DEMO_STAFF) {
    emails.push(s.email);
    phones.push(s.phone);
  }
  for (const m of DEMO_EXISTING_MATTERS) {
    emails.push(m.client.email);
    phones.push(m.client.phone);
  }
  for (const p of DEMO_PROSPECTS) {
    emails.push(p.email);
    phones.push(p.phone);
  }
  for (const row of DEMO_HISTORY_ROWS) {
    for (const cell of row.split(",")) {
      if (cell.includes("@")) emails.push(cell);
      if (/\d{3}-\d{4}/.test(cell)) phones.push(cell);
    }
  }
  emails.push(DEMO_COURT_EMAIL.fromAddress);
  return { emails, phones };
}

export function staffByKey(key: StaffKey): DemoStaff {
  const s = DEMO_STAFF.find((x) => x.key === key);
  if (!s) throw new Error(`Unknown demo staff key '${key}'.`);
  return s;
}
