---
name: Report links across role boundaries
description: How to preserve canonical report links when a report reader lacks access to the full management screen.
---

When a report-reading role does not otherwise have access to a ticket management page, do not mount the full page merely to make report deep links resolve. Serve a capability-gated, exact-record, read-only projection at the canonical path for that role.

**Why:** Full list pages can expose unrelated records, pricing, and create or mutation controls even when the report itself intentionally returns only audit fields.

**How to apply:** Keep the report endpoint tenant-scoped, add a validated exact-record filter, and render only that report projection for restricted roles. Test the exact request and the absence of mutation controls.