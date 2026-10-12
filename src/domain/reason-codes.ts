// Fixed lists of reason codes. Staff and doctors never type a reason (R41, R51).
// The values match the ReasonCode enum in prisma/schema.prisma.

/** Changing working hours or breaks, or adding time off (R51). List decided in F6. */
export const SCHEDULE_CHANGE_REASON_CODES = [
  "planned_leave",
  "unplanned_absence",
  "training",
  "clinic_closure",
  "schedule_change",
  "other",
] as const;
export type ScheduleChangeReasonCode = (typeof SCHEDULE_CHANGE_REASON_CODES)[number];

/** A single appointment cancelled by staff or its doctor (R41). */
export const CANCEL_REASON_CODES = [
  "patient_request",
  "doctor_unavailable",
  "booked_in_error",
  "clinic_closure",
  "other",
] as const;
export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

export type ReasonCode = ScheduleChangeReasonCode | CancelReasonCode;

export const REASON_CODE_LABELS: Record<ReasonCode, string> = {
  patient_request: "Patient asked to cancel",
  doctor_unavailable: "Doctor unavailable",
  booked_in_error: "Booked in error",
  planned_leave: "Planned leave",
  unplanned_absence: "Unplanned absence",
  training: "Training",
  clinic_closure: "Clinic closure",
  schedule_change: "Schedule change",
  other: "Other",
};

export function isScheduleChangeReasonCode(value: unknown): value is ScheduleChangeReasonCode {
  return (SCHEDULE_CHANGE_REASON_CODES as readonly unknown[]).includes(value);
}

export function isCancelReasonCode(value: unknown): value is CancelReasonCode {
  return (CANCEL_REASON_CODES as readonly unknown[]).includes(value);
}
