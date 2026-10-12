// The one error shape and the code table of spec section 4. Messages say what happened and
// what to do next, and never carry internal details or personal data (R88, R89).

export const ERRORS = {
  UNAUTHENTICATED: { status: 401, message: "You are not signed in. Sign in and try again." },
  FORBIDDEN: { status: 403, message: "Your account cannot do this." },
  NOT_FOUND: { status: 404, message: "We could not find that. Go back and try again." },
  VALIDATION_FAILED: {
    status: 422,
    message: "Some details are missing or not valid. Check the fields listed and try again.",
  },
  SLOT_TAKEN: {
    status: 409,
    message: "That time was just taken by someone else. Nothing was booked. Choose another open time.",
  },
  SLOT_UNAVAILABLE: { status: 409, message: "That time is not available. Choose another open time." },
  BOOKING_LIMIT_REACHED: {
    status: 409,
    message:
      "This patient already has the most upcoming appointments the clinic allows. Cancel one, or wait until one has passed, then try again.",
  },
  RESCHEDULE_WINDOW_CLOSED: {
    status: 409,
    message: "It is too close to the appointment to move it. You can still cancel it, or call the clinic.",
  },
  INVALID_TRANSITION: {
    status: 409,
    message: "This appointment can no longer be changed in that way. Reload to see its current status.",
  },
  TOO_EARLY: {
    status: 409,
    message: "This can be recorded only after the appointment has started. Try again then.",
  },
  PREVIEW_STALE: {
    status: 409,
    message: "The affected appointments changed since the preview. Review the new preview and confirm again.",
  },
  HAS_UPCOMING_APPOINTMENTS: {
    status: 409,
    message: "This doctor still has upcoming appointments. Cancel or complete them first, then try again.",
  },
  LINK_INVALID: { status: 410, message: "This link has been used or has expired. Request a new one." },
  RATE_LIMITED: { status: 429, message: "Too many lookups. Wait a while, then try again." },
  INTERNAL: {
    status: 500,
    message: "Something went wrong on our side. Try again, and quote the reference if you contact the clinic.",
  },
} as const;

export type ErrorCode = keyof typeof ERRORS;

/** Names the field and the problem. Never repeats the value typed (R89). */
export interface FieldProblem {
  field: string;
  problem: "required" | "too_long" | "too_short" | "invalid" | "not_allowed";
}

export interface ErrorDetails {
  fields?: FieldProblem[];
  /** With SLOT_TAKEN: the next open slots with the same doctor, as UTC instants (R23). */
  nextSlots?: { startsAt: string; endsAt: string }[];
  /** With SLOT_TAKEN: the clinic time zone to display nextSlots in. */
  timeZone?: string;
  /** With BOOKING_LIMIT_REACHED: the clinic's limit (R25). */
  limit?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, details: ErrorDetails = {}) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERRORS[this.code].status;
  }
}

export function validationError(...fields: FieldProblem[]): AppError {
  return new AppError("VALIDATION_FAILED", { fields });
}

/** A use case that its owning stream has not written yet. Reported to the caller as INTERNAL. */
export class NotImplementedError extends Error {
  readonly useCase: string;

  constructor(useCase: string) {
    super("Not implemented");
    this.name = "NotImplementedError";
    this.useCase = useCase;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId: string } & ErrorDetails;
}

/** The single error shape: a stable code, a plain message and a request reference id. */
export function errorBody(code: ErrorCode, requestId: string, details: ErrorDetails = {}): ErrorBody {
  return { error: { code, message: ERRORS[code].message, requestId, ...details } };
}
