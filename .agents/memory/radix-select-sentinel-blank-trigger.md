---
name: Radix Select sentinel values render a blank trigger
description: Why a shadcn/Radix Select can show neither a value nor its placeholder, and how tenant-seeded option lists turn that into a "the dropdown won't open" bug report.
---

Radix's SelectValue shows the placeholder only when the Root's `value` is `""`
or `undefined`. Any other string that has no matching SelectItem renders as
nothing at all — no value, no placeholder, no error.

**Why:** the common shadcn idiom of a `__none__` sentinel for an optional
"— None —" item breaks the moment that item is conditionally hidden (for
example when a field becomes required). The Root still holds `__none__`, the
item is gone, and the trigger goes blank. It looks like a dead control, and
users report it as "the dropdown doesn't expand" rather than "the label is
missing".

**How to apply:** bind the Root to `""` for the empty state and keep the
sentinel on the item only. Also render a fallback item for a stored value that
is no longer in the option list (deactivated/renamed), or the same blank
trigger returns for legacy records.

## The sibling failure: an option list nobody seeded

A per-tenant option list that is populated by an opt-in Super Admin data
migration is empty until someone runs it. An empty list plus a helper that
collapses 401/403 to `[]` yields a menu with zero items, which genuinely does
not appear to open.

**Why:** when a validation gate requiring a choice from that list goes live
before the seed runs, the requirement is unsatisfiable — the user is hard
blocked with no visible explanation.

**How to apply:** never let a select render an empty menu silently. Separate
loading / error / "none configured" into distinct visible states, and check
that the seed migration has actually run in production before activating any
gate that depends on the registry it fills.
