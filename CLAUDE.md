# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MediBook: multi-tenant appointment booking for small clinics. Behavior is defined in
`docs/001-appointment-booking/spec.md`; build order is in `docs/001-appointment-booking/plan.md`.
No application code exists yet. The rules below say where code goes and how it must behave.

## Commands

- `make db` starts Postgres (`docker compose up -d db`)
- `make run` starts the dev server
- `make test` runs `vitest run`
- `make build` builds and type-checks
- `make lint` runs ESLint

## Conventions

- Times are stored in UTC. Conversion to the clinic time zone happens only in
  `src/domain/time.ts`.
- Every route handler does these four steps, in this order: authenticate with `getSession()`,
  authorize by role and clinic, validate input against a schema, then act.
- Every state change writes an audit event through `src/lib/audit.ts`, with ids only.
- All logging goes through `src/lib/logger.ts` and logs opaque ids only. Never names, emails,
  phones, dates of birth, reasons or notes.
- Appointment status changes go through `src/domain/transitions.ts`. Never set status directly.
- Auth is a development stand-in (header `x-dev-user-id`). Do not treat it as real
  authentication.

## Architecture

- `src/domain`: pure logic. No database imports.
- `src/lib`: the database client, logger, audit and session.
- `src/app/api`: thin route handlers.
- `prisma/`: schema and migrations.

## Things Claude gets wrong

- Never edit a committed file in `prisma/migrations`. Add a new migration.
- No free-text reason fields. Use reason codes.
- A booking unique-violation returns 409. Never retry it silently.
- Do not mock the database in booking tests.
