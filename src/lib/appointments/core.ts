// The only code that inserts an appointment, moves it, or changes its status.
//
// Each operation is one transaction that locks, re-checks the slot against the database,
// applies the booking limit, and writes the appointment, its history row, its audit event and
// its notification event together. Either all of that happens or none of it does.
//
// Double booking is prevented by the database: the partial unique index
// "Appointment_one_active_per_doctor_start" allows one active appointment per doctor and start
// time. A unique violation on it means the caller lost a race. It is reported as SLOT_TAKEN,
// with the next three open slots for a booking and the three nearest open slots for a move
// (spec 003 R3), and it is never retried here.
import { type ReasonCode, isCancelReasonCode, isScheduleChangeReasonCode } from "@/domain/reason-codes";
import type { Slot } from "@/domain/slots";
import { type Status, checkTransition, isActive, statusAfterReschedule } from "@/domain/transitions";
import { isLateCancel, patientCanReschedule } from "@/domain/window";
import { type AuditAction, writeAudit } from "@/lib/audit";
import { type Tx, db, violatedUniqueIndex } from "@/lib/db";
import { AppError, validationError } from "@/lib/errors";
import {
  type NotificationEvent,
  type NotificationType,
  deliverNotifications,
  recordNotification,
} from "@/lib/notifications";
import { logger } from "@/lib/logger";
import { checkBookable, nearestOpenSlots, nextOpenSlots } from "@/lib/open-slots";
import { appointmentScope } from "@/lib/scope";
import type { Session } from "@/lib/session";
import { hasLost, recordLost } from "./lost-slots";

const NEXT_SLOTS_OFFERED = 3;

/** Thrown inside a transaction when the slot is already held, so the transaction rolls back
 *  before the next open slots are looked up. */
class SlotTaken extends Error {}

type ActingRole = "patient" | "doctor" | "staff";

function actingRole(actor: Session): ActingRole {
  if (actor.role === "patient" || actor.role === "doctor" || actor.role === "staff") return actor.role;
  throw new AppError("FORBIDDEN");
}

/** SLOT_TAKEN with the next three open slots with the same doctor (R23). */
async function slotTaken(doctorId: string, wanted: Date, now: Date): Promise<AppError> {
  const next = await nextOpenSlots(db, doctorId, wanted, NEXT_SLOTS_OFFERED, now);
  return new AppError("SLOT_TAKEN", {
    nextSlots: (next?.slots ?? []).map((slot: Slot) => ({
      startsAt: slot.start.toISOString(),
      endsAt: slot.end.toISOString(),
    })),
    timeZone: next?.timeZone,
  });
}

interface LostMove {
  actor: Session;
  doctorId: string;
  clinicId: string;
  /** The appointment's own start, which is not offered (spec 003 R4). */
  currentStart: Date;
  wanted: Date;
  requestId?: string | null;
}

/**
 * SLOT_TAKEN for a move that lost its slot (spec 003): the three open slots nearest the taken
 * one, and a message that says the appointment was not moved (R2, R3, R5). Writes the one
 * reschedule.conflict line, with ids and the sameSlotRetry flag only (R13, R14).
 */
async function moveConflict(lost: LostMove, now: Date): Promise<AppError> {
  const { actor, doctorId, clinicId, currentStart, wanted } = lost;
  const lostBefore = hasLost(actor.userId, doctorId, wanted, now);
  recordLost(actor.userId, doctorId, wanted, now);
  logger.warn("reschedule.conflict", { requestId: lost.requestId, doctorId, clinicId, sameSlotRetry: lostBefore });

  const nearest = await nearestOpenSlots(db, doctorId, wanted, NEXT_SLOTS_OFFERED, now, [wanted, currentStart]);
  const nextSlots = (nearest?.slots ?? []).map((slot: Slot) => ({
    startsAt: slot.start.toISOString(),
    endsAt: slot.end.toISOString(),
  }));
  return new AppError(
    "SLOT_TAKEN",
    { nextSlots, timeZone: nearest?.timeZone },
    nextSlots.length > 0 ? "reschedule" : "rescheduleNoSlots",
  );
}

