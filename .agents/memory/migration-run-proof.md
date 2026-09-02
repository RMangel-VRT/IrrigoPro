---
name: A run's own report is not evidence
description: Why an admin "migration/job succeeded" banner must be backed by a post-run re-read, and how the client must be forced to show it.
---

A job that reports its own success proves nothing. Any admin-triggered run
(migrations, backfills, repairs, sweeps) must be reported as:

1. **The step results** — what the run believes it did.
2. **A post-run re-read** — the server independently re-evaluating the same
   status/preview check the page shows *before* the job is marked finished, so
   the first terminal poll already carries post-run facts.
3. **A distinct terminal state when those two disagree** (e.g. `mismatched`),
   carrying the specific shortfall. It must not be renderable as a success.
   An unverifiable success — the re-read itself threw — belongs in that state
   too.

**Why:** a green "succeeded" banner once sat beside a preview saying the rows
were still missing. Nobody could tell whether the writes had been rolled back,
run against the wrong database, or never happened, because every number on the
screen came from the run's own claims plus a pre-run cache.

Supporting rules that came out of the same incident:

- **A step reports `success` and a `rowsAffected` count only after commit.**
  Anything built inside a `db.transaction(...)` callback can still be undone;
  collect it, return it, push the result after the transaction resolves. Count
  rows present afterwards, not statements attempted.
- **A completion marker goes in the same transaction as the writes it vouches
  for.** A marker written in its own autocommit statement can outlive
  rolled-back writes and makes the migration's own `check()` lie afterwards.
- **Nothing on an admin page refreshes on its own** — this app's query cache is
  configured never to go stale, so after any mutating action explicitly
  invalidate every query whose numbers that action changed, or the operator
  reads pre-action counts beside a post-action banner (reopening a dialog just
  re-serves the cache). When a refetch *fails*, the cache still holds the old
  data: render the error instead of the retained numbers rather than beside
  them.
- **An admin page that can act on more than one database must name the one it
  is talking to** — environment + host + database name, never the user,
  password, or connection string.

**How to apply:** any time you add or review an admin-run job, a migration, or
a "repair" button, check all four. The cheapest test that catches the whole
class: make the run step *claim* writes it did not make, and assert the surface
refuses to call it a success.
