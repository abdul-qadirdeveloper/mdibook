// Changes to working hours and breaks, and the preview-then-apply steps that time off shares
// (R51 to R55). A change and every cancellation it causes happen in one transaction, under the
// exclusive doctor lock, or not at all.
import { z } from "zod";
import type { ScheduleChangeReasonCode } from "@/domain/reason-codes";
import {
  type BookedInterval,
  type ScheduleChange,
  affectedAppointments,
  affectedDates,
  hasOverlap,
  previewToken,
  withChange,
} from "@/domain/schedule-impact";
import { ACTIVE_STATUSES } from "@/domain/transitions";
import { changeAppointmentStatusInTx } from "@/lib/appointments/core";
import { writeAudit } from "@/lib/audit";
import { type DbClient, db } from "@/lib/db";
import { AppError, validationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { type NotificationEvent, deliverNotifications } from "@/lib/notifications";
import { scheduleChangeReasonCodeSchema } from "@/lib/schemas";
import { foundOrNotFound } from "@/lib/scope";
import { type AppointmentResponse, readAppointment } from "@/lib/serialize";
import type { Session } from "@/lib/session";
import { type ManagedDoctor, findManagedDoctor, loadScheduleRules, lockManagedDoctor } from "./schedule-settings";

// A change can cancel many appointments, each with its history, audit and notification rows.
const TRANSACTION = { maxWait: 10_000, timeout: 30_000 };

const weeklyIntervalSchema = z.strictObject({
  /** 1 (Monday) to 7 (Sunday). */
  weekday: z.number().int().min(1).max(7),
  /** Wall-clock minutes from midnight in the clinic's time zone (R50). */
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
});

/** The whole weekly set of working hours, or of breaks: the change replaces the set. */
export const weeklyChangeSchema = z.strictObject({
  kind: z.enum(["working_hours", "breaks"]),
  intervals: z.array(weeklyIntervalSchema).max(70),
});

/** What the user confirms after the preview: a listed reason and the preview's token. */
export const confirmationSchema = z.strictObject({
  // A string first, so that a missing reason is reported as required, not as invalid (R89).
  reasonCode: z.string().pipe(scheduleChangeReasonCodeSchema),
  previewToken: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface Confirmation {
  reasonCode: ScheduleChangeReasonCode;
  previewToken: string;
}

function assertValid(change: ScheduleChange): void {
  if (change.kind === "time_off") return;
  const backwards = change.intervals.some((i) => i.endMinute <= i.startMinute);
  if (backwards || hasOverlap(change.intervals)) throw validationError({ field: "intervals", problem: "invalid" });
}

interface Impact {
  affected: BookedInterval[];
  token: string;
}

/** The doctor's upcoming active appointments that would no longer fit after the change. */
async function computeImpact(client: DbClient, doctor: ManagedDoctor, change: ScheduleChange, now: Date): Promise<Impact> {
  const before = await loadScheduleRules(client, doctor, now);
  const active = await client.appointment.findMany({
    where: { doctorId: doctor.id, status: { in: [...ACTIVE_STATUSES] }, startsAt: { gt: now } },
    select: { id: true, startsAt: true, endsAt: true },
  });
  const affected = affectedAppointments(
    active.map((a) => ({ id: a.id, start: a.startsAt, end: a.endsAt })),
    before,
    withChange(before, change),
    now,
  );
  return { affected, token: previewToken(doctor.id, change, affected) };
}

/** Appointments in the caller's scope, each with the fields the caller's role may see. */
export async function readAppointments(session: Session, ids: readonly string[], now: Date): Promise<AppointmentResponse[]> {
  const out: AppointmentResponse[] = [];
  for (const id of ids) out.push(await readAppointment(session, id, now));
  return out;
}

export interface PreviewResult {
  /** How many appointments the change would cancel, and on which clinic dates (R53). */
  count: number;
  dates: string[];
  timeZone: string;
  appointments: AppointmentResponse[];
  /** Send it back with the confirmation. It stops matching if the affected set changes. */
  previewToken: string;
}

/** What a change would cancel. Changes nothing. */
export async function previewScheduleChange(
  session: Session,
  doctorId: string,
  change: ScheduleChange,
  now: Date,
): Promise<PreviewResult> {
  assertValid(change);
  const doctor = await findManagedDoctor(db, session, doctorId);
  const impact = await computeImpact(db, doctor, change, now);
  return {
    count: impact.affected.length,
    dates: affectedDates(impact.affected, doctor.timeZone),
    timeZone: doctor.timeZone,
    appointments: await readAppointments(
      session,
      impact.affected.map((a) => a.id),
      now,
    ),
    previewToken: impact.token,
  };
}

export interface ScheduleChangeView {
  id: string;
  doctorId: string;
  kind: string;
  reasonCode: string;
  at: string;
  appointmentsCancelled: number;
}

export interface ApplyResult {
  scheduleChange: ScheduleChangeView;
  /** The new time off, when the change added one. */
  timeOffId: string | null;
}

const AUDIT_ACTION = {
  working_hours: "schedule.working_hours_changed",
  breaks: "schedule.breaks_changed",
  time_off: "schedule.time_off_added",
} as const;

/**
 * Saves the change and cancels every appointment that no longer fits, with the same reason,
 * in one transaction (R52). The affected set is computed again under the exclusive doctor
 * lock; if it is not the set the user confirmed, nothing is saved (R53). Errors: NOT_FOUND,
 * VALIDATION_FAILED, PREVIEW_STALE.
 */
export async function applyScheduleChange(
  session: Session,
  doctorId: string,
  change: ScheduleChange,
  confirmation: Confirmation,
  now: Date,
): Promise<ApplyResult> {
  assertValid(change);
  const { reasonCode } = confirmation;

  const committed = await db.$transaction(async (tx) => {
    const doctor = await lockManagedDoctor(tx, session, doctorId);
    // Hold the doctor's upcoming active appointments still, so one cancelled by its patient
    // at this moment cannot change the set between the check and the cancellations.
    await tx.$queryRaw`
      SELECT "id" FROM "Appointment"
      WHERE "doctorId" = ${doctor.id}::uuid AND "status" IN ('requested', 'confirmed') AND "startsAt" > ${now}
      FOR UPDATE`;

    const impact = await computeImpact(tx, doctor, change, now);
    if (impact.token !== confirmation.previewToken) throw new AppError("PREVIEW_STALE");

    const record = await tx.scheduleChange.create({
      data: {
        doctorId: doctor.id,
        clinicId: doctor.clinicId,
        kind: change.kind,
        reasonCode,
        actorId: session.userId,
        actorRole: session.role,
        at: now,
        appointmentsCancelled: impact.affected.length,
      },
    });

    const owner = { doctorId: doctor.id, clinicId: doctor.clinicId };
    let timeOffId: string | null = null;
    if (change.kind === "time_off") {
      const timeOff = await tx.timeOff.create({
        data: { ...owner, startsAt: change.start, endsAt: change.end, reasonCode, createdById: session.userId, createdAt: now },
        select: { id: true },
      });
      timeOffId = timeOff.id;
    } else if (change.kind === "working_hours") {
      await tx.workingHours.deleteMany({ where: { doctorId: doctor.id } });
      await tx.workingHours.createMany({ data: change.intervals.map((i) => ({ ...i, ...owner })) });
    } else {
      await tx.break.deleteMany({ where: { doctorId: doctor.id } });
      await tx.break.createMany({ data: change.intervals.map((i) => ({ ...i, ...owner })) });
    }

    // Each cancellation goes through the core: transition check, history, its own audit
    // event and its own notification event (R54).
    const events: NotificationEvent[] = [];
    for (const appointment of impact.affected) {
      const cancelled = await changeAppointmentStatusInTx(
        tx,
        { actor: session, appointmentId: appointment.id, to: "cancelled", reasonCode, scheduleChangeId: record.id },
        now,
      );
      events.push(cancelled.event);
    }

    await writeAudit(tx, {
      actorId: session.userId,
      actorRole: session.role,
      action: AUDIT_ACTION[change.kind],
      entityType: timeOffId ? "time_off" : "schedule_change",
      entityId: timeOffId ?? record.id,
      clinicId: doctor.clinicId,
    });
    return { record, timeOffId, events };
  }, TRANSACTION);

  await deliverNotifications(committed.events);
  logger.info("schedule.changed", {
    actorId: session.userId,
    doctorId: committed.record.doctorId,
    clinicId: committed.record.clinicId,
    scheduleChangeId: committed.record.id,
  });
  return { scheduleChange: view(committed.record), timeOffId: committed.timeOffId };
}

function view(record: {
  id: string;
  doctorId: string;
  kind: string;
  reasonCode: string;
  at: Date;
  appointmentsCancelled: number;
}): ScheduleChangeView {
  return {
    id: record.id,
    doctorId: record.doctorId,
    kind: record.kind,
    reasonCode: record.reasonCode,
    at: record.at.toISOString(),
    appointmentsCancelled: record.appointmentsCancelled,
  };
}

/**
 * A saved change and the appointments it cancelled, so the clinic can call the patients
 * (R54). Each appointment carries the fields the caller's role may see: staff get the phone
 * number, the doctor does not.
 */
export async function readScheduleChange(
  session: Session,
  doctorId: string,
  changeId: string,
  now: Date,
): Promise<{ scheduleChange: ScheduleChangeView; appointments: AppointmentResponse[] }> {
  const doctor = await findManagedDoctor(db, session, doctorId);
  const record = foundOrNotFound(await db.scheduleChange.findFirst({ where: { id: changeId, doctorId: doctor.id } }));
  const cancelled = await db.appointment.findMany({
    where: { scheduleChangeId: record.id, doctorId: doctor.id },
    select: { id: true },
    orderBy: { startsAt: "asc" },
  });
  return {
    scheduleChange: view(record),
    appointments: await readAppointments(
      session,
      cancelled.map((a) => a.id),
      now,
    ),
  };
}
