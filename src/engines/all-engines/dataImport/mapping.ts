// Generic "turn a raw CSV row into a typed object" mapper, plus a fuzzy
// header-to-field suggester for the spreadsheet adapter (staff mapping an
// arbitrary export has no fixed header set to rely on). Pure functions only.

import { normalizeName } from "@/core";
import type { ImportIssue, ImportRecordKind, RawImportRow } from "./types";

/** Either a literal source column name, or a function that reads the raw row directly. */
export type FieldSource<T> = string | ((fields: Record<string, string>) => T | undefined);

export interface FieldSpec<T> {
  source: FieldSource<T>;
  required?: boolean;
  /** Parse/validate the raw string. Returning undefined means "couldn't parse"; throwing is also treated as that. */
  parse?: (raw: string) => T | undefined;
}

export type ColumnMapping<T extends object> = {
  [K in keyof T]: FieldSpec<T[K]>;
};

export interface MapRowResult<T> {
  value: Partial<T>;
  issues: ImportIssue[];
}

/**
 * Apply a ColumnMapping to one raw row. Never throws: a field whose `parse`
 * throws is recorded as an error issue for that field instead.
 */
export function mapRow<T extends object>(
  row: RawImportRow,
  recordKind: ImportRecordKind,
  mapping: ColumnMapping<T>
): MapRowResult<T> {
  const value: Partial<T> = {};
  const issues: ImportIssue[] = [];

  for (const key of Object.keys(mapping) as (keyof T)[]) {
    const spec = mapping[key];
    let rawValue: unknown;
    if (typeof spec.source === "string") {
      rawValue = row.fields[spec.source];
    } else {
      rawValue = spec.source(row.fields);
    }

    const rawString = typeof rawValue === "string" ? rawValue : rawValue == null ? "" : String(rawValue);
    const isBlank = rawString.trim().length === 0;

    if (isBlank) {
      if (spec.required) {
        issues.push({
          rowNumber: row.rowNumber,
          recordKind,
          field: String(key),
          severity: "error",
          code: "required_field_missing",
          message: `'${String(key)}' is required but was blank.`,
        });
      }
      continue;
    }

    if (!spec.parse) {
      value[key] = rawString as unknown as T[keyof T];
      continue;
    }

    try {
      const parsed = spec.parse(rawString);
      if (parsed === undefined) {
        issues.push({
          rowNumber: row.rowNumber,
          recordKind,
          field: String(key),
          severity: spec.required ? "error" : "warning",
          code: "unparseable_value",
          message: `Could not parse '${String(key)}' from "${rawString}".`,
        });
        continue;
      }
      value[key] = parsed;
    } catch (err) {
      issues.push({
        rowNumber: row.rowNumber,
        recordKind,
        field: String(key),
        severity: spec.required ? "error" : "warning",
        code: "unparseable_value",
        message: `Error parsing '${String(key)}' from "${rawString}": ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { value, issues };
}

// ---------------------------------------------------------------------------
// Common field parsers, shared across adapters
// ---------------------------------------------------------------------------

/** Parses a plain decimal amount ("1,234.56", "$1234.56", "(50.00)" for negative) into integer cents. */
export function parseMoneyToCents(raw: string): number | undefined {
  const trimmed = raw.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const amount = Math.round(parseFloat(cleaned) * 100);
  if (!Number.isFinite(amount)) return undefined;
  return negative ? -Math.abs(amount) : amount;
}

/** Parses a handful of common export date formats (ISO, M/D/YYYY, YYYY-MM-DD) into a Date at UTC midnight. */
export function parseExportDate(raw: string): Date | undefined {
  const trimmed = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (us) {
    const [, m, d, y] = us;
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    return new Date(Date.UTC(Number(y), month - 1, day));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fuzzy header suggestion (spreadsheet adapter: no fixed header set to rely on)
// ---------------------------------------------------------------------------

export interface TargetFieldHint {
  field: string;
  /** Extra header words/phrases that should also match this field, e.g. "e-mail" for 'email'. */
  synonyms?: string[];
}

export interface MappingSuggestion {
  field: string;
  header: string | null;
  /** 0..1 confidence; 1 is an exact normalized match, lower is a partial/substring match. */
  confidence: number;
}

function normalizeHeader(text: string): string {
  return normalizeName(text.replace(/[_-]/g, " "));
}

/**
 * Suggest which source header best matches each target field, for staff to
 * confirm or correct — this never auto-applies a mapping, it only proposes
 * one. Confidence 0 means no header looked like a plausible match.
 */
export function suggestMapping(headers: readonly string[], targets: readonly TargetFieldHint[]): MappingSuggestion[] {
  const normalizedHeaders = headers.map((h) => ({ header: h, normalized: normalizeHeader(h) }));

  return targets.map((target) => {
    const candidates = [normalizeHeader(target.field), ...(target.synonyms ?? []).map(normalizeHeader)];

    let best: MappingSuggestion = { field: target.field, header: null, confidence: 0 };
    for (const { header, normalized } of normalizedHeaders) {
      for (const candidate of candidates) {
        if (!candidate) continue;
        let confidence = 0;
        if (normalized === candidate) confidence = 1;
        else if (normalized.includes(candidate) || candidate.includes(normalized)) confidence = 0.6;
        if (confidence > best.confidence) best = { field: target.field, header, confidence };
      }
    }
    return best;
  });
}
