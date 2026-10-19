// The logger (R78): an event code and opaque ids, nothing else.
import { afterEach, describe, expect, it } from "vitest";
import { type LogIds, logger, setLogSink } from "@/lib/logger";

const ID = "3f2b8c1e-5d47-4a9b-8e21-0c6f7a1d2b34";
const OTHER = "9a1c4e7b-2d38-4f60-a5b9-7e3d1c0f8a26";

function capture(run: () => void): { lines: Record<string, unknown>[]; raw: string } {
  const raw: string[] = [];
  setLogSink((line) => raw.push(line));
  run();
  return { lines: raw.map((l) => JSON.parse(l) as Record<string, unknown>), raw: raw.join("\n") };
}

afterEach(() => setLogSink(() => {}));

describe("logger", () => {
  it("writes one JSON line with a UTC timestamp, a level, the event and the ids", () => {
    const { lines } = capture(() => logger.info("appointment.booked", { appointmentId: ID, clinicId: OTHER }));
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(["appointmentId", "clinicId", "event", "level", "ts"]);
    expect(lines[0]).toMatchObject({ level: "info", event: "appointment.booked", appointmentId: ID, clinicId: OTHER });
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("has the three levels", () => {
    const { lines } = capture(() => {
      logger.info("a.b");
      logger.warn("a.b");
      logger.error("a.b");
    });
    expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  it("accepts every known id key", () => {
    const ids: LogIds = {
      requestId: ID,
      actorId: ID,
      userId: ID,
      clinicId: ID,
      appointmentId: ID,
      patientId: ID,
      doctorId: ID,
      staffId: ID,
      entityId: ID,
      scheduleChangeId: ID,
      timeOffId: ID,
      notificationId: ID,
    };
    const { lines } = capture(() => logger.info("a.b", ids));
    expect(lines[0]).toMatchObject(ids);
    expect(lines[0]).not.toHaveProperty("refusedFields");
  });

  it("refuses fields that are not ids: the key and the value never reach the log (R78)", () => {
    const personal = {
      fullName: "Pat Example",
      email: "pat@example.test",
      phone: "555-0100",
      dateOfBirth: "1990-05-17",
      reasonForVisit: "Fictional reason",
      notes: "Fictional clinical note",
      message: "anything at all",
    };
    const { lines, raw } = capture(() => logger.info("patient.updated", { patientId: ID, ...personal } as LogIds));
    expect(lines[0]).toEqual({
      ts: lines[0].ts,
      level: "info",
      event: "patient.updated",
      patientId: ID,
      refusedFields: 7,
    });
    for (const [key, value] of Object.entries(personal)) {
      expect(raw).not.toContain(key);
      expect(raw).not.toContain(value);
    }
  });

  it("refuses a known id key whose value is not an id", () => {
    const { lines, raw } = capture(() =>
      logger.info("a.b", {
        patientId: "Pat Example",
        userId: "pat@example.test",
        appointmentId: 42 as never,
        clinicId: { name: "Example Clinic" } as never,
      }),
    );
    expect(lines[0]).toEqual({ ts: lines[0].ts, level: "info", event: "a.b", refusedFields: 4 });
    expect(raw).not.toContain("Pat Example");
    expect(raw).not.toContain("pat@example.test");
    expect(raw).not.toContain("Example Clinic");
  });

  it("accepts sameSlotRetry only as a boolean (spec 003 R13)", () => {
    for (const flag of [true, false]) {
      const { lines } = capture(() => logger.warn("reschedule.conflict", { requestId: ID, sameSlotRetry: flag }));
      expect(lines[0]).toEqual({ ts: lines[0].ts, level: "warn", event: "reschedule.conflict", requestId: ID, sameSlotRetry: flag });
    }
    for (const value of ["true", 1, "Pat Example"]) {
      const { lines, raw } = capture(() => logger.warn("a.b", { sameSlotRetry: value as never }));
      expect(lines[0]).toEqual({ ts: lines[0].ts, level: "warn", event: "a.b", refusedFields: 1 });
      expect(raw).not.toContain("Pat Example");
    }
  });

  it("skips empty ids without counting them as refused", () => {
    const { lines } = capture(() => logger.info("a.b", { requestId: ID, actorId: undefined, clinicId: null }));
    expect(lines[0]).toEqual({ ts: lines[0].ts, level: "info", event: "a.b", requestId: ID });
  });

  it("refuses an event that is a sentence instead of a code", () => {
    const sentences = [
      "Booked for Pat Example",
      "patient pat@example.test signed in",
      "reason: Fictional reason",
      "",
      "a".repeat(121),
    ];
    for (const sentence of sentences) {
      const { lines, raw } = capture(() => logger.info(sentence, { requestId: ID }));
      expect(lines[0]).toEqual({ ts: lines[0].ts, level: "info", event: "logger.event_refused", requestId: ID });
      if (sentence) expect(raw).not.toContain(sentence);
    }
  });

  it("accepts dotted event codes, including an error code suffix", () => {
    for (const event of ["request.completed", "request.failed.SLOT_TAKEN", "notification.no_show"]) {
      const { lines } = capture(() => logger.info(event));
      expect(lines[0].event).toBe(event);
    }
  });

  it("has no way to pass a message or a payload", () => {
    // The functions take an event and ids. A third argument is ignored.
    const { lines, raw } = capture(() =>
      (logger.info as (...args: unknown[]) => void)("a.b", { requestId: ID }, { body: "Fictional reason" }),
    );
    expect(lines[0]).toEqual({ ts: lines[0].ts, level: "info", event: "a.b", requestId: ID });
    expect(raw).not.toContain("Fictional reason");
  });
});
