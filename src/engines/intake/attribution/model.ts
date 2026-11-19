// c74 — lead-source attribution captured at intake. Pure types and
// classification logic only (no database, no I/O), so "which bucket does
// this lead belong to" is unit-testable on its own and reusable from the
// capture path, the report query layer and the admin page.
//
// See src/db/tables/intake.ts#intakeLeadAttribution for the stored shape and
// docs/go-to-market/lead-source-attribution.md for the model this
// implements.

/** What the capture path (API route, chat widget, inbound webhook) sends in. Every field is optional — attribution capture must never block an inquiry. */
export interface LeadAttributionInput {
  landingPage?: string | null;
  campaignTag?: string | null;
  isGoogleAds?: boolean;
  directoryName?: string | null;
  referralSource?: string | null;
  phoneTrackingNumber?: string | null;
}

/** The normalised shape stored (and read back) for one session. */
export interface LeadAttributionRecord {
  landingPage: string | null;
  campaignTag: string | null;
  isGoogleAds: boolean;
  directoryName: string | null;
  referralSource: string | null;
  phoneTrackingNumber: string | null;
}

/**
 * The buckets the funnel report groups by. Order here is also the
 * classification precedence in deriveAttributionSource: a Google Ads click
 * that also landed on a page with a campaign tag reports as 'google_ads',
 * not 'website' — the paid channel is the one marketing spent money on and
 * the one the report should credit.
 */
export const ATTRIBUTION_SOURCES = [
  "google_ads",
  "phone_tracking",
  "directory",
  "referral",
  "website",
  "other",
  "unknown",
] as const;
export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalise free-typed capture input before it is stored. Blanks collapse
 * to null; nothing here throws — a malformed or missing attribution field
 * should never be the reason an inquiry fails to save.
 */
export function normalizeLeadAttributionInput(input: LeadAttributionInput): LeadAttributionRecord {
  return {
    landingPage: clean(input.landingPage),
    campaignTag: clean(input.campaignTag),
    isGoogleAds: input.isGoogleAds === true,
    directoryName: clean(input.directoryName),
    referralSource: clean(input.referralSource),
    phoneTrackingNumber: normalizeTrackingNumber(input.phoneTrackingNumber),
  };
}

/**
 * Keeps digits and a leading '+' only; '' becomes null. This does not
 * validate a real phone number — it only produces a stable, comparable key
 * so the same number typed two different ways still groups together in
 * reports.
 */
export function normalizeTrackingNumber(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d+]/g, "");
  return digits || null;
}

/** True when every field is empty/false — i.e. nothing was actually captured. */
export function isEmptyAttribution(record: LeadAttributionRecord): boolean {
  return (
    record.landingPage === null &&
    record.campaignTag === null &&
    record.isGoogleAds === false &&
    record.directoryName === null &&
    record.referralSource === null &&
    record.phoneTrackingNumber === null
  );
}

/** Pick the single primary source bucket for a lead. See ATTRIBUTION_SOURCES for the precedence this follows. */
export function deriveAttributionSource(record: LeadAttributionRecord | null | undefined): AttributionSource {
  if (!record || isEmptyAttribution(record)) return "unknown";
  if (record.isGoogleAds) return "google_ads";
  if (record.phoneTrackingNumber) return "phone_tracking";
  if (record.directoryName) return "directory";
  if (record.referralSource) return "referral";
  if (record.landingPage || record.campaignTag) return "website";
  return "other";
}

/** A short, report-ready label for a source bucket, folding in the directory/referral/campaign name when there is one. */
export function describeAttributionSource(record: LeadAttributionRecord | null | undefined): string {
  const source = deriveAttributionSource(record);
  if (source === "directory" && record?.directoryName) return `Directory: ${record.directoryName}`;
  if (source === "referral" && record?.referralSource) return `Referral: ${record.referralSource}`;
  if (source === "website" && record?.campaignTag) return `Website: ${record.campaignTag}`;
  switch (source) {
    case "google_ads":
      return "Google Ads";
    case "phone_tracking":
      return "Phone tracking number";
    case "website":
      return "Website (organic)";
    case "other":
      return "Other";
    case "unknown":
      return "Unknown";
    default:
      return source;
  }
}
