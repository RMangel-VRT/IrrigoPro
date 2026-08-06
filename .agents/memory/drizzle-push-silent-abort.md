---
name: Drizzle push silent abort on data-loss prompts
description: drizzle-kit push exits 0 without applying anything when the diff contains data-loss statements; dev DB drifts silently and publish then ships code without the new columns.
---

## Rule
Never trust a plain `drizzle-kit push` exit code. When the diff contains data-loss statements (table/column drops), it stops at an interactive confirmation prompt and exits **0 without applying anything** — `set -e` cannot catch it. Automated pushes must be non-interactive (`--force`) and be followed by a drift check (`pnpm --filter db verify`) that asserts the DB matches the schema.

**Why:** A retired-table drop in the diff made every automated dev push silently no-op; publish diffs dev↔prod, saw no schema gap, and production shipped code selecting columns that didn't exist (500s).

**How to apply:** If code references a column the DB says doesn't exist, suspect a swallowed data-loss prompt before suspecting the code. Run the drift check first.

## Ordering rule for retired tables
Before a schema push that drops a legacy table reaches any environment, confirm its data has been imported into the replacement table. For production this means: run the relevant idempotent Super Admin registry migration in the deployed app **before re-publishing**, because the publish-time schema diff drops the legacy table in prod.
