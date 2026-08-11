---
name: Invoice balance only counts once payment sync has run
description: Why an invoice fixture with a small `balance` still reads as the full total in tests and in the UI.
---

The shared balance resolver treats `balance` as meaningful only when the
invoice has a payment-sync timestamp; without one it falls back to the invoice
total and marks the value as a fallback.

**Why:** QuickBooks is the only writer of payment state. An invoice that has
never been synced has a `balance` column that is either zero-by-default or
stale, and showing that as "outstanding" would under-report A/R by the entire
unsynced set. Treating an unsynced row as "owes the full total" is the safe
direction to be wrong in.

**How to apply:** Any test fixture or seed row that wants a *partial* balance
(zero-balance refusals, "balance changed since the reminder went out",
partially-paid rows) must also carry a payment-sync timestamp, or every
assertion about the balance silently sees the invoice total instead. The
symptom is an expectation of, say, $175.50 meeting the total $300.00 with no
error anywhere — the resolver is doing exactly what it promises.
