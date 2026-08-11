// Task #739 — QuickBooks token refresh regression tests.
//
// Locks in the contract for the QB token-refresh lifecycle so that a
// silent token expiry cannot break invoice export without a visible error.
//
// Scenarios:
//   1. Happy-path refresh: near-expiry access token is replaced; connection
//      status stays "connected" after a successful refresh.
//   2. Proactive refresh skipped when token is still far from expiry.
//   3. Proactive refresh skipped when connection is already reconnect_required.
//   4. Proactive refresh skipped when no integration exists.
//   5. Stale refresh token (invalid_grant) → classified as stale_refresh_token
//      → markReconnectRequired called → re-auth prompt (unrecoverable).
//   6. Revoked token → classified as revoked → unrecoverable.
//   7. Intuit 4xx unknown error → classified as reconnect_required → unrecoverable.
//   8. Transient server error (5xx) → classified as transient → NOT unrecoverable,
//      markReconnectRequired NOT called.
//   9. Refresh supplies a new refresh_token → new refresh token is saved.
//  10. Refresh omits refresh_token → existing refresh token is preserved.
//  11. Concurrent callers for the same realmId share the lock — Intuit called once.
//  12. Health job fires for a near-expiry realm.
//  13. Health job fires for an idle realm (>= 90 days since last refresh).
//  14. Health job skips a healthy, recently-refreshed realm.
//  15. Health job skips a realm already in reconnect_required state.

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  classifyQbRefreshError,
  runProactiveRefreshForRealm,
  startQbTokenHealthJob,
  withQbRefreshLock,
  getLastQbHealthSweep,
  resetLastQbHealthSweep,
  QB_PROACTIVE_REFRESH_BUFFER_MS,
  QB_IDLE_THRESHOLD_DAYS,
  qbRefreshLock,
  type QbStorageAdapter,
  type QbTokenPair,
} from "../qb-token-utils";
import { logger } from "../lib/logger";

// ─── Minimal in-memory storage stub ────────────────────────────────────────

type FakeIntegration = {
  companyId: string;
  accessToken: string;
  refreshToken: string;
  realmId: string;
  expiresAt: Date;
  connectionStatus: string;
  reconnectRequiredReason: string | null;
  lastRefreshAttempt?: Date | null;
  lastRefreshSuccess?: Date | null;
};

function makeStore(initial?: Partial<FakeIntegration>): QbStorageAdapter & {
  saved: FakeIntegration[];
  reconnectCalls: Array<{ realmId: string; reason: string }>;
  current: FakeIntegration | null;
} {
  const base: FakeIntegration = {
    companyId: "company-1",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    realmId: "realm-1",
    expiresAt: new Date(Date.now() + 60 * 1000), // 1 minute from now (within buffer)
    connectionStatus: "connected",
    reconnectRequiredReason: null,
    lastRefreshSuccess: new Date(Date.now() - 60 * 1000),
    ...initial,
  };

  const store = {
    current: base as FakeIntegration | null,
    saved: [] as FakeIntegration[],
    reconnectCalls: [] as Array<{ realmId: string; reason: string }>,

    async getIntegration(realmId: string) {
      if (!store.current || store.current.realmId !== realmId) return null;
      return { ...store.current };
    },

    async saveIntegration(data: {
      companyId: string;
      accessToken: string;
      refreshToken: string;
      realmId: string;
      expiresAt: Date;
      lastRefreshAttempt?: Date | null;
      lastRefreshSuccess?: Date | null;
      connectionStatus?: string;
    }) {
      const merged: FakeIntegration = {
        ...(store.current as FakeIntegration),
        ...data,
        connectionStatus: data.connectionStatus ?? store.current?.connectionStatus ?? "connected",
        reconnectRequiredReason: store.current?.reconnectRequiredReason ?? null,
      };
      store.saved.push(merged);
      store.current = merged;
    },

    async markReconnectRequired(realmId: string, reason: string) {
      store.reconnectCalls.push({ realmId, reason });
      if (store.current && store.current.realmId === realmId) {
        store.current = {
          ...store.current,
          connectionStatus: "reconnect_required",
          reconnectRequiredReason: reason,
        };
      }
    },
  };

  return store;
}

