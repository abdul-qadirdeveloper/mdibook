# Intent: Doctor schedule management
Author: Abdul Qadir (Product Owner). Status: accepted.

## Problem
Clinics keep doctor schedules in a shared spreadsheet and by phone. Doctors and staff have no
reliable place to say when a doctor is available or to record what happened to an appointment,
so double bookings occur and no-shows go unrecorded.

## Proposed outcome
- Doctors and clinic staff define working hours, breaks, time off and slot length.
- They view a daily and a weekly schedule.
- They mark an appointment confirmed, reschedule or cancel it, and mark it completed or
  no-show.
- Changing working hours or adding time off requires a reason. Every appointment affected by
  the change is cancelled with that reason, and the patient is informed of the cancellation.

## Affected users and systems
- Roles: doctors and clinic staff. Patients are affected through the slots they can book.
- Systems: web app, database, notification adapter (stub).

## Constraints
- Staff manage schedules only for doctors in their own clinic.
- Patient data is treated as PHI-like: minimum necessary access, and no personal data in logs
  or error messages.
- Times are stored in UTC and shown in the clinic's time zone.
- Both staff and the appointment's doctor see: date, time and slot length; status; the
  patient's full name; the patient's no-show count at the clinic.
- Staff only: the patient's phone and email; who booked the appointment and when; its
  reschedule and cancellation history; the patient's past appointments with other doctors in
  the clinic.
- Doctor only: the patient's date of birth or age; reason for visit; the patient's past
  appointments with that doctor.
- Date of birth and reason for visit are collected when a patient books.
- A no-show is only recorded in this release; follow-up may be added in a future release.
- A booking holds its slot before staff or the doctor mark it confirmed.
- A doctor sees no patient details for another doctor's appointments.
- A clinic sees no patient appointments at another clinic.

## Open questions
None.
