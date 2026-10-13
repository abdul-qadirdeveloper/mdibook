// Confirm, complete and no-show, by staff or the appointment's doctor (R62 to R65). The core
// checks each change against the transition table and writes its history, audit event and
// notification event. A no-show is recorded and nothing else happens (R65).
import { changeAppointmentStatus } from "@/lib/appointments/core";
import type { Session } from "@/lib/session";

export type ClinicOutcome = "confirmed" | "completed" | "no_show";

/** Errors: NOT_FOUND, INVALID_TRANSITION, TOO_EARLY. */
export async function recordOutcome(
  session: Session,
  input: { appointmentId: string; to: ClinicOutcome },
  now: Date,
): Promise<{ appointmentId: string }> {
  const result = await changeAppointmentStatus({ actor: session, appointmentId: input.appointmentId, to: input.to }, now);
  return { appointmentId: result.appointmentId };
}
