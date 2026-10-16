#!/usr/bin/env node
// Deterministic anomaly detector. Same feed and same bands.yaml in, same events out.
// Usage: node ops/detect.mjs [--feed ops/metrics/feed.jsonl] [--bands ops/bands.yaml]
//                            [--dir ops/metrics] [--follow] [--quiet]
// Writes ops/metrics/events.jsonl (one line each time a series enters or leaves a band) and,
// while a series is at "diagnose" or above, ops/metrics/breach.json (the evidence for the responder).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

export function loadConfig(text) {
  const cfg = YAML.parse(text);
  const b = cfg?.bands;
  if (!Array.isArray(b) || b.length === 0) throw new Error("bands.yaml: 'bands' must be a non-empty list");
  b.forEach((x, i) => {
    if (typeof x.sigma !== "number" || !Number.isInteger(x.sustain) || x.sustain < 1) throw new Error(`bands.yaml: band ${x.name}: sigma must be a number and sustain a whole number >= 1`);
    if (!["log", "diagnose", "propose"].includes(x.action)) throw new Error(`bands.yaml: band ${x.name}: unknown action '${x.action}'`);
    if (i > 0 && x.sigma <= b[i - 1].sigma) throw new Error("bands.yaml: bands must be listed from lowest to highest sigma");
  });
  for (const k of ["window_points", "warmup_points", "freeze_at_sigma", "clear_after"]) if (typeof cfg.baseline?.[k] !== "number") throw new Error(`bands.yaml: baseline.${k} is required`);
  if (!cfg.metrics || typeof cfg.metrics !== "object") throw new Error("bands.yaml: 'metrics' is required");
  return cfg;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
const seriesKey = (p) => `${p.metric}|route=${p.route}|clinic=${p.clinic}`;

// Pure function: points in (any order), events and final state out.
export function detect(points, cfg) {
  const { window_points: W, warmup_points: warm, freeze_at_sigma: freeze, clear_after: clearAfter } = cfg.baseline;
  const sorted = [...points].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : seriesKey(a) < seriesKey(b) ? -1 : 1));
  const state = new Map(); const events = [];
  for (const p of sorted) {
    const mc = cfg.metrics[p.metric]; if (!mc) continue;
    const key = seriesKey(p);
    if (!state.has(key)) state.set(key, { key, metric: p.metric, route: p.route, clinic: p.clinic, base: [], runs: cfg.bands.map(() => 0), misses: cfg.bands.map(() => 0), active: cfg.bands.map(() => false), level: -1, since: null, last: null, recent: [] });
    const s = state.get(key), t = Date.parse(p.ts);
    if (p.n < mc.min_events) continue;                        // too few events for a rate to mean anything
    if (s.base.length < warm) { s.base.push({ t, v: p.value }); continue; }
    const vals = s.base.map((x) => x.v), m = mean(vals), sigma = Math.max(sd(vals, m), mc.min_sigma);
    const z = (mc.direction === "below" ? m - p.value : p.value - m) / sigma;
    cfg.bands.forEach((b, i) => {
      if (z >= b.sigma) { s.runs[i]++; s.misses[i] = 0; } else { s.runs[i] = 0; s.misses[i]++; }
      if (!s.active[i] && s.runs[i] >= b.sustain) s.active[i] = true;          // sustained: the band is breached
      if (s.active[i] && s.misses[i] >= clearAfter) s.active[i] = false;        // quiet for a while: the band clears
    });
    let level = -1; cfg.bands.forEach((b, i) => { if (s.active[i]) level = i; });
    s.last = { ts: p.ts, value: p.value, n: p.n, z: +z.toFixed(2), baseline_mean: +m.toFixed(5), baseline_sigma: +sigma.toFixed(5) };
    s.recent.push({ ts: p.ts, value: p.value, n: p.n, z: +z.toFixed(2) }); if (s.recent.length > 20) s.recent.shift();
    if (level !== s.level) {
      const b = level >= 0 ? cfg.bands[level] : null;
      events.push({ ts: p.ts, series: key, metric: p.metric, route: p.route, clinic: p.clinic, event: level > s.level ? "raised" : level < 0 ? "cleared" : "lowered", band: b ? b.name : "normal", action: b ? b.action : "none", ...s.last });
      s.since = level >= 0 && s.level < 0 ? p.ts : level < 0 ? null : s.since;
      s.level = level;
    }
    // Do not let an anomaly become the new normal: while a band is active, or a point is far out, the baseline stands still.
    if (z < freeze && level < 0) { s.base.push({ t, v: p.value }); while (s.base.length > W) s.base.shift(); }
  }
  return { events, state: [...state.values()] };
}

