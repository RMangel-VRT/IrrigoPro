// Task #1831 — QBO Payment-Status Sync
//
// Reads `Balance` from QuickBooks for each QBO-linked, non-terminal,
// non-already-paid invoice belonging to a company and stamps local rows
// with a 3-tier payment status:
//
//   Balance == 0            → paid          (also sets status='paid', paidAt)
//   0 < Balance < TotalAmt  → partially_paid
//   Balance == TotalAmt     → unpaid
//
// Sync is read-only — no SyncToken is used and nothing is written to QBO.
//
// The endpoint `POST /api/invoices/sync-payment-status` is throttled
// in-memory per company so the invoice-list UI can call it on load
// without hammering QBO on every mount.

import type { Express, RequestHandler } from "express";
import { db as dbModule } from "../db";
import { invoices } from "@workspace/db/schema";
import { eq, and, isNotNull, notInArray, sql } from "drizzle-orm";
import type { QbMakeRequestFn } from "./qb-invoice-ops";
import { logger } from "../lib/logger";

// ── Types ──────────────────────────────────────────────────────────────────

export type PaymentStatus = "unpaid" | "partially_paid" | "paid";

export interface PaymentSyncSummary {
  companyId: string;
  invoicesChecked: number;
  paid: number;
  partiallyPaid: number;
  /** Invoices whose QBO balance still equals their total (no payment recorded). */
  unpaid: number;
  /** Invoices detected as voided in QBO this sync run. */
  qbVoided: number;
  skippedNoQb: boolean;
  syncedAt: string;
}

// ── Balance → status mapping (pure, exported for tests) ───────────────────

export function derivePaymentStatus(
  balance: number,
  totalAmt: number,
): PaymentStatus {
  // Task #1848 — guard $0 invoices (e.g. fully-covered membership work, OR
  // QBO-voided invoices) before the balance-zero "paid" check so we never
  // auto-stamp a voided invoice as paid.
  if (totalAmt <= 0) return "unpaid";
  if (balance <= 0) return "paid";
  if (balance < totalAmt) return "partially_paid";
  return "unpaid";
}

// ── In-memory per-company throttle (DB-backed for restart durability) ────────

// Minimum milliseconds between sync runs per company.
const SYNC_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

// app_settings key prefix for persisted last-run timestamps.
const SYNC_SETTING_PREFIX = "qbPaymentSync.lastRun.";

interface SyncRecord {
  lastRun: number; // epoch ms
}

const lastSyncByCompany = new Map<string, number>();

export function isThrottled(companyId: string): boolean {
  const last = lastSyncByCompany.get(companyId);
  if (!last) return false;
  return Date.now() - last < SYNC_THROTTLE_MS;
}

export function getLastSyncMs(companyId: string): number | undefined {
  return lastSyncByCompany.get(companyId);
}

// Persist last-run timestamp to app_settings (fire-and-forget).
// Uses an injectable db for testability.
async function persistSyncTime(companyId: string, db: any): Promise<void> {
  const key = SYNC_SETTING_PREFIX + companyId;
  const value: SyncRecord = { lastRun: Date.now() };
  try {
    await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
  } catch (err) {
    logger.warn({ err, companyId }, "[qb-payment-sync] Failed to persist sync time to app_settings");
  }
}

export function recordSyncTime(companyId: string, db?: any): void {
  lastSyncByCompany.set(companyId, Date.now());
  void persistSyncTime(companyId, db ?? dbModule);
}

// Hydrate the in-memory map from app_settings on startup.
// Only loads entries where lastRun is within the throttle window so stale
// entries from long-ago runs do not block a sync after a long-dormant restart.
export async function hydrateSyncThrottleFromDb(db?: any): Promise<void> {
  const dbInstance = db ?? dbModule;
  try {
    const result = await dbInstance.execute(sql`
      SELECT key, value FROM app_settings WHERE key LIKE ${SYNC_SETTING_PREFIX + "%"}
    `);
    const cutoff = Date.now() - SYNC_THROTTLE_MS;
    for (const row of (result.rows ?? []) as Array<{ key: string; value: string }>) {
      const companyId = row.key.slice(SYNC_SETTING_PREFIX.length);
      if (!companyId) continue;
      try {
        const record = JSON.parse(row.value) as SyncRecord;
        if (typeof record.lastRun === "number" && record.lastRun > cutoff) {
          lastSyncByCompany.set(companyId, record.lastRun);
        }
      } catch {
        // Ignore malformed entries
      }
    }
    logger.info({ loaded: lastSyncByCompany.size }, "[qb-payment-sync] Hydrated sync throttle from DB");
  } catch (err) {
    logger.warn({ err }, "[qb-payment-sync] Failed to hydrate sync throttle from app_settings; starting cold");
  }
}

