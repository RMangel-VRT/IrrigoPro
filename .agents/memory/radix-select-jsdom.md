---
name: Driving a Radix Select in jsdom
description: The pointer-capture shim needed before a Radix Select can be opened in a component test.
---

Radix's Select opens on pointer events and calls pointer-capture methods that
jsdom does not implement. Clicking the trigger throws
`target.hasPointerCapture is not a function`, which surfaces as an *unhandled
error* beside a failing `waitFor`, not as an obvious cause.

**Why:** jsdom implements the pointer *events* but not the capture API, and
Radix uses capture to decide whether a press became a drag.

**How to apply:** In the test file (or a shared setup), no-op
`hasPointerCapture`, `setPointerCapture`, `releasePointerCapture` and
`scrollIntoView` on `Element.prototype` before rendering, then open the
trigger with `fireEvent.pointerDown` followed by `fireEvent.click` —
`userEvent.click` alone does not open it. Note that jsdom applies no media
queries, so a page rendering both a desktop table and a mobile card list will
have two of every control; take the first match.
