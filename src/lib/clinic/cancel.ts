// OWNER: Stream B. Placeholder with a fixed signature, called by the shared route
// src/app/api/v1/appointments/[id]/cancel/route.ts. Stream B replaces the body.
//
// To implement (R41, R42, R44): call changeAppointmentStatus() in
// src/lib/appointments/core.ts with to "cancelled" and the chosen code.
import type { CancelReasonCode } from "@/domain/reason-codes";
import { NotImplementedError } from "@/lib/errors";
import type { Session } from "@/lib/session";

export interface ClinicCancelInput {
  appointmentId: string;
  /** Chosen from the fixed list. */
  code: CancelReasonCode;
}

export interface ClinicCancelResult {
  appointmentId: string;
}

export async function cancelAsClinic(
  session: Session,
  input: ClinicCancelInput,
  now: Date,
): Promise<ClinicCancelResult> {
  void session;
  void input;
  void now;
  throw new NotImplementedError("clinic.cancel");
}
