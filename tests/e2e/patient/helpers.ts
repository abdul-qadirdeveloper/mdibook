// Shared by the patient end-to-end tests. They run against the development server and the
// seeded database (make seed): every person and clinic in it is fictional.
import { type APIRequestContext, type Page, expect } from "@playwright/test";

export const JORDAN = "Patient: Jordan Avery";
export const SAM = "Patient: Sam Rivera";
export const HARTWELL = "Dr. Lena Hartwell";
/** Dr. Hartwell's clinic, Lakeside Family Clinic, is in this zone. */
export const CLINIC_ZONE = "America/Chicago";

/** Chooses a seeded user on the home page (the development stand-in for sign-in). */
export async function actAs(page: Page, label: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByText(`You are acting as ${label}.`)).toBeVisible();
  const stored = await page.evaluate(() => window.localStorage.getItem("medibook.devUser"));
  return (JSON.parse(stored ?? "{}") as { userId: string }).userId;
}

const as = (userId: string) => ({ headers: { "x-dev-user-id": userId } });

interface Listed {
  items: { appointment: { id: string } }[];
}

export async function upcomingCount(request: APIRequestContext, userId: string): Promise<number> {
  const response = await request.get("/api/v1/me/appointments?scope=upcoming", as(userId));
  return ((await response.json()) as Listed).items.length;
}

/** Cancels every upcoming appointment of a seeded patient, so each test starts clean. */
export async function cancelAllUpcoming(request: APIRequestContext, userId: string): Promise<void> {
  const response = await request.get("/api/v1/me/appointments?scope=upcoming", as(userId));
  for (const item of ((await response.json()) as Listed).items) {
    await request.post(`/api/v1/appointments/${item.appointment.id}/cancel`, as(userId));
  }
}

export async function doctorId(request: APIRequestContext, userId: string, name: string): Promise<string> {
  const response = await request.get(`/api/v1/doctors?name=${encodeURIComponent(name)}`, as(userId));
  const body = (await response.json()) as { doctors: { doctorId: string }[] };
  return body.doctors[0].doctorId;
}

export async function openSlots(request: APIRequestContext, userId: string, doctor: string): Promise<string[]> {
  let from = "";
  for (let i = 0; i < 8; i += 1) {
    const response = await request.get(`/api/v1/doctors/${doctor}/slots${from}`, as(userId));
    const body = (await response.json()) as { to: string; days: { slots: { startsAt: string }[] }[] };
    const starts = body.days.flatMap((day) => day.slots.map((slot) => slot.startsAt));
    if (starts.length > 0) return starts;
    from = `?from=${encodeURIComponent(body.to)}`;
  }
  throw new Error("The seeded doctor has no open slots");
}

export async function bookByApi(
  request: APIRequestContext,
  userId: string,
  doctor: string,
  startsAt: string,
): Promise<string> {
  const response = await request.post("/api/v1/appointments", {
    ...as(userId),
    data: { doctorId: doctor, startsAt, reasonForVisit: "Fictional check-up" },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { appointment: { id: string } }).appointment.id;
}

/** "9:00 AM CDT": how a time must read in the clinic's zone, whatever zone the browser is in. */
export function clinicTimeText(instant: string, zone: string = CLINIC_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`;
}
