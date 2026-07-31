// Task #1848 — Repair invoices mis-flagged as paid due to a QBO void bug.
//
// Before the fix in this task, `derivePaymentStatus(0, 0)` returned "paid",
// so invoices voided in QuickBooks (TotalAmt=0, Balance=0) were auto-stamped
// with `status='paid'` and `paidAt`. This migration finds and repairs those
// rows by querying QBO to confirm the void signal, then restoring status.
//
// Safety contract:
//   – Only repairs invoices with TotalAmt=0 AND PrivateNote containing
//     "Voided" in QBO — legitimate $0 invoices are not touched.
//   – Restores status to 'generated' (sentAt set) or 'draft' (sentAt null) —
//     Task #1847 retired status='sent'; sentAt tracks delivery. 'generated'
//     stays in the QBO sync candidate set; 'draft' is the pre-send state.
//   – Idempotent: completed rows are excluded by the candidate query
//     (status must still equal 'paid').
//   – Requires acknowledged=true (financial data change).

import { db } from '../../db';
import { invoices, quickbooksIntegration, appSettings } from '@workspace/db/schema';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import type {
  MigrationDefinition,
  MigrationStatus,
  MigrationPreview,
  MigrationStepResult,
  ProgressEmitter,
  MigrationRunOptions,
} from './types';

export const DONE_KEY = 'repairQbVoidMispaid.done';
const MIGRATION_ID = 'repair-qb-void-mispaid-v1';

const QB_API_BASE =
  process.env.NODE_ENV === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : (process.env.QB_API_BASE ?? 'https://sandbox-quickbooks.api.intuit.com');

// ── Types ────────────────────────────────────────────────────────────────────

interface QbInvoiceBalance {
  Id: string;
  Balance: number;
  TotalAmt: number;
  PrivateNote?: string;
}

interface CandidateRow {
  id: number;
  invoiceNumber: string;
  companyId: number;
  quickbooksInvoiceId: string;
  sentAt: Date | null;
}

// ── QBO batch fetch ──────────────────────────────────────────────────────────

async function fetchQbBalances(
  accessToken: string,
  realmId: string,
  qbIds: string[],
): Promise<QbInvoiceBalance[]> {
  const BATCH = 50;
  const results: QbInvoiceBalance[] = [];
  for (let i = 0; i < qbIds.length; i += BATCH) {
    const chunk = qbIds.slice(i, i + BATCH);
    const idList = chunk.map((id) => `'${id}'`).join(', ');
    const ql = encodeURIComponent(
      `SELECT Id, Balance, TotalAmt, PrivateNote FROM Invoice WHERE Id IN (${idList})`,
    );
    const url = `${QB_API_BASE}/v3/company/${realmId}/query?query=${ql}&minorversion=73`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`QBO query failed: ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as {
      QueryResponse?: {
        Invoice?: Array<{ Id?: string; Balance?: number; TotalAmt?: number; PrivateNote?: string }>;
      };
    };
    for (const item of data?.QueryResponse?.Invoice ?? []) {
      if (item.Id != null) {
        results.push({
          Id: item.Id,
          Balance: typeof item.Balance === 'number' ? item.Balance : parseFloat(String(item.Balance ?? 0)),
          TotalAmt: typeof item.TotalAmt === 'number' ? item.TotalAmt : parseFloat(String(item.TotalAmt ?? 0)),
          PrivateNote: item.PrivateNote,
        });
      }
    }
  }
  return results;
}

// ── Candidate query ──────────────────────────────────────────────────────────

async function queryCandidates(): Promise<CandidateRow[]> {
  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      companyId: invoices.companyId,
      quickbooksInvoiceId: invoices.quickbooksInvoiceId,
      sentAt: invoices.sentAt,
    })
    .from(invoices)
    .where(and(eq(invoices.status, 'paid'), isNotNull(invoices.quickbooksInvoiceId)));
  return rows.map((r) => ({
    ...r,
    quickbooksInvoiceId: String(r.quickbooksInvoiceId),
  }));
}

// ── check() ──────────────────────────────────────────────────────────────────

async function check(): Promise<MigrationStatus> {
  const marker = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, DONE_KEY))
    .limit(1);

  const candidates = await queryCandidates();
  if (candidates.length === 0) {
    if (marker.length > 0) {
      return {
        state: 'completed',
        completedAt: String((marker[0] as any).updatedAt ?? marker[0].value ?? ''),
      };
    }
    return { state: 'completed', completedAt: '' };
  }

  if (marker.length > 0) {
    return {
      state: 'partially_applied',
      details: `${candidates.length} locally-paid QBO-linked invoice(s) still need review`,
    };
  }
  return { state: 'not_started' };
}

// ── preview() ────────────────────────────────────────────────────────────────

async function preview(): Promise<MigrationPreview> {
  const candidates = await queryCandidates();
  const warnings: string[] = [];

  if (candidates.length === 0) {
    warnings.push('No locally-paid QBO-linked invoices found — nothing to repair.');
    return { steps: [], orphanRows: { candidatesFound: 0 }, warnings };
  }

  warnings.push(
    `Found ${candidates.length} locally-paid QBO-linked invoice(s). ` +
    'Each will be re-queried against QBO. Only those with TotalAmt=0 AND ' +
    'a QBO void marker in PrivateNote will be repaired.',
  );
  warnings.push(
    'Repaired invoices will have status restored to \'generated\' (sentAt set) or \'draft\', ' +
    'paidAt cleared, and paymentStatus reset to \'unpaid\'. ' +
    'Acknowledge to proceed.',
  );

  const steps = candidates.map((c) => ({
    id: `invoice_${c.id}`,
    description:
      `Invoice #${c.invoiceNumber} (id=${c.id}, company=${c.companyId}, qbId=${c.quickbooksInvoiceId}): ` +
      `re-query QBO → if voided, restore to ${c.sentAt ? '\'generated\'' : '\'draft\''}`,
  }));

  return {
    steps,
    orphanRows: { candidatesFound: candidates.length },
    warnings,
  };
}

