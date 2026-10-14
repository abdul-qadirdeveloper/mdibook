"use client";

// My appointments (R44 to R47; mocks 12 to 15): the patient's own upcoming and past
// appointments across all clinics, each in its clinic's time zone.
//
// The Reschedule and Cancel buttons are shown but do nothing yet. Their screens (reschedule,
// and the cancel confirmation that must state the consequence first, R43) have no approved
// mock, and a screen without one is not built (R91). The API behind both is ready.
import Link from "next/link";
import { useId, useState } from "react";
import { ClinicTime } from "@/components/ClinicTime";
import { FourState } from "@/components/FourState";
import { api } from "@/lib/api-client";
import { type AppointmentsResponse, type PatientAppointment, loadError, useApi } from "../_shared";

const SEARCH = "/patient/doctors";

/** Patient-facing status labels (R47). */
function statusLabel(appointment: PatientAppointment): string {
  switch (appointment.status) {
    case "requested":
      return "Requested";
    case "confirmed":
      return "Confirmed";
    case "completed":
      return "Attended";
    case "no_show":
      return "Missed";
    case "cancelled":
      return appointment.cancelledBy === "patient" ? "Cancelled by you" : "Cancelled by the clinic";
  }
}

function UpcomingCard({ appointment, now }: { appointment: PatientAppointment; now: number }) {
  const noteId = useId();
  const windowOpen = now >= Date.parse(appointment.cancellationDeadline);
  return (
    <li className="card appointment-card">
      <div>
        <h3>
          <ClinicTime instant={appointment.startsAt} timeZone={appointment.timeZone} />
        </h3>
        <p>
          {appointment.doctorName}, {appointment.specialty}
        </p>
        <p className="muted">
          {appointment.clinicName}, {appointment.clinicAddress}
        </p>
        <p className="muted">
          {windowOpen ? (
            <>
              The time to reschedule, or to cancel without a late mark, ended on{" "}
              <ClinicTime instant={appointment.cancellationDeadline} timeZone={appointment.timeZone} />. A
              cancellation from now on is recorded as a late cancellation.
            </>
          ) : (
            <>
              You can reschedule, or cancel without a late mark, until{" "}
              <ClinicTime instant={appointment.cancellationDeadline} timeZone={appointment.timeZone} />.
            </>
          )}
        </p>
      </div>
      <div className="appointment-card__side">
        <span className="status-badge">Status: {statusLabel(appointment)}</span>
        <div className="button-row">
          <button type="button" className="button button--secondary" disabled aria-describedby={noteId}>
            Reschedule
          </button>
          <button type="button" className="button button--danger" disabled aria-describedby={noteId}>
            Cancel appointment
          </button>
        </div>
        <p className="muted" id={noteId}>
          Not available on this page yet. To reschedule or cancel, call the clinic.
        </p>
      </div>
    </li>
  );
}

function PastCard({ appointment }: { appointment: PatientAppointment }) {
  return (
    <li className="card appointment-card">
      <div>
        <h3>
          <ClinicTime instant={appointment.startsAt} timeZone={appointment.timeZone} />
        </h3>
        <p>
          {appointment.doctorName}, {appointment.specialty}
        </p>
        <p className="muted">
          {appointment.clinicName}, {appointment.clinicAddress}
        </p>
      </div>
      <span className="status-badge">Status: {statusLabel(appointment)}</span>
    </li>
  );
}

export default function MyAppointmentsPage() {
  const upcoming = useApi<AppointmentsResponse>("/me/appointments?scope=upcoming");
  const past = useApi<AppointmentsResponse>("/me/appointments?scope=past");

  // Older pages of past appointments, loaded with "Show older appointments".
  const [older, setOlder] = useState<{ at: number | null; items: PatientAppointment[]; nextCursor: string | null } | null>(
    null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);

  const failed = [upcoming.result, past.result].find((result) => result && !result.ok);
  const upcomingData = upcoming.result?.ok ? upcoming.result.data : null;
  const pastData = past.result?.ok ? past.result.data : null;
  const extra = older !== null && older.at === past.receivedAt ? older : null;
  const upcomingItems = upcomingData?.items.map((item) => item.appointment) ?? [];
  const pastItems = [...(pastData?.items.map((item) => item.appointment) ?? []), ...(extra?.items ?? [])];
  const nextCursor = extra ? extra.nextCursor : (pastData?.nextCursor ?? null);

  const state =
    upcoming.loading || past.loading
      ? "loading"
      : failed
        ? "error"
        : upcomingItems.length === 0 && pastItems.length === 0
          ? "empty"
          : "success";

  const showOlder = async () => {
    if (!nextCursor) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    const result = await api<AppointmentsResponse>(`/me/appointments?scope=past&cursor=${nextCursor}`);
    setLoadingOlder(false);
    if (!result.ok) {
      setOlderFailed(true);
      return;
    }
    setOlder({
      at: past.receivedAt,
      items: [...(extra?.items ?? []), ...result.data.items.map((item) => item.appointment)],
      nextCursor: result.data.nextCursor,
    });
  };

  // The empty state is already drawn as a card by FourState, so there these are not cards.
  const noUpcoming = (card: boolean) => (
    <div className={card ? "card" : undefined}>
      <h3>You have no upcoming appointments</h3>
      <p>When you book an appointment, it will appear here with its date, time and clinic.</p>
      <Link href={SEARCH} className="button">
        Find a doctor
      </Link>
    </div>
  );
  const noPast = (card: boolean) => (
    <div className={card ? "card" : undefined}>
      <p>You have no past appointments. Visits you have attended or cancelled will be listed here.</p>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My appointments</h1>
          <p className="muted">Times are shown in each clinic&apos;s time zone.</p>
        </div>
        {state === "success" ? (
          <Link href={SEARCH} className="button">
            Book a new appointment
          </Link>
        ) : null}
      </div>

      <FourState
        state={state}
        loadingLabel="Loading your appointments"
        onRetry={() => {
          upcoming.retry();
          past.retry();
        }}
        error={
          failed && !failed.ok
            ? loadError(
                failed.error,
                "we could not load your appointments",
                "Something went wrong on our side. Your appointments have not changed. Try again. If it still does not work, wait a few minutes or call the clinic.",
              )
            : undefined
        }
        empty={
          <>
            <h2>Upcoming (0)</h2>
            {noUpcoming(false)}
            <h2 className="section-title">Past (0)</h2>
            {noPast(false)}
          </>
        }
      >
        <h2>Upcoming ({upcomingData?.total ?? 0})</h2>
        {upcomingItems.length === 0 ? (
          noUpcoming(true)
        ) : (
          <ul className="card-list">
            {upcomingItems.map((appointment) => (
              <UpcomingCard key={appointment.id} appointment={appointment} now={upcoming.receivedAt ?? 0} />
            ))}
          </ul>
        )}

        <h2 className="section-title">Past ({pastData?.total ?? 0})</h2>
        {pastItems.length === 0 ? (
          noPast(true)
        ) : (
          <ul className="card-list">
            {pastItems.map((appointment) => (
              <PastCard key={appointment.id} appointment={appointment} />
            ))}
          </ul>
        )}
        {nextCursor ? (
          <div className="button-row">
            <button type="button" className="button button--secondary" onClick={showOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading older appointments…" : "Show older appointments"}
            </button>
          </div>
        ) : null}
        {olderFailed ? (
          <p role="alert">
            Error: older appointments could not be loaded. Choose &quot;Show older appointments&quot; to try again.
          </p>
        ) : null}
      </FourState>
    </>
  );
}
