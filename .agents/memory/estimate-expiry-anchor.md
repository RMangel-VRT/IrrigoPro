---
name: Estimate expiry is a read-time view anchored on the last send
description: Why estimate expiry is never stored, and the rule any surface that measures it must follow.
---

Estimate expiry is **derived at read time**, never written. The anchor is the
most recent send timestamp, with the estimate date as the fallback for rows
that predate reliable send stamping. One shared helper resolves that anchor;
every surface that measures expiry — lifecycle bucket, dashboard windows and
attention ages, the PDF validity date, in-app copy — must call it rather than
reading a date field directly.

**Why:** two things depend on it. (1) Not storing `expired` is what lets a
re-send roll a row back to live with no extra write and no scheduled job — the
same read just returns a different bucket. (2) Surfaces that re-derived the
window on their own have drifted before: the dashboard said "expiring in 3
days" while the board showed the estimate as fresh, because they were anchored
on different columns.

**How to apply:** when adding any widget, report, export, or email that talks
about how old an estimate is or how close to expiry, resolve the date through
the shared anchor helper, and build variant windows (7-day warnings and the
like) on top of the same anchor. Preserve the fallback — dropping it makes
historical rows with no recorded send permanently un-expirable.

**Conditional-write trap:** because the state is derived, the row on disk does
*not* say "expired" — it is an ordinary sent row whose window lapsed. Any
compare-and-swap that gates a write on the expired state must match that
persisted shape, not the derived label; gating on a status value that only
appears as a side effect of some other event silently matches zero rows, and on
the send path that happens *after* the customer's email has gone out. Get
concurrency protection by swapping on a value the flow itself rotates (the
approval token), not on the derived state.

**Send-flow trap:** the approval email is sent *before* the new send timestamp
is persisted (email-first ordering, so a delivery failure doesn't leave a row
marked sent). Anything rendered as part of that send — most importantly the
attached PDF, which reloads the estimate from the database — therefore sees the
*previous* send time. Compute one send timestamp for the whole flow and pass it
into anything rendered during it, otherwise the customer receives a document
whose validity date is stale, and can be already in the past on a resend.
