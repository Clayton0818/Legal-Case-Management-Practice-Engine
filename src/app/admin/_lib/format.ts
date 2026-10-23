// Small presentation helpers shared by the admin console's server
// components and its API route error messages. No database access here —
// pure formatting only.

export function formatEnumLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatFieldLabel(key: string): string {
  const withSpaces = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return withSpaces
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Collected intake answers are a jsonb blob with no fixed shape (they
// depend on the firm's config version and which flow branches ran). This
// renders any top-level value as readable text instead of a raw JSON dump,
// falling back to JSON only for values that are themselves objects/arrays.
export function formatAnswerValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      return value.join(", ") || "—";
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

// Espresso & champagne theme: status pills carry a small leading dot (a
// ::before pseudo-element), so the same class string works on any
// `inline-flex items-center rounded-full` span without markup changes.
const DOT = "before:mr-1.5 before:inline-block before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full";
const PILL = {
  // Cool slate-blue: early / in-progress intake.
  intake: `bg-[#EAEFF3] text-[#2C4256] ${DOT} before:bg-[#5A7A94]`,
  // Warm gold: needs a person's attention.
  review: `bg-[#F7EEDC] text-[#6B4614] ${DOT} before:bg-[#C08A3E]`,
  // Green: good outcome.
  good: `bg-[#E5F1E8] text-[#23502F] ${DOT} before:bg-[#3F8A57]`,
  // Muted red: declined / definite conflict.
  bad: `bg-[#F6E3DF] text-[#7A2A1E] ${DOT} before:bg-[#B5503F]`,
  // Neutral: ended without a matter.
  neutral: `bg-slate-100 text-slate-600 ${DOT} before:bg-slate-400`,
} as const;

const STAGE_BADGE_CLASSES: Record<string, string> = {
  prospective: PILL.intake,
  consultation_scheduled: PILL.intake,
  consult_completed_manual_follow_up: PILL.review,
  pending_review: PILL.review,
  did_not_schedule: PILL.neutral,
  did_not_hire_referred_out: PILL.neutral,
  declined_conflict: PILL.bad,
  retained: PILL.good,
  closed: PILL.neutral,
};

export function stageBadgeClass(stage: string): string {
  return STAGE_BADGE_CLASSES[stage] ?? PILL.neutral;
}

const CONFLICT_OUTCOME_BADGE_CLASSES: Record<string, string> = {
  clear: PILL.good,
  possible: PILL.review,
  definite: PILL.bad,
};

export function conflictOutcomeBadgeClass(outcome: string): string {
  return CONFLICT_OUTCOME_BADGE_CLASSES[outcome] ?? PILL.neutral;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}
