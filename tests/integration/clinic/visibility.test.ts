// What each role sees (R59, R60, R61, R66, R84). Response keys per role equal the visibility
// table; a doctor sees nothing of another doctor's appointments; the no-show count is for
// this clinic only; the history staff see comes from appointment history.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as readRoute } from "@/app/api/v1/appointments/[id]/route";
import { GET as patientRoute } from "@/app/api/v1/clinic/patients/[patientId]/route";
import { GET as scheduleRoute } from "@/app/api/v1/clinic/schedule/route";
import { visibleAppointmentFields } from "@/domain/visibility";
import { changeAppointmentStatus, rescheduleAppointment } from "@/lib/appointments/core";
import { db } from "@/lib/db";
import { NOW, freezeClock, minutesAfter, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createDoctor, createWorld, sessionFor } from "../../helpers/factories";
import { type Appointment, DAY, type ErrorJson, S0900, S0930, S1000, type World, book, otherClinic, send } from "./support";

interface Record_ {
  patient: Record<string, unknown>;
  appointments: Appointment[];
}

let w: World;
const keys = (o: object) => Object.keys(o).sort();
const fields = (role: "doctor" | "staff") => [...visibleAppointmentFields(role)].sort();
const dayOf = async (userId: string, doctorId: string) => {
  const result = await send<{ schedule: { days: { appointments: Appointment[] }[] } }>(scheduleRoute, "GET", userId, {
    query: `doctorId=${doctorId}&date=${DAY}`,
  });
  return result.json.schedule.days[0].appointments;
};

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("response fields per role (R59)", () => {
  it("the schedule gives staff and the doctor exactly their field lists", async () => {
    await book(w, S0900);
    const [forStaff] = await dayOf(w.staffUser.id, w.doctor.id);
    const [forDoctor] = await dayOf(w.doctorUser.id, w.doctor.id);
    expect(keys(forStaff)).toEqual(fields("staff"));
    expect(keys(forDoctor)).toEqual(fields("doctor"));
  });

  it("staff see contact details and who booked, never the visit reason or the date of birth", async () => {
    await book(w, S0900);
    const [a] = await dayOf(w.staffUser.id, w.doctor.id);
    expect(a).toMatchObject({ patientPhone: "555-0100", bookedByRole: "patient", bookedById: w.patientUser.id, lateCancel: false });
    expect(a.patientEmail).toMatch(/@example\.test$/);
    for (const hidden of ["reasonForVisit", "dateOfBirth", "patientAge"]) expect(a).not.toHaveProperty(hidden);
    expect(JSON.stringify(a)).not.toMatch(/Fictional reason|1990-05-17/);
  });

  it("the doctor sees the visit reason and the age only, never contact details or history", async () => {
    await book(w, S0900);
    const [a] = await dayOf(w.doctorUser.id, w.doctor.id);
    expect(a).toMatchObject({ reasonForVisit: "Fictional reason", patientAge: 36 });
    for (const hidden of ["dateOfBirth", "patientPhone", "patientEmail", "history", "bookedById", "bookedAt", "lateCancel"]) {
      expect(a).not.toHaveProperty(hidden);
    }
    expect(JSON.stringify(a)).not.toMatch(/555-0100|example\.test|1990-05-17/);
  });
});

describe("another doctor's appointments (R60)", () => {
  it("are not found, and never appear in a colleague's schedule or patient record", async () => {
    const colleague = await createDoctor(w.clinic.id);
    const id = await book(w, S0900);

    const read = await send<ErrorJson>(readRoute, "GET", colleague.user.id, { params: { id } });
    expect(read.status).toBe(404);
    expect(read.json.error.code).toBe("NOT_FOUND");
    expect(await dayOf(colleague.user.id, colleague.doctor.id)).toEqual([]);

    const record = await send<ErrorJson>(patientRoute, "GET", colleague.user.id, { params: { patientId: w.patient.id } });
    expect(record.status).toBe(404);
  });

  it("a doctor's patient record holds only the appointments with themself; staff see the clinic's", async () => {
    const colleague = await createDoctor(w.clinic.id);
    const mine = await book(w, S0900);
    const theirs = await book(w, S0930, { doctorId: colleague.doctor.id });
    const params = { params: { patientId: w.patient.id } };

    const forDoctor = await send<Record_>(patientRoute, "GET", w.doctorUser.id, params);
    expect(forDoctor.status).toBe(200);
    expect(forDoctor.json.appointments.map((a) => a.id)).toEqual([mine]);
    expect(keys(forDoctor.json.patient)).toEqual(["noShowCount", "patientAge", "patientId", "patientName"]);
    expect(keys(forDoctor.json.appointments[0])).toEqual(fields("doctor"));

    const forStaff = await send<Record_>(patientRoute, "GET", w.staffUser.id, params);
    expect(forStaff.json.appointments.map((a) => a.id)).toEqual([theirs, mine]);
    expect(keys(forStaff.json.patient)).toEqual(["noShowCount", "patientEmail", "patientId", "patientName", "patientPhone"]);
    // Staff see past appointments without the visit reason.
    for (const a of forStaff.json.appointments) expect(keys(a)).toEqual(fields("staff"));
    expect(JSON.stringify(forStaff.json)).not.toMatch(/Fictional reason|1990-05-17/);
  });
});

