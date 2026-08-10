---
name: Drizzle phantom column in a partial select
description: Why a hand-written db.select({...}) that names a non-existent column takes down a whole route with a TypeError, and how to catch it.
---

A hand-written Drizzle partial select — `db.select({ alias: table.column, ... })` — that names a
column which does not exist on the table object resolves that entry to `undefined`. Drizzle's
`orderSelectedFields` then recurses into it and calls `Object.entries(undefined)`, throwing
`TypeError: Cannot convert undefined or null to object` while *preparing* the statement, before any
SQL is sent. Every request through that query returns 500.

**Why this is easy to miss:** TypeScript does not flag `table.nonExistentColumn` on a Drizzle table
object, so the build is clean. The error is not a `_DrizzleQueryError` and carries no SQL, so it
does not look like a database problem in the logs — the symptom is a bare TypeError with an empty
stack under pino serialization. It only fires on the one route that runs that query, so it can ship
green and surface as a total outage of a single feature.

**How to apply:**
- Suspect this first whenever a route throws `Cannot convert undefined or null to object` and the
  handler runs a partial select. Confirm by resolving each selected value against the table object
  (`table.foo === undefined`) — no database needed.
- Converting a `select()`-all into an explicit column list (usually done to add a `leftJoin`, since
  a bare `select()` with a join returns a nested `{ table: row }` shape) is the risky moment. Diff
  the new list against the table's real columns in both directions: invented names break the route
  outright, and quietly *dropped* real columns are a silent data regression in the response.
- A test can assert the selection has no `undefined` values without a database connection. Keep such
  selections as exported module-level consts so they are testable.
