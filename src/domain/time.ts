// The only place that converts between instants and clinic wall-clock time (R69).
// Instants are JavaScript Dates (UTC). Local dates are "YYYY-MM-DD" strings, local times are
// minutes counted from local midnight. Nothing outside this file imports the time zone library.
import { Temporal } from "@js-temporal/polyfill";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** A calendar date in a clinic's time zone, "YYYY-MM-DD". */
export type LocalDate = string;

export class UnknownTimeZoneError extends Error {
  constructor() {
    super("Unknown time zone");
    this.name = "UnknownTimeZoneError";
  }
}

export class InvalidLocalDateError extends Error {
  constructor() {
    super("Invalid local date");
    this.name = "InvalidLocalDateError";
  }
}

// IANA names only ("America/Chicago", "UTC"). Fixed offsets such as "+05:00" are refused: a
// clinic's zone must carry its daylight-saving rules.
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isTimeZone(zone: string): boolean {
  if (!IANA_SHAPE.test(zone)) return false;
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(zone: string): void {
  if (!isTimeZone(zone)) throw new UnknownTimeZoneError();
}

function zoned(instant: Date, zone: string): Temporal.ZonedDateTime {
  assertTimeZone(zone);
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(zone);
}

function plainDate(date: LocalDate): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InvalidLocalDateError();
  try {
    return Temporal.PlainDate.from(date, { overflow: "reject" });
  } catch {
    throw new InvalidLocalDateError();
  }
}

export function isLocalDate(date: string): boolean {
  try {
    plainDate(date);
    return true;
  } catch {
    return false;
  }
}

/** The calendar date an instant falls on in the zone. */
export function localDateOf(instant: Date, zone: string): LocalDate {
  return zoned(instant, zone).toPlainDate().toString();
}

/** Minutes since local midnight on the wall clock, 0 to 1439. */
export function minuteOfDayOf(instant: Date, zone: string): number {
  const z = zoned(instant, zone);
  return z.hour * 60 + z.minute;
}

/** 1 (Monday) to 7 (Sunday). */
export function weekdayOf(date: LocalDate): number {
  return plainDate(date).dayOfWeek;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return plainDate(date).add({ days }).toString();
}

/**
 * How a wall-clock time maps to an instant on that date:
 * - exact: it happens once.
 * - repeated: it happens twice (clocks went back). The earlier occurrence is used.
 * - skipped: it never happens (clocks went forward). The first instant after the gap is used.
 */
export type LocalResolution = "exact" | "repeated" | "skipped";

export function resolveLocal(
  date: LocalDate,
  minuteOfDay: number,
  zone: string,
): { instant: Date; kind: LocalResolution } {
  assertTimeZone(zone);
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1440) {
    throw new RangeError("minuteOfDay must be an integer from 0 to 1440");
  }
  // 1440 is midnight at the end of the date.
  const wall = plainDate(date).toPlainDateTime().add({ minutes: minuteOfDay });
  const earlier = wall.toZonedDateTime(zone, { disambiguation: "earlier" });
  const later = wall.toZonedDateTime(zone, { disambiguation: "later" });

  if (earlier.epochMilliseconds === later.epochMilliseconds) {
    return { instant: new Date(earlier.epochMilliseconds), kind: "exact" };
  }
  if (earlier.toPlainDateTime().equals(wall)) {
    return { instant: new Date(earlier.epochMilliseconds), kind: "repeated" };
  }
  // In a gap "earlier" lands before it, so the next transition is the end of the gap.
  const afterGap = earlier.getTimeZoneTransition("next") ?? later;
  return { instant: new Date(afterGap.epochMilliseconds), kind: "skipped" };
}

/** The instant of a wall-clock time on a date. See resolveLocal for the two edge cases. */
export function localToInstant(date: LocalDate, minuteOfDay: number, zone: string): Date {
  return resolveLocal(date, minuteOfDay, zone).instant;
}

/** Short zone label at that instant, for example CDT or CST (R70, R72). */
export function zoneAbbreviation(instant: Date, zone: string): string {
  assertTimeZone(zone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "short",
  }).formatToParts(instant);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
}

export interface ClinicTime {
  /** "YYYY-MM-DD" in the clinic's zone. */
  date: LocalDate;
  /** For example "Wed, Oct 14, 2026". */
  dateLabel: string;
  /** For example "9:00 AM". */
  timeLabel: string;
  /** For example "CDT". Always shown next to the time. */
  zoneAbbreviation: string;
}

/** Everything needed to display an instant in the clinic's zone. */
export function clinicTime(instant: Date, zone: string): ClinicTime {
  assertTimeZone(zone);
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(instant);
  const timeLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
  return {
    date: localDateOf(instant, zone),
    dateLabel,
    timeLabel,
    zoneAbbreviation: zoneAbbreviation(instant, zone),
  };
}

/** For example "Wed, Oct 14, 2026, 9:00 AM CDT". */
export function formatClinicTime(instant: Date, zone: string): string {
  const t = clinicTime(instant, zone);
  return `${t.dateLabel}, ${t.timeLabel} ${t.zoneAbbreviation}`;
}

/** Completed years between a date of birth and the clinic's calendar date at an instant. */
export function ageOn(dateOfBirth: LocalDate, instant: Date, zone: string): number {
  const born = plainDate(dateOfBirth);
  const today = zoned(instant, zone).toPlainDate();
  return Math.max(0, born.until(today, { largestUnit: "years" }).years);
}
