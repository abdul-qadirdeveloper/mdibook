// The doctor profile and its open slots (R15, R17, R24, R26, R70, R96).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDateOf } from "@/domain/time";
import { db } from "@/lib/db";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createClinic, createDoctor, createPatient, createWorld } from "../../helpers/factories";
import { book, bookingBody, doctorProfile, slots } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
const DAY = 24 * 3_600_000;

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => {
  restoreClock();
});

describe("doctor profile (R15)", () => {
  it("shows name, specialty, clinic, address, clinic time zone, description and slot length, and nothing else", async () => {
    const result = await doctorProfile(w.patientUser.id, w.doctor.id);
    expect(result.status).toBe(200);
    expect(Object.keys(result.json.doctor).sort()).toEqual(
      ["clinicAddress", "clinicName", "description", "id", "name", "slotLengthMinutes", "specialty", "timeZone"].sort(),
    );
    expect(result.json.doctor).toMatchObject({
      id: w.doctor.id,
      name: w.doctor.name,
      clinicName: w.clinic.name,
      clinicAddress: "1 Sample Street, Testville, Exampleton",
      timeZone: "America/Chicago",
      description: "Fictional doctor for tests.",
      slotLengthMinutes: 30,
    });
    expect(JSON.stringify(result.json)).not.toMatch(/@example\.test|userId/);
  });

  it("tells a patient the clinic's window and limit, and how many upcoming appointments they hold there (R26)", async () => {
    expect((await doctorProfile(w.patientUser.id, w.doctor.id)).json.booking).toEqual({
      cancellationWindowHours: 24,
      maxUpcomingPerPatient: 3,
      upcomingCount: 0,
    });

    await book(w.patientUser.id, bookingBody(w.doctor.id, at("2026-10-14", "09:00")));
    // Somebody else's booking, and this patient's booking at another clinic, are not counted.
    const other = await createPatient();
    await book(other.user.id, bookingBody(w.doctor.id, at("2026-10-14", "10:00")));
    const elsewhere = await createClinic({ cancellationWindowHours: 48, maxUpcomingPerPatient: 5 });
    const { doctor: there } = await createDoctor(elsewhere.id);
    await book(w.patientUser.id, bookingBody(there.id, at("2026-10-14", "11:00")));
    await book(w.patientUser.id, bookingBody(there.id, at("2026-10-14", "11:30")));

    expect((await doctorProfile(w.patientUser.id, w.doctor.id)).json.booking?.upcomingCount).toBe(1);
    expect((await doctorProfile(w.patientUser.id, there.id)).json.booking).toEqual({
      cancellationWindowHours: 48,
      maxUpcomingPerPatient: 5,
      upcomingCount: 2,
    });
    // Staff and doctors are told nothing about any patient's count.
    expect((await doctorProfile(w.staffUser.id, w.doctor.id)).json.booking).toBeNull();
    expect((await doctorProfile(w.doctorUser.id, w.doctor.id)).json.booking).toBeNull();
  });

  it("a missing, malformed or deactivated doctor is not found", async () => {
    const { doctor: inactive } = await createDoctor(w.clinic.id, { active: false });
    for (const id of [inactive.id, "7f0c1f0e-3d0a-4b53-9d2e-0a1b2c3d4e5f", "not-an-id"]) {
      for (const result of [await doctorProfile(w.patientUser.id, id), await slots(w.patientUser.id, id)]) {
        expect(result.status, id).toBe(404);
        expect(result.json.error.code).toBe("NOT_FOUND");
      }
    }
  });
});

