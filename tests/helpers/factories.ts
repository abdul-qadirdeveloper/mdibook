// Fictional test data. No name, address or contact detail here belongs to a real person.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { type Session, DEV_USER_HEADER, getSession } from "@/lib/session";

const unique = () => randomUUID().slice(0, 8);

export const CHICAGO = "America/Chicago";

export async function createClinic(
  over: { timeZone?: string; cancellationWindowHours?: number; maxUpcomingPerPatient?: number } = {},
) {
  return db.clinic.create({
    data: {
      name: `Example Clinic ${unique()}`,
      address: "1 Sample Street",
      area: "Testville",
      city: "Exampleton",
      timeZone: over.timeZone ?? CHICAGO,
      ...(over.cancellationWindowHours !== undefined ? { cancellationWindowHours: over.cancellationWindowHours } : {}),
      ...(over.maxUpcomingPerPatient !== undefined ? { maxUpcomingPerPatient: over.maxUpcomingPerPatient } : {}),
    },
  });
}

export async function createSpecialty() {
  return db.specialty.create({ data: { name: `Specialty ${unique()}` } });
}

export interface DoctorOptions {
  slotLengthMinutes?: number;
  /** Working hours on every weekday given. Default: every day 09:00 to 17:00. */
  hours?: { weekday: number; startMinute: number; endMinute: number }[];
  active?: boolean;
}

export async function createDoctor(clinicId: string, options: DoctorOptions = {}) {
  const specialty = await createSpecialty();
  const user = await db.user.create({
    data: { email: `doctor-${unique()}@example.test`, role: "doctor", active: options.active ?? true },
  });
  const doctor = await db.doctorProfile.create({
    data: {
      userId: user.id,
      clinicId,
      name: `Dr. Sample ${unique()}`,
      specialtyId: specialty.id,
      description: "Fictional doctor for tests.",
      slotLengthMinutes: options.slotLengthMinutes ?? 30,
    },
  });
  const hours =
    options.hours ?? [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
  if (hours.length > 0) {
    await db.workingHours.createMany({ data: hours.map((h) => ({ ...h, doctorId: doctor.id, clinicId })) });
  }
  return { user, doctor };
}

export async function createStaff(clinicId: string, options: { active?: boolean } = {}) {
  const user = await db.user.create({
    data: { email: `staff-${unique()}@example.test`, role: "staff", active: options.active ?? true },
  });
  const staff = await db.staffProfile.create({ data: { userId: user.id, clinicId } });
  return { user, staff };
}

export async function createPatient(options: { dateOfBirth?: string | null; active?: boolean } = {}) {
  const user = await db.user.create({
    data: { email: `patient-${unique()}@example.test`, role: "patient", active: options.active ?? true },
  });
  const dateOfBirth = options.dateOfBirth === undefined ? "1990-05-17" : options.dateOfBirth;
  const patient = await db.patientProfile.create({
    data: {
      userId: user.id,
      fullName: `Pat Example ${unique()}`,
      phone: "555-0100",
      dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00Z`) : null,
    },
  });
  return { user, patient };
}

export async function createAdmin() {
  return db.user.create({ data: { email: `admin-${unique()}@example.test`, role: "admin" } });
}

/** The session the development stand-in resolves for a user. */
export async function sessionFor(userId: string): Promise<Session> {
  const session = await getSession(new Request("http://localhost/", { headers: { [DEV_USER_HEADER]: userId } }));
  if (!session) throw new Error("No session for this test user");
  return session;
}

/** A clinic in America/Chicago with one doctor, one staff member and one patient. */
export async function createWorld(
  options: { clinic?: Parameters<typeof createClinic>[0]; doctor?: DoctorOptions } = {},
) {
  const clinic = await createClinic(options.clinic);
  const { user: doctorUser, doctor } = await createDoctor(clinic.id, options.doctor);
  const { user: staffUser, staff } = await createStaff(clinic.id);
  const { user: patientUser, patient } = await createPatient();
  return {
    clinic,
    doctor,
    doctorUser,
    staff,
    staffUser,
    patient,
    patientUser,
    doctorSession: await sessionFor(doctorUser.id),
    staffSession: await sessionFor(staffUser.id),
    patientSession: await sessionFor(patientUser.id),
  };
}
