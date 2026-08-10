---
name: Verifying role-gated UI
description: Role-gated UI needs a real login and a 403 listener; screenshots and seeded sessions both lie.
---

Role-gated UI cannot be verified with a screenshot tool or a seeded session cookie. The
navigation resolves the current role at login rather than per request, so an authenticated API
call proves nothing about what the user actually sees.

**Two traps that produce false results:**

1. **Changing an existing user's role does not change their navigation.** Verify with a freshly
   seeded account of the target role; a role flipped under a live session shows the old nav and
   reads as a failure that is not real.
2. **A seeded user with an unverified email cannot log in.** Login has a distinct 403
   "verification required" branch, separate from the 401 credential failures, so it looks like an
   authorization bug rather than a fixture problem.

**How to apply:** drive a real browser login, one browser context per role so sessions do not
bleed, and attach a response listener that collects every 403. Judge by that list, not by the
screenshot — queries firing on mount fail invisibly, and a background 403 on a role's own landing
page is the most common way a new role ships half-broken. Separate the 403s the new role is
*supposed* to get from ones that also affect existing roles, so pre-existing gaps are reported
rather than silently "fixed" into scope creep.
