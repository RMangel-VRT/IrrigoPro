/**
 * Backfill: Repair QBO-voided invoices mis-flagged as paid
 *
 * Task #1848 — Before this fix, `derivePaymentStatus(0, 0)` returned "paid",
 * so invoices voided in QuickBooks (TotalAmt=0, Balance=0) were auto-stamped
 * with `status='paid'` and `paidAt`. This script identifies and reverses
 * those mis-flips, but ONLY for invoices that carry an explicit QBO void
 * signal (PrivateNote contains "Voided") — legitimate $0 invoices (e.g.
 * fully-covered membership work) are NOT touched.
 *
 * Run (dry-run first — strongly recommended):
 *   node --import tsx/esm artifacts/api-server/src/migrations/qb-void-backfill.ts --dry-run
 *   node --import tsx/esm artifacts/api-server/src/migrations/qb-void-backfill.ts
 *
 * Safe to re-run: only touches invoices with status='paid' + a QBO link
 * + TotalAmt=0 + "Voided" in PrivateNote.
 *
 * NOTE: the module exports pure functions for unit testing. `run()` is only
 * invoked when this file is the direct Node.js entrypoint.
 */

import { fileURLToPath } from "node:url";
import { db } from "../db";
import { invoices, quickbooksIntegration } from "@workspace/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger";

const DRY_RUN = process.argv.includes("--dry-run");

const QB_API_BASE =
  process.env.NODE_ENV === "production"
    ? "https://quickbooks.api.intuit.com"
    : (process.env.QB_API_BASE ?? "https://sandbox-quickbooks.api.intuit.com");

// ── Types ────────────────────────────────────────────────────────────────────

interface QbInvoiceBalance {
  Id: string;
  Balance: number;
  TotalAmt: number;
  PrivateNote?: string;
}

export interface RepairResult {
  invoiceId: number;
  invoiceNumber: string;
  companyId: number;
  qbId: string;
  oldStatus: string;
  newStatus: string;
}

// ── Core repair logic (exported for tests — pure, no side effects) ────────────

/**
 * Determines whether a locally-paid invoice should be repaired based on QBO
 * data. Returns `{ shouldRepair: false }` if the invoice should NOT be touched.
 *
 * Key constraint: only repairs when QBO signals an explicit void via
 * `PrivateNote` containing "voided" (case-insensitive). A $0 invoice with
 * no void marker is NOT repaired — it may be a legitimate $0 amount (e.g.
 * fully-covered membership work that was genuinely paid).
 */
export function deriveRepairedState(
  qbData: QbInvoiceBalance,
  localRow: { sentAt?: Date | null },
): { shouldRepair: boolean; newStatus: string } {
  // Guard 1: TotalAmt must be zero (voided invoices always have TotalAmt=0)
  if (qbData.TotalAmt !== 0) {
    return { shouldRepair: false, newStatus: "" };
  }

  // Guard 2: Require the explicit QBO void signal in PrivateNote.
  // Without this guard we'd incorrectly reopen legitimately paid $0 invoices.
  const hasVoidMarker =
    typeof qbData.PrivateNote === "string" &&
    qbData.PrivateNote.toLowerCase().includes("voided");

  if (!hasVoidMarker) {
    return { shouldRepair: false, newStatus: "" };
  }

  // Restore to 'generated' if the invoice was sent to the customer (sentAt
  // is set), else 'draft'. Task #1847 retired status='sent'; delivery is now
  // tracked via sentAt. 'generated' stays in the QBO sync candidate set;
  // 'draft' is the pre-send state for invoices never emailed.
  const newStatus = localRow.sentAt ? "generated" : "draft";
  return { shouldRepair: true, newStatus };
}

// ── QBO fetch helper ─────────────────────────────────────────────────────────

async function fetchQbBalancesForBackfill(
  accessToken: string,
  realmId: string,
  qbIds: string[],
): Promise<QbInvoiceBalance[]> {
  const BATCH = 50;
  const results: QbInvoiceBalance[] = [];

  for (let i = 0; i < qbIds.length; i += BATCH) {
    const chunk = qbIds.slice(i, i + BATCH);
    const idList = chunk.map((id) => `'${id}'`).join(", ");
    const ql = encodeURIComponent(
      `SELECT Id, Balance, TotalAmt, PrivateNote FROM Invoice WHERE Id IN (${idList})`,
    );
    const url = `${QB_API_BASE}/v3/company/${realmId}/query?query=${ql}&minorversion=73`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `QBO query failed: ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`,
      );
    }
    const data = (await resp.json()) as {
      QueryResponse?: {
        Invoice?: Array<{
          Id?: string;
          Balance?: number;
          TotalAmt?: number;
          PrivateNote?: string;
        }>;
      };
    };
    const items = data?.QueryResponse?.Invoice ?? [];
    for (const item of items) {
      if (item.Id != null) {
        results.push({
          Id: item.Id,
          Balance:
            typeof item.Balance === "number"
              ? item.Balance
              : parseFloat(String(item.Balance ?? 0)),
          TotalAmt:
            typeof item.TotalAmt === "number"
              ? item.TotalAmt
              : parseFloat(String(item.TotalAmt ?? 0)),
          PrivateNote: item.PrivateNote,
        });
      }
    }
  }
  return results;
}

