// GET /api/v1/clinic/schedule?doctorId&view=day|week&date: the daily or weekly schedule with
// its appointments (R58). A doctor sees their own; staff choose a doctor of their clinic.
import { z } from "zod";
import { readSchedule } from "@/lib/clinic/schedule-view";
import { route } from "@/lib/route";
import { idSchema, localDateSchema } from "@/lib/schemas";

const querySchema = z.object({
  doctorId: idSchema.optional(),
  view: z.enum(["day", "week"]).default("day"),
  // A clinic date. Today at the clinic when omitted.
  date: localDateSchema.optional(),
});

export const GET = route({
  roles: ["doctor", "staff"],
  query: querySchema,
  handler: async ({ session, query, now }) => ({ body: { schedule: await readSchedule(session, query, now) } }),
});
