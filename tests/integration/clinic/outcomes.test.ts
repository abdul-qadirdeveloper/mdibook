// Confirm, complete and no-show (R62 to R65), by staff and by the appointment's doctor. Every
// change goes through the transition table; a refused one changes nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as completeRoute } from "@/app/api/v1/appointments/[id]/complete/route";
import { POST as confirmRoute } from "@/app/api/v1/appointments/[id]/confirm/route";
import { POST as noShowRoute } from "@/app/api/v1/appointments/[id]/no-show/route";
import { visibleAppointmentFields } from "@/domain/visibility";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, minutesAfter, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createWorld } from "../../helpers/factories";
import { type Appointment, type ErrorJson, type Handler, S0900, S0930, S1000, type World, book, counts, row, send } from "./support";

let w: World;

const act = (handler: Handler, userId: string, id: string) =>
  send<{ appointment: Appointment } & ErrorJson>(handler, "POST", userId, { params: { id } });
const AFTER_START = minutesAfter(S0900, 1);

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("confirm (R62)", () => {
  it("staff and the appointment's doctor can confirm a requested appointment", async () => {
    const byStaff = await book(w, S0900);
    const byDoctor = await book(w, S0930);

    const staff = await act(confirmRoute, w.staffUser.id, byStaff);
    expect(staff.status).toBe(200);
    expect(staff.json.appointment.status).toBe("confirmed");
    expect(Object.keys(staff.json.appointment).sort()).toEqual([...visibleAppointmentFields("staff")].sort());

    const doctor = await act(confirmRoute, w.doctorUser.id, byDoctor);
    expect(doctor.status).toBe(200);
    expect(doctor.json.appointment.status).toBe("confirmed");
    expect(Object.keys(doctor.json.appointment).sort()).toEqual([...visibleAppointmentFields("doctor")].sort());

    expect((await row(byStaff)).status).toBe("confirmed");
    expect(await db.appointmentHistory.findFirst({ where: { appointmentId: byDoctor, action: "confirmed" } })).toMatchObject({
      actorId: w.doctorUser.id,
      actorRole: "doctor",
    });
  });

  it("writes one history row, one audit event and one notification event, and logs ids only", async () => {
    const id = await book(w, S0900);
    const before = await counts();
    const { raw, lines } = await captureLogs(() => act(confirmRoute, w.staffUser.id, id));

    expect(await counts()).toEqual({ ...before, history: before.history + 1, audit: before.audit + 1, notifications: before.notifications + 1 });
    expect(await db.auditEvent.findFirst({ where: { entityId: id, action: "appointment.confirmed" } })).toMatchObject({
      actorId: w.staffUser.id,
      actorRole: "staff",
      entityType: "appointment",
      clinicId: w.clinic.id,
    });
    expect(lines.map((l) => l.event)).toContain("notification.confirmed");
    expect(raw).not.toMatch(/Pat Example|555-0100|example\.test|Fictional reason|1990/);
  });

  it("confirming twice, or confirming after the start, is INVALID_TRANSITION and changes nothing (R64)", async () => {
    const id = await book(w, S0900);
    await act(confirmRoute, w.staffUser.id, id);
    const before = await counts();

    const twice = await act(confirmRoute, w.doctorUser.id, id);
    expect(twice.status).toBe(409);
    expect(twice.json.error.code).toBe("INVALID_TRANSITION");

    const lateOne = await book(w, S1000);
    const afterBooking = await counts();
    freezeClock(minutesAfter(S1000, 1));
    const tooLate = await act(confirmRoute, w.staffUser.id, lateOne);
    expect(tooLate.status).toBe(409);
    expect(tooLate.json.error.code).toBe("INVALID_TRANSITION");

    expect(afterBooking.history).toBe(before.history + 1);
    expect(await counts()).toEqual(afterBooking);
    expect((await row(lateOne)).status).toBe("requested");
  });
});

