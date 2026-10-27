import { describe, it, expect, beforeEach } from "vitest";
import { classifyPath, decideMiddleware, CLIENT_PORTAL_HEADERS } from "@/auth/middlewarePolicy";
import type { AuthConfig } from "@/auth/config";
import { isPlaceholder, legalCopy, resetApprovalStateForTests, setBlockedActionSink } from "@/compliance/approvals";
import { generateSignInToken, isWellFormedToken, keyedEntityId, normalizeEmail, sha256Hex, tokenEntityId } from "./crypto";
import { PORTAL_COPY_GATES, PORTAL_GATE_KEYS } from "./gates";
import {
  absolutePortalUrl,
  clientIp,
  decideLinkDelivery,
  decideTokenUse,
  isSameOriginPost,
  isValidSlug,
  linkOnScreenAllowed,
  MAX_REQUESTS_PER_ADDRESS,
  MAX_REQUESTS_PER_IP,
  planRateLimit,
  portalUrlForFirm,
  splitSubject,
  toPortalDocumentRequests,
  toPortalTodo,
  toPortalUpdate,
} from "./policy";
import {
  ABSOLUTE_TIMEOUT_MS,
  decodeSession,
  encodeSession,
  IDLE_TIMEOUT_MS,
  PORTAL_COOKIE,
  readPortalSecret,
  sessionCookieOptions,
  touchSession,
  type PortalSession,
} from "./session";

const SECRET = "s".repeat(48);
const TENANT = "11111111-1111-4111-8111-111111111111";
const PARTY = "22222222-2222-4222-8222-222222222222";
const T0 = Date.UTC(2026, 9, 27, 15, 0, 0);

function session(over: Partial<PortalSession> = {}): PortalSession {
  return { tenantId: TENANT, partyId: PARTY, issuedAt: T0, lastSeenAt: T0, ...over };
}

beforeEach(() => {
  resetApprovalStateForTests();
  setBlockedActionSink(() => {});
});

describe("sign-in tokens", () => {
  it("are 32 random bytes, URL-safe, and never repeat", () => {
    const a = generateSignInToken();
    const b = generateSignInToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(isWellFormedToken(a)).toBe(true);
    expect(isWellFormedToken(`${a}x`)).toBe(false);
    expect(isWellFormedToken("../etc/passwd")).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
  });

  it("are stored only as a hash-derived id, never in the clear", () => {
    const t = generateSignInToken();
    const id = tokenEntityId(t);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id.replace(/-/g, "")).toBe(sha256Hex(t).slice(0, 32));
    expect(id).not.toContain(t);
    expect(tokenEntityId(t)).toBe(id);
    expect(tokenEntityId(generateSignInToken())).not.toBe(id);
  });

  it("work once, and only for 15 minutes", () => {
    const issued = { partyId: PARTY, expiresAt: new Date(T0 + 15 * 60_000).toISOString() };
    expect(decideTokenUse({ issued, alreadyUsed: false, now: new Date(T0 + 60_000) })).toEqual({ ok: true, partyId: PARTY });
    expect(decideTokenUse({ issued, alreadyUsed: true, now: new Date(T0 + 60_000) })).toEqual({ ok: false, reason: "used" });
    expect(decideTokenUse({ issued, alreadyUsed: false, now: new Date(T0 + 15 * 60_000) })).toEqual({ ok: false, reason: "expired" });
    expect(decideTokenUse({ issued: null, alreadyUsed: false, now: new Date(T0) })).toEqual({ ok: false, reason: "unknown" });
    expect(decideTokenUse({ issued: { partyId: 7, expiresAt: "x" }, alreadyUsed: false, now: new Date(T0) })).toEqual({ ok: false, reason: "unknown" });
  });

  it("rate-limit ids are keyed hashes: stable, secret-dependent, and not the address", () => {
    const a = keyedEntityId(SECRET, "address", "client@example.com");
    expect(keyedEntityId(SECRET, "address", "client@example.com")).toBe(a);
    expect(keyedEntityId("t".repeat(48), "address", "client@example.com")).not.toBe(a);
    expect(keyedEntityId(SECRET, "ip", "client@example.com")).not.toBe(a);
    expect(a).not.toContain("client");
  });
});

