// Slice 4B — IndexedDB schema for the offline mirror + mutation queue.
//
// Database: `irrigopro_offline` v4 (v3→v4: propertyControllers store removed)
//   - wetChecks                 (key: clientId)         indexes: id, status
//   - wetCheckZoneRecords       (key: clientId)         indexes: wetCheckClientId, wetCheckId, id
//   - wetCheckFindings          (key: clientId)         indexes: zoneRecordClientId, zoneRecordId, id
//   - wetCheckPhotos            (key: clientId)         indexes: wetCheckId — metadata only in 4B
//   - parts                     (key: id)               read-cache for parts catalog
//   - issueTypeConfigs          (key: id)               read-cache
//   - mutationQueue             (key: id)               indexes: status, createdAt, parentClientId, clientId

import { openDB, type IDBPDatabase, type DBSchema } from "idb";
import { isConnectionClosedError } from "./connection-errors";
import type { QueuedMutation } from "./types";

export { isConnectionClosedError } from "./connection-errors";

interface WetCheckMirror {
  clientId: string;
  id?: number; // server-assigned after first sync
  data: any; // full WetCheckWithDetails-shaped payload
  status: string;
  updatedAt: number;
}
interface ZoneRecordMirror {
  clientId: string;
  id?: number;
  wetCheckClientId: string;
  wetCheckId?: number;
  data: any;
  updatedAt: number;
}
interface FindingMirror {
  clientId: string;
  id?: number;
  zoneRecordClientId: string;
  zoneRecordId?: number;
  wetCheckId?: number;
  data: any;
  updatedAt: number;
}
interface PhotoMirror {
  clientId: string;
  id?: number;
  wetCheckId?: number;
  data: any;
  updatedAt: number;
}
// 4C — captured photo bytes live here, keyed by the same clientId used by
// the metadata mirror and by the queued `photo.upload` mutation. The Blob
// is never deleted from this store until the engine confirms the metadata
// POST returned 2xx, so a dead-battery / refresh / failed sync can never
// orphan the bytes the tech captured.
interface PhotoBlobRow {
  clientId: string;
  blob: Blob;
  contentType: string;
  name: string;
  byteSize: number;
  capturedAt: number;
  // Whether `compressPhoto` produced this blob (vs falling back to the
  // original camera bytes). Used by storage hygiene + tests.
  compressed: boolean;
}
interface KvRow {
  id: number | string;
  data: any;
  updatedAt: number;
}
interface KvWithCustomer extends KvRow {
  customerId?: number;
}

interface OfflineSchema extends DBSchema {
  wetChecks: {
    key: string;
    value: WetCheckMirror;
    indexes: { byId: number; byStatus: string };
  };
  wetCheckZoneRecords: {
    key: string;
    value: ZoneRecordMirror;
    indexes: { byWetCheckClientId: string; byWetCheckId: number; byId: number };
  };
  wetCheckFindings: {
    key: string;
    value: FindingMirror;
    indexes: { byZoneRecordClientId: string; byZoneRecordId: number; byId: number };
  };
  wetCheckPhotos: {
    key: string;
    value: PhotoMirror;
    indexes: { byWetCheckId: number };
  };
  photoBlobs: {
    key: string;
    value: PhotoBlobRow;
  };
  parts: { key: number; value: KvRow };
  issueTypeConfigs: { key: number; value: KvRow };
  apiCache: {
    key: string;
    value: { key: string; data: any; updatedAt: number };
  };
  mutationQueue: {
    key: string;
    value: QueuedMutation;
    indexes: {
      byStatus: string;
      byCreatedAt: number;
      byParentClientId: string;
      byClientId: string;
    };
  };
}

export type OfflineDB = IDBPDatabase<OfflineSchema>;

const DB_NAME = "irrigopro_offline";
const DB_VERSION = 4;

// The open connection is shared by every caller. It is NOT permanent: the
// browser is free to close it underneath us, and mobile browsers do so
// routinely — iOS Safari and installed PWAs drop IndexedDB connections when
// a tab is backgrounded or the system reclaims memory, and any tab can force
// a close by starting a schema upgrade. A phone in a truck backgrounds
// constantly, so a page that has been open all morning is very likely
// holding a dead handle.
//
// Every operation therefore goes through `withDB`, which reopens and retries
// once when it sees a closed-connection error. Without that, the first tap
// after coming back from the lock screen throws a raw DOMException and the
// photo the tech just took is never written anywhere.
let dbPromise: Promise<OfflineDB> | null = null;
let dbHandle: OfflineDB | null = null;
// Bumped on every open and every invalidation. Lifecycle callbacks captured
// the generation they were registered for, so a late `terminated` from a
// connection we already replaced cannot tear down its healthy successor.
let dbGeneration = 0;

