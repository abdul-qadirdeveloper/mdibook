// Audit events (R81, R82). Every state-changing action writes one, inside the same transaction
// as the change. An event holds ids and fixed codes only, never a payload.
import { type Tx, isId } from "@/lib/db";
import type { Role } from "@/domain/transitions";

export const AUDIT_ACTIONS = [
  "appointment.booked",
  "appointment.confirmed",
  "appointment.rescheduled",
  "appointment.cancelled",
  "appointment.completed",
  "appointment.no_show",
  "patient.clinic_linked",
  "patient.profile_changed",
  "schedule.working_hours_changed",
  "schedule.breaks_changed",
  "schedule.time_off_added",
  "schedule.time_off_removed",
  "schedule.slot_length_changed",
  "clinic.settings_changed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = [
  "appointment",
  "patient",
  "doctor",
  "clinic",
  "time_off",
  "schedule_change",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export interface AuditInput {
  actorId: string;
  actorRole: Role;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  /** Null only for an action that belongs to no clinic, such as a patient changing their own profile. */
  clinicId: string | null;
}

/** Writes one audit event. The UTC timestamp is set by the database. */
export async function writeAudit(tx: Tx, event: AuditInput): Promise<void> {
  if (!isId(event.actorId) || !isId(event.entityId) || (event.clinicId !== null && !isId(event.clinicId))) {
    throw new TypeError("Audit events hold ids only");
  }
  if (!(AUDIT_ACTIONS as readonly string[]).includes(event.action)) {
    throw new TypeError("Unknown audit action");
  }
  if (!(AUDIT_ENTITY_TYPES as readonly string[]).includes(event.entityType)) {
    throw new TypeError("Unknown audit entity type");
  }
  await tx.auditEvent.create({
    data: {
      actorId: event.actorId,
      actorRole: event.actorRole,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      clinicId: event.clinicId,
    },
  });
}
