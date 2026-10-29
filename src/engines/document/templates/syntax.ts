// c85 — template syntax: parse and validate. Pure.
//
// Deliberately tiny and deterministic (c85 spec §5 rule 5: conditional
// sections use only deterministic rules on matter data; no AI decides
// inclusion; rule 6: nothing in a template runs code):
//
//   {{client.legal_name}}               a catalogue field
//   {{#if fee.type == "fixed"}} … {{else}} … {{/if}}
//   {{#if matter.cause_number}} … {{/if}}      (present / non-empty)
//   {{#unless court.name}} … {{/unless}}
//   {{#each fee.installments}} {{item.due_on}} {{item.amount}} {{/each}}
//
// Anything else inside {{ }} is a validation error, as is any field that is
// not in the catalogue (acceptance criterion 4: unknown fields block saving).

import { getTemplateField } from "./fields";

export type Condition =
  | { op: "present"; key: string }
  | { op: "equals"; key: string; value: string };

export type TemplateNode =
  | { type: "text"; text: string }
  | { type: "field"; key: string }
  | { type: "item_field"; key: string }
  | { type: "if"; negate: boolean; condition: Condition; then: TemplateNode[]; otherwise: TemplateNode[] }
  | { type: "each"; key: string; body: TemplateNode[] };

export type ParseResult =
  | { ok: true; nodes: TemplateNode[]; fieldKeys: string[] }
  | { ok: false; errors: string[] };

const TAG = /\{\{\s*([^{}]*?)\s*\}\}/g;
const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const IF_EQ = /^#(if|unless)\s+([a-z0-9_.]+)\s*==\s*"([^"]*)"$/;
const IF_PRESENT = /^#(if|unless)\s+([a-z0-9_.]+)$/;
const EACH = /^#each\s+([a-z0-9_.]+)$/;
const ITEM = /^item\.([a-z][a-z0-9_]*)$/;

/** Maximum template body we accept (characters). Keeps parsing bounded. */
export const MAX_TEMPLATE_CHARS = 200_000;

interface Frame {
  kind: "root" | "if" | "unless" | "each";
  nodes: TemplateNode[];
  /** For if/unless: the node being built (its `then` until {{else}}, then `otherwise`). */
  ifNode?: Extract<TemplateNode, { type: "if" }>;
  inElse?: boolean;
  eachKey?: string;
}

/** Parse a template body and validate every field against the catalogue. */
export function parseTemplate(body: string): ParseResult {
  const errors: string[] = [];
  if (typeof body !== "string" || body.trim() === "") return { ok: false, errors: ["The template is empty."] };
  if (body.length > MAX_TEMPLATE_CHARS) return { ok: false, errors: [`The template is longer than ${MAX_TEMPLATE_CHARS} characters.`] };

  const root: Frame = { kind: "root", nodes: [] };
  const stack: Frame[] = [root];
  const used = new Set<string>();
  const top = (): Frame => stack[stack.length - 1]!;
  const eachKey = (): string | undefined => [...stack].reverse().find((f) => f.kind === "each")?.eachKey;

  const checkKey = (key: string, want: "scalar" | "list" | "any"): boolean => {
    if (!KEY.test(key)) {
      errors.push(`"${key}" is not a valid field name.`);
      return false;
    }
    const field = getTemplateField(key);
    if (!field) {
      errors.push(`Unknown field "${key}". Only fields from the catalogue can be used.`);
      return false;
    }
    if (want === "scalar" && field.kind === "list") {
      errors.push(`"${key}" is a list; use {{#each ${key}}} … {{/each}}.`);
      return false;
    }
    if (want === "list" && field.kind !== "list") {
      errors.push(`"${key}" is not a list, so it cannot be used with #each.`);
      return false;
    }
    used.add(key);
    return true;
  };

  let last = 0;
  for (const m of body.matchAll(TAG)) {
    const start = m.index ?? 0;
    if (start > last) top().nodes.push({ type: "text", text: body.slice(last, start) });
    last = start + m[0].length;
    const inner = (m[1] ?? "").trim();

    let mm: RegExpMatchArray | null;
    if ((mm = inner.match(IF_EQ)) || (mm = inner.match(IF_PRESENT))) {
      const kind = mm[1] === "unless" ? "unless" : "if";
      const key = mm[2]!;
      checkKey(key, mm[3] !== undefined ? "scalar" : "any");
      const condition: Condition = mm[3] !== undefined ? { op: "equals", key, value: mm[3] } : { op: "present", key };
      const node: Extract<TemplateNode, { type: "if" }> = { type: "if", negate: kind === "unless", condition, then: [], otherwise: [] };
      top().nodes.push(node);
      stack.push({ kind, nodes: node.then, ifNode: node });
    } else if ((mm = inner.match(EACH))) {
      const key = mm[1]!;
      if (eachKey()) errors.push("Nested #each blocks are not supported.");
      checkKey(key, "list");
      const node: Extract<TemplateNode, { type: "each" }> = { type: "each", key, body: [] };
      top().nodes.push(node);
      stack.push({ kind: "each", nodes: node.body, eachKey: key });
    } else if (inner === "else") {
      const f = top();
      if ((f.kind !== "if" && f.kind !== "unless") || f.inElse || !f.ifNode) {
        errors.push("{{else}} without a matching {{#if}} or {{#unless}}.");
      } else {
        f.inElse = true;
        f.nodes = f.ifNode.otherwise;
      }
    } else if (inner === "/if" || inner === "/unless" || inner === "/each") {
      const want = inner.slice(1);
      const f = top();
      if (f.kind !== want) {
        errors.push(`{{${inner}}} does not close an open {{#${want}}}.`);
      } else {
        stack.pop();
      }
    } else if ((mm = inner.match(ITEM))) {
      const listKey = eachKey();
      if (!listKey) {
        errors.push(`{{${inner}}} can only be used inside {{#each}}.`);
      } else {
        const allowed = getTemplateField(listKey)?.itemKeys ?? [];
        if (!allowed.includes(mm[1]!)) errors.push(`"${mm[1]}" is not a field of ${listKey} items (allowed: ${allowed.join(", ")}).`);
        top().nodes.push({ type: "item_field", key: mm[1]! });
      }
    } else {
      if (checkKey(inner, "scalar")) top().nodes.push({ type: "field", key: inner });
    }
  }
  if (last < body.length) top().nodes.push({ type: "text", text: body.slice(last) });

  for (const f of stack.slice(1).reverse()) errors.push(`{{#${f.kind}}} is never closed.`);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, nodes: root.nodes, fieldKeys: [...used].sort() };
}
