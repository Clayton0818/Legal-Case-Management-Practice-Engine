import { describe, expect, it } from "vitest";
import {
  BOUNCE_DUE_BUSINESS_HOURS,
  CLIENT_BOUNCE_FLAG_TYPE,
  CLIENT_BOUNCE_TASK_KIND,
  STAFF_BOUNCE_FLAG_TYPE,
  clientBounceRecipients,
  planEmailBounce,
  type BounceFacts,
} from "./emailBouncePlan";

const LAWYER = "11111111-1111-4111-8111-111111111111";
const INTAKE_A = "22222222-2222-4222-8222-222222222222";
const INTAKE_B = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";
const PARTY = "55555555-5555-4555-8555-555555555555";
const MATTER = "66666666-6666-4666-8666-666666666666";
const STAFF = "77777777-7777-4777-8777-777777777777";

function client(overrides: Partial<BounceFacts> = {}): BounceFacts {
  return {
    notificationId: "n-1",
    recipientType: "party",
    matterId: MATTER,
    urgent: false,
    detail: "Permanent bounce (HardBounce).",
    partyId: PARTY,
    partyDvSensitive: false,
    assignedLawyerId: LAWYER,
    intakeStaffIds: [INTAKE_A, INTAKE_B],
    bouncedUserId: null,
    bouncedUserName: null,
    adminIds: [ADMIN],
    ...overrides,
  };
}

function staff(overrides: Partial<BounceFacts> = {}): BounceFacts {
  return client({
    recipientType: "user",
    partyId: null,
    assignedLawyerId: null,
    intakeStaffIds: [],
    bouncedUserId: STAFF,
    bouncedUserName: "Pat Para",
    matterId: null,
    ...overrides,
  });
}

describe("client email bounces", () => {
  it("alerts the responsible lawyer AND every intake staff member, with a task owned by the lawyer", () => {
    const plan = planEmailBounce(client());
    expect(plan.kind).toBe("client");
    if (plan.kind !== "client") return;
    expect(plan.flag.recipientUserIds).toEqual([LAWYER, INTAKE_A, INTAKE_B]);
    expect(plan.flag).toMatchObject({ type: CLIENT_BOUNCE_FLAG_TYPE, severity: "warning", urgent: false, dedupeKey: `client_email_bounced:${PARTY}` });
    expect(plan.task).toEqual({
      kind: CLIENT_BOUNCE_TASK_KIND,
      title: "Confirm a working, safe email address with the client",
      owner: { type: "user", userId: LAWYER },
      dueBusinessHours: BOUNCE_DUE_BUSINESS_HOURS.standard,
      sourceRef: "notification:n-1",
    });
  });

  it("lawyer only, when the firm has no intake staff", () => {
    const plan = planEmailBounce(client({ intakeStaffIds: [] }));
    expect(plan.kind === "client" && plan.flag.recipientUserIds).toEqual([LAWYER]);
  });

  it("intake staff only (task pooled to the firm), when the matter has no active lawyer", () => {
    const plan = planEmailBounce(client({ assignedLawyerId: null }));
    expect(plan.kind).toBe("client");
    if (plan.kind !== "client") return;
    expect(plan.flag.recipientUserIds).toEqual([INTAKE_A, INTAKE_B]);
    expect(plan.task.owner).toEqual({ type: "firm" });
  });

  it("falls back to the firm admins when there is neither a lawyer nor intake staff", () => {
    const plan = planEmailBounce(client({ assignedLawyerId: null, intakeStaffIds: [] }));
    expect(plan.kind === "client" && plan.flag.recipientUserIds).toEqual([ADMIN]);
  });

  it("does nothing (and says why) only when the firm has nobody active at all", () => {
    const plan = planEmailBounce(client({ assignedLawyerId: null, intakeStaffIds: [], adminIds: [] }));
    expect(plan.kind).toBe("none");
  });

  it("works with no matter on the notification", () => {
    const plan = planEmailBounce(client({ matterId: null, assignedLawyerId: null }));
    expect(plan.kind === "client" && plan.flag.recipientUserIds).toEqual([INTAKE_A, INTAKE_B]);
  });

  it("does not list the same person twice (lawyer who is also intake staff)", () => {
    expect(clientBounceRecipients({ assignedLawyerId: LAWYER, intakeStaffIds: [LAWYER, INTAKE_A, INTAKE_A], adminIds: [ADMIN] })).toEqual([
      LAWYER,
      INTAKE_A,
    ]);
  });

  it("DV-sensitive clients: high severity, 2 business hours, and the lawyer decides how to reach them", () => {
    const plan = planEmailBounce(client({ partyDvSensitive: true }));
    expect(plan.kind).toBe("client");
    if (plan.kind !== "client") return;
    expect(plan.flag.severity).toBe("high");
    expect(plan.flag.urgent).toBe(true);
    expect(plan.task.dueBusinessHours).toBe(BOUNCE_DUE_BUSINESS_HOURS.priority);
    expect(plan.flag.summary).toMatch(/DV-sensitive: the responsible lawyer decides how to reach them/);
  });

  it("urgent notices: high severity and 2 business hours, without the DV sentence", () => {
    const plan = planEmailBounce(client({ urgent: true }));
    expect(plan.kind).toBe("client");
    if (plan.kind !== "client") return;
    expect(plan.flag.severity).toBe("high");
    expect(plan.task.dueBusinessHours).toBe(2);
    expect(plan.flag.summary).not.toMatch(/DV-sensitive/);
  });

  it("wording is internal, gives the reason, and never suggests switching to an unsafe channel", () => {
    const plan = planEmailBounce(client());
    if (plan.kind !== "client") throw new Error("expected a client plan");
    expect(plan.flag.title).toBe("Client email could not be delivered");
    expect(plan.flag.summary).toContain("(Permanent bounce (HardBounce))");
    expect(plan.flag.summary).toMatch(/still waiting in the client portal/);
    expect(plan.flag.summary).toMatch(/do not switch to another channel that is not on their safe-contact list/);
    expect(plan.flag.summary).not.toContain("@");
  });
});

describe("staff email bounces", () => {
  it("flags the firm admins with the staff member's name and no task", () => {
    const plan = planEmailBounce(staff());
    expect(plan.kind).toBe("staff");
    if (plan.kind !== "staff") return;
    expect(plan.flag).toMatchObject({
      type: STAFF_BOUNCE_FLAG_TYPE,
      severity: "warning",
      recipientUserIds: [ADMIN],
      dedupeKey: `staff_email_bounced:${STAFF}`,
      title: "A staff member's email could not be delivered",
    });
    expect(plan.flag.summary).toBe(
      "Alerts to Pat Para are not reaching their inbox (Permanent bounce (HardBounce)). Check the email address on their account."
    );
    expect("task" in plan).toBe(false);
  });

  it("includes the bounced admin when they are the only admin, and falls back to them when there are none", () => {
    const only = planEmailBounce(staff({ bouncedUserId: ADMIN, adminIds: [ADMIN] }));
    expect(only.kind === "staff" && only.flag.recipientUserIds).toEqual([ADMIN]);
    const none = planEmailBounce(staff({ adminIds: [] }));
    expect(none.kind === "staff" && none.flag.recipientUserIds).toEqual([STAFF]);
  });

  it("uses a generic reason when the webhook gave none", () => {
    const plan = planEmailBounce(staff({ detail: null }));
    expect(plan.kind === "staff" && plan.flag.summary).toMatch(/\(permanent bounce\)/);
  });
});
