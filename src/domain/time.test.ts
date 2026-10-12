import { describe, expect, it } from "vitest";
import {
  HOUR_MS,
  InvalidLocalDateError,
  UnknownTimeZoneError,
  addDays,
  ageOn,
  assertTimeZone,
  clinicTime,
  formatClinicTime,
  isLocalDate,
  isTimeZone,
  localDateOf,
  localToInstant,
  minuteOfDayOf,
  resolveLocal,
  weekdayOf,
  zoneAbbreviation,
} from "./time";

const CHICAGO = "America/Chicago";
// 2026 in America/Chicago: clocks go forward on 8 March (02:00 CST becomes 03:00 CDT, at
// 08:00 UTC) and back on 1 November (02:00 CDT becomes 01:00 CST, at 07:00 UTC).
const utc = (iso: string) => new Date(iso);

describe("time zones", () => {
  it("accepts IANA zones", () => {
    expect(isTimeZone(CHICAGO)).toBe(true);
    expect(isTimeZone("Asia/Karachi")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
  });

  it("rejects an unknown zone (R68)", () => {
    expect(isTimeZone("America/Springfield")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(() => assertTimeZone("Mars/Olympus")).toThrow(UnknownTimeZoneError);
    expect(() => localToInstant("2026-10-14", 540, "Not/AZone")).toThrow(UnknownTimeZoneError);
    expect(() => localDateOf(utc("2026-10-14T00:00:00Z"), "nope")).toThrow(UnknownTimeZoneError);
  });

  it("rejects a fixed offset, which has no daylight-saving rules", () => {
    expect(isTimeZone("+05:00")).toBe(false);
    expect(isTimeZone("-06:00")).toBe(false);
  });
});

describe("local dates", () => {
  it("gives the clinic's calendar date, not the UTC one", () => {
    // 03:00 UTC on the 15th is still the evening of the 14th in Chicago.
    expect(localDateOf(utc("2026-10-15T03:00:00Z"), CHICAGO)).toBe("2026-10-14");
    expect(localDateOf(utc("2026-10-15T03:00:00Z"), "Asia/Karachi")).toBe("2026-10-15");
  });

  it("numbers weekdays from Monday (1) to Sunday (7)", () => {
    expect(weekdayOf("2026-10-12")).toBe(1);
    expect(weekdayOf("2026-10-14")).toBe(3);
    expect(weekdayOf("2026-11-01")).toBe(7);
  });

  it("adds days on the calendar", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("validates local dates", () => {
    expect(isLocalDate("2026-02-28")).toBe(true);
    expect(isLocalDate("2026-02-30")).toBe(false);
    expect(isLocalDate("14/10/2026")).toBe(false);
    expect(() => weekdayOf("2026-13-01")).toThrow(InvalidLocalDateError);
  });
});

describe("wall-clock time to instant", () => {
  it("converts an ordinary time in summer and in winter", () => {
    expect(localToInstant("2026-10-14", 9 * 60, CHICAGO)).toEqual(utc("2026-10-14T14:00:00Z"));
    expect(localToInstant("2026-12-14", 9 * 60, CHICAGO)).toEqual(utc("2026-12-14T15:00:00Z"));
    expect(resolveLocal("2026-10-14", 9 * 60, CHICAGO).kind).toBe("exact");
  });

  it("treats minute 1440 as midnight at the end of the date", () => {
    expect(localToInstant("2026-10-14", 1440, CHICAGO)).toEqual(
      localToInstant("2026-10-15", 0, CHICAGO),
    );
  });

  it("round-trips through minuteOfDayOf", () => {
    const instant = localToInstant("2026-10-14", 13 * 60 + 45, CHICAGO);
    expect(minuteOfDayOf(instant, CHICAGO)).toBe(13 * 60 + 45);
  });

  it("refuses a minute outside the day", () => {
    expect(() => localToInstant("2026-10-14", -1, CHICAGO)).toThrow(RangeError);
    expect(() => localToInstant("2026-10-14", 1441, CHICAGO)).toThrow(RangeError);
    expect(() => localToInstant("2026-10-14", 9.5, CHICAGO)).toThrow(RangeError);
  });
});

describe("clocks go forward: 8 March 2026 in America/Chicago", () => {
  it("resolves a skipped time to the first instant after the gap", () => {
    for (const minute of [2 * 60, 2 * 60 + 30, 2 * 60 + 59]) {
      const r = resolveLocal("2026-03-08", minute, CHICAGO);
      expect(r.kind).toBe("skipped");
      expect(r.instant).toEqual(utc("2026-03-08T08:00:00Z"));
    }
    expect(formatClinicTime(utc("2026-03-08T08:00:00Z"), CHICAGO)).toBe(
      "Sun, Mar 8, 2026, 3:00 AM CDT",
    );
  });

  it("keeps the times on either side of the gap exact", () => {
    expect(resolveLocal("2026-03-08", 60 + 59, CHICAGO)).toEqual({
      instant: utc("2026-03-08T07:59:00Z"),
      kind: "exact",
    });
    expect(resolveLocal("2026-03-08", 3 * 60, CHICAGO)).toEqual({
      instant: utc("2026-03-08T08:00:00Z"),
      kind: "exact",
    });
  });

  it("makes the day 23 hours long", () => {
    const start = localToInstant("2026-03-08", 0, CHICAGO).getTime();
    const end = localToInstant("2026-03-08", 1440, CHICAGO).getTime();
    expect(end - start).toBe(23 * HOUR_MS);
  });
});

describe("clocks go back: 1 November 2026 in America/Chicago", () => {
  it("resolves a repeated time to its earlier occurrence", () => {
    const r = resolveLocal("2026-11-01", 60 + 30, CHICAGO);
    expect(r.kind).toBe("repeated");
    expect(r.instant).toEqual(utc("2026-11-01T06:30:00Z"));
    expect(resolveLocal("2026-11-01", 2 * 60, CHICAGO)).toEqual({
      instant: utc("2026-11-01T08:00:00Z"),
      kind: "exact",
    });
  });

  it("labels the two occurrences with different abbreviations (R72)", () => {
    const first = utc("2026-11-01T06:30:00Z");
    const second = utc("2026-11-01T07:30:00Z");
    expect(clinicTime(first, CHICAGO).timeLabel).toBe("1:30 AM");
    expect(clinicTime(second, CHICAGO).timeLabel).toBe("1:30 AM");
    expect(zoneAbbreviation(first, CHICAGO)).toBe("CDT");
    expect(zoneAbbreviation(second, CHICAGO)).toBe("CST");
    expect(formatClinicTime(first, CHICAGO)).toBe("Sun, Nov 1, 2026, 1:30 AM CDT");
    expect(formatClinicTime(second, CHICAGO)).toBe("Sun, Nov 1, 2026, 1:30 AM CST");
  });

  it("makes the day 25 hours long", () => {
    const start = localToInstant("2026-11-01", 0, CHICAGO).getTime();
    const end = localToInstant("2026-11-01", 1440, CHICAGO).getTime();
    expect(end - start).toBe(25 * HOUR_MS);
  });
});

describe("display", () => {
  it("always carries the zone abbreviation (R70)", () => {
    const t = clinicTime(utc("2026-10-14T14:00:00Z"), CHICAGO);
    expect(t).toEqual({
      date: "2026-10-14",
      dateLabel: "Wed, Oct 14, 2026",
      timeLabel: "9:00 AM",
      zoneAbbreviation: "CDT",
    });
  });

  it("shows the clinic's time whatever the viewer's zone is", () => {
    // The same instant is 19:00 in Karachi, but the clinic is in Chicago.
    expect(formatClinicTime(utc("2026-10-14T14:00:00Z"), CHICAGO)).toContain("9:00 AM CDT");
  });
});

describe("age", () => {
  it("counts completed years on the clinic's calendar", () => {
    expect(ageOn("1990-10-14", utc("2026-10-14T14:00:00Z"), CHICAGO)).toBe(36);
    expect(ageOn("1990-10-15", utc("2026-10-14T14:00:00Z"), CHICAGO)).toBe(35);
    // 03:00 UTC on the 15th is still the 14th in Chicago.
    expect(ageOn("1990-10-15", utc("2026-10-15T03:00:00Z"), CHICAGO)).toBe(35);
  });
});
