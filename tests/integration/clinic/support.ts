// Shared by the Stream B integration tests. Fictional data only; the database is real.
import { POST as changePreviewRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/preview/route";
import { POST as changeApplyRoute } from "@/app/api/v1/doctors/[doctorId]/schedule-changes/route";
import { POST as timeOffPreviewRoute } from "@/app/api/v1/doctors/[doctorId]/time-off/preview/route";
import { POST as timeOffRoute } from "@/app/api/v1/doctors/[doctorId]/time-off/route";
import { bookAppointment } from "@/lib/appointments/core";
import { db } from "@/lib/db";
import type { Session } from "@/lib/session";
import { NOW, at } from "../../helpers/clock";
import { createClinic, createDoctor, createStaff, createWorld, sessionFor } from "../../helpers/factories";
import { type ApiResult, apiRequest, call } from "../../helpers/request";

export type World = Awaited<ReturnType<typeof createWorld>>;
export type Handler = Parameters<typeof call>[0];
export type Appointment = Record<string, unknown>;

export interface ErrorJson {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: { field: string; problem: string }[];
    nextSlots?: unknown[];
    limit?: number;
  };
}

// Wednesday 14 October 2026 in Chicago. The default doctor works every day, 09:00 to 17:00,
// in 30-minute slots. NOW is Monday 12 October, 07:00.
export const DAY = "2026-10-14";
export const S0900 = at(DAY, "09:00");
export const S0930 = at(DAY, "09:30");
export const S1000 = at(DAY, "10:00");
export const S1600 = at(DAY, "16:00");
export const S1630 = at(DAY, "16:30");

/** A token of the right shape that matches no preview. */
export const NO_TOKEN = "0".repeat(64);

export const everyDay = (startMinute: number, endMinute: number) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute, endMinute }));

export interface SendOptions {
  params?: Record<string, string>;
  body?: unknown;
  query?: string;
  headers?: Record<string, string>;
}

/** Calls a route handler as a user. Omit the user for a request with no session. */
export function send<T = Record<string, unknown>>(
  handler: Handler,
  method: string,
  userId: string | undefined,
  options: SendOptions = {},
): Promise<ApiResult<T>> {
  const path = `/api/v1/test${options.query ? `?${options.query}` : ""}`;
  return call<T>(
    handler,
    apiRequest(method, path, { userId, body: options.body, headers: options.headers }),
    options.params ?? {},
  );
}

/** Books through the core. By the world's patient (requested) unless another actor is given. */
export async function book(
  w: World,
  start: Date,
  over: { by?: Session; patientId?: string; doctorId?: string; now?: Date } = {},
): Promise<string> {
  const result = await bookAppointment(
    {
      actor: over.by ?? w.patientSession,
      doctorId: over.doctorId ?? w.doctor.id,
      patientId: over.patientId ?? w.patient.id,
      start,
      reasonForVisit: "Fictional reason",
      idempotencyKey: null,
    },
    over.now ?? NOW,
  );
  return result.appointmentId;
}

export interface Preview {
  preview: {
    count: number;
    dates: string[];
    timeZone: string;
    appointments: Appointment[];
    previewToken: string;
    startsAt?: string;
    endsAt?: string;
  };
}

export interface Applied {
  scheduleChange: { id: string; doctorId: string; kind: string; reasonCode: string; at: string; appointmentsCancelled: number };
  timeOff?: { id: string; startsAt: string; endsAt: string; reasonCode: string };
}

const doctorParams = (doctorId: string) => ({ params: { doctorId } });

/** Previews a change to working hours or breaks, then confirms it: what the screen will do. */
export async function changeSchedule(
  userId: string,
  doctorId: string,
  change: { kind: "working_hours" | "breaks"; intervals: { weekday: number; startMinute: number; endMinute: number }[] },
  reasonCode = "schedule_change",
) {
  const preview = await send<Preview>(changePreviewRoute, "POST", userId, { ...doctorParams(doctorId), body: change });
  const applied = await send<Applied>(changeApplyRoute, "POST", userId, {
    ...doctorParams(doctorId),
    body: { ...change, reasonCode, previewToken: preview.json.preview?.previewToken },
  });
  return { preview, applied };
}

export interface TimeOffBody {
  startDate: string;
  startMinute: number;
  endDate: string;
  endMinute: number;
}

/** Previews time off, then confirms it. */
export async function addTimeOff(userId: string, doctorId: string, body: TimeOffBody, reasonCode = "planned_leave") {
  const preview = await send<Preview>(timeOffPreviewRoute, "POST", userId, { ...doctorParams(doctorId), body });
  const applied = await send<Applied>(timeOffRoute, "POST", userId, {
    ...doctorParams(doctorId),
    body: { ...body, reasonCode, previewToken: preview.json.preview?.previewToken },
  });
  return { preview, applied };
}

export const row = (id: string) => db.appointment.findUniqueOrThrow({ where: { id } });

/** A second clinic with its own doctor and staff member. */
export async function otherClinic() {
  const clinic = await createClinic();
  const { user: doctorUser, doctor } = await createDoctor(clinic.id);
  const { user: staffUser } = await createStaff(clinic.id);
  return {
    clinic,
    doctor,
    doctorUser,
    staffUser,
    doctorSession: await sessionFor(doctorUser.id),
    staffSession: await sessionFor(staffUser.id),
  };
}

/** Row counts of everything a schedule or appointment action can write. */
export async function counts() {
  const [appointments, active, history, audit, notifications, hours, breaks, timeOff, changes] = await Promise.all([
    db.appointment.count(),
    db.appointment.count({ where: { status: { in: ["requested", "confirmed"] } } }),
    db.appointmentHistory.count(),
    db.auditEvent.count(),
    db.notificationEvent.count(),
    db.workingHours.count(),
    db.break.count(),
    db.timeOff.count(),
    db.scheduleChange.count(),
  ]);
  return { appointments, active, history, audit, notifications, hours, breaks, timeOff, changes };
}
