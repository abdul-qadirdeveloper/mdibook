// GET and PATCH /api/v1/clinic/settings: the clinic's cancellation window and booking limit
// (R25, R40). Staff only, and only for the clinic in their session.
import { changeClinicSettings, clinicSettingsSchema, readClinicSettings } from "@/lib/clinic/settings";
import { route } from "@/lib/route";

export const GET = route({
  roles: ["staff"],
  handler: async ({ session }) => ({ body: { settings: await readClinicSettings(session) } }),
});

export const PATCH = route({
  roles: ["staff"],
  body: clinicSettingsSchema,
  handler: async ({ session, body }) => ({ body: { settings: await changeClinicSettings(session, body) } }),
});
