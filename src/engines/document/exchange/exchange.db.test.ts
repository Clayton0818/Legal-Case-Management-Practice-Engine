// End-to-end check of outbound document sharing (c89) against a REAL
// Postgres: create → view → download → revoke → expire → download-limit,
// plus the required cross-tenant isolation proof (ADR-0001 §D5's spirit,
// applied to this feature): a tenant A link's token must not read tenant
// B's data even when B's own transaction is asked to look it up.
//
// Skipped without DATABASE_URL. Runs in ONE transaction that is rolled back
// at the end (document_access_log and document_share_links are append-
// only / revoke-only for app_runtime) — including the cross-tenant check,
// which works by calling `select set_config('app.tenant_id', ...)` a
// SECOND time, for a second synthetic firm, part way through the SAME
// transaction (exactly what withTenant() itself does, just invoked twice):
// RLS re-evaluates current_setting('app.tenant_id') on every statement, so
// switching it mid-transaction is a faithful stand-in for two separate
// requests, without needing two committed transactions and the cleanup
// that would come with them.

import { it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users } from "@/db/schema";
import { DEFAULT_DOCUMENT_SETTINGS } from "../settings";
import { MemoryStorageAdapter, StubMalwareScanner, StubOcrAdapter } from "../storage/adapters";
import { loadAccess } from "../access/service";
import { uploadDocument } from "../store/service";
import type { StaffViewer } from "../access/policy";
import { createShareLink, downloadSharedDocument, listShareLinks, revokeShareLink, viewSharedDocument } from "./service";
import { parseShareToken } from "./crypto";
import { DocumentError } from "../errors";

class Rollback extends Error {}

const enc = (s: string) => new TextEncoder().encode(s);
const setTenant = (tx: TenantTx, tenantId: string) => tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);

