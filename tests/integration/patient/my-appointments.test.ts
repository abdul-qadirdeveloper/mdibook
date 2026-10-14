// My appointments (R44, R45, R47, R55, R61): a patient's own upcoming and past appointments
// across all clinics, and nobody else's.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleAppointmentFields } from "@/domain/visibility";
import { changeAppointmentStatus } from "@/lib/appointments/core";
import { db } from "@/lib/db";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createAdmin, createClinic, createDoctor, createPatient, createStaff, createWorld, sessionFor } from "../../helpers/factories";
import { REASON, book, bookingBody, cancel, myAppointments, read } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
const NEW_YORK = "America/New_York";

const idsOf = (result: { json: { items: { appointment: { id: string } }[] } }) =>
  result.json.items.map((item) => item.appointment.id);
const bookId = async (userId: string, doctorId: string, start: Date) => {
  const result = await book(userId, bookingBody(doctorId, start));
  expect(result.status).toBe(201);
  return result.json.appointment.id;
};

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => {
  restoreClock();
});

describe("whose appointments (R45, R61)", () => {
  it("the patient's own, across all clinics, and nobody else's", async () => {
    const elsewhere = await createClinic({ timeZone: NEW_YORK });
    const { doctor: there } = await createDoctor(elsewhere.id);
    const other = await createPatient();

    const mineHere = await bookId(w.patientUser.id, w.doctor.id, at("2026-10-14", "09:00"));
    const mineThere = await bookId(w.patientUser.id, there.id, at("2026-10-15", "09:00", NEW_YORK));
    const theirsHere = await bookId(other.user.id, w.doctor.id, at("2026-10-14", "10:00"));
    const theirsThere = await bookId(other.user.id, there.id, at("2026-10-15", "10:00", NEW_YORK));

    const mine = await myAppointments(w.patientUser.id);
    expect(mine.status).toBe(200);
    expect(idsOf(mine)).toEqual([mineHere, mineThere]);
    expect(mine.json.total).toBe(2);
    expect(mine.json.items.map((item) => item.appointment.timeZone)).toEqual(["America/Chicago", NEW_YORK]);

    const theirs = await myAppointments(other.user.id);
    expect(idsOf(theirs)).toEqual([theirsHere, theirsThere]);

    // Nothing of the other patient is anywhere in the response.
    const text = JSON.stringify(mine.json);
    for (const hidden of [other.patient.id, other.patient.fullName, other.user.email, theirsHere, theirsThere]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("comes from the session only: a patient id sent by the client is refused, not used (R7)", async () => {
    const other = await createPatient();
    const theirs = await bookId(other.user.id, w.doctor.id, at("2026-10-14", "10:00"));
    const attempts: Record<string, string>[] = [{ patientId: other.patient.id }, { userId: other.user.id }];
    for (const query of attempts) {
      const result = await myAppointments(w.patientUser.id, query);
      expect(result.status).toBe(422);
      expect(JSON.stringify(result.json)).not.toContain(theirs);
    }
    expect(idsOf(await myAppointments(w.patientUser.id))).toEqual([]);
  });

  it("is for patients: no session is 401, and staff, doctors and admins are 403", async () => {
    await bookId(w.patientUser.id, w.doctor.id, at("2026-10-14", "09:00"));
    expect((await myAppointments(undefined)).status).toBe(401);
    const admin = await createAdmin();
    for (const userId of [w.staffUser.id, w.doctorUser.id, admin.id]) {
      const result = await myAppointments(userId);
      expect(result.status).toBe(403);
      expect(result.json.items).toBeUndefined();
    }
  });

  it("a patient with none gets an empty list", async () => {
    for (const scope of ["upcoming", "past"]) {
      const result = await myAppointments(w.patientUser.id, { scope });
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ items: [], total: 0, nextCursor: null });
    }
  });
});

describe("what each appointment shows (R45, R46, R83)", () => {
  it("date, time, doctor, specialty, clinic, address, status and the deadline, from the patient's field list", async () => {
    const id = await bookId(w.patientUser.id, w.doctor.id, at("2026-10-14", "09:00"));
    const a = (await myAppointments(w.patientUser.id)).json.items[0].appointment;
    expect(Object.keys(a).sort()).toEqual(visibleAppointmentFields("patient").sort());
    expect(a).toMatchObject({
      id,
      startsAt: at("2026-10-14", "09:00").toISOString(),
      endsAt: at("2026-10-14", "09:30").toISOString(),
      timeZone: "America/Chicago",
      doctorName: w.doctor.name,
      clinicName: w.clinic.name,
      clinicAddress: "1 Sample Street, Testville, Exampleton",
      status: "requested",
      // The last moment to reschedule, or to cancel without a late mark (R26).
      cancellationDeadline: at("2026-10-13", "09:00").toISOString(),
      reasonForVisit: REASON,
    });
    expect(typeof a.specialty).toBe("string");
    // Staff-only fields never reach the patient.
    for (const hidden of ["lateCancel", "history", "bookedById", "cancelReasonCode", "cancelledByRole", "noShowCount"]) {
      expect(a).not.toHaveProperty(hidden);
    }
  });
});

describe("upcoming and past (R45, R47)", () => {
  it("upcoming is active and in the future, soonest first; everything else is past, most recent first", async () => {
    const d = w.doctor.id;
    await db.clinic.update({ where: { id: w.clinic.id }, data: { maxUpcomingPerPatient: 10 } });
    const soon = await bookId(w.patientUser.id, d, at("2026-10-13", "09:00"));
    const later = await bookId(w.patientUser.id, d, at("2026-10-20", "09:00"));
    const toCancel = await bookId(w.patientUser.id, d, at("2026-10-22", "09:00"));
    await cancel(w.patientUser.id, toCancel);
    const toAttend = await bookId(w.patientUser.id, d, at("2026-10-14", "09:00"));
    const toMiss = await bookId(w.patientUser.id, d, at("2026-10-15", "09:00"));

    expect(idsOf(await myAppointments(w.patientUser.id, { scope: "upcoming" }))).toEqual([soon, toAttend, toMiss, later]);
    expect(idsOf(await myAppointments(w.patientUser.id, { scope: "past" }))).toEqual([toCancel]);

    // Friday 16 October: three have started. Staff record two outcomes; one is left as it was.
    const friday = at("2026-10-16", "12:00");
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: toAttend, to: "completed" }, friday);
    await changeAppointmentStatus({ actor: w.doctorSession, appointmentId: toMiss, to: "no_show" }, friday);
    freezeClock(friday);

    const upcoming = await myAppointments(w.patientUser.id, { scope: "upcoming" });
    expect(idsOf(upcoming)).toEqual([later]);
    const past = await myAppointments(w.patientUser.id, { scope: "past" });
    expect(idsOf(past)).toEqual([toCancel, toMiss, toAttend, soon]);
    expect(past.json.total).toBe(4);

    // The values behind the labels of R47: Cancelled by you, Missed, Attended, Requested.
    expect(past.json.items.map((item) => [item.appointment.status, item.appointment.cancelledBy])).toEqual([
      ["cancelled", "patient"],
      ["no_show", null],
      ["completed", null],
      ["requested", null],
    ]);
  });

  it("the scope must be upcoming or past", async () => {
    const result = await myAppointments(w.patientUser.id, { scope: "all" });
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([{ field: "scope", problem: "invalid" }]);
  });

  it("a long history comes 50 at a time", async () => {
    await db.clinicPatient.create({ data: { clinicId: w.clinic.id, patientId: w.patient.id } });
    await db.appointment.createMany({
      data: [...Array(55).keys()].map((i) => {
        const start = new Date(at("2026-06-01", "09:00").getTime() + i * 24 * 3_600_000);
        return {
          clinicId: w.clinic.id,
          doctorId: w.doctor.id,
          patientId: w.patient.id,
          startsAt: start,
          endsAt: new Date(start.getTime() + 30 * 60_000),
          status: "completed" as const,
          reasonForVisit: "Fictional",
          bookedById: w.patientUser.id,
          bookedByRole: "patient" as const,
        };
      }),
    });
    const first = await myAppointments(w.patientUser.id, { scope: "past" });
    expect(first.json.items).toHaveLength(50);
    expect(first.json.total).toBe(55);
    expect(first.json.nextCursor).toBe("50");
    const second = await myAppointments(w.patientUser.id, { scope: "past", cursor: first.json.nextCursor! });
    expect(second.json.items).toHaveLength(5);
    expect(second.json.nextCursor).toBeNull();
    const all = [...idsOf(first), ...idsOf(second)];
    expect(new Set(all).size).toBe(55);
    const starts = [...first.json.items, ...second.json.items].map((item) => Date.parse(item.appointment.startsAt));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));

    const bad = await myAppointments(w.patientUser.id, { scope: "past", cursor: "-1" });
    expect(bad.status).toBe(422);
  });
});

