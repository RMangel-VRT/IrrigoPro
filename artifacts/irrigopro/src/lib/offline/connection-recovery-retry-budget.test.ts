import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { QueuedMutation } from "./types";

// Task #1962, drain-time half.
//
// `withDB` reopens and retries once, so a closed connection is normally
// invisible. When even the reopen fails — the page is being suspended
// mid-write, which is exactly when this happens — the error escapes into the
// dispatch loop's catch block.
//
// That catch used to treat everything as a network failure: increment
// attemptCount, back off, and eventually mark the mutation permanently
// failed. Nothing was ever sent, so a tech who backgrounds the app often
// enough could burn the entire retry budget and lose a photo whose bytes
// were sitting on disk the whole time.
//
// Forcing an unhealable closed-connection error requires intercepting the
// blob read, hence the module mock. Everything else is the real engine.
const mockState = vi.hoisted(() => ({ failBlobRead: false, failSyncingWrite: false }));

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  const closed = () => {
    const err = new Error(
      "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    );
    err.name = "InvalidStateError";
    return err;
  };
  return {
    ...actual,
    getPhotoBlob: async (db: any, clientId: string) => {
      if (mockState.failBlobRead) throw closed();
      return actual.getPhotoBlob(db, clientId);
    },
    updateMutation: async (db: any, id: string, patch: any) => {
      // Only the dispatcher's opening "I am starting on this" write.
      if (mockState.failSyncingWrite && patch?.status === "syncing") throw closed();
      return actual.updateMutation(db, id, patch);
    },
  };
});

const {
  __resetOfflineDBForTests,
  listAllMutations,
  openOfflineDB,
  putPhotoBlob,
} = await import("./db");
const { SyncEngine } = await import("./engine");

function photoUploadMutation(): QueuedMutation {
  return {
    id: "mut-photo-1",
    kind: "photo.upload",
    method: "POST",
    urlTemplate: "/api/wet-checks/123/photos",
    body: { caption: "test" },
    clientId: "photo-1",
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

describe("a dropped connection does not spend the retry budget", () => {
  beforeEach(async () => {
    mockState.failBlobRead = false;
    mockState.failSyncingWrite = false;
    __resetOfflineDBForTests();
    const db = await openOfflineDB();
    await db.clear("mutationQueue");
    await db.clear("photoBlobs");
  });

  it("requeues the photo without counting an attempt or contacting the server", async () => {
    const db = await openOfflineDB();
    await putPhotoBlob(db, {
      clientId: "photo-1",
      blob: new Blob(["pretend-jpeg-bytes"], { type: "image/jpeg" }),
      contentType: "image/jpeg",
      name: "shot.jpg",
      byteSize: 18,
      capturedAt: 1_000,
      compressed: true,
    });

    let now = 1_000;
    let fetchCalls = 0;
    const engine = new SyncEngine({
      fetchImpl: async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 3,
      maxRetryAgeMs: 60 * 60 * 1000,
    });
    engine.setOnline(true);
    await engine.enqueue(photoUploadMutation());

    mockState.failBlobRead = true;
    // Three real dispatch passes — the clock has to move past the backoff
    // gate or the later ticks would simply skip the mutation and prove
    // nothing. Under the old accounting these three alone would exhaust
    // maxAttempts: 3 and mark the photo permanently failed.
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      await engine.tick();
      await new Promise((r) => setTimeout(r, 0));
    }

    const [after] = await listAllMutations(await openOfflineDB());
    expect(after.status).toBe("pending");
    expect(after.attemptCount).toBe(0);
    expect(after.lastError).toBe("local_storage_unavailable");
    // Nothing left the device, so nothing should be reported as a delivery
    // failure either.
    expect(fetchCalls).toBe(0);
  });

  it("does not wedge the queue when storage fails before the attempt starts", async () => {
    let now = 1_000;
    let fetchCalls = 0;
    const engine = new SyncEngine({
      fetchImpl: async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ id: 5 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 3,
      maxRetryAgeMs: 60 * 60 * 1000,
    });
    engine.setOnline(true);
    await engine.enqueue({
      ...photoUploadMutation(),
      kind: "wet_check.set_status",
      urlTemplate: "/api/wet-checks/123/status",
    });

    // The dispatcher's very first write — marking the row `syncing` — is
    // what fails. The mutation must stay dispatchable: if the id were left
    // in the in-memory in-flight set, every later tick would skip it for
    // the rest of the page's life.
    mockState.failSyncingWrite = true;
    now += 60_000;
    await engine.tick();
    await new Promise((r) => setTimeout(r, 0));

    const [stalled] = await listAllMutations(await openOfflineDB());
    expect(stalled.status).toBe("pending");
    expect(stalled.attemptCount).toBe(0);
    expect(fetchCalls).toBe(0);

    mockState.failSyncingWrite = false;
    now += 60_000;
    await engine.tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchCalls).toBe(1);
  });

  it("still delivers the photo once storage comes back", async () => {
    const db = await openOfflineDB();
    await putPhotoBlob(db, {
      clientId: "photo-1",
      blob: new Blob(["pretend-jpeg-bytes"], { type: "image/jpeg" }),
      contentType: "image/jpeg",
      name: "shot.jpg",
      byteSize: 18,
      capturedAt: 1_000,
      compressed: true,
    });

    let now = 1_000;
    const seen: string[] = [];
    const engine = new SyncEngine({
      fetchImpl: async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        seen.push(url);
        if (url.startsWith("/api/upload/photo")) {
          return new Response(JSON.stringify({ uploadUrl: "https://s3.example/put", url: "https://cdn.example/p.jpg" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: 77 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 3,
      maxRetryAgeMs: 60 * 60 * 1000,
    });
    engine.setOnline(true);
    await engine.enqueue(photoUploadMutation());

    mockState.failBlobRead = true;
    now += 60_000;
    await engine.tick();
    await new Promise((r) => setTimeout(r, 0));

    mockState.failBlobRead = false;
    now += 60_000;
    await engine.tick();
    await new Promise((r) => setTimeout(r, 0));

    // The retry budget was never touched, so the upload proceeds normally
    // the moment the connection is usable again.
    expect(seen.some((u) => u.startsWith("/api/upload/photo"))).toBe(true);
  });
});
