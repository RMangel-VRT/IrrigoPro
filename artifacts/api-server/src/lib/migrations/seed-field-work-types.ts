import { db } from "../../db";
import { appSettings, companies, fieldWorkTypes } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  FIELD_WORK_TYPE_SEEDS,
  describeFieldWorkTypeDrift,
  diffFieldWorkTypeSeeds,
  seedFieldWorkTypesForCompany,
  type FieldWorkTypeExistingRow,
  type FieldWorkTypeSeedResult,
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
  /** Rows that exist but disagree with the source file; the run corrects them. */
  rowsDrifted: number;
  companiesWithDrift: number;
  /** One line per drifted row, so a preview can name what will change. */
  driftDetails: string[];
};

/** Rows carry their company so drift can be attributed per tenant. */
export type FieldWorkTypeStateRow = FieldWorkTypeExistingRow & { companyId: number };

export function computeFieldWorkTypeSeedState(
  companyIds: readonly number[],
  existingRows: readonly FieldWorkTypeStateRow[],
): SeedState {
  const byCompany = new Map<number, FieldWorkTypeStateRow[]>();
  for (const row of existingRows) {
    const bucket = byCompany.get(row.companyId);
    if (bucket) bucket.push(row);
    else byCompany.set(row.companyId, [row]);
  }

  let companiesMissingDefaults = 0;
  let rowsMissing = 0;
  let companiesWithDrift = 0;
  let rowsDrifted = 0;
  const driftDetails: string[] = [];

  for (const companyId of companyIds) {
    const { missing, drifted } = diffFieldWorkTypeSeeds(byCompany.get(companyId) ?? []);
    rowsMissing += missing.length;
    if (missing.length > 0) companiesMissingDefaults++;
    rowsDrifted += drifted.length;
    if (drifted.length > 0) companiesWithDrift++;
    for (const drift of drifted) {
      driftDetails.push(`Company ${companyId} · ${describeFieldWorkTypeDrift(drift)}`);
    }
  }

  return {
    companyCount: companyIds.length,
    companiesMissingDefaults,
    rowsMissing,
    rowsDrifted,
    companiesWithDrift,
    driftDetails,
  };
}

