# MediBook MVP implementation plan
Spec: docs/001-appointment-booking/spec.md  
Mocks: docs/001-appointment-booking/mocks.md (status: approved)  
Date: 2026-10-12. Status: approved. Amended 2026-10-12 (see Amendments)

## Amendments

Changes made to this plan while Stream 0 was built, each in the same commit as the code.

1. **Double booking is prevented by a partial unique index, not an exclusion constraint.**
   Decided by the Product Owner, 2026-10-12. The index
   `Appointment_one_active_per_doctor_start` allows at most one active (requested or confirmed)
   appointment per doctor and start time. There is no `btree_gist` extension and no exclusion
   constraint. The exclusion constraint is recorded under Options rejected. What this leaves to
   the application is in Risks 3.
2. **The tenant-consistency keys are declared in `prisma/schema.prisma`,** so they are in the
   generated migration, not the hand-written one. Prisma sees foreign keys; one it did not know
   would be dropped by the next generated migration (Risks 8).
3. **Database sessions are pinned to UTC,** in the hand-written migration and in
   `src/lib/db.ts`. Prisma's PostgreSQL adapter reads and writes timestamps as if the session
   zone were UTC; on a server with another default zone every stored instant was shifted by
   that zone's offset. Found by `constraints.test.ts` (R67).
4. **Small additions to the file list:** `.gitignore` (Playwright output), a `postinstall`
   script in `package.json` that generates the Prisma client, `allowImportingTsExtensions` in
   `tsconfig.json` so `make seed` runs `prisma/seed.ts` with plain Node, and two components the
   stand-in session needs (the site header and the development user chooser, both in
   `src/components/`).
5. **The home page holds a development user chooser.** The stand-in session reads a header,
   which a browser cannot set on its own, so `src/app/page.tsx` lets a developer choose a seeded
   user. It is not the sign-in screen of R91 and does not work in production.
6. **The fixed list for staff and doctor cancellations (R41) is chosen here,** because the spec
   requires a list and gives none: patient request, doctor unavailable, booked in error, clinic
   closure, other. Product Owner should confirm.

## Context

The repo is a skeleton: `prisma/schema.prisma` has no models, there is no `src/`, and no tests.
Behavior is fixed by `docs/001-appointment-booking/spec.md` (R1 to R103, all 22 concerns
resolved), the two accepted intents, `CLAUDE.md`, and the domain, privacy and UX skills. This plan
turns that into a build order in which a sequential foundation (Stream 0) is finished first and two
streams (A: patient, B: doctor and staff) then run in parallel without touching the same file.

Things found while reading that shape the plan:

- **The spec said `Status: draft`.** The Product Owner set it to approved on 2026-10-12, before
  Stream 0 was built.
- **Scope of this plan is the three streams as requested.** Real sign-in, password reset and the
  admin role (R93 to R103, and the sign-in half of R1, R10, R98) are in no stream. They are
  deferred; a seed script stands in for the admin. See Risks 1.
- **R91 blocks most screens.** 4 of 15 screens have approved mocks, all patient screens. Every
  Stream B screen, and the patient cancel-confirmation and reschedule screens, cannot be built
  until mocked and approved or waived. Their APIs and tests are not blocked.
- **`CLAUDE.md` names `docs/001-appointment-booking/plan.md`, which does not exist.** The first
  step after approval is to save this plan there.
- **The skeleton has `app/` at the root, `CLAUDE.md` says `src/app/api`.** Next.js does not allow
  both. Everything moves under `src/`, which is also the only place the PII log hook checks.

## Files that change

Ownership is by file. After Stream 0 is merged, each file below has exactly one owner.

### Stream 0 (foundation, sequential)

Project and config:

- `docs/001-appointment-booking/plan.md` (new: this plan)
- `CLAUDE.md` (add: use-case code lives in `src/lib/appointments/`, `src/lib/patient/`,
  `src/lib/clinic/`; new make targets; the chosen time zone and validation libraries)
- `package.json`, `package-lock.json` (add a schema validation library, the Prisma PostgreSQL
  driver adapter, one time zone library, Playwright and an accessibility checker)
