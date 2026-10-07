---
name: intent-template
description: "Write or revise an intent.md for MediBook. Use whenever the user wants to capture an idea, feature request, bug report, or incident as an intent file in intent/."
---
# MediBook intent template

An intent is a proto-spec in the originator's own words. File name: intent/NNN-short-slug.md
(NNN is the next free number). Use exactly these sections, in this order:

# Intent: <short title>
Author: <name and role>. Status: draft.

## Problem
Who cannot do what today, and what it costs them. Two to five sentences.

## Proposed outcome
What is better when this ships. Observable behavior, not implementation.

## Affected users and systems
Roles (patient, doctor, staff) and systems (web app, database, notification adapter).

## Constraints
Hard limits: privacy, time zones, scope, roles, deadlines.

## Open questions
Anything unknown. Put guesses here, never in the sections above.

Rules:
- Use only facts the originator gave you. If you had to guess, move it to Open questions.
- Do not design the solution. No table names, endpoints, or libraries.
- Never include real patient names or data in examples.
- Keep it under one page.