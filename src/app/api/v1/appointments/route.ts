// POST /api/v1/appointments: book. Shared by Stream A (patient) and Stream B (staff).
// FROZEN after Stream 0. This file only dispatches by role; the work is in
// src/lib/patient/book.ts and src/lib/clinic/book.ts.
import { z } from "zod";
import { bookAsClinic } from "@/lib/clinic/book";
import { validationError } from "@/lib/errors";
import { bookAsPatient } from "@/lib/patient/book";
import { route } from "@/lib/route";
import { dateOfBirthSchema, idSchema, instantSchema, reasonForVisitSchema } from "@/lib/schemas";
import { readAppointment } from "@/lib/serialize";

const bodySchema = z.strictObject({
  doctorId: idSchema,
  startsAt: instantSchema,
  reasonForVisit: reasonForVisitSchema,
  // Patient only, and only needed while the profile has none (R19).
  dateOfBirth: dateOfBirthSchema.optional(),
  // Staff only: the patient the appointment is for (R28).
  patientId: idSchema.optional(),
});

export const POST = route({
  roles: ["patient", "staff"],
  body: bodySchema,
  handler: async ({ session, body, now, idempotencyKey }) => {
    let result: { appointmentId: string; created: boolean };
    if (session.role === "staff") {
      if (body.patientId === undefined) throw validationError({ field: "patientId", problem: "required" });
      // Staff never handle the date of birth: it comes from the patient's profile (R28).
      if (body.dateOfBirth !== undefined) throw validationError({ field: "dateOfBirth", problem: "not_allowed" });
      result = await bookAsClinic(
        session,
        {
          doctorId: body.doctorId,
          patientId: body.patientId,
          start: body.startsAt,
          reasonForVisit: body.reasonForVisit,
          idempotencyKey,
        },
        now,
      );
    } else {
      // A patient books for themself. The session says who that is.
      if (body.patientId !== undefined) throw validationError({ field: "patientId", problem: "not_allowed" });
      result = await bookAsPatient(
        session,
        {
          doctorId: body.doctorId,
          start: body.startsAt,
          reasonForVisit: body.reasonForVisit,
          dateOfBirth: body.dateOfBirth ?? null,
          idempotencyKey,
        },
        now,
      );
    }
    return {
      status: result.created ? 201 : 200,
      body: { appointment: await readAppointment(session, result.appointmentId, now) },
    };
  },
});
