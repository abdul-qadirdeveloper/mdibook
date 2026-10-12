-- Hand-written. These rules cannot be declared in prisma/schema.prisma.

-- Sessions on this database run in UTC (R67). Prisma's PostgreSQL adapter reads and writes
-- timestamps as if the session zone were UTC; on a server with another default zone every
-- instant would be shifted by that zone's offset. Applies to connections opened after this.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', current_database());
END;
$$;

-- No double booking (R22, R30): at most one active appointment per doctor and start time.
-- Active means requested or confirmed. A second insert, or a reschedule onto the same start,
-- fails with a unique violation (SQLSTATE 23505), which the application reports as SLOT_TAKEN.
CREATE UNIQUE INDEX "Appointment_one_active_per_doctor_start"
  ON "Appointment" ("doctorId", "startsAt")
  WHERE "status" IN ('requested', 'confirmed');

-- End after start.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_end_after_start" CHECK ("endsAt" > "startsAt");
ALTER TABLE "TimeOff"
  ADD CONSTRAINT "TimeOff_end_after_start" CHECK ("endsAt" > "startsAt");
ALTER TABLE "WorkingHours"
  ADD CONSTRAINT "WorkingHours_end_after_start"
    CHECK ("startMinute" >= 0 AND "endMinute" <= 1440 AND "endMinute" > "startMinute"),
  ADD CONSTRAINT "WorkingHours_weekday" CHECK ("weekday" BETWEEN 1 AND 7);
ALTER TABLE "Break"
  ADD CONSTRAINT "Break_end_after_start"
    CHECK ("startMinute" >= 0 AND "endMinute" <= 1440 AND "endMinute" > "startMinute"),
  ADD CONSTRAINT "Break_weekday" CHECK ("weekday" BETWEEN 1 AND 7);

-- Sane settings.
ALTER TABLE "DoctorProfile"
  ADD CONSTRAINT "DoctorProfile_slot_length" CHECK ("slotLengthMinutes" BETWEEN 1 AND 1440);
ALTER TABLE "Clinic"
  ADD CONSTRAINT "Clinic_cancellation_window" CHECK ("cancellationWindowHours" >= 0),
  ADD CONSTRAINT "Clinic_max_upcoming" CHECK ("maxUpcomingPerPatient" >= 1);

-- A cancelled appointment records which role cancelled it (R44), and only a patient's
-- cancellation can be a late cancel (R42).
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_cancelled_by"
    CHECK (("status" = 'cancelled') = ("cancelledByRole" IS NOT NULL)),
  ADD CONSTRAINT "Appointment_late_cancel"
    CHECK (NOT "lateCancel" OR "cancelledByRole" = 'patient');

-- Audit events are append-only (R82).
CREATE FUNCTION "AuditEvent_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "AuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "AuditEvent_refuse_change"();

CREATE TRIGGER "AuditEvent_no_truncate"
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "AuditEvent_refuse_change"();
