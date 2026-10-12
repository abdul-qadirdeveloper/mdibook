// DEVELOPMENT STAND-IN, not authentication. The caller names a user in the x-dev-user-id
// header and is believed. It refuses to run in production. Real sign-in (R98 to R103) replaces
// this file; callers depend only on getSession() and the Session shape.
import { db, isId } from "@/lib/db";
import type { Role } from "@/domain/transitions";

export const DEV_USER_HEADER = "x-dev-user-id";

export interface Session {
  userId: string;
  role: Role;
  /** The clinic of a doctor or staff member. Null for a patient or an admin. */
  clinicId: string | null;
  patientId: string | null;
  doctorId: string | null;
  staffId: string | null;
}

export class SessionUnavailableError extends Error {
  constructor() {
    super("The development session stand-in does not run in production");
    this.name = "SessionUnavailableError";
  }
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") throw new SessionUnavailableError();
}

/** The signed-in user, or null when the header is missing, unknown, or names an inactive account. */
export async function getSession(request: Request): Promise<Session | null> {
  assertNotProduction();
  const userId = request.headers.get(DEV_USER_HEADER);
  if (!isId(userId)) return null;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      active: true,
      patientProfile: { select: { id: true } },
      doctorProfile: { select: { id: true, clinicId: true } },
      staffProfile: { select: { id: true, clinicId: true } },
    },
  });
  if (!user || !user.active) return null;

  const session: Session = {
    userId: user.id,
    role: user.role,
    clinicId: null,
    patientId: null,
    doctorId: null,
    staffId: null,
  };
  switch (user.role) {
    case "patient":
      if (!user.patientProfile) return null;
      session.patientId = user.patientProfile.id;
      return session;
    case "doctor":
      if (!user.doctorProfile) return null;
      session.doctorId = user.doctorProfile.id;
      session.clinicId = user.doctorProfile.clinicId;
      return session;
    case "staff":
      if (!user.staffProfile) return null;
      session.staffId = user.staffProfile.id;
      session.clinicId = user.staffProfile.clinicId;
      return session;
    case "admin":
      return session;
    default:
      return null;
  }
}

export interface DevUser {
  userId: string;
  role: Role;
  /** What the development user chooser shows. Seed data is fictional. */
  label: string;
}

/** The accounts the development user chooser offers. Refuses to run in production. */
export async function listDevUsers(): Promise<DevUser[]> {
  assertNotProduction();
  const users = await db.user.findMany({
    where: { active: true },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    take: 50,
    select: {
      id: true,
      role: true,
      patientProfile: { select: { fullName: true } },
      doctorProfile: { select: { name: true, clinic: { select: { name: true } } } },
      staffProfile: { select: { clinic: { select: { name: true } } } },
    },
  });
  return users.map((u) => {
    let label: string = u.role;
    if (u.patientProfile) label = `Patient: ${u.patientProfile.fullName}`;
    else if (u.doctorProfile) label = `Doctor: ${u.doctorProfile.name} (${u.doctorProfile.clinic.name})`;
    else if (u.staffProfile) label = `Staff (${u.staffProfile.clinic.name})`;
    else if (u.role === "admin") label = "Admin";
    return { userId: u.id, role: u.role, label };
  });
}
