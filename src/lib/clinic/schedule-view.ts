// The daily and weekly schedule (R58 to R61). A doctor sees their own; staff choose a doctor
// of their clinic. Each appointment carries only the fields the caller's role may see.
import { type LocalDate, addDays, localDateOf, localToInstant, weekdayOf } from "@/domain/time";
import { db } from "@/lib/db";
import { validationError } from "@/lib/errors";
import { appointmentScope } from "@/lib/scope";
import type { AppointmentResponse } from "@/lib/serialize";
import type { Session } from "@/lib/session";
import { readAppointments } from "./schedule-change";
import { findManagedDoctor } from "./schedule-settings";

export interface ScheduleViewInput {
  /** Staff must choose one. A doctor's own is used when omitted. */
  doctorId?: string;
  view: "day" | "week";
  /** A clinic date. Today in the clinic's zone when omitted. */
  date?: LocalDate;
}

export interface ScheduleView {
  doctorId: string;
  view: "day" | "week";
  timeZone: string;
  /** The instants the view covers: from is included, to is not. */
  from: string;
  to: string;
  /** One entry per clinic date, Monday to Sunday for a week. */
  days: { date: LocalDate; appointments: AppointmentResponse[] }[];
}

export async function readSchedule(session: Session, input: ScheduleViewInput, now: Date): Promise<ScheduleView> {
  const doctorId = input.doctorId ?? (session.role === "doctor" ? session.doctorId : null);
  if (!doctorId) throw validationError({ field: "doctorId", problem: "required" });
  const doctor = await findManagedDoctor(db, session, doctorId);

  const zone = doctor.timeZone;
  const date = input.date ?? localDateOf(now, zone);
  const first = input.view === "week" ? addDays(date, 1 - weekdayOf(date)) : date;
  const dates = Array.from({ length: input.view === "week" ? 7 : 1 }, (_, i) => addDays(first, i));
  // A clinic day runs from local midnight to the next: 23 or 25 hours when the clocks change.
  const from = localToInstant(first, 0, zone);
  const to = localToInstant(addDays(dates[dates.length - 1], 1), 0, zone);

  const rows = await db.appointment.findMany({
    where: { AND: [{ doctorId: doctor.id, startsAt: { gte: from, lt: to } }, appointmentScope(session)] },
    select: { id: true, startsAt: true },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  const appointments = await readAppointments(
    session,
    rows.map((r) => r.id),
    now,
  );

  return {
    doctorId: doctor.id,
    view: input.view,
    timeZone: zone,
    from: from.toISOString(),
    to: to.toISOString(),
    days: dates.map((day) => ({
      date: day,
      appointments: appointments.filter((_, i) => localDateOf(rows[i].startsAt, zone) === day),
    })),
  };
}
