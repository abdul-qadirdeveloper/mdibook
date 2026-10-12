# Spec: MediBook MVP appointment booking and schedule management
Intent: intent/001-appointment-booking.md, intent/002-doctor-schedule-management.md  
Mocks: docs/001-appointment-booking/mocks.md (status: approved)  
Skills in force (tree hash of .claude/skills): 3a54982  
Date: 2026-10-09. Status: approved

## 1. Summary

Patients of small clinics find a doctor, see open slots, and book, reschedule or cancel.
Doctors and staff define availability and record outcomes; an admin creates clinics and accounts.
One deployment serves many clinics, in a new Next.js, TypeScript, PostgreSQL (Prisma) codebase.
Both contradictions between intent 001 and the domain rules are decided: F1 no overbooking, F2 late
cancellation is allowed and flagged. All 22 flagged concerns are resolved; none is open.

## 2. Requirements

Terms used below:

- **Active appointment**: status `requested` or `confirmed`. It holds its slot.
- **Upcoming**: active and starting in the future.
- **Slot**: a bookable interval for one doctor, identified by doctor and start instant.
- **Cancellation window**: the period before the start, 24 hours by default, set per clinic.
- **"Confirm booking"**: the patient's button. It creates a `requested` appointment. It is not the
  `confirmed` status, which only staff or the doctor set.

A source of "assumption" means no intent or skill covers the point and this spec chose a behavior.
Each assumption is listed under Flagged concerns.

Requirement numbers are stable. R92 to R103 were added after Product Owner decisions and sit in
their topic sections, so the numbers are not in reading order everywhere.

### Accounts, roles and tenancy

- **R1** There are four roles: patient, doctor, staff and admin. All can sign in. (intent 001,
  Affected users; domain rules, Roles; admin role added by F9)
- **R2** A patient must have an account to book. There is no guest booking. (intent 001,
  Constraints)
- **R3** One deployment serves many clinics. Every appointment, schedule and staff record belongs to
  exactly one clinic. (intent 001, Constraints)
- **R4** A staff member belongs to exactly one clinic and can act only on that clinic's doctors and
  appointments. (intent 001, Constraints; domain rules, Roles)
- **R5** A doctor belongs to exactly one clinic. (assumption, F15)
- **R6** A patient account is not tied to a clinic. A patient-to-clinic link is created at the
  patient's first booking at that clinic. (assumption, F7)
- **R7** Every query and mutation is scoped by role and clinic on the server. A clinic, doctor or
  patient identifier sent by the client is checked against the session before use. (domain rules,
  Roles; privacy rule 1)
- **R8** A request for a record outside the caller's scope gets the same "not found" result as a
  record that does not exist. (privacy rule 1)
- **R9** Identifiers that appear in URLs, logs, audit events and notifications are random and
  opaque, never sequential and never derived from personal data. (privacy rule 2)
- **R10** Clinics, doctor accounts and staff accounts are created by an admin, as set out in R93 to
  R97. Patients register themselves. (F9)

### Finding a doctor

- **R11** A patient can search doctors by name, specialty, location and availability, alone or
  combined. (intent 001, Proposed outcome)
- **R12** Name matches any part of the doctor's name, ignoring case. Specialty is chosen from a
  fixed list. Location matches the clinic's city or area text, ignoring case, never distance.
  (intent 001, Constraints)
- **R13** Availability offers: any time, today, next 7 days, next 30 days. A doctor matches when
  they have at least one open slot in the period. (assumption from mocks screen 1, F21)
- **R14** Each result shows doctor name, specialty, clinic name, area, city and next open slot.
  Results are ordered by next open slot, earliest first, 20 per page. (assumption from mocks screen
  1, F21)
- **R15** A doctor profile shows name, specialty, clinic, address, clinic time zone, a short
  description, slot length, and open slots grouped by date, with a control to load later dates.
  (intent 001, Proposed outcome; mocks screen 2)
- **R16** Search and profile pages require sign-in. (assumption, F19)

### Booking

- **R17** A patient books by choosing an open slot and then choosing "Confirm booking" on a review
  screen. No slot is held and nothing is booked before that. (intent 001, Proposed outcome; mocks
  screen 3)
- **R18** Date of birth and reason for visit are both required when a patient books. (intent 001,
  Constraints; intent 002, Constraints)
- **R19** Date of birth is stored once on the patient's profile and pre-filled at later bookings.
  The patient can correct it. Reason for visit is stored on the appointment. (assumption, F21)
- **R20** Reason for visit is free text of at most 200 characters. Only the patient who wrote it
  and the appointment's doctor can read it. (intent 002, Constraints; privacy rule 5; F8)
- **R21** A patient's new booking has status `requested` and holds its slot from creation. (intent
  002, Constraints; domain rules, Statuses)
- **R22** A doctor can have at most one active appointment covering any moment. The database
  enforces this, not only application code. (intent 001, Proposed outcome; domain rules, No double
  booking)
- **R23** When two bookings for one slot arrive together, exactly one succeeds. The other gets a
  conflict result, nothing is booked for them, they are shown the next three open slots with that
  doctor, and what they typed stays in the form. (intent 001, Proposed outcome; domain rules, No
  double booking; ux-standards, Booking)
