// Shows an instant in the clinic's time zone, always with the zone abbreviation next to it
// (R70, R72). Never the viewer's own zone.
import { clinicTime } from "@/domain/time";

export interface ClinicTimeProps {
  /** A UTC instant, as an ISO string or a Date. */
  instant: string | Date;
  /** The clinic's IANA time zone, for example "America/Chicago". */
  timeZone: string;
  /** "datetime" (default), or "time" when the date is already shown nearby. */
  show?: "datetime" | "time";
}

export function ClinicTime({ instant, timeZone, show = "datetime" }: ClinicTimeProps) {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  const t = clinicTime(date, timeZone);
  return (
    <time className="clinic-time" dateTime={date.toISOString()}>
      {show === "datetime" ? `${t.dateLabel}, ` : ""}
      {t.timeLabel} <abbr title={`Clinic time zone: ${timeZone}`}>{t.zoneAbbreviation}</abbr>
    </time>
  );
}
