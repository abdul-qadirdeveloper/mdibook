// GET /api/v1/clinic/patients/{patientId}: one patient as the caller's clinic knows them.
// Staff: contact details and the clinic's history. A doctor: the history with themself (R60).
import { z } from "zod";
import { readPatientRecord } from "@/lib/clinic/patient-lookup";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ patientId: idSchema });

export const GET = route({
  roles: ["doctor", "staff"],
  params: paramsSchema,
  handler: async ({ session, params, now }) => ({ body: await readPatientRecord(session, params.patientId, now) }),
});
