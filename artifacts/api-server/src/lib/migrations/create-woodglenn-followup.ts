// Task #1935 — Woodglenn backfill: create a follow-up work order for
// WO-1783955816671-314.
//
// Background: Woodglenn Squares HOA inspection WO-1783955816671-314 was
// completed with 144 items, but its originating estimate (50017) had 162
// items.  The 18 missing items (17 × qty=1 + 1 × qty=2 = 19 deferred units,
// 22.50 hours) vanished without being scheduled for a return visit.
//
// This migration:
//   check   — returns completed if a follow-up with parent_work_order_id
//             pointing at the Woodglenn WO already exists, or not_started
//             otherwise.
//   preview — reports the 18 deferred items that would be created (qty/hour
//             distribution per controller) and warns that the work may no
//             longer be relevant given elapsed time.
//   run     — finds the parent WO, computes deferred items from its estimate,
//             inserts the follow-up WO + items with the same idempotency logic
//             used by the live completion route (23505 catch).
//             Requires acknowledged=true.

import { db } from '../../db';
import { sql, eq, and } from 'drizzle-orm';
import { workOrders, workOrderItems, estimateItems, appSettings } from '@workspace/db/schema';
import { computeDeferredItems } from '../work-order-deferred-items';
import { logger } from '../logger';
import { money } from '../money';
import type {
  MigrationDefinition,
  MigrationStatus,
  MigrationPreview,
  MigrationStepResult,
  ProgressEmitter,
  MigrationRunOptions,
} from './types';

const MIGRATION_ID = 'woodglenn-followup-v1';
const APP_KEY = 'woodglennFollowup';
const PARENT_WO_NUMBER = 'WO-1783955816671-314';
const COMPANY_ID = 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function parentWoColumnExists(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'work_orders' AND column_name = 'parent_work_order_id'
    LIMIT 1
  `);
  const rows = (result as any).rows ?? (result as unknown as any[]);
  return rows.length > 0;
}

async function findParentWo(): Promise<{ id: number; estimateId: number | null } | null> {
  const result = await db.execute(sql`
    SELECT id, estimate_id
    FROM work_orders
    WHERE work_order_number = ${PARENT_WO_NUMBER}
      AND company_id = ${COMPANY_ID}
    LIMIT 1
  `);
  const rows = (result as any).rows ?? (result as unknown as any[]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: Number(r.id), estimateId: r.estimate_id != null ? Number(r.estimate_id) : null };
}

async function existingFollowUp(parentId: number): Promise<{ id: number; createdAt: string } | null> {
  const result = await db.execute(sql`
    SELECT id, created_at
    FROM work_orders
    WHERE parent_work_order_id = ${parentId}
    LIMIT 1
  `);
  const rows = (result as any).rows ?? (result as unknown as any[]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: Number(r.id), createdAt: String(r.created_at ?? '') };
}

// ── check ────────────────────────────────────────────────────────────────────

async function check(): Promise<MigrationStatus> {
  // If the column doesn't exist yet, the migration can't run.
  if (!(await parentWoColumnExists())) {
    return { state: 'not_started' };
  }
  const parent = await findParentWo();
  if (!parent) {
    // WO not found — may already be remediated or this is not a production DB.
    return { state: 'not_started' };
  }
  const fu = await existingFollowUp(parent.id);
  if (fu) {
    return { state: 'completed', completedAt: fu.createdAt || 'follow-up already exists' };
  }
  return { state: 'not_started' };
}

// ── preview ──────────────────────────────────────────────────────────────────

async function preview(): Promise<MigrationPreview> {
  const steps = [
    { id: 'verify-column', description: "Verify parent_work_order_id column exists (run DB migration 0019 first)" },
    { id: 'find-parent-wo', description: `Locate work order ${PARENT_WO_NUMBER} (company_id=${COMPANY_ID}) and confirm no follow-up exists` },
    { id: 'compute-deferred', description: "Load estimate items and completed WO items, compute the 18 deferred lines" },
    { id: 'create-followup', description: "Insert follow-up work order with parentWorkOrderId set and estimateId=null" },
  ];

  const warnings: string[] = [
    "WARNING: This migration targets production WO-1783955816671-314 (Woodglenn Squares HOA).",
    "The original inspection was completed approximately six weeks ago — confirm with Woodglenn that the deferred work is still needed before running.",
    "Expected deferred items: 18 lines (17 × qty=1 + 1 × qty=2 = 19 units), 22.50 hours total.",
    "Distribution across controllers A, C, D, E, F, I, J.",
    "The follow-up will be created as status=pending so dispatch can schedule the return visit.",
    "If parent_work_order_id column does not exist, run `pnpm --filter @workspace/db run push` first.",
  ];

  const hasColumn = await parentWoColumnExists();
  if (!hasColumn) {
    warnings.unshift("BLOCKER: Column parent_work_order_id does not exist yet — run the 0019 DB migration first.");
  }

  let deferredCount = 0;
  let deferredHours = 0;
  if (hasColumn) {
    const parent = await findParentWo();
    if (parent) {
      const fu = await existingFollowUp(parent.id);
      if (fu) {
        warnings.unshift(`ALREADY DONE: Follow-up work order #${fu.id} already exists — migration will be a no-op.`);
      } else if (parent.estimateId) {
        const estItems = await db.select().from(estimateItems).where(eq(estimateItems.estimateId, parent.estimateId));
        const woItems = await db.select().from(workOrderItems).where(eq(workOrderItems.workOrderId, parent.id));
        const deferred = computeDeferredItems(
          estItems.map(i => ({
            partId: i.partId,
            partName: i.partName,
            partPrice: i.partPrice,
            quantity: i.quantity,
            laborHours: i.laborHours,
            controllerLetter: (i as any).controllerLetter ?? null,
            zoneNumber: (i as any).zoneNumber ?? null,
            issueType: (i as any).issueType ?? null,
          })),
          woItems.map(i => ({
            partName: i.partName,
            quantity: i.quantity,
            controllerLetter: (i as any).controllerLetter ?? null,
            zoneNumber: (i as any).zoneNumber ?? null,
            issueType: (i as any).issueType ?? null,
          })),
        );
        deferredCount = deferred.length;
        deferredHours = deferred.reduce((s, d) => s + parseFloat(d.laborHours || '0'), 0);
        const ctrlDist = new Map<string, number>();
        for (const d of deferred) {
          const k = d.controllerLetter ?? '(none)';
          ctrlDist.set(k, (ctrlDist.get(k) ?? 0) + 1);
        }
        warnings.push(`Deferred items found: ${deferredCount} lines, ${deferredHours.toFixed(2)} hours`);
        for (const [ctrl, cnt] of [...ctrlDist.entries()].sort()) {
          warnings.push(`  Controller ${ctrl}: ${cnt} item(s)`);
        }
      } else {
        warnings.push("WARNING: Parent WO has no estimateId — cannot compute deferred items. Migration would be a no-op.");
      }
    } else {
      warnings.push(`WARNING: ${PARENT_WO_NUMBER} not found in this database (may not be production).`);
    }
  }

  return {
    steps,
    orphanRows: { deferredItems: deferredCount, deferredHours: Math.round(deferredHours * 100) / 100 },
    warnings,
  };
}