- **R24** A slot is bookable only if it starts in the future and within the next 90 days, lies in
  the doctor's working hours, is outside breaks and time off, sits on the slot grid, and has no
  active appointment. The server checks all of this again at booking time. (assumption, F20)
- **R25** A patient can hold at most 3 upcoming appointments per clinic. The number is set per
  clinic. Two simultaneous bookings by one patient cannot both pass the check. A patient at the
  limit is told the limit and what to do next. The limit applies whoever makes the booking,
  including staff. Any staff member of the clinic can change the clinic's limit and its
  cancellation window. (intent 001, Constraints; F20)
- **R26** The review screen states how many of the allowed upcoming appointments this booking uses,
  and the instant the cancellation window opens, worded as the last moment to reschedule or to
  cancel without a late mark. (mocks screen 3; F2)
- **R27** A repeated submission of the same booking, such as a double click or a retry after a
  timeout, creates one appointment. (assumption, F21)
- **R28** Staff can book for a patient with a doctor of their own clinic. The appointment records
  who booked it and when. Staff must enter the reason for visit and cannot read it after saving.
  Date of birth is taken from the patient's profile and is never shown to staff; if the profile
  has none, the booking still succeeds and the patient is asked for it at their next sign-in.
  (intent 001, Constraints; intent 002, Constraints; F4)
- **R29** An appointment booked by staff starts as `confirmed`. (assumption, F16)
- **R30** No role, including staff, can add an appointment to a slot that has an active
  appointment. (intent 001, Constraints; domain rules, No double booking; F1)
- **R31** An occupied slot becomes bookable again only when its appointment is cancelled, or is
  moved to another slot by a reschedule. (intent 001, Constraints; domain rules, Reschedule; F1)
- **R92** To find the patient for R28, staff can search by name only among patients linked to
  their clinic. For a patient not yet linked, staff enter the full email address; an exact match
  returns the patient's name and nothing else. A staff member can make at most 30 email lookups
  per hour. (intent 001, Constraints; intent 002, Constraints; privacy rule 1; F7)

### Rescheduling

- **R32** A patient can move an upcoming appointment to another open slot with the same doctor.
  (intent 001, Proposed outcome; same-doctor limit is an assumption, F21)
- **R33** Reschedule is one atomic operation. The old slot is released only if the new one is
  taken. If the new slot was just taken, the appointment is unchanged and R23 applies. (domain
  rules, Reschedule)
- **R34** A patient can reschedule only before the cancellation window opens. Inside the window the
  action is unavailable and the screen says why and what to do. (intent 001, Constraints; F2)
- **R35** Staff and the appointment's doctor can reschedule at any time before the start. (intent
  001, Constraints; intent 002, Proposed outcome)
- **R36** After a patient reschedules, the status is `requested`. After staff or the doctor
  reschedule, the status is unchanged. (assumption, F16)
- **R37** Reason for visit and booking origin carry over, and the move is added to the
  appointment's history. (intent 002, Constraints)

### Cancelling

- **R38** A patient can cancel an upcoming appointment before the cancellation window opens, and
  the cancellation is not flagged. (intent 001, Constraints; domain rules, Cancellation window)
- **R39** A patient can also cancel inside the window, at any time before the start. The
  cancellation is recorded as a late cancel, and the confirmation of R43 says so before the
  patient confirms. The late-cancel flag is visible to staff only and has no other effect. (intent
  001, Constraints; domain rules, Cancellation window; F2)
- **R40** The window is 24 hours by default, set per clinic, and measured as elapsed time between
  two instants. (intent 001, Constraints; domain rules, Cancellation window and Time)
- **R41** Staff and the appointment's doctor can cancel at any time and must choose a reason from a
  fixed list. There is no free-text reason. (domain rules, Cancellation window; privacy rule 5)
- **R42** A cancellation by staff or doctor is never recorded as a late cancel, including when
  staff act for the patient. (assumption, F21)
- **R43** Every cancel action asks for confirmation and states the consequence before it happens.
  (ux-standards, Destructive actions)
- **R44** A cancelled appointment records which role cancelled it. The patient sees "Cancelled by
  you" or "Cancelled by the clinic". (mocks screen 4)

### My appointments

- **R45** A patient sees their own upcoming and past appointments across all clinics, each with
  date, time, doctor, specialty, clinic, address and status. (intent 001, Proposed outcome; privacy
  rule 1)
- **R46** Each upcoming appointment shows its reschedule and cancel actions and the deadline of
  R26. (mocks screen 4)
- **R47** Patient-facing status labels are: Requested, Confirmed, Cancelled by you, Cancelled by
  the clinic, Attended (`completed`), Missed (`no_show`). (assumption from mocks screen 4, F21)

### Schedule definition

- **R48** A doctor can view, add and edit their own schedule. Staff can do the same only for
  doctors in their own clinic. (intent 001, Constraints; intent 002, Constraints)
- **R49** A schedule consists of weekly working hours, breaks, time off and a slot length in
  minutes. (intent 002, Proposed outcome)
- **R50** Working hours and breaks are entered as wall-clock times in the clinic's time zone. Time
  off is entered in the clinic's time zone and stored as start and end instants. (domain rules,
  Time)
