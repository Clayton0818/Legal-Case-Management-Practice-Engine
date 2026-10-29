// c87 — decide where an email belongs: auto-file, suggest, or leave alone. Pure.
//
// Spec: docs/product/features/document/c87-file-all-matter-email.md §4–5.
// Signals, strongest first:
//   (a) thread   — the thread is already filed to a matter
//   (b) address  — a sender/recipient address belongs to a party on the matter
//   (c) cause    — a cause number on the matter appears in the subject or body
//   (d) name     — a party's full name appears in the subject or body
// Auto-file ONLY when (rule 1, §4 step 3):
//   (a) points to exactly one matter, or
//   (b) points to exactly one open matter, or
//   (c) points to exactly one matter AND another signal agrees on it.
// Everything else is a suggestion for a person to confirm. Closed matters are
// never auto-filed to (rule 4). A matter the mailbox owner is screened from
// (c60) is never filed from their mailbox; it goes to the admin queue with no
// content preview (rule 5, acceptance criterion 5). The AI does not read the
// email for legal meaning (rule 9): this is string matching on metadata and
// text the worker already holds.
//
// Reading the mailbox at all needs the shared vendor.mailbox_access gate
// (VENDOR_GATES.mailboxAccess, already lists c87); that check belongs to the
// worker that fetches messages, not to this pure function.

export type EmailSignal = "thread" | "address" | "cause_number" | "name";

export interface EmailMessageMeta {
  threadId: string | null;
  from: string;
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  /** Plain-text body, if the worker fetched it. Optional: metadata alone still matches (a) and (b). */
  bodyText?: string;
  receivedAt: Date;
}

export interface MatterMatchProfile {
  matterId: string;
  open: boolean;
  /** Addresses of parties and contacts on the matter (client, opposing counsel, …). */
  partyAddresses: readonly string[];
  /** Full names of parties on the matter. */
  partyNames: readonly string[];
  causeNumbers: readonly string[];
}

export interface MatchContext {
  matters: readonly MatterMatchProfile[];
  /** threadId -> matter ids it is already filed to. */
  filedThreads: ReadonlyMap<string, readonly string[]>;
  /** The firm's own domains: staff addresses never count as a party signal. */
  firmDomains: readonly string[];
  /** Matters the mailbox owner is screened from (c60). */
  screenedMatterIds: ReadonlySet<string>;
  /** Lawyer- and firm-level exclusions (rule 6): full addresses or bare domains. */
  excludedSenders: readonly string[];
}

export interface Candidate {
  matterId: string;
  open: boolean;
  signals: EmailSignal[];
}

export type FilingDecision =
  | { action: "excluded"; reason: string }
  | { action: "auto_file"; matterId: string; signals: EmailSignal[] }
  | { action: "suggest"; candidates: Candidate[]; reason: string }
  | { action: "screened_admin_queue"; matterIds: string[] }
  | { action: "no_match" };

