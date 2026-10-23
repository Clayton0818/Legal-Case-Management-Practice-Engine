// c106 — fill a brand-new DEMO firm with fictional data, through the engines'
// REAL services wherever one exists, so the demo exercises the product's
// actual code paths (conflict matching, emergency detection, reply clocks,
// the trust gate, …).
//
// Direct inserts are used only where no service exists yet:
//   - the firm's users and its first config version (onboarding has no service);
//   - the two pre-existing ("imported history") matters, their parties and
//     matter_parties links (matter import, c98, is not built yet).
//
// The conflict-check engine now writes the shared conflict_check_results
// rows the intake engine reads (c110), so the demo no longer mirrors them.
//
// Anything gated on a pending attorney / CPA / vendor approval is attempted
// through the real service and recorded as BLOCKED with its visible
// placeholder (see runner.ts) — the demo never fakes an approved action.
//
// This module imports other engines' services on purpose: the demo is the
// one cross-cutting consumer whose job is to drive every engine. Nothing
// imports the demo engine back.

import { and, eq } from "drizzle-orm";
import {
  firmConfigVersions,
  matterParties,
  matters,
  parties,
  users,
} from "@/db/schema";
import { courtCaseRefs } from "@/db/tables/calendar-alerts";
import { audit, createTask, normalizeName, raiseFlag, updateEngineSettings, updateFirmSettings, type Actor } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { placeholderFor } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";

// intake
import { acknowledgeDisclosures, receiveInbound, recordCaseDetails, recordConflictMinimum } from "@/engines/intake/channels/service";
import { addRotaShift } from "@/engines/intake/emergency/service";
import { upsertLawyerProfile } from "@/engines/intake/assignment/service";
import { getBookingOptions, holdSlot, confirmBooking, recordConsultOutcome } from "@/engines/intake/booking/service";
import { evaluateFit, decideBorderline } from "@/engines/intake/acceptance/service";
import { ensureProspectiveMatter } from "@/engines/intake/common/matters";
import { getOpenGatePanel, openMatter, recordGateEvidence } from "@/engines/intake/opening/service";
import { runAutoAssignment } from "@/engines/intake/assignment/service";
import { systemMoveMatter } from "@/engines/intake/pipeline/service";
// conflict-check
import { grantConflictsRole, loadAccess as loadConflictAccess } from "@/engines/conflict-check/access";
import { commitImport, validateImport } from "@/engines/conflict-check/importService";
import { IMPORT_TEMPLATE_HEADER } from "@/engines/conflict-check/historyImport";
import { confirmHistoryImport } from "@/engines/conflict-check/settingsService";
import { checkInquiry } from "@/engines/conflict-check/sync";
import { recordDecision } from "@/engines/conflict-check/decisionService";
// all-engines
import { addTeamMember, grantRole, loadStaffContext } from "@/engines/all-engines/permissions/service";
import { ensureDefaultPackAdoptions } from "@/engines/all-engines/practiceAreas/service";
// calendar-core
import { loadStaff as loadCalendarStaff } from "@/engines/calendar-core/actors";
import { confirmEvent, createEvent } from "@/engines/calendar-core/calendar/service";
import { enterLimitationDate, runLimitationScan, verifyLimitationDate } from "@/engines/calendar-core/limitations/service";
import { importExampleRuleSet, runCalculation } from "@/engines/calendar-core/deadlines/service";
import { activateDefinition, listDefinitions, seedFamilyLawStageDraft, startLifecycle } from "@/engines/calendar-core/templates/stageService";
import { activateTemplate, listTemplates, seedFamilyLawTaskListDrafts, startRun } from "@/engines/calendar-core/templates/taskListService";
// calendar-alerts
import { loadContext as loadAlertsContext, loadStaff as loadAlertsStaff } from "@/engines/calendar-alerts/common";
import { ENGINE as ALERTS_ENGINE } from "@/engines/calendar-alerts/settings";
import { recordInboundMessage, recordOutboundMessage } from "@/engines/calendar-alerts/replyClock/service";
import { runOverdueScan } from "@/engines/calendar-alerts/overdue/service";
import { computeMatterHealth } from "@/engines/calendar-alerts/health/service";
import { approveUpdate, createUpdate } from "@/engines/calendar-alerts/updates/service";
import { ingestCourtEmail } from "@/engines/calendar-alerts/courtNotice/service";
// document
import { DEFAULT_DOCUMENT_SETTINGS } from "@/engines/document/settings";
import { gatedAdapters } from "@/engines/document/storage/adapters";
import { loadAccess as loadDocumentAccess } from "@/engines/document/access/service";
import { folderByKey, provisionMatterFolders } from "@/engines/document/folders/service";
import { downloadDocument, uploadDocument } from "@/engines/document/store/service";
import { runSearch } from "@/engines/document/search/service";
import type { StaffViewer } from "@/engines/document/access/policy";
// billing-trust
import { createTrustAccount, openClientSubledger, placeHold, postTransaction } from "@/engines/billing-trust/ledgerService";
import { importStatement, prepareReconciliation } from "@/engines/billing-trust/reconciliationService";

