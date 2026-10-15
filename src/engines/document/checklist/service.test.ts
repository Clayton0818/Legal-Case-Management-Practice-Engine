// c49 — pure-logic test for the AI's basic upload sanity check. Seeding,
// requesting, receiving and accepting a checklist item against real rows
// need a Postgres transaction and are covered in
// src/engines/document/document-workflow.db.test.ts, skipped without
// DATABASE_URL (unavailable in this sandbox).

import { describe, it, expect } from "vitest";
import { aiChecklistSanityCheck } from "./service";

describe("aiChecklistSanityCheck", () => {
  it("passes an ordinary-looking file", () => {
    expect(aiChecklistSanityCheck({ sizeBytes: 250_000, detectedMimeType: "application/pdf", pageCount: 3 })).toEqual({
      status: "passed",
      detail: {},
    });
  });

  it("flags a suspiciously small file", () => {
    const result = aiChecklistSanityCheck({ sizeBytes: 10, detectedMimeType: "application/pdf" });
    expect(result.status).toBe("flagged");
    expect(result.detail.reasons).toContain("The file is unusually small for a document.");
  });

  it("flags a zero-page document", () => {
    const result = aiChecklistSanityCheck({ sizeBytes: 50_000, detectedMimeType: "application/pdf", pageCount: 0 });
    expect(result.status).toBe("flagged");
    expect(result.detail.reasons).toContain("No pages were detected.");
  });

  it("flags an undetermined file type", () => {
    const result = aiChecklistSanityCheck({ sizeBytes: 50_000, detectedMimeType: null });
    expect(result.status).toBe("flagged");
    expect(result.detail.reasons).toContain("The file type could not be determined.");
  });

  it("can report more than one reason at once", () => {
    const result = aiChecklistSanityCheck({ sizeBytes: 5, detectedMimeType: null, pageCount: 0 });
    expect(result.status).toBe("flagged");
    expect((result.detail.reasons as string[]).length).toBe(3);
  });
});
