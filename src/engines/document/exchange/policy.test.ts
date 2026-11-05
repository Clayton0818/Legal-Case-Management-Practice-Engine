import { describe, it, expect } from "vitest";
import {
  decideShareAccess,
  MAX_SHARE_LINK_DAYS,
  requiresPrivilegedOverride,
  statusForShareDenial,
  validateCreateShareLinkInput,
} from "./policy";

const NOW = new Date("2026-01-01T00:00:00Z");
const DAY = 86_400_000;

describe("requiresPrivilegedOverride (c89)", () => {
  it("requires an override for any privileged/work-product/sealed document, regardless of recipient", () => {
    for (const tag of ["privileged", "work_product", "sealed"]) {
      expect(requiresPrivilegedOverride({ privilegeTag: tag, clientVisible: true }, "opposing_counsel")).toBe(true);
      expect(requiresPrivilegedOverride({ privilegeTag: tag, clientVisible: false }, "expert")).toBe(true);
    }
  });

  it("requires an override to send a non-clientVisible document to a client, even when the tag is 'none'", () => {
    expect(requiresPrivilegedOverride({ privilegeTag: "none", clientVisible: false }, "client")).toBe(true);
  });

  it("never requires an override for a clientVisible, safely-tagged document going to the client", () => {
    expect(requiresPrivilegedOverride({ privilegeTag: "none", clientVisible: true }, "client")).toBe(false);
    expect(requiresPrivilegedOverride({ privilegeTag: "confidential", clientVisible: true }, "client")).toBe(false);
  });

  it("never requires an override for a safely-tagged document going to opposing counsel or an expert", () => {
    expect(requiresPrivilegedOverride({ privilegeTag: "none", clientVisible: false }, "opposing_counsel")).toBe(false);
    expect(requiresPrivilegedOverride({ privilegeTag: "confidential", clientVisible: false }, "expert")).toBe(false);
    expect(requiresPrivilegedOverride({ privilegeTag: "none", clientVisible: false }, "other")).toBe(false);
  });
});

describe("validateCreateShareLinkInput (c89)", () => {
  const future = new Date(NOW.getTime() + DAY).toISOString();

  it("accepts a well-formed request that needs no override", () => {
    const result = validateCreateShareLinkInput({ recipientType: "opposing_counsel", recipientLabel: "Jane Roe, Esq.", expiresAt: future, maxDownloads: 3 }, false, NOW);
    expect(result).toMatchObject({ ok: true, maxDownloads: 3, recipientLabel: "Jane Roe, Esq." });
  });

  it("rejects an unknown recipientType", () => {
    const result = validateCreateShareLinkInput({ recipientType: "friend", expiresAt: future }, false, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects an expiresAt in the past or right now", () => {
    expect(validateCreateShareLinkInput({ recipientType: "expert", expiresAt: NOW.toISOString() }, false, NOW).ok).toBe(false);
    expect(validateCreateShareLinkInput({ recipientType: "expert", expiresAt: new Date(NOW.getTime() - DAY).toISOString() }, false, NOW).ok).toBe(false);
  });

  it(`rejects an expiresAt more than ${MAX_SHARE_LINK_DAYS} days out`, () => {
    const tooFar = new Date(NOW.getTime() + (MAX_SHARE_LINK_DAYS + 1) * DAY).toISOString();
    expect(validateCreateShareLinkInput({ recipientType: "expert", expiresAt: tooFar }, false, NOW).ok).toBe(false);
  });

  it("rejects a maxDownloads of 0 or a non-integer", () => {
    expect(validateCreateShareLinkInput({ recipientType: "expert", expiresAt: future, maxDownloads: 0 }, false, NOW).ok).toBe(false);
    expect(validateCreateShareLinkInput({ recipientType: "expert", expiresAt: future, maxDownloads: 1.5 }, false, NOW).ok).toBe(false);
  });

  it("when an override is needed, rejects it without BOTH confirmSharePrivileged and a non-empty reason", () => {
    expect(validateCreateShareLinkInput({ recipientType: "client", expiresAt: future }, true, NOW).ok).toBe(false);
    expect(validateCreateShareLinkInput({ recipientType: "client", expiresAt: future, confirmSharePrivileged: true }, true, NOW).ok).toBe(false);
    expect(validateCreateShareLinkInput({ recipientType: "client", expiresAt: future, privilegedOverrideReason: "  " }, true, NOW).ok).toBe(false);
    expect(
      validateCreateShareLinkInput({ recipientType: "client", expiresAt: future, confirmSharePrivileged: true, privilegedOverrideReason: "Court ordered disclosure." }, true, NOW).ok
    ).toBe(true);
  });
});

describe("decideShareAccess (c89)", () => {
  const base = { expiresAt: new Date(NOW.getTime() + DAY), revokedAt: null, maxDownloads: null as number | null, downloadCount: 0 };

  it("allows view and download when live, unexpired and under any download limit", () => {
    expect(decideShareAccess(base, "view", NOW)).toEqual({ allowed: true });
    expect(decideShareAccess(base, "download", NOW)).toEqual({ allowed: true });
  });

  it("denies as 'revoked' once revokedAt is set, even before expiry", () => {
    const link = { ...base, revokedAt: new Date(NOW.getTime() - 1000) };
    expect(decideShareAccess(link, "view", NOW)).toEqual({ allowed: false, reason: "revoked" });
  });

  it("denies as 'expired' once now has reached expiresAt", () => {
    const link = { ...base, expiresAt: NOW };
    expect(decideShareAccess(link, "view", NOW)).toEqual({ allowed: false, reason: "expired" });
    expect(decideShareAccess(link, "view", new Date(NOW.getTime() + 1))).toEqual({ allowed: false, reason: "expired" });
  });

  it("denies 'download' (but not 'view') as 'download_limit' once downloadCount reaches maxDownloads", () => {
    const link = { ...base, maxDownloads: 2, downloadCount: 2 };
    expect(decideShareAccess(link, "download", NOW)).toEqual({ allowed: false, reason: "download_limit" });
    expect(decideShareAccess(link, "view", NOW)).toEqual({ allowed: true });
  });

  it("allows download right up to the limit, denies the one after", () => {
    const atLimit = { ...base, maxDownloads: 2, downloadCount: 1 };
    expect(decideShareAccess(atLimit, "download", NOW)).toEqual({ allowed: true });
    const overLimit = { ...base, maxDownloads: 2, downloadCount: 2 };
    expect(decideShareAccess(overLimit, "download", NOW)).toEqual({ allowed: false, reason: "download_limit" });
  });

  it("revoked beats expired beats the download limit (checked in that order)", () => {
    const link = { expiresAt: NOW, revokedAt: new Date(NOW.getTime() - 1), maxDownloads: 1, downloadCount: 1 };
    expect(decideShareAccess(link, "download", new Date(NOW.getTime() + 1))).toEqual({ allowed: false, reason: "revoked" });
  });
});

describe("statusForShareDenial (c89)", () => {
  it("maps each reason to the status the public endpoint answers with", () => {
    expect(statusForShareDenial("invalid_token")).toBe(404);
    expect(statusForShareDenial("expired")).toBe(410);
    expect(statusForShareDenial("revoked")).toBe(410);
    expect(statusForShareDenial("download_limit")).toBe(429);
    expect(statusForShareDenial("integrity_failed")).toBe(403);
  });
});
