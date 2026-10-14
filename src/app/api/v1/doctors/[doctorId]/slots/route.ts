// GET /api/v1/doctors/{doctorId}/slots?from&to: open slots as UTC instants, grouped by date in
// the clinic's time zone, with that zone (R15, R70). Reading slots holds nothing (R17).
// OWNER: Stream A.
import { z } from "zod";
import { listDoctorSlots } from "@/lib/patient/search";
import { route } from "@/lib/route";
import { idSchema, instantSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema });
const querySchema = z.strictObject({
  from: instantSchema.optional(),
  to: instantSchema.optional(),
});

export const GET = route({
  roles: ["patient", "doctor", "staff", "admin"],
  params: paramsSchema,
  query: querySchema,
  handler: async ({ params, query, now }) => ({
    body: await listDoctorSlots(params.doctorId, { from: query.from, to: query.to }, now),
  }),
});
