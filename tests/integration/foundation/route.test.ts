// The route wrapper and the four shared appointment routes (R8, R59, R79, R83, R88, R89).
// The six use-case placeholders belong to Streams A and B and are not written yet. To prove
// the shared routes end to end, this file stands in for them with the thinnest possible
// call to the real core. The database is real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { visibleAppointmentFields } from "@/domain/visibility";
import { POST as cancelRoute } from "@/app/api/v1/appointments/[id]/cancel/route";
import { POST as rescheduleRoute } from "@/app/api/v1/appointments/[id]/reschedule/route";
import { GET as readRoute } from "@/app/api/v1/appointments/[id]/route";
import { POST as bookRoute } from "@/app/api/v1/appointments/route";
import { db } from "@/lib/db";
import { AppError, ERRORS, NotImplementedError } from "@/lib/errors";
import { route } from "@/lib/route";
import { idSchema, reasonForVisitSchema } from "@/lib/schemas";
import { NOW, at, captureLogs, freezeClock, hoursBefore, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createAdmin, createClinic, createDoctor, createPatient, createStaff, createWorld } from "../../helpers/factories";
import { apiRequest, call } from "../../helpers/request";

vi.mock("@/lib/patient/book", async () => {
  const core = await import("@/lib/appointments/core");
  return {
    bookAsPatient: (session: never, input: { doctorId: string; start: Date; reasonForVisit: string; idempotencyKey: string | null }, now: Date) =>
      core.bookAppointment(
        { actor: session, patientId: (session as { patientId: string }).patientId, doctorId: input.doctorId, start: input.start, reasonForVisit: input.reasonForVisit, idempotencyKey: input.idempotencyKey },
        now,
      ),
  };
});
vi.mock("@/lib/clinic/book", async () => {
  const core = await import("@/lib/appointments/core");
  return {
    bookAsClinic: (session: never, input: { doctorId: string; patientId: string; start: Date; reasonForVisit: string; idempotencyKey: string | null }, now: Date) =>
      core.bookAppointment({ actor: session, ...input }, now),
  };
});
vi.mock("@/lib/patient/reschedule", async () => {
  const core = await import("@/lib/appointments/core");
  return {
    rescheduleAsPatient: (session: never, input: { appointmentId: string; start: Date }, now: Date) =>
      core.rescheduleAppointment({ actor: session, appointmentId: input.appointmentId, newStart: input.start }, now),
  };
});
vi.mock("@/lib/clinic/reschedule", async () => {
  const core = await import("@/lib/appointments/core");
  return {
    rescheduleAsClinic: (session: never, input: { appointmentId: string; start: Date }, now: Date) =>
      core.rescheduleAppointment({ actor: session, appointmentId: input.appointmentId, newStart: input.start }, now),
  };
});
vi.mock("@/lib/patient/cancel", async () => {
  const core = await import("@/lib/appointments/core");
  return {
    cancelAsPatient: async (session: never, input: { appointmentId: string }, now: Date) => {
      const result = await core.changeAppointmentStatus({ actor: session, appointmentId: input.appointmentId, to: "cancelled" }, now);
      return { appointmentId: result.appointmentId, late: result.lateCancel };
    },
  };
});
vi.mock("@/lib/clinic/cancel", async () => {
  const core = await import("@/lib/appointments/core");
  return {
    cancelAsClinic: (session: never, input: { appointmentId: string; code: never }, now: Date) =>
      core.changeAppointmentStatus({ actor: session, appointmentId: input.appointmentId, to: "cancelled", reasonCode: input.code }, now),
  };
});

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const S0900 = at("2026-10-14", "09:00");
const S1000 = at("2026-10-14", "10:00");

type ErrorJson = { error: { code: string; message: string; requestId: string; fields?: { field: string; problem: string }[]; nextSlots?: unknown[]; limit?: number } };
type AppointmentJson = { appointment: Record<string, unknown>; recordedAsLate?: boolean };

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => {
  restoreClock();
  vi.unstubAllEnvs();
});

// A route built only for these tests: staff may post a reason and a doctor id.
let acted = 0;
const probe = route({
  roles: ["staff"],
  query: z.object({ search: z.string().max(5).optional() }),
  body: z.strictObject({ doctorId: idSchema, reasonForVisit: reasonForVisitSchema }),
  handler: async ({ session, body, requestId }) => {
    acted += 1;
    return { status: 201, body: { ok: true, role: session.role, doctorId: body.doctorId, requestId } };
  },
});
const validBody = () => ({ doctorId: w.doctor.id, reasonForVisit: "Fictional reason" });

