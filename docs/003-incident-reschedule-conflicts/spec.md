# Spec: Reschedule conflicts: offer open slots, keep the appointment, make retries measurable
Intent: intent/003-incident-reschedule-conflicts.md  
Mocks: docs/003-incident-reschedule-conflicts/mocks.md (status: waived)  
Skills in force (tree hash of .claude/skills): 10efb6f  
Date: 2026-10-19. Status: approved

## 1. Summary

When a reschedule loses the race for a slot, the API answers with a conflict that says the appointment was not moved and lists open slots with the same doctor.
Most of this exists already (spec 001 R23, R33). This spec fixes the conflict message for moves, offers the open slots nearest the taken one, adds repeat-submission handling, and adds a conflict log of ids only that shows how often a taken slot is sent again.
API behavior only. No screen changes: mocks are waived, and screens are a follow-up intent (F4). The stack is unchanged: TypeScript, Next.js, PostgreSQL with Prisma, Vitest.
The incident's evidence comes from a simulated feed and cannot confirm the cause (F1). R12 to R17 are how real evidence would be collected.

## 2. Requirements

Spec 001 is cited as "spec 001 Rn". Requirements marked "assumption" rest on an open concern in section 5.

### Conflict answer

- **R1** When a reschedule asks for a slot that already has an active appointment, or loses the race for it to a concurrent booking or move, the answer is HTTP 409 with code `SLOT_TAKEN`. This holds for patient, doctor and staff callers. (intent 003, Proposed outcome; spec 001 R23, R33; domain rules, No double booking)
- **R2** The conflict message says that the time was just taken, that the appointment was not moved and is still at its original time, and that the caller can choose another open time. A reschedule conflict never says "Nothing was booked". The message contains no names, no times of other people's appointments, and no internal details. (intent 003, Proposed outcome; ux-standards, Errors; privacy rule 2; spec 001 R88)
- **R3** The conflict keeps today's code and status (R1), and lists at most three open slots with the same doctor: the ones nearest in time to the slot that was taken, before or after it, listed earliest first. If two slots are equally near, the earlier one is chosen. Each slot gives its start and end as UTC instants, and the answer gives the clinic's IANA time zone, so a client shows clinic-local time with the zone name, as in every other slot list. (intent 003, Proposed outcome and Open questions; spec 001 R23; domain rules, Time; ux-standards, Times; F3)
- **R4** Every listed slot is one the caller could already see in the doctor's open-slot list (`GET /doctors/{doctorId}/slots`, which applies spec 001 R24) at the moment of the answer. No listed slot is the slot just taken or the appointment's own current slot. (spec 001 R24, R32; F3)
- **R5** If no slot qualifies before the booking horizon, the list is empty. The message then says there are no other open times with this doctor in the next 90 days, and that the current appointment is kept and the caller can contact the clinic. (ux-standards, Errors; spec 001 R24)
- **R6** Listed slots are suggestions, not holds. Choosing one sends a new reschedule request, which can itself lose the race and get R1. (intent 003, Constraints; spec 001 R23)
- **R7** The server never retries the requested slot, and never moves the appointment to a listed slot on its own. (intent 003, Constraints; CLAUDE.md)
- **R8** Checks run in this order: scope, then the patient window, then the slot. An appointment outside the caller's scope gets `NOT_FOUND` even when the requested slot is taken. A patient inside the cancellation window gets `RESCHEDULE_WINDOW_CLOSED`, with no slot list. (spec 001 R8, R34; privacy rule 1; CLAUDE.md, scope)

### The original appointment is unchanged

- **R9** After a conflict, the appointment has the same start, end, status, reason for visit and booking origin as before the request. A patient's `confirmed` appointment stays `confirmed`: the return to `requested` in spec 001 R36 happens only on a completed move. (intent 003, Proposed outcome and Constraints; spec 001 R33, R36)
- **R10** A conflict writes no appointment history row, no audit event and no notification event, because nothing changed. (spec 001 R33, R73, R81; domain rules, Reschedule)
- **R11** Integration tests against the real test database show that two concurrent requests for one slot (move and move, or move and booking) end with exactly one winner. The loser's appointment is unchanged and no extra rows are written. The database is not mocked. (intent 003, Constraints; domain rules, No double booking; CLAUDE.md)

### Repeat submissions

- **R12** Reschedule accepts an optional `Idempotency-Key` header, as booking does. A repeat from the same actor, with the same key, for the same appointment and requested start, within 24 hours, returns the first request's outcome (moved or `SLOT_TAKEN`) without attempting the move again. A replayed conflict computes its slot list afresh (R3, R4). The same key sent with a different appointment or start is refused with `VALIDATION_FAILED`, naming the `Idempotency-Key` field. A request without the header behaves as it does today. (intent 003, Open questions; spec 001 R27; assumption, F5) **Deferred (F5):** not part of this change set.

