// Builds appointment responses from the per-role field lists of src/domain/visibility.ts
// (R59, R83). No handler returns a database row: every appointment leaves through here.
import { ageOn } from "@/domain/time";
import { type AppointmentField, canSee, pickVisible } from "@/domain/visibility";
import { windowOpensAt } from "@/domain/window";
import { type DbClient, type Prisma, db } from "@/lib/db";
import { appointmentScope, foundOrNotFound } from "@/lib/scope";
import type { Session } from "@/lib/session";

export const appointmentInclude = {
  clinic: true,
  doctor: { include: { specialty: true } },
  patient: { include: { user: { select: { email: true } } } },
  history: { orderBy: { at: "asc" } },
} satisfies Prisma.AppointmentInclude;

export type AppointmentRecord = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

export interface HistoryEntry {
  action: string;
  actorId: string;
  actorRole: string;
  oldStartsAt: string | null;
  newStartsAt: string | null;
  reasonCode: string | null;
  at: string;
}

/** Every field of the visibility table. A response holds the subset the caller's role may see. */
export interface AppointmentView {
  id: string;
  startsAt: string;
  endsAt: string;
  slotLengthMinutes: number;
  timeZone: string;
  cancellationDeadline: string;
  status: string;
  cancelledBy: "patient" | "clinic" | null;
  doctorId: string;
  doctorName: string;
  specialty: string;
  clinicId: string;
  clinicName: string;
  clinicAddress: string;
  patientId: string;
  patientName: string;
  noShowCount: number;
  patientPhone: string;
  patientEmail: string;
  bookedById: string;
  bookedByRole: string;
  bookedAt: string;
  history: HistoryEntry[];
  lateCancel: boolean;
  dateOfBirth: string | null;
  patientAge: number | null;
  reasonForVisit: string;
  cancelReasonCode: string | null;
  cancelledByRole: string | null;
}

export type AppointmentResponse = Partial<AppointmentView>;

function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

/**
 * The response for one appointment, for a caller whose scope already includes it. Only the
 * fields the caller's role may see are computed or copied.
 */
export function serializeAppointment(
  session: Session,
  record: AppointmentRecord,
  extras: { noShowCount: number; now: Date },
): AppointmentResponse {
  const dateOfBirth = record.patient.dateOfBirth ? record.patient.dateOfBirth.toISOString().slice(0, 10) : null;
  const full: { [K in AppointmentField]: () => AppointmentView[K] } = {
    id: () => record.id,
    startsAt: () => record.startsAt.toISOString(),
    endsAt: () => record.endsAt.toISOString(),
    slotLengthMinutes: () => minutesBetween(record.startsAt, record.endsAt),
    timeZone: () => record.clinic.timeZone,
    cancellationDeadline: () =>
      windowOpensAt(record.startsAt, record.clinic.cancellationWindowHours).toISOString(),
    status: () => record.status,
    cancelledBy: () =>
      record.cancelledByRole === null ? null : record.cancelledByRole === "patient" ? "patient" : "clinic",
    doctorId: () => record.doctorId,
    doctorName: () => record.doctor.name,
    specialty: () => record.doctor.specialty.name,
    clinicId: () => record.clinicId,
    clinicName: () => record.clinic.name,
    clinicAddress: () => `${record.clinic.address}, ${record.clinic.area}, ${record.clinic.city}`,
    patientId: () => record.patientId,
    patientName: () => record.patient.fullName,
    noShowCount: () => extras.noShowCount,
    patientPhone: () => record.patient.phone,
    patientEmail: () => record.patient.user.email,
    bookedById: () => record.bookedById,
    bookedByRole: () => record.bookedByRole,
    bookedAt: () => record.bookedAt.toISOString(),
    history: () =>
      record.history.map((h) => ({
        action: h.action,
        actorId: h.actorId,
        actorRole: h.actorRole,
        oldStartsAt: h.oldStartsAt ? h.oldStartsAt.toISOString() : null,
        newStartsAt: h.newStartsAt ? h.newStartsAt.toISOString() : null,
        reasonCode: h.reasonCode,
        at: h.at.toISOString(),
      })),
    lateCancel: () => record.lateCancel,
    dateOfBirth: () => dateOfBirth,
    patientAge: () => (dateOfBirth ? ageOn(dateOfBirth, extras.now, record.clinic.timeZone) : null),
    reasonForVisit: () => record.reasonForVisit,
    cancelReasonCode: () => record.cancelReasonCode,
    cancelledByRole: () => record.cancelledByRole,
  };

  const view: Record<string, unknown> = {};
  for (const field of Object.keys(full) as AppointmentField[]) {
    if (canSee(session.role, field)) view[field] = full[field]();
  }
  // The field list is applied once more on the way out.
  return pickVisible(session.role, view) as AppointmentResponse;
}

/**
 * Loads one appointment inside the caller's scope and serializes it for the caller's role.
 * Out of scope and missing are both NOT_FOUND (R8).
 */
export async function readAppointment(
  session: Session,
  appointmentId: string,
  now: Date,
  client: DbClient = db,
): Promise<AppointmentResponse> {
  const record = foundOrNotFound(
    await client.appointment.findFirst({
      where: { id: appointmentId, ...appointmentScope(session) },
      include: appointmentInclude,
    }),
  );
  // The number of the patient's no-shows at this clinic only (R66).
  const noShowCount = canSee(session.role, "noShowCount")
    ? await client.appointment.count({
        where: { clinicId: record.clinicId, patientId: record.patientId, status: "no_show" },
      })
    : 0;
  return serializeAppointment(session, record, { noShowCount, now });
}
