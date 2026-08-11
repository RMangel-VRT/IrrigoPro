import { logger } from './lib/logger';

export type QbRefreshFailureCategory =
  | 'transient'
  | 'stale_refresh_token'
  | 'revoked'
  | 'reconnect_required';

export class QbRefreshError extends Error {
  category: QbRefreshFailureCategory;
  constructor(message: string, category: QbRefreshFailureCategory) {
    super(message);
    this.name = 'QbRefreshError';
    this.category = category;
  }
}

export function classifyQbRefreshError(errorText: string, httpStatus: number): QbRefreshFailureCategory {
  let errorCode = '';
  try {
    const parsed = JSON.parse(errorText);
    errorCode = (parsed.error || parsed.error_code || '').toLowerCase();
  } catch {
    errorCode = errorText.toLowerCase();
  }

  if (errorCode === 'invalid_grant' || errorCode === 'invalid_refresh_token') {
    return 'stale_refresh_token';
  }
  if (errorCode === 'access_denied' || errorCode === 'authorization_revoked' || errorCode === 'revoked_token') {
    return 'revoked';
  }
  if (httpStatus >= 500 || errorCode === 'server_error' || errorCode === 'temporarily_unavailable') {
    return 'transient';
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return 'reconnect_required';
  }
  return 'transient';
}

export const QB_REFRESH_TIMEOUT_MS = 30_000;
export const QB_PROACTIVE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const UNRECOVERABLE_CATEGORIES = new Set<QbRefreshFailureCategory>([
  'stale_refresh_token',
  'revoked',
  'reconnect_required',
]);

interface QbLockEntry {
  promise: Promise<string>;
  generation: number;
  controller: AbortController;
}

export const qbRefreshLock = new Map<string, QbLockEntry>();
let qbLockGeneration = 0;

export async function withQbRefreshLock(
  realmId: string,
  doRefresh: (signal: AbortSignal) => Promise<string>,
  timeoutMs: number = QB_REFRESH_TIMEOUT_MS
): Promise<string> {
  const existing = qbRefreshLock.get(realmId);
  if (existing) {
    return Promise.race([
      existing.promise,
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`QB refresh lock wait-timeout for realmId=${realmId}`)),
          timeoutMs
        )
      ),
    ]);
  }

  const generation = ++qbLockGeneration;
  const controller = new AbortController();

  const underlyingPromise = doRefresh(controller.signal).finally(() => {
    const current = qbRefreshLock.get(realmId);
    if (current && current.generation === generation) {
      qbRefreshLock.delete(realmId);
    }
  });

  const entry: QbLockEntry = { promise: underlyingPromise, generation, controller };
  qbRefreshLock.set(realmId, entry);

  return Promise.race([
    underlyingPromise,
    new Promise<string>((_, reject) => {
      setTimeout(() => {
        controller.abort();
        const current = qbRefreshLock.get(realmId);
        if (current && current.generation === generation) {
          qbRefreshLock.delete(realmId);
        }
        reject(new Error(`QB refresh lock timeout for realmId=${realmId}`));
      }, timeoutMs);
    }),
  ]);
}

export function buildReconnectReason(category: QbRefreshFailureCategory): string {
  const reasonMap: Record<QbRefreshFailureCategory, string> = {
    stale_refresh_token: 'Refresh token expired (invalid_grant). Please reauthorize QuickBooks.',
    revoked: 'QuickBooks authorization was revoked. Please reconnect.',
    reconnect_required: 'QuickBooks token could not be refreshed. Please reauthorize.',
    transient: '',
  };
  return reasonMap[category];
}

export interface QbStorageAdapter {
  getIntegration(realmId: string): Promise<{
    companyId: string;
    accessToken: string;
    refreshToken: string;
    realmId: string;
    expiresAt: Date;
    connectionStatus: string;
    reconnectRequiredReason: string | null;
  } | null>;
  saveIntegration(data: {
    companyId: string;
    accessToken: string;
    refreshToken: string;
    realmId: string;
    expiresAt: Date;
    lastRefreshAttempt?: Date | null;
    lastRefreshSuccess?: Date | null;
    connectionStatus?: string;
  }): Promise<void>;
  markReconnectRequired(realmId: string, reason: string): Promise<void>;
}

