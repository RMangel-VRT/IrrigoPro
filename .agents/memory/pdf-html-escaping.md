---
name: PDF renderers build raw HTML strings
description: Why every customer-editable value interpolated into a PDF template must be escaped, and where the shared escaper lives.
---

# PDF renderers build raw HTML strings

Every value interpolated into a PDF template must go through the shared
`escapeHtml`. This includes addresses, location notes, branch names,
technician names, part names, and controller/zone labels — all of them are
free-text fields a customer or tech can edit.

**Why:** PDF bodies are assembled as HTML strings and handed to Chromium to
render. An unescaped angle bracket is not a display bug — it is markup in the
generated document. The estimate renderer had always escaped its fields; the
invoice-ticket renderers had not, so the same value was safe on one PDF family
and unsafe on another. A hostile-input test is what surfaced it; reading the
happy path never would have.

**How to apply:** When touching any `pdf-*.ts` renderer, escape every `${}`
carrying a database string. Numbers you formatted yourself (money, coordinates
passed through `toFixed`) are already safe, but escaping them costs nothing and
survives refactors.

## The escaper lives in its own module

The canonical `escapeHtml` is a standalone module, not part of either big
renderer. `estimate-pdf-html.ts` imports `pdf-helpers.ts`, so a helper defined
in `pdf-helpers.ts` and imported back would be an import cycle. If you are about
to copy the five-`replace` escaper into a third file, import the shared module
instead.

## Escaping changes URL assertions

Escaping a URL turns `&query=` into `&amp;query=` in the emitted HTML. That is
correct — the browser parses it back to `&`. Tests asserting on a generated link
must expect the escaped form.
