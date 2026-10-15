// The audit trail of one appointment (R81), oldest first. Events hold ids and fixed codes only.
import { db } from "@/lib/db";
import { foundOrNotFound } from "@/lib/scope";

export interface AppointmentHistoryEvent {
  id: string;
  action: string;
  actorId: string;
  actorRole: string;
  at: string;
}

export interface AppointmentHistory {
  appointmentId: string;
  events: AppointmentHistoryEvent[];
}

export async function readAppointmentHistory(appointmentId: string): Promise<AppointmentHistory> {
  const appointment = foundOrNotFound(
    await db.appointment.findUnique({ where: { id: appointmentId }, select: { id: true } }),
  );
  const events = await db.auditEvent.findMany({
    where: { entityType: "appointment", entityId: appointment.id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
    select: { id: true, action: true, actorId: true, actorRole: true, at: true },
  });
  return {
    appointmentId: appointment.id,
    events: events.map((event) => ({ ...event, at: event.at.toISOString() })),
  };
}
