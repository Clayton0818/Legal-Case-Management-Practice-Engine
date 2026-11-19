// c122 — the staff console's "New intake" form and guided intake page.
//
// Pure rules only. The engine already enforces every step (c65, c69, c72):
// this module decides what a staff member should see next, and validates
// the new-intake form before anything is written. It adds no shortcut: a
// staff-entered intake goes through the same disclosures, conflict check
// and case-details lock as every other channel.

import { isPracticeAreaId } from "@/core/practiceAreas";
import { normalizeEmail, normalizePhone, type IntakeChannel, type LockReason } from "../channels/records";
import { IntakeValidationError } from "../common/errors";
import type { ConflictState } from "../adapters/conflictStatus";

/**
 * Channels the "New intake" form offers. 'phone_staff' is deliberately not
 * offered: it means a call through the firm's phone system, which starts
 * with recording consent pending (c65 rule 5). A call a lawyer took on
 * their own phone is entered as 'phone_manual'.
 */
export const NEW_INTAKE_CHANNELS = ["walk_in", "phone_manual"] as const satisfies readonly IntakeChannel[];
export type NewIntakeChannel = (typeof NEW_INTAKE_CHANNELS)[number];

export const NEW_INTAKE_CHANNEL_LABEL: Record<NewIntakeChannel, string> = {
  walk_in: "In person (walk-in, courthouse, meeting)",
  phone_manual: "Phone call, entered by hand",
};

export interface NewIntakeInput {
  channel: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  language?: string | null;
}

export interface CleanNewIntake {
  channel: NewIntakeChannel;
  name: string;
  email: string | null;
  phone: string | null;
  language: "en" | "es";
}

/** Validate and normalise the form. Returns the errors to show, or the clean input. Pure. */
export function validateNewIntake(input: NewIntakeInput): { ok: true; value: CleanNewIntake } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const channel = (NEW_INTAKE_CHANNELS as readonly string[]).includes(input.channel) ? (input.channel as NewIntakeChannel) : null;
  if (!channel) errors.push("Choose how the person reached the firm.");
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) errors.push("The person's name is required.");
  const rawEmail = input.email?.trim() ?? "";
  const rawPhone = input.phone?.trim() ?? "";
  const email = normalizeEmail(rawEmail);
  const phone = normalizePhone(rawPhone);
  if (rawEmail && !email) errors.push("That email address doesn't look right.");
  if (rawPhone && !phone) errors.push("That phone number doesn't look right.");
  if (!email && !phone && !rawEmail && !rawPhone) errors.push("Add a phone number or an email address so the firm can reach them.");
  const language = input.language === "es" ? "es" : "en";
  if (errors.length > 0 || !channel) return { ok: false, errors };
  return { ok: true, value: { channel, name, email, phone, language } };
}

/**
 * The guided steps on the intake page, in the order the engine enforces
 * them. Recording the first human contact (c69) is not one of them: it can
 * happen at any point, and for a staff-entered intake it usually already
 * has, so the page offers it separately.
 */
export const STAFF_STEPS = ["disclosures", "conflict_names", "conflict_check", "case_details"] as const;
export type StaffStep = (typeof STAFF_STEPS)[number];

export type StepStatus = "done" | "current" | "waiting" | "blocked" | "upcoming";

export interface StaffStepView {
  step: StaffStep;
  status: StepStatus;
  /** One plain sentence for the staff member. */
  detail: string;
}

export interface StaffIntakeFacts {
  status: string;
  disclosuresAcknowledgedAt: Date | null;
  conflictMinimum: { fullName?: string; otherPartyNames?: string[] };
  conflictCheckRequestedAt: Date | null;
  conflictState: ConflictState;
  caseDetailsRecorded: boolean;
}

const CLEARED: readonly ConflictState[] = ["clear", "attorney_cleared"];

const STEP_TEXT: Record<StaffStep, { done: string; now: string }> = {
  disclosures: { done: "Disclosures read aloud and recorded.", now: "Read the disclosures to the person, then record that you did." },
  conflict_names: { done: "Names for the conflict check recorded.", now: "Enter the person's name and the other side's names. No case details yet." },
  conflict_check: { done: "No conflict found.", now: "Runs automatically once the names are in." },
  case_details: { done: "Case details recorded.", now: "Record what the person needs help with." },
};

