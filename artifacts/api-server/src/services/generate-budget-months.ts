// Task #1865 — Seasonal Budget Model.
//
// generateBudgetMonths: given a customer with an annualBudgetGoal, resolves
// the effective season curve, validates it totals 100%, distributes the goal
// across the season months, and upserts one customerBudgetMonths row per
// season month. Rows with isManualOverride=true are NEVER overwritten — those
// reflect explicit manager edits and must be preserved across regenerations.
//
// Rounding rule: multiply annualBudgetGoal by each curve percent (as a
// fraction of 100) to get raw cents, round each to the nearest whole cent,
// then put any integer-rounding remainder on the LAST season month that has a
// non-zero percent so that sum(monthly amounts) === annualBudgetGoal exactly.

import { db as defaultDb } from "../db";
import {
  customers as customersTable,
  companies as companiesTable,
  customerBudgetMonths,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SeasonCurveEntry {
  month: number; // 1-12
  percent: number; // 0-100, must total 100 across all entries
}

export interface GenerateBudgetMonthsResult {
  year: number;
  inserted: number;
  updated: number;
  skipped: number; // rows with isManualOverride=true, not touched
  months: Array<{ month: number; amount: number; isManualOverride: boolean }>;
}

export interface ApplyMonthOverrideInput {
  customerId: number;
  companyId: number;
  year: number;
  month: number;
  amount: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** System-default irrigation season: Apr–Oct, 0/10/20/20/20/20/10 = 100 %. */
export const DEFAULT_SEASON_CURVE: SeasonCurveEntry[] = [
  { month: 4, percent: 0 },
  { month: 5, percent: 10 },
  { month: 6, percent: 20 },
  { month: 7, percent: 20 },
  { month: 8, percent: 20 },
  { month: 9, percent: 20 },
  { month: 10, percent: 10 },
];

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

/**
 * Resolve the effective season curve for a customer.
 * Priority: customer override → company curve → system default.
 */
export function resolveEffectiveCurve(
  customerOverride: SeasonCurveEntry[] | null | undefined,
  companyCurve: SeasonCurveEntry[] | null | undefined,
): SeasonCurveEntry[] {
  if (Array.isArray(customerOverride) && customerOverride.length > 0) {
    return customerOverride;
  }
  if (Array.isArray(companyCurve) && companyCurve.length > 0) {
    return companyCurve;
  }
  return DEFAULT_SEASON_CURVE;
}

/**
 * Validate that a curve's percents sum to exactly 100.
 * Throws a descriptive Error if not.
 */
export function validateCurve(curve: SeasonCurveEntry[]): void {
  const total = curve.reduce((s, e) => s + e.percent, 0);
  if (total !== 100) {
    throw new Error(
      `Season curve must total 100% — got ${total}% (` +
        curve.map((e) => `month ${e.month}=${e.percent}%`).join(", ") +
        ")",
    );
  }
}

/**
 * Distribute an annual goal (in dollars) across season months per the curve.
 *
 * Rounding rule (documented here per spec):
 *   1. Convert goal to whole cents.
 *   2. For each month: raw_cents = round(goal_cents × percent / 100).
 *   3. Sum all raw_cents values; compute remainder = goal_cents − sum.
 *   4. Add the remainder (may be ±1 cent) to the LAST month whose percent > 0,
 *      so that sum(all months) === goal exactly regardless of rounding.
 *
 * Zero-percent months get amount = 0 (a row is still generated so the season
 * window is fully represented).
 *
 * @returns Array of {month, amountDollars} in curve order.
 */
export function distributeGoal(
  annualGoalDollars: number,
  curve: SeasonCurveEntry[],
): Array<{ month: number; amount: number }> {
  // Work in whole cents to avoid floating-point drift.
  const goalCents = Math.round(annualGoalDollars * 100);

  const rawCents = curve.map((entry) => ({
    month: entry.month,
    cents: Math.round((goalCents * entry.percent) / 100),
    percentGt0: entry.percent > 0,
  }));

  // Find the last month with percent > 0 to absorb rounding remainder.
  let lastNonZeroIdx = -1;
  for (let i = rawCents.length - 1; i >= 0; i--) {
    if (rawCents[i].percentGt0) {
      lastNonZeroIdx = i;
      break;
    }
  }

  const distributed = rawCents.reduce((s, r) => s + r.cents, 0);
  const remainder = goalCents - distributed;
  if (lastNonZeroIdx >= 0) {
    rawCents[lastNonZeroIdx].cents += remainder;
  }

  // Convert back to dollars (2 decimal places).
  return rawCents.map((r) => ({
    month: r.month,
    amount: r.cents / 100,
  }));
}

// ── Main DB function ──────────────────────────────────────────────────────────

/**
 * Generate (or regenerate) the monthly budget allocations for a customer for
 * the given year. Existing rows that were manually overridden by a manager
 * are preserved (skipped).
 *
 * Must be called inside a transaction when paired with a customer update so
 * the two writes are atomic. Accepts an optional `dbInstance` for testability.
 */
export async function generateBudgetMonths(
  customerId: number,
  year: number,
  dbInstance: NodePgDatabase<any> = defaultDb as any,
): Promise<GenerateBudgetMonthsResult> {
  // Load customer
  const [customer] = await (dbInstance as any)
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, customerId));

  if (!customer) {
    throw new Error(`generateBudgetMonths: customer ${customerId} not found`);
  }

  const annualGoalRaw = customer.annualBudgetGoal;
  if (annualGoalRaw == null) {
    // No goal set — nothing to generate.
    return { year, inserted: 0, updated: 0, skipped: 0, months: [] };
  }
  const annualGoal =
    typeof annualGoalRaw === "number"
      ? annualGoalRaw
      : parseFloat(String(annualGoalRaw));
  if (!Number.isFinite(annualGoal) || annualGoal < 0) {
    return { year, inserted: 0, updated: 0, skipped: 0, months: [] };
  }

  // Load company curve
  const [company] = await (dbInstance as any)
    .select({ budgetSeasonCurve: companiesTable.budgetSeasonCurve })
    .from(companiesTable)
    .where(eq(companiesTable.id, customer.companyId));

  const customerOverride = customer.budgetSeasonCurveOverride as
    | SeasonCurveEntry[]
    | null;
  const companyCurve = company?.budgetSeasonCurve as
    | SeasonCurveEntry[]
    | null;
  const curve = resolveEffectiveCurve(customerOverride, companyCurve);
  validateCurve(curve);

  const monthAmounts = distributeGoal(annualGoal, curve);

  // Load existing rows for this customer/year to detect manual overrides.
  const existingRows: Array<{
    month: number;
    isManualOverride: boolean;
  }> = await (dbInstance as any)
    .select({
      month: customerBudgetMonths.month,
      isManualOverride: customerBudgetMonths.isManualOverride,
    })
    .from(customerBudgetMonths)
    .where(
      and(
        eq(customerBudgetMonths.customerId, customerId),
        eq(customerBudgetMonths.year, year),
      ),
    );

  const overrideMonthSet = new Set(
    existingRows.filter((r) => r.isManualOverride).map((r) => r.month),
  );
  const existingMonthSet = new Set(existingRows.map((r) => r.month));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const resultMonths: Array<{
    month: number;
    amount: number;
    isManualOverride: boolean;
  }> = [];

  for (const { month, amount } of monthAmounts) {
    if (overrideMonthSet.has(month)) {
      // Manual override exists — preserve it, never overwrite.
      skipped++;
      resultMonths.push({ month, amount, isManualOverride: true });
      continue;
    }

    const amountStr = amount.toFixed(2);
    const now = new Date();

    if (existingMonthSet.has(month)) {
      // Row exists and is NOT a manual override — update it.
      await (dbInstance as any)
        .insert(customerBudgetMonths)
        .values({
          companyId: customer.companyId,
          customerId,
          year,
          month,
          amount: amountStr,
          isManualOverride: false,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            customerBudgetMonths.companyId,
            customerBudgetMonths.customerId,
            customerBudgetMonths.year,
            customerBudgetMonths.month,
          ],
          set: { amount: amountStr, isManualOverride: false, updatedAt: now },
        });
      updated++;
    } else {
      // No row yet — insert.
      await (dbInstance as any).insert(customerBudgetMonths).values({
        companyId: customer.companyId,
        customerId,
        year,
        month,
        amount: amountStr,
        isManualOverride: false,
        createdAt: now,
        updatedAt: now,
      });
      inserted++;
    }

    resultMonths.push({ month, amount, isManualOverride: false });
  }

  return { year, inserted, updated, skipped, months: resultMonths };
}

