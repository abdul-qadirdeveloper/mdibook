# Intent: MediBook appointment booking for small clinics
Author: Abdul Qadir (Product Owner). Status: accepted.

## Problem
Today small clinics manage doctor appointments with phone calls and a shared spreadsheet. This
causes double bookings, and no-shows that nobody follows up on. Patients have no single place
to find a doctor, see open slots, and book, reschedule or cancel. Clinic staff need to manage
the schedules of their own clinic's doctors.

## Proposed outcome
- A patient can search doctors by name, specialty, location and availability, and view a
  doctor's profile and open slots.
- A patient can book, reschedule and cancel appointments, and see upcoming and past ones.
- When two people try to book the same slot at once, the first to confirm gets it; the other
  sees an error and picks another slot.
- Booking, cancelling and rescheduling each produce a notification (a log-based stub for now).
- Success: a patient can book in under a minute, and a clinic sees zero double bookings.

## Affected users and systems
- Roles: patients, doctors and clinic staff. All three can log in.
- Systems: web app, database, notification adapter (stub).

## Constraints
- Multi-tenant: one deployment serves many clinics.
- Staff belong to exactly one clinic and manage schedules only for doctors in that clinic.
- Patient data is treated as PHI-like: minimum necessary access, and no personal data in logs
  or error messages.
- Doctors can view/add/edit their own schedule.
- Staff can book, reschedule and cancel on behalf of a patient.
- Patients must have an account to book; there is no guest booking.
- Date of birth and reason for visit are collected when a patient books.
- No-shows are only recorded in this release (see intent 002); follow-up may come later.
- The notification stub records only the event type and opaque identifiers.
- Times are stored in UTC and shown in the clinic's time zone, including to patients in
  another time zone.
- Patients can cancel or reschedule up to 24 hours before the appointment, and can hold at
  most 3 upcoming appointments per clinic. Both values are configurable per clinic.
- Patients can never overbook a slot. Staff can knowingly add an extra booking to a slot for
  their own clinic's doctors.
- Location search matches city or area text, not distance.
- The interface is English only.
- Finish line: a working v1 that meets the two success criteria, with no fixed date.
- Out of scope for this release: payments, SMS/email reminders, waitlists, video consults,
  insurance, reviews, native mobile apps, and compliance with a specific country's regulation.
- No preferences on hosting, budget, expected scale or mobile support.

## Open questions
None.