- **R51** Changing working hours or breaks, or adding time off, requires a reason chosen from a
  fixed list. (intent 002, Proposed outcome; privacy rule 5; F6)
- **R52** Every active future appointment that no longer fits the changed schedule is cancelled
  with that reason in the same transaction as the change. Either the change and all its
  cancellations happen, or none do. (intent 002, Proposed outcome)
- **R53** Before saving, the user is shown how many appointments will be cancelled and on which
  dates, and must confirm. If the affected set changed since the preview, the save is refused and
  the preview is shown again. (ux-standards, Destructive actions)
- **R54** Each cancellation caused by a schedule change produces its own notification event and
  audit event, and the patient sees the appointment as "Cancelled by the clinic". After the change
  is saved, staff of the clinic can open the list of appointments it cancelled, with each patient's
  name and phone, so the clinic can call them. The doctor sees the same list without phone numbers.
  (intent 002, Proposed outcome and Constraints; domain rules, Notification; privacy rule 3; F5)
- **R55** The patient sees a neutral message for a clinic cancellation. The reason code is visible
  to that clinic's staff and to the doctor concerned, not to the patient. (privacy rules 1 and 5;
  F6)
- **R56** Changing slot length affects only slots generated afterwards. Existing appointments keep
  their start and length and are not cancelled. (assumption, F21)
- **R57** Removing time off reopens its slots. It does not restore cancelled appointments.
  (assumption, F21)

### Schedule views and outcomes

- **R58** Doctors and staff see a daily and a weekly schedule. A doctor sees their own. Staff
  choose among their clinic's doctors. (intent 002, Proposed outcome)
- **R59** Each role sees exactly the fields in the visibility table below and no others. (intent
  002, Constraints; privacy rule 1)
- **R60** A doctor sees no patient details for another doctor's appointments. (intent 002,
  Constraints)
- **R61** No user sees a patient's appointments at another clinic. (intent 002, Constraints)
- **R62** Staff and the appointment's doctor can mark an appointment confirmed, completed or
  no-show, and can reschedule or cancel it. (intent 002, Proposed outcome)
- **R63** Completed and no-show can be set only after the appointment's start time. (domain rules,
  Statuses)
- **R64** Only the transitions in the transition table below are allowed. Any other is refused and
  changes nothing. (domain rules, Statuses; F3)
- **R65** A no-show is recorded only. There is no follow-up, penalty or blocking. (intent 001,
  Constraints; intent 002, Constraints)
- **R66** The no-show count is the number of the patient's `no_show` appointments at that clinic.
  Staff and the appointment's doctor see the number only. (intent 002, Constraints)

### Time

- **R67** All instants are stored in UTC. (intent 001, Constraints; domain rules, Time)
- **R68** Each clinic has one IANA time zone, for example `America/Chicago`. (domain rules, Time)
- **R69** Conversion happens only when reading user input and when displaying. All comparisons use
  instants. (domain rules, Time)
- **R70** Every displayed time is in the clinic's time zone, including for a patient elsewhere, and
  has the zone name or abbreviation next to it. (intent 001, Constraints; ux-standards, Times)
- **R71** Slots are produced by stepping the slot length in elapsed time from the start instant of
  a working interval to its end instant. A local time skipped by a daylight-saving change produces
  no slot. A repeated hour produces slots for both occurrences. (domain rules, Time)
- **R72** On a day with a repeated hour, the abbreviation shown tells the two occurrences apart,
  for example EDT and EST. (ux-standards, Times)

### Notifications

- **R73** Every appointment state change emits a notification event: booked, confirmed,
  rescheduled, cancelled, completed, no-show. (domain rules, Notification; intent 001, Proposed
  outcome)
- **R74** The adapter writes events to the application log. (intent 001, Proposed outcome; domain
  rules, Notification)
- **R75** An event holds only its type, a timestamp and opaque identifiers for the appointment,
  clinic, patient and doctor. It never holds a name, contact detail, date of birth, visit reason,
  specialty, cancellation reason or appointment time. (intent 001, Constraints; privacy rules 2 and
  4; F14)
- **R76** The adapter sits behind an interface so a real channel can replace it without changing
  callers. (intent 001, Affected users and systems)
- **R77** The event is written in the same transaction as the state change. (assumption, F21)

### Privacy, logging and audit

- **R78** Logs, error messages, analytics and error reports never contain names, emails, phone
  numbers, dates of birth, visit reasons or clinical notes. They contain opaque IDs only. (intent
  001, Constraints; intent 002, Constraints; privacy rule 2)
- **R79** Request bodies and query parameter values are not logged. Database query logging with
  parameter values is off outside local development. (privacy rule 2)
- **R80** Personal data is never placed in a URL path or query string. Patient lookup sends its
  search term in the request body. (privacy rule 2)
- **R81** Every state-changing action writes an audit event with actor id, actor role, action,
  entity type, entity id, clinic id and UTC timestamp. Audit events hold IDs, never payloads.
  Clinic id is empty only for an action that belongs to no clinic, such as a patient changing
  their own account or an admin creating another admin. (privacy rule 3; F10)
- **R82** Audit events cannot be edited or deleted by any application role. (assumption, F21)
- **R83** Every response is built from a per-role list of allowed fields. No handler returns a
  whole database row. (privacy rule 1)
