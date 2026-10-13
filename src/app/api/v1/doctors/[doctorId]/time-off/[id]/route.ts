// DELETE /api/v1/doctors/{doctorId}/time-off/{id}: remove time off. Its slots are open again;
// appointments it cancelled stay cancelled (R57).
import { z } from "zod";
import { removeTimeOff } from "@/lib/clinic/time-off";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema, id: idSchema });

export const DELETE = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  handler: async ({ session, params }) => ({
    body: { removed: await removeTimeOff(session, params.doctorId, params.id) },
  }),
});
