// A fixed clock for tests. Core functions take `now` as an argument, so most tests pass one of
// these instants directly. Route tests, where the wrapper reads the clock, use freezeClock().
import { vi } from "vitest";
import { localToInstant } from "@/domain/time";
import { CHICAGO } from "./factories";

/** Monday 12 October 2026, 07:00 in Chicago (CDT). */
export const NOW = new Date("2026-10-12T12:00:00Z");

/** An instant on a Chicago calendar date at a wall-clock time, for example at("2026-10-14", "09:30"). */
export function at(date: string, time: string, zone: string = CHICAGO): Date {
  const [hours, minutes] = time.split(":").map(Number);
  return localToInstant(date, hours * 60 + minutes, zone);
}

export function minutesAfter(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function hoursBefore(instant: Date, hours: number): Date {
  return new Date(instant.getTime() - hours * 3_600_000);
}

/** Freezes Date only. Timers keep running, so database calls still work. */
export function freezeClock(now: Date = NOW): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

export function restoreClock(): void {
  vi.useRealTimers();
}

/** Captures application log lines while a test runs. */
export async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[]; raw: string }> {
  const { setLogSink } = await import("@/lib/logger");
  const raw: string[] = [];
  setLogSink((line) => raw.push(line));
  try {
    const result = await run();
    return { result, lines: raw.map((l) => JSON.parse(l) as Record<string, unknown>), raw: raw.join("\n") };
  } finally {
    setLogSink(() => {});
  }
}
