// Wave 3 foundation against a REAL Postgres (migration 0007):
//  - the shared ethical-screens view + src/core/screens.ts, incl. tenant isolation;
//  - the documents freeze trigger and the revoked DELETE;
//  - tenantRoute's permission option (runTenantHandler) returning 403, with
//    roles resolved from users.role, user_capabilities and firm_role_assignments.
//
// Runs as app_runtime (RLS enforced) inside ONE transaction that is rolled back.
// Statements expected to fail run in a savepoint (nested transaction) so the
// outer transaction stays usable. Skipped until 0007 is applied.

import { it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users } from "@/db/schema";
import { firmRoleAssignments } from "@/db/tables/foundation";
import { outcomeResponse, runTenantHandler, FORBIDDEN_BODY } from "@/tenancy/route";
import { activeScreensForUser, isScreened, screenedMatterIdsForUser, screenedUserIdsForMatter } from "./screens";
import { activeCapabilitiesByUser } from "./permissionActor";

// tenantRoute resolves the signed-in principal through @/auth/request; the
// test decides who is signed in. Everything else (roles, overrides, audit) is real.
const signedIn: { current: { userId: string | null; role: string; capabilities: string[] } | null } = { current: null };
vi.mock("@/auth/request", () => ({ requirePrincipal: async () => signedIn.current }));

class Rollback extends Error {}

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];

