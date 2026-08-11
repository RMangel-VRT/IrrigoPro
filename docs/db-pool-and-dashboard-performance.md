# Database pool sizing and manager-dashboard performance

_Task #1898 — "Stop random page failures under load"._

## The incident

Production logs at 00:04:45 showed two queries failing in the same second with
`timeout exceeded when trying to connect`:

- `getEstimates` (the estimate-items query, reached from the estimate routes)
- `getWorkOrdersByCustomer` (logged as "Error fetching work orders by customer")

Neither was a bad query or a missing column. Both were failures to obtain a
database connection at all.

The surrounding requests explain why. Opening the manager dashboard fires
roughly twenty-five API calls at once, and in that same burst healthy requests
were taking 4–8 seconds (`/api/financial-pulse/kpis` 7972ms,
`/api/customers/billing-preview` 8219ms, `/api/admin/labor-rate-audit` 5680ms).
The shared pool allowed **10** connections and gave up after **5 seconds** of
waiting. Once ten slow queries were in flight, the eleventh queued, hit the
ceiling, and threw.

The user-visible symptom was an estimate list or work-order list that simply
wasn't there — no error, no toast — because the storage layer caught the
throw, logged it, and returned `[]`. A reload usually fixed it, so it was
almost never reported.

Two separate problems, in order of importance:

1. Several dashboard queries held a connection for seconds at a time.
2. The pool was too small and too impatient for a fan-out this wide.

Raising the ceiling alone would only have moved the failure, so the queries
were fixed first.

## Baseline

Reproduced with `artifacts/api-server/scripts/dashboard-burst.ts`, which logs
in as a throwaway `company_admin` and fires the dashboard's GETs
concurrently. Run against the dev database (2064 customers — 2030 in the
benchmark tenant, 1545 work orders, 2682 billing sheets, 365 estimates, 639
invoices).

```
BURST_FANOUT=1 pnpm --filter @workspace/api-server exec tsx scripts/dashboard-burst.ts
```

Knobs: `BURST_BASE_URL`, `BURST_COMPANY_ID`, `BURST_ROUNDS`, `BURST_FANOUT`
(number of copies of the 17-endpoint burst issued at once).

| Endpoint | Before | After |
| --- | ---: | ---: |
| `/api/customers/billing-preview` | 6155ms | 688ms |
| `/api/financial-pulse/kpis?period=ytd` | 4162ms | 1407ms |
| `/api/financial-pulse/by-technician` | 4159ms | 297ms |
| `/api/financial-pulse/kpis` | 3385ms | 1407ms |
| `/api/admin/labor-rate-audit` | 3368ms | 1403ms |
| `/api/billing-sheets` | 2689ms | 1424ms |
| `/api/estimates` | ~1990ms | 1404ms |
| **wall clock (17 concurrent)** | **6158ms** | **1314ms** |
| **sum of all request times** | **38604ms** | **11600ms** |

Under a 4× burst (68 concurrent requests), which is the closest local
reproduction of the production incident:

| | Before | After |
| --- | ---: | ---: |
| wall clock | ~20.6s | 4.6s |
| failed requests | 6–11 (HTTP 500) | **0** |
| `timeout exceeded when trying to connect` in the log | yes | **none** |

Run-to-run variance on a shared dev box is a few hundred milliseconds; the
shape of the result (no request over ~1.4s at 1×, zero failures at 4×) is the
part that matters, not the exact figures.

## Why each endpoint was slow

### `/api/customers/billing-preview` — a query loop over every customer

The handler iterated all ~2,030 visible customers and issued four sequential
storage calls per customer, one of which (`getBillingSheetsByCustomer`) itself
ran an extra query per billing sheet to load its items. That is on the order
of **8,000 round trips** for one request, each one taking and releasing a
pooled connection. It also fetched estimates per customer into a variable
(`approvedEstimates`) that was never read.

Fixed by `getBillingPreviewSources`, which issues **three** batched, projected
reads (work orders, billing sheets without their items, wet check billings)
with `inArray` over the customer id list, groups them in memory, and hands
them to the pure `buildBillingPreviewRows`. Money is still delegated to
`computeUnbilledPartition`, so the numbers are unchanged — verified by the
existing `customer-billing-parity` cross-endpoint test.

### `/api/estimates`, `/estimates/summary`, pending-approval — N+1 on items

