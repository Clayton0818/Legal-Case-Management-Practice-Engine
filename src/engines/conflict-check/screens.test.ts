// Pure-function tests for the c60 screen lifecycle helpers. The DB-backed
// flows (liftScreen, setUpScreensForDecision, runScreenSetupTask) need a real
// transaction and are exercised by describeWithDb elsewhere in this engine's
// suite; this file covers everything that doesn't need one, per the engine's
// usual split between plain vitest tests and describeWithDb tests.

import { describe, expect, it } from "vitest";
import { ConflictError } from "./util";
import {
  isScreenActive,
  parseDecisionRef,
  requireLiftReason,
  ScreenBlockedError,
} from "./screens";

describe("isScreenActive", () => {
  it("is true only while a screen is active", () => {
    expect(isScreenActive({ status: "active" })).toBe(true);
    expect(isScreenActive({ status: "requested" })).toBe(false);
    expect(isScreenActive({ status: "lifted" })).toBe(false);
  });
});

describe("parseDecisionRef", () => {
  it("extracts the decision id from a hand-off task's sourceRef", () => {
    expect(parseDecisionRef("conflict_decision:9f2c2b2e-1111-4a2b-8c3d-000000000001")).toBe(
      "9f2c2b2e-1111-4a2b-8c3d-000000000001"
    );
  });

  it("returns null for a ref from a different kind of task", () => {
    expect(parseDecisionRef("conflict_waiver:9f2c2b2e-1111-4a2b-8c3d-000000000001")).toBeNull();
  });

  it("returns null when there is no sourceRef", () => {
    expect(parseDecisionRef(null)).toBeNull();
    expect(parseDecisionRef(undefined)).toBeNull();
    expect(parseDecisionRef("")).toBeNull();
  });
});

describe("requireLiftReason", () => {
  it("returns the trimmed reason when one is given", () => {
    expect(requireLiftReason("  Screen no longer needed — matter closed.  ")).toBe(
      "Screen no longer needed — matter closed."
    );
  });

  it("rejects an empty or whitespace-only reason (c45: no silent clearing)", () => {
    expect(() => requireLiftReason("")).toThrow(ConflictError);
    expect(() => requireLiftReason("   ")).toThrow(ConflictError);
    expect(() => requireLiftReason(null)).toThrow(ConflictError);
    expect(() => requireLiftReason(undefined)).toThrow(ConflictError);
  });

  it("the rejection reads as an instruction, not a stack trace", () => {
    try {
      requireLiftReason(undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toBe("A reason is required to lift a screen.");
    }
  });
});

describe("ScreenBlockedError", () => {
  it("names the user and the subject they are screened from", () => {
    const err = new ScreenBlockedError("user-1", "matter-9");
    expect(err.name).toBe("ScreenBlockedError");
    expect(err.userId).toBe("user-1");
    expect(err.subjectId).toBe("matter-9");
    expect(err.message).toContain("user-1");
    expect(err.message).toContain("matter-9");
  });
});
