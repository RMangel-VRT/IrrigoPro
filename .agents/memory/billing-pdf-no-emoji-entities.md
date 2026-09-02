---
name: Billing PDFs use no emoji entities
description: Font-independent icon rule for every billing PDF state, including conditional warnings and notices.
---

Billing PDF HTML must not emit emoji or symbol entities for icons. Use self-contained inline SVGs with `currentColor`, hidden accessibility semantics, and the shared print alignment class.

**Why:** Headless Chromium font availability varies by environment. A glyph that renders locally can still become a missing-glyph box elsewhere, and conditional warning paths are easy to overlook.

**How to apply:** Audit every normal and conditional billing PDF path when adding an icon. Cover the emitted HTML in tests and visually render warning/notice states in the PDF Chromium environment.