### Conflict log and measurement

- **R13** Each reschedule conflict writes exactly one log line, at level warn, with the event name `reschedule.conflict` and these fields only: request id, doctor id, clinic id, and `sameSlotRetry` (R14). The logger supplies the timestamp. No names, emails or free text. (intent 003, Affected users and systems, and Open questions; privacy rule 2; F2, F6)
- **R14** `sameSlotRetry` is true when this session has already lost the same slot (same doctor, same start) to `SLOT_TAKEN`, and false otherwise. The server computes it. The requested start, the appointment id, the actor id and any session identifier are not logged in any form. (intent 003, Open questions; privacy rule 2; spec 001 R75, R79; F2; assumption, F9)
- **R15** Removed: no client label is logged (F6).
- **R16** Definitions for analysis. The reschedule conflict rate for a clinic in a minute is the number of `reschedule.conflict` lines divided by `n`, where `n` is the number of reschedule requests answered for that clinic in that minute. The same-slot retry share is the number of conflict lines with `sameSlotRetry` true divided by the number of conflict lines. Both can be broken down by clinic and doctor id. (intent 003, Open questions; F1, F2)
- **R17** The product owner judges intent outcome 4 (same-slot retries falling back towards 0.03) on R16, computed from logs written by this release over the 7 days after it goes out. The simulated feed in `ops/metrics/` is not used for this judgement. (intent 003, Proposed outcome; F1)
- **R18** No log line, error, response or metric added by this spec contains a name, email, phone number, date of birth, visit reason, note or appointment time. A test checks the `reschedule.conflict` line for this. (intent 003, Constraints; privacy rule 2; spec 001 R78)
- **R19** The slot list and the conflict message are the same for every role, and say nothing about who holds any other slot. (privacy rule 1; spec 001 R83)

## 3. Data model sketch

Stored appointments do not change. A failed move writes nothing to Appointment, AppointmentHistory, AuditEvent or NotificationEvent (R9, R10).

| Entity | Fields | Notes |
|---|---|---|
| RescheduleRequestKey (new) | actor id, clinic id, appointment id, idempotency key, requested start (UTC), outcome (`moved` or `slot_taken`), created at | Unique on actor and key. Kept for at least 24 hours, then removable. Holds no personal data beyond the ids and the instant the database already holds for appointments. Only needed if F5 is accepted. |

Rules:

1. The new table is added by a **new** migration. Committed migrations are not edited (CLAUDE.md).
2. Writing the key row and making the move happen in one transaction, so a replay can never see a key whose move didn't happen. A conflict records its key row after the move's transaction rolls back.
3. To compute `sameSlotRetry` (R14), the server remembers which slots (doctor id and start) each session has lost. That memory holds no names or free text, is never logged, and lasts no longer than the session (F9). Where it is kept is an engineering choice.

## 4. API sketch

Only one endpoint changes. Everything else in spec 001 section 4 stands.

`POST /api/v1/appointments/{id}/reschedule` (patient, doctor, staff)

- Body: the new start instant, unchanged.
- New optional header: `Idempotency-Key` (R12).
- 200: the moved appointment, built by `readAppointment`, unchanged.
- 409 `SLOT_TAKEN`: the existing error shape, with `nextSlots` and `timeZone`, and the message from R2 or R5.

Example (fictional data). A clinic in America/Chicago, a request for 2026-11-03T15:00:00Z (09:00 CST):

```json
{
  "error": {
    "code": "SLOT_TAKEN",
    "message": "That time was just taken by someone else. Your appointment was not moved and is still at its original time. Choose another open time.",
    "requestId": "req_demo_0001",
    "nextSlots": [
      { "startsAt": "2026-11-03T14:30:00Z", "endsAt": "2026-11-03T15:00:00Z" },
      { "startsAt": "2026-11-03T15:30:00Z", "endsAt": "2026-11-03T16:00:00Z" },
      { "startsAt": "2026-11-03T16:00:00Z", "endsAt": "2026-11-03T16:30:00Z" }
    ],
    "timeZone": "America/Chicago"
  }
}
```

The log line for the same conflict (R13). The ids are opaque and fictional:

```json
{ "level": "warn", "event": "reschedule.conflict", "requestId": "req_demo_0001", "doctorId": "doc_demo_7",
  "clinicId": "cln_demo_2", "sameSlotRetry": false }
```

