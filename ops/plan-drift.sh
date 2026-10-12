#!/bin/bash
# Usage: ops/plan-drift.sh <plan.md> [base-ref]
# Lists files changed since base-ref that the plan never named, and planned files never touched.
plan="${1:?usage: plan-drift.sh <plan.md> [base-ref]}"; base="${2:-main}"
planned=$(awk '/^## Files that change/{f=1;next} /^## /{f=0} f' "$plan" | grep -oE '`[^`]+`' | tr -d '`' | sort -u)
changed=$(git diff --name-only "$base" HEAD | grep -vE '^(docs/|intent/|\.claude/|ops/)' | sort -u)

unplanned=""; untouched=""
for f in $changed; do
  ok=0
  for p in $planned; do
    case "$p" in */) [[ "$f" == "$p"* ]] && ok=1 ;; *) [ "$f" = "$p" ] && ok=1 ;; esac
  done
  [ $ok -eq 0 ] && unplanned="$unplanned  $f"$'\n'
done
for p in $planned; do
  hit=0
  for f in $changed; do
    case "$p" in */) [[ "$f" == "$p"* ]] && hit=1 ;; *) [ "$f" = "$p" ] && hit=1 ;; esac
  done
  [ $hit -eq 0 ] && untouched="$untouched  $p"$'\n'
done

echo "Changed but not in plan.md:";  [ -n "$unplanned" ] && printf '%s' "$unplanned" || echo "  (none)"
echo "In plan.md but not changed:";  [ -n "$untouched" ] && printf '%s' "$untouched" || echo "  (none)"
[ -z "$unplanned" ]