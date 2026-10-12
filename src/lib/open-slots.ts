// Loads a doctor's working hours, breaks, time off and active appointments, and asks
// src/domain/slots.ts which slots are open. Slots are computed, never stored.
import { type Availability, type Slot, type SlotCheck, bookingHorizon, checkSlot, openSlots } from "@/domain/slots";
import { DAY_MS } from "@/domain/time";
import { ACTIVE_STATUSES } from "@/domain/transitions";
import type { DbClient } from "@/lib/db";

export interface DoctorAvailability {
  doctorId: string;
  clinicId: string;
  availability: Availability;
}

interface LoadOptions {
  /** Leave this appointment out of the occupied times: it is the one being moved. */
  excludeAppointmentId?: string;
}

/**
 * Everything that decides which slots are open for a doctor between two instants. Returns null
 * when the doctor does not exist or the account is inactive (R96).
 */
export async function loadAvailability(
  client: DbClient,
  doctorId: string,
  from: Date,
  to: Date,
  options: LoadOptions = {},
): Promise<DoctorAvailability | null> {
  const doctor = await client.doctorProfile.findFirst({
    where: { id: doctorId, user: { active: true } },
    select: {
      id: true,
      clinicId: true,
      slotLengthMinutes: true,
      clinic: { select: { timeZone: true } },
      workingHours: { select: { weekday: true, startMinute: true, endMinute: true } },
      breaks: { select: { weekday: true, startMinute: true, endMinute: true } },
    },
  });
  if (!doctor) return null;

  // One after the other: inside a transaction both run on the same connection.
  const timeOff = await client.timeOff.findMany({
    where: { doctorId, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { startsAt: true, endsAt: true },
  });
  const active = await client.appointment.findMany({
    where: {
      doctorId,
      status: { in: [...ACTIVE_STATUSES] },
      startsAt: { lt: to },
      endsAt: { gt: from },
      ...(options.excludeAppointmentId ? { id: { not: options.excludeAppointmentId } } : {}),
    },
    select: { startsAt: true, endsAt: true },
  });

  return {
    doctorId: doctor.id,
    clinicId: doctor.clinicId,
    availability: {
      timeZone: doctor.clinic.timeZone,
      slotLengthMinutes: doctor.slotLengthMinutes,
      workingHours: doctor.workingHours,
      breaks: doctor.breaks,
      timeOff: timeOff.map((t) => ({ start: t.startsAt, end: t.endsAt })),
      active: active.map((a) => ({ start: a.startsAt, end: a.endsAt })),
    },
  };
}

/** Open slots that start in [from, to), with the clinic time zone to display them in. */
export async function listOpenSlots(
  client: DbClient,
  doctorId: string,
  from: Date,
  to: Date,
  now: Date,
): Promise<{ timeZone: string; slots: Slot[] } | null> {
  const loaded = await loadAvailability(client, doctorId, from, to);
  if (!loaded) return null;
  return {
    timeZone: loaded.availability.timeZone,
    slots: openSlots(loaded.availability, from, to, now),
  };
}

const SEARCH_STEP_DAYS = 14;

/**
 * The next open slots that start after an instant, earliest first. Looks ahead in steps until
 * it has enough or reaches the booking horizon.
 */
export async function nextOpenSlots(
  client: DbClient,
  doctorId: string,
  after: Date,
  count: number,
  now: Date,
): Promise<{ timeZone: string; slots: Slot[] } | null> {
  const horizon = bookingHorizon(now).getTime() + 1;
  let from = new Date(Math.max(after.getTime() + 1, now.getTime() + 1));
  const found: Slot[] = [];
  let timeZone: string | null = null;

  while (found.length < count && from.getTime() < horizon) {
    const to = new Date(Math.min(from.getTime() + SEARCH_STEP_DAYS * DAY_MS, horizon));
    const page = await listOpenSlots(client, doctorId, from, to, now);
    if (!page) return null;
    timeZone = page.timeZone;
    found.push(...page.slots);
    from = to;
  }
  if (timeZone === null) {
    const doctor = await client.doctorProfile.findUnique({
      where: { id: doctorId },
      select: { clinic: { select: { timeZone: true } } },
    });
    if (!doctor) return null;
    timeZone = doctor.clinic.timeZone;
  }
  return { timeZone, slots: found.slice(0, count) };
}

/**
 * Checks one start instant against every booking rule of R24, against the current state of
 * the database. Returns null when the doctor does not exist or is inactive.
 */
export async function checkBookable(
  client: DbClient,
  doctorId: string,
  start: Date,
  now: Date,
  options: LoadOptions = {},
): Promise<SlotCheck | null> {
  // A day on each side covers any appointment or time off that could overlap the slot.
  const from = new Date(start.getTime() - DAY_MS);
  const to = new Date(start.getTime() + DAY_MS);
  const loaded = await loadAvailability(client, doctorId, from, to, options);
  if (!loaded) return null;
  return checkSlot(loaded.availability, start, now);
}
