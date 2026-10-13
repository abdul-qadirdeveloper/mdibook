// Changing working hours or breaks (R51 to R55): a listed reason, a preview that must still
// be true when the change is saved, and the change plus every cancellation it causes in one
// transaction. The database is real; one test makes a notification write fail to force a
// rollback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as readRoute } from "@/app/api/v1/appointments/[id]/route";
import { GET as changeRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/[changeId]/route";
import { POST as changePreviewRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/preview/route";
import { POST as changeApplyRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/route";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createPatient, createWorld, sessionFor } from "../../helpers/factories";
import {
  type Applied,
  type Appointment,
  DAY,
  type ErrorJson,
  NO_TOKEN,
  type Preview,
  S0900,
  S1600,
  S1630,
  type World,
  book,
  changeSchedule,
  counts,
  everyDay,
  row,
  send,
} from "./support";

// Makes the Nth notification write of a test fail, to prove the whole change rolls back.
const failure = vi.hoisted(() => ({ onCall: 0, calls: 0 }));
vi.mock("@/lib/notifications", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/notifications")>();
  return {
    ...original,
    recordNotification: async (...args: Parameters<typeof original.recordNotification>) => {
      failure.calls += 1;
      if (failure.calls === failure.onCall) throw new Error("forced failure");
      return original.recordNotification(...args);
    },
  };
});

let w: World;
let kept: string;
let late: string;
let nextDay: string;
const NEXT_DAY = "2026-10-15";

// The doctor works every day 09:00 to 17:00. This change ends the day at 16:00, which leaves
// the 16:00 and the next day's 16:30 appointments outside the hours.
const SHORTER = { kind: "working_hours" as const, intervals: everyDay(540, 960) };
const params = () => ({ params: { doctorId: w.doctor.id } });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
  const { user, patient } = await createPatient();
  kept = await book(w, S0900);
  late = await book(w, S1600);
  nextDay = await book(w, at(NEXT_DAY, "16:30"), { by: await sessionFor(user.id), patientId: patient.id });
  failure.onCall = 0;
  failure.calls = 0;
});

afterEach(() => restoreClock());

const preview = (userId = w.staffUser.id, body: unknown = SHORTER) =>
  send<Preview>(changePreviewRoute, "POST", userId, { ...params(), body });
const apply = (body: unknown, userId = w.staffUser.id) =>
  send<Applied & ErrorJson>(changeApplyRoute, "POST", userId, { ...params(), body });
const hours = () => db.workingHours.findMany({ where: { doctorId: w.doctor.id }, orderBy: { weekday: "asc" } });

describe("a reason from the fixed list (R51)", () => {
  it("is required, and a code from another list or free text is refused", async () => {
    const token = (await preview()).json.preview.previewToken;
    const before = await counts();

    const missing = await apply({ ...SHORTER, previewToken: token });
    expect(missing.status).toBe(422);
    expect(missing.json.error.fields).toEqual([{ field: "reasonCode", problem: "required" }]);

    // patient_request is a cancellation reason, not a schedule-change reason.
    for (const reasonCode of ["patient_request", "Dr. Sample is unwell", ""]) {
      const refused = await apply({ ...SHORTER, previewToken: token, reasonCode });
      expect(refused.status).toBe(422);
      expect(refused.json.error.fields).toEqual([{ field: "reasonCode", problem: "invalid" }]);
      expect(JSON.stringify(refused.json.error)).not.toContain("unwell");
    }

    const extra = await apply({ ...SHORTER, previewToken: token, reasonCode: "training", reasonText: "anything" });
    expect(extra.status).toBe(422);
    expect(await counts()).toEqual(before);
    expect((await hours())[0].endMinute).toBe(1020);
  });
});

