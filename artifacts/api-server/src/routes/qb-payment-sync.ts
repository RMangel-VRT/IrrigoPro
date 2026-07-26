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
import { eq, and, isNotNull, notInArray } from "drizzle-orm";
import type { QbMakeRequestFn } from "./qb-invoice-ops";
import { logger } from "../lib/logger";

// ── Types ──────────────────────────────────────────────────────────────────

export type PaymentStatus = "unpaid" | "partially_paid" | "paid";

export interface PaymentSyncSummary {
  companyId: string;
  invoicesChecked: number;
  paid: number;
  partiallyPaid: number;
  unchanged: number;
  skippedNoQb: boolean;
  syncedAt: string;
}

// ── Balance → status mapping (pure, exported for tests) ───────────────────

export function derivePaymentStatus(
  balance: number,
  totalAmt: number,
): PaymentStatus {
  if (balance <= 0) return "paid";
  if (totalAmt > 0 && balance < totalAmt) return "partially_paid";
  return "unpaid";
}

// ── In-memory per-company throttle ────────────────────────────────────────

// Minimum milliseconds between sync runs per company.
const SYNC_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

const lastSyncByCompany = new Map<string, number>();

export function isThrottled(companyId: string): boolean {
  const last = lastSyncByCompany.get(companyId);
  if (!last) return false;
  return Date.now() - last < SYNC_THROTTLE_MS;
}

export function recordSyncTime(companyId: string): void {
  lastSyncByCompany.set(companyId, Date.now());
}

// Exposed for tests to reset throttle state
export function resetThrottleForTesting(companyId?: string): void {
  if (companyId) {
    lastSyncByCompany.delete(companyId);
  } else {
    lastSyncByCompany.clear();
  }
}

// ── Terminal statuses — excluded from sync ─────────────────────────────────

const SYNC_EXCLUDED_STATUSES = ["cancelled", "superseded", "merged", "failed", "draft"];

// ── QBO batch query helper ─────────────────────────────────────────────────

interface QbInvoiceBalance {
  Id: string;
  Balance: number;
  TotalAmt: number;
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
    const qlStr = `SELECT Id, Balance, TotalAmt FROM Invoice WHERE Id IN (${idList})`;
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
      QueryResponse?: { Invoice?: Array<{ Id?: string; Balance?: number; TotalAmt?: number }> };
    };
    const items = data?.QueryResponse?.Invoice ?? [];
    for (const item of items) {
      if (item.Id != null) {
        results.push({
          Id: item.Id,
          Balance: typeof item.Balance === "number" ? item.Balance : parseFloat(String(item.Balance ?? 0)),
          TotalAmt: typeof item.TotalAmt === "number" ? item.TotalAmt : parseFloat(String(item.TotalAmt ?? 0)),
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
  const db: any = deps._db ?? dbModule;
  const companyIdNum = parseInt(companyId, 10);

  const summary: PaymentSyncSummary = {
    companyId,
    invoicesChecked: 0,
    paid: 0,
    partiallyPaid: 0,
    unchanged: 0,
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
      return summary;
    }
    integration = { realmId: raw.realmId, accessToken: raw.accessToken };
  } catch (err) {
    logger.warn({ err, companyId }, "[qb-payment-sync] Failed to look up QBO integration; skipping");
    summary.skippedNoQb = true;
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
    recordSyncTime(companyId);
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

    // Use QBO's own TotalAmt (not local totalAmount) to avoid misclassification
    // when local totals drift from QBO (e.g. after corrections or manual edits in QBO).
    const newStatus = derivePaymentStatus(qbData.Balance, qbData.TotalAmt);

    const updates: Record<string, unknown> = {
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
      summary.unchanged++;
    }

    await db
      .update(invoices)
      .set(updates)
      .where(eq(invoices.id, row.id));
  }

  recordSyncTime(companyId);
  return summary;
}

// ── Overdue derivation (pure, exported for tests) ──────────────────────────

// Payment terms → days until due (fallback)
const PAYMENT_TERMS_DAYS: Record<string, number> = {
  net_30: 30,
  net_15: 15,
  due_on_receipt: 0,
};

export function computeEffectiveDueDate(
  dueDate: Date | string | null | undefined,
  createdAt: Date | string,
  paymentTerms?: string | null,
): Date {
  if (dueDate) {
    const d = dueDate instanceof Date ? dueDate : new Date(dueDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const days = PAYMENT_TERMS_DAYS[paymentTerms ?? "net_30"] ?? 30;
  return new Date(created.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isInvoiceOverdue(
  paymentStatus: string | null | undefined,
  effectiveDueDate: Date,
  now: Date,
): boolean {
  const ps = paymentStatus ?? "unpaid";
  if (ps === "paid") return false;
  return effectiveDueDate < now;
}

// ── Route registration ─────────────────────────────────────────────────────

export interface RegisterQbPaymentSyncRoutesDeps {
  requireAuthentication: RequestHandler;
  requireBillingAccess: RequestHandler;
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
  const { requireAuthentication, requireBillingAccess, makeRequest, getQbIntegration, apiBase } = deps;

  // POST /api/invoices/sync-payment-status
  // Reads Balance from QBO for all active QBO-linked invoices in the caller's
  // company and stamps payment_status / balance / payment_synced_at.
  // Throttled to at most once per 5 minutes per company to protect QBO quota.
  app.post(
    "/api/invoices/sync-payment-status",
    requireAuthentication,
    requireBillingAccess,
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
          const lastMs = lastSyncByCompany.get(companyId) ?? 0;
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
