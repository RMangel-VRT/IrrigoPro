#!/bin/bash
set -e
pnpm install --frozen-lockfile
# push-force: plain `drizzle-kit push` stops at an interactive confirmation
# prompt when the diff contains data-loss statements (e.g. dropping a retired
# table) and exits 0 without applying anything — so the dev DB silently
# drifts from the schema. --force applies the diff non-interactively.
# (Dev-DB only; production schema is owned by the Replit publish flow, which
# surfaces destructive changes to the user for confirmation. The dev DB is
# checkpointed and can be rolled back.)
pnpm --filter db push-force
# Regression check: fail the merge loudly if the push left the dev database
# missing any table/column defined in the Drizzle schema (guards against the
# silent-abort failure mode above ever recurring).
pnpm --filter db verify
