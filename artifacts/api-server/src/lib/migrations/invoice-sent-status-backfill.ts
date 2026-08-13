// Task #1847 / #1942 — Backfill invoice sent_at and retire status='sent'.
//
// This is a PORT, not a rewrite. `artifacts/api-server/src/migrations/
// 0006-invoice-sent-status-backfill.ts` was written for #1847 as a standalone
// `node --import tsx/esm ...` script and was never wired to anything: not in
// this registry, not invoked at startup, referenced nowhere outside itself.
// That is why invoices are still sitting at `status = 'sent'` weeks later and
// why paid invoices still have a NULL `sent_at`.
//
// The registry exists precisely so a written-but-unrun migration is visible at
// /admin/migrations with a preview and an acknowledgement. So 0006 moves here.
//
// THE SQL BELOW IS 0006's SQL, VERBATIM. Same three statements, same order,
// same WHERE clauses, same COALESCE, same dry-run COUNT queries. Nothing was
// "improved" during the move and nothing was translated into the Drizzle query
// builder — a port that also rewrites is a port nobody can review.
//
// Steps (0006's own ordering, preserved):
//   1. status='sent' AND sent_at IS NULL  → sent_at = COALESCE(sent_at, updated_at)
//   2. sent_at IS NULL and a matching invoice_pdfs row was sent
//                                         → copy invoice_pdfs.sent_at across
//   3. every remaining status='sent'      → status='generated'
//
// Company-agnostic, exactly as 0006 argued: all three updates are timestamp /
// status normalisations keyed by primary key, identical across every company.
//
// Safe to re-run: each step is idempotent.
//
// Financial-adjacent gate: `sentAt != null` drives the never-sent A/R flag and
// the reminder refusal matrix, and step 2 touches paid invoices, so run()
// refuses to write without `acknowledged: true`.

import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { appSettings } from '@workspace/db/schema';
import { eq } from 'drizzle-orm';
import type {
  MigrationDefinition,
  MigrationStatus,
  MigrationPreview,
  MigrationStepResult,
  MigrationRunOptions,
  ProgressEmitter,
} from './types';

const MIGRATION_ID = 'invoice-sent-status-backfill-v1';
export const APP_KEY = 'invoiceSentStatusBackfill.done';

// ── Preview counts — 0006's --dry-run queries, verbatim ─────────────────────

function countOf(result: unknown): number {
  const rows = (result as any).rows ?? (result as unknown as any[]);
  const raw = rows?.[0]?.cnt;
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Step 1 dry-run: rows at status='sent' with no sent_at at all. */
async function countStep1(): Promise<number> {
  return countOf(
    await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM invoices
      WHERE status = 'sent' AND sent_at IS NULL
    `),
  );
}

/**
 * Step 2 dry-run: invoices with no sent_at that DO have a recoverable
 * timestamp on a sent invoice_pdfs row. This is the count that answers "how
 * many of the sent_at-less invoices can actually be recovered from the PDF
 * table", which is the number worth reviewing before acknowledging.
 */
async function countStep2(): Promise<number> {
  return countOf(
    await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM invoices i
      JOIN invoice_pdfs p ON p.invoice_id = i.id
      WHERE p.status = 'sent'
        AND p.sent_at IS NOT NULL
        AND i.sent_at IS NULL
    `),
  );
}

