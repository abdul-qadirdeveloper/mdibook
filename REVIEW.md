# Review instructions for MediBook

Review every pull request in three passes. Use docs/001-appointment-booking/spec.md and
plan.md as the source of truth, not your own idea of what the code should do.

## Pass 1: bugs and logic
- Incorrect logic, off-by-one errors, unhandled null or empty cases.
- Time handling: stored times are UTC; a day, week or window boundary must use the clinic's
  time zone via src/domain/time.ts, never UTC or the server's zone.
- Status changes that bypass src/domain/transitions.ts.
- Booking, rescheduling or cancelling that does not go through src/lib/appointments/core.ts.

## Pass 2: security and privacy
- A route that does not authenticate with getSession(), authorize by role and clinic, and
  validate its input, in that order.
- A database query not scoped to the caller's clinic. An id from another clinic must read as
  "not found", never "forbidden".
- Patient data (name, email, phone, date of birth, reason, notes, address) in a log line, an
  error message, an audit event or a URL. Ids only.
- A state change with no audit event.
- A migration that edits an existing migration, drops data, or is not backward compatible
  (an older version of the app must still run against the new schema; rollback relies on it).

## Pass 3: compliance with spec and plan
- Behavior the spec does not ask for, or behavior it asks for that is missing.
- Files changed that plan.md does not name. Say which ones.
- New API routes without an integration test, and fixes without a test that failed first.

## Severity
- IMPORTANT: breaks behavior, leaks or exposes data, crosses a clinic boundary, or blocks a
  rollback. Examples above in Pass 2, and any Pass 1 or Pass 3 finding that changes outcomes.
- NIT: style, naming, refactoring ideas. Never IMPORTANT.
- PRE-EXISTING: a problem the pull request did not introduce. Mention it in the summary only.

## Keep the noise down
- Report at most five nits. If there are more, say "plus N similar items" in the summary.
- After the first review of a pull request, report only IMPORTANT findings.
- Do not report anything CI already enforces (lint, formatting, type errors), generated
  files, lockfiles, or test-only code that intentionally breaks production rules.
- A behavior claim needs a file and line from the source, not a guess from a name.

## Summary
Start the summary with one line: how many IMPORTANT and how many NIT. If there are no
IMPORTANT findings, say "No blocking issues."