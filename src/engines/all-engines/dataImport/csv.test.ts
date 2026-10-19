import { describe, expect, it } from "vitest";
import { parseCsv, readCsvWithHeader } from "./csv";

describe("parseCsv", () => {
  it("parses plain comma-separated rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas and newlines", () => {
    const text = 'name,note\n"Doe, Jane","Line one\nLine two"\n';
    expect(parseCsv(text)).toEqual([
      ["name", "note"],
      ["Doe, Jane", "Line one\nLine two"],
    ]);
  });

  it("handles escaped double quotes inside a quoted field", () => {
    const text = 'label\n"She said ""hi"""\n';
    expect(parseCsv(text)).toEqual([["label"], ['She said "hi"']]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops trailing blank rows but keeps a genuinely empty cell", () => {
    expect(parseCsv("a,b\n1,\n\n")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  it("returns an empty grid for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("readCsvWithHeader", () => {
  it("keys each row by the header, with 1-based row numbers starting after the header", () => {
    const result = readCsvWithHeader("Name,Email\nAna Lee,ana@example.com\nBo Kim,bo@example.com\n");
    expect(result.headers).toEqual(["Name", "Email"]);
    expect(result.rows).toEqual([
      { rowNumber: 2, fields: { Name: "Ana Lee", Email: "ana@example.com" } },
      { rowNumber: 3, fields: { Name: "Bo Kim", Email: "bo@example.com" } },
    ]);
    expect(result.malformedRowNumbers).toEqual([]);
  });

  it("flags rows whose cell count doesn't match the header, without dropping them", () => {
    const result = readCsvWithHeader("a,b,c\n1,2,3\n1,2\n");
    expect(result.malformedRowNumbers).toEqual([3]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]!.fields).toEqual({ a: "1", b: "2", c: "" });
  });

  it("trims header and cell whitespace", () => {
    const result = readCsvWithHeader(" Name , Email \n Ana , a@example.com \n");
    expect(result.headers).toEqual(["Name", "Email"]);
    expect(result.rows[0]!.fields).toEqual({ Name: "Ana", Email: "a@example.com" });
  });

  it("returns empty results for empty input", () => {
    expect(readCsvWithHeader("")).toEqual({ headers: [], rows: [], malformedRowNumbers: [] });
  });
});
