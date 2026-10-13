import { describe, it, expect } from "vitest";
import {
  addBusinessDays,
  addBusinessHours,
  addBusinessMinutes,
  addClockHours,
  businessDaysBetween,
  businessHoursBetween,
  endOfQuietTime,
  fromLocal,
  hoursBetweenOnClock,
  isBusinessTime,
  isQuietTime,
  localDateString,
  nextBusinessStart,
  validateCalendar,
  type BusinessCalendar,
} from "./businessHours";

const nineToFive = [{ start: "09:00", end: "17:00" }];

/** Mon–Fri 9–5 in Texas (America/Chicago), with a July 4th holiday. */
const texasFirm: BusinessCalendar = {
  timeZone: "America/Chicago",
  weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive },
  holidays: [{ date: "2026-07-03", name: "Independence Day (observed)" }, "2026-12-25"],
};

/** Always open — makes DST day lengths visible. */
const alwaysOpen: BusinessCalendar = {
  timeZone: "America/Chicago",
  weekly: {
    mon: [{ start: "00:00", end: "24:00" }],
    tue: [{ start: "00:00", end: "24:00" }],
    wed: [{ start: "00:00", end: "24:00" }],
    thu: [{ start: "00:00", end: "24:00" }],
    fri: [{ start: "00:00", end: "24:00" }],
    sat: [{ start: "00:00", end: "24:00" }],
    sun: [{ start: "00:00", end: "24:00" }],
  },
  holidays: [],
};

/** Local Chicago wall time → Date. */
const chi = (y: number, mo: number, d: number, h = 0, mi = 0) => fromLocal(y, mo, d, h, mi, "America/Chicago");

