#!/usr/bin/env bash
# Diagnose the active breach, read-only. Usage: ops/diagnose.sh
# Claude gets Read, Grep and Glob and nothing that writes or runs commands. The script, not Claude,
# writes the incident record from Claude's answer. What Claude is asked to add depends on the band.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
breach=ops/metrics/breach.json
[ -f "$breach" ] || { echo "No active breach at diagnose or above. Run: node ops/detect.mjs" >&2; exit 1; }
id=$(jq -r .id "$breach"); action=$(jq -r .action "$breach")
case "$action" in
  diagnose) ask="Do not propose a change. Say what is known, what is not known, and what a person should look at next." ;;
  propose)  ask="Finish with a section '## Proposed next step' holding ONE draft that a person must approve before anything happens: either a pull request description or a runbook step. Do not carry it out." ;;
  *) echo "Band action '$action' does not allow a diagnosis." >&2; exit 1 ;;
esac
out="docs/incidents/$id.md"; mkdir -p docs/incidents
[ ! -e "$out" ] || { echo "$out already exists. Read it, or delete it to diagnose again." >&2; exit 1; }

prompt="You are the first responder for MediBook, in read-only mode. A deterministic detector breached a control band.
Read ops/metrics/breach.json first: it holds the evidence. If you need to check a number, the raw feed is
ops/metrics/feed.jsonl and the sampled conflict logs are ops/metrics/logs.jsonl. The code is in this repository,
and the rules are in docs/001-appointment-booking/spec.md and CLAUDE.md.

Answer with an incident record in exactly this format, and nothing before or after it:

# Incident $id: <short title>
Band: <band>. Detected: <time>.
## What the metrics show
## What the logs show
## What stayed normal
## Likely cause
## Confidence, and what would change it

Rules: use only numbers you read, and copy identifiers exactly (doctor ids are opaque ids). In 'Likely cause'
state a hypothesis, and name the file and function in this repository that you read to support it; if you did
not read code, say so. Where the evidence does not say, write 'not known'. No patient data. Do not write,
edit or run anything. $ask"

claude -p "$prompt" \
  --allowedTools "Read,Grep,Glob" \
  --disallowedTools "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Read(./.env),Read(./.env.*)" \
  --max-turns 20 > "$out.tmp"
if ! head -n 1 "$out.tmp" | grep -q '^# Incident'; then
  mv "$out.tmp" "$out.rejected"; echo "The answer did not start with '# Incident'. Saved as $out.rejected for you to read." >&2; exit 1
fi
mv "$out.tmp" "$out"; echo "wrote $out"
