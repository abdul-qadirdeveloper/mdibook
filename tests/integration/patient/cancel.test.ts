// Cancelling as a patient (R31, R38 to R40, R44). Before the window opens the cancellation is
// not flagged. Inside it the cancellation still succeeds and is recorded as a late cancel.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeAppointmentStatus } from "@/lib/appointments/core";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, hoursBefore, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createPatient, createWorld } from "../../helpers/factories";
import { book, bookingBody, cancel, openStarts, read } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
let id: string;
// Friday 16 October 2026, 09:00 in Chicago: four days after NOW.
const START = at("2026-10-16", "09:00");

const row = () => db.appointment.findUniqueOrThrow({ where: { id } });
/** Audit events for a cancellation, late or not. The action says which. */
const cancelAudits = () =>
  db.auditEvent.findMany({
    where: { action: { in: ["appointment.cancelled", "appointment.cancelled_late"] } },
    orderBy: { at: "asc" },
  });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
  id = (await book(w.patientUser.id, bookingBody(w.doctor.id, START))).json.appointment.id;
});

afterEach(() => {
  restoreClock();
});

describe("before the cancellation window opens (R38)", () => {
  it("the appointment is cancelled, not flagged, and records that the patient cancelled (R44)", async () => {
    freezeClock(hoursBefore(START, 25));
    const result = await cancel(w.patientUser.id, id);
    expect(result.status).toBe(200);
    expect(result.json.recordedAsLate).toBe(false);
    expect(result.json.appointment).toMatchObject({ id, status: "cancelled", cancelledBy: "patient" });

    expect(await row()).toMatchObject({
      status: "cancelled",
      lateCancel: false,
      cancelledByRole: "patient",
      cancelReasonCode: null,
    });
    // Audited as an ordinary cancellation, not a late one.
    expect((await cancelAudits()).map((event) => event.action)).toEqual(["appointment.cancelled"]);
  });

  it("works with no body at all, and frees the slot for someone else (R31)", async () => {
    const other = await createPatient();
    expect(await openStarts(other.user.id, w.doctor.id)).not.toContain(START.toISOString());
    expect((await cancel(w.patientUser.id, id)).status).toBe(200);
    expect(await openStarts(other.user.id, w.doctor.id)).toContain(START.toISOString());
    expect((await book(other.user.id, bookingBody(w.doctor.id, START))).status).toBe(201);
  });

  it("no longer counts toward the booking limit", async () => {
    await db.clinic.update({ where: { id: w.clinic.id }, data: { maxUpcomingPerPatient: 1 } });
    const blocked = await book(w.patientUser.id, bookingBody(w.doctor.id, at("2026-10-16", "10:00")));
    expect(blocked.json.error.code).toBe("BOOKING_LIMIT_REACHED");
    await cancel(w.patientUser.id, id);
    expect((await book(w.patientUser.id, bookingBody(w.doctor.id, at("2026-10-16", "10:00")))).status).toBe(201);
  });
});

