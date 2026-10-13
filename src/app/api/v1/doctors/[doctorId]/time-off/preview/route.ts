// POST /api/v1/doctors/{doctorId}/time-off/preview: the appointments that time off would
// cancel, with a preview token (R53). Saves nothing and cancels nothing.
import { z } from "zod";
import { previewTimeOff, timeOffSchema } from "@/lib/clinic/time-off";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema });

export const POST = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  body: timeOffSchema,
  handler: async ({ session, params, body, now }) => ({
    body: { preview: await previewTimeOff(session, params.doctorId, body, now) },
  }),
});
