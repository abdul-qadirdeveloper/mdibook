// OWNER: Stream B. Placeholder with a fixed signature, called by the shared route
// src/app/api/v1/appointments/[id]/reschedule/route.ts. Stream B replaces the body.
//
// To implement (R35, R36): call rescheduleAppointment() in src/lib/appointments/core.ts.
import { NotImplementedError } from "@/lib/errors";
import type { Session } from "@/lib/session";

export interface ClinicRescheduleInput {
  appointmentId: string;
  start: Date;
}

export interface ClinicRescheduleResult {
  appointmentId: string;
}

export async function rescheduleAsClinic(
  session: Session,
  input: ClinicRescheduleInput,
  now: Date,
): Promise<ClinicRescheduleResult> {
  void session;
  void input;
  void now;
  throw new NotImplementedError("clinic.reschedule");
}
