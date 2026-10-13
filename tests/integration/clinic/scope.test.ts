// Who may act on what (R4, R7, R8, R48). A doctor acts on their own schedule and appointments
// only; staff only for doctors of their own clinic. Anything else is refused with 403 or 404,
// a record out of scope looks exactly like a missing one, and nothing changes.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as cancelRoute } from "@/app/api/v1/appointments/[id]/cancel/route";
import { POST as completeRoute } from "@/app/api/v1/appointments/[id]/complete/route";
import { POST as confirmRoute } from "@/app/api/v1/appointments/[id]/confirm/route";
import { POST as noShowRoute } from "@/app/api/v1/appointments/[id]/no-show/route";
import { POST as rescheduleRoute } from "@/app/api/v1/appointments/[id]/reschedule/route";
import { GET as readRoute } from "@/app/api/v1/appointments/[id]/route";
import { POST as bookRoute } from "@/app/api/v1/appointments/route";
import { GET as patientRoute } from "@/app/api/v1/clinic/patients/[patientId]/route";
import { POST as searchRoute } from "@/app/api/v1/clinic/patients/search/route";
import { GET as scheduleRoute } from "@/app/api/v1/clinic/schedule/route";
import { GET as settingsRoute, PATCH as settingsPatchRoute } from "@/app/api/v1/clinic/settings/route";
import { GET as changeRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/[changeId]/route";
import { POST as changePreviewRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/preview/route";
import { POST as changeApplyRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/route";
import { GET as scheduleSettingsRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-settings/route";
import { PATCH as slotLengthRoute } from "@/app/api/v1/doctors/[doctorId]/slot-length/route";
import { DELETE as timeOffRemoveRoute } from "@/app/api/v1/doctors/[doctorId]/time-off/[id]/route";
import { POST as timeOffPreviewRoute } from "@/app/api/v1/doctors/[doctorId]/time-off/preview/route";
import { POST as timeOffRoute } from "@/app/api/v1/doctors/[doctorId]/time-off/route";
import { db } from "@/lib/db";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createAdmin, createDoctor, createWorld } from "../../helpers/factories";
import {
  DAY,
  type ErrorJson,
  type Handler,
  NO_TOKEN,
  S0900,
  S1000,
  type SendOptions,
  type World,
  book,
  counts,
  everyDay,
  otherClinic,
  send,
} from "./support";

let w: World;
let appointmentId: string;
let timeOffId: string;
let changeId: string;

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
  appointmentId = await book(w, S0900);
  const timeOff = await db.timeOff.create({
    data: {
      doctorId: w.doctor.id,
      clinicId: w.clinic.id,
      startsAt: at("2026-11-02", "09:00"),
      endsAt: at("2026-11-03", "09:00"),
      reasonCode: "planned_leave",
      createdById: w.staffUser.id,
    },
  });
  timeOffId = timeOff.id;
  const change = await db.scheduleChange.create({
    data: { doctorId: w.doctor.id, clinicId: w.clinic.id, kind: "time_off", reasonCode: "planned_leave", actorId: w.staffUser.id, actorRole: "staff" },
  });
  changeId = change.id;
});

afterEach(() => restoreClock());

interface Case {
  name: string;
  handler: Handler;
  method: string;
  options: SendOptions;
  /** Roles the route lets in at all. Any other role is 403 before anything is looked up. */
  open: "clinic" | "shared" | "booking";
}

const timeOffBody = { startDate: "2026-10-20", startMinute: 0, endDate: "2026-10-21", endMinute: 0 };
const hoursBody = { kind: "working_hours", intervals: everyDay(600, 900) };
const confirmation = { reasonCode: "planned_leave", previewToken: NO_TOKEN };

/** Every route that names a doctor, an appointment or a patient of the world's clinic. */
function cases(): Case[] {
  const doctor = { doctorId: w.doctor.id };
  const appointment = { id: appointmentId };
  return [
    { name: "read schedule settings", handler: scheduleSettingsRoute, method: "GET", options: { params: doctor }, open: "clinic" },
    { name: "preview a schedule change", handler: changePreviewRoute, method: "POST", options: { params: doctor, body: hoursBody }, open: "clinic" },
    { name: "apply a schedule change", handler: changeApplyRoute, method: "POST", options: { params: doctor, body: { ...hoursBody, ...confirmation } }, open: "clinic" },
    { name: "read a schedule change", handler: changeRoute, method: "GET", options: { params: { ...doctor, changeId } }, open: "clinic" },
    { name: "preview time off", handler: timeOffPreviewRoute, method: "POST", options: { params: doctor, body: timeOffBody }, open: "clinic" },
    { name: "add time off", handler: timeOffRoute, method: "POST", options: { params: doctor, body: { ...timeOffBody, ...confirmation } }, open: "clinic" },
    { name: "remove time off", handler: timeOffRemoveRoute, method: "DELETE", options: { params: { ...doctor, id: timeOffId } }, open: "clinic" },
    { name: "change slot length", handler: slotLengthRoute, method: "PATCH", options: { params: doctor, body: { slotLengthMinutes: 20 } }, open: "clinic" },
    { name: "read the day schedule", handler: scheduleRoute, method: "GET", options: { query: `doctorId=${w.doctor.id}&view=day&date=${DAY}` }, open: "clinic" },
    { name: "read the week schedule", handler: scheduleRoute, method: "GET", options: { query: `doctorId=${w.doctor.id}&view=week&date=${DAY}` }, open: "clinic" },
    { name: "read a patient record", handler: patientRoute, method: "GET", options: { params: { patientId: w.patient.id } }, open: "clinic" },
    { name: "confirm", handler: confirmRoute, method: "POST", options: { params: appointment }, open: "clinic" },
    { name: "complete", handler: completeRoute, method: "POST", options: { params: appointment }, open: "clinic" },
    { name: "no-show", handler: noShowRoute, method: "POST", options: { params: appointment }, open: "clinic" },
    { name: "cancel", handler: cancelRoute, method: "POST", options: { params: appointment, body: { reasonCode: "doctor_unavailable" } }, open: "shared" },
    { name: "reschedule", handler: rescheduleRoute, method: "POST", options: { params: appointment, body: { startsAt: S1000.toISOString() } }, open: "shared" },
    { name: "read an appointment", handler: readRoute, method: "GET", options: { params: appointment }, open: "shared" },
    { name: "book for a patient", handler: bookRoute, method: "POST", options: { body: { doctorId: w.doctor.id, patientId: w.patient.id, startsAt: S1000.toISOString(), reasonForVisit: "Fictional reason" } }, open: "booking" },
  ];
}

/** Everything a refused request must leave as it was. */
async function state() {
  const appointment = await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  const doctor = await db.doctorProfile.findUniqueOrThrow({ where: { id: w.doctor.id } });
  return { counts: await counts(), status: appointment.status, startsAt: appointment.startsAt, slotLength: doctor.slotLengthMinutes };
}

describe("staff of another clinic", () => {
  it("get 403 or 404 on every route, the same body as for a missing record, and change nothing (R4, R8)", async () => {
    const other = await otherClinic();
    const before = await state();

    for (const c of cases()) {
      const result = await send<ErrorJson>(c.handler, c.method, other.staffUser.id, c.options);
      expect([403, 404], c.name).toContain(result.status);
      expect(result.status, c.name).toBe(404);
      expect(result.json.error.code, c.name).toBe("NOT_FOUND");
      // Only the code, a plain message and the reference id: nothing about the record.
      expect(Object.keys(result.json.error).sort(), c.name).toEqual(["code", "message", "requestId"]);
    }
    expect(await state()).toEqual(before);
  });

  it("the routes with no id in them act on the caller's own clinic only", async () => {
    const other = await otherClinic();
    const settings = await send<{ settings: { clinicId: string } }>(settingsRoute, "GET", other.staffUser.id);
    expect(settings.json.settings.clinicId).toBe(other.clinic.id);

    await send(settingsPatchRoute, "PATCH", other.staffUser.id, { body: { maxUpcomingPerPatient: 9 } });
    const mine = await db.clinic.findUniqueOrThrow({ where: { id: w.clinic.id } });
    expect(mine.maxUpcomingPerPatient).toBe(3);

    // The world's patient is linked to the world's clinic, not to the other one.
    const search = await send<{ patients: unknown[] }>(searchRoute, "POST", other.staffUser.id, { body: { name: "Pat Example" } });
    expect(search.status).toBe(200);
    expect(search.json.patients).toEqual([]);
  });

  it("a missing doctor, appointment or patient gets the same answer as one out of scope", async () => {
    const missing = randomUUID();
    const a = await send<ErrorJson>(scheduleSettingsRoute, "GET", w.staffUser.id, { params: { doctorId: missing } });
    const b = await send<ErrorJson>(confirmRoute, "POST", w.staffUser.id, { params: { id: missing } });
    const c = await send<ErrorJson>(patientRoute, "GET", w.staffUser.id, { params: { patientId: missing } });
    for (const result of [a, b, c]) {
      expect(result.status).toBe(404);
      expect(result.json.error.code).toBe("NOT_FOUND");
    }
    const malformed = await send<ErrorJson>(scheduleSettingsRoute, "GET", w.staffUser.id, { params: { doctorId: "not-an-id" } });
    expect(malformed.status).toBe(404);
  });
});

describe("a doctor", () => {
  it("cannot read or change another doctor's schedule or appointments, even in the same clinic (R48, R60)", async () => {
    const colleague = await createDoctor(w.clinic.id);
    const before = await state();

    for (const c of cases()) {
      const result = await send<ErrorJson>(c.handler, c.method, colleague.user.id, c.options);
      // A doctor never books, so that route is closed to the role; everything else is not found.
      expect(result.status, c.name).toBe(c.open === "booking" ? 403 : 404);
    }
    expect(await state()).toEqual(before);
  });

  it("can read and change their own schedule (R48)", async () => {
    const read = await send(scheduleSettingsRoute, "GET", w.doctorUser.id, { params: { doctorId: w.doctor.id } });
    expect(read.status).toBe(200);
    const changed = await send(slotLengthRoute, "PATCH", w.doctorUser.id, { params: { doctorId: w.doctor.id }, body: { slotLengthMinutes: 20 } });
    expect(changed.status).toBe(200);
  });
});

describe("staff", () => {
  it("can read and change the schedule of a doctor in their own clinic (R48)", async () => {
    const read = await send(scheduleSettingsRoute, "GET", w.staffUser.id, { params: { doctorId: w.doctor.id } });
    expect(read.status).toBe(200);
    const removed = await send(timeOffRemoveRoute, "DELETE", w.staffUser.id, { params: { doctorId: w.doctor.id, id: timeOffId } });
    expect(removed.status).toBe(200);
  });
});

describe("other roles and no session", () => {
  it("a patient and an admin get 403 on every doctor and staff route, and change nothing", async () => {
    const admin = await createAdmin();
    const before = await state();
    for (const c of cases().filter((c) => c.open === "clinic")) {
      for (const userId of [w.patientUser.id, admin.id]) {
        const result = await send<ErrorJson>(c.handler, c.method, userId, c.options);
        expect(result.status, c.name).toBe(403);
        expect(result.json.error.code, c.name).toBe("FORBIDDEN");
      }
    }
    for (const [handler, method] of [[settingsRoute, "GET"], [settingsPatchRoute, "PATCH"], [searchRoute, "POST"]] as const) {
      for (const userId of [w.patientUser.id, w.doctorUser.id, admin.id]) {
        const options = method === "GET" ? {} : { body: {} };
        expect((await send(handler, method, userId, options)).status).toBe(403);
      }
    }
    expect(await state()).toEqual(before);
  });

  it("an admin sees no appointment at all (R94)", async () => {
    const admin = await createAdmin();
    for (const c of cases().filter((c) => c.open !== "clinic")) {
      expect([403, 404], c.name).toContain((await send(c.handler, c.method, admin.id, c.options)).status);
    }
  });

  it("no session is 401 on every route", async () => {
    for (const c of cases()) {
      const result = await send<ErrorJson>(c.handler, c.method, undefined, c.options);
      expect(result.status, c.name).toBe(401);
    }
  });
});
