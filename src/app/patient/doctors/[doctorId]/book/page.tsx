"use client";

// Confirm booking (R17 to R19, R23, R26, R27; mocks 09 to 11). Nothing is booked until the
// patient chooses "Confirm booking". If the time was just taken, nothing is booked, the next
// open slots are offered, and what the patient typed stays in the form.
//
// Copy differs from the approved mocks where the spec says it must (F2, F4): the deadline is
// worded as the last moment to reschedule or to cancel without a late mark, and the details
// are readable by the patient and their doctor, not "the clinic".
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useRef, useState } from "react";
import { ClinicTime } from "@/components/ClinicTime";
import { ErrorMessage } from "@/components/ErrorMessage";
import { FourState } from "@/components/FourState";
import { LabelledField } from "@/components/LabelledField";
import { clinicTime } from "@/domain/time";
import { windowOpensAt } from "@/domain/window";
import { type ApiError, api, newIdempotencyKey } from "@/lib/api-client";
import {
  type DoctorProfileResponse,
  type PatientAppointment,
  type SlotTime,
  clinicDateLabel,
  clinicMomentLabel,
  loadError,
  useApi,
} from "../../../_shared";

const SEARCH = "/patient/doctors";
const REASON_MAX = 200;

interface OwnProfile {
  profile: { dateOfBirth: string | null };
}

