// OWNER: Stream A. Placeholder with a fixed signature, called by the shared route
// src/app/api/v1/appointments/[id]/reschedule/route.ts. Stream A replaces the body.
//
// To implement (R32 to R34, R36, R37): call rescheduleAppointment() in
// src/lib/appointments/core.ts, which enforces the cancellation window for a patient.
import { NotImplementedError } from "@/lib/errors";
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
  void session;
  void input;
  void now;
  throw new NotImplementedError("patient.reschedule");
}