- `tsconfig.json` (point `@/*` at `src/`)
- `eslint.config.mjs` (forbid database imports in `src/domain/`, forbid `console.*` in `src/`)
- `Makefile` (add `migrate` and `seed`; `test` unchanged)
- `.env.example` (add the test database URL)
- `.gitignore` (ignore Playwright output)
- `vitest.config.ts` (new: unit project and a serial integration project)
- `playwright.config.ts` (new)
- `app/.gitkeep` (delete; `app/` is replaced by `src/app/`)

Data model and migrations:

- `prisma/schema.prisma` (all entities in spec section 3 except PasswordResetToken and
  credentials, plus two additions: an idempotency key on Appointment, and a staff lookup log for
  the R92 rate limit)
- `prisma/migrations/` (new directory; migration 1 is generated tables, including the
  tenant-consistency keys; migration 2 is hand-written SQL: UTC sessions, the partial unique
  index on doctor and start time for active appointments, end-after-start checks, and triggers
  that refuse update, delete and truncate on audit events)
- `prisma/seed.ts` (fictional clinics in different time zones, doctors, staff, patients,
  specialties)

Pure domain, each with a colocated test file:

- `src/domain/time.ts`, `src/domain/time.test.ts` (the only place that converts time zones)
- `src/domain/slots.ts`, `src/domain/slots.test.ts` (slot generation, open-slot calculation)
- `src/domain/transitions.ts`, `src/domain/transitions.test.ts` (the R64 table)
- `src/domain/window.ts`, `src/domain/window.test.ts` (cancellation window, late flag, deadline)
- `src/domain/visibility.ts`, `src/domain/visibility.test.ts` (per-role field lists, R59 and R83)
- `src/domain/reason-codes.ts` (cancel and schedule-change reason lists)

Library:

- `src/lib/db.ts` (database client; query logging with values only in local development)
- `src/lib/logger.ts` (accepts an event name and opaque ids, nothing else)
- `src/lib/audit.ts`
- `src/lib/session.ts` (`getSession()` from header `x-dev-user-id`; refuses inactive users;
  refuses to run in production)
- `src/lib/errors.ts` (the one error shape and the code table of spec section 4)
- `src/lib/route.ts` (wrapper that runs authenticate, authorize, validate, act in that order, adds
  the request reference id, and maps errors)
- `src/lib/scope.ts` (clinic and role scoping; out-of-scope equals not found, R8)
- `src/lib/schemas.ts` (shared input schemas: ids, instants, reason codes)
- `src/lib/notifications.ts` (adapter interface and the log adapter)
- `src/lib/serialize.ts` (builds responses from `src/domain/visibility.ts`)
- `src/lib/open-slots.ts` (loads hours, breaks, time off and active appointments, calls
  `src/domain/slots.ts`)
- `src/lib/appointments/core.ts` (the only code that inserts an appointment, moves it, or changes
  its status; does locking, slot re-check, booking limit, history, audit and notification in one
  transaction, refuses an overlap with a different start time, and maps the unique violation to
  `SLOT_TAKEN`)

Shared route handlers, written complete in Stream 0 as role dispatchers and then frozen:

- `src/app/api/v1/appointments/route.ts` (book: patient or staff)
- `src/app/api/v1/appointments/[id]/route.ts` (read, by role)
- `src/app/api/v1/appointments/[id]/reschedule/route.ts`
- `src/app/api/v1/appointments/[id]/cancel/route.ts`

Placeholders Stream 0 creates with fixed signatures, each handed to one stream:

- `src/lib/patient/book.ts`, `src/lib/patient/reschedule.ts`, `src/lib/patient/cancel.ts`
  (to Stream A)
- `src/lib/clinic/book.ts`, `src/lib/clinic/reschedule.ts`, `src/lib/clinic/cancel.ts`
  (to Stream B)

Shared interface:

- `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css` (navigation for all roles is
  written once here, with every final link)
- `src/components/` (clinic-time display with zone abbreviation, four-state wrapper, confirmation
  dialog, error message, labelled field, site header, development user chooser)
- `src/lib/api-client.ts`

Tests and helpers:

- `tests/helpers/` (test database reset, fictional factories, request helper that sets
  `x-dev-user-id`, fixed clock)
- `tests/integration/foundation/` (`constraints.test.ts`, `core.test.ts`, `audit.test.ts`,
  `logger.test.ts`, `session.test.ts`, `route.test.ts`, `notifications.test.ts`)
- `tests/architecture.test.ts` (static rules: see Proof)

### Stream A (patient)

- `src/lib/patient/` (the three files handed over, plus `search.ts`, `appointments.ts`,
  `profile.ts`)
