// Admin migration: seed irrigation_controllers + irrigation_profile_zones from property_controllers.
//
// Two passes are run:
//
// Pass 1 — Seed: For every (companyId, customerId, branchName) tuple that has
// property_controllers rows but no irrigation_controllers rows at all, create one
// irrigation_controllers row per legacy controller (named "Controller {letter}") with
// totalZones = zoneCount from property_controllers. Also seeds irrigation_profile_zones
// placeholder rows (zone numbers 1…zoneCount) per controller.
//
// Pass 2 — Backfill (mismatch repair): For every irrigation_controllers row whose
// total_zones IS DISTINCT FROM the authoritative zone_count in property_controllers
// (covers both null values and wrong non-null values written by the old lazy-seed),
// look up the matching property_controllers row (same company/customer/branch/letter)
// and update total_zones to the correct count + sync irrigation_profile_zones: insert
// missing trailing zone placeholders up to the new count, and remove trailing zones
// beyond the new count only if they carry no programs, run-times, or notes (data
// zones are never removed).
//
// Both inserts use ON CONFLICT DO NOTHING so concurrent or repeated calls are safe.
// Does not modify property_controllers.

import { db } from '../../db';
import { sql } from 'drizzle-orm';
import type {
  MigrationDefinition,
  MigrationStatus,
  MigrationPreview,
  MigrationStep,
  MigrationStepResult,
  ProgressEmitter,
} from './types';

const MIGRATION_ID = 'import-irrigation-profile-from-property-controllers-v1';
const MIGRATION_KEY = MIGRATION_ID;

// ── Types ──────────────────────────────────────────────────────────────────────

type LegacyControllerRow = {
  companyId: number;
  customerId: number;
  branchName: string;
  controllerLetter: string;
  zoneCount: number;
};

type BackfillRow = {
  irrigationControllerId: number;
  companyId: number;
  customerId: number;
  branchName: string;
  controllerLetter: string;
  zoneCount: number;
  currentTotalZones: number | null;
};

type TupleKey = string;

