// c122 — one intake, step by step, for the staff member working it. Shows the
// steps the intake engine enforces (disclosures → conflict-check names →
// conflict check → case details) and offers only the step that is actionable
// now. Internal only: nothing on this page is client-facing.
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDevTenantId } from "@/tenancy/devTenant";
import { legalCopyStatus } from "@/compliance/approvals";
import { practiceAreaLabel } from "@/core/practiceAreas";
import { CHANNEL_COPY, copyKeyFor } from "@/engines/intake/gates";
import { LOCK_REASON_LABEL, type StepStatus } from "@/engines/intake/staffEntry/steps";
import type { StaffIntakeView } from "@/engines/intake/staffEntry/service";
import { Card, Notice, PageHeader, SectionTitle, StatusPill } from "../../_components/ui";
import { StaffIntakeActions } from "./staff-intake-actions";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STEP_TITLE = {
  disclosures: "Disclosures",
  conflict_names: "Names for the conflict check",
  conflict_check: "Conflict check",
  case_details: "Case details",
} as const;

const STATUS_PILL: Record<StepStatus, { tone: "success" | "brand" | "warning" | "danger" | "neutral"; text: string }> = {
  done: { tone: "success", text: "done" },
  current: { tone: "brand", text: "now" },
  waiting: { tone: "warning", text: "waiting" },
  blocked: { tone: "danger", text: "stopped" },
  upcoming: { tone: "neutral", text: "later" },
};

async function load(id: string): Promise<{ view: StaffIntakeView; practiceAreas: Array<{ id: string; label: string }> } | null> {
  const tenantId = getDevTenantId();
  const [{ withTenant }, { ensureServerApprovals }, { getStaffIntakeView }, { getEnabledPracticeAreas }, { IntakeNotFoundError }] = await Promise.all([
    import("@/tenancy/withTenant"),
    import("@/compliance/server"),
    import("@/engines/intake/staffEntry/service"),
    import("@/core/practiceAreas"),
    import("@/engines/intake/common/errors"),
  ]);
  await ensureServerApprovals();
  try {
    return await withTenant(tenantId, async (tx) => ({
      view: await getStaffIntakeView(tx, tenantId, id),
      practiceAreas: (await getEnabledPracticeAreas(tx, tenantId)).map((a) => ({ id: a, label: practiceAreaLabel(a) })),
    }));
  } catch (err) {
    if (err instanceof IntakeNotFoundError) return null;
    throw err;
  }
}

function fmt(d: Date | null): string {
  return d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function words(v: string): string {
  return v.replace(/_/g, " ");
}

export default async function IntakeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const loaded = await load(id);
  if (!loaded) notFound();
  const { view, practiceAreas } = loaded;
  const disclosure = legalCopyStatus(copyKeyFor(CHANNEL_COPY.disclosure, view.language));
  const current = view.steps.find((s) => s.status === "current")?.step ?? null;
  const allDone = view.steps.every((s) => s.status === "done");

  return (
    <div className="space-y-6">
      <Link href="/admin/intake" className="text-sm text-slate-500 hover:underline">
        ← Back to the intake queue
      </Link>
      <PageHeader
        eyebrow={`Intake · ${words(view.channel)}`}
        title={view.contact?.fullName ?? "Unknown contact"}
        description={`Started ${fmt(view.startedAt)} · ${view.language === "es" ? "Spanish" : "English"}`}
        actions={
          <>
            {view.safetyFlagged ? <StatusPill tone="danger">safety</StatusPill> : null}
            <StatusPill tone="info">{words(view.status)}</StatusPill>
          </>
        }
      />

      {view.status === "referral_awaiting_contact" ? (
        <Notice tone="info">This referral is waiting for the person to contact the firm. Nothing has been sent to them.</Notice>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <SectionTitle>Contact</SectionTitle>
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-16 text-slate-500">Phone</dt>
              <dd className="text-slate-900">{view.contact?.phone ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 text-slate-500">Email</dt>
              <dd className="text-slate-900">{view.contact?.email ?? "—"}</dd>
            </div>
          </dl>
        </Card>
        <Card className="p-5">
          <SectionTitle>Response clock</SectionTitle>
          <p className="text-sm text-slate-700">
            {view.firstHumanContactAt
              ? `Contacted ${fmt(view.firstHumanContactAt)}.`
              : view.responseOutcome
                ? `Closed: ${words(view.responseOutcome)}.`
                : view.responseTargetAt
                  ? `The firm should respond by ${fmt(view.responseTargetAt)}.`
                  : "Not running."}
          </p>
          {!view.firstHumanContactAt && view.status !== "referral_awaiting_contact" ? (
            <div className="mt-3">
              <StaffIntakeActions intakeSessionId={view.intakeSessionId} mode="contact" channel={view.channel} />
            </div>
          ) : null}
        </Card>
      </div>

      <section>
        <SectionTitle hint="The same steps every inquiry goes through, in the order the system enforces them.">Steps</SectionTitle>
        <Card>
          <ol className="divide-y divide-slate-100">
            {view.steps.map((s, i) => (
              <li key={s.step} className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-slate-400">{i + 1}</span>
                  <span className="font-semibold text-slate-900">{STEP_TITLE[s.step]}</span>
                  <StatusPill tone={STATUS_PILL[s.status].tone}>{STATUS_PILL[s.status].text}</StatusPill>
                </div>
                <p className="text-sm text-slate-600">{s.detail}</p>
                {s.step === current && view.status !== "referral_awaiting_contact" ? (
                  <StaffIntakeActions
                    intakeSessionId={view.intakeSessionId}
                    mode={s.step}
                    channel={view.channel}
                    contactName={view.contact?.fullName ?? ""}
                    disclosure={disclosure}
                    practiceAreas={practiceAreas}
                  />
                ) : null}
                {s.step === "case_details" && s.status === "upcoming" && view.caseDetailsLocked ? (
                  <ul className="list-disc pl-5 text-xs text-slate-500">
                    {view.lockReasons.map((r) => (
                      <li key={r}>{LOCK_REASON_LABEL[r]}</li>
                    ))}
                  </ul>
                ) : null}
                {s.step === "case_details" && s.status === "done" ? (
                  <dl className="space-y-1 text-sm">
                    {view.caseDetails.practiceArea ? (
                      <div className="flex gap-2">
                        <dt className="w-32 text-slate-500">Practice area</dt>
                        <dd className="text-slate-900">{practiceAreas.find((a) => a.id === view.caseDetails.practiceArea)?.label ?? view.caseDetails.practiceArea}</dd>
                      </div>
                    ) : null}
                    {view.caseDetails.county ? (
                      <div className="flex gap-2">
                        <dt className="w-32 text-slate-500">County</dt>
                        <dd className="text-slate-900">{view.caseDetails.county}</dd>
                      </div>
                    ) : null}
                    {view.caseDetails.practiceAreaFreeText ? (
                      <div className="flex gap-2">
                        <dt className="w-32 text-slate-500">What they need</dt>
                        <dd className="whitespace-pre-wrap text-slate-900">{view.caseDetails.practiceAreaFreeText}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
      </section>

      {allDone ? (
        <Notice tone="success">
          The intake steps are complete. Next come the firm&apos;s case-acceptance rules, lawyer assignment and booking a consultation.
          {view.matterId ? (
            <>
              {" "}
              <Link href={`/admin/matters/${view.matterId}`} className="underline">
                Open the prospective matter
              </Link>
              .
            </>
          ) : null}
        </Notice>
      ) : null}
    </div>
  );
}
