// End-to-end check of the Document-engine workflow cards (c39 engagement
// signing, c40 delivery confirmation, c41 client sign-off, c49 required-
// documents checklist) against a REAL Postgres, in one rolled-back
// transaction — same pattern as document.db.test.ts.
//
// Skipped without DATABASE_URL, and until the integration migration has
// created document_checklist_items (the newest table this batch adds).

import { it, expect, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users, documents } from "@/db/schema";
import { documentChecklistItems } from "@/db/tables/document";
import { DEFAULT_DOCUMENT_SETTINGS } from "./settings";
import { MemoryStorageAdapter, StubMalwareScanner, StubOcrAdapter } from "./storage/adapters";
import { loadAccess } from "./access/service";
import { provisionMatterFolders } from "./folders/service";
import { uploadDocument } from "./store/service";
import type { StaffViewer } from "./access/policy";
import { resetApprovalStateForTests, setApprovals } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "./gates";
import { recordClientSignature, recordFirmCountersignature, setSignatureAdapter, startEngagementAgreement } from "./engagement/service";
import { askAboutDelivery, recordDeliveryAnswer } from "./delivery/service";
import { recordClientDecision, requestClientSignoff } from "./review/service";
import { acceptChecklistItem, activateChecklistTemplate, createChecklistTemplate, listClientChecklist, recordChecklistUpload, requestChecklistItem, seedChecklistForMatter } from "./checklist/service";

class Rollback extends Error {}

const enc = (s: string) => new TextEncoder().encode(s);

afterEach(() => {
  resetApprovalStateForTests();
  setSignatureAdapter(null);
});

