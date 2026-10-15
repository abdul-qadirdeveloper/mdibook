#!/bin/bash
# Blocks edits to protected paths. Exit 2 blocks the action; stderr goes to Claude.
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
path=$(jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0
path="${path//\\//}"; root="${root//\\//}"     # Windows: backslashes -> slashes
rel="${path#"$root"/}"
base=$(basename "$path")

block() {
  mkdir -p "$root/.claude"
  echo "$(date -u +%FT%TZ) block protect-paths $rel" >> "$root/.claude/hook-events.log"
  echo "Blocked: $1 If this change is really needed, stop and ask the tech lead. Do not work around the block." >&2
  exit 2
}

case "$base" in
  .env.example) ;;
  .env|.env.*) block "$rel holds secrets and is protected." ;;
esac

case "$path" in
  */prisma/migrations/*)
    if git -C "$(dirname "$path")" ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
      block "$rel is an existing migration. Applied migrations are immutable: add a new migration instead."
    fi ;;
esac
exit 0