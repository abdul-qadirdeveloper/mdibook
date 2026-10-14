"use client";

// Doctor profile and open slots (R15, R17, R70; mocks 05 to 08). Every time is shown in the
// clinic's time zone with its abbreviation. Choosing a time books nothing: it only opens the
// review screen.
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ClinicTime } from "@/components/ClinicTime";
import { ErrorMessage } from "@/components/ErrorMessage";
import { FourState } from "@/components/FourState";
import { type ApiError, api, readDevUserSnapshot, subscribeDevUser } from "@/lib/api-client";
import {
  type DoctorProfileResponse,
  type SlotTime,
  type SlotsResponse,
  clinicDateLabel,
  clinicZoneLabel,
  loadError,
  useApi,
} from "../../_shared";

const SEARCH = "/patient/doctors";

interface SlotPeriods {
  periods: SlotsResponse[];
  error: ApiError | null;
}

/**
 * Loads open slots from an instant onward, one period after another, until a period has slots
 * or the booking horizon is reached. So "no open slots" is only said when there are none.
 */
async function loadSlotsFrom(doctorId: string, from: string | null, signal?: AbortSignal): Promise<SlotPeriods> {
  const periods: SlotsResponse[] = [];
  let next = from;
  for (;;) {
    const path = `/doctors/${doctorId}/slots${next ? `?from=${encodeURIComponent(next)}` : ""}`;
    const result = await api<SlotsResponse>(path, { signal });
    if (!result.ok) return { periods, error: result.error };
    periods.push(result.data);
    if (result.data.days.length > 0 || !result.data.hasLater) return { periods, error: null };
    next = result.data.to;
  }
}

/** Days from several periods, with a date that spans two periods shown once. */
function mergeDays(periods: SlotsResponse[]): { date: string; slots: SlotTime[] }[] {
  const days: { date: string; slots: SlotTime[] }[] = [];
  for (const period of periods) {
    for (const day of period.days) {
      const last = days[days.length - 1];
      if (last && last.date === day.date) last.slots.push(...day.slots);
      else days.push({ date: day.date, slots: [...day.slots] });
    }
  }
  return days;
}

