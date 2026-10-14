// GET and PATCH /api/v1/me/profile: a patient reads and corrects their own full name, phone
// and date of birth (R19). Personal data travels in the body, never in the URL (R80).
// OWNER: Stream A.
import { z } from "zod";
import { validationError } from "@/lib/errors";
import { changeOwnProfile, readOwnProfile } from "@/lib/patient/profile";
import { route } from "@/lib/route";
import { dateOfBirthSchema } from "@/lib/schemas";

const bodySchema = z.strictObject({
  fullName: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(3).max(30).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
});

export const GET = route({
  roles: ["patient"],
  handler: async ({ session }) => ({ body: { profile: await readOwnProfile(session) } }),
});

export const PATCH = route({
  roles: ["patient"],
  body: bodySchema,
  handler: async ({ session, body }) => {
    if (Object.keys(body).length === 0) throw validationError({ field: "body", problem: "required" });
    return { body: { profile: await changeOwnProfile(session, body) } };
  },
});