describe("the four steps, in order", () => {
  beforeEach(() => {
    acted = 0;
  });

  it("1. authenticates first: no session is 401, whatever else is wrong", async () => {
    const result = await call<ErrorJson>(probe, apiRequest("POST", "/probe", { rawBody: "{not json" }));
    expect(result.status).toBe(401);
    expect(result.json.error.code).toBe("UNAUTHENTICATED");
    expect(acted).toBe(0);
  });

  it("2. then authorizes by role: the wrong role is 403 before input is looked at", async () => {
    for (const userId of [w.patientUser.id, w.doctorUser.id]) {
      const result = await call<ErrorJson>(probe, apiRequest("POST", "/probe", { userId, rawBody: "{not json" }));
      expect(result.status).toBe(403);
      expect(result.json.error.code).toBe("FORBIDDEN");
      expect(result.json.error.fields).toBeUndefined();
    }
    expect(acted).toBe(0);
  });

  it("3. then validates: bad input from the right role is 422 and the action does not run", async () => {
    const result = await call<ErrorJson>(probe, apiRequest("POST", "/probe", { userId: w.staffUser.id, body: {} }));
    expect(result.status).toBe(422);
    expect(result.json.error.code).toBe("VALIDATION_FAILED");
    expect(acted).toBe(0);
  });

  it("4. then acts", async () => {
    const result = await call(probe, apiRequest("POST", "/probe", { userId: w.staffUser.id, body: validBody() }));
    expect(result.status).toBe(201);
    expect(result.json).toMatchObject({ ok: true, role: "staff", doctorId: w.doctor.id });
    expect(acted).toBe(1);
  });

  it("an inactive account has no session", async () => {
    await db.user.update({ where: { id: w.staffUser.id }, data: { active: false } });
    const result = await call<ErrorJson>(probe, apiRequest("POST", "/probe", { userId: w.staffUser.id, body: validBody() }));
    expect(result.status).toBe(401);
  });
});

