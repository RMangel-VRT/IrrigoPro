// Task #1934 — Repair Woodglenn Squares HOA over-stated work order hours.
//
// Two completed, unbilled work orders carry labor hours roughly double the
// correct figure due to the pre-#1869 inspection-completion prefill bug.
//
// Safety contract:
//   – Only corrects the two named WOs scoped by companyId AND workOrderNumber.
//   – Preflight verifies both WOs exist, neither is billed, and hours match
//     the expected-current value. If any check fails, nothing is written.
//   – Production path wraps row-locking, billed-state re-validation, and
//     conditional updates (WHERE invoice_id IS NULL AND total_hours = expected)
//     in a single DB transaction; 0-rows-affected on any update throws and
//     rolls back all writes.
//   – Writes only: total_hours, labor_subtotal, total_amount.
//   – Never touches: parts_subtotal, total_parts_cost, estimated_total,
//     line items, status, completed_at.
//   – Idempotent: rows already at correctHours are skipped cleanly.
//   – Requires acknowledged=true (financial-data gate).

import { db } from '../../db';
import { workOrders, billingSheets, appSettings } from '@workspace/db/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { money } from '../money';
import type {
  MigrationDefinition,
  MigrationStatus,
  MigrationPreview,
  MigrationStepResult,
  ProgressEmitter,
  MigrationRunOptions,
} from './types';

export const DONE_KEY = 'repairWoodglennWoHours.done';
const MIGRATION_ID = 'repair-woodglenn-wo-hours-v1';

// ── Verified correction constants ────────────────────────────────────────────

interface WoCorrection {
  workOrderNumber: string;
  companyId: number;
  expectedCurrentHours: number;
  correctHours: number;
  expectedLaborSubtotal: number;
  expectedTotal: number;
}

const CORRECTIONS: WoCorrection[] = [
  {
    workOrderNumber: 'WO-1783955816671-314',
    companyId: 1,
    expectedCurrentHours: 140.00,
    correctHours: 50.00,
    expectedLaborSubtotal: 4250.00,
    expectedTotal: 7381.70,
  },
  {
    workOrderNumber: 'WO-1783955809401-62',
    companyId: 1,
    expectedCurrentHours: 22.00,
    correctHours: 10.75,
    expectedLaborSubtotal: 913.75,
    expectedTotal: 1886.25,
  },
];

// ── Candidate row type ────────────────────────────────────────────────────────

export interface WoCandidateRow {
  workOrderNumber: string;
  companyId: number;
  totalHours: string | null;
  laborRate: string | null;
  appliedLaborRate: string | null;
  laborSubtotal: string | null;
  partsSubtotal: string | null;
  totalAmount: string | null;
  invoiceId: number | null;
  billingSheetExists: boolean;
}

// ── Preflight result ──────────────────────────────────────────────────────────

type PreflightOk = {
  kind: 'ok';
  correction: WoCorrection;
  row: WoCandidateRow;
  alreadyDone: boolean;
  derivedLaborSubtotal: number;
  derivedTotal: number;
};

type PreflightFail = {
  kind: 'fail';
  workOrderNumber: string;
  error: string;
};

type PreflightResult = PreflightOk | PreflightFail;