// Exposed for tests to reset throttle state
export function resetThrottleForTesting(companyId?: string): void {
  if (companyId) {
    lastSyncByCompany.delete(companyId);
  } else {
    lastSyncByCompany.clear();
  }
}

// ── Per-company in-flight guard ─────────────────────────────────────────────
// Prevents two near-simultaneous requests for the same company from each
// issuing a full QBO batch query. The second caller reuses the first caller's
// Promise and receives an identical summary at no extra QBO cost.

const inFlightByCompany = new Map<string, Promise<PaymentSyncSummary>>();

export function resetInFlightForTesting(): void {
  inFlightByCompany.clear();
}

// ── Terminal statuses — excluded from sync ─────────────────────────────────

const SYNC_EXCLUDED_STATUSES = ["cancelled", "superseded", "merged", "failed", "draft"];

// ── QBO batch query helper ─────────────────────────────────────────────────

interface QbInvoiceBalance {
  Id: string;
  Balance: number;
  TotalAmt: number;
  /** Raw PrivateNote from QBO; contains the word "Voided" when the invoice was voided in QB. */
  PrivateNote?: string;
}

// Sentinel error class so syncPaymentStatusForCompany can distinguish
// expired/revoked QBO tokens (401) from genuine network/API failures.
// Caught in the orchestrator to return a graceful skip summary instead of 502.
class QbAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "QbAuthError";
  }
}

async function fetchQbBalances(
  makeRequest: QbMakeRequestFn,
  apiBase: string,
  integration: { realmId: string; accessToken: string },
  qbIds: string[],
): Promise<QbInvoiceBalance[]> {
  const BATCH = 50;
  const results: QbInvoiceBalance[] = [];

  for (let i = 0; i < qbIds.length; i += BATCH) {
    const chunk = qbIds.slice(i, i + BATCH);
    const idList = chunk.map((id) => `'${id}'`).join(", ");
    const qlStr = `SELECT Id, Balance, TotalAmt, PrivateNote FROM Invoice WHERE Id IN (${idList})`;
    const query = encodeURIComponent(qlStr);

    const resp = await makeRequest(
      `${apiBase}/v3/company/${integration.realmId}/query?query=${query}&minorversion=73`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${integration.accessToken}`,
          Accept: "application/json",
        },
      },
      "QBO Balance query",
      integration.realmId,
    );

    if (resp.status === 401) {
      throw new QbAuthError("QBO token expired or revoked (401) during balance query");
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`QBO balance query failed: ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      QueryResponse?: { Invoice?: Array<{ Id?: string; Balance?: number; TotalAmt?: number; PrivateNote?: string }> };
    };
    const items = data?.QueryResponse?.Invoice ?? [];
    for (const item of items) {
      if (item.Id != null) {
        results.push({
          Id: item.Id,
          Balance: typeof item.Balance === "number" ? item.Balance : parseFloat(String(item.Balance ?? 0)),
          TotalAmt: typeof item.TotalAmt === "number" ? item.TotalAmt : parseFloat(String(item.TotalAmt ?? 0)),
          PrivateNote: item.PrivateNote,
        });
      }
    }
  }

  return results;
}

// ── Core sync function ─────────────────────────────────────────────────────

export interface SyncPaymentStatusDeps {
  makeRequest: QbMakeRequestFn;
  getQbIntegration: (companyId: string) => Promise<{
    realmId: string;
    accessToken: string;
    connectionStatus?: string | null;
  } | null>;
  apiBase: string;
  // Test injection
  _db?: any;
}

export async function syncPaymentStatusForCompany(
  companyId: string,
  deps: SyncPaymentStatusDeps,
): Promise<PaymentSyncSummary> {
  // Task #1848 — concurrent sync guard: if a sync is already in flight for
  // this company, return the same promise so only one QBO batch query fires.
  const existing = inFlightByCompany.get(companyId);
  if (existing) return existing;

  const promise = _syncImpl(companyId, deps);
  inFlightByCompany.set(companyId, promise);
  return promise.finally(() => {
    inFlightByCompany.delete(companyId);
  });
}