- **R84** The history staff see (who booked, moves, cancellations) is stored as appointment data
  with access control. It is not read from the audit log. (intent 002, Constraints; privacy rule 3)
- **R85** No screen, document or message claims the system complies with any regulation. (privacy
  rule 7; intent 001, Constraints)

### Interface

- **R86** Every screen defines four states: loading, empty, error, success. (ux-standards)
- **R87** Every input has a visible label, everything works by keyboard, focus is visible, color is
  never the only signal, text contrast meets WCAG AA, and tap targets are at least 44 by 44 px.
  (ux-standards, Accessibility basics)
- **R88** Error messages say what happened and what to do next, and never show internal details or
  personal data. A server error shows a reference ID. (ux-standards, Errors; privacy rule 2)
- **R89** Validation errors name the field and the problem and do not repeat the value typed.
  (privacy rule 2)
- **R90** The interface is English only. (intent 001, Constraints)
- **R91** A screen without an approved mock is not built until its mock is approved or waived by
  the Product Owner. The screens are listed below. (spec-template, Gate; F11)

| Screen | Roles | Mock |
|---|---|---|
| Find a doctor | patient | Approved |
| Doctor profile and open slots | patient | Approved |
| Confirm booking, slot taken, booked | patient | Approved; copy must change per F2 and F4 |
| My appointments | patient | Approved; copy must change per F2 |
| Cancel confirmation | patient | None |
| Reschedule | patient | None |
| Sign in, register, profile | all | None |
| Forgot password, set a new password | all | None |
| Admin: clinics, accounts, specialties | admin | None |
| Daily and weekly schedule | doctor, staff | None |
| Appointment detail and actions | doctor, staff | None |
| Working hours, breaks, slot length | doctor, staff | None |
| Time off with affected-appointments confirmation | doctor, staff | None |
| Find a patient and book for them | staff | None |
| Clinic settings | staff | None |

### Administration and account recovery

- **R93** An admin does not belong to a clinic. An admin can create a clinic and edit its name,
  address, area, city and time zone; create doctor and staff accounts in a clinic; deactivate and
  reactivate those accounts; maintain the specialty list; and create other admin accounts. (F9;
  scope is an assumption, F22)
- **R94** An admin cannot read or change patients, appointments, visit reasons, or any field in the
  visibility table below. An admin's request for such a record gets the "not found" result of R8.
  (privacy rule 1; F22)
- **R95** The first admin account is created at deployment. Every later admin is created by an
  admin. (assumption, F22)
- **R96** A deactivated account cannot sign in, and a deactivated doctor does not appear in search
  or offer slots. A doctor with upcoming appointments cannot be deactivated until those are
  cancelled or completed. (assumption, F22)
- **R97** Every admin action writes an audit event as in R81. (privacy rule 3)
- **R98** Users sign in with email and password. (assumption, F22)
- **R99** Any user can request a password reset by entering their email address. The response is
  identical whether or not the address has an account. (F9; privacy rule 1)
- **R100** The reset message is sent by email to the account's address. It contains a single-use
  link that expires after 30 minutes, and no other personal data. (F9; privacy rule 4; expiry is an
  assumption, F22)
- **R101** Using the link sets a new password and ends the user's other sessions. A used or expired
  link is refused with a message that says how to request a new one. (F9; ux-standards, Errors)
- **R102** A doctor, staff or admin account created by an admin receives a set-password link by the
  same channel. An admin never sees or sets another user's password. (F9; privacy rule 1)
- **R103** Reset and set-password links and their tokens never appear in logs, audit events or
  notification events. This channel is separate from the notification stub of R74. (privacy rule 2;
  intent 001, Constraints)

### Field visibility by role (R59)

"Doctor" is the appointment's own doctor. "Staff" is staff of the appointment's clinic. Anyone
else, including an admin, sees nothing. (intent 002, Constraints; privacy rule 1)

| Field | Patient (own) | Doctor | Staff |
|---|---|---|---|
| Date, time, slot length | Yes | Yes | Yes |
| Status | Yes | Yes | Yes |
| Doctor, specialty, clinic, address | Yes | Yes | Yes |
| Patient full name | Yes | Yes | Yes |
| No-show count at the clinic | No | Yes | Yes |
| Patient phone and email | Yes | No | Yes |
| Who booked and when | No | No | Yes |
| Reschedule and cancellation history | No | No | Yes |
| Past appointments with other doctors in the clinic | Yes | No | Yes, without visit reason |
| Past appointments with this doctor | Yes | Yes | Yes, without visit reason |
| Date of birth or age | Yes | Age only (F17) | No |
| Reason for visit | Yes | Yes | No; entered but not readable when staff book (R28) |
| Staff or schedule-change reason code | No | Yes | Yes |

### Status transitions (R64)

The domain rules name five statuses and say only listed transitions are valid, but list none. The
Product Owner accepted this table on 2026-10-09 (F3).

| From | To | Who | Condition |
|---|---|---|---|
| none | `requested` | patient | R17 to R27 |
| none | `confirmed` | staff | Staff booking (R28, R29) |
| `requested` | `confirmed` | staff, doctor | Before the start |
| `requested`, `confirmed` | `cancelled` | patient, staff, doctor | Before the start; a patient inside the window sets the late-cancel flag (R39) |
| `confirmed` | `requested` | patient | Only through a patient reschedule (R36) |
| `requested`, `confirmed` | `completed` | staff, doctor | After the start |
| `requested`, `confirmed` | `no_show` | staff, doctor | After the start |

