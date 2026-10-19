// The appointment core against real PostgreSQL: booking, moving and status changes, each as
// one transaction, including the concurrency cases. The database is not mocked.
import { beforeEach, describe, expect, it } from "vitest";
import {
  bookAppointment,
  changeAppointmentStatus,
  changeAppointmentStatusInTx,
  rescheduleAppointment,
} from "@/lib/appointments/core";
import { db } from "@/lib/db";
import { AppError, type ErrorCode } from "@/lib/errors";
import type { Session } from "@/lib/session";
import { NOW, at, captureLogs, hoursBefore, minutesAfter } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createClinic, createDoctor, createPatient, createStaff, createWorld, sessionFor } from "../../helpers/factories";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;

// Wednesday 14 October 2026 in Chicago. The doctor works every day, 09:00 to 17:00, in
// 30-minute slots. NOW is Monday 12 October, 07:00.
const S0900 = at("2026-10-14", "09:00");
const S0930 = at("2026-10-14", "09:30");
const S1000 = at("2026-10-14", "10:00");

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
});

async function expectAppError(run: Promise<unknown>, code: ErrorCode): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected ${code}, but the call succeeded`);
}

function book(actor: Session, start: Date, over: { doctorId?: string; patientId?: string; key?: string; now?: Date } = {}) {
  return bookAppointment(
    {
      actor,
      doctorId: over.doctorId ?? w.doctor.id,
      patientId: over.patientId ?? w.patient.id,
      start,
      reasonForVisit: "Fictional reason",
      idempotencyKey: over.key ?? null,
    },
    over.now ?? NOW,
  );
}

const appointment = (id: string) => db.appointment.findUniqueOrThrow({ where: { id } });

async function counts() {
  const [appointments, history, audit, notifications, links] = await Promise.all([
    db.appointment.count(),
    db.appointmentHistory.count(),
    db.auditEvent.count(),
    db.notificationEvent.count(),
    db.clinicPatient.count(),
  ]);
  return { appointments, history, audit, notifications, links };
}

async function newPatient() {
  const { user, patient } = await createPatient();
  return { patient, session: await sessionFor(user.id) };
}

describe("booking", () => {
  it("a patient's booking is requested and holds its slot (R21)", async () => {
    const result = await book(w.patientSession, S0900);
    expect(result.created).toBe(true);
    const row = await appointment(result.appointmentId);
    expect(row).toMatchObject({
      status: "requested",
      clinicId: w.clinic.id,
      doctorId: w.doctor.id,
      patientId: w.patient.id,
      bookedById: w.patientUser.id,
      bookedByRole: "patient",
      reasonForVisit: "Fictional reason",
      lateCancel: false,
      cancelledByRole: null,
    });
    expect(row.startsAt).toEqual(S0900);
    expect(row.endsAt).toEqual(S0930);
    expect(row.bookedAt).toEqual(NOW);

    const other = await newPatient();
    await expectAppError(book(other.session, S0900, { patientId: other.patient.id }), "SLOT_TAKEN");
  });

  it("a staff booking is confirmed and records who booked it and when (R28, R29)", async () => {
    const result = await book(w.staffSession, S0900);
    const row = await appointment(result.appointmentId);
    expect(row).toMatchObject({ status: "confirmed", bookedById: w.staffUser.id, bookedByRole: "staff" });
    expect(row.bookedAt).toEqual(NOW);
  });

  it("creates the patient-to-clinic link at the first booking and not again (R6)", async () => {
    expect(await db.clinicPatient.count()).toBe(0);
    await book(w.patientSession, S0900);
    await book(w.patientSession, S0930);
    expect(await db.clinicPatient.count({ where: { clinicId: w.clinic.id, patientId: w.patient.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "patient.clinic_linked" } })).toBe(1);
  });

  it("a doctor or an admin cannot book", async () => {
    await expectAppError(book(w.doctorSession, S0900), "FORBIDDEN");
    const admin = await sessionFor((await db.user.create({ data: { email: "admin@example.test", role: "admin" } })).id);
    await expectAppError(book(admin, S0900), "FORBIDDEN");
    expect((await counts()).appointments).toBe(0);
  });

  it("a patient can book only for themself (R7, R8)", async () => {
    const other = await newPatient();
    await expectAppError(book(w.patientSession, S0900, { patientId: other.patient.id }), "NOT_FOUND");
    expect((await counts()).appointments).toBe(0);
  });

  it("staff cannot book with a doctor of another clinic: it is not found (R4, R8)", async () => {
    const elsewhere = await createClinic();
    const { doctor } = await createDoctor(elsewhere.id);
    await expectAppError(book(w.staffSession, S0900, { doctorId: doctor.id }), "NOT_FOUND");
    expect(await counts()).toEqual({ appointments: 0, history: 0, audit: 0, notifications: 0, links: 0 });
  });

  it("an inactive doctor, or an unknown doctor or patient, is not found (R96)", async () => {
    const { doctor } = await createDoctor(w.clinic.id, { active: false });
    await expectAppError(book(w.patientSession, S0900, { doctorId: doctor.id }), "NOT_FOUND");
    await expectAppError(book(w.patientSession, S0900, { doctorId: w.clinic.id }), "NOT_FOUND");
    await expectAppError(book(w.staffSession, S0900, { patientId: w.clinic.id }), "NOT_FOUND");
  });

  it("refuses every unbookable slot with SLOT_UNAVAILABLE and books nothing (R24)", async () => {
    await db.break.create({
      data: { doctorId: w.doctor.id, clinicId: w.clinic.id, weekday: 3, startMinute: 12 * 60, endMinute: 13 * 60 },
    });
    await db.timeOff.create({
      data: {
        doctorId: w.doctor.id,
        clinicId: w.clinic.id,
        startsAt: at("2026-10-15", "00:00"),
        endsAt: at("2026-10-16", "00:00"),
        reasonCode: "training",
        createdById: w.staffUser.id,
      },
    });
    const cases: Record<string, Date> = {
      "in the past": at("2026-10-12", "06:30"),
      "starting now": NOW,
      "off the grid": at("2026-10-14", "09:10"),
      "before opening": at("2026-10-14", "08:30"),
      "at closing": at("2026-10-14", "17:00"),
      "in a break": at("2026-10-14", "12:30"),
      "in time off": at("2026-10-15", "10:00"),
      "beyond 90 days": at("2027-02-10", "10:00"),
    };
    for (const [label, start] of Object.entries(cases)) {
      const error = await expectAppError(book(w.patientSession, start), "SLOT_UNAVAILABLE");
      expect(error.details, label).toEqual({});
    }
    expect(await counts()).toEqual({ appointments: 0, history: 0, audit: 0, notifications: 0, links: 0 });
  });

  it("an occupied slot is refused for every role, with the next three open slots (R23, R30)", async () => {
    await book(w.patientSession, S0900);
    const other = await newPatient();
    for (const actor of [other.session, w.staffSession]) {
      const error = await expectAppError(book(actor, S0900, { patientId: other.patient.id }), "SLOT_TAKEN");
      expect(error.details.timeZone).toBe("America/Chicago");
      expect(error.details.nextSlots).toEqual([
        { startsAt: S0930.toISOString(), endsAt: S1000.toISOString() },
        { startsAt: S1000.toISOString(), endsAt: at("2026-10-14", "10:30").toISOString() },
        { startsAt: at("2026-10-14", "10:30").toISOString(), endsAt: at("2026-10-14", "11:00").toISOString() },
      ]);
    }
    expect((await counts()).appointments).toBe(1);
  });

  it("refuses an overlap with a different start time, which the unique index alone does not see", async () => {
    // A 30-minute appointment at 09:00, then the slot length changes to 20 minutes (R56). The
    // new 09:20 slot overlaps it. The index covers equal starts only; the slot re-check in
    // the core refuses this one.
    await book(w.patientSession, S0900);
    await db.doctorProfile.update({ where: { id: w.doctor.id }, data: { slotLengthMinutes: 20 } });
    const other = await newPatient();
    const error = await expectAppError(
      book(other.session, at("2026-10-14", "09:20"), { patientId: other.patient.id }),
      "SLOT_TAKEN",
    );
    expect(error.details.nextSlots?.[0].startsAt).toBe(at("2026-10-14", "09:40").toISOString());
    const ok = await book(other.session, at("2026-10-14", "09:40"), { patientId: other.patient.id });
    expect((await appointment(ok.appointmentId)).endsAt).toEqual(S1000);
    // The existing appointment kept its start and length.
    expect(await db.appointment.count({ where: { startsAt: S0900, endsAt: S0930, status: "requested" } })).toBe(1);
  });
});

describe("booking limit (R25)", () => {
  it("refuses the booking over the limit and says what the limit is", async () => {
    for (const start of [S0900, S0930, S1000]) await book(w.patientSession, start);
    const error = await expectAppError(book(w.patientSession, at("2026-10-14", "10:30")), "BOOKING_LIMIT_REACHED");
    expect(error.details).toEqual({ limit: 3 });
    expect((await counts()).appointments).toBe(3);
  });

  it("applies whoever makes the booking, including staff", async () => {
    for (const start of [S0900, S0930, S1000]) await book(w.staffSession, start);
    await expectAppError(book(w.staffSession, at("2026-10-14", "10:30")), "BOOKING_LIMIT_REACHED");
  });

  it("follows the clinic's own setting", async () => {
    await db.clinic.update({ where: { id: w.clinic.id }, data: { maxUpcomingPerPatient: 1 } });
    await book(w.patientSession, S0900);
    const error = await expectAppError(book(w.patientSession, S0930), "BOOKING_LIMIT_REACHED");
    expect(error.details.limit).toBe(1);
  });

  it("counts upcoming appointments at this clinic only: not cancelled, not past, not elsewhere", async () => {
    const first = await book(w.patientSession, S0900);
    await book(w.patientSession, S0930);
    await book(w.patientSession, S1000);
    await changeAppointmentStatus({ actor: w.patientSession, appointmentId: first.appointmentId, to: "cancelled" }, NOW);
    // Two upcoming now: one more is allowed.
    await book(w.patientSession, at("2026-10-14", "11:00"));
    // At the limit again, but another clinic has its own count.
    const elsewhere = await createClinic();
    const { doctor } = await createDoctor(elsewhere.id);
    await expect(book(w.patientSession, S0900, { doctorId: doctor.id })).resolves.toMatchObject({ created: true });
    // Once the earliest has started it is no longer upcoming.
    const later = minutesAfter(S0930, 1);
    await expect(book(w.patientSession, at("2026-10-14", "15:00"), { now: later })).resolves.toMatchObject({
      created: true,
    });
  });
});

describe("repeated submission (R27)", () => {
  it("the same key twice creates one appointment and returns it both times", async () => {
    const first = await book(w.patientSession, S0900, { key: "key-0001-abcdef" });
    const second = await book(w.patientSession, S0900, { key: "key-0001-abcdef" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ appointmentId: first.appointmentId, created: false });
    expect(await counts()).toMatchObject({ appointments: 1, history: 1, notifications: 1 });
  });

  it("a replay is not a retry: a different key for a taken slot is still a conflict", async () => {
    await book(w.patientSession, S0900, { key: "key-0001-abcdef" });
    await expectAppError(book(w.patientSession, S0900, { key: "key-0002-abcdef" }), "SLOT_TAKEN");
    expect((await counts()).appointments).toBe(1);
  });

  it("keys belong to the user who sent them", async () => {
    const other = await newPatient();
    const mine = await book(w.patientSession, S0900, { key: "shared-key-0001" });
    const theirs = await book(other.session, S0930, { patientId: other.patient.id, key: "shared-key-0001" });
    expect(theirs.created).toBe(true);
    expect(theirs.appointmentId).not.toBe(mine.appointmentId);
  });
});

describe("concurrency", () => {
  it("simultaneous bookings for one slot: exactly one succeeds, the rest get SLOT_TAKEN (R23)", async () => {
    const patients = await Promise.all(Array.from({ length: 8 }, () => newPatient()));
    const results = await Promise.allSettled(
      patients.map((p) => book(p.session, S0900, { patientId: p.patient.id })),
    );

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    for (const r of lost) {
      expect(r.reason).toBeInstanceOf(AppError);
      const error = r.reason as AppError;
      expect(error.code).toBe("SLOT_TAKEN");
      expect(error.status).toBe(409);
      expect(error.details.nextSlots).toHaveLength(3);
      expect(error.details.nextSlots?.map((s) => s.startsAt)).not.toContain(S0900.toISOString());
    }
    // One row, and nothing at all was written for the losers.
    expect(await db.appointment.count({ where: { doctorId: w.doctor.id, startsAt: S0900 } })).toBe(1);
    expect(await counts()).toEqual({ appointments: 1, history: 1, audit: 2, notifications: 1, links: 1 });
  });

  it("two simultaneous bookings by one patient, one below the limit: one succeeds (R25)", async () => {
    await book(w.patientSession, S0900);
    await book(w.patientSession, S0930);
    const { doctor: second } = await createDoctor(w.clinic.id);
    const results = await Promise.allSettled([
      book(w.patientSession, S1000),
      book(w.patientSession, S1000, { doctorId: second.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect((lost?.reason as AppError).code).toBe("BOOKING_LIMIT_REACHED");
    expect(
      await db.appointment.count({ where: { patientId: w.patient.id, status: { in: ["requested", "confirmed"] } } }),
    ).toBe(3);
  });

  it("the same submission sent twice at once creates one appointment (R27)", async () => {
    const results = await Promise.all([
      book(w.patientSession, S0900, { key: "double-click-0001" }),
      book(w.patientSession, S0900, { key: "double-click-0001" }),
    ]);
    expect(results[0].appointmentId).toBe(results[1].appointmentId);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await counts()).appointments).toBe(1);
  });

  it("a move and a booking racing for one slot: one wins, and a lost move changes nothing (R33)", async () => {
    const mine = await book(w.patientSession, S0900);
    const other = await newPatient();
    const [move, booking] = await Promise.allSettled([
      rescheduleAppointment({ actor: w.patientSession, appointmentId: mine.appointmentId, newStart: S1000 }, NOW),
      book(other.session, S1000, { patientId: other.patient.id }),
    ]);
    expect([move.status, booking.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    const row = await appointment(mine.appointmentId);
    if (move.status === "rejected") {
      expect((move.reason as AppError).code).toBe("SLOT_TAKEN");
      expect(row.startsAt).toEqual(S0900);
      expect(await db.appointmentHistory.count({ where: { appointmentId: mine.appointmentId } })).toBe(1);
    } else {
      expect(((booking as PromiseRejectedResult).reason as AppError).code).toBe("SLOT_TAKEN");
      expect(row.startsAt).toEqual(S1000);
    }
    expect(await db.appointment.count({ where: { startsAt: S1000, status: { in: ["requested", "confirmed"] } } })).toBe(1);
  });
});

describe("rescheduling", () => {
  it("moves the same appointment and frees the old slot (R31, R32, R37)", async () => {
    const booked = await book(w.patientSession, S0900);
    await rescheduleAppointment({ actor: w.patientSession, appointmentId: booked.appointmentId, newStart: S1000 }, NOW);

    const row = await appointment(booked.appointmentId);
    expect(row.startsAt).toEqual(S1000);
    expect(row.endsAt).toEqual(at("2026-10-14", "10:30"));
    // Reason for visit and booking origin carry over.
    expect(row).toMatchObject({ reasonForVisit: "Fictional reason", bookedById: w.patientUser.id, bookedByRole: "patient" });
    expect(row.bookedAt).toEqual(NOW);
    expect(await db.appointment.count()).toBe(1);

    const history = await db.appointmentHistory.findMany({
      where: { appointmentId: booked.appointmentId, action: "rescheduled" },
    });
    expect(history).toHaveLength(1);
    expect(history[0].oldStartsAt).toEqual(S0900);
    expect(history[0].newStartsAt).toEqual(S1000);
    expect(history[0]).toMatchObject({ actorId: w.patientUser.id, actorRole: "patient" });

    const other = await newPatient();
    await expect(book(other.session, S0900, { patientId: other.patient.id })).resolves.toMatchObject({ created: true });
  });

  it("a patient's move returns a confirmed appointment to requested (R36)", async () => {
    const booked = await book(w.staffSession, S0900);
    expect((await appointment(booked.appointmentId)).status).toBe("confirmed");
    await rescheduleAppointment({ actor: w.patientSession, appointmentId: booked.appointmentId, newStart: S1000 }, NOW);
    expect((await appointment(booked.appointmentId)).status).toBe("requested");
  });

  it("a move by staff or the doctor keeps the status (R36)", async () => {
    const confirmed = await book(w.staffSession, S0900);
    await rescheduleAppointment({ actor: w.staffSession, appointmentId: confirmed.appointmentId, newStart: S1000 }, NOW);
    expect((await appointment(confirmed.appointmentId)).status).toBe("confirmed");
    await rescheduleAppointment({ actor: w.doctorSession, appointmentId: confirmed.appointmentId, newStart: S0930 }, NOW);
    expect((await appointment(confirmed.appointmentId)).status).toBe("confirmed");

    const other = await newPatient();
    const requested = await book(other.session, at("2026-10-14", "11:00"), { patientId: other.patient.id });
    await rescheduleAppointment(
      { actor: w.doctorSession, appointmentId: requested.appointmentId, newStart: at("2026-10-14", "11:30") },
      NOW,
    );
    expect((await appointment(requested.appointmentId)).status).toBe("requested");
  });

  it("a patient cannot move inside the cancellation window; staff and the doctor can (R34, R35)", async () => {
    const booked = await book(w.patientSession, S0900);
    const inside = hoursBefore(S0900, 24);
    await expectAppError(
      rescheduleAppointment({ actor: w.patientSession, appointmentId: booked.appointmentId, newStart: S1000 }, inside),
      "RESCHEDULE_WINDOW_CLOSED",
    );
    expect((await appointment(booked.appointmentId)).startsAt).toEqual(S0900);

    const justBefore = new Date(inside.getTime() - 1);
    await rescheduleAppointment(
      { actor: w.patientSession, appointmentId: booked.appointmentId, newStart: S0930 },
      justBefore,
    );
    const lastMinute = hoursBefore(S0930, 1);
    await rescheduleAppointment({ actor: w.staffSession, appointmentId: booked.appointmentId, newStart: S1000 }, lastMinute);
    await rescheduleAppointment(
      { actor: w.doctorSession, appointmentId: booked.appointmentId, newStart: at("2026-10-14", "10:30") },
      lastMinute,
    );
    expect((await appointment(booked.appointmentId)).startsAt).toEqual(at("2026-10-14", "10:30"));
  });

  it("follows the clinic's own window (R40)", async () => {
    await db.clinic.update({ where: { id: w.clinic.id }, data: { cancellationWindowHours: 48 } });
    const booked = await book(w.patientSession, at("2026-10-16", "09:00"));
    await expectAppError(
      rescheduleAppointment(
        { actor: w.patientSession, appointmentId: booked.appointmentId, newStart: at("2026-10-16", "10:00") },
        hoursBefore(at("2026-10-16", "09:00"), 36),
      ),
      "RESCHEDULE_WINDOW_CLOSED",
    );
  });

  it("onto a taken slot: SLOT_TAKEN with the nearest slots, and the appointment is unchanged (R33, spec 003 R3)", async () => {
    const mine = await book(w.patientSession, S0900);
    const other = await newPatient();
    await book(other.session, S1000, { patientId: other.patient.id });
    const before = await counts();

    const error = await expectAppError(
      rescheduleAppointment({ actor: w.patientSession, appointmentId: mine.appointmentId, newStart: S1000 }, NOW),
      "SLOT_TAKEN",
    );
    expect(error.details.nextSlots).toHaveLength(3);
    expect(error.details.nextSlots?.[0].startsAt).toBe(S0930.toISOString());
    const row = await appointment(mine.appointmentId);
    expect(row.startsAt).toEqual(S0900);
    expect(row.status).toBe("requested");
    expect(await counts()).toEqual(before);
  });

  it("refuses a slot that is not bookable, or the slot it already has", async () => {
    const booked = await book(w.patientSession, S0900);
    for (const newStart of [S0900, at("2026-10-14", "09:10"), at("2026-10-14", "18:00"), at("2026-10-12", "06:00")]) {
      await expectAppError(
        rescheduleAppointment({ actor: w.patientSession, appointmentId: booked.appointmentId, newStart }, NOW),
        "SLOT_UNAVAILABLE",
      );
    }
    expect((await appointment(booked.appointmentId)).startsAt).toEqual(S0900);
  });

  it("refuses moving an appointment that is cancelled or has started", async () => {
    const cancelled = await book(w.patientSession, S0900);
    await changeAppointmentStatus({ actor: w.patientSession, appointmentId: cancelled.appointmentId, to: "cancelled" }, NOW);
    await expectAppError(
      rescheduleAppointment({ actor: w.staffSession, appointmentId: cancelled.appointmentId, newStart: S1000 }, NOW),
      "INVALID_TRANSITION",
    );
    const started = await book(w.patientSession, S0930);
    await expectAppError(
      rescheduleAppointment(
        { actor: w.staffSession, appointmentId: started.appointmentId, newStart: at("2026-10-14", "15:00") },
        minutesAfter(S0930, 1),
      ),
      "INVALID_TRANSITION",
    );
  });
});

describe("scope (R7, R8, R60)", () => {
  it("another patient, another doctor and another clinic's staff all get NOT_FOUND, and nothing changes", async () => {
    const booked = await book(w.patientSession, S0900);
    const stranger = await newPatient();
    const colleague = await sessionFor((await createDoctor(w.clinic.id)).user.id);
    const elsewhere = await createClinic();
    const outsideStaff = await sessionFor((await createStaff(elsewhere.id)).user.id);
    const before = await counts();

    for (const actor of [stranger.session, colleague, outsideStaff]) {
      await expectAppError(
        rescheduleAppointment({ actor, appointmentId: booked.appointmentId, newStart: S1000 }, NOW),
        "NOT_FOUND",
      );
      await expectAppError(
        changeAppointmentStatus({ actor, appointmentId: booked.appointmentId, to: "cancelled", reasonCode: "other" }, NOW),
        "NOT_FOUND",
      );
    }
    // The same answer as for an appointment that does not exist.
    await expectAppError(
      changeAppointmentStatus({ actor: w.staffSession, appointmentId: w.clinic.id, to: "confirmed" }, NOW),
      "NOT_FOUND",
    );
    expect(await counts()).toEqual(before);
    expect((await appointment(booked.appointmentId)).status).toBe("requested");
  });
});

describe("status changes (R62 to R64)", () => {
  it("staff and the appointment's doctor can confirm; a patient cannot", async () => {
    const first = await book(w.patientSession, S0900);
    const second = await book(w.patientSession, S0930);
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: first.appointmentId, to: "confirmed" }, NOW);
    await changeAppointmentStatus({ actor: w.doctorSession, appointmentId: second.appointmentId, to: "confirmed" }, NOW);
    expect((await appointment(first.appointmentId)).status).toBe("confirmed");
    expect((await appointment(second.appointmentId)).status).toBe("confirmed");

    const third = await book(w.patientSession, S1000);
    await expectAppError(
      changeAppointmentStatus({ actor: w.patientSession, appointmentId: third.appointmentId, to: "confirmed" }, NOW),
      "INVALID_TRANSITION",
    );
    expect((await appointment(third.appointmentId)).status).toBe("requested");
  });

  it("a patient's cancellation before the window is not flagged; inside it is a late cancel (R38, R39)", async () => {
    const early = await book(w.patientSession, S0900);
    const late = await book(w.patientSession, S0930);

    const first = await changeAppointmentStatus(
      { actor: w.patientSession, appointmentId: early.appointmentId, to: "cancelled" },
      new Date(hoursBefore(S0900, 24).getTime() - 1),
    );
    expect(first.lateCancel).toBe(false);
    expect(await appointment(early.appointmentId)).toMatchObject({
      status: "cancelled",
      cancelledByRole: "patient",
      lateCancel: false,
      cancelReasonCode: null,
    });

    const second = await changeAppointmentStatus(
      { actor: w.patientSession, appointmentId: late.appointmentId, to: "cancelled" },
      hoursBefore(S0930, 2),
    );
    expect(second.lateCancel).toBe(true);
    expect(await appointment(late.appointmentId)).toMatchObject({
      status: "cancelled",
      cancelledByRole: "patient",
      lateCancel: true,
    });
  });

  it("staff and the doctor must choose a listed reason, and are never flagged late (R41, R42)", async () => {
    const booked = await book(w.patientSession, S0900);
    const inside = hoursBefore(S0900, 2);
    const base = { actor: w.staffSession, appointmentId: booked.appointmentId, to: "cancelled" as const };

    const missing = await expectAppError(changeAppointmentStatus(base, inside), "VALIDATION_FAILED");
    expect(missing.details.fields).toEqual([{ field: "reasonCode", problem: "required" }]);
    // "training" is a schedule-change reason, not a reason for cancelling one appointment.
    const unlisted = await expectAppError(
      changeAppointmentStatus({ ...base, reasonCode: "training" }, inside),
      "VALIDATION_FAILED",
    );
    expect(unlisted.details.fields).toEqual([{ field: "reasonCode", problem: "invalid" }]);
    expect((await appointment(booked.appointmentId)).status).toBe("requested");

    const result = await changeAppointmentStatus({ ...base, reasonCode: "doctor_unavailable" }, inside);
    expect(result.lateCancel).toBe(false);
    expect(await appointment(booked.appointmentId)).toMatchObject({
      status: "cancelled",
      cancelledByRole: "staff",
      cancelReasonCode: "doctor_unavailable",
      lateCancel: false,
    });

    const second = await book(w.patientSession, S0930);
    await changeAppointmentStatus(
      { actor: w.doctorSession, appointmentId: second.appointmentId, to: "cancelled", reasonCode: "patient_request" },
      inside,
    );
    expect(await appointment(second.appointmentId)).toMatchObject({ cancelledByRole: "doctor", lateCancel: false });
  });

  it("a patient's reason code is ignored: patients never give one", async () => {
    const booked = await book(w.patientSession, S0900);
    await changeAppointmentStatus(
      { actor: w.patientSession, appointmentId: booked.appointmentId, to: "cancelled", reasonCode: "other" },
      NOW,
    );
    expect((await appointment(booked.appointmentId)).cancelReasonCode).toBeNull();
  });

  it("completed and no-show are refused before the start with TOO_EARLY, and change nothing (R63)", async () => {
    const booked = await book(w.patientSession, S0900);
    const before = await counts();
    for (const to of ["completed", "no_show"] as const) {
      for (const actor of [w.staffSession, w.doctorSession]) {
        await expectAppError(
          changeAppointmentStatus({ actor, appointmentId: booked.appointmentId, to }, new Date(S0900.getTime() - 1)),
          "TOO_EARLY",
        );
      }
    }
    expect((await appointment(booked.appointmentId)).status).toBe("requested");
    expect(await counts()).toEqual(before);
  });

  it("after the start, staff or the doctor record completed or no-show, straight from requested too", async () => {
    const first = await book(w.patientSession, S0900);
    const second = await book(w.staffSession, S0930);
    await changeAppointmentStatus({ actor: w.doctorSession, appointmentId: first.appointmentId, to: "completed" }, S0900);
    await changeAppointmentStatus(
      { actor: w.staffSession, appointmentId: second.appointmentId, to: "no_show" },
      minutesAfter(S0930, 45),
    );
    expect((await appointment(first.appointmentId)).status).toBe("completed");
    expect((await appointment(second.appointmentId)).status).toBe("no_show");
  });

  it("a transition outside the table is refused with INVALID_TRANSITION and changes nothing (R64)", async () => {
    const done = await book(w.patientSession, S0900);
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: done.appointmentId, to: "completed" }, S0930);
    const before = await counts();
    const after = minutesAfter(S0930, 5);
    for (const to of ["confirmed", "cancelled", "no_show", "completed"] as const) {
      await expectAppError(
        changeAppointmentStatus({ actor: w.staffSession, appointmentId: done.appointmentId, to, reasonCode: "other" }, after),
        "INVALID_TRANSITION",
      );
    }
    // Cancelling after the start is not in the table either.
    const started = await book(w.patientSession, S1000);
    await expectAppError(
      changeAppointmentStatus({ actor: w.patientSession, appointmentId: started.appointmentId, to: "cancelled" }, S1000),
      "INVALID_TRANSITION",
    );
    expect((await appointment(done.appointmentId)).status).toBe("completed");
    expect((await appointment(started.appointmentId)).status).toBe("requested");
    expect(await counts()).toEqual({ ...before, appointments: 2, history: before.history + 1, audit: before.audit + 1, notifications: before.notifications + 1 });
  });
});

describe("events (R73, R77)", () => {
  it("each of the six changes writes exactly one notification, one audit event and one history row", async () => {
    const expectOne = async (appointmentId: string, type: string) => {
      expect(await db.notificationEvent.count({ where: { appointmentId, type: type as never } }), type).toBe(1);
      expect(await db.auditEvent.count({ where: { entityId: appointmentId, action: `appointment.${type}` } }), type).toBe(1);
      expect(await db.appointmentHistory.count({ where: { appointmentId, action: type as never } }), type).toBe(1);
    };

    const { result: ids, lines } = await captureLogs(async () => {
      const a = await book(w.patientSession, S0900);
      await expectOne(a.appointmentId, "booked");
      await changeAppointmentStatus({ actor: w.staffSession, appointmentId: a.appointmentId, to: "confirmed" }, NOW);
      await expectOne(a.appointmentId, "confirmed");
      await rescheduleAppointment({ actor: w.staffSession, appointmentId: a.appointmentId, newStart: S1000 }, NOW);
      await expectOne(a.appointmentId, "rescheduled");
      await changeAppointmentStatus(
        { actor: w.staffSession, appointmentId: a.appointmentId, to: "cancelled", reasonCode: "other" },
        NOW,
      );
      await expectOne(a.appointmentId, "cancelled");

      const b = await book(w.patientSession, S0900);
      await changeAppointmentStatus({ actor: w.doctorSession, appointmentId: b.appointmentId, to: "completed" }, S0930);
      await expectOne(b.appointmentId, "completed");

      const c = await book(w.patientSession, at("2026-10-15", "09:00"));
      await changeAppointmentStatus(
        { actor: w.staffSession, appointmentId: c.appointmentId, to: "no_show" },
        at("2026-10-15", "09:30"),
      );
      await expectOne(c.appointmentId, "no_show");
      return [a.appointmentId, b.appointmentId, c.appointmentId];
    });

    // Eight changes in all: three bookings and five others. One stored event each.
    expect(await db.notificationEvent.count()).toBe(8);
    expect(await db.notificationEvent.count({ where: { appointmentId: { in: ids } } })).toBe(8);
    // And each was handed to the adapter once, after its transaction committed.
    expect(lines.map((l) => l.event)).toEqual([
      "notification.booked",
      "notification.confirmed",
      "notification.rescheduled",
      "notification.cancelled",
      "notification.booked",
      "notification.completed",
      "notification.booked",
      "notification.no_show",
    ]);
  });

  it("a rolled-back change leaves no event, no audit row, no history and no change", async () => {
    const booked = await book(w.patientSession, S0900);
    const before = await counts();

    const { lines } = await captureLogs(async () => {
      await expect(
        db.$transaction(async (tx) => {
          const result = await changeAppointmentStatusInTx(
            tx,
            { actor: w.staffSession, appointmentId: booked.appointmentId, to: "confirmed" },
            NOW,
          );
          // The change, its history row, its audit event and its notification are all written.
          expect(result.status).toBe("confirmed");
          expect(await tx.notificationEvent.count({ where: { type: "confirmed" } })).toBe(1);
          expect(await tx.auditEvent.count({ where: { action: "appointment.confirmed" } })).toBe(1);
          throw new Error("forced failure after the change");
        }),
      ).rejects.toThrow("forced failure");
    });

    expect(await counts()).toEqual(before);
    expect((await appointment(booked.appointmentId)).status).toBe("requested");
    expect(await db.notificationEvent.count({ where: { type: "confirmed" } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: "appointment.confirmed" } })).toBe(0);
    expect(lines).toEqual([]);
  });

  it("a refused booking leaves nothing behind, not even the clinic link", async () => {
    const { lines } = await captureLogs(async () => {
      await expectAppError(book(w.patientSession, at("2026-10-14", "09:10")), "SLOT_UNAVAILABLE");
    });
    expect(await counts()).toEqual({ appointments: 0, history: 0, audit: 0, notifications: 0, links: 0 });
    expect(lines).toEqual([]);
  });

  it("a schedule-change cancellation takes a schedule-change reason and links to the change (R52)", async () => {
    const booked = await book(w.patientSession, S0900);
    const change = await db.scheduleChange.create({
      data: {
        doctorId: w.doctor.id,
        clinicId: w.clinic.id,
        kind: "time_off",
        reasonCode: "planned_leave",
        actorId: w.staffUser.id,
        actorRole: "staff",
      },
    });
    await db.$transaction((tx) =>
      changeAppointmentStatusInTx(
        tx,
        {
          actor: w.staffSession,
          appointmentId: booked.appointmentId,
          to: "cancelled",
          reasonCode: "planned_leave",
          scheduleChangeId: change.id,
        },
        NOW,
      ),
    );
    expect(await appointment(booked.appointmentId)).toMatchObject({
      status: "cancelled",
      cancelledByRole: "staff",
      cancelReasonCode: "planned_leave",
      scheduleChangeId: change.id,
      lateCancel: false,
    });
  });
});