- `src/app/api/v1/specialties/route.ts`
- `src/app/api/v1/doctors/route.ts`
- `src/app/api/v1/doctors/[doctorId]/route.ts`
- `src/app/api/v1/doctors/[doctorId]/slots/route.ts`
- `src/app/api/v1/me/appointments/route.ts`
- `src/app/api/v1/me/profile/route.ts`
- `src/app/patient/` (Find a doctor, Doctor profile, Confirm booking, My appointments; the cancel
  confirmation and reschedule screens only after their mocks are approved)
- `tests/integration/patient/`
- `tests/e2e/patient/`

### Stream B (doctor and staff)

- `src/lib/clinic/` (the three files handed over, plus `outcomes.ts`, `schedule-view.ts`,
  `schedule-settings.ts`, `schedule-change.ts`, `time-off.ts`, `patient-lookup.ts`, `settings.ts`)
- `src/domain/schedule-impact.ts`, `src/domain/schedule-impact.test.ts` (which appointments no
  longer fit a changed schedule; the preview token)
- `src/app/api/v1/appointments/[id]/confirm/route.ts`
- `src/app/api/v1/appointments/[id]/complete/route.ts`
- `src/app/api/v1/appointments/[id]/no-show/route.ts`
- `src/app/api/v1/clinic/` (`schedule/route.ts`, `settings/route.ts`,
  `patients/search/route.ts`, `patients/[patientId]/route.ts`)
- `src/app/api/v1/doctors/[doctorId]/schedule-settings/route.ts`
- `src/app/api/v1/doctors/[doctorId]/schedule-changes/` (`route.ts`, `preview/route.ts`,
  `[changeId]/route.ts`; the last is the R54 list of cancelled appointments, which the API sketch
  does not have)
- `src/app/api/v1/doctors/[doctorId]/time-off/` (`route.ts`, `preview/route.ts`,
  `[id]/route.ts`)
- `src/app/api/v1/doctors/[doctorId]/slot-length/route.ts`
- `src/app/clinic/` (all screens; none may be built until mocked and approved, R91)
- `tests/integration/clinic/`
- `tests/e2e/clinic/` (after mocks)

Streams A and B both add files under `src/app/api/v1/doctors/[doctorId]/` and
`src/app/api/v1/appointments/[id]/`, but never the same file.

### Not changed

`docs/001-appointment-booking/spec.md` (apart from its status line, set by the Product Owner),
`intent/`, `.claude/`, `docker-compose.yml`, `prisma.config.ts`, `next.config.ts`.

## Order of work

### Before Stream 0

1. Product Owner sets the spec to approved, and decides Risks 1 and 2.
2. Save this plan as `docs/001-appointment-booking/plan.md`.

### Stream 0: foundation, strictly in this order

1. **Project layout.** Move to `src/`, update `tsconfig.json`, `eslint.config.mjs`,
   `package.json`, `Makefile`, `.env.example`, `vitest.config.ts`, `playwright.config.ts`,
   `CLAUDE.md`. Add `tests/helpers/` and `tests/architecture.test.ts`.
2. **Data model and migrations.** `prisma/schema.prisma`, then the generated migration, then the
   hand-written constraints migration. Review both before committing: the path-protection hook
   makes a committed migration immutable. Prove with `constraints.test.ts`. Then `prisma/seed.ts`.
3. **Time zone helpers.** `src/domain/time.ts` with its tests, including both daylight-saving
   changes.
4. **Slot generation.** `src/domain/slots.ts` on top of the time helpers, then
   `src/lib/open-slots.ts`.
5. **Appointment status transitions.** `src/domain/transitions.ts`, `src/domain/window.ts`,
   `src/domain/reason-codes.ts`.
6. **Logger.** `src/lib/logger.ts`.
7. **Audit.** `src/lib/audit.ts`.
8. **Development session stand-in.** `src/lib/session.ts`, then `src/lib/scope.ts`,
   `src/lib/errors.ts`, `src/lib/schemas.ts`, `src/lib/route.ts`.
9. **Visibility and notifications.** `src/domain/visibility.ts`, `src/lib/serialize.ts`,
   `src/lib/notifications.ts`.
10. **Appointment core.** `src/lib/appointments/core.ts`, proven by `core.test.ts`, including the
    concurrency cases against the real database.
