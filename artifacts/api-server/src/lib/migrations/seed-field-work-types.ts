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

async function run(
  emit: ProgressEmitter,
  opts?: MigrationRunOptions,
): Promise<MigrationStepResult[]> {
  if (opts?.acknowledged !== true) {
    return [{
      id: "seed-defaults",
      status: "failed",
      durationMs: 0,
      error: "Preview acknowledgement is required before seeding field work types.",
    }];
  }

  const results: MigrationStepResult[] = [];
  const seedStarted = Date.now();
  emit({ step: "seed-defaults", status: "running" });
  try {
    const companyRows = await db.select({ id: companies.id }).from(companies);
    let inserted = 0;
    for (const company of companyRows) {
      inserted += await seedFieldWorkTypesForCompany(company.id);
    }
    const result = {
      id: "seed-defaults",
      status: "success" as const,
      durationMs: Date.now() - seedStarted,
      rowsAffected: inserted,
    };
    results.push(result);
    emit({ step: result.id, status: result.status, rowsAffected: inserted });
  } catch (error) {
    const result = {
      id: "seed-defaults",
      status: "failed" as const,
      durationMs: Date.now() - seedStarted,
      error: error instanceof Error ? error.message : String(error),
    };
    results.push(result);
    emit({ step: result.id, status: result.status, error: result.error });
    return results;
  }

  const markerStarted = Date.now();
  emit({ step: "mark-done", status: "running" });
  try {
    const completedAt = new Date().toISOString();
    await db
      .insert(appSettings)
      .values({ key: FIELD_WORK_TYPE_SEED_DONE_KEY, value: completedAt })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: completedAt, updatedAt: new Date() },
      });
    const result = {
      id: "mark-done",
      status: "success" as const,
      durationMs: Date.now() - markerStarted,
      rowsAffected: 1,
    };
    results.push(result);
    emit({ step: result.id, status: result.status, rowsAffected: 1 });
  } catch (error) {
    const result = {
      id: "mark-done",
      status: "failed" as const,
      durationMs: Date.now() - markerStarted,
      error: error instanceof Error ? error.message : String(error),
    };
    results.push(result);
    emit({ step: result.id, status: result.status, error: result.error });
  }

  return results;
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