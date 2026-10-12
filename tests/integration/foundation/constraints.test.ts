// Rules the database itself enforces, proven by inserting rows directly, without the
// application code. Runs against the migrated database on every test run, so a later
// migration that drops a hand-written constraint fails here (plan, Risks 8).
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { expectDbError, resetDb } from "../../helpers/db";
import { createClinic, createDoctor, createPatient, createStaff } from "../../helpers/factories";

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";
const SLOT_INDEX = "Appointment_one_active_per_doctor_start";

let clinicId: string;
let otherClinicId: string;
let doctorId: string;
let secondDoctorId: string;
let otherClinicDoctorId: string;
let patientId: string;
let patientUserId: string;

interface Row {
  doctorId?: string;
  clinicId?: string;
  startsAt: string;
  endsAt: string;
  status?: "requested" | "confirmed" | "cancelled" | "completed" | "no_show";
}

/** Inserts an appointment with plain SQL, as any client of the database could. */
async function insertAppointment(row: Row): Promise<string> {
  const status = row.status ?? "requested";
  const cancelledBy = status === "cancelled" ? "staff" : null;
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "Appointment"
      ("clinicId", "doctorId", "patientId", "startsAt", "endsAt", "status", "reasonForVisit",
       "bookedById", "bookedByRole", "cancelledByRole")
    VALUES
      (${row.clinicId ?? clinicId}::uuid, ${row.doctorId ?? doctorId}::uuid, ${patientId}::uuid,
       ${row.startsAt}::timestamptz, ${row.endsAt}::timestamptz, ${status}::"AppointmentStatus",
       'Fictional visit', ${patientUserId}::uuid, 'patient', ${cancelledBy}::"Role")
    RETURNING "id"`;
  return rows[0].id;
}

beforeAll(async () => {
  await resetDb();
  const clinic = await createClinic();
  const other = await createClinic();
  clinicId = clinic.id;
  otherClinicId = other.id;
  doctorId = (await createDoctor(clinic.id)).doctor.id;
  secondDoctorId = (await createDoctor(clinic.id)).doctor.id;
  otherClinicDoctorId = (await createDoctor(other.id)).doctor.id;
  const { user, patient } = await createPatient();
  patientId = patient.id;
  patientUserId = user.id;
  await createStaff(clinic.id);
});

describe("no double booking (R22, R30): one active appointment per doctor and start time", () => {
  it("has the partial unique index, limited to requested and confirmed", async () => {
    const rows = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${SLOT_INDEX}`;
    expect(rows).toHaveLength(1);
    const definition = rows[0].indexdef;
    expect(definition).toContain("CREATE UNIQUE INDEX");
    expect(definition).toContain('("doctorId", "startsAt")');
    expect(definition).toMatch(/WHERE .*requested.*confirmed/);
    expect(definition).not.toMatch(/cancelled|completed|no_show/);
  });

  it("refuses a second active appointment for the same doctor and start", async () => {
    await insertAppointment({ startsAt: "2026-11-02T15:00:00Z", endsAt: "2026-11-02T15:30:00Z" });
    const error = await expectDbError(() =>
      insertAppointment({ startsAt: "2026-11-02T15:00:00Z", endsAt: "2026-11-02T15:30:00Z" }),
    );
    expect(error.sqlState).toBe(UNIQUE_VIOLATION);
    expect(error.text).toContain(SLOT_INDEX);
    const count = await db.appointment.count({ where: { doctorId, startsAt: new Date("2026-11-02T15:00:00Z") } });
    expect(count).toBe(1);
  });

  it("treats requested and confirmed alike: each blocks the other", async () => {
    await insertAppointment({ startsAt: "2026-11-02T16:00:00Z", endsAt: "2026-11-02T16:30:00Z", status: "confirmed" });
    const first = await expectDbError(() =>
      insertAppointment({ startsAt: "2026-11-02T16:00:00Z", endsAt: "2026-11-02T16:30:00Z", status: "requested" }),
    );
    expect(first.sqlState).toBe(UNIQUE_VIOLATION);
    const second = await expectDbError(() =>
      insertAppointment({ startsAt: "2026-11-02T16:00:00Z", endsAt: "2026-11-02T16:30:00Z", status: "confirmed" }),
    );
    expect(second.sqlState).toBe(UNIQUE_VIOLATION);
  });

  it("compares instants: the same moment written with another offset is the same start", async () => {
    await insertAppointment({ startsAt: "2026-11-02T17:00:00Z", endsAt: "2026-11-02T17:30:00Z" });
    const error = await expectDbError(() =>
      insertAppointment({ startsAt: "2026-11-02T11:00:00-06:00", endsAt: "2026-11-02T11:30:00-06:00" }),
    );
    expect(error.sqlState).toBe(UNIQUE_VIOLATION);
  });

  it("allows the same start for a different doctor", async () => {
    await insertAppointment({ startsAt: "2026-11-02T18:00:00Z", endsAt: "2026-11-02T18:30:00Z" });
    await expect(
      insertAppointment({
        doctorId: secondDoctorId,
        startsAt: "2026-11-02T18:00:00Z",
        endsAt: "2026-11-02T18:30:00Z",
      }),
    ).resolves.toBeTruthy();
  });

  it("does not count cancelled, completed or no-show appointments", async () => {
    for (const status of ["cancelled", "completed", "no_show"] as const) {
      await insertAppointment({ startsAt: "2026-11-02T19:00:00Z", endsAt: "2026-11-02T19:30:00Z", status });
    }
    await expect(
      insertAppointment({ startsAt: "2026-11-02T19:00:00Z", endsAt: "2026-11-02T19:30:00Z" }),
    ).resolves.toBeTruthy();
  });

  it("frees the slot when the appointment is cancelled (R31)", async () => {
    const id = await insertAppointment({ startsAt: "2026-11-02T20:00:00Z", endsAt: "2026-11-02T20:30:00Z" });
    await db.$executeRaw`
      UPDATE "Appointment" SET "status" = 'cancelled', "cancelledByRole" = 'patient' WHERE "id" = ${id}::uuid`;
    await expect(
      insertAppointment({ startsAt: "2026-11-02T20:00:00Z", endsAt: "2026-11-02T20:30:00Z" }),
    ).resolves.toBeTruthy();
  });

  it("refuses moving an appointment onto an occupied start, and leaves it where it was (R33)", async () => {
    await insertAppointment({ startsAt: "2026-11-03T15:00:00Z", endsAt: "2026-11-03T15:30:00Z" });
    const moving = await insertAppointment({ startsAt: "2026-11-03T16:00:00Z", endsAt: "2026-11-03T16:30:00Z" });
    const error = await expectDbError(
      () => db.$executeRaw`
        UPDATE "Appointment"
        SET "startsAt" = '2026-11-03T15:00:00Z', "endsAt" = '2026-11-03T15:30:00Z'
        WHERE "id" = ${moving}::uuid`,
    );
    expect(error.sqlState).toBe(UNIQUE_VIOLATION);
    const row = await db.appointment.findUniqueOrThrow({ where: { id: moving } });
    expect(row.startsAt.toISOString()).toBe("2026-11-03T16:00:00.000Z");
  });

  it("refuses reactivating a cancelled appointment onto an occupied start", async () => {
    const cancelled = await insertAppointment({
      startsAt: "2026-11-03T17:00:00Z",
      endsAt: "2026-11-03T17:30:00Z",
      status: "cancelled",
    });
    await insertAppointment({ startsAt: "2026-11-03T17:00:00Z", endsAt: "2026-11-03T17:30:00Z" });
    const error = await expectDbError(
      () => db.$executeRaw`
        UPDATE "Appointment" SET "status" = 'requested', "cancelledByRole" = NULL WHERE "id" = ${cancelled}::uuid`,
    );
    expect(error.sqlState).toBe(UNIQUE_VIOLATION);
  });

  it("covers equal start times only: an overlap with a different start is left to the application", async () => {
    // Decided for the MVP (plan.md, Options rejected: exclusion constraint). The index does
    // not see a 09:15 appointment overlapping a 09:00 one. src/lib/appointments/core.ts
    // refuses that overlap in its slot re-check; core.test.ts proves it.
    await insertAppointment({ startsAt: "2026-11-04T15:00:00Z", endsAt: "2026-11-04T15:30:00Z" });
    await expect(
      insertAppointment({ startsAt: "2026-11-04T15:15:00Z", endsAt: "2026-11-04T15:35:00Z" }),
    ).resolves.toBeTruthy();
  });
});

