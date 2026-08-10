---
name: Role capability registry
description: Authorization is declared as capability sets; call sites ask what a user can do, never who they are.
---

Authorization for roles is declared as named capability sets in the shared package. Guards and UI
both resolve through a `hasCapability(role, capability)` helper. A new call site asks for a
capability; it does not compare role strings or add a role literal to an inline array.

**`hasCapability` returns false for an unrecognised role string and for null/undefined.**
Never "fix" that with a permissive null check.

**Why:** the QuickBooks gate was historically a *denylist* — it named the roles it refused and
called `next()` for everything else, so every role added afterwards passed by accident, as did an
undefined role. Converting to an allowlist is only safe if the unknown case is false. If refusing
an undefined role appears to break a caller, that caller was relying on an authorization bypass;
report it rather than restoring the bypass.

**Prefer allowlists to denylists for any role gate.** A denylist silently grants access to
everything it has not yet heard of — precisely the set of things that do not exist yet.

**Every UI control must be gated on the same capability as the endpoint behind it.** A control
whose gate is looser than its guard produces a button that 403s; a background query with a looser
gate produces a failure nobody sees. Both shipped here and had to be caught in review. When
adding a role, audit the whole page — the reachable controls, the modals they open, and the
queries that fire on mount — against the guards of the endpoints they call.

**How to apply:** when classifying an existing gate as read vs. write, default to write when
ambiguous — a wrongly-read-gated mutation is privilege escalation, while a wrongly-write-gated
read is a support ticket. Watch for read-shaped endpoints that are really part of a write flow
(a "preview" that assembles an unsaved record is create-flow, not a read).

**Widening a `Role` union surfaces almost nothing in typecheck** when role comparisons are typed
`string` rather than the union. Do not rely on the compiler to find sites needing a new role.