// Facts from the conflict logs for one breached series, in the same spirit as an alert's context.
function logFacts(logs, route, clinic, sinceTs) {
  const rows = logs.filter((l) => l.route === route && l.clinic === clinic && l.code === "SLOT_TAKEN");
  const pick = (a) => ({ conflicts: a.length, same_slot_retry_share: a.length ? +(a.filter((l) => l.sameSlotRetry).length / a.length).toFixed(2) : null });
  const during = rows.filter((l) => l.ts >= sinceTs), before = rows.filter((l) => l.ts < sinceTs);
  const byDoc = {}; during.forEach((l) => { byDoc[l.doctorId] = (byDoc[l.doctorId] || 0) + 1; });
  const top = Object.entries(byDoc).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([doctorId, c]) => ({ doctorId, share: +(c / during.length).toFixed(2) }));
  return { since: sinceTs, during_breach: { ...pick(during), top_doctors: top }, before_breach: pick(before) };
}

function run({ feed, bandsPath, dir, quiet, printed }) {
  const cfg = loadConfig(fs.readFileSync(bandsPath, "utf8"));
  const points = fs.readFileSync(feed, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const { events, state } = detect(points, cfg);
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  for (const e of events) {
    const id = `${e.series}@${e.ts}@${e.event}`; if (printed.has(id)) continue; printed.add(id);
    if (!quiet) console.log(`${e.ts} ${(e.event === "cleared" ? "CLEARED" : e.event === "lowered" ? `LOWERED to ${e.band.toUpperCase()}` : e.band.toUpperCase()).padEnd(9)} ${e.metric} route=${e.route} clinic=${e.clinic} value=${e.value} baseline=${e.baseline_mean}±${e.baseline_sigma} z=${e.z} -> ${e.action}`);
  }
  const active = state.filter((s) => s.level >= 0 && cfg.bands[s.level].action !== "log");
  const breachPath = path.join(dir, "breach.json");
  if (active.length) {
    const top = Math.max(...active.map((s) => s.level)), first = active.map((s) => s.since).sort()[0];
    const logsPath = path.join(dir, "logs.jsonl");
    const logs = fs.existsSync(logsPath) ? fs.readFileSync(logsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const breach = {
      id: `INC-${first.replace(/[-:]/g, "").slice(0, 13).replace("T", "-")}`,
      detected_at: first, band: cfg.bands[top].name, action: cfg.bands[top].action, feed_end: points[points.length - 1]?.ts,
      series: active.map((s) => ({ metric: s.metric, route: s.route, clinic: s.clinic, band: cfg.bands[s.level].name, since: s.since, ...s.last, recent: s.recent.slice(-12), log_facts: logFacts(logs, s.route, s.clinic, s.since) })),
      other_series_state: state.filter((s) => !active.includes(s)).map((s) => ({ metric: s.metric, route: s.route, clinic: s.clinic, band: s.level >= 0 ? cfg.bands[s.level].name : "normal", z: s.last?.z ?? null })),
    };
    fs.writeFileSync(breachPath, JSON.stringify(breach, null, 2) + "\n");
  } else if (fs.existsSync(breachPath)) fs.rmSync(breachPath);
  return { active, cfg, state, points: points.length, events };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const a = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true); };
  const opts = { feed: a("feed", "ops/metrics/feed.jsonl"), bandsPath: a("bands", "ops/bands.yaml"), dir: a("dir", "ops/metrics"), quiet: a("quiet", false) === true, printed: new Set() };
  const follow = a("follow", false) === true;
  const summary = (r) => {
    const hi = r.active.length ? r.active.map((s) => `${s.route}/${s.clinic} ${r.cfg.bands[s.level].name}`).join(", ") : "none";
    console.log(`checked ${r.state.length} series, ${r.points} points. Active at diagnose or above: ${hi}`);
    if (r.active.length) console.log(`evidence written to ${path.join(opts.dir, "breach.json")}`);
  };
  try {
    const r = run(opts);
    if (!follow) summary(r);
    else { console.log("following; Ctrl+C to stop"); setInterval(() => { try { run(opts); } catch (e) { console.error(e.message); } }, 1000); }
  } catch (e) { console.error(`detect: ${e.message}`); process.exit(2); }
}