/** Validates one WO without writing anything. */
export function preflightOne(correction: WoCorrection, rows: WoCandidateRow[]): PreflightResult {
  const row = rows.find(
    (r) =>
      r.workOrderNumber === correction.workOrderNumber &&
      r.companyId === correction.companyId,
  );

  if (!row) {
    return {
      kind: 'fail',
      workOrderNumber: correction.workOrderNumber,
      error: `WO ${correction.workOrderNumber} (company ${correction.companyId}) not found — cannot apply correction`,
    };
  }

  if (row.invoiceId != null) {
    return {
      kind: 'fail',
      workOrderNumber: correction.workOrderNumber,
      error:
        `WO ${correction.workOrderNumber} has invoice_id=${row.invoiceId} — ` +
        'cannot modify a billed work order',
    };
  }

  if (row.billingSheetExists) {
    return {
      kind: 'fail',
      workOrderNumber: correction.workOrderNumber,
      error:
        `WO ${correction.workOrderNumber} has a billing sheet — ` +
        'cannot modify a work order that has already been converted to billing',
    };
  }

  const currentHoursStr = money(row.totalHours).toFixed(2);
  const correctHoursStr = correction.correctHours.toFixed(2);
  const expectedCurrentStr = correction.expectedCurrentHours.toFixed(2);

  if (currentHoursStr === correctHoursStr) {
    const rate = money(row.appliedLaborRate ?? row.laborRate);
    return {
      kind: 'ok',
      correction,
      row,
      alreadyDone: true,
      derivedLaborSubtotal: money(correction.correctHours) * rate,
      derivedTotal: money(correction.correctHours) * rate + money(row.partsSubtotal),
    };
  }

  if (currentHoursStr !== expectedCurrentStr) {
    return {
      kind: 'fail',
      workOrderNumber: correction.workOrderNumber,
      error:
        `WO ${correction.workOrderNumber} has total_hours=${currentHoursStr}, ` +
        `expected either ${expectedCurrentStr} (uncorrected) or ${correctHoursStr} (already done). ` +
        'Something changed outside this migration — refusing to guess.',
    };
  }

  const rate = money(row.appliedLaborRate ?? row.laborRate);
  const derivedLaborSubtotal = money(correction.correctHours) * rate;
  const derivedTotal = derivedLaborSubtotal + money(row.partsSubtotal);

  if (derivedLaborSubtotal.toFixed(2) !== correction.expectedLaborSubtotal.toFixed(2)) {
    return {
      kind: 'fail',
      workOrderNumber: correction.workOrderNumber,
      error:
        `WO ${correction.workOrderNumber} cross-check failed: ` +
        `derived labor_subtotal=${derivedLaborSubtotal.toFixed(2)} but constant says ${correction.expectedLaborSubtotal.toFixed(2)}. ` +
        `Applied rate=${rate.toFixed(2)}. Refusing to apply a correction that conflicts with verified constants.`,
    };
  }

  if (derivedTotal.toFixed(2) !== correction.expectedTotal.toFixed(2)) {
    return {
      kind: 'fail',
      workOrderNumber: correction.workOrderNumber,
      error:
        `WO ${correction.workOrderNumber} cross-check failed: ` +
        `derived total_amount=${derivedTotal.toFixed(2)} but constant says ${correction.expectedTotal.toFixed(2)}. ` +
        `parts_subtotal=${money(row.partsSubtotal).toFixed(2)}. Refusing to apply.`,
    };
  }

  return { kind: 'ok', correction, row, alreadyDone: false, derivedLaborSubtotal, derivedTotal };
}

// ── Injectable deps (for unit testing without DB) ─────────────────────────────

export type RepairWoodglennDeps = {
  /** Fetches both target WOs scoped by companyId AND workOrderNumber. */
  getCandidates(): Promise<WoCandidateRow[]>;
  /**
   * Writes only total_hours, labor_subtotal, total_amount.
   * Returns the number of rows actually modified — the caller must fail if 0.
   */
  applyCorrection(
    workOrderNumber: string,
    companyId: number,
    updates: { totalHours: string; laborSubtotal: string; totalAmount: string },
  ): Promise<{ rowsAffected: number }>;
  /** Upserts the done marker in app_settings. */
  markDone(): Promise<void>;
};

// ── Pure runner (deps-injectable, exported for unit tests) ────────────────────
//
// The production `run()` uses a separate transactional path (see below).
// This export exists solely so unit tests can exercise the logic layer with
// an in-memory dep implementation.

