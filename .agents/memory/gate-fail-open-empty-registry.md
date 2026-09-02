---
name: Gates over an empty tenant registry
description: When a gate requires a value from a per-tenant registry the tenant cannot populate, enforce nothing and audit the skip.
---

A gate that requires a value from a per-tenant registry must fail open when
that registry is confirmed empty, and the skip must be recorded as an audited
event carrying the company id.

**Why:** a tenant whose registry was never seeded had no action available that
satisfied the gate, so enforcing it was an outage rather than enforcement — it
blocked every field tech until a seed was run, while the UI advised an action
nobody could take. Failing open silently would instead hide that the tenant had
lost field capture, so the skip is the thing worth alarming on.

**How to apply:**
- Distinguish *confirmed empty* (a resolved count of zero) from *unknown* (a
  failed or absent lookup). Unknown keeps the gate on; only a confirmed zero
  fails open.
- Return a decision the caller can audit, not a bare boolean — a skip and a
  non-applicable gate are different events.
- Client and server must fail open on the *same* count, resolved for the same
  tenant. A super admin's unscoped read sees other tenants' rows, so a
  record-scoped lookup is required or the client blocks a save the server
  accepts.

Related: a cross-surface gate should turn on the fact being gated, never on the
caller's role. A role condition on one surface and not the other makes the same
rule behave differently depending on which screen was opened, and roles that do
the same field work (a manager acting as a tech) produce exactly the records
the gate exists to prevent. Delete the role parameter rather than widening it
to a list — a parameter that always passes invites the condition creeping back.
