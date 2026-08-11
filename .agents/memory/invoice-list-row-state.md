---
name: Per-row UI state on the invoices list
description: Why per-row expansion/disclosure state must stay in local component state and out of the A/R URL params, and how capability-gated sections are handled there.
---

## Rule 1 — per-row UI state never goes in the A/R URL params

Any new per-row disclosure state on the invoices list (row expansion, inline
detail, per-row toggles) belongs in plain local component state. It must not be
written to the URL or folded into the A/R query params.

**Why:** the page has an effect that clears the batch selection whenever the A/R
params change. Routing per-row UI state through those params silently wipes the
user's ticked rows and can refetch the list, dropping pages already loaded via
"Load more" and collapsing the month grouping. The symptom looks like a
selection bug, not a routing bug, so it is expensive to trace back.

**How to apply:** when adding a row-level toggle, hold it in `useState` on the
page, keep it out of `arParams`/`setLocation`, and assert in tests that the
wouter history is unchanged and the list request count is unchanged across a
toggle.

## Rule 2 — capability-gated sections gate by absence, on both ends

Sections inside the row that need a capability the invoice-read role may not
hold (reminder history needs the invoice-send capability; A/R notes need the
note-read capability) are simply not rendered and not requested for a role that
lacks them.

**Why:** the alternative — render and let the server 403 — turns a legitimate
narrower role into a permanent spinner or a red error inside an otherwise
working row. Widening the capability to make the section appear is worse: it
grants send/notes rights to buy a read.

**How to apply:** compute the capability client-side purely to decide whether to
mount the section; the server guard stays the actual protection. Test both that
the section is absent and that no request was issued for it.

## Rule 3 — one source-derivation rule

The invoice line-item work date is derived from the source ticket (work order,
billing sheet, wet check billing), and that derivation is shared by the audit
view and the line-item read. Do not inline a second copy: the invoice
*generation* path has its own, different work-date choice, so a grep for
"workDate =" finds legitimate non-matches and a copy hides easily.
