---
name: Catch-and-return-[] hides infrastructure failures
description: Why list readers that degrade to an empty array must distinguish connection-acquisition failures from query errors.
---

# Catch-and-return-`[]` hides infrastructure failures

Several storage list readers catch any error, log it, and `return []` so a
transient hiccup does not blank a page. That is reasonable for a query error —
but it turns a **connection-acquisition failure** into HTTP 200 with an empty
list, which the UI draws as "No work orders yet". The user sees missing data
with no error, reloads, it works, and never reports it. The incident is
invisible in the error rate.

**Rule:** before degrading a read to `[]`, classify the error. Failures to
*obtain* a connection (pg-pool queue timeout, connection-establishment
timeout, socket-level `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`EHOSTUNREACH`/
`ENOTFOUND`, and Postgres `53300`/`57P03`) must be rethrown so the route 500s.
Everything else keeps the existing degrade behaviour.

**Why:** silent and intermittent is the worst failure mode — it is
under-reported, so it persists and worsens as data grows. A visible error
state is strictly better than a plausible-looking empty one.

**How to apply:**
- Drizzle wraps driver errors, so any classifier must walk the `cause` chain
  (with a depth cap — a self-referential cause would hang the request thread
  inside a catch block).
- Keep the classifier narrow in *both* directions. Too broad and ordinary
  query errors start 500ing pages that used to survive them; test the negative
  cases (e.g. undefined_column `42703`, unique violation `23505`) explicitly.
- Rethrowing is only half the fix: check the frontend actually renders an
  error branch. A page that reads `isLoading`/`data` but ignores `isError`
  will still draw the empty state. Check the error branch *before* the empty
  state, and keep a test asserting the empty state still appears on a genuine
  zero-row success.
