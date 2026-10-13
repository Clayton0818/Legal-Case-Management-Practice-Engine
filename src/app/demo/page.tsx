// /demo (c106) — guided walkthrough of the whole product using the fictional
// DEMO firm. Server component: signed-in staff only (any firm); the live
// panels read ONLY the current demo firm, re-checked with the demo flag
// (assertDemoTenant) inside that firm's own transaction.
//
// The "open the real page" links go to the real staff pages, which show the
// firm the presenter's session belongs to. When that is not the current demo
// firm, the links are disabled and a warning explains how to point the
// session at the demo — so a demo can never accidentally show a real firm.

import Link from "next/link";
import { WALKTHROUGH, resolveHref, type SnapshotPanel, type WalkthroughStep } from "@/engines/demo/walkthrough";
import { HONESTY_STATEMENT, gateView, simulatedLabel, type GateView } from "@/engines/demo/honesty";
import type { DemoSnapshot } from "@/engines/demo/snapshot";
import type { DemoStatus } from "@/engines/demo/status";
import { DEMO_FIRM } from "@/engines/demo/fixtures";
import { ResetDemoButton } from "./reset-button";

export const dynamic = "force-dynamic";

interface PageData {
  status: DemoStatus | null;
  snapshot: DemoSnapshot | null;
  gates: Map<string, GateView>;
  error: string | null;
}

async function loadPageData(): Promise<PageData> {
  const gates = new Map<string, GateView>();
  try {
    const [{ resolveRequestTenantId }, { withTenant }, { ensureServerApprovals }, { loadAllGates }, { loadDemoStatus }, { loadDemoSnapshot }] = await Promise.all([
      import("@/auth/request"),
      import("@/tenancy/withTenant"),
      import("@/compliance/server"),
      import("@/compliance/allGates"),
      import("@/engines/demo/status"),
      import("@/engines/demo/snapshot"),
    ]);
    const tenantId = await resolveRequestTenantId();
    await loadAllGates();
    await ensureServerApprovals();
    for (const key of new Set(WALKTHROUGH.flatMap((s) => s.gates))) gates.set(key, gateView(key));
    const status = await loadDemoStatus((id, fn) => withTenant(id, fn), tenantId);
    const snapshot = status.current ? await withTenant(status.current.tenantId, (tx) => loadDemoSnapshot(tx, status.current!.tenantId)) : null;
    return { status, snapshot, gates, error: null };
  } catch (err) {
    return { status: null, snapshot: null, gates, error: err instanceof Error ? err.message : String(err) };
  }
}

