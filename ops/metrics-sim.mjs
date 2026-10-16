#!/usr/bin/env node
// Fake production metrics for MediBook. A stand-in for Prometheus, Datadog or your host's dashboard.
// Usage: node ops/metrics-sim.mjs [--minutes 240] [--seed 42] [--append]
//                                 [--inject hot-doctor --after 15 --duration 30] [--pace 0]
// Writes one JSON line per series per minute to ops/metrics/feed.jsonl, and sampled conflict
// log lines (ids only, no patient data) to ops/metrics/logs.jsonl.
// The values are a pure function of (seed, series, minute), so the same seed gives the same feed.
import fs from "node:fs";
import path from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const minutes = Number(arg("minutes", 240));
const seed = String(arg("seed", 42));
const append = arg("append", false) === true;
const inject = arg("inject", null);
const after = Number(arg("after", 0));
const duration = Number(arg("duration", 30));
const paceSeconds = Number(arg("pace", 0));
const dir = arg("dir", "ops/metrics");
const feedPath = path.join(dir, "feed.jsonl");
const logPath = path.join(dir, "logs.jsonl");
const KNOWN = ["hot-doctor"];
if (inject && !KNOWN.includes(inject)) { console.error(`unknown scenario '${inject}'. Known: ${KNOWN.join(", ")}`); process.exit(2); }

// Deterministic randomness: hash the key, then draw from a small PRNG.
function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(key) { let a = hash(`${seed}|${key}`); return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { const u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// The world: two clinics, two routes, two metrics. Baselines are made up.
const CLINICS = { north: ["doc_01", "doc_02", "doc_03", "doc_04"], lakeside: ["doc_05", "doc_06", "doc_07", "doc_08"] };
const ROUTES = { book: { n: 60, nSpread: 10 }, reschedule: { n: 25, nSpread: 6 } };
const BASE = {
  booking_conflict_rate: { sd: 0.004, mean: { "book/north": 0.020, "book/lakeside": 0.025, "reschedule/north": 0.030, "reschedule/lakeside": 0.030 } },
  api_5xx_rate: { sd: 0.001, mean: { "book/north": 0.002, "book/lakeside": 0.002, "reschedule/north": 0.002, "reschedule/lakeside": 0.002 } },
};

// Last minute already in the feed (for --append).
function lastTs() {
  if (!fs.existsSync(feedPath)) return null;
  const lines = fs.readFileSync(feedPath, "utf8").trimEnd().split("\n");
  return lines.length && lines[lines.length - 1] ? new Date(JSON.parse(lines[lines.length - 1]).ts) : null;
}
fs.mkdirSync(dir, { recursive: true });
let startMs;
const prev = append ? lastTs() : null;
if (prev) startMs = prev.getTime() + 60000;
else { const now = Math.floor(Date.now() / 60000) * 60000; startMs = arg("start", null) ? Date.parse(arg("start")) : now - (minutes - 1) * 60000; if (!append) { fs.writeFileSync(feedPath, ""); fs.writeFileSync(logPath, ""); } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let written = 0;
for (let i = 0; i < minutes; i++) {
  const t = startMs + i * 60000, ts = new Date(t).toISOString().replace(/\.\d+Z$/, "Z"), mIdx = Math.floor(t / 60000);
  // Scenario: from minute `after` for `duration` minutes, one doctor's newly opened slots attract a stampede.
  const k = i - after;
  const hot = inject === "hot-doctor" && k >= 0 && k < duration;
  const ramp = hot ? Math.min(1, (k + 1) / 30) : 0;         // the shift builds over 30 minutes
  const feedLines = [], logLines = [];
  for (const [route, rcfg] of Object.entries(ROUTES)) for (const clinic of Object.keys(CLINICS)) {
    const key = `${route}/${clinic}`, hotSeries = hot && key === "reschedule/lakeside";
    const rn = rng(`n|${key}|${mIdx}`);
    let n = Math.max(0, Math.round(rcfg.n + gauss(rn) * rcfg.nSpread));
    if (hotSeries) n = Math.round(n * (1 + 0.5 * ramp));
    for (const [metric, cfg] of Object.entries(BASE)) {
      const r = rng(`${metric}|${key}|${mIdx}`);
      let mean = cfg.mean[key];
      if (hotSeries && metric === "booking_conflict_rate") mean += 0.030 * ramp;
      const value = Math.min(1, Math.max(0, +(mean + gauss(r) * cfg.sd).toFixed(4)));
      feedLines.push(JSON.stringify({ ts, metric, route, clinic, value, n }));
      if (metric === "booking_conflict_rate") {
        const lr = rng(`log|${key}|${mIdx}`);
        const conflicts = Math.min(8, Math.round(value * n));
        for (let c = 0; c < conflicts; c++) {
          const hotLine = hotSeries && lr() < 0.85 * ramp;
          const docs = CLINICS[clinic];
          const doctorId = hotLine ? "doc_07" : docs[Math.floor(lr() * docs.length)];
          const sameSlotRetry = hotLine ? lr() < 0.6 : lr() < 0.05;
          const slot = new Date(t + (1 + Math.floor(lr() * 48)) * 30 * 60000).toISOString().replace(/\.\d+Z$/, "Z");
          logLines.push(JSON.stringify({ ts, level: "warn", route, clinic, doctorId, code: "SLOT_TAKEN", slotStart: slot, sameSlotRetry }));
        }
      }
    }
  }
  fs.appendFileSync(feedPath, feedLines.join("\n") + "\n");
  if (logLines.length) fs.appendFileSync(logPath, logLines.join("\n") + "\n");
  written++;
  if (paceSeconds > 0) await sleep(paceSeconds * 1000);
}
console.log(`wrote ${written} minutes (${written * 8} points) to ${feedPath}${inject ? ` with scenario '${inject}'` : ""}`);
