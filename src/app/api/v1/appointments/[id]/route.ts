// GET /api/v1/appointments/{id}: read one appointment, with the fields the caller's role may
// see. FROZEN after Stream 0.
import { z } from "zod";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";
import { readAppointment } from "@/lib/serialize";

const paramsSchema = z.object({ id: idSchema });

export const GET = route({
  roles: ["patient", "doctor", "staff"],
  params: paramsSchema,
  handler: async ({ session, params, now }) => ({
    body: { appointment: await readAppointment(session, params.id, now) },
  }),
});
