// The appointment status transition table of R64. Every status change in the application is
// checked here; nothing sets a status directly.

export const ROLES = ["patient", "doctor", "staff", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const STATUSES = ["requested", "confirmed", "cancelled", "completed", "no_show"] as const;
export type Status = (typeof STATUSES)[number];

/** "none" is an appointment that does not exist yet. */
export type FromStatus = Status | "none";

export const ACTIVE_STATUSES = ["requested", "confirmed"] as const satisfies readonly Status[];
export const FINAL_STATUSES = ["cancelled", "completed", "no_show"] as const satisfies readonly Status[];

/** An active appointment holds its slot. */
export function isActive(status: Status): boolean {
  return (ACTIVE_STATUSES as readonly Status[]).includes(status);
}

type Timing = "any" | "before_start" | "after_start";

interface Rule {
  from: readonly FromStatus[];
  to: Status;
  roles: readonly Role[];
  timing: Timing;
  /** Allowed only as part of a reschedule (R36). */
  onlyViaReschedule?: boolean;
}

// One row per row of the table in spec section 2, "Status transitions (R64)".
const RULES: readonly Rule[] = [
  { from: ["none"], to: "requested", roles: ["patient"], timing: "any" },
  { from: ["none"], to: "confirmed", roles: ["staff"], timing: "any" },
  { from: ["requested"], to: "confirmed", roles: ["staff", "doctor"], timing: "before_start" },
  {
    from: ["requested", "confirmed"],
    to: "cancelled",
    roles: ["patient", "staff", "doctor"],
    timing: "before_start",
  },
  {
    from: ["confirmed"],
    to: "requested",
    roles: ["patient"],
    timing: "before_start",
    onlyViaReschedule: true,
  },
  { from: ["requested", "confirmed"], to: "completed", roles: ["staff", "doctor"], timing: "after_start" },
  { from: ["requested", "confirmed"], to: "no_show", roles: ["staff", "doctor"], timing: "after_start" },
];

export interface TransitionRequest {
  from: FromStatus;
  to: Status;
  role: Role;
  /** The appointment's start instant. */
  start: Date;
  now: Date;
  /** True when the change is part of a reschedule. */
  viaReschedule?: boolean;
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; code: "INVALID_TRANSITION" | "TOO_EARLY" };

/**
 * Allows a status change only if the table lists it for this role and the timing condition
 * holds. Completed and no-show before the start are TOO_EARLY (R63); everything else outside
 * the table is INVALID_TRANSITION.
 */
export function checkTransition(request: TransitionRequest): TransitionResult {
  const rule = RULES.find(
    (r) =>
      r.to === request.to &&
      r.from.includes(request.from) &&
      r.roles.includes(request.role) &&
      Boolean(r.onlyViaReschedule) === Boolean(request.viaReschedule),
  );
  if (!rule) return { ok: false, code: "INVALID_TRANSITION" };

  const started = request.now.getTime() >= request.start.getTime();
  if (rule.timing === "after_start" && !started) return { ok: false, code: "TOO_EARLY" };
  if (rule.timing === "before_start" && started) return { ok: false, code: "INVALID_TRANSITION" };
  return { ok: true };
}

/**
 * The status an appointment has after a reschedule (R36): a patient's move returns a confirmed
 * appointment to requested, so the clinic confirms the new time. Staff and doctor moves keep
 * the status.
 */
export function statusAfterReschedule(status: Status, role: Role): Status {
  return role === "patient" && status === "confirmed" ? "requested" : status;
}