`getEstimates`, `getEstimatesPendingApproval` and `getEstimateSummary` each ran
one `estimateItems` query per estimate to compute totals: 365 estimates meant
366 round trips. Replaced with a single `inArray` + `GROUP BY` aggregate
(`_estimateItemTotals`) feeding the pure `computeEstimateTotals`, which
preserves the `appliedLaborRate ?? laborRate` precedence and the
flat-vs-`per_part` labor modes.

### `/api/financial-pulse/kpis` — duplicated work and unprojected reads

`computeUnbilledExposure` re-queried the customer list and the same work
order / billing sheet / wet-check-billing tables that `/kpis` had *just*
loaded, doubling the endpoint's query count. It is now a **pure** function
taking the rows the handler already has. Separately, `loadCustomers`,
`loadTechs`, `loadInvoiceItemsForInvoices`, `loadWorkOrdersForInvoices` and
`loadBillingSheetsForInvoices` all did unprojected `select()`, pulling every
column (including large text fields) across the wire; they now select only the
columns they use.

### `/api/admin/labor-rate-audit` — serial independent scans

`getLaborRateMismatchTickets` awaited two independent raw SQL scans one after
the other. They are now issued with `Promise.all`.

## Pool sizing

Set in `lib/db/src/index.ts`, overridable by environment variable:

| Setting | Was | Now | Env var |
| --- | ---: | ---: | --- |
| `max` | 10 | **20** | `DB_POOL_MAX` |
| `connectionTimeoutMillis` | 5000 | **15000** | `DB_POOL_CONNECT_TIMEOUT_MS` |

The ceiling is a budget, not a wish. The cost to the database is
`DB_POOL_MAX × replicas`, and an Autoscale deployment can run more than one
replica against the same database. Sizing a single replica at 20 and planning
for a worst case of five replicas gives **100** connections, which leaves
room under a managed-Postgres connection limit for migrations, the session
store, and manual `psql` sessions.

Raise `DB_POOL_MAX` only alongside a check of the database's own
`max_connections` **and** the configured replica ceiling. A larger pool does
not make queries faster; it only lets more of them run at once, and past a
point it makes things worse by oversubscribing the database's CPU.

The acquisition timeout is a different thing from query time: it is how long a
caller waits for a *free connection*. Five seconds was short enough that an
ordinary dashboard burst tripped it. Fifteen seconds absorbs a burst while
still failing loudly instead of hanging forever.

## Tenant scoping fixed alongside the batching

While rewriting the billing-preview handler it became clear the customer list
itself was read with an unscoped `storage.getCustomers()`. The row-level
sources were company-scoped, so other tenants' money came back as zero — which
made the leak look like harmless empty rows, while their customer names,
emails and phone numbers were real and rendered. The handler now derives the
caller's company exactly as `GET /api/customers` does, and passes it to both
`getCustomers` and `getBillingPreviewSources`.

The handler was moved into `artifacts/api-server/src/routes/billing-preview-route.ts`
so this is testable against a storage stub without a live Postgres. `routes.ts`
registers that function — it is the real handler, not a mirror, so the test and
production cannot drift apart. See `billing-preview-tenant-scope.test.ts`,
which also asserts the endpoint issues a constant number of storage calls
regardless of customer count (the N+1 regression guard).

## Failing visibly

A pool-acquisition failure must not look like "no data". `isConnectionAcquisitionError`
(exported from `@workspace/db`) walks the `cause` chain and recognises the
pg-pool queue timeout, the connection-establishment timeout, socket-level
failures (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`,
`ENOTFOUND`) and the server refusing new connections (`53300`, `57P03`).

The work-order list readers (`getWorkOrders`, `getWorkOrdersByTechnician`,
`getWorkOrdersByCustomer`, `getWorkOrdersByStatus`, `getWorkOrdersByEstimate`)
now rethrow when the classifier matches, and keep their existing
degrade-to-`[]` behaviour for every other error. That turns a silent empty
list into a 500, which the frontend query layer already converts into
`isError`. The estimate list and the customer profile's estimate and
work-order sections render an explicit error block with a retry, checked
*before* the empty state.

## Observation, not fixed here

`insertAppEvent` writes an `http.slow` row for every slow request. During pool
exhaustion this means the incident generates additional database writes, each
needing its own connection — a mild feedback loop that makes a bad burst
slightly worse. It was left alone because it is genuinely useful telemetry and
was not a primary contributor, but it is worth remembering if a future
incident looks self-amplifying.

## Deliberately out of scope

- **No new indexes**, and no production schema change of any kind. Every
  improvement above is a change to how queries are issued, not to the
  database.
- **No caching layer.** The queries and the pool were the problem; a cache
  would have hidden it.