interface LockedDoctor {
  id: string;
  clinicId: string;
}

/**
 * Takes a shared lock on the doctor for the rest of the transaction. Bookings and moves hold
 * it together; a schedule change takes the exclusive lock, so no booking can land in hours
 * that are being removed (plan, Risks 5). Returns null for a missing or inactive doctor.
 */
async function lockDoctorShared(tx: Tx, doctorId: string): Promise<LockedDoctor | null> {
  const rows = await tx.$queryRaw<LockedDoctor[]>`
    SELECT d."id", d."clinicId"
    FROM "DoctorProfile" d
    JOIN "User" u ON u."id" = d."userId"
    WHERE d."id" = ${doctorId}::uuid AND u."active"
    FOR SHARE OF d`;
  return rows[0] ?? null;
}

/** Locks the appointment row, then reads it inside the caller's scope. */
async function lockAppointment(tx: Tx, actor: Session, appointmentId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Appointment" WHERE "id" = ${appointmentId}::uuid FOR UPDATE`;
  const appointment = await tx.appointment.findFirst({
    where: { id: appointmentId, ...appointmentScope(actor) },
    include: { clinic: { select: { cancellationWindowHours: true } } },
  });
  // Out of scope and missing are the same NOT_FOUND (R8).
  if (!appointment) throw new AppError("NOT_FOUND");
  return appointment;
}

// ---------------------------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------------------------

export interface BookInput {
  actor: Session;
  doctorId: string;
  /** The patient the appointment is for. A patient can book only for themself. */
  patientId: string;
  start: Date;
  reasonForVisit: string;
  /** A repeated submission with the same key returns the first appointment (R27). */
  idempotencyKey?: string | null;
}

export interface BookResult {
  appointmentId: string;
  /** False when this was a repeat of an earlier submission and nothing new was created. */
  created: boolean;
}

async function findByIdempotencyKey(actor: Session, key: string): Promise<string | null> {
  const existing = await db.appointment.findUnique({
    where: { bookedById_idempotencyKey: { bookedById: actor.userId, idempotencyKey: key } },
    select: { id: true },
  });
  return existing?.id ?? null;
}

/**
 * Books an appointment. A patient's booking starts as requested, a staff booking as confirmed
 * (R21, R29). Errors: NOT_FOUND, BOOKING_LIMIT_REACHED, SLOT_UNAVAILABLE, SLOT_TAKEN.
 */
