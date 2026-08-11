---
name: Dashboard fan-out and the DB pool budget
description: Why the connection pool ceiling is a budget shared across replicas, and why slow queries must be fixed before the pool is raised.
---

# Dashboard fan-out and the DB pool budget

The manager dashboard mounts ~25 concurrent API calls. Any endpoint that holds
a pooled connection for seconds turns that fan-out into pool exhaustion, and
the requests that queue behind it fail with
`timeout exceeded when trying to connect` — an *acquisition* failure, not a
query failure.

**Rule: fix the slow queries before raising the pool ceiling.** Raising `max`
alone only moves the failure to a higher concurrency level, and it costs real
database capacity.

**Why:** the pool ceiling is a budget, not a wish. The cost to Postgres is
`DB_POOL_MAX × replicas`, and an Autoscale deployment runs more than one
replica against the same database. Any increase must be checked against the
database's own `max_connections` *and* the configured replica ceiling, leaving
headroom for migrations, the session store, and manual `psql`. A bigger pool
does not make queries faster; past a point it oversubscribes the database CPU
and makes the burst worse.

**How to apply:** when a dashboard endpoint is slow, look first for a loop
issuing per-row queries (the classic shape here: iterate customers, call
storage per customer), a second function re-querying rows the caller already
loaded, unprojected `select()` pulling every column, and independent awaits
that should be `Promise.all`. Batch with `inArray` + grouping in memory, and
push the arithmetic into a pure function so the money logic stays testable and
unchanged.

**Related trap:** the slow-request telemetry writer persists an `http.slow`
row per slow request, so pool exhaustion generates extra DB writes that each
need a connection. Mild, but it makes a bad burst self-amplifying — worth
remembering when an incident looks like it is feeding itself.
