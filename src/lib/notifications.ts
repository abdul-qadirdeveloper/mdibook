// Notification events (R73 to R77). An event is recorded in the same transaction as the state
// change, then handed to the adapter after the transaction commits. The MVP adapter writes to
// the application log. A real channel replaces the adapter without any change to callers.
import type { Tx } from "@/lib/db";
import { logger } from "@/lib/logger";

export const NOTIFICATION_TYPES = ["booked", "confirmed", "rescheduled", "cancelled", "completed", "no_show"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Type, timestamp and four opaque ids. Nothing else, ever (R75). */
export interface NotificationEvent {
  type: NotificationType;
  at: Date;
  appointmentId: string;
  clinicId: string;
  patientId: string;
  doctorId: string;
}

export interface NotificationAdapter {
  deliver(event: NotificationEvent): void | Promise<void>;
}

/** Writes the event to the application log: the type and the ids. */
export const logAdapter: NotificationAdapter = {
  deliver(event) {
    logger.info(`notification.${event.type}`, {
      appointmentId: event.appointmentId,
      clinicId: event.clinicId,
      patientId: event.patientId,
      doctorId: event.doctorId,
    });
  },
};

let adapter: NotificationAdapter = logAdapter;

/** Swaps the delivery channel. Pass null to go back to the log adapter. */
export function setNotificationAdapter(next: NotificationAdapter | null): void {
  adapter = next ?? logAdapter;
}

/** Records the event inside the transaction that makes the state change (R77). */
export async function recordNotification(
  tx: Tx,
  event: Omit<NotificationEvent, "at">,
): Promise<NotificationEvent> {
  const row = await tx.notificationEvent.create({
    data: {
      type: event.type,
      appointmentId: event.appointmentId,
      clinicId: event.clinicId,
      patientId: event.patientId,
      doctorId: event.doctorId,
    },
  });
  return {
    type: row.type,
    at: row.at,
    appointmentId: row.appointmentId,
    clinicId: row.clinicId,
    patientId: row.patientId,
    doctorId: row.doctorId,
  };
}

/**
 * Hands committed events to the adapter. Call it only after the transaction has committed. A
 * failing channel never undoes or fails the state change: the event is already stored.
 */
export async function deliverNotifications(events: readonly NotificationEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await adapter.deliver(event);
    } catch {
      logger.error("notification.delivery_failed", { appointmentId: event.appointmentId });
    }
  }
}