function tupleKey(r: LegacyControllerRow): TupleKey {
  return `${r.companyId}:${r.customerId}:${r.branchName}`;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

/**
 * Pass 1 — Load all property_controllers rows whose (companyId, customerId, branchName)
 * tuple has no irrigation_controllers row yet.
 */
async function loadSeedCandidates(): Promise<LegacyControllerRow[]> {
  const result = await db.execute<{
    company_id: string;
    customer_id: string;
    branch_name: string;
    controller_letter: string;
    zone_count: string;
  }>(sql`
    SELECT
      pc.company_id,
      pc.customer_id,
      pc.branch_name,
      pc.controller_letter,
      pc.zone_count
    FROM property_controllers pc
    WHERE NOT EXISTS (
      SELECT 1
      FROM irrigation_controllers ic
      WHERE ic.company_id  = pc.company_id
        AND ic.customer_id = pc.customer_id
        AND ic.branch_name = pc.branch_name
    )
    ORDER BY pc.company_id, pc.customer_id, pc.branch_name, pc.controller_letter
  `);

  return result.rows.map((r) => ({
    companyId: Number(r.company_id),
    customerId: Number(r.customer_id),
    branchName: String(r.branch_name),
    controllerLetter: String(r.controller_letter),
    zoneCount: Number(r.zone_count),
  }));
}

/**
 * Pass 2 — Load irrigation_controllers rows whose total_zones IS DISTINCT FROM the
 * authoritative zone_count in the matching property_controllers row (same
 * company/customer/branch, letter extracted from the last word of the controller name).
 * This catches both null values and wrong non-null values (e.g. a lazy-seed that wrote
 * an incorrect count).
 */
async function loadBackfillCandidates(): Promise<BackfillRow[]> {
  const result = await db.execute<{
    ic_id: string;
    company_id: string;
    customer_id: string;
    branch_name: string;
    controller_letter: string;
    zone_count: string;
    current_total_zones: string | null;
  }>(sql`
    SELECT
      ic.id            AS ic_id,
      ic.company_id,
      ic.customer_id,
      ic.branch_name,
      pc.controller_letter,
      pc.zone_count,
      ic.total_zones   AS current_total_zones
    FROM irrigation_controllers ic
    JOIN property_controllers pc
      ON  pc.company_id        = ic.company_id
      AND pc.customer_id       = ic.customer_id
      AND pc.branch_name       = ic.branch_name
      AND pc.controller_letter = upper(right(trim(ic.name), 1))
    WHERE ic.total_zones IS DISTINCT FROM pc.zone_count
    ORDER BY ic.company_id, ic.customer_id, ic.branch_name, ic.name
  `);

  return result.rows.map((r) => ({
    irrigationControllerId: Number(r.ic_id),
    companyId: Number(r.company_id),
    customerId: Number(r.customer_id),
    branchName: String(r.branch_name),
    controllerLetter: String(r.controller_letter),
    zoneCount: Number(r.zone_count),
    currentTotalZones: r.current_total_zones == null ? null : Number(r.current_total_zones),
  }));
}

/**
 * Pass 1: seed one irrigation_controllers row for a legacy controller, plus
 * irrigation_profile_zones placeholder rows 1..zoneCount.
 * Uses ON CONFLICT DO NOTHING — race-safe.
 */
async function seedController(row: LegacyControllerRow): Promise<void> {
  const controllerName = `Controller ${row.controllerLetter}`;

  // Task #1856: include `letter` (NOT NULL + unique) from the legacy
  // controllerLetter field so this migration does not violate the new constraint.
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO irrigation_controllers
      (company_id, customer_id, branch_name, name, letter, total_zones, is_active, created_at, updated_at)
    VALUES
      (${row.companyId}, ${row.customerId}, ${row.branchName}, ${controllerName}, ${row.controllerLetter}, ${row.zoneCount}, true, NOW(), NOW())
    ON CONFLICT (company_id, customer_id, branch_name, name) DO NOTHING
    RETURNING id
  `);

  let controllerId: number;
  if (inserted.rows.length > 0) {
    controllerId = Number((inserted.rows[0] as { id: string }).id);
  } else {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id FROM irrigation_controllers
      WHERE company_id  = ${row.companyId}
        AND customer_id = ${row.customerId}
        AND branch_name = ${row.branchName}
        AND name        = ${controllerName}
    `);
    if (existing.rows.length === 0) return;
    controllerId = Number((existing.rows[0] as { id: string }).id);
  }

  for (let z = 1; z <= row.zoneCount; z++) {
    const zoneName = `Zone ${z}`;
    await db.execute(sql`
      INSERT INTO irrigation_profile_zones
        (company_id, controller_id, zone_number, name, zone_type, run_time_minutes, zone_order, is_active, created_at, updated_at)
      VALUES
        (${row.companyId}, ${controllerId}, ${z}, ${zoneName}, 'other', 0, ${z}, true, NOW(), NOW())
      ON CONFLICT (company_id, controller_id, zone_number) DO NOTHING
    `);
  }
}

/**
 * Pass 2: fix total_zones on an existing irrigation_controllers row (overwrites any
 * value — null or a wrong number), then sync irrigation_profile_zones:
 *   - Insert missing trailing zone placeholders up to the new count.
 *   - Remove trailing zone rows beyond the new count ONLY if they have no
 *     program assignment, non-zero run time, or notes (data zones are kept).
 */
async function backfillController(row: BackfillRow): Promise<void> {
  // 1. Stamp the correct zone count on the controller row (overwrites null or wrong value).
  await db.execute(sql`
    UPDATE irrigation_controllers
    SET total_zones = ${row.zoneCount}, updated_at = NOW()
    WHERE id = ${row.irrigationControllerId}
  `);

  // 2. Insert any missing placeholder zone rows up to the new count.
  for (let z = 1; z <= row.zoneCount; z++) {
    const zoneName = `Zone ${z}`;
    await db.execute(sql`
      INSERT INTO irrigation_profile_zones
        (company_id, controller_id, zone_number, name, zone_type, run_time_minutes, zone_order, is_active, created_at, updated_at)
      VALUES
        (${row.companyId}, ${row.irrigationControllerId}, ${z}, ${zoneName}, 'other', 0, ${z}, true, NOW(), NOW())
      ON CONFLICT (company_id, controller_id, zone_number) DO NOTHING
    `);
  }

  // 3. Remove trailing empty zone rows beyond the new count (data zones are kept).
  await db.execute(sql`
    DELETE FROM irrigation_profile_zones
    WHERE controller_id = ${row.irrigationControllerId}
      AND zone_number   > ${row.zoneCount}
      AND program_id    IS NULL
      AND (run_time_minutes IS NULL OR run_time_minutes = 0)
      AND (notes IS NULL OR notes = '')
  `);
}