`cancelled`, `completed` and `no_show` are final (F18). A reschedule changes the time of the same
appointment; there is no "rescheduled" status. Nothing expires automatically: an appointment still
`requested` after its start stays so until an outcome is recorded.

## 3. Data model sketch

Entities and rules, not schema code. All keys are random opaque IDs. All timestamps are UTC
instants.

| Entity | Main fields | Notes |
|---|---|---|
| Clinic | name, address, area, city, IANA time zone, cancellation window hours (24), max upcoming per patient (3) | Tenant root. Area and city feed location search. |
| User | email, credentials, role, active flag | One role per account: patient, doctor, staff or admin. An admin has no clinic. |
| PasswordResetToken | user, token hash, expires at, used at | Only a hash of the token is stored. Also used for set-password links (R102). |
| PatientProfile | user, full name, phone, date of birth | Not owned by a clinic. |
| DoctorProfile | user, clinic, name, specialty, description, slot length minutes | One clinic (R5). |
| StaffProfile | user, clinic | Exactly one clinic. |
| Specialty | name | Fixed list. |
| ClinicPatient | clinic, patient | Created at first booking. Limits staff lookup; locked when checking the booking limit. |
| WorkingHours | doctor, clinic, weekday, local start, local end | Weekly template in clinic wall-clock time. |
| Break | doctor, clinic, weekday, local start, local end | |
| TimeOff | doctor, clinic, start instant, end instant, reason code, created by | |
| ScheduleChange | doctor, clinic, kind, reason code, actor, at, appointments cancelled | One per change that needed a reason. |
| Appointment | clinic, doctor, patient, start, end, status, reason for visit, booked by (id and role), booked at, cancelled by role, cancel reason code, late-cancel flag, schedule change | Clinic is on the row so every query filters by it directly. |
| AppointmentHistory | appointment, clinic, action, actor id and role, old start, new start, reason code, at | Source of the staff history view. No free text. |
| AuditEvent | actor id, actor role, action, entity type, entity id, clinic id, at | IDs only. Append-only. |
| NotificationEvent | type, appointment, clinic, patient, doctor, at | Written with the state change; the log adapter prints type and IDs. |

Rules the database enforces:

1. **No overlapping active appointments per doctor.** A PostgreSQL exclusion constraint over doctor
   and the range from start to end, applied to rows with status `requested` or `confirmed`. It
   stays correct when a slot-length change leaves appointments of different lengths on the
   calendar, which uniqueness on start time alone does not. It needs PostgreSQL's `btree_gist`
   extension and cannot be declared in the Prisma schema file, so it is added by a hand-written SQL
   migration. A violation is reported to the caller as the slot-taken conflict of R23.
2. **End after start** on appointments, working hours, breaks and time off.
3. **Tenant consistency.** An appointment's clinic equals its doctor's clinic.
4. **Reschedule** updates start and end on the same row, with its history, audit and notification
   rows, in one transaction. Rule 1 then releases the old time only if the new time is free.
5. **Booking limit.** Inside the booking transaction the ClinicPatient row is locked, upcoming
   appointments are counted, then the appointment is inserted.

Notes:

- Slots are not stored. They are computed from working hours, minus breaks, minus time off, minus
  active appointments.
- The no-show count is computed by query, not kept as a counter.
- PostgreSQL row-level security keyed on clinic is recommended as a second layer behind R7.
- Rule 1 has no exceptions for any role (F1).

## 4. API sketch

JSON over HTTPS under `/api/v1`, as Next.js route handlers. The session supplies the actor's id,
role and clinic. No endpoint treats a client-sent clinic id as authority.