describe("who cancelled (R44, R55)", () => {
  it("'patient' when the patient cancelled, 'clinic' when staff or the doctor did, and never the reason code", async () => {
    const byMe = await bookId(w.patientUser.id, w.doctor.id, at("2026-10-14", "09:00"));
    const byStaff = await bookId(w.patientUser.id, w.doctor.id, at("2026-10-15", "09:00"));
    const byDoctor = await bookId(w.patientUser.id, w.doctor.id, at("2026-10-16", "09:00"));
    await cancel(w.patientUser.id, byMe);
    await changeAppointmentStatus(
      { actor: w.staffSession, appointmentId: byStaff, to: "cancelled", reasonCode: "booked_in_error" },
      NOW,
    );
    await changeAppointmentStatus(
      { actor: w.doctorSession, appointmentId: byDoctor, to: "cancelled", reasonCode: "doctor_unavailable" },
      NOW,
    );

    const past = await myAppointments(w.patientUser.id, { scope: "past" });
    expect(past.json.items.map((item) => [item.appointment.id, item.appointment.cancelledBy])).toEqual([
      [byDoctor, "clinic"],
      [byStaff, "clinic"],
      [byMe, "patient"],
    ]);
    // The patient sees a neutral result: no reason code, and not which clinic role it was.
    const text = JSON.stringify(past.json);
    expect(text).not.toMatch(/booked_in_error|doctor_unavailable|cancelReasonCode|cancelledByRole/);
    expect(text).not.toMatch(/"staff"|"doctor"/);
  });
});

describe("other clinics' people see none of it (R61)", () => {
  it("staff of another clinic cannot read a patient's appointment at this one", async () => {
    const id = await bookId(w.patientUser.id, w.doctor.id, at("2026-10-14", "09:00"));
    const elsewhere = await createStaff((await createClinic()).id);
    const session = await sessionFor(elsewhere.user.id);
    expect(session.clinicId).not.toBe(w.clinic.id);
    const result = await read(elsewhere.user.id, id);
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.json)).not.toContain(w.patient.fullName);
  });
});
