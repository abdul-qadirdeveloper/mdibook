# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MediBook: multi-tenant appointment booking for small clinics. Behavior is defined in
`docs/001-appointment-booking/spec.md`; build order is in `docs/001-appointment-booking/plan.md`.
Stream 0 (the foundation) is built. Its files are frozen: Streams A and B do not edit them (see
plan.md, "Shared files"). The rules below say where code goes and how it must behave.

## Commands

- `make db` starts Postgres (`docker compose up -d db`)
- `make migrate` applies migrations and generates the Prisma client
- `make seed` loads fictional clinics, doctors, staff and patients (`node prisma/seed.ts`)
- `make run` starts the dev server
- `make test` runs `vitest run`: unit tests, and integration tests against real Postgres
- `make build` builds and type-checks
- `make lint` runs ESLint

Tests need `DATABASE_URL` and `TEST_DATABASE_URL` (copy `.env.example` to `.env`). The test
database is created and migrated by the test run and emptied by every test file.

## Conventions

- Times are stored in UTC. Conversion to the clinic time zone happens only in
  `src/domain/time.ts`, which is the only file that imports the time zone library
  (`@js-temporal/polyfill`).
- Database sessions run in UTC. `src/lib/db.ts` sets this on every connection; create clients
  only there.
- Every route handler is built with `route()` from `src/lib/route.ts`, which does these four
  steps, in this order: authenticate with `getSession()`, authorize by role and clinic, validate
  input against a schema, then act. Schemas use `zod`; shared ones are in `src/lib/schemas.ts`.
- Record-level scope comes from `src/lib/scope.ts`. Out of scope is `NOT_FOUND`, the same as
  missing.
- Every state change writes an audit event through `src/lib/audit.ts`, with ids only.
- All logging goes through `src/lib/logger.ts` and logs opaque ids only. Never names, emails,
  phones, dates of birth, reasons or notes.
- Appointment status changes go through `src/domain/transitions.ts`. Never set status directly.
  Only `src/lib/appointments/core.ts` inserts, moves or changes the status of an appointment.
- Appointment responses are built by `src/lib/serialize.ts` from the per-role field lists in
  `src/domain/visibility.ts`. Never return a database row.
- Errors are `AppError` with a code from `src/lib/errors.ts`.
- Auth is a development stand-in (header `x-dev-user-id`). Do not treat it as real
  authentication.

## Architecture

- `src/domain`: pure logic. No database imports.
- `src/lib`: the database client, logger, audit, session, and the shared building blocks above.
- `src/lib/appointments`: the appointment core.
- `src/lib/patient`: patient use cases (Stream A). `src/lib/clinic`: doctor and staff use cases
  (Stream B).
- `src/app/api`: thin route handlers.
- `src/components`: shared interface pieces (clinic time, four-state wrapper, confirmation
  dialog, error message, labelled field).
- `prisma/`: schema, migrations and the seed.
- `tests/helpers`, `tests/integration`, `tests/architecture.test.ts`. Unit tests sit next to
  the code in `src/domain`.

## Things Claude gets wrong

- Never edit a committed file in `prisma/migrations`. Add a new migration.
- No free-text reason fields for staff or doctors. Use reason codes. The one free-text reason
  is the patient's reason for visit (spec R20, decision F8).
- A booking unique-violation returns 409. Never retry it silently.
- Do not mock the database in booking tests.
