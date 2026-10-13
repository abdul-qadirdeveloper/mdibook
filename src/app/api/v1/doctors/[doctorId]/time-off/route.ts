// POST /api/v1/doctors/{doctorId}/time-off: add time off, with a reason code and the token of
// the preview the user confirmed (R51 to R53).
import { z } from "zod";
import { confirmationSchema } from "@/lib/clinic/schedule-change";
import { addTimeOff, timeOffSchema } from "@/lib/clinic/time-off";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema });
const bodySchema = timeOffSchema.extend(confirmationSchema.shape);

export const POST = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  body: bodySchema,
  handler: async ({ session, params, body, now }) => {
    const { reasonCode, previewToken, ...timeOff } = body;
    const added = await addTimeOff(session, params.doctorId, timeOff, { reasonCode, previewToken }, now);
    return { status: 201, body: added };
  },
});