// ── Main backfill ─────────────────────────────────────────────────────────────

async function run() {
  logger.info({ dryRun: DRY_RUN }, "[qb-void-backfill] Starting backfill");

  // 1. Find all locally-paid invoices with a QBO link
  const paidRows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      companyId: invoices.companyId,
      quickbooksInvoiceId: invoices.quickbooksInvoiceId,
      sentAt: invoices.sentAt,
      status: invoices.status,
    })
    .from(invoices)
    .where(and(eq(invoices.status, "paid"), isNotNull(invoices.quickbooksInvoiceId)));

  if (paidRows.length === 0) {
    logger.info("[qb-void-backfill] No paid QBO-linked invoices found; nothing to repair.");
    return;
  }

  logger.info(
    { count: paidRows.length },
    "[qb-void-backfill] Found locally-paid QBO-linked invoices to check",
  );

  // Group by companyId so we can batch QBO calls per company
  const byCompany = new Map<number, typeof paidRows>();
  for (const row of paidRows) {
    const arr = byCompany.get(row.companyId) ?? [];
    arr.push(row);
    byCompany.set(row.companyId, arr);
  }

  const repaired: RepairResult[] = [];

  for (const [companyId, rows] of byCompany) {
    // Load QBO integration for this company directly from DB
    const [integration] = await db
      .select({
        realmId: quickbooksIntegration.realmId,
        accessToken: quickbooksIntegration.accessToken,
        connectionStatus: quickbooksIntegration.connectionStatus,
      })
      .from(quickbooksIntegration)
      .where(eq(quickbooksIntegration.companyId, String(companyId)))
      .limit(1);

    if (!integration || integration.connectionStatus === "reconnect_required") {
      logger.info(
        { companyId },
        "[qb-void-backfill] No valid QBO integration for company; skipping",
      );
      continue;
    }

    const qbIds = rows.map((r) => String(r.quickbooksInvoiceId));
    let balances: QbInvoiceBalance[];
    try {
      balances = await fetchQbBalancesForBackfill(
        integration.accessToken,
        integration.realmId,
        qbIds,
      );
    } catch (err) {
      logger.warn(
        { companyId, err },
        "[qb-void-backfill] QBO query failed for company; skipping",
      );
      continue;
    }

    const balanceByQbId = new Map(balances.map((b) => [b.Id, b]));
    const now = new Date();

    for (const row of rows) {
      const qbId = String(row.quickbooksInvoiceId);
      const qbData = balanceByQbId.get(qbId);
      if (!qbData) continue; // No longer in QBO — skip

      const { shouldRepair, newStatus } = deriveRepairedState(qbData, row);
      if (!shouldRepair) continue;

      const repairEntry: RepairResult = {
        invoiceId: row.id,
        invoiceNumber: row.invoiceNumber,
        companyId: row.companyId,
        qbId,
        oldStatus: row.status,
        newStatus,
      };

      logger.info(repairEntry, "[qb-void-backfill] Repairing invoice");

      if (!DRY_RUN) {
        await db
          .update(invoices)
          .set({
            status: newStatus as any,
            paymentStatus: "unpaid",
            paidAt: null,
            qbVoidDetectedAt: now,
          })
          .where(eq(invoices.id, row.id));
      }

      repaired.push(repairEntry);
    }
  }

  logger.info(
    { repaired: repaired.length, dryRun: DRY_RUN },
    "[qb-void-backfill] Backfill complete",
  );

  if (repaired.length > 0) {
    console.table(
      repaired.map((r) => ({
        id: r.invoiceId,
        invoice: r.invoiceNumber,
        company: r.companyId,
        oldStatus: r.oldStatus,
        newStatus: r.newStatus,
      })),
    );
  }

  if (DRY_RUN && repaired.length > 0) {
    console.log(
      "\n⚠️  DRY RUN — no changes were written. Re-run without --dry-run to apply.",
    );
  }
}

// ── Entrypoint guard ──────────────────────────────────────────────────────────
// Only execute `run()` when this file is the direct Node.js entrypoint.
// Importing this module for its exported functions has no side effects.

const isMainModule =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  run().catch((err) => {
    logger.error({ err }, "[qb-void-backfill] Fatal error");
    process.exit(1);
  });
}
