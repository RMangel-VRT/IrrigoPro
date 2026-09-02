---
name: Preset seed reconcile contract
description: Who owns a seeded preset row's columns — the source file, except the one column the tenant owns and the seed must never write.
---

For seed rows that are *presets owned by a source file*, "re-running changes nothing"
is not a safety property — it is what stops a later edit to the file from ever reaching
tenants seeded before it. A conflict-do-nothing seed reports success having changed
nothing.

**The rule:** the seed reconciles the columns the source file owns on every run, and
never writes the row's enabled/retired state, which the tenant owns.

**Why:** the file's ownership of labels and rule flags is the point of having presets;
the tenant's ownership of retirement is why one run must not silently re-enable
everything anyone ever turned off. This ownership split was chosen deliberately and it
reversed a shipped guarantee that customizations survive a re-run — do not restore that
guarantee thinking it was lost by accident.

**How to apply:**
- Enforce the never-written column in the type system (an owned-column union that
  excludes it), not in a comment.
- Completion means "matches the source file", not "no row is absent" — a drifted-but-
  complete tenant must read as partially applied, or the admin page retires the only
  thing that can fix it.
- Preview the rows that will change by name, and separate insertions from corrections. A
  rule-flag correction changes what a save-time gate demands of every record written
  afterwards; that is not something an operator should acknowledge blind.
- Drive preview, status, and write from one pure diff, so the preview cannot promise a
  change the run does not make.