// Simple doRefresh that returns a fresh token pair.
function makeRefreshFn(
  result: Partial<QbTokenPair> | Error
): (refreshToken: string, signal: AbortSignal) => Promise<QbTokenPair> {
  return async (_refreshToken, _signal) => {
    if (result instanceof Error) throw result;
    return {
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
      ...result,
    };
  };
}

// ─── classifyQbRefreshError ─────────────────────────────────────────────────

describe("classifyQbRefreshError", () => {
  it("classifies invalid_grant as stale_refresh_token", () => {
    const cat = classifyQbRefreshError(
      JSON.stringify({ error: "invalid_grant" }),
      400
    );
    assert.equal(cat, "stale_refresh_token");
  });

  it("classifies invalid_refresh_token as stale_refresh_token", () => {
    const cat = classifyQbRefreshError(
      JSON.stringify({ error: "invalid_refresh_token" }),
      400
    );
    assert.equal(cat, "stale_refresh_token");
  });

  it("classifies authorization_revoked as revoked", () => {
    const cat = classifyQbRefreshError(
      JSON.stringify({ error: "authorization_revoked" }),
      401
    );
    assert.equal(cat, "revoked");
  });

  it("classifies access_denied as revoked", () => {
    const cat = classifyQbRefreshError(
      JSON.stringify({ error: "access_denied" }),
      403
    );
    assert.equal(cat, "revoked");
  });

  it("classifies 5xx server error as transient", () => {
    const cat = classifyQbRefreshError("internal server error", 503);
    assert.equal(cat, "transient");
  });

  it("classifies server_error code as transient regardless of status", () => {
    const cat = classifyQbRefreshError(
      JSON.stringify({ error: "server_error" }),
      200
    );
    assert.equal(cat, "transient");
  });

  it("classifies unknown 4xx as reconnect_required", () => {
    const cat = classifyQbRefreshError(
      JSON.stringify({ error: "some_unknown_error" }),
      422
    );
    assert.equal(cat, "reconnect_required");
  });
});

// ─── runProactiveRefreshForRealm ─────────────────────────────────────────────

describe("runProactiveRefreshForRealm — happy path", () => {
  beforeEach(() => {
    qbRefreshLock.clear();
  });

  it("refreshes a near-expiry token and returns connected result", async () => {
    const store = makeStore({
      expiresAt: new Date(Date.now() + 60 * 1000), // 1 min from now — within 5min buffer
    });
    const doRefresh = makeRefreshFn({
      access_token: "access-fresh",
      refresh_token: "refresh-fresh",
      expires_in: 3600,
    });

    const result = await runProactiveRefreshForRealm(
      "realm-1",
      doRefresh,
      store
    );

    assert.equal(result.skipped, false, "should not be skipped");
    assert.equal(result.refreshed, true, "should be marked refreshed");
    assert.equal(result.newAccessToken, "access-fresh", "should return new access token");
    assert.ok(!result.error, "should have no error");

    // Storage must have been updated with the new tokens
    assert.equal(store.saved.length, 1, "saveIntegration called once");
    assert.equal(store.saved[0].accessToken, "access-fresh");
    assert.equal(store.saved[0].refreshToken, "refresh-fresh");

    // No reconnect_required should have been flagged
    assert.equal(
      store.reconnectCalls.length,
      0,
      "markReconnectRequired must NOT be called on success"
    );
  });

  it("saves the existing refresh_token when Intuit omits it from the response", async () => {
    const store = makeStore({
      refreshToken: "original-refresh",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    // Intuit response without a new refresh_token
    const doRefresh = makeRefreshFn({ access_token: "access-v2", refresh_token: undefined });

    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.refreshed, true);
    assert.equal(store.saved[0].refreshToken, "original-refresh",
      "must preserve existing refresh_token when Intuit omits one");
  });

  it("skips when token is not near expiry", async () => {
    const store = makeStore({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour away — well beyond 5min buffer
    });
    let refreshCalled = false;
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      refreshCalled = true;
      return { access_token: "x", refresh_token: "y", expires_in: 3600 };
    };

    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "not_near_expiry");
    assert.equal(refreshCalled, false, "Intuit should not be called when token is healthy");
    assert.equal(store.saved.length, 0, "storage should not be mutated");
  });

  it("skips when connection is already reconnect_required", async () => {
    const store = makeStore({
      connectionStatus: "reconnect_required",
      expiresAt: new Date(Date.now() - 5000), // already expired
    });
    let refreshCalled = false;
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      refreshCalled = true;
      return { access_token: "x", refresh_token: "y", expires_in: 3600 };
    };

    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "reconnect_required");
    assert.equal(refreshCalled, false, "Intuit must not be called when already disconnected");
  });

  it("skips when there is no integration for the realmId", async () => {
    const store = makeStore();
    store.current = null;

    const doRefresh = makeRefreshFn({ access_token: "x" });
    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "no_integration");
  });
});