function OpenSlots({ doctorId, doctorName, timeZone }: { doctorId: string; doctorName: string; timeZone: string }) {
  const router = useRouter();
  const user = useSyncExternalStore(subscribeDevUser, readDevUserSnapshot, () => null);
  const [attempt, setAttempt] = useState(0);
  const key = `${user ?? ""}|${attempt}|${doctorId}`;
  const [loaded, setLoaded] = useState<({ key: string } & SlotPeriods) | null>(null);
  const [loadingLater, setLoadingLater] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadSlotsFrom(doctorId, null, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLoaded({ key, ...result });
    });
    return () => controller.abort();
  }, [key, doctorId]);

  const current = loaded !== null && loaded.key === key ? loaded : null;
  const days = current ? mergeDays(current.periods) : [];
  const lastPeriod = current?.periods[current.periods.length - 1];
  const failedAtStart = current !== null && current.error !== null && current.periods.length === 0;

  const showLater = async () => {
    if (!current || !lastPeriod) return;
    setLoadingLater(true);
    const later = await loadSlotsFrom(doctorId, lastPeriod.to);
    setLoadingLater(false);
    setLoaded({ key, periods: [...current.periods, ...later.periods], error: later.error });
  };

  const state = current === null ? "loading" : failedAtStart ? "error" : days.length === 0 ? "empty" : "success";

  return (
    <section className="card" aria-labelledby="open-slots">
      <h2 id="open-slots">Open slots</h2>
      <FourState
        state={state}
        loadingLabel="Loading open slots"
        onRetry={() => setAttempt((n) => n + 1)}
        error={
          current?.error
            ? loadError(
                current.error,
                "we could not load the open slots",
                "Something went wrong on our side, so the open times could not be shown. Try again. If it still does not work, wait a few minutes or call the clinic to book.",
              )
            : undefined
        }
        empty={
          <>
            <h3>No open slots right now</h3>
            <p>
              {doctorName} has no open appointment times at the moment. New times appear here as soon as the clinic
              adds them.
            </p>
            <p>You can check again later, or look for another doctor.</p>
            <div className="button-row">
              <button type="button" className="button" onClick={() => router.push(SEARCH)}>
                Find another doctor
              </button>
              <button type="button" className="button button--secondary" onClick={() => setAttempt((n) => n + 1)}>
                Check again
              </button>
            </div>
          </>
        }
      >
        <p>
          All times are in the clinic&apos;s time zone, <strong>{timeZone}</strong>, even if you are somewhere else.
        </p>
        <p className="muted">Choose a time to continue. Nothing is booked until you confirm on the next step.</p>
        {days.map((day) => (
          <div key={day.date}>
            <h3 className="slot-day">{clinicDateLabel(day.slots[0].startsAt, timeZone)}</h3>
            <ul className="slot-grid">
              {day.slots.map((slot) => (
                <li key={slot.startsAt}>
                  <Link
                    className="button button--secondary"
                    href={`${SEARCH}/${doctorId}/book?start=${encodeURIComponent(slot.startsAt)}`}
                  >
                    <ClinicTime instant={slot.startsAt} timeZone={timeZone} show="time" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {current?.error && !failedAtStart ? (
          <ErrorMessage
            title="later dates could not be loaded"
            message="The times above are still correct. Choose &quot;Show later dates&quot; to try again."
            requestId={current.error.requestId}
          />
        ) : null}
        {lastPeriod?.hasLater ? (
          <div className="button-row">
            <button type="button" className="button button--secondary" onClick={showLater} disabled={loadingLater}>
              {loadingLater ? "Loading later dates…" : "Show later dates"}
            </button>
          </div>
        ) : (
          <p className="muted">There are no later dates: appointments can be booked up to 90 days ahead.</p>
        )}
      </FourState>
    </section>
  );
}

export default function DoctorProfilePage() {
  const { doctorId } = useParams<{ doctorId: string }>();
  const profile = useApi<DoctorProfileResponse>(`/doctors/${doctorId}`);
  const doctor = profile.result?.ok ? profile.result.data.doctor : null;
  const state = profile.loading ? "loading" : doctor ? "success" : "error";

  return (
    <>
      <Link href={SEARCH} className="back-link">
        Back to search
      </Link>
      <FourState
        state={state}
        loadingLabel="Loading the doctor's profile"
        onRetry={profile.retry}
        // A profile is one record: it is found or it is not, so there is no empty state.
        empty={null}
        error={
          profile.result && !profile.result.ok
            ? loadError(
                profile.result.error,
                "we could not load this doctor",
                "Something went wrong on our side, so the profile could not be shown. Try again. If it still does not work, wait a few minutes or call the clinic to book.",
              )
            : undefined
        }
      >
        {doctor ? (
          <>
            <section className="card" aria-labelledby="doctor-name">
              <h1 id="doctor-name">{doctor.name}</h1>
              <p>{doctor.specialty}</p>
              <dl className="details">
                <div>
                  <dt>Clinic</dt>
                  <dd>{doctor.clinicName}</dd>
                </div>
                <div>
                  <dt>Address</dt>
                  <dd>{doctor.clinicAddress}</dd>
                </div>
                <div>
                  <dt>Clinic time zone</dt>
                  <dd>
                    {doctor.timeZone} ({clinicZoneLabel(new Date(profile.receivedAt ?? 0), doctor.timeZone)})
                  </dd>
                </div>
              </dl>
              <p>
                {doctor.description} Appointments are {doctor.slotLengthMinutes} minutes.
              </p>
            </section>
            <OpenSlots doctorId={doctor.id} doctorName={doctor.name} timeZone={doctor.timeZone} />
          </>
        ) : null}
      </FourState>
    </>
  );
}
