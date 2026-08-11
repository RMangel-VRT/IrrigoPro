# Merge gate: which check owns which drift direction

`scripts/post-merge.sh` is the merge gate (there is no CI). It now runs four steps,
and three of them each own exactly one direction of schema/code drift. Nothing else
in the repo covers these, so if a step is weakened the direction it owns goes unguarded.

| Drift direction | Owned by | Failure mode it prevents |
| --- | --- | --- |
| A schema diff is generated but silently **not applied** | `pnpm --filter db push-force` | Plain `drizzle-kit push` stops at an interactive confirmation when the diff contains data-loss statements and exits **0 without applying anything**; `set -e` cannot see it. `--force` applies non-interactively. |
| The **database is missing what the schema defines** | `pnpm --filter db verify` | A push that partially applied, or did not run, leaves the dev DB without a table/column the Drizzle schema declares. Verify asserts DB ⊇ schema and fails the merge loudly. |
| **Code references what the schema does not define** | `pnpm run typecheck` | A query selecting a column that was never in the schema. This is the #1885 outage: five phantom fields on `wetCheckZoneRecords`; each resolved to `undefined`, Drizzle's `orderSelectedFields` did `Object.entries(undefined)` at prepare time, and every `GET /api/wet-checks/:id` returned 500. The DB matched the schema perfectly, so neither `push-force` nor `verify` could see it. |

`pnpm install --frozen-lockfile` is the fourth step and owns no drift direction; it just
makes the other three run against the merged dependency set.

Ordering is load-bearing: the typecheck goes **last** because `typecheck:libs`
(`tsc --build`) compiles `lib/db` and the artifact projects read its emitted
declarations. The schema has to be settled (pushed and verified) before the compiler
is asked whether the code agrees with it.

## Proof the gate is not decorative

Captured on the current tree by reintroducing one of #1885's phantom fields
(`issueSummary`) into `WET_CHECK_ZONE_RECORD_SELECTION` in
`artifacts/api-server/src/storage.ts`.

### 1. Typecheck fails, naming file, line and property

```
$ pnpm run typecheck
...
artifacts/api-server typecheck: src/storage.ts(1513,37): error TS2339: Property 'issueSummary'
  does not exist on type 'PgTableWithColumns<{ name: "wet_check_zone_records"; schema: undefined;
  columns: { id: PgColumn<...>; ... 14 more ...; controllerId: PgColumn<....'.
artifacts/api-server typecheck: Failed
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @workspace/api-server@0.0.0 typecheck: `tsc -p tsconfig.json --noEmit`
Exit status 2
$ echo $?
2
```

The prose claim in `wet-check-select-shape.test.ts` that "TypeScript does not catch
this" is wrong for a *selection object typed against the table*: `wetCheckZoneRecords.issueSummary`
is a property access on a fully-typed `PgTableWithColumns`, so it is a hard `TS2339`.
That test remains the guard for the shapes the compiler cannot see (spreads, dynamic
builders, raw strings).

### 2. Typecheck passes once the field is removed

```
$ pnpm run typecheck
Scope: 6 of 12 workspace projects
artifacts/mockup-sandbox typecheck: Done
artifacts/irrigopro-mobile typecheck: Done
artifacts/pitch-deck typecheck: Done
scripts typecheck: Done
artifacts/api-server typecheck: Done
artifacts/irrigopro typecheck: Done
$ echo $?
0
```

### 3. The merge hook itself exits non-zero — observed, not inferred from `set -e`

```
$ bash scripts/post-merge.sh   # with the phantom field present
...
artifacts/api-server typecheck: src/storage.ts(1513,37): error TS2339: Property 'issueSummary' does not exist ...
 ELIFECYCLE  Command failed with exit code 2.
POST_MERGE_EXIT=2
```

With the field removed, the same script exits 0.

## Timing against the 120 s hook budget

`.replit` sets `timeoutMs = 120000` on `[postMerge]`. Measured on this repl:

| Run | Result | Elapsed |
| --- | --- | --- |
| Full hook, cold (no `*.tsbuildinfo`), clean tree | exit 0 | **51.9 s** |
| Full hook, warm, clean tree | exit 0 | **45.3 s** |
| Full hook, warm, phantom field present | exit 2 | 30.5 s (fails at the last step) |
| `pnpm run typecheck` alone, cold | exit 0 | 40.6 s |
| `pnpm run typecheck` alone, warm | exit 2 / 0 | 16.2 s – 31.2 s |

Per-step breakdown of a warm passing hook:

| Step | Elapsed |
| --- | --- |
| `pnpm install --frozen-lockfile` | 3.6 s |
| `pnpm --filter db push-force` | 5.1 s |
| `pnpm --filter db verify` | 1.6 s |
| `pnpm run typecheck` | 31.2 s |
| total | ~41.5 s |

