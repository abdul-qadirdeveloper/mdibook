// Schedule settings (R49, R50): working hours, breaks, time off and slot length. Hours and
// breaks are wall-clock times in the clinic's zone; time off is stored as two instants.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as changePreviewRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/preview/route";
import { GET as scheduleSettingsRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-settings/route";
import { db } from "@/lib/db";
import { listOpenSlots } from "@/lib/open-slots";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createClinic, createDoctor, createStaff, createWorld } from "../../helpers/factories";
import { DAY, type ErrorJson, type World, addTimeOff, changeSchedule, counts, everyDay, send } from "./support";

interface Settings {
  settings: {
    doctorId: string;
    timeZone: string;
    slotLengthMinutes: number;
    workingHours: { weekday: number; startMinute: number; endMinute: number }[];
    breaks: { weekday: number; startMinute: number; endMinute: number }[];
    timeOff: { id: string; startsAt: string; endsAt: string; reasonCode: string }[];
  };
}

let w: World;
const params = () => ({ params: { doctorId: w.doctor.id } });

/** Start instants of the open slots on a clinic date. */
async function slotsOn(date: string, zone?: string) {
  const open = await listOpenSlots(db, w.doctor.id, at(date, "00:00", zone), at(date, "23:59", zone), NOW);
  return (open?.slots ?? []).map((s) => s.start.toISOString());
}

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("schedule settings (R49)", () => {
  it("hold working hours, breaks, time off and slot length, for the doctor and for staff", async () => {
    const owner = { doctorId: w.doctor.id, clinicId: w.clinic.id };
    await db.break.create({ data: { ...owner, weekday: 3, startMinute: 720, endMinute: 780 } });
    const upcoming = await db.timeOff.create({
      data: { ...owner, startsAt: at("2026-10-20", "09:00"), endsAt: at("2026-10-21", "09:00"), reasonCode: "training", createdById: w.staffUser.id },
    });
    // Time off that is over is history, not a setting.
    await db.timeOff.create({
      data: { ...owner, startsAt: at("2026-10-01", "09:00"), endsAt: at("2026-10-02", "09:00"), reasonCode: "training", createdById: w.staffUser.id },
    });

    for (const userId of [w.doctorUser.id, w.staffUser.id]) {
      const result = await send<Settings>(scheduleSettingsRoute, "GET", userId, params());
      expect(result.status).toBe(200);
      expect(Object.keys(result.json.settings).sort()).toEqual(
        ["breaks", "doctorId", "slotLengthMinutes", "timeOff", "timeZone", "workingHours"],
      );
      expect(result.json.settings).toMatchObject({
        doctorId: w.doctor.id,
        timeZone: "America/Chicago",
        slotLengthMinutes: 30,
        breaks: [{ weekday: 3, startMinute: 720, endMinute: 780 }],
        timeOff: [
          { id: upcoming.id, startsAt: at("2026-10-20", "09:00").toISOString(), endsAt: at("2026-10-21", "09:00").toISOString(), reasonCode: "training" },
        ],
      });
      expect(result.json.settings.workingHours).toEqual(everyDay(540, 1020));
    }
  });
});

