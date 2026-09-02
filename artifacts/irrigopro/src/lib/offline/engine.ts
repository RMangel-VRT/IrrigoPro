// Slice 4B — Replay engine.
//
// Singleton that drains the mutationQueue against the network in
// dependency order, with per-mutation exponential backoff and a
// concurrency cap of 2. Online state is fed by navigator.onLine, the
// `online`/`offline` window events, a 30s `/api/health` heartbeat, and
// inferred state from real API responses.
//
// The engine is intentionally test-friendly: `fetchImpl`, `now`, and the
// timer functions are injectable so node:test + fake-indexeddb can drive
// it deterministically.

import {
  deleteMutation,
  deletePhotoBlob,
  enqueueMutation,
  getPhotoBlob,
  isConnectionClosedError,
  listAllMutations,
  openOfflineDB,
  pruneCompleted,
  putWetCheckMirror,
  resolveServerId,
  updateMutation,
  withDB,
  type OfflineDB,
} from "./db";
import { backoffMs, readySet, resolveBody, resolveTemplate } from "./sortQueue";
import { postTelemetry } from "./telemetry";
import type {
  EngineEvent,
  EngineListener,
  QueuedMutation,
} from "./types";

// API validation responses are JSON objects, but Response.text() gives the
// engine the serialized envelope. Keep the terminal queue error actionable
// instead of showing `{"message":"..."}` in the sync drawer.
export function extractApiErrorMessage(body: string, status: number): string {
  const fallback = body || `${status}`;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === "string" && parsed.trim()) return parsed;
    if (parsed && typeof parsed === "object") {
      for (const key of ["message", "error", "detail"]) {
        if (typeof parsed[key] === "string" && parsed[key].trim()) {
          return parsed[key];
        }
      }
    }
  } catch {
    // Non-JSON bodies are handled by the edge-error classifier.
  }
  return fallback;
}

// Detect a 4xx response that almost certainly came from an upstream/edge
// layer (deployment proxy, stale PWA shell, blocked-host page, generic
// CDN/load-balancer error page) rather than from our Express API.
//
// Our API server only ever returns JSON 4xx, so anything else — HTML,
// `text/plain` "Forbidden", an empty body, or any other non-JSON
// content-type — should be treated as a transient network hiccup and
// retried. (Task #469.)
export function isLikelyEdgeError(contentType: string, body: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  // Anything our API would emit is application/json. If we see that, it's
  // a real validation/permission error — not transient.
  if (ct.includes("application/json")) return false;
  // Otherwise, we're confident this came from a layer above Express:
  //   - text/html → proxy login page, blocked-host page
  //   - text/plain → generic LB / CDN "Forbidden" / "Bad Gateway"
  //   - empty/missing content-type with empty body → preflight rejection
  //   - anything else non-JSON → still not us
  if (ct) return true;
  // No content-type at all: treat as edge if body is empty or HTML-ish.
  const head = (body ?? "").trimStart().slice(0, 64).toLowerCase();
  if (!head) return true;
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<")) return true;
  // Last resort: try to parse as JSON; if it doesn't parse, treat as edge.
  try { JSON.parse(body); return false; } catch { return true; }
}

export interface EngineOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  heartbeatIntervalMs?: number;
  maxConcurrent?: number;
  pruneOlderThanMs?: number;
  authHeaders?: () => Record<string, string>;
  // Task #501 — passive retry caps. Once a mutation has accumulated
  // `maxAttempts` failed attempts OR has been sitting in the queue
  // (createdAt → now) longer than `maxRetryAgeMs`, the engine flips it to
  // `status: "failed"` instead of scheduling another retry. The existing
  // Retry / Cancel affordances in the queue view then become visible so
  // the tech can decide what to do, rather than having a doomed upload
  // loop forever in the background.
  maxAttempts?: number;
  maxRetryAgeMs?: number;
}

// Task #501 — default caps. ~8 attempts maps to a worst-case of roughly
// 1s+2s+4s+8s+16s+30s+30s+30s ≈ 2 minutes of backoff before giving up.
//
// Task #532 — raise the wall-clock cap from 1 hour to 12 hours. The 1h
// backstop was originally meant to catch slow-trickle failures, but in
// practice it also gave up on a tech who is offline for half a shift
// (no LTE in a basement, on a remote site, etc.). With the new cap,
// queued writes auto-resume the moment they get back into coverage,
// even after a long lunch break or a multi-stop morning route. The
// existing manual Retry / Cancel buttons remain as a fallback, and the
// retry-cap-exceeded messaging from Task #525 still surfaces *why*
// something is stuck once it does hit the cap.
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_MAX_RETRY_AGE_MS = 12 * 60 * 60 * 1000;

export class SyncEngine {
  private listeners = new Set<EngineListener>();
  private fetchImpl: typeof fetch;
  private now: () => number;
  private heartbeatIntervalMs: number;
  private maxConcurrent: number;
  private pruneOlderThanMs: number;
  private authHeaders: () => Record<string, string>;
  private maxAttempts: number;
  private maxRetryAgeMs: number;
  private inFlight = new Set<string>();
  private aborts = new Map<string, AbortController>();
  private online = true;
  private heartbeatTimer: any = null;
  private started = false;
  private tickScheduled = false;

