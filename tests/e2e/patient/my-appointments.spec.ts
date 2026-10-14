// My appointments in the browser (R44 to R47).
import { expect, test } from "@playwright/test";
import { HARTWELL, JORDAN, actAs, bookByApi, cancelAllUpcoming, clinicTimeText, doctorId, openSlots } from "./helpers";

let jordan: string;

test.beforeEach(async ({ page, request }) => {
  jordan = await actAs(page, JORDAN);
  await cancelAllUpcoming(request, jordan);
});

test.afterEach(async ({ request }) => {
  await cancelAllUpcoming(request, jordan);
});

test("an upcoming appointment shows its details, status, deadline and actions (R45, R46)", async ({ page, request }) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  const slots = await openSlots(request, jordan, doctor);
  // The last open slot of the period: its deadline is still ahead.
  const startsAt = slots[slots.length - 1];
  await bookByApi(request, jordan, doctor, startsAt);

  await page.goto("/patient/appointments");
  await expect(page.getByRole("heading", { name: "Upcoming (1)" })).toBeVisible();
  const card = page.locator(".appointment-card").first();
  await expect(card).toContainText(clinicTimeText(startsAt));
  await expect(card).toContainText(`${HARTWELL}, Family medicine`);
  await expect(card).toContainText("Lakeside Family Clinic, 120 Fictional Avenue, Northgate, Larkfield");
  await expect(card).toContainText("Status: Requested");
  await expect(card).toContainText("You can reschedule, or cancel without a late mark, until");
  await expect(card.getByRole("button", { name: "Reschedule" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancel appointment" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Book a new appointment" })).toBeVisible();
});

test("a cancelled appointment moves to Past as 'Cancelled by you' (R44, R47)", async ({ page, request }) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  const [startsAt] = await openSlots(request, jordan, doctor);
  const id = await bookByApi(request, jordan, doctor, startsAt);
  await request.post(`/api/v1/appointments/${id}/cancel`, { headers: { "x-dev-user-id": jordan } });

  await page.goto("/patient/appointments");
  await expect(page.getByRole("heading", { name: "Upcoming (0)" })).toBeVisible();
  await expect(page.getByText("Status: Cancelled by you").first()).toBeVisible();
});

test("someone who is not a patient is told so, and sees no appointments", async ({ page }) => {
  await actAs(page, "Admin");
  await page.goto("/patient/appointments");
  await expect(page.locator(".error-message")).toContainText("Your account cannot do this.");
  await expect(page.locator(".appointment-card")).toHaveCount(0);
});
