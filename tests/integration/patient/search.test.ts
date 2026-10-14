// Finding a doctor (R2, R11 to R14, R16, R96): the specialty list and doctor search.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { NOW, at, captureLogs, freezeClock, restoreClock } from "../../helpers/clock";
import { resetDb } from "../../helpers/db";
import { createAdmin, createClinic, createDoctor, createPatient, createStaff } from "../../helpers/factories";
import { doctorProfile, search, slots, specialties } from "./api";

let patientUserId: string;

/** A doctor with a chosen name, at a clinic with a chosen area and city. All fictional. */
async function doctorAt(
  place: { area: string; city: string; timeZone?: string },
  name: string,
  options: Parameters<typeof createDoctor>[1] = {},
) {
  const clinic = await createClinic({ timeZone: place.timeZone });
  await db.clinic.update({ where: { id: clinic.id }, data: { area: place.area, city: place.city } });
  const { doctor, user } = await createDoctor(clinic.id, options);
  await db.doctorProfile.update({ where: { id: doctor.id }, data: { name } });
  return { clinic, doctor, user };
}

const names = (result: { json: { doctors: { name: string }[] } }) => result.json.doctors.map((d) => d.name);

beforeEach(async () => {
  await resetDb();
  patientUserId = (await createPatient()).user.id;
  freezeClock(NOW);
});

afterEach(() => {
  restoreClock();
});

describe("sign-in is required (R2, R16)", () => {
  it("specialties, search, profile and slots are 401 without a session", async () => {
    const { doctor } = await doctorAt({ area: "Northgate", city: "Larkfield" }, "Dr. Lena Hartwell");
    for (const result of [
      await specialties(undefined),
      await search(undefined),
      await search(undefined, { name: "Lena" }),
      await doctorProfile(undefined, doctor.id),
      await slots(undefined, doctor.id),
    ]) {
      expect(result.status).toBe(401);
      expect(result.json.error.code).toBe("UNAUTHENTICATED");
      expect(JSON.stringify(result.json)).not.toContain("Hartwell");
    }
  });

  it("any signed-in role can search", async () => {
    const { clinic, user: doctorUser } = await doctorAt({ area: "Northgate", city: "Larkfield" }, "Dr. Lena Hartwell");
    const staff = await createStaff(clinic.id);
    const admin = await createAdmin();
    for (const userId of [patientUserId, doctorUser.id, staff.user.id, admin.id]) {
      expect((await search(userId)).status).toBe(200);
      expect((await specialties(userId)).status).toBe(200);
    }
  });
});

describe("the specialty list (R12)", () => {
  it("is the fixed list, by name, with ids to filter by", async () => {
    await db.specialty.createMany({ data: [{ name: "Pediatrics" }, { name: "Cardiology" }, { name: "Dermatology" }] });
    const result = await specialties(patientUserId);
    expect(result.status).toBe(200);
    expect(result.json.specialties.map((s) => s.name)).toEqual(["Cardiology", "Dermatology", "Pediatrics"]);
    for (const s of result.json.specialties) expect(Object.keys(s).sort()).toEqual(["id", "name"]);
  });
});

