---
name: One scoping contract for a list and its aggregates
description: Why a summary endpoint must derive its tenant/company scope from the same helper as the list it sits above, and how the mismatch hides.
---

A summary endpoint added above an existing list must resolve its scope through
**the same helper the list uses**, not its own rule — even when the new rule
looks stricter and safer.

**Why:** the strict rule and the old permissive one disagree exactly where the
old one is unusual. A cross-tenant role whose list deliberately reads every
tenant, paired with an aggregate that demands one tenant, yields either a
single-tenant balance printed over a cross-tenant table or an error strip over
a working one. Both are silent: each endpoint is defensible alone, and no test
that exercises one endpoint can see it. "Requires an explicit tenant param" is
only stricter if the list requires it too; otherwise it is just different.

**How to apply:** extract a single `resolveScope(req)` returning the tenant or
an explicit refusal, and call it from both routes. A scoped caller is pinned to
her own tenant and a tenant param she sends is ignored, never honoured. Send
the scope from the client on **every** request the page makes — list,
aggregate, and any select-all/export fetch — so one contract governs all of
them. Test that both endpoints read the same tenant for the same request, in
both the named and unnamed case.
