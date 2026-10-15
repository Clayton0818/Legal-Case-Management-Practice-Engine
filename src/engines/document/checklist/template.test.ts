// c49 — pure validation/planning tests for the checklist template, mirroring
// src/engines/document/folders/template.test.ts.

import { describe, it, expect } from "vitest";
import { missingChecklistItems, pickChecklistTemplate, validateChecklistTemplate } from "./template";

describe("validateChecklistTemplate", () => {
  it("accepts a well-formed template and normalizes keys/labels", () => {
    const result = validateChecklistTemplate([
      { key: "Marriage_Certificate", label: "  Marriage certificate  ", responsibleParty: "client" },
      { key: "financial_affidavit", label: "Financial affidavit", description: "Signed and dated.", responsibleParty: "client", documentType: "Affidavit" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized).toEqual([
      { key: "marriage_certificate", label: "Marriage certificate", description: "", responsibleParty: "client" },
      { key: "financial_affidavit", label: "Financial affidavit", description: "Signed and dated.", responsibleParty: "client", documentType: "affidavit" },
    ]);
  });

  it("rejects a non-array, an empty list, duplicate keys, bad keys, missing labels and bad responsibleParty", () => {
    expect(validateChecklistTemplate("nope").ok).toBe(false);
    expect(validateChecklistTemplate([]).ok).toBe(false);

    const dup = validateChecklistTemplate([
      { key: "a", label: "A", responsibleParty: "client" },
      { key: "a", label: "A again", responsibleParty: "firm" },
    ]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.some((e) => e.includes("used more than once"))).toBe(true);

    const badKey = validateChecklistTemplate([{ key: "Not A Key!", label: "X", responsibleParty: "client" }]);
    expect(badKey.ok).toBe(false);

    const noLabel = validateChecklistTemplate([{ key: "x", label: "  ", responsibleParty: "client" }]);
    expect(noLabel.ok).toBe(false);

    const badResp = validateChecklistTemplate([{ key: "x", label: "X", responsibleParty: "robot" }]);
    expect(badResp.ok).toBe(false);
  });
});

describe("pickChecklistTemplate", () => {
  const templates = [
    { id: "t-draft", practiceArea: "family", items: [{ key: "draft_only", label: "Draft only", description: "", responsibleParty: "client" as const }], status: "draft" },
    { id: "t-family", practiceArea: "family", items: [{ key: "mc", label: "Marriage certificate", description: "", responsibleParty: "client" as const }], status: "active" },
    { id: "t-firmwide", practiceArea: null, items: [{ key: "id", label: "Photo ID", description: "", responsibleParty: "client" as const }], status: "active" },
  ];

  it("prefers the active practice-area template", () => {
    const picked = pickChecklistTemplate(templates, "family");
    expect(picked).toEqual({ templateId: "t-family", items: templates[1]!.items, source: "practice_area" });
  });

  it("falls back to the firm-wide template when no practice-area match", () => {
    const picked = pickChecklistTemplate(templates, "immigration");
    expect(picked).toEqual({ templateId: "t-firmwide", items: templates[2]!.items, source: "firm_wide" });
  });

  it("returns an empty, 'none' result when nothing is active", () => {
    const picked = pickChecklistTemplate(
      [{ id: "t-draft", practiceArea: null, items: [], status: "draft" }],
      null
    );
    expect(picked).toEqual({ templateId: null, items: [], source: "none" });
  });
});

describe("missingChecklistItems", () => {
  it("returns only the template items the matter does not already have", () => {
    const template = [
      { key: "a", label: "A", description: "", responsibleParty: "client" as const },
      { key: "b", label: "B", description: "", responsibleParty: "client" as const },
    ];
    expect(missingChecklistItems(template, [{ templateItemKey: "a" }])).toEqual([template[1]]);
    expect(missingChecklistItems(template, [{ templateItemKey: null }])).toEqual(template);
    expect(missingChecklistItems(template, [{ templateItemKey: "a" }, { templateItemKey: "b" }])).toEqual([]);
  });
});
