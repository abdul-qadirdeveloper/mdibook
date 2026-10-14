// OWNER: Stream A. Called by the shared route
// src/app/api/v1/appointments/[id]/cancel/route.ts.
//
// A patient cancels their own upcoming appointment (R38 to R40, R44). Inside the cancellation
// window the cancellation still succeeds and is recorded as a late cancel (R39).
// changeAppointmentStatus() in src/lib/appointments/core.ts decides that, records that the
// patient cancelled, and writes the history row, audit event and notification event.
import { changeAppointmentStatus } from "@/lib/appointments/core";
import { AppError } from "@/lib/errors";
import type { Session } from "@/lib/session";

export interface PatientCancelInput {
  appointmentId: string;
}

export interface PatientCancelResult {
  appointmentId: string;
  /** True when the cancellation was recorded as a late cancel (R39). */
  late: boolean;
}

export async function cancelAsPatient(
  session: Session,
  input: PatientCancelInput,
  now: Date,
): Promise<PatientCancelResult> {
  if (session.role !== "patient" || !session.patientId) throw new AppError("NOT_FOUND");
  const result = await changeAppointmentStatus(
    { actor: session, appointmentId: input.appointmentId, to: "cancelled" },
    now,
  );
  return { appointmentId: result.appointmentId, late: result.lateCancel };
}
