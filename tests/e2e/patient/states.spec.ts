// Every approved patient screen defines its four states: loading, empty, error, success
// (R86). The API is held back, emptied or failed at the network, so each state can be seen.
import { type Page, type Route, expect, test } from "@playwright/test";
import { HARTWELL, JORDAN, actAs, cancelAllUpcoming, doctorId, openSlots } from "./helpers";

let jordan: string;

const serverError = (route: Route) =>
  route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "INTERNAL", message: "Something went wrong on our side.", requestId: "11111111-2222-4333-8444-555555555555" },
    }),
  });
const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Holds matching requests until release() is called. */
async function hold(page: Page, url: string | RegExp): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

test.beforeEach(async ({ page, request }) => {
  jordan = await actAs(page, JORDAN);
  await cancelAllUpcoming(request, jordan);
});

test.describe("Find a doctor", () => {
  const SEARCH = /\/api\/v1\/doctors(\?.*)?$/;

  test("loading, then success", async ({ page }) => {
    const release = await hold(page, SEARCH);
    await page.goto("/patient/doctors");
    await expect(page.getByRole("status").filter({ hasText: "Searching for doctors" })).toBeVisible();
    release();
    await expect(page.getByRole("link", { name: HARTWELL, exact: true })).toBeVisible();
    await expect(page.getByText(/doctors match\. Times are shown in each clinic's time zone\./)).toBeVisible();
  });

  test("empty: says why and what to do next", async ({ page }) => {
    await page.goto("/patient/doctors?name=zzzz-nobody");
    await expect(page.getByRole("heading", { name: "No doctors match these filters" })).toBeVisible();
    await expect(page.getByLabel("Doctor name")).toHaveValue("zzzz-nobody");
    await page.getByRole("button", { name: "Clear filters and show all doctors" }).click();
    await expect(page.getByRole("link", { name: HARTWELL, exact: true })).toBeVisible();
    await expect(page.getByLabel("Doctor name")).toHaveValue("");
  });

  test("error: keeps the filters, shows a reference, and can be retried", async ({ page }) => {
    await page.route(SEARCH, serverError);
    await page.goto("/patient/doctors?location=Larkfield");
    await expect(page.getByRole("heading", { name: "Error: we could not load doctors" })).toBeVisible();
    await expect(page.getByText("Your filters are still filled in.")).toBeVisible();
    await expect(page.getByText("Reference: 11111111-2222-4333-8444-555555555555")).toBeVisible();
    await expect(page.getByLabel("Location (city or area)")).toHaveValue("Larkfield");
    await page.unroute(SEARCH);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("link", { name: HARTWELL, exact: true })).toBeVisible();
  });
});

test.describe("Doctor profile and open slots", () => {
  const SLOTS = /\/api\/v1\/doctors\/[^/]+\/slots/;

  test("loading, then success", async ({ page, request }) => {
    const doctor = await doctorId(request, jordan, "hartwell");
    const release = await hold(page, SLOTS);
    await page.goto(`/patient/doctors/${doctor}`);
    await expect(page.getByRole("heading", { name: HARTWELL })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading open slots" })).toBeVisible();
    release();
    await expect(page.locator(".slot-grid a").first()).toBeVisible();
  });

  test("empty: no open slots", async ({ page, request }) => {
    const doctor = await doctorId(request, jordan, "hartwell");
    await page.route(SLOTS, (route) =>
      json(route, { timeZone: "America/Chicago", from: "2026-01-01T00:00:00Z", to: "2026-01-15T00:00:00Z", days: [], hasLater: false }),
    );
    await page.goto(`/patient/doctors/${doctor}`);
    await expect(page.getByRole("heading", { name: "No open slots right now" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Find another doctor" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  });

  test("error: the slots, and a doctor that does not exist", async ({ page, request }) => {
    const doctor = await doctorId(request, jordan, "hartwell");
    await page.route(SLOTS, serverError);
    await page.goto(`/patient/doctors/${doctor}`);
    await expect(page.getByRole("heading", { name: "Error: we could not load the open slots" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

    await page.goto("/patient/doctors/7f0c1f0e-3d0a-4b53-9d2e-0a1b2c3d4e5f");
    await expect(page.getByRole("heading", { name: "Error: we could not load this doctor" })).toBeVisible();
    await expect(page.getByText("We could not find that.")).toBeVisible();
  });
});

test.describe("Confirm booking", () => {
  test("loading, then the review; an error books nothing", async ({ page, request }) => {
    const doctor = await doctorId(request, jordan, "hartwell");
    const [slot] = await openSlots(request, jordan, doctor);
    const release = await hold(page, /\/api\/v1\/me\/profile$/);
    await page.goto(`/patient/doctors/${doctor}/book?start=${encodeURIComponent(slot)}`);
    await expect(page.getByRole("status").filter({ hasText: "Loading the appointment details" })).toBeVisible();
    release();
    await expect(page.getByRole("button", { name: "Confirm booking" })).toBeVisible();

    await page.route(/\/api\/v1\/appointments$/, serverError);
    await page.getByLabel("Reason for visit").fill("Fictional check-up");
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "Error: the appointment was not booked" })).toBeVisible();
    await expect(page.getByText("Nothing has been booked.").first()).toBeVisible();
    // What was typed is still there.
    await expect(page.getByLabel("Reason for visit")).toHaveValue("Fictional check-up");
  });

  test("without a chosen time it says so and offers the open slots", async ({ page, request }) => {
    const doctor = await doctorId(request, jordan, "hartwell");
    await page.goto(`/patient/doctors/${doctor}/book`);
    await expect(page.getByRole("heading", { name: "Error: no time was chosen" })).toBeVisible();
    await expect(page.getByRole("link", { name: "See all open slots" })).toBeVisible();
  });
});

test.describe("My appointments", () => {
  const MINE = /\/api\/v1\/me\/appointments/;

  test("loading, then empty: none yet", async ({ page }) => {
    const release = await hold(page, MINE);
    await page.goto("/patient/appointments");
    await expect(page.getByRole("status").filter({ hasText: "Loading your appointments" })).toBeVisible();
    release();
    await expect(page.getByRole("heading", { name: /^Upcoming \(\d+\)$/ })).toBeVisible();
    // Jordan may have past appointments from earlier runs, so the empty state is forced.
    await page.unroute(MINE);
    await page.route(MINE, (route) => json(route, { items: [], total: 0, nextCursor: null }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "You have no upcoming appointments" })).toBeVisible();
    await expect(page.getByText("You have no past appointments.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Find a doctor" }).last()).toBeVisible();
  });

  test("error: says nothing changed and can be retried", async ({ page }) => {
    await page.route(MINE, serverError);
    await page.goto("/patient/appointments");
    await expect(page.getByRole("heading", { name: "Error: we could not load your appointments" })).toBeVisible();
    await expect(page.getByText("Your appointments have not changed.")).toBeVisible();
    await page.unroute(MINE);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: /^Upcoming \(\d+\)$/ })).toBeVisible();
  });
});
