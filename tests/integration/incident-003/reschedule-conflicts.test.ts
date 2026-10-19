// Incident 003 (docs/003-incident-reschedule-conflicts/spec.md): a reschedule that loses its slot.
// The answer stays 409 SLOT_TAKEN, says the appointment was not moved, offers the open slots
// nearest the taken one, changes nothing, and writes one ids-only reschedule.conflict log line.
// R12 (Idempotency-Key) is deferred (spec F5) and is not tested here. The database is real.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, hoursBefore, minutesAfter, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createPatient, createWorld } from "../../helpers/factories";
import { book as bookCore, counts } from "../clinic/support";
import { type ErrorJson, REASON, book, bookingBody, openStarts, reschedule, shape } from "../patient/api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
let id: string;

const DAY = "2026-10-14";
const S1 = at(DAY, "09:00");
const S2 = at(DAY, "10:00");
const to = (start: Date) => ({ startsAt: start.toISOString() });
const row = () => db.appointment.findUniqueOrThrow({ where: { id } });
const offeredStarts = (json: ErrorJson) => json.error.nextSlots?.map((slot) => slot.startsAt) ?? [];
const conflictLines = (lines: Record<string, unknown>[]) => lines.filter((l) => l.event === "reschedule.conflict");

/** P's appointment is at S1, and another patient holds S2. */
async function takeS2() {
  const other = await createPatient();
  expect((await book(other.user.id, bookingBody(w.doctor.id, S2))).status).toBe(201);
  return other;
}

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
  id = (await book(w.patientUser.id, bookingBody(w.doctor.id, S1))).json.appointment.id;
});

afterEach(() => {
  restoreClock();
});