describe("completed and no-show (R62, R63)", () => {
  it("are refused before the start with TOO_EARLY, and change nothing", async () => {
    const id = await book(w, S0900);
    const before = await counts();
    for (const handler of [completeRoute, noShowRoute]) {
      for (const userId of [w.staffUser.id, w.doctorUser.id]) {
        const result = await act(handler, userId, id);
        expect(result.status).toBe(409);
        expect(result.json.error.code).toBe("TOO_EARLY");
      }
    }
    expect(await counts()).toEqual(before);
    expect((await row(id)).status).toBe("requested");
  });

  it("after the start, staff or the doctor record them, straight from requested too", async () => {
    const attended = await book(w, S0900);
    const missed = await book(w, at("2026-10-14", "09:30"), { by: w.staffSession });
    freezeClock(minutesAfter(S0930, 1));

    const completed = await act(completeRoute, w.doctorUser.id, attended);
    expect(completed.status).toBe(200);
    expect(completed.json.appointment.status).toBe("completed");

    const noShow = await act(noShowRoute, w.staffUser.id, missed);
    expect(noShow.status).toBe(200);
    expect(noShow.json.appointment.status).toBe("no_show");

    expect((await row(attended)).status).toBe("completed");
    expect((await row(missed)).status).toBe("no_show");
    expect(await db.notificationEvent.count({ where: { appointmentId: attended, type: "completed" } })).toBe(1);
    expect(await db.notificationEvent.count({ where: { appointmentId: missed, type: "no_show" } })).toBe(1);
  });

  it("are final: no further change is accepted (R64)", async () => {
    const id = await book(w, S0900);
    freezeClock(AFTER_START);
    await act(noShowRoute, w.staffUser.id, id);
    const before = await counts();

    for (const handler of [completeRoute, confirmRoute, noShowRoute]) {
      const result = await act(handler, w.staffUser.id, id);
      expect(result.status).toBe(409);
      expect(result.json.error.code).toBe("INVALID_TRANSITION");
    }
    expect(await counts()).toEqual(before);
    expect((await row(id)).status).toBe("no_show");
  });

  it("a cancelled appointment cannot be completed or marked as a no-show", async () => {
    const { changeAppointmentStatus } = await import("@/lib/appointments/core");
    const id = await book(w, S0900);
    await changeAppointmentStatus({ actor: w.patientSession, appointmentId: id, to: "cancelled" }, NOW);
    freezeClock(AFTER_START);
    for (const handler of [completeRoute, noShowRoute]) {
      const result = await act(handler, w.doctorUser.id, id);
      expect(result.json.error.code).toBe("INVALID_TRANSITION");
    }
    expect((await row(id)).status).toBe("cancelled");
  });
});

describe("a no-show is recorded only (R65)", () => {
  it("changes nothing else: no penalty, no block, and the patient can book again", async () => {
    const id = await book(w, S0900);
    freezeClock(AFTER_START);
    const before = await counts();
    const patientBefore = await db.user.findUniqueOrThrow({ where: { id: w.patientUser.id } });
    const clinicBefore = await db.clinic.findUniqueOrThrow({ where: { id: w.clinic.id } });

    await act(noShowRoute, w.staffUser.id, id);

    expect(await counts()).toEqual({ ...before, active: before.active - 1, history: before.history + 1, audit: before.audit + 1, notifications: before.notifications + 1 });
    expect(await row(id)).toMatchObject({ status: "no_show", lateCancel: false, cancelledByRole: null, cancelReasonCode: null });
    expect(await db.user.findUniqueOrThrow({ where: { id: w.patientUser.id } })).toEqual(patientBefore);
    expect(await db.clinic.findUniqueOrThrow({ where: { id: w.clinic.id } })).toEqual(clinicBefore);

    const again = await book(w, S1000, { now: AFTER_START });
    expect((await row(again)).status).toBe("requested");
  });
});
