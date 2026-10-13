// Finding the patient to book for (R92, R80). Name search covers patients linked to the
// clinic only; an exact email returns the name and nothing else; 30 email lookups an hour.
// The term travels in the request body and never reaches the log.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as searchRoute } from "@/app/api/v1/clinic/patients/search/route";
import { db } from "@/lib/db";
import { NOW, captureLogs, freezeClock, minutesAfter, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createPatient, createStaff, createWorld } from "../../helpers/factories";
import { type ErrorJson, S0900, S0930, type World, book, otherClinic, send } from "./support";

interface Found {
  patients: { patientId: string; patientName: string }[];
}

let w: World;
const search = (body: unknown, userId = w.staffUser.id) => send<Found & ErrorJson>(searchRoute, "POST", userId, { body });

async function named(fullName: string, email?: string) {
  const created = await createPatient();
  await db.patientProfile.update({ where: { id: created.patient.id }, data: { fullName } });
  if (email) await db.user.update({ where: { id: created.user.id }, data: { email } });
  return created;
}

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  freezeClock(NOW);
});

afterEach(() => restoreClock());

describe("search by name (R92)", () => {
  it("covers only patients linked to the caller's clinic", async () => {
    const other = await otherClinic();
    const linked = await named("Robin Sampleton");
    const elsewhere = await named("Robin Sampleford");
    await named("Robin Sampleby");
    await book(w, S0900, { by: w.staffSession, patientId: linked.patient.id });
    await book(w, S0900, { by: other.staffSession, doctorId: other.doctor.id, patientId: elsewhere.patient.id });

    const result = await search({ name: "Robin" });
    expect(result.status).toBe(200);
    expect(result.json.patients).toEqual([{ patientId: linked.patient.id, patientName: "Robin Sampleton" }]);

    // The other clinic finds its own patient and not ours.
    const theirs = await search({ name: "Robin" }, other.staffUser.id);
    expect(theirs.json.patients).toEqual([{ patientId: elsewhere.patient.id, patientName: "Robin Sampleford" }]);
  });

  it("matches any part of the name, ignoring case, and returns the id and the name only", async () => {
    const linked = await named("Robin Sampleton");
    await book(w, S0900, { by: w.staffSession, patientId: linked.patient.id });

    for (const name of ["sampleT", "ROBIN", "bin Sam"]) {
      const result = await search({ name });
      expect(result.json.patients).toHaveLength(1);
      expect(Object.keys(result.json.patients[0]).sort()).toEqual(["patientId", "patientName"]);
    }
    expect((await search({ name: "Nobody" })).json.patients).toEqual([]);
    expect(JSON.stringify((await search({ name: "Robin" })).json)).not.toMatch(/555-0100|example\.test|1990/);
  });

  it("does not count against the email lookup limit", async () => {
    await search({ name: "Robin" });
    expect(await db.staffLookupLog.count()).toBe(0);
  });
});

describe("lookup by email (R92)", () => {
  it("an exact match returns the patient's name and nothing else, linked or not", async () => {
    const unlinked = await named("Jamie Placeholder", "jamie.placeholder@example.test");

    const result = await search({ email: "jamie.placeholder@example.test" });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ patients: [{ patientId: unlinked.patient.id, patientName: "Jamie Placeholder" }] });

    // The address is matched whole, whatever its capitals.
    expect((await search({ email: "Jamie.Placeholder@Example.test" })).json.patients).toHaveLength(1);
    expect((await search({ email: "placeholder@example.test" })).json.patients).toEqual([]);
    expect((await search({ email: "nobody@example.test" })).json.patients).toEqual([]);
  });

  it("finds patients only: a doctor's or staff member's address matches nothing", async () => {
    expect((await search({ email: w.doctorUser.email })).json.patients).toEqual([]);
    expect((await search({ email: w.staffUser.email })).json.patients).toEqual([]);
  });

  it("refuses part of an address, both terms together, or neither", async () => {
    for (const body of [{ email: "jamie" }, { email: "jamie@" }, { name: "Jamie", email: "jamie@example.test" }, {}, { name: "J" }, { phone: "555-0100" }]) {
      const result = await search(body);
      expect(result.status).toBe(422);
      expect(JSON.stringify(result.json.error.fields)).not.toMatch(/jamie|555/i);
    }
    expect(await db.staffLookupLog.count()).toBe(0);
  });

  it("the 31st lookup in an hour is RATE_LIMITED, found or not; the hour then passes", async () => {
    await named("Jamie Placeholder", "jamie.placeholder@example.test");
    for (let i = 0; i < 30; i += 1) {
      const result = await search({ email: i % 2 ? "jamie.placeholder@example.test" : `nobody-${i}@example.test` });
      expect(result.status).toBe(200);
    }
    const limited = await search({ email: "jamie.placeholder@example.test" });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe("RATE_LIMITED");
    expect(limited.json).not.toHaveProperty("patients");
    expect(await db.staffLookupLog.count({ where: { staffUserId: w.staffUser.id } })).toBe(30);

    // The limit is per staff member.
    const { user: colleague } = await createStaff(w.clinic.id);
    expect((await search({ email: "jamie.placeholder@example.test" }, colleague.id)).status).toBe(200);
    // Name search still works.
    expect((await search({ name: "Jamie" })).status).toBe(200);

    freezeClock(minutesAfter(NOW, 61));
    expect((await search({ email: "jamie.placeholder@example.test" })).status).toBe(200);
  });

  it("lookups sent together cannot pass the limit", async () => {
    await db.staffLookupLog.createMany({
      data: Array.from({ length: 28 }, () => ({ staffUserId: w.staffUser.id, clinicId: w.clinic.id, at: NOW })),
    });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => search({ email: `nobody-${i}@example.test` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    expect(await db.staffLookupLog.count()).toBe(30);
  });
});

describe("the search term (R79, R80)", () => {
  it("travels in the body, and neither it nor the result reaches the log", async () => {
    const linked = await named("Robin Sampleton", "robin.sampleton@example.test");
    await book(w, S0930, { by: w.staffSession, patientId: linked.patient.id });

    const { raw, lines } = await captureLogs(async () => {
      await search({ name: "Sampleton" });
      await search({ email: "robin.sampleton@example.test" });
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(raw).not.toMatch(/Sampleton|sampleton|Robin|example\.test/);

    // The route reads no query string: a term in the URL is ignored and the body is required.
    const inUrl = await send<ErrorJson>(searchRoute, "POST", w.staffUser.id, { query: "name=Sampleton" });
    expect(inUrl.status).toBe(422);
  });

  it("is for staff only", async () => {
    for (const userId of [w.doctorUser.id, w.patientUser.id]) {
      expect((await search({ name: "Robin" }, userId)).status).toBe(403);
    }
  });
});
