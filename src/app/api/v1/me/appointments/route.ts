// GET /api/v1/me/appointments?scope=upcoming|past&cursor: the patient's own appointments
// across all clinics (R45). Whose they are comes from the session only. Each one is built by
// the serializer from the patient's field list (R83). OWNER: Stream A.
import { z } from "zod";
import { APPOINTMENT_SCOPES, listOwnAppointments } from "@/lib/patient/appointments";
import { route } from "@/lib/route";
import { type AppointmentResponse, readAppointment } from "@/lib/serialize";

const querySchema = z.strictObject({
  scope: z.enum(APPOINTMENT_SCOPES).default("upcoming"),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
});

export const GET = route({
  roles: ["patient"],
  query: querySchema,
  handler: async ({ session, query, now }) => {
    const page = await listOwnAppointments(session, query.scope, now, query.cursor ?? null);
    const items: { appointment: AppointmentResponse }[] = [];
    for (const id of page.ids) {
      items.push({ appointment: await readAppointment(session, id, now) });
    }
    return { body: { items, total: page.total, nextCursor: page.nextCursor } };
  },
});
