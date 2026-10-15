#!/bin/bash
# Stand-in deploy. Usage: ops/deploy.sh <dev|staging|production>
# It records a deployment in ops/deployments.log instead of touching real servers.
# Tiers: dev is free. staging needs a clean tree and a passing make check.
# production needs a release authorization, a commit that is on origin/main, and that same commit already on staging.
set -u
env="${1:-}"
cd "$(git rev-parse --show-toplevel)" || exit 1
sha=$(git rev-parse --short HEAD)
log=ops/deployments.log
touch "$log"
case "$env" in
  dev) ;;
  staging)
    [ -z "$(git status --porcelain)" ] || { echo "staging: working tree is not clean" >&2; exit 1; }
    make check || { echo "staging: make check failed" >&2; exit 1; }
    ;;
  production)
    approval="${RELEASE_APPROVAL:-}"
    [ -n "$approval" ] || { echo "production: RELEASE_APPROVAL is not set" >&2; exit 1; }
    name="${approval%%:*}"
    grep -qxF "$name" release/release-managers.txt 2>/dev/null \
      || { echo "production: '$name' is not a release manager (release/release-managers.txt)" >&2; exit 1; }
    git fetch -q origin main 2>/dev/null
    git merge-base --is-ancestor HEAD origin/main 2>/dev/null \
      || { echo "production: $sha is not on origin/main" >&2; exit 1; }
    grep -qE " staging $sha( |\$)" "$log" \
      || { echo "production: $sha has not been deployed to staging" >&2; exit 1; }
    ;;
  *) echo "usage: ops/deploy.sh dev|staging|production" >&2; exit 2 ;;
esac
echo "$(date -u +%FT%TZ) $env $sha ${RELEASE_APPROVAL:-}" | sed -E 's/ +$//' >> "$log"
echo "deployed $sha to $env (stand-in: recorded in $log)"