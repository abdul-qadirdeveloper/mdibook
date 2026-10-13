// Rescheduling as staff or as the appointment's doctor (R35, R36): allowed inside the
// cancellation window, up to the start, and the status stays as it was.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as rescheduleRoute } from "@/app/api/v1/appointments/[id]/reschedule/route";
import { db } from "@/lib/db";
import { NOW, at, freezeClock, hoursBefore, minutesAfter, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createPatient, createWorld, sessionFor } from "../../helpers/factories";
import { type Appointment, DAY, type ErrorJson, S0900, S0930, S1000, type World, book, counts, row, send } from "./support";

let w: World;

const move = (userId: string, id: string, to: Date | string) =>
  send<{ appointment: Appointment } & ErrorJson>(rescheduleRoute, "POST", userId, {
    params: { id },
    body: { startsAt: typeof to === "string" ? to : to.toISOString() },
  });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("moving an appointment (R35)", () => {
  it("staff and the doctor can move it inside the cancellation window, up to the start", async () => {
    const one = await book(w, S0900);
    const two = await book(w, S0930);
    // Two hours before: a patient could no longer move it.
    freezeClock(hoursBefore(S0900, 2));

    const byStaff = await move(w.staffUser.id, one, S1000);
    expect(byStaff.status).toBe(200);
    expect(byStaff.json.appointment).toMatchObject({ id: one, startsAt: S1000.toISOString(), endsAt: at(DAY, "10:30").toISOString() });

    const byDoctor = await move(w.doctorUser.id, two, at(DAY, "11:00"));
    expect(byDoctor.status).toBe(200);
    expect((await row(two)).startsAt).toEqual(at(DAY, "11:00"));
  });

  it("keeps the status: confirmed stays confirmed, requested stays requested (R36)", async () => {
    const confirmed = await book(w, S0900, { by: w.staffSession });
    const requested = await book(w, S0930);

    await move(w.staffUser.id, confirmed, S1000);
    await move(w.doctorUser.id, requested, at(DAY, "10:30"));

    expect((await row(confirmed)).status).toBe("confirmed");
    expect((await row(requested)).status).toBe("requested");
  });

  it("keeps the same appointment, its origin and its visit reason, and adds the move to its history (R37)", async () => {
    const id = await book(w, S0900);
    const original = await row(id);
    const before = await counts();

    await move(w.staffUser.id, id, S1000);

    const moved = await row(id);
    expect(moved).toMatchObject({
      reasonForVisit: original.reasonForVisit,
      bookedById: original.bookedById,
      bookedByRole: "patient",
      bookedAt: original.bookedAt,
    });
    expect(await counts()).toEqual({ ...before, history: before.history + 1, audit: before.audit + 1, notifications: before.notifications + 1 });
    expect(await db.appointmentHistory.findFirst({ where: { appointmentId: id, action: "rescheduled" } })).toMatchObject({
      actorId: w.staffUser.id,
      actorRole: "staff",
      oldStartsAt: S0900,
      newStartsAt: S1000,
    });
  });

  it("onto a taken slot: 409 SLOT_TAKEN with the next open slots, and the appointment is unchanged", async () => {
    const { user, patient } = await createPatient();
    const id = await book(w, S0900);
    await book(w, S1000, { by: await sessionFor(user.id), patientId: patient.id });
    const before = await counts();

    const result = await move(w.staffUser.id, id, S1000);
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_TAKEN");
    expect(result.json.error.nextSlots).toHaveLength(3);
    expect((await row(id)).startsAt).toEqual(S0900);
    expect(await counts()).toEqual(before);
  });

  it("refuses a slot outside the schedule, and an appointment that has started or is cancelled", async () => {
    const id = await book(w, S0900);
    const outside = await move(w.doctorUser.id, id, at(DAY, "18:00"));
    expect(outside.status).toBe(409);
    expect(outside.json.error.code).toBe("SLOT_UNAVAILABLE");

    const notAnInstant = await move(w.doctorUser.id, id, "tomorrow at ten");
    expect(notAnInstant.status).toBe(422);
    expect(notAnInstant.json.error.fields).toEqual([{ field: "startsAt", problem: "invalid" }]);

    freezeClock(minutesAfter(S0900, 1));
    const started = await move(w.staffUser.id, id, at("2026-10-15", "09:00"));
    expect(started.status).toBe(409);
    expect(started.json.error.code).toBe("INVALID_TRANSITION");
    expect((await row(id)).startsAt).toEqual(S0900);
  });
});
