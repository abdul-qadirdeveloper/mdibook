// GET /api/v1/doctors/{doctorId}: the doctor profile (R15). A patient also gets the clinic's
// cancellation window and booking limit with their own count of upcoming appointments there,
// which the review screen states before they confirm (R26). OWNER: Stream A.
import { z } from "zod";
import { readDoctorProfile } from "@/lib/patient/search";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ doctorId: idSchema });

export const GET = route({
  roles: ["patient", "doctor", "staff", "admin"],
  params: paramsSchema,
  handler: async ({ session, params, now }) => ({
    body: await readDoctorProfile(session, params.doctorId, now),
  }),
});
