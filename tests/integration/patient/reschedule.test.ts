// Rescheduling as a patient (R31 to R34, R36, R37). The move is one transaction: the old slot
// is released only if the new one is taken, and a lost race leaves the appointment untouched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeAppointmentStatus } from "@/lib/appointments/core";
import { db } from "@/lib/db";
import { NOW, at, freezeClock, hoursBefore, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createDoctor, createPatient, createWorld } from "../../helpers/factories";
import { REASON, book, bookingBody, openStarts, reschedule } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
let id: string;
const S0900 = at("2026-10-14", "09:00");
const S1000 = at("2026-10-14", "10:00");
const S1030 = at("2026-10-14", "10:30");
const S1100 = at("2026-10-14", "11:00");
const S1130 = at("2026-10-14", "11:30");
const S1200 = at("2026-10-14", "12:00");

const to = (start: Date) => ({ startsAt: start.toISOString() });
const row = () => db.appointment.findUniqueOrThrow({ where: { id } });
const moves = () => db.appointmentHistory.count({ where: { appointmentId: id, action: "rescheduled" } });
const activeAt = (start: Date) =>
  db.appointment.count({ where: { doctorId: w.doctor.id, startsAt: start, status: { in: ["requested", "confirmed"] } } });

/** Nothing about the appointment changed, and the refused move left no trace. */
async function expectUntouched(before: Awaited<ReturnType<typeof row>>) {
  expect(await row()).toEqual(before);
  expect(await moves()).toBe(0);
  expect(await db.auditEvent.count({ where: { action: "appointment.rescheduled" } })).toBe(0);
  expect(await db.notificationEvent.count({ where: { type: "rescheduled" } })).toBe(0);
}

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
  id = (await book(w.patientUser.id, bookingBody(w.doctor.id, S0900))).json.appointment.id;
});

afterEach(() => {
  restoreClock();
});

describe("a patient moves their own upcoming appointment (R32)", () => {
  it("to another open slot with the same doctor: the new slot is taken and the old one is open again (R31)", async () => {
    const result = await reschedule(w.patientUser.id, id, to(S1000));
    expect(result.status).toBe(200);
    expect(result.json.appointment).toMatchObject({
      id,
      startsAt: S1000.toISOString(),
      endsAt: S1030.toISOString(),
      status: "requested",
      doctorId: w.doctor.id,
    });

    // It is the same appointment, moved. No second row.
    expect(await db.appointment.count()).toBe(1);
    const other = await createPatient();
    const open = await openStarts(other.user.id, w.doctor.id);
    expect(open).toContain(S0900.toISOString());
    expect(open).not.toContain(S1000.toISOString());
    expect((await book(other.user.id, bookingBody(w.doctor.id, S0900))).status).toBe(201);
  });

  it("keeps the reason for visit and the booking origin, and adds the move to the history (R37)", async () => {
    const before = await row();
    freezeClock(new Date(NOW.getTime() + 3_600_000));
    await reschedule(w.patientUser.id, id, to(S1000));

    const after = await row();
    expect(after).toMatchObject({
      reasonForVisit: REASON,
      bookedById: before.bookedById,
      bookedByRole: "patient",
      bookedAt: before.bookedAt,
      patientId: before.patientId,
      doctorId: before.doctorId,
      clinicId: before.clinicId,
    });
    const history = await db.appointmentHistory.findMany({ where: { appointmentId: id }, orderBy: { at: "asc" } });
    expect(history.map((h) => h.action)).toEqual(["booked", "rescheduled"]);
    expect(history[1]).toMatchObject({
      actorId: w.patientUser.id,
      actorRole: "patient",
      oldStartsAt: S0900,
      newStartsAt: S1000,
    });
    const audit = await db.auditEvent.findMany({ where: { action: "appointment.rescheduled" } });
    expect(audit).toMatchObject([{ actorId: w.patientUser.id, actorRole: "patient", entityId: id, clinicId: w.clinic.id }]);
    expect(await db.notificationEvent.count({ where: { type: "rescheduled", appointmentId: id } })).toBe(1);
  });

  it("returns a confirmed appointment to requested, so the clinic confirms the new time (R36)", async () => {
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: id, to: "confirmed" }, NOW);
    expect((await row()).status).toBe("confirmed");

    const result = await reschedule(w.patientUser.id, id, to(S1000));
    expect(result.status).toBe(200);
    expect(result.json.appointment.status).toBe("requested");
    expect((await row()).status).toBe("requested");
  });

  it("only with the same doctor: there is no way to name another one", async () => {
    const { doctor: colleague } = await createDoctor(w.clinic.id);
    const result = await reschedule(w.patientUser.id, id, { ...to(S1000), doctorId: colleague.id });
    expect(result.status).toBe(422);
    expect((await row()).doctorId).toBe(w.doctor.id);
  });
});