describe("client session cookie", () => {
  it("fails closed without a long enough CLIENT_SESSION_SECRET", () => {
    expect(readPortalSecret({}).ok).toBe(false);
    expect(readPortalSecret({ CLIENT_SESSION_SECRET: "short" }).ok).toBe(false);
    expect(readPortalSecret({ CLIENT_SESSION_SECRET: SECRET })).toEqual({ ok: true, secret: SECRET });
  });

  it("round-trips a signed session", () => {
    const value = encodeSession(session(), SECRET);
    expect(decodeSession(value, SECRET, T0 + 1000)).toEqual({ ok: true, session: session() });
  });

  it("rejects tampering, a different secret, and garbage", () => {
    const value = encodeSession(session(), SECRET);
    const [payload, sig] = value.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ v: 1, t: TENANT, p: "33333333-3333-4333-8333-333333333333", iat: T0, seen: T0 }),
      "utf8"
    ).toString("base64url");
    expect(decodeSession(`${forged}.${sig}`, SECRET, T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(decodeSession(`${payload}.${sig.slice(0, -2)}xx`, SECRET, T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(decodeSession(value, "x".repeat(48), T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(decodeSession("nonsense", SECRET, T0)).toEqual({ ok: false, reason: "malformed" });
    expect(decodeSession(undefined, SECRET, T0)).toEqual({ ok: false, reason: "missing" });
  });

  it("expires after 30 minutes idle and 8 hours absolute, and a touch never extends the 8 hours", () => {
    const value = encodeSession(session(), SECRET);
    expect(decodeSession(value, SECRET, T0 + IDLE_TIMEOUT_MS - 1).ok).toBe(true);
    expect(decodeSession(value, SECRET, T0 + IDLE_TIMEOUT_MS)).toEqual({ ok: false, reason: "idle" });

    const active = touchSession(session(), T0 + ABSOLUTE_TIMEOUT_MS - 60_000);
    expect(active.issuedAt).toBe(T0);
    const v2 = encodeSession(active, SECRET);
    expect(decodeSession(v2, SECRET, T0 + ABSOLUTE_TIMEOUT_MS - 1).ok).toBe(true);
    expect(decodeSession(v2, SECRET, T0 + ABSOLUTE_TIMEOUT_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("is an httpOnly, Secure, SameSite=Lax __Host- cookie that the browser drops at the first limit", () => {
    expect(PORTAL_COOKIE.startsWith("__Host-")).toBe(true);
    expect(sessionCookieOptions(session(), T0)).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: IDLE_TIMEOUT_MS / 1000 });
    const late = session({ lastSeenAt: T0 + ABSOLUTE_TIMEOUT_MS - 10 * 60_000 });
    expect(sessionCookieOptions(late, late.lastSeenAt).maxAge).toBe(600);
  });
});

describe("sign-in requests", () => {
  const base = {
    enteredEmail: "client@example.com",
    resolved: { deliver: true as const, address: "Client@Example.com " },
    showOnScreenAllowed: false,
    vendorEmailApproved: true,
    copyApproved: true,
    providerReady: true,
    baseUrlReady: true,
  };

  it("emails only the client's resolved (safe) address", () => {
    expect(decideLinkDelivery(base)).toEqual({ kind: "email", to: "Client@Example.com" });
    // The ordinary address of a client whose safe address is different gets nothing.
    expect(decideLinkDelivery({ ...base, resolved: { deliver: true, address: "safe@example.org" } }).kind).toBe("none");
    // DV-sensitive client with no safe email: in-app only, never a link.
    expect(
      decideLinkDelivery({ ...base, resolved: { deliver: false, reason: "DV-sensitive client has no safe email on file; in-app only." } }).kind
    ).toBe("none");
  });

  it("holds (issues nothing) until the vendor gate, wording, provider and base URL are all ready", () => {
    expect(decideLinkDelivery({ ...base, vendorEmailApproved: false })).toMatchObject({ kind: "held" });
    expect(decideLinkDelivery({ ...base, copyApproved: false })).toMatchObject({ kind: "held" });
    expect(decideLinkDelivery({ ...base, providerReady: false })).toMatchObject({ kind: "held" });
    expect(decideLinkDelivery({ ...base, baseUrlReady: false })).toMatchObject({ kind: "held" });
  });

  it("shows the link on screen only in dev mode for a non-production firm — never with real auth", () => {
    expect(linkOnScreenAllowed("dev", false)).toBe(true);
    expect(linkOnScreenAllowed("dev", true)).toBe(false);
    expect(linkOnScreenAllowed("clerk", false)).toBe(false);
    expect(linkOnScreenAllowed("none", false)).toBe(false);
    expect(decideLinkDelivery({ ...base, showOnScreenAllowed: true, vendorEmailApproved: false })).toEqual({ kind: "screen" });
    // ...and even then, only for the client's own resolved address.
    expect(decideLinkDelivery({ ...base, showOnScreenAllowed: true, enteredEmail: "other@example.com" }).kind).toBe("none");
  });

  it("rate-limits per address and per IP", () => {
    expect(planRateLimit({ addressCount: 0, ipCount: 0 }).allowed).toBe(true);
    expect(planRateLimit({ addressCount: MAX_REQUESTS_PER_ADDRESS - 1, ipCount: MAX_REQUESTS_PER_IP - 1 }).allowed).toBe(true);
    expect(planRateLimit({ addressCount: MAX_REQUESTS_PER_ADDRESS, ipCount: 0 }).allowed).toBe(false);
    expect(planRateLimit({ addressCount: 0, ipCount: MAX_REQUESTS_PER_IP }).allowed).toBe(false);
  });

  it("normalises addresses and IPs", () => {
    expect(normalizeEmail("  Client@Example.COM ")).toBe("client@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(clientIp("203.0.113.9, 10.0.0.1", null)).toBe("203.0.113.9");
    expect(clientIp(null, "198.51.100.2")).toBe("198.51.100.2");
    expect(clientIp(null, null)).toBe("unknown");
  });
});

describe("links and requests", () => {
  it("builds absolute links only from the configured base URL", () => {
    expect(portalUrlForFirm("https://app.example.com/", "smith-law")).toBe("https://app.example.com/portal/smith-law");
    expect(portalUrlForFirm(undefined, "smith-law")).toBeNull();
    expect(absolutePortalUrl("javascript:alert(1)", "/portal")).toBeNull();
    expect(absolutePortalUrl("https://evil.example/x?", "/portal")).toBeNull();
  });

  it("accepts only same-origin cookie-authenticated POSTs and plain slugs", () => {
    expect(isSameOriginPost("https://app.example.com", "app.example.com")).toBe(true);
    expect(isSameOriginPost("https://evil.example", "app.example.com")).toBe(false);
    expect(isSameOriginPost("null", "app.example.com")).toBe(false);
    expect(isValidSlug("smith-law")).toBe(true);
    expect(isValidSlug("../admin")).toBe(false);
    expect(isValidSlug("Smith")).toBe(false);
  });

  it("splits a Subject line off approved email copy", () => {
    expect(splitSubject("Subject: Hi\n\nBody", "F")).toEqual({ subject: "Hi", body: "Body" });
    expect(splitSubject("No subject", "F")).toEqual({ subject: "F", body: "No subject" });
  });
});

describe("what the client sees", () => {
  it("drops every internal field from updates, to-dos and document requests", () => {
    const update = toPortalUpdate({
      id: "u1",
      createdAt: new Date(T0),
      readAt: null,
      message: "Hello",
      ...({ matterId: "m1", links: { flagId: "f" }, recipientAddress: "x@y.z", lastError: "boom" } as object),
    } as Parameters<typeof toPortalUpdate>[0]);
    expect(Object.keys(update).sort()).toEqual(["createdAt", "id", "message", "read"]);

    const todo = toPortalTodo({
      id: "t1",
      title: "Sign the form",
      description: null,
      dueAt: new Date(T0),
      overdue: true,
      ...({ kind: "internal.kind", matterId: "m1", ownerUserId: "u", deadlineCritical: true } as object),
    } as Parameters<typeof toPortalTodo>[0]);
    expect(Object.keys(todo).sort()).toEqual(["description", "dueAt", "id", "pastDue", "title"]);

    const docs = toPortalDocumentRequests([
      { id: "d1", label: "Pay stubs", description: "", status: "requested", ...({ aiCheckDetail: { reasons: ["x"] }, notApplicableReason: null } as object) },
      { id: "d2", label: "Old lease", description: "", status: "not_applicable" },
    ]);
    expect(docs).toEqual([{ id: "d1", label: "Pay stubs", description: "", statusLabel: "Requested" }]);
  });

  it("has attorney-gated wording that shows a placeholder until approved, and no firm/matter details in the email draft", () => {
    expect(new Set(PORTAL_GATE_KEYS).size).toBe(PORTAL_GATE_KEYS.length);
    for (const key of PORTAL_GATE_KEYS) expect(isPlaceholder(legalCopy(key, { minutes: 15, link: "L" }))).toBe(true);
    for (const gate of Object.values(PORTAL_COPY_GATES)) expect(gate.reviewers).toEqual(["attorney"]);
    expect(PORTAL_COPY_GATES.signInEmail.draft).not.toMatch(/firmName|matter|case|court/i);
  });
});

describe("middleware", () => {
  const dev: AuthConfig = { mode: "dev", insecure: false, reason: "" };
  const clerk: AuthConfig = { mode: "clerk", insecure: false, reason: "" };

  it("classifies the client portal separately from staff and public paths", () => {
    expect(classifyPath("/portal")).toBe("client_portal");
    expect(classifyPath("/portal/smith-law/sign-in")).toBe("client_portal");
    expect(classifyPath("/api/portal/sign-in")).toBe("client_portal");
    expect(classifyPath("/portals")).toBe("public");
    expect(classifyPath("/admin/portal")).toBe("staff_page");
  });

  it("lets clients through without staff auth, with no-store / no-frame / no-referrer headers", () => {
    for (const config of [dev, clerk]) {
      const d = decideMiddleware({ pathname: "/portal/smith-law", config, hasCredential: false });
      expect(d.action).toBe("next");
      expect(d.headers).toMatchObject(CLIENT_PORTAL_HEADERS);
    }
    expect(CLIENT_PORTAL_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(CLIENT_PORTAL_HEADERS["cache-control"]).toBe("no-store");
  });
});
