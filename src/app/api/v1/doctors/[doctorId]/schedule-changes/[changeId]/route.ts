// GET /api/v1/doctors/{doctorId}/schedule-changes/{changeId}: a saved change and the
// appointments it cancelled, so the clinic can call the patients (R54). Staff see each
// patient's phone number; the doctor does not.
import { z } from "zod";
import { readScheduleChange } from "@/lib/clinic/schedule-change";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema, changeId: idSchema });

export const GET = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  handler: async ({ session, params, now }) => ({
    body: await readScheduleChange(session, params.doctorId, params.changeId, now),
  }),
});
