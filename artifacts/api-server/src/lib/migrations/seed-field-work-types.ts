import { db } from "../../db";
import { appSettings, companies, fieldWorkTypes } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  FIELD_WORK_TYPE_SEEDS,
  seedFieldWorkTypesForCompany,
} from "../../seeds/field-work-types";
import type {
  MigrationDefinition,
  MigrationPreview,
  MigrationStatus,
  MigrationStepResult,
  ProgressEmitter,
  MigrationRunOptions,
} from "./types";

export const FIELD_WORK_TYPE_SEED_MIGRATION_ID = "seed-field-work-types-v1";
export const FIELD_WORK_TYPE_SEED_DONE_KEY = "seedFieldWorkTypes.done";

type SeedState = {
  companyCount: number;
  companiesMissingDefaults: number;
  rowsMissing: number;
};

export function computeFieldWorkTypeSeedState(
  companyIds: readonly number[],
  existingRows: readonly { companyId: number; code: string }[],
): SeedState {
  const existing = new Set(existingRows.map((row) => `${row.companyId}:${row.code}`));
  let companiesMissingDefaults = 0;
  let rowsMissing = 0;
  for (const companyId of companyIds) {
    let companyMissing = false;
    for (const seed of FIELD_WORK_TYPE_SEEDS) {
      if (!existing.has(`${companyId}:${seed.code}`)) {
        rowsMissing++;
        companyMissing = true;
      }
    }
    if (companyMissing) companiesMissingDefaults++;
  }
  return { companyCount: companyIds.length, companiesMissingDefaults, rowsMissing };
}

async function loadState(): Promise<SeedState> {
  const [companyRows, existingRows] = await Promise.all([
    db.select({ id: companies.id }).from(companies),
    db.select({
      companyId: fieldWorkTypes.companyId,
      code: fieldWorkTypes.code,
    }).from(fieldWorkTypes),
  ]);
  return computeFieldWorkTypeSeedState(
    companyRows.map((row) => row.id),
    existingRows,
  );
}

async function loadMarker(): Promise<{ value: string } | undefined> {
  const [marker] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, FIELD_WORK_TYPE_SEED_DONE_KEY))
    .limit(1);
  return marker;
}

export function resolveFieldWorkTypeSeedStatus(
  state: SeedState,
  markerValue?: string,
): MigrationStatus {
  if (state.rowsMissing === 0 && markerValue) {
    return { state: "completed", completedAt: markerValue };
  }
  if (state.rowsMissing === 0) {
    return {
      state: "partially_applied",
      details: "All defaults are present, but the completion marker is missing.",
    };
  }
  if (markerValue) {
    return {
      state: "partially_applied",
      details:
        `${state.rowsMissing} default field work type(s) are still missing ` +
        `across ${state.companiesMissingDefaults} company/companies`,
    };
  }
  return { state: "not_started" };
}

async function check(): Promise<MigrationStatus> {
  const [state, marker] = await Promise.all([loadState(), loadMarker()]);
  return resolveFieldWorkTypeSeedStatus(state, marker?.value);
}

async function preview(): Promise<MigrationPreview> {
  const state = await loadState();
  return {
    steps: [
      {
        id: "seed-defaults",
        description:
          "Insert any missing default field work types for every company without overwriting tenant customizations",
      },
      {
        id: "mark-done",
        description: "Record completion in app_settings",
      },
    ],
    orphanRows: {
      companies: state.companyCount,
      companiesMissingDefaults: state.companiesMissingDefaults,
      fieldWorkTypesMissing: state.rowsMissing,
    },
    warnings:
      state.rowsMissing === 0
        ? ["All companies already have the seven default field work types."]
        : [
            `${state.rowsMissing} row(s) will be inserted for ` +
              `${state.companiesMissingDefaults} company/companies. Existing rows will not be changed.`,
          ],
  };
}

/**
 * Seams for the reporting-contract tests. The default implementations are the
 * real database; a test supplies fakes so "the insert throws" and "the writes
 * are committed" can both be exercised without a database.
 */
export type SeedFieldWorkTypesRunDeps = {
  /** Runs `body` in a transaction; a throw rolls back everything inside it. */
  withTransaction<T>(body: (tx: SeedTransaction) => Promise<T>): Promise<T>;
  /** Companies to seed, read inside the transaction. */
  listCompanyIds(tx: SeedTransaction): Promise<number[]>;
  /** Inserts the missing defaults for one company; returns rows inserted. */
  seedCompany(tx: SeedTransaction, companyId: number): Promise<number>;
  /** Writes the completion marker — inside the same transaction as the seeds. */
  writeMarker(tx: SeedTransaction, completedAt: string): Promise<void>;
  /** Re-reads the seed state after the transaction commits. */
  loadStateAfterCommit(): Promise<SeedState>;
};

