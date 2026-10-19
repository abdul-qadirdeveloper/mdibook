// OWNER: Stream B. Called by the shared route
// src/app/api/v1/appointments/[id]/reschedule/route.ts.
//
// Staff and the appointment's doctor can move an appointment at any time before its start,
// and the status stays as it was (R35, R36). The core does the move as one atomic operation.
import { rescheduleAppointment } from "@/lib/appointments/core";
import type { Session } from "@/lib/session";

export interface ClinicRescheduleInput {
  appointmentId: string;
  start: Date;
  /** For the reschedule.conflict log line (spec 003 R13). */
  requestId?: string | null;
}

export interface ClinicRescheduleResult {
  appointmentId: string;
}

export async function rescheduleAsClinic(
  session: Session,
  input: ClinicRescheduleInput,
  now: Date,
): Promise<ClinicRescheduleResult> {
  return rescheduleAppointment(
    { actor: session, appointmentId: input.appointmentId, newStart: input.start, requestId: input.requestId },
    now,
  );
}