export async function runRepairWoodglennWoHours(
  deps: RepairWoodglennDeps,
  emit: ProgressEmitter,
  opts?: MigrationRunOptions,
): Promise<MigrationStepResult[]> {
  if (!opts?.acknowledged) {
    const stepId = 'acknowledge_gate';
    const error =
      'This migration modifies work order labor hours and totals. ' +
      'Set acknowledged=true to proceed.';
    emit({ step: stepId, status: 'failed', error });
    return [{ id: stepId, status: 'failed', durationMs: 0, error }];
  }

  const rows = await deps.getCandidates();

  // ── Preflight: validate ALL targets before writing anything ───────────────
  const preflights: PreflightResult[] = CORRECTIONS.map((c) => preflightOne(c, rows));
  const failures = preflights.filter((p): p is PreflightFail => p.kind === 'fail');

  if (failures.length > 0) {
    const stepId = 'preflight';
    const error =
      'Preflight failed — no corrections applied to either work order:\n' +
      failures.map((f) => `  • ${f.workOrderNumber}: ${f.error}`).join('\n');
    emit({ step: stepId, status: 'failed', error });
    return [{ id: stepId, status: 'failed', durationMs: 0, error }];
  }

  // ── All preflights passed — apply corrections ─────────────────────────────
  const results: MigrationStepResult[] = [];

  for (const pf of preflights as PreflightOk[]) {
    const { correction, alreadyDone, derivedLaborSubtotal, derivedTotal } = pf;
    const stepId = `repair_${correction.workOrderNumber}`;
    const t0 = Date.now();
    emit({ step: stepId, status: 'running' });

    if (alreadyDone) {
      emit({ step: stepId, status: 'skipped' });
      results.push({ id: stepId, status: 'skipped', durationMs: Date.now() - t0 });
      continue;
    }

    try {
      const { rowsAffected } = await deps.applyCorrection(
        correction.workOrderNumber,
        correction.companyId,
        {
          totalHours: correction.correctHours.toFixed(2),
          laborSubtotal: derivedLaborSubtotal.toFixed(2),
          totalAmount: derivedTotal.toFixed(2),
        },
      );

      if (rowsAffected === 0) {
        const error =
          `WO ${correction.workOrderNumber} update matched 0 rows — ` +
          'concurrent modification detected (invoice added or hours changed since preflight)';
        emit({ step: stepId, status: 'failed', error });
        results.push({ id: stepId, status: 'failed', durationMs: Date.now() - t0, error });
        // Do not continue — do not call markDone
        return results;
      }

      emit({ step: stepId, status: 'success', rowsAffected: 1 });
      results.push({ id: stepId, status: 'success', durationMs: Date.now() - t0, rowsAffected: 1 });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emit({ step: stepId, status: 'failed', error });
      results.push({ id: stepId, status: 'failed', durationMs: Date.now() - t0, error });
      // Do not call markDone on error
      return results;
    }
  }

  const allSucceeded = results.every(
    (r) => r.status === 'success' || r.status === 'skipped',
  );
  if (allSucceeded) {
    await deps.markDone();
  }

  return results;
}

// ── DB candidate query (used outside the transaction) ─────────────────────────

async function queryCandidates(): Promise<WoCandidateRow[]> {
  const rows: WoCandidateRow[] = [];

  for (const c of CORRECTIONS) {
    const [wo] = await db
      .select({
        workOrderNumber: workOrders.workOrderNumber,
        companyId: workOrders.companyId,
        totalHours: workOrders.totalHours,
        laborRate: workOrders.laborRate,
        appliedLaborRate: workOrders.appliedLaborRate,
        laborSubtotal: workOrders.laborSubtotal,
        partsSubtotal: workOrders.partsSubtotal,
        totalAmount: workOrders.totalAmount,
        invoiceId: workOrders.invoiceId,
      })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, c.companyId),
          eq(workOrders.workOrderNumber, c.workOrderNumber),
        ),
      )
      .limit(1);

    if (!wo) continue;

    const bsRows = await db
      .select({ id: billingSheets.id })
      .from(billingSheets)
      .where(
        and(
          eq(billingSheets.companyId, c.companyId),
          sql`billing_sheets.work_order_id = (
            SELECT id FROM work_orders
            WHERE company_id = ${c.companyId}
              AND work_order_number = ${c.workOrderNumber}
            LIMIT 1
          )`,
        ),
      )
      .limit(1);

    rows.push({
      ...wo,
      workOrderNumber: wo.workOrderNumber ?? c.workOrderNumber,
      companyId: wo.companyId ?? c.companyId,
      invoiceId: wo.invoiceId ?? null,
      billingSheetExists: bsRows.length > 0,
    });
  }

  return rows;
}