Other answers are unchanged: `NOT_FOUND`, `RESCHEDULE_WINDOW_CLOSED`, `SLOT_UNAVAILABLE`, `INVALID_TRANSITION`, and `VALIDATION_FAILED`, which now also covers misuse of the `Idempotency-Key` header.

## 5. Flagged concerns

### Open questions carried from intent 003

| Intent question | Where it stands |
|---|---|
| Cause: a caller resends the same slot after `SLOT_TAKEN` | Not confirmed and cannot be confirmed from the available data. See F1. R13 to R16 provide the data to test it. |
| Alternative: real demand on `doc_07` after a schedule change around 04:10 to 04:15 | Carried forward, F8. The feed holds no schedule or audit data. This needs step 4 of the incident runbook, which the on-call lead must approve. |
| Who sends the retries; are patients affected directly? | Carried forward. The conflict log has no actor role or client (R13, F6 resolved), so these logs cannot answer it. That needs the request log (runbook step 2, F8). No screen in this repository calls reschedule, so patients are affected only through some other client. F4. |
| Do callers receive and show the next open slots, and if so why resend? | **Answered in part.** Callers receive them: `slotTaken` in `src/lib/appointments/core.ts` attaches them to every reschedule conflict. No screen in this repository shows them. What external callers do is unknown (F1, F8). |
| What does `n` count? | **Answered for the feed.** In `ops/metrics-sim.mjs`, `n` is the number of requests on that route and clinic in that minute, so 0.0584 at n 33 is about 2 conflicts. For real logs, R16 defines `n`. |
| How is `sameSlotRetry` computed? | **Answered for the feed:** it is a random flag set by the simulator, not derived from requests (F1). **Defined for real logs** in R14: this session already lost the same slot. Whether a retry repeats someone else's slot is not logged. |
| Is the missing repeat-submission key part of the problem? | Possibly, for double clicks and timeout retries only. A deliberate resend after reading the 409 would send a new key. R12, F5. |
| Which internal doctor is `doc_07`? Anything deployed near 04:10? | **`doc_07` is a simulator label** (`CLINICS` in `ops/metrics-sim.mjs`) and maps to no doctor in the database or seed. The deploy question is carried forward, F8. |
| What does "nearby" mean? | Answered in R3 and R4, decided by the product owner: at most three open slots nearest in time to the taken slot, on either side, that the caller could see in search. F3. |

### Concerns

