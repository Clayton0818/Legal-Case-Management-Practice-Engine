// c41 — pure-logic tests. The sign-off workflow itself (status transitions,
// the client task, the restart-on-new-version behaviour) needs a real
// Postgres transaction and is covered in
// src/engines/document/document-workflow.db.test.ts, skipped without
// DATABASE_URL (unavailable in this sandbox).

import { describe, it, expect } from "vitest";
import { REVIEW_ELIGIBLE_STATUSES, SIGNOFF_TASK_KIND } from "./service";

describe("REVIEW_ELIGIBLE_STATUSES", () => {
  it("never includes a status that has already left client review", () => {
    expect(REVIEW_ELIGIBLE_STATUSES).not.toContain("client_review");
    expect(REVIEW_ELIGIBLE_STATUSES).not.toContain("client_approved");
    expect(REVIEW_ELIGIBLE_STATUSES).not.toContain("final");
    expect(REVIEW_ELIGIBLE_STATUSES).not.toContain("filed");
    expect(REVIEW_ELIGIBLE_STATUSES).not.toContain("superseded");
    expect(REVIEW_ELIGIBLE_STATUSES).not.toContain("archived");
  });
});

describe("SIGNOFF_TASK_KIND", () => {
  it("is a namespaced task kind", () => {
    expect(SIGNOFF_TASK_KIND).toMatch(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/);
  });
});
