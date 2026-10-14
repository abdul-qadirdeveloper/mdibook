// OWNER: Stream A. A patient reads and corrects their own profile (R19). The date of birth is
// stored once here and pre-filled at later bookings; the patient can correct it. A change
// writes one audit event with no clinic id: the action belongs to no clinic (R81).
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Session } from "@/lib/session";

/** The patient's own profile. Never returned to any other role. */
export interface PatientProfileView {
  fullName: string;
  phone: string;
  email: string;
  /** "YYYY-MM-DD", or null when none is on file yet. */
  dateOfBirth: string | null;
}

export interface PatientProfileChanges {
  fullName?: string;
  phone?: string;
  /** "YYYY-MM-DD". */
  dateOfBirth?: string;
}

const profileSelect = {
  id: true,
  fullName: true,
  phone: true,
  dateOfBirth: true,
  user: { select: { email: true } },
} as const;

function ownPatientId(session: Session): string {
  // Only a patient has a profile of their own. Anyone else finds nothing (R8).
  if (session.role !== "patient" || !session.patientId) throw new AppError("NOT_FOUND");
  return session.patientId;
}

function isoDate(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function view(row: {
  fullName: string;
  phone: string;
  dateOfBirth: Date | null;
  user: { email: string };
}): PatientProfileView {
  return {
    fullName: row.fullName,
    phone: row.phone,
    email: row.user.email,
    dateOfBirth: isoDate(row.dateOfBirth),
  };
}

export async function readOwnProfile(session: Session): Promise<PatientProfileView> {
  const row = await db.patientProfile.findUnique({ where: { id: ownPatientId(session) }, select: profileSelect });
  if (!row) throw new AppError("NOT_FOUND");
  return view(row);
}

/**
 * Corrects the patient's own profile. Fields that already hold the value sent are left alone,
 * and a request that changes nothing writes no audit event.
 */
export async function changeOwnProfile(session: Session, changes: PatientProfileChanges): Promise<PatientProfileView> {
  const patientId = ownPatientId(session);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PatientProfile" WHERE "id" = ${patientId}::uuid FOR UPDATE`;
    const current = await tx.patientProfile.findUnique({ where: { id: patientId }, select: profileSelect });
    if (!current) throw new AppError("NOT_FOUND");

    const data: { fullName?: string; phone?: string; dateOfBirth?: Date } = {};
    if (changes.fullName !== undefined && changes.fullName !== current.fullName) data.fullName = changes.fullName;
    if (changes.phone !== undefined && changes.phone !== current.phone) data.phone = changes.phone;
    if (changes.dateOfBirth !== undefined && changes.dateOfBirth !== isoDate(current.dateOfBirth)) {
      data.dateOfBirth = new Date(`${changes.dateOfBirth}T00:00:00Z`);
    }
    if (Object.keys(data).length === 0) return view(current);

    const updated = await tx.patientProfile.update({ where: { id: patientId }, data, select: profileSelect });
    await writeAudit(tx, {
      actorId: session.userId,
      actorRole: session.role,
      action: "patient.profile_changed",
      entityType: "patient",
      entityId: patientId,
      clinicId: null,
    });
    return view(updated);
  });
}
