// The booking flow in the browser (R17, R23, R26, R70, and the success criterion: a signed-in
// patient gets from "Find a doctor" to "Booked" inside a minute).
import { expect, test } from "@playwright/test";
import {
  HARTWELL,
  JORDAN,
  SAM,
  actAs,
  bookByApi,
  cancelAllUpcoming,
  clinicTimeText,
  doctorId,
  openSlots,
  upcomingCount,
} from "./helpers";

let jordan: string;
let sam: string;

test.beforeEach(async ({ page, request }) => {
  sam = await actAs(page, SAM);
  jordan = await actAs(page, JORDAN);
  await cancelAllUpcoming(request, jordan);
  await cancelAllUpcoming(request, sam);
});

test.afterEach(async ({ request }) => {
  await cancelAllUpcoming(request, jordan);
  await cancelAllUpcoming(request, sam);
  // One test corrects the date of birth. Put the seeded one back, even if that test failed.
  await request.patch("/api/v1/me/profile", {
    headers: { "x-dev-user-id": jordan },
    data: { dateOfBirth: "1988-03-14" },
  });
});

test("search to Booked inside a minute, and nothing is booked before Confirm booking (R17)", async ({ page, request }) => {
  const started = Date.now();
  await page.goto("/patient/doctors");
  await page.getByLabel("Doctor name").fill("hartwell");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: HARTWELL, exact: true }).click();

  await expect(page.getByRole("heading", { name: HARTWELL })).toBeVisible();
  await expect(page.getByText("Nothing is booked until you confirm on the next step.")).toBeVisible();
  await page.locator(".slot-grid a").first().click();

  // The review screen is open and still nothing is booked or held.
  await expect(page.getByRole("heading", { name: "Confirm your appointment" })).toBeVisible();
  await expect(page.getByText('Nothing is booked until you choose "Confirm booking".')).toBeVisible();
  expect(await upcomingCount(request, jordan)).toBe(0);

  // The date of birth is on file and pre-filled (R19). Only the reason is typed.
  await expect(page.getByLabel("Date of birth")).toHaveValue("14 03 1988");
  await page.getByLabel("Reason for visit").fill("Fictional annual check-up");
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByRole("heading", { name: "Appointment booked" })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(60_000);
  expect(await upcomingCount(request, jordan)).toBe(1);
  await expect(page.getByText(`Your appointment with ${HARTWELL} is booked.`)).toBeVisible();

  await page.getByRole("link", { name: "View my appointments" }).click();
  await expect(page.getByRole("heading", { name: "Upcoming (1)" })).toBeVisible();
});

test("the review screen states the appointments used and the deadline (R26)", async ({ page, request }) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  // Slots more than a day ahead, so the deadline is still to come whatever the time of day.
  const dayAhead = Date.now() + 25 * 3_600_000;
  const [first, second] = (await openSlots(request, jordan, doctor)).filter((start) => Date.parse(start) > dayAhead);
  await bookByApi(request, jordan, doctor, first);

  await page.goto(`/patient/doctors/${doctor}/book?start=${encodeURIComponent(second)}`);
  const notice = page.locator(".notice");
  await expect(notice).toContainText("This will be your 2nd of 3 upcoming appointments allowed at this clinic.");
  await expect(notice).toContainText("You can reschedule, or cancel without a late mark, until");
  await expect(notice).toContainText("(24 hours before)");
  await expect(notice).toContainText("it is recorded as a late cancellation");
  // The wording the spec replaced (F2, F4) is gone.
  await expect(page.getByText("Only the clinic can see them")).toHaveCount(0);
  await expect(page.getByText("Only you and your doctor can see them.")).toBeVisible();
});

