// Slot length (R56): a change affects only the slots generated afterwards. Existing
// appointments keep their start and length and none is cancelled.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as bookRoute } from "@/app/api/v1/appointments/route";
import { GET as scheduleSettingsRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-settings/route";
import { PATCH as slotLengthRoute } from "@/app/api/v1/doctors/[doctorId]/slot-length/route";
import { db } from "@/lib/db";
import { listOpenSlots } from "@/lib/open-slots";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createWorld } from "../../helpers/factories";
import { DAY, type ErrorJson, S0930, type World, book, changeSchedule, counts, everyDay, row, send } from "./support";

let w: World;
const params = () => ({ params: { doctorId: w.doctor.id } });
const change = (userId: string, slotLengthMinutes: unknown) =>
  send<{ settings: { doctorId: string; slotLengthMinutes: number } } & ErrorJson>(slotLengthRoute, "PATCH", userId, {
    ...params(),
    body: { slotLengthMinutes },
  });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

async function openOn(date: string) {
  const open = await listOpenSlots(db, w.doctor.id, at(date, "00:00"), at(date, "23:59"), NOW);
  return (open?.slots ?? []).map((s) => [s.start.toISOString(), s.end.toISOString()]);
}

describe("changing the slot length (R56)", () => {
  it("keeps existing appointments as they are and cancels none", async () => {
    const existing = await book(w, S0930);
    const before = await row(existing);
    const beforeCounts = await counts();

    const result = await change(w.staffUser.id, 45);
    expect(result.status).toBe(200);
    expect(result.json.settings).toEqual({ doctorId: w.doctor.id, slotLengthMinutes: 45 });

    const after = await row(existing);
    expect(after).toMatchObject({ status: "requested", startsAt: before.startsAt, endsAt: before.endsAt });
    expect(after.endsAt.getTime() - after.startsAt.getTime()).toBe(30 * 60_000);
    // One audit event, and nothing else written.
    expect(await counts()).toEqual({ ...beforeCounts, audit: beforeCounts.audit + 1 });
    expect(await db.auditEvent.findFirst({ where: { action: "schedule.slot_length_changed" } })).toMatchObject({
      actorId: w.staffUser.id,
      actorRole: "staff",
      entityType: "doctor",
      entityId: w.doctor.id,
      clinicId: w.clinic.id,
    });
  });

  it("slots generated afterwards use the new length, around the older appointment", async () => {
    await book(w, S0930);
    await change(w.doctorUser.id, 45);

    const settings = await send<{ settings: { slotLengthMinutes: number } }>(scheduleSettingsRoute, "GET", w.doctorUser.id, params());
    expect(settings.json.settings.slotLengthMinutes).toBe(45);

    const open = await openOn(DAY);
    // The 45-minute grid starts at 09:00. Its first two slots overlap the 09:30 appointment.
    expect(open[0]).toEqual([at(DAY, "10:30").toISOString(), at(DAY, "11:15").toISOString()]);
    expect(open.every(([start, end]) => new Date(end).getTime() - new Date(start).getTime() === 45 * 60_000)).toBe(true);
  });

  it("a new booking cannot overlap the older, differently sized appointment (plan, Risks 3)", async () => {
    const existing = await book(w, S0930);
    await change(w.staffUser.id, 45);

    const overlapping = await send<ErrorJson>(bookRoute, "POST", w.staffUser.id, {
      body: { doctorId: w.doctor.id, patientId: w.patient.id, startsAt: at(DAY, "09:00").toISOString(), reasonForVisit: "Fictional reason" },
    });
    expect(overlapping.status).toBe(409);
    expect(overlapping.json.error.code).toBe("SLOT_TAKEN");
    expect((await row(existing)).status).toBe("requested");

    const free = await send(bookRoute, "POST", w.staffUser.id, {
      body: { doctorId: w.doctor.id, patientId: w.patient.id, startsAt: at(DAY, "10:30").toISOString(), reasonForVisit: "Fictional reason" },
    });
    expect(free.status).toBe(201);
  });

  it("an appointment that is off the new grid is not treated as affected by a later change of hours", async () => {
    const existing = await book(w, S0930);
    await change(w.staffUser.id, 45);
    // Longer hours remove nothing, so nothing is cancelled, on or off the grid.
    const { preview, applied } = await changeSchedule(w.staffUser.id, w.doctor.id, { kind: "working_hours", intervals: everyDay(480, 1080) });
    expect(preview.json.preview.count).toBe(0);
    expect(applied.status).toBe(201);
    expect((await row(existing)).status).toBe("requested");
  });

  it("refuses a length that is not a whole number of minutes from 5 to 480", async () => {
    for (const value of [0, 4, 481, 22.5, "30", null]) {
      const result = await change(w.staffUser.id, value);
      expect(result.status).toBe(422);
      expect(result.json.error.fields?.[0].field).toBe("slotLengthMinutes");
    }
    expect((await db.doctorProfile.findUniqueOrThrow({ where: { id: w.doctor.id } })).slotLengthMinutes).toBe(30);
  });
});
