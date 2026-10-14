// Booking as a patient (R2, R6, R17, R18, R20, R21, R24, R25, R27), through the real route,
// the real use case and the real database.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleAppointmentFields } from "@/domain/visibility";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createClinic, createDoctor, createPatient, createWorld } from "../../helpers/factories";
import { REASON, book, bookingBody, openStarts, slots } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
// Wednesday 14 October 2026, Chicago. The doctor works every day, 09:00 to 17:00, 30 minutes.
const S0900 = at("2026-10-14", "09:00");
const S0930 = at("2026-10-14", "09:30");
const S1000 = at("2026-10-14", "10:00");
const S1030 = at("2026-10-14", "10:30");

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => {
  restoreClock();
});

describe("booking as a patient", () => {
  it("needs an account: no session is 401 and nothing is booked (R2)", async () => {
    const result = await book(undefined, bookingBody(w.doctor.id, S0900));
    expect(result.status).toBe(401);
    expect(result.json.error.code).toBe("UNAUTHENTICATED");
    expect(await db.appointment.count()).toBe(0);
  });

  it("creates a requested appointment that holds its slot from creation (R21)", async () => {
    expect(await openStarts(w.patientUser.id, w.doctor.id)).toContain(S0900.toISOString());

    const result = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900));
    expect(result.status).toBe(201);
    const a = result.json.appointment;
    expect(Object.keys(a).sort()).toEqual(visibleAppointmentFields("patient").sort());
    expect(a).toMatchObject({
      status: "requested",
      startsAt: S0900.toISOString(),
      endsAt: S0930.toISOString(),
      slotLengthMinutes: 30,
      timeZone: "America/Chicago",
      doctorId: w.doctor.id,
      patientId: w.patient.id,
      reasonForVisit: REASON,
      cancelledBy: null,
    });

    const row = await db.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ status: "requested", bookedById: w.patientUser.id, bookedByRole: "patient" });
    // The slot is no longer offered to anyone.
    const other = await createPatient();
    expect(await openStarts(other.user.id, w.doctor.id)).not.toContain(S0900.toISOString());
  });

  it("reading slots holds nothing and books nothing (R17)", async () => {
    await slots(w.patientUser.id, w.doctor.id);
    await slots(w.patientUser.id, w.doctor.id);
    expect(await db.appointment.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
    expect(await db.notificationEvent.count()).toBe(0);
    // Still open for somebody else.
    const other = await createPatient();
    expect((await book(other.user.id, bookingBody(w.doctor.id, S0900))).status).toBe(201);
  });

  it("writes one history row, one audit event and one notification event, with ids only", async () => {
    const { result, raw } = await captureLogs(() => book(w.patientUser.id, bookingBody(w.doctor.id, S0900)));
    const id = result.json.appointment.id;

    const audit = await db.auditEvent.findMany({ where: { action: "appointment.booked" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: w.patientUser.id,
      actorRole: "patient",
      entityType: "appointment",
      entityId: id,
      clinicId: w.clinic.id,
    });
    const events = await db.notificationEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "booked", appointmentId: id, patientId: w.patient.id, doctorId: w.doctor.id });
    expect(await db.appointmentHistory.count({ where: { appointmentId: id, action: "booked" } })).toBe(1);

    // The log has event codes and ids. Never the reason, the name, the phone or the birth date.
    expect(raw).toContain("request.completed");
    expect(raw).not.toContain(REASON);
    expect(raw).not.toContain(w.patient.fullName);
    expect(raw).not.toMatch(/555-0100|1990-05-17|@example\.test/);
  });

  it("requires a reason for visit of at most 200 characters, and never repeats what was typed (R18, R20, R89)", async () => {
    const missing = await book(w.patientUser.id, { doctorId: w.doctor.id, startsAt: S0900.toISOString() });
    expect(missing.status).toBe(422);
    expect(missing.json.error.fields).toEqual([{ field: "reasonForVisit", problem: "required" }]);

    const blank = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900, { reasonForVisit: "   " }));
    expect(blank.status).toBe(422);
    expect(blank.json.error.fields).toEqual([{ field: "reasonForVisit", problem: "too_short" }]);

    const long = "Fictional symptom ".repeat(12);
    expect(long.length).toBeGreaterThan(200);
    const tooLong = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900, { reasonForVisit: long }));
    expect(tooLong.status).toBe(422);
    expect(tooLong.json.error.fields).toEqual([{ field: "reasonForVisit", problem: "too_long" }]);
    expect(JSON.stringify(tooLong.json)).not.toContain("Fictional symptom");

    const exactly200 = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900, { reasonForVisit: "x".repeat(200) }));
    expect(exactly200.status).toBe(201);
    expect(await db.appointment.count()).toBe(1);
  });

  it("the first booking at a clinic creates the patient-to-clinic link, the second does not repeat it (R6)", async () => {
    expect(await db.clinicPatient.count()).toBe(0);
    await book(w.patientUser.id, bookingBody(w.doctor.id, S0900));
    await book(w.patientUser.id, bookingBody(w.doctor.id, S1000));

    expect(await db.clinicPatient.findMany()).toMatchObject([{ clinicId: w.clinic.id, patientId: w.patient.id }]);
    expect(await db.auditEvent.count({ where: { action: "patient.clinic_linked" } })).toBe(1);

    // A booking at another clinic links the patient there too.
    const elsewhere = await createClinic();
    const { doctor } = await createDoctor(elsewhere.id);
    await book(w.patientUser.id, bookingBody(doctor.id, S0900));
    expect(await db.clinicPatient.count()).toBe(2);
  });

  it("a patient cannot name another patient, and a doctor cannot book at all", async () => {
    const other = await createPatient();
    const forOther = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900, { patientId: other.patient.id }));
    expect(forOther.status).toBe(422);
    expect(forOther.json.error.fields).toEqual([{ field: "patientId", problem: "not_allowed" }]);

    const asDoctor = await book(w.doctorUser.id, bookingBody(w.doctor.id, S0900));
    expect(asDoctor.status).toBe(403);
    expect(await db.appointment.count()).toBe(0);
  });

  it("a missing, malformed or deactivated doctor is not found (R96)", async () => {
    const { doctor: inactive } = await createDoctor(w.clinic.id, { active: false });
    const gone = await book(w.patientUser.id, bookingBody(inactive.id, S0900));
    expect(gone.status).toBe(404);
    const missing = await book(w.patientUser.id, bookingBody("7f0c1f0e-3d0a-4b53-9d2e-0a1b2c3d4e5f", S0900));
    expect(missing.status).toBe(404);
    const malformed = await book(w.patientUser.id, bookingBody("not-an-id", S0900));
    expect(malformed.status).toBe(422);
    expect(await db.appointment.count()).toBe(0);
  });
});

