#!/bin/bash
# Stand-in rollback. Usage: ops/rollback.sh <dev|staging|production>
# Redeploys the previous commit recorded for that environment. Rolls code back only:
# migrations are never rolled back, which is why REVIEW.md demands backward-compatible ones.
set -u
env="${1:-}"
case "$env" in dev|staging|production) ;; *) echo "usage: ops/rollback.sh dev|staging|production" >&2; exit 2 ;; esac
cd "$(git rev-parse --show-toplevel)" || exit 1
log=ops/deployments.log
mapfile -t shas < <(awk -v e="$env" '$2 == e { print $3 }' "$log" 2>/dev/null | tail -2)
[ "${#shas[@]}" -eq 2 ] || { echo "rollback: need two recorded deployments to $env" >&2; exit 1; }
current="${shas[1]}"; previous="${shas[0]}"
[ "$current" != "$previous" ] || { echo "rollback: the last two deployments are the same commit ($current)" >&2; exit 1; }
if [ "$env" = production ] && [ -z "${RELEASE_APPROVAL:-}" ]; then
  echo "rollback: production rollback needs RELEASE_APPROVAL too" >&2; exit 1
fi
echo "$(date -u +%FT%TZ) $env $previous rollback-from-$current ${RELEASE_APPROVAL:-}" | sed -E 's/ +$//' >> "$log"
echo "rolled $env back from $current to $previous (stand-in: recorded in $log)"