/** Step 3 dry-run: every row still carrying the retired status value. */
async function countStep3(): Promise<number> {
  return countOf(
    await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM invoices WHERE status = 'sent'
    `),
  );
}

// ── check ───────────────────────────────────────────────────────────────────

async function readMarker(): Promise<{ completedAt: string } | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, APP_KEY))
    .limit(1);
  if (rows.length === 0) return null;
  // `app_settings.value` is text, so the marker object comes back as a JSON
  // string. Reading it without parsing hands the whole blob back as the
  // timestamp, which then renders as a completion date nobody can read.
  const raw = rows[0].value as unknown;
  let val: any = raw;
  if (typeof raw === 'string') {
    try {
      val = JSON.parse(raw);
    } catch {
      return { completedAt: raw };
    }
  }
  return { completedAt: (typeof val === 'string' ? val : val?.completedAt) ?? '' };
}

async function writeMarker(payload: Record<string, unknown>): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: APP_KEY, value: payload } as any)
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: payload, updatedAt: new Date() } as any,
    });
}

/**
 * Completion is inferred from the data, the way repair-woodglenn-wo-hours
 * does it — but from BOTH halves of the work, not just the visible one.
 *
 * Zero rows at `status = 'sent'` only says step 3 has happened. A database
 * where someone cleaned the statuses by hand still owes step 2: paid invoices
 * with a NULL `sent_at` whose `invoice_pdfs` row knows when it went out.
 * Reporting that as completed would retire the migration from the admin page
 * with the delivery timestamps — which drive the never-sent flag and the
 * reminder refusal matrix — still missing.
 *
 * The marker is read here and never written: a status check is a read, and
 * the completion marker belongs to the acknowledged run. The reference
 * implementation (repair-woodglenn-wo-hours) does the same, returning an
 * empty completedAt when the data is clean but no run of ours recorded it.
 */
export function resolveCheckState(
  remainingSentStatus: number,
  recoverableFromPdfs: number,
  marker: { completedAt: string } | null,
): MigrationStatus {
  const outstanding: string[] = [];
  if (remainingSentStatus > 0) {
    outstanding.push(`${remainingSentStatus} invoice(s) still at status='sent'`);
  }
  if (recoverableFromPdfs > 0) {
    outstanding.push(
      `${recoverableFromPdfs} invoice(s) still have a NULL sent_at recoverable from invoice_pdfs`,
    );
  }

  if (outstanding.length === 0) {
    return { state: 'completed', completedAt: marker?.completedAt ?? '' };
  }

  // Some of the work is demonstrably done — either the statuses were retired
  // without the timestamps being recovered, or the reverse — so this is not a
  // migration that has never been touched.
  const partial = marker != null || outstanding.length < 2;
  return partial
    ? { state: 'partially_applied', details: `${outstanding.join('; ')}.` }
    : { state: 'not_started' };
}

async function check(): Promise<MigrationStatus> {
  let remaining: number;
  let recoverable: number;
  try {
    remaining = await countStep3();
    recoverable = await countStep2();
  } catch (err) {
    return {
      state: 'error',
      details: `check() failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return resolveCheckState(remaining, recoverable, await readMarker());
}

// ── preview ─────────────────────────────────────────────────────────────────

const STEPS = [
  {
    id: 'backfill-sent-at-from-updated-at',
    description:
      "Step 1 — rows at status='sent' with a NULL sent_at: set sent_at = COALESCE(sent_at, updated_at)",
  },
  {
    id: 'recover-sent-at-from-invoice-pdfs',
    description:
      "Step 2 — invoices with a NULL sent_at whose invoice_pdfs row is status='sent': copy invoice_pdfs.sent_at onto the invoice",
  },
  {
    id: 'retire-sent-status',
    description: "Step 3 — every remaining status='sent' row: set status='generated'",
  },
  {
    id: 'mark-done',
    description: 'Stamp completion marker in app_settings',
  },
];

async function preview(): Promise<MigrationPreview> {
  const step1 = await countStep1();
  const step2 = await countStep2();
  const step3 = await countStep3();

  const warnings: string[] = [
    `Step 1 would backfill sent_at from updated_at on ${step1} row(s) at status='sent'.`,
    `Step 2 would recover sent_at from invoice_pdfs on ${step2} invoice(s) — these are invoices with no sent_at that have a matching sent PDF, and they include paid invoices.`,
    `Step 3 would retire ${step3} row(s) from status='sent' to status='generated'.`,
    'One acknowledgement runs all three steps. There is no per-step skip: if only steps 1 and 3 are wanted, say so before running — a skip option is not implemented.',
  ];
  if (step1 === 0 && step2 === 0 && step3 === 0) {
    warnings.push('Nothing to do — the data already matches the post-migration state.');
  }

  return {
    steps: STEPS,
    orphanRows: {
      // Broken out separately, per step, so the three numbers can be reviewed
      // independently rather than as one opaque total.
      sentStatusMissingSentAt: step1,
      recoverableFromInvoicePdfs: step2,
      rowsAtSentStatus: step3,
    },
    warnings,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

function rowCountOf(result: unknown): number {
  const n = (result as any)?.rowCount ?? 0;
  return Number.isFinite(Number(n)) ? Number(n) : 0;
}

async function run(
  emit: ProgressEmitter,
  opts?: MigrationRunOptions,
): Promise<MigrationStepResult[]> {
  const results: MigrationStepResult[] = [];

  if (!opts?.acknowledged) {
    const err =
      "This migration rewrites sent_at (which drives the never-sent flag and the reminder refusal matrix) and moves every status='sent' invoice to 'generated'. Re-run with acknowledged=true after reviewing the preview counts.";
    emit({ step: STEPS[0].id, status: 'failed', error: err });
    results.push({ id: STEPS[0].id, status: 'failed', durationMs: 0, error: err });
    return results;
  }

  // ── Step 1 ─ 0006's statement, verbatim ───────────────────────────────────
  const t1 = Date.now();
  emit({ step: STEPS[0].id, status: 'running' });
  const step1 = await db.execute(sql`
      UPDATE invoices
      SET sent_at = COALESCE(sent_at, updated_at)
      WHERE status = 'sent'
        AND sent_at IS NULL
    `);
  const step1Count = rowCountOf(step1);
  emit({ step: STEPS[0].id, status: 'success', rowsAffected: step1Count });
  results.push({
    id: STEPS[0].id,
    status: 'success',
    durationMs: Date.now() - t1,
    rowsAffected: step1Count,
  });

  // ── Step 2 ─ 0006's statement, verbatim ───────────────────────────────────
  const t2 = Date.now();
  emit({ step: STEPS[1].id, status: 'running' });
  const step2 = await db.execute(sql`
      UPDATE invoices i
      SET sent_at = p.sent_at
      FROM invoice_pdfs p
      WHERE p.invoice_id = i.id
        AND p.status = 'sent'
        AND p.sent_at IS NOT NULL
        AND i.sent_at IS NULL
    `);
  const step2Count = rowCountOf(step2);
  emit({ step: STEPS[1].id, status: 'success', rowsAffected: step2Count });
  results.push({
    id: STEPS[1].id,
    status: 'success',
    durationMs: Date.now() - t2,
    rowsAffected: step2Count,
  });

  // ── Step 3 ─ 0006's statement, verbatim ───────────────────────────────────
  const t3 = Date.now();
  emit({ step: STEPS[2].id, status: 'running' });
  const step3 = await db.execute(sql`
      UPDATE invoices
      SET status = 'generated'
      WHERE status = 'sent'
    `);
  const step3Count = rowCountOf(step3);
  emit({ step: STEPS[2].id, status: 'success', rowsAffected: step3Count });
  results.push({
    id: STEPS[2].id,
    status: 'success',
    durationMs: Date.now() - t3,
    rowsAffected: step3Count,
  });

  // ── Mark done ─────────────────────────────────────────────────────────────
  const t4 = Date.now();
  emit({ step: STEPS[3].id, status: 'running' });
  const completedAt = new Date().toISOString();
  await writeMarker({
    completedAt,
    sentAtFromUpdatedAt: step1Count,
    sentAtFromInvoicePdfs: step2Count,
    statusRetired: step3Count,
  });
  emit({ step: STEPS[3].id, status: 'success' });
  results.push({ id: STEPS[3].id, status: 'success', durationMs: Date.now() - t4 });

  return results;
}

export const invoiceSentStatusBackfillMigration: MigrationDefinition = {
  id: MIGRATION_ID,
  title: "Backfill invoice sent_at and retire status='sent'",
  description:
    "Port of the unwired 0006 backfill script (#1847), SQL unchanged. Fills sent_at from updated_at on " +
    "status='sent' rows, recovers sent_at from matching sent invoice_pdfs rows, then moves every remaining " +
    "status='sent' invoice to status='generated' so sent_at is the single source of delivery truth. " +
    "Idempotent. One acknowledgement runs all three steps.",
  appSettingsKey: APP_KEY,
  check,
  preview,
  run,
};
