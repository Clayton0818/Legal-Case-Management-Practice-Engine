import { describe, expect, it } from "vitest";
import { intakeResultValues, resolutionPatch, ROLE_NOT_SPECIFIED, type CheckForIntake } from "./intakeResults";

const SESSION = "5b0f7c2e-1d4a-4c3b-9a8e-0c1d2e3f4a5b";
const CONFIG = "6c1a8d3f-2e5b-4d4c-8b9f-1d2e3f4a5b6c";
const ATTORNEY = "7d2b9e4a-3f6c-4e5d-9c0a-2e3f4a5b6c7d";
const NOW = new Date("2026-10-22T15:00:00Z");

const check = (over: Partial<CheckForIntake> = {}): CheckForIntake => ({
  id: "8e3c0f5b-4a7d-4f6e-8d1b-3f4a5b6c7d8e",
  tenantId: "9f4d1a6c-5b8e-4a7f-9e2c-4a5b6c7d8e9f",
  intakeSessionId: SESSION,
  roleSought: "client",
  outcome: "possible",
  outcomeReasons: ["hits"],
  legacyResultId: null,
  ...over,
});

describe("intakeResultValues (c110)", () => {
  it("copies the engine's own tri-state outcome for an intake check, unchanged", () => {
    for (const outcome of ["clear", "possible", "definite"] as const) {
      expect(intakeResultValues(check({ outcome }), CONFIG, NOW)).toMatchObject({
        intakeSessionId: SESSION,
        outcome,
        firmConfigVersionId: CONFIG,
        resolvedByUserId: null,
        resolvedAt: null,
        createdAt: NOW,
      });
    }
  });

  it("is only for intake checks, and never duplicates an existing legacy result", () => {
    expect(intakeResultValues(check({ intakeSessionId: null }), CONFIG, NOW)).toBeNull();
    expect(intakeResultValues(check({ legacyResultId: "a05e2b7d-6c9f-4b8a-8f3d-5b6c7d8e9f0a" }), CONFIG, NOW)).toBeNull();
    expect(intakeResultValues(check({ outcome: "maybe" }), CONFIG, NOW)).toBeNull();
  });

  it("fills the required role when the check had none", () => {
    expect(intakeResultValues(check({ roleSought: null }), CONFIG, NOW)?.roleSought).toBe(ROLE_NOT_SPECIFIED);
    expect(intakeResultValues(check({ roleSought: "  " }), CONFIG, NOW)?.roleSought).toBe(ROLE_NOT_SPECIFIED);
    expect(intakeResultValues(check({ roleSought: "petitioner" }), CONFIG, NOW)?.roleSought).toBe("petitioner");
  });

  it("carries only ids and reason codes, never names or hit details", () => {
    const values = intakeResultValues(check({ outcomeReasons: ["hits", "name_unknown"] }), CONFIG, NOW)!;
    expect(values.matchedSources).toEqual({ conflictCheckId: check().id, reasons: ["hits", "name_unknown"] });
    expect(values).not.toHaveProperty("matchedPartyIds");
  });
});

describe("resolutionPatch (c110): the system never resolves a conflict by itself", () => {
  const unresolved = { resolvedAt: null, resolvedByUserId: null };
  const resolved = { resolvedAt: NOW, resolvedByUserId: ATTORNEY };
  const open = { state: "open" } as const;
  const closed = { state: "closed" } as const;

  it("leaves clear and definite results alone", () => {
    expect(resolutionPatch({ outcome: "clear", ...unresolved }, open, ATTORNEY, NOW)).toBeNull();
    expect(resolutionPatch({ outcome: "definite", ...unresolved }, open, ATTORNEY, NOW)).toBeNull();
    expect(resolutionPatch({ outcome: "definite", ...resolved }, closed, null, NOW)).toBeNull();
  });

  it("keeps a possible conflict paused while the gate is closed (pending, declined, awaiting consent or screen)", () => {
    expect(resolutionPatch({ outcome: "possible", ...unresolved }, closed, ATTORNEY, NOW)).toBeNull();
  });

  it("resolves a possible conflict only when the gate is open AND a human attorney decided", () => {
    expect(resolutionPatch({ outcome: "possible", ...unresolved }, open, ATTORNEY, NOW)).toEqual({ resolvedByUserId: ATTORNEY, resolvedAt: NOW });
    expect(resolutionPatch({ outcome: "possible", ...unresolved }, open, null, NOW)).toBeNull();
  });

  it("does not rewrite an existing resolution", () => {
    expect(resolutionPatch({ outcome: "possible", ...resolved }, open, ATTORNEY, new Date("2026-10-23T09:00:00Z"))).toBeNull();
  });

  it("withdraws the resolution when the gate closes again (e.g. a corrected decision)", () => {
    expect(resolutionPatch({ outcome: "possible", ...resolved }, closed, null, NOW)).toEqual({ resolvedByUserId: null, resolvedAt: null });
  });
});
