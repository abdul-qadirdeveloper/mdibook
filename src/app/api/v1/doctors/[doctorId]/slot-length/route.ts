// PATCH /api/v1/doctors/{doctorId}/slot-length: change the slot length. Only slots generated
// afterwards use it; existing appointments are kept as they are (R56).
import { z } from "zod";
import { changeSlotLength } from "@/lib/clinic/schedule-settings";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema });
const bodySchema = z.strictObject({ slotLengthMinutes: z.number().int().min(5).max(480) });

export const PATCH = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  body: bodySchema,
  handler: async ({ session, params, body }) => ({
    body: {
      settings: await changeSlotLength(session, { doctorId: params.doctorId, slotLengthMinutes: body.slotLengthMinutes }),
    },
  }),
});
