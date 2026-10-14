"use client";

// Shared by the patient screens: the response shapes of the Stream A routes, a hook that loads
// one of them, and the wording of load errors. Everything here runs in the browser.
import { useEffect, useState, useSyncExternalStore } from "react";
import { clinicTime } from "@/domain/time";
import { type ApiError, type ApiResult, api, readDevUserSnapshot, subscribeDevUser } from "@/lib/api-client";

export interface DoctorSummary {
  doctorId: string;
  name: string;
  specialty: string;
  clinicName: string;
  area: string;
  city: string;
  timeZone: string;
  nextOpenSlot: string;
}

export interface SearchResponse {
  doctors: DoctorSummary[];
  total: number;
  nextCursor: string | null;
}

export interface DoctorProfileResponse {
  doctor: {
    id: string;
    name: string;
    specialty: string;
    description: string;
    slotLengthMinutes: number;
    clinicName: string;
    clinicAddress: string;
    timeZone: string;
  };
  booking: { cancellationWindowHours: number; maxUpcomingPerPatient: number; upcomingCount: number } | null;
}

export interface SlotTime {
  startsAt: string;
  endsAt: string;
}

export interface SlotsResponse {
  timeZone: string;
  from: string;
  to: string;
  days: { date: string; slots: SlotTime[] }[];
  hasLater: boolean;
}

/** The fields a patient sees on their own appointment (src/domain/visibility.ts). */
export interface PatientAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  cancellationDeadline: string;
  status: "requested" | "confirmed" | "cancelled" | "completed" | "no_show";
  cancelledBy: "patient" | "clinic" | null;
  doctorId: string;
  doctorName: string;
  specialty: string;
  clinicName: string;
  clinicAddress: string;
}

export interface AppointmentsResponse {
  items: { appointment: PatientAppointment }[];
  total: number;
  nextCursor: string | null;
}

export interface Loaded<T> {
  loading: boolean;
  result: ApiResult<T> | null;
  /** When the result arrived, in epoch milliseconds. */
  receivedAt: number | null;
  retry: () => void;
}

/**
 * Loads one GET path of /api/v1, again whenever the path or the acting user changes. Pass null
 * to load nothing yet.
 */
export function useApi<T>(path: string | null): Loaded<T> {
  const user = useSyncExternalStore(subscribeDevUser, readDevUserSnapshot, () => null);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ key: string; result: ApiResult<T>; at: number } | null>(null);
  const key = path === null ? null : `${user ?? ""}|${attempt}|${path}`;

  useEffect(() => {
    if (key === null || path === null) return;
    const controller = new AbortController();
    void api<T>(path, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setSettled({ key, result, at: Date.now() });
    });
    return () => controller.abort();
  }, [key, path]);

  const current = settled !== null && settled.key === key ? settled : null;
  return {
    loading: key !== null && current === null,
    result: current?.result ?? null,
    receivedAt: current?.at ?? null,
    retry: () => setAttempt((n) => n + 1),
  };
}

/**
 * The error state of a screen (R88). A fault on our side gets the screen's own words; anything
 * else, such as not being signed in, already says what happened and what to do next.
 */
export function loadError(error: ApiError, title: string, serverFault: string) {
  return {
    title,
    message: error.code === "INTERNAL" ? serverFault : error.message,
    requestId: error.requestId,
  };
}

/** "Wed, Oct 14, 2026", the calendar date of an instant in the clinic's time zone. */
export function clinicDateLabel(instant: string, timeZone: string): string {
  return clinicTime(new Date(instant), timeZone).dateLabel;
}

/** "CDT": the clinic zone's abbreviation at that instant. */
export function clinicZoneLabel(instant: string | Date, timeZone: string): string {
  return clinicTime(typeof instant === "string" ? new Date(instant) : instant, timeZone).zoneAbbreviation;
}
