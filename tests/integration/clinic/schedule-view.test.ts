// The daily and weekly schedule (R58). A doctor sees their own; staff choose a doctor of
// their clinic. Days are clinic dates, whatever the UTC date is.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as scheduleRoute } from "@/app/api/v1/clinic/schedule/route";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createDoctor, createPatient, createWorld, sessionFor } from "../../helpers/factories";
import { type Appointment, DAY, type ErrorJson, S0900, S1000, type World, book, send } from "./support";

interface Schedule {
  schedule: {
    doctorId: string;
    view: "day" | "week";
    timeZone: string;
    from: string;
    to: string;
    days: { date: string; appointments: Appointment[] }[];
  };
}

let w: World;
let first: string;
let second: string;
let evening: string;
let friday: string;
let nextWeek: string;

const read = (userId: string, query: string) => send<Schedule & ErrorJson>(scheduleRoute, "GET", userId, { query });
const ids = (day: { appointments: Appointment[] }) => day.appointments.map((a) => a.id);

beforeEach(async () => {
  await resetDb();
  // Open until 23:00, so one appointment falls on the next UTC date.
  w = await createWorld({ doctor: { hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1380 })) } });
  freezeClock(NOW);
  const { user, patient } = await createPatient();
  const otherPatient = { by: await sessionFor(user.id), patientId: patient.id };
  second = await book(w, S1000);
  first = await book(w, S0900, { by: w.staffSession });
  evening = await book(w, at(DAY, "22:00"), otherPatient);
  friday = await book(w, at("2026-10-16", "09:00"));
  nextWeek = await book(w, at("2026-10-19", "09:00"), otherPatient);
});

afterEach(() => restoreClock());

describe("the daily schedule", () => {
  it("lists the doctor's appointments of that clinic date in time order", async () => {
    const result = await read(w.staffUser.id, `doctorId=${w.doctor.id}&view=day&date=${DAY}`);
    expect(result.status).toBe(200);
    const { schedule } = result.json;
    expect(schedule).toMatchObject({
      doctorId: w.doctor.id,
      view: "day",
      timeZone: "America/Chicago",
      from: at(DAY, "00:00").toISOString(),
      to: at("2026-10-15", "00:00").toISOString(),
    });
    expect(schedule.days).toHaveLength(1);
    expect(schedule.days[0].date).toBe(DAY);
    // 22:00 in Chicago is already 15 October in UTC. It belongs to the 14th at the clinic.
    expect(ids(schedule.days[0])).toEqual([first, second, evening]);
    expect(schedule.days[0].appointments[2].startsAt).toBe("2026-10-15T03:00:00.000Z");
  });

  it("a doctor sees their own without naming themself, and it defaults to a day view of today", async () => {
    freezeClock(at(DAY, "08:00"));
    const result = await read(w.doctorUser.id, "");
    expect(result.status).toBe(200);
    expect(result.json.schedule).toMatchObject({ doctorId: w.doctor.id, view: "day" });
    expect(result.json.schedule.days[0].date).toBe(DAY);
    expect(ids(result.json.schedule.days[0])).toEqual([first, second, evening]);
  });

  it("shows cancelled and finished appointments too, with their status", async () => {
    const { changeAppointmentStatus } = await import("@/lib/appointments/core");
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: second, to: "cancelled", reasonCode: "patient_request" }, NOW);
    const result = await read(w.staffUser.id, `doctorId=${w.doctor.id}&date=${DAY}`);
    expect(result.json.schedule.days[0].appointments.map((a) => a.status)).toEqual(["confirmed", "cancelled", "requested"]);
  });

  it("an empty day is an empty list", async () => {
    const result = await read(w.staffUser.id, `doctorId=${w.doctor.id}&date=2026-10-13`);
    expect(result.json.schedule.days).toEqual([{ date: "2026-10-13", appointments: [] }]);
  });
});

describe("the weekly schedule", () => {
  it("covers Monday to Sunday of the week the date is in, one entry per clinic date", async () => {
    const result = await read(w.doctorUser.id, `view=week&date=${DAY}`);
    const { schedule } = result.json;
    expect(schedule.view).toBe("week");
    expect(schedule.days.map((d) => d.date)).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18",
    ]);
    expect(schedule.from).toBe(at("2026-10-12", "00:00").toISOString());
    expect(schedule.to).toBe(at("2026-10-19", "00:00").toISOString());
    expect(schedule.days.map((d) => ids(d))).toEqual([[], [], [first, second, evening], [], [friday], [], []]);
    // The Monday after is in the next week.
    expect(schedule.days.flatMap((d) => ids(d))).not.toContain(nextWeek);
  });

  it("a week with a clock change still runs midnight to midnight at the clinic", async () => {
    // Clocks go back in Chicago on Sunday 1 November 2026, so that week is an hour longer.
    const result = await read(w.doctorUser.id, "view=week&date=2026-10-28");
    const { from, to } = result.json.schedule;
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe((7 * 24 + 1) * 3_600_000);
  });
});

describe("whose schedule (R58)", () => {
  it("staff must choose a doctor, and can choose any doctor of their clinic", async () => {
    const missing = await read(w.staffUser.id, `view=day&date=${DAY}`);
    expect(missing.status).toBe(422);
    expect(missing.json.error.fields).toEqual([{ field: "doctorId", problem: "required" }]);

    const colleague = await createDoctor(w.clinic.id);
    const { patient } = await createPatient();
    const theirs = await book(w, S0900, { by: w.staffSession, doctorId: colleague.doctor.id, patientId: patient.id });
    const result = await read(w.staffUser.id, `doctorId=${colleague.doctor.id}&date=${DAY}`);
    expect(result.status).toBe(200);
    expect(ids(result.json.schedule.days[0])).toEqual([theirs]);
  });

  it("a doctor cannot open a colleague's schedule: it is not found (R60)", async () => {
    const colleague = await createDoctor(w.clinic.id);
    const result = await read(colleague.user.id, `doctorId=${w.doctor.id}&date=${DAY}`);
    expect(result.status).toBe(404);
    // Their own is empty: none of the other doctor's appointments leak into it.
    const own = await read(colleague.user.id, `date=${DAY}`);
    expect(own.json.schedule.days[0].appointments).toEqual([]);
  });

  it("refuses a view or a date that is not valid, without repeating it", async () => {
    for (const query of ["view=month", "date=14-10-2026", "date=2026-02-30", "doctorId=someone"]) {
      const result = await read(w.doctorUser.id, query);
      expect(result.status).toBe(422);
      expect(JSON.stringify(result.json.error.fields)).not.toMatch(/month|14-10|02-30|someone/);
    }
  });
});
