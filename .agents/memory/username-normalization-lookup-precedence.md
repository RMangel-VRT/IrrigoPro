---
name: Username normalization lookup precedence
description: When a login lookup strips invisible characters, the RAW value must be tried before the cleaned one, or lookalike accounts get cross-selected.
---

When an identifier lookup normalizes its input (NFKC, stripping `\p{Cf}`/`\p{Cc}`,
trimming), try the **raw submitted value first** whenever it differs from its
normalized form, and only fall back to the normalized value.

**Why:** normalizing the request but not the stored column silently changes
*which row* is selected. If `bob` and `bob\u200B` both exist as separate
accounts, cleaning the input first resolves a paste of `bob\u200B` to the `bob`
row. The password check then fails against a stranger's hash, locking out a user
who could sign in a minute earlier — and any "reset the password for this
username" path aimed at the same value rewrites the wrong person's credentials.
Cleaned-first also breaks the rollout: while a stored value is still corrupt, the
cleaned form matches nothing, so shipping normalization ahead of the data repair
removes the only access that still worked (pasting).

Raw-first is strictly safe because it can only find a row an exact match would
already have found. It never widens access on its own; the normalized query is
what widens, and it runs second.

**How to apply:** any lookup keyed on a user-supplied identifier that also
normalizes it — login, password reset, invitation acceptance, API-key or
clock-number lookup. Two ordering rules fall out:

- Resolve to a single row, then write by primary key. A normalized or
  case-insensitive *predicate* on an UPDATE can rewrite several rows while
  returning only the first.
- Ship the code before the data repair only if the raw fallback exists; the
  repair migration is what restores access for the typed form, not the deploy.

Repairing stored values is a separate, later step, and it must refuse any rewrite
that would collide case-insensitively with another account rather than merging
two identities. Preflight the collision count against real production rows using
the migration's own planner before running it.