11. **Shared routes and placeholders.** The four shared route files and the six placeholder files.
12. **Shared interface.** `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`,
    `src/components/`, `src/lib/api-client.ts`.
13. **Gate.** `make lint`, `make build` and `make test` pass. Merge to `main`. From here every
    Stream 0 file is frozen.

### Shared files Stream 0 must finish before A and B start

Both streams depend on every one of these, and neither may edit them:

`prisma/schema.prisma`, `prisma/migrations/`, `prisma/seed.ts`, `package.json`,
`package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`,
`playwright.config.ts`, `Makefile`, `.env.example`, `CLAUDE.md`, `src/domain/time.ts`,
`src/domain/slots.ts`, `src/domain/transitions.ts`, `src/domain/window.ts`,
`src/domain/visibility.ts`, `src/domain/reason-codes.ts`, `src/lib/db.ts`, `src/lib/logger.ts`,
`src/lib/audit.ts`, `src/lib/session.ts`, `src/lib/errors.ts`, `src/lib/route.ts`,
`src/lib/scope.ts`, `src/lib/schemas.ts`, `src/lib/notifications.ts`, `src/lib/serialize.ts`,
`src/lib/open-slots.ts`, `src/lib/appointments/core.ts`, `src/lib/api-client.ts`,
`src/app/api/v1/appointments/route.ts`, `src/app/api/v1/appointments/[id]/route.ts`,
`src/app/api/v1/appointments/[id]/reschedule/route.ts`,
`src/app/api/v1/appointments/[id]/cancel/route.ts`, `src/app/layout.tsx`, `src/app/page.tsx`,
`src/app/globals.css`, `src/components/`, `tests/helpers/`, `tests/architecture.test.ts`.

If a stream finds it needs one of these changed, it stops and the change is made once on `main` as
a foundation patch (a new migration if it is a schema change); both streams then update from
`main`. Neither stream edits the file in its own branch.

### Stream A: patient (parallel with B)

1. Doctor search: `GET /specialties`, `GET /doctors` (R11 to R14, R16).
2. Doctor profile and open slots (R15).
3. Patient profile read and correct, for date of birth (R19).
4. Booking as a patient: `src/lib/patient/book.ts` (R17 to R27, R6).
5. My appointments (R45 to R47).
6. Rescheduling as a patient: `src/lib/patient/reschedule.ts` (R32 to R34, R36, R37).
7. Cancelling as a patient: `src/lib/patient/cancel.ts` (R38 to R40, R44).
8. The four approved screens, with the copy corrections of F2 and F4, and their end-to-end tests.
9. Cancel-confirmation and reschedule screens, once mocked and approved.

### Stream B: doctor and staff (parallel with A)

1. Schedule settings read; working hours and breaks; slot length (R48 to R50, R56).
2. `src/domain/schedule-impact.ts`, then preview and apply for schedule changes (R51 to R55).
3. Time off: preview, add, remove (R51 to R54, R57).
4. Daily and weekly views (R58 to R61, R66).
5. Confirm, complete, no-show: `src/lib/clinic/outcomes.ts` (R62 to R65).
6. Cancel as staff or doctor: `src/lib/clinic/cancel.ts` (R41, R42, R44).
7. Reschedule as staff or doctor: `src/lib/clinic/reschedule.ts` (R35, R36).
8. Staff booking and patient lookup: `src/lib/clinic/book.ts`,
   `src/lib/clinic/patient-lookup.ts` (R28 to R30, R92). The request names Stream A for booking,
   but these are staff actions on a different file, so they sit here.
9. Clinic settings (R25, R40).
10. Screens, each only after its mock is approved.

## Risks

1. **Three spec areas are in no stream.** Sign-in with email and password, password reset and
   set-password links (R98 to R103), and admin functions (R93 to R97). `CLAUDE.md` says auth is a
   stand-in. With the plan as written the MVP is not deployable to real users. Recommended: a
   Stream C after A and B; it needs new migrations and an email service not yet chosen (F22).
2. **`CLAUDE.md` said "No free-text reason fields", but R20 makes reason for visit free text**
   (decided by the Product Owner, F8). This plan reads the `CLAUDE.md` rule as covering reasons
   recorded by staff and doctors, and builds R20 as specified. Accepted by the Product Owner,
   2026-10-12; the wording in `CLAUDE.md` is corrected.
