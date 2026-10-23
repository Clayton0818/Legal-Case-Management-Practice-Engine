// Trust-balance reconciliation: the one check this whole card exists to get
// right. The card's own note is explicit — "Trust balances must reconcile
// to the penny against the old system before go-live, with CPA-reviewed
// sign-off." This module does the penny-for-penny comparison (pure, cents
// only, no floating point); the actual import of a trust balance into the
// ledger is a separate, gated step in service.ts — reconciling here never
// writes anything by itself.

import { requireApproval, type GateContext } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import type { NormalizedTrustBalance } from "./entities";

export interface OldSystemBalance {
  clientExternalId: string;
  matterExternalId?: string;
  reportedBalanceCents: number;
  asOfDate: Date;
}

export interface ReconciledMatch {
  clientExternalId: string;
  matterExternalId?: string;
  balanceCents: number;
}

export interface ReconciledMismatch {
  clientExternalId: string;
  matterExternalId?: string;
  importedBalanceCents: number | null;
  oldSystemBalanceCents: number | null;
  /** importedBalanceCents - oldSystemBalanceCents, null when one side is missing entirely. */
  differenceCents: number | null;
  reason: "missing_in_import" | "missing_in_old_system" | "amount_mismatch";
}

export interface TrustReconciliationResult {
  matches: ReconciledMatch[];
  mismatches: ReconciledMismatch[];
  /** True only when every old-system balance has an exact imported match and vice versa. */
  reconciled: boolean;
}

function balanceKey(clientExternalId: string, matterExternalId: string | undefined): string {
  return `${clientExternalId}::${matterExternalId ?? ""}`;
}

/**
 * Compare every imported trust balance against the old system's own report
 * for the same client/matter, to the penny. A row present on only one side
 * is a mismatch, never silently dropped or silently accepted — the dry-run
 * report (types.ts) surfaces every mismatch for a human to resolve before
 * go-live, exactly as the card requires.
 */
export function reconcileTrustBalances(
  imported: readonly NormalizedTrustBalance[],
  oldSystem: readonly OldSystemBalance[]
): TrustReconciliationResult {
  const importedByKey = new Map(imported.map((b) => [balanceKey(b.clientExternalId, b.matterExternalId), b]));
  const oldByKey = new Map(oldSystem.map((b) => [balanceKey(b.clientExternalId, b.matterExternalId), b]));

  const matches: ReconciledMatch[] = [];
  const mismatches: ReconciledMismatch[] = [];
  const seen = new Set<string>();

  for (const [key, importedBalance] of importedByKey) {
    seen.add(key);
    const oldBalance = oldByKey.get(key);
    if (!oldBalance) {
      mismatches.push({
        clientExternalId: importedBalance.clientExternalId,
        matterExternalId: importedBalance.matterExternalId,
        importedBalanceCents: importedBalance.balanceCents,
        oldSystemBalanceCents: null,
        differenceCents: null,
        reason: "missing_in_old_system",
      });
      continue;
    }
    if (importedBalance.balanceCents === oldBalance.reportedBalanceCents) {
      matches.push({ clientExternalId: importedBalance.clientExternalId, matterExternalId: importedBalance.matterExternalId, balanceCents: importedBalance.balanceCents });
    } else {
      mismatches.push({
        clientExternalId: importedBalance.clientExternalId,
        matterExternalId: importedBalance.matterExternalId,
        importedBalanceCents: importedBalance.balanceCents,
        oldSystemBalanceCents: oldBalance.reportedBalanceCents,
        differenceCents: importedBalance.balanceCents - oldBalance.reportedBalanceCents,
        reason: "amount_mismatch",
      });
    }
  }

  for (const [key, oldBalance] of oldByKey) {
    if (seen.has(key)) continue;
    mismatches.push({
      clientExternalId: oldBalance.clientExternalId,
      matterExternalId: oldBalance.matterExternalId,
      importedBalanceCents: null,
      oldSystemBalanceCents: oldBalance.reportedBalanceCents,
      differenceCents: null,
      reason: "missing_in_import",
    });
  }

  return { matches, mismatches, reconciled: mismatches.length === 0 };
}

/**
 * Gate for actually committing reconciled trust balances as opening ledger
 * entries. Reuses the shared `rules.trust_accounting` gate (attorney + CPA)
 * — c98 is not in that gate's `cardIds` list yet in src/compliance/gates.ts;
 * flagged as an open question in the card's doc rather than silently adding
 * this card's id to a shared file this engine doesn't own. Throws
 * PendingApprovalError until both reviewers have signed off.
 */
export function requireTrustBalanceImportApproval(context: GateContext = {}): void {
  requireApproval(RULE_GATES.trustAccounting.key, { ...context, action: context.action ?? "data_import.trust_balance_import" });
}
