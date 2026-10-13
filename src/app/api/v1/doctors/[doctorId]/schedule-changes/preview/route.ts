// POST /api/v1/doctors/{doctorId}/schedule-changes/preview: the appointments a change to
// working hours or breaks would cancel, with a preview token (R53). Changes nothing.
import { z } from "zod";
import { previewScheduleChange, weeklyChangeSchema } from "@/lib/clinic/schedule-change";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema });

export const POST = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  body: weeklyChangeSchema,
  handler: async ({ session, params, body, now }) => ({
    body: { preview: await previewScheduleChange(session, params.doctorId, body, now) },
  }),
});
