// c76 — Trust accounting overview: what the ledger is waiting on (attorney +
// CPA review), and each trust bank account's book balance against the sum of
// its client ledgers. Read-only; posting and reconciling go through the
// gated API under /api/billing-trust.

import Link from "next/link";
import { gateStatus } from "@/compliance/approvals";
import { TRUST_DEPENDENCY_GATE_KEYS } from "@/engines/billing-trust/gates";
import { listTrustAccounts } from "@/engines/billing-trust/ledgerService";
import { trustRuleValues } from "@/engines/billing-trust/rules";
import { PageHeader, SectionTitle, StatusPill } from "../_components/ui";
import { loadTrustPage, Money, Notice, Table, Td, Th } from "./_lib/data";

export const dynamic = "force-dynamic";

export default async function TrustOverviewPage() {
  const data = await loadTrustPage((tx, tenantId) => listTrustAccounts(tx, tenantId));
  const gates = TRUST_DEPENDENCY_GATE_KEYS.map((key) => gateStatus(key));
  const rules = trustRuleValues();
  const trustGate = gates[0]!;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Billing & trust"
        title="Client trust accounts"
        description={
          <>
            Every client&apos;s money is tracked per matter. Ledgers can never go below zero, one client&apos;s money never covers another&apos;s,
            and entries are never edited — corrections are reversing entries.
          </>
        }
      />

      {!trustGate.approved && (
        <Notice
          message={`Posting trust entries and closing months is blocked until the trust-accounting rules are reviewed (waiting: ${trustGate.pendingReviewers.join(
            " + "
          )}). Viewing ledgers, entering statements and preparing reconciliations still work.`}
        />
      )}

      <section>
        <SectionTitle>Accounts</SectionTitle>
        {!data.ok ? (
          <Notice message={data.message} />
        ) : data.value.length === 0 ? (
          <p className="text-sm text-slate-600">
            No trust accounts yet. An owner or bookkeeper registers one with <code>POST /api/billing-trust/accounts</code>.
          </p>
        ) : (
          <Table
            head={
              <>
                <Th>Account</Th>
                <Th right>Book balance</Th>
                <Th right>Sum of client ledgers</Th>
                <Th>Agree</Th>
                <Th>Closed through</Th>
              </>
            }
          >
            {data.value.map((a) => (
              <tr key={a.account.id}>
                <Td>
                  <Link className="font-semibold text-champagne-ink underline-offset-4 hover:underline" href={`/admin/billing-trust/accounts/${a.account.id}`}>
                    {a.account.name}
                  </Link>
                  <div className="text-xs text-slate-500">
                    {a.account.bankName} ••{a.account.accountNumberLast4} · {a.account.accountType.toUpperCase()} · {a.account.status}
                  </div>
                </Td>
                <Td right>
                  <Money cents={a.bookBalance} />
                </Td>
                <Td right>
                  <Money cents={a.clientLedgerTotal} />
                </Td>
                <Td>
                  {a.bookBalance === a.clientLedgerTotal ? (
                    <StatusPill tone="success">Yes</StatusPill>
                  ) : (
                    <StatusPill tone="danger">NO — investigate now</StatusPill>
                  )}
                </Td>
                <Td>{a.closedPeriod ?? "No month closed yet"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle>Reviews this ledger depends on</SectionTitle>
        <Table
          head={
            <>
              <Th>What</Th>
              <Th>Gate</Th>
              <Th>Status</Th>
            </>
          }
        >
          {gates.map((g) => (
            <tr key={g.gate.key}>
              <Td>{g.gate.description}</Td>
              <Td mono>{g.gate.key}</Td>
              <Td>
                {g.approved ? (
                  <StatusPill tone="success">Approved</StatusPill>
                ) : (
                  <StatusPill tone="warning">Waiting: {g.pendingReviewers.join(", ")}</StatusPill>
                )}
              </Td>
            </tr>
          ))}
        </Table>
        <p className="text-xs leading-relaxed text-slate-500">
          Rule values {rules.approved ? "(approved)" : "(PROPOSED — pending attorney + CPA review)"}: records kept{" "}
          {rules.values.retentionYearsAfterRepresentationEnds} years after the representation ends (never deleted by this product),{" "}
          {rules.values.reconciliationCadence} three-way reconciliation, zero tolerance for differences. This is research, not legal or accounting
          advice.
        </p>
      </section>
    </div>
  );
}
