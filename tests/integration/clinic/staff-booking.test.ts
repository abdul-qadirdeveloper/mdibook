// Staff booking for a patient (R28 to R30), and the clinic's limit applied to it (R25).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as bookRoute } from "@/app/api/v1/appointments/route";
import { visibleAppointmentFields } from "@/domain/visibility";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createClinic, createDoctor, createPatient, createStaff, createWorld } from "../../helpers/factories";
import { type Appointment, DAY, type ErrorJson, S0900, S0930, S1000, type World, book, counts, otherClinic, row, send } from "./support";

let w: World;
const REASON = "Fictional knee pain";

type Booked = { appointment: Appointment } & ErrorJson;
const bookFor = (body: Record<string, unknown>, headers?: Record<string, string>, userId = w.staffUser.id) =>
  send<Booked>(bookRoute, "POST", userId, {
    body: { doctorId: w.doctor.id, patientId: w.patient.id, startsAt: S0900.toISOString(), reasonForVisit: REASON, ...body },
    headers,
  });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("a staff booking (R28, R29)", () => {
  it("starts confirmed and records who booked it and when", async () => {
    const result = await bookFor({});
    expect(result.status).toBe(201);
    expect(result.json.appointment).toMatchObject({
      status: "confirmed",
      startsAt: S0900.toISOString(),
      bookedById: w.staffUser.id,
      bookedByRole: "staff",
      bookedAt: NOW.toISOString(),
      patientId: w.patient.id,
    });
    expect(await row(result.json.appointment.id as string)).toMatchObject({
      status: "confirmed",
      clinicId: w.clinic.id,
      bookedById: w.staffUser.id,
      bookedByRole: "staff",
      bookedAt: NOW,
      reasonForVisit: REASON,
    });
    expect(await db.appointmentHistory.findFirst({ where: { action: "booked" } })).toMatchObject({ actorId: w.staffUser.id, actorRole: "staff" });
  });

  it("the reason staff typed is stored but never returned to staff, and is not logged", async () => {
    const { result, raw } = await captureLogs(() => bookFor({}));
    expect(Object.keys(result.json.appointment).sort()).toEqual([...visibleAppointmentFields("staff")].sort());
    expect(result.json.appointment).not.toHaveProperty("reasonForVisit");
    expect(JSON.stringify(result.json)).not.toContain("knee");
    expect(raw).not.toMatch(/knee|Pat Example|555-0100|example\.test/);
    // The doctor can read it.
    expect((await row(result.json.appointment.id as string)).reasonForVisit).toBe(REASON);
  });

  it("the date of birth is never returned to staff and cannot be sent by staff", async () => {
    const result = await bookFor({});
    expect(result.json.appointment).not.toHaveProperty("dateOfBirth");
    expect(result.json.appointment).not.toHaveProperty("patientAge");
    expect(JSON.stringify(result.json)).not.toContain("1990");

    const sent = await bookFor({ startsAt: S0930.toISOString(), dateOfBirth: "1990-05-17" });
    expect(sent.status).toBe(422);
    expect(sent.json.error.fields).toEqual([{ field: "dateOfBirth", problem: "not_allowed" }]);
    expect(await db.appointment.count()).toBe(1);
  });

  it("succeeds for a patient with no date of birth on file", async () => {
    const { patient } = await createPatient({ dateOfBirth: null });
    const result = await bookFor({ patientId: patient.id });
    expect(result.status).toBe(201);
    expect((await db.patientProfile.findUniqueOrThrow({ where: { id: patient.id } })).dateOfBirth).toBeNull();
  });

  it("links the patient to the clinic at the first booking (R6)", async () => {
    expect(await db.clinicPatient.count()).toBe(0);
    await bookFor({});
    await bookFor({ startsAt: S0930.toISOString() });
    expect(await db.clinicPatient.count({ where: { clinicId: w.clinic.id, patientId: w.patient.id } })).toBe(1);
  });

  it("a repeated submission with the same key creates one appointment (R27)", async () => {
    const headers = { "Idempotency-Key": "staff-booking-0001" };
    const first = await bookFor({}, headers);
    const second = await bookFor({}, headers);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.json.appointment.id).toBe(first.json.appointment.id);
    expect(await db.appointment.count()).toBe(1);
  });
});

