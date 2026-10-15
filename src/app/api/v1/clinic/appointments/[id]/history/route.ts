// GET /api/v1/clinic/appointments/{id}/history: the audit events of one appointment, for staff.
import { z } from "zod";
import { readAppointmentHistory } from "@/lib/clinic/appointment-history";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

const paramsSchema = z.object({ id: idSchema });

export const GET = route({
  roles: ["staff"],
  params: paramsSchema,
  handler: async ({ params }) => ({ body: { history: await readAppointmentHistory(params.id) } }),
});
