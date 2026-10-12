// OWNER: Stream A. Placeholder with a fixed signature, called by the shared route
// src/app/api/v1/appointments/route.ts. Stream A replaces the body; the signature stays.
//
// To implement (R17 to R27, R6): store or check the date of birth on the patient's profile
// (R18, R19), then call bookAppointment() in src/lib/appointments/core.ts, which does the
// locking, the slot re-check, the booking limit and the conflict handling.
import { NotImplementedError } from "@/lib/errors";
import type { Session } from "@/lib/session";

export interface PatientBookInput {
  doctorId: string;
  start: Date;
  reasonForVisit: string;
  /** "YYYY-MM-DD". Required when the profile has none yet. */
  dateOfBirth: string | null;
  idempotencyKey: string | null;
}

export interface PatientBookResult {
  appointmentId: string;
  /** False when this repeated an earlier submission (R27). */
  created: boolean;
}

export async function bookAsPatient(
  session: Session,
  input: PatientBookInput,
  now: Date,
): Promise<PatientBookResult> {
  void session;
  void input;
  void now;
  throw new NotImplementedError("patient.book");
}
