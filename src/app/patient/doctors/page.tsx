"use client";

// Find a doctor (R11 to R14, R16; mocks 01 to 04). Filters are kept in the address, so the
// browser's back button returns to the same results. They are a doctor's name, a specialty, a
// place and a period: never anything about the patient (R80).
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { ClinicTime } from "@/components/ClinicTime";
import { FourState } from "@/components/FourState";
import { LabelledField } from "@/components/LabelledField";
import { api } from "@/lib/api-client";
import { type DoctorSummary, type SearchResponse, loadError, useApi } from "../_shared";

const AVAILABILITY = [
  ["any", "Any day"],
  ["today", "Today"],
  ["next_7_days", "Next 7 days"],
  ["next_30_days", "Next 30 days"],
] as const;

interface Filters {
  name: string;
  specialty: string;
  location: string;
  availability: string;
}

const HOME = "/patient/doctors";

function toQuery(filters: Filters): string {
  const query = new URLSearchParams();
  if (filters.name.trim()) query.set("name", filters.name.trim());
  if (filters.specialty) query.set("specialty", filters.specialty);
  if (filters.location.trim()) query.set("location", filters.location.trim());
  if (filters.availability !== "any") query.set("availability", filters.availability);
  return query.toString();
}

function FilterForm({
  initial,
  specialties,
  onSearch,
  onClear,
}: {
  initial: Filters;
  specialties: { id: string; name: string }[];
  onSearch: (filters: Filters) => void;
  onClear: () => void;
}) {
  const [filters, setFilters] = useState(initial);
  const set = (key: keyof Filters) => (event: { target: { value: string } }) =>
    setFilters((current) => ({ ...current, [key]: event.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(filters);
  };

  return (
    <form className="card" onSubmit={submit} role="search" aria-label="Find a doctor">
      <div className="filters">
        <LabelledField label="Doctor name">
          {(control) => <input {...control} type="text" maxLength={100} value={filters.name} onChange={set("name")} />}
        </LabelledField>
        <LabelledField label="Specialty">
          {(control) => (
            <select {...control} value={filters.specialty} onChange={set("specialty")}>
              <option value="">Any specialty</option>
              {specialties.map((specialty) => (
                <option key={specialty.id} value={specialty.id}>
                  {specialty.name}
                </option>
              ))}
            </select>
          )}
        </LabelledField>
        <LabelledField label="Location (city or area)">
          {(control) => (
            <input {...control} type="text" maxLength={100} value={filters.location} onChange={set("location")} />
          )}
        </LabelledField>
        <LabelledField label="Availability">
          {(control) => (
            <select {...control} value={filters.availability} onChange={set("availability")}>
              {AVAILABILITY.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </LabelledField>
      </div>
      <div className="button-row">
        <button type="submit" className="button">
          Search
        </button>
        <button type="button" className="button button--secondary" onClick={onClear}>
          Clear filters
        </button>
      </div>
    </form>
  );
}

function ResultCard({ doctor }: { doctor: DoctorSummary }) {
  const href = `${HOME}/${doctor.doctorId}`;
  return (
    <li className="card result-card">
      <div>
        <h3>
          <Link href={href}>{doctor.name}</Link>
        </h3>
        <p>{doctor.specialty}</p>
        <p className="muted">
          {doctor.clinicName}, {doctor.area}, {doctor.city}
        </p>
      </div>
      <div className="result-card__slot">
        <span className="muted">Next open slot</span>
        <strong>
          <ClinicTime instant={doctor.nextOpenSlot} timeZone={doctor.timeZone} />
        </strong>
        <Link href={href} className="button" aria-label={`View profile and slots for ${doctor.name}`}>
          View profile and slots
        </Link>
      </div>
    </li>
  );
}

function FindDoctor() {
  const router = useRouter();
  const params = useSearchParams();
  const filters: Filters = {
    name: params.get("name") ?? "",
    specialty: params.get("specialty") ?? "",
    location: params.get("location") ?? "",
    availability: params.get("availability") ?? "any",
  };
  const query = toQuery(filters);

  const specialties = useApi<{ specialties: { id: string; name: string }[] }>("/specialties");
  const search = useApi<SearchResponse>(`/doctors${query ? `?${query}` : ""}`);

  // Further pages of the same search, loaded with "Show more doctors".
  const [more, setMore] = useState<{ query: string; doctors: DoctorSummary[]; nextCursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const extra = more !== null && more.query === query ? more : null;

  const first = search.result?.ok ? search.result.data : null;
  const doctors = first ? [...first.doctors] : [];
  for (const doctor of extra?.doctors ?? []) {
    if (!doctors.some((shown) => shown.doctorId === doctor.doctorId)) doctors.push(doctor);
  }
  const nextCursor = extra ? extra.nextCursor : (first?.nextCursor ?? null);

  const showMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await api<SearchResponse>(`/doctors?${query ? `${query}&` : ""}cursor=${encodeURIComponent(nextCursor)}`);
    setLoadingMore(false);
    if (!result.ok) {
      setMoreFailed(true);
      return;
    }
    setMore({ query, doctors: [...(extra?.doctors ?? []), ...result.data.doctors], nextCursor: result.data.nextCursor });
  };

  const state = search.loading
    ? "loading"
    : !search.result?.ok
      ? "error"
      : doctors.length === 0
        ? "empty"
        : "success";
  const specialtyList = specialties.result?.ok ? specialties.result.data.specialties : [];

  return (
    <>
      <h1>Find a doctor</h1>
      <p className="muted">Search by name, specialty, location or availability. Use any one filter or combine them.</p>

      {/* Keyed by the address, so "Clear filters" and the back button reset what is typed. */}
      <FilterForm
        key={query}
        initial={filters}
        specialties={specialtyList}
        onSearch={(next) => {
          const nextQuery = toQuery(next);
          if (nextQuery === query) search.retry();
          else router.push(nextQuery ? `${HOME}?${nextQuery}` : HOME);
        }}
        onClear={() => router.push(HOME)}
      />

      <h2 className="section-title">Results</h2>
      <FourState
        state={state}
        loadingLabel="Searching for doctors"
        onRetry={search.retry}
        error={
          search.result && !search.result.ok
            ? loadError(
                search.result.error,
                "we could not load doctors",
                "Something went wrong on our side, so the search did not finish. Your filters are still filled in. Try again. If it still does not work, wait a few minutes or call the clinic to book.",
              )
            : undefined
        }
        empty={
          <>
            <h3>No doctors match these filters</h3>
            <p>Nothing was found for the name, specialty, location and availability you chose.</p>
            <ul>
              <li>Check the spelling of the doctor&apos;s name.</li>
              <li>Try a nearby city or area.</li>
              <li>Change availability to &quot;Any day&quot;.</li>
            </ul>
            <button type="button" className="button" onClick={() => router.push(HOME)}>
              Clear filters and show all doctors
            </button>
          </>
        }
      >
        <p role="status">
          {first?.total === 1 ? "1 doctor matches" : `${first?.total ?? 0} doctors match`}. Times are shown in each
          clinic&apos;s time zone.
        </p>
        <ul className="card-list">
          {doctors.map((doctor) => (
            <ResultCard key={doctor.doctorId} doctor={doctor} />
          ))}
        </ul>
        {nextCursor ? (
          <div className="button-row">
            <button type="button" className="button button--secondary" onClick={showMore} disabled={loadingMore}>
              {loadingMore ? "Loading more doctors…" : "Show more doctors"}
            </button>
          </div>
        ) : null}
        {moreFailed ? (
          <p role="alert">Error: more doctors could not be loaded. Choose &quot;Show more doctors&quot; to try again.</p>
        ) : null}
      </FourState>
    </>
  );
}

export default function FindDoctorPage() {
  return (
    <Suspense
      fallback={
        <p className="state state--loading" role="status">
          Loading the search…
        </p>
      }
    >
      <FindDoctor />
    </Suspense>
  );
}
