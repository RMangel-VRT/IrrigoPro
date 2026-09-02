---
name: Chromium PDF atomic cards
description: How to keep small bordered summary cards intact across Chromium PDF page boundaries.
---

Chromium can fragment an ordinary block or table-like block across printed pages even when both `page-break-inside: avoid` and `break-inside: avoid` are present. A small bordered card that must remain visually whole should also use an atomic inline-level layout such as `display: inline-block`.

**Why:** A long-table PDF rendered the first row and top border of a totals card on one page and the remaining rows and border on the next. The legacy and modern break declarations alone, and then a table-like display, did not prevent the split; an inline block did.

**How to apply:** Keep both legacy and modern break declarations for compatibility, make only the indivisible card atomic (not its surrounding long table), preserve its intended width/alignment, and rasterize a fixture whose card lands near a page boundary.