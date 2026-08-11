// Trim orphan `not_checked` wet-check zone records that exceed a controller's
// current zoneCount AND carry no real data.
//
// Background: before this fix, `ensurePropertyControllers` seeded new
// property controllers with zoneCount=100. `ControllerSelectionPage` then
// created 100 zone records (status='not_checked') per controller even when
// the real controller had far fewer zones. This script deletes those phantom
// rows for every in-progress wet check, leaving only zone records whose
// zoneNumber is <= the controller's current zoneCount OR that carry real data.
//
// Safety guard — a zone is only deleted when BOTH conditions hold:
//   1. zoneNumber > controller's current zoneCount (it's beyond the range)
//   2. isEmptyZone(zone) === true — the zone carries no real data (no notes,
//      PSI/GPM readings, findings, or non-zero repairLaborHours). This matches
//      the same predicate used by the PDF renderer to decide which zones to
//      suppress, so a phantom zone with a note or pressure reading is preserved
//      even when it sits above the zone-count threshold.
//
// Scope:
//   - Only `not_checked` records are removed (isEmptyZone enforces this too).
//   - The script operates on all wet checks (any status) — even submitted or
//     converted ones may carry phantom rows that inflate PDF zone counts.
//   - Controllers with no matching `property_controllers` row are skipped
//     (safe-unknown situation).
//
// Idempotent: processed wet-check ids are stored in
//   app_settings.trimPhantomZones.done
// Any wet-check id that errors lands in
//   app_settings.trimPhantomZones.failed
//
// Run:
//   node --import tsx/esm \
//     artifacts/api-server/src/scripts/backfill-trim-phantom-zones.ts \
//     [--dry-run] [--batch=N]

try { (process.stdout as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle?.setBlocking?.(true); } catch {}
try { (process.stderr as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle?.setBlocking?.(true); } catch {}

import { db } from "../db";
import { wetChecks, wetCheckZoneRecords, irrigationControllers, appSettings } from "@workspace/db";
import { eq, and, gt, inArray, sql, isNotNull } from "drizzle-orm";
import { isEmptyZone } from "../wet-check-zone-filter";

const DONE_KEY = "trimPhantomZones.done";
const FAIL_KEY = "trimPhantomZones.failed";

function parseFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseArg(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const n = Number(raw.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function loadIdSet(key: string): Promise<Set<number>> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key));
  if (rows.length === 0) return new Set();
  try {
    const parsed = JSON.parse(String((rows[0] as { value: string }).value));
    if (Array.isArray(parsed)) {
      return new Set(
        parsed
          .map((v) => (typeof v === "number" ? v : Number(v)))
          .filter((n) => Number.isFinite(n)),
      );
    }
  } catch {
    // Corrupt value — start fresh.
  }
  return new Set();
}

async function saveIdSet(key: string, ids: Set<number>): Promise<void> {
  const value = JSON.stringify(Array.from(ids).sort((a, b) => a - b));
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

interface FailureEntry {
  id: number;
  error: string;
  at: string;
}

async function loadFailures(): Promise<FailureEntry[]> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, FAIL_KEY));
  if (rows.length === 0) return [];
  try {
    const parsed = JSON.parse(String((rows[0] as { value: string }).value));
    return Array.isArray(parsed) ? (parsed as FailureEntry[]) : [];
  } catch {
    return [];
  }
}

