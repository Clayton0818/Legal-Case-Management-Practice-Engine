// Client portal (c11, c112) — database side. Every function takes a
// TenantTx, i.e. runs inside withTenant(firmId), so RLS confines it to one
// firm, and every client read is filtered to the signed-in party.
//
// No new tables: sign-in links, rate-limit counters and "signed out
// everywhere" markers are rows in the append-only `audit_events` table:
//
//   entity_type                 entity_id                         action(s)
//   portal_sign_in_token        uuid(SHA-256(token))              portal.sign_in_link.issued / .used
//   portal_sign_in_address      uuid(HMAC(secret, email))         portal.sign_in.requested
//   portal_sign_in_ip           uuid(HMAC(secret, ip))            portal.sign_in.requested
//   party                       party id                          portal.sessions.revoked
//
// The token itself, the email address and the IP are never stored.
// Single use is enforced under a transaction-scoped advisory lock on the
// token id, so two simultaneous clicks cannot both sign in.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { matters, parties } from "@/db/schema";
import { auditEvents } from "@/db/tables/foundation";
import { audit } from "@/core/audit";
import { resolveClientAddress } from "@/core/contacts";
import { getFirmSettings } from "@/core/firmSettings";
import { listInAppForParty } from "@/core/notify";
import { listClientTasks } from "@/core/tasks";
import { isApproved, legalCopyStatus } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import type { TenantTx } from "@/tenancy/withTenant";
import { generateSignInToken, tokenEntityId } from "./crypto";
import { PORTAL_COPY_GATES } from "./gates";
import {
  decideLinkDelivery,
  decideTokenUse,
  planRateLimit,
  PORTAL_STAGES,
  RATE_WINDOW_MS,
  SIGN_IN_TOKEN_TTL_MINUTES,
  SIGN_IN_TOKEN_TTL_MS,
  splitSubject,
  toPortalTodo,
  toPortalUpdate,
  type PortalMatter,
  type PortalTodo,
  type PortalUpdate,
  type TokenUse,
} from "./policy";
import type { PortalSession } from "./session";

export const PORTAL_ENGINE = "all-engines";

const ENTITY = {
  token: "portal_sign_in_token",
  address: "portal_sign_in_address",
  ip: "portal_sign_in_ip",
  party: "party",
} as const;

export const PORTAL_AUDIT_ACTIONS = {
  requested: "portal.sign_in.requested",
  rateLimited: "portal.sign_in.rate_limited",
  notIssued: "portal.sign_in.not_issued",
  issued: "portal.sign_in_link.issued",
  used: "portal.sign_in_link.used",
  rejected: "portal.sign_in_link.rejected",
  emailed: "portal.sign_in_link.emailed",
  emailFailed: "portal.sign_in_link.email_failed",
  revoked: "portal.sessions.revoked",
} as const;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function eligiblePartyIds(tx: TenantTx, tenantId: string) {
  return tx
    .select({ id: matters.primaryPartyId })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), inArray(matters.stage, [...PORTAL_STAGES])));
}

/** True while the party is the client on at least one open (retained) matter. */
export async function isPortalEligible(tx: TenantTx, tenantId: string, partyId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: matters.id })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.primaryPartyId, partyId), inArray(matters.stage, [...PORTAL_STAGES])))
    .limit(1);
  return Boolean(row);
}

/** Eligible clients with this address anywhere on their record (resolveClientAddress then decides which one, if any, may be used). */
async function findCandidates(tx: TenantTx, tenantId: string, email: string) {
  return tx
    .select({
      id: parties.id,
      email: parties.email,
      emails: parties.emails,
      phone: parties.phone,
      phones: parties.phones,
      safeContact: parties.safeContact,
      dvSensitive: parties.dvSensitive,
    })
    .from(parties)
    .where(
      and(
        eq(parties.tenantId, tenantId),
        inArray(parties.id, eligiblePartyIds(tx, tenantId)),
        sql`(lower(trim(${parties.email})) = ${email}
          or lower(trim(${parties.safeContact} ->> 'safeEmail')) = ${email}
          or exists (select 1 from unnest(${parties.emails}) as e(addr) where lower(trim(e.addr)) = ${email}))`
      )
    )
    .limit(5);
}

// ---------------------------------------------------------------------------
// Sign-in requests
// ---------------------------------------------------------------------------

async function countRequests(tx: TenantTx, tenantId: string, entityType: string, entityId: string, since: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.entityType, entityType),
        eq(auditEvents.entityId, entityId),
        eq(auditEvents.action, PORTAL_AUDIT_ACTIONS.requested),
        gte(auditEvents.occurredAt, since)
      )
    );
  return row?.n ?? 0;
}

export type SignInOutcome =
  | { kind: "neutral" }
  | { kind: "screen"; token: string }
  | { kind: "email"; token: string; partyId: string; to: string; subject: string; text: string; fromName: string; fromAddress: string | null; replyTo: string | null };

