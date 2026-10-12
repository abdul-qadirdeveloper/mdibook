-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('patient', 'doctor', 'staff', 'admin');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('requested', 'confirmed', 'cancelled', 'completed', 'no_show');

-- CreateEnum
CREATE TYPE "AppointmentEventType" AS ENUM ('booked', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show');

-- CreateEnum
CREATE TYPE "ReasonCode" AS ENUM ('patient_request', 'doctor_unavailable', 'booked_in_error', 'planned_leave', 'unplanned_absence', 'training', 'clinic_closure', 'schedule_change', 'other');

-- CreateEnum
CREATE TYPE "ScheduleChangeKind" AS ENUM ('working_hours', 'breaks', 'time_off');

-- CreateTable
CREATE TABLE "Clinic" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "cancellationWindowHours" INTEGER NOT NULL DEFAULT 24,
    "maxUpcomingPerPatient" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientProfile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "dateOfBirth" DATE,

    CONSTRAINT "PatientProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Specialty" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,

    CONSTRAINT "Specialty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorProfile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "specialtyId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "slotLengthMinutes" INTEGER NOT NULL,

    CONSTRAINT "DoctorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffProfile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicPatient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinicId" UUID NOT NULL,
    "patientId" UUID NOT NULL,

    CONSTRAINT "ClinicPatient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkingHours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doctorId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "WorkingHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Break" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doctorId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "Break_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doctorId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reasonCode" "ReasonCode" NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleChange" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doctorId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "kind" "ScheduleChangeKind" NOT NULL,
    "reasonCode" "ReasonCode" NOT NULL,
    "actorId" UUID NOT NULL,
    "actorRole" "Role" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appointmentsCancelled" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ScheduleChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinicId" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL,
    "reasonForVisit" VARCHAR(200) NOT NULL,
    "bookedById" UUID NOT NULL,
    "bookedByRole" "Role" NOT NULL,
    "bookedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledByRole" "Role",
    "cancelReasonCode" "ReasonCode",
    "lateCancel" BOOLEAN NOT NULL DEFAULT false,
    "scheduleChangeId" UUID,
    "idempotencyKey" VARCHAR(100),

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentHistory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointmentId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "action" "AppointmentEventType" NOT NULL,
    "actorId" UUID NOT NULL,
    "actorRole" "Role" NOT NULL,
    "oldStartsAt" TIMESTAMPTZ(3),
    "newStartsAt" TIMESTAMPTZ(3),
    "reasonCode" "ReasonCode",
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorId" UUID NOT NULL,
    "actorRole" "Role" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "clinicId" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "AppointmentEventType" NOT NULL,
    "appointmentId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLookupLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "staffUserId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffLookupLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PatientProfile_userId_key" ON "PatientProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Specialty_name_key" ON "Specialty"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorProfile_userId_key" ON "DoctorProfile"("userId");

-- CreateIndex
CREATE INDEX "DoctorProfile_clinicId_idx" ON "DoctorProfile"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorProfile_id_clinicId_key" ON "DoctorProfile"("id", "clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_userId_key" ON "StaffProfile"("userId");

-- CreateIndex
CREATE INDEX "StaffProfile_clinicId_idx" ON "StaffProfile"("clinicId");

-- CreateIndex
CREATE INDEX "ClinicPatient_patientId_idx" ON "ClinicPatient"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicPatient_clinicId_patientId_key" ON "ClinicPatient"("clinicId", "patientId");

-- CreateIndex
CREATE INDEX "WorkingHours_doctorId_weekday_idx" ON "WorkingHours"("doctorId", "weekday");

-- CreateIndex
CREATE INDEX "Break_doctorId_weekday_idx" ON "Break"("doctorId", "weekday");

-- CreateIndex
CREATE INDEX "TimeOff_doctorId_startsAt_idx" ON "TimeOff"("doctorId", "startsAt");

-- CreateIndex
CREATE INDEX "ScheduleChange_doctorId_at_idx" ON "ScheduleChange"("doctorId", "at");

-- CreateIndex
CREATE INDEX "Appointment_doctorId_startsAt_idx" ON "Appointment"("doctorId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_clinicId_startsAt_idx" ON "Appointment"("clinicId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_patientId_clinicId_status_startsAt_idx" ON "Appointment"("patientId", "clinicId", "status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_id_clinicId_key" ON "Appointment"("id", "clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_bookedById_idempotencyKey_key" ON "Appointment"("bookedById", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AppointmentHistory_appointmentId_at_idx" ON "AppointmentHistory"("appointmentId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_clinicId_at_idx" ON "AuditEvent"("clinicId", "at");

-- CreateIndex
CREATE INDEX "NotificationEvent_appointmentId_idx" ON "NotificationEvent"("appointmentId");

-- CreateIndex
CREATE INDEX "StaffLookupLog_staffUserId_at_idx" ON "StaffLookupLog"("staffUserId", "at");

-- AddForeignKey
ALTER TABLE "PatientProfile" ADD CONSTRAINT "PatientProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorProfile" ADD CONSTRAINT "DoctorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorProfile" ADD CONSTRAINT "DoctorProfile_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorProfile" ADD CONSTRAINT "DoctorProfile_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicPatient" ADD CONSTRAINT "ClinicPatient_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicPatient" ADD CONSTRAINT "ClinicPatient_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_doctorId_clinicId_fkey" FOREIGN KEY ("doctorId", "clinicId") REFERENCES "DoctorProfile"("id", "clinicId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Break" ADD CONSTRAINT "Break_doctorId_clinicId_fkey" FOREIGN KEY ("doctorId", "clinicId") REFERENCES "DoctorProfile"("id", "clinicId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Break" ADD CONSTRAINT "Break_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_doctorId_clinicId_fkey" FOREIGN KEY ("doctorId", "clinicId") REFERENCES "DoctorProfile"("id", "clinicId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleChange" ADD CONSTRAINT "ScheduleChange_doctorId_clinicId_fkey" FOREIGN KEY ("doctorId", "clinicId") REFERENCES "DoctorProfile"("id", "clinicId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleChange" ADD CONSTRAINT "ScheduleChange_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_clinicId_fkey" FOREIGN KEY ("doctorId", "clinicId") REFERENCES "DoctorProfile"("id", "clinicId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_bookedById_fkey" FOREIGN KEY ("bookedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_scheduleChangeId_fkey" FOREIGN KEY ("scheduleChangeId") REFERENCES "ScheduleChange"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentHistory" ADD CONSTRAINT "AppointmentHistory_appointmentId_clinicId_fkey" FOREIGN KEY ("appointmentId", "clinicId") REFERENCES "Appointment"("id", "clinicId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_appointmentId_clinicId_fkey" FOREIGN KEY ("appointmentId", "clinicId") REFERENCES "Appointment"("id", "clinicId") ON DELETE RESTRICT ON UPDATE CASCADE;

