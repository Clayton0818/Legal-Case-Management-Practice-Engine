import { describe, expect, it, beforeEach } from "vitest";
import { reconcileTrustBalances, requireTrustBalanceImportApproval } from "./reconciliation";
import { resetApprovalStateForTests, InMemoryApprovalSource, setApprovalSource, ensureApprovalsLoaded } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";

const DATE = new Date("2026-10-01");

describe("reconcileTrustBalances", () => {
  it("matches identical balances to the penny", () => {
    const result = reconcileTrustBalances(
      [{ clientExternalId: "C-1", balanceCents: 450000, asOfDate: DATE }],
      [{ clientExternalId: "C-1", reportedBalanceCents: 450000, asOfDate: DATE }]
    );
    expect(result).toEqual({ matches: [{ clientExternalId: "C-1", matterExternalId: undefined, balanceCents: 450000 }], mismatches: [], reconciled: true });
  });

  it("flags a one-cent difference as a mismatch, not a rounding pass", () => {
    const result = reconcileTrustBalances(
      [{ clientExternalId: "C-1", balanceCents: 450001, asOfDate: DATE }],
      [{ clientExternalId: "C-1", reportedBalanceCents: 450000, asOfDate: DATE }]
    );
    expect(result.reconciled).toBe(false);
    expect(result.mismatches[0]).toMatchObject({ reason: "amount_mismatch", differenceCents: 1 });
  });

  it("flags a balance present only in the old system", () => {
    const result = reconcileTrustBalances([], [{ clientExternalId: "C-1", reportedBalanceCents: 100, asOfDate: DATE }]);
    expect(result.mismatches[0]).toMatchObject({ reason: "missing_in_import" });
  });

  it("flags a balance present only in the import", () => {
    const result = reconcileTrustBalances([{ clientExternalId: "C-1", balanceCents: 100, asOfDate: DATE }], []);
    expect(result.mismatches[0]).toMatchObject({ reason: "missing_in_old_system" });
  });

  it("keys client+matter balances separately, not just by client", () => {
    const result = reconcileTrustBalances(
      [
        { clientExternalId: "C-1", matterExternalId: "M-1", balanceCents: 100, asOfDate: DATE },
        { clientExternalId: "C-1", matterExternalId: "M-2", balanceCents: 200, asOfDate: DATE },
      ],
      [
        { clientExternalId: "C-1", matterExternalId: "M-1", reportedBalanceCents: 100, asOfDate: DATE },
        { clientExternalId: "C-1", matterExternalId: "M-2", reportedBalanceCents: 999, asOfDate: DATE },
      ]
    );
    expect(result.matches).toHaveLength(1);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!.matterExternalId).toBe("M-2");
  });
});

describe("requireTrustBalanceImportApproval", () => {
  beforeEach(() => {
    resetApprovalStateForTests();
  });

  it("throws PendingApprovalError when the shared trust-accounting gate isn't approved", async () => {
    await ensureApprovalsLoaded(0);
    expect(() => requireTrustBalanceImportApproval({ tenantId: "t1" })).toThrow(/pending/i);
  });

  it("passes once both attorney and CPA sign-off are on record", async () => {
    const source = new InMemoryApprovalSource();
    source.approve({ gateKey: RULE_GATES.trustAccounting.key, reviewerKind: "attorney", approvedByName: "A. Attorney" });
    source.approve({ gateKey: RULE_GATES.trustAccounting.key, reviewerKind: "cpa", approvedByName: "C. Accountant" });
    setApprovalSource(source);
    await ensureApprovalsLoaded(0);
    expect(() => requireTrustBalanceImportApproval({ tenantId: "t1" })).not.toThrow();
  });
});
