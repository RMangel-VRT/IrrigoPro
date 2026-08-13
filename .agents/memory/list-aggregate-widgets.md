---
name: Aggregate widgets above a paginated list
description: How a header total / summary strip sitting above a list must be keyed, scoped and sourced so it cannot disagree with the rows beneath it.
---

An aggregate rendered above a filtered, paginated list (a header total, a
bucket strip, a health pill) is a second answer to the same question the table
answers. Three rules keep the two from contradicting each other.

**1. Key the aggregate under the list's own query key.**
`["<list-key>", "summary", params]`, not a sibling `["<summary-url>", params]`.
Every mutation on the page already invalidates the list prefix, and TanStack
Query matches by prefix, so the aggregate refetches with the rows for free.
**Why:** a sibling key survives the invalidation, so after a mutation the page
shows refreshed rows under pre-mutation totals until something unrelated
refetches. **How to apply:** whenever adding a summary/aggregate query beside
an existing list query.

**2. Price and count the same population.**
If the dollar total comes from the aggregate, the count must come from the
aggregate too. A list's post-filter total counts every row the table renders;
an A/R-style aggregate usually counts a narrower set (open items only), so
pairing them prints a balance and a count describing different populations.
**Why:** the two numbers sit side by side and are read as one sentence.
**How to apply:** derive both from one server response and one selection
helper; if the header narrows with a facet (a selected bucket), narrow both.

**3. A connection/health indicator is not a property of the loaded rows.**
Compute "last synced" server-side over the whole account, not as a max over
the rows currently on screen. **Why:** any filter that happens to exclude the
most recently touched row reports a healthy integration as stale or never-run.
**How to apply:** return it as its own field on the aggregate response,
computed before the filters are applied.
