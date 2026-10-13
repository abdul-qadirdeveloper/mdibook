// Finding the patient to book for (R92), and one patient's record at the clinic (R59, R60,
// R61, R66, R84). Staff search by name only among patients linked to their clinic. For a
// patient not yet linked they enter the full email address, and an exact match returns the
// patient's name and nothing else, at most 30 times an hour. The term travels in the request
// body and is never logged (R79, R80).
import { z } from "zod";
import { HOUR_MS, ageOn } from "@/domain/time";
import { canSee, pickVisible } from "@/domain/visibility";
import { db } from "@/lib/db";
import { AppError, validationError } from "@/lib/errors";
import { appointmentScope, clinicOf, foundOrNotFound } from "@/lib/scope";
import type { AppointmentResponse } from "@/lib/serialize";
import type { Session } from "@/lib/session";
import { readAppointments } from "./schedule-change";

export const EMAIL_LOOKUPS_PER_HOUR = 30;
const NAME_RESULTS = 20;
const RECORD_APPOINTMENTS = 100;

/** Exactly one of the two. */
export const patientSearchSchema = z.strictObject({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
});

export type PatientSearch = z.infer<typeof patientSearchSchema>;

export interface PatientMatch {
  patientId: string;
  patientName: string;
}

async function searchByName(clinicId: string, term: string): Promise<PatientMatch[]> {
  const rows = await db.patientProfile.findMany({
    where: {
      fullName: { contains: term, mode: "insensitive" },
      user: { active: true },
      clinics: { some: { clinicId } },
    },
    select: { id: true, fullName: true },
    orderBy: [{ fullName: "asc" }, { id: "asc" }],
    take: NAME_RESULTS,
  });
  return rows.map((r) => ({ patientId: r.id, patientName: r.fullName }));
}

async function lookUpByEmail(session: Session, clinicId: string, email: string, now: Date): Promise<PatientMatch[]> {
  // Count and record under a lock on the staff member's own row, so lookups sent together
  // cannot all pass the limit.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "StaffProfile" WHERE "userId" = ${session.userId}::uuid FOR UPDATE`;
    const used = await tx.staffLookupLog.count({
      where: { staffUserId: session.userId, at: { gt: new Date(now.getTime() - HOUR_MS) } },
    });
    if (used >= EMAIL_LOOKUPS_PER_HOUR) throw new AppError("RATE_LIMITED");
    await tx.staffLookupLog.create({ data: { staffUserId: session.userId, clinicId, at: now } });
  });

  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, role: "patient", active: true },
    select: { patientProfile: { select: { id: true, fullName: true } } },
  });
  const profile = user?.patientProfile;
  return profile ? [{ patientId: profile.id, patientName: profile.fullName }] : [];
}

/** Errors: VALIDATION_FAILED, RATE_LIMITED. */
export async function searchPatients(session: Session, search: PatientSearch, now: Date): Promise<PatientMatch[]> {
  const clinicId = clinicOf(session);
  if ((search.name === undefined) === (search.email === undefined)) {
    throw validationError({ field: "body", problem: "invalid" });
  }
  if (search.email !== undefined) return lookUpByEmail(session, clinicId, search.email, now);
  return searchByName(clinicId, search.name ?? "");
}

export interface PatientRecord {
  /** The patient fields of the visibility table that the caller's role may see. */
  patient: Partial<Pick<AppointmentResponse, "patientId" | "patientName" | "patientPhone" | "patientEmail" | "noShowCount" | "patientAge">>;
  /** Newest first. Staff: all at their clinic. A doctor: only those with themself (R60). */
  appointments: AppointmentResponse[];
}

/**
 * One patient as the caller's clinic knows them. Nothing from another clinic is read (R61).
 * A patient with no appointment in the caller's scope is NOT_FOUND (R8).
 */
export async function readPatientRecord(session: Session, patientId: string, now: Date): Promise<PatientRecord> {
  const clinicId = clinicOf(session);
  const rows = await db.appointment.findMany({
    where: { AND: [{ patientId, clinicId }, appointmentScope(session)] },
    select: { id: true },
    orderBy: [{ startsAt: "desc" }, { id: "asc" }],
    take: RECORD_APPOINTMENTS,
  });
  if (rows.length === 0) throw new AppError("NOT_FOUND");

  const profile = foundOrNotFound(
    await db.patientProfile.findUnique({
      where: { id: patientId },
      select: { id: true, fullName: true, phone: true, dateOfBirth: true, user: { select: { email: true } } },
    }),
  );
  const clinic = await db.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timeZone: true } });
  // The number of the patient's no-shows at this clinic only (R66).
  const noShowCount = await db.appointment.count({ where: { clinicId, patientId, status: "no_show" } });
  const born = profile.dateOfBirth ? profile.dateOfBirth.toISOString().slice(0, 10) : null;

  return {
    patient: pickVisible(session.role, {
      patientId: profile.id,
      patientName: profile.fullName,
      patientPhone: profile.phone,
      patientEmail: profile.user.email,
      noShowCount,
      // Age only, and only for a role that may see it (F17).
      patientAge: canSee(session.role, "patientAge") && born ? ageOn(born, now, clinic.timeZone) : null,
    }),
    appointments: await readAppointments(
      session,
      rows.map((r) => r.id),
      now,
    ),
  };
}