| # | Concern | Policies in tension | Decision or options | Owner | Status |
|---|---|---|---|---|---|
| F1 | **The incident's evidence is simulated and statistically weak.** `ops/metrics-sim.mjs` calls itself "Fake production metrics". It produced this feed with an injected `hot-doctor` scenario, in which `doc_07` and `sameSlotRetry` (true about 60% of the time on hot lines) are random draws. The application logs only `request.failed.SLOT_TAKEN` with the request id and actor id (`src/lib/route.ts:148`), so the doctor id, slot and retry flag cannot come from real logs. The baseline sigma of 0.004 is far below binomial noise for about 33 requests a minute (about 0.03), so z 7.1 overstates a rise of roughly 1 conflict a minute. | Intent 003 Problem, and the triage "fix now" by the service owner, vs. the facts in `ops/`. Outcome 4 (share back to 0.03) cannot be measured before R13 to R16 ship. | (a) Go ahead as triaged, and treat R13 to R17 as the way to get real evidence (recommended). (b) Pause until real request logs exist. (c) Ship only R1 to R11, the fixes that stand regardless of the cause. | Product owner, with the service owner | open |
| F2 | Diagnosing same-slot retries needs the requested slot in the log. Logging the slot puts an appointment time, tied to a patient-linked actor id, into the logs. | Intent 003 (measure retries) vs. privacy rule 2, spec 001 R79 (no request body values in logs) and R75 (no appointment time in events). | Decided by the service owner, 2026-10-19: nothing about the slot is logged, neither its time nor a hash of it. Each conflict logs request id, doctor id, clinic id and a server-computed flag for whether this session already lost the same slot (R13, R14). The options were: a keyed-hash slot key; logging the start time; logging nothing about the slot. | Service owner | resolved |
| F3 | The meaning of "nearby". | Intent 003 open question. ux-standards, Booking ("offers the next open slots"). | Decided by the product owner, 2026-10-19: at most three open slots with the same doctor, nearest in time to the taken slot, excluding that slot and any slot the caller could not already see in search. Code and status stay as today, times come in UTC and are shown in the clinic's zone, the original appointment is untouched, the move stays atomic, and the server does not retry (R1, R3, R4, R7, R9). This replaces booking-style "next after", so reschedule and booking (spec 001 R23) now list slots differently. | Product owner | resolved |
| F4 | **No patient is told anything yet.** Intent outcome 1 says "the patient is told straight away". No patient or staff screen in this repository calls reschedule, and the patient page says "Not available on this page yet". This spec meets outcome 1 at the API only. Approved spec 001 R46 already requires a reschedule action on My appointments, and it is unbuilt. | Intent 003 Proposed outcome vs. intent 003 Out of scope ("redesigning screens") and the mocks waiver ("any screen change is a follow-up intent"). The ux-standards Booking rule applies once a screen exists. | Decided by the product owner, 2026-10-19: API only. Screen changes are out of scope and become their own intent if wanted. The spec 001 R46 gap stays until then. | Product owner | resolved |
| F5 | A repeat-submission key for reschedule adds a table and a migration, and may not lower deliberate resends. | Intent 003 open question. Spec 001 R27 (a repeated booking creates one appointment). Domain rules (reschedule is atomic). | Deferred by the product owner, 2026-10-19: this change set leaves out R12 and the RescheduleRequestKey table, and stays within `src/` and tests. R12 becomes a follow-up with its own migration. The options were: (a) add it, as in R12, for parity with booking; (b) leave it out. | Product owner | deferred |
| F6 | Finding which client sends retries needs some client identity. The raw user agent and IP address are fingerprinting data. | Intent 003 open question (who sends) vs. privacy rule 1 (minimum necessary) and rule 2. | Decided by the service owner, 2026-10-19: no client identity and no actor role are logged (R13; R15 removed). Who sends the retries must come from the request log instead (F8). | Service owner | resolved |
| F7 | **This work edits frozen Stream 0 files.** R2, R5 and R12 to R14 touch `src/lib/appointments/core.ts`, `src/lib/errors.ts`, `src/lib/route.ts` and `prisma/schema.prisma`, plus a new migration. plan.md, "Shared files", forbids Streams A and B to edit them, and this incident belongs to neither stream. | plan.md, Shared files, vs. intent 003. CLAUDE.md: only `core.ts` moves appointments, so the change cannot live in `src/lib/patient` or `src/lib/clinic`. | (a) The product owner authorizes a Stream 0 change set for this incident, in its own pull request with both required checks (recommended). (b) Narrow the spec to what fits outside the frozen files. Almost nothing does. Decided by the product owner, 2026-10-19: (a), authorized. | Product owner (tech lead) | resolved |
| F8 | Questions this spec cannot answer from the repository: (1) Did `doc_07`'s schedule or time off change around 04:10 to 04:15? (2) Was anything deployed or reconfigured near 04:10? The end of `ops/deployments.log` lists one production deploy, at 2026-10-15T13:46:33Z, after the incident began. Its earlier lines were not read, because a project hook blocks shell commands that mention production deploys. | Incident runbook step 4 needs the on-call lead's approval. | Someone with access reads the full deploy log, and the on-call lead approves and runs runbook step 4. Record the results in `docs/incidents/INC-20261015-0415.md`. | On-call lead | open |
| F9 | Decision 5 bases `sameSlotRetry` on "this session", but today's sign-in is a development stand-in (`src/lib/session.ts`): the caller names a user in a header, and there is no session id and no session lifetime. Without a definition the flag cannot be tested. | The service owner's F2 decision vs. the current auth stand-in (CLAUDE.md: "do not treat it as real authentication"). | (a) Treat a session as the signed-in user, and remember lost slots for a fixed time, for example 15 minutes. (b) Use a real session id once real sign-in (spec 001 R98 to R103) exists, with (a) until then. (c) Remember lost slots per user with no time limit. Decided 2026-10-19: (a). A session is the signed-in user id, and lost slots are remembered for 15 minutes in process memory, with nothing persisted. | Service owner | resolved |

## 6. Out of scope

- Screen changes, including any patient, doctor or staff screen for rescheduling or for showing the listed slots. Each becomes its own intent if wanted. (intent 003, Constraints; mocks waiver; F4)
- A waitlist. Its own intent if wanted. (intent 003, Constraints)
- Rate limiting reschedule requests or callers. Its own intent if wanted. (product owner decision, 2026-10-19)
- Holding or reserving listed slots for the caller.
- Retrying, or choosing an alternative slot, automatically on the server.
- Blocking or contacting the client that sends the retries.
- Changing booking's conflict answer (spec 001 R23).
- Running the incident runbook step, or changing data, clients or deployments for the incident.
- Changes to the metrics simulator, detector or bands in `ops/`.