describe("one atomic operation (R33)", () => {
  it("if the new slot is already taken the appointment is unchanged, and the next open slots are offered", async () => {
    const other = await createPatient();
    await book(other.user.id, bookingBody(w.doctor.id, S1000));
    const before = await row();

    const result = await reschedule(w.patientUser.id, id, to(S1000));
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_TAKEN");
    expect(result.json.error.nextSlots?.map((slot) => slot.startsAt)).toEqual(
      [S1030, S1100, S1130].map((slot) => slot.toISOString()),
    );
    await expectUntouched(before);
    // The old slot was not released.
    expect(await activeAt(S0900)).toBe(1);
    expect(await openStarts(other.user.id, w.doctor.id)).not.toContain(S0900.toISOString());
  });

  it("a move and a booking that reach the same slot together: one wins, and a lost move changes nothing", async () => {
    const other = await createPatient();
    await db.clinic.update({ where: { id: w.clinic.id }, data: { maxUpcomingPerPatient: 50 } });

    let movesWon = 0;
    for (let i = 0; i < 6; i += 1) {
      const target = new Date(at("2026-10-15", "09:00").getTime() + i * 30 * 60_000);
      const before = await row();

      const [move, booking] = await Promise.all([
        reschedule(w.patientUser.id, id, to(target)),
        book(other.user.id, bookingBody(w.doctor.id, target)),
      ]);

      expect([move.status, booking.status].sort(), `round ${i}`).toEqual([move.status === 200 ? 200 : 201, 409]);
      expect(await activeAt(target), `round ${i}`).toBe(1);
      const after = await row();
      if (move.status === 200) {
        movesWon += 1;
        expect(after.startsAt).toEqual(target);
        expect(booking.json.error.code).toBe("SLOT_TAKEN");
        // The slot it left is free.
        expect(await activeAt(before.startsAt)).toBe(0);
      } else {
        expect(move.json.error.code).toBe("SLOT_TAKEN");
        expect(after).toEqual(before);
        // It still holds the slot it had.
        expect(await activeAt(before.startsAt)).toBe(1);
      }
    }
    // Every successful move has exactly one history row, audit event and notification.
    expect(await moves()).toBe(movesWon);
    expect(await db.auditEvent.count({ where: { action: "appointment.rescheduled" } })).toBe(movesWon);
    expect(await db.notificationEvent.count({ where: { type: "rescheduled" } })).toBe(movesWon);
    // The patient still has exactly one appointment.
    expect(await db.appointment.count({ where: { patientId: w.patient.id } })).toBe(1);
  });

  it("two patients swapping into each other's slots at once never end up double booked", async () => {
    const other = await createPatient();
    const otherId = (await book(other.user.id, bookingBody(w.doctor.id, S1000))).json.appointment.id;

    const results = await Promise.all([
      reschedule(w.patientUser.id, id, to(S1000)),
      reschedule(other.user.id, otherId, to(S0900)),
    ]);
    // Each wanted a slot the other held, so neither can be given it.
    for (const result of results) {
      expect(result.status).toBe(409);
      expect(result.json.error.code).toBe("SLOT_TAKEN");
    }
    expect((await row()).startsAt).toEqual(S0900);
    expect((await db.appointment.findUniqueOrThrow({ where: { id: otherId } })).startsAt).toEqual(S1000);
    expect(await activeAt(S0900)).toBe(1);
    expect(await activeAt(S1000)).toBe(1);
  });
});

describe("when a patient cannot reschedule", () => {
  it("inside the cancellation window: refused with what to do instead, and nothing changes (R34)", async () => {
    const before = await row();
    freezeClock(hoursBefore(S0900, 23));
    const result = await reschedule(w.patientUser.id, id, to(S1200));
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("RESCHEDULE_WINDOW_CLOSED");
    expect(result.json.error.message).toMatch(/cancel it, or call the clinic/);
    await expectUntouched(before);
  });

  it("the window is the clinic's own, and exactly at its opening the move is already refused", async () => {
    await db.clinic.update({ where: { id: w.clinic.id }, data: { cancellationWindowHours: 48 } });
    freezeClock(hoursBefore(S0900, 48));
    expect((await reschedule(w.patientUser.id, id, to(S1200))).json.error.code).toBe("RESCHEDULE_WINDOW_CLOSED");
    freezeClock(new Date(hoursBefore(S0900, 48).getTime() - 1000));
    expect((await reschedule(w.patientUser.id, id, to(S1200))).status).toBe(200);
  });

  it("to a time that is not bookable, or to the time it already has", async () => {
    const before = await row();
    for (const start of [at("2026-10-14", "08:00"), at("2026-10-14", "09:10"), at("2026-10-11", "09:00"), S0900]) {
      const result = await reschedule(w.patientUser.id, id, to(start));
      expect(result.status).toBe(409);
      expect(result.json.error.code).toBe("SLOT_UNAVAILABLE");
    }
    await expectUntouched(before);
  });

  it("an appointment that is cancelled or has started", async () => {
    const second = (await book(w.patientUser.id, bookingBody(w.doctor.id, S1100))).json.appointment.id;
    await changeAppointmentStatus({ actor: w.patientSession, appointmentId: second, to: "cancelled" }, NOW);
    const cancelled = await reschedule(w.patientUser.id, second, to(S1200));
    expect(cancelled.status).toBe(409);
    expect(cancelled.json.error.code).toBe("INVALID_TRANSITION");

    freezeClock(at("2026-10-14", "09:05"));
    const started = await reschedule(w.patientUser.id, id, to(S1200));
    expect(started.json.error.code).toBe("INVALID_TRANSITION");
    expect((await row()).startsAt).toEqual(S0900);
  });

  it("without a session, or with a start that is not an instant", async () => {
    expect((await reschedule(undefined, id, to(S1000))).status).toBe(401);
    const bad = await reschedule(w.patientUser.id, id, { startsAt: "tomorrow at ten" });
    expect(bad.status).toBe(422);
    expect(bad.json.error.fields).toEqual([{ field: "startsAt", problem: "invalid" }]);
    expect((await row()).startsAt).toEqual(S0900);
  });
});
