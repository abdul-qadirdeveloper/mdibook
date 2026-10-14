// Calls the patient-facing routes the way a browser would, for the tests in this folder.
// The real route handlers and the real use cases run against the real test database.
import { POST as cancelRoute } from "@/app/api/v1/appointments/[id]/cancel/route";
import { POST as rescheduleRoute } from "@/app/api/v1/appointments/[id]/reschedule/route";
import { GET as readRoute } from "@/app/api/v1/appointments/[id]/route";
import { POST as bookRoute } from "@/app/api/v1/appointments/route";
import { GET as doctorRoute } from "@/app/api/v1/doctors/[doctorId]/route";
import { GET as slotsRoute } from "@/app/api/v1/doctors/[doctorId]/slots/route";
import { GET as searchRoute } from "@/app/api/v1/doctors/route";
import { GET as myAppointmentsRoute } from "@/app/api/v1/me/appointments/route";
import { GET as profileRoute, PATCH as profilePatchRoute } from "@/app/api/v1/me/profile/route";
import { GET as specialtiesRoute } from "@/app/api/v1/specialties/route";
import { apiRequest, call } from "../../helpers/request";

export interface ErrorJson {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: { field: string; problem: string }[];
    nextSlots?: { startsAt: string; endsAt: string }[];
    timeZone?: string;
    limit?: number;
  };
}

export type Appointment = Record<string, unknown> & { id: string; startsAt: string; status: string };
export interface AppointmentJson {
  appointment: Appointment;
  recordedAsLate?: boolean;
}

export interface SearchJson {
  doctors: {
    doctorId: string;
    name: string;
    specialty: string;
    clinicName: string;
    area: string;
    city: string;
    timeZone: string;
    nextOpenSlot: string;
  }[];
  total: number;
  nextCursor: string | null;
}

export interface SlotsJson {
  timeZone: string;
  from: string;
  to: string;
  days: { date: string; slots: { startsAt: string; endsAt: string }[] }[];
  hasLater: boolean;
}

export interface DoctorJson {
  doctor: Record<string, unknown>;
  booking: { cancellationWindowHours: number; maxUpcomingPerPatient: number; upcomingCount: number } | null;
}

export interface MyAppointmentsJson {
  items: { appointment: Appointment }[];
  total: number;
  nextCursor: string | null;
}

export interface ProfileJson {
  profile: { fullName: string; phone: string; email: string; dateOfBirth: string | null };
}

const queryString = (query: Record<string, string>) => {
  const text = new URLSearchParams(query).toString();
  return text ? `?${text}` : "";
};

/** A fictional reason for visit. Tests assert it never reaches logs, staff or other patients. */
export const REASON = "Fictional reason for visit";

export function bookingBody(doctorId: string, start: Date, over: Record<string, unknown> = {}) {
  return { doctorId, startsAt: start.toISOString(), reasonForVisit: REASON, ...over };
}

export const book = (userId: string | undefined, body: unknown, headers?: Record<string, string>) =>
  call<AppointmentJson & ErrorJson>(bookRoute, apiRequest("POST", "/api/v1/appointments", { userId, body, headers }));

export const read = (userId: string | undefined, id: string) =>
  call<AppointmentJson & ErrorJson>(readRoute, apiRequest("GET", `/api/v1/appointments/${id}`, { userId }), { id });

export const reschedule = (userId: string | undefined, id: string, body: unknown) =>
  call<AppointmentJson & ErrorJson>(
    rescheduleRoute,
    apiRequest("POST", `/api/v1/appointments/${id}/reschedule`, { userId, body }),
    { id },
  );

export const cancel = (userId: string | undefined, id: string, body?: unknown) =>
  call<AppointmentJson & ErrorJson>(
    cancelRoute,
    apiRequest("POST", `/api/v1/appointments/${id}/cancel`, { userId, body }),
    { id },
  );

export const specialties = (userId: string | undefined) =>
  call<{ specialties: { id: string; name: string }[] } & ErrorJson>(
    specialtiesRoute,
    apiRequest("GET", "/api/v1/specialties", { userId }),
  );

export const search = (userId: string | undefined, query: Record<string, string> = {}) =>
  call<SearchJson & ErrorJson>(searchRoute, apiRequest("GET", `/api/v1/doctors${queryString(query)}`, { userId }));

export const doctorProfile = (userId: string | undefined, doctorId: string) =>
  call<DoctorJson & ErrorJson>(doctorRoute, apiRequest("GET", `/api/v1/doctors/${doctorId}`, { userId }), { doctorId });

export const slots = (userId: string | undefined, doctorId: string, query: Record<string, string> = {}) =>
  call<SlotsJson & ErrorJson>(
    slotsRoute,
    apiRequest("GET", `/api/v1/doctors/${doctorId}/slots${queryString(query)}`, { userId }),
    { doctorId },
  );

export const myAppointments = (userId: string | undefined, query: Record<string, string> = {}) =>
  call<MyAppointmentsJson & ErrorJson>(
    myAppointmentsRoute,
    apiRequest("GET", `/api/v1/me/appointments${queryString(query)}`, { userId }),
  );

export const getProfile = (userId: string | undefined) =>
  call<ProfileJson & ErrorJson>(profileRoute, apiRequest("GET", "/api/v1/me/profile", { userId }));

export const patchProfile = (userId: string | undefined, body: unknown) =>
  call<ProfileJson & ErrorJson>(profilePatchRoute, apiRequest("PATCH", "/api/v1/me/profile", { userId, body }));

/** Every open slot start the slots route returns for a doctor in the default period. */
export async function openStarts(userId: string, doctorId: string): Promise<string[]> {
  const result = await slots(userId, doctorId);
  return result.json.days.flatMap((day) => day.slots.map((slot) => slot.startsAt));
}

/** An error body without its request reference, to compare two refusals (R8). */
export function shape(json: ErrorJson): unknown {
  return { ...json.error, requestId: "" };
}
