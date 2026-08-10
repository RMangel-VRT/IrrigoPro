---
name: Express middleware typing
description: Typing a shared guard as RequestHandler breaks unrelated route handlers; keep loose params.
---

Shared Express guards here are deliberately typed with loose parameters
(`(req: any, res: any, next: any)`) rather than as `RequestHandler`.

**Why:** annotating a guard as `RequestHandler` changes which `app.get`/`app.post` overload
TypeScript selects. The selected overload re-types `req.params` for the whole route, so handlers
that read a named param stop compiling — several unrelated routes broke this way. The guard
itself is fine either way; the damage lands at every call site that passes it.

**How to apply:** when extracting an inline guard into a shared module, keep the loose parameter
types and note why. Before tightening one, run a full `tsc --noEmit` and compare the error count
against the baseline on a clean checkout — the new failures appear in files you did not touch.
