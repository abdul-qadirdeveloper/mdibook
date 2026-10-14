// The patient's own profile and the date of birth asked for at booking (R18, R19, R81).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createPatient, createWorld } from "../../helpers/factories";
import { book, bookingBody, getProfile, patchProfile, read } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
const S0900 = at("2026-10-14", "09:00");
const S1000 = at("2026-10-14", "10:00");
const MISSING_DOCTOR = "7f0c1f0e-3d0a-4b53-9d2e-0a1b2c3d4e5f";

const storedBirthDate = async (patientId: string) =>
  (await db.patientProfile.findUniqueOrThrow({ where: { id: patientId } })).dateOfBirth?.toISOString().slice(0, 10) ?? null;

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => {
  restoreClock();
});

describe("date of birth at booking (R18, R19)", () => {
  it("is required when the profile has none: the booking is refused and nothing is booked", async () => {
    const fresh = await createPatient({ dateOfBirth: null });
    const result = await book(fresh.user.id, bookingBody(w.doctor.id, S0900));
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([{ field: "dateOfBirth", problem: "required" }]);
    expect(await db.appointment.count()).toBe(0);
  });

  it("is stored once on the profile and not asked for again", async () => {
    const fresh = await createPatient({ dateOfBirth: null });
    const first = await book(fresh.user.id, bookingBody(w.doctor.id, S0900, { dateOfBirth: "1984-02-29" }));
    expect(first.status).toBe(201);
    expect(first.json.appointment.dateOfBirth).toBe("1984-02-29");
    expect(await storedBirthDate(fresh.patient.id)).toBe("1984-02-29");

    // The profile pre-fills the next booking form, and the next booking needs no date.
    expect((await getProfile(fresh.user.id)).json.profile.dateOfBirth).toBe("1984-02-29");
    const second = await book(fresh.user.id, bookingBody(w.doctor.id, S1000));
    expect(second.status).toBe(201);
    expect(await db.auditEvent.count({ where: { action: "patient.profile_changed" } })).toBe(1);
  });

  it("can be corrected at a later booking, and sending the same date again changes nothing", async () => {
    await book(w.patientUser.id, bookingBody(w.doctor.id, S0900, { dateOfBirth: "1990-05-17" }));
    expect(await db.auditEvent.count({ where: { action: "patient.profile_changed" } })).toBe(0);

    const corrected = await book(w.patientUser.id, bookingBody(w.doctor.id, S1000, { dateOfBirth: "1990-05-18" }));
    expect(corrected.status).toBe(201);
    expect(await storedBirthDate(w.patient.id)).toBe("1990-05-18");
    expect(await db.auditEvent.count({ where: { action: "patient.profile_changed" } })).toBe(1);
  });

  it("must be a real calendar date that is not in the future, and is never repeated in the error (R89)", async () => {
    for (const bad of ["2026-10-13", "1990-02-30", "17/05/1990", "1890-01-01"]) {
      const result = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900, { dateOfBirth: bad }));
      expect(result.status, bad).toBe(422);
      expect(result.json.error.fields).toEqual([{ field: "dateOfBirth", problem: "invalid" }]);
      expect(JSON.stringify(result.json)).not.toContain(bad);
    }
    expect(await storedBirthDate(w.patient.id)).toBe("1990-05-17");
    expect(await db.appointment.count()).toBe(0);
  });

  it("is not stored when the slot turns out to be taken; it is stored by the booking that succeeds", async () => {
    const holder = await createPatient();
    await book(holder.user.id, bookingBody(w.doctor.id, S0900));
    const fresh = await createPatient({ dateOfBirth: null });
    const lost = await book(fresh.user.id, bookingBody(w.doctor.id, S0900, { dateOfBirth: "1984-02-29" }));
    expect(lost.status).toBe(409);
    expect(await storedBirthDate(fresh.patient.id)).toBeNull();
    expect(await db.auditEvent.count({ where: { action: "patient.profile_changed" } })).toBe(0);

    // The form keeps what was typed (R23), so the next choice sends it again.
    expect((await book(fresh.user.id, bookingBody(w.doctor.id, S1000, { dateOfBirth: "1984-02-29" }))).status).toBe(201);
    expect(await storedBirthDate(fresh.patient.id)).toBe("1984-02-29");
    expect(await db.auditEvent.count({ where: { action: "patient.profile_changed" } })).toBe(1);
  });

  it("a correction sent with a refused booking leaves the stored date as it was", async () => {
    await db.clinic.update({ where: { id: w.clinic.id }, data: { maxUpcomingPerPatient: 1 } });
    expect((await book(w.patientUser.id, bookingBody(w.doctor.id, S1000))).status).toBe(201);
    const refused = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900, { dateOfBirth: "1990-05-18" }));
    expect(refused.json.error.code).toBe("BOOKING_LIMIT_REACHED");
    const missing = await book(w.patientUser.id, bookingBody(MISSING_DOCTOR, S0900, { dateOfBirth: "1990-05-18" }));
    expect(missing.status).toBe(404);
    expect(await storedBirthDate(w.patient.id)).toBe("1990-05-17");
    expect(await db.auditEvent.count({ where: { action: "patient.profile_changed" } })).toBe(0);
  });

  it("is shown to the patient, as an age to the doctor, and not at all to staff", async () => {
    const id = (await book(w.patientUser.id, bookingBody(w.doctor.id, S0900))).json.appointment.id;
    expect((await read(w.patientUser.id, id)).json.appointment.dateOfBirth).toBe("1990-05-17");
    const asDoctor = (await read(w.doctorUser.id, id)).json;
    expect(asDoctor.appointment.patientAge).toBe(36);
    expect(JSON.stringify(asDoctor)).not.toContain("1990-05-17");
    expect(JSON.stringify((await read(w.staffUser.id, id)).json)).not.toMatch(/1990-05-17|patientAge/);
  });
});

