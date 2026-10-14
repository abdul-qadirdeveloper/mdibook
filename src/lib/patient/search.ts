// OWNER: Stream A. Finding a doctor (R11 to R16): the specialty list, doctor search, the
// doctor profile and a doctor's open slots. Nothing here reads patient data except the
// caller's own count of upcoming appointments at the doctor's clinic (R26).
//
// Slots are computed, never stored, so "next open slot" is worked out for every matching
// doctor before the first page can be ordered (plan, Risks 7).
import { type Slot, bookingHorizon } from "@/domain/slots";
import { DAY_MS, addDays, localDateOf, localToInstant } from "@/domain/time";
import { ACTIVE_STATUSES } from "@/domain/transitions";
import { type Prisma, db } from "@/lib/db";
import { AppError, validationError } from "@/lib/errors";
import { listOpenSlots, nextOpenSlots } from "@/lib/open-slots";
import { appointmentScope } from "@/lib/scope";
import type { Session } from "@/lib/session";

// ---------------------------------------------------------------------------------------------
// Specialties
// ---------------------------------------------------------------------------------------------

export interface SpecialtyView {
  id: string;
  name: string;
}

/** The fixed list for the search filter (R12). */
export async function listSpecialties(): Promise<SpecialtyView[]> {
  return db.specialty.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/** R13. Each period ends at a midnight in the clinic's own time zone. */
export const AVAILABILITY_PERIODS = ["any", "today", "next_7_days", "next_30_days"] as const;
export type AvailabilityPeriod = (typeof AVAILABILITY_PERIODS)[number];

const PERIOD_DAYS: Record<Exclude<AvailabilityPeriod, "any">, number> = {
  today: 1,
  next_7_days: 7,
  next_30_days: 30,
};

export const SEARCH_PAGE_SIZE = 20;
/** What a search cursor looks like: the last result's next open slot and doctor id. */
export const SEARCH_CURSOR_SHAPE = /^\d{1,15}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLOT_LOOKUPS_AT_ONCE = 8;

export interface DoctorSearchInput {
  /** Any part of the doctor's name, ignoring case (R12). */
  name?: string;
  /** A specialty id from the fixed list. */
  specialtyId?: string;
  /** Any part of the clinic's city or area, ignoring case. Never distance. */
  location?: string;
  availability: AvailabilityPeriod;
  cursor?: string;
}

/** Exactly the fields of R14. */
export interface DoctorSearchResult {
  doctorId: string;
  name: string;
  specialty: string;
  clinicName: string;
  area: string;
  city: string;
  /** The clinic's IANA time zone, to display nextOpenSlot in. */
  timeZone: string;
  /** A UTC instant. A doctor with no open slot in the period is not a result (R13). */
  nextOpenSlot: string;
}

export interface DoctorSearchPage {
  doctors: DoctorSearchResult[];
  /** Every doctor that matches, on all pages. */
  total: number;
  nextCursor: string | null;
}

/** The end of an availability period, counted in calendar days of the clinic's zone. */
function periodEnd(period: Exclude<AvailabilityPeriod, "any">, now: Date, timeZone: string): Date {
  const today = localDateOf(now, timeZone);
  return localToInstant(addDays(today, PERIOD_DAYS[period]), 0, timeZone);
}

async function firstOpenSlot(
  doctorId: string,
  timeZone: string,
  period: AvailabilityPeriod,
  now: Date,
): Promise<Date | null> {
  if (period === "any") {
    const next = await nextOpenSlots(db, doctorId, now, 1, now);
    return next?.slots[0]?.start ?? null;
  }
  const open = await listOpenSlots(db, doctorId, now, periodEnd(period, now, timeZone), now);
  return open?.slots[0]?.start ?? null;
}

type Ranked = DoctorSearchResult & { sortKey: number };

/** Earliest next open slot first; the id settles ties. */
function compareRanked(a: { sortKey: number; doctorId: string }, b: { sortKey: number; doctorId: string }): number {
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
  return a.doctorId < b.doctorId ? -1 : a.doctorId > b.doctorId ? 1 : 0;
}

function parseCursor(cursor: string): { sortKey: number; doctorId: string } {
  if (!SEARCH_CURSOR_SHAPE.test(cursor)) throw validationError({ field: "cursor", problem: "invalid" });
  const [key, doctorId] = cursor.split("_");
  return { sortKey: Number(key), doctorId };
}

/** Text typed by the user is matched as it is: "%" and "_" are not wildcards. */
function literal(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

function cursorOf(result: Ranked): string {
  return `${result.sortKey}_${result.doctorId}`;
}

/**
 * Doctors that match every filter given (R11, R12) and have at least one open slot in the
 * availability period (R13). "Any" is the whole booking horizon, so a doctor with no open slot
 * in the next 90 days is not listed. Ordered by next open slot, 20 per page (R14). Deactivated
 * doctors never appear (R96).
 */
export async function searchDoctors(input: DoctorSearchInput, now: Date): Promise<DoctorSearchPage> {
  const after = input.cursor ? parseCursor(input.cursor) : null;

  const where: Prisma.DoctorProfileWhereInput = { user: { active: true } };
  if (input.name) where.name = { contains: literal(input.name), mode: "insensitive" };
  if (input.specialtyId) where.specialtyId = input.specialtyId;
  if (input.location) {
    const location = literal(input.location);
    where.clinic = {
      OR: [
        { city: { contains: location, mode: "insensitive" } },
        { area: { contains: location, mode: "insensitive" } },
      ],
    };
  }

  const matches = await db.doctorProfile.findMany({
    where,
    select: {
      id: true,
      name: true,
      specialty: { select: { name: true } },
      clinic: { select: { name: true, area: true, city: true, timeZone: true } },
    },
  });

  const ranked: Ranked[] = [];
  for (let i = 0; i < matches.length; i += SLOT_LOOKUPS_AT_ONCE) {
    const batch = matches.slice(i, i + SLOT_LOOKUPS_AT_ONCE);
    const slots = await Promise.all(
      batch.map((doctor) => firstOpenSlot(doctor.id, doctor.clinic.timeZone, input.availability, now)),
    );
    batch.forEach((doctor, index) => {
      const slot = slots[index];
      if (slot === null) return;
      ranked.push({
        doctorId: doctor.id,
        name: doctor.name,
        specialty: doctor.specialty.name,
        clinicName: doctor.clinic.name,
        area: doctor.clinic.area,
        city: doctor.clinic.city,
        timeZone: doctor.clinic.timeZone,
        nextOpenSlot: slot.toISOString(),
        sortKey: slot.getTime(),
      });
    });
  }
  ranked.sort(compareRanked);

  const rest = after ? ranked.filter((result) => compareRanked(result, after) > 0) : ranked;
  const page = rest.slice(0, SEARCH_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    doctors: page.map((result) => ({
      doctorId: result.doctorId,
      name: result.name,
      specialty: result.specialty,
      clinicName: result.clinicName,
      area: result.area,
      city: result.city,
      timeZone: result.timeZone,
      nextOpenSlot: result.nextOpenSlot,
    })),
    total: ranked.length,
    nextCursor: rest.length > SEARCH_PAGE_SIZE && last ? cursorOf(last) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Doctor profile
// ---------------------------------------------------------------------------------------------

/** Exactly the fields of R15, apart from the open slots, which have their own route. */
export interface DoctorProfileView {
  id: string;
  name: string;
  specialty: string;
  description: string;
  slotLengthMinutes: number;
  clinicName: string;
  clinicAddress: string;
  timeZone: string;
}

/** What the review screen states before the patient confirms (R26). Patient callers only. */
export interface BookingTerms {
  cancellationWindowHours: number;
  maxUpcomingPerPatient: number;
  /** The caller's own upcoming appointments at this doctor's clinic. */
  upcomingCount: number;
}

export async function readDoctorProfile(
  session: Session,
  doctorId: string,
  now: Date,
): Promise<{ doctor: DoctorProfileView; booking: BookingTerms | null }> {
  const row = await db.doctorProfile.findFirst({
    // A deactivated doctor is not found (R96).
    where: { id: doctorId, user: { active: true } },
    select: {
      id: true,
      name: true,
      description: true,
      slotLengthMinutes: true,
      clinicId: true,
      specialty: { select: { name: true } },
      clinic: {
        select: {
          name: true,
          address: true,
          area: true,
          city: true,
          timeZone: true,
          cancellationWindowHours: true,
          maxUpcomingPerPatient: true,
        },
      },
    },
  });
  if (!row) throw new AppError("NOT_FOUND");

  let booking: BookingTerms | null = null;
  if (session.role === "patient" && session.patientId) {
    const upcomingCount = await db.appointment.count({
      where: {
        // The caller's own appointments only, narrowed by src/lib/scope.ts.
        ...appointmentScope(session),
        clinicId: row.clinicId,
        status: { in: [...ACTIVE_STATUSES] },
        startsAt: { gt: now },
      },
    });
    booking = {
      cancellationWindowHours: row.clinic.cancellationWindowHours,
      maxUpcomingPerPatient: row.clinic.maxUpcomingPerPatient,
      upcomingCount,
    };
  }

  return {
    doctor: {
      id: row.id,
      name: row.name,
      specialty: row.specialty.name,
      description: row.description,
      slotLengthMinutes: row.slotLengthMinutes,
      clinicName: row.clinic.name,
      clinicAddress: `${row.clinic.address}, ${row.clinic.area}, ${row.clinic.city}`,
      timeZone: row.clinic.timeZone,
    },
    booking,
  };
}

// ---------------------------------------------------------------------------------------------
// Open slots
// ---------------------------------------------------------------------------------------------

export const SLOTS_DEFAULT_DAYS = 14;
export const SLOTS_MAX_DAYS = 31;

export interface SlotView {
  startsAt: string;
  endsAt: string;
}

export interface DoctorSlots {
  /** The clinic's IANA time zone. Every slot is displayed in it (R70). */
  timeZone: string;
  /** The period covered, as UTC instants. Ask for the next one with `from` set to this `to`. */
  from: string;
  to: string;
  /** Open slots grouped by calendar date in the clinic's zone, earliest first (R15). */
  days: { date: string; slots: SlotView[] }[];
  /** False once the period reaches the booking horizon (R24): there are no later dates. */
  hasLater: boolean;
}

/**
 * A doctor's open slots that start in [from, to). Reading them holds nothing and books nothing
 * (R17). Defaults: from now, for 14 days. At most 31 days at a time.
 */
export async function listDoctorSlots(
  doctorId: string,
  range: { from?: Date; to?: Date },
  now: Date,
): Promise<DoctorSlots> {
  const from = range.from && range.from.getTime() > now.getTime() ? range.from : now;
  const to = range.to ?? new Date(from.getTime() + SLOTS_DEFAULT_DAYS * DAY_MS);
  if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > SLOTS_MAX_DAYS * DAY_MS) {
    throw validationError({ field: "to", problem: "invalid" });
  }

  const open = await listOpenSlots(db, doctorId, from, to, now);
  if (!open) throw new AppError("NOT_FOUND");

  const days: DoctorSlots["days"] = [];
  for (const slot of open.slots as Slot[]) {
    const date = localDateOf(slot.start, open.timeZone);
    let day = days[days.length - 1];
    if (!day || day.date !== date) {
      day = { date, slots: [] };
      days.push(day);
    }
    day.slots.push({ startsAt: slot.start.toISOString(), endsAt: slot.end.toISOString() });
  }

  return {
    timeZone: open.timeZone,
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    hasLater: to.getTime() <= bookingHorizon(now).getTime(),
  };
}