3. **The unique index covers equal start times only.** It does not see two active appointments
   that overlap with different starts. On one slot grid that cannot happen: slots of one length
   that start at different grid points do not overlap. It can happen after a slot-length change
   (R56), when an older, longer appointment overlaps a new grid point. That case is refused by
   the slot re-check in `src/lib/appointments/core.ts`, which is application code, so the
   database enforces R22 for equal starts only. Two consequences. A slot-length change must
   take the exclusive doctor lock of Risks 5 (Stream B). And spec section 3 rule 1 and R22
   still describe the exclusion constraint; the Product Owner should reword them.
   `constraints.test.ts` pins down what the index does and does not cover, and `core.test.ts`
   proves the core refuses the overlap. The conflict is an ordinary unique violation, which
   Prisma reports with the index name; the core maps it to `SLOT_TAKEN`.
4. **Idempotent replay versus "never retry silently".** R27 returns the original appointment for a
   repeated key; that is a replay of a stored result, not a retry of a conflict. The two cases
   must stay distinct in the core.
5. **A booking can race a schedule change.** A booking could land in hours being removed, after
   the affected set was computed. Mitigation: the core takes a shared lock on the doctor for
   bookings and moves, and schedule changes take an exclusive one; the affected set is recomputed
   under that lock (R53).
6. **Daylight saving edge cases the spec does not settle.** A break or working-hours boundary that
   falls in a repeated hour, or a start time that falls in a skipped hour. The plan takes the
   earlier occurrence, and the first instant after the gap. Product Owner should confirm.
7. **Search ordering is computed, not stored.** "Next open slot" needs slot calculation for every
   matching doctor before the first page can be ordered. Acceptable with no stated scale; it is
   the first thing to slow down.
8. **Prisma cannot see the hand-written constraints.** A later generated migration could drop or
   ignore them. `constraints.test.ts` runs against the migrated database on every test run.
9. **A wrong first migration is permanent.** The hook blocks edits once committed; mistakes are
   corrected only by a further migration.
10. **The PII log hook matches words.** A log line containing words such as name, reason, note or
    address is blocked even when harmless. Log calls carry an event code and ids only.
11. **The stand-in session trusts a header.** It must refuse to run in production.
12. **Parallel streams drift from `main`.** A foundation patch during A and B forces both to
    update. Keeping Stream 0 complete, especially the schema, is what keeps this rare.
13. **Unfinished follow-ups in the spec:** mocks 09 and 12 still carry the old copy (F2, F4); the
    transition table and admin role are not yet in the skills (F3, F22), and editing the skills
    changes the tree hash in the spec header.
14. **"Under a minute" and "informed of the cancellation"** depend on the interface and on the
    clinic phoning patients (F5); neither can be proven by API tests alone.

## Options rejected

- **An exclusion constraint on doctor and time range (`btree_gist`), for the MVP.** Rejected by
  the Product Owner, 2026-10-12, in favour of the partial unique index on doctor and start
  time. It would also refuse overlaps with different start times at the database, which the
  index leaves to the core (Risks 3). It can be added later by a new migration without changing
  callers.
- **Preventing double booking in application code only, with advisory locks, or with
  serializable isolation alone.** The domain rule requires the database to enforce it; the
  unique index does, for equal start times.
- **Storing slots as rows.** The spec computes them; stored slots would need regenerating on every
  schedule change.
- **Splitting the streams by layer (API, then interface).** Both would edit the same routes.
- **Letting A and B each edit the shared book, reschedule and cancel routes and merging later.**
  Rejected for the dispatcher-plus-owned-file arrangement above.
- **Giving all booking, rescheduling and cancelling for every role to Stream A.** It would make
  Stream B wait on A for staff and doctor actions.
- **Use-case code in route handlers or in `src/domain/`.** Handlers must stay thin and the domain
  may not import the database.
- **Building real sign-in in Stream 0.** Outside the requested foundation; see Risks 1.
- **Row-level security now.** The spec recommends it as a second layer; deferred so the first
  layer is proven first.
- **Mocking the database in tests.** Forbidden for booking tests, and it cannot prove the
  constraint.
- **Hand-written offset arithmetic, or date handling spread across files.** One library, imported
  only by `src/domain/time.ts`.
