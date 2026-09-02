import { db as defaultDb } from "../db";
import {
  customers,
  companies,
  customerBudgetMonths,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

export interface SeasonCurveEntry {
  month: number;
  percent: number;
}

export interface GenerateBudgetMonthsResult {
  year: number;
  inserted: number;
  updated: number;
  skipped: number;
  months: Array<{ month: number; amount: number; isManualOverride: boolean }>;
}

type BudgetDb = typeof defaultDb;

export const DEFAULT_SEASON_CURVE: SeasonCurveEntry[] = [
  { month: 4, percent: 0 },
  { month: 5, percent: 10 },
  { month: 6, percent: 20 },
  { month: 7, percent: 20 },
  { month: 8, percent: 20 },
  { month: 9, percent: 20 },
  { month: 10, percent: 10 },
];

export function resolveEffectiveCurve(
  customerOverride: SeasonCurveEntry[] | null | undefined,
  companyCurve: SeasonCurveEntry[] | null | undefined,
): SeasonCurveEntry[] {
  if (Array.isArray(customerOverride) && customerOverride.length > 0) return customerOverride;
  if (Array.isArray(companyCurve) && companyCurve.length > 0) return companyCurve;
  return DEFAULT_SEASON_CURVE;
}

export function validateCurve(curve: SeasonCurveEntry[]): void {
  if (curve.length === 0) throw new Error("Season curve must contain at least one month");
  const months = new Set<number>();
  let total = 0;
  for (const entry of curve) {
    if (!Number.isInteger(entry.month) || entry.month < 1 || entry.month > 12) {
      throw new Error(`Season curve month must be between 1 and 12 — got ${entry.month}`);
    }
    if (months.has(entry.month)) throw new Error(`Season curve contains duplicate month ${entry.month}`);
    if (!Number.isFinite(entry.percent) || entry.percent < 0 || entry.percent > 100) {
      throw new Error(`Season curve percent must be between 0 and 100 — got ${entry.percent}`);
    }
    months.add(entry.month);
    total += entry.percent;
  }
  if (Math.abs(total - 100) > 0.000001) {
    throw new Error(`Season curve must total 100% — got ${total}%`);
  }
}

/**
 * Work in whole cents, round each month, then put any remainder on the last
 * non-zero season month. This guarantees allocations sum exactly to the goal.
 */
export function distributeGoal(
  annualGoalDollars: number,
  curve: SeasonCurveEntry[],
): Array<{ month: number; amount: number }> {
  const goalCents = Math.round(annualGoalDollars * 100);
  const rows = curve.map((entry) => ({
    month: entry.month,
    cents: Math.round((goalCents * entry.percent) / 100),
    nonZero: entry.percent > 0,
  }));
  let lastNonZero = rows.length - 1;
  while (lastNonZero > 0 && !rows[lastNonZero].nonZero) lastNonZero -= 1;
  if (!rows[lastNonZero]?.nonZero) lastNonZero = -1;
  const remainder = goalCents - rows.reduce((sum, row) => sum + row.cents, 0);
  if (lastNonZero >= 0) rows[lastNonZero].cents += remainder;
  return rows.map(({ month, cents }) => ({ month, amount: cents / 100 }));
}

async function loadCustomer(customerId: number, db: BudgetDb) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  return customer;
}

