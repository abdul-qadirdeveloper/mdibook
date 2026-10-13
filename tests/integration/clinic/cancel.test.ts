// Cancelling as staff or as the appointment's doctor (R41, R42, R44): a reason code from the
// fixed list, never a late cancel, and the cancelling role is recorded.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as cancelRoute } from "@/app/api/v1/appointments/[id]/cancel/route";
import { GET as readRoute } from "@/app/api/v1/appointments/[id]/route";
import { CANCEL_REASON_CODES } from "@/domain/reason-codes";
import { db } from "@/lib/db";
import { listOpenSlots } from "@/lib/open-slots";
import { NOW, at, freezeClock, hoursBefore, minutesAfter, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createWorld } from "../../helpers/factories";
import { type Appointment, DAY, type ErrorJson, S0900, S0930, S1000, type World, book, counts, row, send } from "./support";

let w: World;

const cancel = (userId: string, id: string, body: unknown = {}) =>
  send<{ appointment: Appointment; recordedAsLate?: boolean } & ErrorJson>(cancelRoute, "POST", userId, { params: { id }, body });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("the reason (R41)", () => {
  it("is required from staff and from the doctor, and nothing is cancelled without it", async () => {
    const id = await book(w, S0900);
    const before = await counts();
    for (const userId of [w.staffUser.id, w.doctorUser.id]) {
      const result = await cancel(userId, id);
      expect(result.status).toBe(422);
      expect(result.json.error.fields).toEqual([{ field: "reasonCode", problem: "required" }]);
    }
    expect(await counts()).toEqual(before);
    expect((await row(id)).status).toBe("requested");
  });

  it("must be on the cancellation list: a schedule-change code or free text is refused", async () => {
    const id = await book(w, S0900);
    const before = await counts();
    for (const reasonCode of ["planned_leave", "The patient phoned to cancel", "", 3]) {
      const result = await cancel(w.staffUser.id, id, { reasonCode });
      expect(result.status).toBe(422);
      expect(result.json.error.fields?.[0].field).toBe("reasonCode");
      expect(JSON.stringify(result.json.error)).not.toContain("phoned");
    }
    const freeText = await cancel(w.staffUser.id, id, { reasonCode: "other", note: "anything" });
    expect(freeText.status).toBe(422);
    expect(await counts()).toEqual(before);
  });

  it("every code on the list is accepted and stored", async () => {
    for (const [i, reasonCode] of CANCEL_REASON_CODES.entries()) {
      const id = await book(w, at("2026-10-20", `${String(9 + i).padStart(2, "0")}:00`));
      const result = await cancel(i % 2 === 0 ? w.staffUser.id : w.doctorUser.id, id, { reasonCode });
      expect(result.status).toBe(200);
      expect(result.json.appointment).toMatchObject({ status: "cancelled", cancelReasonCode: reasonCode });
      expect(await row(id)).toMatchObject({ status: "cancelled", cancelReasonCode: reasonCode });
    }
  });
});

describe("a cancellation by the clinic", () => {
  it("is never a late cancel, even inside the window and when staff act for the patient (R42)", async () => {
    const id = await book(w, S0900);
    // Two hours before the start: well inside the 24-hour window.
    freezeClock(hoursBefore(S0900, 2));
    const result = await cancel(w.staffUser.id, id, { reasonCode: "patient_request" });
    expect(result.status).toBe(200);
    expect(result.json.appointment).toMatchObject({ status: "cancelled", lateCancel: false });
    expect(result.json).not.toHaveProperty("recordedAsLate");
    expect(await row(id)).toMatchObject({ lateCancel: false, cancelledByRole: "staff" });
  });

  it("records which role cancelled, and the patient sees only that the clinic did (R44, R55)", async () => {
    const byStaff = await book(w, S0900);
    const byDoctor = await book(w, S0930);
    await cancel(w.staffUser.id, byStaff, { reasonCode: "booked_in_error" });
    const doctor = await cancel(w.doctorUser.id, byDoctor, { reasonCode: "doctor_unavailable" });

    expect((await row(byStaff)).cancelledByRole).toBe("staff");
    expect((await row(byDoctor)).cancelledByRole).toBe("doctor");
    expect(doctor.json.appointment).toMatchObject({ cancelledByRole: "doctor", cancelReasonCode: "doctor_unavailable" });
    expect(await db.appointmentHistory.findFirst({ where: { appointmentId: byDoctor, action: "cancelled" } })).toMatchObject({
      actorId: w.doctorUser.id,
      actorRole: "doctor",
      reasonCode: "doctor_unavailable",
    });

    for (const id of [byStaff, byDoctor]) {
      const seen = await send<{ appointment: Appointment }>(readRoute, "GET", w.patientUser.id, { params: { id } });
      expect(seen.json.appointment).toMatchObject({ status: "cancelled", cancelledBy: "clinic" });
      expect(seen.json.appointment).not.toHaveProperty("cancelReasonCode");
      expect(seen.json.appointment).not.toHaveProperty("cancelledByRole");
      expect(seen.json.appointment).not.toHaveProperty("lateCancel");
    }
  });

  it("frees the slot, and writes one history row, one audit event and one notification event", async () => {
    const id = await book(w, S0900);
    const before = await counts();
    await cancel(w.staffUser.id, id, { reasonCode: "clinic_closure" });

    expect(await counts()).toEqual({
      ...before,
      active: before.active - 1,
      history: before.history + 1,
      audit: before.audit + 1,
      notifications: before.notifications + 1,
    });
    const open = await listOpenSlots(db, w.doctor.id, at(DAY, "00:00"), at(DAY, "23:59"), NOW);
    expect(open?.slots.map((s) => s.start.toISOString())).toContain(S0900.toISOString());
  });

  it("is refused once the appointment has started, or is already cancelled or finished (R64)", async () => {
    const started = await book(w, S0900);
    const cancelled = await book(w, S1000);
    await cancel(w.doctorUser.id, cancelled, { reasonCode: "other" });
    const before = await counts();

    const twice = await cancel(w.staffUser.id, cancelled, { reasonCode: "other" });
    expect(twice.status).toBe(409);
    expect(twice.json.error.code).toBe("INVALID_TRANSITION");

    freezeClock(minutesAfter(S0900, 1));
    const tooLate = await cancel(w.staffUser.id, started, { reasonCode: "other" });
    expect(tooLate.status).toBe(409);
    expect(tooLate.json.error.code).toBe("INVALID_TRANSITION");

    expect(await counts()).toEqual(before);
    expect((await row(started)).status).toBe("requested");
  });
});