async function markDone(): Promise<void> {
  await db.execute(sql`
    INSERT INTO app_settings (key, value)
    VALUES (${MIGRATION_KEY}, 'completed')
    ON CONFLICT (key) DO UPDATE SET value = 'completed', updated_at = NOW()
  `);
}

// ── check / preview / run ─────────────────────────────────────────────────────

async function check(): Promise<MigrationStatus> {
  try {
    const [seedCandidates, backfillCandidates] = await Promise.all([
      loadSeedCandidates(),
      loadBackfillCandidates(),
    ]);

    const pending = seedCandidates.length + backfillCandidates.length;

    if (pending === 0) {
      const marker = await db.execute(
        sql`SELECT updated_at FROM app_settings WHERE key = ${MIGRATION_KEY}`,
      );
      const completedAt = marker.rows.length > 0
        ? String((marker.rows[0] as { updated_at?: unknown }).updated_at ?? '')
        : '';
      return { state: 'completed', completedAt };
    }

    const marker = await db.execute(
      sql`SELECT value FROM app_settings WHERE key = ${MIGRATION_KEY}`,
    );
    if (marker.rows.length > 0) {
      const tupleSeedCount = new Set(seedCandidates.map(tupleKey)).size;
      return {
        state: 'partially_applied',
        details:
          `${tupleSeedCount} customer/branch tuple(s) need seeding; ` +
          `${backfillCandidates.length} controller(s) have wrong/missing zone counts`,
      };
    }
    return { state: 'not_started' };
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    return { state: 'error', details };
  }
}

async function preview(): Promise<MigrationPreview> {
  const [seedCandidates, backfillCandidates] = await Promise.all([
    loadSeedCandidates(),
    loadBackfillCandidates(),
  ]);

  const byTuple = new Map<TupleKey, LegacyControllerRow[]>();
  for (const r of seedCandidates) {
    const k = tupleKey(r);
    if (!byTuple.has(k)) byTuple.set(k, []);
    byTuple.get(k)!.push(r);
  }

  const steps: MigrationStep[] = [];

  for (const [, rows] of byTuple) {
    const first = rows[0]!;
    const letters = rows.map((r) => r.controllerLetter).join(', ');
    const totalZones = rows.reduce((s, r) => s + r.zoneCount, 0);
    steps.push({
      id: tupleKey(first),
      description:
        `[Seed] Customer ${first.customerId} (company ${first.companyId})` +
        (first.branchName ? ` branch "${first.branchName}"` : '') +
        `: seed ${rows.length} controller(s) [${letters}] → ${totalZones} total zone placeholder(s)`,
    });
  }

  for (const row of backfillCandidates) {
    const oldValue = row.currentTotalZones == null ? 'null' : String(row.currentTotalZones);
    steps.push({
      id: `backfill:${row.irrigationControllerId}`,
      description:
        `[Backfill] Controller #${row.irrigationControllerId} (customer ${row.customerId}, company ${row.companyId})` +
        (row.branchName ? ` branch "${row.branchName}"` : '') +
        `: set totalZones = ${row.zoneCount} (was ${oldValue}) and sync zone placeholders`,
    });
  }

  const warnings: string[] = [];
  if (steps.length === 0) {
    warnings.push('All controllers already have zone counts and profiles — nothing to do.');
  } else {
    if (byTuple.size > 0) {
      warnings.push(
        `Will seed irrigation_controllers rows for ${byTuple.size} customer/branch tuple(s). ` +
        'Uses ON CONFLICT DO NOTHING — safe to re-run. ' +
        'Zone placeholder rows (irrigation_profile_zones) will also be created. ' +
        'property_controllers is not modified.',
      );
    }
    if (backfillCandidates.length > 0) {
      warnings.push(
        `Will fix totalZones on ${backfillCandidates.length} controller(s) with wrong/missing zone counts. ` +
        'Empty trailing zone rows beyond the real count will be removed; zones with data are kept.',
      );
    }
  }

  return {
    steps,
    orphanRows: { customersWithoutProfile: byTuple.size, controllersWithWrongZoneCount: backfillCandidates.length },
    warnings,
  };
}