describeWithDb("outbound document sharing (c89) against Postgres", () => {
  it("create, view, download, revoke, expire, download-limit, and cross-tenant isolation, in one rolled-back transaction", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.document_share_links') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();

    try {
      await rawDb.transaction(async (raw) => {
        const tx = raw as unknown as TenantTx;
        const t0 = new Date("2026-03-01T00:00:00Z");

        const [firmA] = await raw.insert(firms).values({ name: "Exchange Test Firm A", slug: `exchange-a-${Date.now()}` }).returning({ id: firms.id });
        const [firmB] = await raw.insert(firms).values({ name: "Exchange Test Firm B", slug: `exchange-b-${Date.now()}` }).returning({ id: firms.id });
        const tenantA = firmA!.id;
        const tenantB = firmB!.id;

        // --- Set up a real matter + document under tenant A. ---
        await setTenant(tx, tenantA);
        const [lawyerRow] = await tx.insert(users).values({ tenantId: tenantA, email: "l@exchange.example", displayName: "Lee", role: "attorney" }).returning({ id: users.id });
        const [client] = await tx.insert(parties).values({ tenantId: tenantA, fullName: "Ana", normalizedName: "ana" }).returning({ id: parties.id });
        const [matter] = await tx.insert(matters).values({ tenantId: tenantA, primaryPartyId: client!.id, practiceArea: "family" }).returning({ id: matters.id });
        const perms = ["documents.read", "documents.write", "documents.approve"];
        const lawyer: StaffViewer = { kind: "staff", userId: lawyerRow!.id, role: "attorney", permissions: perms };
        const adapters = { storage: new MemoryStorageAdapter(), scanner: new StubMalwareScanner(), ocr: new StubOcrAdapter() };
        const { access } = await loadAccess(tx, tenantA, lawyer);
        const c = { tenantId: tenantA, viewer: lawyer, access, settings: DEFAULT_DOCUMENT_SETTINGS, adapters, now: t0 };

        const upload = await uploadDocument(tx, c, {
          matterId: matter!.id,
          bytes: enc("Exhibit A: the settlement draft."),
          filename: "exhibit-a.txt",
          declaredMimeType: "text/plain",
          documentType: "letter",
        });

        // --- Create a share link that needs no privileged override. ---
        const created = await createShareLink(tx, c, {
          groupId: upload.groupId,
          recipientType: "opposing_counsel",
          recipientLabel: "Jane Roe, Esq.",
          expiresAt: new Date(t0.getTime() + 2000).toISOString(),
        });
        expect(created.privilegedOverrideConfirmed).toBe(false);
        expect(created.token).toMatch(/^shl_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);

        // --- A plain view, then a download, both allowed and logged. ---
        const secret = parseShareToken(created.token)!.secret;
        const viewed = await viewSharedDocument(tx, tenantA, secret, new Date(t0.getTime() + 500));
        expect(viewed).toMatchObject({ linkId: created.linkId, groupId: upload.groupId, documentId: upload.documentId, name: "exhibit-a.txt" });

        const downloaded = await downloadSharedDocument(tx, tenantA, secret, adapters, new Date(t0.getTime() + 600));
        expect(Buffer.from(downloaded.bytes).toString()).toBe("Exhibit A: the settlement draft.");

        const afterOneDownload = await listShareLinks(tx, tenantA, { groupId: upload.groupId });
        expect(afterOneDownload).toHaveLength(1);
        expect(afterOneDownload[0]).toMatchObject({ downloadCount: 1, id: created.linkId });
        expect("tokenHash" in afterOneDownload[0]!).toBe(false);
        expect(afterOneDownload[0]!.accessCount).toEqual({ allowed: 2, denied: 0 }); // one view + one download

        // --- Expiry: the link we just used expires 2s after t0; at t0+3s it is denied, not served. ---
        await expect(viewSharedDocument(tx, tenantA, secret, new Date(t0.getTime() + 3000))).rejects.toMatchObject({ status: 410 });

        // --- Download limit on a fresh link. ---
        const limited = await createShareLink(tx, c, {
          groupId: upload.groupId,
          recipientType: "expert",
          expiresAt: new Date(t0.getTime() + 60_000).toISOString(),
          maxDownloads: 1,
        });
        const limitedSecret = parseShareToken(limited.token)!.secret;
        await downloadSharedDocument(tx, tenantA, limitedSecret, adapters, new Date(t0.getTime() + 700));
        await expect(downloadSharedDocument(tx, tenantA, limitedSecret, adapters, new Date(t0.getTime() + 800))).rejects.toMatchObject({ status: 429 });

        // --- Revoke: immediately denied afterwards, double-revoke refused. ---
        const revocable = await createShareLink(tx, c, { groupId: upload.groupId, recipientType: "other", expiresAt: new Date(t0.getTime() + 60_000).toISOString() });
        const revocableSecret = parseShareToken(revocable.token)!.secret;
        await revokeShareLink(tx, c, revocable.linkId, "Sent to the wrong address.");
        await expect(viewSharedDocument(tx, tenantA, revocableSecret, new Date(t0.getTime() + 900))).rejects.toMatchObject({ status: 410 });
        await expect(revokeShareLink(tx, c, revocable.linkId, "again")).rejects.toMatchObject({ status: 409 });

        // --- Privileged document: creating a link needs the explicit override. ---
        const privileged = await uploadDocument(tx, c, { matterId: matter!.id, bytes: enc("Privileged memo."), filename: "memo.txt", declaredMimeType: "text/plain", privilegeTag: "privileged" });
        await expect(createShareLink(tx, c, { groupId: privileged.groupId, recipientType: "client", expiresAt: new Date(t0.getTime() + 60_000).toISOString() })).rejects.toBeInstanceOf(DocumentError);
        const overridden = await createShareLink(tx, c, {
          groupId: privileged.groupId,
          recipientType: "client",
          expiresAt: new Date(t0.getTime() + 60_000).toISOString(),
          confirmSharePrivileged: true,
          privilegedOverrideReason: "Court-ordered disclosure to the client.",
        });
        expect(overridden.privilegedOverrideConfirmed).toBe(true);

        // --- A non-attorney (no documents.approve) cannot create a share link at all. ---
        const paralegal: StaffViewer = { kind: "staff", userId: lawyerRow!.id, role: "intake_staff", permissions: ["documents.read", "documents.write"] };
        await expect(createShareLink(tx, { ...c, viewer: paralegal }, { groupId: upload.groupId, recipientType: "other", expiresAt: new Date(t0.getTime() + 60_000).toISOString() })).rejects.toBeInstanceOf(
          DocumentError
        );

        // --- Cross-tenant isolation: tenant B's own transaction must not be able to use tenant A's live, unexpired, unrevoked link. ---
        const freshForIsolation = await createShareLink(tx, c, { groupId: upload.groupId, recipientType: "other", expiresAt: new Date(t0.getTime() + 60_000).toISOString() });
        const isolationSecret = parseShareToken(freshForIsolation.token)!.secret;

        await setTenant(tx, tenantB);
        // The denial must be "no such link" (invalid_token / 404), not merely refused for some other reason —
        // confirming RLS hid the row entirely rather than the policy layer rejecting a visible one.
        await expect(downloadSharedDocument(tx, tenantB, isolationSecret, adapters, new Date(t0.getTime() + 1000))).rejects.toMatchObject({ status: 404 });
        // And switching back to tenant A, the SAME token works again — proving the denial above was really about
        // which tenant was asking, not something wrong with the token or the link itself.
        await setTenant(tx, tenantA);
        const stillWorks = await viewSharedDocument(tx, tenantA, isolationSecret, new Date(t0.getTime() + 1100));
        expect(stillWorks.linkId).toBe(freshForIsolation.linkId);

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
