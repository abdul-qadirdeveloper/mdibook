---
name: spec-template
description: "Structure and rules for MediBook spec.md files. Use whenever creating, revising, reviewing or approving a spec.md under docs/."
---
# MediBook spec template

## Gate: check these before writing anything
1. Every intent the spec cites exists in intent/ and says `Status: accepted`.
2. docs/<slug>/mocks.md exists and says `status: approved`, or says `mocks: waived by
   product owner`, or (backend-only work) `mocks: not needed (no UI)`.
3. If a check fails, write nothing. Name the blocking file and what the product owner must do.
4. Never change an intent's Status or a mock's status yourself. Those are human decisions.

## Location and header
File: docs/<intent-slug>/spec.md. The first lines, in this order:

    # Spec: <title>
    Intent: <intent file paths, comma separated>
    Mocks: <path to mocks.md> (status: approved | waived | not needed)
    Skills in force (tree hash of .claude/skills): <output of git rev-parse --short HEAD:.claude/skills>
    Date: <today>. Status: draft

## Sections, in this order
1. Summary (five lines at most)
2. Requirements (numbered R1, R2, ...)
3. Data model sketch
4. API sketch
5. Flagged concerns (table: #, Concern, Policies in tension, Decision or options, Owner, Status)
6. Out of scope

## Rules
- Each requirement is testable and ends with its source, for example (intent 001, Constraints).
- Behavior only. No application code, and no technology beyond the stack named in the intents or the Summary (TypeScript, Next.js, PostgreSQL with Prisma, Vitest, Playwright).
- Every open question in every cited intent is either answered in a requirement or carried
  forward by name under Flagged concerns.
- Apply healthcare-privacy, appointment-domain-rules and ux-standards. Where two rules
  conflict, add a Flagged concern with options and an owner. Do not pick silently.
- A concern is `resolved` only when the user has given a decision. Until then it is `open`.
- Out of scope repeats every exclusion from the cited intents.
- Examples use fictional data only.
- Claude writes `Status: draft`. Only the product owner changes it to `approved`.
- Changing an approved spec sets Status back to `draft` and adds a one-line Changelog entry.