async function _syncImpl(
  companyId: string,
  deps: SyncPaymentStatusDeps,
): Promise<PaymentSyncSummary> {
  const db: any = deps._db ?? dbModule;
  const companyIdNum = parseInt(companyId, 10);

  const summary: PaymentSyncSummary = {
    companyId,
    invoicesChecked: 0,
    paid: 0,
    partiallyPaid: 0,
    unpaid: 0,
    qbVoided: 0,
    skippedNoQb: false,
    syncedAt: new Date().toISOString(),
  };

  // Fetch QBO integration for the company
  let integration: { realmId: string; accessToken: string } | null = null;
  try {
    const raw = await deps.getQbIntegration(companyId);
    if (!raw || raw.connectionStatus === "reconnect_required") {
      summary.skippedNoQb = true;
      logger.warn({ companyId }, "[qb-payment-sync] No valid QBO connection; skipping sync");
      // Task #1848 — stamp throttle even on skip so repeated mounts within
      // the window don't re-run the integration lookup.
      recordSyncTime(companyId, db);
      return summary;
    }
    integration = { realmId: raw.realmId, accessToken: raw.accessToken };
  } catch (err) {
    logger.warn({ err, companyId }, "[qb-payment-sync] Failed to look up QBO integration; skipping");
    summary.skippedNoQb = true;
    // Task #1848 — stamp throttle on error-skip too.
    recordSyncTime(companyId, db);
    return summary;
  }

  // Load local invoices that are QBO-linked and not terminal/already-paid
  const candidateRows = await db
    .select({
      id: invoices.id,
      quickbooksInvoiceId: invoices.quickbooksInvoiceId,
      totalAmount: invoices.totalAmount,
      paymentStatus: invoices.paymentStatus,
      status: invoices.status,
      qbVoidDetectedAt: invoices.qbVoidDetectedAt,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, companyIdNum),
        isNotNull(invoices.quickbooksInvoiceId),
        notInArray(invoices.status, SYNC_EXCLUDED_STATUSES),
      ),
    );

  // Filter out already-paid (status === 'paid') — out of scope per task
  const candidates = candidateRows.filter(
    (r: any) => r.status !== "paid" && r.paymentStatus !== "paid",
  );

  summary.invoicesChecked = candidates.length;

  if (candidates.length === 0) {
    recordSyncTime(companyId, db);
    return summary;
  }

  // Fetch balances from QBO
  const qbIds = candidates.map((r: any) => String(r.quickbooksInvoiceId));
  let balances: QbInvoiceBalance[];
  try {
    balances = await fetchQbBalances(deps.makeRequest, deps.apiBase, integration, qbIds);
  } catch (err) {
    if (err instanceof QbAuthError) {
      // Expired or revoked token — treat as if no QB connection (safe skip, not a server error).
      logger.warn({ companyId }, "[qb-payment-sync] QBO token expired/revoked; skipping sync gracefully");
      summary.skippedNoQb = true;
      return summary;
    }
    logger.warn({ err, companyId }, "[qb-payment-sync] QBO balance fetch failed; aborting sync");
    throw err;
  }

  const balanceByQbId = new Map(balances.map((b) => [b.Id, b]));
  const now = new Date();

  // Update each candidate
  for (const row of candidates) {
    const qbId = String(row.quickbooksInvoiceId);
    const qbData = balanceByQbId.get(qbId);
    if (!qbData) continue; // QBO doesn't know this invoice (void, etc.) — skip

    // Task #1848 — detect QBO-voided invoices: TotalAmt=0 AND PrivateNote
    // contains the word "Voided" (case-insensitive). This is the marker QBO
    // writes when an invoice is voided in the QB UI.
    const isQbVoided =
      qbData.TotalAmt === 0 &&
      typeof qbData.PrivateNote === "string" &&
      qbData.PrivateNote.toLowerCase().includes("voided");

    if (isQbVoided) {
      // Surface for human review: stamp the detection timestamp on first
      // detection; do NOT change status or paymentStatus so the invoice stays
      // in AR and remains editable. Managers see a warning badge instead.
      const voidUpdates: Record<string, unknown> = {
        qbVoidDetectedAt: row.qbVoidDetectedAt ? row.qbVoidDetectedAt : now,
        paymentSyncedAt: now,
      };
      await db.update(invoices).set(voidUpdates).where(eq(invoices.id, row.id));
      summary.qbVoided++;
      continue;
    }

    // Clear the void flag if a later sync shows the invoice is no longer voided.
    const voidClearUpdate: Record<string, unknown> = {};
    if (row.qbVoidDetectedAt) {
      voidClearUpdate.qbVoidDetectedAt = null;
    }

    // Use QBO's own TotalAmt (not local totalAmount) to avoid misclassification
    // when local totals drift from QBO (e.g. after corrections or manual edits in QBO).
    const newStatus = derivePaymentStatus(qbData.Balance, qbData.TotalAmt);

    const updates: Record<string, unknown> = {
      ...voidClearUpdate,
      paymentStatus: newStatus,
      balance: qbData.Balance.toFixed(2),
      paymentSyncedAt: now,
    };

    if (newStatus === "paid") {
      updates.status = "paid";
      updates.paidAt = now;
      summary.paid++;
    } else if (newStatus === "partially_paid") {
      summary.partiallyPaid++;
    } else {
      summary.unpaid++;
    }

    await db
      .update(invoices)
      .set(updates)
      .where(eq(invoices.id, row.id));
  }

  recordSyncTime(companyId, db);
  return summary;
}

