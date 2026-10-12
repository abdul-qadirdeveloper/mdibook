import { describe, expect, it } from "vitest";
import { HOUR_MS, formatClinicTime, localToInstant } from "./time";
import { isInsideWindow, isLateCancel, patientCanReschedule, windowOpensAt } from "./window";

const START = new Date("2026-10-14T14:00:00Z");
const before = (hours: number, ms = 0) => new Date(START.getTime() - hours * HOUR_MS + ms);

describe("cancellation window (R40)", () => {
  it("opens the configured number of hours before the start", () => {
    expect(windowOpensAt(START, 24)).toEqual(new Date("2026-10-13T14:00:00Z"));
    expect(windowOpensAt(START, 48)).toEqual(new Date("2026-10-12T14:00:00Z"));
    expect(windowOpensAt(START, 0)).toEqual(START);
  });

  it("refuses a negative window", () => {
    expect(() => windowOpensAt(START, -1)).toThrow(RangeError);
  });

  it("is inside from the opening instant until the start", () => {
    expect(isInsideWindow(before(24, -1), START, 24)).toBe(false);
    expect(isInsideWindow(before(24), START, 24)).toBe(true);
    expect(isInsideWindow(before(1), START, 24)).toBe(true);
    expect(isInsideWindow(START, START, 24)).toBe(false);
  });

  it("is never inside when the clinic sets the window to zero", () => {
    expect(isInsideWindow(before(0, -1), START, 0)).toBe(false);
    expect(patientCanReschedule(before(0, -1), START, 0)).toBe(true);
  });
});

describe("elapsed time across a clock change (R40)", () => {
  const CHICAGO = "America/Chicago";

  it("clocks go forward: 24 elapsed hours before 09:00 on 8 March is 08:00 the day before", () => {
    const start = localToInstant("2026-03-08", 9 * 60, CHICAGO);
    const opens = windowOpensAt(start, 24);
    expect(start.getTime() - opens.getTime()).toBe(24 * HOUR_MS);
    expect(formatClinicTime(opens, CHICAGO)).toBe("Sat, Mar 7, 2026, 8:00 AM CST");
    // The same wall-clock time the day before is only 23 hours earlier: already inside.
    const sameWallClock = localToInstant("2026-03-07", 9 * 60, CHICAGO);
    expect(isInsideWindow(sameWallClock, start, 24)).toBe(true);
    expect(patientCanReschedule(sameWallClock, start, 24)).toBe(false);
  });

  it("clocks go back: 24 elapsed hours before 09:00 on 1 November is 10:00 the day before", () => {
    const start = localToInstant("2026-11-01", 9 * 60, CHICAGO);
    const opens = windowOpensAt(start, 24);
    expect(start.getTime() - opens.getTime()).toBe(24 * HOUR_MS);
    expect(formatClinicTime(opens, CHICAGO)).toBe("Sat, Oct 31, 2026, 10:00 AM CDT");
    // The same wall-clock time the day before is 25 hours earlier: still outside.
    const sameWallClock = localToInstant("2026-10-31", 9 * 60, CHICAGO);
    expect(isInsideWindow(sameWallClock, start, 24)).toBe(false);
    expect(patientCanReschedule(sameWallClock, start, 24)).toBe(true);
  });
});

describe("patient reschedule (R34)", () => {
  it("is allowed only before the window opens", () => {
    expect(patientCanReschedule(before(24, -1), START, 24)).toBe(true);
    expect(patientCanReschedule(before(24), START, 24)).toBe(false);
    expect(patientCanReschedule(before(2), START, 24)).toBe(false);
  });
});

describe("late cancel flag (R38, R39, R42)", () => {
  it("is not set for a patient cancelling before the window opens", () => {
    expect(isLateCancel("patient", before(24, -1), START, 24)).toBe(false);
  });

  it("is set for a patient cancelling inside the window", () => {
    expect(isLateCancel("patient", before(24), START, 24)).toBe(true);
    expect(isLateCancel("patient", before(0, -1), START, 24)).toBe(true);
  });

  it("is never set for staff or a doctor", () => {
    for (const role of ["staff", "doctor", "admin"] as const) {
      expect(isLateCancel(role, before(1), START, 24)).toBe(false);
    }
  });

  it("follows the clinic's own window", () => {
    expect(isLateCancel("patient", before(30), START, 48)).toBe(true);
    expect(isLateCancel("patient", before(30), START, 24)).toBe(false);
  });
});