import {
  DEMO_CLIENT_MESSAGES,
  DEMO_COURT_EMAIL,
  DEMO_DOCUMENTS,
  DEMO_EXISTING_MATTERS,
  DEMO_FIRM,
  DEMO_HISTORY_ROWS,
  DEMO_PROSPECTS,
  DEMO_SEED_VERSION,
  DEMO_STAFF,
  type DemoProspect,
  type StaffKey,
} from "./fixtures";
import { SeedRunner, type SeedReport } from "./runner";
import { addDays, atLocalHour, isoDate, monthBounds, previousMonth } from "./time";

export interface SeedContext {
  tenantId: string;
  now: Date;
  users: Record<StaffKey, string>;
  matters: Partial<Record<"sampleford" | "fictiva" | "placewell", string>>;
  clients: Partial<Record<"sampleford" | "fictiva", string>>;
  sessions: Partial<Record<DemoProspect["key"], string>>;
  checks: Partial<Record<DemoProspect["key"], string>>;
  configVersionId: string;
}

const user = (ctx: SeedContext, key: StaffKey): Actor => ({ type: "user", userId: ctx.users[key] });

// ---------------------------------------------------------------------------
// 1. Firm, people, settings
// ---------------------------------------------------------------------------

async function seedFirm(r: SeedRunner, tx: TenantTx, tenantId: string, now: Date): Promise<SeedContext> {
  // Onboarding has no service yet: users and the first config version are inserted.
  const rows = await tx
    .insert(users)
    .values(
      DEMO_STAFF.map((s) => ({ tenantId, email: s.email, displayName: s.displayName, role: s.role, roleLabel: s.roleLabel }))
    )
    .returning({ id: users.id, email: users.email });
  const ids = {} as Record<StaffKey, string>;
  for (const s of DEMO_STAFF) ids[s.key] = rows.find((x) => x.email === s.email)!.id;
  const [config] = await tx
    .insert(firmConfigVersions)
    .values({ tenantId, version: 1, config: { demo: true, seedVersion: DEMO_SEED_VERSION } })
    .returning({ id: firmConfigVersions.id });
  r.record("firm", "firm.users_and_config", "ok");

  const ctx: SeedContext = { tenantId, now, users: ids, matters: {}, clients: {}, sessions: {}, checks: {}, configVersionId: config!.id };

  await r.step("firm", "firm.settings", (t) =>
    updateFirmSettings(
      t,
      tenantId,
      { emailFromName: DEMO_FIRM.name, emailFromAddress: "no-reply@example.com", clientPortalUrl: "https://portal.example.com/demo" },
      user(ctx, "admin")
    )
  );
  await r.step("firm", "practice_areas.adopt_family_pack", (t) => ensureDefaultPackAdoptions(t, tenantId));
  return ctx;
}

async function seedPermissions(r: SeedRunner, ctx: SeedContext): Promise<void> {
  const { tenantId, users: u } = ctx;
  await r.step("permissions", "permissions.owner_and_roles", async (t) => {
    const admin = await loadStaffContext(t, tenantId, { userId: u.admin, role: "firm_admin", capabilities: [] });
    await grantRole(t, { tenantId, by: admin, userId: u.partner, role: "owner", reason: "DEMO: founding partner of the fictional firm" });
    const owner = await loadStaffContext(t, tenantId, { userId: u.partner, role: "attorney", capabilities: [] });
    await grantRole(t, { tenantId, by: owner, userId: u.paralegal, role: "paralegal", reason: "DEMO: paralegal on the family team" });
  });
  await r.step("permissions", "conflicts.designate_attorney", async (t) => {
    const admin = await loadConflictAccess(t, tenantId, u.admin);
    await grantConflictsRole(t, { tenantId, userId: u.partner, role: "conflicts_attorney", designated: true, by: admin });
  });
  await r.step("intake", "intake.lawyer_profiles", async (t) => {
    for (const s of DEMO_STAFF.filter((x) => x.role === "attorney")) {
      await upsertLawyerProfile(t, {
        tenantId,
        byUserId: u.admin,
        userId: u[s.key],
        practiceAreas: ["family"],
        languages: s.languages,
        counties: [DEMO_FIRM.county],
        seniority: s.seniority,
        weeklyNewMatterCap: 5,
      });
    }
  });
  await r.step("intake", "intake.on_call_rota", async (t) => {
    const start = addDays(ctx.now, -1);
    const end = addDays(ctx.now, 14);
    await addRotaShift(t, { tenantId, byUserId: u.admin, userId: u.partner, role: "primary", startsAt: start, endsAt: end });
    await addRotaShift(t, { tenantId, byUserId: u.admin, userId: u.associate, role: "backup", startsAt: start, endsAt: end });
  });
}

// ---------------------------------------------------------------------------
// 2. Existing matters ("imported history") + the conflict index
// ---------------------------------------------------------------------------