// ── Overdue derivation ─────────────────────────────────────────────────────
//
// Task #1890 — these two used to be defined here, with the payment-terms table
// inline. They now live in `@workspace/shared` alongside the aging bucket
// classifier so the API server and the web app share one copy of the rule.
// Re-exported under the original names because callers (and this module's own
// test file) import them from here.
export {
  computeEffectiveDueDate,
  isInvoiceOverdue,
  PAYMENT_TERMS_DAYS,
} from "@workspace/shared";

// ── Route registration ─────────────────────────────────────────────────────

export interface RegisterQbPaymentSyncRoutesDeps {
  requireAuthentication: RequestHandler;
  /**
   * Task #1942: re-gated from CAN_EDIT_INVOICES to CAN_MANAGE_QUICKBOOKS.
   *
   * The write this endpoint performs is not authoring an invoice — it copies
   * QuickBooks' own payment state back onto rows it owns. Whoever owns the
   * QuickBooks connection is exactly who should be able to refresh it, and
   * that includes the bookkeeper, whose page this is. Membership only widens:
   * CAN_EDIT_INVOICES is a strict subset of CAN_MANAGE_QUICKBOOKS, so no
   * caller who could sync before loses the ability.
   */
  requireQuickBooksAccess: RequestHandler;
  makeRequest: QbMakeRequestFn;
  getQbIntegration: (companyId: string) => Promise<{
    realmId: string;
    accessToken: string;
    connectionStatus?: string | null;
  } | null>;
  apiBase: string;
}

export function registerQbPaymentSyncRoutes(
  app: Express,
  deps: RegisterQbPaymentSyncRoutesDeps,
): void {
  const { requireAuthentication, requireQuickBooksAccess, makeRequest, getQbIntegration, apiBase } = deps;

  // Hydrate the in-memory throttle map from app_settings on startup so that
  // a server restart doesn't let every company trigger a full QBO batch query
  // simultaneously on the first post-deploy request.
  void hydrateSyncThrottleFromDb();

  // POST /api/invoices/sync-payment-status
  // Reads Balance from QBO for all active QBO-linked invoices in the caller's
  // company and stamps payment_status / balance / payment_synced_at.
  // Throttled to at most once per 5 minutes per company to protect QBO quota.
  app.post(
    "/api/invoices/sync-payment-status",
    requireAuthentication,
    requireQuickBooksAccess,
    async (req: any, res) => {
      try {
        const role: string | undefined = req.authenticatedUserRole;
        const companyId: string | null =
          role === "super_admin"
            ? (req.body?.companyId ? String(req.body.companyId) : null)
            : String(req.authenticatedUserCompanyId ?? "");

        if (!companyId) {
          res.status(400).json({ message: "companyId is required for super_admin callers" });
          return;
        }

        // Check throttle (bypassed when force=true is sent by super_admin)
        const force = role === "super_admin" && req.body?.force === true;
        if (!force && isThrottled(companyId)) {
          const lastMs = getLastSyncMs(companyId) ?? 0;
          res.json({
            throttled: true,
            nextAllowedIn: Math.ceil((lastMs + SYNC_THROTTLE_MS - Date.now()) / 1000),
            message: "Payment status was recently synced. Try again in a few minutes.",
          });
          return;
        }

        const summary = await syncPaymentStatusForCompany(companyId, {
          makeRequest,
          getQbIntegration,
          apiBase,
        });

        res.json({ ok: true, ...summary });
      } catch (err: any) {
        logger.warn({ err }, "[qb-payment-sync] sync-payment-status endpoint error");
        res.status(502).json({
          message: err?.message ?? "QBO payment sync failed",
          ok: false,
        });
      }
    },
  );
}