export async function generateBudgetMonths(
  customerId: number,
  year: number,
  db: BudgetDb = defaultDb,
): Promise<GenerateBudgetMonthsResult> {
  const customer = await loadCustomer(customerId, db);
  const goal = customer.annualBudgetGoal == null
    ? null
    : Number(customer.annualBudgetGoal);
  if (goal == null) {
    await db.delete(customerBudgetMonths).where(and(
      eq(customerBudgetMonths.companyId, customer.companyId),
      eq(customerBudgetMonths.customerId, customerId),
      eq(customerBudgetMonths.year, year),
      eq(customerBudgetMonths.isManualOverride, false),
    ));
    return { year, inserted: 0, updated: 0, skipped: 0, months: [] };
  }
  if (!Number.isFinite(goal) || goal < 0) throw new Error("Annual budget goal must be a non-negative amount");

  const [company] = await db
    .select({ budgetSeasonCurve: companies.budgetSeasonCurve })
    .from(companies)
    .where(eq(companies.id, customer.companyId))
    .limit(1);
  const curve = resolveEffectiveCurve(
    customer.budgetSeasonCurveOverride,
    company?.budgetSeasonCurve,
  );
  validateCurve(curve);
  const generated = distributeGoal(goal, curve);
  const existing = await db
    .select({
      month: customerBudgetMonths.month,
      amount: customerBudgetMonths.amount,
      isManualOverride: customerBudgetMonths.isManualOverride,
    })
    .from(customerBudgetMonths)
    .where(and(
      eq(customerBudgetMonths.companyId, customer.companyId),
      eq(customerBudgetMonths.customerId, customerId),
      eq(customerBudgetMonths.year, year),
    ));
  const byMonth = new Map(existing.map((row) => [row.month, row]));
  await db.delete(customerBudgetMonths).where(and(
    eq(customerBudgetMonths.companyId, customer.companyId),
    eq(customerBudgetMonths.customerId, customerId),
    eq(customerBudgetMonths.year, year),
    eq(customerBudgetMonths.isManualOverride, false),
  ));
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const resultMonths: GenerateBudgetMonthsResult["months"] = [];

  for (const row of generated) {
    const current = byMonth.get(row.month);
    if (current?.isManualOverride) {
      skipped++;
      resultMonths.push({
        month: row.month,
        amount: Number(current.amount),
        isManualOverride: true,
      });
      continue;
    }
    const amount = row.amount.toFixed(2);
    await db
      .insert(customerBudgetMonths)
      .values({
        companyId: customer.companyId,
        customerId,
        year,
        month: row.month,
        amount,
        isManualOverride: false,
      })
      .onConflictDoUpdate({
        target: [
          customerBudgetMonths.companyId,
          customerBudgetMonths.customerId,
          customerBudgetMonths.year,
          customerBudgetMonths.month,
        ],
        set: { amount, isManualOverride: false, updatedAt: new Date() },
      });
    current ? updated++ : inserted++;
    resultMonths.push({ ...row, isManualOverride: false });
  }
  return { year, inserted, updated, skipped, months: resultMonths };
}

export async function applyMonthOverride(
  input: { customerId: number; year: number; month: number; amount: number },
  db: BudgetDb = defaultDb,
): Promise<void> {
  if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
    throw new Error("Budget month must be between 1 and 12");
  }
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error("Budget amount must be a non-negative number");
  }
  const customer = await loadCustomer(input.customerId, db);
  await db
    .insert(customerBudgetMonths)
    .values({
      companyId: customer.companyId,
      customerId: customer.id,
      year: input.year,
      month: input.month,
      amount: input.amount.toFixed(2),
      isManualOverride: true,
    })
    .onConflictDoUpdate({
      target: [
        customerBudgetMonths.companyId,
        customerBudgetMonths.customerId,
        customerBudgetMonths.year,
        customerBudgetMonths.month,
      ],
      set: {
        amount: input.amount.toFixed(2),
        isManualOverride: true,
        updatedAt: new Date(),
      },
    });
}

export async function resetMonthOverride(
  input: { customerId: number; year: number; month: number },
  db: BudgetDb = defaultDb,
): Promise<GenerateBudgetMonthsResult> {
  const customer = await loadCustomer(input.customerId, db);
  await db
    .update(customerBudgetMonths)
    .set({ isManualOverride: false, updatedAt: new Date() })
    .where(and(
      eq(customerBudgetMonths.companyId, customer.companyId),
      eq(customerBudgetMonths.customerId, customer.id),
      eq(customerBudgetMonths.year, input.year),
      eq(customerBudgetMonths.month, input.month),
    ));
  return generateBudgetMonths(customer.id, input.year, db);
}