import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { isLikelyEdgeError, SyncEngine } from "./engine";
import {
  __resetOfflineDBForTests,
  listAllMutations,
  openOfflineDB,
  putPhotoBlob,
} from "./db";
import type { QueuedMutation } from "./types";
import { readySet } from "./sortQueue";

describe("isLikelyEdgeError (Task #469)", () => {
  it("treats application/json 4xx as a real API error (not edge)", () => {
    expect(
      isLikelyEdgeError("application/json; charset=utf-8", '{"message":"Forbidden"}'),
    ).toBe(false);
  });

  it("treats HTML 4xx as edge so the engine retries", () => {
    expect(
      isLikelyEdgeError(
        "text/html; charset=utf-8",
        "<!doctype html><html><head><title>403</title></head><body>403 Forbidden</body></html>",
      ),
    ).toBe(true);
  });

  it("treats text/plain 4xx as edge so the engine retries", () => {
    expect(isLikelyEdgeError("text/plain", "Forbidden")).toBe(true);
  });

  it("treats a missing content-type with empty body (preflight reject) as edge", () => {
    expect(isLikelyEdgeError("", "")).toBe(true);
  });

  it("treats a missing content-type with HTML body as edge", () => {
    expect(isLikelyEdgeError("", "<html><body>403</body></html>")).toBe(true);
  });

  it("treats a missing content-type with parseable JSON body as a real API error", () => {
    expect(isLikelyEdgeError("", '{"message":"nope"}')).toBe(false);
  });

  it("treats any other non-JSON content-type as edge", () => {
    expect(isLikelyEdgeError("text/xml", "<error/>")).toBe(true);
    expect(isLikelyEdgeError("application/octet-stream", "")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Task #501 — passive retry cap.
//
// A wet-check photo upload that keeps hitting persistent 500s should not
// loop forever in the background. After `maxAttempts` failed dispatches
// the engine flips the queued mutation to `status: "failed"` so the
// existing Retry / Cancel affordances become visible in the queue view.

async function freshDb() {
  // Each test gets a clean queue / blob store so prior runs don't bleed
  // through. Deleting + reopening the database is hostile under
  // fake-indexeddb because lingering connections block the delete; clearing
  // the relevant stores is sufficient for these tests.
  __resetOfflineDBForTests();
  const db = await openOfflineDB();
  await db.clear("mutationQueue");
  await db.clear("photoBlobs");
  await db.clear("wetChecks");
  return db;
}

function makePhotoUploadMutation(now: number): QueuedMutation {
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
    createdAt: now,
    resolvedId: null,
  };
}

// Drive the engine deterministically by invoking tick() in a loop and
// advancing the injected clock past the backoff gate each pass. We never
// actually wait on the engine's setTimeout-scheduled retries — that keeps
// the test free of real-time delays.
async function runUntilSettled(
  engine: SyncEngine,
  bumpNow: () => void,
  maxIterations = 20,
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    bumpNow();
    engine.setOnline(true);
    await engine.tick();
    // Flush microtasks so any chained scheduleTick runs.
    await new Promise((r) => setTimeout(r, 0));
    const db = await openOfflineDB();
    const all = await listAllMutations(db);
    const stillPending = all.some((m) => m.status === "pending");
    if (!stillPending) return;
  }
}

describe("SyncEngine retry cap (Task #501)", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("flips a persistently-500ing photo upload to failed after maxAttempts", async () => {
    let now = 1_000;
    const db = await openOfflineDB();
    // Seed the captured photo bytes so dispatchPhotoUpload reaches the
    // signing call instead of synthesizing a 410 (missing-blob) response.
    await putPhotoBlob(db, {
      clientId: "photo-1",
      blob: new Blob(["pretend-jpeg-bytes"], { type: "image/jpeg" }),
      contentType: "image/jpeg",
      name: "shot.jpg",
      byteSize: 18,
      capturedAt: now,
      compressed: true,
    });

    let signCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("/api/upload/photo")) {
        signCalls++;
        return new Response("upstream boom", { status: 500 });
      }
      return new Response("unexpected", { status: 500 });
    };

    const errors: Array<{ status: number | null; message: string }> = [];
    const engine = new SyncEngine({
      fetchImpl,
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 3,
      maxRetryAgeMs: 60 * 60 * 1000,
    });
    engine.on((e) => {
      if (e.type === "error") errors.push({ status: e.status, message: e.message });
    });
    engine.setOnline(true);

    await engine.enqueue(makePhotoUploadMutation(now));

    await runUntilSettled(engine, () => {
      now += 60_000;
    });

    const after = await listAllMutations(await openOfflineDB());
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("failed");
    expect(after[0].attemptCount).toBe(3);
    expect(after[0].lastError ?? "").toMatch(/gave_up_after_3_attempts/);
    expect(signCalls).toBe(3);
    // The OfflineStrip / SyncBadge listen for state events and will see
    // the failed count tick up; an explicit error event also fires so
    // any toast surface can react.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[errors.length - 1].status).toBe(500);
  });

  it("flips to failed when elapsed age exceeds maxRetryAgeMs even before maxAttempts", async () => {
    let now = 0;
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 502 });
    const engine = new SyncEngine({
      fetchImpl,
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 99,
      maxRetryAgeMs: 5 * 60_000, // 5 minutes
    });
    engine.setOnline(true);

    await engine.enqueue({
      id: "mut-elapsed",
      kind: "wet_check.update",
      method: "PATCH",
      urlTemplate: "/api/wet-checks/77",
      body: { note: "x" },
      clientId: "wc-77",
      parentClientId: null,
      placeholders: {},
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
      createdAt: 0,
      resolvedId: null,
    });

    await engine.tick();
    await new Promise((r) => setTimeout(r, 0));
    let all = await listAllMutations(await openOfflineDB());
    expect(all[0].status).toBe("pending");

    // Jump well past the elapsed cap. The next attempt should fail even
    // though attemptCount is far below the attempt cap.
    now = 10 * 60_000;
    engine.setOnline(true);
    await engine.tick();
    await new Promise((r) => setTimeout(r, 0));
    all = await listAllMutations(await openOfflineDB());
    expect(all[0].status).toBe("failed");
    expect(all[0].lastError ?? "").toMatch(/gave_up_after_5_minutes/);
  });

  it("Task #510 — photo.link uses {{p}} to resolve the photo's server id from its upload", async () => {
    let now = 1_000;
    const db = await openOfflineDB();
    await putPhotoBlob(db, {
      clientId: "photo-cid-1",
      blob: new Blob(["bytes"], { type: "image/jpeg" }),
      contentType: "image/jpeg",
      name: "shot.jpg",
      byteSize: 5,
      capturedAt: now,
      compressed: true,
    });
    // Pre-seed a finding mirror so {{f}} resolves to id 42 immediately.
    await db.put("wetCheckFindings", {
      clientId: "finding-cid-1",
      id: 42,
      zoneRecordClientId: "zr-cid-1",
      zoneRecordId: 7,
      wetCheckId: 123,
      data: { id: 42, clientId: "finding-cid-1" },
      updatedAt: now,
    });

    const calls: Array<{ method: string; url: string; body?: any }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      let body: any = undefined;
      if (init?.body && typeof init.body === "string") {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      calls.push({ method, url, body });
      if (url.startsWith("/api/upload/photo?")) {
        return new Response(
          JSON.stringify({ signedUrl: "https://signed.example/put", url: "https://cdn.example/p.jpg" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://signed.example/put") {
        return new Response("", { status: 200 });
      }
      if (url === "/api/upload/photo/finalize") {
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/wet-checks/123/photos") {
        return new Response(
          JSON.stringify({ id: 9999, url: "https://cdn.example/p.jpg" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/wet-checks/photos/9999") {
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("unexpected", { status: 500 });
    };

    const engine = new SyncEngine({
      fetchImpl,
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 2,
    });
    engine.setOnline(true);

    // Enqueue the upload (clientId = photo cid; the engine will set
    // resolvedId from the metadata POST response.id = 9999).
    await engine.enqueue({
      id: "mut-upload-1",
      kind: "photo.upload",
      method: "POST",
      urlTemplate: "/api/wet-checks/123/photos",
      body: { caption: "hello" },
      clientId: "photo-cid-1",
      parentClientId: null,
      placeholders: {},
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
      createdAt: now,
      resolvedId: null,
    });
    // Enqueue the link with {{p}} pointing at the photo cid and {{f}}
    // at the (already-mirrored) finding cid. parentClientId = photo cid
    // gates the link on the upload completing first.
    await engine.enqueue({
      id: "mut-link-1",
      kind: "photo.link",
      method: "PATCH",
      urlTemplate: "/api/wet-checks/photos/{{p}}",
      body: { findingId: "{{f}}" },
      clientId: "link-cid-1",
      parentClientId: "photo-cid-1",
      placeholders: { p: "photo-cid-1", f: "finding-cid-1" },
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
      createdAt: now,
      resolvedId: null,
    });

    await engine.drainAll();

    const after = await listAllMutations(await openOfflineDB());
    const upload = after.find((m) => m.id === "mut-upload-1")!;
    const link = after.find((m) => m.id === "mut-link-1")!;
    expect(upload.status).toBe("completed");
    expect(upload.resolvedId).toBe(9999);
    expect(link.status).toBe("completed");

    // The link PATCH must have been issued against the resolved
    // server id, with the finding id substituted into the body.
    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.url === "/api/wet-checks/photos/9999",
    );
    expect(patchCall, "PATCH against resolved photo id").toBeDefined();
    expect(patchCall!.body).toEqual({ findingId: 42 });
    // And we never tried to PATCH a negative-id URL.
    expect(
      calls.find((c) => /\/api\/wet-checks\/photos\/-\d+/.test(c.url)),
    ).toBeUndefined();
  });

  it("Task #510 — cleanupLegacyPhotoLinks rewrites recoverable legacy links and cancels orphans", async () => {
    const now = 1_000;
    const db = await freshDb();
    // Recoverable: legacy link for finding-X has a matching completed
    // photo.upload (resolvedId = 555). After cleanup it must be
    // rewritten into the {{p}} shape, parented on the upload, and
    // re-queued (status=pending, attemptCount=0).
    await db.put("mutationQueue", {
      id: "upload-recoverable",
      kind: "photo.upload",
      method: "POST",
      urlTemplate: "/api/wet-checks/123/photos",
      body: {},
      clientId: "photo-cid-recoverable",
      parentClientId: "finding-cid-x",
      placeholders: { f: "finding-cid-x" },
      attemptCount: 1,
      lastAttemptAt: now,
      lastError: null,
      status: "completed",
      createdAt: now - 100,
      resolvedId: 555,
    });
    await db.put("mutationQueue", {
      id: "legacy-recoverable",
      kind: "photo.link",
      method: "PATCH",
      urlTemplate: "/api/wet-checks/photos/-1714768241234",
      body: { findingId: "{{f}}" },
      clientId: "link-legacy-1",
      parentClientId: "finding-cid-x",
      placeholders: { f: "finding-cid-x" },
      attemptCount: 4,
      lastAttemptAt: now,
      lastError: "404",
      status: "failed",
      createdAt: now - 50,
      resolvedId: null,
    });
    // Orphan: legacy link for finding-Y with NO completed upload to
    // pair with. Must be deleted outright.
    await db.put("mutationQueue", {
      id: "legacy-orphan",
      kind: "photo.link",
      method: "PATCH",
      urlTemplate: "/api/wet-checks/photos/-987654",
      body: { findingId: "{{f}}" },
      clientId: "link-legacy-2",
      parentClientId: "finding-cid-y",
      placeholders: { f: "finding-cid-y" },
      attemptCount: 1,
      lastAttemptAt: null,
      lastError: null,
      status: "failed",
      createdAt: now,
      resolvedId: null,
    });
    // Modern row — must NOT be touched.
    await db.put("mutationQueue", {
      id: "modern-1",
      kind: "photo.link",
      method: "PATCH",
      urlTemplate: "/api/wet-checks/photos/{{p}}",
      body: { findingId: "{{f}}" },
      clientId: "link-modern-1",
      parentClientId: "photo-cid-modern",
      placeholders: { p: "photo-cid-modern", f: "finding-cid-z" },
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
      createdAt: now,
      resolvedId: null,
    });

    const engine = new SyncEngine({
      fetchImpl: async () => new Response("nope", { status: 500 }),
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
    });
    const acted = await engine.cleanupLegacyPhotoLinks();
    expect(acted).toBe(2); // 1 rewrite + 1 cancel

    const remaining = await listAllMutations(await openOfflineDB());
    const remainingIds = remaining.map((m) => m.id).sort();
    // Orphan deleted; recoverable + upload + modern remain.
    expect(remainingIds).toEqual(["legacy-recoverable", "modern-1", "upload-recoverable"]);

    const rewritten = remaining.find((m) => m.id === "legacy-recoverable")!;
    expect(rewritten.urlTemplate).toBe("/api/wet-checks/photos/{{p}}");
    expect(rewritten.parentClientId).toBe("photo-cid-recoverable");
    expect(rewritten.placeholders).toEqual({
      p: "photo-cid-recoverable",
      f: "finding-cid-x",
    });
    expect(rewritten.status).toBe("pending");
    expect(rewritten.attemptCount).toBe(0);
    expect(rewritten.lastError).toBeNull();
    expect(rewritten.lastAttemptAt).toBeNull();

    // Modern row is untouched.
    const modern = remaining.find((m) => m.id === "modern-1")!;
    expect(modern.urlTemplate).toBe("/api/wet-checks/photos/{{p}}");
    expect(modern.attemptCount).toBe(0);
  });

  it("Task #510 — when multiple legacy links share a finding, each pairs with a distinct upload", async () => {
    const now = 1_000;
    const db = await freshDb();
    // Two completed uploads for the same finding, two legacy links;
    // each link should pair with a distinct upload (createdAt order).
    for (const [id, cid, ts] of [
      ["upload-A", "photo-A", now - 100],
      ["upload-B", "photo-B", now - 50],
    ] as const) {
      await db.put("mutationQueue", {
        id,
        kind: "photo.upload",
        method: "POST",
        urlTemplate: "/api/wet-checks/1/photos",
        body: {},
        clientId: cid,
        parentClientId: "finding-cid-x",
        placeholders: { f: "finding-cid-x" },
        attemptCount: 1,
        lastAttemptAt: ts,
        lastError: null,
        status: "completed",
        createdAt: ts,
        resolvedId: id === "upload-A" ? 100 : 200,
      });
    }
    for (const [id, ts] of [
      ["link-1", now - 40],
      ["link-2", now - 30],
    ] as const) {
      await db.put("mutationQueue", {
        id,
        kind: "photo.link",
        method: "PATCH",
        urlTemplate: `/api/wet-checks/photos/-${ts}`,
        body: { findingId: "{{f}}" },
        clientId: id,
        parentClientId: "finding-cid-x",
        placeholders: { f: "finding-cid-x" },
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        status: "pending",
        createdAt: ts,
        resolvedId: null,
      });
    }

    const engine = new SyncEngine({
      fetchImpl: async () => new Response("nope", { status: 500 }),
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
    });
    expect(await engine.cleanupLegacyPhotoLinks()).toBe(2);

    const all = await listAllMutations(await openOfflineDB());
    const link1 = all.find((m) => m.id === "link-1")!;
    const link2 = all.find((m) => m.id === "link-2")!;
    // Earliest link claims earliest upload.
    expect(link1.placeholders.p).toBe("photo-A");
    expect(link2.placeholders.p).toBe("photo-B");
    expect(link1.parentClientId).toBe("photo-A");
    expect(link2.parentClientId).toBe("photo-B");
  });

  it("does not give up while attempts and age remain under the caps", async () => {
    let now = 1_000;
    const fetchImpl: typeof fetch = async () => new Response("oops", { status: 503 });
    const engine = new SyncEngine({
      fetchImpl,
      now: () => now,
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      maxAttempts: 8,
      maxRetryAgeMs: 60 * 60_000,
    });
    engine.setOnline(true);

    await engine.enqueue({
      id: "mut-keep-pending",
      kind: "wet_check.update",
      method: "PATCH",
      urlTemplate: "/api/wet-checks/9",
      body: {},
      clientId: "wc-9",
      parentClientId: null,
      placeholders: {},
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
      createdAt: now,
      resolvedId: null,
    });

    await engine.tick();
    await new Promise((r) => setTimeout(r, 0));
    const all = await listAllMutations(await openOfflineDB());
    expect(all[0].status).toBe("pending");
    expect(all[0].attemptCount).toBe(1);
  });
});

describe("work-order offline mutations", () => {
  beforeEach(async () => {
    await freshDb();
  });

  function workOrderMutation(
    id: string,
    kind: "work_order.location_patch" | "work_order.complete",
    clientId: string,
    workOrderId = 42,
  ): QueuedMutation {
    return {
      id,
      kind,
      method: kind === "work_order.location_patch" ? "PATCH" : "POST",
      urlTemplate:
        kind === "work_order.location_patch"
          ? `/api/work-orders/${workOrderId}`
          : "/api/work-orders/complete",
      body:
        kind === "work_order.location_patch"
          ? {
              workLocationLat: 39.7392,
              workLocationLng: -104.9903,
              workLocationAddress: null,
            }
          : {
              workOrderId,
              workSummary: "Completed the irrigation repair and tested it",
              customerNotes: "System is operating normally",
            },
      workOrderId,
      clientId,
      parentClientId: null,
      placeholders: {},
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
      createdAt: Number(id.replace(/\D/g, "")) || 1,
      resolvedId: null,
    };
  }

  it("does not dispatch completion until all location patches for that work order finish", async () => {
    let now = 10_000;
    const calls: string[] = [];
    const engine = new SyncEngine({
      heartbeatIntervalMs: 0,
      maxConcurrent: 2,
      now: () => now,
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    engine.setOnline(false);
    await engine.enqueue(workOrderMutation("location-1", "work_order.location_patch", "location-1"));
    await engine.enqueue({
      ...workOrderMutation("location-2", "work_order.location_patch", "location-2"),
      parentClientIds: ["location-1"],
    });
    await engine.enqueue({
      ...workOrderMutation("completion-1", "work_order.complete", "completion-1"),
      parentClientIds: ["location-1", "location-2"],
    });

    engine.setOnline(true);
    await engine.drainAll();

    expect(calls).toEqual([
      "/api/work-orders/42",
      "/api/work-orders/42",
      "/api/work-orders/complete",
    ]);
    const rows = await listAllMutations(await openOfflineDB());
    expect(rows.every((row) => row.status === "completed")).toBe(true);
  });

  it("turns a JSON validation 400 into one terminal actionable error and continues", async () => {
    let completionCalls = 0;
    let laterCalls = 0;
    const errors: Array<{ kind: string; status: number | null; message: string }> = [];
    const engine = new SyncEngine({
      heartbeatIntervalMs: 0,
      maxConcurrent: 1,
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/work-orders/complete") {
          completionCalls++;
          return new Response(
            JSON.stringify({ message: "Pin the work location before completing this work order." }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        laterCalls++;
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    engine.on((event) => {
      if (event.type === "error") {
        errors.push({ kind: event.kind, status: event.status, message: event.message });
      }
    });
    engine.setOnline(true);
    await engine.enqueue(workOrderMutation("completion-1", "work_order.complete", "completion-1"));
    await engine.enqueue({
      ...workOrderMutation("later-1", "work_order.location_patch", "work-order:99", 99),
      createdAt: 999,
    });

    await engine.drainAll();

    const rows = await listAllMutations(await openOfflineDB());
    const completion = rows.find((row) => row.id === "completion-1")!;
    expect(completion.status).toBe("failed");
    expect(completion.attemptCount).toBe(1);
    expect(completion.lastError).toBe("Pin the work location before completing this work order.");
    expect(completionCalls).toBe(1);
    expect(laterCalls).toBe(1);
    expect(errors).toEqual([
      {
        kind: "work_order.complete",
        status: 400,
        message: "Pin the work location before completing this work order.",
      },
    ]);
  });

  it("releases ordering-only dependents after a failed or cancelled location patch", () => {
    const failed = {
      ...workOrderMutation("location-failed", "work_order.location_patch", "location-failed"),
      status: "failed" as const,
    };
    const completion = {
      ...workOrderMutation("completion-after-failure", "work_order.complete", "completion-after-failure"),
      parentClientIds: ["location-failed"],
      orderingDependencies: true,
    };
    expect(readySet([failed, completion], Date.now(), () => null)).toEqual([completion]);
    expect(readySet([completion], Date.now(), () => null)).toEqual([completion]);
  });
});
