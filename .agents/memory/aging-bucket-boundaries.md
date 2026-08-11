---
name: A/R aging bucket boundaries are frozen
description: Why the aging boundaries must not move, and the known day-zero asymmetry that must not be "fixed" in passing.
---

The A/R aging boundaries are `< 0` → current, `0 ≤ d < 30`, `30 ≤ d < 60`, `d ≥ 60`.

**Do not move a boundary as part of unrelated work.** These same numbers produce the Financial
Pulse aging totals the business reports on. Shifting one by a day silently restates every historical
figure, and nothing in the UI would show that it happened.

**Known asymmetry, deliberately left alone:** an invoice due *today* counts as overdue (day zero
falls in the first overdue bucket, not Current). This looks like an off-by-one and is not a
mistake to fix in passing — correcting it moves Financial Pulse totals and needs its own change
with a before/after comparison.

**Why:** the labels were reworded once already because they disagreed with the boundaries beside
them ("1–30" against `0 ≤ d < 30`). Rewording moves no numbers; that is exactly why it was safe.
The temptation in that moment is to "also fix" the boundary the label just exposed. Don't.

**How to apply:** any change to bucketing goes through the single shared classifier rather than a
new inline comparison chain, and a change to the *numbers* is a separate, explicitly-scoped piece
of work. Note the classifier's fallthrough puts `NaN` days in the oldest bucket — that reproduces
the original ternary chain and is load-bearing for rows with unparseable dates.