describeWithDb("wave 3 foundation against Postgres", () => {
  it("screens view, document freeze, DELETE refused and tenantRoute 403 in one rolled-back transaction", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = rows(await rawDb.execute(sql`select to_regclass('public.active_ethical_screens') as t`));
    if (!probe[0]?.t) ctx.skip(); // 0007 not applied yet

    try {
      await rawDb.transaction(async (raw) => {
        const stamp = Date.now();
        const [a] = await raw.insert(firms).values({ name: "Wave3 Firm A", slug: `wave3-a-${stamp}` }).returning({ id: firms.id });
        const [b] = await raw.insert(firms).values({ name: "Wave3 Firm B", slug: `wave3-b-${stamp}` }).returning({ id: firms.id });
        const A = a!.id;
        const B = b!.id;
        const asTenant = (id: string) => raw.execute(sql`select set_config('app.tenant_id', ${id}, true)`);
        await asTenant(A);
        const tx = raw as unknown as TenantTx;

        const mkUser = async (email: string, role: "attorney" | "intake_staff") =>
          (await tx.insert(users).values({ tenantId: A, email, displayName: email, role }).returning({ id: users.id }))[0]!.id;
        const lawyer = await mkUser("lawyer@w3.example", "attorney");
        const screenedLawyer = await mkUser("screened@w3.example", "attorney");
        const staff = await mkUser("staff@w3.example", "intake_staff");
        const keeper = await mkUser("keeper@w3.example", "intake_staff");
        const [client] = await tx.insert(parties).values({ tenantId: A, fullName: "Cara Client", normalizedName: "cara client" }).returning({ id: parties.id });
        const [matter] = await tx.insert(matters).values({ tenantId: A, primaryPartyId: client!.id }).returning({ id: matters.id });
        const M = matter!.id;

        // --- screens: one conflict-check screen, one document ethical-screen block,
        //     plus rows the view must NOT show (lifted screen, 'restricted' block).
        const [check] = rows(
          await tx.execute(sql`insert into conflict_checks (tenant_id, trigger, matter_id, outcome, status, hits)
                               values (${A}, 'manual', ${M}, 'possible', 'decided', '[{"x":1}]'::jsonb) returning id`)
        );
        const [decision] = rows(
          await tx.execute(sql`insert into conflict_decisions (tenant_id, check_id, decision, reason_code, screened_user_ids, decided_by_user_id)
                               values (${A}, ${check!.id}, 'proceed_with_screen', 'screen', ARRAY[${screenedLawyer}]::uuid[], ${lawyer}) returning id`)
        );
        await tx.execute(sql`insert into conflict_screens (tenant_id, decision_id, check_id, screened_user_id, matter_id, reason, status)
                             values (${A}, ${decision!.id}, ${check!.id}, ${screenedLawyer}, ${M}, 'former client', 'active'),
                                    (${A}, ${decision!.id}, ${check!.id}, ${lawyer}, ${M}, 'old screen', 'lifted')`);
        await tx.execute(sql`insert into document_access_blocks (tenant_id, user_id, matter_id, reason, created_by_user_id)
                             values (${A}, ${staff}, ${M}, 'ethical_screen', ${lawyer}),
                                    (${A}, ${keeper}, ${M}, 'restricted', ${lawyer})`);

        expect(await isScreened(tx, A, screenedLawyer, M)).toBe(true);
        expect(await isScreened(tx, A, staff, M)).toBe(true);
        expect(await isScreened(tx, A, lawyer, M)).toBe(false); // lifted
        expect(await isScreened(tx, A, keeper, M)).toBe(false); // 'restricted' block stays document-local
        expect((await screenedUserIdsForMatter(tx, A, M)).sort()).toEqual([screenedLawyer, staff].sort());
        expect([...(await screenedMatterIdsForUser(tx, A, screenedLawyer))]).toEqual([M]);
        const screens = await activeScreensForUser(tx, A, screenedLawyer);
        expect(screens).toHaveLength(1);
        expect(screens[0]).toMatchObject({ source: "conflict_screen", status: "active", matterId: M, tenantId: A });

        // Tenant isolation: scoped to firm B, nothing of firm A is visible
        // through the view, even when asking with A's ids.
        await asTenant(B);
        expect(rows(await tx.execute(sql`select count(*)::int as n from active_ethical_screens`))[0]!.n).toBe(0);
        expect(await isScreened(tx, A, screenedLawyer, M)).toBe(false);
        expect(await screenedUserIdsForMatter(tx, A, M)).toEqual([]);
        expect(await activeScreensForUser(tx, B, screenedLawyer)).toEqual([]);
        // ... and the app role may only read the view (the REST roles not even that).
        const privs = rows(
          await tx.execute(sql`select p, has_table_privilege(current_user, 'active_ethical_screens', p) as ok
                               from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p`)
        );
        expect(Object.fromEntries(privs.map((r) => [r.p, r.ok]))).toEqual({ SELECT: true, INSERT: false, UPDATE: false, DELETE: false, TRUNCATE: false });
        const rest = rows(
          await tx.execute(sql`select r from unnest(array['anon','authenticated']) r
                               where exists (select 1 from pg_roles where rolname = r)
                                 and has_table_privilege(r, 'active_ethical_screens', 'SELECT')`)
        );
        expect(rest).toEqual([]);
        await asTenant(A);
        expect(rows(await tx.execute(sql`select count(*)::int as n from active_ethical_screens`))[0]!.n).toBe(2);

        // --- documents: a version's content is frozen; DELETE is refused.
        const [doc] = rows(
          await tx.execute(sql`insert into documents (tenant_id, matter_id, document_type, storage_key, mime_type, size_bytes)
                               values (${A}, ${M}, 'pleading', 'tenant/a/doc-1/v1', 'application/pdf', 1234) returning id`)
        );
        const D = doc!.id as string;
        // Workflow columns stay editable; a missing checksum may be filled once.
        await tx.execute(sql`update documents set status = 'in_review', privilege_tag = 'privileged', name = 'Petition.pdf', updated_at = now() where id = ${D}`);
        await tx.execute(sql`update documents set sha256 = ${"a".repeat(64)} where id = ${D}`);
        const frozen = /content cannot change/;
        for (const change of [
          sql`update documents set storage_key = 'tenant/a/doc-1/evil' where id = ${D}`,
          sql`update documents set sha256 = ${"b".repeat(64)} where id = ${D}`,
          sql`update documents set sha256 = null where id = ${D}`,
          sql`update documents set size_bytes = 9999 where id = ${D}`,
          sql`update documents set mime_type = 'text/html' where id = ${D}`,
          sql`update documents set version = 2 where id = ${D}`,
        ]) {
          await expect(tx.transaction(async (sp) => sp.execute(change))).rejects.toThrow(frozen);
        }
        await expect(tx.transaction(async (sp) => sp.execute(sql`delete from documents where id = ${D}`))).rejects.toThrow(/permission denied/);
        const [still] = rows(await tx.execute(sql`select storage_key, sha256, status from documents where id = ${D}`));
        expect(still).toEqual({ storage_key: "tenant/a/doc-1/v1", sha256: "a".repeat(64), status: "in_review" });

        // --- tenantRoute({ right }): roles come from the database.
        const label = `POST /api/test/wave3-${stamp}`;
        const handler = vi.fn(async () => ({ ok: true }));

        // intake staff, no capability, no assigned role: 403 with a reason-free body, audited.
        signedIn.current = { userId: staff, role: "intake_staff", capabilities: [] };
        const denied = await runTenantHandler(tx, A, label, { right: "trust.record" }, handler);
        expect(denied).toEqual({ denied: true });
        expect(handler).not.toHaveBeenCalled();
        const res = outcomeResponse(denied);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual(FORBIDDEN_BODY);
        const audit = rows(
          await tx.execute(sql`select actor_user_id, payload from audit_events
                               where tenant_id = ${A} and action = 'access.denied' and payload->>'attempted' = ${label}`)
        );
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actor_user_id: staff, payload: { right: "trust.record", reason: "role_lacks_right" } });

        // the bookkeeper capability (user_capabilities, via the principal) grants it ...
        await tx.execute(sql`insert into user_capabilities (tenant_id, user_id, capability, granted_by_user_id, grant_reason)
                             values (${A}, ${staff}, 'bookkeeper', ${lawyer}, 'Keeps the books')`);
        expect((await activeCapabilitiesByUser(tx, A, [staff, keeper])).get(staff)).toEqual(["bookkeeper"]);
        signedIn.current = { userId: staff, role: "intake_staff", capabilities: ["bookkeeper"] };
        expect(await runTenantHandler(tx, A, label, { right: "trust.record" }, handler)).toEqual({ denied: false, value: { ok: true } });

        // ... and so does an assigned role (firm_role_assignments).
        await tx.insert(firmRoleAssignments).values({ tenantId: A, userId: keeper, role: "bookkeeper", grantedByUserId: lawyer, grantReason: "Backup bookkeeper" });
        signedIn.current = { userId: keeper, role: "intake_staff", capabilities: [] };
        const allowed = await runTenantHandler(tx, A, label, { right: "trust.record" }, async (c) => c.policy?.roles);
        expect(allowed).toEqual({ denied: false, value: ["intake_staff", "bookkeeper"] });

        // A screen beats every role: the screened lawyer cannot view the matter.
        const matterResource = async ({ tx: t, tenantId }: { tx: TenantTx; tenantId: string }) => ({
          type: "matter" as const,
          matterId: M,
          screenedUserIds: await screenedUserIdsForMatter(t, tenantId, M),
        });
        signedIn.current = { userId: screenedLawyer, role: "attorney", capabilities: [] };
        expect(await runTenantHandler(tx, A, label, { right: "matters.view", resource: matterResource }, handler)).toEqual({ denied: true });
        signedIn.current = { userId: lawyer, role: "attorney", capabilities: [] };
        expect((await runTenantHandler(tx, A, label, { right: "matters.view", resource: matterResource }, handler)).denied).toBe(false);

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
