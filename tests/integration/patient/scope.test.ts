// Record scope for patients (R7, R8): another patient's appointment gets the same answer as
// one that does not exist, whatever the action, and nothing about it changes or leaks.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createPatient, createWorld } from "../../helpers/factories";
import { REASON, book, bookingBody, cancel, myAppointments, read, reschedule, shape } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
let stranger: Awaited<ReturnType<typeof createPatient>>;
/** The appointment of w.patient. The stranger must never reach it. */
let id: string;
const MISSING = "7f0c1f0e-3d0a-4b53-9d2e-0a1b2c3d4e5f";
const S0900 = at("2026-10-14", "09:00");
const S1000 = at("2026-10-14", "10:00");

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  stranger = await createPatient();
  freezeClock(NOW);
  id = (await book(w.patientUser.id, bookingBody(w.doctor.id, S0900))).json.appointment.id;
});

afterEach(() => {
  restoreClock();
});

describe("another patient's appointment is the same as a missing one (R8)", () => {
  it("to read", async () => {
    const theirs = await read(stranger.user.id, id);
    const missing = await read(stranger.user.id, MISSING);
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(shape(theirs.json)).toEqual(shape(missing.json));
  });

  it("to reschedule, and it is not moved", async () => {
    const before = await db.appointment.findUniqueOrThrow({ where: { id } });
    const theirs = await reschedule(stranger.user.id, id, { startsAt: S1000.toISOString() });
    const missing = await reschedule(stranger.user.id, MISSING, { startsAt: S1000.toISOString() });
    expect(theirs.status).toBe(404);
    expect(shape(theirs.json)).toEqual(shape(missing.json));
    expect(await db.appointment.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await db.appointmentHistory.count({ where: { action: "rescheduled" } })).toBe(0);
  });

  it("to cancel, and it is not cancelled", async () => {
    const theirs = await cancel(stranger.user.id, id);
    const missing = await cancel(stranger.user.id, MISSING);
    expect(theirs.status).toBe(404);
    expect(shape(theirs.json)).toEqual(shape(missing.json));
    expect((await db.appointment.findUniqueOrThrow({ where: { id } })).status).toBe("requested");
    expect(await db.auditEvent.count({ where: { action: { startsWith: "appointment.cancelled" } } })).toBe(0);
    expect(await db.notificationEvent.count({ where: { type: "cancelled" } })).toBe(0);
  });

  it("a malformed id is not found either", async () => {
    for (const result of [
      await read(stranger.user.id, "1"),
      await cancel(stranger.user.id, "1"),
      await reschedule(stranger.user.id, "1", { startsAt: S1000.toISOString() }),
    ]) {
      expect(result.status).toBe(404);
    }
  });

  it("no refusal says anything about the appointment or its patient, in the response or the log", async () => {
    const { result, raw } = await captureLogs(async () => [
      await read(stranger.user.id, id),
      await cancel(stranger.user.id, id),
      await reschedule(stranger.user.id, id, { startsAt: S1000.toISOString() }),
      await myAppointments(stranger.user.id),
      await myAppointments(stranger.user.id, { scope: "past" }),
    ]);
    const text = JSON.stringify(result.map((r) => r.json)) + raw;
    for (const hidden of [w.patient.fullName, w.patientUser.email, w.patient.id, REASON, "555-0100", "1990-05-17"]) {
      expect(text).not.toContain(hidden);
    }
  });
});

describe("a patient acts only as themself (R7)", () => {
  it("the owner can still read, move and cancel it", async () => {
    expect((await read(w.patientUser.id, id)).status).toBe(200);
    expect((await reschedule(w.patientUser.id, id, { startsAt: S1000.toISOString() })).status).toBe(200);
    expect((await cancel(w.patientUser.id, id)).status).toBe(200);
  });

  it("a deactivated patient account has no session", async () => {
    await db.user.update({ where: { id: w.patientUser.id }, data: { active: false } });
    expect((await read(w.patientUser.id, id)).status).toBe(401);
    expect((await myAppointments(w.patientUser.id)).status).toBe(401);
    expect((await cancel(w.patientUser.id, id)).status).toBe(401);
  });

  it("booking the slot another patient holds reveals nothing about them", async () => {
    const result = await book(stranger.user.id, bookingBody(w.doctor.id, S0900));
    expect(result.status).toBe(409);
    const text = JSON.stringify(result.json);
    for (const hidden of [w.patient.fullName, w.patient.id, id, REASON]) expect(text).not.toContain(hidden);
  });
});