async function loadState(): Promise<SeedState> {
  const [companyRows, existingRows] = await Promise.all([
    db.select({ id: companies.id }).from(companies),
    db.select({
      companyId: fieldWorkTypes.companyId,
      code: fieldWorkTypes.code,
      label: fieldWorkTypes.label,
      requiresController: fieldWorkTypes.requiresController,
      requiresZone: fieldWorkTypes.requiresZone,
      requiresDetails: fieldWorkTypes.requiresDetails,
      sortOrder: fieldWorkTypes.sortOrder,
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

/**
 * Completion means "the database matches the source file", not merely "no row
 * is absent". A company whose rows all exist but whose labels or requirement
 * flags have drifted still owes this migration a run, so it must not read as
 * completed — otherwise the migrations page retires the only thing that can
 * correct the drift.
 */
export function resolveFieldWorkTypeSeedStatus(
  state: SeedState,
  markerValue?: string,
): MigrationStatus {
  const driftSuffix =
    `${state.rowsDrifted} field work type(s) differ from the source file ` +
    `across ${state.companiesWithDrift} company/companies`;

  if (state.rowsMissing === 0 && state.rowsDrifted === 0) {
    if (markerValue) return { state: "completed", completedAt: markerValue };
    return {
      state: "partially_applied",
      details: "All defaults are present, but the completion marker is missing.",
    };
  }
  if (state.rowsMissing === 0) {
    // Every preset exists, so the seed has plainly run here before; the work
    // left is correction, not insertion.
    return { state: "partially_applied", details: driftSuffix };
  }
  if (markerValue) {
    return {
      state: "partially_applied",
      details:
        `${state.rowsMissing} default field work type(s) are still missing ` +
        `across ${state.companiesMissingDefaults} company/companies` +
        (state.rowsDrifted > 0 ? `; ${driftSuffix}` : ""),
    };
  }
  return { state: "not_started" };
}

async function check(): Promise<MigrationStatus> {
  const [state, marker] = await Promise.all([loadState(), loadMarker()]);
  return resolveFieldWorkTypeSeedStatus(state, marker?.value);
}

/** How many drifted rows the preview names one by one before it summarises. */
const MAX_NAMED_DRIFT_ROWS = 25;

/**
 * The preview must distinguish inserts from updates and name every row it is
 * about to change. A requirement-flag correction alters what the location gate
 * demands of every ticket saved afterwards, so it cannot be something an
 * operator acknowledges blind inside an insert count.
 */
export function buildFieldWorkTypeSeedWarnings(state: SeedState): string[] {
  const warnings: string[] = [];

  if (state.rowsMissing === 0 && state.rowsDrifted === 0) {
    warnings.push(
      "All companies already have the seven default field work types, " +
        "and every row matches the source file. Nothing will be inserted or updated.",
    );
    return warnings;
  }

  if (state.rowsMissing > 0) {
    warnings.push(
      `${state.rowsMissing} row(s) will be INSERTED for ` +
        `${state.companiesMissingDefaults} company/companies.`,
    );
  }

  if (state.rowsDrifted > 0) {
    warnings.push(
      `${state.rowsDrifted} existing row(s) will be UPDATED across ` +
        `${state.companiesWithDrift} company/companies: their label, requirement flags ` +
        `and sort order are reconciled to the source file. A requirement-flag change ` +
        `alters what the location gate demands of every ticket saved afterwards. ` +
        `Retirement is never written — a row that is inactive today stays inactive.`,
    );
    for (const detail of state.driftDetails.slice(0, MAX_NAMED_DRIFT_ROWS)) {
      warnings.push(detail);
    }
    if (state.driftDetails.length > MAX_NAMED_DRIFT_ROWS) {
      warnings.push(
        `…and ${state.driftDetails.length - MAX_NAMED_DRIFT_ROWS} further drifted row(s).`,
      );
    }
  }

  return warnings;
}

async function preview(): Promise<MigrationPreview> {
  const state = await loadState();
  return {
    steps: [
      {
        id: "seed-defaults",
        description:
          "Insert any missing default field work types for every company, and reconcile " +
          "existing rows' label, requirement flags and sort order to the source file " +
          "(retirement is left as the tenant set it)",
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
      companiesWithDriftedRows: state.companiesWithDrift,
      fieldWorkTypesDrifted: state.rowsDrifted,
    },
    warnings: buildFieldWorkTypeSeedWarnings(state),
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
  /**
   * Reconciles one company against the source file: inserts the presets it is
   * missing and corrects the ones that have drifted. Counts are separate
   * because they are separate promises to the operator.
   */
  seedCompany(tx: SeedTransaction, companyId: number): Promise<FieldWorkTypeSeedResult>;
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
 *   * the inserts, the reconciling updates and the completion marker share one
 *     transaction, so a failure part-way through leaves none of them behind —
 *     no marker can vouch for rows that were rolled back;
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

  let applied: FieldWorkTypeSeedResult = { inserted: 0, updated: 0 };
  try {
    applied = await deps.withTransaction(async (tx) => {
      const companyIds = await deps.listCompanyIds(tx);
      const totals: FieldWorkTypeSeedResult = { inserted: 0, updated: 0 };
      for (const companyId of companyIds) {
        const result = await deps.seedCompany(tx, companyId);
        totals.inserted += result.inserted;
        totals.updated += result.updated;
      }
      await deps.writeMarker(tx, new Date().toISOString());
      return totals;
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

  // Committed. Reconcile the reported counts against what is actually there.
  const durationMs = Date.now() - seedStarted;
  let rowsAffected = applied.inserted + applied.updated;
  let shortfall: string | undefined;
  try {
    const after = await deps.loadStateAfterCommit();
    const shortfalls: string[] = [];
    if (after.rowsMissing > 0) {
      // The writes committed but the defaults are still not all present:
      // report the rows that are genuinely there, not the attempted count.
      rowsAffected = Math.max(rowsAffected - after.rowsMissing, 0);
      shortfalls.push(
        `${after.rowsMissing} default field work type(s) are still missing after the run ` +
        `across ${after.companiesMissingDefaults} company/companies.`,
      );
    }
    if (after.rowsDrifted > 0) {
      // The reconcile is the whole point of the run: rows that still disagree
      // with the source file afterwards mean it did not do what it reported.
      rowsAffected = Math.max(rowsAffected - after.rowsDrifted, 0);
      shortfalls.push(
        `${after.rowsDrifted} field work type(s) still differ from the source file after ` +
        `the run across ${after.companiesWithDrift} company/companies.`,
      );
    }
    if (shortfalls.length > 0) shortfall = shortfalls.join(" ");
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
    "Add the seven default field work types to existing companies and reconcile rows that " +
    "already exist back to the source file — label, requirement flags and sort order. " +
    "Retirement is never overwritten: an inactive row stays inactive.",
  appSettingsKey: FIELD_WORK_TYPE_SEED_DONE_KEY,
  check,
  preview,
  run,
};