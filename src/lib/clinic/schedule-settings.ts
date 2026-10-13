// A doctor's schedule settings: working hours, breaks, time off and slot length (R48 to R50,
// R56). Also the two building blocks every schedule use case starts from: finding a doctor
// inside the caller's scope, and taking the exclusive doctor lock.
import type { ScheduleRules } from "@/domain/schedule-impact";
import type { WeeklyInterval } from "@/domain/slots";
import { writeAudit } from "@/lib/audit";
import { type DbClient, type Tx, db } from "@/lib/db";
import { foundOrNotFound, managedDoctorScope } from "@/lib/scope";
import type { Session } from "@/lib/session";

export interface ManagedDoctor {
  id: string;
  clinicId: string;
  slotLengthMinutes: number;
  timeZone: string;
}

/**
 * The doctor, if the session may manage their schedule: a doctor themself, staff for doctors
 * of their own clinic (R48). Anyone else gets NOT_FOUND, the same as a missing doctor (R8).
 */
export async function findManagedDoctor(client: DbClient, session: Session, doctorId: string): Promise<ManagedDoctor> {
  const doctor = foundOrNotFound(
    await client.doctorProfile.findFirst({
      where: { AND: [{ id: doctorId }, managedDoctorScope(session)] },
      select: { id: true, clinicId: true, slotLengthMinutes: true, clinic: { select: { timeZone: true } } },
    }),
  );
  return {
    id: doctor.id,
    clinicId: doctor.clinicId,
    slotLengthMinutes: doctor.slotLengthMinutes,
    timeZone: doctor.clinic.timeZone,
  };
}

/**
 * Takes the exclusive lock on the doctor for the rest of the transaction. Bookings and moves
 * hold the shared lock, so none can land while the schedule is being changed (plan, Risks 3
 * and 5). Scope is checked before the lock, so a caller out of scope never holds it.
 */
export async function lockManagedDoctor(tx: Tx, session: Session, doctorId: string): Promise<ManagedDoctor> {
  await findManagedDoctor(tx, session, doctorId);
  await tx.$queryRaw`SELECT "id" FROM "DoctorProfile" WHERE "id" = ${doctorId}::uuid FOR UPDATE`;
  return findManagedDoctor(tx, session, doctorId);
}

const weekly = { weekday: true, startMinute: true, endMinute: true } as const;
const byWeekday = [{ weekday: "asc" }, { startMinute: "asc" }] as const;

/** Hours, breaks, and the time off that has not ended yet. */
export async function loadScheduleRules(client: DbClient, doctor: ManagedDoctor, now: Date): Promise<ScheduleRules> {
  // One after the other: inside a transaction they run on the same connection.
  const workingHours = await client.workingHours.findMany({
    where: { doctorId: doctor.id },
    select: weekly,
    orderBy: [...byWeekday],
  });
  const breaks = await client.break.findMany({ where: { doctorId: doctor.id }, select: weekly, orderBy: [...byWeekday] });
  const timeOff = await client.timeOff.findMany({
    where: { doctorId: doctor.id, endsAt: { gt: now } },
    select: { startsAt: true, endsAt: true },
  });
  return {
    timeZone: doctor.timeZone,
    workingHours,
    breaks,
    timeOff: timeOff.map((t) => ({ start: t.startsAt, end: t.endsAt })),
  };
}

export interface TimeOffView {
  id: string;
  startsAt: string;
  endsAt: string;
  reasonCode: string;
}

export interface ScheduleSettingsView {
  doctorId: string;
  /** Hours and breaks are wall-clock minutes from midnight in this zone (R50). */
  timeZone: string;
  slotLengthMinutes: number;
  workingHours: WeeklyInterval[];
  breaks: WeeklyInterval[];
  /** Time off that has not ended, as instants. */
  timeOff: TimeOffView[];
}

export async function readScheduleSettings(session: Session, doctorId: string, now: Date): Promise<ScheduleSettingsView> {
  const doctor = await findManagedDoctor(db, session, doctorId);
  const rules = await loadScheduleRules(db, doctor, now);
  const timeOff = await db.timeOff.findMany({
    where: { doctorId: doctor.id, endsAt: { gt: now } },
    select: { id: true, startsAt: true, endsAt: true, reasonCode: true },
    orderBy: { startsAt: "asc" },
  });
  return {
    doctorId: doctor.id,
    timeZone: doctor.timeZone,
    slotLengthMinutes: doctor.slotLengthMinutes,
    workingHours: rules.workingHours,
    breaks: rules.breaks,
    timeOff: timeOff.map((t) => ({
      id: t.id,
      startsAt: t.startsAt.toISOString(),
      endsAt: t.endsAt.toISOString(),
      reasonCode: t.reasonCode,
    })),
  };
}

/**
 * Changes the slot length. Only slots generated afterwards use it: existing appointments keep
 * their start and length and none is cancelled (R56).
 */
export async function changeSlotLength(
  session: Session,
  input: { doctorId: string; slotLengthMinutes: number },
): Promise<{ doctorId: string; slotLengthMinutes: number }> {
  return db.$transaction(async (tx) => {
    const doctor = await lockManagedDoctor(tx, session, input.doctorId);
    await tx.doctorProfile.update({
      where: { id: doctor.id },
      data: { slotLengthMinutes: input.slotLengthMinutes },
    });
    await writeAudit(tx, {
      actorId: session.userId,
      actorRole: session.role,
      action: "schedule.slot_length_changed",
      entityType: "doctor",
      entityId: doctor.id,
      clinicId: doctor.clinicId,
    });
    return { doctorId: doctor.id, slotLengthMinutes: input.slotLengthMinutes };
  });
}