describe("tenancy (R3, R5)", () => {
  it("requires a clinic on appointment, schedule, doctor and staff rows", async () => {
    const rows = await db.$queryRaw<{ table_name: string; is_nullable: string }[]>`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'clinicId'`;
    const required = rows.filter((r) => r.is_nullable === "NO").map((r) => r.table_name).sort();
    expect(required).toEqual(
      expect.arrayContaining([
        "Appointment",
        "AppointmentHistory",
        "Break",
        "ClinicPatient",
        "DoctorProfile",
        "ScheduleChange",
        "StaffProfile",
        "TimeOff",
        "WorkingHours",
      ]),
    );
    // Only an audit event may have no clinic (R81).
    expect(rows.filter((r) => r.is_nullable === "YES").map((r) => r.table_name)).toEqual(["AuditEvent"]);
  });

  it("refuses a row with no clinic", async () => {
    const error = await expectDbError(
      () => db.$executeRaw`
        INSERT INTO "WorkingHours" ("doctorId", "clinicId", "weekday", "startMinute", "endMinute")
        VALUES (${doctorId}::uuid, NULL, 1, 540, 600)`,
    );
    expect(error.sqlState).toBe(NOT_NULL_VIOLATION);
  });

  it("refuses an appointment whose clinic is not its doctor's clinic", async () => {
    const error = await expectDbError(() =>
      insertAppointment({
        clinicId: otherClinicId,
        doctorId,
        startsAt: "2026-11-05T15:00:00Z",
        endsAt: "2026-11-05T15:30:00Z",
      }),
    );
    expect(error.sqlState).toBe(FOREIGN_KEY_VIOLATION);
    expect(error.text).toContain("Appointment_doctorId_clinicId_fkey");
  });

  it("applies the same rule to working hours, breaks and time off", async () => {
    const hours = await expectDbError(
      () => db.$executeRaw`
        INSERT INTO "WorkingHours" ("doctorId", "clinicId", "weekday", "startMinute", "endMinute")
        VALUES (${otherClinicDoctorId}::uuid, ${clinicId}::uuid, 1, 540, 600)`,
    );
    const breaks = await expectDbError(
      () => db.$executeRaw`
        INSERT INTO "Break" ("doctorId", "clinicId", "weekday", "startMinute", "endMinute")
        VALUES (${otherClinicDoctorId}::uuid, ${clinicId}::uuid, 1, 540, 600)`,
    );
    const timeOff = await expectDbError(
      () => db.$executeRaw`
        INSERT INTO "TimeOff" ("doctorId", "clinicId", "startsAt", "endsAt", "reasonCode", "createdById")
        VALUES (${otherClinicDoctorId}::uuid, ${clinicId}::uuid, '2026-11-05T00:00:00Z', '2026-11-06T00:00:00Z',
                'training', ${patientUserId}::uuid)`,
    );
    for (const error of [hours, breaks, timeOff]) expect(error.sqlState).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("allows a staff member and a doctor exactly one clinic", async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT c.relname AS table_name
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisunique AND i.indnatts = 1 AND a.attname = 'userId'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual(["DoctorProfile", "PatientProfile", "StaffProfile"]);
  });
});

describe("identifiers (R9)", () => {
  it("every table's id is a random UUID generated by the database", async () => {
    const rows = await db.$queryRaw<{ table_name: string; data_type: string; column_default: string | null }[]>`
      SELECT table_name, data_type, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND table_name <> '_prisma_migrations'`;
    expect(rows.length).toBe(16);
    for (const row of rows) {
      expect(row.data_type, row.table_name).toBe("uuid");
      expect(row.column_default, row.table_name).toBe("gen_random_uuid()");
    }
  });

  it("has no sequence, so no id can be sequential", async () => {
    const rows = await db.$queryRaw<unknown[]>`
      SELECT 1 FROM information_schema.sequences WHERE sequence_schema = 'public'`;
    expect(rows).toHaveLength(0);
  });

  it("generates version 4 (random) ids", async () => {
    const id = await insertAppointment({ startsAt: "2026-11-06T15:00:00Z", endsAt: "2026-11-06T15:30:00Z" });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("time (R67)", () => {
  it("stores every timestamp as an instant with a time zone", async () => {
    const rows = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
        AND table_name <> '_prisma_migrations'`;
    expect(rows).toEqual([]);
  });

  it("runs every session in UTC, by database default and by connection setting", async () => {
    const session = await db.$queryRaw<{ zone: string }[]>`SELECT current_setting('TimeZone') AS zone`;
    expect(session[0].zone).toBe("UTC");
    const byDatabase = await db.$queryRaw<{ setconfig: string[] | null }[]>`
      SELECT s.setconfig FROM pg_db_role_setting s
      JOIN pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = current_database() AND s.setrole = 0`;
    expect(byDatabase[0]?.setconfig).toContain("TimeZone=UTC");
  });

  it("stores the instant the application wrote, not one shifted by a server offset", async () => {
    const start = new Date("2026-11-07T15:00:00Z");
    const id = await insertAppointment({ startsAt: "2026-11-07T15:00:00Z", endsAt: "2026-11-07T15:30:00Z" });
    // Written as text, found by a Date parameter, read back as a Date: all the same instant.
    expect(await db.appointment.count({ where: { id, startsAt: start } })).toBe(1);
    await db.appointment.update({ where: { id }, data: { endsAt: new Date("2026-11-07T15:45:00Z") } });
    const stored = await db.$queryRaw<{ epoch: number }[]>`
      SELECT extract(epoch FROM "endsAt")::float8 AS epoch FROM "Appointment" WHERE "id" = ${id}::uuid`;
    expect(stored[0].epoch * 1000).toBe(new Date("2026-11-07T15:45:00Z").getTime());
  });

  it("round-trips an instant as UTC whatever offset it was written with", async () => {
    // 19:00 at +05:00 is 14:00 UTC.
    const id = await insertAppointment({ startsAt: "2026-11-07T19:00:00+05:00", endsAt: "2026-11-07T19:30:00+05:00" });
    const row = await db.appointment.findUniqueOrThrow({ where: { id } });
    expect(row.startsAt.toISOString()).toBe("2026-11-07T14:00:00.000Z");
    expect(row.endsAt.toISOString()).toBe("2026-11-07T14:30:00.000Z");
    const text = await db.$queryRaw<{ utc: string }[]>`
      SELECT to_char("startsAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS utc
      FROM "Appointment" WHERE "id" = ${id}::uuid`;
    expect(text[0].utc).toBe("2026-11-07T14:00:00Z");
  });
});

describe("end after start", () => {
  it("on appointments", async () => {
    const equal = await expectDbError(() =>
      insertAppointment({ startsAt: "2026-11-08T15:00:00Z", endsAt: "2026-11-08T15:00:00Z" }),
    );
    const reversed = await expectDbError(() =>
      insertAppointment({ startsAt: "2026-11-08T16:00:00Z", endsAt: "2026-11-08T15:30:00Z" }),
    );
    for (const error of [equal, reversed]) {
      expect(error.sqlState).toBe(CHECK_VIOLATION);
      expect(error.text).toContain("Appointment_end_after_start");
    }
  });

  it("on time off", async () => {
    const error = await expectDbError(
      () => db.$executeRaw`
        INSERT INTO "TimeOff" ("doctorId", "clinicId", "startsAt", "endsAt", "reasonCode", "createdById")
        VALUES (${doctorId}::uuid, ${clinicId}::uuid, '2026-11-06T00:00:00Z', '2026-11-05T00:00:00Z',
                'training', ${patientUserId}::uuid)`,
    );
    expect(error.sqlState).toBe(CHECK_VIOLATION);
    expect(error.text).toContain("TimeOff_end_after_start");
  });

  it("on working hours and breaks, within one day and on a real weekday", async () => {
    for (const table of ["WorkingHours", "Break"] as const) {
      for (const [weekday, start, end] of [
        [1, 600, 540],
        [1, 540, 540],
        [1, -1, 60],
        [1, 540, 1441],
        [0, 540, 600],
        [8, 540, 600],
      ]) {
        const error = await expectDbError(() =>
          db.$executeRawUnsafe(
            `INSERT INTO "${table}" ("doctorId", "clinicId", "weekday", "startMinute", "endMinute")
             VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
            doctorId,
            clinicId,
            weekday,
            start,
            end,
          ),
        );
        expect(error.sqlState, `${table} ${weekday} ${start} ${end}`).toBe(CHECK_VIOLATION);
      }
    }
  });
});

describe("other invariants", () => {
  it("a cancelled appointment must record who cancelled it, and only a cancelled one may (R44)", async () => {
    const id = await insertAppointment({ startsAt: "2026-11-09T15:00:00Z", endsAt: "2026-11-09T15:30:00Z" });
    const missing = await expectDbError(
      () => db.$executeRaw`UPDATE "Appointment" SET "status" = 'cancelled' WHERE "id" = ${id}::uuid`,
    );
    const stray = await expectDbError(
      () => db.$executeRaw`UPDATE "Appointment" SET "cancelledByRole" = 'staff' WHERE "id" = ${id}::uuid`,
    );
    for (const error of [missing, stray]) {
      expect(error.sqlState).toBe(CHECK_VIOLATION);
      expect(error.text).toContain("Appointment_cancelled_by");
    }
  });

  it("only a patient's cancellation can be a late cancel (R42)", async () => {
    const id = await insertAppointment({ startsAt: "2026-11-09T16:00:00Z", endsAt: "2026-11-09T16:30:00Z" });
    const error = await expectDbError(
      () => db.$executeRaw`
        UPDATE "Appointment" SET "status" = 'cancelled', "cancelledByRole" = 'staff', "lateCancel" = true
        WHERE "id" = ${id}::uuid`,
    );
    expect(error.sqlState).toBe(CHECK_VIOLATION);
    expect(error.text).toContain("Appointment_late_cancel");
  });

  it("limits the reason for visit to 200 characters (R20)", async () => {
    const error = await expectDbError(
      () => db.$executeRaw`
        UPDATE "Appointment" SET "reasonForVisit" = repeat('x', 201) WHERE "doctorId" = ${doctorId}::uuid`,
    );
    expect(error.sqlState).toBe("22001");
  });

  it("refuses impossible clinic settings and slot lengths", async () => {
    const window = await expectDbError(
      () => db.$executeRaw`UPDATE "Clinic" SET "cancellationWindowHours" = -1 WHERE "id" = ${clinicId}::uuid`,
    );
    const limit = await expectDbError(
      () => db.$executeRaw`UPDATE "Clinic" SET "maxUpcomingPerPatient" = 0 WHERE "id" = ${clinicId}::uuid`,
    );
    const slot = await expectDbError(
      () => db.$executeRaw`UPDATE "DoctorProfile" SET "slotLengthMinutes" = 0 WHERE "id" = ${doctorId}::uuid`,
    );
    for (const error of [window, limit, slot]) expect(error.sqlState).toBe(CHECK_VIOLATION);
  });

  it("links a patient to a clinic at most once (R6)", async () => {
    await db.clinicPatient.create({ data: { clinicId, patientId } });
    const error = await expectDbError(() => db.clinicPatient.create({ data: { clinicId, patientId } }));
    expect(error.sqlState).toBe(UNIQUE_VIOLATION);
  });
});
