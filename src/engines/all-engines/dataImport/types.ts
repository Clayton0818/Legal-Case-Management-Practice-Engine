// Shared types for the firm data-import pipeline (c98). Nothing here touches
// the database — nothing in this file imports drizzle, @/db or @/tenancy.
//
// Design note (engine boundary, see src/engines/README.md): this module only
// ever produces NORMALIZED rows plus a dry-run report. It never writes into
// another engine's own tables (contacts/documents/calendar events go through
// @/core; matters, time entries, invoices and trust balances are handed off
// as `tasks` rows for the owning engine to pick up — see service.ts).

export type ImportSourceKind = "clio" | "mycase" | "spreadsheet";

/** What a staged row ultimately becomes. Trust balances get the most scrutiny (see reconciliation.ts). */
export const IMPORT_RECORD_KINDS = [
  "contact",
  "matter",
  "document",
  "calendar_event",
  "task",
  "time_entry",
  "invoice",
  "trust_balance",
] as const;
export type ImportRecordKind = (typeof IMPORT_RECORD_KINDS)[number];

export function isImportRecordKind(value: unknown): value is ImportRecordKind {
  return typeof value === "string" && (IMPORT_RECORD_KINDS as readonly string[]).includes(value);
}

/** One row exactly as read from the source, before any mapping. */
export interface RawImportRow {
  /** 1-based line/row number in the source file, for error messages. */
  rowNumber: number;
  /** Original column values, keyed by the source's own header text. */
  fields: Record<string, string>;
}

export type IssueSeverity = "error" | "warning";

export interface ImportIssue {
  rowNumber: number;
  recordKind: ImportRecordKind;
  /** Target field the issue is about, when it's about one field in particular. */
  field?: string;
  severity: IssueSeverity;
  /** Stable machine code, e.g. 'required_field_missing', 'unparseable_date'. */
  code: string;
  message: string;
}

/** The result of mapping + validating one raw row into one target shape. */
export interface MappedImportRow<T> {
  rowNumber: number;
  recordKind: ImportRecordKind;
  raw: RawImportRow;
  /** null when mapping failed hard enough that there's nothing usable to show. */
  mapped: T | null;
  issues: ImportIssue[];
}

export function hasErrors(issues: readonly ImportIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

export interface DryRunCounts {
  recordKind: ImportRecordKind;
  total: number;
  withErrors: number;
  withWarningsOnly: number;
  clean: number;
}

export interface DryRunReport {
  sourceKind: ImportSourceKind;
  generatedAt: string; // ISO timestamp — kept as a string so this type has no Date dependency
  counts: DryRunCounts[];
  issues: ImportIssue[];
  /** True only when every row across every kind is clean or warning-only. */
  readyToImport: boolean;
}

export function summarizeForDryRun<T>(
  sourceKind: ImportSourceKind,
  rows: readonly MappedImportRow<T>[],
  now: Date
): DryRunReport {
  const byKind = new Map<ImportRecordKind, MappedImportRow<T>[]>();
  for (const row of rows) {
    const list = byKind.get(row.recordKind) ?? [];
    list.push(row);
    byKind.set(row.recordKind, list);
  }
  const counts: DryRunCounts[] = [...byKind.entries()].map(([recordKind, rowsForKind]) => {
    const withErrors = rowsForKind.filter((r) => hasErrors(r.issues)).length;
    const withWarningsOnly = rowsForKind.filter((r) => !hasErrors(r.issues) && r.issues.length > 0).length;
    return {
      recordKind,
      total: rowsForKind.length,
      withErrors,
      withWarningsOnly,
      clean: rowsForKind.length - withErrors - withWarningsOnly,
    };
  });
  const issues = rows.flatMap((r) => r.issues);
  return {
    sourceKind,
    generatedAt: now.toISOString(),
    counts,
    issues,
    readyToImport: !issues.some((i) => i.severity === "error"),
  };
}