describe("what a staff booking cannot do", () => {
  it("add an appointment to an occupied slot (R30): 409, with the next open slots, nothing booked", async () => {
    const { patient } = await createPatient();
    await book(w, S0900);
    const before = await counts();

    const result = await bookFor({ patientId: patient.id });
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_TAKEN");
    expect(result.json.error.nextSlots).toHaveLength(3);
    expect(await counts()).toEqual(before);
  });

  it("go over the clinic's limit for the patient (R25)", async () => {
    await db.clinic.update({ where: { id: w.clinic.id }, data: { maxUpcomingPerPatient: 2 } });
    await bookFor({});
    await book(w, S0930);
    const before = await counts();

    const result = await bookFor({ startsAt: S1000.toISOString() });
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("BOOKING_LIMIT_REACHED");
    expect(result.json.error.limit).toBe(2);
    expect(await counts()).toEqual(before);
  });

  it("book a slot outside the schedule, in the past, or off the grid", async () => {
    for (const startsAt of [at(DAY, "18:00"), at("2026-10-09", "09:00"), at(DAY, "09:10")]) {
      const result = await bookFor({ startsAt: startsAt.toISOString() });
      expect(result.status).toBe(409);
      expect(result.json.error.code).toBe("SLOT_UNAVAILABLE");
    }
    expect(await db.appointment.count()).toBe(0);
  });

  it("book with a doctor of another clinic, or for a patient that does not exist: not found (R4, R8)", async () => {
    const other = await otherClinic();
    const elsewhere = await bookFor({ doctorId: other.doctor.id });
    expect(elsewhere.status).toBe(404);

    const nobody = await bookFor({ patientId: "5a7d2c1e-9b3f-4a6d-8e2c-1f0b9a8c7d6e" });
    expect(nobody.status).toBe(404);
    expect(nobody.json.error).toMatchObject({ code: elsewhere.json.error.code, message: elsewhere.json.error.message });
    expect(await db.appointment.count()).toBe(0);
    expect(await db.clinicPatient.count()).toBe(0);
  });

  it("be sent without a patient, a reason, or with a reason over 200 characters", async () => {
    const noPatient = await bookFor({ patientId: undefined });
    expect(noPatient.status).toBe(422);
    expect(noPatient.json.error.fields).toEqual([{ field: "patientId", problem: "required" }]);

    const noReason = await bookFor({ reasonForVisit: " " });
    expect(noReason.status).toBe(422);
    const tooLong = await bookFor({ reasonForVisit: "x".repeat(201) });
    expect(tooLong.status).toBe(422);
    expect(tooLong.json.error.fields).toEqual([{ field: "reasonForVisit", problem: "too_long" }]);
    expect(await db.appointment.count()).toBe(0);
  });

  it("be made by a doctor: only staff and patients book", async () => {
    const result = await bookFor({}, undefined, w.doctorUser.id);
    expect(result.status).toBe(403);
  });
});

describe("staff of one clinic and a patient of another", () => {
  it("each clinic's limit counts its own appointments only", async () => {
    const clinic = await createClinic({ maxUpcomingPerPatient: 1 });
    const { doctor } = await createDoctor(clinic.id);
    const { user: staffUser } = await createStaff(clinic.id);
    await bookFor({});
    await bookFor({ startsAt: S0930.toISOString() });

    // Two upcoming at the first clinic do not count against the second clinic's limit of one.
    const there = await bookFor({ doctorId: doctor.id }, undefined, staffUser.id);
    expect(there.status).toBe(201);
    const second = await bookFor({ doctorId: doctor.id, startsAt: S1000.toISOString() }, undefined, staffUser.id);
    expect(second.json.error.code).toBe("BOOKING_LIMIT_REACHED");
  });
});
