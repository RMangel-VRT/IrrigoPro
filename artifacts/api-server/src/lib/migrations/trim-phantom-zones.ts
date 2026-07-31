// Harden phantom-zone trim — admin migration wrapper for the isEmptyZone-guarded
// delete of wet-check zone records that exceed a controller's current zoneCount.
//
// Background: before the fix, `ensurePropertyControllers` seeded controllers
// with zoneCount=100, causing 100 `not_checked` zone records to be created per
// controller even when the real controller had far fewer zones. These phantom
// rows inflate PDF zone counts. The CLI script
// (`scripts/backfill-trim-phantom-zones.ts`) performs the same cleanup but
// requires terminal access. This migration wraps the same logic into the admin
// framework so Randy can run it from /admin/migrations with a preview + ack gate.
//
// Safety guard: a zone is only deleted when BOTH hold:
//   1. zoneNumber > controller's current zoneCount (it's a phantom)
//   2. isEmptyZone(zone) === true — no notes, PSI/GPM, findings, ranSuccessfully,
//      or non-zero repairLaborHours. This matches the PDF renderer's predicate so
//      a zone that appears in PDFs is never deleted.
//
// The acknowledgement gate (orphanRows.phantomZones > 0) forces the operator to
// read the hard-delete warning before Run is enabled.

import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { isEmptyZone } from '../../wet-check-zone-filter';
import type {
  MigrationDefinition,
  MigrationStatus,
  MigrationPreview,
  MigrationStep,
  MigrationStepResult,
  ProgressEmitter,
} from './types';

const MIGRATION_ID = 'trim-phantom-zones-v1';
const MIGRATION_KEY = MIGRATION_ID;

// ── Shared types ──────────────────────────────────────────────────────────────

export type PhantomZoneRow = {
  id: number;
  wetCheckId: number;
  controllerLetter: string;
  zoneNumber: number;
  zoneCount: number;
  status: string | null;
  observedPressure: string | null;
  observedFlow: string | null;
  ranSuccessfully: boolean | null;
  notes: string | null;
  repairLaborHours: string | null;
  findingCount: number;
};

export type TrimPhantomZonesDeps = {
  getCandidates: () => Promise<PhantomZoneRow[]>;
  deleteZone: (id: number) => Promise<void>;
  markDone: () => Promise<void>;
};

// ── DB helpers ─────────────────────────────────────────────────────────────────

/**
 * Load all wet-check zone records whose zoneNumber exceeds the controller's
 * current zoneCount, joined with finding counts. The isEmptyZone filter is
 * then applied in JS so the guard logic stays in one canonical place.
 */
async function loadCandidates(): Promise<PhantomZoneRow[]> {
  const result = await db.execute<{
    id: number;
    wet_check_id: number;
    controller_letter: string;
    zone_number: number;
    zone_count: number;
    status: string | null;
    observed_pressure: string | null;
    observed_flow: string | null;
    ran_successfully: boolean | null;
    notes: string | null;
    repair_labor_hours: string | null;
    finding_count: string;
  }>(sql`
    -- Task #1857: property_controllers dropped; resolve via irrigation_controllers
    -- keyed by controller_id (preferred) or letter+scope (fallback).
    SELECT
      wcz.id,
      wcz.wet_check_id,
      wcz.controller_letter,
      wcz.zone_number,
      ic.total_zones AS zone_count,
      wcz.status,
      wcz.observed_pressure,
      wcz.observed_flow,
      wcz.ran_successfully,
      wcz.notes,
      wcz.repair_labor_hours,
      COALESCE(fc.cnt, 0) AS finding_count
    FROM wet_check_zone_records wcz
    JOIN wet_checks wc ON wc.id = wcz.wet_check_id
    JOIN irrigation_controllers ic
      ON ic.id = COALESCE(
           wcz.controller_id,
           (SELECT ic2.id FROM irrigation_controllers ic2
            WHERE ic2.company_id  = wc.company_id
              AND ic2.customer_id = wc.customer_id
              AND COALESCE(ic2.branch_name, '') = COALESCE(TRIM(wc.branch_name), '')
              AND ic2.letter = wcz.controller_letter
            LIMIT 1)
         )
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM wet_check_findings
      WHERE zone_record_id = wcz.id
    ) fc ON true
    WHERE wcz.status = 'not_checked'
      AND wcz.zone_number > ic.total_zones
    ORDER BY wc.id, wcz.id
  `);

  return result.rows.map((r) => ({
    id: Number(r.id),
    wetCheckId: Number(r.wet_check_id),
    controllerLetter: String(r.controller_letter),
    zoneNumber: Number(r.zone_number),
    zoneCount: Number(r.zone_count),
    status: r.status,
    observedPressure: r.observed_pressure,
    observedFlow: r.observed_flow,
    ranSuccessfully: r.ran_successfully,
    notes: r.notes,
    repairLaborHours: r.repair_labor_hours,
    findingCount: Number(r.finding_count),
  }));
}