test("a time inside the cancellation window says it cannot be rescheduled, not a deadline already past (R26, R34)", async ({
  page,
  request,
}) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  // Two hours from now: the window opened long ago. The review screen needs no open slot to say so.
  const soon = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 900_000) * 900_000).toISOString();
  await page.goto(`/patient/doctors/${doctor}/book?start=${encodeURIComponent(soon)}`);
  const notice = page.locator(".notice");
  await expect(notice).toContainText("This appointment starts within the clinic's cancellation window, which opened at");
  await expect(notice).toContainText("cannot be rescheduled online");
  await expect(notice).toContainText("To move it, call the clinic.");
  await expect(notice).not.toContainText("You can reschedule, or cancel without a late mark, until");
});

test("a slot taken while confirming: nothing is booked, three slots are offered, typed values remain (R23)", async ({
  page,
  request,
}) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  const [wanted] = await openSlots(request, jordan, doctor);

  await page.goto(`/patient/doctors/${doctor}/book?start=${encodeURIComponent(wanted)}`);
  await page.getByLabel("Reason for visit").fill("Fictional sore shoulder");
  await page.getByLabel("Date of birth").fill("15 03 1988");

  // Someone else takes the time while this patient is still on the review screen.
  await bookByApi(request, sam, doctor, wanted);
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByRole("heading", { name: "Error: that time was just taken" })).toBeVisible();
  await expect(page.getByText("Nothing has been booked for you.")).toBeVisible();
  expect(await upcomingCount(request, jordan)).toBe(0);
  const offers = page.getByRole("button", { name: "Choose this time" });
  await expect(offers).toHaveCount(3);

  const offered = clinicTimeText((await openSlots(request, jordan, doctor))[0]);
  await offers.first().click();
  // The review now shows the newly chosen time, straight away.
  await expect(page.locator(".details")).toContainText(offered.replace(/ C[DS]T$/, ""));
  await expect(page.getByLabel("Reason for visit")).toHaveValue("Fictional sore shoulder");
  await expect(page.getByLabel("Date of birth")).toHaveValue("15 03 1988");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: "Appointment booked" })).toBeVisible();
  expect(await upcomingCount(request, jordan)).toBe(1);
});

test("the form names what is missing and books nothing", async ({ page, request }) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  const [slot] = await openSlots(request, jordan, doctor);
  await page.goto(`/patient/doctors/${doctor}/book?start=${encodeURIComponent(slot)}`);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("Error: Enter a reason for your visit.")).toBeVisible();
  await expect(page.getByLabel("Reason for visit")).toHaveAttribute("aria-invalid", "true");
  expect(await upcomingCount(request, jordan)).toBe(0);
});

test.describe("a patient in another time zone", () => {
  // The browser is in Karachi. The clinic is in Chicago.
  test.use({ timezoneId: "Asia/Karachi" });

  test("sees every time in the clinic's zone, with its abbreviation (R70)", async ({ page, request }) => {
    const doctor = await doctorId(request, jordan, "hartwell");
    const [first] = await openSlots(request, jordan, doctor);
    const expected = clinicTimeText(first);
    // Whatever the first open slot is right now, it is a Chicago time. In Karachi's own zone
    // the same instant would read nine or ten hours later.
    expect(expected).toMatch(/^\d{1,2}:\d{2} [AP]M C[DS]T$/);
    const ends = clinicTimeText(new Date(Date.parse(first) + 30 * 60_000).toISOString());

    await page.goto(`/patient/doctors/${doctor}`);
    await expect(page.locator(".slot-grid a").first()).toHaveText(expected);
    await expect(page.getByText("All times are in the clinic's time zone, America/Chicago")).toBeVisible();
    for (const text of await page.locator(".slot-grid a").allTextContents()) expect(text).toMatch(/ C[DS]T$/);

    await page.locator(".slot-grid a").first().click();
    await expect(page.locator(".details")).toContainText(`${expected.replace(/ C[DS]T$/, "")} to ${ends}`);

    await page.goto("/patient/doctors?name=hartwell");
    await expect(page.locator(".result-card__slot")).toContainText(expected);
  });
});
