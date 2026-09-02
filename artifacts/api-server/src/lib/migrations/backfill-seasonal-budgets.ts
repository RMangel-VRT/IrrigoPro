import { and, eq } from "drizzle-orm";
import { customers, customerBudgetMonths } from "@workspace/db/schema";
import { db } from "../../db";
import { generateBudgetMonths } from "../../services/generate-budget-months";
import type {
  MigrationDefinition,
  MigrationPreview,
  MigrationStatus,
  MigrationStepResult,
  ProgressEmitter,
} from "./types";

const CURRENT_YEAR = new Date().getFullYear();
const SEASON_MONTHS = [4, 5, 6, 7, 8, 9, 10];
const APP_KEY = "seasonalBudgetBackfill.done";

type PlannedCustomer = {
  id: number;
  companyId: number;
  name: string;
  annualCap: number | null;
  monthlyCap: number | null;
  annualGoal: number | null;
  existingMonths: Set<number>;
};

function positiveDecimal(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function loadPlan(): Promise<PlannedCustomer[]> {
  const allCustomers = await db.select().from(customers);
  const monthRows = await db
    .select({
      customerId: customerBudgetMonths.customerId,
      month: customerBudgetMonths.month,
    })
    .from(customerBudgetMonths)
    .where(eq(customerBudgetMonths.year, CURRENT_YEAR));
  const monthsByCustomer = new Map<number, Set<number>>();
  for (const row of monthRows) {
    const months = monthsByCustomer.get(row.customerId) ?? new Set<number>();
    months.add(row.month);
    monthsByCustomer.set(row.customerId, months);
  }
  return allCustomers.map((customer) => ({
    id: customer.id,
    companyId: customer.companyId,
    name: customer.name,
    annualCap: positiveDecimal(customer.annualBudgetCap),
    monthlyCap: positiveDecimal(customer.monthlyBudgetCap),
    annualGoal: positiveDecimal(customer.annualBudgetGoal),
    existingMonths: monthsByCustomer.get(customer.id) ?? new Set<number>(),
  }));
}

function needsWork(customer: PlannedCustomer): boolean {
  if (customer.annualCap != null) {
    return customer.annualGoal == null ||
      SEASON_MONTHS.some((month) => !customer.existingMonths.has(month));
  }
  if (customer.monthlyCap != null) {
    return SEASON_MONTHS.some((month) => !customer.existingMonths.has(month));
  }
  return false;
}

async function preview(): Promise<MigrationPreview> {
  const plan = (await loadPlan()).filter(needsWork);
  const companyCounts = new Map<number, number>();
  for (const customer of plan) {
    companyCounts.set(customer.companyId, (companyCounts.get(customer.companyId) ?? 0) + 1);
  }
  return {
    steps: [{
      id: "backfill-seasonal-budgets",
      description: `Convert legacy annual/monthly budget caps into ${CURRENT_YEAR} seasonal allocations`,
    }],
    orphanRows: {
      customersToConvert: plan.length,
      companiesAffected: companyCounts.size,
    },
    warnings: plan.length === 0
      ? ["Nothing to convert — no customer has populated legacy budget caps."]
      : [
          ...Array.from(companyCounts, ([companyId, count]) =>
            `Company ${companyId}: ${count} customer(s) require conversion.`),
          ...plan.map((customer) =>
            `Customer ${customer.id} (${customer.name}): ${
              customer.annualCap != null ? "annual goal + generated season" : "flat manual monthly overrides"
            }.`),
        ],
  };
}

async function check(): Promise<MigrationStatus> {
  try {
    const outstanding = (await loadPlan()).filter(needsWork);
    return outstanding.length === 0
      ? { state: "completed", completedAt: "" }
      : { state: "not_started" };
  } catch (error) {
    return {
      state: "error",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

async function run(emit: ProgressEmitter): Promise<MigrationStepResult[]> {
  const step = "backfill-seasonal-budgets";
  const started = Date.now();
  emit({ step, status: "running" });
  try {
    const plan = (await loadPlan()).filter(needsWork);
    let converted = 0;
    for (const customer of plan) {
      if (customer.annualCap != null) {
        if (customer.annualGoal == null) {
          await db
            .update(customers)
            .set({ annualBudgetGoal: customer.annualCap.toFixed(2) })
            .where(eq(customers.id, customer.id));
        }
        await generateBudgetMonths(customer.id, CURRENT_YEAR);
        converted += 1;
        continue;
      }
      if (customer.monthlyCap == null) continue;
      for (const month of SEASON_MONTHS) {
        await db
          .insert(customerBudgetMonths)
          .values({
            companyId: customer.companyId,
            customerId: customer.id,
            year: CURRENT_YEAR,
            month,
            amount: customer.monthlyCap.toFixed(2),
            isManualOverride: true,
          })
          .onConflictDoNothing({
            target: [
              customerBudgetMonths.companyId,
              customerBudgetMonths.customerId,
              customerBudgetMonths.year,
              customerBudgetMonths.month,
            ],
          });
      }
      converted += 1;
    }
    const remaining = (await loadPlan()).filter(needsWork);
    if (remaining.length > 0) {
      throw new Error(`${remaining.length} customer(s) still require conversion after the run`);
    }
    emit({ step, status: "success", rowsAffected: converted });
    return [{
      id: step,
      status: "success",
      durationMs: Date.now() - started,
      rowsAffected: converted,
    }];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ step, status: "failed", error: message });
    return [{ id: step, status: "failed", durationMs: Date.now() - started, error: message }];
  }
}

export const backfillSeasonalBudgetsMigration: MigrationDefinition = {
  id: "backfill-seasonal-budgets-v1",
  title: "Backfill seasonal customer budgets",
  description:
    "Converts legacy annual caps into annual goals with generated Apr–Oct allocations, " +
    "and monthly-only caps into flat manual overrides. Idempotent and tenant-scoped.",
  appSettingsKey: APP_KEY,
  check,
  preview,
  run,
};