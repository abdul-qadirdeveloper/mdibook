// Notifications (R74 to R76): the log adapter is called, the event holds only a type, a
// timestamp and four ids, and another channel can be substituted without changing a caller.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookAppointment, changeAppointmentStatus } from "@/lib/appointments/core";
import { db } from "@/lib/db";
import {
  type NotificationAdapter,
  type NotificationEvent,
  deliverNotifications,
  logAdapter,
  setNotificationAdapter,
} from "@/lib/notifications";
import { NOW, at, captureLogs } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createWorld } from "../../helpers/factories";

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;
const S0900 = at("2026-10-14", "09:00");

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
});

afterEach(() => setNotificationAdapter(null));

const book = () =>
  bookAppointment(
    {
      actor: w.patientSession,
      doctorId: w.doctor.id,
      patientId: w.patient.id,
      start: S0900,
      reasonForVisit: "Fictional reason about a private matter",
    },
    NOW,
  );

describe("the log adapter (R74)", () => {
  it("is the default channel and writes the event to the application log", async () => {
    const { result, lines } = await captureLogs(book);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      ts: lines[0].ts,
      level: "info",
      event: "notification.booked",
      appointmentId: result.appointmentId,
      clinicId: w.clinic.id,
      patientId: w.patient.id,
      doctorId: w.doctor.id,
    });
  });

  it("the logged event holds only type, timestamp and four ids (R75)", async () => {
    const { lines, raw } = await captureLogs(async () => {
      const booked = await book();
      await changeAppointmentStatus(
        { actor: w.staffSession, appointmentId: booked.appointmentId, to: "cancelled", reasonCode: "doctor_unavailable" },
        NOW,
      );
    });
    expect(lines.map((l) => l.event)).toEqual(["notification.booked", "notification.cancelled"]);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        ["appointmentId", "clinicId", "doctorId", "event", "level", "patientId", "ts"].sort(),
      );
    }
    const specialty = await db.specialty.findFirstOrThrow();
    for (const forbidden of [
      w.patient.fullName,
      w.patientUser.email,
      w.patient.phone,
      "1990-05-17",
      "Fictional reason",
      specialty.name,
      w.doctor.name,
      "doctor_unavailable",
      S0900.toISOString(),
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe("the stored event (R75, R77)", () => {
  it("has columns for a type, a timestamp and four ids, and nothing else", async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'NotificationEvent' ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      "appointmentId",
      "at",
      "clinicId",
      "doctorId",
      "id",
      "patientId",
      "type",
    ]);
  });

  it("is written with the state change and matches what the adapter receives", async () => {
    const received: NotificationEvent[] = [];
    setNotificationAdapter({ deliver: (event) => void received.push(event) });
    const booked = await book();
    const stored = await db.notificationEvent.findMany();
    expect(stored).toHaveLength(1);
    expect(received).toEqual([
      {
        type: "booked",
        at: stored[0].at,
        appointmentId: booked.appointmentId,
        clinicId: w.clinic.id,
        patientId: w.patient.id,
        doctorId: w.doctor.id,
      },
    ]);
    expect(Object.keys(received[0]).sort()).toEqual(["appointmentId", "at", "clinicId", "doctorId", "patientId", "type"]);
  });
});

describe("a substitute adapter (R76)", () => {
  it("replaces the log without any change to the caller", async () => {
    const sent: string[] = [];
    const channel: NotificationAdapter = {
      async deliver(event) {
        sent.push(`${event.type}:${event.appointmentId}`);
      },
    };
    setNotificationAdapter(channel);
    // The same calls as everywhere else in this suite: the core knows nothing of the channel.
    const { result, lines } = await captureLogs(async () => {
      const booked = await book();
      await changeAppointmentStatus({ actor: w.staffSession, appointmentId: booked.appointmentId, to: "confirmed" }, NOW);
      return booked;
    });
    expect(sent).toEqual([`booked:${result.appointmentId}`, `confirmed:${result.appointmentId}`]);
    expect(lines).toEqual([]);

    setNotificationAdapter(null);
    const back = await captureLogs(() =>
      changeAppointmentStatus(
        { actor: w.staffSession, appointmentId: result.appointmentId, to: "cancelled", reasonCode: "other" },
        NOW,
      ),
    );
    expect(back.lines.map((l) => l.event)).toEqual(["notification.cancelled"]);
  });

  it("a failing channel does not undo or fail the state change", async () => {
    setNotificationAdapter({
      deliver() {
        throw new Error("channel down");
      },
    });
    const { result, lines } = await captureLogs(book);
    const row = await db.appointment.findUniqueOrThrow({ where: { id: result.appointmentId } });
    expect(row.status).toBe("requested");
    expect(await db.notificationEvent.count({ where: { appointmentId: result.appointmentId } })).toBe(1);
    expect(lines).toEqual([
      { ts: lines[0].ts, level: "error", event: "notification.delivery_failed", appointmentId: result.appointmentId },
    ]);
  });

  it("delivers events in order", async () => {
    const order: string[] = [];
    setNotificationAdapter({ deliver: (event) => void order.push(event.type) });
    const base = { at: NOW, appointmentId: w.clinic.id, clinicId: w.clinic.id, patientId: w.patient.id, doctorId: w.doctor.id };
    await deliverNotifications([
      { ...base, type: "booked" },
      { ...base, type: "rescheduled" },
      { ...base, type: "cancelled" },
    ]);
    expect(order).toEqual(["booked", "rescheduled", "cancelled"]);
    expect(logAdapter).toBeDefined();
  });
});
