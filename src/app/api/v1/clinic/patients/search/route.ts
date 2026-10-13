// POST /api/v1/clinic/patients/search: find the patient to book for (R92). Staff only. The
// search term is in the body, never in the URL (R80).
import { patientSearchSchema, searchPatients } from "@/lib/clinic/patient-lookup";
import { route } from "@/lib/route";

export const POST = route({
  roles: ["staff"],
  body: patientSearchSchema,
  handler: async ({ session, body, now }) => ({ body: { patients: await searchPatients(session, body, now) } }),
});