// ─── runProactiveRefreshForRealm — unrecoverable failures ────────────────────

describe("runProactiveRefreshForRealm — token expiry / revocation", () => {
  beforeEach(() => {
    qbRefreshLock.clear();
  });

  it("stale refresh token (invalid_grant) → unrecoverable → markReconnectRequired called", async () => {
    const store = makeStore({
      expiresAt: new Date(Date.now() + 60 * 1000),
    });

    const { QbRefreshError } = await import("../qb-token-utils");
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      throw new QbRefreshError(
        JSON.stringify({ error: "invalid_grant" }),
        "stale_refresh_token"
      );
    };

    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.skipped, false, "should not be skipped — refresh was attempted");
    assert.equal(result.refreshed, false, "should not be marked refreshed");
    assert.equal(result.isUnrecoverable, true, "stale refresh token is unrecoverable");
    assert.ok(result.error, "should carry the error");

    // Must have called markReconnectRequired to surface the re-auth prompt
    assert.equal(store.reconnectCalls.length, 1,
      "markReconnectRequired must be called exactly once");
    assert.equal(store.reconnectCalls[0].realmId, "realm-1");
    assert.match(
      store.reconnectCalls[0].reason,
      /reauthorize|expired|invalid_grant/i,
      "reason should explain why re-auth is needed"
    );

    // Connection status must now be reconnect_required so users see the re-auth prompt
    assert.equal(
      store.current?.connectionStatus,
      "reconnect_required",
      "connection must be flagged reconnect_required after stale refresh token"
    );

    // No partial token save should have happened
    assert.equal(store.saved.length, 0, "saveIntegration must not be called on failure");
  });

  it("revoked authorization → unrecoverable → markReconnectRequired called", async () => {
    const store = makeStore({ expiresAt: new Date(Date.now() + 30 * 1000) });

    const { QbRefreshError } = await import("../qb-token-utils");
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      throw new QbRefreshError("authorization_revoked", "revoked");
    };

    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.isUnrecoverable, true);
    assert.equal(store.reconnectCalls.length, 1,
      "revoked token must trigger re-auth prompt");
    assert.equal(store.current?.connectionStatus, "reconnect_required");
  });

  it("reconnect_required category → unrecoverable → markReconnectRequired called", async () => {
    const store = makeStore({ expiresAt: new Date(Date.now() + 30 * 1000) });

    const { QbRefreshError } = await import("../qb-token-utils");
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      throw new QbRefreshError("unknown 4xx error", "reconnect_required");
    };

    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.isUnrecoverable, true);
    assert.equal(store.reconnectCalls.length, 1);
  });

  it("transient error → NOT unrecoverable → markReconnectRequired NOT called", async () => {
    const store = makeStore({ expiresAt: new Date(Date.now() + 30 * 1000) });

    const { QbRefreshError } = await import("../qb-token-utils");
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      throw new QbRefreshError("temporarily_unavailable", "transient");
    };

    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.refreshed, false, "refresh did not succeed");
    assert.equal(result.isUnrecoverable, false, "transient error is recoverable");
    assert.equal(store.reconnectCalls.length, 0,
      "transient error must NOT flag reconnect_required");
    assert.equal(
      store.current?.connectionStatus,
      "connected",
      "connection status must remain connected on transient error"
    );
  });

  it("generic non-QbRefreshError → not unrecoverable → no markReconnectRequired", async () => {
    const store = makeStore({ expiresAt: new Date(Date.now() + 30 * 1000) });

    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      throw new Error("network timeout");
    };

    const result = await runProactiveRefreshForRealm("realm-1", doRefresh, store);

    assert.equal(result.refreshed, false);
    assert.equal(result.isUnrecoverable, false);
    assert.equal(store.reconnectCalls.length, 0);
  });
});

// ─── withQbRefreshLock — concurrency deduplication ───────────────────────────