**Verdict: the hook fits comfortably.** Worst observed total is 51.9 s against a
120 s budget — about 43 % of it, ~68 s of headroom. The timeout was left at
120000. Revisit (raise, do not weaken the check) if a routine hook run starts
landing above ~80 s; the two things that would push it there are a merge whose
lockfile changes materially (install was measured at only 3.6 s as a no-op) and
continued growth of the api-server and web sources, which dominate the typecheck.

**Build-info cache: only partly survives, and only for the libs.**
`*.tsbuildinfo` is gitignored and lives in the working tree, so `tsc --build` on
`lib/*` does keep its cache between merge runs (worth ~9 s). The five artifact
packages and `scripts` run `tsc -p tsconfig.json --noEmit`, which is not
incremental and writes no build info — **every merge pays their full cost**, which is
the bulk of the 31 s. That is why the warm number is only modestly better than cold.

## What the gate actually covers

`pnpm typecheck` = `tsc --build` at the root (which walks the root
`tsconfig.json` project references) followed by `pnpm -r --filter "./artifacts/**"
--filter "./scripts" --if-present run typecheck`. Reported scope: **6 of 12 workspace projects**.

Covered:

- via root project references — `lib/db`, `lib/api-client-react`, `lib/api-zod`, `lib/shared`
- via the recursive run — `@workspace/api-server` ✅ (confirmed present: `artifacts/api-server typecheck: Done`),
  `@workspace/irrigopro`, `@workspace/irrigopro-mobile`, `@workspace/pitch-deck`,
  `@workspace/mockup-sandbox`, `@workspace/scripts`

### Known gaps (reported, not fixed)

1. **Test files in the web, slides and design packages are excluded from typecheck.**
   `artifacts/irrigopro/tsconfig.json` excludes `**/*.test.ts`, `**/*.test.tsx` and
   `src/test/**`; `artifacts/pitch-deck` and `artifacts/mockup-sandbox` exclude
   `**/*.test.ts` too. A test file with a broken import or a stale type still merges
   clean — the gate never compiles it. (`artifacts/api-server` includes all of `src`,
   so *its* tests are typechecked; `artifacts/irrigopro-mobile` includes everything too.)
   Removing the excludes will surface a backlog of pre-existing errors, so it needs its
   own task.

2. **`lib/api-spec` is checked by nothing.** It is a workspace package, it is in no
   root project reference, it has no `tsconfig.json`, and it has no `typecheck` script,
   so `pnpm -r` skips it (`--if-present`). Its only TypeScript file is `orval.config.ts`
   — small, but a break there is invisible until someone runs `pnpm --filter
   @workspace/api-spec run codegen`. Its *generated* output lands in
   `lib/api-client-react` and `lib/api-zod`, both of which are covered.

## The publish path does not typecheck (recommendation only)

`.replit` has **no `[deployment] build` and no `[deployment] run`** — only
`router = "application"`, `deploymentTarget = "autoscale"` and a `postBuild` prune.
With `router = "application"` the publish flow builds each artifact from its own
`.replit-artifact/artifact.toml`:

| Artifact | Production build the publish flow runs | Typechecks? |
| --- | --- | --- |
| api-server | `pnpm --filter @workspace/api-server run build` → `node ./build.mjs` (esbuild bundle) | ❌ esbuild strips types without checking them |
| irrigopro (web) | `pnpm --filter @workspace/irrigopro run build` → `vite build` | ❌ esbuild transform, no type checking |
| pitch-deck | `pnpm --filter @workspace/pitch-deck run build` → `vite build` | ❌ |
| irrigopro-mobile | `pnpm --filter @workspace/irrigopro-mobile run build` → `node scripts/build.js` (Metro export) | ❌ |
| mockup-sandbox | no `[services.production]` — not published | n/a |

The root `build` script — `pnpm run typecheck && pnpm -r --if-present run build`, the
one place a build implies a typecheck — is **never invoked by publish**. Each artifact's
production build calls its own package script directly, bypassing the root.

**So the publish path does not reach `build` in the typechecking sense, and that is how
#1885 shipped**: nothing between writing the phantom column and serving 500s in
production ever asked the compiler a question.

Recommended (deliberately not done here, deployment config is out of scope for this task):
make the publish path typecheck as well as the merge path, by either

- adding a root `[deployment] build` of `pnpm run typecheck` in `.replit`, so it runs
  once before the per-artifact builds, or
- prefixing each artifact's own `build` script with the root typecheck (slower — it
  would run once per artifact).

The first is cheaper and mirrors what the merge hook now does. Until one of them lands,
the merge gate is the only thing standing between a type error and production, which
means a change published without going through a merge is still unguarded.