describe("open slots (R15)", () => {
  it("are UTC instants grouped by date, with the clinic time zone to show them in (R70)", async () => {
    const result = await slots(w.patientUser.id, w.doctor.id);
    expect(result.status).toBe(200);
    expect(Object.keys(result.json).sort()).toEqual(["days", "from", "hasLater", "timeZone", "to"]);
    expect(result.json.timeZone).toBe("America/Chicago");
    expect(result.json.from).toBe(NOW.toISOString());
    expect(result.json.to).toBe(new Date(NOW.getTime() + 14 * DAY).toISOString());

    // Monday 12 to Monday 26 October: 09:00 to 17:00 is 16 half-hour slots a day. The last day
    // is cut at 07:00, the hour the period started, so it has none.
    expect(result.json.days.map((day) => day.date)).toEqual(
      [...Array(14).keys()].map((i) => `2026-10-${12 + i}`),
    );
    for (const day of result.json.days) expect(day.slots, day.date).toHaveLength(16);
    expect(result.json.days[0].slots[0]).toEqual({
      startsAt: at("2026-10-12", "09:00").toISOString(),
      endsAt: at("2026-10-12", "09:30").toISOString(),
    });
    expect(result.json.days[0].slots[15].startsAt).toBe(at("2026-10-12", "16:30").toISOString());
    for (const slot of result.json.days[0].slots) expect(slot.startsAt).toMatch(/Z$/);
  });

  it("group by the clinic's calendar date, not the UTC date", async () => {
    // 18:00 to 23:00 in Chicago is 23:00 to 04:00 UTC the next day.
    const { doctor } = await createDoctor(w.clinic.id, {
      hours: [{ weekday: 3, startMinute: 18 * 60, endMinute: 23 * 60 }],
    });
    const result = await slots(w.patientUser.id, doctor.id);
    expect(result.json.days).toHaveLength(2);
    expect(result.json.days.map((day) => day.date)).toEqual(["2026-10-14", "2026-10-21"]);
    const wednesday = result.json.days[0];
    expect(wednesday.slots).toHaveLength(10);
    expect(wednesday.slots[9].startsAt).toBe("2026-10-15T03:30:00.000Z");
    for (const slot of wednesday.slots) {
      expect(localDateOf(new Date(slot.startsAt), "America/Chicago")).toBe("2026-10-14");
    }
  });

  it("leave out past times, breaks, time off and occupied slots (R24)", async () => {
    await db.break.create({
      data: { doctorId: w.doctor.id, clinicId: w.clinic.id, weekday: 1, startMinute: 12 * 60, endMinute: 13 * 60 },
    });
    await db.timeOff.create({
      data: {
        doctorId: w.doctor.id,
        clinicId: w.clinic.id,
        startsAt: at("2026-10-13", "00:00"),
        endsAt: at("2026-10-14", "00:00"),
        reasonCode: "training",
        createdById: w.staffUser.id,
      },
    });
    const other = await createPatient();
    await book(other.user.id, bookingBody(w.doctor.id, at("2026-10-12", "15:00")));

    // 10:15 on Monday: 09:00, 09:30 and 10:00 have started.
    freezeClock(at("2026-10-12", "10:15"));
    const result = await slots(w.patientUser.id, w.doctor.id);
    const monday = result.json.days[0];
    expect(monday.date).toBe("2026-10-12");
    const starts = monday.slots.map((slot) => slot.startsAt);
    expect(starts[0]).toBe(at("2026-10-12", "10:30").toISOString());
    for (const gone of ["12:00", "12:30", "15:00"]) {
      expect(starts).not.toContain(at("2026-10-12", gone).toISOString());
    }
    expect(starts).toHaveLength(13 - 3);
    // Tuesday is time off.
    expect(result.json.days[1].date).toBe("2026-10-14");
  });

  it("later dates load: the next period starts where the last one ended, up to 90 days ahead", async () => {
    const first = await slots(w.patientUser.id, w.doctor.id);
    expect(first.json.hasLater).toBe(true);

    const second = await slots(w.patientUser.id, w.doctor.id, { from: first.json.to });
    expect(second.json.from).toBe(first.json.to);
    expect(second.json.days[0].date).toBe("2026-10-26");
    expect(second.json.days[0].slots[0].startsAt).toBe(at("2026-10-26", "09:00").toISOString());
    const firstStarts = new Set(first.json.days.flatMap((day) => day.slots.map((slot) => slot.startsAt)));
    for (const day of second.json.days) for (const slot of day.slots) expect(firstStarts.has(slot.startsAt)).toBe(false);

    // The period that reaches the horizon offers nothing beyond it and says there is no more.
    const horizon = new Date(NOW.getTime() + 90 * DAY);
    const last = await slots(w.patientUser.id, w.doctor.id, {
      from: new Date(NOW.getTime() + 80 * DAY).toISOString(),
      to: new Date(NOW.getTime() + 100 * DAY).toISOString(),
    });
    expect(last.json.hasLater).toBe(false);
    const lastStarts = last.json.days.flatMap((day) => day.slots.map((slot) => Date.parse(slot.startsAt)));
    expect(lastStarts.length).toBeGreaterThan(0);
    expect(Math.max(...lastStarts)).toBeLessThanOrEqual(horizon.getTime());
  });

  it("a period that starts in the past starts now instead", async () => {
    const result = await slots(w.patientUser.id, w.doctor.id, {
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-13T00:00:00Z",
    });
    expect(result.json.from).toBe(NOW.toISOString());
    expect(result.json.days.map((day) => day.date)).toEqual(["2026-10-12"]);
  });

  it("a doctor with no open slots gets an empty list, not an error", async () => {
    const { doctor } = await createDoctor(w.clinic.id, { hours: [] });
    const result = await slots(w.patientUser.id, doctor.id);
    expect(result.status).toBe(200);
    expect(result.json.days).toEqual([]);
  });

  it("refuses a period that ends before it starts, is longer than 31 days, or is not an instant", async () => {
    const backwards = await slots(w.patientUser.id, w.doctor.id, {
      from: "2026-10-20T00:00:00Z",
      to: "2026-10-19T00:00:00Z",
    });
    expect(backwards.status).toBe(422);
    expect(backwards.json.error.fields).toEqual([{ field: "to", problem: "invalid" }]);

    const tooLong = await slots(w.patientUser.id, w.doctor.id, { to: "2026-12-20T00:00:00Z" });
    expect(tooLong.status).toBe(422);

    const notAnInstant = await slots(w.patientUser.id, w.doctor.id, { from: "next week" });
    expect(notAnInstant.status).toBe(422);
    expect(notAnInstant.json.error.fields).toEqual([{ field: "from", problem: "invalid" }]);
    expect(JSON.stringify(notAnInstant.json)).not.toContain("next week");
  });
});
