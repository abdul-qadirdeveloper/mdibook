---
name: appointment-domain-rules
description: "MediBook business rules for appointments. Use whenever specifying or implementing booking, rescheduling, cancelling, schedules, slots, time zones, or role-based access."
---
# Appointment domain rules

- No double booking. A slot can have at most one active appointment, enforced by the database
  (a uniqueness guarantee), not only by application code. Concurrent attempts must resolve to
  one winner and a clear conflict result for the other.
- Time: store instants in UTC. Each clinic has an IANA time zone (for example America/Chicago).
  Convert only at the edges. Slot generation must be correct across daylight-saving changes.
- Reschedule is one atomic operation: the old slot is released only if the new one is taken.
- Cancellation window: patients may cancel up to 24 hours before the start without being
  flagged. Inside the window the cancellation is allowed but recorded as a late cancel.
  Staff and doctors may cancel at any time.
- Statuses: requested, confirmed, cancelled, completed, no_show. Only the listed transitions
  are valid. Completed and no_show can only be set after the start time.
- Roles: patient, doctor, staff. Staff belong to exactly one clinic and act only on doctors in
  that clinic. Every query and mutation must be scoped by clinic and role on the server.
- Every state change emits a notification event (log-based adapter in the MVP).