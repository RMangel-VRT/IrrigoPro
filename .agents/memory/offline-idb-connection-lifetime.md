---
name: Offline IndexedDB connection lifetime
description: Why a cached IDB handle cannot be trusted in the field app, and the rules for healing one.
---

An IndexedDB connection is not owned by the page for the life of the page.
Mobile browsers close it on their own — iOS Safari and installed PWAs drop
connections on backgrounding or memory pressure, and any tab starting a
schema upgrade forces the others shut. A phone in a truck backgrounds
constantly, so a long-lived tab is very likely holding a dead handle.

**Rule 1 — heal at the shared opener, not at the call site.** Every helper
takes the handle as its first parameter, so a stale handle must heal no
matter which caller is holding it. Route operations through a wrapper that
catches a closed connection, reopens, and retries once. Do not let any module
cache its own second copy of the handle; there must be exactly one memoized
connection.

**Why:** the sync engine used to keep its own copy. Once that copy died, the
engine was broken for the rest of the session even though every other caller
had healed.

**Rule 2 — detect deadness by probing, not by matching message text.**
Chromium says "The database connection is closing", Safari talks about losing
the backing store, and the spec's generic InvalidStateError wording mentions
neither — fake-indexeddb uses that generic wording, so message-only matching
passes in the browser and fails in tests. Open a throwaway readonly
transaction instead: a closed connection refuses. Keep the message match as a
fast path for places that have an error but no handle.

**Rule 3 — serialize recovery, and validate the handle you hand back.** When
the connection dies, every concurrent caller fails at once. Without a single
shared recovery promise they each reopen and each discards the successor the
previous one just opened, leaving orphaned connections pinned to the database
that later block a schema upgrade. A caller arriving with an older handle
must not be handed the current one unchecked — if that replacement has died
too, its single retry burns on a second corpse.

**Rule 4 — a local storage failure is not a delivery attempt.** Never
increment a queued mutation's retry count when the failure was IndexedDB
rather than the network. Otherwise a tech who backgrounds the app often
enough exhausts the retry budget and the queue permanently fails a photo
whose bytes are still on disk and which the server never saw.

**Rule 5 — in-flight state is memory-only, so `syncing` rows are orphans.**
Anything still marked `syncing` on disk at startup is being dispatched by
nobody, and the ready-set filter ignores it, so it is invisible forever.
Requeue it at startup — but apply the retry cap and max-age check while doing
so, or restarting the app silently grants every capped mutation another
attempt.

**How to apply:** any new offline store, or any new direct `db.*` call in the
wet-check offline layer, has to go through the shared wrapper. A raw
`db.get` / `db.put` / `db.transaction` outside it is the bug.
