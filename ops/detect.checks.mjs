// Run with: node --test ops/detect.checks.mjs     (node:test ships with Node. The file is not named *.test.* on purpose: Vitest would pick that up.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { detect, loadConfig } from "./detect.mjs";

const cfg = loadConfig(fs.readFileSync(new URL("./bands.yaml", import.meta.url), "utf8"));
const T0 = Date.parse("2026-10-15T00:00:00Z");
const ts = (i) => new Date(T0 + i * 60000).toISOString().replace(/\.\d+Z$/, "Z");
// A feed for one series: `base` for the first `at` minutes, then `level`, with a tiny repeating wobble.
function feed({ minutes, at = 1e9, level = 0.2, base = 0.03, n = 50, metric = "booking_conflict_rate", wobble = 0.002 }) {
  return Array.from({ length: minutes }, (_, i) => ({
    ts: ts(i), metric, route: "reschedule", clinic: "lakeside",
    value: (i >= at ? level : base) + (i % 4 === 0 ? wobble : i % 4 === 2 ? -wobble : 0), n,
  }));
}
const bands = (r) => r.events.filter((e) => e.event === "raised").map((e) => e.band);

test("a calm series raises nothing", () => {
  assert.deepEqual(detect(feed({ minutes: 200 }), cfg).events, []);
});

test("a sudden jump goes straight to the top band", () => {
  const r = detect(feed({ minutes: 100, at: 60, level: 0.06 }), cfg);
  assert.deepEqual(bands(r), ["propose"]);
});

test("a gradual climb passes through the bands in order", () => {
  const f = feed({ minutes: 140 }).map((p, i) => (i < 60 ? p : { ...p, value: p.value + Math.min(0.03, (i - 59) * 0.001) }));
  assert.deepEqual(bands(detect(f, cfg)), ["watch", "diagnose", "propose"]);
});

test("one wild point is not a breach (sustain)", () => {
  const f = feed({ minutes: 100 }); f[70].value = 0.5;
  assert.deepEqual(detect(f, cfg).events, []);
});

test("a rate over very few events is ignored (min_events)", () => {
  const f = feed({ minutes: 100, at: 60, level: 0.5, n: 5 });
  assert.deepEqual(detect(f, cfg).events, []);
});

test("nothing is judged before the baseline has warmed up", () => {
  const f = feed({ minutes: 20, at: 5, level: 0.5 });
  assert.deepEqual(detect(f, cfg).events, []);
});

test("an incident longer than the baseline window does not become the new normal", () => {
  const r = detect(feed({ minutes: 260, at: 60, level: 0.06 }), cfg);      // 200 minutes of incident, window is 60
  const s = r.state[0];
  assert.equal(cfg.bands[s.level].name, "propose");
  assert.ok(s.last.baseline_mean < 0.035, `baseline drifted to ${s.last.baseline_mean}`);
});

test("a band clears after clear_after quiet points, and not before", () => {
  const f = feed({ minutes: 150, at: 60, level: 0.06 }).map((p, i) => (i >= 100 ? { ...p, value: 0.03 } : p));
  const r = detect(f, cfg);
  const cleared = r.events.find((e) => e.event === "cleared");
  assert.ok(cleared, "expected a cleared event");
  assert.equal(cleared.ts, ts(100 + cfg.baseline.clear_after - 1));
});

test("same input, same output", () => {
  const f = feed({ minutes: 120, at: 60, level: 0.06 });
  assert.deepEqual(detect(f, cfg), detect([...f].reverse(), cfg));
});

test("bands.yaml is validated", () => {
  assert.throws(() => loadConfig("baseline: {window_points: 60, warmup_points: 30, freeze_at_sigma: 2, clear_after: 3}\nmetrics: {}\nbands:\n  - {name: a, sigma: 3, sustain: 3, action: log}\n  - {name: b, sigma: 2, sustain: 3, action: diagnose}\n"), /lowest to highest/);
  assert.throws(() => loadConfig("baseline: {window_points: 60, warmup_points: 30, freeze_at_sigma: 2, clear_after: 3}\nmetrics: {}\nbands:\n  - {name: a, sigma: 1, sustain: 3, action: reboot}\n"), /unknown action/);
});