describe("the preview (R53)", () => {
  it("says how many appointments would be cancelled and on which dates, and changes nothing", async () => {
    const before = await counts();
    const result = await preview();
    expect(result.status).toBe(200);
    expect(result.json.preview).toMatchObject({ count: 2, dates: [DAY, NEXT_DAY], timeZone: "America/Chicago" });
    expect(result.json.preview.appointments.map((a) => a.id)).toEqual([late, nextDay]);
    expect(result.json.preview.previewToken).toMatch(/^[0-9a-f]{64}$/);

    expect(await counts()).toEqual(before);
    expect((await row(late)).status).toBe("requested");
    expect((await hours())[0].endMinute).toBe(1020);
  });

  it("a save without the preview's token is refused", async () => {
    const before = await counts();
    const none = await apply({ ...SHORTER, reasonCode: "training" });
    expect(none.status).toBe(422);
    expect(none.json.error.fields).toEqual([{ field: "previewToken", problem: "required" }]);

    const wrong = await apply({ ...SHORTER, reasonCode: "training", previewToken: NO_TOKEN });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error.code).toBe("PREVIEW_STALE");
    expect(await counts()).toEqual(before);
  });

  it("a booking made after the preview makes the save PREVIEW_STALE, and nothing is saved", async () => {
    const token = (await preview()).json.preview.previewToken;
    // Someone books 16:30 on the first day while the preview is on screen.
    const booked = await book(w, S1630, { by: w.staffSession });
    const before = await counts();

    const stale = await apply({ ...SHORTER, reasonCode: "training", previewToken: token });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("PREVIEW_STALE");
    expect(await counts()).toEqual(before);
    expect((await hours())[0].endMinute).toBe(1020);
    for (const id of [late, nextDay, booked]) expect((await row(id)).status).not.toBe("cancelled");

    // The preview is shown again, now with three appointments, and can be confirmed.
    const again = await preview();
    expect(again.json.preview.count).toBe(3);
    const saved = await apply({ ...SHORTER, reasonCode: "training", previewToken: again.json.preview.previewToken });
    expect(saved.status).toBe(201);
    expect(saved.json.scheduleChange.appointmentsCancelled).toBe(3);
  });

  it("a token confirms the change it was given for and no other", async () => {
    const token = (await preview()).json.preview.previewToken;
    const other = await apply({ kind: "working_hours", intervals: everyDay(540, 600), reasonCode: "training", previewToken: token });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("PREVIEW_STALE");
    expect((await hours())[0].endMinute).toBe(1020);
  });
});

