// Audit events (R81, R82): written by every core mutation with all seven fields, ids only,
// and impossible to edit or delete at the database.
import { beforeEach, describe, expect, it } from "vitest";
import { bookAppointment, changeAppointmentStatus, rescheduleAppointment } from "@/lib/appointments/core";
import { AUDIT_ACTIONS, writeAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { NOW, at } from "../../helpers/clock";
import { expectDbError, resetDb } from "../../helpers/db";
import { createWorld } from "../../helpers/factories";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const S0900 = at("2026-10-14", "09:00");

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
});

const book = (actor: World["patientSession"], start: Date) =>
  bookAppointment(
    { actor, doctorId: w.doctor.id, patientId: w.patient.id, start, reasonForVisit: "Fictional reason" },
    NOW,
  );

describe("audit events written by the core (R81)", () => {
  it("each mutation writes one event with all seven fields", async () => {
    const started = new Date();
    const a = await book(w.patientSession, S0900);
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: a.appointmentId, to: "confirmed" }, NOW);
    await rescheduleAppointment(
      { actor: w.doctorSession, appointmentId: a.appointmentId, newStart: at("2026-10-14", "10:00") },
      NOW,
    );
    await changeAppointmentStatus(
      { actor: w.staffSession, appointmentId: a.appointmentId, to: "cancelled", reasonCode: "other" },
      NOW,
    );
    const b = await book(w.staffSession, S0900);
    await changeAppointmentStatus({ actor: w.doctorSession, appointmentId: b.appointmentId, to: "completed" }, S0900);
    const c = await book(w.patientSession, at("2026-10-14", "11:00"));
    await changeAppointmentStatus(
      { actor: w.staffSession, appointmentId: c.appointmentId, to: "no_show" },
      at("2026-10-14", "11:30"),
    );

    const events = await db.auditEvent.findMany({ where: { entityType: "appointment" }, orderBy: { at: "asc" } });
    expect(events.map((e) => [e.action, e.actorRole, e.actorId, e.entityId])).toEqual([
      ["appointment.booked", "patient", w.patientUser.id, a.appointmentId],
      ["appointment.confirmed", "staff", w.staffUser.id, a.appointmentId],
      ["appointment.rescheduled", "doctor", w.doctorUser.id, a.appointmentId],
      ["appointment.cancelled", "staff", w.staffUser.id, a.appointmentId],
      ["appointment.booked", "staff", w.staffUser.id, b.appointmentId],
      ["appointment.completed", "doctor", w.doctorUser.id, b.appointmentId],
      ["appointment.booked", "patient", w.patientUser.id, c.appointmentId],
      ["appointment.no_show", "staff", w.staffUser.id, c.appointmentId],
    ]);
    for (const event of events) {
      // actor id, actor role, action, entity type, entity id, clinic id, UTC timestamp.
      expect(event.actorId).toMatch(UUID);
      expect(["patient", "doctor", "staff"]).toContain(event.actorRole);
      expect(AUDIT_ACTIONS).toContain(event.action);
      expect(event.entityType).toBe("appointment");
      expect(event.entityId).toMatch(UUID);
      expect(event.clinicId).toBe(w.clinic.id);
      expect(event.at.getTime()).toBeGreaterThanOrEqual(started.getTime() - 5_000);
      expect(event.at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    }
  });

  it("the first booking at a clinic also records the new patient-to-clinic link", async () => {
    await book(w.patientSession, S0900);
    const link = await db.auditEvent.findMany({ where: { action: "patient.clinic_linked" } });
    expect(link).toHaveLength(1);
    expect(link[0]).toMatchObject({ entityType: "patient", entityId: w.patient.id, clinicId: w.clinic.id });
  });

  it("an event holds ids and codes only: the table has no column for a payload", async () => {
    const columns = await db.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'AuditEvent' ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      "action",
      "actorId",
      "actorRole",
      "at",
      "clinicId",
      "entityId",
      "entityType",
      "id",
    ]);
    await book(w.patientSession, S0900);
    const stored = JSON.stringify(await db.auditEvent.findMany());
    expect(stored).not.toContain("Fictional reason");
    expect(stored).not.toContain(w.patient.fullName);
    expect(stored).not.toContain(w.patientUser.email);
  });
});

describe("writeAudit", () => {
  const base = () => ({
    actorId: w.patientUser.id,
    actorRole: "patient" as const,
    action: "patient.profile_changed" as const,
    entityType: "patient" as const,
    entityId: w.patient.id,
    clinicId: null,
  });

  it("leaves the clinic empty only for an action that belongs to no clinic", async () => {
    await db.$transaction((tx) => writeAudit(tx, base()));
    const event = await db.auditEvent.findFirstOrThrow({ where: { action: "patient.profile_changed" } });
    expect(event.clinicId).toBeNull();
    expect(event).toMatchObject({ actorId: w.patientUser.id, actorRole: "patient", entityId: w.patient.id });
    // Every event written by an appointment change has a clinic.
    await book(w.patientSession, S0900);
    expect(await db.auditEvent.count({ where: { entityType: "appointment", clinicId: null } })).toBe(0);
  });

  it("refuses anything that is not an id", async () => {
    const attempts = [
      { ...base(), actorId: "pat@example.test" },
      { ...base(), entityId: "Pat Example" },
      { ...base(), clinicId: "Example Clinic" },
      { ...base(), action: "something else" as never },
      { ...base(), entityType: "free text" as never },
    ];
    for (const attempt of attempts) {
      await expect(db.$transaction((tx) => writeAudit(tx, attempt))).rejects.toThrow(TypeError);
    }
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("is part of the caller's transaction: a rollback removes the event", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await writeAudit(tx, base());
        throw new Error("forced failure");
      }),
    ).rejects.toThrow("forced failure");
    expect(await db.auditEvent.count()).toBe(0);
  });
});

describe("audit events are append-only (R82)", () => {
  const RESTRICT_VIOLATION = "23001";

  beforeEach(async () => {
    await book(w.patientSession, S0900);
  });

  it("refuses an update at the database", async () => {
    const error = await expectDbError(() => db.$executeRaw`UPDATE "AuditEvent" SET "action" = 'changed'`);
    expect(error.sqlState).toBe(RESTRICT_VIOLATION);
    expect(error.text).toContain("append-only");
    const viaClient = await expectDbError(() => db.auditEvent.updateMany({ data: { action: "changed" } }));
    expect(viaClient.text).toContain("append-only");
    expect(await db.auditEvent.count({ where: { action: "changed" } })).toBe(0);
  });

  it("refuses a delete at the database", async () => {
    const before = await db.auditEvent.count();
    const error = await expectDbError(() => db.$executeRaw`DELETE FROM "AuditEvent"`);
    expect(error.sqlState).toBe(RESTRICT_VIOLATION);
    const viaClient = await expectDbError(() => db.auditEvent.deleteMany());
    expect(viaClient.text).toContain("append-only");
    expect(await db.auditEvent.count()).toBe(before);
  });

  it("refuses a truncate at the database", async () => {
    const before = await db.auditEvent.count();
    const error = await expectDbError(() => db.$executeRawUnsafe('TRUNCATE "AuditEvent"'));
    expect(error.sqlState).toBe(RESTRICT_VIOLATION);
    expect(await db.auditEvent.count()).toBe(before);
  });

  it("nothing cascades into the table: it has no foreign keys", async () => {
    const keys = await db.$queryRaw<unknown[]>`
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public' AND table_name = 'AuditEvent' AND constraint_type = 'FOREIGN KEY'`;
    expect(keys).toHaveLength(0);
  });
});
