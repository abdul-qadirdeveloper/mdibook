// Clinic and role scoping (R4, R7, R8). Every query for a record is narrowed by the caller's
// session here, and a record outside the caller's scope gets the same NOT_FOUND as a record
// that does not exist. A clinic, doctor or patient id sent by the client is never authority.
import type { Role } from "@/domain/transitions";
import type { Prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Session } from "@/lib/session";

/** Matches no row. */
const NOTHING = { id: { in: [] as string[] } };

/**
 * Step two of every route: the role may perform this kind of action at all (else FORBIDDEN),
 * and a doctor or staff member has a clinic to act in.
 */
export function requireRole(session: Session, roles: readonly Role[]): void {
  if (!roles.includes(session.role)) throw new AppError("FORBIDDEN");
  if ((session.role === "doctor" || session.role === "staff") && !session.clinicId) {
    throw new AppError("FORBIDDEN");
  }
}

/**
 * The appointments a session may read or act on: a patient's own, a doctor's own, and for
 * staff those of their clinic. An admin has none (R94).
 */
export function appointmentScope(session: Session): Prisma.AppointmentWhereInput {
  switch (session.role) {
    case "patient":
      return session.patientId ? { patientId: session.patientId } : NOTHING;
    case "doctor":
      return session.doctorId ? { doctorId: session.doctorId } : NOTHING;
    case "staff":
      return session.clinicId ? { clinicId: session.clinicId } : NOTHING;
    default:
      return NOTHING;
  }
}

/**
 * The doctors whose schedule and appointments a session may manage: a doctor themself, and for
 * staff the doctors of their clinic (R48).
 */
export function managedDoctorScope(session: Session): Prisma.DoctorProfileWhereInput {
  switch (session.role) {
    case "doctor":
      return session.doctorId ? { id: session.doctorId } : NOTHING;
    case "staff":
      return session.clinicId ? { clinicId: session.clinicId } : NOTHING;
    default:
      return NOTHING;
  }
}

/** True when the session may manage this doctor. */
export function managesDoctor(session: Session, doctor: { id: string; clinicId: string }): boolean {
  if (session.role === "doctor") return session.doctorId === doctor.id;
  if (session.role === "staff") return session.clinicId === doctor.clinicId;
  return false;
}

/** The clinic a doctor or staff member acts in. Anyone else has none. */
export function clinicOf(session: Session): string {
  if ((session.role === "doctor" || session.role === "staff") && session.clinicId) return session.clinicId;
  throw new AppError("NOT_FOUND");
}

/** Out of scope and missing look the same to the caller (R8). */
export function foundOrNotFound<T>(record: T | null | undefined): T {
  if (record === null || record === undefined) throw new AppError("NOT_FOUND");
  return record;
}
