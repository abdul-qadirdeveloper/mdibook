// Which appointments no longer fit a changed schedule (R52), and the preview token that ties
// a confirmation to the set of appointments the user was shown (R53). Pure: no database.
import { createHash } from "node:crypto";
import type { Interval, WeeklyInterval } from "./slots";
import { type LocalDate, localDateOf, localToInstant, weekdayOf } from "./time";

/** Everything that decides whether an appointment fits: hours, breaks and time off. */
export interface ScheduleRules {
  timeZone: string;
  workingHours: WeeklyInterval[];
  breaks: WeeklyInterval[];
  timeOff: Interval[];
}

export interface BookedInterval extends Interval {
  id: string;
}

/** A change that needs a reason and a confirmed preview (R51, R53). */
export type ScheduleChange =
  | { kind: "working_hours"; intervals: WeeklyInterval[] }
  | { kind: "breaks"; intervals: WeeklyInterval[] }
  | { kind: "time_off"; start: Date; end: Date };

function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

function onDate(intervals: WeeklyInterval[], date: LocalDate, timeZone: string): Interval[] {
  const weekday = weekdayOf(date);
  return intervals
    .filter((i) => i.weekday === weekday)
    .map((i) => ({
      start: localToInstant(date, i.startMinute, timeZone),
      end: localToInstant(date, i.endMinute, timeZone),
    }));
}

/**
 * True when the appointment lies inside one working interval of its clinic date and overlaps
 * no break and no time off. The slot grid is not checked: an appointment made before a
 * slot-length change keeps its start and length (R56).
 */
export function fitsSchedule(appointment: Interval, rules: ScheduleRules): boolean {
  const date = localDateOf(appointment.start, rules.timeZone);
  const start = appointment.start.getTime();
  const end = appointment.end.getTime();
  const inHours = onDate(rules.workingHours, date, rules.timeZone).some(
    (h) => h.start.getTime() <= start && end <= h.end.getTime(),
  );
  if (!inHours) return false;
  if (onDate(rules.breaks, date, rules.timeZone).some((b) => overlaps(appointment, b))) return false;
  return !rules.timeOff.some((t) => overlaps(appointment, t));
}

/** The schedule as it would be after the change. */
export function withChange(rules: ScheduleRules, change: ScheduleChange): ScheduleRules {
  switch (change.kind) {
    case "working_hours":
      return { ...rules, workingHours: change.intervals };
    case "breaks":
      return { ...rules, breaks: change.intervals };
    case "time_off":
      return { ...rules, timeOff: [...rules.timeOff, { start: change.start, end: change.end }] };
  }
}

/**
 * The future appointments that fit the schedule before the change and no longer fit after it,
 * ordered by start. The caller passes the doctor's active appointments.
 */
export function affectedAppointments(
  appointments: readonly BookedInterval[],
  before: ScheduleRules,
  after: ScheduleRules,
  now: Date,
): BookedInterval[] {
  return appointments
    .filter((a) => a.start.getTime() > now.getTime() && fitsSchedule(a, before) && !fitsSchedule(a, after))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
}

/** The clinic dates the affected appointments fall on, each once, earliest first (R53). */
export function affectedDates(affected: readonly Interval[], timeZone: string): LocalDate[] {
  return [...new Set(affected.map((a) => localDateOf(a.start, timeZone)))].sort();
}

/** True when two intervals on the same weekday overlap. */
export function hasOverlap(intervals: readonly WeeklyInterval[]): boolean {
  return intervals.some((a, i) =>
    intervals.some(
      (b, j) => i < j && a.weekday === b.weekday && a.startMinute < b.endMinute && b.startMinute < a.endMinute,
    ),
  );
}

function canonical(change: ScheduleChange): unknown {
  if (change.kind === "time_off") return [change.kind, change.start.getTime(), change.end.getTime()];
  const intervals = change.intervals
    .map((i) => [i.weekday, i.startMinute, i.endMinute])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return [change.kind, intervals];
}

/**
 * Names one change to one doctor together with the appointments it would cancel. The save
 * recomputes it; a different token means the affected set changed since the preview (R53).
 * It is derived from ids and instants only.
 */
export function previewToken(doctorId: string, change: ScheduleChange, affected: readonly BookedInterval[]): string {
  const set = affected.map((a) => `${a.id}@${a.start.getTime()}`).sort();
  return createHash("sha256")
    .update(JSON.stringify([doctorId, canonical(change), set]))
    .digest("hex");
}