| Method and path | Roles | Purpose |
|---|---|---|
| `POST /patients` | public | Register a patient account. |
| `POST /auth/password-reset/request` | public | Body: email. Same response whether or not the account exists (R99). |
| `POST /auth/password-reset/confirm` | public | Body: token and new password. Single use (R101). |
| `GET /me/profile`, `PATCH /me/profile` | patient | Read and correct own name, phone, date of birth. |
| `GET /specialties` | signed in | Fixed list for the search filter. |
| `GET /doctors?name&specialty&location&availability&cursor` | signed in | Search. Doctor, clinic, next open slot. |
| `GET /doctors/{doctorId}` | signed in | Profile. |
| `GET /doctors/{doctorId}/slots?from&to` | signed in | Open slots as UTC instants plus the clinic time zone. |
| `GET /me/appointments?scope=upcoming\|past` | patient | Own appointments across clinics. |
| `POST /appointments` | patient, staff | Book. Doctor id, start instant, reason for visit, date of birth if not on file; staff also send patient id. Accepts an `Idempotency-Key` header. |
| `GET /appointments/{id}` | patient, doctor, staff | Fields per the visibility table. |
| `POST /appointments/{id}/reschedule` | patient, doctor, staff | New start instant. Atomic. |
| `POST /appointments/{id}/cancel` | patient, doctor, staff | Staff and doctor send a reason code. The response says whether it was recorded as late. |
| `POST /appointments/{id}/confirm` | doctor, staff | |
| `POST /appointments/{id}/complete` | doctor, staff | After the start only. |
| `POST /appointments/{id}/no-show` | doctor, staff | After the start only. |
| `GET /clinic/schedule?doctorId&view=day\|week&date` | doctor (self), staff | Schedule with appointments. |
| `POST /clinic/patients/search` | staff | Find a patient to book for. Term in the body (R80, F7). |
| `GET /clinic/patients/{patientId}` | doctor, staff | Staff: contact details and clinic history. Doctor: history with that doctor. |
| `GET /doctors/{doctorId}/schedule-settings` | doctor (self), staff | Hours, breaks, slot length, time off. |
| `POST /doctors/{doctorId}/schedule-changes/preview` | doctor (self), staff | Appointments a change would cancel, plus a preview token. |
| `POST /doctors/{doctorId}/schedule-changes` | doctor (self), staff | Apply with reason code and preview token. |
| `POST /doctors/{doctorId}/time-off/preview`, `POST /doctors/{doctorId}/time-off` | doctor (self), staff | Same preview-then-apply pattern. |
| `DELETE /doctors/{doctorId}/time-off/{id}` | doctor (self), staff | Reopens slots. |
| `PATCH /doctors/{doctorId}/slot-length` | doctor (self), staff | Future slots only. |
| `GET /clinic/settings`, `PATCH /clinic/settings` | staff | Cancellation window and booking limit. |
| `GET /admin/clinics`, `POST /admin/clinics`, `PATCH /admin/clinics/{clinicId}` | admin | List, create and edit clinics. |
| `GET /admin/clinics/{clinicId}/accounts` | admin | Doctor and staff accounts: name, email, role, active. |
| `POST /admin/clinics/{clinicId}/doctors`, `POST /admin/clinics/{clinicId}/staff` | admin | Create an account and send its set-password link. |
| `PATCH /admin/accounts/{userId}` | admin | Deactivate or reactivate (R96). |
| `POST /admin/admins` | admin | Create another admin. |
| `POST /admin/specialties`, `PATCH /admin/specialties/{id}` | admin | Maintain the fixed specialty list. |

Every error has one shape: a stable code, a plain message and a request reference ID. Never a stack
trace, SQL text or personal data.

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Not signed in. |
| `FORBIDDEN` | 403 | The role may never perform this kind of action. |
| `NOT_FOUND` | 404 | Does not exist, or is outside the caller's scope (R8). |
| `VALIDATION_FAILED` | 422 | Field names and problems, never values. |
| `SLOT_TAKEN` | 409 | Lost the race. Includes the next three open slots. |
| `SLOT_UNAVAILABLE` | 409 | In the past, off the grid, or outside the schedule. |
| `BOOKING_LIMIT_REACHED` | 409 | Includes the clinic's limit. |
| `RESCHEDULE_WINDOW_CLOSED` | 409 | Patient reschedule inside the cancellation window (R34). |
| `INVALID_TRANSITION` | 409 | Not in the transition table. |
| `TOO_EARLY` | 409 | Completed or no-show before the start. |
| `PREVIEW_STALE` | 409 | Affected appointments changed since the preview. |
| `HAS_UPCOMING_APPOINTMENTS` | 409 | Doctor cannot be deactivated yet (R96). |
| `LINK_INVALID` | 410 | Reset or set-password link is used or expired (R101). |
| `RATE_LIMITED` | 429 | Too many email lookups (R92). |
| `INTERNAL` | 500 | Reference ID only. |

## 5. Flagged concerns

Open questions carried from the intents: both cited intents state "Open questions: None", so there
is nothing to answer or carry forward by name. Every row below was raised by this spec.

F1 and F2 are contradictions where both policies cannot be satisfied. Both were decided by the
Product Owner on 2026-10-09, as were F3 to F11 and F18. On the same day the Product Owner asked
Claude to choose the best option for every concern still open; F13 to F17 and F19 to F22 were
chosen that way, and each of those rows says so. The Product Owner then decided F12. No concern is
`open`. "PO" is the Product Owner, Abdul Qadir.

