/**
 * Migration 0006: Backfill invoice sent_at and retire status='sent'
 *
 * Task #1847 — Decouple invoice sent-ness from lifecycle status.
 *
 * SUPERSEDED BY THE REGISTRY (Task #1942). This script was never wired to
 * anything and so never ran. Its three statements now live, verbatim, in
 * `../lib/migrations/invoice-sent-status-backfill.ts`, registered as
 * `invoice-sent-status-backfill-v1` and runnable from /admin/migrations with a
 * preview and an acknowledgement. Run it from there, not from here; this file
 * is kept only as the reviewable original of the ported SQL.
 *
 * `invoices.status` previously doubled as both a lifecycle tracker and a
 * delivery flag. This migration promotes `sent_at` to the single source of
 * delivery truth and retires the `status = 'sent'` value.
 *
 * Steps (run in order, each logged with row counts):
 *
 *   1. For rows where status='sent' and sent_at IS NULL, backfill sent_at
 *      from updated_at (best available timestamp when the row was last touched).
 *
 *   2. For invoices where sent_at IS NULL and a matching invoice_pdfs row has
 *      status='sent', copy invoice_pdfs.sent_at onto invoices.sent_at
 *      (covers invoices emailed via the pdf/send endpoint).
 *
 *   3. Set status='generated' for every row still at status='sent' (after the
 *      above backfills, sentAt records the delivery fact independently).
 *
 * Company-agnostic justification: all three updates are pure timestamp /
 * status normalisations that apply identically across every company. There is
 * no company-specific business logic and no risk of cross-company data
 * contamination — rows are keyed by their own primary keys. Running per-company
 * would add unnecessary complexity without a safety benefit.
 *
 * Safe to re-run: each step is idempotent.
 *
 * Run:
 *   node --import tsx/esm artifacts/api-server/src/migrations/0006-invoice-sent-status-backfill.ts [--dry-run]
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`[0006] invoice-sent-status-backfill — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  // ── Step 1: Fill sent_at gaps on status='sent' rows ──────────────────────
  // Any row that was transitioned to status='sent' by the old mark-sent route
  // but somehow has a NULL sent_at (shouldn't happen in normal operation, but
  // guard against any data gaps).
  if (!DRY_RUN) {
    const step1 = await db.execute(sql`
      UPDATE invoices
      SET sent_at = COALESCE(sent_at, updated_at)
      WHERE status = 'sent'
        AND sent_at IS NULL
    `);
    const step1Count = (step1 as any).rowCount ?? 0;
    console.log(`[0006] Step 1 — backfilled sent_at from updated_at on ${step1Count} status='sent' rows`);
  } else {
    const preview = await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM invoices
      WHERE status = 'sent' AND sent_at IS NULL
    `);
    console.log(`[0006] Step 1 (dry-run) — would backfill ${(preview.rows[0] as any).cnt} rows`);
  }

  // ── Step 2: Back-fill sent_at from invoice_pdfs for emailed invoices ─────
  // Invoices whose PDF was sent via the pdf/send endpoint only have delivery
  // recorded on invoice_pdfs.sent_at. Copy that timestamp onto the invoice row.
  if (!DRY_RUN) {
    const step2 = await db.execute(sql`
      UPDATE invoices i
      SET sent_at = p.sent_at
      FROM invoice_pdfs p
      WHERE p.invoice_id = i.id
        AND p.status = 'sent'
        AND p.sent_at IS NOT NULL
        AND i.sent_at IS NULL
    `);
    const step2Count = (step2 as any).rowCount ?? 0;
    console.log(`[0006] Step 2 — copied sent_at from invoice_pdfs onto ${step2Count} invoice rows`);
  } else {
    const preview = await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM invoices i
      JOIN invoice_pdfs p ON p.invoice_id = i.id
      WHERE p.status = 'sent'
        AND p.sent_at IS NOT NULL
        AND i.sent_at IS NULL
    `);
    console.log(`[0006] Step 2 (dry-run) — would copy sent_at from invoice_pdfs onto ${(preview.rows[0] as any).cnt} rows`);
  }

  // ── Step 3: Retire status='sent' → status='generated' ───────────────────
  // sentAt now records delivery independently; status='sent' is no longer used.
  if (!DRY_RUN) {
    const step3 = await db.execute(sql`
      UPDATE invoices
      SET status = 'generated'
      WHERE status = 'sent'
    `);
    const step3Count = (step3 as any).rowCount ?? 0;
    console.log(`[0006] Step 3 — retired ${step3Count} rows from status='sent' → 'generated'`);
  } else {
    const preview = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM invoices WHERE status = 'sent'
    `);
    console.log(`[0006] Step 3 (dry-run) — would retire ${(preview.rows[0] as any).cnt} rows from status='sent'`);
  }

  console.log("[0006] Done.");
}

main().catch((err) => {
  console.error("[0006] FATAL:", err);
  process.exit(1);
});