describe("a slot is bookable only if every rule of R24 holds, checked again by the server", () => {
  const unavailable = async (start: Date, doctorId = w.doctor.id) => {
    const result = await book(w.patientUser.id, bookingBody(doctorId, start));
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_UNAVAILABLE");
  };

  it("in the past", async () => {
    await unavailable(at("2026-10-11", "09:00"));
    // 06:30 today is before NOW (07:00) and outside hours; 09:00 today is still ahead.
    expect((await book(w.patientUser.id, bookingBody(w.doctor.id, at("2026-10-12", "09:00")))).status).toBe(201);
  });

  it("more than 90 days ahead", async () => {
    await unavailable(at("2027-01-11", "09:00"));
    expect((await book(w.patientUser.id, bookingBody(w.doctor.id, at("2027-01-09", "09:00")))).status).toBe(201);
  });

  it("outside the doctor's working hours", async () => {
    await unavailable(at("2026-10-14", "08:30"));
    await unavailable(at("2026-10-14", "17:00"));
    const { doctor: weekdaysOnly } = await createDoctor(w.clinic.id, {
      hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
    });
    await unavailable(at("2026-10-17", "09:00"), weekdaysOnly.id);
  });

  it("off the slot grid", async () => {
    await unavailable(at("2026-10-14", "09:10"));
  });

  it("in a break", async () => {
    await db.break.create({
      data: { doctorId: w.doctor.id, clinicId: w.clinic.id, weekday: 3, startMinute: 12 * 60, endMinute: 13 * 60 },
    });
    await unavailable(at("2026-10-14", "12:00"));
    await unavailable(at("2026-10-14", "12:30"));
  });

  it("in time off", async () => {
    await db.timeOff.create({
      data: {
        doctorId: w.doctor.id,
        clinicId: w.clinic.id,
        startsAt: at("2026-10-14", "00:00"),
        endsAt: at("2026-10-15", "00:00"),
        reasonCode: "planned_leave",
        createdById: w.staffUser.id,
      },
    });
    await unavailable(S0900);
  });

  it("already holding an active appointment: SLOT_TAKEN, with the next three open slots (R23)", async () => {
    const holder = await createPatient();
    await book(holder.user.id, bookingBody(w.doctor.id, S0900));

    const result = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900));
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_TAKEN");
    expect(result.json.error.nextSlots?.map((slot) => slot.startsAt)).toEqual(
      [S0930, S1000, S1030].map((slot) => slot.toISOString()),
    );
    expect(result.json.error.timeZone).toBe("America/Chicago");
    // Nothing about whoever holds the slot.
    expect(JSON.stringify(result.json)).not.toContain(holder.patient.fullName);
    expect(JSON.stringify(result.json)).not.toContain(holder.patient.id);
    expect(await db.appointment.count()).toBe(1);
  });

  afterEach(async () => {
    // None of the refusals above left an appointment for this patient at the refused time.
    expect(await db.appointment.count({ where: { patientId: w.patient.id, status: "requested" } })).toBeLessThanOrEqual(1);
  });
});

