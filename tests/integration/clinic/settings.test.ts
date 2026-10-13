// Clinic settings (R25, R40): any staff member of the clinic changes the booking limit and
// the cancellation window, and both take effect.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as bookRoute } from "@/app/api/v1/appointments/route";
import { GET as readRoute } from "@/app/api/v1/appointments/[id]/route";
import { GET as settingsRoute, PATCH as settingsPatchRoute } from "@/app/api/v1/clinic/settings/route";
import { changeAppointmentStatus } from "@/lib/appointments/core";
import { db } from "@/lib/db";
import { NOW, freezeClock, hoursBefore, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createStaff, createWorld } from "../../helpers/factories";
import { type Appointment, type ErrorJson, S0900, S0930, S1000, type World, book, otherClinic, row, send } from "./support";

interface Settings {
  settings: { clinicId: string; cancellationWindowHours: number; maxUpcomingPerPatient: number };
}

let w: World;
const read = (userId: string) => send<Settings & ErrorJson>(settingsRoute, "GET", userId);
const change = (userId: string, body: unknown) => send<Settings & ErrorJson>(settingsPatchRoute, "PATCH", userId, { body });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("reading and changing", () => {
  it("staff read their clinic's window and limit, which start at 24 hours and 3", async () => {
    const result = await read(w.staffUser.id);
    expect(result.status).toBe(200);
    expect(result.json.settings).toEqual({ clinicId: w.clinic.id, cancellationWindowHours: 24, maxUpcomingPerPatient: 3 });
  });

  it("any staff member of the clinic can change either one, and it is audited", async () => {
    const { user: colleague } = await createStaff(w.clinic.id);
    const first = await change(w.staffUser.id, { maxUpcomingPerPatient: 5 });
    expect(first.status).toBe(200);
    expect(first.json.settings).toEqual({ clinicId: w.clinic.id, cancellationWindowHours: 24, maxUpcomingPerPatient: 5 });
    const second = await change(colleague.id, { cancellationWindowHours: 48 });
    expect(second.json.settings).toEqual({ clinicId: w.clinic.id, cancellationWindowHours: 48, maxUpcomingPerPatient: 5 });

    expect(await db.clinic.findUniqueOrThrow({ where: { id: w.clinic.id } })).toMatchObject({ cancellationWindowHours: 48, maxUpcomingPerPatient: 5 });
    const audit = await db.auditEvent.findMany({ where: { action: "clinic.settings_changed" }, orderBy: { at: "asc" } });
    expect(audit.map((a) => a.actorId).sort()).toEqual([w.staffUser.id, colleague.id].sort());
    expect(audit[0]).toMatchObject({ actorRole: "staff", entityType: "clinic", entityId: w.clinic.id, clinicId: w.clinic.id });
  });

  it("changes only the caller's own clinic", async () => {
    const other = await otherClinic();
    await change(w.staffUser.id, { maxUpcomingPerPatient: 7, cancellationWindowHours: 0 });
    expect(await db.clinic.findUniqueOrThrow({ where: { id: other.clinic.id } })).toMatchObject({ cancellationWindowHours: 24, maxUpcomingPerPatient: 3 });
    // A clinic id in the body is not accepted as authority: it is not accepted at all.
    const named = await change(other.staffUser.id, { clinicId: w.clinic.id, maxUpcomingPerPatient: 1 });
    expect(named.status).toBe(422);
    expect((await db.clinic.findUniqueOrThrow({ where: { id: w.clinic.id } })).maxUpcomingPerPatient).toBe(7);
  });

  it("refuses values out of range, an empty change and unknown settings", async () => {
    for (const body of [{ maxUpcomingPerPatient: 0 }, { maxUpcomingPerPatient: 2.5 }, { cancellationWindowHours: -1 }, { cancellationWindowHours: "24" }, {}, { timeZone: "UTC" }]) {
      const result = await change(w.staffUser.id, body);
      expect(result.status).toBe(422);
      expect(result.json.error.code).toBe("VALIDATION_FAILED");
    }
    expect(await db.auditEvent.count({ where: { action: "clinic.settings_changed" } })).toBe(0);
  });

  it("is for staff only: a doctor and a patient get 403", async () => {
    for (const userId of [w.doctorUser.id, w.patientUser.id]) {
      expect((await read(userId)).status).toBe(403);
      expect((await change(userId, { maxUpcomingPerPatient: 9 })).status).toBe(403);
    }
    expect((await db.clinic.findUniqueOrThrow({ where: { id: w.clinic.id } })).maxUpcomingPerPatient).toBe(3);
  });
});

describe("taking effect", () => {
  const staffBooks = (start: Date) =>
    send<ErrorJson>(bookRoute, "POST", w.staffUser.id, {
      body: { doctorId: w.doctor.id, patientId: w.patient.id, startsAt: start.toISOString(), reasonForVisit: "Fictional reason" },
    });

  it("the new limit applies to the next booking, by staff as well (R25)", async () => {
    await change(w.staffUser.id, { maxUpcomingPerPatient: 1 });
    expect((await staffBooks(S0900)).status).toBe(201);
    const over = await staffBooks(S0930);
    expect(over.status).toBe(409);
    expect(over.json.error).toMatchObject({ code: "BOOKING_LIMIT_REACHED", limit: 1 });

    await change(w.staffUser.id, { maxUpcomingPerPatient: 2 });
    expect((await staffBooks(S0930)).status).toBe(201);
    expect((await staffBooks(S1000)).json.error.limit).toBe(2);
  });

  it("the new window decides the deadline shown and what counts as a late cancel (R40)", async () => {
    const id = await book(w, S0900);
    const other = await book(w, S0930);
    await change(w.staffUser.id, { cancellationWindowHours: 2 });

    const seen = await send<{ appointment: Appointment }>(readRoute, "GET", w.staffUser.id, { params: { id } });
    expect(seen.json.appointment.cancellationDeadline).toBe(hoursBefore(S0900, 2).toISOString());

    // Three hours before: late under the old 24-hour window, not under the new 2-hour one.
    const result = await changeAppointmentStatus({ actor: w.patientSession, appointmentId: id, to: "cancelled" }, hoursBefore(S0900, 3));
    expect(result.lateCancel).toBe(false);

    await change(w.staffUser.id, { cancellationWindowHours: 48 });
    const late = await changeAppointmentStatus({ actor: w.patientSession, appointmentId: other, to: "cancelled" }, hoursBefore(S0930, 30));
    expect(late.lateCancel).toBe(true);
    expect((await row(other)).lateCancel).toBe(true);
  });
});
