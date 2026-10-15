// c49 — pure validation and planning for the required-documents checklist
// template, mirroring src/engines/document/folders/template.ts: a firm sets
// one JSON template per practice area (or firm-wide); a matter's checklist
// is SEEDED from the active template once and then lives on its own rows
// (document_checklist_items) so later template edits never retroactively
// change an in-progress matter's checklist.

import type { ChecklistTemplateItem } from "@/db/tables/document";

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const RESPONSIBLE_PARTIES = ["client", "firm", "third_party"] as const;

export interface ValidTemplate {
  ok: true;
  normalized: ChecklistTemplateItem[];
}
export interface InvalidTemplate {
  ok: false;
  errors: string[];
}

/** Pure: validate and normalize a proposed template's `items`. */
export function validateChecklistTemplate(items: unknown): ValidTemplate | InvalidTemplate {
  const errors: string[] = [];
  if (!Array.isArray(items)) return { ok: false, errors: ["A checklist template must be a list of items."] };
  if (items.length === 0) errors.push("A checklist template needs at least one item.");

  const seenKeys = new Set<string>();
  const normalized: ChecklistTemplateItem[] = [];
  items.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      errors.push(`Item ${i + 1} must be an object.`);
      return;
    }
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key.trim().toLowerCase() : "";
    if (!KEY_PATTERN.test(key)) {
      errors.push(`Item ${i + 1}: key must be lowercase letters, digits and underscores, starting with a letter (got '${key}').`);
    } else if (seenKeys.has(key)) {
      errors.push(`Item ${i + 1}: key '${key}' is used more than once.`);
    } else {
      seenKeys.add(key);
    }
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (!label) errors.push(`Item ${i + 1} ('${key || "?"}') needs a label.`);
    const responsibleParty = r.responsibleParty;
    if (!(RESPONSIBLE_PARTIES as readonly unknown[]).includes(responsibleParty)) {
      errors.push(`Item ${i + 1} ('${key || "?"}'): responsibleParty must be one of ${RESPONSIBLE_PARTIES.join(", ")}.`);
    }
    const description = typeof r.description === "string" ? r.description.trim() : "";
    const documentType = typeof r.documentType === "string" && r.documentType.trim() ? r.documentType.trim().toLowerCase() : undefined;
    if (errors.length === 0 || KEY_PATTERN.test(key)) {
      normalized.push({
        key,
        label,
        description,
        responsibleParty: responsibleParty as ChecklistTemplateItem["responsibleParty"],
        ...(documentType ? { documentType } : {}),
      });
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, normalized };
}

export interface PickedChecklistTemplate {
  templateId: string | null;
  items: ChecklistTemplateItem[];
  /** 'practice_area' | 'firm_wide' | 'none' (no active template at all — an empty checklist is fine). */
  source: "practice_area" | "firm_wide" | "none";
}

/** Pick the active template for a matter's practice area, falling back to the firm-wide one. Pure. */
export function pickChecklistTemplate<T extends { id: string; practiceArea: string | null; items: ChecklistTemplateItem[]; status: string }>(
  templates: readonly T[],
  practiceArea: string | null
): PickedChecklistTemplate {
  const active = templates.filter((t) => t.status === "active");
  const byArea = practiceArea ? active.find((t) => t.practiceArea === practiceArea) : undefined;
  if (byArea) return { templateId: byArea.id, items: byArea.items, source: "practice_area" };
  const firmWide = active.find((t) => t.practiceArea === null);
  if (firmWide) return { templateId: firmWide.id, items: firmWide.items, source: "firm_wide" };
  return { templateId: null, items: [], source: "none" };
}

export interface ExistingChecklistItem {
  templateItemKey: string | null;
}

/** Template items a matter's checklist does not have yet (by key). Pure. */
export function missingChecklistItems(template: ChecklistTemplateItem[], existing: readonly ExistingChecklistItem[]): ChecklistTemplateItem[] {
  const have = new Set(existing.map((e) => e.templateItemKey).filter((k): k is string => k !== null));
  return template.filter((item) => !have.has(item.key));
}
