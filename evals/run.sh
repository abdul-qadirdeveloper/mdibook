#!/bin/bash
# Run the MediBook agent evals.   Usage: evals/run.sh [--check-only] [case-id ...]
# DESTRUCTIVE: it resets the working tree between cases. Run it only in a throwaway checkout
# (CI, or a git worktree you made for this) and say so with EVAL_ALLOW_RESET=1.
set -u
if [ "${EVAL_ALLOW_RESET:-}" != "1" ]; then
  echo "Refusing to run: this resets the working tree. Use a throwaway checkout and set EVAL_ALLOW_RESET=1." >&2
  exit 2
fi
check_only=0
if [ "${1:-}" = "--check-only" ]; then check_only=1; shift; fi
min="${EVAL_MIN_PASS_RATE:-0.8}"
cd "$(git rev-parse --show-toplevel)" || exit 2
base=$(git rev-parse HEAD)
if [ $# -gt 0 ]; then cases=("$@"); else mapfile -t cases < <(ls evals/cases); fi
out="evals/results/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
pass=0; total=0
for id in "${cases[@]}"; do
  dir="evals/cases/$id"
  [ -f "$dir/prompt.txt" ] || { echo "no such case: $id" >&2; continue; }
  git reset --hard -q "$base"
  git clean -fdq -e evals/results
  transcript="$out/$id.jsonl"; : > "$transcript"
  if [ $check_only -eq 0 ]; then
    claude -p "$(cat "$dir/prompt.txt")" \
      --permission-mode acceptEdits \
      --allowedTools "Read,Grep,Glob,Edit,Write,Bash(make *),Bash(npx *),Bash(git diff *),Bash(git status *)" \
      --max-turns "${EVAL_MAX_TURNS:-25}" \
      --output-format stream-json --verbose \
      > "$transcript" 2> "$out/$id.err"
  fi
  git add -A
  if BASE="$base" TRANSCRIPT="$PWD/$transcript" bash "$dir/check.sh" > "$out/$id.check.log" 2>&1; then
    result=pass; pass=$((pass + 1))
  else
    result=FAIL
  fi
  total=$((total + 1))
  printf '%-24s %s\n' "$id" "$result"
  echo "$(date -u +%FT%TZ),$base,$id,$result" >> evals/results/history.csv
done
git reset --hard -q "$base"
awk -v p="$pass" -v t="$total" -v m="$min" 'BEGIN {
  r = (t > 0) ? p / t : 0
  printf "pass rate %d/%d = %.2f (minimum %.2f)\n", p, t, r, m
  exit !(t > 0 && r >= m)
}'