// Slot generation and the rules that make a slot bookable (R24, R71). Pure: no database.
// Slots are never stored. They are computed from working hours, minus breaks, minus time off,
// minus active appointments.
import { DAY_MS, MINUTE_MS, type LocalDate, addDays, localDateOf, localToInstant, weekdayOf } from "./time";

/** Patients and staff can book at most this far ahead (R24). */
export const BOOKING_HORIZON_DAYS = 90;

/** A weekly wall-clock interval: weekday 1 (Monday) to 7 (Sunday), minutes from local midnight. */
export interface WeeklyInterval {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/** A half-open interval between two instants: start included, end excluded. */
export interface Interval {
  start: Date;
  end: Date;
}

export type Slot = Interval;

export interface Schedule {
  timeZone: string;
  slotLengthMinutes: number;
  workingHours: WeeklyInterval[];
  breaks: WeeklyInterval[];
  timeOff: Interval[];
}

export interface Availability extends Schedule {
  /** Active (requested or confirmed) appointments of the doctor. */
  active: Interval[];
}

export type SlotProblem =
  | "past"
  | "beyond_horizon"
  | "outside_hours"
  | "off_grid"
  | "in_break"
  | "in_time_off"
  | "occupied";

export type SlotCheck = { ok: true; slot: Slot } | { ok: false; problem: SlotProblem };

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

function assertSlotLength(slotLengthMinutes: number): number {
  if (!Number.isInteger(slotLengthMinutes) || slotLengthMinutes <= 0) {
    throw new RangeError("slotLengthMinutes must be a positive integer");
  }
  return slotLengthMinutes * MINUTE_MS;
}

/**
 * The slot grid for one local date: step the slot length in elapsed time from the start instant
 * of each working interval to its end instant (R71). A wall-clock hour skipped by a
 * daylight-saving change therefore produces no slot, and a repeated hour produces slots for
 * both occurrences. A slot must fit inside its working interval.
 */
function gridOn(schedule: Pick<Schedule, "timeZone" | "slotLengthMinutes" | "workingHours">, date: LocalDate): Slot[] {
  const stepMs = assertSlotLength(schedule.slotLengthMinutes);
  const slots: Slot[] = [];
  for (const hours of onDate(schedule.workingHours, date, schedule.timeZone)) {
    const end = hours.end.getTime();
    for (let t = hours.start.getTime(); t + stepMs <= end; t += stepMs) {
      slots.push({ start: new Date(t), end: new Date(t + stepMs) });
    }
  }
  return slots;
}

/** Every slot on the grid that starts in [from, to), ordered by start. Ignores breaks, time off
 *  and appointments. */
export function generateSlots(
  schedule: Pick<Schedule, "timeZone" | "slotLengthMinutes" | "workingHours">,
  from: Date,
  to: Date,
): Slot[] {
  const slots: Slot[] = [];
  if (to.getTime() <= from.getTime()) return slots;
  const last = localDateOf(to, schedule.timeZone);
  for (let date = localDateOf(from, schedule.timeZone); date <= last; date = addDays(date, 1)) {
    for (const slot of gridOn(schedule, date)) {
      const t = slot.start.getTime();
      if (t >= from.getTime() && t < to.getTime()) slots.push(slot);
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The last instant a booking made at `now` may start. */
export function bookingHorizon(now: Date): Date {
  return new Date(now.getTime() + BOOKING_HORIZON_DAYS * DAY_MS);
}

function blockedBy(slot: Slot, date: LocalDate, a: Availability): SlotProblem | null {
  if (onDate(a.breaks, date, a.timeZone).some((b) => overlaps(slot, b))) return "in_break";
  if (a.timeOff.some((t) => overlaps(slot, t))) return "in_time_off";
  if (a.active.some((appointment) => overlaps(slot, appointment))) return "occupied";
  return null;
}

/** Bookable slots that start in [from, to): in the future, within the horizon, outside breaks
 *  and time off, and with no active appointment. Ordered by start. */
export function openSlots(a: Availability, from: Date, to: Date, now: Date): Slot[] {
  const earliest = Math.max(from.getTime(), now.getTime() + 1);
  const latest = Math.min(to.getTime(), bookingHorizon(now).getTime() + 1);
  const open: Slot[] = [];
  for (const slot of generateSlots(a, new Date(earliest), new Date(latest))) {
    if (blockedBy(slot, localDateOf(slot.start, a.timeZone), a) === null) open.push(slot);
  }
  return open;
}

/** The `count` open slots nearest in time to `target`, before or after it, leaving out the
 *  `exclude` starts. On a tie the earlier slot wins. Ordered by start (spec 003 R3, R4). */
export function nearestSlots(open: Slot[], target: Date, count: number, exclude: Date[]): Slot[] {
  const excluded = new Set(exclude.map((d) => d.getTime()));
  const distance = (slot: Slot) => Math.abs(slot.start.getTime() - target.getTime());
  return open
    .filter((slot) => !excluded.has(slot.start.getTime()))
    .sort((a, b) => distance(a) - distance(b) || a.start.getTime() - b.start.getTime())
    .slice(0, count)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Checks one requested start against every rule of R24. The server runs this again at booking
 *  time. */
export function checkSlot(a: Availability, start: Date, now: Date): SlotCheck {
  const stepMs = assertSlotLength(a.slotLengthMinutes);
  if (start.getTime() <= now.getTime()) return { ok: false, problem: "past" };
  if (start.getTime() > bookingHorizon(now).getTime()) return { ok: false, problem: "beyond_horizon" };

  const slot: Slot = { start, end: new Date(start.getTime() + stepMs) };
  const date = localDateOf(start, a.timeZone);
  const hours = onDate(a.workingHours, date, a.timeZone).find(
    (h) => h.start.getTime() <= slot.start.getTime() && slot.end.getTime() <= h.end.getTime(),
  );
  if (!hours) return { ok: false, problem: "outside_hours" };
  if ((slot.start.getTime() - hours.start.getTime()) % stepMs !== 0) {
    return { ok: false, problem: "off_grid" };
  }

  const problem = blockedBy(slot, date, a);
  return problem ? { ok: false, problem } : { ok: true, slot };
}
