---
name: ux-standards
description: "MediBook accessibility and interface standards. Use whenever specifying or building screens, forms, error states, empty states, or loading states."
---
# UX standards

- Accessibility basics: every input has a visible label, everything works by keyboard, focus is
  visible, color is never the only signal, text contrast meets WCAG AA, tap targets are at
  least 44 by 44 px.
- Every screen defines four states: loading, empty, error, success.
- Errors say what happened and what to do next. They never expose internal details or personal
  data.
- Times always show the clinic's time zone name or abbreviation next to the time.
- Destructive actions (cancel, time off) ask for confirmation and state the consequence.
- Booking: a slot taken by someone else shows a plain message and offers the next open slots.