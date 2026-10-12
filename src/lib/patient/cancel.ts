// OWNER: Stream A. Placeholder with a fixed signature, called by the shared route
// src/app/api/v1/appointments/[id]/cancel/route.ts. Stream A replaces the body.
//
// To implement (R38 to R40, R44): call changeAppointmentStatus() in
// src/lib/appointments/core.ts with to "cancelled". It sets the late-cancel flag.
import { NotImplementedError } from "@/lib/errors";
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
  void session;
  void input;
  void now;
  throw new NotImplementedError("patient.cancel");
}
