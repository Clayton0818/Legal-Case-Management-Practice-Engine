// A small, dependency-free CSV parser and header-aware row reader. Pure
// functions only — no file-system or network access here. Handles the
// RFC-4180 bits real exports actually use: quoted fields, escaped quotes
// (""), commas and newlines inside quotes, and both \r\n and \n line endings.

import type { RawImportRow } from "./types";

/** Parse raw CSV text into a grid of string cells. Trailing blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      // Lone \r or \r\n: treat as a row break either way.
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Final field/row, unless the text ended cleanly on a row break.
  if (field.length > 0 || row.length > 0) pushRow();

  // Drop wholly-blank trailing rows (common after a trailing newline).
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c === "")) rows.pop();
  return rows;
}

export interface CsvReadResult {
  headers: string[];
  rows: RawImportRow[];
  /** Rows whose cell count didn't match the header — reported, not silently padded or dropped. */
  malformedRowNumbers: number[];
}

/**
 * Read CSV text as header-keyed rows. `rowNumber` is 1-based and counts the
 * header row, so it lines up with what a person sees opening the file in a
 * spreadsheet (header = row 1, first data row = row 2).
 */
export function readCsvWithHeader(text: string): CsvReadResult {
  const grid = parseCsv(text);
  if (grid.length === 0) return { headers: [], rows: [], malformedRowNumbers: [] };
  const headers = grid[0]!.map((h) => h.trim());
  const rows: RawImportRow[] = [];
  const malformedRowNumbers: number[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!;
    const rowNumber = r + 1;
    if (cells.length !== headers.length) malformedRowNumbers.push(rowNumber);
    const fields: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      fields[headers[c]!] = (cells[c] ?? "").trim();
    }
    rows.push({ rowNumber, fields });
  }
  return { headers, rows, malformedRowNumbers };
}
