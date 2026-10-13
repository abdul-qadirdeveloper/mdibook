import { describe, expect, it } from "vitest";
import {
  type BookedInterval,
  type ScheduleRules,
  affectedAppointments,
  affectedDates,
  fitsSchedule,
  hasOverlap,
  previewToken,
  withChange,
} from "./schedule-impact";
import { MINUTE_MS, localToInstant } from "./time";

const CHICAGO = "America/Chicago";
const at = (date: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return localToInstant(date, h * 60 + m, CHICAGO);
};
const appointment = (id: string, date: string, time: string, minutes = 30): BookedInterval => {
  const start = at(date, time);
  return { id, start, end: new Date(start.getTime() + minutes * MINUTE_MS) };
};

// Every day 09:00 to 17:00, lunch 12:00 to 13:00. 14 October 2026 is a Wednesday (weekday 3).
const everyDay = (startMinute: number, endMinute: number) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute, endMinute }));
const RULES: ScheduleRules = {
  timeZone: CHICAGO,
  workingHours: everyDay(9 * 60, 17 * 60),
  breaks: everyDay(12 * 60, 13 * 60),
  timeOff: [],
};
const NOW = new Date("2026-10-12T12:00:00Z");

describe("fitsSchedule", () => {
  it("fits inside working hours, outside breaks and time off", () => {
    expect(fitsSchedule(appointment("a", "2026-10-14", "09:00"), RULES)).toBe(true);
    expect(fitsSchedule(appointment("a", "2026-10-14", "16:30"), RULES)).toBe(true);
  });

  it("does not fit outside working hours, or when it runs past their end", () => {
    expect(fitsSchedule(appointment("a", "2026-10-14", "08:30"), RULES)).toBe(false);
    expect(fitsSchedule(appointment("a", "2026-10-14", "16:45"), RULES)).toBe(false);
    expect(fitsSchedule(appointment("a", "2026-10-14", "17:00"), RULES)).toBe(false);
  });

  it("does not fit when it overlaps a break, even partly", () => {
    expect(fitsSchedule(appointment("a", "2026-10-14", "12:00"), RULES)).toBe(false);
    expect(fitsSchedule(appointment("a", "2026-10-14", "11:45"), RULES)).toBe(false);
    expect(fitsSchedule(appointment("a", "2026-10-14", "13:00"), RULES)).toBe(true);
  });

  it("does not fit when it overlaps time off; touching its edge is fine", () => {
    const rules = { ...RULES, timeOff: [{ start: at("2026-10-14", "10:00"), end: at("2026-10-14", "11:00") }] };
    expect(fitsSchedule(appointment("a", "2026-10-14", "10:30"), rules)).toBe(false);
    expect(fitsSchedule(appointment("a", "2026-10-14", "09:30"), rules)).toBe(true);
    expect(fitsSchedule(appointment("a", "2026-10-14", "11:00"), rules)).toBe(true);
  });

  it("ignores the slot grid: a longer appointment made before a slot-length change still fits (R56)", () => {
    expect(fitsSchedule(appointment("a", "2026-10-14", "09:10", 45), RULES)).toBe(true);
  });

  it("uses the weekday of the clinic date, not the UTC date", () => {
    // Wednesday only, late evening in Chicago is already Thursday in UTC.
    const rules = { ...RULES, breaks: [], workingHours: [{ weekday: 3, startMinute: 18 * 60, endMinute: 23 * 60 }] };
    expect(fitsSchedule(appointment("a", "2026-10-14", "22:00"), rules)).toBe(true);
    expect(fitsSchedule(appointment("a", "2026-10-15", "22:00"), rules)).toBe(false);
  });
});

describe("affectedAppointments (R52)", () => {
  const booked = [
    appointment("late", "2026-10-14", "16:00"),
    appointment("early", "2026-10-14", "09:00"),
    appointment("next-day", "2026-10-15", "16:30"),
  ];

  it("shorter hours affect only the appointments left outside them, earliest first", () => {
    const after = withChange(RULES, { kind: "working_hours", intervals: everyDay(9 * 60, 16 * 60) });
    expect(affectedAppointments(booked, RULES, after, NOW).map((a) => a.id)).toEqual(["late", "next-day"]);
  });

  it("a new break affects the appointments it overlaps", () => {
    const after = withChange(RULES, { kind: "breaks", intervals: everyDay(9 * 60, 9 * 60 + 15) });
    expect(affectedAppointments(booked, RULES, after, NOW).map((a) => a.id)).toEqual(["early"]);
  });

  it("time off affects the appointments it overlaps and no others", () => {
    const after = withChange(RULES, {
      kind: "time_off",
      start: at("2026-10-14", "15:00"),
      end: at("2026-10-15", "12:00"),
    });
    expect(affectedAppointments(booked, RULES, after, NOW).map((a) => a.id)).toEqual(["late"]);
  });

  it("a change that removes nothing affects nothing", () => {
    const after = withChange(RULES, { kind: "working_hours", intervals: everyDay(8 * 60, 18 * 60) });
    expect(affectedAppointments(booked, RULES, after, NOW)).toEqual([]);
  });

  it("an appointment that has started is never affected", () => {
    const after = withChange(RULES, { kind: "working_hours", intervals: [] });
    const now = at("2026-10-14", "12:00");
    expect(affectedAppointments(booked, RULES, after, now).map((a) => a.id)).toEqual(["late", "next-day"]);
  });

  it("lists each clinic date once (R53)", () => {
    expect(affectedDates(booked, CHICAGO)).toEqual(["2026-10-14", "2026-10-15"]);
  });
});

describe("hasOverlap", () => {
  it("is true only for two intervals on the same weekday that share time", () => {
    expect(hasOverlap([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 700, endMinute: 800 }])).toBe(true);
    expect(hasOverlap([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 720, endMinute: 800 }])).toBe(false);
    expect(hasOverlap([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 2, startMinute: 540, endMinute: 720 }])).toBe(false);
  });
});

describe("previewToken (R53)", () => {
  const doctorId = "11111111-1111-4111-8111-111111111111";
  const change = { kind: "working_hours" as const, intervals: everyDay(9 * 60, 16 * 60) };
  const a = appointment("a", "2026-10-14", "16:00");
  const b = appointment("b", "2026-10-14", "16:30");

  it("is the same for the same change and the same appointments, in any order", () => {
    const reordered = { ...change, intervals: [...change.intervals].reverse() };
    expect(previewToken(doctorId, change, [a, b])).toBe(previewToken(doctorId, reordered, [b, a]));
  });

  it("changes when an appointment is added, removed or moved", () => {
    const token = previewToken(doctorId, change, [a]);
    expect(previewToken(doctorId, change, [a, b])).not.toBe(token);
    expect(previewToken(doctorId, change, [])).not.toBe(token);
    expect(previewToken(doctorId, change, [{ ...a, start: b.start }])).not.toBe(token);
  });

  it("cannot confirm a different change or another doctor's change", () => {
    const token = previewToken(doctorId, change, [a]);
    expect(previewToken(doctorId, { kind: "breaks", intervals: change.intervals }, [a])).not.toBe(token);
    expect(previewToken("22222222-2222-4222-8222-222222222222", change, [a])).not.toBe(token);
  });

  it("holds no id or time in readable form", () => {
    expect(previewToken(doctorId, change, [a])).toMatch(/^[0-9a-f]{64}$/);
  });
});