const fmt = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) : "—";
const money = (cents: string) => `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "amber" | "green" | "red" | "blue" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    amber: "bg-amber-100 text-amber-900",
    green: "bg-emerald-100 text-emerald-800",
    red: "bg-red-100 text-red-800",
    blue: "bg-sky-100 text-sky-800",
  } as const;
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

function Rows({ rows }: { rows: Array<[React.ReactNode, React.ReactNode]> }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">Nothing in the demo firm for this step.</p>;
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {rows.map(([a, b], i) => (
        <li key={i} className="flex items-start justify-between gap-4 py-1">
          <span className="text-slate-800">{a}</span>
          <span className="shrink-0 text-right text-slate-600">{b}</span>
        </li>
      ))}
    </ul>
  );
}

function LivePanel({ panel, snap }: { panel: SnapshotPanel; snap: DemoSnapshot }) {
  switch (panel) {
    case "prospects":
      return <Rows rows={snap.prospects.map((p) => [`${p.name} · ${p.channel.replace("_", " ")}`, <Badge key="s" tone={p.safetyFlagged ? "red" : "slate"}>{p.status.replace(/_/g, " ")}</Badge>])} />;
    case "emergency":
      return (
        <Rows
          rows={snap.emergencies.map((e) => [
            `${e.track.replace(/_/g, " ")} — ${e.category.replace(/_/g, " ")}`,
            <Badge key="a" tone={e.acknowledged ? "green" : "red"}>{e.acknowledged ? "acknowledged" : `waiting for on-call lawyer (step ${e.escalationStep})`}</Badge>,
          ])}
        />
      );
    case "conflicts":
      return (
        <Rows
          rows={snap.conflicts.map((c) => [
            c.name,
            <span key="o" className="space-x-1">
              <Badge tone={c.outcome === "clear" ? "green" : c.outcome === "definite" || c.decision === "declined" ? "red" : "amber"}>{c.outcome}</Badge>
              {c.decision ? <Badge tone="blue">attorney decision: {c.decision.replace(/_/g, " ")}</Badge> : c.outcome !== "clear" ? <Badge>awaiting conflicts attorney</Badge> : null}
              {!c.ruleTableApplied && c.outcome !== "clear" ? <Badge tone="amber">rule table pending review</Badge> : null}
            </span>,
          ])}
        />
      );
    case "booking":
      return <Rows rows={snap.consultations.map((c) => [`Consultation with ${c.lawyer}`, `${fmt(c.startsAt)} · ${c.status}${c.outcome ? ` (${c.outcome.replace(/_/g, " ")})` : ""}`])} />;
    case "acceptance":
    case "opening":
      return <Rows rows={snap.matters.map((m) => [`${m.client}${m.practiceArea ? ` · ${m.practiceArea}` : ""}`, `${m.stage.replace(/_/g, " ")} · ${m.lawyer ?? "unassigned"}`])} />;
    case "calendar":
      return (
        <Rows
          rows={snap.events
            .filter((e) => !e.title.startsWith("Limitation"))
            .map((e) => [e.title, <span key="s" className="space-x-1"><Badge tone={e.status === "confirmed" ? "green" : "amber"}>{e.status === "proposed" ? "PROPOSED — lawyer must confirm" : e.status}</Badge> <span>{fmt(e.startsAt)}</span></span>])}
        />
      );
    case "limitations":
      return <Rows rows={snap.limitations.map((l) => [l.claim, <span key="s" className="space-x-1"><Badge tone={l.status === "verified" ? "green" : "amber"}>{l.status}</Badge> <span>{l.date}</span></span>])} />;
    case "documents":
      return <Rows rows={snap.documents.map((d) => [d.name, `v${d.version} · ${d.status}`])} />;
    case "trust":
      return (
        <div className="space-y-2">
          <Rows rows={snap.trust.accounts.map((a) => [a.name, a.bank])} />
          <Rows rows={snap.trust.subledgers.map((s) => [`Client ledger: ${s.client ?? "—"}`, `${money(s.balanceCents)} (held ${money(s.heldCents)})`])} />
          <Rows
            rows={snap.trust.reconciliations.map((r) => [
              `Three-way reconciliation ${r.period}`,
              <span key="r" className="space-x-1"><Badge tone={r.status === "balanced" ? "green" : "amber"}>{r.status}</Badge> <span>{r.differences} difference(s)</span>{!r.rulesApproved && <Badge tone="amber">trust rules pending review</Badge>}</span>,
            ])}
          />
        </div>
      );
    case "communication":
      return (
        <div className="space-y-2">
          <Rows rows={snap.replyClocks.map((c) => [`Reply clock (${c.tier} track)`, `${c.status}${c.status === "open" ? ` · answer by ${fmt(c.promiseAt)}` : ""}`])} />
          <Rows rows={snap.updates.map((u) => [u.body, <Badge key="u" tone={u.status === "sent" ? "green" : "amber"}>{u.status.replace(/_/g, " ")}</Badge>])} />
        </div>
      );
    case "court_notice":
      return <Rows rows={snap.courtNotices.map((n) => [n.subject, `${n.classification.replace(/_/g, " ")} · ${n.matched ? "matched to matter" : "unmatched"}`])} />;
    case "health":
      return <Rows rows={[...snap.health.map((h): [string, React.ReactNode] => [`Case health: ${h.client}`, <Badge key="h" tone={h.band === "green" ? "green" : h.band === "red" ? "red" : "amber"}>{h.score ?? "—"} · {h.band}</Badge>]), ["Overdue tasks right now", String(snap.ops.overdueTasks)]]} />;
    case "permissions":
      return <Rows rows={snap.staff.map((s) => [`${s.name} — ${s.title}`, s.email])} />;
    case "family_pack":
      return <Rows rows={snap.matters.filter((m) => m.practiceArea === "family").map((m) => [m.client, m.stage.replace(/_/g, " ")])} />;
    case "ops":
      return (
        <Rows
          rows={[
            ["Open flags", String(snap.ops.openFlags)],
            ["Overdue tasks", String(snap.ops.overdueTasks)],
            ["Notifications held or queued (email simulated)", String(snap.ops.heldNotifications)],
          ]}
        />
      );
  }
}

function StepCard({ step, data, linksEnabled }: { step: WalkthroughStep; data: PageData; linksEnabled: boolean }) {
  const ids = { matter: data.snapshot?.ids.matter ?? {}, session: data.snapshot?.ids.session ?? {} };
  return (
    <section id={step.id} className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{step.title}</h2>
        <Badge tone="amber">DEMO · fictional</Badge>
      </div>
      <p className="text-sm text-slate-700">{step.explanation}</p>

      <div className="flex flex-wrap gap-2">
        {step.links.map((l) => {
          const href = resolveHref(l.href, ids);
          const label = `${l.label}${l.kind === "api" ? " · JSON" : ""}`;
          return href && linksEnabled ? (
            <Link key={l.href} href={href} className="rounded-md border border-slate-300 px-3 py-1 text-sm text-slate-800 hover:bg-slate-50" target={l.kind === "api" ? "_blank" : undefined}>
              {label} →
            </Link>
          ) : (
            <span key={l.href} title={linksEnabled ? "Not in this demo firm" : "Point your session at the demo firm first (see Presenter setup)"} className="cursor-not-allowed rounded-md border border-dashed border-slate-300 px-3 py-1 text-sm text-slate-400">
              {label}
            </span>
          );
        })}
      </div>

      {data.snapshot && (
        <div className="rounded-md bg-slate-50 p-3">
          <p className="mb-1 text-xs font-semibold uppercase text-slate-500">In the demo firm right now</p>
          <LivePanel panel={step.panel} snap={data.snapshot} />
        </div>
      )}

      <div>
        <p className="text-xs font-semibold uppercase text-slate-500">Talking points</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-800">
          {step.talkingPoints.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>

      {(step.gates.length > 0 || step.simulated.length > 0) && (
        <div className="space-y-1 border-t border-slate-100 pt-2">
          {step.gates.map((key) => {
            const g = data.gates.get(key);
            if (!g) return null;
            return (
              <div key={key} className="text-xs">
                <Badge tone={g.approved ? "green" : "amber"}>{g.label}</Badge>{" "}
                {g.approved ? <span className="text-slate-600">{g.description}</span> : <code className="text-amber-900">{g.placeholder}</code>}
              </div>
            );
          })}
          {step.simulated.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {step.simulated.map((v) => (
                <Badge key={v} tone="blue">{simulatedLabel(v)}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ResetNote({ status }: { status: DemoStatus }) {
  const c = status.current;
  if (!c) return null;
  return (
    <p className="mt-1 text-xs">
      The reset is an admin action (settings.manage): press it as the fictional firm administrator {c.adminName} (<code>DEV_USER_ID={c.adminUserId ?? "<admin user id>"}</code>), or with DEV_USER_ID unset in dev mode.
    </p>
  );
}

function PresenterSetup({ status }: { status: DemoStatus }) {
  const c = status.current;
  if (!c) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-semibold">No demo firm exists yet on this deployment.</p>
        <p className="mt-1">
          An operator creates the first one from a terminal on the demo deployment: <code>DEMO_RESET_ENABLED=1 npx tsx src/engines/demo/cli.ts create --by &quot;Your name&quot;</code>. After that, the reset button below does it in one click.
        </p>
      </div>
    );
  }
  const env = `DEV_TENANT_ID=${c.tenantId}\nDEV_USER_ID=${c.presenterUserId ?? "<partner user id>"}`;
  if (status.session.kind === "current_demo") {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
        Your session is signed in to the current demo firm (generation {c.generation}, seeded {fmt(c.seededAt)}). The real-page links below show the fictional demo data.
        <ResetNote status={status} />
      </div>
    );
  }
  return (
    <div className={`rounded-lg border p-4 text-sm ${status.session.kind === "not_demo" ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-950"}`}>
      <p className="font-semibold">
        {status.session.kind === "not_demo"
          ? "Your session belongs to a REAL firm, not the demo firm. Real-page links are disabled so a demo never shows real client data."
          : "Your session points at a retired demo firm (from before the last reset). Real-page links are disabled until you switch."}
      </p>
      <p className="mt-1">The live panels below already show the current demo firm. To open the real staff pages on it, point the presenter session at it — in dev mode:</p>
      <pre className="mt-2 overflow-x-auto rounded bg-white/70 p-2 text-xs">{env}</pre>
      <p className="mt-1 text-xs">({c.presenterName} is the fictional partner: a lawyer and the designated conflicts attorney, so lawyer-only actions can be shown.)</p>
      <ResetNote status={status} />
    </div>
  );
}