async function seedExistingMatters(r: SeedRunner, ctx: SeedContext): Promise<void> {
  const { tenantId, now } = ctx;
  for (const m of DEMO_EXISTING_MATTERS) {
    await r.step("matters", `matters.import_existing.${m.key}`, async (t) => {
      const [client] = await t
        .insert(parties)
        .values({ tenantId, fullName: m.client.fullName, normalizedName: normalizeName(m.client.fullName), email: m.client.email, phone: m.client.phone })
        .returning({ id: parties.id });
      const [opp] = await t
        .insert(parties)
        .values({ tenantId, fullName: m.opposing.fullName, normalizedName: normalizeName(m.opposing.fullName) })
        .returning({ id: parties.id });
      const [matter] = await t
        .insert(matters)
        .values({
          tenantId,
          primaryPartyId: client!.id,
          practiceArea: "family",
          stage: "retained",
          assignedUserId: ctx.users[m.responsible],
          openedAt: addDays(now, -m.openedDaysAgo),
        })
        .returning({ id: matters.id });
      const links: Array<typeof matterParties.$inferInsert> = [
        { tenantId, matterId: matter!.id, partyId: client!.id, role: "client" },
        { tenantId, matterId: matter!.id, partyId: opp!.id, role: "opposing_party", relationship: m.opposing.relationship, isAdverse: true },
      ];
      for (const c of m.children ?? []) {
        const [child] = await t.insert(parties).values({ tenantId, fullName: c.fullName, normalizedName: normalizeName(c.fullName) }).returning({ id: parties.id });
        links.push({ tenantId, matterId: matter!.id, partyId: child!.id, role: "child", relationship: "child", isAdverse: false });
      }
      await t.insert(matterParties).values(links);
      await t.insert(courtCaseRefs).values({ tenantId, matterId: matter!.id, causeNumber: m.causeNumber, addedByUserId: ctx.users[m.responsible] });
      ctx.matters[m.key] = matter!.id;
      ctx.clients[m.key] = client!.id;
    });
  }
  await r.step("permissions", "permissions.matter_team", async (t) => {
    const owner = await loadStaffContext(t, tenantId, { userId: ctx.users.partner, role: "attorney", capabilities: [] });
    for (const m of DEMO_EXISTING_MATTERS) {
      const id = ctx.matters[m.key];
      if (!id) continue;
      for (const k of m.team) await addTeamMember(t, { tenantId, by: owner, matterId: id, userId: ctx.users[k], roleOnMatter: "paralegal", reason: "DEMO team" });
    }
  });
}

async function seedConflictHistory(r: SeedRunner, ctx: SeedContext): Promise<void> {
  const { tenantId, now } = ctx;
  await r.step("conflicts", "conflicts.history_import", async (t) => {
    const access = await loadConflictAccess(t, tenantId, ctx.users.partner);
    const csv = `${IMPORT_TEMPLATE_HEADER}\n${DEMO_HISTORY_ROWS.join("\n")}\n`;
    const report = await validateImport(t, { tenantId, filename: "demo-history (fictional).csv", csv, access, now });
    await commitImport(t, { tenantId, batchId: report.batch.id, access, now });
    await confirmHistoryImport(t, { tenantId, access, now });
  });
}

// ---------------------------------------------------------------------------
// 3. Prospects chat in: triage, emergency, conflict check (clear / possible / definite)
// ---------------------------------------------------------------------------

async function chatIn(r: SeedRunner, ctx: SeedContext, p: DemoProspect, minutesAgo: number): Promise<string | null> {
  const at = new Date(ctx.now.getTime() - minutesAgo * 60_000);
  const sessionId = await r.step("intake", `intake.chat_in.${p.key}`, async (t) => {
    const res = await receiveInbound(t, {
      tenantId: ctx.tenantId,
      channel: "web_chat",
      from: { name: p.fullName, email: p.email, phone: p.phone },
      text: p.message,
      now: at,
    });
    return res.intakeSessionId;
  });
  if (!sessionId) return null;
  ctx.sessions[p.key] = sessionId;
  if (p.key === "emergency") return sessionId; // paused for the on-call lawyer; no conflict step yet
  await r.step("intake", `intake.disclosures_and_conflict_minimum.${p.key}`, async (t) => {
    await acknowledgeDisclosures(t, { tenantId: ctx.tenantId, intakeSessionId: sessionId, now: at });
    await recordConflictMinimum(t, { tenantId: ctx.tenantId, intakeSessionId: sessionId, fullName: p.fullName, otherPartyNames: p.otherPartyNames, now: at });
  });
  const check = await r.step("conflicts", `conflicts.check.${p.key}`, async (t) => {
    const res = await checkInquiry(t, {
      tenantId: ctx.tenantId,
      intakeSessionId: sessionId,
      roleSought: "client",
      parties: [
        { role: "prospective_client", name: p.fullName, email: p.email, phone: p.phone },
        ...p.otherPartyNames.map((n) => ({ role: "opposing_party" as const, name: n, relationship: p.otherPartyRelationship })),
      ],
      by: user(ctx, "intake"),
      now: at,
    });
    // The engine itself hands the outcome to intake via conflict_check_results (c110).
    return res.check;
  });
  if (check) ctx.checks[p.key] = check.id;
  return sessionId;
}

