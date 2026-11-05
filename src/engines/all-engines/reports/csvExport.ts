// Small, dependency-free CSV writer for the cross-engine reports (c101).
// Mirrors the parsing conventions in ../dataImport/csv.ts (RFC-4180 quoting)
// but in the write direction, which that module doesn't provide. Pure.

export function csvEscapeField(value: string | number | boolean | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render headers + rows as CSV text (CRLF line endings, trailing CRLF). Pure. */
export function toCsv(headers: readonly string[], rows: readonly (string | number | boolean | null | undefined)[][]): string {
  const lines = [headers.map(csvEscapeField).join(","), ...rows.map((row) => row.map(csvEscapeField).join(","))];
  return lines.join("\r\n") + "\r\n";
}