  constructor(opts: EngineOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.now = opts.now ?? (() => Date.now());
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.pruneOlderThanMs = opts.pruneOlderThanMs ?? 24 * 60 * 60 * 1000;
    this.authHeaders = opts.authHeaders ?? (() => ({}));
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxRetryAgeMs = opts.maxRetryAgeMs ?? DEFAULT_MAX_RETRY_AGE_MS;
  }

  // Task #501 — decide whether the next attempt for this mutation would
  // exceed either configured cap. `nextAttemptCount` is the value we'd
  // write if we kept it pending. Returns a reason string if the mutation
  // should be flipped to `failed` instead, or `null` to keep retrying.
  // Task #552 — emit a one-shot `sync.stuck` telemetry event the first
  // time a queued mutation crosses either of the "stuck" thresholds:
  // attempt > 3 OR age > 1h. We dedupe per mutation so a long-stuck
  // item doesn't produce one event per retry tick.
  private stuckEmitted = new Set<string>();
  private maybeEmitStuck(m: QueuedMutation, nextAttempt: number, reason: string): void {
    try {
      if (this.stuckEmitted.has(m.id)) return;
      const ageMs = this.now() - m.createdAt;
      const overAttempts = nextAttempt > 3;
      const overAge = ageMs > 60 * 60 * 1000;
      if (!overAttempts && !overAge) return;
      this.stuckEmitted.add(m.id);
      postTelemetry({
        name: "sync.stuck",
        message: `${m.kind} stuck after ${nextAttempt} attempts (${Math.round(ageMs / 60000)}m)`,
        severity: "warning",
        source: "sw",
        component: "offline.engine",
        context: {
          kind: m.kind,
          attempt: nextAttempt,
          age_ms: ageMs,
          reason,
        },
      });
    } catch { /* never throw */ }
  }

  private capExceededReason(
    m: QueuedMutation,
    nextAttemptCount: number,
  ): string | null {
    if (nextAttemptCount >= this.maxAttempts) {
      return `gave_up_after_${nextAttemptCount}_attempts`;
    }
    if (this.now() - m.createdAt >= this.maxRetryAgeMs) {
      const mins = Math.round(this.maxRetryAgeMs / 60_000);
      return `gave_up_after_${mins}_minutes`;
    }
    return null;
  }

  on(l: EngineListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: EngineEvent) {
    for (const l of Array.from(this.listeners)) {
      try { l(e); } catch (err) { console.warn("[offline-engine] listener error:", err); }
    }
  }

  // Always resolve through the shared opener rather than caching a handle
  // on the engine. `openOfflineDB` memoizes the healthy connection, so this
  // is cheap — and when the browser closes the connection, the engine picks
  // up the reopened one instead of holding a dead handle for the rest of
  // the page's life.
  private async ensureDB(): Promise<OfflineDB> {
    return await openOfflineDB();
  }

  setOnline(next: boolean) {
    if (this.online === next) return;
    this.online = next;
    this.broadcastState().catch(() => {});
    if (next) this.scheduleTick();
  }

  isOnline(): boolean { return this.online; }

