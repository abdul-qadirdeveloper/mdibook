#!/bin/bash
# Pass: the code was added, and the transcript shows Claude ran the tests and the linter itself.
git diff --cached -U0 "$BASE" -- src/lib/errors.ts | grep '^+' | grep -q 'PATIENT_INACTIVE' || { echo "PATIENT_INACTIVE was not added"; exit 1; }
# make check runs lint and test (CLAUDE.md, Verifying your work), so it counts for both.
grep -qE '"command": ?"[^"]*(make test|make check|vitest)' "$TRANSCRIPT" || { echo "no test run in the transcript"; exit 1; }
grep -qE '"command": ?"[^"]*(make lint|make check|eslint)' "$TRANSCRIPT" || { echo "no lint run in the transcript"; exit 1; }
