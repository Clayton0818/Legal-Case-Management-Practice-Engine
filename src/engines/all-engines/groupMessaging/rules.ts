// c124 — when a matter's group thread is open, and who it reaches. Pure.
//
// A group thread is available only when ALL of these hold:
//  1. a lawyer has marked the matter as a joint representation (active);
//  2. the matter has at least two current clients;
//  3. no current client is marked adverse on the matter;
//  4. every current client has an active consent to information being
//     shared with the other clients.
// Recipients are exactly the current, consenting clients. Opposing parties,
// opposing counsel and anyone else on the matter can never be recipients,
// because only parties holding the 'client' role are considered at all.

export interface ClientOnMatter {
  partyId: string;
  fullName: string;
  /** matter_parties.is_adverse */
  isAdverse: boolean | null;
}

export interface ConsentFact {
  partyId: string;
  withdrawnAt: Date | null;
}

export interface GroupFacts {
  jointActive: boolean;
  clients: readonly ClientOnMatter[];
  consents: readonly ConsentFact[];
}

export interface GroupState {
  available: boolean;
  /** Why it isn't available yet, in plain words (empty when available). */
  reasons: string[];
  /** Party ids a group message would go to (empty when not available). */
  recipients: string[];
  /** Current clients without an active consent. */
  awaitingConsent: string[];
}

export function deriveGroupState(f: GroupFacts): GroupState {
  const reasons: string[] = [];
  const consenting = new Set(f.consents.filter((c) => c.withdrawnAt === null).map((c) => c.partyId));
  const awaitingConsent = f.clients.filter((c) => !consenting.has(c.partyId)).map((c) => c.partyId);
  if (!f.jointActive) reasons.push("A lawyer hasn't marked this matter as a joint representation.");
  if (f.clients.length < 2) reasons.push("Group messages need at least two clients on the matter.");
  if (f.clients.some((c) => c.isAdverse)) reasons.push("A client on this matter is marked adverse, so group messages are off.");
  if (awaitingConsent.length > 0) {
    reasons.push(`Waiting for consent to share information from ${awaitingConsent.length} client${awaitingConsent.length === 1 ? "" : "s"}.`);
  }
  const available = reasons.length === 0;
  return { available, reasons, recipients: available ? f.clients.map((c) => c.partyId) : [], awaitingConsent };
}

export const MAX_MESSAGE_LENGTH = 5000;

/** Trim and bound a message body. Returns the clean body or an error. Pure. */
export function checkMessageBody(raw: string): { ok: true; body: string } | { ok: false; error: string } {
  const body = raw.replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "Write a message first." };
  if (body.length > MAX_MESSAGE_LENGTH) return { ok: false, error: `Keep messages under ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters.` };
  return { ok: true, body };
}

/** Firm roles allowed to mark or end a joint representation: a lawyer's decision. */
export const JOINT_REPRESENTATION_ROLES: readonly string[] = ["lawyer", "conflicts_attorney"];

export function canDecideJointRepresentation(roles: readonly string[]): boolean {
  return roles.some((r) => JOINT_REPRESENTATION_ROLES.includes(r));
}
