// The cancellation window (R34, R38 to R40, R42): the period before an appointment's start,
// set per clinic, measured as elapsed time between two instants. Never wall-clock arithmetic.
import { HOUR_MS } from "./time";
import type { Role } from "./transitions";

/**
 * The instant the window opens. It is the deadline shown to the patient (R26): the last moment
 * to reschedule, or to cancel without a late mark.
 */
export function windowOpensAt(start: Date, windowHours: number): Date {
  if (!Number.isFinite(windowHours) || windowHours < 0) {
    throw new RangeError("windowHours must be zero or more");
  }
  return new Date(start.getTime() - windowHours * HOUR_MS);
}

/** True from the instant the window opens until the start. */
export function isInsideWindow(now: Date, start: Date, windowHours: number): boolean {
  const t = now.getTime();
  return t >= windowOpensAt(start, windowHours).getTime() && t < start.getTime();
}

/** A patient can reschedule only before the window opens (R34). */
export function patientCanReschedule(now: Date, start: Date, windowHours: number): boolean {
  return now.getTime() < windowOpensAt(start, windowHours).getTime();
}

/**
 * Whether a cancellation is recorded as a late cancel. Only a patient's own cancellation
 * inside the window is (R39). A cancellation by staff or a doctor never is (R42).
 */
export function isLateCancel(role: Role, now: Date, start: Date, windowHours: number): boolean {
  return role === "patient" && isInsideWindow(now, start, windowHours);
}
