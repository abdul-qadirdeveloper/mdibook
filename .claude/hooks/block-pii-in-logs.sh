#!/bin/bash
# Blocks log statements that mention patient-data field names. Exit 2 blocks the action.
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
path="${path//\\//}"                              # Windows: backslashes -> slashes

case "$path" in
  *.test.ts|*.test.tsx) exit 0 ;;
  */src/*.ts|*/src/*.tsx|src/*.ts|src/*.tsx) ;;
  *) exit 0 ;;
esac

text=$(printf '%s' "$input" | jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits[]?.new_string)] | map(select(. != null)) | join("\n")')

hits=""
while IFS= read -r line; do
  lower=$(printf '%s' "$line" | tr 'A-Z' 'a-z' | sed -E 's/reasoncode|filename|hostname|username//g')
  if printf '%s' "$lower" | grep -qE 'name|email|phone|dob|birth|reason|note|address'; then
    hits="$hits$line"$'\n'
  fi
done < <(printf '%s\n' "$text" | grep -nE '(console\.(log|info|warn|error|debug)|logger\.[a-z]+)\(')

if [ -n "$hits" ]; then
  mkdir -p "$root/.claude"
  echo "$(date -u +%FT%TZ) block pii-in-logs $path" >> "$root/.claude/hook-events.log"
  {
    echo "Blocked: a log statement appears to include patient data (name, email, phone, birth date, reason, notes or address):"
    printf '%s' "$hits"
    echo "Log opaque ids only (for example patientId, appointmentId) through src/lib/logger.ts. See the healthcare-privacy skill."
  } >&2
  exit 2
fi
exit 0