// ── check() ──────────────────────────────────────────────────────────────────

async function check(): Promise<MigrationStatus> {
  const marker = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, DONE_KEY))
    .limit(1);

  let uncorrectedCount = 0;
  try {
    const rows = await queryCandidates();
    for (const row of rows) {
      const correction = CORRECTIONS.find(
        (c) =>
          c.workOrderNumber === row.workOrderNumber &&
          c.companyId === row.companyId,
      );
      if (!correction) continue;
      if (money(row.totalHours).toFixed(2) !== correction.correctHours.toFixed(2)) {
        uncorrectedCount++;
      }
    }
  } catch (err) {
    return {
      state: 'error',
      details: `check() failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (marker.length > 0 && uncorrectedCount === 0) {
    return {
      state: 'completed',
      completedAt: String((marker[0] as any).value ?? ''),
    };
  }

  if (marker.length > 0 && uncorrectedCount > 0) {
    return {
      state: 'partially_applied',
      details: `${uncorrectedCount} work order(s) still have uncorrected hours`,
    };
  }

  if (uncorrectedCount === 0) {
    return { state: 'completed', completedAt: '' };
  }

  return { state: 'not_started' };
}

// ── preview() ────────────────────────────────────────────────────────────────

async function preview(): Promise<MigrationPreview> {
  const rows = await queryCandidates();
  const warnings: string[] = [];
  const steps = [];

  for (const correction of CORRECTIONS) {
    const row = rows.find(
      (r) =>
        r.workOrderNumber === correction.workOrderNumber &&
        r.companyId === correction.companyId,
    );

    if (!row) {
      warnings.push(
        `WO ${correction.workOrderNumber} (company ${correction.companyId}) not found in DB — may already be removed.`,
      );
      continue;
    }

    const currentHours = money(row.totalHours);
    const currentLaborSubtotal = money(row.laborSubtotal);
    const currentTotal = money(row.totalAmount);
    const partsSubtotal = money(row.partsSubtotal);
    const rate = money(row.appliedLaborRate ?? row.laborRate);
    const newLaborSubtotal = money(correction.correctHours) * rate;
    const newTotal = newLaborSubtotal + partsSubtotal;

    const billedNote =
      row.invoiceId != null
        ? `⚠ invoice_id=${row.invoiceId} — run() will refuse`
        : row.billingSheetExists
          ? '⚠ billing sheet exists — run() will refuse'
          : 'invoice_id=null, no billing sheet';

    steps.push({
      id: `preview_${correction.workOrderNumber}`,
      description:
        `${correction.workOrderNumber} (company ${correction.companyId}): ` +
        `total_hours ${currentHours.toFixed(2)} → ${correction.correctHours.toFixed(2)}; ` +
        `labor_subtotal ${currentLaborSubtotal.toFixed(2)} → ${newLaborSubtotal.toFixed(2)}; ` +
        `total_amount ${currentTotal.toFixed(2)} → ${newTotal.toFixed(2)}; ` +
        `parts_subtotal stays ${partsSubtotal.toFixed(2)} (unchanged); ` +
        `total_parts_cost and estimated_total are NOT read or written; ` +
        billedNote,
    });
  }

  warnings.push(
    'This migration writes total_hours, labor_subtotal, and total_amount only. ' +
    'parts_subtotal, total_parts_cost, estimated_total, line items, status, and ' +
    'completed_at are not touched. Set acknowledged=true to proceed.',
  );

  return {
    steps,
    orphanRows: { candidatesFound: rows.length },
    warnings,
  };
}

// ── Production run(): fully transactional ────────────────────────────────────
//
// Execution order:
//   1. Acknowledge gate (no writes)
//   2. queryCandidates() for a fast preflight (outside the transaction)
//   3. preflightOne() on every target — aborts all if any fails
//   4. db.transaction():
//      a. SELECT … FOR UPDATE on both WO rows (exclusive row lock)
//      b. Re-check invoice_id and billing_sheets inside the transaction
//      c. Conditional UPDATE WHERE invoice_id IS NULL AND total_hours = expected
//      d. Verify rowCount > 0 for each update; throw (rolls back) if 0
//   5. markDone() after the transaction commits
//
// The unit-testable pure runner (`runRepairWoodglennWoHours`) exercises the
// same acknowledge gate, preflight logic, and 0-rows-affected guard using
// in-memory injectable deps.

async function run(
  emit: ProgressEmitter,
  opts?: MigrationRunOptions,
): Promise<MigrationStepResult[]> {
  // ── Acknowledge gate ───────────────────────────────────────────────────────
  if (!opts?.acknowledged) {
    const stepId = 'acknowledge_gate';
    const error =
      'This migration modifies work order labor hours and totals. ' +
      'Set acknowledged=true to proceed.';
    emit({ step: stepId, status: 'failed', error });
    return [{ id: stepId, status: 'failed', durationMs: 0, error }];
  }

  // ── Preflight (outside transaction — fast read, no writes) ─────────────────
  const rows = await queryCandidates();
  const preflights: PreflightResult[] = CORRECTIONS.map((c) => preflightOne(c, rows));
  const failures = preflights.filter((p): p is PreflightFail => p.kind === 'fail');

  if (failures.length > 0) {
    const stepId = 'preflight';
    const error =
      'Preflight failed — no corrections applied to either work order:\n' +
      failures.map((f) => `  • ${f.workOrderNumber}: ${f.error}`).join('\n');
    emit({ step: stepId, status: 'failed', error });
    return [{ id: stepId, status: 'failed', durationMs: 0, error }];
  }

  const toApply = (preflights as PreflightOk[]).filter((pf) => !pf.alreadyDone);
  const toSkip  = (preflights as PreflightOk[]).filter((pf) => pf.alreadyDone);

  if (toApply.length === 0) {
    // All WOs already at the correct hours — idempotent no-op
    await db
      .insert(appSettings)
      .values({ key: DONE_KEY, value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: new Date().toISOString() },
      });

    return toSkip.map((pf) => ({
      id: `repair_${pf.correction.workOrderNumber}`,
      status: 'skipped' as const,
      durationMs: 0,
    }));
  }

  // ── Transactional apply ────────────────────────────────────────────────────
  //
  // Errors thrown inside the callback roll back all writes automatically.
  // After the transaction commits, we emit results and call markDone.

  try {
    await db.transaction(async (tx) => {
      // a) Exclusive row lock on both targets (prevents concurrent billing conversion)
      for (const pf of [...toApply, ...toSkip]) {
        await tx.execute(
          sql`SELECT id FROM work_orders
              WHERE company_id = ${pf.correction.companyId}
                AND work_order_number = ${pf.correction.workOrderNumber}
              FOR UPDATE`,
        );
      }

      // b) Re-validate billed state inside the transaction (race protection)
      for (const pf of toApply) {
        const [locked] = await tx
          .select({ invoiceId: workOrders.invoiceId })
          .from(workOrders)
          .where(
            and(
              eq(workOrders.companyId, pf.correction.companyId),
              eq(workOrders.workOrderNumber, pf.correction.workOrderNumber),
            ),
          )
          .limit(1);

        if (locked?.invoiceId != null) {
          throw new Error(
            `WO ${pf.correction.workOrderNumber} gained invoice_id=${locked.invoiceId} ` +
            'after preflight — concurrent billing detected, rolling back',
          );
        }

        const [bs] = await tx
          .select({ id: billingSheets.id })
          .from(billingSheets)
          .where(
            and(
              eq(billingSheets.companyId, pf.correction.companyId),
              sql`billing_sheets.work_order_id = (
                SELECT id FROM work_orders
                WHERE company_id = ${pf.correction.companyId}
                  AND work_order_number = ${pf.correction.workOrderNumber}
                LIMIT 1
              )`,
            ),
          )
          .limit(1);

        if (bs) {
          throw new Error(
            `WO ${pf.correction.workOrderNumber} gained a billing sheet after preflight ` +
            '— concurrent conversion detected, rolling back',
          );
        }
      }

      // c+d) Conditional updates guarded by invoice_id IS NULL and expected hours
      for (const pf of toApply) {
        const result = await tx.execute(
          sql`UPDATE work_orders
              SET total_hours    = ${pf.correction.correctHours.toFixed(2)}::decimal,
                  labor_subtotal = ${pf.derivedLaborSubtotal.toFixed(2)}::decimal,
                  total_amount   = ${pf.derivedTotal.toFixed(2)}::decimal
              WHERE company_id        = ${pf.correction.companyId}
                AND work_order_number = ${pf.correction.workOrderNumber}
                AND invoice_id IS NULL
                AND total_hours       = ${pf.correction.expectedCurrentHours.toFixed(2)}::decimal`,
        );

        // Drizzle surfaces pg's rowCount as result.rowCount (number | null)
        const rowCount = (result as any).rowCount ?? (result as any).count ?? 0;
        if (rowCount === 0) {
          throw new Error(
            `WO ${pf.correction.workOrderNumber} conditional update matched 0 rows — ` +
            'concurrent modification detected (invoice added or hours changed), rolling back',
          );
        }
      }
    });
  } catch (err) {
    const stepId = 'apply_transaction';
    const error = err instanceof Error ? err.message : String(err);
    emit({ step: stepId, status: 'failed', error });
    return [{ id: stepId, status: 'failed', durationMs: 0, error }];
  }

  // ── Transaction committed — emit results ───────────────────────────────────
  const results: MigrationStepResult[] = [];

  for (const pf of toApply) {
    logger.info(
      {
        workOrderNumber: pf.correction.workOrderNumber,
        companyId: pf.correction.companyId,
        oldHours: pf.correction.expectedCurrentHours.toFixed(2),
        newHours: pf.correction.correctHours.toFixed(2),
        newLaborSubtotal: pf.derivedLaborSubtotal.toFixed(2),
        newTotalAmount: pf.derivedTotal.toFixed(2),
      },
      '[repair-woodglenn-wo-hours] Work order hours corrected',
    );
    const stepId = `repair_${pf.correction.workOrderNumber}`;
    emit({ step: stepId, status: 'success', rowsAffected: 1 });
    results.push({ id: stepId, status: 'success', durationMs: 0, rowsAffected: 1 });
  }

  for (const pf of toSkip) {
    const stepId = `repair_${pf.correction.workOrderNumber}`;
    emit({ step: stepId, status: 'skipped' });
    results.push({ id: stepId, status: 'skipped', durationMs: 0 });
  }

  // ── Mark done after transaction commits ────────────────────────────────────
  await db
    .insert(appSettings)
    .values({ key: DONE_KEY, value: new Date().toISOString() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: new Date().toISOString() },
    });

  return results;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const repairWoodglennWoHoursMigration: MigrationDefinition = {
  id: MIGRATION_ID,
  title: 'Repair Woodglenn Squares HOA over-stated work order hours',
  description:
    'Corrects total_hours, labor_subtotal, and total_amount on two completed, ' +
    'unbilled Woodglenn Squares HOA work orders that carry roughly double the correct ' +
    'labor hours due to the pre-#1869 inspection-completion prefill bug. ' +
    'WO-1783955816671-314: 140.00 h → 50.00 h. ' +
    'WO-1783955809401-62: 22.00 h → 10.75 h. ' +
    'Runs both updates in a single DB transaction with row locking and conditional ' +
    'WHERE guards (invoice_id IS NULL, total_hours = expected). ' +
    'parts_subtotal, total_parts_cost, estimated_total, line items, status, ' +
    'and completed_at are untouched. Idempotent.',
  appSettingsKey: DONE_KEY,
  check,
  preview,
  run,
};