/**
 * Drop the shared connection so the next call opens a fresh one.
 *
 * Bumping the generation also disarms the lifecycle callbacks of the
 * connection we are discarding.
 */
export function invalidateOfflineDB(): void {
  dbGeneration++;
  dbPromise = null;
  dbHandle = null;
}

// A single in-flight recovery, shared by everyone who was holding the dead
// handle when it failed.
let recovery: Promise<OfflineDB> | null = null;

/**
 * Replace a dead connection with a live one, exactly once.
 *
 * When the browser closes the connection, every concurrent caller fails at
 * more or less the same moment. Left to their own devices they would each
 * invalidate and reopen, and each would discard the successor the previous
 * one had just opened — leaving a trail of orphaned connections that keep
 * the database pinned and can block a later schema upgrade. Funnelling them
 * through one promise means the first caller heals and the rest wait for it.
 */
function recoverFrom(dead: OfflineDB): Promise<OfflineDB> {
  if (recovery) return recovery;
  // Someone already replaced the handle while we were failing. Take theirs,
  // but only after checking it is actually alive: a replacement that has
  // since died too must be healed, not passed along. `withDB` gets exactly
  // one retry, so handing it a second corpse turns a recoverable situation
  // into a lost photo.
  let doomed = dead;
  if (dbHandle && dbHandle !== dead) {
    if (isConnectionUsable(dbHandle)) return Promise.resolve(dbHandle);
    doomed = dbHandle;
  }
  const attempt = (async () => {
    invalidateOfflineDB();
    // Release the corpses rather than leaving them pinned to the database,
    // where they would block the next schema upgrade.
    try { doomed.close(); } catch { /* already gone */ }
    if (doomed !== dead) {
      try { dead.close(); } catch { /* already gone */ }
    }
    return await openOfflineDB();
  })();
  recovery = attempt;
  return attempt.finally(() => {
    if (recovery === attempt) recovery = null;
  });
}