describe("withQbRefreshLock — concurrent callers share result", () => {
  beforeEach(() => {
    qbRefreshLock.clear();
  });

  it("concurrent refresh calls for the same realmId resolve to the same token", async () => {
    let callCount = 0;
    const doRefresh = async (_signal: AbortSignal): Promise<string> => {
      callCount++;
      // Small delay to let the second caller arrive before the first resolves
      await new Promise((r) => setTimeout(r, 10));
      return "shared-access-token";
    };

    const [r1, r2] = await Promise.all([
      withQbRefreshLock("realm-concurrent", doRefresh),
      withQbRefreshLock("realm-concurrent", doRefresh),
    ]);

    assert.equal(callCount, 1, "Intuit must be called exactly once for concurrent requests");
    assert.equal(r1, "shared-access-token");
    assert.equal(r2, "shared-access-token");
  });

  it("sequential calls after the lock clears each call Intuit once", async () => {
    let callCount = 0;
    const doRefresh = async (_signal: AbortSignal): Promise<string> => {
      callCount++;
      return `token-${callCount}`;
    };

    const r1 = await withQbRefreshLock("realm-seq", doRefresh);
    const r2 = await withQbRefreshLock("realm-seq", doRefresh);

    assert.equal(callCount, 2, "each sequential call should invoke Intuit independently");
    assert.equal(r1, "token-1");
    assert.equal(r2, "token-2");
  });
});

// ─── startQbTokenHealthJob ───────────────────────────────────────────────────

describe("startQbTokenHealthJob", () => {
  beforeEach(() => {
    qbRefreshLock.clear();
  });

  it("refreshes a near-expiry realm during the initial sweep", async () => {
    const store = makeStore({
      expiresAt: new Date(Date.now() + 60 * 1000), // within 5-min buffer
      lastRefreshSuccess: new Date(),
    });

    let refreshCalled = false;
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      refreshCalled = true;
      return { access_token: "health-fresh", refresh_token: "rf-new", expires_in: 3600 };
    };

    // Pass a very long interval so only the initial sweep fires during the test.
    const handle = startQbTokenHealthJob(
      async () => [
        {
          realmId: "realm-1",
          connectionStatus: "connected",
          expiresAt: new Date(Date.now() + 60 * 1000),
          lastRefreshSuccess: new Date(),
        },
      ],
      doRefresh,
      store,
      24 * 60 * 60 * 1000
    );

    // Give the async initial sweep a moment to complete.
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(handle);

    assert.equal(refreshCalled, true, "health job must refresh a near-expiry realm");
    assert.equal(store.saved.length, 1, "saveIntegration must be called");
    assert.equal(store.saved[0].accessToken, "health-fresh");
  });

  it("refreshes a realm idle >= 90 days even when the access token is not near expiry", async () => {
    const idleLastSuccess = new Date(
      Date.now() - (QB_IDLE_THRESHOLD_DAYS + 1) * 24 * 60 * 60 * 1000
    );
    const store = makeStore({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour away — healthy
      lastRefreshSuccess: idleLastSuccess,
    });

    let refreshCalled = false;
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      refreshCalled = true;
      return { access_token: "idle-fresh", refresh_token: "rf-idle", expires_in: 3600 };
    };

    const handle = startQbTokenHealthJob(
      async () => [
        {
          realmId: "realm-1",
          connectionStatus: "connected",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          lastRefreshSuccess: idleLastSuccess,
        },
      ],
      doRefresh,
      store,
      24 * 60 * 60 * 1000
    );

    await new Promise((r) => setTimeout(r, 50));
    clearInterval(handle);

    assert.equal(refreshCalled, true,
      "health job must refresh an idle realm approaching the 90-day Intuit revocation threshold");
    assert.equal(store.saved[0].accessToken, "idle-fresh");
  });

  it("skips a healthy, recently-refreshed realm", async () => {
    let refreshCalled = false;
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      refreshCalled = true;
      return { access_token: "x", refresh_token: "y", expires_in: 3600 };
    };

    const store = makeStore({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour away
      lastRefreshSuccess: new Date(), // just refreshed
    });

    const handle = startQbTokenHealthJob(
      async () => [
        {
          realmId: "realm-1",
          connectionStatus: "connected",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          lastRefreshSuccess: new Date(),
        },
      ],
      doRefresh,
      store,
      24 * 60 * 60 * 1000
    );

    await new Promise((r) => setTimeout(r, 50));
    clearInterval(handle);

    assert.equal(refreshCalled, false, "healthy realm must not be refreshed unnecessarily");
  });

  it("skips a realm already in reconnect_required state", async () => {
    let refreshCalled = false;
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      refreshCalled = true;
      return { access_token: "x", refresh_token: "y", expires_in: 3600 };
    };

    const store = makeStore({
      connectionStatus: "reconnect_required",
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    // Health job getAllActiveIntegrations should not return reconnect_required realms,
    // but even if it does, the job's own guard skips them.
    const handle = startQbTokenHealthJob(
      async () => [
        {
          realmId: "realm-1",
          connectionStatus: "reconnect_required",
          expiresAt: new Date(Date.now() - 1000),
          lastRefreshSuccess: null,
        },
      ],
      doRefresh,
      store,
      24 * 60 * 60 * 1000
    );

    await new Promise((r) => setTimeout(r, 50));
    clearInterval(handle);

    assert.equal(refreshCalled, false,
      "reconnect_required realm must never be silently refreshed — it needs explicit user re-auth");
  });
});