describe("the one error shape (R88)", () => {
  it("has a stable code, a plain message and a reference id, and nothing else", async () => {
    const result = await call<ErrorJson>(probe, apiRequest("POST", "/probe"));
    expect(Object.keys(result.json)).toEqual(["error"]);
    expect(Object.keys(result.json.error).sort()).toEqual(["code", "message", "requestId"]);
    expect(result.json.error.message).toBe(ERRORS.UNAUTHENTICATED.message);
    expect(result.json.error.requestId).toMatch(UUID);
    expect(result.headers.get("x-request-id")).toBe(result.json.error.requestId);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("gives every request its own reference id, on success too", async () => {
    const first = await call<{ requestId: string }>(probe, apiRequest("POST", "/probe", { userId: w.staffUser.id, body: validBody() }));
    const second = await call<{ requestId: string }>(probe, apiRequest("POST", "/probe", { userId: w.staffUser.id, body: validBody() }));
    expect(first.headers.get("x-request-id")).toBe(first.json.requestId);
    expect(first.json.requestId).not.toBe(second.json.requestId);
  });

  it("every message says what happened and what to do next, with no internals", () => {
    for (const [code, entry] of Object.entries(ERRORS)) {
      expect(entry.message.split(". ").length, code).toBeGreaterThanOrEqual(code === "FORBIDDEN" ? 1 : 2);
      expect(entry.message, code).not.toMatch(/sql|prisma|stack|exception|constraint|null|undefined/i);
    }
  });

  it("an unexpected error is INTERNAL with a reference id only", async () => {
    const failing = route({
      roles: ["staff"],
      handler: async () => {
        throw new Error("duplicate key for pat@example.test in SELECT * FROM secrets");
      },
    });
    const { result, lines, raw } = await captureLogs(() =>
      call<ErrorJson>(failing, apiRequest("GET", "/failing", { userId: w.staffUser.id })),
    );
    expect(result.status).toBe(500);
    expect(Object.keys(result.json.error).sort()).toEqual(["code", "message", "requestId"]);
    expect(result.json.error.code).toBe("INTERNAL");
    expect(JSON.stringify(result.json)).not.toMatch(/duplicate|pat@example|SELECT|stack/);
    // The log has the class of the error and the ids, never its message.
    expect(lines).toEqual([
      { ts: lines[0].ts, level: "error", event: "request.failed.INTERNAL.Error", requestId: result.json.error.requestId, actorId: w.staffUser.id },
    ]);
    expect(raw).not.toMatch(/duplicate|pat@example|SELECT/);
  });

  it("a use case its stream has not written yet is INTERNAL", async () => {
    const pending = route({
      roles: ["staff"],
      handler: async () => {
        throw new NotImplementedError("clinic.book");
      },
    });
    const result = await call<ErrorJson>(pending, apiRequest("GET", "/pending", { userId: w.staffUser.id }));
    expect(result.status).toBe(500);
    expect(result.json.error.code).toBe("INTERNAL");
  });

  it("an application error carries its code, status and details", async () => {
    const limited = route({
      roles: ["staff"],
      handler: async () => {
        throw new AppError("BOOKING_LIMIT_REACHED", { limit: 3 });
      },
    });
    const result = await call<ErrorJson>(limited, apiRequest("GET", "/limited", { userId: w.staffUser.id }));
    expect(result.status).toBe(409);
    expect(result.json.error).toMatchObject({ code: "BOOKING_LIMIT_REACHED", limit: 3 });
  });

  it("refuses to serve anything in production, where the session stand-in must not run", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = await call<ErrorJson>(probe, apiRequest("POST", "/probe", { userId: w.staffUser.id, body: validBody() }));
    expect(result.status).toBe(500);
    expect(result.json.error.code).toBe("INTERNAL");
  });
});

describe("validation errors name the field and the problem, never the value (R89)", () => {
  const post = (body: unknown, extra: { path?: string; headers?: Record<string, string>; rawBody?: string } = {}) =>
    call<ErrorJson>(
      probe,
      apiRequest("POST", extra.path ?? "/probe", { userId: w.staffUser.id, body, rawBody: extra.rawBody, headers: extra.headers }),
    );

  it("too long, required, invalid", async () => {
    const secret = `Private-${"x".repeat(200)}`;
    const result = await post({ doctorId: "not-an-id-but-typed-by-user", reasonForVisit: secret });
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([
      { field: "doctorId", problem: "invalid" },
      { field: "reasonForVisit", problem: "too_long" },
    ]);
    const text = JSON.stringify(result.json);
    expect(text).not.toContain("Private-");
    expect(text).not.toContain("not-an-id-but-typed-by-user");

    const missing = await post({ doctorId: w.doctor.id });
    expect(missing.json.error.fields).toEqual([{ field: "reasonForVisit", problem: "required" }]);

    const empty = await post({ doctorId: w.doctor.id, reasonForVisit: "   " });
    expect(empty.json.error.fields).toEqual([{ field: "reasonForVisit", problem: "too_short" }]);
  });

  it("refuses fields the route does not know", async () => {
    const result = await post({ ...validBody(), clinicId: w.clinic.id, role: "admin" });
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([{ field: "body", problem: "not_allowed" }]);
  });

  it("refuses a body that is not JSON", async () => {
    const result = await post(undefined, { rawBody: '{"reasonForVisit": "Private matter' });
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([{ field: "body", problem: "invalid" }]);
    expect(JSON.stringify(result.json)).not.toContain("Private matter");
  });

  it("reports query and header problems the same way", async () => {
    const result = await post(validBody(), { path: "/probe?search=far-too-long-secret", headers: { "idempotency-key": "bad key!" } });
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([
      { field: "search", problem: "too_long" },
      { field: "Idempotency-Key", problem: "invalid" },
    ]);
    expect(JSON.stringify(result.json)).not.toMatch(/far-too-long-secret|bad key/);
  });
});

describe("logging (R78, R79)", () => {
  it("request bodies and query values are absent from the log, on success and on failure", async () => {
    const { lines, raw } = await captureLogs(async () => {
      await call(probe, apiRequest("POST", "/probe?search=qqqq", { userId: w.staffUser.id, body: { doctorId: w.doctor.id, reasonForVisit: "Fictional private reason" } }));
      await call(probe, apiRequest("POST", "/probe?search=zzzzzzzzzz", { userId: w.staffUser.id, body: { doctorId: "typed-value", reasonForVisit: "Another private reason" } }));
      await call(probe, apiRequest("POST", "/probe?search=qqqq", { body: { reasonForVisit: "Unsigned private reason" } }));
    });
    expect(lines.map((l) => l.event)).toEqual([
      "request.completed",
      "request.failed.VALIDATION_FAILED",
      "request.failed.UNAUTHENTICATED",
    ]);
    for (const line of lines) {
      const keys = Object.keys(line).sort();
      expect(["actorId", "event", "level", "requestId", "ts"]).toEqual(expect.arrayContaining(keys));
      expect(line.requestId).toMatch(UUID);
    }
    expect(lines[0].actorId).toBe(w.staffUser.id);
    expect(lines[2]).not.toHaveProperty("actorId");
    expect(raw).not.toMatch(/private reason|typed-value|zzzzzzzzzz|qqqq|search|reasonForVisit/);
    expect(raw).not.toContain(w.doctor.id);
  });
});

describe("shared routes: book, read, reschedule, cancel", () => {
  const bookAs = (userId: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
    call<AppointmentJson & ErrorJson>(bookRoute, apiRequest("POST", "/api/v1/appointments", { userId, body, headers }));
  const read = (userId: string | undefined, id: string) =>
    call<AppointmentJson & ErrorJson>(readRoute, apiRequest("GET", `/api/v1/appointments/${id}`, { userId }), { id });
  const patientBody = (start = S0900) => ({ doctorId: w.doctor.id, startsAt: start.toISOString(), reasonForVisit: "Fictional reason" });

  it("a patient books: 201, requested, and only the fields a patient may see (R59, R83)", async () => {
    const result = await bookAs(w.patientUser.id, patientBody());
    expect(result.status).toBe(201);
    const a = result.json.appointment;
    expect(Object.keys(a).sort()).toEqual(visibleAppointmentFields("patient").sort());
    expect(a).toMatchObject({
      status: "requested",
      startsAt: S0900.toISOString(),
      endsAt: at("2026-10-14", "09:30").toISOString(),
      slotLengthMinutes: 30,
      timeZone: "America/Chicago",
      cancellationDeadline: hoursBefore(S0900, 24).toISOString(),
      doctorName: w.doctor.name,
      clinicName: w.clinic.name,
      patientName: w.patient.fullName,
      patientEmail: w.patientUser.email,
      dateOfBirth: "1990-05-17",
      reasonForVisit: "Fictional reason",
      cancelledBy: null,
    });
    expect(a).not.toHaveProperty("idempotencyKey");
  });

  it("staff book for a patient: confirmed, and the reason they typed is not returned (R28, R29)", async () => {
    const result = await bookAs(w.staffUser.id, { ...patientBody(), patientId: w.patient.id });
    expect(result.status).toBe(201);
    const a = result.json.appointment;
    expect(Object.keys(a).sort()).toEqual(visibleAppointmentFields("staff").sort());
    expect(a).toMatchObject({ status: "confirmed", bookedByRole: "staff", bookedById: w.staffUser.id, noShowCount: 0 });
    for (const hidden of ["reasonForVisit", "dateOfBirth", "patientAge"]) expect(a).not.toHaveProperty(hidden);
    expect(JSON.stringify(result.json)).not.toMatch(/Fictional reason|1990-05-17/);
  });

  it("dispatches by role: staff must name the patient, a patient must not, staff send no date of birth", async () => {
    const noPatient = await bookAs(w.staffUser.id, patientBody());
    expect(noPatient.status).toBe(422);
    expect(noPatient.json.error.fields).toEqual([{ field: "patientId", problem: "required" }]);

    const withBirth = await bookAs(w.staffUser.id, { ...patientBody(), patientId: w.patient.id, dateOfBirth: "1990-05-17" });
    expect(withBirth.json.error.fields).toEqual([{ field: "dateOfBirth", problem: "not_allowed" }]);

    const forSomeoneElse = await bookAs(w.patientUser.id, { ...patientBody(), patientId: w.patient.id });
    expect(forSomeoneElse.json.error.fields).toEqual([{ field: "patientId", problem: "not_allowed" }]);

    const doctor = await bookAs(w.doctorUser.id, patientBody());
    expect(doctor.status).toBe(403);
    expect(await db.appointment.count()).toBe(0);
  });

  it("a lost race is 409 SLOT_TAKEN with the next three slots, and nothing is booked (R23)", async () => {
    await bookAs(w.patientUser.id, patientBody());
    const other = await createPatient();
    const result = await bookAs(other.user.id, patientBody());
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_TAKEN");
    expect(result.json.error.nextSlots).toHaveLength(3);
    expect(await db.appointment.count()).toBe(1);
  });

  it("the same Idempotency-Key twice: 201, then 200 with the same appointment (R27)", async () => {
    const headers = { "idempotency-key": "retry-after-timeout-01" };
    const first = await bookAs(w.patientUser.id, patientBody(), headers);
    const second = await bookAs(w.patientUser.id, patientBody(), headers);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.json.appointment.id).toBe(first.json.appointment.id);
    expect(await db.appointment.count()).toBe(1);
  });

  it("each role reads exactly its own field list (R59)", async () => {
    const id = (await bookAs(w.patientUser.id, patientBody())).json.appointment.id as string;
    for (const [role, userId] of [
      ["patient", w.patientUser.id],
      ["doctor", w.doctorUser.id],
      ["staff", w.staffUser.id],
    ] as const) {
      const result = await read(userId, id);
      expect(result.status, role).toBe(200);
      expect(Object.keys(result.json.appointment).sort(), role).toEqual(visibleAppointmentFields(role).sort());
    }
    const asDoctor = (await read(w.doctorUser.id, id)).json.appointment;
    expect(asDoctor).toMatchObject({ patientAge: 36, reasonForVisit: "Fictional reason", noShowCount: 0 });
    expect(JSON.stringify(asDoctor)).not.toMatch(/1990-05-17|555-0100|@example\.test/);
    const asStaff = (await read(w.staffUser.id, id)).json.appointment;
    expect(asStaff).toMatchObject({ patientPhone: "555-0100", lateCancel: false });
    expect((asStaff.history as { action: string }[]).map((h) => h.action)).toEqual(["booked"]);
    expect(JSON.stringify(asStaff)).not.toMatch(/Fictional reason|1990-05-17/);
  });

  it("out of scope is the same NOT_FOUND as missing; an admin is refused; no session is 401 (R8, R94)", async () => {
    const id = (await bookAs(w.patientUser.id, patientBody())).json.appointment.id as string;
    const stranger = await createPatient();
    const colleague = await createDoctor(w.clinic.id);
    const elsewhere = await createStaff((await createClinic()).id);
    const admin = await createAdmin();

    const missing = await read(w.patientUser.id, w.clinic.id);
    expect(missing.status).toBe(404);
    const shape = (json: ErrorJson) => ({ ...json.error, requestId: "" });
    for (const userId of [stranger.user.id, colleague.user.id, elsewhere.user.id]) {
      const result = await read(userId, id);
      expect(result.status).toBe(404);
      expect(shape(result.json)).toEqual(shape(missing.json));
    }
    const malformed = await call<ErrorJson>(readRoute, apiRequest("GET", "/api/v1/appointments/1", { userId: w.patientUser.id }), { id: "1" });
    expect(malformed.status).toBe(404);
    expect(shape(malformed.json)).toEqual(shape(missing.json));

    expect((await read(admin.id, id)).status).toBe(403);
    expect((await read(undefined, id)).status).toBe(401);
  });

  it("the no-show count is for this clinic only (R66)", async () => {
    const first = (await bookAs(w.patientUser.id, patientBody())).json.appointment.id as string;
    const { changeAppointmentStatus } = await import("@/lib/appointments/core");
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: first, to: "no_show" }, at("2026-10-14", "10:00"));
    // A no-show at another clinic does not count here.
    const other = await createWorld();
    await db.appointment.create({
      data: {
        clinicId: other.clinic.id,
        doctorId: other.doctor.id,
        patientId: w.patient.id,
        startsAt: at("2026-10-01", "09:00"),
        endsAt: at("2026-10-01", "09:30"),
        status: "no_show",
        reasonForVisit: "Fictional reason",
        bookedById: w.patientUser.id,
        bookedByRole: "patient",
      },
    });
    const second = (await bookAs(w.patientUser.id, patientBody(at("2026-10-15", "09:00")))).json.appointment.id as string;
    expect((await read(w.staffUser.id, second)).json.appointment.noShowCount).toBe(1);
    expect((await read(w.doctorUser.id, second)).json.appointment.noShowCount).toBe(1);
    expect((await read(w.patientUser.id, second)).json.appointment).not.toHaveProperty("noShowCount");
  });

  it("reschedule: moves the appointment; a patient's move of a confirmed one returns it to requested", async () => {
    const id = (await bookAs(w.staffUser.id, { ...patientBody(), patientId: w.patient.id })).json.appointment.id as string;
    const result = await call<AppointmentJson & ErrorJson>(
      rescheduleRoute,
      apiRequest("POST", `/api/v1/appointments/${id}/reschedule`, { userId: w.patientUser.id, body: { startsAt: S1000.toISOString() } }),
      { id },
    );
    expect(result.status).toBe(200);
    expect(result.json.appointment).toMatchObject({ id, startsAt: S1000.toISOString(), status: "requested" });

    const bad = await call<ErrorJson>(
      rescheduleRoute,
      apiRequest("POST", `/api/v1/appointments/${id}/reschedule`, { userId: w.patientUser.id, body: { startsAt: "tomorrow at ten" } }),
      { id },
    );
    expect(bad.status).toBe(422);
    expect(bad.json.error.fields).toEqual([{ field: "startsAt", problem: "invalid" }]);
  });

  it("cancel: a patient sends no reason and is told whether it was late (R39)", async () => {
    const id = (await bookAs(w.patientUser.id, patientBody())).json.appointment.id as string;
    const withReason = await call<ErrorJson>(
      cancelRoute,
      apiRequest("POST", `/api/v1/appointments/${id}/cancel`, { userId: w.patientUser.id, body: { reasonCode: "other" } }),
      { id },
    );
    expect(withReason.json.error.fields).toEqual([{ field: "reasonCode", problem: "not_allowed" }]);

    freezeClock(hoursBefore(S0900, 3));
    const result = await call<AppointmentJson>(
      cancelRoute,
      apiRequest("POST", `/api/v1/appointments/${id}/cancel`, { userId: w.patientUser.id }),
      { id },
    );
    expect(result.status).toBe(200);
    expect(result.json.recordedAsLate).toBe(true);
    expect(result.json.appointment).toMatchObject({ status: "cancelled", cancelledBy: "patient" });
    // The flag itself is for staff only.
    expect(result.json.appointment).not.toHaveProperty("lateCancel");
    expect((await read(w.staffUser.id, id)).json.appointment).toMatchObject({ lateCancel: true, cancelledByRole: "patient" });
  });

  it("cancel: staff and doctors must choose a listed reason, which the patient never sees (R41, R55)", async () => {
    const id = (await bookAs(w.patientUser.id, patientBody())).json.appointment.id as string;
    const cancel = (userId: string, body?: unknown) =>
      call<AppointmentJson & ErrorJson>(cancelRoute, apiRequest("POST", `/api/v1/appointments/${id}/cancel`, { userId, body }), { id });

    expect((await cancel(w.staffUser.id)).json.error.fields).toEqual([{ field: "reasonCode", problem: "required" }]);
    expect((await cancel(w.staffUser.id, { reasonCode: "because I said so" })).json.error.fields).toEqual([
      { field: "reasonCode", problem: "invalid" },
    ]);
    expect((await cancel(w.staffUser.id, { reasonCode: "other", note: "free text" })).status).toBe(422);
    expect((await db.appointment.findUniqueOrThrow({ where: { id } })).status).toBe("requested");

    const done = await cancel(w.doctorUser.id, { reasonCode: "doctor_unavailable" });
    expect(done.status).toBe(200);
    expect(done.json.appointment).toMatchObject({ status: "cancelled", cancelledBy: "clinic", cancelReasonCode: "doctor_unavailable", cancelledByRole: "doctor" });
    expect(done.json).not.toHaveProperty("recordedAsLate");

    const asPatient = (await read(w.patientUser.id, id)).json.appointment;
    expect(asPatient).toMatchObject({ status: "cancelled", cancelledBy: "clinic" });
    expect(JSON.stringify(asPatient)).not.toContain("doctor_unavailable");

    const again = await cancel(w.staffUser.id, { reasonCode: "other" });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("INVALID_TRANSITION");
  });
});
