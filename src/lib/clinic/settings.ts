// Clinic settings: the cancellation window and the booking limit (R25, R40). Any staff member
// of the clinic can read and change them. The clinic is always the one in the session.
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { validationError } from "@/lib/errors";
import { clinicOf } from "@/lib/scope";
import type { Session } from "@/lib/session";

export const clinicSettingsSchema = z.strictObject({
  /** Hours before the start. Zero means no window. */
  cancellationWindowHours: z.number().int().min(0).max(720).optional(),
  maxUpcomingPerPatient: z.number().int().min(1).max(50).optional(),
});

export type ClinicSettingsChange = z.infer<typeof clinicSettingsSchema>;

export interface ClinicSettingsView {
  clinicId: string;
  cancellationWindowHours: number;
  maxUpcomingPerPatient: number;
}

const fields = { id: true, cancellationWindowHours: true, maxUpcomingPerPatient: true } as const;

function view(clinic: { id: string; cancellationWindowHours: number; maxUpcomingPerPatient: number }): ClinicSettingsView {
  return {
    clinicId: clinic.id,
    cancellationWindowHours: clinic.cancellationWindowHours,
    maxUpcomingPerPatient: clinic.maxUpcomingPerPatient,
  };
}

export async function readClinicSettings(session: Session): Promise<ClinicSettingsView> {
  return view(await db.clinic.findUniqueOrThrow({ where: { id: clinicOf(session) }, select: fields }));
}

/** Takes effect at once: the next booking and the next cancellation use the new values. */
export async function changeClinicSettings(session: Session, change: ClinicSettingsChange): Promise<ClinicSettingsView> {
  if (change.cancellationWindowHours === undefined && change.maxUpcomingPerPatient === undefined) {
    throw validationError({ field: "body", problem: "required" });
  }
  const clinicId = clinicOf(session);
  return db.$transaction(async (tx) => {
    const clinic = await tx.clinic.update({ where: { id: clinicId }, data: change, select: fields });
    await writeAudit(tx, {
      actorId: session.userId,
      actorRole: session.role,
      action: "clinic.settings_changed",
      entityType: "clinic",
      entityId: clinicId,
      clinicId,
    });
    return view(clinic);
  });
}
