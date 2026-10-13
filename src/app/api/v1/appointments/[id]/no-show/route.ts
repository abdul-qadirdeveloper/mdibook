// POST /api/v1/appointments/{id}/no-show: staff or the appointment's doctor record a no-show.
// After the start only, and nothing else follows from it (R62, R63, R65).
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
    const result = await recordOutcome(session, { appointmentId: params.id, to: "no_show" }, now);
    return { body: { appointment: await readAppointment(session, result.appointmentId, now) } };
  },
});
