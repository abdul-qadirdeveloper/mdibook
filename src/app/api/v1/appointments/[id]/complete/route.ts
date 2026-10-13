// POST /api/v1/appointments/{id}/complete: staff or the appointment's doctor record that the
// patient attended. After the start only (R62, R63).
import { z } from "zod";
import { recordOutcome } from "@/lib/clinic/outcomes";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";
import { readAppointment } from "@/lib/serialize";

const paramsSchema = z.object({ id: idSchema });

export const POST = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  handler: async ({ session, params, now }) => {
    const result = await recordOutcome(session, { appointmentId: params.id, to: "completed" }, now);
    return { body: { appointment: await readAppointment(session, result.appointmentId, now) } };
  },
});