export function normalizeAddress(a: string): string {
  const m = a.match(/<([^>]+)>/);
  return (m ? m[1]! : a).trim().toLowerCase();
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/** Letters and digits only, upper-cased: "2026-CI-01234" and "2026 ci 01234" compare equal. */
export function normalizeCauseNumber(c: string): string {
  return c.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

/** Cause numbers this short would match too much by accident. */
const MIN_CAUSE_CHARS = 5;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive match of a multi-word name. Single words are too weak to count. */
function containsFullName(text: string, name: string): boolean {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const re = new RegExp(`(^|[^\\p{L}])${parts.map(escapeRegExp).join("\\s+")}($|[^\\p{L}])`, "iu");
  return re.test(text);
}

export function isExcluded(from: string, excluded: readonly string[]): boolean {
  const addr = normalizeAddress(from);
  return excluded.some((e) => {
    const x = e.trim().toLowerCase().replace(/^@/, "");
    return x.includes("@") ? x === addr : domainOf(addr) === x;
  });
}

/** Collect every signal per matter. Pure. */
export function collectCandidates(msg: EmailMessageMeta, ctx: MatchContext): Candidate[] {
  const byMatter = new Map<string, Candidate>();
  const add = (m: MatterMatchProfile, s: EmailSignal) => {
    const c = byMatter.get(m.matterId) ?? { matterId: m.matterId, open: m.open, signals: [] };
    if (!c.signals.includes(s)) c.signals.push(s);
    byMatter.set(m.matterId, c);
  };
  const profile = new Map(ctx.matters.map((m) => [m.matterId, m]));
  const firmDomains = new Set(ctx.firmDomains.map((d) => d.toLowerCase()));

  if (msg.threadId) {
    for (const id of ctx.filedThreads.get(msg.threadId) ?? []) {
      const m = profile.get(id);
      if (m) add(m, "thread");
    }
  }

  const addresses = [msg.from, ...msg.to, ...(msg.cc ?? [])]
    .map(normalizeAddress)
    .filter((a) => a.includes("@") && !firmDomains.has(domainOf(a)));
  const text = `${msg.subject}\n${msg.bodyText ?? ""}`;
  const normText = normalizeCauseNumber(text);

  for (const m of ctx.matters) {
    const partyAddrs = new Set(m.partyAddresses.map(normalizeAddress));
    if (addresses.some((a) => partyAddrs.has(a))) add(m, "address");
    if (m.causeNumbers.some((c) => {
      const n = normalizeCauseNumber(c);
      return n.length >= MIN_CAUSE_CHARS && normText.includes(n);
    })) add(m, "cause_number");
    if (m.partyNames.some((n) => containsFullName(text, n))) add(m, "name");
  }
  return [...byMatter.values()];
}

const RANK: Record<EmailSignal, number> = { thread: 0, address: 1, cause_number: 2, name: 3 };

function sorted(cands: Candidate[]): Candidate[] {
  return cands
    .map((c) => ({ ...c, signals: [...c.signals].sort((a, b) => RANK[a] - RANK[b]) }))
    .sort((a, b) => b.signals.length - a.signals.length || RANK[a.signals[0]!] - RANK[b.signals[0]!] || a.matterId.localeCompare(b.matterId));
}

/** The filing decision for one message. Pure. */
export function decideFiling(msg: EmailMessageMeta, ctx: MatchContext): FilingDecision {
  if (isExcluded(msg.from, ctx.excludedSenders)) return { action: "excluded", reason: "Sender is on an exclusion list." };

  const all = collectCandidates(msg, ctx);
  if (all.length === 0) return { action: "no_match" };

  // Screens first (rule 5): nothing from this mailbox lands on a screened
  // matter, and the admin item carries ids only, no content preview.
  const screened = all.filter((c) => ctx.screenedMatterIds.has(c.matterId));
  const visible = all.filter((c) => !ctx.screenedMatterIds.has(c.matterId));
  if (screened.length > 0 && visible.length === 0) {
    return { action: "screened_admin_queue", matterIds: screened.map((c) => c.matterId).sort() };
  }
  const cands = sorted(visible);

  const withSignal = (s: EmailSignal) => cands.filter((c) => c.signals.includes(s));
  const auto = (c: Candidate): FilingDecision =>
    c.open ? { action: "auto_file", matterId: c.matterId, signals: c.signals } : { action: "suggest", candidates: [c], reason: "Matches a closed matter; closed matters are never filed to automatically." };

  if (screened.length === 0) {
    const thread = withSignal("thread");
    if (thread.length === 1) return auto(thread[0]!);

    const address = withSignal("address");
    const openAddress = address.filter((c) => c.open);
    if (openAddress.length === 1 && address.length === 1) return auto(openAddress[0]!);

    const cause = withSignal("cause_number");
    if (cause.length === 1 && cause[0]!.signals.length >= 2) return auto(cause[0]!);
  }

  let reason: string;
  if (screened.length > 0) reason = "Also matches a matter the mailbox owner is screened from; a person must decide.";
  else if (cands.length > 1) reason = "Matches more than one matter.";
  else if (!cands[0]!.open) reason = "Matches a closed matter; closed matters are never filed to automatically.";
  else reason = "Only weaker signals match (name, or a cause number with nothing else agreeing).";
  return { action: "suggest", candidates: cands, reason };
}

/** Rule 2: unmatched message metadata is discarded after the firm's window (default 7 days, real clock). */
export const DEFAULT_UNMATCHED_RETENTION_DAYS = 7;

export function unmatchedPurgeAt(receivedAt: Date, windowDays = DEFAULT_UNMATCHED_RETENTION_DAYS): Date {
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 90) throw new RangeError("windowDays must be a whole number from 0 to 90.");
  return new Date(receivedAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
}

/**
 * Rule 7 / open question 1: whether an auto-filed inbound client email should
 * start the firm's reply clock. Only inbound mail from a client address, and
 * only when the firm setting is on.
 */
export function startsReplyClock(
  decision: FilingDecision,
  msg: EmailMessageMeta,
  clientAddresses: readonly string[],
  firmSettingOn: boolean
): boolean {
  if (!firmSettingOn || decision.action !== "auto_file") return false;
  const from = normalizeAddress(msg.from);
  return clientAddresses.map(normalizeAddress).includes(from);
}
