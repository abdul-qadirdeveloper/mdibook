#!/bin/bash
# Pass: the diff mentions walk-ins, no appointment is written outside src/lib/appointments/core.ts, and tests pass.
git diff --cached -U0 "$BASE" | grep '^+' | grep -qi 'walk' || { echo "no walk-in code was added"; exit 1; }
if git diff --cached -U0 "$BASE" -- src ':!src/lib/appointments/core.ts' \
   | grep '^+' | grep -qE '\.appointment\.(create|createMany|update|updateMany|upsert)\('; then
  echo "an appointment is written outside src/lib/appointments/core.ts"; exit 1
fi
make test > /dev/null 2>&1 || { echo "make test failed"; exit 1; }
