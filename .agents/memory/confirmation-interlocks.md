---
name: Confirmation interlocks for high-blast-radius actions
description: When a feature's safety property is "a human saw the list first", the ordering must be enforced at the API boundary, not in the dialog.
---

# Confirmation interlocks

When an action's stated safety property is "nothing happens until a person has
reviewed exactly what will happen" — batch email sends, bulk deletes, mass
status changes — a preview endpoint plus a confirming dialog is **not** an
interlock. The send endpoint stays independently callable, so the guarantee
only holds for clients that choose to honour it.

The shape that does hold:

- the dry-run/preview endpoint issues a short-lived confirmation token,
  HMAC-signed over the caller, the company, the *normalized* target ids and
  every other choice the preview described (tone, template, options);
- the acting endpoint requires it, rejects before touching the side-effecting
  path, and spends it so one reading of the list authorises exactly one run;
- rejection messages are uniform across "wrong ids / wrong user / wrong
  option", so the error cannot be used to probe what a valid request is;
- validate the request *shape* before the confirmation, so a malformed
  selection still gets its own explanation rather than a confirmation error.

**Why:** a completion code review rejected an otherwise-sound batch reminder
implementation purely on this point — the confirmation list was mandatory in
the UI and optional at the boundary, and the tests themselves demonstrated the
endpoint being called with no preceding preview.

**How to apply:** any time a plan calls a confirmation "mandatory", or one
control can affect many customer-visible records at once. Sign with a subkey
derived from `SESSION_SECRET` (a per-process random fallback fails safe: the
worst case is "review the list again"), and keep send-time re-validation —
the token authorises the run, it does not vouch for the targets still being
eligible.
