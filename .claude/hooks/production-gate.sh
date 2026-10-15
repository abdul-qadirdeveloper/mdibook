#!/bin/bash
# Blocks any shell command that deploys to production unless a release manager authorized it.
# The authorization is set by a human before the session starts:
#   RELEASE_APPROVAL="<release manager name>:<change ticket>" claude
# The name must be listed in release/release-managers.txt.
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
root="${root//\\//}"
cmd=$(jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

lower=$(printf '%s' "$cmd" | tr 'A-Z' 'a-z')
printf '%s' "$lower" | grep -qE 'deploy|rollback' || exit 0
printf '%s' "$lower" | grep -qE 'prod' || exit 0

log() { mkdir -p "$root/.claude"; echo "$(date -u +%FT%TZ) $1 production-gate $2" >> "$root/.claude/hook-events.log"; }

approval="${RELEASE_APPROVAL:-}"
name="${approval%%:*}"; ticket="${approval#*:}"
if [ -n "$approval" ] && [ "$name" != "$approval" ] && [ -n "$ticket" ] \
   && grep -qxF "$name" "$root/release/release-managers.txt" 2>/dev/null; then
  log allow "$name $ticket"
  exit 0
fi

log block "no valid RELEASE_APPROVAL"
{
  echo "Blocked: production deploys need a release authorization from a named release manager."
  echo "The agent prepares the release (tests, release notes, the staging deploy) and stops here."
  echo "Ask the release manager to start the session with RELEASE_APPROVAL=<name>:<change ticket>, where <name> is listed in release/release-managers.txt."
  echo "Do not try another command or wrapper to get around this gate."
} >&2
exit 2