// Visual check of the Confirm booking screen at phone size (mock 09). Run with make visual; it is
// not part of make test or make check. Regenerate the baseline after an approved change with:
//   npx playwright test visual --update-snapshots
//
// Everything on screen is pinned: a fixed appointment time in the address (the review screen
// does not book, so it need not be open), a fixed browser clock before it, and a patient with
// no upcoming appointments, so "your 1st of 3" never drifts.
import { expect, test } from "@playwright/test";
import { HARTWELL, SAM, actAs, cancelAllUpcoming, doctorId } from "./helpers";

/** Wednesday 21 October 2026, 9:00 AM CDT, a working-hours slot of Dr. Hartwell's. */
const START = "2026-10-21T14:00:00.000Z";
/** A week earlier, so the slot is outside the 24-hour cancellation window. */
const NOW = new Date("2026-10-14T15:00:00.000Z");

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

test("Confirm booking, review", async ({ page, request }) => {
  await page.clock.setFixedTime(NOW);
  const sam = await actAs(page, SAM);
  await cancelAllUpcoming(request, sam);
  const doctor = await doctorId(request, sam, HARTWELL);

  await page.goto(`/patient/doctors/${doctor}/book?start=${encodeURIComponent(START)}`);
  await expect(page.getByRole("button", { name: "Confirm booking" })).toBeVisible();
  await expect(page.getByText("Before you confirm")).toBeVisible();
  // The Next.js development badge is not part of the app. In development, React runs effects
  // twice, which can move focus to the heading; whether it has landed yet is timing, not design.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await expect(page).toHaveScreenshot("confirm-booking.png", { fullPage: true, maxDiffPixelRatio: 0.01 });
});
