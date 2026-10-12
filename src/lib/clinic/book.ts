// OWNER: Stream B. Placeholder with a fixed signature, called by the shared route
// src/app/api/v1/appointments/route.ts. Stream B replaces the body; the signature stays.
//
// To implement (R28 to R30): call bookAppointment() in src/lib/appointments/core.ts. The date
// of birth comes from the patient's profile and is never returned to staff.
import { NotImplementedError } from "@/lib/errors";
import type { Session } from "@/lib/session";

export interface ClinicBookInput {
  doctorId: string;
  patientId: string;
  start: Date;
  /** Entered by staff, not readable by staff after saving (R28). */
  reasonForVisit: string;
  idempotencyKey: string | null;
}

export interface ClinicBookResult {
  appointmentId: string;
  /** False when this repeated an earlier submission (R27). */
  created: boolean;
}

export async function bookAsClinic(session: Session, input: ClinicBookInput, now: Date): Promise<ClinicBookResult> {
  void session;
  void input;
  void now;
  throw new NotImplementedError("clinic.book");
}