describe("GET and PATCH /me/profile (R19)", () => {
  it("a patient reads their own full name, phone, email and date of birth", async () => {
    const result = await getProfile(w.patientUser.id);
    expect(result.status).toBe(200);
    expect(result.json.profile).toEqual({
      fullName: w.patient.fullName,
      phone: "555-0100",
      email: w.patientUser.email,
      dateOfBirth: "1990-05-17",
    });
  });

  it("only a patient has one: no session is 401, any other role is 403", async () => {
    expect((await getProfile(undefined)).status).toBe(401);
    expect((await patchProfile(undefined, { phone: "555-0199" })).status).toBe(401);
    for (const userId of [w.staffUser.id, w.doctorUser.id]) {
      expect((await getProfile(userId)).status).toBe(403);
      expect((await patchProfile(userId, { phone: "555-0199" })).status).toBe(403);
    }
  });

  it("a correction changes only the caller's own profile and writes one audit event with no clinic (R81)", async () => {
    const other = await createPatient();
    const result = await patchProfile(w.patientUser.id, {
      fullName: "Pat Corrected",
      phone: "555-0142",
      dateOfBirth: "1991-06-18",
    });
    expect(result.status).toBe(200);
    expect(result.json.profile).toEqual({
      fullName: "Pat Corrected",
      phone: "555-0142",
      email: w.patientUser.email,
      dateOfBirth: "1991-06-18",
    });
    expect((await getProfile(other.user.id)).json.profile.fullName).toBe(other.patient.fullName);

    const audit = await db.auditEvent.findMany({ where: { action: "patient.profile_changed" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: w.patientUser.id,
      actorRole: "patient",
      entityType: "patient",
      entityId: w.patient.id,
      clinicId: null,
    });
    // Ids only: the audit row has no column that could hold what was typed.
    expect(JSON.stringify(audit[0])).not.toMatch(/Corrected|555-0142|1991-06-18/);
  });

  it("a request that changes nothing writes no audit event", async () => {
    const result = await patchProfile(w.patientUser.id, { phone: "555-0100", dateOfBirth: "1990-05-17" });
    expect(result.status).toBe(200);
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("refuses an empty body, an unknown field, and values that are not valid, without repeating them", async () => {
    const empty = await patchProfile(w.patientUser.id, {});
    expect(empty.status).toBe(422);
    expect(empty.json.error.fields).toEqual([{ field: "body", problem: "required" }]);

    const unknown = await patchProfile(w.patientUser.id, { email: "someone-else@example.test" });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.json)).not.toContain("someone-else");

    const future = await patchProfile(w.patientUser.id, { dateOfBirth: "2031-01-01" });
    expect(future.json.error.fields).toEqual([{ field: "dateOfBirth", problem: "invalid" }]);
    expect(JSON.stringify(future.json)).not.toContain("2031-01-01");

    const blank = await patchProfile(w.patientUser.id, { fullName: "  " });
    expect(blank.json.error.fields).toEqual([{ field: "fullName", problem: "too_short" }]);
    expect(await db.auditEvent.count()).toBe(0);
    expect((await getProfile(w.patientUser.id)).json.profile.fullName).toBe(w.patient.fullName);
  });

  it("nothing typed reaches the log (R78, R79)", async () => {
    const { raw } = await captureLogs(async () => {
      await patchProfile(w.patientUser.id, { fullName: "Pat Corrected", phone: "555-0142", dateOfBirth: "1991-06-18" });
      await getProfile(w.patientUser.id);
    });
    expect(raw).toContain("request.completed");
    expect(raw).not.toMatch(/Corrected|555-0142|1991-06-18|@example\.test/);
  });
});