// Whatever the transaction handle is; the deps decide how to use it.
type SeedTransaction = any;

function defaultRunDeps(): SeedFieldWorkTypesRunDeps {
  return {
    withTransaction: (body) => db.transaction((tx) => body(tx)),
    listCompanyIds: async (tx) => {
      const rows = await tx.select({ id: companies.id }).from(companies);
      return rows.map((row: { id: number }) => row.id);
    },
    seedCompany: (tx, companyId) => seedFieldWorkTypesForCompany(companyId, tx),
    writeMarker: async (tx, completedAt) => {
      await tx
        .insert(appSettings)
        .values({ key: FIELD_WORK_TYPE_SEED_DONE_KEY, value: completedAt })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: completedAt, updatedAt: new Date() },
        });
    },
    loadStateAfterCommit: loadState,
  };
}

/**
 * Run the seed under the step reporting contract (see `types.ts`):
 *
 *   * the inserts and the completion marker share one transaction, so a
 *     failure part-way through leaves neither behind — no marker can vouch
 *     for rows that were rolled back;
 *   * every step result is pushed **after** the transaction commits, so a
 *     `success` can never describe a write that was undone;
 *   * `rowsAffected` is reconciled against a post-commit re-read, so it counts
 *     rows that are actually present rather than statements attempted.
 */
export async function runSeedFieldWorkTypes(
  emit: ProgressEmitter,
  opts?: MigrationRunOptions,
  deps: SeedFieldWorkTypesRunDeps = defaultRunDeps(),
): Promise<MigrationStepResult[]> {
  if (opts?.acknowledged !== true) {
    return [{
      id: "seed-defaults",
      status: "failed",
      durationMs: 0,
      error: "Preview acknowledgement is required before seeding field work types.",
    }];
  }

  const seedStarted = Date.now();
  emit({ step: "seed-defaults", status: "running" });
  emit({ step: "mark-done", status: "running" });

  let inserted = 0;
  try {
    inserted = await deps.withTransaction(async (tx) => {
      const companyIds = await deps.listCompanyIds(tx);
      let count = 0;
      for (const companyId of companyIds) {
        count += await deps.seedCompany(tx, companyId);
      }
      await deps.writeMarker(tx, new Date().toISOString());
      return count;
    });
  } catch (error) {
    // Nothing was committed — neither the inserts nor the marker — so both
    // steps report failure and check() still reads "not started".
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - seedStarted;
    emit({ step: "seed-defaults", status: "failed", error: message });
    emit({
      step: "mark-done",
      status: "failed",
      error: "Rolled back with the seed inserts; no completion marker was written.",
    });
    return [
      { id: "seed-defaults", status: "failed", durationMs, error: message },
      {
        id: "mark-done",
        status: "failed",
        durationMs: 0,
        error: "Rolled back with the seed inserts; no completion marker was written.",
      },
    ];
  }

  // Committed. Reconcile the reported count against what is actually there.
  const durationMs = Date.now() - seedStarted;
  let rowsAffected = inserted;
  let shortfall: string | undefined;
  try {
    const after = await deps.loadStateAfterCommit();
    if (after.rowsMissing > 0) {
      // The writes committed but the defaults are still not all present:
      // report the rows that are genuinely there, not the attempted count.
      rowsAffected = Math.max(inserted - after.rowsMissing, 0);
      shortfall =
        `${after.rowsMissing} default field work type(s) are still missing after the run ` +
        `across ${after.companiesMissingDefaults} company/companies.`;
    }
  } catch (error) {
    shortfall = `Post-commit verification failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  if (shortfall) {
    emit({ step: "seed-defaults", status: "failed", error: shortfall });
    emit({ step: "mark-done", status: "success", rowsAffected: 1 });
    return [
      { id: "seed-defaults", status: "failed", durationMs, rowsAffected, error: shortfall },
      { id: "mark-done", status: "success", durationMs: 0, rowsAffected: 1 },
    ];
  }

  emit({ step: "seed-defaults", status: "success", rowsAffected });
  emit({ step: "mark-done", status: "success", rowsAffected: 1 });
  return [
    { id: "seed-defaults", status: "success", durationMs, rowsAffected },
    { id: "mark-done", status: "success", durationMs: 0, rowsAffected: 1 },
  ];
}

async function run(
  emit: ProgressEmitter,
  opts?: MigrationRunOptions,
): Promise<MigrationStepResult[]> {
  return runSeedFieldWorkTypes(emit, opts);
}

export const seedFieldWorkTypesMigration: MigrationDefinition = {
  id: FIELD_WORK_TYPE_SEED_MIGRATION_ID,
  title: "Seed default field work types",
  description:
    "Add the seven default field work types to existing companies without overwriting company customizations.",
  appSettingsKey: FIELD_WORK_TYPE_SEED_DONE_KEY,
  check,
  preview,
  run,
};