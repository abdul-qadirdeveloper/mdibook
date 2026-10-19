// All application logging goes through here (R78, R79). A log line is an event code plus
// opaque ids, plus at most the one boolean flag below: there is no message argument and no way
// to attach a payload.
// A field that is not a known id key, or whose value is not an id, is dropped and counted.

const ID_KEYS = [
  "requestId",
  "actorId",
  "userId",
  "clinicId",
  "appointmentId",
  "patientId",
  "doctorId",
  "staffId",
  "entityId",
  "scheduleChangeId",
  "timeOffId",
  "notificationId",
] as const;

// The one field that is not an id: a server-computed yes or no on reschedule.conflict (spec 003
// R13, R14). Any other value for it is refused like a field that is not an id.
const FLAG_KEYS = ["sameSlotRetry"] as const;

export type LogIdKey = (typeof ID_KEYS)[number];
export type LogFlagKey = (typeof FLAG_KEYS)[number];
export type LogIds = Partial<Record<LogIdKey, string | null | undefined>> & Partial<Record<LogFlagKey, boolean>>;
export type LogLevel = "info" | "warn" | "error";

// An event is a code such as "appointment.booked" or "request.failed.SLOT_TAKEN", never a sentence.
const EVENT_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const MAX_EVENT_LENGTH = 120;
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sink = (line: string) => void;
const defaultSink: Sink = (line) => {
  process.stdout.write(`${line}\n`);
};
let sink: Sink = defaultSink;

/** Replaces where lines go. Used by tests; pass null to restore standard output. */
export function setLogSink(next: Sink | null): void {
  sink = next ?? defaultSink;
}

function write(level: LogLevel, event: string, ids?: LogIds): void {
  const validEvent = typeof event === "string" && event.length <= MAX_EVENT_LENGTH && EVENT_SHAPE.test(event);
  const entry: Record<string, string | number | boolean> = {
    ts: new Date().toISOString(),
    level,
    event: validEvent ? event : "logger.event_refused",
  };
  let refused = 0;
  for (const [key, value] of Object.entries(ids ?? {})) {
    if (value === null || value === undefined) continue;
    if ((ID_KEYS as readonly string[]).includes(key) && typeof value === "string" && ID_SHAPE.test(value)) {
      entry[key] = value;
    } else if ((FLAG_KEYS as readonly string[]).includes(key) && typeof value === "boolean") {
      entry[key] = value;
    } else {
      refused += 1;
    }
  }
  // Only the count is recorded, never the refused key or value.
  if (refused > 0) entry.refusedFields = refused;
  sink(JSON.stringify(entry));
}

export const logger = {
  info: (event: string, ids?: LogIds) => write("info", event, ids),
  warn: (event: string, ids?: LogIds) => write("warn", event, ids),
  error: (event: string, ids?: LogIds) => write("error", event, ids),
};