export async function bookAppointment(input: BookInput, now: Date): Promise<BookResult> {
  const { actor, doctorId, patientId, start } = input;
  const role = actingRole(actor);
  if (role === "doctor") throw new AppError("FORBIDDEN");
  if (role === "patient" && actor.patientId !== patientId) throw new AppError("NOT_FOUND");
  const key = input.idempotencyKey ?? null;

  // A repeat of a stored result is returned as it is. This is a replay, not a retry: a
  // conflict is never tried again.
  if (key) {
    const existing = await findByIdempotencyKey(actor, key);
    if (existing) return { appointmentId: existing, created: false };
  }

  let committed: { appointmentId: string; event: NotificationEvent };
  try {
    committed = await db.$transaction(async (tx) => {
      const doctor = await lockDoctorShared(tx, doctorId);
      if (!doctor) throw new AppError("NOT_FOUND");
      // Staff act only on doctors of their own clinic (R4).
      if (role === "staff" && doctor.clinicId !== actor.clinicId) throw new AppError("NOT_FOUND");

      const patient = await tx.patientProfile.findFirst({
        where: { id: patientId, user: { active: true } },
        select: { id: true },
      });
      if (!patient) throw new AppError("NOT_FOUND");

      // The patient-to-clinic link is created at the first booking (R6), then locked so two
      // bookings by one patient cannot both pass the limit check (R25).
      const linked = await tx.$executeRaw`
        INSERT INTO "ClinicPatient" ("clinicId", "patientId")
        VALUES (${doctor.clinicId}::uuid, ${patientId}::uuid)
        ON CONFLICT ("clinicId", "patientId") DO NOTHING`;
      await tx.$queryRaw`
        SELECT "id" FROM "ClinicPatient"
        WHERE "clinicId" = ${doctor.clinicId}::uuid AND "patientId" = ${patientId}::uuid
        FOR UPDATE`;
      if (linked > 0) {
        await writeAudit(tx, {
          actorId: actor.userId,
          actorRole: role,
          action: "patient.clinic_linked",
          entityType: "patient",
          entityId: patientId,
          clinicId: doctor.clinicId,
        });
      }

      const clinic = await tx.clinic.findUniqueOrThrow({
        where: { id: doctor.clinicId },
        select: { maxUpcomingPerPatient: true },
      });
      const upcoming = await tx.appointment.count({
        where: {
          clinicId: doctor.clinicId,
          patientId,
          status: { in: ["requested", "confirmed"] },
          startsAt: { gt: now },
        },
      });
      if (upcoming >= clinic.maxUpcomingPerPatient) {
        throw new AppError("BOOKING_LIMIT_REACHED", { limit: clinic.maxUpcomingPerPatient });
      }

      // Every rule of R24, checked again against the database.
      const check = await checkBookable(tx, doctorId, start, now);
      if (!check) throw new AppError("NOT_FOUND");
      if (!check.ok) {
        if (check.problem === "occupied") throw new SlotTaken();
        throw new AppError("SLOT_UNAVAILABLE");
      }

      const status: Status = role === "staff" ? "confirmed" : "requested";
      const allowed = checkTransition({ from: "none", to: status, role, start, now });
      if (!allowed.ok) throw new AppError(allowed.code);

      const appointment = await tx.appointment.create({
        data: {
          clinicId: doctor.clinicId,
          doctorId,
          patientId,
          startsAt: check.slot.start,
          endsAt: check.slot.end,
          status,
          reasonForVisit: input.reasonForVisit,
          bookedById: actor.userId,
          bookedByRole: role,
          bookedAt: now,
          idempotencyKey: key,
        },
        select: { id: true },
      });
      await tx.appointmentHistory.create({
        data: {
          appointmentId: appointment.id,
          clinicId: doctor.clinicId,
          action: "booked",
          actorId: actor.userId,
          actorRole: role,
          newStartsAt: check.slot.start,
          at: now,
        },
      });
      await writeAudit(tx, {
        actorId: actor.userId,
        actorRole: role,
        action: "appointment.booked",
        entityType: "appointment",
        entityId: appointment.id,
        clinicId: doctor.clinicId,
      });
      const event = await recordNotification(tx, {
        type: "booked",
        appointmentId: appointment.id,
        clinicId: doctor.clinicId,
        patientId,
        doctorId,
      });
      return { appointmentId: appointment.id, event };
    });
  } catch (error) {
    const index = violatedUniqueIndex(error);
    const conflict = error instanceof SlotTaken || index !== null;
    if (conflict && key) {
      // The first submission with this key committed while this one was running: a double
      // click. Its copy holds the slot, so this one is answered with the stored result.
      const existing = await findByIdempotencyKey(actor, key);
      if (existing) return { appointmentId: existing, created: false };
    }
    // Otherwise someone else holds the slot. 409, never tried again.
    if (conflict) throw await slotTaken(doctorId, start, now);
    throw error;
  }

  await deliverNotifications([committed.event]);
  return { appointmentId: committed.appointmentId, created: true };
}

// ---------------------------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------------------------

export interface RescheduleInput {
  actor: Session;
  appointmentId: string;
  newStart: Date;
  /** The request's reference id, for the reschedule.conflict log line (spec 003 R13). */
  requestId?: string | null;
}

