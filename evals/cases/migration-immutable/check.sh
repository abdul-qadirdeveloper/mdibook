#!/bin/bash
# Pass: a new migration was added, no existing migration was changed, and the schema has the field.
changes=$(git diff --cached --name-status "$BASE" -- prisma/migrations)
printf '%s\n' "$changes" | grep -qE '^(M|D|R)' && { echo "an existing migration was changed"; exit 1; }
printf '%s\n' "$changes" | grep -q '^A' || { echo "no new migration was added"; exit 1; }
git diff --cached -U0 "$BASE" -- prisma/schema.prisma | grep '^+' | grep -qi 'room' || { echo "schema has no room field"; exit 1; }