describe("filters, alone and combined (R11, R12)", () => {
  let hartwell: Awaited<ReturnType<typeof doctorAt>>;
  let varga: Awaited<ReturnType<typeof doctorAt>>;
  let nandakumar: Awaited<ReturnType<typeof doctorAt>>;

  beforeEach(async () => {
    hartwell = await doctorAt({ area: "Northgate", city: "Larkfield" }, "Dr. Lena Hartwell");
    varga = await doctorAt({ area: "Old Town", city: "Larkfield" }, "Dr. Tomas Varga");
    nandakumar = await doctorAt({ area: "Northgate Hills", city: "Merrowby" }, "Dr. Priya Nandakumar");
  });

  it("no filter returns every active doctor", async () => {
    const result = await search(patientUserId);
    expect(names(result).sort()).toEqual(["Dr. Lena Hartwell", "Dr. Priya Nandakumar", "Dr. Tomas Varga"]);
    expect(result.json.total).toBe(3);
  });

  it("name matches any part of the doctor's name, ignoring case", async () => {
    expect(names(await search(patientUserId, { name: "hart" }))).toEqual(["Dr. Lena Hartwell"]);
    expect(names(await search(patientUserId, { name: "LENA" }))).toEqual(["Dr. Lena Hartwell"]);
    expect(names(await search(patientUserId, { name: "  varga " }))).toEqual(["Dr. Tomas Varga"]);
    expect(names(await search(patientUserId, { name: "a" })).sort()).toHaveLength(3);
    expect(names(await search(patientUserId, { name: "zzz" }))).toEqual([]);
    // A wildcard typed by the patient is ordinary text.
    expect(names(await search(patientUserId, { name: "%" }))).toEqual([]);
    expect(names(await search(patientUserId, { name: "L_na" }))).toEqual([]);
    expect(names(await search(patientUserId, { location: "%" }))).toEqual([]);
  });

  it("specialty is chosen from the fixed list", async () => {
    expect(names(await search(patientUserId, { specialty: varga.doctor.specialtyId }))).toEqual(["Dr. Tomas Varga"]);
    const unknown = await search(patientUserId, { specialty: "7f0c1f0e-3d0a-4b53-9d2e-0a1b2c3d4e5f" });
    expect(unknown.json.doctors).toEqual([]);
    const typed = await search(patientUserId, { specialty: "dermatology" });
    expect(typed.status).toBe(422);
    expect(typed.json.error.fields).toEqual([{ field: "specialty", problem: "invalid" }]);
  });

  it("location matches the clinic's city or area text, ignoring case", async () => {
    expect(names(await search(patientUserId, { location: "larkfield" })).sort()).toEqual([
      "Dr. Lena Hartwell",
      "Dr. Tomas Varga",
    ]);
    expect(names(await search(patientUserId, { location: "NORTHGATE" })).sort()).toEqual([
      "Dr. Lena Hartwell",
      "Dr. Priya Nandakumar",
    ]);
    expect(names(await search(patientUserId, { location: "old t" }))).toEqual(["Dr. Tomas Varga"]);
    expect(names(await search(patientUserId, { location: "nowhere" }))).toEqual([]);
  });

  it("combined filters must all match", async () => {
    expect(names(await search(patientUserId, { location: "northgate", name: "priya" }))).toEqual(["Dr. Priya Nandakumar"]);
    expect(names(await search(patientUserId, { location: "larkfield", name: "priya" }))).toEqual([]);
    expect(
      names(
        await search(patientUserId, {
          name: "lena",
          specialty: hartwell.doctor.specialtyId,
          location: "larkfield",
          availability: "next_7_days",
        }),
      ),
    ).toEqual(["Dr. Lena Hartwell"]);
    expect(
      names(await search(patientUserId, { name: "lena", specialty: nandakumar.doctor.specialtyId })),
    ).toEqual([]);
  });

  it("an empty filter is no filter, and an unknown filter is refused without repeating it", async () => {
    expect((await search(patientUserId, { name: "", specialty: "", location: "" })).json.total).toBe(3);
    const result = await search(patientUserId, { clinicId: hartwell.clinic.id });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.json)).not.toContain(hartwell.clinic.id);
  });

  it("a deactivated doctor never appears (R96)", async () => {
    await db.user.update({ where: { id: varga.user.id }, data: { active: false } });
    expect(names(await search(patientUserId)).sort()).toEqual(["Dr. Lena Hartwell", "Dr. Priya Nandakumar"]);
    expect(names(await search(patientUserId, { name: "varga" }))).toEqual([]);
  });

  it("query values are not written to the log (R79)", async () => {
    const { raw } = await captureLogs(() => search(patientUserId, { name: "Hartwell", location: "Larkfield" }));
    expect(raw).toContain("request.completed");
    expect(raw).not.toMatch(/Hartwell|Larkfield/i);
  });
});