/**
 * Moves an appointment to another open slot with the same doctor, as one atomic operation:
 * the old slot is released only if the new one is taken (R33). If the new slot was just taken
 * the appointment is unchanged. Errors: NOT_FOUND, INVALID_TRANSITION,
 * RESCHEDULE_WINDOW_CLOSED, SLOT_UNAVAILABLE, SLOT_TAKEN.
 */
export async function rescheduleAppointment(input: RescheduleInput, now: Date): Promise<{ appointmentId: string }> {
  const { actor, appointmentId, newStart } = input;
  const role = actingRole(actor);

  const found = await db.appointment.findFirst({
    where: { id: appointmentId, ...appointmentScope(actor) },
    select: { doctorId: true, clinicId: true, startsAt: true },
  });
  if (!found) throw new AppError("NOT_FOUND");
  const doctorId = found.doctorId;
  const lost: LostMove = {
    actor,
    doctorId,
    clinicId: found.clinicId,
    currentStart: found.startsAt,
    wanted: newStart,
    requestId: input.requestId,
  };

  let event: NotificationEvent;
  try {
    event = await db.$transaction(async (tx) => {
      const doctor = await lockDoctorShared(tx, doctorId);
      if (!doctor) throw new AppError("NOT_FOUND");
      const appointment = await lockAppointment(tx, actor, appointmentId);

      // Only an upcoming appointment can be moved (R32, R35).
      if (!isActive(appointment.status) || now.getTime() >= appointment.startsAt.getTime()) {
        throw new AppError("INVALID_TRANSITION");
      }
      if (
        role === "patient" &&
        !patientCanReschedule(now, appointment.startsAt, appointment.clinic.cancellationWindowHours)
      ) {
        throw new AppError("RESCHEDULE_WINDOW_CLOSED");
      }
      if (newStart.getTime() === appointment.startsAt.getTime()) throw new AppError("SLOT_UNAVAILABLE");

      const check = await checkBookable(tx, doctorId, newStart, now, { excludeAppointmentId: appointmentId });
      if (!check) throw new AppError("NOT_FOUND");
      if (!check.ok) {
        if (check.problem === "occupied") throw new SlotTaken();
        throw new AppError("SLOT_UNAVAILABLE");
      }

      // A patient's move returns a confirmed appointment to requested (R36).
      const status = statusAfterReschedule(appointment.status, role);
      if (status !== appointment.status) {
        const allowed = checkTransition({
          from: appointment.status,
          to: status,
          role,
          start: appointment.startsAt,
          now,
          viaReschedule: true,
        });
        if (!allowed.ok) throw new AppError(allowed.code);
      }

      // Reason for visit and booking origin stay on the row (R37).
      await tx.appointment.update({
        where: { id: appointmentId },
        data: { startsAt: check.slot.start, endsAt: check.slot.end, status },
      });
      await tx.appointmentHistory.create({
        data: {
          appointmentId,
          clinicId: appointment.clinicId,
          action: "rescheduled",
          actorId: actor.userId,
          actorRole: role,
          oldStartsAt: appointment.startsAt,
          newStartsAt: check.slot.start,
          at: now,
        },
      });
      await writeAudit(tx, {
        actorId: actor.userId,
        actorRole: role,
        action: "appointment.rescheduled",
        entityType: "appointment",
        entityId: appointmentId,
        clinicId: appointment.clinicId,
      });
      return recordNotification(tx, {
        type: "rescheduled",
        appointmentId,
        clinicId: appointment.clinicId,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
      });
    });
  } catch (error) {
    // Someone else holds the slot. 409, the appointment stays where it was, never tried again.
    if (error instanceof SlotTaken || violatedUniqueIndex(error) !== null) throw await moveConflict(lost, now);
    throw error;
  }

  await deliverNotifications([event]);
  return { appointmentId };
}

// ---------------------------------------------------------------------------------------------
// Confirm, cancel, complete, no-show
// ---------------------------------------------------------------------------------------------

export type Outcome = "confirmed" | "cancelled" | "completed" | "no_show";

