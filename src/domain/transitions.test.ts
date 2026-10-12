import { describe, expect, it } from "vitest";
import {
  type FromStatus,
  ROLES,
  type Role,
  STATUSES,
  type Status,
  checkTransition,
  isActive,
  statusAfterReschedule,
} from "./transitions";

const START = new Date("2026-10-14T14:00:00Z");
const BEFORE = new Date("2026-10-14T13:59:59Z");
const AFTER = new Date("2026-10-14T14:00:01Z");

type Timing = "before" | "after";
const FROMS: FromStatus[] = ["none", ...STATUSES];

// The whole table of R64, written out independently of the implementation. Every combination
// of from, to, role, reschedule flag and timing that is not listed here must be refused.
// Booking rows ("none") have no timing condition of their own: the slot rules cover it.
interface Allowed {
  from: FromStatus;
  to: Status;
  role: Role;
  viaReschedule: boolean;
  timing: Timing[];
}

const ALLOWED: Allowed[] = [
  { from: "none", to: "requested", role: "patient", viaReschedule: false, timing: ["before", "after"] },
  { from: "none", to: "confirmed", role: "staff", viaReschedule: false, timing: ["before", "after"] },

  { from: "requested", to: "confirmed", role: "staff", viaReschedule: false, timing: ["before"] },
  { from: "requested", to: "confirmed", role: "doctor", viaReschedule: false, timing: ["before"] },

  { from: "requested", to: "cancelled", role: "patient", viaReschedule: false, timing: ["before"] },
  { from: "requested", to: "cancelled", role: "staff", viaReschedule: false, timing: ["before"] },
  { from: "requested", to: "cancelled", role: "doctor", viaReschedule: false, timing: ["before"] },
  { from: "confirmed", to: "cancelled", role: "patient", viaReschedule: false, timing: ["before"] },
  { from: "confirmed", to: "cancelled", role: "staff", viaReschedule: false, timing: ["before"] },
  { from: "confirmed", to: "cancelled", role: "doctor", viaReschedule: false, timing: ["before"] },

  { from: "confirmed", to: "requested", role: "patient", viaReschedule: true, timing: ["before"] },

  { from: "requested", to: "completed", role: "staff", viaReschedule: false, timing: ["after"] },
  { from: "requested", to: "completed", role: "doctor", viaReschedule: false, timing: ["after"] },
  { from: "confirmed", to: "completed", role: "staff", viaReschedule: false, timing: ["after"] },
  { from: "confirmed", to: "completed", role: "doctor", viaReschedule: false, timing: ["after"] },

  { from: "requested", to: "no_show", role: "staff", viaReschedule: false, timing: ["after"] },
  { from: "requested", to: "no_show", role: "doctor", viaReschedule: false, timing: ["after"] },
  { from: "confirmed", to: "no_show", role: "staff", viaReschedule: false, timing: ["after"] },
  { from: "confirmed", to: "no_show", role: "doctor", viaReschedule: false, timing: ["after"] },
];

function find(from: FromStatus, to: Status, role: Role, viaReschedule: boolean): Allowed | undefined {
  return ALLOWED.find(
    (a) => a.from === from && a.to === to && a.role === role && a.viaReschedule === viaReschedule,
  );
}

interface Case {
  from: FromStatus;
  to: Status;
  role: Role;
  viaReschedule: boolean;
  timing: Timing;
}

const ALL: Case[] = [];
for (const from of FROMS)
  for (const to of STATUSES)
    for (const role of ROLES)
      for (const viaReschedule of [false, true])
        for (const timing of ["before", "after"] as const) ALL.push({ from, to, role, viaReschedule, timing });

const label = (c: Case) =>
  `${c.from} -> ${c.to} by ${c.role}${c.viaReschedule ? " (reschedule)" : ""}, ${c.timing} the start`;
const run = (c: Case) =>
  checkTransition({
    from: c.from,
    to: c.to,
    role: c.role,
    viaReschedule: c.viaReschedule,
    start: START,
    now: c.timing === "before" ? BEFORE : AFTER,
  });

const allowedCases = ALL.filter((c) => find(c.from, c.to, c.role, c.viaReschedule)?.timing.includes(c.timing));
const forbiddenCases = ALL.filter((c) => !find(c.from, c.to, c.role, c.viaReschedule)?.timing.includes(c.timing));

describe("status transitions (R64)", () => {
  it("covers every combination", () => {
    // 6 from states x 5 to states x 4 roles x reschedule or not x before or after the start.
    expect(ALL).toHaveLength(6 * 5 * 4 * 2 * 2);
    expect(allowedCases.length + forbiddenCases.length).toBe(ALL.length);
    expect(allowedCases).toHaveLength(21);
    expect(forbiddenCases).toHaveLength(459);
  });

  describe("every allowed change", () => {
    it.each(allowedCases.map((c) => [label(c), c] as const))("%s", (_label, c) => {
      expect(run(c)).toEqual({ ok: true });
    });
  });

  describe("every forbidden change", () => {
    it.each(forbiddenCases.map((c) => [label(c), c] as const))("%s", (_label, c) => {
      const result = run(c);
      expect(result.ok).toBe(false);
      // A listed outcome recorded too soon is TOO_EARLY (R63); anything else is not in the table.
      const tooEarly =
        c.timing === "before" && find(c.from, c.to, c.role, c.viaReschedule)?.timing.includes("after");
      expect(result).toEqual({ ok: false, code: tooEarly ? "TOO_EARLY" : "INVALID_TRANSITION" });
    });
  });
});