/**
 * Handle one "email me a sign-in link" request. Whatever happens, the caller
 * shows the same neutral confirmation (no account enumeration); only the
 * returned outcome tells the route whether to email or (dev/demo) show a link.
 */
export async function requestSignInLink(
  tx: TenantTx,
  input: {
    tenantId: string;
    firmName: string;
    email: string;
    addressId: string;
    ipId: string;
    now: Date;
    showOnScreenAllowed: boolean;
    providerReady: boolean;
    /** Builds the absolute link for the email; null when PORTAL_BASE_URL is not configured. */
    linkFor: ((token: string) => string) | null;
  }
): Promise<SignInOutcome> {
  const { tenantId, now } = input;
  const since = new Date(now.getTime() - RATE_WINDOW_MS);
  const addressCount = await countRequests(tx, tenantId, ENTITY.address, input.addressId, since);
  const ipCount = await countRequests(tx, tenantId, ENTITY.ip, input.ipId, since);
  for (const [entityType, entityId] of [
    [ENTITY.address, input.addressId],
    [ENTITY.ip, input.ipId],
  ] as const) {
    await audit(tx, { tenantId, engine: PORTAL_ENGINE, action: PORTAL_AUDIT_ACTIONS.requested, entityType, entityId, occurredAt: now });
  }

  const limit = planRateLimit({ addressCount, ipCount });
  if (!limit.allowed) {
    await audit(tx, {
      tenantId,
      engine: PORTAL_ENGINE,
      action: PORTAL_AUDIT_ACTIONS.rateLimited,
      entityType: ENTITY.address,
      entityId: input.addressId,
      reason: limit.reason,
      occurredAt: now,
    });
    return { kind: "neutral" };
  }

  const copyApproved = legalCopyStatus(PORTAL_COPY_GATES.signInEmail.key).approved;
  const vendorEmailApproved = isApproved(VENDOR_GATES.email.key);
  const candidates = await findCandidates(tx, tenantId, input.email);
  const matches = candidates
    .map((c) => ({
      partyId: c.id,
      delivery: decideLinkDelivery({
        enteredEmail: input.email,
        resolved: resolveClientAddress(c, "email"),
        showOnScreenAllowed: input.showOnScreenAllowed,
        vendorEmailApproved,
        copyApproved,
        providerReady: input.providerReady,
        baseUrlReady: input.linkFor !== null,
      }),
    }))
    .filter((m) => m.delivery.kind !== "none");

  const match = matches[0];
  if (!match || matches.length > 1) {
    await audit(tx, {
      tenantId,
      engine: PORTAL_ENGINE,
      action: PORTAL_AUDIT_ACTIONS.notIssued,
      entityType: ENTITY.address,
      entityId: input.addressId,
      reason: matches.length > 1 ? "More than one client record resolves to this address." : "No open client resolves to this address.",
      occurredAt: now,
    });
    return { kind: "neutral" };
  }
  if (match.delivery.kind === "held" || match.delivery.kind === "none") {
    await audit(tx, {
      tenantId,
      engine: PORTAL_ENGINE,
      action: PORTAL_AUDIT_ACTIONS.notIssued,
      entityType: ENTITY.party,
      entityId: match.partyId,
      reason: match.delivery.reason,
      occurredAt: now,
    });
    return { kind: "neutral" };
  }

  const token = generateSignInToken();
  const expiresAt = new Date(now.getTime() + SIGN_IN_TOKEN_TTL_MS);
  await audit(tx, {
    tenantId,
    engine: PORTAL_ENGINE,
    action: PORTAL_AUDIT_ACTIONS.issued,
    entityType: ENTITY.token,
    entityId: tokenEntityId(token),
    payload: { partyId: match.partyId, expiresAt: expiresAt.toISOString(), delivery: match.delivery.kind },
    occurredAt: now,
  });

  if (match.delivery.kind === "screen") return { kind: "screen", token };
  if (!input.linkFor) return { kind: "neutral" }; // unreachable: decideLinkDelivery holds without a base URL

  const settings = await getFirmSettings(tx, tenantId);
  const copy = legalCopyStatus(PORTAL_COPY_GATES.signInEmail.key, {
    link: input.linkFor(token),
    minutes: SIGN_IN_TOKEN_TTL_MINUTES,
  });
  const { subject, body } = splitSubject(copy.text, "Your secure sign-in link");
  return {
    kind: "email",
    token,
    partyId: match.partyId,
    to: match.delivery.to,
    subject,
    text: body,
    fromName: settings.emailFromName ?? input.firmName,
    fromAddress: settings.emailFromAddress,
    replyTo: settings.emailReplyTo,
  };
}