// ── run ──────────────────────────────────────────────────────────────────────

async function run(emit: ProgressEmitter, opts?: MigrationRunOptions): Promise<MigrationStepResult[]> {
  const results: MigrationStepResult[] = [];

  // ── Step 1: Verify column ────────────────────────────────────────────────
  const t1 = Date.now();
  emit({ step: 'verify-column', status: 'running' });
  if (!(opts?.acknowledged)) {
    const err = "acknowledged=true is required to run this migration (creates production work order records).";
    emit({ step: 'verify-column', status: 'failed', error: err });
    results.push({ id: 'verify-column', status: 'failed', durationMs: 0, error: err });
    return results;
  }
  if (!(await parentWoColumnExists())) {
    const err = "Column parent_work_order_id does not exist. Run `pnpm --filter @workspace/db run push` first.";
    emit({ step: 'verify-column', status: 'failed', error: err });
    results.push({ id: 'verify-column', status: 'failed', durationMs: Date.now() - t1, error: err });
    return results;
  }
  emit({ step: 'verify-column', status: 'success' });
  results.push({ id: 'verify-column', status: 'success', durationMs: Date.now() - t1 });

  // ── Step 2: Find parent WO ───────────────────────────────────────────────
  const t2 = Date.now();
  emit({ step: 'find-parent-wo', status: 'running' });
  const parent = await findParentWo();
  if (!parent) {
    const err = `Work order ${PARENT_WO_NUMBER} (company_id=${COMPANY_ID}) not found. This migration only applies to the production database.`;
    emit({ step: 'find-parent-wo', status: 'failed', error: err });
    results.push({ id: 'find-parent-wo', status: 'failed', durationMs: Date.now() - t2, error: err });
    return results;
  }
  const fu = await existingFollowUp(parent.id);
  if (fu) {
    const skip = `Follow-up #${fu.id} already exists — skipping creation (idempotent).`;
    emit({ step: 'find-parent-wo', status: 'skipped', rowsAffected: 0 });
    results.push({ id: 'find-parent-wo', status: 'skipped', durationMs: Date.now() - t2, error: skip });
    // Mark done and return
    await db.insert(appSettings)
      .values({ key: APP_KEY, value: { completedAt: new Date().toISOString(), followUpId: fu.id, skipped: true } as any })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { completedAt: new Date().toISOString(), followUpId: fu.id, skipped: true } as any, updatedAt: new Date() } as any });
    emit({ step: 'create-followup', status: 'skipped' });
    results.push({ id: 'create-followup', status: 'skipped', durationMs: 0 });
    return results;
  }
  if (!parent.estimateId) {
    const err = `${PARENT_WO_NUMBER} has no estimateId — cannot compute deferred items.`;
    emit({ step: 'find-parent-wo', status: 'failed', error: err });
    results.push({ id: 'find-parent-wo', status: 'failed', durationMs: Date.now() - t2, error: err });
    return results;
  }
  emit({ step: 'find-parent-wo', status: 'success' });
  results.push({ id: 'find-parent-wo', status: 'success', durationMs: Date.now() - t2 });

  // ── Step 3: Compute deferred items ────────────────────────────────────────
  const t3 = Date.now();
  emit({ step: 'compute-deferred', status: 'running' });
  const estItems = await db.select().from(estimateItems).where(eq(estimateItems.estimateId, parent.estimateId));
  const woItemRows = await db.select().from(workOrderItems).where(eq(workOrderItems.workOrderId, parent.id));
  const deferred = computeDeferredItems(
    estItems.map(i => ({
      partId: i.partId,
      partName: i.partName,
      partPrice: i.partPrice,
      quantity: i.quantity,
      laborHours: i.laborHours,
      controllerLetter: (i as any).controllerLetter ?? null,
      zoneNumber: (i as any).zoneNumber ?? null,
      issueType: (i as any).issueType ?? null,
    })),
    woItemRows.map(i => ({
      partName: i.partName,
      quantity: i.quantity,
      controllerLetter: (i as any).controllerLetter ?? null,
      zoneNumber: (i as any).zoneNumber ?? null,
      issueType: (i as any).issueType ?? null,
    })),
  );
  if (deferred.length === 0) {
    const skip = "No deferred items computed — estimate and WO items match exactly. No follow-up needed.";
    emit({ step: 'compute-deferred', status: 'skipped', rowsAffected: 0 });
    results.push({ id: 'compute-deferred', status: 'skipped', durationMs: Date.now() - t3, error: skip });
    emit({ step: 'create-followup', status: 'skipped' });
    results.push({ id: 'create-followup', status: 'skipped', durationMs: 0 });
    return results;
  }
  emit({ step: 'compute-deferred', status: 'success', rowsAffected: deferred.length });
  results.push({ id: 'compute-deferred', status: 'success', durationMs: Date.now() - t3, rowsAffected: deferred.length });

  // ── Step 4: Create follow-up WO ────────────────────────────────────────────
  const t4 = Date.now();
  emit({ step: 'create-followup', status: 'running' });

  // Look up the parent WO details for the follow-up header.
  const [parentRow] = await db.select().from(workOrders).where(
    and(eq(workOrders.id, parent.id), eq(workOrders.companyId, COMPANY_ID)),
  );
  if (!parentRow) {
    const err = `Failed to reload parent WO #${parent.id} details.`;
    emit({ step: 'create-followup', status: 'failed', error: err });
    results.push({ id: 'create-followup', status: 'failed', durationMs: Date.now() - t4, error: err });
    return results;
  }

  const totalHours = deferred.reduce((s, d) => s + money(d.laborHours), 0);
  const workOrderNumber = `WO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  // Build findingId lookup from the prior WO items.
  const findingByKey = new Map<string, number | null>();
  for (const item of woItemRows) {
    const key = [
      item.partName,
      (item as any).controllerLetter ?? '',
      (item as any).zoneNumber ?? '',
      (item as any).issueType ?? '',
    ].join('\x01');
    if (!findingByKey.has(key)) {
      findingByKey.set(key, (item as any).findingId ?? null);
    }
  }

  try {
    // Wrap header + items in a transaction so a failed item write rolls back
    // the header rather than leaving an orphan that blocks future 23505 retries.
    const followUpRow = await db.transaction(async (tx) => {
      const [row] = await tx.insert(workOrders).values({
        workOrderNumber,
        estimateId: null,
        parentWorkOrderId: parent.id,
        customerId: parentRow.customerId,
        companyId: parentRow.companyId,
        customerName: parentRow.customerName,
        customerEmail: parentRow.customerEmail,
        customerPhone: parentRow.customerPhone,
        projectName: parentRow.projectName,
        projectAddress: parentRow.projectAddress,
        workType: (parentRow as any).workType ?? 'estimate_based',
        status: 'pending',
        priority: 'medium',
        description: `Follow-up for ${PARENT_WO_NUMBER}: carries 18 deferred items (${totalHours.toFixed(2)} hours) from the original Woodglenn Squares HOA inspection.`,
        branchName: (parentRow as any).branchName ?? null,
        originWetCheckId: (parentRow as any).originWetCheckId ?? null,
        totalHours: totalHours.toFixed(2),
        laborMode: 'per_part',
        totalAmount: '0.00',
        laborSubtotal: '0.00',
        partsSubtotal: '0.00',
      } as any).returning();

      for (const item of deferred) {
        const key = [
          item.partName,
          item.controllerLetter ?? '',
          item.zoneNumber ?? '',
          item.issueType ?? '',
        ].join('\x01');
        const findingId = findingByKey.get(key) ?? null;
        const qty = item.quantity;
        const unitPrice = money(item.partPrice);
        await tx.insert(workOrderItems).values({
          workOrderId: row.id,
          partId: item.partId,
          partName: item.partName,
          partPrice: item.partPrice,
          quantity: qty,
          laborHours: item.laborHours,
          totalPrice: (qty * unitPrice).toFixed(2),
          controllerLetter: item.controllerLetter,
          zoneNumber: item.zoneNumber,
          issueType: item.issueType,
          findingId,
        } as any);
      }

      return row;
    });

    // Stamp completion marker outside the transaction (non-critical bookkeeping).
    await db.insert(appSettings)
      .values({ key: APP_KEY, value: { completedAt: new Date().toISOString(), followUpId: followUpRow.id, deferredCount: deferred.length } as any })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { completedAt: new Date().toISOString(), followUpId: followUpRow.id, deferredCount: deferred.length } as any, updatedAt: new Date() } as any });

    logger.info({ followUpId: followUpRow.id, parentWoId: parent.id, deferredCount: deferred.length }, 'Woodglenn follow-up WO created by migration');
    emit({ step: 'create-followup', status: 'success', rowsAffected: deferred.length });
    results.push({ id: 'create-followup', status: 'success', durationMs: Date.now() - t4, rowsAffected: deferred.length });
  } catch (err: unknown) {
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      // Race: another process created the follow-up concurrently.
      const fu2 = await existingFollowUp(parent.id);
      const msg = `Follow-up already created by a concurrent process (23505) — existing id: ${fu2?.id ?? 'unknown'}.`;
      emit({ step: 'create-followup', status: 'skipped', rowsAffected: 0 });
      results.push({ id: 'create-followup', status: 'skipped', durationMs: Date.now() - t4, error: msg });
    } else {
      const errMsg = String((err as Error).message ?? err);
      emit({ step: 'create-followup', status: 'failed', error: errMsg });
      results.push({ id: 'create-followup', status: 'failed', durationMs: Date.now() - t4, error: errMsg });
    }
  }

  return results;
}

export const createWoodglennFollowupMigration: MigrationDefinition = {
  id: MIGRATION_ID,
  title: 'Create follow-up work order for Woodglenn WO-1783955816671-314',
  description:
    "Diffs the completed Woodglenn Squares HOA inspection work order against its originating " +
    "estimate (50017) and creates a follow-up work order carrying the 18 deferred items " +
    "(17 × qty=1 + 1 × qty=2 = 19 units, 22.50 hours) across controllers A, C, D, E, F, I, J. " +
    "Idempotent via the partial unique index on parent_work_order_id.",
  appSettingsKey: APP_KEY,
  check,
  preview,
  run,
};