/**
 * Where each step stands. At most one step is actionable ('current') or
 * holding everything up ('waiting' or 'blocked'); every step after it is
 * 'upcoming'. A closed intake has nothing current. Pure.
 */
export function deriveStaffSteps(f: StaffIntakeFacts): StaffStepView[] {
  const closed = f.status === "closed" || f.status === "not_an_inquiry";
  const pause = f.status === "paused_emergency" ? "Paused for an emergency alert. Acknowledge the alert in the emergency queue first." : null;
  const namesDone = Boolean(f.conflictMinimum.fullName?.trim()) && Array.isArray(f.conflictMinimum.otherPartyNames);
  let open = !closed;
  const views: StaffStepView[] = [];

  const actionable = (step: StaffStep, done: boolean) => {
    if (done) return views.push({ step, status: "done", detail: STEP_TEXT[step].done });
    if (!open) return views.push({ step, status: "upcoming", detail: STEP_TEXT[step].now });
    open = false;
    return views.push(pause ? { step, status: "blocked", detail: pause } : { step, status: "current", detail: STEP_TEXT[step].now });
  };
  const holding = (status: "waiting" | "blocked", detail: string) => {
    if (!open) return views.push({ step: "conflict_check", status: "upcoming", detail: STEP_TEXT.conflict_check.now });
    open = false;
    return views.push({ step: "conflict_check", status, detail });
  };

  actionable("disclosures", Boolean(f.disclosuresAcknowledgedAt));
  actionable("conflict_names", namesDone);

  if (CLEARED.includes(f.conflictState)) {
    views.push({ step: "conflict_check", status: "done", detail: f.conflictState === "attorney_cleared" ? "A lawyer cleared a possible conflict." : STEP_TEXT.conflict_check.done });
  } else if (f.conflictState === "declined" || f.conflictState === "definite") {
    holding("blocked", "Conflicted out. The firm can't take this inquiry; it closes with the neutral non-engagement letter (c62).");
  } else if (f.conflictState === "possible_pending") {
    holding("waiting", "Possible conflict. It's with the conflicts attorney, and nothing else happens until they decide.");
  } else if (namesDone || f.conflictCheckRequestedAt) {
    holding("waiting", "The conflict check is running. Refresh this page in a minute.");
  } else {
    views.push({ step: "conflict_check", status: "upcoming", detail: STEP_TEXT.conflict_check.now });
  }

  actionable("case_details", f.caseDetailsRecorded);
  return views;
}

/** Plain-language reasons for a locked case-details step (c65). Pure. */
export const LOCK_REASON_LABEL: Record<LockReason, string> = {
  disclosures_not_acknowledged: "The disclosures haven't been recorded yet.",
  conflict_minimum_missing: "The names for the conflict check aren't in yet.",
  conflict_check_not_run: "The conflict check hasn't come back yet.",
  conflict_not_clear: "The conflict check isn't clear.",
  emergency_pause: "The intake is paused for an emergency alert.",
};

/** "Ana Smith, Bob Smith" / "ana smith; bob smith" → names, trimmed, de-duplicated. Pure. */
export function parseOtherPartyNames(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n;,]+/)) {
    const name = part.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Fields a staff member may record as case details from the guided page. */
export const STAFF_CASE_DETAIL_FIELDS = ["practiceArea", "practiceAreaFreeText", "county"] as const;

/**
 * Keep only the case-detail fields the guided page may set, trimmed and
 * non-empty. A practice area must be one of the firm-level pack ids
 * (family, immigration, personal_injury). Throws on anything invalid
 * rather than silently dropping it.
 */
export function pickStaffCaseDetails(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of STAFF_CASE_DETAIL_FIELDS) {
    const v = raw[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") throw new IntakeValidationError(`'${key}' must be text.`);
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (key === "practiceArea" && !isPracticeAreaId(trimmed)) throw new IntakeValidationError("Choose one of the firm's practice areas.");
    if (trimmed.length > 2000) throw new IntakeValidationError(`'${key}' is too long (2,000 characters at most).`);
    out[key] = trimmed;
  }
  if (Object.keys(out).length === 0) throw new IntakeValidationError("Enter at least one case detail.");
  return out;
}
