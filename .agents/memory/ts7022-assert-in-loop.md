---
name: TS7022 from assert.ok inside a loop
description: Why an inferred const narrowed by a node:assert assertion function becomes implicitly any inside a for-loop, and the fix.
---

A `const` whose type is inferred from its initializer and is then narrowed by an
assertion function (`assert.ok(x)` from `node:assert/strict`) compiles fine at
function scope, but inside a `for` loop it fails with:

`TS7022: 'x' implicitly has type 'any' because it does not have a type annotation
and is referenced directly or indirectly in its own initializer.`

The loop back-edge feeds the assertion-narrowed type from the previous iteration
back into the control-flow analysis of the declaration, so the inference is
circular. The error points at the declaration, which makes it look like the
initializer expression is untyped — it usually is not.

**Fix:** give the variable an explicit type annotation (`const x: T | undefined = ...`).
Do not add `as any` or annotate the callback parameter — those do not break the cycle.

**How to apply:** whenever a typecheck error blames an obviously-typed
`const y = arr.find(...)` for being implicitly `any`, check whether it sits in a
loop with an `assert.*` call on it a line or two later.
