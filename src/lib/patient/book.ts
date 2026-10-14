// OWNER: Stream A. Called by the shared route src/app/api/v1/appointments/route.ts.
//
// A patient books for themself (R17 to R27, R6). The date of birth is required (R18): it is
// taken from the profile, or stored there once the booking succeeds (R19). Everything else,
// the locking, the slot re-check, the booking limit and the conflict handling, is done by
// bookAppointment() in src/lib/appointments/core.ts. A lost race is SLOT_TAKEN (409) from the
// core. It is not caught and not tried again here.
import { bookAppointment } from "@/lib/appointments/core";
import { AppError, validationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { changeOwnProfile, readOwnProfile } from "@/lib/patient/profile";
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
  if (session.role !== "patient" || !session.patientId) throw new AppError("NOT_FOUND");

  const profile = await readOwnProfile(session);
  if (input.dateOfBirth === null && profile.dateOfBirth === null) {
    throw validationError({ field: "dateOfBirth", problem: "required" });
  }

  const result = await bookAppointment(
    {
      actor: session,
      doctorId: input.doctorId,
      patientId: session.patientId,
      start: input.start,
      reasonForVisit: input.reasonForVisit,
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );

  // First time, or a correction. Stored only once the booking holds, so a refused booking
  // changes nothing (after a lost race the form keeps what was typed, R23). A repeat of the
  // same submission stores it too, which repairs a save that failed the first time.
  if (input.dateOfBirth !== null && input.dateOfBirth !== profile.dateOfBirth) {
    try {
      await changeOwnProfile(session, { dateOfBirth: input.dateOfBirth });
    } catch {
      // The appointment is booked and must not be reported as failed. With no date on file the
      // patient is asked again at their next booking (R18, R28).
      logger.warn("patient.profile_change_failed", { patientId: session.patientId, appointmentId: result.appointmentId });
    }
  }
  return result;
}