  private async broadcastState() {
    try {
      const db = await this.ensureDB();
      const all = await listAllMutations(db);
      let pending = 0, syncing = 0, failed = 0;
      for (const m of all) {
        if (m.status === "pending") pending++;
        else if (m.status === "syncing") syncing++;
        else if (m.status === "failed") failed++;
      }
      this.emit({ type: "state", online: this.online, pending, syncing, failed });
    } catch {
      // ignore
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (typeof window !== "undefined") {
      this.online = navigator.onLine;
      window.addEventListener("online", () => this.setOnline(true));
      window.addEventListener("offline", () => this.setOnline(false));
    }
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => { this.heartbeat().catch(() => {}); }, this.heartbeatIntervalMs);
    }
    await this.ensureDB();
    // Requeue orphaned `syncing` rows. In-flight state lives in memory
    // only, so anything still marked `syncing` on disk is by definition not
    // being dispatched by anyone — the page was closed mid-flight, or
    // device storage failed before the dispatcher could record the outcome.
    // `readySet` ignores those rows, so without this they are invisible
    // forever and the photo never uploads.
    //
    // `attemptCount` is left alone, and a row that has already spent its
    // budget (or aged out) is retired rather than requeued — otherwise
    // restarting the app would quietly hand every capped mutation another
    // network attempt, and the cap would mean nothing.
    try {
      const db = await this.ensureDB();
      for (const m of await listAllMutations(db)) {
        if (m.status !== "syncing") continue;
        const capped = this.capExceededReason(m, m.attemptCount);
        await updateMutation(db, m.id, capped
          ? { status: "failed", lastError: capped }
          : { status: "pending" });
      }
    } catch (err) {
      console.warn("[offline-engine] could not requeue orphaned syncing rows:", err);
    }
    // Task #510 — one-shot cleanup of legacy `photo.link` mutations
    // whose urlTemplate baked in a negative client-side id (e.g.
    // `/api/wet-checks/photos/-1714768241234`). Those will never
    // resolve to a real server id and would otherwise loop until the
    // retry cap kicks in. We cancel them so the queue clears and the
    // tech is free to re-link photos by editing the finding. Any
    // accompanying `photo.upload` rows with valid bytes stay intact —
    // the photo still ends up on the server, just not auto-attached.
    try {
      await this.cleanupLegacyPhotoLinks();
    } catch (err) {
      console.warn("[offline-engine] legacy photo.link cleanup failed:", err);
    }
    this.scheduleTick();
  }

  // Scan the queue for `photo.link` mutations whose urlTemplate still
  // embeds a negative numeric id (the pre-Task-#510 shape). For each
  // legacy row we try to recover by pairing it with a completed
  // `photo.upload` mutation for the same finding (matched by
  // `placeholders.f` / `parentClientId`, ordered by createdAt so the
  // first link gets the first upload). Recoverable rows are rewritten
  // into the modern `{{p}}` shape and re-queued; truly orphaned rows
  // (no matching completed upload, or a sibling already claimed it)
  // are cancelled so they stop looping forever. Returns the total
  // number of legacy rows acted on. Exposed so tests can drive the
  // cleanup deterministically without spinning up the full engine
  // lifecycle.
  async cleanupLegacyPhotoLinks(): Promise<number> {
    const db = await this.ensureDB();
    const all = await listAllMutations(db);
    const isLegacy = (m: QueuedMutation) =>
      m.kind === "photo.link" &&
      m.status !== "completed" &&
      /\/api\/wet-checks\/photos\/-\d+/.test(m.urlTemplate);

    const legacy = all.filter(isLegacy).sort((a, b) => a.createdAt - b.createdAt);
    if (legacy.length === 0) return 0;

    // Index completed photo.uploads (with a real resolvedId) by the
    // finding clientId we can correlate against. The legacy enqueue
    // path always wrote `placeholders.f` on the link AND on the
    // upload, so that's the most reliable join key; we fall back to
    // parentClientId for older rows that only set the parent.
    const findingKey = (m: QueuedMutation): string | null =>
      (m.placeholders?.f as string | undefined) ?? m.parentClientId ?? null;

    const uploadsByFinding = new Map<string, QueuedMutation[]>();
    for (const m of all) {
      if (m.kind !== "photo.upload") continue;
      if (m.status !== "completed") continue;
      if (m.resolvedId == null) continue;
      const key = findingKey(m);
      if (!key) continue;
      if (!uploadsByFinding.has(key)) uploadsByFinding.set(key, []);
      uploadsByFinding.get(key)!.push(m);
    }
    for (const arr of uploadsByFinding.values()) {
      arr.sort((a, b) => a.createdAt - b.createdAt);
    }

    let rewritten = 0;
    let cancelled = 0;
    for (const link of legacy) {
      const key = findingKey(link);
      const candidates = key ? uploadsByFinding.get(key) ?? [] : [];
      const match = candidates.shift(); // claim earliest available upload
      if (match) {
        await updateMutation(db, link.id, {
          urlTemplate: "/api/wet-checks/photos/{{p}}",
          parentClientId: match.clientId,
          placeholders: {
            ...(link.placeholders ?? {}),
            p: match.clientId,
            // Keep f if it was set; otherwise default to the finding key.
            f: (link.placeholders?.f as string | undefined) ?? key ?? "",
          },
          status: "pending",
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        });
        rewritten++;
      } else {
        await deleteMutation(db, link.id);
        this.inFlight.delete(link.id);
        this.aborts.delete(link.id);
        cancelled++;
      }
    }

    if (rewritten > 0 || cancelled > 0) {
      console.info(
        `[offline-engine] legacy photo.link cleanup — rewrote ${rewritten}, cancelled ${cancelled} orphan(s)`,
      );
      await this.broadcastState();
      if (rewritten > 0) this.scheduleTick();
    }
    return rewritten + cancelled;
  }

  stop(): void {
    this.started = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async heartbeat(): Promise<void> {
    try {
      const res = await this.fetchImpl("/api/health", { method: "GET" });
      this.setOnline(res.ok);
    } catch {
      this.setOnline(false);
    }
  }

  // Append a new queued mutation. The engine triggers a tick immediately.
  async enqueue(m: QueuedMutation): Promise<void> {
    const db = await this.ensureDB();
    await enqueueMutation(db, m);
    await this.broadcastState();
    this.scheduleTick();
  }

  // Slice 4D — UI-driven actions on individual queue entries.
  //
  // Snapshot of every queue entry, used by the queue view. Re-fetched on
  // every engine state event by the consuming hook.
  async listMutations(): Promise<QueuedMutation[]> {
    const db = await this.ensureDB();
    return await listAllMutations(db);
  }

  // Reset a failed mutation back to pending so the next tick will pick it
  // up. Safe to call on any mutation; only failed entries are useful.
  async retryMutation(id: string): Promise<void> {
    const db = await this.ensureDB();
    await updateMutation(db, id, {
      status: "pending",
      attemptCount: 0,
      lastError: null,
      lastAttemptAt: null,
    });
    await this.broadcastState();
    this.scheduleTick();
  }

  // Remove a mutation from the queue. If it is currently in-flight, abort
  // the fetch first; the dispatcher's catch block will see the abort but
  // updateMutation against the deleted row is a no-op.
  async cancelMutation(id: string): Promise<void> {
    const db = await this.ensureDB();
    const ac = this.aborts.get(id);
    if (ac) {
      try { ac.abort(); } catch { /* ignore */ }
    }
    await deleteMutation(db, id);
    this.inFlight.delete(id);
    this.aborts.delete(id);
    await this.broadcastState();
  }

  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    Promise.resolve().then(() => {
      this.tickScheduled = false;
      this.tick().catch((err) => console.warn("[offline-engine] tick error:", err));
    });
  }

  // Build a {clientId → server id} resolver for every clientId referenced
  // by parent gates or placeholders in the queue. Pre-resolving lets the
  // sync `readySet` honor parents/placeholders that point at entities that
  // already exist on the server (no queued create), so editing a
  // pre-existing wet check doesn't deadlock the queue.
  private async buildResolver(
    db: OfflineDB,
    queue: ReadonlyArray<QueuedMutation>,
  ): Promise<(clientId: string) => number | null> {
    const cidSet = new Set<string>();
    for (const m of queue) {
      if (m.parentClientId) cidSet.add(m.parentClientId);
      for (const c of m.parentClientIds ?? []) cidSet.add(c);
      for (const c of Object.values(m.placeholders ?? {})) cidSet.add(c);
    }
    const map = new Map<string, number | null>();
    for (const cid of Array.from(cidSet)) map.set(cid, await resolveServerId(db, cid));
    return (cid) => (map.has(cid) ? map.get(cid)! : null);
  }

  // Public so tests can drive it deterministically without timers.
  async tick(): Promise<void> {
    if (!this.online) return;
    const db = await this.ensureDB();
    const all = await listAllMutations(db);
    const resolver = await this.buildResolver(db, all);
    const candidates = readySet(all, this.now(), resolver).filter((m) => !this.inFlight.has(m.id));
    const slots = Math.max(0, this.maxConcurrent - this.inFlight.size);
    const next = candidates.slice(0, slots);
    await Promise.all(next.map((m) => this.dispatch(m)));
    // Prune old completed entries each cycle.
    try { await pruneCompleted(db, this.pruneOlderThanMs, this.now()); } catch {}
  }

  // Drain the queue until empty or all remaining mutations are blocked
  // by backoff/parents (test convenience).
  async drainAll(maxIterations = 100): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      await this.tick();
      // Wait for all in-flight to settle.
      while (this.inFlight.size > 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const db = await this.ensureDB();
      const all = await listAllMutations(db);
      const resolver = await this.buildResolver(db, all);
      const remaining = readySet(all, this.now(), resolver);
      const stillPending = all.some((m) => m.status === "pending");
      if (!stillPending) return;
      if (remaining.length === 0) return; // blocked by backoff/parents
    }
  }

  private async dispatch(m: QueuedMutation): Promise<void> {
    this.inFlight.add(m.id);
    let db: OfflineDB;
    try {
      db = await this.ensureDB();
      await updateMutation(db, m.id, { status: "syncing", lastAttemptAt: this.now() });
    } catch (err) {
      // Device storage went away before we touched the network. Nothing was
      // attempted and the row is still durably `pending`, so back out
      // cleanly — leaving the id in `inFlight` would make every future tick
      // skip this mutation for the rest of the page's life, which is
      // precisely how a captured photo disappears for good.
      this.inFlight.delete(m.id);
      this.aborts.delete(m.id);
      if (!isConnectionClosedError(err)) throw err;
      setTimeout(() => this.scheduleTick(), backoffMs(1));
      return;
    }

    let url: string;
    let body: unknown;
    try {
      const resolveCid = async (cid: string) => await resolveServerId(db, cid);
      // Pre-resolve all placeholder ids synchronously by gathering them first.
      const resolvedMap: Record<string, number | null> = {};
      for (const cid of Object.values(m.placeholders ?? {})) {
        resolvedMap[cid] = await resolveCid(cid);
      }
      const lookup = (cid: string) => resolvedMap[cid] ?? null;
      url = resolveTemplate(m.urlTemplate, m.placeholders, lookup);
      body = resolveBody(m.body, m.placeholders, lookup);
    } catch (err: any) {
      // Should not happen — readySet gated on resolved parents — but if
      // it does, leave as pending and back off.
      await updateMutation(db, m.id, {
        status: "pending",
        attemptCount: m.attemptCount + 1,
        lastError: err?.message ?? String(err),
      });
      this.inFlight.delete(m.id);
      return;
    }

    // Belt-and-suspenders: cancel any photo.link mutation whose URL still
    // has a baked-in negative photo ID (pre-Task-#510 legacy shape). These
    // are created by old browser-cached code and will always fail with
    // PostgreSQL error 22003. Deleting here is a silent cleanup so the tech
    // never sees a spurious "sync failed" toast. Fix #1 above (running
    // cleanupLegacyPhotoLinks after every upload) is the primary defence;
    // this guard fires only if a legacy link somehow escapes that pass.
    if (m.kind === "photo.link" && /\/api\/wet-checks\/photos\/-\d+/.test(url)) {
      await deleteMutation(db, m.id);
      this.inFlight.delete(m.id);
      // Note: AbortController (ac) has not been created yet at this point,
      // so there is nothing in this.aborts to clean up.
      return;
    }

    const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (ac) this.aborts.set(m.id, ac);
    try {
      let res: Response;
      if (m.kind === "photo.upload") {
        // Specialized path: pull the captured Blob from IndexedDB and run
        // the existing sign → PUT → finalize → POST flow against the
        // injected fetchImpl. The Blob row is only deleted from IDB after
        // the metadata POST succeeds — the spec's storage-hygiene rule.
        res = await this.dispatchPhotoUpload(db, m, url, body);
      } else {
        const headers: Record<string, string> = {
          ...this.authHeaders(),
        };
        if (m.method !== "DELETE" && body !== undefined) {
          headers["Content-Type"] = "application/json";
        }
        res = await this.fetchImpl(url, {
          method: m.method,
          headers,
          body: m.method === "DELETE" || body === undefined ? undefined : JSON.stringify(body),
          credentials: "include",
          signal: ac?.signal,
          // Task #469 — defense-in-depth: bypass any browser / service
          // worker cache so a stale PWA shell can't return a generic
          // HTML 403/login page for an /api/* mutation.
          cache: "no-store",
        });
      }

      // Any successful response is a heartbeat: we know we're online.
      if (res.ok) {
        this.setOnline(true);
        let payload: any = null;
        try { payload = await res.json(); } catch { /* ignore */ }
        const resolvedId =
          payload && typeof payload === "object" && typeof payload.id === "number"
            ? payload.id
            : null;
        await updateMutation(db, m.id, {
          status: "completed",
          lastError: null,
          resolvedId,
          progress: m.kind === "photo.upload" ? 100 : m.progress,
        });
        // Mirror server-assigned id back into the matching mirror row so
        // future reads can find it by server id, not just clientId.
        await this.applyServerIdToMirror(db, m, resolvedId);
        // 4C — only NOW is the captured Blob safe to drop from IDB.
        if (m.kind === "photo.upload") {
          try { await deletePhotoBlob(db, m.clientId); } catch {}
          // Old browser-cached code (pre-Task-#510) creates photo.link
          // mutations with baked-in negative photo IDs AFTER engine
          // startup, so they escape the startup-only cleanup. Re-running
          // cleanupLegacyPhotoLinks here catches any such link that was
          // just unblocked by this upload completing and rewrites/cancels
          // it before the next tick can dispatch it.
          void this.cleanupLegacyPhotoLinks().catch(() => {});
        }
        // Task #552 — telemetry: photo upload + wet check sync success.
        if (m.kind === "photo.upload") {
          postTelemetry({
            name: "photo.upload.ok",
            severity: "info",
            source: "sw",
            component: "offline.engine",
            context: { attempt: m.attemptCount + 1 },
          });
        } else if (m.kind.startsWith("wet_check.")) {
          postTelemetry({
            name: "wet_check.sync.ok",
            severity: "info",
            source: "sw",
            component: "offline.engine",
            context: { kind: m.kind, attempt: m.attemptCount + 1 },
          });
        }
        await this.broadcastState();
      } else if (res.status === 409) {
        // Conflict — server wins.
        let message = "Conflict";
        try { message = (await res.text()) || message; } catch {}
        await updateMutation(db, m.id, {
          status: "completed",
          lastError: `409: ${message}`,
        });
        const wetCheckId = await this.findWetCheckIdForMutation(db, m);
        if (wetCheckId) {
          await this.refreshMirrorFromServer(db, wetCheckId);
        }
        // Task #552 — telemetry: count conflicts so the Sync card can
        // light up the "Conflicts" tile.
        postTelemetry({
          name: "sync.conflict",
          type: "metric",
          severity: "warning",
          source: "sw",
          component: "offline.engine",
          message: message.slice(0, 200),
          context: { kind: m.kind, status_code: 409 },
        });
        this.emit({
          type: "conflict",
          mutationId: m.id,
          kind: m.kind,
          wetCheckId: wetCheckId ?? null,
          message,
        });
        await this.broadcastState();
      } else if (res.status >= 400 && res.status < 500) {
        // Other 4xx. Two flavors:
        //   • JSON 4xx from our API → real validation/permission error;
        //     mark failed and surface so the UI can show it.
        //   • HTML / non-JSON 4xx (typically a generic 401/403/blocked-host
        //     page injected by the Replit edge proxy or a stale PWA shell
        //     before the request reaches Express) → treat as a transient
        //     network hiccup, keep the mutation pending, flip offline so
        //     the heartbeat recovers us, and back off. (Task #469.)
        let body = "";
        try { body = await res.text(); } catch {}
        const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
        const looksLikeEdge = isLikelyEdgeError(ctype, body);
        const message = looksLikeEdge
          ? (body || `${res.status}`)
          : extractApiErrorMessage(body, res.status);
        if (looksLikeEdge) {
          this.setOnline(false);
          const nextAttempt = m.attemptCount + 1;
          const giveUp = this.capExceededReason(m, nextAttempt);
          if (giveUp) {
            await updateMutation(db, m.id, {
              status: "failed",
              attemptCount: nextAttempt,
              lastError: giveUp,
            });
            this.emit({
              type: "error",
              mutationId: m.id,
              kind: m.kind,
              status: res.status,
              message: giveUp,
              workOrderId: m.workOrderId,
            });
            await this.broadcastState();
          } else {
            await updateMutation(db, m.id, {
              status: "pending",
              attemptCount: nextAttempt,
              lastError: `edge_${res.status}`,
            });
            await this.broadcastState();
            const wait = backoffMs(nextAttempt);
            setTimeout(() => this.scheduleTick(), wait);
          }
        } else {
          await updateMutation(db, m.id, {
            status: "failed",
            lastError: message,
            attemptCount: m.attemptCount + 1,
          });
          this.emit({
            type: "error",
            mutationId: m.id,
            kind: m.kind,
            status: res.status,
            message,
            workOrderId: m.workOrderId,
          });
          await this.broadcastState();
        }
      } else {
        // 5xx → retry with backoff, unless we've blown the cap (Task #501).
        let message = `${res.status}`;
        try { message = (await res.text()) || message; } catch {}
        // 5xx might mean server-side outage — flip offline-ish to throttle
        // future tries. Heartbeat will recover us.
        if (res.status >= 500) this.setOnline(false);
        const nextAttempt = m.attemptCount + 1;
        // Task #552 — telemetry: photo upload + wet check sync 5xx failure.
        if (m.kind === "photo.upload") {
          postTelemetry({
            name: "photo.upload.failed",
            message: message.slice(0, 200),
            severity: "warning",
            source: "sw",
            component: "offline.engine",
            context: { reason: `http_${res.status}`, attempt: nextAttempt },
          });
        } else if (m.kind.startsWith("wet_check.")) {
          postTelemetry({
            name: "wet_check.sync.failed",
            message: message.slice(0, 200),
            severity: "warning",
            source: "sw",
            component: "offline.engine",
            context: { kind: m.kind, reason: `http_${res.status}`, attempt: nextAttempt },
          });
        }
        this.maybeEmitStuck(m, nextAttempt, `http_${res.status}`);
        const giveUp = this.capExceededReason(m, nextAttempt);
        if (giveUp) {
          await updateMutation(db, m.id, {
            status: "failed",
            attemptCount: nextAttempt,
            lastError: `${giveUp}: ${message}`,
          });
          this.emit({
            type: "error",
            mutationId: m.id,
            kind: m.kind,
            status: res.status,
            message,
            workOrderId: m.workOrderId,
          });
          await this.broadcastState();
        } else {
          await updateMutation(db, m.id, {
            status: "pending",
            attemptCount: nextAttempt,
            lastError: message,
          });
          await this.broadcastState();
          const wait = backoffMs(nextAttempt);
          setTimeout(() => this.scheduleTick(), wait);
        }
      }
    } catch (err: any) {
      // A dropped IndexedDB connection is infrastructure trouble on this
      // device, not a delivery attempt. The shared helpers already reopen
      // and retry once; reaching here means even the reopen failed, which
      // on iOS usually just means the page is being suspended mid-write.
      //
      // Requeue WITHOUT incrementing attemptCount. Counting it would let a
      // tech who backgrounds the app often enough burn through the retry
      // cap and have a perfectly good queued photo — bytes still on disk,
      // server never contacted — marked permanently failed.
      if (isConnectionClosedError(err)) {
        try {
          await updateMutation(db, m.id, {
            status: "pending",
            lastError: "local_storage_unavailable",
          });
        } catch {
          // Storage is unreachable entirely. The row is already `pending`
          // on disk from the last successful write, so the next tick after
          // the connection recovers will pick it up unchanged.
        }
        await this.broadcastState().catch(() => {});
        setTimeout(() => this.scheduleTick(), backoffMs(1));
        return;
      }
      // Network error — treat as offline + backoff (Task #501 cap applies).
      this.setOnline(false);
      const errMessage = err?.message ?? String(err);
      const nextAttempt = m.attemptCount + 1;
      // Task #552 — telemetry: photo upload failed (network err).
      if (m.kind === "photo.upload") {
        postTelemetry({
          name: "photo.upload.failed",
          message: errMessage,
          severity: "warning",
          source: "sw",
          component: "offline.engine",
          context: { reason: "network", attempt: nextAttempt },
        });
      } else if (m.kind.startsWith("wet_check.")) {
        postTelemetry({
          name: "wet_check.sync.failed",
          message: errMessage,
          severity: "warning",
          source: "sw",
          component: "offline.engine",
          context: { kind: m.kind, reason: "network", attempt: nextAttempt },
        });
      }
      this.maybeEmitStuck(m, nextAttempt, "network");
      const giveUp = this.capExceededReason(m, nextAttempt);
      if (giveUp) {
        await updateMutation(db, m.id, {
          status: "failed",
          attemptCount: nextAttempt,
          lastError: `${giveUp}: ${errMessage}`,
        });
        this.emit({
          type: "error",
          mutationId: m.id,
          kind: m.kind,
          status: null,
          message: errMessage,
        });
        await this.broadcastState();
      } else {
        await updateMutation(db, m.id, {
          status: "pending",
          attemptCount: nextAttempt,
          lastError: errMessage,
        });
        const wait = backoffMs(nextAttempt);
        setTimeout(() => this.scheduleTick(), wait);
      }
    } finally {
      this.inFlight.delete(m.id);
      this.aborts.delete(m.id);
    }
    // Chain the next dispatch immediately if there's room.
    if (this.online && this.inFlight.size < this.maxConcurrent) {
      this.scheduleTick();
    }
  }

  // 4C — sign → PUT → finalize → POST. The Blob lives in IndexedDB; on
  // every retry we re-sign and re-PUT (signed URLs are short-lived).
  // Returns the final metadata-POST Response so the outer dispatch loop
  // can apply its standard ok/409/4xx/5xx classification.
  private async dispatchPhotoUpload(
    db: OfflineDB,
    m: QueuedMutation,
    metadataUrl: string,
    metadataBody: any,
  ): Promise<Response> {
    const blobRow = await getPhotoBlob(db, m.clientId);
    if (!blobRow) {
      // The Blob was lost (manual IDB clear, partial upgrade, etc).
      // Synthesize a permanent 4xx so the outer loop fails the mutation
      // instead of retrying it forever against missing bytes.
      return new Response(
        JSON.stringify({ message: "Photo bytes missing from local storage" }),
        { status: 410, headers: { "Content-Type": "application/json" } },
      );
    }
    const auth = this.authHeaders();
    const retryCount = m.attemptCount;
    // Per-step telemetry — Task #552. Each pipeline step emits an
    // `ok` or `failed` metric so the Sync & Uploads tab can light up
    // per-step success rates (Captured → DB → S3 → CDN → metadata).
    const emitStep = (step: "sign" | "put" | "finalize" | "metadata", ok: boolean, statusCode: number | null, message?: string) => {
      postTelemetry({
        name: `photo.upload.${step}.${ok ? "ok" : "failed"}`,
        type: "metric",
        severity: ok ? "info" : "warning",
        source: "sw",
        component: "offline.engine",
        message: ok ? "" : (message ?? "").slice(0, 200),
        context: {
          step,
          status_code: statusCode ?? undefined,
          retry_count: retryCount,
        },
      });
    };
    // 1) Sign — first hop, hits our own API → DB row reservation.
    const t1 = Date.now();
    const signRes = await this.fetchImpl(
      `/api/upload/photo?originalName=${encodeURIComponent(blobRow.name)}`,
      { method: "POST", headers: auth, credentials: "include" },
    );
    if (!signRes.ok) {
      let body = "";
      try { body = (await signRes.clone().text()).slice(0, 200); } catch {}
      emitStep("sign", false, signRes.status, body || `sign_${signRes.status}`);
      return signRes;
    }
    emitStep("sign", true, signRes.status);
    const signed = await signRes.json();
    await updateMutation(db, m.id, { progress: 25 });
    // 2) PUT bytes to signed URL — this is the S3 hop.
    const putRes = await this.fetchImpl(signed.signedUrl, {
      method: "PUT",
      body: blobRow.blob,
      headers: { "Content-Type": blobRow.contentType },
    });
    if (!putRes.ok) {
      emitStep("put", false, putRes.status, `s3_${putRes.status}`);
      // Surface as a 5xx so the outer loop schedules a retry — signed
      // URLs commonly fail with transient 503s on weak LTE.
      return new Response("PUT failed", { status: 502 });
    }
    emitStep("put", true, putRes.status);
    await updateMutation(db, m.id, { progress: 60 });
    // 3) Finalize — server-side CDN handoff / EXIF strip.
    const finRes = await this.fetchImpl("/api/upload/photo/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      credentials: "include",
      body: JSON.stringify({ photoId: signed.url }),
    });
    if (!finRes.ok) {
      let body = "";
      try { body = (await finRes.clone().text()).slice(0, 200); } catch {}
      emitStep("finalize", false, finRes.status, body || `finalize_${finRes.status}`);
      return finRes;
    }
    emitStep("finalize", true, finRes.status);
    await updateMutation(db, m.id, { progress: 80 });
    // 4) POST metadata to /api/wet-checks/:id/photos. The placeholder-
    // resolved body from the queue is merged with the dynamic url field.
    const finalBody = { ...(metadataBody as object | null ?? {}), url: signed.url };
    const metaRes = await this.fetchImpl(metadataUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      credentials: "include",
      body: JSON.stringify(finalBody),
    });
    if (metaRes.ok) {
      emitStep("metadata", true, metaRes.status);
    } else {
      let body = "";
      try { body = (await metaRes.clone().text()).slice(0, 200); } catch {}
      emitStep("metadata", false, metaRes.status, body || `metadata_${metaRes.status}`);
    }
    void t1; // keep — duration captured by outer success path
    return metaRes;
  }

  private async applyServerIdToMirror(db: OfflineDB, m: QueuedMutation, id: number | null) {
    if (id == null) return;
    const store =
      m.kind === "wet_check.create" ? "wetChecks"
      : m.kind === "zone_record.upsert" ? "wetCheckZoneRecords"
      : m.kind === "finding.create" ? "wetCheckFindings"
      : null;
    if (!store) return;
    await withDB(db, async (d) => {
      const tx = d.transaction(store, "readwrite");
      const cur = await tx.store.get(m.clientId);
      if (cur) await tx.store.put({ ...cur, id } as any);
      await tx.done;
    });
  }

  private async findWetCheckIdForMutation(db: OfflineDB, m: QueuedMutation): Promise<number | null> {
    // Walk parent chain to find the wet check id this mutation belongs to.
    let cursor: QueuedMutation | undefined | null = m;
    const all = await listAllMutations(db);
    const byClientId = new Map(all.map((x) => [x.clientId, x] as const));
    while (cursor) {
      if (cursor.kind.startsWith("wet_check.")) {
        if (cursor.resolvedId) return cursor.resolvedId;
        const mirror = await withDB(db, (d) => d.get("wetChecks", cursor!.clientId));
        if (mirror?.id) return mirror.id;
      }
      // Many queued mutations target pre-existing server entities, so there
      // may be no queued ancestor that owns the wet check id. Fall back to
      // resolving via the per-entity mirrors / placeholders.
      const candidateWetCheckCids: string[] = [];
      if (cursor.kind === "finding.update" || cursor.kind === "finding.delete") {
        const fRow = await withDB(db, (d) => d.get("wetCheckFindings", cursor!.clientId));
        if (fRow?.wetCheckId) return fRow.wetCheckId;
        const zrCid = fRow?.zoneRecordClientId ?? cursor.parentClientId;
        if (zrCid) {
          const zrRow = await withDB(db, (d) => d.get("wetCheckZoneRecords", zrCid));
          if (zrRow?.wetCheckId) return zrRow.wetCheckId;
          if (zrRow?.wetCheckClientId) candidateWetCheckCids.push(zrRow.wetCheckClientId);
        }
      }
      if (cursor.kind === "zone_record.upsert") {
        const zrRow = await withDB(db, (d) => d.get("wetCheckZoneRecords", cursor!.clientId));
        if (zrRow?.wetCheckId) return zrRow.wetCheckId;
        if (zrRow?.wetCheckClientId) candidateWetCheckCids.push(zrRow.wetCheckClientId);
      }
      // Submit / setStatus carry the wet check clientId via parentClientId
      // or the {{wc}} placeholder; consult the mirror directly.
      const placeholderWcCid = cursor.placeholders?.wc;
      if (placeholderWcCid) candidateWetCheckCids.push(placeholderWcCid);
      if (cursor.parentClientId) candidateWetCheckCids.push(cursor.parentClientId);
      for (const wcCid of candidateWetCheckCids) {
        const wcMirror = await withDB(db, (d) => d.get("wetChecks", wcCid));
        if (wcMirror?.id) return wcMirror.id;
      }
      cursor = cursor.parentClientId ? byClientId.get(cursor.parentClientId) ?? null : null;
    }
    return null;
  }

  private async refreshMirrorFromServer(db: OfflineDB, wetCheckId: number): Promise<void> {
    try {
      const res = await this.fetchImpl(`/api/wet-checks/${wetCheckId}`, {
        method: "GET",
        headers: this.authHeaders(),
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      const clientId: string = data?.clientId ?? `server-${wetCheckId}`;
      const updatedAt = this.now();
      // Server-wins: drop existing per-entity mirror rows for this wet
      // check so any local entities the server no longer has (e.g. a
      // finding that lost the conflict and was rejected, or one that has
      // been converted/deleted server-side) are removed instead of
      // continuing to render via assembleFromMirror.
      const existingZones = await withDB(db, (d) =>
        d.getAllFromIndex("wetCheckZoneRecords", "byWetCheckClientId", clientId));
      for (const zr of existingZones) {
        const existingFindings = await withDB(db, (d) =>
          d.getAllFromIndex("wetCheckFindings", "byZoneRecordClientId", zr.clientId));
        for (const f of existingFindings) {
          await withDB(db, (d) => d.delete("wetCheckFindings", f.clientId));
        }
        await withDB(db, (d) => d.delete("wetCheckZoneRecords", zr.clientId));
      }
      await putWetCheckMirror(db, {
        clientId,
        id: wetCheckId,
        data,
        status: data?.status ?? "in_progress",
        updatedAt,
      });
      // Insert the fresh server snapshot.
      const zoneRecords: any[] = Array.isArray(data?.zoneRecords) ? data.zoneRecords : [];
      for (const zr of zoneRecords) {
        if (!zr?.clientId) continue;
        await withDB(db, (d) => d.put("wetCheckZoneRecords", {
          clientId: zr.clientId,
          id: typeof zr.id === "number" ? zr.id : undefined,
          wetCheckClientId: clientId,
          wetCheckId,
          data: zr,
          updatedAt,
        }));
        const findings: any[] = Array.isArray(zr?.findings) ? zr.findings : [];
        for (const f of findings) {
          if (!f?.clientId) continue;
          await withDB(db, (d) => d.put("wetCheckFindings", {
            clientId: f.clientId,
            id: typeof f.id === "number" ? f.id : undefined,
            zoneRecordClientId: zr.clientId,
            zoneRecordId: typeof zr.id === "number" ? zr.id : undefined,
            wetCheckId,
            data: f,
            updatedAt,
          }));
        }
      }
    } catch {
      // ignore
    }
  }
}

// --- Singleton + flag glue ---------------------------------------------

const FLAG_ENABLED =
  (typeof import.meta !== "undefined" &&
    (import.meta as any).env?.VITE_OFFLINE_QUEUE !== "false");

export function isOfflineQueueEnabled(): boolean {
  return FLAG_ENABLED;
}

// Slice 4D — Independent feature flag for the sync UI surface (badge,
// queue view, offline strip, conflict toast). Defaults on. Flipping this
// off hides the UI but keeps the queue draining in the background.
const SYNC_UI_FLAG_ENABLED =
  (typeof import.meta !== "undefined" &&
    (import.meta as any).env?.VITE_OFFLINE_SYNC_UI !== "false");

export function isOfflineSyncUIEnabled(): boolean {
  return SYNC_UI_FLAG_ENABLED;
}

let singleton: SyncEngine | null = null;

export function getSyncEngine(): SyncEngine {
  if (!singleton) {
    singleton = new SyncEngine({
      authHeaders: () => {
        if (typeof window === "undefined") return {};
        try {
          const raw = localStorage.getItem("user");
          if (!raw) return {};
          const u = JSON.parse(raw);
          const h: Record<string, string> = {};
          if (u?.role) h["x-user-role"] = u.role;
          if (u?.id != null) h["x-user-id"] = String(u.id);
          if (u?.name) h["x-user-name"] = u.name;
          if (u?.companyId != null) h["x-user-company-id"] = String(u.companyId);
          return h;
        } catch { return {}; }
      },
    });
  }
  return singleton;
}

// Test-only.
export function __resetEngineForTests() {
  singleton = null;
}

// Test-only — inject a specific engine as the singleton so functions that
// call getSyncEngine() (e.g. queuePhotoUpload) use a controlled instance.
export function __setEngineForTests(engine: SyncEngine) {
  singleton = engine;
}
