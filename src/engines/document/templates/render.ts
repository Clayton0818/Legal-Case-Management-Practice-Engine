// c85 — fill a parsed template from matter data. Pure.
//
// Output is always a DRAFT for a lawyer to review (c85 spec §5 rule 3).
// Missing values never get guessed: they render as a visible
// "[MISSING: <label>]" placeholder and are returned in `placeholders`, which
// blocks approval, sending and signing until a lawyer fills or clears each
// one with a reason (see lifecycle.ts, acceptance criteria 2–3).

import { getTemplateField, type TemplateField } from "./fields";
import type { Condition, TemplateNode } from "./syntax";

export type ScalarValue = string | number | Date | null | undefined;
export type ListItem = Readonly<Record<string, ScalarValue>>;
export type ContextValue = ScalarValue | readonly ListItem[];

export interface TemplateContext {
  /** Catalogue key -> value. Money is integer cents; dates are Date objects. */
  values: Readonly<Record<string, ContextValue>>;
  /** The firm's IANA time zone; dates render in it (c85 §4: "Dates use the firm's time zone"). */
  timeZone: string;
  /** BCP 47 locale of the template's language ('en-US', 'es-US'). */
  locale?: string;
}

export interface RenderOptions {
  /**
   * Who the document is addressed to. For 'other_party' (opposing counsel, a
   * court, a third party) sensitive fields are withheld unless the lawyer has
   * confirmed that field for this document (c85 §4, DV-matter edge case).
   */
  audience: "client" | "internal" | "other_party";
  sensitiveConfirmed?: readonly string[];
}

export type PlaceholderReason = "missing" | "withheld_sensitive";

export interface Placeholder {
  key: string;
  label: string;
  reason: PlaceholderReason;
}

export interface RenderResult {
  text: string;
  placeholders: Placeholder[];
  /** Snapshot of the values actually used (c85 rule 7), for generated_document_sources. */
  snapshot: Record<string, ContextValue>;
}

export function missingMarker(label: string): string {
  return `[MISSING: ${label}]`;
}

export function withheldMarker(label: string): string {
  return `[WITHHELD: ${label} — lawyer must confirm before including]`;
}

function isBlank(v: ContextValue): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Date) return Number.isNaN(v.getTime());
  return false;
}

export function formatDate(d: Date, timeZone: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "long", day: "numeric" }).format(d);
}

export function formatMoneyCents(cents: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(cents / 100);
}

function formatScalar(field: Pick<TemplateField, "kind">, v: ScalarValue, ctx: TemplateContext): string {
  if (v instanceof Date) return formatDate(v, ctx.timeZone, ctx.locale);
  if (typeof v === "number") return field.kind === "money" ? formatMoneyCents(v, ctx.locale) : String(v);
  return String(v ?? "");
}

/** List-item values: Dates render as dates, numbers as money (cents), strings as-is. */
function formatItemValue(v: ScalarValue, ctx: TemplateContext): string {
  if (v instanceof Date) return formatDate(v, ctx.timeZone, ctx.locale);
  if (typeof v === "number") return formatMoneyCents(v, ctx.locale);
  return String(v ?? "");
}

export function renderTemplate(nodes: readonly TemplateNode[], ctx: TemplateContext, opts: RenderOptions): RenderResult {
  const placeholders = new Map<string, Placeholder>();
  const snapshot: Record<string, ContextValue> = {};
  const confirmed = new Set(opts.sensitiveConfirmed ?? []);

  const withheld = (field: TemplateField): boolean =>
    field.sensitive === true && opts.audience === "other_party" && !confirmed.has(field.key);

  const note = (field: TemplateField, reason: PlaceholderReason) => {
    if (!placeholders.has(field.key)) placeholders.set(field.key, { key: field.key, label: field.label, reason });
  };

  const value = (key: string): ContextValue => {
    const v = ctx.values[key];
    if (!isBlank(v)) snapshot[key] = v;
    return v;
  };

  const evaluate = (c: Condition): boolean => {
    const field = getTemplateField(c.key);
    const v = value(c.key);
    if (c.op === "present") return !isBlank(v);
    // An equality test on a missing value cannot be decided safely: record it
    // so the lawyer sees the section choice may be wrong.
    if (isBlank(v)) {
      if (field) note(field, "missing");
      return false;
    }
    return String(v) === c.value;
  };

  const walk = (list: readonly TemplateNode[], item: ListItem | null): string => {
    let out = "";
    for (const n of list) {
      switch (n.type) {
        case "text":
          out += n.text;
          break;
        case "field": {
          const field = getTemplateField(n.key);
          if (!field) break; // parseTemplate guarantees catalogue keys
          if (withheld(field)) {
            note(field, "withheld_sensitive");
            out += withheldMarker(field.label);
            break;
          }
          const v = value(n.key);
          if (isBlank(v) || Array.isArray(v)) {
            note(field, "missing");
            out += missingMarker(field.label);
          } else {
            out += formatScalar(field, v as ScalarValue, ctx);
          }
          break;
        }
        case "item_field": {
          const v = item?.[n.key];
          out += isBlank(v) ? missingMarker(n.key.replace(/_/g, " ")) : formatItemValue(v, ctx);
          if (isBlank(v)) placeholders.set(`item.${n.key}`, { key: `item.${n.key}`, label: n.key.replace(/_/g, " "), reason: "missing" });
          break;
        }
        case "if": {
          const result = evaluate(n.condition) !== n.negate;
          out += walk(result ? n.then : n.otherwise, item);
          break;
        }
        case "each": {
          const field = getTemplateField(n.key);
          if (!field) break;
          if (withheld(field)) {
            note(field, "withheld_sensitive");
            out += withheldMarker(field.label);
            break;
          }
          const v = value(n.key);
          if (!Array.isArray(v) || v.length === 0) {
            note(field, "missing");
            out += missingMarker(field.label);
            break;
          }
          for (const it of v as readonly ListItem[]) out += walk(n.body, it);
          break;
        }
      }
    }
    return out;
  };

  const text = walk(nodes, null);
  return { text, placeholders: [...placeholders.values()], snapshot };
}
