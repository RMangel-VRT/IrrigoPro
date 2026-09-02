---
name: Work type registry — selection vs resolution
description: Why a retired preset must still resolve its rule and its label everywhere, while never being selectable, and which count stays active-only.
---

A registry of preset codes (field work types) answers three different questions,
and reading one list for all three is what breaks records.

1. **What may a user choose for new work?** — active rows only.
2. **What is this stored code called?** — the full registry.
3. **What does this stored code require?** — the full registry.

**Why:** a record that already carries a since-retired code has to keep working.
Resolving a retired rule demands nothing new — it demands exactly what it
demanded the day the record was saved. Reading active-only resolved *no* rule,
which the shared location gate reports as "work type missing", so a ticket that
was captured correctly could not be re-saved after an unrelated edit, and the
retired type could not be re-selected either. Meanwhile the report that predicts
the gate's verdict read the full registry and insisted the ticket was fine. A
report that contradicts the gate is worse than either being wrong alone.

**How to apply:**
- Expose the three answers from one place (one fetch, three named accessors);
  never hand a caller a raw mixed list, because the "options to offer" and the
  "is the registry empty" questions usually live a few lines apart from the
  "what does this record require" question in the same component.
- The empty-registry fail-open counts **active** rows only. A tenant left
  holding nothing but retired rows is empty: nobody can pick a work type, so
  enforcing would be an outage. Resolution reading retired rows must not make
  that count look populated.
- Retired rows are surfaced only because a record already carries the code —
  render the real label plus a "no longer offered" note, and keep the row out of
  the choosable options entirely when nothing references it.
- Prove the report and the save gate against **each other** for a retired code,
  not each against a hand-written expectation; that is the assertion that would
  have caught the divergence.

A preset list owned by code also means no per-tenant editing: the manage
capability belongs to super admin, and a tenant admin gets a clean 403. Keep
that separate from cross-tenant probes, which stay 404 — a capability refusal on
your own data and an existence probe on someone else's are different questions.
