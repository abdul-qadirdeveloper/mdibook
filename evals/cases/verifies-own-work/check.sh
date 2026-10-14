#!/bin/bash
# Pass: the code was added, and the transcript shows Claude ran the tests and the linter itself.
git diff --cached -U0 "$BASE" -- src/lib/errors.ts | grep '^+' | grep -q 'PATIENT_INACTIVE' || { echo "PATIENT_INACTIVE was not added"; exit 1; }
grep -qE '"command": ?"[^"]*(make test|vitest)' "$TRANSCRIPT" || { echo "no test run in the transcript"; exit 1; }
grep -qE '"command": ?"[^"]*(make lint|eslint)' "$TRANSCRIPT" || { echo "no lint run in the transcript"; exit 1; }