async function seedProspects(r: SeedRunner, ctx: SeedContext): Promise<void> {
  const [clear, possible, definite, emergency] = ["clear", "possible", "definite", "emergency"].map(
    (k) => DEMO_PROSPECTS.find((p) => p.key === k)!
  );
  await chatIn(r, ctx, emergency!, 25);
  await chatIn(r, ctx, possible!, 90);
  await chatIn(r, ctx, definite!, 150);
  const clearSession = await chatIn(r, ctx, clear!, 60 * 26);

  // DEFINITE: the conflicts attorney (a person) declines it as not waivable.
  const defSession = ctx.sessions.definite;
  const defCheck = ctx.checks.definite;
  if (defSession && defCheck) {
    await r.step("conflicts", "conflicts.attorney_declines_definite", async (t) => {
      const access = await loadConflictAccess(t, ctx.tenantId, ctx.users.partner);
      await recordDecision(t, {
        tenantId: ctx.tenantId,
        checkId: defCheck,
        access,
        decision: {
          decision: "declined",
          reasonCode: "conflict_not_waivable",
          reasonText: "DEMO: the inquirer is the opposing party in our current client's divorce. Not waivable; decline without saying why.",
        },
        now: ctx.now,
      });
      const matter = await ensureProspectiveMatter(t, ctx.tenantId, defSession, ctx.now);
      await systemMoveMatter(t, { tenantId: ctx.tenantId, matterId: matter.id, systemStage: "declined_conflict", via: "conflict_decision", actor: user(ctx, "partner"), reason: "Conflicts attorney declined (DEMO)" });
    });
  }

  if (!clearSession) return;
  const at = addDays(ctx.now, -1);
  // CLEAR: case details unlock, fit is evaluated, a consultation is booked.
  await r.step("intake", "intake.case_details.clear", (t) =>
    recordCaseDetails(t, { tenantId: ctx.tenantId, intakeSessionId: clearSession, answers: clear!.answers, now: at })
  );
  const fit = await r.step("intake", "intake.fit_evaluation.clear", (t) => evaluateFit(t, { tenantId: ctx.tenantId, intakeSessionId: clearSession, now: at }));
  if (fit && fit.decision.outcome === "borderline" && fit.evaluationId) {
    await r.step("intake", "intake.lawyer_accepts_borderline.clear", (t) =>
      decideBorderline(t, { tenantId: ctx.tenantId, evaluationId: fit.evaluationId!, userId: ctx.users.associate, decision: "accept", reason: "DEMO: family matter in our county; we can help.", now: at })
    );
  }
  // AI triage is pending vendor approval (vendor.ai_model), so a PERSON triages: the intake
  // coordinator reads the chat and records the practice area. No service exists for this
  // yet, so the matter row is updated directly and the human decision is audited.
  await r.step("intake", "intake.staff_triage_practice_area.clear", async (t) => {
    const m = await ensureProspectiveMatter(t, ctx.tenantId, clearSession, at);
    await t.update(matters).set({ practiceArea: "family" }).where(and(eq(matters.tenantId, ctx.tenantId), eq(matters.id, m.id)));
    await audit(t, {
      tenantId: ctx.tenantId,
      engine: "demo",
      action: "demo.staff_triage",
      entityType: "matter",
      entityId: m.id,
      matterId: m.id,
      intakeSessionId: clearSession,
      actor: user(ctx, "intake"),
      reason: "Practice area set by the intake coordinator after reading the chat (AI triage pending vendor approval).",
      payload: { practiceArea: "family" },
    });
  });
  const consult = await r.step("intake", "intake.book_consultation.clear", async (t) => {
    const options = await getBookingOptions(t, { tenantId: ctx.tenantId, intakeSessionId: clearSession, now: at });
    if (!options.offered) throw new Error(`Booking not offered: ${options.reasons.join(", ")}`);
    const lawyer = options.lawyers.find((l) => l.slots.length > 0);
    if (!lawyer) throw new Error(`No bookable slot (callback offered); unavailable: ${JSON.stringify(options.unavailable)}`);
    const held = await holdSlot(t, {
      tenantId: ctx.tenantId,
      intakeSessionId: clearSession,
      lawyerUserId: lawyer.lawyerUserId,
      startsAt: lawyer.slots[0]!.start,
      format: options.formats[0]!,
      bookedByUserId: ctx.users.intake,
      now: at,
    });
    return confirmBooking(t, { tenantId: ctx.tenantId, consultationId: held.id, byUserId: ctx.users.intake, now: at });
  });
  const matter = await r.step("intake", "intake.prospective_matter.clear", (t) => ensureProspectiveMatter(t, ctx.tenantId, clearSession, at));
  if (!matter) return;
  ctx.matters.placewell = matter.id;
  if (consult) {
    await r.step("intake", "intake.consult_outcome.clear", (t) =>
      recordConsultOutcome(t, { tenantId: ctx.tenantId, consultationId: consult.id, userId: consult.lawyerUserId, outcome: "retain_offered", note: "DEMO: the lawyer offered to take the case; the client wants to proceed.", now: ctx.now })
    );
  }
  await r.step("intake", "intake.auto_assignment.clear", (t) => runAutoAssignment(t, { tenantId: ctx.tenantId, matterId: matter.id, trigger: "demo_seed", now: ctx.now }));
  await r.step("intake", "intake.gate_evidence.fee_arrangement", (t) =>
    recordGateEvidence(t, {
      tenantId: ctx.tenantId,
      matterId: matter.id,
      userId: ctx.users.associate,
      evidence: { gate: "fee_arrangement", fee: { feeType: "retainer", amountCents: 450_000 }, note: "DEMO: retainer at the firm's $4,500 floor (a firm setting)" },
      now: ctx.now,
    })
  );
  await r.step("intake", "intake.open_gate_panel.clear", (t) => getOpenGatePanel(t, ctx.tenantId, matter.id));
  // The open action itself waits for an attorney to approve the matter-open gate list.
  await r.step("intake", "intake.open_matter.clear", (t) => openMatter(t, { tenantId: ctx.tenantId, matterId: matter.id, userId: ctx.users.associate, now: ctx.now }));
}

