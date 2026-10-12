import { describe, expect, it } from "vitest";
import {
  BOOKING_HORIZON_DAYS,
  type Availability,
  type Schedule,
  checkSlot,
  generateSlots,
  openSlots,
} from "./slots";
import { DAY_MS, MINUTE_MS, clinicTime } from "./time";

const CHICAGO = "America/Chicago";
const utc = (iso: string) => new Date(iso);
const local = (slots: { start: Date }[], zone = CHICAGO) =>
  slots.map((s) => {
    const t = clinicTime(s.start, zone);
    return `${t.timeLabel} ${t.zoneAbbreviation}`;
  });

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    timeZone: CHICAGO,
    slotLengthMinutes: 30,
    // Wednesday 09:00 to 12:00.
    workingHours: [{ weekday: 3, startMinute: 9 * 60, endMinute: 12 * 60 }],
    breaks: [],
    timeOff: [],
    ...over,
  };
}

function availability(over: Partial<Availability> = {}): Availability {
  return { ...schedule(), active: [], ...over };
}

// Wednesday 14 October 2026. Chicago is on CDT (UTC-5), so 09:00 local is 14:00 UTC.
const DAY_START = utc("2026-10-14T05:00:00Z");
const DAY_END = utc("2026-10-15T05:00:00Z");
const NOW = utc("2026-10-12T12:00:00Z");

describe("slot generation", () => {
  it("steps the slot length from the start of working hours to the end", () => {
    const slots = generateSlots(schedule(), DAY_START, DAY_END);
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-10-14T14:00:00.000Z",
      "2026-10-14T14:30:00.000Z",
      "2026-10-14T15:00:00.000Z",
      "2026-10-14T15:30:00.000Z",
      "2026-10-14T16:00:00.000Z",
      "2026-10-14T16:30:00.000Z",
    ]);
    expect(slots.every((s) => s.end.getTime() - s.start.getTime() === 30 * MINUTE_MS)).toBe(true);
  });

  it("produces nothing on a weekday with no working hours", () => {
    expect(generateSlots(schedule(), utc("2026-10-15T05:00:00Z"), utc("2026-10-16T05:00:00Z"))).toEqual([]);
  });

  it("drops a last slot that would run past the end of working hours", () => {
    const slots = generateSlots(schedule({ slotLengthMinutes: 50 }), DAY_START, DAY_END);
    expect(local(slots)).toEqual(["9:00 AM CDT", "9:50 AM CDT", "10:40 AM CDT"]);
  });

  it("handles two working intervals on one day and returns them in order", () => {
    const slots = generateSlots(
      schedule({
        workingHours: [
          { weekday: 3, startMinute: 14 * 60, endMinute: 15 * 60 },
          { weekday: 3, startMinute: 9 * 60, endMinute: 10 * 60 },
        ],
      }),
      DAY_START,
      DAY_END,
    );
    expect(local(slots)).toEqual(["9:00 AM CDT", "9:30 AM CDT", "2:00 PM CDT", "2:30 PM CDT"]);
  });

  it("returns only slots that start inside the requested range, across several days", () => {
    const everyDay = schedule({
      workingHours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 540, endMinute: 600 })),
    });
    const slots = generateSlots(everyDay, utc("2026-10-14T14:30:00Z"), utc("2026-10-16T14:30:00Z"));
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-10-14T14:30:00.000Z",
      "2026-10-15T14:00:00.000Z",
      "2026-10-15T14:30:00.000Z",
      "2026-10-16T14:00:00.000Z",
    ]);
  });

  it("uses the clinic's zone, not UTC, to decide the weekday", () => {
    // Asia/Karachi is UTC+5 all year. Wednesday 01:00 local is Tuesday 20:00 UTC.
    const slots = generateSlots(
      schedule({ timeZone: "Asia/Karachi", workingHours: [{ weekday: 3, startMinute: 60, endMinute: 120 }] }),
      utc("2026-10-13T00:00:00Z"),
      utc("2026-10-15T00:00:00Z"),
    );
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-10-13T20:00:00.000Z",
      "2026-10-13T20:30:00.000Z",
    ]);
  });

  it("refuses a slot length that is not a positive whole number", () => {
    expect(() => generateSlots(schedule({ slotLengthMinutes: 0 }), DAY_START, DAY_END)).toThrow(RangeError);
    expect(() => generateSlots(schedule({ slotLengthMinutes: 7.5 }), DAY_START, DAY_END)).toThrow(RangeError);
  });
});