function makeDbDeps(): TrimPhantomZonesDeps {
  return {
    getCandidates: loadCandidates,
    deleteZone: async (id) => {
      await db.execute(sql`DELETE FROM wet_check_zone_records WHERE id = ${id}`);
    },
    markDone: async () => {
      await db.execute(sql`
        INSERT INTO app_settings (key, value)
        VALUES (${MIGRATION_KEY}, 'completed')
        ON CONFLICT (key) DO UPDATE SET value = 'completed', updated_at = NOW()
      `);
    },
  };
}

// ── isEmptyZone adapter ────────────────────────────────────────────────────────

function rowIsEmpty(row: PhantomZoneRow): boolean {
  return isEmptyZone({
    status: row.status,
    findings: row.findingCount > 0 ? [{}] : [],
    observedPressure: row.observedPressure,
    observedFlow: row.observedFlow,
    ranSuccessfully: row.ranSuccessfully,
    notes: row.notes,
    repairLaborHours: row.repairLaborHours,
  });
}

// ── Pure preview builder (exported for tests) ─────────────────────────────────

export function buildTrimPhantomZonesPreview(candidates: PhantomZoneRow[]): MigrationPreview {
  // Filter to only truly-empty zones (the isEmptyZone guard).
  const trimmable = candidates.filter(rowIsEmpty);

  // Group by wet check for readable preview steps.
  const byWetCheck = new Map<number, { controllerLetter: string; zones: PhantomZoneRow[] }[]>();
  for (const zone of trimmable) {
    if (!byWetCheck.has(zone.wetCheckId)) byWetCheck.set(zone.wetCheckId, []);
    const buckets = byWetCheck.get(zone.wetCheckId)!;
    let bucket = buckets.find((b) => b.controllerLetter === zone.controllerLetter);
    if (!bucket) {
      bucket = { controllerLetter: zone.controllerLetter, zones: [] };
      buckets.push(bucket);
    }
    bucket.zones.push(zone);
  }

  const steps: MigrationStep[] = [];
  for (const [wetCheckId, groups] of byWetCheck) {
    for (const group of groups) {
      const zoneCount = group.zones[0]?.zoneCount ?? 0;
      steps.push({
        id: `wc_${wetCheckId}_ctrl_${group.controllerLetter}`,
        description:
          `Wet check #${wetCheckId}, controller ${group.controllerLetter}: ` +
          `delete ${group.zones.length} phantom zone record(s) ` +
          `(zone numbers ${group.zones.map((z) => z.zoneNumber).sort((a, b) => a - b).join(', ')} ` +
          `exceed controller's current zone count of ${zoneCount})`,
      });
    }
  }

  const warnings: string[] = [];
  if (trimmable.length === 0) {
    warnings.push(
      'No trimmable phantom zones found — all not_checked zones beyond the zone count ' +
      'carry real data (notes, PSI/GPM, findings, or repairLaborHours) and will be preserved.',
    );
  } else {
    warnings.push(
      `PERMANENT HARD DELETE: ${trimmable.length} phantom zone record(s) across ` +
      `${byWetCheck.size} wet check(s) will be permanently deleted. ` +
      'Only truly-empty zones are included (no notes, PSI/GPM readings, findings, ' +
      'or non-zero repairLaborHours). This operation cannot be undone. ' +
      'Acknowledge to proceed.',
    );
  }

  return {
    steps,
    orphanRows: { phantomZones: trimmable.length },
    warnings,
  };
}

