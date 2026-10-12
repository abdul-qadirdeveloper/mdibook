// Field visibility by role (R59, R83): the table in spec section 2, as data. Every appointment
// response is built from these lists by src/lib/serialize.ts. No handler returns a database row.
//
// "doctor" is the appointment's own doctor, "staff" is staff of the appointment's clinic, and
// "patient" is the appointment's own patient. Whether the caller is one of those is decided by
// src/lib/scope.ts before anything is serialized. Anyone else, including an admin, sees nothing.
import type { Role } from "./transitions";

export const APPOINTMENT_FIELDS = [
  // Date, time, slot length
  "id",
  "startsAt",
  "endsAt",
  "slotLengthMinutes",
  "timeZone",
  "cancellationDeadline",
  // Status
  "status",
  "cancelledBy",
  // Doctor, specialty, clinic, address
  "doctorId",
  "doctorName",
  "specialty",
  "clinicId",
  "clinicName",
  "clinicAddress",
  // Patient full name
  "patientId",
  "patientName",
  // No-show count at the clinic
  "noShowCount",
  // Patient phone and email
  "patientPhone",
  "patientEmail",
  // Who booked and when
  "bookedById",
  "bookedByRole",
  "bookedAt",
  // Reschedule and cancellation history, and the late-cancel flag (R39: staff only)
  "history",
  "lateCancel",
  // Date of birth or age
  "dateOfBirth",
  "patientAge",
  // Reason for visit
  "reasonForVisit",
  // Staff or schedule-change reason code, and which clinic role cancelled
  "cancelReasonCode",
  "cancelledByRole",
] as const;

export type AppointmentField = (typeof APPOINTMENT_FIELDS)[number];
export type ViewerRole = Exclude<Role, "admin">;

const ALL: readonly ViewerRole[] = ["patient", "doctor", "staff"];

const VISIBLE_TO: Record<AppointmentField, readonly ViewerRole[]> = {
  id: ALL,
  startsAt: ALL,
  endsAt: ALL,
  slotLengthMinutes: ALL,
  timeZone: ALL,
  cancellationDeadline: ALL,
  status: ALL,
  // "you" or "clinic": the patient-facing wording of R44.
  cancelledBy: ALL,
  doctorId: ALL,
  doctorName: ALL,
  specialty: ALL,
  clinicId: ALL,
  clinicName: ALL,
  clinicAddress: ALL,
  patientId: ALL,
  patientName: ALL,
  noShowCount: ["doctor", "staff"],
  patientPhone: ["patient", "staff"],
  patientEmail: ["patient", "staff"],
  bookedById: ["staff"],
  bookedByRole: ["staff"],
  bookedAt: ["staff"],
  history: ["staff"],
  lateCancel: ["staff"],
  dateOfBirth: ["patient"],
  // Age only for the doctor (F17).
  patientAge: ["doctor"],
  // Never staff, including the staff member who typed it (R20, R28).
  reasonForVisit: ["patient", "doctor"],
  // Not shown to the patient, who sees a neutral message (R55).
  cancelReasonCode: ["doctor", "staff"],
  cancelledByRole: ["doctor", "staff"],
};

/** The fields a role may see on an appointment in its scope. An admin sees none (R94). */
export function visibleAppointmentFields(role: Role): AppointmentField[] {
  if (role === "admin") return [];
  return APPOINTMENT_FIELDS.filter((field) => VISIBLE_TO[field].includes(role));
}

export function canSee(role: Role, field: AppointmentField): boolean {
  return role !== "admin" && VISIBLE_TO[field].includes(role);
}

/** Keeps only the fields the role may see. Unknown keys are dropped, never passed through. */
export function pickVisible<T extends Partial<Record<AppointmentField, unknown>>>(
  role: Role,
  record: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const field of visibleAppointmentFields(role)) {
    if (field in record) out[field as keyof T] = record[field as keyof T];
  }
  return out;
}

/**
 * Whether a role may see one of the patient's past appointments at the clinic. A doctor sees
 * only those with themself (R60); staff see all at their clinic, and the field lists above
 * already remove the visit reason for them.
 */
export function canSeePastAppointment(role: Role, withSameDoctor: boolean): boolean {
  if (role === "patient" || role === "staff") return true;
  if (role === "doctor") return withSameDoctor;
  return false;
}