describe("daylight saving in America/Chicago (R71)", () => {
  // Sunday, 00:00 to 06:00 wall-clock, 30-minute slots.
  const night = schedule({ workingHours: [{ weekday: 7, startMinute: 0, endMinute: 6 * 60 }] });

  it("clocks go forward on 8 March 2026: no slot in the skipped hour", () => {
    const slots = generateSlots(night, utc("2026-03-08T06:00:00Z"), utc("2026-03-09T05:00:00Z"));
    // Six wall-clock hours are only five elapsed hours.
    expect(slots).toHaveLength(10);
    expect(local(slots)).toEqual([
      "12:00 AM CST",
      "12:30 AM CST",
      "1:00 AM CST",
      "1:30 AM CST",
      "3:00 AM CDT",
      "3:30 AM CDT",
      "4:00 AM CDT",
      "4:30 AM CDT",
      "5:00 AM CDT",
      "5:30 AM CDT",
    ]);
    expect(local(slots).some((label) => label.startsWith("2:"))).toBe(false);
    // Consecutive slots stay exactly one slot length apart in elapsed time.
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].start.getTime() - slots[i - 1].start.getTime()).toBe(30 * MINUTE_MS);
    }
    expect(slots[4].start).toEqual(utc("2026-03-08T08:00:00Z"));
  });

  it("clocks go back on 1 November 2026: slots for both occurrences of the repeated hour", () => {
    const slots = generateSlots(night, utc("2026-11-01T05:00:00Z"), utc("2026-11-02T06:00:00Z"));
    // Six wall-clock hours are seven elapsed hours.
    expect(slots).toHaveLength(14);
    expect(local(slots)).toEqual([
      "12:00 AM CDT",
      "12:30 AM CDT",
      "1:00 AM CDT",
      "1:30 AM CDT",
      "1:00 AM CST",
      "1:30 AM CST",
      "2:00 AM CST",
      "2:30 AM CST",
      "3:00 AM CST",
      "3:30 AM CST",
      "4:00 AM CST",
      "4:30 AM CST",
      "5:00 AM CST",
      "5:30 AM CST",
    ]);
    expect(new Set(slots.map((s) => s.start.getTime())).size).toBe(14);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].start.getTime() - slots[i - 1].start.getTime()).toBe(30 * MINUTE_MS);
    }
  });

  it("keeps ordinary daytime hours at the same wall-clock time on both sides of each change", () => {
    const daytime = schedule({
      workingHours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 540, endMinute: 570 })),
    });
    const spring = generateSlots(daytime, utc("2026-03-07T06:00:00Z"), utc("2026-03-10T05:00:00Z"));
    expect(spring.map((s) => s.start.toISOString())).toEqual([
      "2026-03-07T15:00:00.000Z", // 09:00 CST
      "2026-03-08T14:00:00.000Z", // 09:00 CDT
      "2026-03-09T14:00:00.000Z",
    ]);
    const autumn = generateSlots(daytime, utc("2026-10-31T05:00:00Z"), utc("2026-11-03T06:00:00Z"));
    expect(autumn.map((s) => s.start.toISOString())).toEqual([
      "2026-10-31T14:00:00.000Z", // 09:00 CDT
      "2026-11-01T15:00:00.000Z", // 09:00 CST
      "2026-11-02T15:00:00.000Z",
    ]);
  });

  it("starts at the first instant after the gap when working hours begin in the skipped hour", () => {
    const slots = generateSlots(
      schedule({ workingHours: [{ weekday: 7, startMinute: 2 * 60 + 30, endMinute: 4 * 60 }] }),
      utc("2026-03-08T06:00:00Z"),
      utc("2026-03-09T05:00:00Z"),
    );
    expect(local(slots)).toEqual(["3:00 AM CDT", "3:30 AM CDT"]);
  });

  it("a break in the repeated hour starts at the earlier occurrence", () => {
    const open = openSlots(
      { ...night, breaks: [{ weekday: 7, startMinute: 60, endMinute: 2 * 60 }], active: [] },
      utc("2026-11-01T05:00:00Z"),
      utc("2026-11-02T06:00:00Z"),
      utc("2026-10-30T00:00:00Z"),
    );
    // 01:00 (earlier occurrence) to 02:00 CST covers both occurrences of the hour.
    expect(local(open).slice(0, 3)).toEqual(["12:00 AM CDT", "12:30 AM CDT", "2:00 AM CST"]);
    expect(open).toHaveLength(10);
  });
});

