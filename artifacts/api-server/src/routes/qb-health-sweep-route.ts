// QB Harden #4 — External daily health probe.
//
// POST /api/internal/qb/health-sweep
//
// Called by an external cron / Replit Scheduled Task to guarantee the QB token
// sweep runs at least once per day even when the server has been idle (which
// would reset the in-process setInterval in registerRoutes).
//
// Auth: Authorization: Bearer <QB_HEALTH_PROBE_TOKEN>
//   - 503 {"error":"not configured"} if the env var is absent
//   - 401 {"error":"unauthorized"}   if the token doesn't match
//
// Response: { checked: N, refreshed: N, reconnect_required: string[] }
//
// Task #1911 — extracted verbatim from routes.ts so the failure path has an
// importable seam. The 500 branch below was previously dead code:
// storage.getAllActiveQuickBooksIntegrations() caught its own database errors
// and returned [], so this catch could never fire and a failed load was
// reported as a successful sweep over zero integrations.

import type { Express } from "express";
import { storage } from "../storage";
import {
  runProactiveRefreshForRealm,
  QB_IDLE_THRESHOLD_DAYS,
  QB_PROACTIVE_REFRESH_BUFFER_MS,
  type QbRefreshFn,
  type QbStorageAdapter,
} from "../qb-token-utils";

export interface RegisterQbHealthSweepRouteDeps {
  /** Injected Intuit refresh call (real token endpoint in production). */
  refreshFn: QbRefreshFn;
  /** Storage adapter bridge used by qb-token-utils. */
  store: QbStorageAdapter;
}

export function registerQbHealthSweepRoute(
  app: Express,
  { refreshFn, store }: RegisterQbHealthSweepRouteDeps,
): void {
  app.post("/api/internal/qb/health-sweep", async (req: any, res) => {
    const probeToken = process.env.QB_HEALTH_PROBE_TOKEN;
    if (!probeToken) {
      res.status(503).json({ error: "not configured" });
      return;
    }

    const authHeader = req.headers["authorization"] ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!provided || provided !== probeToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    let integrations: Array<{
      realmId: string;
      connectionStatus: string;
      expiresAt: Date;
      lastRefreshSuccess: Date | null;
    }> = [];

    try {
      integrations = await storage.getAllActiveQuickBooksIntegrations();
    } catch (e) {
      req.log?.error?.({ err: e }, "[QB probe] Failed to fetch active integrations");
      res.status(500).json({ error: "failed to fetch integrations" });
      return;
    }

    const idleThresholdMs = QB_IDLE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    let checked = 0;
    let refreshed = 0;
    const reconnectRequired: string[] = [];

    for (const integ of integrations) {
      if (integ.connectionStatus === "reconnect_required") {
        reconnectRequired.push(integ.realmId);
        continue;
      }

      checked++;

      const msUntilExpiry = integ.expiresAt.getTime() - Date.now();
      const isNearExpiry = msUntilExpiry <= QB_PROACTIVE_REFRESH_BUFFER_MS;

      const lastSuccessMs = integ.lastRefreshSuccess ? integ.lastRefreshSuccess.getTime() : 0;
      const idleMs = Date.now() - lastSuccessMs;
      const isApproachingIdleThreshold = idleMs >= idleThresholdMs;

      if (!isNearExpiry && !isApproachingIdleThreshold) {
        req.log?.info?.({ realmId: integ.realmId }, "[QB probe] realm healthy — skipping");
        continue;
      }

      const effectiveBufferMs = isApproachingIdleThreshold
        ? Math.max(QB_PROACTIVE_REFRESH_BUFFER_MS, msUntilExpiry + 1)
        : QB_PROACTIVE_REFRESH_BUFFER_MS;

      const result = await runProactiveRefreshForRealm(
        integ.realmId,
        refreshFn,
        store,
        effectiveBufferMs,
      );

      if (result.refreshed) {
        refreshed++;
        req.log?.info?.({ realmId: integ.realmId }, "[QB probe] refreshed successfully");
      } else if (result.isUnrecoverable) {
        reconnectRequired.push(integ.realmId);
        req.log?.warn?.(
          { realmId: integ.realmId, err: result.error },
          "[QB probe] unrecoverable error — reconnect required",
        );
      } else if (result.skipped) {
        req.log?.info?.(
          { realmId: integ.realmId, skipReason: result.skipReason },
          "[QB probe] skipped",
        );
      }
    }

    res.json({ checked, refreshed, reconnect_required: reconnectRequired });
  });
}