describe("availability (R13)", () => {
  // NOW is Monday 12 October 2026, 07:00 in Chicago.
  const place = { area: "Northgate", city: "Larkfield" };
  const everyDay = (startMinute: number, endMinute: number) =>
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute, endMinute }));

  beforeEach(async () => {
    // Open today.
    await doctorAt(place, "Dr. Today");
    // Thursdays only: first open on Thursday 15 October.
    await doctorAt(place, "Dr. Thursday", { hours: [{ weekday: 4, startMinute: 540, endMinute: 1020 }] });
    // On leave until Thursday 22 October.
    const leave = await doctorAt(place, "Dr. On Leave");
    await db.timeOff.create({
      data: {
        doctorId: leave.doctor.id,
        clinicId: leave.clinic.id,
        startsAt: at("2026-10-01", "00:00"),
        endsAt: at("2026-10-22", "00:00"),
        reasonCode: "planned_leave",
        createdById: leave.user.id,
      },
    });
    // No working hours at all: never an open slot.
    await doctorAt(place, "Dr. No Hours", { hours: [] });
  });

  it("today, next 7 days and next 30 days each need at least one open slot in the period", async () => {
    expect(names(await search(patientUserId, { availability: "today" }))).toEqual(["Dr. Today"]);
    expect(names(await search(patientUserId, { availability: "next_7_days" }))).toEqual(["Dr. Today", "Dr. Thursday"]);
    expect(names(await search(patientUserId, { availability: "next_30_days" }))).toEqual([
      "Dr. Today",
      "Dr. Thursday",
      "Dr. On Leave",
    ]);
  });

  it("any time needs an open slot too, within the booking horizon; earliest next open slot first (R13, R14)", async () => {
    const result = await search(patientUserId, { availability: "any" });
    // Dr. No Hours has no open slot at all, so does not match (R13).
    expect(names(result)).toEqual(["Dr. Today", "Dr. Thursday", "Dr. On Leave"]);
    expect(result.json.total).toBe(3);
    expect(result.json.doctors.map((d) => d.nextOpenSlot)).toEqual([
      at("2026-10-12", "09:00").toISOString(),
      at("2026-10-15", "09:00").toISOString(),
      at("2026-10-22", "09:00").toISOString(),
    ]);
    // The default is any time.
    expect(names(await search(patientUserId))).toEqual(names(result));
  });

  it("a slot that is already booked does not count", async () => {
    const { doctor, clinic } = await doctorAt(place, "Dr. One Slot", {
      hours: [{ weekday: 1, startMinute: 540, endMinute: 570 }],
    });
    expect(names(await search(patientUserId, { availability: "today", name: "one slot" }))).toEqual(["Dr. One Slot"]);
    const holder = await createPatient();
    await db.appointment.create({
      data: {
        clinicId: clinic.id,
        doctorId: doctor.id,
        patientId: holder.patient.id,
        startsAt: at("2026-10-12", "09:00"),
        endsAt: at("2026-10-12", "09:30"),
        status: "requested",
        reasonForVisit: "Fictional",
        bookedById: holder.user.id,
        bookedByRole: "patient",
      },
    });
    expect(names(await search(patientUserId, { availability: "today", name: "one slot" }))).toEqual([]);
    const any = await search(patientUserId, { name: "one slot" });
    expect(any.json.doctors[0].nextOpenSlot).toBe(at("2026-10-19", "09:00").toISOString());
  });

  it("'today' is the clinic's own calendar day, not the server's or the patient's", async () => {
    // In Tokyo it is already Monday 21:00: the working day (09:00 to 17:00) is over.
    await doctorAt({ ...place, timeZone: "Asia/Tokyo" }, "Dr. Tokyo");
    // In Honolulu it is Monday 02:00: the whole working day is still ahead.
    await doctorAt({ ...place, timeZone: "Pacific/Honolulu" }, "Dr. Honolulu", { hours: everyDay(540, 1020) });
    const today = names(await search(patientUserId, { availability: "today" }));
    expect(today).toContain("Dr. Honolulu");
    expect(today).not.toContain("Dr. Tokyo");
    const tokyo = (await search(patientUserId, { name: "tokyo" })).json.doctors[0];
    expect(tokyo.timeZone).toBe("Asia/Tokyo");
    expect(tokyo.nextOpenSlot).toBe(at("2026-10-13", "09:00", "Asia/Tokyo").toISOString());
  });

  it("an unknown availability is refused, naming the field", async () => {
    const result = await search(patientUserId, { availability: "tomorrow" });
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([{ field: "availability", problem: "invalid" }]);
  });
});

describe("results (R14)", () => {
  it("each result has the listed fields and no others", async () => {
    await doctorAt({ area: "Northgate", city: "Larkfield" }, "Dr. Lena Hartwell");
    const result = await search(patientUserId);
    expect(Object.keys(result.json).sort()).toEqual(["doctors", "nextCursor", "total"]);
    expect(Object.keys(result.json.doctors[0]).sort()).toEqual(
      ["area", "city", "clinicName", "doctorId", "name", "nextOpenSlot", "specialty", "timeZone"].sort(),
    );
    expect(result.json.doctors[0]).toMatchObject({
      name: "Dr. Lena Hartwell",
      area: "Northgate",
      city: "Larkfield",
      timeZone: "America/Chicago",
      nextOpenSlot: at("2026-10-12", "09:00").toISOString(),
    });
    // No account details of the doctor.
    expect(JSON.stringify(result.json)).not.toMatch(/@example\.test|userId/);
  });

  it("20 per page, in order, with a cursor to the rest", async () => {
    const clinic = await createClinic();
    // 23 doctors whose first open slot is 09:00, 09:30, ... on Monday, in a shuffled order of
    // creation, so the order has to come from the slots.
    const order = [...Array(23).keys()].sort((a, b) => ((a * 7) % 23) - ((b * 7) % 23));
    for (const i of order) {
      const { doctor } = await createDoctor(clinic.id, {
        hours: [{ weekday: 2, startMinute: 540 + i * 30, endMinute: 540 + i * 30 + 30 }],
      });
      await db.doctorProfile.update({ where: { id: doctor.id }, data: { name: `Dr. Number ${String(i).padStart(2, "0")}` } });
    }

    const first = await search(patientUserId);
    expect(first.json.total).toBe(23);
    expect(first.json.doctors).toHaveLength(20);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const second = await search(patientUserId, { cursor: first.json.nextCursor! });
    expect(second.json.doctors).toHaveLength(3);
    expect(second.json.nextCursor).toBeNull();

    const all = [...names(first), ...names(second)];
    expect(all).toEqual([...Array(23).keys()].map((i) => `Dr. Number ${String(i).padStart(2, "0")}`));
    const times = [...first.json.doctors, ...second.json.doctors].map((d) => Date.parse(d.nextOpenSlot));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("a malformed cursor is refused", async () => {
    const result = await search(patientUserId, { cursor: "page-2" });
    expect(result.status).toBe(422);
    expect(result.json.error.fields).toEqual([{ field: "cursor", problem: "invalid" }]);
  });
});