describe("open slots", () => {
  it("removes slots in breaks, in time off and with an active appointment", () => {
    const open = openSlots(
      availability({
        breaks: [{ weekday: 3, startMinute: 10 * 60, endMinute: 10 * 60 + 30 }],
        timeOff: [{ start: utc("2026-10-14T16:00:00Z"), end: utc("2026-10-14T17:00:00Z") }],
        active: [{ start: utc("2026-10-14T14:00:00Z"), end: utc("2026-10-14T14:30:00Z") }],
      }),
      DAY_START,
      DAY_END,
      NOW,
    );
    expect(local(open)).toEqual(["9:30 AM CDT", "10:30 AM CDT"]);
  });

  it("removes a slot that only partly overlaps a break or an appointment", () => {
    const open = openSlots(
      availability({
        breaks: [{ weekday: 3, startMinute: 9 * 60 + 45, endMinute: 10 * 60 }],
        // A 20-minute appointment left over from an earlier slot length.
        active: [{ start: utc("2026-10-14T15:20:00Z"), end: utc("2026-10-14T15:40:00Z") }],
      }),
      DAY_START,
      DAY_END,
      NOW,
    );
    expect(local(open)).toEqual(["9:00 AM CDT", "11:00 AM CDT", "11:30 AM CDT"]);
  });

  it("offers nothing that has already started", () => {
    const open = openSlots(availability(), DAY_START, DAY_END, utc("2026-10-14T15:00:00Z"));
    expect(local(open)).toEqual(["10:30 AM CDT", "11:00 AM CDT", "11:30 AM CDT"]);
  });

  it("offers nothing beyond 90 days", () => {
    const weekly = availability();
    const open = openSlots(weekly, NOW, new Date(NOW.getTime() + 200 * DAY_MS), NOW);
    const horizon = NOW.getTime() + BOOKING_HORIZON_DAYS * DAY_MS;
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((s) => s.start.getTime() <= horizon)).toBe(true);
    // 13 Wednesdays fall inside the horizon, six slots each.
    expect(open).toHaveLength(13 * 6);
  });
});