// ─── Task #1911 — a failed load is not an empty sweep ────────────────────────
//
// storage.getAllActiveQuickBooksIntegrations used to swallow database errors
// and return []. The health job then iterated nothing, refreshed nothing, and
// finished exactly like a sweep of a fleet with no connected realms — while
// every real token marched toward the 100-day Intuit revocation. The loader now
// throws, and the job has to say so.

describe("startQbTokenHealthJob — failed integration load (Task #1911)", () => {
  beforeEach(() => {
    qbRefreshLock.clear();
    resetLastQbHealthSweep();
  });

  after(() => {
    resetLastQbHealthSweep();
  });

  async function runSweepWithFailingLoader(): Promise<{ errorLogs: unknown[][] }> {
    const errorLogs: unknown[][] = [];
    const realError = logger.error.bind(logger);
    (logger as any).error = (...args: unknown[]) => {
      errorLogs.push(args);
    };

    const store = makeStore();
    let refreshCalled = false;
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      refreshCalled = true;
      return { access_token: "x", refresh_token: "y", expires_in: 3600 };
    };

    try {
      const handle = startQbTokenHealthJob(
        async () => {
          throw new Error("Failed query: timeout exceeded when trying to connect");
        },
        doRefresh,
        store,
        24 * 60 * 60 * 1000,
      );
      await new Promise((r) => setTimeout(r, 50));
      clearInterval(handle);
    } finally {
      (logger as any).error = realError;
    }

    assert.equal(refreshCalled, false, "nothing can be refreshed when the load failed");
    return { errorLogs };
  }

  it("records the run as skipped instead of a clean sweep over zero integrations", async () => {
    await runSweepWithFailingLoader();

    const record = getLastQbHealthSweep();
    assert.ok(record, "the sweep must record an outcome an operator can read");
    assert.equal(
      record!.status,
      "skipped_load_failed",
      "a failed load must never be recorded as a completed sweep",
    );
    assert.equal(record!.checked, 0);
    assert.equal(record!.refreshed, 0);
    assert.match(String(record!.error), /timeout exceeded when trying to connect/);
  });

  it("logs at error level through the structured logger", async () => {
    const { errorLogs } = await runSweepWithFailingLoader();
    assert.equal(errorLogs.length, 1, "exactly one error-level log for the failed load");
    const [context, message] = errorLogs[0] as [Record<string, unknown>, string];
    assert.ok((context as any).err, "the underlying database error must be attached");
    assert.match(String(message), /sweep skipped/i);
  });

  it("a sweep that really has no connected realms is still recorded as completed", async () => {
    // The other half of the fix: zero integrations is a legitimate outcome and
    // must stay distinguishable from a load that blew up.
    const store = makeStore();
    const doRefresh: (r: string, s: AbortSignal) => Promise<QbTokenPair> = async () => {
      throw new Error("must not be called");
    };

    const handle = startQbTokenHealthJob(async () => [], doRefresh, store, 24 * 60 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(handle);

    const record = getLastQbHealthSweep();
    assert.equal(record?.status, "completed");
    assert.equal(record?.checked, 0);
  });
});