describe("the booking limit (R25)", () => {
  it("the booking over the clinic's limit is refused with the limit and what to do next", async () => {
    for (const start of [S0900, S1000, S1030]) {
      expect((await book(w.patientUser.id, bookingBody(w.doctor.id, start))).status).toBe(201);
    }
    const fourth = await book(w.patientUser.id, bookingBody(w.doctor.id, at("2026-10-15", "09:00")));
    expect(fourth.status).toBe(409);
    expect(fourth.json.error.code).toBe("BOOKING_LIMIT_REACHED");
    expect(fourth.json.error.limit).toBe(3);
    expect(fourth.json.error.message).toMatch(/Cancel one/);
    expect(await db.appointment.count()).toBe(3);
  });

  it("is counted per clinic, uses the clinic's own number, and counts only upcoming appointments", async () => {
    const strict = await createClinic({ maxUpcomingPerPatient: 1 });
    const { doctor } = await createDoctor(strict.id);
    expect((await book(w.patientUser.id, bookingBody(doctor.id, S0900))).status).toBe(201);
    const second = await book(w.patientUser.id, bookingBody(doctor.id, S1000));
    expect(second.json.error).toMatchObject({ code: "BOOKING_LIMIT_REACHED", limit: 1 });

    // The other clinic still has room.
    expect((await book(w.patientUser.id, bookingBody(w.doctor.id, S1000))).status).toBe(201);

    // Once the first one has started it is no longer upcoming.
    freezeClock(at("2026-10-14", "09:05"));
    expect((await book(w.patientUser.id, bookingBody(doctor.id, S1030))).status).toBe(201);
  });
});

describe("a repeated submission (R27)", () => {
  it("the same Idempotency-Key twice gives one appointment: 201, then 200 with the same one", async () => {
    const headers = { "idempotency-key": "double-click-0001" };
    const first = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900), headers);
    const second = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900), headers);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.json.appointment.id).toBe(first.json.appointment.id);
    expect(await db.appointment.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "appointment.booked" } })).toBe(1);
    expect(await db.notificationEvent.count()).toBe(1);
  });

  it("without a key, a second submission for the same slot is a 409, never a second appointment", async () => {
    await book(w.patientUser.id, bookingBody(w.doctor.id, S0900));
    const again = await book(w.patientUser.id, bookingBody(w.doctor.id, S0900));
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("SLOT_TAKEN");
    expect(await db.appointment.count()).toBe(1);
  });

  it("another patient cannot replay someone else's key", async () => {
    const headers = { "idempotency-key": "double-click-0002" };
    await book(w.patientUser.id, bookingBody(w.doctor.id, S0900), headers);
    const other = await createPatient();
    const result = await book(other.user.id, bookingBody(w.doctor.id, S0900), headers);
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.json)).not.toContain(w.patient.id);
  });
});
