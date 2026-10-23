import { describe, expect, it } from "vitest";
import { mapRow } from "../mapping";
import { CLIO_CONTACT_MAPPING, CLIO_MATTER_MAPPING, CLIO_TRUST_BALANCE_MAPPING } from "./clio";
import { MYCASE_CONTACT_MAPPING, MYCASE_MATTER_MAPPING } from "./myCase";
import { buildSpreadsheetMapping, suggestSpreadsheetMapping, SPREADSHEET_TARGET_HINTS } from "./spreadsheet";

describe("Clio adapter", () => {
  it("maps an individual contact, preferring first+last name", () => {
    const { value, issues } = mapRow(
      { rowNumber: 2, fields: { "Display Number": "C-1", Type: "Person", "First Name": "Ana", "Last Name": "Lee", "Company Name": "", Email: "ana@example.com", "Phone Number": "555-0100" } },
      "contact",
      CLIO_CONTACT_MAPPING
    );
    expect(issues).toEqual([]);
    expect(value).toEqual({ externalId: "C-1", fullName: "Ana Lee", email: "ana@example.com", phone: "555-0100", isOrganization: false });
  });

  it("maps an organization contact, preferring company name over person name", () => {
    const { value } = mapRow(
      { rowNumber: 3, fields: { "Display Number": "C-2", Type: "Company", "First Name": "", "Last Name": "", "Company Name": "Acme Holdings", Email: "", "Phone Number": "" } },
      "contact",
      CLIO_CONTACT_MAPPING
    );
    expect(value.fullName).toBe("Acme Holdings");
    expect(value.isOrganization).toBe(true);
  });

  it("flags a contact with no usable name as an error", () => {
    const { issues } = mapRow({ rowNumber: 4, fields: { "Display Number": "C-3" } }, "contact", CLIO_CONTACT_MAPPING);
    expect(issues).toEqual([
      { rowNumber: 4, recordKind: "contact", field: "fullName", severity: "error", code: "required_field_missing", message: "'fullName' is required but was blank." },
    ]);
  });

  it("maps a matter row", () => {
    const { value, issues } = mapRow(
      { rowNumber: 2, fields: { "Display Number": "M-1", "Client Display Number": "C-1", "Matter Description": "Smith v. Jones", "Practice Area": "Family", Status: "Open", "Open Date": "2026-01-15" } },
      "matter",
      CLIO_MATTER_MAPPING
    );
    expect(issues).toEqual([]);
    expect(value.matterName).toBe("Smith v. Jones");
    expect(value.openedAt?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("maps a trust balance row to integer cents", () => {
    const { value, issues } = mapRow(
      { rowNumber: 2, fields: { "Client Display Number": "C-1", "Matter Display Number": "M-1", "Trust Balance": "4,500.00", "As Of Date": "2026-10-01" } },
      "trust_balance",
      CLIO_TRUST_BALANCE_MAPPING
    );
    expect(issues).toEqual([]);
    expect(value.balanceCents).toBe(450000);
  });
});

describe("MyCase adapter", () => {
  it("maps an individual contact", () => {
    const { value } = mapRow({ rowNumber: 2, fields: { "Contact ID": "1", "First Name": "Bo", "Last Name": "Kim", Company: "", Email: "bo@example.com", Phone: "555-0200" } }, "contact", MYCASE_CONTACT_MAPPING);
    expect(value.fullName).toBe("Bo Kim");
    expect(value.isOrganization).toBe(false);
  });

  it("maps a matter/case row", () => {
    const { value, issues } = mapRow(
      { rowNumber: 2, fields: { "Case Number": "2026-001", Client: "Bo Kim", "Case Name": "Kim Custody Matter", "Practice Area": "Family", Status: "Open", "Open Date": "1/15/2026" } },
      "matter",
      MYCASE_MATTER_MAPPING
    );
    expect(issues).toEqual([]);
    expect(value.matterName).toBe("Kim Custody Matter");
  });
});

describe("spreadsheet adapter", () => {
  it("suggests a plausible mapping from arbitrary headers", () => {
    const suggestions = suggestSpreadsheetMapping(["Client Name", "E-Mail", "Phone Number"], SPREADSHEET_TARGET_HINTS.contact);
    expect(suggestions.find((s) => s.field === "email")).toEqual({ field: "email", header: "E-Mail" });
    expect(suggestions.find((s) => s.field === "fullName")).toEqual({ field: "fullName", header: "Client Name" });
  });

  it("builds a working ColumnMapping from staff-confirmed headers", () => {
    const mapping = buildSpreadsheetMapping<{ fullName: string; email?: string }>(
      [
        { field: "fullName", header: "Client Name" },
        { field: "email", header: "E-Mail" },
      ],
      ["fullName"]
    );
    const { value, issues } = mapRow({ rowNumber: 2, fields: { "Client Name": "Cy Ortiz", "E-Mail": "cy@example.com" } }, "contact", mapping);
    expect(issues).toEqual([]);
    expect(value).toEqual({ fullName: "Cy Ortiz", email: "cy@example.com" });
  });

  it("leaves a field unmapped (and so unvalidated here) when staff didn't confirm a header for it", () => {
    const mapping = buildSpreadsheetMapping<{ fullName: string; email?: string }>([{ field: "fullName", header: "Client Name" }], ["fullName"]);
    expect(Object.keys(mapping)).toEqual(["fullName"]);
  });
});
