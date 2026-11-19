// c124 against a REAL Postgres, in one rolled-back transaction: the group
// thread opens only after a lawyer marks joint representation and every
// client consents; it reaches only the clients (never the opposing party);
// client notices carry no case details; withdrawing consent closes it; and
// every step is audited. Skipped without DATABASE_URL.

import { expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matterParties, matters, parties, users } from "@/db/schema";
import { auditEvents, notificationOutbox } from "@/db/tables/foundation";
import { matterGroupMessages } from "@/db/tables/all-engines";
import { loadStaffContext } from "../permissions/service";
import { GROUP_MESSAGING_GATES } from "../gates";
import {
  endJointRepresentation,
  listGroupMatters,
  loadGroupView,
  markJointRepresentation,
  postClientGroupReply,
  postGroupMessage,
  recordSharingConsent,
  withdrawSharingConsent,
} from "./service";

class Rollback extends Error {}

describeWithDb("c124 group messaging against Postgres", () => {
  it("opens only with joint representation and every client's consent, and reaches only the clients", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.matter_group_messages') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Group Test Firm", slug: `group-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;
        const [lawyer, para] = await tx
          .insert(users)
          .values([
            { tenantId, email: "lee@group.example", displayName: "Lee Lawyer", role: "attorney" },
            { tenantId, email: "pat@group.example", displayName: "Pat Paralegal", role: "intake_staff" },
          ])
          .returning({ id: users.id });
        const [ann, bob, opp] = await tx
          .insert(parties)
          .values([
            { tenantId, fullName: "Ann Partner", normalizedName: "ann partner", email: "ann@client.example" },
            { tenantId, fullName: "Bob Partner", normalizedName: "bob partner", email: "bob@client.example" },
            { tenantId, fullName: "Olive Opposing", normalizedName: "olive opposing", email: "olive@other.example" },
          ])
          .returning({ id: parties.id });
        const [matter] = await tx.insert(matters).values({ tenantId, primaryPartyId: ann!.id, practiceArea: "family", stage: "retained", assignedUserId: lawyer!.id }).returning({ id: matters.id });
        const matterId = matter!.id;
        await tx.insert(matterParties).values([
          { tenantId, matterId, partyId: ann!.id, role: "client" },
          { tenantId, matterId, partyId: bob!.id, role: "client" },
          { tenantId, matterId, partyId: opp!.id, role: "opposing_party", isAdverse: true },
        ]);

        const lee = await loadStaffContext(tx, tenantId, { userId: lawyer!.id, role: "attorney", capabilities: [] });
        const pat = await loadStaffContext(tx, tenantId, { userId: para!.id, role: "intake_staff", capabilities: [] });

        expect((await listGroupMatters(tx, tenantId, lee)).map((m) => m.matterId)).toContain(matterId);

        // Closed at first; posting is refused with the reasons.
        let view = await loadGroupView(tx, tenantId, lee, matterId);
        expect(view.state.available).toBe(false);
        expect(view.consentWording.approved).toBe(false);
        expect(view.consentWording.text).toMatch(/PENDING/);
        await expect(postGroupMessage(tx, { tenantId, staff: lee, matterId, body: "Hello both" })).rejects.toThrow(/isn't available/);

        // Only a lawyer marks joint representation; consent needs it first.
        await expect(recordSharingConsent(tx, { tenantId, staff: pat, matterId, partyId: ann!.id })).rejects.toThrow(/joint representation first/);
        await expect(markJointRepresentation(tx, { tenantId, staff: pat, matterId })).rejects.toThrow(/Only a lawyer/);
        await markJointRepresentation(tx, { tenantId, staff: lee, matterId, note: "Engagement letter signed by both" });

        // Consent can't be recorded for the opposing party.
        await expect(recordSharingConsent(tx, { tenantId, staff: pat, matterId, partyId: opp!.id })).rejects.toThrow(/current client/);
        const consent = await recordSharingConsent(tx, { tenantId, staff: pat, matterId, partyId: ann!.id });
        expect(consent.wordingApproved).toBe(false);
        view = await loadGroupView(tx, tenantId, lee, matterId);
        expect(view.state.available).toBe(false);
        expect(view.state.awaitingConsent).toEqual([bob!.id]);
        await recordSharingConsent(tx, { tenantId, staff: pat, matterId, partyId: bob!.id });

        // Open: a message reaches exactly Ann and Bob, never Olive.
        const posted = await postGroupMessage(tx, { tenantId, staff: pat, matterId, body: "  The mediation is next Tuesday.  " });
        expect(posted.recipientCount).toBe(2);
        const [msg] = await tx.select().from(matterGroupMessages).where(eq(matterGroupMessages.id, posted.messageId));
        expect(msg!.body).toBe("The mediation is next Tuesday.");
        expect([...msg!.recipientPartyIds].sort()).toEqual([ann!.id, bob!.id].sort());

        const notes = await tx.select().from(notificationOutbox).where(and(eq(notificationOutbox.tenantId, tenantId), eq(notificationOutbox.matterId, matterId)));
        expect(notes).toHaveLength(4);
        expect(notes.every((n) => n.templateKey === GROUP_MESSAGING_GATES.newMessageNotice.key)).toBe(true);
        expect(notes.every((n) => JSON.stringify(n.payload) === "{}")).toBe(true);
        expect(notes.some((n) => n.recipientPartyId === opp!.id)).toBe(false);

        // A client reply goes to the other client only.
        await postClientGroupReply(tx, { tenantId, matterId, partyId: bob!.id, body: "Thanks, I'll be there." });
        await expect(postClientGroupReply(tx, { tenantId, matterId, partyId: opp!.id, body: "Me too" })).rejects.toThrow(/Only a client/);
        view = await loadGroupView(tx, tenantId, lee, matterId);
        expect(view.messages).toHaveLength(2);
        expect(view.messages[0]!.authorName).toBe("Bob Partner");
        expect(view.messages[0]!.recipientCount).toBe(1);

        // Withdrawing consent closes the thread at once.
        await withdrawSharingConsent(tx, { tenantId, staff: pat, matterId, partyId: bob!.id, reason: "Called the office" });
        await expect(postGroupMessage(tx, { tenantId, staff: pat, matterId, body: "Anyone?" })).rejects.toThrow(/isn't available/);
        await recordSharingConsent(tx, { tenantId, staff: pat, matterId, partyId: bob!.id });
        expect((await loadGroupView(tx, tenantId, lee, matterId)).state.available).toBe(true);

        // Ending the joint representation closes it too.
        await expect(endJointRepresentation(tx, { tenantId, staff: lee, matterId, reason: "  " })).rejects.toThrow(/reason/);
        await endJointRepresentation(tx, { tenantId, staff: lee, matterId, reason: "Conflict arose between the clients" });
        expect((await loadGroupView(tx, tenantId, lee, matterId)).state.available).toBe(false);

        // Messages are append-only for the app role.
        const roles = (await tx.execute(sql`select has_table_privilege('app_runtime', 'matter_group_messages', 'UPDATE') as u, has_table_privilege('app_runtime', 'matter_group_messages', 'DELETE') as d`)) as unknown as { u: boolean; d: boolean }[];
        if (roles[0]) {
          expect(roles[0].u).toBe(false);
          expect(roles[0].d).toBe(false);
        }

        const actions = (
          await tx.select({ action: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.matterId, matterId)))
        ).map((r) => r.action);
        expect(actions).toContain("group_messaging.joint_marked");
        expect(actions).toContain("group_messaging.joint_ended");
        expect(actions.filter((a) => a === "group_messaging.consent_recorded")).toHaveLength(3);
        expect(actions).toContain("group_messaging.consent_withdrawn");
        expect(actions).toContain("group_messaging.message_posted");
        expect(actions).toContain("group_messaging.client_reply");

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
