import { describe, expect, it } from "vitest";
import { mapRow, parseExportDate, parseMoneyToCents, suggestMapping } from "./mapping";
import type { ColumnMapping } from "./mapping";

interface Contact {
  name: string;
  email: string;
  balanceCents: number;
}

const CONTACT_MAPPING: ColumnMapping<Contact> = {
  name: { source: "Full Name", required: true },
  email: { source: "Email", required: true },
  balanceCents: { source: "Balance", required: true, parse: parseMoneyToCents },
};

describe("mapRow", () => {
  it("maps a clean row with no issues", () => {
    const { value, issues } = mapRow(
      { rowNumber: 2, fields: { "Full Name": "Ana Lee", Email: "ana@example.com", Balance: "1,234.50" } },
      "contact",
      CONTACT_MAPPING
    );
    expect(value).toEqual({ name: "Ana Lee", email: "ana@example.com", balanceCents: 123450 });
    expect(issues).toEqual([]);
  });

  it("reports a required field that's blank as an error", () => {
    const { value, issues } = mapRow(
      { rowNumber: 3, fields: { "Full Name": "", Email: "ana@example.com", Balance: "0" } },
      "contact",
      CONTACT_MAPPING
    );
    expect(value.name).toBeUndefined();
    expect(issues).toEqual([
      { rowNumber: 3, recordKind: "contact", field: "name", severity: "error", code: "required_field_missing", message: "'name' is required but was blank." },
    ]);
  });

  it("reports an unparseable required field as an error, and an unparseable optional field as a warning", () => {
    const optionalMapping: ColumnMapping<Contact> = { ...CONTACT_MAPPING, balanceCents: { source: "Balance", parse: parseMoneyToCents } };
    const { issues } = mapRow({ rowNumber: 4, fields: { "Full Name": "Bo", Email: "b@example.com", Balance: "not a number" } }, "contact", optionalMapping);
    expect(issues).toEqual([
      { rowNumber: 4, recordKind: "contact", field: "balanceCents", severity: "warning", code: "unparseable_value", message: 'Could not parse \'balanceCents\' from "not a number".' },
    ]);

    const { issues: requiredIssues } = mapRow({ rowNumber: 5, fields: { "Full Name": "Bo", Email: "b@example.com", Balance: "nope" } }, "contact", CONTACT_MAPPING);
    expect(requiredIssues[0]!.severity).toBe("error");
  });

  it("supports a function source for columns that need to be derived", () => {
    const mapping: ColumnMapping<{ fullAddress: string }> = {
      fullAddress: { source: (fields) => [fields["Street"], fields["City"]].filter(Boolean).join(", "), required: true },
    };
    const { value } = mapRow({ rowNumber: 2, fields: { Street: "1 Main St", City: "Austin" } }, "contact", mapping);
    expect(value.fullAddress).toBe("1 Main St, Austin");
  });
});

describe("parseMoneyToCents", () => {
  it.each([
    ["1234.56", 123456],
    ["$1,234.56", 123456],
    ["0", 0],
    ["(50.00)", -5000],
    ["4500", 450000],
  ])("parses %s to %i cents", (input, expected) => {
    expect(parseMoneyToCents(input)).toBe(expected);
  });

  it("returns undefined for non-numeric input", () => {
    expect(parseMoneyToCents("n/a")).toBeUndefined();
  });
});

describe("parseExportDate", () => {
  it("parses ISO dates", () => {
    expect(parseExportDate("2026-03-05")?.toISOString()).toBe("2026-03-05T00:00:00.000Z");
  });

  it("parses US M/D/YYYY dates", () => {
    expect(parseExportDate("3/5/2026")?.toISOString()).toBe("2026-03-05T00:00:00.000Z");
  });

  it("returns undefined for an invalid date", () => {
    expect(parseExportDate("13/40/2026")).toBeUndefined();
    expect(parseExportDate("not a date")).toBeUndefined();
  });
});

describe("suggestMapping", () => {
  it("finds an exact normalized match", () => {
    const result = suggestMapping(["Full Name", "E-Mail", "Phone"], [{ field: "email", synonyms: ["e-mail"] }]);
    expect(result).toEqual([{ field: "email", header: "E-Mail", confidence: 1 }]);
  });

  it("finds a partial match when no exact match exists", () => {
    const result = suggestMapping(["Client Full Name"], [{ field: "name" }]);
    expect(result[0]!.header).toBe("Client Full Name");
    expect(result[0]!.confidence).toBeGreaterThan(0);
    expect(result[0]!.confidence).toBeLessThan(1);
  });

  it("reports no match with zero confidence", () => {
    const result = suggestMapping(["Unrelated Column"], [{ field: "trustBalance" }]);
    expect(result).toEqual([{ field: "trustBalance", header: null, confidence: 0 }]);
  });
});
