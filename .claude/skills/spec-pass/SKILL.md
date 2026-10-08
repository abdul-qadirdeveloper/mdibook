---
name: spec-pass
description: "Run the MediBook requirements-and-design pass on an accepted intent file and write spec.md."
argument-hint: "[intent-file]"
disable-model-invocation: true
---
Run the requirements-and-design pass on $ARGUMENTS (an intent file under intent/) using the
spec-template skill. Do its gate checks first and stop if one fails. Then read the intent, apply
the privacy, appointment-domain and UX skills so the spec conforms, and write
docs/<intent-slug>/spec.md in the template's format, ready to hand to the engineering team.

Describe clearly any areas of concern, especially where you cannot satisfy contradicting
policies. Answer the intent's open questions or carry them forward explicitly. Do not write
application code.