// c106 — runs the seed one step at a time and records what happened.
//
// Each step runs in its own savepoint. Three outcomes:
//   ok       the real service did the work;
//   blocked  the service refused because an approval gate is still pending
//            (attorney / CPA / vendor sign-off). The PendingApprovalError is
//            caught INSIDE the savepoint, so the engine's own "approval.blocked"
//            audit row is kept — the demo shows the [PENDING … REVIEW]
//            placeholder instead of pretending the action happened;
//   failed   anything else. The savepoint is rolled back so the rest of the
//            seed can continue, and the failure is reported (the DB test
//            requires zero failures).

import { PendingApprovalError } from "@/compliance/approvals";
import type { TenantTx } from "@/tenancy/withTenant";

export type StepStatus = "ok" | "blocked" | "failed";

export interface StepRecord {
  key: string;
  area: string;
  status: StepStatus;
  /** For blocked steps: the visible placeholder; for failed: the error message. */
  detail: string | null;
  gate: string | null;
}

export interface SeedReport {
  seedVersion: string;
  startedAt: string;
  finishedAt: string | null;
  steps: StepRecord[];
  /** Ids of the demo's key records, for the walkthrough's deep links. */
  ids?: { matters: Record<string, string>; sessions: Record<string, string> };
}

export function summarizeReport(report: Pick<SeedReport, "steps">): Record<StepStatus, number> {
  const out: Record<StepStatus, number> = { ok: 0, blocked: 0, failed: 0 };
  for (const s of report.steps) out[s.status]++;
  return out;
}

/** Pure: classify a thrown error. */
export function classifyStepError(err: unknown): { status: "blocked" | "failed"; detail: string; gate: string | null } {
  if (err instanceof PendingApprovalError) return { status: "blocked", detail: err.placeholder, gate: err.gateKey };
  const message = err instanceof Error ? err.message : String(err);
  return { status: "failed", detail: message.slice(0, 500), gate: null };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; err: unknown };

export class SeedRunner {
  readonly steps: StepRecord[] = [];
  constructor(private readonly tx: TenantTx) {}

  /** Run one step. Returns the value, or null when it was blocked or failed. */
  async step<T>(area: string, key: string, fn: (tx: TenantTx) => Promise<T>): Promise<T | null> {
    let outcome: Outcome<T>;
    try {
      outcome = await this.tx.transaction(async (sp) => {
        try {
          return { ok: true as const, value: await fn(sp as unknown as TenantTx) };
        } catch (err) {
          // A pending gate is a JS-level refusal, not a database error: keep
          // the savepoint (and the engine's approval.blocked audit row).
          if (err instanceof PendingApprovalError) return { ok: false as const, err };
          throw err;
        }
      });
    } catch (err) {
      outcome = { ok: false, err };
    }
    if (outcome.ok) {
      this.steps.push({ key, area, status: "ok", detail: null, gate: null });
      return outcome.value;
    }
    const c = classifyStepError(outcome.err);
    if (process.env.DEMO_DEBUG) console.error(key, outcome.err);
    this.steps.push({ key, area, status: c.status, detail: c.detail, gate: c.gate });
    return null;
  }

  /** Record a step whose outcome the caller determined (e.g. a runGated result). */
  record(area: string, key: string, status: StepStatus, detail: string | null = null, gate: string | null = null): void {
    this.steps.push({ key, area, status, detail, gate });
  }
}
