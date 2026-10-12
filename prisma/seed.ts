// Development seed: fictional clinics in different time zones, with doctors, staff, patients
// and specialties. It stands in for the admin, who is not built yet (plan, Risks 1).
// Run with `make seed` (node prisma/seed.ts). Every name, address, phone number and email here
// is invented. It refuses to run on a database that already has clinics.
import { existsSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const say = (line: string) => process.stdout.write(`${line}\n`);

const SPECIALTIES = [
  "Family medicine",
  "Pediatrics",
  "Dermatology",
  "Cardiology",
  "Orthopedics",
  "Gynecology",
  "Ear, nose and throat",
  "Psychiatry",
];

const CLINICS = [
  {
    name: "Lakeside Family Clinic",
    address: "120 Fictional Avenue",
    area: "Northgate",
    city: "Larkfield",
    timeZone: "America/Chicago",
    doctors: [
      { name: "Dr. Lena Hartwell", specialty: "Family medicine", slotLengthMinutes: 30 },
      { name: "Dr. Priya Nandakumar", specialty: "Pediatrics", slotLengthMinutes: 20 },
    ],
  },
  {
    name: "Harbor Street Clinic",
    address: "8 Sample Quay",
    area: "Old Town",
    city: "Merrowby",
    timeZone: "America/New_York",
    doctors: [
      { name: "Dr. Tomas Varga", specialty: "Dermatology", slotLengthMinutes: 15 },
      { name: "Dr. Amara Okafor", specialty: "Cardiology", slotLengthMinutes: 45 },
    ],
  },
  {
    // America/Phoenix does not observe daylight saving time.
    name: "Canyon View Clinic",
    address: "45 Placeholder Road",
    area: "Mesa Ridge",
    city: "Sunhollow",
    timeZone: "America/Phoenix",
    doctors: [{ name: "Dr. Elias Brandt", specialty: "Orthopedics", slotLengthMinutes: 30 }],
  },
];

const PATIENTS = [
  { fullName: "Jordan Avery", phone: "555-0101", dateOfBirth: "1988-03-14" },
  { fullName: "Sam Rivera", phone: "555-0102", dateOfBirth: "1975-11-02" },
  // No date of birth on file: the patient is asked for it (R28).
  { fullName: "Casey Lindqvist", phone: "555-0103", dateOfBirth: null },
];

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/^dr\. /, "")
    .replace(/[^a-z]+/g, ".");

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("The seed does not run in production.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");

  // Sessions run in UTC, as in src/lib/db.ts.
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: "-c TimeZone=UTC" }) });
  try {
    if ((await db.clinic.count()) > 0) {
      say("The database already has clinics. Nothing was changed.");
      return;
    }

    await db.$transaction(async (tx) => {
      const specialtyIds = new Map<string, string>();
      for (const name of SPECIALTIES) {
        specialtyIds.set(name, (await tx.specialty.create({ data: { name } })).id);
      }

      for (const c of CLINICS) {
        const clinic = await tx.clinic.create({
          data: { name: c.name, address: c.address, area: c.area, city: c.city, timeZone: c.timeZone },
        });
        for (const d of c.doctors) {
          const user = await tx.user.create({ data: { email: `${slug(d.name)}@example.test`, role: "doctor" } });
          const doctor = await tx.doctorProfile.create({
            data: {
              userId: user.id,
              clinicId: clinic.id,
              name: d.name,
              specialtyId: specialtyIds.get(d.specialty)!,
              description: `${d.specialty} at ${c.name}. A fictional profile for development.`,
              slotLengthMinutes: d.slotLengthMinutes,
            },
          });
          // Monday to Friday, 09:00 to 17:00 clinic time, with a break from 12:00 to 13:00.
          for (const weekday of [1, 2, 3, 4, 5]) {
            await tx.workingHours.create({
              data: { doctorId: doctor.id, clinicId: clinic.id, weekday, startMinute: 9 * 60, endMinute: 17 * 60 },
            });
            await tx.break.create({
              data: { doctorId: doctor.id, clinicId: clinic.id, weekday, startMinute: 12 * 60, endMinute: 13 * 60 },
            });
          }
        }
        const staffUser = await tx.user.create({
          data: { email: `frontdesk.${slug(c.name)}@example.test`, role: "staff" },
        });
        await tx.staffProfile.create({ data: { userId: staffUser.id, clinicId: clinic.id } });
      }

      for (const p of PATIENTS) {
        const user = await tx.user.create({ data: { email: `${slug(p.fullName)}@example.test`, role: "patient" } });
        await tx.patientProfile.create({
          data: {
            userId: user.id,
            fullName: p.fullName,
            phone: p.phone,
            dateOfBirth: p.dateOfBirth ? new Date(`${p.dateOfBirth}T00:00:00Z`) : null,
          },
        });
      }

      await tx.user.create({ data: { email: "admin@example.test", role: "admin" } });
    });

    const users = await db.user.findMany({ orderBy: [{ role: "asc" }, { createdAt: "asc" }] });
    say(`Seeded ${CLINICS.length} clinics, ${SPECIALTIES.length} specialties and ${users.length} users.`);
    say("Send one of these ids in the x-dev-user-id header, or choose a user on the home page:");
    for (const user of users) say(`  ${user.role.padEnd(8)} ${user.id}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
