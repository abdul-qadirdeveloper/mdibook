// Time off (R51 to R54, R57). The preview returns the appointments the time off would cancel
// and cancels none of them. Saving it with the confirmed preview cancels them. Removing it
// reopens its slots and restores nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as bookRoute } from "@/app/api/v1/appointments/route";
import { GET as scheduleSettingsRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-settings/route";
import { DELETE as timeOffRemoveRoute } from "@/app/api/v1/doctors/[doctorId]/time-off/[id]/route";
import { POST as timeOffPreviewRoute } from "@/app/api/v1/doctors/[doctorId]/time-off/preview/route";
import { POST as timeOffRoute } from "@/app/api/v1/doctors/[doctorId]/time-off/route";
import { visibleAppointmentFields } from "@/domain/visibility";
import { db } from "@/lib/db";
import { listOpenSlots } from "@/lib/open-slots";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createDoctor, createPatient, createWorld } from "../../helpers/factories";
import {
  type Applied,
  DAY,
  type ErrorJson,
  NO_TOKEN,
  type Preview,
  S0900,
  S1000,
  S1600,
  type World,
  addTimeOff,
  book,
  counts,
  row,
  send,
} from "./support";

let w: World;
let morning: string;
let midMorning: string;
let afternoon: string;

// Wednesday 14 October, 09:00 to 12:00 in Chicago: covers the 09:00 and 10:00 appointments.
const MORNING_OFF = { startDate: DAY, startMinute: 540, endDate: DAY, endMinute: 720 };
const params = () => ({ params: { doctorId: w.doctor.id } });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
  morning = await book(w, S0900);
  midMorning = await book(w, S1000, { by: w.staffSession });
  afternoon = await book(w, S1600);
});

afterEach(() => restoreClock());

async function openOn(date: string) {
  const open = await listOpenSlots(db, w.doctor.id, at(date, "00:00"), at(date, "23:59"), NOW);
  return (open?.slots ?? []).map((s) => s.start.toISOString());
}

describe("previewing time off over existing appointments", () => {
  it("returns the affected appointments and cancels none of them", async () => {
    const before = await counts();
    const result = await send<Preview>(timeOffPreviewRoute, "POST", w.staffUser.id, { ...params(), body: MORNING_OFF });

    expect(result.status).toBe(200);
    expect(result.json.preview).toMatchObject({
      count: 2,
      dates: [DAY],
      startsAt: at(DAY, "09:00").toISOString(),
      endsAt: at(DAY, "12:00").toISOString(),
    });
    expect(result.json.preview.appointments.map((a) => a.id)).toEqual([morning, midMorning]);
    // Each one is the staff view of the appointment and nothing more.
    for (const a of result.json.preview.appointments) {
      expect(Object.keys(a).sort()).toEqual([...visibleAppointmentFields("staff")].sort());
      expect(["requested", "confirmed"]).toContain(a.status);
    }

    // Nothing was saved and nothing was cancelled.
    expect(await counts()).toEqual(before);
    expect((await row(morning)).status).toBe("requested");
    expect((await row(midMorning)).status).toBe("confirmed");
    expect(await db.timeOff.count()).toBe(0);
  });

  it("a preview that touches no appointment returns an empty list", async () => {
    const result = await send<Preview>(timeOffPreviewRoute, "POST", w.doctorUser.id, {
      ...params(),
      body: { startDate: "2026-10-20", startMinute: 0, endDate: "2026-10-21", endMinute: 0 },
    });
    expect(result.json.preview).toMatchObject({ count: 0, dates: [], appointments: [] });
  });

  it("only this doctor's appointments are listed", async () => {
    const colleague = await createDoctor(w.clinic.id);
    const { patient } = await createPatient();
    await book(w, S0900, { by: w.staffSession, doctorId: colleague.doctor.id, patientId: patient.id });
    const result = await send<Preview>(timeOffPreviewRoute, "POST", w.staffUser.id, { ...params(), body: MORNING_OFF });
    expect(result.json.preview.appointments.map((a) => a.id)).toEqual([morning, midMorning]);
  });
});

