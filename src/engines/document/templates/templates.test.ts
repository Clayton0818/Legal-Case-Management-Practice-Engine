// c85 — pure tests for the template syntax, renderer and lifecycle rules,
// keyed to the spec's acceptance criteria (docs/product/features/document/c85-templates-fill-from-matter-data.md §10).

import { describe, it, expect } from "vitest";
import { parseTemplate, type TemplateNode } from "./syntax";
import { renderTemplate, type TemplateContext } from "./render";
import {
  canApproveVersion,
  downstreamBlockers,
  generatableTemplates,
  nextVersionNo,
  planApproval,
  validateClearance,
  validateTemplateMeta,
  type TemplateRow,
  type TemplateVersionRow,
} from "./lifecycle";
import { listTemplateFields } from "./fields";

function parse(body: string): TemplateNode[] {
  const r = parseTemplate(body);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.nodes;
}

const ctx = (values: TemplateContext["values"]): TemplateContext => ({ values, timeZone: "America/Chicago" });

describe("parseTemplate", () => {
  it("accepts catalogue fields and reports which ones are used", () => {
    const r = parseTemplate("Dear {{client.first_name}}, re cause {{ matter.cause_number }}.");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fieldKeys).toEqual(["client.first_name", "matter.cause_number"]);
  });

  it("criterion 4: an unknown field blocks saving and is named", () => {
    const r = parseTemplate("Favourite colour: {{client.favorite_color}}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("client.favorite_color");
  });

  it("rejects unbalanced blocks, stray else, item fields outside #each and #each on a scalar", () => {
    expect(parseTemplate("{{#if court.name}}x").ok).toBe(false);
    expect(parseTemplate("x{{/if}}").ok).toBe(false);
    expect(parseTemplate("{{else}}").ok).toBe(false);
    expect(parseTemplate("{{item.amount}}").ok).toBe(false);
    expect(parseTemplate("{{#each court.name}}{{/each}}").ok).toBe(false);
    expect(parseTemplate("{{#each fee.installments}}{{item.colour}}{{/each}}").ok).toBe(false);
    expect(parseTemplate("{{fee.installments}}").ok).toBe(false);
    expect(parseTemplate("   ").ok).toBe(false);
  });

  it("does not allow anything that looks like code", () => {
    expect(parseTemplate("{{constructor.constructor('x')()}}").ok).toBe(false);
    expect(parseTemplate("{{> partial}}").ok).toBe(false);
  });

  it("every catalogue key is a valid field name", () => {
    for (const f of listTemplateFields()) expect(parseTemplate(f.kind === "list" ? `{{#each ${f.key}}}x{{/each}}` : `{{${f.key}}}`).ok).toBe(true);
  });
});

describe("renderTemplate", () => {
  it("fills text, dates in the firm's time zone and money from cents", () => {
    const nodes = parse("{{client.legal_name}} owes {{fee.retainer_amount}} as of {{today}}.");
    const r = renderTemplate(
      nodes,
      ctx({ "client.legal_name": "Ana Example", "fee.retainer_amount": 450000, today: new Date("2026-10-02T03:00:00Z") }),
      { audience: "client" }
    );
    // 03:00 UTC on Oct 2 is still Oct 1 in Chicago.
    expect(r.text).toBe("Ana Example owes $4,500.00 as of October 1, 2026.");
    expect(r.placeholders).toEqual([]);
    expect(r.snapshot["client.legal_name"]).toBe("Ana Example");
  });

  it("criterion 2: a missing cause number becomes a visible placeholder", () => {
    const r = renderTemplate(parse("Cause No. {{matter.cause_number}}"), ctx({}), { audience: "internal" });
    expect(r.text).toBe("Cause No. [MISSING: cause number]");
    expect(r.placeholders).toEqual([{ key: "matter.cause_number", label: "cause number", reason: "missing" }]);
  });

  it("criterion 6: a fixed-fee matter gets the pay-schedule block, not the retainer block", () => {
    const body =
      '{{#if fee.type == "fixed"}}Total {{fee.fixed_fee_total}}:{{#each fee.installments}} {{item.due_on}} {{item.amount}};{{/each}}{{else}}Retainer {{fee.retainer_amount}}{{/if}}';
    const fixed = renderTemplate(
      parse(body),
      ctx({
        "fee.type": "fixed",
        "fee.fixed_fee_total": 300000,
        "fee.installments": [
          { due_on: new Date("2026-11-01T12:00:00Z"), amount: 150000 },
          { due_on: new Date("2026-12-01T12:00:00Z"), amount: 150000 },
        ],
      }),
      { audience: "client" }
    );
    expect(fixed.text).toBe("Total $3,000.00: November 1, 2026 $1,500.00; December 1, 2026 $1,500.00;");
    expect(fixed.text).not.toContain("Retainer");

    const retainer = renderTemplate(parse(body), ctx({ "fee.type": "retainer", "fee.retainer_amount": 450000 }), { audience: "client" });
    expect(retainer.text).toBe("Retainer $4,500.00");
  });

  it("an equality test on a missing value is flagged rather than silently decided", () => {
    const r = renderTemplate(parse('{{#if fee.type == "fixed"}}A{{else}}B{{/if}}'), ctx({}), { audience: "client" });
    expect(r.text).toBe("B");
    expect(r.placeholders.map((p) => p.key)).toEqual(["fee.type"]);
  });

  it("#unless and presence tests", () => {
    const nodes = parse("{{#unless court.name}}No court yet.{{/unless}}{{#if court.name}}Court: {{court.name}}{{/if}}");
    expect(renderTemplate(nodes, ctx({}), { audience: "internal" }).text).toBe("No court yet.");
    expect(renderTemplate(nodes, ctx({ "court.name": "District Court" }), { audience: "internal" }).text).toBe("Court: District Court");
  });

  it("withholds sensitive fields from documents to another party unless the lawyer confirms", () => {
    const nodes = parse("Client address: {{client.mailing_address}}");
    const values = { "client.mailing_address": "1 Safe St" };
    const out = renderTemplate(nodes, ctx(values), { audience: "other_party" });
    expect(out.text).toContain("[WITHHELD: client mailing address");
    expect(out.text).not.toContain("1 Safe St");
    expect(out.placeholders[0]?.reason).toBe("withheld_sensitive");

    const confirmed = renderTemplate(nodes, ctx(values), { audience: "other_party", sensitiveConfirmed: ["client.mailing_address"] });
    expect(confirmed.text).toBe("Client address: 1 Safe St");
    expect(renderTemplate(nodes, ctx(values), { audience: "client" }).text).toBe("Client address: 1 Safe St");
  });
});

