import { describe, expect, it } from "vitest";
import { agendaWindowEnd } from "./agenda";

describe("agendaWindowEnd", () => {
  it("returns the next UTC midnight after `now`", () => {
    const now = new Date("2026-11-05T14:30:00.000Z");
    expect(agendaWindowEnd(now).toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });

  it("rolls to the following day even when `now` is exactly midnight", () => {
    const now = new Date("2026-11-05T00:00:00.000Z");
    expect(agendaWindowEnd(now).toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });

  it("rolls correctly across a month boundary", () => {
    const now = new Date("2026-11-30T23:59:59.000Z");
    expect(agendaWindowEnd(now).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});