// ---------------------------------------------------------------------------
// 4. Calendar, deadlines, limitation dates, stages and task lists
// ---------------------------------------------------------------------------

async function seedCalendar(r: SeedRunner, ctx: SeedContext): Promise<void> {
  const { tenantId, now } = ctx;
  const m1 = ctx.matters.sampleford;
  const m2 = ctx.matters.fictiva;
  if (!m1 || !m2) return;
  const tz = "America/Chicago";

  await r.step("calendar", "calendar.lawyer_confirmed_hearing", async (t) => {
    const lawyer = await loadCalendarStaff(t, tenantId, ctx.users.associate);
    return createEvent(t, {
      tenantId,
      staff: lawyer,
      draft: { matterId: m1, eventType: "hearing", title: "Temporary orders hearing (DEMO)", startsAt: atLocalHour(addDays(now, 6), 9, tz), courtName: DEMO_FIRM.court, causeNumber: "DEMO-2026-FL-0101", assignedUserIds: [ctx.users.associate] },
      confirmNow: true,
      now,
    });
  });
  await r.step("calendar", "calendar.staff_proposed_mediation", async (t) => {
    const para = await loadCalendarStaff(t, tenantId, ctx.users.paralegal);
    return createEvent(t, {
      tenantId,
      staff: para,
      draft: { matterId: m1, eventType: "mediation", title: "Mediation (DEMO) — awaiting lawyer confirmation", startsAt: atLocalHour(addDays(now, 20), 9, tz), assignedUserIds: [ctx.users.associate] },
      confirmNow: true,
      now,
    });
  });
  await r.step("calendar", "calendar.staff_proposed_deadline", async (t) => {
    const para = await loadCalendarStaff(t, tenantId, ctx.users.paralegal);
    return createEvent(t, {
      tenantId,
      staff: para,
      draft: { matterId: m1, eventType: "filing_deadline", title: "Inventory and appraisement due (DEMO — typed by staff, lawyer must confirm)", startsAt: atLocalHour(addDays(now, 12), 17, tz), isDeadline: true, assignedUserIds: [ctx.users.associate] },
      now,
    });
  });
  const proposedForConfirm = await r.step("calendar", "calendar.staff_proposed_status_conference", async (t) => {
    const para = await loadCalendarStaff(t, tenantId, ctx.users.paralegal);
    return createEvent(t, {
      tenantId,
      staff: para,
      draft: { matterId: m2, eventType: "hearing", title: "Status conference (DEMO)", startsAt: atLocalHour(addDays(now, 9), 14, tz), courtName: DEMO_FIRM.court, assignedUserIds: [ctx.users.associate2] },
      now,
    });
  });
  if (proposedForConfirm) {
    await r.step("calendar", "calendar.lawyer_confirms_proposed", async (t) => {
      const lawyer = await loadCalendarStaff(t, tenantId, ctx.users.associate2);
      return confirmEvent(t, { tenantId, staff: lawyer, eventId: proposedForConfirm.id, now });
    });
  }
  // Deadline calculator: rule sets are lawyer-approved per firm AND the court-rules gate is pending.
  await r.step("calendar", "deadlines.import_example_rule_set", async (t) => {
    const partner = await loadCalendarStaff(t, tenantId, ctx.users.partner);
    return importExampleRuleSet(t, { tenantId, staff: partner });
  });
  await r.step("calendar", "deadlines.calculate", async (t) => {
    const lawyer = await loadCalendarStaff(t, tenantId, ctx.users.associate);
    return runCalculation(t, { tenantId, staff: lawyer, matterId: m1, ruleSetKey: "example", triggerKey: "service", triggerAt: addDays(now, -3), now });
  });

  // Limitation dates: typed in by a lawyer, verified blind by a second person.
  const lim = await r.step("limitations", "limitations.enter_verified_example", async (t) => {
    const partner = await loadCalendarStaff(t, tenantId, ctx.users.partner);
    return enterLimitationDate(t, {
      tenantId,
      staff: partner,
      matterId: m2,
      claimDescription: "DEMO: enforcement of a prior property-division order (fictional date typed in by the lawyer)",
      limitationDate: isoDate(addDays(now, 200)),
      basis: "Entered by the responsible lawyer from the file (DEMO). The product does not compute limitation periods.",
      now,
    });
  });
  if (lim) {
    await r.step("limitations", "limitations.second_lawyer_verifies", async (t) => {
      const jordan = await loadCalendarStaff(t, tenantId, ctx.users.associate);
      return verifyLimitationDate(t, { tenantId, staff: jordan, limitationId: lim.limitation.id, verifierDate: isoDate(addDays(now, 200)), method: "Independent review of the order (DEMO)", now });
    });
  }
  await r.step("limitations", "limitations.enter_unverified_example", async (t) => {
    const jordan = await loadCalendarStaff(t, tenantId, ctx.users.associate);
    return enterLimitationDate(t, {
      tenantId,
      staff: jordan,
      matterId: m1,
      claimDescription: "DEMO: possible reimbursement claim (fictional) — awaiting a second lawyer's blind verification",
      limitationDate: isoDate(addDays(now, 25)),
      now,
    });
  });
  await r.step("limitations", "limitations.daily_scan", (t) => runLimitationScan(t, tenantId, now));

  // Stages and task lists: the system ships DRAFT Family Law templates; the fictional partner reviews and activates them.
  await r.step("stages", "stages.activate_family_draft", async (t) => {
    const partner = await loadCalendarStaff(t, tenantId, ctx.users.partner);
    await seedFamilyLawStageDraft(t, tenantId, partner);
    const draft = (await listDefinitions(t, tenantId, "family")).find((d) => d.status === "draft");
    if (draft) await activateDefinition(t, { tenantId, staff: partner, definitionId: draft.id, now });
    await seedFamilyLawTaskListDrafts(t, tenantId, partner);
    for (const tpl of await listTemplates(t, tenantId, { practiceArea: "family" })) {
      if (tpl.status === "draft") await activateTemplate(t, { tenantId, staff: partner, templateId: tpl.id, now });
    }
  });
  await r.step("stages", "stages.start_lifecycle", async (t) => {
    const lawyer = await loadCalendarStaff(t, tenantId, ctx.users.associate);
    return startLifecycle(t, { tenantId, staff: lawyer, matterId: m1, practiceArea: "family", now });
  });
  await r.step("stages", "task_lists.start_run", async (t) => {
    const lawyer = await loadCalendarStaff(t, tenantId, ctx.users.associate);
    const tpl = (await listTemplates(t, tenantId, { practiceArea: "family" })).find((x) => x.status === "active");
    if (!tpl) throw new Error("No active Family Law task list.");
    return startRun(t, { tenantId, matterId: m2, templateKey: tpl.key, staff: lawyer, now });
  });
}

