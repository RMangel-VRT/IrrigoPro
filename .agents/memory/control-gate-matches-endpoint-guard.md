---
name: Gate a control on the endpoint's guard, not the conceptually right capability
description: A UI control's capability must equal the route guard behind it; what to do when the "right" capability is wider.
---

Gate a rendered control on **the capability set the endpoint it calls is
guarded by**, not on the capability that best describes the concept. When a
spec asks for the conceptually-correct capability and that set is *wider* than
the route's guard, do not widen the control — split it (read-only indicator on
the conceptual gate, action on the route's own guard) and file the server
re-gate as its own ticket.

**Why:** a control gated more loosely than its endpoint is a button that 403s.
It is invisible in review because the JSX reads correctly; the mismatch only
exists across two files.

**When the route is the thing that is wrong.** The rule above is about not
widening a *control* past its endpoint; it does not forbid re-gating the
*endpoint*. If a route's guard names a capability the operation does not
actually exercise — a call that writes only into a third-party system guarded
by "may edit our records", say — the coherent fix is to move the route onto the
capability that owns that surface, so the whole surface (indicator, sync,
per-item push) answers to one gate. Do that only when the new set is a superset
of the old one, so no caller loses access; verify membership rather than
assuming, assert the guard in a route test and the control in a role test, and
say plainly in the change notes which role newly gains the action.

**How to apply:** look up the route's guard before adding or re-gating any
control. If the two genuinely differ, record the control → gate → endpoint
mapping in an audit doc and assert it in a per-role test that walks the
rendered output, so a later re-gate cannot drift silently.