export function openOfflineDB(): Promise<OfflineDB> {
  if (!dbPromise) {
    const generation = ++dbGeneration;
    // Only tear down the shared state if it still belongs to this
    // connection — a slow `terminated` callback must not clobber a
    // successor that has already been opened and used.
    const invalidateThisConnection = () => {
      if (dbGeneration !== generation) return;
      dbPromise = null;
      dbHandle = null;
    };
    const opening = openDB<OfflineSchema>(DB_NAME, DB_VERSION, {
      // Another tab wants to upgrade the schema. Close immediately so we
      // don't block it, and reopen lazily against the new version.
      blocking() {
        // Grab the handle before clearing the shared state — otherwise
        // there is nothing left to close and the other tab stays blocked.
        const doomed = dbGeneration === generation ? dbHandle : null;
        invalidateThisConnection();
        try { doomed?.close(); } catch { /* already gone */ }
      },
      // The browser closed the connection on its own: backgrounding,
      // memory pressure, storage eviction, or a crashed backing store.
      // Not called for a close we requested ourselves.
      terminated() {
        invalidateThisConnection();
      },
      upgrade(db) {
        if (!db.objectStoreNames.contains("apiCache")) {
          db.createObjectStore("apiCache", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("wetChecks")) {
          const s = db.createObjectStore("wetChecks", { keyPath: "clientId" });
          s.createIndex("byId", "id");
          s.createIndex("byStatus", "status");
        }
        if (!db.objectStoreNames.contains("wetCheckZoneRecords")) {
          const s = db.createObjectStore("wetCheckZoneRecords", { keyPath: "clientId" });
          s.createIndex("byWetCheckClientId", "wetCheckClientId");
          s.createIndex("byWetCheckId", "wetCheckId");
          s.createIndex("byId", "id");
        }
        if (!db.objectStoreNames.contains("wetCheckFindings")) {
          const s = db.createObjectStore("wetCheckFindings", { keyPath: "clientId" });
          s.createIndex("byZoneRecordClientId", "zoneRecordClientId");
          s.createIndex("byZoneRecordId", "zoneRecordId");
          s.createIndex("byId", "id");
        }
        if (!db.objectStoreNames.contains("wetCheckPhotos")) {
          const s = db.createObjectStore("wetCheckPhotos", { keyPath: "clientId" });
          s.createIndex("byWetCheckId", "wetCheckId");
        }
        if (!db.objectStoreNames.contains("photoBlobs")) {
          // 4C — keyed by the photo clientId. No indexes needed; lookups
          // are always by clientId from the queued mutation row.
          db.createObjectStore("photoBlobs", { keyPath: "clientId" });
        }
        if (!db.objectStoreNames.contains("parts")) {
          db.createObjectStore("parts", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("issueTypeConfigs")) {
          db.createObjectStore("issueTypeConfigs", { keyPath: "id" });
        }
        // v4: the propertyControllers store was dropped (Task #1857 retired
        // property_controllers). It is no longer part of OfflineSchema, so the
        // upgrade no longer touches it; any leftover store on a v3 client is
        // simply never opened again.
        if (!db.objectStoreNames.contains("mutationQueue")) {
          const s = db.createObjectStore("mutationQueue", { keyPath: "id" });
          s.createIndex("byStatus", "status");
          s.createIndex("byCreatedAt", "createdAt");
          s.createIndex("byParentClientId", "parentClientId");
          s.createIndex("byClientId", "clientId");
        }
      },
    });
    dbPromise = opening.then(
      (db) => {
        if (dbGeneration === generation) dbHandle = db;
        return db;
      },
      (err) => {
        // A failed open must not be cached, or the page stays broken until
        // it is reloaded. Clear it so the next caller gets a real attempt.
        invalidateThisConnection();
        throw err;
      },
    );
  }
  return dbPromise;
}

/**
 * Ask a connection whether it still works, by opening the cheapest possible
 * transaction on it.
 *
 * Message text is not a reliable signal on its own: Chromium says "The
 * database connection is closing", Safari talks about losing the backing
 * store, and the spec's own generic InvalidStateError wording mentions
 * neither. Rather than maintain a phrasebook, ask the object directly — a
 * closed connection refuses to start a transaction, a healthy one does not.
 */
export function isConnectionUsable(db: OfflineDB): boolean {
  try {
    const tx = db.transaction("mutationQueue", "readonly");
    // Nothing to read; release it immediately and swallow the resulting
    // abort rejection so it never surfaces as an unhandled rejection.
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already settled */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one IndexedDB operation, reopening the database and retrying once if
 * the connection turns out to be closed.
 *
 * `db` is whatever handle the caller already had. It may be stale — callers
 * cache it across awaits and the engine holds one for the life of the page —
 * so the retry deliberately ignores it and uses a freshly opened connection
 * instead. Only closed-connection failures are retried; every other error
 * propagates on the first throw so genuine bugs stay loud.
 */
export async function withDB<T>(
  db: OfflineDB,
  fn: (db: OfflineDB) => Promise<T>,
): Promise<T> {
  try {
    return await fn(db);
  } catch (err) {
    // Recognisable closed-connection wording, or a handle that fails the
    // probe. Anything else is a genuine failure and must stay loud —
    // retrying a quota error or a bad key would only hide it.
    if (!isConnectionClosedError(err) && isConnectionUsable(db)) throw err;
    const fresh = await recoverFrom(db);
    return await fn(fresh);
  }
}

/** `withDB` for callers that do not already hold a handle. */
export async function runWithOfflineDB<T>(
  fn: (db: OfflineDB) => Promise<T>,
): Promise<T> {
  return await withDB(await openOfflineDB(), fn);
}

// Test-only hook: reset the lazy singleton so a fresh fake-indexeddb
// instance can be re-opened in test isolation.
export function __resetOfflineDBForTests() {
  recovery = null;
  invalidateOfflineDB();
}

// Queue helpers ----------------------------------------------------------

export async function enqueueMutation(db: OfflineDB, m: QueuedMutation): Promise<void> {
  await withDB(db, (d) => d.put("mutationQueue", m));
}

export async function listAllMutations(db: OfflineDB): Promise<QueuedMutation[]> {
  return await withDB(db, (d) => d.getAll("mutationQueue"));
}

export async function updateMutation(
  db: OfflineDB,
  id: string,
  patch: Partial<QueuedMutation>,
): Promise<void> {
  await withDB(db, async (d) => {
    const tx = d.transaction("mutationQueue", "readwrite");
    const current = await tx.store.get(id);
    if (!current) {
      await tx.done;
      return;
    }
    await tx.store.put({ ...current, ...patch });
    await tx.done;
  });
}

export async function deleteMutation(db: OfflineDB, id: string): Promise<void> {
  await withDB(db, (d) => d.delete("mutationQueue", id));
}

// Prune completed mutations older than the cutoff (default: 24h).
export async function pruneCompleted(db: OfflineDB, olderThanMs: number, now: number): Promise<number> {
  return await withDB(db, async (d) => {
    const tx = d.transaction("mutationQueue", "readwrite");
    let deleted = 0;
    let cursor = await tx.store.index("byStatus").openCursor(IDBKeyRange.only("completed"));
    while (cursor) {
      const v = cursor.value;
      if (now - v.createdAt > olderThanMs) {
        await cursor.delete();
        deleted++;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return deleted;
  });
}

// Resolve the server-assigned id for a clientId by looking at completed
// mutations in the queue (their `resolvedId`) plus the mirrors. Used by
// the engine to substitute placeholders before dispatch.
export async function resolveServerId(db: OfflineDB, clientId: string): Promise<number | null> {
  return await withDB(db, async (d) => {
    // 1) Check the queue for a completed mutation that produced this id.
    const tx = d.transaction(["mutationQueue", "wetChecks", "wetCheckZoneRecords", "wetCheckFindings"]);
    const fromQueue = await tx.objectStore("mutationQueue").index("byClientId").get(clientId);
    if (fromQueue && fromQueue.status === "completed" && fromQueue.resolvedId != null) {
      return fromQueue.resolvedId;
    }
    // 2) Fall through to mirrors (in case the wet check pre-existed online).
    const wc = await tx.objectStore("wetChecks").get(clientId);
    if (wc?.id != null) return wc.id;
    const zr = await tx.objectStore("wetCheckZoneRecords").get(clientId);
    if (zr?.id != null) return zr.id;
    const f = await tx.objectStore("wetCheckFindings").get(clientId);
    if (f?.id != null) return f.id;
    return null;
  });
}

// Mirror writers ---------------------------------------------------------

export async function putWetCheckMirror(db: OfflineDB, m: WetCheckMirror) {
  await withDB(db, (d) => d.put("wetChecks", m));
}
export async function getWetCheckMirrorByClientId(db: OfflineDB, clientId: string) {
  return await withDB(db, (d) => d.get("wetChecks", clientId));
}
export async function getWetCheckMirrorById(db: OfflineDB, id: number) {
  return await withDB(db, (d) => d.getFromIndex("wetChecks", "byId", id));
}

export async function putZoneRecordMirror(db: OfflineDB, m: ZoneRecordMirror) {
  await withDB(db, (d) => d.put("wetCheckZoneRecords", m));
}
export async function listZoneRecordsForWetCheck(db: OfflineDB, wetCheckClientId: string) {
  return await withDB(db, (d) =>
    d.getAllFromIndex("wetCheckZoneRecords", "byWetCheckClientId", wetCheckClientId));
}

export async function putFindingMirror(db: OfflineDB, m: FindingMirror) {
  await withDB(db, (d) => d.put("wetCheckFindings", m));
}
export async function deleteFindingMirror(db: OfflineDB, clientId: string) {
  await withDB(db, (d) => d.delete("wetCheckFindings", clientId));
}
export async function listFindingsForZoneRecord(db: OfflineDB, zoneRecordClientId: string) {
  return await withDB(db, (d) =>
    d.getAllFromIndex("wetCheckFindings", "byZoneRecordClientId", zoneRecordClientId));
}

// Photo blob helpers (4C) ----------------------------------------------
//
// The Blob is stored once at capture time and only deleted by the engine
// after the metadata POST returns 2xx. A failed sync, browser refresh,
// or quota eviction must never strand a queued upload without its bytes.

export type PhotoBlob = PhotoBlobRow;

export async function putPhotoBlob(db: OfflineDB, row: PhotoBlobRow): Promise<void> {
  await withDB(db, (d) => d.put("photoBlobs", row));
}
export async function getPhotoBlob(db: OfflineDB, clientId: string): Promise<PhotoBlobRow | undefined> {
  return await withDB(db, (d) => d.get("photoBlobs", clientId));
}
export async function deletePhotoBlob(db: OfflineDB, clientId: string): Promise<void> {
  await withDB(db, (d) => d.delete("photoBlobs", clientId));
}
export async function listPhotoBlobs(db: OfflineDB): Promise<PhotoBlobRow[]> {
  return await withDB(db, (d) => d.getAll("photoBlobs"));
}

// Generic IDB-first read cache for GET endpoints (controllers, issue
// type configs, parts-by-issue, etc.). Keyed by URL so callers can pass
// the same URL they would pass to apiRequest.
export async function getApiCache(db: OfflineDB, key: string) {
  return await withDB(db, (d) => d.get("apiCache", key));
}
export async function putApiCache(db: OfflineDB, key: string, data: any) {
  await withDB(db, (d) => d.put("apiCache", { key, data, updatedAt: Date.now() }));
}