describe("other clinics (R61, R66)", () => {
  it("the no-show count is for this clinic only, and nothing from the other clinic is shown", async () => {
    const other = await otherClinic();
    // One no-show here and one at the other clinic, both in the past by the time we look.
    const here = await book(w, S0900);
    const there = await book(w, S0900, { by: other.staffSession, doctorId: other.doctor.id });
    const later = minutesAfter(S0900, 1);
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: here, to: "no_show" }, later);
    await changeAppointmentStatus({ actor: other.staffSession, appointmentId: there, to: "no_show" }, later);
    const upcoming = await book(w, S1000, { now: later });
    freezeClock(later);

    for (const userId of [w.staffUser.id, w.doctorUser.id]) {
      const read = await send<{ appointment: Appointment }>(readRoute, "GET", userId, { params: { id: upcoming } });
      expect(read.json.appointment.noShowCount).toBe(1);
      const record = await send<Record_>(patientRoute, "GET", userId, { params: { patientId: w.patient.id } });
      expect(record.json.patient.noShowCount).toBe(1);
      expect(record.json.appointments.map((a) => a.id).sort()).toEqual([here, upcoming].sort());
      expect(JSON.stringify(record.json)).not.toContain(there);
      expect(JSON.stringify(record.json)).not.toContain(other.clinic.id);
    }

    // And the other clinic sees its own one no-show, not ours.
    const theirs = await send<Record_>(patientRoute, "GET", other.staffUser.id, { params: { patientId: w.patient.id } });
    expect(theirs.json.patient.noShowCount).toBe(1);
    expect(theirs.json.appointments.map((a) => a.id)).toEqual([there]);
  });

  it("the count is a number only: no list of the missed appointments comes with it", async () => {
    const id = await book(w, S0900);
    const read = await send<{ appointment: Appointment }>(readRoute, "GET", w.doctorUser.id, { params: { id } });
    expect(read.json.appointment.noShowCount).toBe(0);
    expect(typeof read.json.appointment.noShowCount).toBe("number");
  });
});

describe("the history staff see (R84)", () => {
  it("is the appointment's own history: who booked, each move, the cancellation and its reason", async () => {
    const id = await book(w, S0900, { by: w.staffSession });
    await rescheduleAppointment({ actor: w.doctorSession, appointmentId: id, newStart: S1000 }, minutesAfter(NOW, 1));
    await changeAppointmentStatus(
      { actor: w.staffSession, appointmentId: id, to: "cancelled", reasonCode: "patient_request" },
      minutesAfter(NOW, 2),
    );

    const read = await send<{ appointment: Appointment & { history: Record<string, unknown>[] } }>(readRoute, "GET", w.staffUser.id, { params: { id } });
    const { appointment } = read.json;
    expect(appointment).toMatchObject({ bookedById: w.staffUser.id, bookedByRole: "staff", bookedAt: NOW.toISOString() });
    expect(appointment.history.map((h) => h.action)).toEqual(["booked", "rescheduled", "cancelled"]);
    expect(appointment.history[1]).toMatchObject({ actorId: w.doctorUser.id, actorRole: "doctor", oldStartsAt: S0900.toISOString(), newStartsAt: S1000.toISOString() });
    expect(appointment.history[2]).toMatchObject({ actorRole: "staff", reasonCode: "patient_request" });

    // Row for row the AppointmentHistory table, which holds ids and codes and no free text.
    const stored = await db.appointmentHistory.findMany({ where: { appointmentId: id }, orderBy: { at: "asc" } });
    expect(appointment.history).toHaveLength(stored.length);
    expect(keys(appointment.history[0])).toEqual(["action", "actorId", "actorRole", "at", "newStartsAt", "oldStartsAt", "reasonCode"]);

    const forDoctor = await send<{ appointment: Appointment }>(readRoute, "GET", w.doctorUser.id, { params: { id } });
    expect(forDoctor.json.appointment).not.toHaveProperty("history");
  });

  it("is not shown to staff of another clinic, who cannot find the appointment at all", async () => {
    const other = await otherClinic();
    const id = await book(w, S0900);
    const read = await send<ErrorJson>(readRoute, "GET", other.staffUser.id, { params: { id } });
    expect(read.status).toBe(404);
    expect(await sessionFor(other.staffUser.id)).toMatchObject({ clinicId: other.clinic.id });
  });
});