export interface QbTokenPair {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export type QbRefreshFn = (refreshToken: string, signal: AbortSignal) => Promise<QbTokenPair>;

export interface ProactiveRefreshResult {
  skipped: boolean;
  skipReason?: 'reconnect_required' | 'not_near_expiry' | 'no_integration';
  refreshed?: boolean;
  newAccessToken?: string;
  error?: Error;
  isUnrecoverable?: boolean;
}

/**
 * Proactive refresh: if the realm's token is within the 5-minute expiry buffer, refresh it.
 *
 * This function encapsulates the proactive refresh logic used by makeQuickBooksRequest
 * and the background health job. It is fully testable via the QbStorageAdapter interface.
 *
 * @param realmId   QuickBooks realm ID
 * @param doRefresh Injected Intuit token refresh call (real or mock)
 * @param store     Injected storage adapter (real DatabaseStorage or mock)
 * @param bufferMs  Override refresh buffer (default: QB_PROACTIVE_REFRESH_BUFFER_MS)
 */
export async function runProactiveRefreshForRealm(
  realmId: string,
  doRefresh: QbRefreshFn,
  store: QbStorageAdapter,
  bufferMs: number = QB_PROACTIVE_REFRESH_BUFFER_MS
): Promise<ProactiveRefreshResult> {
  const integration = await store.getIntegration(realmId);

  if (!integration) {
    return { skipped: true, skipReason: 'no_integration' };
  }
  if (integration.connectionStatus === 'reconnect_required') {
    return { skipped: true, skipReason: 'reconnect_required' };
  }

  const msUntilExpiry = integration.expiresAt.getTime() - Date.now();
  if (msUntilExpiry > bufferMs) {
    return { skipped: true, skipReason: 'not_near_expiry' };
  }

  try {
    const newAccessToken = await withQbRefreshLock(realmId, async (signal) => {
      const fresh = await store.getIntegration(realmId);
      if (!fresh) {
        throw new Error(`[QB proactive refresh] Integration for realmId=${realmId} not found`);
      }
      if (fresh.connectionStatus === 'reconnect_required') {
        throw new QbRefreshError(
          `Connection already marked as reconnect_required for realmId=${realmId}`,
          'reconnect_required'
        );
      }
      const tokenPair = await doRefresh(fresh.refreshToken, signal);
      const expiresInSeconds = tokenPair.expires_in && tokenPair.expires_in > 0 ? tokenPair.expires_in : 3600;
      const now = new Date();
      await store.saveIntegration({
        companyId: fresh.companyId,
        accessToken: tokenPair.access_token,
        refreshToken: tokenPair.refresh_token || fresh.refreshToken,
        realmId,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
        lastRefreshAttempt: now,
        lastRefreshSuccess: now,
      });
      return tokenPair.access_token;
    });
    return { skipped: false, refreshed: true, newAccessToken };
  } catch (err) {
    const isUnrecoverable = err instanceof QbRefreshError
      ? UNRECOVERABLE_CATEGORIES.has(err.category)
      : false;
    if (isUnrecoverable && err instanceof QbRefreshError) {
      const reason = buildReconnectReason(err.category);
      await store.markReconnectRequired(realmId, reason).catch(() => {});
    }
    return { skipped: false, refreshed: false, error: err as Error, isUnrecoverable };
  }
}

/**
 * Number of days of inactivity after which the health job proactively refreshes
 * the token regardless of expiry. Intuit silently revokes refresh tokens after
 * 100 days of non-use. We act at 90 days to leave a safety margin.
 */
export const QB_IDLE_THRESHOLD_DAYS = 90;

/**
 * Task #1911 — outcome of the most recent health sweep.
 *
 * `getAllActiveQuickBooksIntegrations` used to swallow database errors and
 * return `[]`, so a failed load looked exactly like "there are no connected
 * realms": the job iterated nothing, logged nothing at error level, and
 * finished as if all was well while tokens marched toward expiry. The storage
 * method now throws, and the sweep records what actually happened so an
 * operator (and a test) can tell a clean sweep from a skipped one.
 */
export type QbHealthSweepStatus = 'completed' | 'skipped_load_failed';

export interface QbHealthSweepRecord {
  status: QbHealthSweepStatus;
  ranAt: Date;
  /** Realms examined. Always 0 when the load failed. */
  checked: number;
  /** Realms actually refreshed during the sweep. */
  refreshed: number;
  /** Present only when status is 'skipped_load_failed'. */
  error?: string;
}

let lastQbHealthSweep: QbHealthSweepRecord | null = null;

/** Most recent sweep outcome, or null if no sweep has finished yet. */
export function getLastQbHealthSweep(): QbHealthSweepRecord | null {
  return lastQbHealthSweep;
}

/** Test seam — clears the recorded sweep outcome. */
export function resetLastQbHealthSweep(): void {
  lastQbHealthSweep = null;
}

/**
 * QB Token Health Job
 *
 * Runs immediately and then on the configured interval (default: 24 hours).
 * For every connected realm, refreshes if either condition is true:
 *   1. Token is within the 5-minute expiry buffer (proactive expiry refresh), OR
 *   2. lastRefreshSuccess is older than QB_IDLE_THRESHOLD_DAYS (90 days),
 *      even if the access token itself has a valid far-future expiry.
 *      This prevents the 100-day refresh-token revocation by Intuit.
 *
 * Both conditions use runProactiveRefreshForRealm (shared with makeQuickBooksRequest).
 * For condition 2, a custom bufferMs of (token expiry + 1 day) forces the refresh
 * regardless of real token expiry.
 *
 * @param getAllActiveIntegrations Returns all connected (non-reconnect_required) QB realms
 * @param doRefresh               Injected Intuit token refresh call (real or mock)
 * @param store                   Injected storage adapter
 * @param intervalMs              Polling interval (default: 24 hours)
 * @returns NodeJS.Timeout handle — call clearInterval to stop
 */
export function startQbTokenHealthJob(
  getAllActiveIntegrations: () => Promise<Array<{
    realmId: string;
    connectionStatus: string;
    expiresAt: Date;
    lastRefreshSuccess: Date | null;
  }>>,
  doRefresh: QbRefreshFn,
  store: QbStorageAdapter,
  intervalMs: number = 24 * 60 * 60 * 1000
): ReturnType<typeof setInterval> {
  const idleThresholdMs = QB_IDLE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  const runHealthSweep = async () => {
    let integrations: Array<{
      realmId: string;
      connectionStatus: string;
      expiresAt: Date;
      lastRefreshSuccess: Date | null;
    }> = [];
    try {
      integrations = await getAllActiveIntegrations();
    } catch (e) {
      // Task #1911 — a failed load is not an empty sweep. Log at error level
      // through the structured logger and record the run as skipped so nothing
      // downstream (or nobody on call) reads this as "checked everything, all
      // healthy".
      lastQbHealthSweep = {
        status: 'skipped_load_failed',
        ranAt: new Date(),
        checked: 0,
        refreshed: 0,
        error: e instanceof Error ? e.message : String(e),
      };
      logger.error(
        { err: e },
        '[QB health job] Failed to load active integrations — sweep skipped, no realms checked',
      );
      return;
    }

    let checked = 0;
    let refreshedCount = 0;

    for (const integ of integrations) {
      if (integ.connectionStatus === 'reconnect_required') continue;

      checked++;

      const msUntilExpiry = integ.expiresAt.getTime() - Date.now();
      const isNearExpiry = msUntilExpiry <= QB_PROACTIVE_REFRESH_BUFFER_MS;

      const lastSuccessMs = integ.lastRefreshSuccess ? integ.lastRefreshSuccess.getTime() : 0;
      const idleMs = Date.now() - lastSuccessMs;
      const isApproachingIdleThreshold = idleMs >= idleThresholdMs;

      if (!isNearExpiry && !isApproachingIdleThreshold) {
        console.log(`[QB health job] realmId=${integ.realmId}: healthy (expires in ${Math.round(msUntilExpiry / 60000)}min, idle ${Math.round(idleMs / 86400000)}d) — skipping`);
        continue;
      }

      const reason = isApproachingIdleThreshold && !isNearExpiry
        ? `idle ${Math.round(idleMs / 86400000)}d >= ${QB_IDLE_THRESHOLD_DAYS}d threshold`
        : `expires in ${Math.round(msUntilExpiry / 1000)}s`;
      console.log(`[QB health job] Proactively refreshing realmId=${integ.realmId} (${reason})`);

      // For idle-threshold cases: force a refresh by passing a bufferMs that is
      // guaranteed to exceed the token's remaining time (even if the token is valid).
      // This is safe because runProactiveRefreshForRealm re-reads fresh state inside
      // the lock and only calls Intuit once per realm even under concurrent callers.
      const effectiveBufferMs = isApproachingIdleThreshold
        ? Math.max(QB_PROACTIVE_REFRESH_BUFFER_MS, msUntilExpiry + 1)
        : QB_PROACTIVE_REFRESH_BUFFER_MS;

      const result = await runProactiveRefreshForRealm(integ.realmId, doRefresh, store, effectiveBufferMs);
      if (result.refreshed) {
        refreshedCount++;
        console.log(`[QB health job] Refreshed realmId=${integ.realmId} successfully`);
      } else if (result.isUnrecoverable) {
        logger.warn(
          { realmId: integ.realmId, err: result.error },
          '[QB health job] Unrecoverable refresh error — reconnect required',
        );
      } else if (result.skipped) {
        console.log(`[QB health job] realmId=${integ.realmId} skipped (${result.skipReason})`);
      }
    }

    lastQbHealthSweep = {
      status: 'completed',
      ranAt: new Date(),
      checked,
      refreshed: refreshedCount,
    };
  };

  runHealthSweep().catch((e) => logger.error({ err: e }, '[QB health job] Initial sweep error'));
  return setInterval(() => {
    runHealthSweep().catch((e) => logger.error({ err: e }, '[QB health job] Sweep error'));
  }, intervalMs);
}
