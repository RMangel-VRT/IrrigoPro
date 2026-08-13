---
name: A standalone migration script is a migration that never runs
description: Backfills belong in the migration registry; numbered standalone scripts have no caller and silently never execute.
---

A numbered backfill written as a standalone file with its own `main()` has
**no caller**: nothing invokes it at startup, no registry references it, and
nothing fails when it is never run. Expect to find such a script unrun, with
its data problem still live and blamed on the UI that surfaces it.

**Why:** the migration registry (preview, acknowledge, completion marker,
visible at `/admin/migrations`) exists precisely so a written-but-unrun
migration is visible. A script outside it is invisible by construction.

**How to apply:**
- Write backfills directly as a registry `MigrationDefinition`, never as a
  standalone script.
- When porting an existing script, move its SQL **verbatim** and prove it with
  a mechanical statement-by-statement diff, not by eye.
- `check()` should infer completion from the data, not only from the marker,
  so a run performed by hand is recognised.
- Preview counts from the dev database say nothing about production; ticket
  numbers are usually production numbers. Report both and let the owner
  acknowledge against production before anything writes.