- **Reading staff history from the audit log.** R84 forbids it.
- **Writing notifications straight to the log.** R77 needs the event in the same transaction.
- **A stored no-show counter.** The spec computes it by query.
- **Retrying a lost booking race on the next slot.** Always a 409 with the next three slots.
- **Building screens that have no approved mock.** R91.
- **Sequential or time-ordered ids.** R9 requires random ids.

## Proof

Unit tests are colocated in `src/domain/`. Integration tests run against real PostgreSQL from
`make db`. End-to-end tests use Playwright. All run under `make test`, with `make lint` and
`make build`.

### Foundation

| Requirement | Test |
|---|---|
| R1 (roles) | `tests/integration/foundation/session.test.ts`: resolves each of the four roles and its clinic from the header |
| R3, R5 | `constraints.test.ts`: appointment, schedule and staff rows require a clinic; an appointment's clinic must equal its doctor's |
| R9 | `constraints.test.ts`: every id is a random identifier |
| R22, R30 | `constraints.test.ts`: the database refuses a second active appointment for the same doctor and start time, inserted directly, and on a move; `core.test.ts`: the core refuses an overlap with a different start time |
| R64 | `src/domain/transitions.test.ts`: every from, to and role combination outside the table is refused |
| R63 | `transitions.test.ts`: completed and no-show are refused before the start |
| R40 | `src/domain/window.test.ts`: the window is elapsed time, correct across a clock change |
| R67, R68 | `constraints.test.ts`: instants round-trip as UTC; `src/domain/time.test.ts`: an unknown zone is rejected |
| R69 | `tests/architecture.test.ts`: only `src/domain/time.ts` imports the time zone library |
| R71 | `src/domain/slots.test.ts`: no slot in the skipped hour; slots for both occurrences of the repeated hour |
| R72 | `time.test.ts`: the repeated hour is labelled with two different abbreviations |
| R24 (rules) | `slots.test.ts`: past, beyond 90 days, outside hours, in a break, in time off, off the grid, occupied |
| R73, R77 | `tests/integration/foundation/core.test.ts`: each of the six changes writes one event; a rolled-back change leaves none |
| R74, R75, R76 | `notifications.test.ts`: the log adapter is called; the event has only type, timestamp and four ids; a substitute adapter needs no caller change |
| R78, R79 | `logger.test.ts`: non-id fields are refused; `route.test.ts`: bodies and query values are absent from log output |
| R81 | `audit.test.ts`: each core mutation writes all seven fields; clinic id is empty only for a patient's own profile change |
| R82 | `audit.test.ts`: update, delete and truncate on audit events fail at the database |
| R83, R59 (lists) | `src/domain/visibility.test.ts`: each role's field list equals the table; `architecture.test.ts`: every handler responds through the serializer |
| R88, R89 | `route.test.ts`: one error shape with a reference id; validation errors name the field and omit the value |
| R85 | `architecture.test.ts`: no source text claims compliance |
| Conventions | `architecture.test.ts`: no database import in `src/domain/`; status is written only by the core; every route uses the wrapper |

### Stream A, in `tests/integration/patient/` and `tests/e2e/patient/`

