// GET /api/v1/doctors/{doctorId}/schedule-settings: working hours, breaks, slot length and
// time off (R48, R49). The doctor themself, or staff of the doctor's clinic.
import { z } from "zod";
import { readScheduleSettings } from "@/lib/clinic/schedule-settings";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema });

export const GET = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  handler: async ({ session, params, now }) => ({
    body: { settings: await readScheduleSettings(session, params.doctorId, now) },
  }),
});
