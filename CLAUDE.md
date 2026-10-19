# CLAUDE.md

MediBook: multi-tenant appointment booking for small clinics. Behavior is defined in
`docs/001-appointment-booking/spec.md`; build order is in `docs/001-appointment-booking/plan.md`. Stream 0
(the foundation) is built and its files are frozen: Streams A and B do not edit them (plan.md, "Shared files").

## Commands

- `make db` starts Postgres (`docker compose up -d db`). `make migrate` applies migrations and generates the
  Prisma client. `make seed` loads fictional clinics, doctors, staff and patients (`node prisma/seed.ts`).
- `make run` starts the dev server. `make build` builds and type-checks. `make lint` runs ESLint.
- `make test` runs `vitest run`: unit tests, and integration tests against real Postgres.
- `make check` runs lint, then test, then build, and stops at the first failure.
- Tests need `DATABASE_URL` and `TEST_DATABASE_URL` (copy `.env.example` to `.env`). The test database is
  created and migrated by the test run and emptied by every test file.

## Conventions

- Times are stored in UTC. Only `src/domain/time.ts` converts to clinic time and imports `@js-temporal/polyfill`.
- Database sessions run in UTC. `src/lib/db.ts` sets this on every connection; create clients only there.
- Every route handler is built with `route()` from `src/lib/route.ts`, which in this order: authenticates with
  `getSession()`, authorizes by role and clinic, validates input against a `zod` schema (shared ones are in
  `src/lib/schemas.ts`), then acts.
- Record-level scope comes from `src/lib/scope.ts`. Out of scope is `NOT_FOUND`, the same as missing.
- Every state change writes an audit event through `src/lib/audit.ts`, with ids only.
- All logging goes through `src/lib/logger.ts`, opaque ids only: never names, emails, phones, birth dates,
  reasons or notes.
- Appointment status changes go through `src/domain/transitions.ts`; never set status directly. Only
  `src/lib/appointments/core.ts` inserts, moves or changes the status of an appointment.
- Appointment responses are built by `src/lib/serialize.ts` from the per-role field lists in
  `src/domain/visibility.ts`. Never return a database row.
- Errors are `AppError` with a code from `src/lib/errors.ts`. Auth is a development stand-in (header
  `x-dev-user-id`); do not treat it as real authentication.

## Architecture

- `src/domain`: pure logic, no database imports; unit tests live next to the code. `src/app/api`: thin handlers.
- `prisma/`: schema, migrations, seed. Tests: `tests/helpers`, `tests/integration`, `tests/architecture.test.ts`.
- `src/lib`: database client, logger, audit, session, building blocks above. `src/lib/appointments`: appointment core.
- `src/lib/patient`: patient use cases (Stream A). `src/lib/clinic`: doctor and staff use cases (Stream B).
- `src/components`: shared UI (clinic time, four-state wrapper, confirmation dialog, error message, labelled field).

## Things Claude gets wrong

- Never edit a committed file in `prisma/migrations`. Add a new migration.
- No free-text reason fields for staff or doctors. Use reason codes. The one free-text reason is the
  patient's reason for visit (spec R20, decision F8).
- A booking unique-violation returns 409. Never retry it silently. Do not mock the database in booking tests.
- A route under `/appointments/` returns one appointment: it imports from `@/lib/serialize` and responds with
  `appointment: await readAppointment(...)` (`tests/architecture.test.ts`, R83). A list of appointments goes at
  another path and builds them with `readAppointments`, as `/clinic/schedule` does.
- Every clinic route resolves ids through src/lib/scope.ts; a bare findUnique by id is a bug.
- A reschedule that loses a race returns the conflict error with alternative slots. Never retry the taken slot on the server (INC-20261015-0415).

## Verifying your work

- Before saying a task is done, run `make check` and paste the last 20 lines of its output.
- Healthy output: lint prints no errors, vitest ends with all tests passed and none failed, build has no errors.
- "Done" means `make check` exits 0 and the new behavior has a test that failed before the change.
- For a bug fix, write the failing test first, show it failing for the expected reason, and never edit that
  test afterwards.
- For a UI change, save a Playwright screenshot, compare it with the approved mock in
  `docs/001-appointment-booking/mocks/`, and list what still differs.
- If the same check fails twice for the same reason, stop and say what you tried.
