---
name: Bundler hides ESM temporal-dead-zone breakage after a merge
description: Why a module can work under the running server but throw "Cannot access X before initialization" in tests, and what to check after any rebase that touches a shared lib entrypoint.
---

# Bundler hides ESM temporal-dead-zone breakage after a merge

A rebase or merge that touches a shared library's entrypoint can reorder the
file so a `const` is *used* above where it is *declared*. TypeScript does not
flag this, and it is easy to miss in review because the diff looks like a
harmless hunk relocation.

**Rule: after any merge that touches a shared lib entrypoint, run something
that imports it through plain ESM — not just the bundled server.**

**Why:** the API server is bundled with esbuild, which hoists and reorders
bindings, so the bundle runs fine. Direct ESM execution (the test runner via
tsx) does not, and throws `ReferenceError: Cannot access '<name>' before
initialization` at import time. The result is a green-looking dev server and a
whole test suite that dies during import — and because the failure happens
while loading the package, *every* suite that imports it fails at once, which
looks like a much larger regression than it is.

**How to apply:** when a broad set of unrelated suites all start failing
together right after a merge, suspect a single import-time throw in a shared
module before suspecting the suites. Run one cheap suite that imports the
package and read the *first* error, not the summary. The same merge can also
silently drop guard clauses (e.g. a required-env check) from the top of the
file, so re-read the whole entrypoint rather than only the conflicted hunk.

**Related:** the type surface of a workspace lib may resolve through its
generated `.d.ts` output rather than its source. If that output directory is
gitignored and the package has no build script, editing the lib's source
leaves the types stale and produces "module has no exported member" errors for
things that plainly exist in the source. Rebuild the lib's declarations before
trusting a typecheck result.
