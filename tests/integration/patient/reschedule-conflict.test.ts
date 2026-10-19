// Incident 003 (docs/003-incident-reschedule-conflicts/spec.md): a patient's move onto a slot that
// another patient holds. The answer keeps today's 409 SLOT_TAKEN (R1), the appointment stays where
// it was (R9), the open slots offered are the three nearest the taken one (R3, R4), and the answer
// carries no patient data (R18, R19).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { NOW, at, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createPatient, createWorld } from "../../helpers/factories";
import { REASON, book, bookingBody, reschedule } from "./api";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;

const S1 = at("2026-10-14", "09:00");
const S2 = at("2026-10-14", "10:00");

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => {
  restoreClock();
});

describe("a patient's move onto a slot another patient holds (spec 003)", () => {
  it("is SLOT_TAKEN, keeps the appointment at S1, offers the three nearest open slots, and shows no patient data", async () => {
    const id = (await book(w.patientUser.id, bookingBody(w.doctor.id, S1))).json.appointment.id;
    const other = await createPatient();
    expect((await book(other.user.id, bookingBody(w.doctor.id, S2))).status).toBe(201);

    const result = await reschedule(w.patientUser.id, id, { startsAt: S2.toISOString() });

    // R1: the same status and code as today.
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("SLOT_TAKEN");

    // R9: P's appointment is still active at S1.
    const row = await db.appointment.findUniqueOrThrow({ where: { id } });
    expect(row.startsAt).toEqual(S1);
    expect(["requested", "confirmed"]).toContain(row.status);

    // R18, R19: nothing about either patient is in the answer.
    const text = JSON.stringify(result.json);
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

    // R3, R4: at most three open slots with D, the nearest to S2 on either side (a tie goes to the
    // earlier one), listed earliest first. Neither S2 nor P's own slot S1 is offered. 09:30 and
    // 10:30 are each 30 minutes from S2, 11:00 is 60 minutes away.
    const offered = result.json.error.nextSlots?.map((slot) => slot.startsAt) ?? [];
    expect(offered.length).toBeLessThanOrEqual(3);
    expect(offered).not.toContain(S2.toISOString());
    expect(offered).not.toContain(S1.toISOString());
    expect(offered).toEqual([at("2026-10-14", "09:30"), at("2026-10-14", "10:30"), at("2026-10-14", "11:00")].map((s) => s.toISOString()));
  });
});