// ── Injectable deps (for testing without DB or QBO) ──────────────────────────

export type RepairQbVoidDeps = {
  /** Returns locally-paid QBO-linked invoices to examine. */
  getCandidates(): Promise<CandidateRow[]>;
  /** Returns the QBO integration for a company, or null if none / reconnect required. */
  getIntegration(companyId: number): Promise<{ realmId: string; accessToken: string } | null>;
  /** Fetches QBO balances for a batch of invoice IDs. */
  fetchBalances(accessToken: string, realmId: string, qbIds: string[]): Promise<QbInvoiceBalance[]>;
  /** Applies the repair to a single invoice row. */
  applyRepair(invoiceId: number, newStatus: string, now: Date): Promise<void>;
  /** Marks the migration as complete (idempotent). */
  markDone(): Promise<void>;
};

/** DB-backed deps (production use). */
function createDbDeps(): RepairQbVoidDeps {
  return {
    getCandidates: queryCandidates,

    getIntegration: async (companyId) => {
      const [row] = await db
        .select({
          realmId: quickbooksIntegration.realmId,
          accessToken: quickbooksIntegration.accessToken,
          connectionStatus: quickbooksIntegration.connectionStatus,
        })
        .from(quickbooksIntegration)
        .where(eq(quickbooksIntegration.companyId, String(companyId)))
        .limit(1);
      if (!row || row.connectionStatus === 'reconnect_required') return null;
      return { realmId: row.realmId, accessToken: row.accessToken };
    },

    fetchBalances: fetchQbBalances,

    applyRepair: async (invoiceId, newStatus, now) => {
      await db
        .update(invoices)
        .set({
          status: newStatus as any,
          paymentStatus: 'unpaid',
          paidAt: null,
          qbVoidDetectedAt: now,
        })
        .where(eq(invoices.id, invoiceId));
    },

    markDone: async () => {
      await db
        .insert(appSettings)
        .values({ key: DONE_KEY, value: new Date().toISOString() })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: new Date().toISOString() },
        });
    },
  };
}

// ── Pure runner (deps-injectable, exported for tests) ─────────────────────────

