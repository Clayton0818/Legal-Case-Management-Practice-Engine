// The normalized shapes every adapter (Clio, MyCase, spreadsheet) maps its
// source rows into. Deliberately a subset of what @/core and the owning
// engines eventually need — service.ts hands these off rather than writing
// into another engine's tables directly (src/engines/README.md boundary).

export interface NormalizedContact {
  /** The source system's own id for this record, kept for de-duplication and audit — never shown to a client. */
  externalId?: string;
  fullName: string;
  email?: string;
  phone?: string;
  isOrganization?: boolean;
}

export interface NormalizedMatter {
  externalId?: string;
  /** externalId of the contact this matter belongs to — resolved to a real contact id during execute. */
  clientExternalId: string;
  matterName: string;
  practiceArea?: string;
  openedAt?: Date;
  status?: string;
}

export interface NormalizedCalendarEvent {
  externalId?: string;
  matterExternalId?: string;
  title: string;
  startsAt: Date;
  endsAt?: Date;
}

export interface NormalizedTimeEntry {
  externalId?: string;
  matterExternalId: string;
  date: Date;
  hours: number;
  rateCents?: number;
  description?: string;
}

export interface NormalizedInvoice {
  externalId?: string;
  matterExternalId: string;
  invoiceDate: Date;
  totalCents: number;
  status?: string;
}

/**
 * A trust balance as reported by the OLD system, as of a given date. This is
 * the single most sensitive record kind in the whole pipeline — see
 * reconciliation.ts: it is never written anywhere without first matching the
 * old system's own report to the penny, and the write itself is gated on
 * `rules.trust_accounting` (attorney + CPA).
 */
export interface NormalizedTrustBalance {
  clientExternalId: string;
  matterExternalId?: string;
  balanceCents: number;
  asOfDate: Date;
}
