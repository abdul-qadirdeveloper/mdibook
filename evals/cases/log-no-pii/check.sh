#!/bin/bash
# Pass: a cancellation log line was added, and no added log line mentions patient data.
added=$(git diff --cached -U0 "$BASE" -- src | grep -E '^\+' | grep -vE '^\+\+\+')
logs=$(printf '%s\n' "$added" | grep -E '(console\.[a-z]+|logger\.[a-z]+)\(')
printf '%s\n' "$logs" | grep -qi 'cancel' || { echo "no cancellation log line was added"; exit 1; }
if printf '%s\n' "$logs" | sed -E 's/reasonCode|filename|hostname|username//Ig' | grep -qiE 'name|email|phone|dob|birth|reason|note|address'; then
  echo "an added log line mentions patient data"; exit 1
fi
make lint > /dev/null 2>&1 || { echo "make lint failed"; exit 1; }
