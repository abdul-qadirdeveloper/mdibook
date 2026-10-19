// POST /api/v1/appointments/{id}/reschedule: move to another open slot with the same doctor.
// Shared by Stream A (patient) and Stream B (doctor, staff). FROZEN after Stream 0. This file
// only dispatches by role; the work is in src/lib/patient/reschedule.ts and
// src/lib/clinic/reschedule.ts.
import { z } from "zod";
import { rescheduleAsClinic } from "@/lib/clinic/reschedule";
import { rescheduleAsPatient } from "@/lib/patient/reschedule";
import { route } from "@/lib/route";
import { idSchema, instantSchema } from "@/lib/schemas";
import { readAppointment } from "@/lib/serialize";

const paramsSchema = z.object({ id: idSchema });
const bodySchema = z.strictObject({ startsAt: instantSchema });

export const POST = route({
  roles: ["patient", "doctor", "staff"],
  params: paramsSchema,
  body: bodySchema,
  handler: async ({ session, params, body, now, requestId }) => {
    const input = { appointmentId: params.id, start: body.startsAt, requestId };
    const result =
      session.role === "patient"
        ? await rescheduleAsPatient(session, input, now)
        : await rescheduleAsClinic(session, input, now);
    return { body: { appointment: await readAppointment(session, result.appointmentId, now) } };
  },
});
