// The audit trail of one appointment, for staff (R81): ids and fixed codes, oldest first.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as historyRoute } from "@/app/api/v1/clinic/appointments/[id]/history/route";
import { changeAppointmentStatus } from "@/lib/appointments/core";
import { NOW, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createWorld } from "../../helpers/factories";
import { type ErrorJson, S0900, type World, book, send } from "./support";

interface HistoryJson {
  history: {
    appointmentId: string;
    events: { id: string; action: string; actorId: string; actorRole: string; at: string }[];
  };
}

let w: World;
const read = (id: string, userId = w.staffUser.id) =>
  send<HistoryJson & ErrorJson>(historyRoute, "GET", userId, { params: { id } });

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("appointment history", () => {
  it("lists the appointment's audit events, oldest first, with ids and codes only", async () => {
    const id = await book(w, S0900);
    await changeAppointmentStatus({ actor: w.staffSession, appointmentId: id, to: "confirmed" }, NOW);

    const result = await read(id);
    expect(result.status).toBe(200);
    expect(result.json.history.appointmentId).toBe(id);
    expect(result.json.history.events.map((e) => [e.action, e.actorRole])).toEqual([
      ["appointment.booked", "patient"],
      ["appointment.confirmed", "staff"],
    ]);
    for (const event of result.json.history.events) {
      expect(Object.keys(event).sort()).toEqual(["action", "actorId", "actorRole", "at", "id"]);
    }
  });

  it("is for staff only", async () => {
    const id = await book(w, S0900);
    for (const userId of [w.patientUser.id, w.doctorUser.id]) {
      expect((await read(id, userId)).status).toBe(403);
    }
  });

  it("is NOT_FOUND for an appointment that does not exist", async () => {
    const result = await read("00000000-0000-4000-8000-000000000000");
    expect(result.status).toBe(404);
    expect(result.json.error.code).toBe("NOT_FOUND");
  });
});