export default async function DemoPage() {
  const data = await loadPageData();
  const status = data.status;
  const linksEnabled = status?.session.kind === "current_demo";
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Product walkthrough — {DEMO_FIRM.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Sixteen steps through the whole journey, from a prospect&apos;s first chat to the firm&apos;s operations views. Each step has a short explanation, a link into the real page, what the demo firm holds right now, and talking points for the presenter. The full script is in <code>docs/product/features/demo/presenter-script.md</code>.
        </p>
      </div>

      <ul className="list-disc space-y-1 rounded-lg border border-slate-200 bg-white p-4 pl-8 text-sm text-slate-800">
        {HONESTY_STATEMENT.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>

      {data.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Could not load the demo firm: {data.error}. The walkthrough text below still works; live panels and links need a signed-in session and a database.
        </div>
      )}
      {status && <PresenterSetup status={status} />}

      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm text-slate-700">
          <p className="font-semibold text-slate-900">Start every demo clean</p>
          <p>Reset creates a fresh fictional firm through the product&apos;s own services and retires the old one. It refuses to run for any firm that is not flagged as the demo firm.</p>
          {data.snapshot && (
            <p className="mt-1 text-xs text-slate-500">
              Current seed: {data.snapshot.summary.ok} steps done, {data.snapshot.summary.blocked} blocked pending review (shown as placeholders), {data.snapshot.summary.failed} failed.
            </p>
          )}
        </div>
        <ResetDemoButton enabled={Boolean(status?.resetEnabled && status.session.kind !== "not_demo")} />
      </div>

      <nav className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <p className="mb-1 font-semibold text-slate-900">Steps</p>
        <ol className="grid gap-1 sm:grid-cols-2">
          {WALKTHROUGH.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-slate-700 hover:underline">
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {WALKTHROUGH.map((step) => (
        <StepCard key={step.id} step={step} data={data} linksEnabled={linksEnabled} />
      ))}

      {data.snapshot && data.snapshot.failedSteps.length > 0 && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <h2 className="font-semibold">Seed steps that failed on this deployment</h2>
          <p className="mt-1">Usually configuration (for example document storage must be set up on the demo deployment). Fix it and reset the demo.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {data.snapshot.failedSteps.map((s) => (
              <li key={s.key}>
                <code>{s.key}</code>: {s.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.snapshot && data.snapshot.blockedSteps.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <h2 className="font-semibold">What the demo firm could not do yet (and why)</h2>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {data.snapshot.blockedSteps.map((s) => (
              <li key={s.key}>
                <code>{s.key}</code>: {s.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