/** "1990-04-23" as the patient types it: "23 04 1990". */
function typedDate(iso: string | null): string {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${day} ${month} ${year}`;
}

/** Day, month, year as typed, to "YYYY-MM-DD". Null when it is not a real calendar date. */
function parseTypedDate(text: string): string | null {
  const match = /^\s*(\d{1,2})[\s./-]+(\d{1,2})[\s./-]+(\d{4})\s*$/.exec(text);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The current instant. Read in event handlers only, never while rendering. */
function clockNow(): number {
  return Date.now();
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function AppointmentDetails({
  doctorName,
  specialty,
  clinic,
  startsAt,
  endsAt,
  timeZone,
}: {
  doctorName: string;
  specialty: string;
  clinic: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
}) {
  return (
    <dl className="details">
      <div>
        <dt>Doctor</dt>
        <dd>
          {doctorName}, {specialty}
        </dd>
      </div>
      <div>
        <dt>Clinic</dt>
        <dd>{clinic}</dd>
      </div>
      <div>
        <dt>Date</dt>
        <dd>{clinicDateLabel(startsAt, timeZone)}</dd>
      </div>
      <div>
        <dt>Time</dt>
        <dd>
          {clinicTime(new Date(startsAt), timeZone).timeLabel} to{" "}
          <ClinicTime instant={endsAt} timeZone={timeZone} show="time" /> (the clinic&apos;s time zone, {timeZone})
        </dd>
      </div>
    </dl>
  );
}

/**
 * The last moment to reschedule or to cancel without a late mark (R26). When that moment has
 * already passed, it says so, why, and what to do instead (R34), rather than a deadline in the past.
 */
function DeadlineTerms({
  deadline,
  timeZone,
  windowHours,
  now,
  fromMyAppointments = false,
}: {
  deadline: Date;
  timeZone: string;
  windowHours: number | null;
  now: number;
  /** Once booked, say where to do it (mock 11). */
  fromMyAppointments?: boolean;
}) {
  const hours = windowHours === null ? null : ` (${windowHours} hours before)`;
  const when = <time dateTime={deadline.toISOString()}>{clinicMomentLabel(deadline, timeZone)}</time>;
  if (now >= deadline.getTime()) {
    return (
      <>
        This appointment starts within the clinic&apos;s cancellation window, which opened at {when}
        {hours}. So it cannot be rescheduled online, and a cancellation is recorded as a late cancellation. To move
        it, call the clinic.
      </>
    );
  }
  return (
    <>
      You can reschedule, or cancel without a late mark,{" "}
      {fromMyAppointments ? <>from &quot;My appointments&quot; </> : null}until {when}
      {hours}. After that you can still cancel, and it is recorded as a late cancellation.
    </>
  );
}

function ConfirmBooking() {
  const { doctorId } = useParams<{ doctorId: string }>();
  const router = useRouter();
  const fromAddress = useSearchParams().get("start");
  // A time chosen on this screen after "that time was just taken". It applies at once: the
  // address is updated too, but that arrives a moment later.
  const [chosen, setChosen] = useState<string | null>(null);
  const startParam = chosen ?? fromAddress;
  const start = startParam && !Number.isNaN(Date.parse(startParam)) ? new Date(startParam) : null;
  const slotsHref = `${SEARCH}/${doctorId}`;

  const doctorLoad = useApi<DoctorProfileResponse>(`/doctors/${doctorId}`);
  const profileLoad = useApi<OwnProfile>("/me/profile");

  // What the patient typed. It is kept while they choose another time (R23).
  const [birthTyped, setBirthTyped] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ dateOfBirth?: string; reasonForVisit?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [taken, setTaken] = useState<{ startsAt: string; nextSlots: SlotTime[]; timeZone: string } | null>(null);
  const [booked, setBooked] = useState<PatientAppointment | null>(null);
  const [bookedAt, setBookedAt] = useState(0);
  // One key per chosen time: a double click or a retry after a timeout books once (R27).
  const keys = useRef(new Map<string, string>());

  const view = booked ? "booked" : taken ? "taken" : "review";
  const heading = useRef<HTMLHeadingElement>(null);
  const firstView = useRef(true);
  useEffect(() => {
    // Move focus to the new heading when the screen changes, so it is announced.
    if (firstView.current) firstView.current = false;
    else heading.current?.focus();
  }, [view]);

  const loads = [doctorLoad.result, profileLoad.result];
  const failed = loads.find((result) => result && !result.ok);
  const state = doctorLoad.loading || profileLoad.loading ? "loading" : failed ? "error" : "success";
  const doctor = doctorLoad.result?.ok ? doctorLoad.result.data.doctor : null;
  const terms = doctorLoad.result?.ok ? doctorLoad.result.data.booking : null;
  const birthOnFile = profileLoad.result?.ok ? profileLoad.result.data.profile.dateOfBirth : null;
  const birthValue = birthTyped ?? typedDate(birthOnFile);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!start || !doctor || submitting) return;

    const problems: typeof fieldErrors = {};
    const dateOfBirth = parseTypedDate(birthValue);
    if (!birthValue.trim()) problems.dateOfBirth = "Enter your date of birth.";
    else if (!dateOfBirth) problems.dateOfBirth = "Enter a real date as day, month, year. For example 23 04 1990.";
    const reasonForVisit = reason.trim();
    if (!reasonForVisit) problems.reasonForVisit = "Enter a reason for your visit.";
    else if (reasonForVisit.length > REASON_MAX) {
      problems.reasonForVisit = `Enter a reason of ${REASON_MAX} characters or fewer.`;
    }
    setFieldErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;

    const startsAt = start.toISOString();
    let idempotencyKey = keys.current.get(startsAt);
    if (!idempotencyKey) {
      idempotencyKey = newIdempotencyKey();
      keys.current.set(startsAt, idempotencyKey);
    }

    setSubmitting(true);
    const result = await api<{ appointment: PatientAppointment }>("/appointments", {
      method: "POST",
      body: { doctorId: doctor.id, startsAt, reasonForVisit, dateOfBirth },
      idempotencyKey,
    });
    setSubmitting(false);

    if (result.ok) {
      setBookedAt(clockNow());
      setBooked(result.data.appointment);
      return;
    }
    const error = result.error;
    if (error.code === "SLOT_TAKEN") {
      setTaken({ startsAt, nextSlots: error.nextSlots ?? [], timeZone: error.timeZone ?? doctor.timeZone });
      return;
    }
    if (error.code === "VALIDATION_FAILED") {
      const fromServer: typeof fieldErrors = {};
      for (const field of error.fields ?? []) {
        if (field.field === "dateOfBirth") {
          fromServer.dateOfBirth = "Enter a real date that is not in the future, as day, month, year.";
        }
        if (field.field === "reasonForVisit") {
          fromServer.reasonForVisit = `Enter a reason of 1 to ${REASON_MAX} characters.`;
        }
      }
      if (Object.keys(fromServer).length > 0) {
        setFieldErrors(fromServer);
        return;
      }
    }
    setFailure(error);
  };

  const chooseTime = (startsAt: string) => {
    setChosen(startsAt);
    setTaken(null);
    setFailure(null);
    router.replace(`${slotsHref}/book?start=${encodeURIComponent(startsAt)}`);
  };

  if (booked) {
    return (
      <div className="page-narrow">
        <div className="success-banner" role="status">
          <h1 ref={heading} tabIndex={-1}>
            Appointment booked
          </h1>
          <p>
            Your appointment with {booked.doctorName} is booked. The clinic will confirm it. You do not need to do
            anything else.
          </p>
        </div>
        <section className="card" aria-labelledby="booked-details">
          <h2 id="booked-details">Appointment details</h2>
          <AppointmentDetails
            doctorName={booked.doctorName}
            specialty={booked.specialty}
            clinic={`${booked.clinicName}, ${booked.clinicAddress}`}
            startsAt={booked.startsAt}
            endsAt={booked.endsAt}
            timeZone={booked.timeZone}
          />
          <p>
            <DeadlineTerms
              deadline={new Date(booked.cancellationDeadline)}
              timeZone={booked.timeZone}
              windowHours={terms?.cancellationWindowHours ?? null}
              now={bookedAt}
              fromMyAppointments
            />
          </p>
        </section>
        <div className="button-row">
          <Link href="/patient/appointments" className="button">
            View my appointments
          </Link>
          <Link href={SEARCH} className="button button--secondary">
            Find another doctor
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-narrow">
      <Link href={slotsHref} className="back-link">
        Back to open slots
      </Link>
      <h1 ref={heading} tabIndex={-1}>
        Confirm your appointment
      </h1>

      <FourState
        state={state}
        loadingLabel="Loading the appointment details"
        onRetry={() => {
          doctorLoad.retry();
          profileLoad.retry();
        }}
        // The review screen always has one doctor and one time, so there is no empty state.
        empty={null}
        error={
          failed && !failed.ok
            ? loadError(
                failed.error,
                "we could not load the appointment details",
                "Something went wrong on our side. Nothing has been booked. Try again. If it still does not work, wait a few minutes or call the clinic to book.",
              )
            : undefined
        }
      >
        {!doctor ? null : !start ? (
          <ErrorMessage
            title="no time was chosen"
            message="This page needs one of the doctor's open times. Nothing has been booked. Go back and choose a time."
          >
            <Link href={slotsHref} className="button">
              See all open slots
            </Link>
          </ErrorMessage>
        ) : taken ? (
          <>
            <ErrorMessage
              title="that time was just taken"
              message={`Someone else booked ${clinicDateLabel(taken.startsAt, taken.timeZone)} at ${
                clinicTime(new Date(taken.startsAt), taken.timeZone).timeLabel
              } ${clinicTime(new Date(taken.startsAt), taken.timeZone).zoneAbbreviation} while you were confirming. Nothing has been booked for you. Choose another time below. Your date of birth and reason for visit are kept, so you will not need to type them again.`}
            />
            <section className="card" aria-labelledby="next-slots">
              <h2 id="next-slots">Next open slots with {doctor.name}</h2>
              <p>
                All times are in the clinic&apos;s time zone, <strong>{taken.timeZone}</strong>.
              </p>
              {taken.nextSlots.length === 0 ? (
                <p>{doctor.name} has no other open times at the moment.</p>
              ) : (
                taken.nextSlots.map((slot) => (
                  <div key={slot.startsAt} className="slot-option">
                    <strong>
                      <ClinicTime instant={slot.startsAt} timeZone={taken.timeZone} />
                    </strong>
                    <button type="button" className="button" onClick={() => chooseTime(slot.startsAt)}>
                      Choose this time
                    </button>
                  </div>
                ))
              )}
              <Link href={slotsHref} className="back-link">
                See all open slots
              </Link>
            </section>
          </>
        ) : (
          <>
            <p className="muted">
              Check the details, then confirm. Nothing is booked until you choose &quot;Confirm booking&quot;.
            </p>
            <section className="card" aria-labelledby="appointment-details">
              <h2 id="appointment-details">Appointment details</h2>
              <AppointmentDetails
                doctorName={doctor.name}
                specialty={doctor.specialty}
                clinic={`${doctor.clinicName}, ${doctor.clinicAddress}`}
                startsAt={start.toISOString()}
                endsAt={new Date(start.getTime() + doctor.slotLengthMinutes * 60_000).toISOString()}
                timeZone={doctor.timeZone}
              />
              <Link href={slotsHref} className="back-link">
                Choose a different time
              </Link>
            </section>

            <form className="card" onSubmit={submit} noValidate aria-labelledby="your-details">
              <h2 id="your-details">Your details</h2>
              <p className="muted">Both fields are required. Only you and your doctor can see them.</p>
              {Object.keys(fieldErrors).length > 0 ? (
                <p role="alert">Error: check the fields marked below. Nothing has been booked.</p>
              ) : null}
              <LabelledField
                label="Date of birth"
                hint="Day, month, year. For example 23 04 1990."
                error={fieldErrors.dateOfBirth}
              >
                {(control) => (
                  <input
                    {...control}
                    className="input--short"
                    type="text"
                    inputMode="numeric"
                    autoComplete="bday"
                    value={birthValue}
                    onChange={(event) => setBirthTyped(event.target.value)}
                  />
                )}
              </LabelledField>
              <LabelledField
                label="Reason for visit"
                hint={`A few words is enough. For example "annual check-up". ${REASON_MAX} characters at most.`}
                error={fieldErrors.reasonForVisit}
              >
                {(control) => (
                  <textarea {...control} rows={4} value={reason} onChange={(event) => setReason(event.target.value)} />
                )}
              </LabelledField>

              {terms ? (
                <div className="notice">
                  <h3>Before you confirm</h3>
                  <ul>
                    <li>
                      <DeadlineTerms
                        deadline={windowOpensAt(start, terms.cancellationWindowHours)}
                        timeZone={doctor.timeZone}
                        windowHours={terms.cancellationWindowHours}
                        now={doctorLoad.receivedAt ?? 0}
                      />
                    </li>
                    <li>
                      {terms.upcomingCount >= terms.maxUpcomingPerPatient
                        ? `You already have ${terms.upcomingCount} upcoming appointments at this clinic, the most it allows. Cancel one, or wait until one has passed, before you book another.`
                        : `This will be your ${ordinal(terms.upcomingCount + 1)} of ${terms.maxUpcomingPerPatient} upcoming appointments allowed at this clinic.`}
                    </li>
                  </ul>
                </div>
              ) : null}

              {failure ? (
                <ErrorMessage
                  title={failure.code === "SLOT_UNAVAILABLE" ? "that time is not available" : "the appointment was not booked"}
                  message={`${failure.message} Nothing has been booked.`}
                  requestId={failure.code === "INTERNAL" ? failure.requestId : null}
                >
                  <Link href={slotsHref} className="button button--secondary">
                    See all open slots
                  </Link>
                </ErrorMessage>
              ) : null}

              <div className="button-row">
                <button type="submit" className="button" disabled={submitting}>
                  {submitting ? "Booking…" : "Confirm booking"}
                </button>
                <Link href={slotsHref} className="button button--secondary">
                  Go back without booking
                </Link>
              </div>
            </form>
          </>
        )}
      </FourState>
    </div>
  );
}

export default function ConfirmBookingPage() {
  return (
    <Suspense
      fallback={
        <p className="state state--loading" role="status">
          Loading the appointment details…
        </p>
      }
    >
      <ConfirmBooking />
    </Suspense>
  );
}
