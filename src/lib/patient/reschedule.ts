// OWNER: Stream A. Called by the shared route
// src/app/api/v1/appointments/[id]/reschedule/route.ts.
//
// A patient moves their own upcoming appointment to another open slot with the same doctor
// (R32). rescheduleAppointment() in src/lib/appointments/core.ts does it in one transaction:
// the old slot is released only if the new one is taken (R33). It refuses a patient inside the
// cancellation window (R34), returns a confirmed appointment to requested (R36), and keeps the
// reason for visit and booking origin while adding the move to the history (R37).
import { rescheduleAppointment } from "@/lib/appointments/core";
import { AppError } from "@/lib/errors";
import type { Session } from "@/lib/session";

export interface PatientRescheduleInput {
  appointmentId: string;
  start: Date;
}

export interface PatientRescheduleResult {
  appointmentId: string;
}

export async function rescheduleAsPatient(
  session: Session,
  input: PatientRescheduleInput,
  now: Date,
): Promise<PatientRescheduleResult> {
  if (session.role !== "patient" || !session.patientId) throw new AppError("NOT_FOUND");
  return rescheduleAppointment({ actor: session, appointmentId: input.appointmentId, newStart: input.start }, now);
}