describe("timing conditions", () => {
  it("refuses completed and no-show before the start with TOO_EARLY (R63)", () => {
    for (const to of ["completed", "no_show"] as const)
      for (const from of ["requested", "confirmed"] as const)
        for (const role of ["staff", "doctor"] as const) {
          expect(checkTransition({ from, to, role, start: START, now: BEFORE })).toEqual({
            ok: false,
            code: "TOO_EARLY",
          });
        }
  });

  it("treats the start instant itself as started", () => {
    expect(checkTransition({ from: "confirmed", to: "completed", role: "staff", start: START, now: START })).toEqual({
      ok: true,
    });
    expect(checkTransition({ from: "confirmed", to: "cancelled", role: "staff", start: START, now: START })).toEqual({
      ok: false,
      code: "INVALID_TRANSITION",
    });
    expect(checkTransition({ from: "requested", to: "confirmed", role: "doctor", start: START, now: START })).toEqual({
      ok: false,
      code: "INVALID_TRANSITION",
    });
  });
});

describe("final statuses (F18)", () => {
  it("cancelled, completed and no_show lead nowhere, for any role at any time", () => {
    for (const from of ["cancelled", "completed", "no_show"] as const)
      for (const to of STATUSES)
        for (const role of ROLES)
          for (const viaReschedule of [false, true])
            for (const now of [BEFORE, AFTER]) {
              expect(checkTransition({ from, to, role, viaReschedule, start: START, now })).toEqual({
                ok: false,
                code: "INVALID_TRANSITION",
              });
            }
  });
});

describe("roles", () => {
  it("an admin can make no status change at all (R94)", () => {
    for (const c of ALL.filter((x) => x.role === "admin")) expect(run(c).ok).toBe(false);
  });

  it("a patient cannot confirm, complete or mark a no-show", () => {
    for (const to of ["confirmed", "completed", "no_show"] as const)
      for (const from of FROMS)
        for (const now of [BEFORE, AFTER]) {
          expect(checkTransition({ from, to, role: "patient", start: START, now }).ok).toBe(false);
        }
  });

  it("a doctor cannot create an appointment", () => {
    for (const to of STATUSES) {
      expect(checkTransition({ from: "none", to, role: "doctor", start: START, now: BEFORE }).ok).toBe(false);
    }
  });

  it("a patient's booking starts requested and a staff booking starts confirmed (R21, R29)", () => {
    expect(checkTransition({ from: "none", to: "requested", role: "patient", start: START, now: BEFORE }).ok).toBe(true);
    expect(checkTransition({ from: "none", to: "confirmed", role: "patient", start: START, now: BEFORE }).ok).toBe(false);
    expect(checkTransition({ from: "none", to: "confirmed", role: "staff", start: START, now: BEFORE }).ok).toBe(true);
    expect(checkTransition({ from: "none", to: "requested", role: "staff", start: START, now: BEFORE }).ok).toBe(false);
  });
});

describe("reschedule (R36)", () => {
  it("confirmed returns to requested only through a patient reschedule", () => {
    const base = { from: "confirmed", to: "requested", start: START, now: BEFORE } as const;
    expect(checkTransition({ ...base, role: "patient", viaReschedule: true })).toEqual({ ok: true });
    expect(checkTransition({ ...base, role: "patient", viaReschedule: false }).ok).toBe(false);
    expect(checkTransition({ ...base, role: "patient" }).ok).toBe(false);
    expect(checkTransition({ ...base, role: "staff", viaReschedule: true }).ok).toBe(false);
    expect(checkTransition({ ...base, role: "doctor", viaReschedule: true }).ok).toBe(false);
  });

  it("a reschedule cannot smuggle in any other status change", () => {
    const others = ALL.filter((c) => c.viaReschedule && !(c.from === "confirmed" && c.to === "requested" && c.role === "patient"));
    for (const c of others) expect(run(c).ok).toBe(false);
  });

  it("gives the status after a move", () => {
    expect(statusAfterReschedule("confirmed", "patient")).toBe("requested");
    expect(statusAfterReschedule("requested", "patient")).toBe("requested");
    expect(statusAfterReschedule("confirmed", "staff")).toBe("confirmed");
    expect(statusAfterReschedule("requested", "staff")).toBe("requested");
    expect(statusAfterReschedule("confirmed", "doctor")).toBe("confirmed");
    expect(statusAfterReschedule("requested", "doctor")).toBe("requested");
  });
});

describe("active statuses", () => {
  it("requested and confirmed hold a slot; the rest do not", () => {
    expect(STATUSES.filter(isActive)).toEqual(["requested", "confirmed"]);
  });
});
