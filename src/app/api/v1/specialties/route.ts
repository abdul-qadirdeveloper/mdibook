// GET /api/v1/specialties: the fixed list for the search filter (R12). Signed-in users only
// (R16). OWNER: Stream A.
import { listSpecialties } from "@/lib/patient/search";
import { route } from "@/lib/route";

export const GET = route({
  roles: ["patient", "doctor", "staff", "admin"],
  handler: async () => ({ body: { specialties: await listSpecialties() } }),
});