async function appendFailure(entry: FailureEntry): Promise<void> {
  const existing = await loadFailures();
  const value = JSON.stringify([...existing, entry]);
  await db
    .insert(appSettings)
    .values({ key: FAIL_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

async function main(): Promise<void> {
  const dryRun = parseFlag("dry-run");
  const batchSize = parseArg("batch", 200);

  console.log(
    `[backfill-trim-phantom-zones] starting (dryRun=${dryRun}, batch=${batchSize})`,
  );

  const done = await loadIdSet(DONE_KEY);
  console.log(
    `[backfill-trim-phantom-zones] resume — ${done.size} wet-check ids already processed`,
  );

  let lastId = 0;
  let scanned = 0;
  let trimmed = 0;
  let skippedAlreadyDone = 0;
  let skippedNoPhantoms = 0;
  let failed = 0;

  for (;;) {
    // Fetch the next batch of wet-check ids that have at least one
    // not_checked zone record (any wet check status).
    const rows = await db
      .selectDistinct({ id: wetChecks.id })
      .from(wetChecks)
      .innerJoin(
        wetCheckZoneRecords,
        and(
          eq(wetCheckZoneRecords.wetCheckId, wetChecks.id),
          eq(wetCheckZoneRecords.status, "not_checked"),
        ),
      )
      .where(sql`${wetChecks.id} > ${lastId}`)
      .orderBy(wetChecks.id)
      .limit(batchSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      lastId = row.id;

      if (done.has(row.id)) {
        skippedAlreadyDone += 1;
        continue;
      }

      try {
        // Load the not_checked zone records for this wet check — fetch all
        // fields needed by isEmptyZone so the guard can make an accurate decision.
        const notCheckedZones = await db
          .select({
            id: wetCheckZoneRecords.id,
            controllerLetter: wetCheckZoneRecords.controllerLetter,
            zoneNumber: wetCheckZoneRecords.zoneNumber,
            status: wetCheckZoneRecords.status,
            observedPressure: wetCheckZoneRecords.observedPressure,
            observedFlow: wetCheckZoneRecords.observedFlow,
            ranSuccessfully: wetCheckZoneRecords.ranSuccessfully,
            notes: wetCheckZoneRecords.notes,
            repairLaborHours: wetCheckZoneRecords.repairLaborHours,
          })
          .from(wetCheckZoneRecords)
          .where(
            and(
              eq(wetCheckZoneRecords.wetCheckId, row.id),
              eq(wetCheckZoneRecords.status, "not_checked"),
            ),
          );

        if (notCheckedZones.length === 0) {
          skippedNoPhantoms += 1;
          done.add(row.id);
          continue;
        }

        // Load finding counts per zone record id so isEmptyZone can check
        // whether any findings exist without loading the full finding rows.
        const zoneIds = notCheckedZones.map((z) => z.id);
        const findingCountRows = await db.execute<{ zone_record_id: number; cnt: string }>(sql`
          SELECT zone_record_id, COUNT(*) AS cnt
          FROM wet_check_findings
          WHERE zone_record_id IN (${sql.join(zoneIds.map((id) => sql`${id}`), sql`, `)})
          GROUP BY zone_record_id
        `);
        const findingCountByZoneId = new Map<number, number>();
        for (const r of findingCountRows.rows) {
          findingCountByZoneId.set(Number(r.zone_record_id), Number(r.cnt));
        }

        // Determine which controller letters are referenced.
        const letters = [...new Set(notCheckedZones.map((z) => z.controllerLetter))];

        // Load the controllers for this wet check's customer, scoped by the
        // wet check's branchName. Task #1857: use irrigation_controllers (single
        // source of truth). The customer-level bucket has branchName='' (empty
        // string); null branchName normalizes to '' — matching prior behaviour.
        const wcRows = await db.execute<{ company_id: number; customer_id: number; branch_name: string | null }>(sql`
          SELECT company_id, customer_id, branch_name FROM wet_checks WHERE id = ${row.id}
        `);
        const wc = wcRows.rows[0];
        if (!wc) {
          skippedNoPhantoms += 1;
          done.add(row.id);
          continue;
        }

        // Normalize: null or undefined → '' (customer-level bucket in
        // property_controllers).
        const branchKey = (wc.branch_name ?? "").trim();

        const ctrlRows = await db
          .select({
            controllerLetter: irrigationControllers.letter,
            zoneCount: irrigationControllers.totalZones,
          })
          .from(irrigationControllers)
          .where(
            and(
              eq(irrigationControllers.companyId, wc.company_id),
              eq(irrigationControllers.customerId, wc.customer_id),
              eq(irrigationControllers.branchName, branchKey),
              isNotNull(irrigationControllers.letter),
              inArray(irrigationControllers.letter, letters),
            ),
          );

        // (companyId, customerId, branchName, letter) has a unique index in
        // irrigation_controllers, so ctrlRows has at most one row per letter.
        const zoneCountByLetter = new Map(
          ctrlRows.map((c) => [c.controllerLetter, c.zoneCount]),
        );

        // Collect zone record ids to delete: those whose zoneNumber exceeds
        // the controller's current zoneCount AND whose isEmptyZone check
        // confirms they carry no real data.
        const toDelete: number[] = [];
        for (const zone of notCheckedZones) {
          const maxZones = zoneCountByLetter.get(zone.controllerLetter);
          if (maxZones == null) {
            // Controller not found, or its zone count has never been
            // recorded (total_zones is nullable) — skip to be safe.
            continue;
          }
          if (zone.zoneNumber <= maxZones) {
            // Within the current zone count — leave it alone.
            continue;
          }
          // Beyond the zone count — only delete if truly empty (no real data).
          const findingCount = findingCountByZoneId.get(zone.id) ?? 0;
          const zoneForGuard = {
            status: zone.status,
            findings: findingCount > 0 ? [{}] : [],
            observedPressure: zone.observedPressure,
            observedFlow: zone.observedFlow,
            ranSuccessfully: zone.ranSuccessfully,
            notes: zone.notes,
            repairLaborHours: zone.repairLaborHours,
          };
          if (isEmptyZone(zoneForGuard)) {
            toDelete.push(zone.id);
          }
        }

        if (toDelete.length === 0) {
          skippedNoPhantoms += 1;
          done.add(row.id);
          continue;
        }

        if (dryRun) {
          console.log(
            `[backfill-trim-phantom-zones] dry-run: wet-check id=${row.id} would delete ${toDelete.length} phantom zone record(s)`,
          );
        } else {
          await db
            .delete(wetCheckZoneRecords)
            .where(inArray(wetCheckZoneRecords.id, toDelete));
        }

        trimmed += toDelete.length;
        done.add(row.id);
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[backfill-trim-phantom-zones] FAILED wet-check id=${row.id}: ${msg}`,
        );
        if (!dryRun) {
          await appendFailure({
            id: row.id,
            error: msg,
            at: new Date().toISOString(),
          });
        }
      }
    }

    // Persist the done set after every batch so a mid-run timeout can resume.
    if (!dryRun) {
      await saveIdSet(DONE_KEY, done);
    }

    console.log(
      `[backfill-trim-phantom-zones] scanned=${scanned} trimmed=${trimmed} ` +
        `skippedAlreadyDone=${skippedAlreadyDone} skippedNoPhantoms=${skippedNoPhantoms} ` +
        `failed=${failed} lastId=${lastId}`,
    );
  }

  console.log(
    `[backfill-trim-phantom-zones] done. scanned=${scanned} trimmed=${trimmed} ` +
      `skippedAlreadyDone=${skippedAlreadyDone} skippedNoPhantoms=${skippedNoPhantoms} ` +
      `failed=${failed} dryRun=${dryRun}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-trim-phantom-zones] fatal:", err);
    process.exit(1);
  });