/** Record what the email provider did with a sign-in email (never the link). */
export async function recordSignInEmail(
  tx: TenantTx,
  tenantId: string,
  partyId: string,
  result: { outcome: string; detail?: string | null },
  now: Date
): Promise<void> {
  await audit(tx, {
    tenantId,
    engine: PORTAL_ENGINE,
    action: result.outcome === "sent" ? PORTAL_AUDIT_ACTIONS.emailed : PORTAL_AUDIT_ACTIONS.emailFailed,
    entityType: ENTITY.party,
    entityId: partyId,
    payload: { outcome: result.outcome, detail: result.detail ?? null },
    occurredAt: now,
  });
}

// ---------------------------------------------------------------------------
// Using a link
// ---------------------------------------------------------------------------

/** Exchange a sign-in token for the party it was issued to — once, within 15 minutes, while still a client. */
export async function consumeSignInLink(tx: TenantTx, tenantId: string, token: string, now: Date): Promise<TokenUse> {
  const id = tokenEntityId(token);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);

  const rows = await tx
    .select({ action: auditEvents.action, payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.entityType, ENTITY.token),
        eq(auditEvents.entityId, id),
        inArray(auditEvents.action, [PORTAL_AUDIT_ACTIONS.issued, PORTAL_AUDIT_ACTIONS.used])
      )
    );
  const issued = rows.find((r) => r.action === PORTAL_AUDIT_ACTIONS.issued);
  let use = decideTokenUse({
    issued: issued ? { partyId: issued.payload.partyId, expiresAt: issued.payload.expiresAt } : null,
    alreadyUsed: rows.some((r) => r.action === PORTAL_AUDIT_ACTIONS.used),
    now,
  });
  if (use.ok && !(await isPortalEligible(tx, tenantId, use.partyId))) use = { ok: false, reason: "unknown" };

  if (!use.ok) {
    if (issued) {
      await audit(tx, {
        tenantId,
        engine: PORTAL_ENGINE,
        action: PORTAL_AUDIT_ACTIONS.rejected,
        entityType: ENTITY.token,
        entityId: id,
        reason: use.reason,
        occurredAt: now,
      });
    }
    return use;
  }
  await audit(tx, {
    tenantId,
    engine: PORTAL_ENGINE,
    action: PORTAL_AUDIT_ACTIONS.used,
    entityType: ENTITY.token,
    entityId: id,
    actor: { type: "client", partyId: use.partyId },
    occurredAt: now,
  });
  return use;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** "Sign out everywhere": every session issued up to now stops working. */
export async function revokeSessions(tx: TenantTx, tenantId: string, partyId: string, now: Date, via: "sign_out" | "quick_exit"): Promise<void> {
  await audit(tx, {
    tenantId,
    engine: PORTAL_ENGINE,
    action: PORTAL_AUDIT_ACTIONS.revoked,
    entityType: ENTITY.party,
    entityId: partyId,
    actor: { type: "client", partyId },
    payload: { via },
    occurredAt: now,
  });
}

/** A session is live only if it is newer than the last sign-out and the party is still a client. */
export async function isSessionLive(tx: TenantTx, session: PortalSession): Promise<boolean> {
  const [last] = await tx
    .select({ at: auditEvents.occurredAt })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, session.tenantId),
        eq(auditEvents.entityType, ENTITY.party),
        eq(auditEvents.entityId, session.partyId),
        eq(auditEvents.action, PORTAL_AUDIT_ACTIONS.revoked)
      )
    )
    .orderBy(desc(auditEvents.occurredAt))
    .limit(1);
  if (last && last.at.getTime() >= session.issuedAt) return false;
  return isPortalEligible(tx, session.tenantId, session.partyId);
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

export interface PortalHome {
  timeZone: string;
  matters: PortalMatter[];
  updates: PortalUpdate[];
  todos: PortalTodo[];
}

/** Everything the dashboard shows, already reduced to client-visible fields. */
export async function loadPortalHome(
  tx: TenantTx,
  session: PortalSession,
  ctx: { firmName: string; portalUrl: string | null }
): Promise<PortalHome> {
  const { tenantId, partyId } = session;
  const settings = await getFirmSettings(tx, tenantId);
  const matterRows = await tx
    .select({ id: matters.id, openedAt: matters.openedAt })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.primaryPartyId, partyId), inArray(matters.stage, [...PORTAL_STAGES])))
    .orderBy(desc(matters.openedAt));
  const updates = await listInAppForParty(tx, tenantId, partyId, ctx, { limit: 30 });
  const todos = await listClientTasks(tx, tenantId, partyId);
  return {
    timeZone: settings.timeZone,
    matters: matterRows.map((m) => ({ id: m.id, openedAt: m.openedAt })),
    updates: updates.map(toPortalUpdate),
    todos: todos.map(toPortalTodo),
  };
}