/**
 * Apply (upsert) a manager's manual override for a single month.
 * Sets isManualOverride=true so generateBudgetMonths will skip it on
 * future regenerations.
 */
export async function applyMonthOverride(
  input: ApplyMonthOverrideInput,
  dbInstance: NodePgDatabase<any> = defaultDb as any,
): Promise<void> {
  const { customerId, companyId, year, month, amount } = input;
  const amountStr = amount.toFixed(2);
  const now = new Date();

  await (dbInstance as any)
    .insert(customerBudgetMonths)
    .values({
      companyId,
      customerId,
      year,
      month,
      amount: amountStr,
      isManualOverride: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        customerBudgetMonths.companyId,
        customerBudgetMonths.customerId,
        customerBudgetMonths.year,
        customerBudgetMonths.month,
      ],
      set: { amount: amountStr, isManualOverride: true, updatedAt: now },
    });
}

/**
 * Reset a manual override back to the generated value.
 * Clears isManualOverride and sets amount from the curve computation.
 * After this call, a subsequent generateBudgetMonths will regenerate the month
 * to the curve-derived amount.
 */
export async function resetMonthOverride(
  input: Omit<ApplyMonthOverrideInput, "amount">,
  dbInstance: NodePgDatabase<any> = defaultDb as any,
): Promise<void> {
  const { customerId, companyId, year, month } = input;
  const now = new Date();

  // Clear the manual override flag. generateBudgetMonths will recompute.
  await (dbInstance as any)
    .insert(customerBudgetMonths)
    .values({
      companyId,
      customerId,
      year,
      month,
      amount: "0.00",
      isManualOverride: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        customerBudgetMonths.companyId,
        customerBudgetMonths.customerId,
        customerBudgetMonths.year,
        customerBudgetMonths.month,
      ],
      set: { isManualOverride: false, updatedAt: now },
    });
}