describeWithDb("document workflow cards c39/c40/c41/c49 against Postgres", () => {
  it("engagement signing, delivery confirmation, client sign-off and the required-documents checklist", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.document_checklist_items') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();

    resetApprovalStateForTests();
    setApprovals([
      { gateKey: VENDOR_GATES.esignature.key, reviewerKind: "vendor_dpa", approvedByName: "Test DPA", approvedAt: new Date() },
      {
        gateKey: RULE_GATES.feeAgreementTerms.key,
        reviewerKind: "attorney",
        approvedByName: "Test Attorney",
        approvedAt: new Date(),
        approvedText: "Flat fee of $2,500, due on signing.",
      },
    ]);
    setSignatureAdapter({ name: "fake-vendor", async requestSignature() { return { vendorRequestId: "req_test_1" }; } });

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Workflow Test Firm", slug: `doc-wf-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;

        const [attorneyRow] = await tx.insert(users).values({ tenantId, email: "attorney@wf.example", displayName: "Avery", role: "attorney" }).returning({ id: users.id });
        const [client] = await tx.insert(parties).values({ tenantId, fullName: "Jamie Rivera", normalizedName: "jamie rivera" }).returning({ id: parties.id });
        const [matter] = await tx.insert(matters).values({ tenantId, primaryPartyId: client!.id, practiceArea: null }).returning({ id: matters.id });
        const perms = ["documents.read", "documents.write", "documents.approve", "settings.manage"];
        const attorney: StaffViewer = { kind: "staff", userId: attorneyRow!.id, role: "attorney", permissions: perms };
        const adapters = { storage: new MemoryStorageAdapter(), scanner: new StubMalwareScanner(), ocr: new StubOcrAdapter() };

        await provisionMatterFolders(tx, tenantId, matter!.id);
        const { access } = await loadAccess(tx, tenantId, attorney);
        const engagementCtx = { tenantId, viewer: attorney, access, settings: DEFAULT_DOCUMENT_SETTINGS, adapters };

        // --- c39: engagement agreement signing --------------------------
        const started = await startEngagementAgreement(tx, engagementCtx, { matterId: matter!.id, firmName: "Workflow Test Firm" });
        expect(started.status).toBe("sent_for_signature");
        if (started.status !== "sent_for_signature") return;

        await recordClientSignature(tx, { tenantId, documentId: started.documentId, partyId: client!.id });
        const countersigned = await recordFirmCountersignature(tx, { tenantId, viewer: attorney, access }, { documentId: started.documentId });
        expect(countersigned).toMatchObject({ matterStage: "retained", intakeSessionClosed: false });

        const [matterRow] = await tx.select({ stage: matters.stage }).from(matters).where(eq(matters.id, matter!.id));
        expect(matterRow!.stage).toBe("retained");
        const [agreementDoc] = await tx.select({ status: documents.status, clientVisible: documents.clientVisible }).from(documents).where(eq(documents.id, started.documentId));
        expect(agreementDoc).toMatchObject({ status: "final", clientVisible: true });

        // --- c40: delivery confirmation ----------------------------------
        const otherUpload = await uploadDocument(tx, engagementCtx, {
          matterId: matter!.id,
          bytes: enc("Discovery responses for the record."),
          filename: "discovery.txt",
          declaredMimeType: "text/plain",
          documentType: "pleading",
        });

        const asked = await askAboutDelivery(tx, { tenantId, viewer: attorney, access }, { groupId: otherUpload.groupId });
        expect(asked.asked).toBe(true);
        const askedAgain = await askAboutDelivery(tx, { tenantId, viewer: attorney, access }, { groupId: otherUpload.groupId });
        expect(askedAgain.asked).toBe(false); // a question is already open

        const notYet = await recordDeliveryAnswer(tx, { tenantId, viewer: attorney, access }, { groupId: otherUpload.groupId, status: "not_yet" });
        expect(notYet.status).toBe("not_yet");
        expect(notYet.taskReopenedUntil).toBeInstanceOf(Date);

        const sent = await recordDeliveryAnswer(tx, { tenantId, viewer: attorney, access }, { groupId: otherUpload.groupId, status: "sent", method: "mail" });
        expect(sent.status).toBe("sent");

        // --- c41: client sign-off before filing --------------------------
        const signoff = await requestClientSignoff(tx, { tenantId, viewer: attorney, access }, { documentId: otherUpload.documentId, due: { hours: 48, clock: "business" } });
        expect(signoff.taskId).toBeTruthy();
        const [underReview] = await tx.select({ status: documents.status }).from(documents).where(eq(documents.id, otherUpload.documentId));
        expect(underReview!.status).toBe("client_review");

        const decision = await recordClientDecision(tx, { tenantId, documentId: otherUpload.documentId, partyId: client!.id, decision: "approved" });
        expect(decision.status).toBe("client_approved");

        // --- c49: required-documents checklist ----------------------------
        const template = await createChecklistTemplate(tx, tenantId, attorney, {
          name: "Firm-wide defaults",
          practiceArea: null,
          items: [{ key: "photo_id", label: "Photo ID", responsibleParty: "client" }],
        });
        await activateChecklistTemplate(tx, tenantId, attorney, template.id);
        const seeded = await seedChecklistForMatter(tx, tenantId, matter!.id);
        expect(seeded.created).toBe(1);

        const [item] = await tx
          .select()
          .from(documentChecklistItems)
          .where(eq(documentChecklistItems.matterId, matter!.id));
        expect(item!.status).toBe("missing");

        const requested = await requestChecklistItem(tx, tenantId, attorney, access, item!.id, { due: { hours: 72, clock: "business" } });
        expect(requested.status).toBe("requested");

        const received = await recordChecklistUpload(tx, tenantId, { type: "client", partyId: client!.id }, item!.id, {
          groupId: otherUpload.groupId,
          sizeBytes: 50_000,
          detectedMimeType: "application/pdf",
          pageCount: 2,
        });
        expect(received).toMatchObject({ status: "received", aiCheckStatus: "passed" });

        const accepted = await acceptChecklistItem(tx, tenantId, attorney, access, item!.id);
        expect(accepted.status).toBe("accepted");

        const clientView = await listClientChecklist(tx, tenantId, client!.id, matter!.id);
        expect(clientView).toEqual([{ id: item!.id, label: "Photo ID", description: "", status: "accepted", notApplicableReason: null }]);

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
