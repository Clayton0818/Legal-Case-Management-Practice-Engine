// c87 — pure tests for email-to-matter matching, keyed to the spec's
// acceptance criteria (docs/product/features/document/c87-file-all-matter-email.md §10).

import { describe, it, expect } from "vitest";
import {
  decideFiling,
  isExcluded,
  normalizeAddress,
  normalizeCauseNumber,
  startsReplyClock,
  unmatchedPurgeAt,
  type EmailMessageMeta,
  type MatchContext,
  type MatterMatchProfile,
} from "./match";

const matter = (id: string, over: Partial<MatterMatchProfile> = {}): MatterMatchProfile => ({
  matterId: id, open: true, partyAddresses: [], partyNames: [], causeNumbers: [], ...over,
});

const msg = (over: Partial<EmailMessageMeta> = {}): EmailMessageMeta => ({
  threadId: null, from: "someone@example.com", to: ["lawyer@firm.test"], subject: "Hello", receivedAt: new Date("2026-10-29T12:00:00Z"), ...over,
});

const ctx = (matters: MatterMatchProfile[], over: Partial<MatchContext> = {}): MatchContext => ({
  matters, filedThreads: new Map(), firmDomains: ["firm.test"], screenedMatterIds: new Set(), excludedSenders: [], ...over,
});

describe("decideFiling", () => {
  it("criterion 1: the client's address on exactly one open matter auto-files", () => {
    const d = decideFiling(
      msg({ from: "Ana Client <ana@client.test>" }),
      ctx([matter("m1", { partyAddresses: ["ana@client.test"] }), matter("m2")])
    );
    expect(d).toEqual({ action: "auto_file", matterId: "m1", signals: ["address"] });
  });

  it("criterion 2: opposing counsel on three open matters with no cause number is only a suggestion", () => {
    const oc = "oc@otherfirm.test";
    const d = decideFiling(
      msg({ from: oc }),
      ctx([matter("m1", { partyAddresses: [oc] }), matter("m2", { partyAddresses: [oc] }), matter("m3", { partyAddresses: [oc] })])
    );
    expect(d.action).toBe("suggest");
    if (d.action === "suggest") expect(d.candidates.map((c) => c.matterId)).toEqual(["m1", "m2", "m3"]);
  });

  it("a cause number plus an agreeing signal auto-files; a cause number alone only suggests", () => {
    const oc = "oc@otherfirm.test";
    const matters = [
      matter("m1", { partyAddresses: [oc], causeNumbers: ["2026-CI-01234"] }),
      matter("m2", { partyAddresses: [oc], causeNumbers: ["2026-CI-09999"] }),
    ];
    const agreeing = decideFiling(msg({ from: oc, subject: "RE: Cause No. 2026 ci 01234 — hearing" }), ctx(matters));
    expect(agreeing).toEqual({ action: "auto_file", matterId: "m1", signals: ["address", "cause_number"] });

    const alone = decideFiling(msg({ from: "court@unknown.test", subject: "Cause 2026-CI-01234" }), ctx(matters));
    expect(alone.action).toBe("suggest");
  });

  it("criterion 4: a reply in a thread already filed to M is filed to M", () => {
    const d = decideFiling(msg({ threadId: "t1" }), ctx([matter("M")], { filedThreads: new Map([["t1", ["M"]]]) }));
    expect(d).toEqual({ action: "auto_file", matterId: "M", signals: ["thread"] });
  });

  it("closed matters are never auto-filed to", () => {
    const d = decideFiling(msg({ from: "ana@client.test" }), ctx([matter("m1", { open: false, partyAddresses: ["ana@client.test"] })]));
    expect(d.action).toBe("suggest");
  });

  it("name-only matches are suggestions, and single-word names never count", () => {
    const matters = [matter("m1", { partyNames: ["Maria Lopez", "Cher"] })];
    const d = decideFiling(msg({ subject: "Update on maria  lopez's documents" }), ctx(matters));
    expect(d.action).toBe("suggest");
    expect(decideFiling(msg({ subject: "Cher concert" }), ctx(matters))).toEqual({ action: "no_match" });
    expect(decideFiling(msg({ subject: "Mariana Lopezz" }), ctx(matters))).toEqual({ action: "no_match" });
  });

  it("criterion 5: a match on a screened matter goes to the admin queue with ids only", () => {
    const d = decideFiling(
      msg({ from: "ana@client.test", subject: "Private details here" }),
      ctx([matter("m1", { partyAddresses: ["ana@client.test"] })], { screenedMatterIds: new Set(["m1"]) })
    );
    expect(d).toEqual({ action: "screened_admin_queue", matterIds: ["m1"] });
  });

  it("a match on a screened AND an unscreened matter is never auto-filed", () => {
    const d = decideFiling(
      msg({ from: "x@client.test", threadId: "t" }),
      ctx([matter("m1", { partyAddresses: ["x@client.test"] }), matter("m2")], {
        filedThreads: new Map([["t", ["m2"]]]),
        screenedMatterIds: new Set(["m1"]),
      })
    );
    expect(d.action).toBe("suggest");
    if (d.action === "suggest") expect(d.candidates.map((c) => c.matterId)).toEqual(["m2"]);
  });

  it("the firm's own staff addresses never count as a party signal", () => {
    const d = decideFiling(
      msg({ from: "colleague@firm.test" }),
      ctx([matter("m1", { partyAddresses: ["colleague@firm.test"] })])
    );
    expect(d).toEqual({ action: "no_match" });
  });

  it("excluded senders and domains are left alone", () => {
    const c = ctx([matter("m1", { partyAddresses: ["ana@client.test"] })], { excludedSenders: ["@client.test"] });
    expect(decideFiling(msg({ from: "ana@client.test" }), c).action).toBe("excluded");
    expect(isExcluded("Doc <doctor@clinic.test>", ["doctor@clinic.test"])).toBe(true);
    expect(isExcluded("a@b.test", ["c.test"])).toBe(false);
  });

  it("criterion 3: unmatched metadata has a purge date 7 days out by default", () => {
    expect(unmatchedPurgeAt(new Date("2026-10-29T12:00:00Z")).toISOString()).toBe("2026-11-05T12:00:00.000Z");
    expect(() => unmatchedPurgeAt(new Date(), 1.5)).toThrow(RangeError);
  });
});

describe("helpers", () => {
  it("normalizes addresses and cause numbers", () => {
    expect(normalizeAddress("  Ana <ANA@Client.Test> ")).toBe("ana@client.test");
    expect(normalizeCauseNumber("2026-CI-01234")).toBe(normalizeCauseNumber("2026 ci 01234"));
  });

  it("only an auto-filed inbound client email starts the reply clock, and only if the firm turned it on", () => {
    const m = msg({ from: "ana@client.test" });
    const c = ctx([matter("m1", { partyAddresses: ["ana@client.test"] })]);
    const d = decideFiling(m, c);
    expect(startsReplyClock(d, m, ["ana@client.test"], true)).toBe(true);
    expect(startsReplyClock(d, m, ["ana@client.test"], false)).toBe(false);
    expect(startsReplyClock(d, m, ["other@client.test"], true)).toBe(false);
  });
});
