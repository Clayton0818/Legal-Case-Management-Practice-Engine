import { describe, it, expect } from "vitest";
import { generateShareToken, hashShareSecret, parseShareToken, tenantIdToHex } from "./crypto";

const TENANT_A = "11111111-2222-3333-4444-555555555555";
const TENANT_B = "99999999-8888-7777-6666-555555555555";

describe("exchange/crypto (c89)", () => {
  it("round-trips a token: parse(token) recovers the tenant id and the secret that hashes to tokenHash", () => {
    const { token, secret, tokenHash } = generateShareToken(TENANT_A);
    const parsed = parseShareToken(token);
    expect(parsed).toEqual({ tenantId: TENANT_A, secret });
    expect(hashShareSecret(parsed!.secret)).toBe(tokenHash);
  });

  it("never reuses a secret across two calls (even for the same tenant)", () => {
    const a = generateShareToken(TENANT_A);
    const b = generateShareToken(TENANT_A);
    expect(a.secret).not.toBe(b.secret);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("embeds a DIFFERENT tenant id for a different tenant, in the token itself", () => {
    const a = generateShareToken(TENANT_A);
    const b = generateShareToken(TENANT_B);
    expect(parseShareToken(a.token)!.tenantId).toBe(TENANT_A);
    expect(parseShareToken(b.token)!.tenantId).toBe(TENANT_B);
    expect(parseShareToken(a.token)!.tenantId).not.toBe(parseShareToken(b.token)!.tenantId);
  });

  it("parseShareToken rejects anything not of the exact shape — never throws", () => {
    expect(parseShareToken(null)).toBeNull();
    expect(parseShareToken(undefined)).toBeNull();
    expect(parseShareToken("")).toBeNull();
    expect(parseShareToken("not-a-token")).toBeNull();
    expect(parseShareToken("shl_not-hex_" + "a".repeat(43))).toBeNull();
    const { token } = generateShareToken(TENANT_A);
    expect(parseShareToken(token.slice(0, -1))).toBeNull(); // one char short
    expect(parseShareToken(token + "x")).toBeNull(); // one char long
  });

  it("tenantIdToHex refuses a non-uuid", () => {
    expect(() => tenantIdToHex("not-a-uuid")).toThrow();
  });

  it("a token edited to claim a different tenant id still only hashes to the SAME secret's hash — it cannot forge someone else's hash", () => {
    const { token, secret } = generateShareToken(TENANT_A);
    const forged = token.replace(tenantIdToHex(TENANT_A), tenantIdToHex(TENANT_B));
    const parsed = parseShareToken(forged)!;
    expect(parsed.tenantId).toBe(TENANT_B);
    expect(parsed.secret).toBe(secret); // the secret (and so its hash) is unchanged by editing the tenant part
  });
});
