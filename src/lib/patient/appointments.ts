// OWNER: Stream A. My appointments (R45): which of the patient's own appointments are
// upcoming and which are past, across all clinics. This file only finds ids inside the
// caller's scope; the route builds each response through src/lib/serialize.ts.
import { ACTIVE_STATUSES } from "@/domain/transitions";
import { type Prisma, db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { appointmentScope } from "@/lib/scope";
import type { Session } from "@/lib/session";

export const APPOINTMENT_SCOPES = ["upcoming", "past"] as const;
export type AppointmentListScope = (typeof APPOINTMENT_SCOPES)[number];

export const APPOINTMENTS_PAGE_SIZE = 50;

export interface OwnAppointmentsPage {
  /** Upcoming: soonest first. Past: most recent first. */
  ids: string[];
  /** Total in this scope, for the heading. */
  total: number;
  /** Send back as `cursor` for the next page, or null when there is none. */
  nextCursor: string | null;
}

/**
 * The patient's own appointments. Upcoming means active and starting in the future (spec
 * section 2, Terms); everything else is past: cancelled, attended, missed, or already started.
 */
export async function listOwnAppointments(
  session: Session,
  scope: AppointmentListScope,
  now: Date,
  cursor: string | null,
): Promise<OwnAppointmentsPage> {
  if (session.role !== "patient" || !session.patientId) throw new AppError("NOT_FOUND");

  const upcoming: Prisma.AppointmentWhereInput = {
    status: { in: [...ACTIVE_STATUSES] },
    startsAt: { gt: now },
  };
  // appointmentScope() narrows to the caller's own patient id. Nothing sent by the client
  // decides whose appointments these are (R7).
  const where: Prisma.AppointmentWhereInput = {
    ...appointmentScope(session),
    ...(scope === "upcoming" ? upcoming : { NOT: upcoming }),
  };
  const direction = scope === "upcoming" ? "asc" : "desc";
  const offset = cursor === null ? 0 : Number(cursor);

  const total = await db.appointment.count({ where });
  const rows = await db.appointment.findMany({
    where,
    orderBy: [{ startsAt: direction }, { id: "asc" }],
    skip: offset,
    take: APPOINTMENTS_PAGE_SIZE,
    select: { id: true },
  });
  const end = offset + rows.length;
  return { ids: rows.map((row) => row.id), total, nextCursor: end < total ? String(end) : null };
}
