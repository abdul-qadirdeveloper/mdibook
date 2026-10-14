#!/bin/bash
# Active only while .claude/fix-mode exists. Turn on: touch .claude/fix-mode   Turn off: rm .claude/fix-mode
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
root="${root//\\//}"
[ -f "$root/.claude/fix-mode" ] || exit 0

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')
block() {
  echo "$(date -u +%FT%TZ) block test-edit $1" >> "$root/.claude/hook-events.log"
  echo "Blocked: this is a fix task, so tests are read-only ($1). Change the code under test, not the test. If the test is wrong, stop and tell the engineer." >&2
  exit 2
}

if [ "$tool" = "Bash" ]; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
  case "$cmd" in *fix-mode*) block "the fix-mode marker" ;; esac
  if printf '%s' "$cmd" | grep -qE '(sed +-i|tee |>|rm |mv |cp |git +(checkout|restore|stash|apply)).*(\.test\.tsx?|\.spec\.ts|tests/|vitest\.config|playwright\.config|evals/)'; then
    block "a shell command that touches test files"
  fi
  exit 0
fi

path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0
path="${path//\\//}"
rel="${path#"$root"/}"
case "$rel" in
  *.test.ts|*.test.tsx|*.spec.ts|tests/*|*/tests/*|vitest.config.*|playwright.config.*|evals/*) block "$rel" ;;
esac
exit 0