// ---------------------------------------------------------------------------
// 5. Documents
// ---------------------------------------------------------------------------

async function seedDocuments(r: SeedRunner, ctx: SeedContext): Promise<void> {
  const { tenantId } = ctx;
  const enc = (s: string) => new TextEncoder().encode(s);
  const viewerFor = (key: StaffKey, role: string): StaffViewer => ({
    kind: "staff",
    userId: ctx.users[key],
    role: role as StaffViewer["role"],
    permissions: ["documents.read", "documents.write", ...(role === "attorney" ? ["documents.approve"] : [])],
  });
  const lawyer = viewerFor("associate", "attorney");
  for (const key of ["sampleford", "fictiva"] as const) {
    const matterId = ctx.matters[key];
    if (!matterId) continue;
    await r.step("documents", `documents.folders.${key}`, (t) => provisionMatterFolders(t, tenantId, matterId));
  }
  let firstDocId: string | null = null;
  for (const d of DEMO_DOCUMENTS) {
    const matterId = ctx.matters[d.matter];
    if (!matterId) continue;
    const res = await r.step("documents", `documents.upload.${d.filename}`, async (t) => {
      const { access } = await loadDocumentAccess(t, tenantId, lawyer);
      const c = { tenantId, viewer: lawyer, access, settings: DEFAULT_DOCUMENT_SETTINGS, adapters: gatedAdapters(tenantId) };
      const folder = await folderByKey(t, tenantId, matterId, d.folderKey);
      let groupId: string | undefined;
      let last: { documentId: string } | null = null;
      for (const text of d.versions) {
        const up = await uploadDocument(t, c, {
          matterId,
          folderId: folder?.id,
          groupId,
          bytes: enc(text),
          filename: d.filename,
          declaredMimeType: "text/plain",
          documentType: d.documentType,
        });
        groupId = up.groupId;
        last = up;
      }
      return last;
    });
    firstDocId ??= res?.documentId ?? null;
  }
  // A search and a download, so the access log has entries to show.
  await r.step("documents", "documents.search_and_download", async (t) => {
    const { access } = await loadDocumentAccess(t, tenantId, lawyer);
    const c = { tenantId, viewer: lawyer, access, settings: DEFAULT_DOCUMENT_SETTINGS, adapters: gatedAdapters(tenantId) };
    await runSearch(t, c, { text: "mediation" });
    if (firstDocId) await downloadDocument(t, c, firstDocId);
  });
}

// ---------------------------------------------------------------------------
// 6. Trust ledger and three-way reconciliation
// ---------------------------------------------------------------------------

