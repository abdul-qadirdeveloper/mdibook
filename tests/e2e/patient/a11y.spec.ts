// Accessibility of the approved patient screens (R87): labels, keyboard, visible focus,
// contrast, and targets of at least 44 by 44 px.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { JORDAN, actAs, bookByApi, cancelAllUpcoming, doctorId, openSlots } from "./helpers";

let jordan: string;

test.beforeEach(async ({ page, request }) => {
  jordan = await actAs(page, JORDAN);
  await cancelAllUpcoming(request, jordan);
});

test.afterEach(async ({ request }) => {
  await cancelAllUpcoming(request, jordan);
});

/** No WCAG 2 A or AA failure that axe can detect: labels, names, roles, contrast. */
async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Every button, button-styled link, input and select in the main content is at least 44 px tall and wide. */
async function expectTargets(page: Page) {
  const small = await page
    .locator("main")
    .locator("button, a.button, input, select, textarea, a.back-link")
    .evaluateAll((elements) =>
      elements
        .map((element) => ({ text: (element.textContent ?? "").trim().slice(0, 30), box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && (box.height < 44 || box.width < 44))
        .map(({ text, box }) => `${text} ${Math.round(box.width)}x${Math.round(box.height)}`),
    );
  expect(small).toEqual([]);
}

test("Find a doctor", async ({ page }) => {
  await page.goto("/patient/doctors");
  await expect(page.locator(".result-card").first()).toBeVisible();
  for (const label of ["Doctor name", "Specialty", "Location (city or area)", "Availability"]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expectNoViolations(page);
  await expectTargets(page);

  // By keyboard alone: type a filter, submit with Enter, and reach a result.
  await page.getByLabel("Doctor name").focus();
  await page.keyboard.type("hartwell");
  await page.keyboard.press("Enter");
  await expect(page.locator(".result-card")).toHaveCount(1);
  const link = page.locator(".result-card h3 a");
  await link.focus();
  // Focus is visible: the focused link has an outline.
  expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Open slots" })).toBeVisible();
});

test("Doctor profile and open slots", async ({ page, request }) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  await page.goto(`/patient/doctors/${doctor}`);
  await expect(page.locator(".slot-grid a").first()).toBeVisible();
  await expectNoViolations(page);
  await expectTargets(page);

  // A slot is a link that can be reached and followed from the keyboard.
  await page.locator(".slot-grid a").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Confirm your appointment" })).toBeVisible();
});

test("Confirm booking: review, errors and booked", async ({ page, request }) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  const [slot] = await openSlots(request, jordan, doctor);
  await page.goto(`/patient/doctors/${doctor}/book?start=${encodeURIComponent(slot)}`);
  await expect(page.getByLabel("Date of birth")).toBeVisible();
  await expect(page.getByLabel("Reason for visit")).toBeVisible();
  await expectNoViolations(page);
  await expectTargets(page);

  // An error is text that starts with "Error:", tied to its field. Colour is not the only signal.
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("Error: Enter a reason for your visit.")).toBeVisible();
  const describedBy = await page.getByLabel("Reason for visit").getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expectNoViolations(page);

  // Fill and submit from the keyboard. Focus moves to the new heading.
  await page.getByLabel("Reason for visit").focus();
  await page.keyboard.type("Fictional check-up");
  await page.getByRole("button", { name: "Confirm booking" }).focus();
  await page.keyboard.press("Enter");
  const booked = page.getByRole("heading", { name: "Appointment booked" });
  await expect(booked).toBeVisible();
  await expect(booked).toBeFocused();
  await expectNoViolations(page);
  await expectTargets(page);
});

test("My appointments", async ({ page, request }) => {
  const doctor = await doctorId(request, jordan, "hartwell");
  const slots = await openSlots(request, jordan, doctor);
  await bookByApi(request, jordan, doctor, slots[slots.length - 1]);
  await page.goto("/patient/appointments");
  await expect(page.getByRole("heading", { name: "Upcoming (1)" })).toBeVisible();
  await expectNoViolations(page);
  await expectTargets(page);
  // Status is written out, not shown by colour.
  await expect(page.locator(".status-badge").first()).toHaveText(/^Status: /);
});
