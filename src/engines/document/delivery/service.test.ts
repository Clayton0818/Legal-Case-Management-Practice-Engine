// c40 — pure-logic tests. Asking, recording an answer, and the task
// cadence against real document_groups/tasks rows need a real Postgres
// transaction and are covered in
// src/engines/document/document-workflow.db.test.ts, skipped without
// DATABASE_URL (unavailable in this sandbox).

import { describe, it, expect } from "vitest";
import { DELIVERY_METHODS, DELIVERY_REASK_HOURS, DELIVERY_STATUSES, nextDeliveryReaskAt } from "./service";

describe("DELIVERY_STATUSES / DELIVERY_METHODS", () => {
  it("matches the document_groups CHECK constraints", () => {
    expect(DELIVERY_STATUSES).toEqual(["sent", "not_yet", "not_needed"]);
    expect(DELIVERY_METHODS).toEqual(["platform", "email", "mail", "hand_delivery", "other"]);
  });
});

describe("nextDeliveryReaskAt", () => {
  it("pushes the due time forward by the cadence", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const next = nextDeliveryReaskAt(now);
    expect(next.toISOString()).toBe("2026-10-16T12:00:00.000Z");
    expect(DELIVERY_REASK_HOURS).toBe(24);
  });

  it("accepts a custom cadence", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    expect(nextDeliveryReaskAt(now, 6).toISOString()).toBe("2026-10-15T18:00:00.000Z");
  });
});