| Requirement | Test |
|---|---|
| R2, R16 | `search.test.ts` and `book.test.ts`: search, profile, slots and booking return 401 without a session |
| R7, R8 | `scope.test.ts`: another patient's appointment returns the same body as a missing one |
| R11, R12 | `search.test.ts`: name, specialty and location filters, alone and combined, ignoring case |
| R13, R14 | `search.test.ts`: availability periods; listed fields only; earliest next slot first; 20 per page |
| R15 | `profile-slots.test.ts`: listed fields; slots grouped by date; later dates load |
| R17 | `book.test.ts`: reading slots creates no row; `booking.spec.ts`: nothing is booked before "Confirm booking" |
| R18, R20 | `book.test.ts`: both fields required; reason over 200 characters refused |
| R19 | `profile.test.ts`: date of birth is stored once, not asked again, and can be corrected |
| R6 | `book.test.ts`: the first booking at a clinic creates the link, the second does not repeat it |
| R21, R31 | `book.test.ts`: a new booking is `requested` and its slot is no longer open; `cancel.test.ts` and `reschedule.test.ts`: the freed slot is open again |
| R23 | `book-concurrency.test.ts`: simultaneous bookings for one slot give one success, the rest `SLOT_TAKEN` with three slots, one row; `booking.spec.ts`: typed values remain |
| R24 | `book.test.ts`: each unbookable case returns `SLOT_UNAVAILABLE` |
| R25 | `book.test.ts`: the booking over the limit returns `BOOKING_LIMIT_REACHED`; `book-concurrency.test.ts`: two at once at one below the limit, one succeeds |
| R26, R46 | `booking.spec.ts` and `my-appointments.spec.ts`: count used, deadline and actions are shown |
| R27 | `book.test.ts`: the same idempotency key twice gives one appointment |
| R32, R33 | `reschedule.test.ts`: moves within the same doctor only; a lost race leaves the appointment unchanged |
| R34, R36, R37 | `reschedule.test.ts`: refused inside the window; `confirmed` returns to `requested`; reason and origin kept, history added |
| R38, R39 | `cancel.test.ts`: not flagged outside the window; flagged late inside it, and the response says so |
| R44, R47, R55 | `my-appointments.test.ts`: status labels, "Cancelled by you" or "by the clinic", no reason code |
| R45, R61 | `my-appointments.test.ts`: own appointments across clinics, upcoming and past, nobody else's |
| R70 | `booking.spec.ts`: times show the clinic zone when the browser is in another zone |
| R86, R87 | `states.spec.ts`: four states per approved screen; `a11y.spec.ts`: labels, keyboard, focus, contrast, target size |
| Success criterion | `booking.spec.ts`: search to "Booked" completes inside a minute |
| R43 (patient) | `cancel.spec.ts`: confirmation states the consequence. Blocked until the screen is mocked |

### Stream B, in `tests/integration/clinic/`

| Requirement | Test |
|---|---|
| R4, R7, R8, R48 | `scope.test.ts`: a doctor edits only their own schedule, staff only their clinic's; anything else is not found |
| R49, R50 | `working-hours.test.ts`: settings hold hours, breaks, time off and slot length; hours are wall-clock, time off is stored as instants |
| R51 | `schedule-change.test.ts`: a change without a listed reason code is refused |
| R52 | `schedule-change.test.ts`: affected appointments are cancelled with the reason; a forced failure leaves hours and appointments untouched. Rule in `src/domain/schedule-impact.test.ts` |
| R53 | `schedule-change.test.ts`: preview gives count and dates; a booking made after the preview causes `PREVIEW_STALE` |
| R54 | `schedule-change.test.ts`: one notification and one audit event per cancellation; staff list has name and phone, doctor list has no phone |
| R56, R57 | `slot-length.test.ts`: existing appointments are kept; `time-off.test.ts`: removal reopens slots and restores nothing |
| R58 | `schedule-view.test.ts`: day and week; doctor sees own; staff choose a doctor of their clinic |
| R59, R60, R66, R84 | `visibility.test.ts`: response keys per role match the table; another doctor's appointment is not found; no-show count is for this clinic only; history comes from appointment history |
| R62, R65 | `outcomes.test.ts`: confirm, complete and no-show by staff and by the appointment's doctor; a no-show changes nothing else |
| R63, R64 | `outcomes.test.ts`: `TOO_EARLY` before the start; `INVALID_TRANSITION` changes nothing |
| R41, R42, R44 | `cancel.test.ts`: reason code required from the list; never flagged late; cancelling role recorded |
| R35, R36 | `reschedule.test.ts`: allowed inside the window up to the start; status unchanged |
| R28, R29, R30 | `staff-booking.test.ts`: booked-by recorded; reason not returned; date of birth never returned; works with none on file; starts `confirmed`; occupied slot refused |
| R25, R40 | `staff-booking.test.ts`: the limit applies to staff bookings; `settings.test.ts`: staff change limit and window, and both take effect |
| R92, R80 | `patient-lookup.test.ts`: name search covers linked patients only; exact email returns the name only; the 31st lookup in an hour is `RATE_LIMITED`; the term travels in the body |
| R43, R86, R87 (clinic) | `tests/e2e/clinic/`: blocked until the screens are mocked |

### Not proven by a test in this plan

- R90 (English only) and R91 (mock gate): checked in review.
- R10, R93 to R103, and sign-in under R1: not built (Risks 1).

### End-to-end check

1. `make db`, `make migrate`, `make seed`, `make run`.
2. As a seeded patient: search, open a profile, book, see it under My appointments.
3. As seeded staff of that clinic: confirm it, then add time off covering it and accept the
   preview. As the patient: it shows "Cancelled by the clinic".
4. Read the application log: event types and ids only.
