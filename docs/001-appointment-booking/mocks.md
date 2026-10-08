# Mocks: patient booking flow

- Intent: [001 MediBook appointment booking](../../intent/001-medibook-appointment-booking.md)
- Claude Design artifact: https://claude.ai/artifact/8KMXKDeSMfDAxzJs332534
- Date: 2026-10-08
- status: approved

## Screens included

1. Find a doctor (filters: name, specialty, location, availability)
   - Search: results
   - Search: loading
   - Search: no matches
   - Search: error
2. Doctor profile and open slots (times in the clinic's time zone)
   - Profile: open slots
   - Profile: loading
   - Profile: no open slots
   - Profile: error
3. Confirm booking
   - Confirm: review and details (date of birth, reason for visit)
   - Confirm: slot just taken (offers the next open slots)
   - Confirm: booked
4. My appointments
   - My appointments: upcoming and past
   - My appointments: loading
   - My appointments: none yet
   - My appointments: error

All names, clinics, addresses and dates in the mock are fictional placeholders.