async function seedTrust(r: SeedRunner, ctx: SeedContext): Promise<void> {
  const { tenantId, now } = ctx;
  const m1 = ctx.matters.sampleford;
  const m2 = ctx.matters.fictiva;
  const c1 = ctx.clients.sampleford;
  const c2 = ctx.clients.fictiva;
  if (!m1 || !m2 || !c1 || !c2) return;
  const period = previousMonth(now);
  const { start } = monthBounds(period);
  const as = (key: StaffKey) => ({ tx: undefined as unknown as TenantTx, tenantId, actorUserId: ctx.users[key], now });

  const account = await r.step("trust", "trust.open_account", (t) =>
    createTrustAccount({ ...as("admin"), tx: t }, {
      name: "DEMO IOLTA (fictional)",
      bankName: "Example Bank (fictional)",
      accountNumberLast4: "0000",
      accountType: "iolta",
      openedOn: isoDate(addDays(new Date(`${start}T12:00:00Z`), -31)),
    })
  );
  if (!account) return;
  const subs = await r.step("trust", "trust.client_subledgers", async (t) => {
    const a = await openClientSubledger({ ...as("admin"), tx: t }, { trustAccountId: account.id, clientPartyId: c1, matterId: m1 });
    const b = await openClientSubledger({ ...as("admin"), tx: t }, { trustAccountId: account.id, clientPartyId: c2, matterId: m2 });
    return { a, b };
  });
  if (!subs) return;
  const depositDate = `${period}-03`;
  // Any movement of trust money waits for BOTH an attorney and a CPA to approve the trust rules.
  await r.step("trust", "trust.deposit_retainer.sampleford", (t) =>
    postTransaction({ ...as("bookkeeper"), tx: t }, { kind: "deposit", trustAccountId: account.id, effectiveDate: depositDate, reason: "DEMO retainer deposit (fictional)", fundsSource: "client", amount: 350_000n, subledgerId: subs.a.id, reference: "DEMO-DEP-1" })
  );
  const second = await r.step("trust", "trust.deposit_retainer.fictiva", (t) =>
    postTransaction({ ...as("bookkeeper"), tx: t }, { kind: "deposit", trustAccountId: account.id, effectiveDate: `${period}-10`, reason: "DEMO retainer deposit (fictional)", fundsSource: "client", amount: 150_000n, subledgerId: subs.b.id, reference: "DEMO-DEP-2" })
  );
  if (second) {
    await r.step("trust", "trust.hold_disputed_funds", (t) =>
      placeHold({ ...as("bookkeeper"), tx: t }, { trustAccountId: account.id, subledgerId: subs.b.id, amount: 50_000n, reason: "DEMO: client disputes part of an invoice" })
    );
  } else {
    // Nothing was posted (the trust gate is pending), so there is nothing to hold yet.
    const gate = RULE_GATES.trustAccounting.key;
    r.record("trust", "trust.hold_disputed_funds", "blocked", placeholderFor(gate), gate);
  }
  await r.step("trust", "trust.import_bank_statement", (t) =>
    importStatement({ ...as("bookkeeper"), tx: t }, {
      trustAccountId: account.id,
      period,
      openingBalance: 0n,
      closingBalance: 500_000n,
      source: "manual",
      note: "DEMO statement typed in by the bookkeeper (bank feed is simulated in the demo)",
      lines: [
        { postedOn: `${period}-04`, amount: 350_000n, description: "DEMO deposit", reference: "DEMO-DEP-1", kind: "deposit" },
        { postedOn: `${period}-11`, amount: 150_000n, description: "DEMO deposit", reference: "DEMO-DEP-2", kind: "deposit" },
      ],
    })
  );
  await r.step("trust", "trust.prepare_three_way_reconciliation", (t) => prepareReconciliation({ ...as("bookkeeper"), tx: t }, { trustAccountId: account.id, period }));
}

// ---------------------------------------------------------------------------
// 7. Client communication: reply clocks, updates, overdue, court notice, health
// ---------------------------------------------------------------------------

