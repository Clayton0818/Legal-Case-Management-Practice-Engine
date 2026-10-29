// c85 — template version lifecycle and the "placeholders block downstream"
// rule. Pure: callers pass the actor's effective rights (from
// src/core/permissions.ts effectiveRights()) and the rows they loaded.
//
//   template:          active | retired
//   template version:  draft -> approved -> superseded
//
// Rules (c85 spec §5):
//   1. Only approved versions of active templates generate documents.
//   2. Only a lawyer (right `documents.approve`, attorney-only) approves a version.
//   4. Placeholders block approval / sending / signing unless a lawyer clears
//      each one with a logged reason.
//   9. Starter templates shipped by the product arrive as draft.
// Editing an approved version creates a new draft; the old approved version
// stays in use until the new one is approved (then it becomes superseded).

import type { Placeholder } from "./render";

export type TemplateStatus = "active" | "retired";
export type TemplateVersionStatus = "draft" | "approved" | "superseded";

export const TEMPLATE_CATEGORIES = ["letter", "pleading", "form", "agreement"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const MANAGE_RIGHT = "templates.manage";
export const APPROVE_RIGHT = "documents.approve";

export interface TemplateRow {
  id: string;
  name: string;
  category: TemplateCategory;
  practiceArea: string | null;
  matterType: string | null;
  language: string;
  status: TemplateStatus;
}

export interface TemplateVersionRow {
  id: string;
  templateId: string;
  versionNo: number;
  status: TemplateVersionStatus;
}

export type Decision = { ok: true } | { ok: false; reason: string };

const yes: Decision = { ok: true };
const no = (reason: string): Decision => ({ ok: false, reason });

export function canEditTemplate(rights: ReadonlySet<string>, template: TemplateRow): Decision {
  if (!rights.has(MANAGE_RIGHT)) return no("You do not have the right to manage templates.");
  if (template.status === "retired") return no("This template is retired. Create a new template instead.");
  return yes;
}

/** Acceptance criterion 7: a non-attorney without approval rights is refused. */
export function canApproveVersion(rights: ReadonlySet<string>, version: TemplateVersionRow, template: TemplateRow): Decision {
  if (!rights.has(APPROVE_RIGHT)) return no("Only a lawyer can approve a template version.");
  if (template.status === "retired") return no("A retired template cannot be approved.");
  if (version.status !== "draft") return no(`Only a draft version can be approved (this one is ${version.status}).`);
  return yes;
}

/**
 * What approving `versionId` changes: the version becomes approved and any
 * previously approved version of the same template becomes superseded.
 */
export function planApproval(versions: readonly TemplateVersionRow[], versionId: string): { approve: string; supersede: string[] } {
  const target = versions.find((v) => v.id === versionId);
  if (!target) throw new Error(`Template version ${versionId} not found.`);
  return {
    approve: target.id,
    supersede: versions.filter((v) => v.templateId === target.templateId && v.status === "approved" && v.id !== target.id).map((v) => v.id),
  };
}

/** The next version number for a new draft of a template. */
export function nextVersionNo(versions: readonly TemplateVersionRow[], templateId: string): number {
  return versions.filter((v) => v.templateId === templateId).reduce((max, v) => Math.max(max, v.versionNo), 0) + 1;
}

export interface GeneratableTemplate {
  template: TemplateRow;
  version: TemplateVersionRow;
}

/**
 * Templates a user may generate from for a matter (acceptance criterion 1:
 * a draft version is never offered). Filters by practice area / matter type
 * (null on the template = any), and by language. A language is offered only
 * if it has an approved version (c85 §4 edge case).
 */
export function generatableTemplates(
  templates: readonly TemplateRow[],
  versions: readonly TemplateVersionRow[],
  matter: { practiceArea: string | null; matterType: string | null },
  filter: { language?: string; category?: TemplateCategory } = {}
): GeneratableTemplate[] {
  const out: GeneratableTemplate[] = [];
  for (const t of templates) {
    if (t.status !== "active") continue;
    if (t.practiceArea !== null && t.practiceArea !== matter.practiceArea) continue;
    if (t.matterType !== null && t.matterType !== matter.matterType) continue;
    if (filter.language && t.language !== filter.language) continue;
    if (filter.category && t.category !== filter.category) continue;
    const approved = versions.find((v) => v.templateId === t.id && v.status === "approved");
    if (approved) out.push({ template: t, version: approved });
  }
  return out.sort((a, b) => a.template.name.localeCompare(b.template.name));
}

export interface PlaceholderClearance {
  key: string;
  reason: string;
  clearedByUserId: string;
}

/**
 * Acceptance criteria 2–3: a generated draft with unresolved placeholders
 * cannot be approved, sent or signed. A lawyer may clear a placeholder with
 * a reason (logged by the caller in the audit trail).
 */
export function downstreamBlockers(
  placeholders: readonly Placeholder[],
  clearances: readonly PlaceholderClearance[]
): Placeholder[] {
  const cleared = new Set(clearances.filter((c) => c.reason.trim() !== "").map((c) => c.key));
  return placeholders.filter((p) => !cleared.has(p.key));
}

export function validateClearance(rights: ReadonlySet<string>, c: { key: string; reason: string }, placeholders: readonly Placeholder[]): Decision {
  if (!rights.has(APPROVE_RIGHT)) return no("Only a lawyer can clear a placeholder.");
  if (!placeholders.some((p) => p.key === c.key)) return no(`"${c.key}" is not an open placeholder on this draft.`);
  if (!c.reason.trim()) return no("Record why this placeholder can be left as it is.");
  return yes;
}

/** Validates the metadata a user enters when creating a template. */
export function validateTemplateMeta(t: { name: string; category: string; language: string }): string[] {
  const errors: string[] = [];
  if (!t.name?.trim()) errors.push("Give the template a name.");
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(t.category)) errors.push(`Category must be one of: ${TEMPLATE_CATEGORIES.join(", ")}.`);
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(t.language ?? "")) errors.push("Language must be a code such as 'en' or 'es'.");
  return errors;
}