describe("booking rules for one slot (R24)", () => {
  const start = utc("2026-10-14T14:30:00Z"); // Wednesday 09:30 CDT

  it("accepts an open slot on the grid", () => {
    expect(checkSlot(availability(), start, NOW)).toEqual({
      ok: true,
      slot: { start, end: utc("2026-10-14T15:00:00Z") },
    });
  });

  it("refuses a slot in the past, or starting now", () => {
    expect(checkSlot(availability(), start, utc("2026-10-14T14:31:00Z"))).toEqual({ ok: false, problem: "past" });
    expect(checkSlot(availability(), start, start)).toEqual({ ok: false, problem: "past" });
  });

  it("refuses a slot more than 90 days ahead and accepts one inside 90 days", () => {
    const far = utc("2027-01-13T15:30:00Z"); // Wednesday 09:30 CST
    expect(checkSlot(availability(), far, new Date(far.getTime() - 90 * DAY_MS - 1))).toEqual({
      ok: false,
      problem: "beyond_horizon",
    });
    expect(checkSlot(availability(), far, new Date(far.getTime() - 90 * DAY_MS)).ok).toBe(true);
  });

  it("refuses a slot outside working hours", () => {
    for (const iso of [
      "2026-10-14T13:30:00Z", // 08:30, before opening
      "2026-10-14T17:00:00Z", // 12:00, at closing
      "2026-10-15T14:30:00Z", // Thursday, no hours
    ]) {
      expect(checkSlot(availability(), utc(iso), NOW)).toEqual({ ok: false, problem: "outside_hours" });
    }
  });

  it("refuses a last slot that would run past closing", () => {
    const a = availability({ slotLengthMinutes: 50 });
    expect(checkSlot(a, utc("2026-10-14T16:30:00Z"), NOW)).toEqual({ ok: false, problem: "outside_hours" });
  });

  it("refuses a start that is off the slot grid", () => {
    expect(checkSlot(availability(), utc("2026-10-14T14:15:00Z"), NOW)).toEqual({ ok: false, problem: "off_grid" });
    expect(checkSlot(availability(), utc("2026-10-14T14:30:01Z"), NOW)).toEqual({ ok: false, problem: "off_grid" });
  });

  it("refuses a slot in a break", () => {
    const a = availability({ breaks: [{ weekday: 3, startMinute: 9 * 60 + 30, endMinute: 10 * 60 }] });
    expect(checkSlot(a, start, NOW)).toEqual({ ok: false, problem: "in_break" });
    // The same break on another weekday does not apply.
    const other = availability({ breaks: [{ weekday: 4, startMinute: 9 * 60 + 30, endMinute: 10 * 60 }] });
    expect(checkSlot(other, start, NOW).ok).toBe(true);
  });

  it("refuses a slot in time off", () => {
    const a = availability({
      timeOff: [{ start: utc("2026-10-14T00:00:00Z"), end: utc("2026-10-15T00:00:00Z") }],
    });
    expect(checkSlot(a, start, NOW)).toEqual({ ok: false, problem: "in_time_off" });
  });

  it("refuses a slot with an active appointment, including a partial overlap", () => {
    const same = availability({ active: [{ start, end: utc("2026-10-14T15:00:00Z") }] });
    expect(checkSlot(same, start, NOW)).toEqual({ ok: false, problem: "occupied" });
    const partial = availability({
      active: [{ start: utc("2026-10-14T14:50:00Z"), end: utc("2026-10-14T15:10:00Z") }],
    });
    expect(checkSlot(partial, start, NOW)).toEqual({ ok: false, problem: "occupied" });
  });

  it("accepts a slot that only touches an appointment, a break or time off", () => {
    const a = availability({
      active: [{ start: utc("2026-10-14T14:00:00Z"), end: start }],
      breaks: [{ weekday: 3, startMinute: 10 * 60, endMinute: 10 * 60 + 30 }],
      timeOff: [{ start: utc("2026-10-14T15:00:00Z"), end: utc("2026-10-14T16:00:00Z") }],
    });
    expect(checkSlot(a, start, NOW).ok).toBe(true);
  });

  it("does not offer the skipped hour, and offers both occurrences of the repeated hour", () => {
    const night = availability({ workingHours: [{ weekday: 7, startMinute: 0, endMinute: 6 * 60 }] });
    const before = utc("2026-03-01T00:00:00Z");
    // 08:00 UTC on 8 March is 03:00 CDT, the fifth slot. Nothing exists at wall-clock 02:30.
    expect(checkSlot(night, utc("2026-03-08T08:00:00Z"), before).ok).toBe(true);
    expect(checkSlot(night, utc("2026-03-08T07:30:00Z"), before).ok).toBe(true); // 01:30 CST
    const autumn = utc("2026-10-25T00:00:00Z");
    expect(checkSlot(night, utc("2026-11-01T06:30:00Z"), autumn).ok).toBe(true); // 01:30 CDT
    expect(checkSlot(night, utc("2026-11-01T07:30:00Z"), autumn).ok).toBe(true); // 01:30 CST
  });
});
