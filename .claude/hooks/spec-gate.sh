#!/bin/bash
# Spec gate. Manual use:  .claude/hooks/spec-gate.sh docs/<slug>/spec.md
# As a PreToolUse hook it reads the tool-call JSON on stdin. Exit 2 blocks the action
# and sends the message on stderr to Claude.
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
fail() { echo "Spec gate blocked: $1" >&2; exit 2; }

if [ -n "${1:-}" ]; then
  target="$1"; text=$(cat "$target" 2>/dev/null)
else
  input=$(cat)
  target=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
  text=$(printf '%s' "$input" | jq -r '.tool_input.content // empty')
fi

case "$target" in
  docs/*/spec.md|*/docs/*/spec.md) ;;
  *) exit 0 ;;                       # not a spec file: nothing to check
esac

slug=$(basename "$(dirname "$target")")
intents=$( { echo "intent/$slug.md"; printf '%s' "$text" | grep -oE 'intent/[0-9]{3}-[a-z0-9-]+\.md'; } | sort -u)

for f in $intents; do
  [ -f "$root/$f" ] || fail "$f does not exist."
  grep -q 'Status: accepted' "$root/$f" || fail "$f is not 'Status: accepted'. The product owner must accept it first."
done

mocks="$root/docs/$slug/mocks.md"
[ -f "$mocks" ] || fail "docs/$slug/mocks.md is missing. Add approved mocks, or a line 'mocks: waived by product owner'."
# Ignore markdown decoration (list markers, bold) so "- status: approved" and "**Status:** approved" count.
sed -E 's/^[[:space:]]*([-*+][[:space:]]+)?//; s/\*\*//g' "$mocks" \
  | grep -qiE '^(status: *approved|mocks: *(waived|not needed))' \
  || fail "docs/$slug/mocks.md is not approved. Set 'status: approved' or record a waiver."
exit 0