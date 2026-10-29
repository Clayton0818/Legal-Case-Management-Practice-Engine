// c85 — the field catalogue for firm document templates.
//
// Business rule 6 (c85 spec §5): the catalogue is maintained by the product.
// Firms cannot define free-form fields, and nothing in a template can run
// code — a template may only reference the keys below. A template that names
// any other field fails validation and cannot be saved (acceptance criterion 4).
//
// Values are supplied by the caller as a plain TemplateContext (see
// render.ts); this file does not read the database. Several fields map to
// matter data the shared `matters` table does not hold yet (cause number,
// court, matter type — c85 spec §6 "Missing today"). Until the data-model
// extension adds them, those fields simply render as "[MISSING: …]"
// placeholders, which is exactly the safe behaviour the spec asks for.

export type TemplateFieldKind = "text" | "date" | "money" | "list";

export interface TemplateField {
  key: string;
  label: string;
  kind: TemplateFieldKind;
  /**
   * Protected data (c85 §4 edge cases: a DV client's address). A sensitive
   * field is never filled into a document addressed to another party unless
   * the lawyer confirms it for that document.
   */
  sensitive?: boolean;
  /** For kind 'list': the sub-keys each item may carry ({{item.<key>}}). */
  itemKeys?: readonly string[];
}

const FIELDS: readonly TemplateField[] = [
  { key: "today", label: "today's date", kind: "date" },
  { key: "firm.name", label: "firm name", kind: "text" },
  { key: "firm.address", label: "firm address", kind: "text" },
  { key: "firm.phone", label: "firm phone", kind: "text" },
  { key: "lawyer.name", label: "responsible lawyer", kind: "text" },
  { key: "lawyer.bar_number", label: "lawyer bar number", kind: "text" },
  { key: "client.legal_name", label: "client legal name", kind: "text" },
  { key: "client.first_name", label: "client first name", kind: "text" },
  { key: "client.mailing_address", label: "client mailing address", kind: "text", sensitive: true },
  { key: "client.email", label: "client email", kind: "text", sensitive: true },
  { key: "matter.practice_area", label: "practice area", kind: "text" },
  { key: "matter.matter_type", label: "matter type", kind: "text" },
  { key: "matter.cause_number", label: "cause number", kind: "text" },
  { key: "matter.opened_on", label: "matter opened date", kind: "date" },
  { key: "matter.closed_on", label: "matter closed date", kind: "date" },
  { key: "court.name", label: "court name", kind: "text" },
  { key: "court.county", label: "court county", kind: "text" },
  { key: "opposing_party.name", label: "opposing party name", kind: "text" },
  { key: "opposing_counsel.name", label: "opposing counsel name", kind: "text" },
  { key: "fee.type", label: "fee type", kind: "text" },
  { key: "fee.retainer_amount", label: "retainer amount", kind: "money" },
  { key: "fee.minimum_trust_balance", label: "minimum trust balance", kind: "money" },
  { key: "fee.fixed_fee_total", label: "fixed fee total", kind: "money" },
  { key: "fee.refund_amount", label: "refund amount", kind: "money" },
  {
    key: "fee.installments",
    label: "payment schedule",
    kind: "list",
    itemKeys: ["due_on", "amount", "label"],
  },
  {
    key: "children",
    label: "children",
    kind: "list",
    itemKeys: ["name", "birth_date"],
    sensitive: true,
  },
];

export const TEMPLATE_FIELDS: ReadonlyMap<string, TemplateField> = new Map(FIELDS.map((f) => [f.key, f]));

export function getTemplateField(key: string): TemplateField | undefined {
  return TEMPLATE_FIELDS.get(key);
}

/** The catalogue as a list, for the template editor's field picker. */
export function listTemplateFields(): readonly TemplateField[] {
  return FIELDS;
}
