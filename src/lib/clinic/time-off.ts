// Time off (R50 to R54, R57). It is entered as wall-clock dates and times in the clinic's
// time zone and stored as two instants. Adding it follows the same preview-then-apply steps
// as any schedule change; removing it reopens its slots and restores nothing.
import { z } from "zod";
import type { ScheduleChange } from "@/domain/schedule-impact";
import { localToInstant } from "@/domain/time";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { validationError } from "@/lib/errors";
import { localDateSchema } from "@/lib/schemas";
import { foundOrNotFound } from "@/lib/scope";
import type { Session } from "@/lib/session";
import {
  type Confirmation,
  type PreviewResult,
  type ScheduleChangeView,
  applyScheduleChange,
  previewScheduleChange,
} from "./schedule-change";
import { type TimeOffView, findManagedDoctor } from "./schedule-settings";

const minuteSchema = z.number().int().min(0).max(1440);

/** Start and end as a clinic date and wall-clock minutes from midnight (R50). */
export const timeOffSchema = z.strictObject({
  startDate: localDateSchema,
  startMinute: minuteSchema,
  endDate: localDateSchema,
  endMinute: minuteSchema,
});

export type TimeOffInput = z.infer<typeof timeOffSchema>;

/** Converts the wall-clock entry to instants in the doctor's clinic zone. */
async function toChange(session: Session, doctorId: string, input: TimeOffInput, now: Date): Promise<ScheduleChange> {
  const doctor = await findManagedDoctor(db, session, doctorId);
  const start = localToInstant(input.startDate, input.startMinute, doctor.timeZone);
  const end = localToInstant(input.endDate, input.endMinute, doctor.timeZone);
  // It must end after it starts, and it must not be over already.
  if (end.getTime() <= start.getTime() || end.getTime() <= now.getTime()) {
    throw validationError({ field: "endDate", problem: "invalid" });
  }
  return { kind: "time_off", start, end };
}

/** The appointments the time off would cancel. Saves nothing and cancels nothing. */
export async function previewTimeOff(
  session: Session,
  doctorId: string,
  input: TimeOffInput,
  now: Date,
): Promise<PreviewResult & { startsAt: string; endsAt: string }> {
  const change = await toChange(session, doctorId, input, now);
  const preview = await previewScheduleChange(session, doctorId, change, now);
  return { ...preview, ...instants(change) };
}

function instants(change: ScheduleChange): { startsAt: string; endsAt: string } {
  if (change.kind !== "time_off") throw new TypeError("Not time off");
  return { startsAt: change.start.toISOString(), endsAt: change.end.toISOString() };
}

/** Adds the time off and cancels the appointments the confirmed preview listed (R52). */
export async function addTimeOff(
  session: Session,
  doctorId: string,
  input: TimeOffInput,
  confirmation: Confirmation,
  now: Date,
): Promise<{ timeOff: TimeOffView; scheduleChange: ScheduleChangeView }> {
  const change = await toChange(session, doctorId, input, now);
  const applied = await applyScheduleChange(session, doctorId, change, confirmation, now);
  return {
    timeOff: { id: foundOrNotFound(applied.timeOffId), ...instants(change), reasonCode: confirmation.reasonCode },
    scheduleChange: applied.scheduleChange,
  };
}

/** Removes time off. Its slots are open again; cancelled appointments stay cancelled (R57). */
export async function removeTimeOff(session: Session, doctorId: string, timeOffId: string): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    const doctor = await findManagedDoctor(tx, session, doctorId);
    const timeOff = foundOrNotFound(
      await tx.timeOff.findFirst({ where: { id: timeOffId, doctorId: doctor.id }, select: { id: true } }),
    );
    await tx.timeOff.delete({ where: { id: timeOff.id } });
    await writeAudit(tx, {
      actorId: session.userId,
      actorRole: session.role,
      action: "schedule.time_off_removed",
      entityType: "time_off",
      entityId: timeOff.id,
      clinicId: doctor.clinicId,
    });
    return { id: timeOff.id };
  });
}
