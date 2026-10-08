---
name: healthcare-privacy
description: "MediBook patient-data handling rules. Use whenever designing or changing anything that stores, shows, logs, emails, or exports patient or appointment data, including specs, schemas, APIs, logging, error handling, and notifications."
---
# Healthcare privacy rules (good engineering hygiene, not a compliance program)

Treat patient data as PHI-like. Anything that identifies a patient, or reveals why they
are seeing a doctor, is sensitive.

1. Minimum necessary: every role sees only the fields it needs. Patients see their own data.
   Doctors see their own patients' appointments. Staff see appointments for their own clinic only.
2. Logs and errors: never put names, emails, phone numbers, dates of birth, visit reasons or
   clinical notes in application logs, error messages, or analytics. Log opaque IDs only.
3. Audit: every state-changing action emits an audit event with actor id, actor role, action,
   entity type, entity id, clinic id and UTC timestamp. Audit events hold IDs, never payloads.
   Clinic id is left empty only for an action that belongs to no clinic, such as a patient
   changing their own account.
4. Notifications: contain the least needed to act. Do not include the doctor's specialty or the
   visit reason. Link to the signed-in app for details.
5. Free text is a risk: prefer fixed lists to free-text fields where staff or doctors record
   reasons. If free text is unavoidable, say who can read it.
6. If a requirement conflicts with these rules, flag it. Do not silently pick one.
7. Never claim the system is compliant with any regulation.