async function run(emit: ProgressEmitter): Promise<MigrationStepResult[]> {
  const [seedCandidates, backfillCandidates] = await Promise.all([
    loadSeedCandidates(),
    loadBackfillCandidates(),
  ]);

  const byTuple = new Map<TupleKey, LegacyControllerRow[]>();
  for (const r of seedCandidates) {
    const k = tupleKey(r);
    if (!byTuple.has(k)) byTuple.set(k, []);
    byTuple.get(k)!.push(r);
  }

  const results: MigrationStepResult[] = [];

  if (byTuple.size === 0 && backfillCandidates.length === 0) {
    results.push({ id: 'seed_summary', status: 'skipped', durationMs: 0, rowsAffected: 0 });
    emit({ step: 'seed_summary', status: 'skipped', rowsAffected: 0 });
    await markDone();
    return results;
  }

  let seeded = 0;
  let seedErrors = 0;

  for (const [k, rows] of byTuple) {
    const t = Date.now();
    emit({ step: k, status: 'running' });

    let tupleSeeded = 0;
    let tupleError: string | undefined;

    for (const row of rows) {
      try {
        await seedController(row);
        tupleSeeded++;
        seeded++;
      } catch (err) {
        seedErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        tupleError = tupleError ? `${tupleError}; ${msg}` : msg;
      }
    }

    if (tupleError) {
      results.push({
        id: k,
        status: 'failed',
        durationMs: Date.now() - t,
        rowsAffected: tupleSeeded,
        error: tupleError,
      });
      emit({ step: k, status: 'failed', rowsAffected: tupleSeeded, error: tupleError });
    } else {
      results.push({ id: k, status: 'success', durationMs: Date.now() - t, rowsAffected: tupleSeeded });
      emit({ step: k, status: 'success', rowsAffected: tupleSeeded });
    }
  }

  const seedSummaryStatus = seedErrors > 0 ? 'failed' : 'success';
  results.push({ id: 'seed_summary', status: seedSummaryStatus, durationMs: 0, rowsAffected: seeded });
  emit({ step: 'seed_summary', status: seedSummaryStatus, rowsAffected: seeded });

  // Pass 2 — Repair mismatched/null totalZones.
  let backfilled = 0;
  let backfillErrors = 0;

  for (const row of backfillCandidates) {
    const stepId = `backfill:${row.irrigationControllerId}`;
    const t = Date.now();
    emit({ step: stepId, status: 'running' });
    try {
      await backfillController(row);
      backfilled++;
      results.push({ id: stepId, status: 'success', durationMs: Date.now() - t, rowsAffected: 1 });
      emit({ step: stepId, status: 'success', rowsAffected: 1 });
    } catch (err) {
      backfillErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id: stepId, status: 'failed', durationMs: Date.now() - t, rowsAffected: 0, error: msg });
      emit({ step: stepId, status: 'failed', rowsAffected: 0, error: msg });
    }
  }

  if (backfillCandidates.length > 0) {
    const backfillSummaryStatus = backfillErrors > 0 ? 'failed' : 'success';
    results.push({ id: 'backfill_summary', status: backfillSummaryStatus, durationMs: 0, rowsAffected: backfilled });
    emit({ step: 'backfill_summary', status: backfillSummaryStatus, rowsAffected: backfilled });
  }

  if (seedErrors === 0 && backfillErrors === 0) {
    await markDone();
  }

  return results;
}

export const importIrrigationProfileMigration: MigrationDefinition = {
  id: MIGRATION_ID,
  title: 'Seed irrigation profiles from legacy property controller data',
  description:
    'Pass 1: For every customer that has property_controllers rows but no irrigation_controllers rows, ' +
    'creates one irrigation_controllers row per legacy controller (named "Controller {letter}") ' +
    'with totalZones = the legacy zoneCount. Also seeds irrigation_profile_zones placeholder rows ' +
    '(zone numbers 1…zoneCount) per controller. ' +
    'Pass 2 (mismatch repair): For every existing irrigation_controllers row whose total_zones ' +
    'IS DISTINCT FROM the authoritative zone_count in property_controllers (covers both null values ' +
    'and wrong non-null values written by the old lazy-seed), looks up the matching ' +
    'property_controllers row and corrects total_zones + syncs zone placeholders (adds missing ' +
    'trailing zones; removes empty trailing zones beyond the count — data zones are never deleted). ' +
    'Both passes use ON CONFLICT DO NOTHING — idempotent and race-safe. Does not modify property_controllers.',
  appSettingsKey: MIGRATION_KEY,
  check,
  preview,
  run,
};
