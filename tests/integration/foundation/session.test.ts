// The development session stand-in (R1): resolves each role and its clinic from the
// x-dev-user-id header, refuses inactive accounts, and refuses to run in production.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { DEV_USER_HEADER, SessionUnavailableError, getSession, listDevUsers } from "@/lib/session";
import { resetDb } from "../../helpers/db";
import { createAdmin, createClinic, createDoctor, createPatient, createStaff } from "../../helpers/factories";

const request = (userId?: string) =>
  new Request("http://localhost/api/v1/anything", { headers: userId ? { [DEV_USER_HEADER]: userId } : {} });

let clinicId: string;
let otherClinicId: string;

beforeAll(async () => {
  await resetDb();
  clinicId = (await createClinic()).id;
  otherClinicId = (await createClinic()).id;
});

afterEach(() => vi.unstubAllEnvs());

describe("getSession", () => {
  it("resolves a patient: no clinic", async () => {
    const { user, patient } = await createPatient();
    expect(await getSession(request(user.id))).toEqual({
      userId: user.id,
      role: "patient",
      clinicId: null,
      patientId: patient.id,
      doctorId: null,
      staffId: null,
    });
  });

  it("resolves a doctor and the doctor's one clinic", async () => {
    const { user, doctor } = await createDoctor(clinicId);
    expect(await getSession(request(user.id))).toEqual({
      userId: user.id,
      role: "doctor",
      clinicId,
      patientId: null,
      doctorId: doctor.id,
      staffId: null,
    });
  });

  it("resolves a staff member and their one clinic", async () => {
    const { user, staff } = await createStaff(otherClinicId);
    expect(await getSession(request(user.id))).toEqual({
      userId: user.id,
      role: "staff",
      clinicId: otherClinicId,
      patientId: null,
      doctorId: null,
      staffId: staff.id,
    });
  });

  it("resolves an admin: no clinic and no profile", async () => {
    const user = await createAdmin();
    expect(await getSession(request(user.id))).toEqual({
      userId: user.id,
      role: "admin",
      clinicId: null,
      patientId: null,
      doctorId: null,
      staffId: null,
    });
  });

  it("takes the role and clinic from the database, never from the request", async () => {
    const { user } = await createPatient();
    const forged = new Request(`http://localhost/api/v1/x?role=staff&clinicId=${clinicId}`, {
      headers: { [DEV_USER_HEADER]: user.id, "x-role": "staff", "x-clinic-id": clinicId },
    });
    expect(await getSession(forged)).toMatchObject({ role: "patient", clinicId: null });
  });

  it("returns no session without the header, or for a malformed or unknown id", async () => {
    expect(await getSession(request())).toBeNull();
    expect(await getSession(request("not-an-id"))).toBeNull();
    expect(await getSession(request("1"))).toBeNull();
    expect(await getSession(request("' OR 1=1 --"))).toBeNull();
    expect(await getSession(request("3f2b8c1e-5d47-4a9b-8e21-0c6f7a1d2b34"))).toBeNull();
  });

  it("refuses an inactive user, for every role (R96)", async () => {
    const patient = await createPatient({ active: false });
    const doctor = await createDoctor(clinicId, { active: false });
    const staff = await createStaff(clinicId, { active: false });
    for (const { user } of [patient, doctor, staff]) {
      expect(await getSession(request(user.id))).toBeNull();
    }
    const active = await createStaff(clinicId);
    expect(await getSession(request(active.user.id))).not.toBeNull();
    await db.user.update({ where: { id: active.user.id }, data: { active: false } });
    expect(await getSession(request(active.user.id))).toBeNull();
  });

  it("refuses an account whose role has no matching profile", async () => {
    const user = await db.user.create({ data: { email: "orphan@example.test", role: "staff" } });
    expect(await getSession(request(user.id))).toBeNull();
  });

  it("refuses to run in production, with or without a valid header", async () => {
    const { user } = await createPatient();
    vi.stubEnv("NODE_ENV", "production");
    await expect(getSession(request(user.id))).rejects.toThrow(SessionUnavailableError);
    await expect(getSession(request())).rejects.toThrow(SessionUnavailableError);
    await expect(listDevUsers()).rejects.toThrow(SessionUnavailableError);
  });
});

describe("listDevUsers", () => {
  it("lists active accounts for the development user chooser", async () => {
    const users = await listDevUsers();
    const roles = new Set(users.map((u) => u.role));
    expect(roles).toEqual(new Set(["patient", "doctor", "staff", "admin"]));
    const inactive = await db.user.findMany({ where: { active: false }, select: { id: true } });
    for (const { id } of inactive) expect(users.map((u) => u.userId)).not.toContain(id);
  });
});
