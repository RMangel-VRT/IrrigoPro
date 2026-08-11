---
name: Merge gate vs publish path — where typechecking actually happens
description: The post-merge hook is the only place a type error is caught; the publish flow builds each artifact from its own artifact.toml script and never runs the root build, so it never typechecks.
---

## Rule
Treat the post-merge hook as the **only** type gate. Publishing does not typecheck.

**Why:** With `router = "application"`, the publish flow builds each artifact from
`artifacts/<name>/.replit-artifact/artifact.toml` → `[services.production.build]`, which
invokes that package's own `build` script (esbuild bundle for the api server, `vite build`
for the web/slides artifacts, a Metro export for mobile). All of those strip types without
checking them. The root `build` script — the one place a build implies `pnpm run typecheck`
— is never invoked, and `.replit` has no `[deployment] build`. A phantom-column outage
reached production this way with nothing in between ever asking the compiler.

**How to apply:** Do not assume "it built, so it compiles". If a change can bypass a merge
(published straight from the workspace), it bypasses type checking entirely. Closing that
means a root `[deployment] build` running the typecheck once, before the per-artifact builds.

## The three drift directions, and who owns each
- schema diff silently not applied → `drizzle-kit push --force`
- database missing what the schema defines → `pnpm --filter db verify`
- code referencing what the schema does not define → `pnpm run typecheck`

Nothing else covers any of them. The typecheck must run **last** in the hook: the libs build
compiles `lib/db` and the artifact projects consume its emitted declarations, so the schema
has to be settled first.

## Cost characteristics
Only the `tsc --build` libs step is incremental; `*.tsbuildinfo` is gitignored but survives in
the working tree between merges. Every artifact package runs `tsc -p … --noEmit`, which writes
no build info, so **each merge pays their full cost** — the artifact packages, not the libs,
dominate the typecheck's runtime, and a warm run is only modestly cheaper than a cold one.
