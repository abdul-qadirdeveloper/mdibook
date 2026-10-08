---
name: claude-design-mock
description: "Create UI mocks, wireframes, screen designs and prototypes for MediBook in Claude Design, never as an HTML file in the repo. Use whenever the user asks for a mock, mockup, wireframe, screen design, UI design or prototype."
argument-hint: "[intent-file] [screens to mock]"
---
# Make mocks in Claude Design

When asked for a mock, mockup, wireframe, screen design or prototype, the deliverable is a
**Claude Design artifact**, not a file in this repository.

Do:
1. Read the intent or spec file the user names, plus the `ux-standards` skill. Apply its
   accessibility rules and the four states (loading, empty, error, success) to every screen.
2. Use the Artifact tool, not Write. First call it with action "quickstart" and intent "design",
   then create the artifact from the **Design** type it lists, following the instructions that
   come back with it. Give it a short title such as "MediBook patient booking mock".
3. Build the screens inside that Design artifact. Use fictional placeholder data only. Never
   use real patient names or details.
4. When done, give the user the one-line summary and the artifact link. Then write
   `docs/<slug>/mocks.md` with the link, the date, the screens included, and "status: draft".
   That small markdown file is the only thing that goes into the repo.

Do not:
- Do not create .html, .css, .jsx, .svg or image files in the repo as the mock.
- Do not fall back to a hand-built HTML page if the Design type is not listed or the Artifact
  tool is missing or errors. Stop, say exactly what was missing or what the error said, and ask
  the user how to proceed (for example: enable Claude Design in their organization settings, or
  open claude.ai and make the mock there).
- Do not mark the mock approved. Only the product owner approves.