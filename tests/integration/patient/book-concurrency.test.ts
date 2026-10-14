// Simultaneous bookings (R22, R23, R25, R27). The requests are fired together and run on
// separate database connections against real PostgreSQL. Nothing is mocked: the loser is
// turned away by the database, through the partial unique index, and is answered with a 409.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createClinic, createDoctor, createPatient, createWorld } from "../../helpers/factories";
import { book, bookingBody } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
const S0900 = at("2026-10-14", "09:00");
const S0930 = at("2026-10-14", "09:30");
const S1000 = at("2026-10-14", "10:00");
const S1030 = at("2026-10-14", "10:30");

const activeAt = (doctorId: string, start: Date) =>
  db.appointment.count({ where: { doctorId, startsAt: start, status: { in: ["requested", "confirmed"] } } });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => {
  restoreClock();
});

describe("two bookings for the same slot at the same moment", () => {
  it("the database has the partial unique index that decides the race", async () => {
    const rows = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'Appointment_one_active_per_doctor_start'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/);
    expect(rows[0].indexdef).toMatch(/"doctorId", "startsAt"/);
    expect(rows[0].indexdef).toMatch(/WHERE .*status.*requested.*confirmed/);
  });

  it("exactly one 201 and one 409 SLOT_TAKEN, and one appointment (R23)", async () => {
    const other = await createPatient();

    const results = await Promise.all([
      book(w.patientUser.id, bookingBody(w.doctor.id, S0900)),
      book(other.user.id, bookingBody(w.doctor.id, S0900)),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = results.find((r) => r.status === 201)!;
    const loser = results.find((r) => r.status === 409)!;

    expect(winner.json.appointment).toMatchObject({ status: "requested", startsAt: S0900.toISOString() });
    expect(loser.json.error.code).toBe("SLOT_TAKEN");
    // The loser is offered the next three open slots with the same doctor, not the taken one.
    expect(loser.json.error.nextSlots?.map((slot) => slot.startsAt)).toEqual(
      [S0930, S1000, S1030].map((slot) => slot.toISOString()),
    );
    expect(loser.json.appointment).toBeUndefined();

    // One row, one history row, one audit event, one notification: nothing was booked for the
    // loser, and nothing was tried again on another slot.
    expect(await db.appointment.count()).toBe(1);
    expect(await activeAt(w.doctor.id, S0900)).toBe(1);
    expect(await db.appointmentHistory.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "appointment.booked" } })).toBe(1);
    expect(await db.notificationEvent.count()).toBe(1);
    const row = await db.appointment.findFirstOrThrow();
    expect(row.id).toBe(winner.json.appointment.id);
  });

  it("holds every time it is repeated, on a fresh slot each time", async () => {
    const other = await createPatient();
    // Eight different slots, so neither patient's booking limit is what stops them.
    await db.clinic.update({ where: { id: w.clinic.id }, data: { maxUpcomingPerPatient: 50 } });
    for (let i = 0; i < 8; i += 1) {
      const start = new Date(at("2026-10-15", "09:00").getTime() + i * 30 * 60_000);
      const statuses = (
        await Promise.all([
          book(w.patientUser.id, bookingBody(w.doctor.id, start)),
          book(other.user.id, bookingBody(w.doctor.id, start)),
        ])
      ).map((r) => r.status);
      expect(statuses.sort(), `round ${i}`).toEqual([201, 409]);
      expect(await activeAt(w.doctor.id, start), `round ${i}`).toBe(1);
    }
    expect(await db.appointment.count()).toBe(8);
  });

  it("ten patients at once: one success, nine SLOT_TAKEN, one row", async () => {
    const patients = [w.patientUser.id];
    for (let i = 0; i < 9; i += 1) patients.push((await createPatient()).user.id);

    const results = await Promise.all(patients.map((userId) => book(userId, bookingBody(w.doctor.id, S0900))));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = results.filter((r) => r.status !== 201);
    expect(losers).toHaveLength(9);
    for (const loser of losers) {
      expect(loser.status).toBe(409);
      expect(loser.json.error.code).toBe("SLOT_TAKEN");
      expect(loser.json.error.nextSlots).toHaveLength(3);
    }
    expect(await db.appointment.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "appointment.booked" } })).toBe(1);
  });

  it("a different doctor's slot at the same time is not a conflict", async () => {
    const { doctor: colleague } = await createDoctor(w.clinic.id);
    const other = await createPatient();
    const results = await Promise.all([
      book(w.patientUser.id, bookingBody(w.doctor.id, S0900)),
      book(other.user.id, bookingBody(colleague.id, S0900)),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
  });
});

describe("one patient, two submissions at the same moment", () => {
  it("a double click with the same Idempotency-Key gives one appointment and no error (R27)", async () => {
    const headers = { "idempotency-key": "double-click-race-01" };
    const results = await Promise.all([
      book(w.patientUser.id, bookingBody(w.doctor.id, S0900), headers),
      book(w.patientUser.id, bookingBody(w.doctor.id, S0900), headers),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results[0].json.appointment.id).toBe(results[1].json.appointment.id);
    expect(await db.appointment.count()).toBe(1);
  });

  it("two different slots at one below the limit: one succeeds, the other is BOOKING_LIMIT_REACHED (R25)", async () => {
    const strict = await createClinic({ maxUpcomingPerPatient: 2 });
    const { doctor } = await createDoctor(strict.id);
    expect((await book(w.patientUser.id, bookingBody(doctor.id, S0900))).status).toBe(201);

    const results = await Promise.all([
      book(w.patientUser.id, bookingBody(doctor.id, S1000)),
      book(w.patientUser.id, bookingBody(doctor.id, S1030)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect(refused.json.error).toMatchObject({ code: "BOOKING_LIMIT_REACHED", limit: 2 });
    expect(await db.appointment.count({ where: { clinicId: strict.id } })).toBe(2);
  });
});
