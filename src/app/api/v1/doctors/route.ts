// GET /api/v1/doctors?name&specialty&location&availability&cursor: doctor search (R11 to R14).
// Signed-in users only (R16). OWNER: Stream A.
import { z } from "zod";
import { AVAILABILITY_PERIODS, SEARCH_CURSOR_SHAPE, searchDoctors } from "@/lib/patient/search";
import { route } from "@/lib/route";
import { idSchema } from "@/lib/schemas";

// An empty filter is the same as no filter.
const text = z.string().trim().max(100).optional();
const querySchema = z.strictObject({
  name: text,
  // A specialty id from GET /specialties.
  specialty: z.union([z.literal(""), idSchema]).optional(),
  location: text,
  availability: z.enum(AVAILABILITY_PERIODS).default("any"),
  cursor: z.string().regex(SEARCH_CURSOR_SHAPE).optional(),
});

export const GET = route({
  roles: ["patient", "doctor", "staff", "admin"],
  query: querySchema,
  handler: async ({ query, now }) => ({
    body: await searchDoctors(
      {
        name: query.name || undefined,
        specialtyId: query.specialty || undefined,
        location: query.location || undefined,
        availability: query.availability,
        cursor: query.cursor,
      },
      now,
    ),
  }),
});