export async function runRepairQbVoid(
  deps: RepairQbVoidDeps,
  emit: ProgressEmitter,
  opts?: MigrationRunOptions,
): Promise<MigrationStepResult[]> {
  if (!opts?.acknowledged) {
    const stepId = 'acknowledge_gate';
    const error =
      'This migration modifies invoice statuses and payment fields. ' +
      'Set acknowledged=true to proceed.';
    emit({ step: stepId, status: 'failed', error });
    return [{ id: stepId, status: 'failed', durationMs: 0, error }];
  }

  const results: MigrationStepResult[] = [];
  const candidates = await deps.getCandidates();

  if (candidates.length === 0) {
    const stepId = 'no_candidates';
    emit({ step: stepId, status: 'skipped' });
    results.push({ id: stepId, status: 'skipped', durationMs: 0 });
    await deps.markDone();
    return results;
  }

  // Group by company for batched QBO queries
  const byCompany = new Map<number, CandidateRow[]>();
  for (const row of candidates) {
    const arr = byCompany.get(row.companyId) ?? [];
    arr.push(row);
    byCompany.set(row.companyId, arr);
  }

  const now = new Date();
  let repaired = 0;
  let errors = 0;

  for (const [companyId, rows] of byCompany) {
    const integration = await deps.getIntegration(companyId);

    if (!integration) {
      for (const row of rows) {
        const stepId = `invoice_${row.id}`;
        emit({ step: stepId, status: 'skipped' });
        results.push({
          id: stepId,
          status: 'skipped',
          durationMs: 0,
          error: `Company ${companyId} has no valid QBO connection`,
        });
      }
      continue;
    }

    let balances: QbInvoiceBalance[];
    try {
      balances = await deps.fetchBalances(
        integration.accessToken,
        integration.realmId,
        rows.map((r) => r.quickbooksInvoiceId),
      );
    } catch (err) {
      for (const row of rows) {
        const stepId = `invoice_${row.id}`;
        const error = `QBO query failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`;
        emit({ step: stepId, status: 'failed', error });
        results.push({ id: stepId, status: 'failed', durationMs: 0, error });
        errors++;
      }
      continue;
    }

    const balanceByQbId = new Map(balances.map((b) => [b.Id, b]));

    for (const row of rows) {
      const stepId = `invoice_${row.id}`;
      const t0 = Date.now();
      emit({ step: stepId, status: 'running' });

      const qbData = balanceByQbId.get(row.quickbooksInvoiceId);
      if (!qbData) {
        emit({ step: stepId, status: 'skipped' });
        results.push({ id: stepId, status: 'skipped', durationMs: Date.now() - t0 });
        continue;
      }

      // Must have TotalAmt=0 AND explicit void marker — both guards required.
      // Legitimate $0 invoices without the marker are NOT touched.
      if (qbData.TotalAmt !== 0) {
        emit({ step: stepId, status: 'skipped' });
        results.push({ id: stepId, status: 'skipped', durationMs: Date.now() - t0 });
        continue;
      }

      const hasVoidMarker =
        typeof qbData.PrivateNote === 'string' &&
        qbData.PrivateNote.toLowerCase().includes('voided');

      if (!hasVoidMarker) {
        emit({ step: stepId, status: 'skipped' });
        results.push({ id: stepId, status: 'skipped', durationMs: Date.now() - t0 });
        continue;
      }

      // Restore to the appropriate active lifecycle status (Task #1847
      // retired 'sent'; delivery is now tracked via sentAt timestamp):
      //   'generated' — invoice was sent (sentAt set); stays in the sync
      //                 candidate set for future QBO balance checks.
      //   'draft'     — invoice was never sent; excluded from auto-sync
      //                 but editable and visible in AR.
      const newStatus = row.sentAt ? 'generated' : 'draft';

      try {
        await deps.applyRepair(row.id, newStatus, now);

        logger.info(
          {
            invoiceId: row.id,
            invoiceNumber: row.invoiceNumber,
            companyId: row.companyId,
            oldStatus: 'paid',
            newStatus,
          },
          '[repair-qb-void-mispaid] Invoice repaired',
        );

        repaired++;
        emit({ step: stepId, status: 'success', rowsAffected: 1 });
        results.push({ id: stepId, status: 'success', durationMs: Date.now() - t0, rowsAffected: 1 });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        emit({ step: stepId, status: 'failed', error });
        results.push({ id: stepId, status: 'failed', durationMs: Date.now() - t0, error });
        errors++;
      }
    }
  }

  const summaryId = 'repair_summary';
  const summaryStatus = errors > 0 ? 'failed' : 'success';
  emit({ step: summaryId, status: summaryStatus, rowsAffected: repaired });
  results.push({ id: summaryId, status: summaryStatus, durationMs: 0, rowsAffected: repaired });

  if (errors === 0) {
    await deps.markDone();
  }

  return results;
}

// ── run() wires DB deps (production entrypoint) ───────────────────────────────

async function run(
  emit: ProgressEmitter,
  opts?: MigrationRunOptions,
): Promise<MigrationStepResult[]> {
  return runRepairQbVoid(createDbDeps(), emit, opts);
}

// ── Export ────────────────────────────────────────────────────────────────────

export const repairQbVoidMispaidMigration: MigrationDefinition = {
  id: MIGRATION_ID,
  title: 'Repair QBO-voided invoices mis-flagged as paid',
  description:
    'Finds locally-paid QBO-linked invoices that were mis-stamped as paid because the ' +
    'invoice was voided in QuickBooks (TotalAmt=0, Balance=0). Re-queries QBO for current ' +
    'balances; invoices with TotalAmt=0 AND a "Voided" QBO marker have their status, ' +
    'paymentStatus, and paidAt corrected. Legitimate $0 invoices without the void marker ' +
    'are not touched. Idempotent.',
  appSettingsKey: DONE_KEY,
  check,
  preview,
  run,
};