| # | Concern | Policies in tension | Decision or options | Owner | Status |
|---|---|---|---|---|---|
| F1 | Staff overbooking is a double booking. Both rules cannot hold. | Intent 001: "Staff can knowingly add an extra booking to a slot." Domain rules: at most one active appointment per slot, enforced by the database. Intent 001 success: "zero double bookings." | Decided by the PO, 2026-10-09: no overbooking by any role. The staff overbooking line is removed from intent 001. A slot can be booked again only once its booking is cancelled (R30, R31). R31 also counts a slot vacated by a reschedule as free, as the domain rules require; say if that should not be so. | PO | resolved |
| F2 | A patient cancelling inside the 24-hour window is blocked by one rule and allowed by another. | Intent 001, as first accepted: patients "can cancel or reschedule up to 24 hours before". Approved mocks say "You can cancel or reschedule until...". Domain rules: inside the window cancellation "is allowed but recorded as a late cancel". | Decided by the PO, 2026-10-09: allow and flag as late, as the domain rules say (R38, R39). Intent 001 was reworded to match on 2026-10-09. Follow-up not yet done: mocks 09 and 12 still say "You can cancel or reschedule until...". Reschedule stays blocked for patients inside the window (R34), because the intent says so and the domain rules are silent; a patient there can cancel but not move. | PO | resolved |
| F3 | The domain rules require "listed transitions" but list none. | Domain rules, Statuses, against itself. | Decided by the PO, 2026-10-09: the transition table in section 2 is accepted unchanged. Completed and no-show may be set straight from `requested`. Follow-up not yet done: add the table to the appointment-domain-rules skill so the rule and the spec agree. | PO | resolved |
| F4 | Staff must enter fields they may not see. Mock 09 also says "Only the clinic can see them", which is wrong under intent 002. | Intent 001: staff book for patients; date of birth and reason collected at booking. Intent 002: both are doctor-only. Privacy rule 1. | Decided by the PO, 2026-10-09: option A. Staff type the reason for visit but cannot read it back; date of birth comes from the patient's profile and is never shown to staff (R28). Also approved by the PO on 2026-10-09: when the profile has no date of birth, the booking succeeds and the patient is asked at next sign-in. Follow-up not yet done: mock 09 says "Only the clinic can see them" and must say only the patient and their doctor can. | PO | resolved |
| F5 | "The patient is informed" cannot be met by a log stub. A patient learns of a clinic cancellation only by opening the app. | Intent 002: "the patient is informed of the cancellation". Intent 001: notifications are a log stub with IDs only; SMS and email out of scope. | Decided by the PO, 2026-10-09: option A. Accepted for the MVP: the patient is informed in the app only, and the clinic phones affected patients using the list in R54. A real delivery channel for cancellations stays out of scope and is the first candidate after the MVP. | PO | resolved |
| F6 | One schedule edit can cancel many appointments with no rebooking help, and the reason may be personal to the doctor. | Intent 002: every affected appointment "is cancelled with that reason". Privacy rules 1 and 5. ux-standards, Destructive actions. | Decided by the PO, 2026-10-09: as this spec suggested. "Cancelled with that reason" means the reason is stored and visible to the clinic's staff and the doctor, not shown to the patient, who sees a neutral message (R55). The reason comes from a neutral fixed list: planned leave, unplanned absence, training, clinic closure, schedule change, other (R51). Offering replacement slots stays out of scope. | PO | resolved |
| F7 | Patients are shared across clinics, so staff search could expose other clinics' patients. | Intent 001: staff book for a patient. Intent 002: "A clinic sees no patient appointments at another clinic." Privacy rule 1. | Decided by the PO, 2026-10-09: option A. Staff search by name only among patients linked to their clinic; for a new patient, an exact email match returns the name only (R92). Accepted with it: a staff member can learn that an email address has an account. The limit of 30 lookups per hour is this spec's assumption (F21). | PO | resolved |
| F8 | Reason for visit is free text and may hold more than is needed. | Intent 001 and 002: reason for visit collected. Privacy rule 5: prefer fixed lists; if free text, say who can read it. | Decided by the PO, 2026-10-09: option A. Free text, at most 200 characters, readable by the patient and the appointment's doctor only (R20). | PO | resolved |
| F9 | Nothing defines how users sign in, recover an account, or how clinics, doctors and staff are created. | Intent 001: "All three can log in." Domain rules: roles are patient, doctor, staff only. Email is out of scope, so there is no channel for reset or verification. | Decided by the PO, 2026-10-09: add an admin role and a password reset channel (R1, R10, R93 to R103). The decision did not specify the details; those chosen by this spec are listed in F22. | PO | resolved |
| F10 | Audit events need a clinic id, but a patient's own account actions have none. Reads of patient data are not audited at all. | Privacy rule 3 against R6. | Decided by the PO, 2026-10-09: option A. Clinic id is left empty for actions that belong to no clinic (R81), and privacy rule 3 was amended on the same day to permit it. Auditing reads of patient records stays out of scope and is recommended as a follow-up. | PO | resolved |
| F11 | The mocks gate passes, but the approved mocks cover 4 of 15 screens. No doctor or staff screen is mocked. | spec-template, Gate 2. ux-standards, four states per screen. | Decided by the PO, 2026-10-09: as this spec suggested. The remaining 11 screens are to be mocked in Claude Design and approved, or waived one by one, and R91 holds each of them until then. Work not yet done: none of those mocks exists, and mocks 09 and 12 still need the copy changes from F2 and F4. | PO | resolved |
| F12 | Retention and deletion are undefined. Data is kept indefinitely and an account cannot be removed. | Privacy rule 1, minimum necessary. Neither intent covers it. | Decided by the PO, 2026-10-09: the MVP keeps data indefinitely and has no removal feature. Retention periods are decided in a later iteration, together with country-specific privacy rules, which are out of scope for this release. | PO | resolved |
| F13 | spec-template limits technology to "the stack in CLAUDE.md", but the project has no CLAUDE.md. | spec-template, Rules. | Chosen by Claude on the PO's instruction, 2026-10-09: a CLAUDE.md was added recording the stack as Next.js, TypeScript, PostgreSQL and Prisma. It allows PostgreSQL extensions and hand-written SQL migrations, which rule 1 in section 3 needs, and notes that an email delivery service is still to be chosen. | PO | resolved |
| F14 | Future notifications must link to the signed-in app, but the stub may record only type and IDs. The domain rules also emit more events than the intent names. | Privacy rule 4. Intent 001: stub records "only the event type and opaque identifiers"; names booking, cancelling, rescheduling. Domain rules: every state change emits an event. | Chosen by Claude on the PO's instruction, 2026-10-09: all six events are emitted (R73), the stub holds only type and IDs (R75), and a link to the signed-in app is built from the appointment id once a real channel exists. This satisfies both sources: the domain rule's list contains the intent's three events. | PO | resolved |
| F15 | Whether a doctor can work at more than one clinic is unstated. | Intent 001: "doctors in that clinic." | Chosen by Claude on the PO's instruction, 2026-10-09: a doctor belongs to exactly one clinic (R5). It matches the wording of both intents and keeps clinic scoping simple. Allowing several clinics later alters the data model. | PO | resolved |
| F16 | Status after a reschedule, and of a staff-made booking, is unstated. | Intent 002: "A booking holds its slot before staff or the doctor mark it confirmed." | Chosen by Claude on the PO's instruction, 2026-10-09: a patient reschedule returns the appointment to `requested`, so the clinic confirms the new time; a staff or doctor reschedule keeps the status; staff bookings start `confirmed` (R29, R36). | PO | resolved |
| F17 | "Date of birth or age" does not say which the doctor sees. | Intent 002, Constraints. Privacy rule 1. | Chosen by Claude on the PO's instruction, 2026-10-09: option A, age only. It is the lesser disclosure and privacy rule 1 asks for the minimum necessary. | PO | resolved |
| F18 | A wrongly recorded no-show cannot be corrected, and it raises a count that staff and doctors see. | Intent 002: no-show count shown. Domain rules: only listed transitions. | Decided by the PO, 2026-10-09: completed and no-show are final, with no correction in this release. | PO | resolved |
| F19 | Whether doctors and slots can be browsed before signing in is unstated. | Intent 001: account needed "to book". Success: book in under a minute. | Chosen by Claude on the PO's instruction, 2026-10-09: option A, sign-in first (R16). It matches the approved mocks, which all show a signed-in patient. Public browsing can be added later without changing the booking flow. | PO | resolved |
| F20 | Booking parameters are unstated: how far ahead a patient can book, whether the limit of 3 applies to staff bookings, and who may change clinic settings. | Intent 001: limit and window "configurable per clinic". | Chosen by Claude on the PO's instruction, 2026-10-09: patients can book up to 90 days ahead (R24); the limit applies to staff bookings too, in line with the no-exceptions decision on F1; any staff member of the clinic may change the clinic's limit and window (R25). | PO | resolved |
| F21 | Smaller assumptions made by this spec, and the measurement of success. | No source covers them. | R13, R14, R19, R27, R32, R42, R47, R56, R57, R77, R82, and the lookup limit in R92. Also: "under a minute" is measured for a signed-in patient from "Find a doctor" to "Booked"; "zero double bookings" is measured as no overlapping active appointments per doctor. Chosen by Claude on the PO's instruction, 2026-10-09: all of these stand as written. | PO | resolved |
| F22 | The F9 decision adds an admin role and a reset channel without details, and it departs from documents that name three roles and exclude email. | PO decision on F9. Domain rules, Roles: "patient, doctor, staff". Intent 001: "Roles: patients, doctors and clinic staff"; out of scope "SMS/email reminders". Privacy rule 1 gives no access rule for an admin. spec-template: no technology beyond the stack. | This spec assumes: one platform-wide admin role with no clinic and no access to patient or appointment data (R93, R94); first admin created at deployment (R95); a doctor with upcoming appointments cannot be deactivated (R96); sign-in by email and password (R98); reset by emailed single-use link valid 30 minutes (R100). Reset email is treated as an account message, not a reminder. Chosen by Claude on the PO's instruction, 2026-10-09: all of these stand. A clinic-level admin and admin read access to appointments were rejected, the second because privacy rule 1 gives an admin no need for patient data. Follow-ups not yet done: add the admin role and its access rule to the domain and privacy skills and to intent 001; engineering chooses the email delivery service at build time and records it in CLAUDE.md. | PO | resolved |

## 6. Out of scope

Excluded by the cited intents:

- Payments
- SMS and email reminders
- Waitlists
- Video consults
- Insurance
- Reviews
- Native mobile apps
- Compliance with a specific country's regulation
- Guest booking
- Distance-based location search
- Languages other than English
- No-show follow-up of any kind (intent 001 and intent 002)
- Overbooking a slot, by any role
- A real notification channel (stub only)
- Preferences on hosting, budget, expected scale and mobile support (none stated)

Excluded by this spec:

- Any consequence of a late cancel beyond recording it
- Patient rescheduling inside the cancellation window
- Admin access to patient or appointment data
- Clinic-level admins (the admin role is platform-wide)
- Email verification at registration, and any email other than reset and set-password links
- Doctors working at more than one clinic
- Rescheduling to a different doctor
- Offering replacement slots after a schedule-change cancellation
- Correcting a recorded outcome
- Clinical notes
- Recurring appointments and appointment types of different lengths
- Recording who viewed a patient record
- Data export, retention periods and account deletion; data is kept indefinitely in the MVP (F12)