describe("adding time off (R51, R52)", () => {
  it("needs a listed reason and the preview's token, and saves nothing without them", async () => {
    const before = await counts();
    const token = (await send<Preview>(timeOffPreviewRoute, "POST", w.staffUser.id, { ...params(), body: MORNING_OFF })).json.preview.previewToken;
    const post = (body: unknown) => send<ErrorJson>(timeOffRoute, "POST", w.staffUser.id, { ...params(), body });

    const noToken = await post({ ...MORNING_OFF, reasonCode: "planned_leave" });
    expect(noToken.status).toBe(422);
    const noReason = await post({ ...MORNING_OFF, previewToken: token });
    expect(noReason.status).toBe(422);
    expect(noReason.json.error.fields?.[0].field).toBe("reasonCode");
    const cancelReason = await post({ ...MORNING_OFF, previewToken: token, reasonCode: "booked_in_error" });
    expect(cancelReason.status).toBe(422);
    const unconfirmed = await post({ ...MORNING_OFF, previewToken: NO_TOKEN, reasonCode: "planned_leave" });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json.error.code).toBe("PREVIEW_STALE");

    expect(await counts()).toEqual(before);
    expect((await row(morning)).status).toBe("requested");
  });

  it("with the confirmed preview, cancels the listed appointments with the reason and keeps the others", async () => {
    const { applied } = await addTimeOff(w.staffUser.id, w.doctor.id, MORNING_OFF, "unplanned_absence");
    expect(applied.status).toBe(201);
    expect(applied.json.scheduleChange).toMatchObject({ kind: "time_off", reasonCode: "unplanned_absence", appointmentsCancelled: 2 });
    expect(applied.json.timeOff).toMatchObject({
      startsAt: at(DAY, "09:00").toISOString(),
      endsAt: at(DAY, "12:00").toISOString(),
      reasonCode: "unplanned_absence",
    });

    for (const id of [morning, midMorning]) {
      expect(await row(id)).toMatchObject({
        status: "cancelled",
        cancelledByRole: "staff",
        cancelReasonCode: "unplanned_absence",
        lateCancel: false,
        scheduleChangeId: applied.json.scheduleChange.id,
      });
      expect(await db.notificationEvent.count({ where: { appointmentId: id, type: "cancelled" } })).toBe(1);
    }
    expect(await row(afternoon)).toMatchObject({ status: "requested", scheduleChangeId: null });

    const audit = await db.auditEvent.findMany({ where: { action: "schedule.time_off_added" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "time_off", entityId: applied.json.timeOff?.id, actorId: w.staffUser.id, clinicId: w.clinic.id });
  });

  it("a doctor adds their own, and its slots cannot be booked", async () => {
    const { applied } = await addTimeOff(w.doctorUser.id, w.doctor.id, MORNING_OFF);
    expect(applied.status).toBe(201);
    expect((await row(morning)).cancelledByRole).toBe("doctor");
    expect(await openOn(DAY)).not.toContain(at(DAY, "11:00").toISOString());

    const refused = await send<ErrorJson>(bookRoute, "POST", w.staffUser.id, {
      body: { doctorId: w.doctor.id, patientId: w.patient.id, startsAt: at(DAY, "11:00").toISOString(), reasonForVisit: "Fictional reason" },
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("SLOT_UNAVAILABLE");
  });

  it("refuses time off that ends before it starts, or that is already over", async () => {
    const backwards = await send<ErrorJson>(timeOffPreviewRoute, "POST", w.staffUser.id, {
      ...params(),
      body: { startDate: DAY, startMinute: 720, endDate: DAY, endMinute: 540 },
    });
    expect(backwards.status).toBe(422);
    expect(backwards.json.error.fields).toEqual([{ field: "endDate", problem: "invalid" }]);

    const over = await send<ErrorJson>(timeOffPreviewRoute, "POST", w.staffUser.id, {
      ...params(),
      body: { startDate: "2026-10-01", startMinute: 0, endDate: "2026-10-02", endMinute: 0 },
    });
    expect(over.status).toBe(422);

    const notADate = await send<ErrorJson>(timeOffPreviewRoute, "POST", w.staffUser.id, {
      ...params(),
      body: { startDate: "2026-02-30", startMinute: 0, endDate: "2026-03-02", endMinute: 0 },
    });
    expect(notADate.status).toBe(422);
    expect(notADate.json.error.fields).toEqual([{ field: "startDate", problem: "invalid" }]);
  });
});

describe("removing time off (R57)", () => {
  it("reopens its slots and does not restore the appointments it cancelled", async () => {
    const { applied } = await addTimeOff(w.staffUser.id, w.doctor.id, MORNING_OFF);
    const id = applied.json.timeOff?.id as string;
    expect(await openOn(DAY)).not.toContain(S0900.toISOString());

    const removed = await send<{ removed: { id: string } }>(timeOffRemoveRoute, "DELETE", w.staffUser.id, { params: { doctorId: w.doctor.id, id } });
    expect(removed.status).toBe(200);
    expect(removed.json.removed.id).toBe(id);

    expect(await db.timeOff.count()).toBe(0);
    const open = await openOn(DAY);
    for (const slot of [S0900, S1000, at(DAY, "11:00")]) expect(open).toContain(slot.toISOString());
    // Still cancelled: the patient books again if they want the time back.
    expect((await row(morning)).status).toBe("cancelled");
    expect((await row(midMorning)).status).toBe("cancelled");

    const settings = await send<{ settings: { timeOff: unknown[] } }>(scheduleSettingsRoute, "GET", w.staffUser.id, params());
    expect(settings.json.settings.timeOff).toEqual([]);
    expect(await db.auditEvent.count({ where: { action: "schedule.time_off_removed", entityId: id } })).toBe(1);

    const again = await send<ErrorJson>(timeOffRemoveRoute, "DELETE", w.staffUser.id, { params: { doctorId: w.doctor.id, id } });
    expect(again.status).toBe(404);
  });

  it("time off is removed only through its own doctor", async () => {
    const colleague = await createDoctor(w.clinic.id);
    const { applied } = await addTimeOff(w.staffUser.id, w.doctor.id, MORNING_OFF);
    const result = await send<Applied & ErrorJson>(timeOffRemoveRoute, "DELETE", w.staffUser.id, {
      params: { doctorId: colleague.doctor.id, id: applied.json.timeOff?.id as string },
    });
    expect(result.status).toBe(404);
    expect(await db.timeOff.count()).toBe(1);
  });
});