describe("saving the change (R52)", () => {
  it("cancels every appointment that no longer fits, with the reason, and keeps the rest", async () => {
    const before = await counts();
    const { applied } = await changeSchedule(w.staffUser.id, w.doctor.id, SHORTER, "training");
    expect(applied.status).toBe(201);
    const change = applied.json.scheduleChange;
    expect(change).toMatchObject({ doctorId: w.doctor.id, kind: "working_hours", reasonCode: "training", appointmentsCancelled: 2, at: NOW.toISOString() });

    for (const id of [late, nextDay]) {
      expect(await row(id)).toMatchObject({
        status: "cancelled",
        cancelledByRole: "staff",
        cancelReasonCode: "training",
        lateCancel: false,
        scheduleChangeId: change.id,
      });
    }
    expect(await row(kept)).toMatchObject({ status: "requested", scheduleChangeId: null, startsAt: S0900 });
    expect((await hours()).map((h) => h.endMinute)).toEqual([960, 960, 960, 960, 960, 960, 960]);

    const after = await counts();
    expect(after.active).toBe(before.active - 2);
    expect(after.changes).toBe(before.changes + 1);
    expect(await db.scheduleChange.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({
      actorId: w.staffUser.id,
      actorRole: "staff",
      clinicId: w.clinic.id,
      appointmentsCancelled: 2,
    });
  });

  it("a doctor changes their own breaks, and the cancellations record the doctor", async () => {
    const lunch = { kind: "breaks" as const, intervals: everyDay(960, 1020) };
    const { preview: shown, applied } = await changeSchedule(w.doctorUser.id, w.doctor.id, lunch, "schedule_change");
    expect(shown.json.preview.count).toBe(2);
    expect(applied.status).toBe(201);
    expect(await row(late)).toMatchObject({ status: "cancelled", cancelledByRole: "doctor", cancelReasonCode: "schedule_change" });
    expect(await db.break.count({ where: { doctorId: w.doctor.id } })).toBe(7);
  });

  it("a failure part of the way through leaves the hours and every appointment untouched", async () => {
    const token = (await preview()).json.preview.previewToken;
    const before = await counts();
    // The first cancellation is written, then the second one fails.
    failure.calls = 0;
    failure.onCall = 2;

    const failed = await apply({ ...SHORTER, reasonCode: "training", previewToken: token });
    expect(failed.status).toBe(500);
    expect(failed.json.error.code).toBe("INTERNAL");
    expect(failed.json.error.message).not.toContain("forced");

    expect(await counts()).toEqual(before);
    expect((await hours()).every((h) => h.endMinute === 1020)).toBe(true);
    for (const id of [kept, late, nextDay]) {
      expect(await row(id)).toMatchObject({ status: "requested", cancelledByRole: null, scheduleChangeId: null });
    }
  });

  it("a booking racing the change never ends up outside the new hours (plan, Risks 5)", async () => {
    const token = (await preview()).json.preview.previewToken;
    const [change, booking] = await Promise.allSettled([
      apply({ ...SHORTER, reasonCode: "training", previewToken: token }),
      book(w, S1630, { by: w.staffSession }),
    ]);
    const saved = change.status === "fulfilled" && change.value.status === 201;
    const booked = booking.status === "fulfilled";
    // Either the change went first and the booking was refused, or the booking went first
    // and the change is stale. Never both.
    expect(saved && booked).toBe(false);
    expect(saved || booked).toBe(true);
    if (!saved && change.status === "fulfilled") expect(change.value.json.error.code).toBe("PREVIEW_STALE");
    const outside = await db.appointment.count({
      where: { doctorId: w.doctor.id, status: { in: ["requested", "confirmed"] }, startsAt: { in: [S1600, S1630] } },
    });
    expect(outside).toBe(saved ? 0 : 2);
  });
});

describe("each cancellation (R54, R55)", () => {
  it("has its own notification event and audit event, and the log holds ids only", async () => {
    const token = (await preview()).json.preview.previewToken;
    const { result, lines, raw } = await captureLogs(() => apply({ ...SHORTER, reasonCode: "training", previewToken: token }));
    expect(result.status).toBe(201);

    for (const id of [late, nextDay]) {
      expect(await db.notificationEvent.count({ where: { appointmentId: id, type: "cancelled" } })).toBe(1);
      expect(await db.auditEvent.count({ where: { entityId: id, action: "appointment.cancelled" } })).toBe(1);
      expect(await db.appointmentHistory.count({ where: { appointmentId: id, action: "cancelled", reasonCode: "training" } })).toBe(1);
    }
    expect(await db.notificationEvent.count({ where: { appointmentId: kept, type: "cancelled" } })).toBe(0);

    const delivered = lines.filter((l) => l.event === "notification.cancelled").map((l) => l.appointmentId);
    expect(delivered.sort()).toEqual([late, nextDay].sort());
    expect(raw).not.toMatch(/Pat Example|555-0100|example\.test|Fictional reason|training/);
  });

  it("staff open the list with each patient's name and phone; the doctor sees it without phone numbers", async () => {
    const { applied } = await changeSchedule(w.staffUser.id, w.doctor.id, SHORTER, "training");
    const changeParams = { params: { doctorId: w.doctor.id, changeId: applied.json.scheduleChange.id } };
    type List = { scheduleChange: Applied["scheduleChange"]; appointments: Appointment[] };

    const forStaff = await send<List>(changeRoute, "GET", w.staffUser.id, changeParams);
    expect(forStaff.status).toBe(200);
    expect(forStaff.json.scheduleChange.appointmentsCancelled).toBe(2);
    expect(forStaff.json.appointments.map((a) => a.id)).toEqual([late, nextDay]);
    for (const a of forStaff.json.appointments) {
      expect(a.patientName).toMatch(/^Pat Example/);
      expect(a.patientPhone).toBe("555-0100");
      expect(a.cancelReasonCode).toBe("training");
      expect(a).not.toHaveProperty("reasonForVisit");
    }

    const forDoctor = await send<List>(changeRoute, "GET", w.doctorUser.id, changeParams);
    expect(forDoctor.json.appointments).toHaveLength(2);
    for (const a of forDoctor.json.appointments) {
      expect(a.patientName).toMatch(/^Pat Example/);
      expect(a).not.toHaveProperty("patientPhone");
      expect(a).not.toHaveProperty("patientEmail");
      expect(a.cancelReasonCode).toBe("training");
    }
  });

  it("the patient sees it as cancelled by the clinic, without the reason code", async () => {
    await changeSchedule(w.staffUser.id, w.doctor.id, SHORTER, "unplanned_absence");
    const seen = await send<{ appointment: Appointment }>(readRoute, "GET", w.patientUser.id, { params: { id: late } });
    expect(seen.json.appointment).toMatchObject({ status: "cancelled", cancelledBy: "clinic" });
    expect(seen.json.appointment).not.toHaveProperty("cancelReasonCode");
    expect(JSON.stringify(seen.json)).not.toContain("unplanned_absence");
  });
});
