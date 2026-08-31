// Classifying — and explaining — a dropped IndexedDB connection.
//
// Kept in its own module with no `idb` import so UI code and tests can pull
// in the predicate and the copy without dragging the whole offline schema
// along. `db.ts` re-exports `isConnectionClosedError` for callers that are
// already talking to the database.

/**
 * True when `err` means our IndexedDB connection is gone rather than the
 * operation being wrong.
 *
 * Mobile browsers close IndexedDB connections on their own: iOS Safari and
 * installed PWAs drop them when a tab is backgrounded or memory gets tight,
 * and any tab starting a schema upgrade forces every other connection shut.
 * A phone in a truck backgrounds constantly, so this is routine rather than
 * exceptional.
 *
 * These are recoverable — the data is still on disk and reopening gets a
 * working handle. Everything else (a bad key, a missing store, a quota
 * failure) is a real error and must keep propagating.
 */
export function isConnectionClosedError(err: unknown): boolean {
  if (!err) return false;
  const name = String((err as any)?.name ?? "");
  const message = String((err as any)?.message ?? err ?? "").toLowerCase();
  // Chromium/Firefox, and the exact text from the field report:
  // "Failed to execute 'transaction' on 'IDBDatabase': The database
  // connection is closing."
  if (message.includes("connection is closing")) return true;
  if (message.includes("connection is closed")) return true;
  // Safari drops the whole backing store and says so in its own words.
  if (message.includes("connection to indexed database server lost")) return true;
  // The same condition reported without the descriptive text.
  if (name === "InvalidStateError" && message.includes("clos")) return true;
  // A transaction killed mid-flight by another tab's schema upgrade.
  if (name === "AbortError" && message.includes("version change")) return true;
  return false;
}

/**
 * What to show a tech when a photo could not be captured or queued.
 *
 * The raw value here is a DOMException aimed at browser engineers — the
 * field report was someone standing at a controller reading "Failed to
 * execute 'transaction' on 'IDBDatabase'". Say what happened and what to do
 * instead.
 */
export function photoErrorMessage(err: unknown): string {
  if (isConnectionClosedError(err)) {
    return "Your device's storage was busy. Nothing was saved — tap Photo again.";
  }
  const raw = String((err as any)?.message ?? "").trim();
  return raw || "Try again";
}
