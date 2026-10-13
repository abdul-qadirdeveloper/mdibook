// POST /api/v1/doctors/{doctorId}/schedule-changes: save new working hours or breaks, with a
// reason code and the token of the preview the user confirmed (R51 to R53).
import { z } from "zod";
import { applyScheduleChange, confirmationSchema, weeklyChangeSchema } from "@/lib/clinic/schedule-change";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema });
const bodySchema = weeklyChangeSchema.extend(confirmationSchema.shape);

export const POST = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  body: bodySchema,
  handler: async ({ session, params, body, now }) => {
    const { reasonCode, previewToken, ...change } = body;
    const applied = await applyScheduleChange(session, params.doctorId, change, { reasonCode, previewToken }, now);
    return { status: 201, body: { scheduleChange: applied.scheduleChange } };
  },
});
