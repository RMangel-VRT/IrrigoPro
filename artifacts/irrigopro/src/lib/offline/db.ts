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
import type { QueuedMutation } from "./types";

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

let dbPromise: Promise<OfflineDB> | null = null;

export function openOfflineDB(): Promise<OfflineDB> {
  if (!dbPromise) {
    dbPromise = openDB<OfflineSchema>(DB_NAME, DB_VERSION, {
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
  }
  return dbPromise;
}

// Test-only hook: reset the lazy singleton so a fresh fake-indexeddb
// instance can be re-opened in test isolation.
export function __resetOfflineDBForTests() {
  dbPromise = null;
}

// Queue helpers ----------------------------------------------------------

export async function enqueueMutation(db: OfflineDB, m: QueuedMutation): Promise<void> {
  await db.put("mutationQueue", m);
}

export async function listAllMutations(db: OfflineDB): Promise<QueuedMutation[]> {
  return await db.getAll("mutationQueue");
}

export async function updateMutation(
  db: OfflineDB,
  id: string,
  patch: Partial<QueuedMutation>,
): Promise<void> {
  const tx = db.transaction("mutationQueue", "readwrite");
  const current = await tx.store.get(id);
  if (!current) {
    await tx.done;
    return;
  }
  await tx.store.put({ ...current, ...patch });
  await tx.done;
}

export async function deleteMutation(db: OfflineDB, id: string): Promise<void> {
  await db.delete("mutationQueue", id);
}

// Prune completed mutations older than the cutoff (default: 24h).
export async function pruneCompleted(db: OfflineDB, olderThanMs: number, now: number): Promise<number> {
  const tx = db.transaction("mutationQueue", "readwrite");
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
}

// Resolve the server-assigned id for a clientId by looking at completed
// mutations in the queue (their `resolvedId`) plus the mirrors. Used by
// the engine to substitute placeholders before dispatch.
export async function resolveServerId(db: OfflineDB, clientId: string): Promise<number | null> {
  // 1) Check the queue for a completed mutation that produced this id.
  const tx = db.transaction(["mutationQueue", "wetChecks", "wetCheckZoneRecords", "wetCheckFindings"]);
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
}

// Mirror writers ---------------------------------------------------------

export async function putWetCheckMirror(db: OfflineDB, m: WetCheckMirror) {
  await db.put("wetChecks", m);
}
export async function getWetCheckMirrorByClientId(db: OfflineDB, clientId: string) {
  return await db.get("wetChecks", clientId);
}
export async function getWetCheckMirrorById(db: OfflineDB, id: number) {
  return await db.getFromIndex("wetChecks", "byId", id);
}

export async function putZoneRecordMirror(db: OfflineDB, m: ZoneRecordMirror) {
  await db.put("wetCheckZoneRecords", m);
}
export async function listZoneRecordsForWetCheck(db: OfflineDB, wetCheckClientId: string) {
  return await db.getAllFromIndex("wetCheckZoneRecords", "byWetCheckClientId", wetCheckClientId);
}

export async function putFindingMirror(db: OfflineDB, m: FindingMirror) {
  await db.put("wetCheckFindings", m);
}
export async function deleteFindingMirror(db: OfflineDB, clientId: string) {
  await db.delete("wetCheckFindings", clientId);
}
export async function listFindingsForZoneRecord(db: OfflineDB, zoneRecordClientId: string) {
  return await db.getAllFromIndex("wetCheckFindings", "byZoneRecordClientId", zoneRecordClientId);
}

// Photo blob helpers (4C) ----------------------------------------------
//
// The Blob is stored once at capture time and only deleted by the engine
// after the metadata POST returns 2xx. A failed sync, browser refresh,
// or quota eviction must never strand a queued upload without its bytes.

export type PhotoBlob = PhotoBlobRow;

export async function putPhotoBlob(db: OfflineDB, row: PhotoBlobRow): Promise<void> {
  await db.put("photoBlobs", row);
}
export async function getPhotoBlob(db: OfflineDB, clientId: string): Promise<PhotoBlobRow | undefined> {
  return await db.get("photoBlobs", clientId);
}
export async function deletePhotoBlob(db: OfflineDB, clientId: string): Promise<void> {
  await db.delete("photoBlobs", clientId);
}
export async function listPhotoBlobs(db: OfflineDB): Promise<PhotoBlobRow[]> {
  return await db.getAll("photoBlobs");
}

// Generic IDB-first read cache for GET endpoints (controllers, issue
// type configs, parts-by-issue, etc.). Keyed by URL so callers can pass
// the same URL they would pass to apiRequest.
export async function getApiCache(db: OfflineDB, key: string) {
  return await db.get("apiCache", key);
}
export async function putApiCache(db: OfflineDB, key: string, data: any) {
  await db.put("apiCache", { key, data, updatedAt: Date.now() });
}