async function seedAlerts(r: SeedRunner, ctx: SeedContext): Promise<void> {
  const { tenantId, now } = ctx;
  const m1 = ctx.matters.sampleford;
  const m2 = ctx.matters.fictiva;
  const c1 = ctx.clients.sampleford;
  const c2 = ctx.clients.fictiva;
  if (!m1 || !m2 || !c1 || !c2) return;

  // A deadline question from the client starts a reply clock (stays open for the presenter).
  await r.step("alerts", "reply_clock.deadline_question", async (t) => {
    const engine = await loadAlertsContext(t, tenantId);
    return recordInboundMessage(t, engine, { tenantId, matterId: m1, partyId: c1, channel: "portal", body: DEMO_CLIENT_MESSAGES.deadlineQuestion, occurredAt: new Date(now.getTime() - 3 * 3_600_000) });
  });
  // A routine question that a lawyer already answered (clock stopped by a human reply).
  await r.step("alerts", "reply_clock.answered_question", async (t) => {
    const engine = await loadAlertsContext(t, tenantId);
    const at = addDays(now, -2);
    await recordInboundMessage(t, engine, { tenantId, matterId: m2, partyId: c2, channel: "portal", body: DEMO_CLIENT_MESSAGES.routineQuestion, occurredAt: at });
    return recordOutboundMessage(t, engine, {
      tenantId,
      matterId: m2,
      partyId: c2,
      channel: "portal",
      body: DEMO_CLIENT_MESSAGES.firmReply,
      occurredAt: new Date(at.getTime() + 2 * 3_600_000),
      sender: { type: "user", userId: ctx.users.associate2 },
      expectsReply: true,
    });
  });
  // Client updates: one sent after lawyer approval, one AI-drafted waiting for approval.
  await r.step("alerts", "client_updates.sent_after_approval", async (t) => {
    const engine = await loadAlertsContext(t, tenantId);
    const staff = await loadAlertsStaff(t, tenantId, ctx.users.associate);
    const u = await createUpdate(t, engine, { tenantId, matterId: m1, recipientPartyIds: [c1], body: "DEMO update: the temporary orders hearing is set. We will call you this week to prepare.", author: { type: "user", staff }, now: addDays(now, -1) });
    if (u.status === "pending_approval") return approveUpdate(t, engine, { tenantId, updateId: u.id, staff, now: addDays(now, -1) });
    return u;
  });
  await r.step("alerts", "client_updates.ai_draft_pending_approval", async (t) => {
    const engine = await loadAlertsContext(t, tenantId);
    return createUpdate(t, engine, { tenantId, matterId: m2, recipientPartyIds: [c2], body: "DEMO draft: your status conference has been confirmed on the calendar. (Drafted automatically — a lawyer must approve before it is sent.)", author: { type: "system_draft" }, now });
  });
  // An internal task that is already overdue, flagged by the real overdue scan.
  await r.step("alerts", "overdue.task_and_scan", async (t) => {
    await createTask(t, {
      tenantId,
      kind: "demo.prepare_exhibit_list",
      title: "Prepare exhibit list for temporary orders hearing (DEMO)",
      owner: { type: "user", userId: ctx.users.paralegal },
      due: { at: addDays(now, -2) },
      matterId: m1,
      createdBy: user(ctx, "associate"),
      engine: "calendar-alerts",
    }, { now: addDays(now, -5) });
    const engine = await loadAlertsContext(t, tenantId);
    return runOverdueScan(t, engine, tenantId, now);
  });
  // A court notice arrives by email from a trusted (fictional) court sender.
  await r.step("alerts", "court_notice.trusted_sender", async (t) => {
    await updateEngineSettings(t, tenantId, ALERTS_ENGINE, { trustedCourtSenders: [{ domain: DEMO_FIRM.courtSenderDomain, label: "Example County clerk (fictional)", kind: "court" }] }, user(ctx, "admin"));
    const engine = await loadAlertsContext(t, tenantId);
    return ingestCourtEmail(
      t,
      engine,
      tenantId,
      {
        externalId: `demo-court-${tenantId}`,
        source: "manual",
        sourceAccount: null,
        fromAddress: DEMO_COURT_EMAIL.fromAddress,
        fromDisplayName: DEMO_COURT_EMAIL.fromDisplayName,
        subject: DEMO_COURT_EMAIL.subject,
        bodyText: DEMO_COURT_EMAIL.bodyText,
        receivedAt: new Date(now.getTime() - 40 * 60_000),
        auth: { spf: "pass", dkim: "pass", dkimDomain: DEMO_FIRM.courtSenderDomain, dmarc: "pass" },
        attachments: [],
      },
      now
    );
  });
  // A client-safety flag for the emergency inquiry is raised by intake itself; here an
  // internal "case health" flag example comes from the real health computation.
  for (const key of ["sampleford", "fictiva"] as const) {
    const id = ctx.matters[key];
    if (!id) continue;
    await r.step("alerts", `case_health.${key}`, async (t) => {
      const engine = await loadAlertsContext(t, tenantId);
      return computeMatterHealth(t, engine, tenantId, id, now);
    });
  }
  await r.step("alerts", "flags.internal_example", (t) =>
    raiseFlag(t, {
      tenantId,
      type: "demo.walkthrough_note",
      severity: "info",
      title: "DEMO: this firm is fictional — reset it from /demo before each demonstration",
      audience: "internal",
      recipients: { userIds: [ctx.users.admin] },
      matterId: m1,
      raisedBy: { type: "system" },
      engine: "demo",
    })
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface SeedResult {
  report: SeedReport;
  context: SeedContext;
}

/**
 * Seed a brand-new demo firm. `tx` must be a transaction scoped to `tenantId`
 * (withTenant) in which the firm row and its demo_tenants flag were just created.
 */
export async function seedDemoTenant(tx: TenantTx, input: { tenantId: string; now?: Date }): Promise<SeedResult> {
  const now = input.now ?? new Date();
  const r = new SeedRunner(tx);
  const startedAt = new Date().toISOString();
  const ctx = await seedFirm(r, tx, input.tenantId, now);
  await seedPermissions(r, ctx);
  await seedExistingMatters(r, ctx);
  await seedConflictHistory(r, ctx);
  await seedProspects(r, ctx);
  await seedCalendar(r, ctx);
  await seedDocuments(r, ctx);
  await seedTrust(r, ctx);
  await seedAlerts(r, ctx);
  const ids = { matters: { ...ctx.matters } as Record<string, string>, sessions: { ...ctx.sessions } as Record<string, string> };
  return { report: { seedVersion: DEMO_SEED_VERSION, startedAt, finishedAt: new Date().toISOString(), steps: r.steps, ids }, context: ctx };
}
