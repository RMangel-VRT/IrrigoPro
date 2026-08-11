---
name: Shared dev database lags merged schema
description: Why a freshly merged feature's table can be missing at runtime, and why that is drift rather than a bug in your change.
---

# Shared dev database lags merged schema

DDL in this project is applied with drizzle push, not ordered migration files.
Nothing applies a merged task's schema to the shared dev database
automatically, so a feature can merge and its table can still not exist there.

**Symptom:** a route 500s with Postgres `42P01 relation "<table>" does not
exist` for a table that is plainly defined in the schema module, while that
feature's own test suite passes (integration suites create the tables they
need, and can drop them again on teardown).

**Rule: a 42P01 for a recently merged feature's table is environment drift,
not evidence that your change broke something.** Do not adopt it into your
task's diff.

**Why:** it is invisible in a code review of your branch, and it will reappear
in production on the next publish unless whoever owns that feature applies the
DDL. Silently "fixing" it inside an unrelated task hides that fact and makes
the real owner's gap harder to see.

**How to apply:** confirm the table really is absent for the *server's*
connection rather than trusting a query tool that may point elsewhere —
compare `current_database()` and `to_regclass('public.<table>')` from both
sides. If you need the endpoint working to finish your own verification,
create only the specific missing objects, and never run a full push whose diff
also drops or recreates constraints on unrelated tables. Then say plainly, in
the completion notes, that production still needs the same DDL.
