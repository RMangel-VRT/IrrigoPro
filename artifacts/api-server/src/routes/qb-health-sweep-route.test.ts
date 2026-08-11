// Task #1911 — POST /api/internal/qb/health-sweep failure path.
//
// The route always had a try/catch around the integration load that returns
// 500, but the catch was dead code: storage.getAllActiveQuickBooksIntegrations
// caught its own database errors and returned []. The probe therefore answered
// 200 {"checked":0,"refreshed":0} to an external cron whenever the database was
// unreachable — a green check for a sweep that never happened.
//
// Now the storage reader throws, so these tests prove the 500 branch actually
// fires, and that a real zero-integration fleet still answers 200.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { registerQbHealthSweepRoute } from "./qb-health-sweep-route";
import { storage } from "../storage";
import type { QbRefreshFn, QbStorageAdapter } from "../qb-token-utils";

const PROBE_TOKEN = "test-probe-token-1911";

const originalGetAllActive = (storage as any).getAllActiveQuickBooksIntegrations;
const originalProbeToken = process.env.QB_HEALTH_PROBE_TOKEN;

// The refresh seam must never be reached in these tests — every scenario
// either fails before the loop or has nothing to iterate.
const refreshFn: QbRefreshFn = async () => {
  throw new Error("Intuit must not be called in this test");
};

const store: QbStorageAdapter = {
  getIntegration: async () => null,
  saveIntegration: async () => {},
  markReconnectRequired: async () => {},
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  registerQbHealthSweepRoute(app, { refreshFn, store });
  return app;
}

async function startServer(app: Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("POST /api/internal/qb/health-sweep (Task #1911)", () => {
  let server: Server;
  let base: string;

  before(async () => {
    process.env.QB_HEALTH_PROBE_TOKEN = PROBE_TOKEN;
    ({ server, base } = await startServer(makeApp()));
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    (storage as any).getAllActiveQuickBooksIntegrations = originalGetAllActive;
    if (originalProbeToken === undefined) {
      delete process.env.QB_HEALTH_PROBE_TOKEN;
    } else {
      process.env.QB_HEALTH_PROBE_TOKEN = originalProbeToken;
    }
  });

  beforeEach(() => {
    (storage as any).getAllActiveQuickBooksIntegrations = originalGetAllActive;
  });

  function post() {
    return fetch(`${base}/api/internal/qb/health-sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${PROBE_TOKEN}` },
    });
  }

  it("returns 500 when the integration load fails", async () => {
    (storage as any).getAllActiveQuickBooksIntegrations = async () => {
      throw new Error("Failed query: timeout exceeded when trying to connect");
    };

    const res = await post();
    assert.equal(res.status, 500, "a failed load must not be reported as a completed sweep");
    assert.deepEqual(await res.json(), { error: "failed to fetch integrations" });
  });

  it("still returns 200 with checked:0 when there genuinely are no integrations", async () => {
    (storage as any).getAllActiveQuickBooksIntegrations = async () => [];

    const res = await post();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { checked: 0, refreshed: 0, reconnect_required: [] });
  });

  it("counts a healthy realm without refreshing it", async () => {
    (storage as any).getAllActiveQuickBooksIntegrations = async () => [
      {
        realmId: "realm-1",
        connectionStatus: "connected",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        lastRefreshSuccess: new Date(),
      },
    ];

    const res = await post();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { checked: 1, refreshed: 0, reconnect_required: [] });
  });

  it("rejects an unauthenticated probe before touching storage", async () => {
    let loadCalled = false;
    (storage as any).getAllActiveQuickBooksIntegrations = async () => {
      loadCalled = true;
      return [];
    };

    const res = await fetch(`${base}/api/internal/qb/health-sweep`, { method: "POST" });
    assert.equal(res.status, 401);
    assert.equal(loadCalled, false);
  });
});