describe("working hours and breaks (R50)", () => {
  it("are stored as wall-clock minutes, and the open slots follow them", async () => {
    const hours = [{ weekday: 3, startMinute: 600, endMinute: 720 }];
    const { applied } = await changeSchedule(w.staffUser.id, w.doctor.id, { kind: "working_hours", intervals: hours });
    expect(applied.status).toBe(201);
    expect(applied.json.scheduleChange).toMatchObject({ kind: "working_hours", reasonCode: "schedule_change", appointmentsCancelled: 0 });

    const stored = await db.workingHours.findMany({ where: { doctorId: w.doctor.id }, select: { weekday: true, startMinute: true, endMinute: true } });
    expect(stored).toEqual(hours);
    const read = await send<Settings>(scheduleSettingsRoute, "GET", w.doctorUser.id, params());
    expect(read.json.settings.workingHours).toEqual(hours);

    // Wednesday 10:00 to 12:00 in Chicago, in 30-minute slots. Thursday has no hours now.
    expect(await slotsOn(DAY)).toEqual(["10:00", "10:30", "11:00", "11:30"].map((t) => at(DAY, t).toISOString()));
    expect(await slotsOn("2026-10-15")).toEqual([]);
  });

  it("a break takes its slots out", async () => {
    await changeSchedule(w.doctorUser.id, w.doctor.id, { kind: "working_hours", intervals: [{ weekday: 3, startMinute: 600, endMinute: 720 }] });
    const { applied } = await changeSchedule(w.doctorUser.id, w.doctor.id, { kind: "breaks", intervals: [{ weekday: 3, startMinute: 630, endMinute: 690 }] });
    expect(applied.status).toBe(201);
    expect(applied.json.scheduleChange.kind).toBe("breaks");
    expect(await slotsOn(DAY)).toEqual(["10:00", "11:30"].map((t) => at(DAY, t).toISOString()));
  });

  it("the same wall-clock hours are a different instant after the clocks change", async () => {
    await changeSchedule(w.staffUser.id, w.doctor.id, { kind: "working_hours", intervals: everyDay(540, 600) });
    // Clocks go back in Chicago on 1 November 2026: 09:00 is 14:00 UTC before, 15:00 UTC after.
    expect((await slotsOn("2026-10-30"))[0]).toBe("2026-10-30T14:00:00.000Z");
    expect((await slotsOn("2026-11-02"))[0]).toBe("2026-11-02T15:00:00.000Z");
  });

  it("writes one audit event for the change, with ids only", async () => {
    const { applied } = await changeSchedule(w.staffUser.id, w.doctor.id, { kind: "working_hours", intervals: everyDay(600, 900) });
    const events = await db.auditEvent.findMany({ where: { action: "schedule.working_hours_changed" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: w.staffUser.id,
      actorRole: "staff",
      entityType: "schedule_change",
      entityId: applied.json.scheduleChange.id,
      clinicId: w.clinic.id,
    });
  });

  it("refuses intervals that overlap, run backwards or are out of range, naming the field and not the value", async () => {
    const before = await counts();
    const bad = [
      [{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 700, endMinute: 800 }],
      [{ weekday: 1, startMinute: 720, endMinute: 540 }],
      [{ weekday: 8, startMinute: 540, endMinute: 720 }],
      [{ weekday: 1, startMinute: 540, endMinute: 1441 }],
      [{ weekday: 1, startMinute: 540.5, endMinute: 720 }],
    ];
    for (const intervals of bad) {
      const result = await send<ErrorJson>(changePreviewRoute, "POST", w.staffUser.id, { ...params(), body: { kind: "working_hours", intervals } });
      expect(result.status).toBe(422);
      expect(result.json.error.code).toBe("VALIDATION_FAILED");
      expect(result.json.error.fields?.[0].field).toMatch(/^intervals/);
      expect(JSON.stringify([result.json.error.fields, result.json.error.message])).not.toMatch(/1441|540\.5|700/);
    }
    const unknownKind = await send<ErrorJson>(changePreviewRoute, "POST", w.staffUser.id, { ...params(), body: { kind: "time_off", intervals: [] } });
    expect(unknownKind.status).toBe(422);
    expect(await counts()).toEqual(before);
  });
});

describe("time off (R50)", () => {
  it("is entered in the clinic's time zone and stored as two instants", async () => {
    const clinic = await createClinic({ timeZone: "Europe/Berlin" });
    const { doctor } = await createDoctor(clinic.id);
    const { user: staffUser } = await createStaff(clinic.id);

    const { preview, applied } = await addTimeOff(staffUser.id, doctor.id, { startDate: "2026-10-20", startMinute: 0, endDate: "2026-10-21", endMinute: 0 });
    expect(preview.json.preview.timeZone).toBe("Europe/Berlin");
    expect(applied.status).toBe(201);

    // Midnight in Berlin on 20 October is 22:00 UTC the evening before.
    const stored = await db.timeOff.findUniqueOrThrow({ where: { id: applied.json.timeOff?.id } });
    expect(stored.startsAt.toISOString()).toBe("2026-10-19T22:00:00.000Z");
    expect(stored.endsAt.toISOString()).toBe("2026-10-20T22:00:00.000Z");
    expect(stored).toMatchObject({ reasonCode: "planned_leave", createdById: staffUser.id, clinicId: clinic.id });
    expect(applied.json.timeOff).toMatchObject({ startsAt: "2026-10-19T22:00:00.000Z", endsAt: "2026-10-20T22:00:00.000Z" });
  });
});
