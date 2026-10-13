// OWNER: Stream B. Called by the shared route src/app/api/v1/appointments/[id]/cancel/route.ts.
//
// Staff and the appointment's doctor cancel at any time before the start, with a code from the
// fixed list (R41). The core never flags it late (R42) and records the cancelling role (R44).
import type { CancelReasonCode } from "@/domain/reason-codes";
import { changeAppointmentStatus } from "@/lib/appointments/core";
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
  const result = await changeAppointmentStatus(
    { actor: session, appointmentId: input.appointmentId, to: "cancelled", reasonCode: input.code },
    now,
  );
  return { appointmentId: result.appointmentId };
}
