import { describe, expect, it } from "vitest";
import { csvEscapeField, toCsv } from "./csvExport";

describe("csvEscapeField", () => {
  it("leaves plain fields unquoted", () => {
    expect(csvEscapeField("family")).toBe("family");
    expect(csvEscapeField(12)).toBe("12");
    expect(csvEscapeField(null)).toBe("");
    expect(csvEscapeField(undefined)).toBe("");
  });

  it("quotes and escapes fields containing commas, quotes or newlines", () => {
    expect(csvEscapeField("Smith, John")).toBe('"Smith, John"');
    expect(csvEscapeField('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvEscapeField("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("toCsv", () => {
  it("renders a header row and data rows with CRLF line endings", () => {
    const out = toCsv(
      ["stage", "count"],
      [
        ["retained", 3],
        ["prospective", 5],
      ]
    );
    expect(out).toBe("stage,count\r\nretained,3\r\nprospective,5\r\n");
  });

  it("escapes values that need it inside a row", () => {
    const out = toCsv(["name"], [["Doe, Jane"]]);
    expect(out).toBe('name\r\n"Doe, Jane"\r\n');
  });

  it("renders an empty data set as just the header row", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\r\n");
  });
});