describe("lifecycle", () => {
  const lawyer = new Set(["documents.approve", "templates.manage"]);
  const paralegal = new Set(["templates.manage"]);
  const t = (over: Partial<TemplateRow> = {}): TemplateRow => ({
    id: "t1", name: "Engagement letter", category: "agreement", practiceArea: "family", matterType: null, language: "en", status: "active", ...over,
  });
  const versions: TemplateVersionRow[] = [
    { id: "v1", templateId: "t1", versionNo: 1, status: "approved" },
    { id: "v2", templateId: "t1", versionNo: 2, status: "draft" },
    { id: "w1", templateId: "t2", versionNo: 1, status: "draft" },
  ];

  it("criterion 7: only a lawyer approves, and only drafts", () => {
    expect(canApproveVersion(paralegal, versions[1]!, t()).ok).toBe(false);
    expect(canApproveVersion(lawyer, versions[1]!, t()).ok).toBe(true);
    expect(canApproveVersion(lawyer, versions[0]!, t()).ok).toBe(false);
    expect(canApproveVersion(lawyer, versions[1]!, t({ status: "retired" })).ok).toBe(false);
  });

  it("approving v2 supersedes v1; version numbers increment per template", () => {
    expect(planApproval(versions, "v2")).toEqual({ approve: "v2", supersede: ["v1"] });
    expect(nextVersionNo(versions, "t1")).toBe(3);
    expect(nextVersionNo(versions, "t9")).toBe(1);
  });

  it("criterion 1: draft-only and retired templates are never offered; filters apply", () => {
    const templates = [t(), t({ id: "t2", name: "Draft only" }), t({ id: "t3", name: "Retired", status: "retired" }), t({ id: "t4", name: "Immigration", practiceArea: "immigration" })];
    const all = [...versions, { id: "x3", templateId: "t3", versionNo: 1, status: "approved" as const }, { id: "x4", templateId: "t4", versionNo: 1, status: "approved" as const }];
    const offered = generatableTemplates(templates, all, { practiceArea: "family", matterType: "divorce" });
    expect(offered.map((g) => g.version.id)).toEqual(["v1"]);
    expect(generatableTemplates(templates, all, { practiceArea: "family", matterType: null }, { language: "es" })).toEqual([]);
  });

  it("criteria 2–3: placeholders block until a lawyer clears them with a reason", () => {
    const ph = [{ key: "matter.cause_number", label: "cause number", reason: "missing" as const }];
    expect(downstreamBlockers(ph, [])).toHaveLength(1);
    expect(validateClearance(paralegal, { key: "matter.cause_number", reason: "Not yet filed" }, ph).ok).toBe(false);
    expect(validateClearance(lawyer, { key: "matter.cause_number", reason: " " }, ph).ok).toBe(false);
    expect(validateClearance(lawyer, { key: "court.name", reason: "x" }, ph).ok).toBe(false);
    expect(validateClearance(lawyer, { key: "matter.cause_number", reason: "Not yet filed" }, ph).ok).toBe(true);
    expect(downstreamBlockers(ph, [{ key: "matter.cause_number", reason: "Not yet filed", clearedByUserId: "u1" }])).toEqual([]);
  });

  it("validates template metadata", () => {
    expect(validateTemplateMeta({ name: "Letter", category: "letter", language: "es" })).toEqual([]);
    expect(validateTemplateMeta({ name: "", category: "memo", language: "spanish" })).toHaveLength(3);
  });
});
