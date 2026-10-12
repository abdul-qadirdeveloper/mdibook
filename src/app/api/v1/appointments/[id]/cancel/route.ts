// POST /api/v1/appointments/{id}/cancel. Shared by Stream A (patient) and Stream B (doctor,
// staff). FROZEN after Stream 0. This file only dispatches by role; the work is in
// src/lib/patient/cancel.ts and src/lib/clinic/cancel.ts.
import { z } from "zod";
import { cancelAsClinic } from "@/lib/clinic/cancel";
import { validationError } from "@/lib/errors";
import { cancelAsPatient } from "@/lib/patient/cancel";
import { route } from "@/lib/route";
import { cancelReasonCodeSchema, idSchema } from "@/lib/schemas";
import { readAppointment } from "@/lib/serialize";

const paramsSchema = z.object({ id: idSchema });
// Staff and doctors choose a code from the fixed list (R41). A patient sends none.
const bodySchema = z.strictObject({ reasonCode: cancelReasonCodeSchema.optional() });

export const POST = route({
  roles: ["patient", "doctor", "staff"],
  params: paramsSchema,
  body: bodySchema,
  handler: async ({ session, params, body, now }) => {
    const code = body.reasonCode;
    if (session.role === "patient") {
      if (code !== undefined) throw validationError({ field: "reasonCode", problem: "not_allowed" });
      const result = await cancelAsPatient(session, { appointmentId: params.id }, now);
      return {
        body: {
          appointment: await readAppointment(session, result.appointmentId, now),
          // The patient is told whether it was recorded as a late cancel (R39).
          recordedAsLate: result.late,
        },
      };
    }
    if (code === undefined) throw validationError({ field: "reasonCode", problem: "required" });
    const result = await cancelAsClinic(session, { appointmentId: params.id, code }, now);
    return { body: { appointment: await readAppointment(session, result.appointmentId, now) } };
  },
});