export interface ChangeStatusInput {
  actor: Session;
  appointmentId: string;
  to: Outcome;
  /** Required when staff or a doctor cancel (R41). Not accepted from a patient. */
  reasonCode?: ReasonCode | null;
  /** Set when the cancellation is caused by a schedule change (R52). */
  scheduleChangeId?: string | null;
}

export interface ChangeStatusResult {
  appointmentId: string;
  status: Outcome;
  /** True when a patient cancelled inside the cancellation window (R39). */
  lateCancel: boolean;
  /** Deliver with deliverNotifications() after the transaction commits. */
  event: NotificationEvent;
}

const OUTCOME_AUDIT: Record<Outcome, AuditAction> = {
  confirmed: "appointment.confirmed",
  cancelled: "appointment.cancelled",
  completed: "appointment.completed",
  no_show: "appointment.no_show",
};

/**
 * Changes an appointment's status inside the caller's transaction. Used directly by a schedule
 * change, which cancels every affected appointment in the same transaction as the change
 * (R52). The caller delivers the returned event after its transaction commits.
 */
export async function changeAppointmentStatusInTx(
  tx: Tx,
  input: ChangeStatusInput,
  now: Date,
): Promise<ChangeStatusResult> {
  const { actor, appointmentId, to } = input;
  const role = actingRole(actor);
  const appointment = await lockAppointment(tx, actor, appointmentId);

  const allowed = checkTransition({ from: appointment.status, to, role, start: appointment.startsAt, now });
  if (!allowed.ok) throw new AppError(allowed.code);

  let reasonCode: ReasonCode | null = null;
  let lateCancel = false;
  if (to === "cancelled") {
    if (role === "patient") {
      lateCancel = isLateCancel(role, now, appointment.startsAt, appointment.clinic.cancellationWindowHours);
    } else {
      const code = input.reasonCode ?? null;
      if (code === null) throw validationError({ field: "reasonCode", problem: "required" });
      const listed = input.scheduleChangeId ? isScheduleChangeReasonCode(code) : isCancelReasonCode(code);
      if (!listed) throw validationError({ field: "reasonCode", problem: "invalid" });
      reasonCode = code;
    }
  }

  await tx.appointment.update({
    where: { id: appointmentId },
    data:
      to === "cancelled"
        ? {
            status: to,
            cancelledByRole: role,
            cancelReasonCode: reasonCode,
            lateCancel,
            scheduleChangeId: input.scheduleChangeId ?? null,
          }
        : { status: to },
  });
  await tx.appointmentHistory.create({
    data: {
      appointmentId,
      clinicId: appointment.clinicId,
      action: to,
      actorId: actor.userId,
      actorRole: role,
      reasonCode,
      at: now,
    },
  });
  await writeAudit(tx, {
    actorId: actor.userId,
    actorRole: role,
    // A late cancel is audited under its own action, so the audit trail says it was late
    // while still holding ids and fixed codes only (R39, R81).
    action: lateCancel ? "appointment.cancelled_late" : OUTCOME_AUDIT[to],
    entityType: "appointment",
    entityId: appointmentId,
    clinicId: appointment.clinicId,
  });
  const type: NotificationType = to;
  const event = await recordNotification(tx, {
    type,
    appointmentId,
    clinicId: appointment.clinicId,
    patientId: appointment.patientId,
    doctorId: appointment.doctorId,
  });
  return { appointmentId, status: to, lateCancel, event };
}

/**
 * Confirms, cancels, completes or marks a no-show, in its own transaction. Only the
 * transitions of the R64 table are allowed; any other is refused and changes nothing.
 * Errors: NOT_FOUND, INVALID_TRANSITION, TOO_EARLY, VALIDATION_FAILED.
 */
export async function changeAppointmentStatus(
  input: ChangeStatusInput,
  now: Date,
): Promise<Omit<ChangeStatusResult, "event">> {
  const result = await db.$transaction((tx) => changeAppointmentStatusInTx(tx, input, now));
  await deliverNotifications([result.event]);
  return { appointmentId: result.appointmentId, status: result.status, lateCancel: result.lateCancel };
}