describe("the conflict answer (R1 to R8)", () => {
  it("a taken slot answers 409 SLOT_TAKEN for patient, doctor and staff (R1), with the same slots and message for each (R19)", async () => {
    await takeS2();
    const answers = [];
    for (const userId of [w.patientUser.id, w.doctorUser.id, w.staffUser.id]) {
      const result = await reschedule(userId, id, to(S2));
      expect(result.status).toBe(409);
      expect(result.json.error.code).toBe("SLOT_TAKEN");
      answers.push(shape(result.json));
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it("the conflict message says the appointment was not moved and is still at its original time, and never 'Nothing was booked' (R2)", async () => {
    await takeS2();
    const { message } = (await reschedule(w.patientUser.id, id, to(S2))).json.error;
    expect(message).toMatch(/just taken/i);
    expect(message).toMatch(/not moved/i);
    expect(message).toMatch(/original time/i);
    expect(message).toMatch(/choose another open time/i);
    expect(message).not.toMatch(/nothing was booked/i);
  });

  it("a booking conflict keeps its own message (spec 001 R23 is out of scope)", async () => {
    await takeS2();
    const other = await createPatient();
    const result = await book(other.user.id, bookingBody(w.doctor.id, S2));
    expect(result.status).toBe(409);
    expect(result.json.error.message).toMatch(/Nothing was booked/);
  });

  it("lists at most three open slots nearest the taken slot, on either side, earliest first, with the clinic time zone (R3)", async () => {
    await takeS2();
    const { error } = (await reschedule(w.patientUser.id, id, to(S2))).json;
    expect(error.timeZone).toBe("America/Chicago");
    expect(error.nextSlots).toEqual(
      [at(DAY, "09:30"), at(DAY, "10:30"), at(DAY, "11:00")].map((start) => ({
        startsAt: start.toISOString(),
        endsAt: minutesAfter(start, 30).toISOString(),
      })),
    );
  });

  it("every listed slot appears in GET /doctors/{id}/slots, and neither the taken slot nor the appointment's own slot is listed (R4)", async () => {
    await takeS2();
    const offered = offeredStarts((await reschedule(w.patientUser.id, id, to(S2))).json);
    const visible = await openStarts(w.patientUser.id, w.doctor.id);
    expect(offered.length).toBeGreaterThan(0);
    for (const start of offered) expect(visible).toContain(start);
    expect(offered).not.toContain(S2.toISOString());
    expect(offered).not.toContain(S1.toISOString());
  });

  it("with no other open slot before the horizon the list is empty and the message says the appointment is kept (R5)", async () => {
    // A doctor who works only Wednesdays 09:00 to 10:00, and is off from 10:00 that day to past
    // the booking horizon: the only slots are 09:00 (P's) and 09:30 (taken).
    await resetDb();
    w = await createWorld({ doctor: { hours: [{ weekday: 3, startMinute: 9 * 60, endMinute: 10 * 60 }] } });
    id = (await book(w.patientUser.id, bookingBody(w.doctor.id, S1))).json.appointment.id;
    const other = await createPatient();
    expect((await book(other.user.id, bookingBody(w.doctor.id, at(DAY, "09:30")))).status).toBe(201);
    await db.timeOff.create({
      data: {
        doctorId: w.doctor.id,
        clinicId: w.clinic.id,
        startsAt: at(DAY, "10:00"),
        endsAt: minutesAfter(NOW, 100 * 24 * 60),
        reasonCode: "planned_leave",
        createdById: w.staffUser.id,
      },
    });

    const result = await reschedule(w.patientUser.id, id, to(at(DAY, "09:30")));
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_TAKEN");
    expect(result.json.error.nextSlots).toEqual([]);
    expect(result.json.error.message).toMatch(/no other open times with this doctor in the next 90 days/i);
    expect(result.json.error.message).toMatch(/kept/i);
    expect(result.json.error.message).toMatch(/contact the clinic/i);
    expect((await row()).startsAt).toEqual(S1);
  });

  it("a listed slot is not held: someone else can book it, and choosing it then gets SLOT_TAKEN (R6)", async () => {
    await takeS2();
    const [first] = offeredStarts((await reschedule(w.patientUser.id, id, to(S2))).json);
    const third = await createPatient();
    expect((await book(third.user.id, bookingBody(w.doctor.id, new Date(first)))).status).toBe(201);

    const result = await reschedule(w.patientUser.id, id, { startsAt: first });
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_TAKEN");
  });

  it("after a conflict the appointment is not moved to any listed slot (R7)", async () => {
    await takeS2();
    const offered = offeredStarts((await reschedule(w.patientUser.id, id, to(S2))).json);
    const after = await row();
    expect(after.startsAt).toEqual(S1);
    expect(offered).not.toContain(after.startsAt.toISOString());
  });

  it("out of scope is NOT_FOUND even when the slot is taken (R8)", async () => {
    await takeS2();
    const stranger = await createPatient();
    const { result, lines } = await captureLogs(() => reschedule(stranger.user.id, id, to(S2)));
    expect(result.status).toBe(404);
    expect(result.json.error.code).toBe("NOT_FOUND");
    expect(result.json.error.nextSlots).toBeUndefined();
    expect(conflictLines(lines)).toHaveLength(0);
  });

  it("a patient inside the window gets RESCHEDULE_WINDOW_CLOSED with no nextSlots (R8)", async () => {
    await takeS2();
    freezeClock(hoursBefore(S1, 2));
    const { result, lines } = await captureLogs(() => reschedule(w.patientUser.id, id, to(S2)));
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("RESCHEDULE_WINDOW_CLOSED");
    expect(result.json.error.nextSlots).toBeUndefined();
    expect(conflictLines(lines)).toHaveLength(0);
  });
});

describe("the original appointment is unchanged (R9 to R11)", () => {
  it("a confirmed appointment stays confirmed after a lost move, with the same start, end, reason for visit and origin (R9)", async () => {
    await resetDb();
    w = await createWorld();
    id = await bookCore(w, S1, { by: w.staffSession });
    await takeS2();
    const before = await row();
    expect(before.status).toBe("confirmed");

    expect((await reschedule(w.patientUser.id, id, to(S2))).status).toBe(409);
    expect(await row()).toEqual(before);
  });

  it("a conflict writes no history row, audit event or notification event (R10)", async () => {
    await takeS2();
    const before = await counts();
    expect((await reschedule(w.patientUser.id, id, to(S2))).status).toBe(409);
    expect(await counts()).toEqual(before);
  });

  it("move and move racing for one slot: exactly one wins and the loser is unchanged (R11)", async () => {
    const other = await createPatient();
    const otherId = (await book(other.user.id, bookingBody(w.doctor.id, at(DAY, "09:30")))).json.appointment.id;
    const before = new Map(
      (await db.appointment.findMany({ where: { id: { in: [id, otherId] } } })).map((a) => [a.id, a]),
    );
    const target = at(DAY, "11:00");

    const results = await Promise.all([
      reschedule(w.patientUser.id, id, to(target)),
      reschedule(other.user.id, otherId, to(target)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const loserId = results[0].status === 409 ? id : otherId;
    expect(await db.appointment.findUniqueOrThrow({ where: { id: loserId } })).toEqual(before.get(loserId));
    expect(await db.appointmentHistory.count({ where: { action: "rescheduled" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "appointment.rescheduled" } })).toBe(1);
    expect(await db.notificationEvent.count({ where: { type: "rescheduled" } })).toBe(1);
    expect(
      await db.appointment.count({ where: { doctorId: w.doctor.id, startsAt: target, status: { in: ["requested", "confirmed"] } } }),
    ).toBe(1);
  });
});

describe("the conflict log line (R13, R14, R18)", () => {
  it("each conflict writes exactly one warn line 'reschedule.conflict' with requestId, doctorId, clinicId and sameSlotRetry only (R13)", async () => {
    await takeS2();
    const { result, lines } = await captureLogs(() => reschedule(w.patientUser.id, id, to(S2)));
    const found = conflictLines(lines);
    expect(found).toHaveLength(1);
    expect(Object.keys(found[0]).sort()).toEqual(["clinicId", "doctorId", "event", "level", "requestId", "sameSlotRetry", "ts"]);
    expect(found[0]).toMatchObject({
      level: "warn",
      requestId: result.json.error.requestId,
      doctorId: w.doctor.id,
      clinicId: w.clinic.id,
      sameSlotRetry: false,
    });
  });

  it("sameSlotRetry is false the first time and true when the same user loses the same slot again within 15 minutes, false after (R14)", async () => {
    await takeS2();
    const flag = async (userId: string) => {
      const { lines } = await captureLogs(() => reschedule(userId, id, to(S2)));
      return conflictLines(lines)[0].sameSlotRetry;
    };
    expect(await flag(w.patientUser.id)).toBe(false);
    expect(await flag(w.patientUser.id)).toBe(true);
    // Another user losing the same slot is not this session's repeat.
    expect(await flag(w.staffUser.id)).toBe(false);
    freezeClock(minutesAfter(NOW, 16));
    expect(await flag(w.patientUser.id)).toBe(false);
  });

  it("the conflict log line holds no name, email, phone, date of birth, reason for visit, appointment time or other ids (R18)", async () => {
    const other = await takeS2();
    const { lines } = await captureLogs(() => reschedule(w.patientUser.id, id, to(S2)));
    const text = JSON.stringify(conflictLines(lines));
    expect(conflictLines(lines)).toHaveLength(1);
    for (const patientId of [w.patient.id, other.patient.id]) {
      const profile = await db.patientProfile.findUniqueOrThrow({
        where: { id: patientId },
        include: { user: { select: { email: true } } },
      });
      for (const value of [profile.fullName, profile.user.email, profile.phone, profile.dateOfBirth?.toISOString().slice(0, 10)]) {
        if (value) expect(text).not.toContain(value);
      }
      expect(text).not.toContain(patientId);
    }
    expect(text).not.toContain(REASON);
    for (const value of [S1.toISOString(), S2.toISOString(), id, w.patientUser.id, other.user.id]) {
      expect(text).not.toContain(value);
    }
  });
});
