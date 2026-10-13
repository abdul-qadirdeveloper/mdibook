// OWNER: Stream B. Called by the shared route src/app/api/v1/appointments/route.ts.
//
// Staff book for a patient with a doctor of their own clinic (R28 to R30). The core records
// who booked and when, starts the appointment as confirmed, applies the clinic's limit and
// refuses an occupied slot. The date of birth is never read here: it stays on the patient's
// profile, and a profile without one does not stop the booking.
import { bookAppointment } from "@/lib/appointments/core";
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
  return bookAppointment(
    {
      actor: session,
      doctorId: input.doctorId,
      patientId: input.patientId,
      start: input.start,
      reasonForVisit: input.reasonForVisit,
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );
}