describe("fromLocal / time-zone conversion", () => {
  it("converts CDT and CST wall times", () => {
    expect(chi(2026, 9, 25, 9).toISOString()).toBe("2026-09-25T14:00:00.000Z"); // CDT, UTC-5
    expect(chi(2026, 12, 1, 9).toISOString()).toBe("2026-12-01T15:00:00.000Z"); // CST, UTC-6
  });

  it("resolves a spring-forward gap time to the same wall time after the jump", () => {
    // 2026-03-08 02:30 does not exist in Chicago; 03:30 CDT = 08:30Z.
    expect(chi(2026, 3, 8, 2, 30).toISOString()).toBe("2026-03-08T08:30:00.000Z");
  });

  it("resolves a fall-back ambiguous time to the first occurrence", () => {
    // 2026-11-01 01:30 happens twice; first is CDT (06:30Z).
    expect(chi(2026, 11, 1, 1, 30).toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("formats local dates in the firm's zone", () => {
    // 03:00Z on Sep 26 is still Sep 25 in Chicago.
    expect(localDateString(new Date("2026-09-26T03:00:00Z"), "America/Chicago")).toBe("2026-09-25");
  });
});

describe("validateCalendar", () => {
  it("rejects bad zones, bad times, inverted intervals and empty calendars", () => {
    expect(() => validateCalendar({ ...texasFirm, timeZone: "Mars/Olympus" })).toThrow(/time zone/);
    expect(() => validateCalendar({ ...texasFirm, weekly: { mon: [{ start: "9am", end: "17:00" }] } })).toThrow(/HH:MM/);
    expect(() => validateCalendar({ ...texasFirm, weekly: { mon: [{ start: "17:00", end: "09:00" }] } })).toThrow(/end after/);
    expect(() => validateCalendar({ ...texasFirm, weekly: {} })).toThrow(/no business hours/);
    expect(() => validateCalendar({ ...texasFirm, holidays: ["July 4"] })).toThrow(/holiday/);
  });
});

describe("isBusinessTime / nextBusinessStart", () => {
  it("knows open, closed, weekend and holiday times", () => {
    expect(isBusinessTime(chi(2026, 9, 25, 10), texasFirm)).toBe(true); // Fri 10am
    expect(isBusinessTime(chi(2026, 9, 25, 17), texasFirm)).toBe(false); // closing time is exclusive
    expect(isBusinessTime(chi(2026, 9, 25, 8, 59), texasFirm)).toBe(false);
    expect(isBusinessTime(chi(2026, 9, 26, 10), texasFirm)).toBe(false); // Saturday
    expect(isBusinessTime(chi(2026, 7, 3, 10), texasFirm)).toBe(false); // holiday
  });

  it("finds the next opening", () => {
    expect(nextBusinessStart(chi(2026, 9, 25, 18), texasFirm)).toEqual(chi(2026, 9, 28, 9)); // Fri eve → Mon 9
    expect(nextBusinessStart(chi(2026, 9, 25, 11), texasFirm)).toEqual(chi(2026, 9, 25, 11)); // already open
    expect(nextBusinessStart(chi(2026, 7, 2, 18), texasFirm)).toEqual(chi(2026, 7, 6, 9)); // skips Fri holiday
  });
});

describe("addBusinessHours", () => {
  it("adds within a single day", () => {
    expect(addBusinessHours(chi(2026, 9, 21, 9), 3, texasFirm)).toEqual(chi(2026, 9, 21, 12));
  });

  it("lands exactly on closing time rather than the next opening", () => {
    expect(addBusinessHours(chi(2026, 9, 21, 9), 8, texasFirm)).toEqual(chi(2026, 9, 21, 17));
  });

  it("carries over the night", () => {
    expect(addBusinessHours(chi(2026, 9, 21, 16), 2, texasFirm)).toEqual(chi(2026, 9, 22, 10));
  });

  it("c43: a Friday-evening message is due 24 business hours later, not on Saturday", () => {
    // Fri 6pm → clock starts Mon 9am; 24h at 8h/day = Mon, Tue, Wed → Wed 5pm.
    expect(addBusinessHours(chi(2026, 9, 25, 18), 24, texasFirm)).toEqual(chi(2026, 9, 30, 17));
  });

  it("starts after-hours and weekend clocks at the next opening", () => {
    expect(addBusinessHours(chi(2026, 9, 22, 6), 1, texasFirm)).toEqual(chi(2026, 9, 22, 10)); // before opening
    expect(addBusinessHours(chi(2026, 9, 27, 12), 1, texasFirm)).toEqual(chi(2026, 9, 28, 10)); // Sunday
  });

  it("skips holidays", () => {
    // Thu Jul 2 4pm + 2h: 1h Thu, Fri Jul 3 is a holiday, weekend, → Mon Jul 6 10am.
    expect(addBusinessHours(chi(2026, 7, 2, 16), 2, texasFirm)).toEqual(chi(2026, 7, 6, 10));
  });

  it("handles fractional hours and minutes", () => {
    expect(addBusinessHours(chi(2026, 9, 21, 16, 45), 0.5, texasFirm)).toEqual(chi(2026, 9, 22, 9, 15));
    expect(addBusinessMinutes(chi(2026, 9, 21, 16, 50), 15, texasFirm)).toEqual(chi(2026, 9, 22, 9, 5));
  });

  it("returns the start for zero hours and rejects negative hours", () => {
    const start = chi(2026, 9, 26, 3);
    expect(addBusinessHours(start, 0, texasFirm)).toEqual(start);
    expect(() => addBusinessHours(start, -1, texasFirm)).toThrow();
  });

  it("keeps a 9–5 day at 8 business hours across both DST changes", () => {
    // DST starts Sun 2026-03-08 and ends Sun 2026-11-01 in Chicago.
    expect(addBusinessHours(chi(2026, 3, 6, 9), 16, texasFirm)).toEqual(chi(2026, 3, 9, 17));
    expect(addBusinessHours(chi(2026, 10, 30, 13), 8, texasFirm)).toEqual(chi(2026, 11, 2, 13));
  });

  it("counts real elapsed time on DST days when the firm is always open", () => {
    // Spring forward: the local day Mar 8 has only 23 hours.
    expect(addBusinessHours(chi(2026, 3, 8, 0), 23, alwaysOpen)).toEqual(chi(2026, 3, 9, 0));
    // Fall back: Nov 1 has 25 hours.
    expect(addBusinessHours(chi(2026, 11, 1, 0), 25, alwaysOpen)).toEqual(chi(2026, 11, 2, 0));
  });

  it("supports split days (lunch closures)", () => {
    const split: BusinessCalendar = {
      timeZone: "America/Chicago",
      weekly: { mon: [{ start: "13:00", end: "17:00" }, { start: "08:00", end: "12:00" }] },
      holidays: [],
    };
    expect(addBusinessHours(chi(2026, 9, 21, 11), 2, split)).toEqual(chi(2026, 9, 21, 14));
  });

  it("works in other zones", () => {
    const ny: BusinessCalendar = { ...texasFirm, timeZone: "America/New_York", holidays: [] };
    const start = fromLocal(2026, 9, 21, 16, 0, "America/New_York");
    expect(addBusinessHours(start, 2, ny)).toEqual(fromLocal(2026, 9, 22, 10, 0, "America/New_York"));
  });
});

describe("businessHoursBetween", () => {
  it("counts only business time", () => {
    expect(businessHoursBetween(chi(2026, 9, 25, 16), chi(2026, 9, 28, 10), texasFirm)).toBe(2); // Fri 4pm → Mon 10am
    expect(businessHoursBetween(chi(2026, 9, 26, 8), chi(2026, 9, 27, 20), texasFirm)).toBe(0); // weekend
    expect(businessHoursBetween(chi(2026, 7, 2, 9), chi(2026, 7, 6, 17), texasFirm)).toBe(16); // Thu + Mon, Fri holiday
  });

  it("is the inverse of addBusinessHours", () => {
    const start = chi(2026, 9, 25, 18);
    for (const h of [0.25, 1, 7.5, 24, 48, 100]) {
      expect(businessHoursBetween(start, addBusinessHours(start, h, texasFirm), texasFirm)).toBeCloseTo(h, 6);
    }
  });

  it("is negative when the end is before the start", () => {
    expect(businessHoursBetween(chi(2026, 9, 21, 12), chi(2026, 9, 21, 10), texasFirm)).toBe(-2);
  });

  it("counts DST days in real hours", () => {
    expect(businessHoursBetween(chi(2026, 3, 8, 0), chi(2026, 3, 9, 0), alwaysOpen)).toBe(23);
    expect(businessHoursBetween(chi(2026, 11, 1, 0), chi(2026, 11, 2, 0), alwaysOpen)).toBe(25);
  });
});

describe("clock switch (business vs real)", () => {
  it("real clock ignores the firm calendar (court notices, deadline safety nets)", () => {
    const fri5pm = chi(2026, 9, 25, 17);
    expect(addClockHours(fri5pm, 24, "real", texasFirm)).toEqual(chi(2026, 9, 26, 17));
    expect(addClockHours(fri5pm, 24, "business", texasFirm)).toEqual(chi(2026, 9, 30, 17));
    expect(hoursBetweenOnClock(fri5pm, chi(2026, 9, 28, 9), "real", texasFirm)).toBe(64);
    expect(hoursBetweenOnClock(fri5pm, chi(2026, 9, 28, 9), "business", texasFirm)).toBe(0);
  });
});

describe("quiet hours", () => {
  const quiet = { start: "21:00", end: "08:00" };
  it("detects quiet time across midnight", () => {
    expect(isQuietTime(chi(2026, 9, 25, 22), quiet, "America/Chicago")).toBe(true);
    expect(isQuietTime(chi(2026, 9, 26, 7, 59), quiet, "America/Chicago")).toBe(true);
    expect(isQuietTime(chi(2026, 9, 26, 8), quiet, "America/Chicago")).toBe(false);
    expect(isQuietTime(chi(2026, 9, 26, 12), quiet, "America/Chicago")).toBe(false);
  });

  it("computes when quiet time ends", () => {
    expect(endOfQuietTime(chi(2026, 9, 25, 22), quiet, "America/Chicago")).toEqual(chi(2026, 9, 26, 8));
    expect(endOfQuietTime(chi(2026, 9, 26, 6), quiet, "America/Chicago")).toEqual(chi(2026, 9, 26, 8));
    expect(endOfQuietTime(chi(2026, 9, 26, 12), quiet, "America/Chicago")).toEqual(chi(2026, 9, 26, 12));
  });
});

describe("addBusinessDays", () => {
  // 2026-06-29 is a Monday; Friday 2026-07-03 is a holiday on texasFirm.
  it("keeps the wall-clock time and skips weekends and holidays", () => {
    expect(addBusinessDays(chi(2026, 6, 29, 10, 30), 1, texasFirm)).toEqual(chi(2026, 6, 30, 10, 30));
    expect(addBusinessDays(chi(2026, 7, 2, 10, 30), 1, texasFirm)).toEqual(chi(2026, 7, 6, 10, 30)); // Thu → Mon (Fri holiday)
    expect(addBusinessDays(chi(2026, 6, 29, 10, 30), 5, texasFirm)).toEqual(chi(2026, 7, 7, 10, 30));
    expect(addBusinessDays(chi(2026, 6, 29, 10, 30), 0, texasFirm)).toEqual(chi(2026, 6, 29, 10, 30));
  });

  it("counts a start outside business hours from the previous close", () => {
    expect(addBusinessDays(chi(2026, 6, 26, 18), 1, texasFirm)).toEqual(chi(2026, 6, 29, 17)); // Fri 6pm → Mon close
    expect(addBusinessDays(chi(2026, 6, 27, 12), 1, texasFirm)).toEqual(chi(2026, 6, 29, 17)); // Saturday → Mon close
    expect(addBusinessDays(chi(2026, 6, 29, 7), 1, texasFirm)).toEqual(chi(2026, 6, 29, 17)); // Mon 7am (= Fri close) → Mon close
  });

  it("follows the firm's own day length instead of assuming 8 hours", () => {
    const nineToSix = [{ start: "09:00", end: "18:00" }];
    const longDays: BusinessCalendar = { timeZone: "America/Chicago", weekly: { mon: nineToSix, tue: nineToSix, wed: nineToSix, thu: nineToSix, fri: nineToSix }, holidays: [] };
    expect(addBusinessDays(chi(2026, 6, 29, 10), 1, longDays)).toEqual(chi(2026, 6, 30, 10));
    // the old approximation (8 business hours) landed on the same day:
    expect(addBusinessHours(chi(2026, 6, 29, 10), 8, longDays)).toEqual(chi(2026, 6, 29, 18));
  });

  it("clamps into a shorter day (half-day Friday) and across a lunch break", () => {
    const halfFriday: BusinessCalendar = {
      timeZone: "America/Chicago",
      weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:00" }], fri: [{ start: "09:00", end: "12:00" }] },
      holidays: [],
    };
    expect(addBusinessDays(chi(2026, 7, 2, 15), 1, halfFriday)).toEqual(chi(2026, 7, 3, 12)); // Thu 3pm → Fri close (noon)
    expect(addBusinessDays(chi(2026, 7, 1, 12, 30), 1, halfFriday)).toEqual(chi(2026, 7, 2, 12)); // Wed 12:30 → Thu lunch → Thu noon close
  });

  it("is business-equivalent to the old 8-hour approximation on a 9–5 calendar", () => {
    // Every quarter hour across two weeks: zero business hours between the two answers.
    for (let t = chi(2026, 6, 22).getTime(); t < chi(2026, 7, 6).getTime(); t += 15 * 60_000) {
      for (const days of [1, 2, 5]) {
        const start = new Date(t);
        const viaDays = addBusinessDays(start, days, texasFirm);
        const viaHours = addBusinessHours(start, days * 8, texasFirm);
        expect(Math.abs(businessHoursBetween(viaDays, viaHours, texasFirm)), `${start.toISOString()} +${days}`).toBe(0);
      }
    }
  });

  it("handles 24:00 closes and DST", () => {
    expect(addBusinessDays(chi(2026, 3, 7, 12), 1, alwaysOpen)).toEqual(chi(2026, 3, 8, 12)); // spring-forward Sunday
    expect(addBusinessDays(chi(2026, 11, 1, 1, 30), 1, alwaysOpen)).toEqual(chi(2026, 11, 2, 1, 30));
    const lateWeek: BusinessCalendar = { timeZone: "America/Chicago", weekly: { fri: [{ start: "09:00", end: "24:00" }], mon: [{ start: "09:00", end: "24:00" }] }, holidays: [] };
    expect(addBusinessDays(chi(2026, 6, 27, 0, 30), 1, lateWeek)).toEqual(chi(2026, 6, 30, 0, 0)); // Sat 00:30 = Fri close → Mon close (24:00)
  });

  it("rejects fractional or negative days", () => {
    expect(() => addBusinessDays(chi(2026, 6, 29, 10), 1.5, texasFirm)).toThrow(/whole number/);
    expect(() => addBusinessDays(chi(2026, 6, 29, 10), -1, texasFirm)).toThrow(/whole number/);
  });
});

describe("businessDaysBetween", () => {
  it("counts each business day as 1 whatever its length", () => {
    expect(businessDaysBetween(chi(2026, 6, 29, 9), chi(2026, 6, 30, 9), texasFirm)).toBe(1);
    expect(businessDaysBetween(chi(2026, 6, 29, 13), chi(2026, 6, 29, 17), texasFirm)).toBe(0.5);
    expect(businessDaysBetween(chi(2026, 6, 26, 17), chi(2026, 7, 6, 17), texasFirm)).toBe(5); // Fri→Mon+1wk, holiday skipped
    expect(businessDaysBetween(chi(2026, 6, 30, 9), chi(2026, 6, 29, 9), texasFirm)).toBe(-1);
    const halfFriday: BusinessCalendar = { timeZone: "America/Chicago", weekly: { thu: nineToFive, fri: [{ start: "09:00", end: "12:00" }] }, holidays: [] };
    expect(businessDaysBetween(chi(2026, 7, 2, 9), chi(2026, 7, 3, 12), halfFriday)).toBe(2);
  });

  it("equals business hours / 8 on a 9–5 calendar (the old approximation)", () => {
    const a = chi(2026, 6, 23, 11, 15);
    for (const b of [chi(2026, 6, 23, 16), chi(2026, 6, 26, 10, 45), chi(2026, 7, 8, 14)]) {
      expect(businessDaysBetween(a, b, texasFirm)).toBeCloseTo(businessHoursBetween(a, b, texasFirm) / 8, 10);
    }
  });

  it("is consistent with addBusinessDays", () => {
    const start = chi(2026, 6, 29, 10, 30);
    for (const n of [1, 3, 10]) expect(businessDaysBetween(start, addBusinessDays(start, n, texasFirm), texasFirm)).toBeCloseTo(n, 10);
  });
});
