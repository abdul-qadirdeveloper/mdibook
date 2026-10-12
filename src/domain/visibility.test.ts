import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_FIELDS,
  type AppointmentField,
  canSee,
  canSeePastAppointment,
  pickVisible,
  visibleAppointmentFields,
} from "./visibility";

// The visibility table of spec section 2 (R59), written out row by row and independently of
// the implementation. P, D, S = patient (own), doctor (own appointment), staff (own clinic).
const TABLE: { row: string; fields: AppointmentField[]; P: boolean; D: boolean; S: boolean }[] = [
  {
    row: "Date, time, slot length",
    fields: ["id", "startsAt", "endsAt", "slotLengthMinutes", "timeZone", "cancellationDeadline"],
    P: true,
    D: true,
    S: true,
  },
  { row: "Status", fields: ["status", "cancelledBy"], P: true, D: true, S: true },
  {
    row: "Doctor, specialty, clinic, address",
    fields: ["doctorId", "doctorName", "specialty", "clinicId", "clinicName", "clinicAddress"],
    P: true,
    D: true,
    S: true,
  },
  { row: "Patient full name", fields: ["patientId", "patientName"], P: true, D: true, S: true },
  { row: "No-show count at the clinic", fields: ["noShowCount"], P: false, D: true, S: true },
  { row: "Patient phone and email", fields: ["patientPhone", "patientEmail"], P: true, D: false, S: true },
  { row: "Who booked and when", fields: ["bookedById", "bookedByRole", "bookedAt"], P: false, D: false, S: true },
  { row: "Reschedule and cancellation history", fields: ["history", "lateCancel"], P: false, D: false, S: true },
  { row: "Date of birth", fields: ["dateOfBirth"], P: true, D: false, S: false },
  { row: "Age only (F17)", fields: ["patientAge"], P: false, D: true, S: false },
  { row: "Reason for visit", fields: ["reasonForVisit"], P: true, D: true, S: false },
  {
    row: "Staff or schedule-change reason code",
    fields: ["cancelReasonCode", "cancelledByRole"],
    P: false,
    D: true,
    S: true,
  },
];

const expected = (column: "P" | "D" | "S") =>
  TABLE.filter((r) => r[column])
    .flatMap((r) => r.fields)
    .sort();

describe("field visibility by role (R59, R83)", () => {
  it("the table covers every field exactly once", () => {
    const listed = TABLE.flatMap((r) => r.fields);
    expect([...listed].sort()).toEqual([...APPOINTMENT_FIELDS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("the patient's field list equals the table", () => {
    expect(visibleAppointmentFields("patient").sort()).toEqual(expected("P"));
  });

  it("the doctor's field list equals the table", () => {
    expect(visibleAppointmentFields("doctor").sort()).toEqual(expected("D"));
  });

  it("the staff field list equals the table", () => {
    expect(visibleAppointmentFields("staff").sort()).toEqual(expected("S"));
  });

  it("an admin sees no field at all (R94)", () => {
    expect(visibleAppointmentFields("admin")).toEqual([]);
    for (const field of APPOINTMENT_FIELDS) expect(canSee("admin", field)).toBe(false);
  });

  it("staff never see the reason for visit or the date of birth (R20, R28)", () => {
    expect(canSee("staff", "reasonForVisit")).toBe(false);
    expect(canSee("staff", "dateOfBirth")).toBe(false);
    expect(canSee("staff", "patientAge")).toBe(false);
  });

  it("the doctor sees age, not date of birth, and no contact details", () => {
    expect(canSee("doctor", "patientAge")).toBe(true);
    expect(canSee("doctor", "dateOfBirth")).toBe(false);
    expect(canSee("doctor", "patientPhone")).toBe(false);
    expect(canSee("doctor", "patientEmail")).toBe(false);
  });

  it("the patient does not see the reason code, the late flag or the no-show count (R39, R55)", () => {
    for (const field of ["cancelReasonCode", "cancelledByRole", "lateCancel", "noShowCount", "history"] as const) {
      expect(canSee("patient", field)).toBe(false);
    }
  });
});

describe("pickVisible", () => {
  const full = Object.fromEntries(APPOINTMENT_FIELDS.map((f) => [f, `value of ${f}`])) as Record<
    AppointmentField,
    string
  >;

  it("returns exactly the role's fields", () => {
    for (const role of ["patient", "doctor", "staff"] as const) {
      expect(Object.keys(pickVisible(role, full)).sort()).toEqual(visibleAppointmentFields(role).sort());
    }
    expect(pickVisible("admin", full)).toEqual({});
  });

  it("drops keys that are not in the table, such as a whole database row would carry", () => {
    const row = { ...full, idempotencyKey: "k", scheduleChangeId: "s" };
    const picked = pickVisible("staff", row);
    expect(picked).not.toHaveProperty("idempotencyKey");
    expect(picked).not.toHaveProperty("scheduleChangeId");
    expect(picked).not.toHaveProperty("reasonForVisit");
  });
});

describe("past appointments at the clinic (R60)", () => {
  it("a doctor sees only those with themself; patient and staff see all; admin none", () => {
    expect(canSeePastAppointment("doctor", true)).toBe(true);
    expect(canSeePastAppointment("doctor", false)).toBe(false);
    expect(canSeePastAppointment("patient", false)).toBe(true);
    expect(canSeePastAppointment("staff", false)).toBe(true);
    expect(canSeePastAppointment("admin", true)).toBe(false);
  });
});
