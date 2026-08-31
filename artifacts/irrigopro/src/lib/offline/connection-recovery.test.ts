import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { isConnectionClosedError, photoErrorMessage } from "./connection-errors";
import {
  __resetOfflineDBForTests,
  enqueueMutation,
  getPhotoBlob,
  isConnectionUsable,
  listAllMutations,
  listFindingsForZoneRecord,
  openOfflineDB,
  putFindingMirror,
  putPhotoBlob,
  withDB,
} from "./db";
import { SyncEngine } from "./engine";
import type { QueuedMutation } from "./types";

// Task #1962 — a tech in the field reported a red "Photo upload failed —
// Failed to execute 'transaction' on 'IDBDatabase': The database connection
// is closing." banner, and the photo was gone.
//
// Mobile browsers close IndexedDB connections whenever the app is
// backgrounded or memory is tight. The offline layer used to cache the
// connection for the life of the page, so the first tap after coming back
// from the lock screen threw and the captured bytes were never written.

async function freshDb() {
  __resetOfflineDBForTests();
  const db = await openOfflineDB();
  await db.clear("mutationQueue");
  await db.clear("photoBlobs");
  await db.clear("wetCheckFindings");
  return db;
}

/** The exception Chromium raises once the handle is dead. */
function closedConnectionError() {
  const err = new Error(
    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
  );
  err.name = "InvalidStateError";
  return err;
}

function photoBlobRow(clientId: string) {
  return {
    clientId,
    blob: new Blob(["pretend-jpeg-bytes"], { type: "image/jpeg" }),
    contentType: "image/jpeg",
    name: "shot.jpg",
    byteSize: 18,
    capturedAt: 1_000,
    compressed: true,
  };
}

function photoUploadMutation(id: string, clientId: string): QueuedMutation {
  return {
    id,
    kind: "photo.upload",
    method: "POST",
    urlTemplate: "/api/wet-checks/123/photos",
    body: { caption: "test" },
    clientId,
    parentClientId: null,
    placeholders: {},
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    status: "pending",
    createdAt: 1_000,
    resolvedId: null,
  };
}

describe("isConnectionClosedError", () => {
  it("recognises the exact message from the field report", () => {
    expect(isConnectionClosedError(closedConnectionError())).toBe(true);
  });

  it("recognises Safari losing the backing store", () => {
    expect(
      isConnectionClosedError(
        new Error("Connection to Indexed Database server lost. Refresh the page to try again"),
      ),
    ).toBe(true);
  });

  it("recognises an InvalidStateError reported without descriptive text", () => {
    const err = new Error("The database connection is closed.");
    err.name = "InvalidStateError";
    expect(isConnectionClosedError(err)).toBe(true);
  });

  it("recognises a transaction aborted by another tab's schema upgrade", () => {
    const err = new Error("Version change transaction was aborted");
    err.name = "AbortError";
    expect(isConnectionClosedError(err)).toBe(true);
  });

  // The whole point of the predicate is that it is narrow. If it swallowed
  // real failures, a quota-exhausted phone would silently retry forever
  // instead of telling the tech that the device is out of room.
  it("does not claim unrelated storage failures", () => {
    const quota = new Error("The quota has been exceeded.");
    quota.name = "QuotaExceededError";
    expect(isConnectionClosedError(quota)).toBe(false);

    const data = new Error("Data provided to an operation does not meet requirements.");
    data.name = "DataError";
    expect(isConnectionClosedError(data)).toBe(false);

    expect(isConnectionClosedError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isConnectionClosedError(null)).toBe(false);
    expect(isConnectionClosedError(undefined)).toBe(false);
  });
});

describe("photoErrorMessage", () => {
  it("replaces the raw DOMException with something a tech can act on", () => {
    const msg = photoErrorMessage(closedConnectionError());
    expect(msg).toBe("Your device's storage was busy. Nothing was saved — tap Photo again.");
    // No browser-engineer vocabulary should reach the toast.
    expect(msg).not.toMatch(/IDBDatabase|transaction|InvalidStateError/i);
  });

  it("passes through a real error so genuine failures stay diagnosable", () => {
    expect(photoErrorMessage(new Error("Upload rejected: file too large"))).toBe(
      "Upload rejected: file too large",
    );
  });

  it("falls back to generic advice when there is no message at all", () => {
    expect(photoErrorMessage({})).toBe("Try again");
  });
});