// ── Deps-injectable runner (exported for tests) ────────────────────────────────

export async function runTrimPhantomZonesMigration(
  deps: TrimPhantomZonesDeps,
  emit: ProgressEmitter,
): Promise<MigrationStepResult[]> {
  const results: MigrationStepResult[] = [];
  const candidates = await deps.getCandidates();
  const trimmable = candidates.filter(rowIsEmpty);

  if (trimmable.length === 0) {
    results.push({
      id: 'trim_summary',
      status: 'skipped',
      durationMs: 0,
      rowsAffected: 0,
    });
    emit({ step: 'trim_summary', status: 'skipped', rowsAffected: 0 });
    await deps.markDone();
    return results;
  }

  // Process wet-check by wet-check, emitting one progress event per wet check.
  const byWetCheck = new Map<number, PhantomZoneRow[]>();
  for (const zone of trimmable) {
    if (!byWetCheck.has(zone.wetCheckId)) byWetCheck.set(zone.wetCheckId, []);
    byWetCheck.get(zone.wetCheckId)!.push(zone);
  }

  let deleted = 0;
  let errors = 0;

  for (const [wetCheckId, zones] of byWetCheck) {
    const stepId = `wc_${wetCheckId}`;
    const t = Date.now();
    emit({ step: stepId, status: 'running' });

    let wcDeleted = 0;
    let wcError: string | undefined;

    for (const zone of zones) {
      try {
        await deps.deleteZone(zone.id);
        wcDeleted++;
        deleted++;
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        wcError = wcError ? `${wcError}; ${msg}` : msg;
      }
    }

    if (wcError) {
      results.push({ id: stepId, status: 'failed', durationMs: Date.now() - t, rowsAffected: wcDeleted, error: wcError });
      emit({ step: stepId, status: 'failed', rowsAffected: wcDeleted, error: wcError });
    } else {
      results.push({ id: stepId, status: 'success', durationMs: Date.now() - t, rowsAffected: wcDeleted });
      emit({ step: stepId, status: 'success', rowsAffected: wcDeleted });
    }
  }

  const summaryStatus = errors > 0 ? 'failed' : 'success';
  results.push({
    id: 'trim_summary',
    status: summaryStatus,
    durationMs: 0,
    rowsAffected: deleted,
    error: errors > 0 ? `${errors} zone record(s) failed to delete` : undefined,
  });
  emit({ step: 'trim_summary', status: summaryStatus, rowsAffected: deleted });

  if (errors === 0) {
    await deps.markDone();
  }

  return results;
}

// ── check / preview / run (framework contract) ─────────────────────────────────

async function check(): Promise<MigrationStatus> {
  try {
    const candidates = await loadCandidates();
    const trimmable = candidates.filter(rowIsEmpty);

    if (trimmable.length === 0) {
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
      return {
        state: 'partially_applied',
        details: `${trimmable.length} trimmable phantom zone record(s) remain`,
      };
    }
    return { state: 'not_started' };
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    return { state: 'error', details };
  }
}

async function preview(): Promise<MigrationPreview> {
  const candidates = await loadCandidates();
  return buildTrimPhantomZonesPreview(candidates);
}

async function run(emit: ProgressEmitter): Promise<MigrationStepResult[]> {
  return runTrimPhantomZonesMigration(makeDbDeps(), emit);
}

export const trimPhantomZonesMigration: MigrationDefinition = {
  id: MIGRATION_ID,
  title: 'Trim phantom wet-check zone records',
  description:
    'Permanently deletes wet-check zone records whose zoneNumber exceeds the ' +
    "controller's current zoneCount AND that carry no real data (no notes, PSI/GPM, " +
    'findings, or non-zero repairLaborHours). These phantom rows were created by a ' +
    'bug that seeded 100 zone records per controller regardless of actual zone count. ' +
    'Zones that carry any real data are preserved even when above the threshold. ' +
    'Idempotent — a clean re-run finds zero rows. HARD DELETE: cannot be undone.',
  appSettingsKey: MIGRATION_KEY,
  check,
  preview,
  run,
};
