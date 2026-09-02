import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "./db";
import {
  DEFAULT_SEASON_CURVE,
  applyMonthOverride,
  distributeGoal,
  generateBudgetMonths,
  resetMonthOverride,
  resolveEffectiveCurve,
  validateCurve,
} from "./services/generate-budget-months";
import { companies, customerBudgetMonths, customers } from "@workspace/db/schema";

type MonthRow = {
  companyId: number;
  customerId: number;
  year: number;
  month: number;
  amount: string;
  isManualOverride: boolean;
};

function fakeBudgetDb(input?: {
  customer?: Record<string, unknown>;
  company?: Record<string, unknown>;
  months?: MonthRow[];
}) {
  const customer = input?.customer ?? {
    id: 7,
    companyId: 22,
    annualBudgetGoal: "7500.00",
    budgetSeasonCurveOverride: null,
  };
  const company = input?.company ?? { id: 22, budgetSeasonCurve: DEFAULT_SEASON_CURVE };
  const months = input?.months ?? [];

  const select = () => {
    let table: unknown;
    const query: any = {
      from(nextTable: unknown) {
        table = nextTable;
        return query;
      },
      where() { return query; },
      limit() {
        if (table === customers) return Promise.resolve([customer]);
        if (table === companies) return Promise.resolve([company]);
        return Promise.resolve(months);
      },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        const rows = table === customers ? [customer] : table === companies ? [company] : months;
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return query;
  };
  const upsert = (values: any) => {
    const index = months.findIndex((row) =>
      row.companyId === values.companyId &&
      row.customerId === values.customerId &&
      row.year === values.year &&
      row.month === values.month);
    if (index >= 0) months[index] = { ...months[index], ...values };
    else months.push(values);
  };
  return {
    months,
    db: {
      select,
      insert() {
        let values: any;
        return {
          values(next: any) {
            values = next;
            return {
              onConflictDoUpdate() {
                upsert(values);
                return Promise.resolve();
              },
            };
          },
        };
      },
      update() {
        return {
          set(next: any) {
            return {
              where() {
                const row = months.find((candidate) => candidate.month === 6);
                if (row) Object.assign(row, next);
                return Promise.resolve();
              },
            };
          },
        };
      },
      delete() {
        return {
          where() {
            for (let i = months.length - 1; i >= 0; i--) {
              if (!months[i].isManualOverride) months.splice(i, 1);
            }
            return Promise.resolve();
          },
        };
      },
    } as any,
  };
}

describe("seasonal budget generation", () => {
  it("matches the spreadsheet row for a $7,500 goal", () => {
    assert.deepEqual(distributeGoal(7500, DEFAULT_SEASON_CURVE), [
      { month: 4, amount: 0 },
      { month: 5, amount: 750 },
      { month: 6, amount: 1500 },
      { month: 7, amount: 1500 },
      { month: 8, amount: 1500 },
      { month: 9, amount: 1500 },
      { month: 10, amount: 750 },
    ]);
  });

  it("puts the rounding remainder on the final non-zero season month", () => {
    const rows = distributeGoal(100.01, DEFAULT_SEASON_CURVE);
    assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 100.01);
    assert.equal(rows.at(-1)?.amount, 10.01);
  });

  it("resolves customer override over company curve over the system default", () => {
    const customerCurve = [{ month: 8, percent: 100 }];
    const companyCurve = [{ month: 7, percent: 100 }];
    assert.equal(resolveEffectiveCurve(customerCurve, companyCurve), customerCurve);
    assert.equal(resolveEffectiveCurve(null, companyCurve), companyCurve);
    assert.equal(resolveEffectiveCurve(null, null), DEFAULT_SEASON_CURVE);
  });

  it("rejects curves that do not total 100 or repeat a month", () => {
    assert.throws(() => validateCurve([{ month: 4, percent: 99 }]), /100%/);
    assert.throws(
      () => validateCurve([{ month: 4, percent: 50 }, { month: 4, percent: 50 }]),
      /duplicate/,
    );
  });

  it("treats a missing annual goal as unset", async () => {
    const fake = fakeBudgetDb({ customer: {
      id: 7,
      companyId: 22,
      annualBudgetGoal: null,
      budgetSeasonCurveOverride: null,
    } });
    assert.deepEqual(await generateBudgetMonths(7, 2026, fake.db), {
      year: 2026,
      inserted: 0,
      updated: 0,
      skipped: 0,
      months: [],
    });
  });

  it("preserves an override across regeneration and reset restores generation", async () => {
    const fake = fakeBudgetDb();
    await generateBudgetMonths(7, 2026, fake.db);
    await applyMonthOverride({ customerId: 7, year: 2026, month: 6, amount: 1234 }, fake.db);
    const regenerated = await generateBudgetMonths(7, 2026, fake.db);
    assert.equal(regenerated.months.find((row) => row.month === 6)?.amount, 1234);
    assert.equal(regenerated.months.find((row) => row.month === 6)?.isManualOverride, true);
    await resetMonthOverride({ customerId: 7, year: 2026, month: 6 }, fake.db);
    assert.equal(Number(fake.months.find((row) => row.month === 6)?.amount), 1500);
    assert.equal(fake.months.find((row) => row.month === 6)?.isManualOverride, false);
    assert.ok(fake.months.every((row) => row.companyId === 22));
  });
});

describe("0021 seasonal budget schema", () => {
  it("is idempotent when all columns, table, and indexes already exist", async () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "../../lib/db/migrations/0021_seasonal_budget_model.sql",
    );
    const migrationSql = fs.readFileSync(migrationPath, "utf8");
    await db.execute(sql.raw(migrationSql));
    await db.execute(sql.raw(migrationSql));
    const result = await db.execute(sql`
      SELECT
        to_regclass('public.customer_budget_months') IS NOT NULL AS table_exists,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'customers' AND column_name = 'annual_budget_goal'
        ) AS goal_exists
    `);
    assert.deepEqual(result.rows[0], { table_exists: true, goal_exists: true });
  });
});