# Intent: Reschedule conflicts leave the caller resubmitting a taken slot
Author: Abdul Qadir (Product Owner). Status: accepted.

## Problem
Incident INC-20261015-0415: from 2026-10-15T04:15Z, reschedules at the lakeside clinic lost
their chosen slot far more often than normal. The conflict rate reached 0.0584 at 04:39 (z 7.1),
against a baseline of 0.03, and did not come back down by the end of the feed. Since 04:15 the
sampled logs show 45 conflicts, all "slot taken". 25 of them (0.56) were the same slot sent
again. Before 04:15 that share was 0.03. 38 of the 45 conflicts, and all 25 same-slot retries,
were on one doctor, `doc_07`. Every failed move leaves the appointment where it was, so the
person moving it gets nowhere, and their next attempt mostly repeats the slot that was just
taken. Booking, the north clinic, and server error rates all stayed normal.

## Proposed outcome
- When a reschedule loses the race for a slot, the patient is told straight away which nearby
  slots with the same doctor are still open.
- Their original appointment stays exactly as it was: same time, same status.
- Resubmitting the slot that was just taken is no longer their only next move. They can pick
  one of the open slots instead.
- Same-slot retries on lakeside reschedules fall back towards their earlier share (0.03).

## Affected users and systems
- Roles: patients moving their own appointment. Staff and doctors also reschedule, but the
  incident does not show which role sent the retries.
- Systems: web app (reschedule flow and its conflict answer), database (no change to stored
  appointments on a failed move), operational metrics and logs for this incident.

## Constraints
- A reschedule stays one atomic operation: it either moves the appointment or changes nothing.
- A lost slot is final for that attempt (spec R23, R33). Never retry a conflict silently.
- Times stay UTC in storage and are shown in clinic-local time.
- Logs hold opaque ids only. No patient data appears anywhere: not in logs, metrics, messages,
  or this intent.
- Out of scope: redesigning screens, and a waitlist.

## Open questions
- Cause (hypothesis, from the incident): a caller resends the same slot after a "slot taken"
  answer, which multiplies conflicts. Confidence medium. Not confirmed.
- Alternative: real demand on `doc_07`, for example many moves after a schedule change. Did
  anything change on `doc_07`'s schedule or time off around 04:10–04:15?
- Who sends the retries: patient, staff, doctor, or an integration? The logs have no role,
  caller or client version. The patient appointments page offers no reschedule today ("call the
  clinic"), and no screen in this repository calls reschedule. So are patients affected
  directly at all?
- The server already includes the doctor's next open slots with its "slot taken" answer. Do
  callers receive and show them? If so, why do they still resend the taken slot?
- What does `n` count, and so how many conflicts each rate stands for?
- How is `sameSlotRetry` computed? Do the retries repeat the caller's own earlier slot, or
  someone else's?
- Reschedule takes no repeat-submission key, unlike booking. Is that part of the problem?
- Which internal doctor is `doc_07`? Was anything deployed or reconfigured near 04:10?
- Should "nearby" mean the same day, a fixed number of slots, or a time window?
