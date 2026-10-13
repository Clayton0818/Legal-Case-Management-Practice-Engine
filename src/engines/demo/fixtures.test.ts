import { describe, expect, it } from "vitest";
import {
  allFixtureContacts,
  DEMO_BANNER,
  DEMO_DOCUMENTS,
  DEMO_EXISTING_MATTERS,
  DEMO_FIRM,
  DEMO_HISTORY_ROWS,
  DEMO_PROSPECTS,
  DEMO_STAFF,
  staffByKey,
} from "./fixtures";
import { IMPORT_FIELDS } from "@/engines/conflict-check/historyImport";

describe("demo fixtures are obviously fictional", () => {
  it("labels the firm DEMO and fictional everywhere it shows", () => {
    expect(DEMO_FIRM.name).toMatch(/DEMO/);
    expect(DEMO_FIRM.name).toMatch(/fictional/i);
    expect(DEMO_FIRM.label).toMatch(/DEMO/);
    expect(DEMO_BANNER).toMatch(/^DEMO — fictional data/);
    expect(DEMO_FIRM.slugPrefix).toBe("demo-");
  });

  it("uses only example.com addresses and 555-01xx numbers", () => {
    const { emails, phones } = allFixtureContacts();
    expect(emails.length).toBeGreaterThan(10);
    for (const e of emails) expect(e).toMatch(/@([a-z0-9-]+\.)*example\.com$/);
    expect(phones.length).toBeGreaterThan(10);
    for (const p of phones) expect(p).toMatch(/^\+1-512-555-01\d\d$/);
  });

  it("has unique staff emails and the roles the walkthrough needs", () => {
    expect(new Set(DEMO_STAFF.map((s) => s.email)).size).toBe(DEMO_STAFF.length);
    expect(DEMO_STAFF.filter((s) => s.role === "attorney").length).toBeGreaterThanOrEqual(3);
    expect(staffByKey("admin").role).toBe("firm_admin");
    expect(staffByKey("bookkeeper").roleLabel).toBe("bookkeeper");
    expect(() => staffByKey("nobody" as never)).toThrow();
  });

  it("covers the three conflict states and an emergency", () => {
    expect(DEMO_PROSPECTS.map((p) => p.key).sort()).toEqual(["clear", "definite", "emergency", "possible"]);
    const definite = DEMO_PROSPECTS.find((p) => p.key === "definite")!;
    const sampleford = DEMO_EXISTING_MATTERS.find((m) => m.key === "sampleford")!;
    // The "definite" inquirer is the other side of a current matter and names our client.
    expect(definite.fullName).toBe(sampleford.opposing.fullName);
    expect(definite.otherPartyNames).toContain(sampleford.client.fullName);
    // The "possible" inquirer names a former client by her maiden name, which the history import carries.
    const possible = DEMO_PROSPECTS.find((p) => p.key === "possible")!;
    expect(DEMO_HISTORY_ROWS.some((r) => r.startsWith("former_client,") && r.includes(possible.otherPartyNames[0]!))).toBe(true);
  });

  it("history rows match the conflict import template's columns", () => {
    for (const row of DEMO_HISTORY_ROWS) expect(row.split(",")).toHaveLength(IMPORT_FIELDS.length);
  });

  it("documents are short, plainly-marked fictional text", () => {
    for (const d of DEMO_DOCUMENTS) {
      expect(d.filename).toMatch(/DEMO/);
      for (const v of d.versions) {
        expect(v).toMatch(/^DEMO DOCUMENT — FICTIONAL\./);
        expect(v.length).toBeLessThan(2000);
      }
    }
  });

  it("has a Family Law matter with a child", () => {
    expect(DEMO_EXISTING_MATTERS.some((m) => (m.children ?? []).length > 0)).toBe(true);
  });
});