describe("offline storage survives the browser closing the connection", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("writes and reads back a photo captured after a mid-session close", async () => {
    const db = await openOfflineDB();
    // Simulate iOS reclaiming the connection while the app was backgrounded.
    db.close();

    // These are exactly the two writes queuePhotoUpload performs. Before the
    // fix the first one threw and the photo was lost outright.
    await putPhotoBlob(db, photoBlobRow("photo-after-close"));
    await enqueueMutation(db, photoUploadMutation("mut-1", "photo-after-close"));

    // Genuinely persisted, not merely "did not throw" — read it back through
    // a connection obtained after the fact.
    const reopened = await openOfflineDB();
    const blob = await getPhotoBlob(reopened, "photo-after-close");
    expect(blob?.byteSize).toBe(18);
    const queued = await listAllMutations(reopened);
    expect(queued.map((m) => m.clientId)).toEqual(["photo-after-close"]);
  });

  it("stops handing out the dead connection to everyone else", async () => {
    const dead = await openOfflineDB();
    expect(isConnectionUsable(dead)).toBe(true);
    dead.close();
    expect(isConnectionUsable(dead)).toBe(false);

    // Healing one caller has to replace the shared connection, not just
    // paper over that one call. Otherwise every other part of the app —
    // the sync engine, the mirror readers, the next photo — keeps being
    // handed the same corpse.
    await listAllMutations(dead);

    const fresh = await openOfflineDB();
    expect(fresh).not.toBe(dead);
    expect(isConnectionUsable(fresh)).toBe(true);
    // Usable directly, with no withDB wrapper doing the healing.
    await expect(fresh.getAll("mutationQueue")).resolves.toEqual([]);
  });

  it("heals index reads too, not just single-key writes", async () => {
    const db = await openOfflineDB();
    await putFindingMirror(db, {
      clientId: "finding-1",
      zoneRecordClientId: "zone-1",
      data: { note: "leaking head" },
      updatedAt: 1_000,
    } as any);

    db.close();

    const findings = await listFindingsForZoneRecord(db, "zone-1");
    expect(findings.map((f) => f.clientId)).toEqual(["finding-1"]);
  });

  it("recovers when several operations race on the same dead connection", async () => {
    const db = await openOfflineDB();
    db.close();

    // Every in-flight caller holds the same stale handle. They must all end
    // up on one healthy connection rather than each tearing down the
    // successor the previous one just opened.
    await Promise.all([
      putPhotoBlob(db, photoBlobRow("race-a")),
      putPhotoBlob(db, photoBlobRow("race-b")),
      putPhotoBlob(db, photoBlobRow("race-c")),
    ]);

    const reopened = await openOfflineDB();
    const stored = await reopened.getAll("photoBlobs");
    expect(stored.map((r) => r.clientId).sort()).toEqual(["race-a", "race-b", "race-c"]);
  });

  it("funnels concurrent recoveries onto a single replacement connection", async () => {
    const dead = await openOfflineDB();
    dead.close();

    const healedOn: unknown[] = [];
    const op = () =>
      withDB(dead, async (d) => {
        if (d === dead) throw closedConnectionError();
        healedOn.push(d);
      });

    await Promise.all([op(), op(), op()]);

    // One replacement, shared. Opening a connection per failing caller
    // leaves orphans pinned to the database — they keep working, so the
    // writes still land, but they block the next schema upgrade and the
    // symptom surfaces much later as a hung migration.
    expect(healedOn).toHaveLength(3);
    expect(new Set(healedOn).size).toBe(1);
    expect(healedOn[0]).toBe(await openOfflineDB());
  });

  it("heals a caller still holding an older handle when the replacement died too", async () => {
    const first = await openOfflineDB();
    first.close();
    // Someone else already healed, so the shared handle has moved on.
    await listAllMutations(first);
    const second = await openOfflineDB();
    expect(second).not.toBe(first);

    // ...and then that replacement was closed as well, before our caller —
    // who is still holding the original handle — got its turn. withDB only
    // retries once, so being handed the second corpse would lose the write.
    second.close();

    await putPhotoBlob(first, photoBlobRow("photo-two-corpses"));

    const live = await openOfflineDB();
    expect(live).not.toBe(first);
    expect(live).not.toBe(second);
    expect(isConnectionUsable(live)).toBe(true);
    expect((await getPhotoBlob(live, "photo-two-corpses"))?.byteSize).toBe(18);
  });

  it("requeues a mutation orphaned in `syncing` when the engine starts", async () => {
    const db = await openOfflineDB();
    // A row left mid-dispatch: the page died, or storage failed before the
    // outcome could be written. `readySet` ignores `syncing`, so nothing
    // would ever pick this up again.
    await enqueueMutation(db, {
      ...photoUploadMutation("mut-orphan", "photo-orphan"),
      status: "syncing",
      attemptCount: 2,
      lastAttemptAt: 1_000,
    });

    const engine = new SyncEngine({
      fetchImpl: async () => new Response("{}", { status: 200 }),
      // Backoff for attempt 2 has not elapsed, so start()'s tick cannot
      // dispatch it — we are observing the requeue, not a delivery.
      now: () => 1_000,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 3,
      maxRetryAgeMs: 60 * 60 * 1000,
    });
    await engine.start();

    const [after] = await listAllMutations(await openOfflineDB());
    expect(after.status).toBe("pending");
    // The retry cap still means what it says — requeueing is not a reprieve.
    expect(after.attemptCount).toBe(2);
  });

  it("retires an orphaned `syncing` row that has already spent its retries", async () => {
    const db = await openOfflineDB();
    await enqueueMutation(db, {
      ...photoUploadMutation("mut-spent", "photo-spent"),
      status: "syncing",
      attemptCount: 3,
      lastAttemptAt: 1_000,
    });

    let fetchCalls = 0;
    const engine = new SyncEngine({
      fetchImpl: async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      },
      now: () => 1_000,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 3,
      maxRetryAgeMs: 60 * 60 * 1000,
    });
    await engine.start();
    await new Promise((r) => setTimeout(r, 0));

    // Restarting the app must not silently hand a capped mutation another
    // attempt; it stays failed, where the queue view offers Retry / Cancel.
    const [after] = await listAllMutations(await openOfflineDB());
    expect(after.status).toBe("failed");
    expect(after.lastError).toMatch(/gave_up_after_3_attempts/);
    expect(fetchCalls).toBe(0);
  });

  it("retries a closed connection exactly once and then gives up", async () => {
    const db = await openOfflineDB();
    let calls = 0;
    await expect(
      withDB(db, async () => {
        calls++;
        throw closedConnectionError();
      }),
    ).rejects.toThrow(/connection is closing/);
    // One original attempt plus one retry against the reopened handle. A
    // permanently unhappy store must not spin.
    expect(calls).toBe(2);
  });

  it("propagates a real error immediately instead of retrying it", async () => {
    const db = await openOfflineDB();
    let calls = 0;
    const quota = new Error("The quota has been exceeded.");
    quota.name = "QuotaExceededError";

    await expect(
      withDB(db, async () => {
        calls++;
        throw quota;
      }),
    ).rejects.toThrow(/quota/i);
    expect(calls).toBe(1);
  });
});

describe("SyncEngine after the connection drops", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("queues new work instead of holding a dead handle for the rest of the session", async () => {
    const engine = new SyncEngine({
      fetchImpl: async () => new Response("{}", { status: 200 }),
      now: () => 1_000,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 3,
      maxRetryAgeMs: 60 * 60 * 1000,
    });
    // Force the engine to resolve a connection, the way a page that has been
    // open all morning already has.
    await engine.listMutations();
    engine.setOnline(false);

    (await openOfflineDB()).close();

    await engine.enqueue(photoUploadMutation("mut-after-close", "photo-engine"));

    const queued = await listAllMutations(await openOfflineDB());
    expect(queued.map((m) => m.id)).toEqual(["mut-after-close"]);
  });
});
