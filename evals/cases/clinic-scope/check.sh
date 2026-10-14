#!/bin/bash
# Pass: a new clinic route, scoping code in the diff, a test that names another clinic, and green tests.
git diff --cached --name-only --diff-filter=A "$BASE" -- 'src/app/api/v1/clinic' | grep -q 'route.ts' \
  || { echo "no new route under src/app/api/v1/clinic"; exit 1; }
git diff --cached -U0 "$BASE" -- src | grep '^+' | grep -qi 'scope' \
  || { echo "the new code never mentions scope (src/lib/scope.ts)"; exit 1; }
git diff --cached -U0 "$BASE" -- tests | grep '^+' | grep -qiE 'other clinic|another clinic|different clinic|otherClinic' \
  || { echo "no test about a staff user from another clinic"; exit 1; }
make test > /dev/null 2>&1 || { echo "make test failed"; exit 1; }