describe("inside the cancellation window (R39)", () => {
  it("23 hours before the start: it succeeds, is recorded as a late cancel, and is audited", async () => {
    freezeClock(hoursBefore(START, 23));
    const result = await cancel(w.patientUser.id, id);

    // Allowed, not blocked.
    expect(result.status).toBe(200);
    expect(result.json.appointment).toMatchObject({ id, status: "cancelled", cancelledBy: "patient" });
    // The patient is told it was recorded as late.
    expect(result.json.recordedAsLate).toBe(true);

    // late_cancel is true on the appointment.
    expect(await row()).toMatchObject({ status: "cancelled", lateCancel: true, cancelledByRole: "patient" });
    const flags = await db.$queryRaw<{ lateCancel: boolean }[]>`
      SELECT "lateCancel" FROM "Appointment" WHERE "id" = ${id}::uuid`;
    expect(flags).toEqual([{ lateCancel: true }]);

    // One audit event for it, and the audit event itself says it was late: who, which role,
    // what, on which appointment, at which clinic, when.
    const audit = await cancelAudits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: w.patientUser.id,
      actorRole: "patient",
      action: "appointment.cancelled_late",
      entityType: "appointment",
      entityId: id,
      clinicId: w.clinic.id,
    });
    expect(audit[0].at).toBeInstanceOf(Date);
    // The audit event points at exactly the appointment whose late flag is set.
    expect((await db.appointment.findUniqueOrThrow({ where: { id: audit[0].entityId } })).lateCancel).toBe(true);

    // History and notification are written with it.
    const history = await db.appointmentHistory.findMany({ where: { appointmentId: id, action: "cancelled" } });
    expect(history).toMatchObject([{ actorId: w.patientUser.id, actorRole: "patient", reasonCode: null }]);
    expect(await db.notificationEvent.count({ where: { type: "cancelled", appointmentId: id } })).toBe(1);
  });

  it("the flag is visible to staff only: not to the patient, not to the doctor", async () => {
    freezeClock(hoursBefore(START, 2));
    const result = await cancel(w.patientUser.id, id);
    expect(result.json.appointment).not.toHaveProperty("lateCancel");
    expect((await read(w.patientUser.id, id)).json.appointment).not.toHaveProperty("lateCancel");
    expect((await read(w.doctorUser.id, id)).json.appointment).not.toHaveProperty("lateCancel");
    expect((await read(w.staffUser.id, id)).json.appointment).toMatchObject({ lateCancel: true, cancelledByRole: "patient" });
  });

  it("exactly when the window opens it is late; one second earlier it is not (R40)", async () => {
    freezeClock(hoursBefore(START, 24));
    expect((await cancel(w.patientUser.id, id)).json.recordedAsLate).toBe(true);

    const second = (await book(w.patientUser.id, bookingBody(w.doctor.id, at("2026-10-16", "10:00")))).json.appointment.id;
    freezeClock(new Date(hoursBefore(at("2026-10-16", "10:00"), 24).getTime() - 1000));
    expect((await cancel(w.patientUser.id, second)).json.recordedAsLate).toBe(false);

    expect((await cancelAudits()).map((event) => [event.entityId, event.action])).toEqual([
      [id, "appointment.cancelled_late"],
      [second, "appointment.cancelled"],
    ]);
  });

  it("a cancellation by staff inside the window is never audited as late (R42)", async () => {
    freezeClock(hoursBefore(START, 2));
    await changeAppointmentStatus(
      { actor: w.staffSession, appointmentId: id, to: "cancelled", reasonCode: "patient_request" },
      hoursBefore(START, 2),
    );
    expect((await row()).lateCancel).toBe(false);
    expect((await cancelAudits()).map((event) => event.action)).toEqual(["appointment.cancelled"]);
  });

  it("the window is the clinic's own number of hours, measured as elapsed time", async () => {
    await db.clinic.update({ where: { id: w.clinic.id }, data: { cancellationWindowHours: 72 } });
    freezeClock(hoursBefore(START, 60));
    const result = await cancel(w.patientUser.id, id);
    expect(result.status).toBe(200);
    expect(result.json.recordedAsLate).toBe(true);
    expect((await row()).lateCancel).toBe(true);
  });

  it("a late cancel still frees the slot, up to the last minute before the start", async () => {
    freezeClock(new Date(START.getTime() - 60_000));
    const result = await cancel(w.patientUser.id, id);
    expect(result.status).toBe(200);
    expect(result.json.recordedAsLate).toBe(true);
    expect(await db.appointment.count({ where: { doctorId: w.doctor.id, startsAt: START, status: "requested" } })).toBe(0);
  });
});

describe("what a patient cannot do", () => {
  it("send a reason: there is no free-text or coded reason from a patient", async () => {
    const result = await cancel(w.patientUser.id, id, { reasonCode: "other" });
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([{ field: "reasonCode", problem: "not_allowed" }]);
    const text = await cancel(w.patientUser.id, id, { reason: "Fictional free text" });
    expect(text.status).toBe(422);
    expect(JSON.stringify(text.json)).not.toContain("Fictional free text");
    expect((await row()).status).toBe("requested");
  });

  it("cancel twice: the second is refused and changes nothing", async () => {
    await cancel(w.patientUser.id, id);
    const before = await row();
    const again = await cancel(w.patientUser.id, id);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("INVALID_TRANSITION");
    expect(await row()).toEqual(before);
    expect(await cancelAudits()).toHaveLength(1);
    expect(await db.notificationEvent.count({ where: { type: "cancelled" } })).toBe(1);
  });

  it("two cancellations at the same moment: one succeeds", async () => {
    const results = await Promise.all([cancel(w.patientUser.id, id), cancel(w.patientUser.id, id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await cancelAudits()).toHaveLength(1);
  });

  it("cancel once the appointment has started", async () => {
    freezeClock(START);
    const result = await cancel(w.patientUser.id, id);
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("INVALID_TRANSITION");
    expect((await row()).status).toBe("requested");
    expect(await cancelAudits()).toHaveLength(0);
  });

  it("cancel without a session", async () => {
    expect((await cancel(undefined, id)).status).toBe(401);
    expect((await row()).status).toBe("requested");
  });
});

describe("privacy", () => {
  it("the log line for a cancellation has ids and event codes only", async () => {
    freezeClock(hoursBefore(START, 3));
    const { raw, lines } = await captureLogs(() => cancel(w.patientUser.id, id));
    expect(lines.map((line) => line.event)).toContain("request.completed");
    expect(raw).not.toContain(w.patient.fullName);
    expect(raw).not.toMatch(/Fictional reason|555-0100|1990-05-17|@example\.test/);
  });
});
