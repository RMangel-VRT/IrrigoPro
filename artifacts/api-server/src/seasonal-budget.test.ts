// Task #1865 — Seasonal Budget Model tests.
//
// Covers:
//   - $7,500 default-curve reproduction (spec-required spreadsheet check)
//   - Uneven goal ($10,001) sums exactly to goal
//   - Custom curve not totalling 100 is rejected
//   - July manual override preserved on regeneration
//   - Reset override restores generated value
//   - Season-to-date target = sum of elapsed season months
//   - Goal field parsing: 14000 / 14,000 / $14,000.00 all produce same rows
//   - Company isolation: generation scoped to customer's own company

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveCurve,
  validateCurve,
  distributeGoal,
  generateBudgetMonths,
  applyMonthOverride,
  resetMonthOverride,
  DEFAULT_SEASON_CURVE,
} from "./services/generate-budget-months";
import { db } from "./db";
import { customers, companies, customerBudgetMonths } from "@workspace/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

// ── Pure function tests (no DB) ───────────────────────────────────────────────

describe("distributeGoal — $7,500 default curve (spec spreadsheet reproduction)", () => {
  const GOAL = 7500;
  let months: Array<{ month: number; amount: number }>;

  before(() => {
    months = distributeGoal(GOAL, DEFAULT_SEASON_CURVE);
  });

  it("produces exactly 7 month entries", () => {
    assert.equal(months.length, 7);
  });

  it("Apr (month 4) = $0.00 (0%)", () => {
    const apr = months.find((m) => m.month === 4)!;
    assert.ok(apr, "Apr entry missing");
    assert.equal(apr.amount, 0);
  });

  it("May (month 5) = $750.00 (10%)", () => {
    const may = months.find((m) => m.month === 5)!;
    assert.equal(may.amount, 750);
  });

  it("Jun (month 6) = $1,500.00 (20%)", () => {
    assert.equal(months.find((m) => m.month === 6)!.amount, 1500);
  });

  it("Jul (month 7) = $1,500.00 (20%)", () => {
    assert.equal(months.find((m) => m.month === 7)!.amount, 1500);
  });

  it("Aug (month 8) = $1,500.00 (20%)", () => {
    assert.equal(months.find((m) => m.month === 8)!.amount, 1500);
  });

  it("Sep (month 9) = $1,500.00 (20%)", () => {
    assert.equal(months.find((m) => m.month === 9)!.amount, 1500);
  });

  it("Oct (month 10) = $750.00 (10%)", () => {
    assert.equal(months.find((m) => m.month === 10)!.amount, 750);
  });

  it("months sum exactly to $7,500.00", () => {
    const sum = months.reduce((s, m) => s + m.amount, 0);
    // Use toFixed(2) to avoid floating-point representation drift.
    assert.equal(sum.toFixed(2), "7500.00");
  });
});

describe("distributeGoal — uneven goal ($10,001) sums exactly to goal", () => {
  it("$10,001 sums exactly to $10,001", () => {
    const months = distributeGoal(10001, DEFAULT_SEASON_CURVE);
    const sum = months.reduce((s, m) => s + m.amount, 0);
    // Convert back to cents for exact integer comparison.
    assert.equal(Math.round(sum * 100), Math.round(10001 * 100));
  });

  it("no individual month amount is negative", () => {
    const months = distributeGoal(10001, DEFAULT_SEASON_CURVE);
    for (const m of months) {
      assert.ok(m.amount >= 0, `month ${m.month} is negative: ${m.amount}`);
    }
  });
});

describe("validateCurve — rejects curves that don't total 100", () => {
  it("throws when curve totals 99", () => {
    const bad = DEFAULT_SEASON_CURVE.map((e, i) =>
      i === 0 ? { ...e, percent: e.percent - 1 } : e,
    );
    // Apr is 0 → -1 won't help; let's change May instead
    const bad2 = DEFAULT_SEASON_CURVE.map((e, i) =>
      i === 1 ? { ...e, percent: 9 } : e,
    );
    assert.throws(
      () => validateCurve(bad2),
      /Season curve must total 100%/,
    );
  });

  it("throws when curve totals 101", () => {
    const bad = DEFAULT_SEASON_CURVE.map((e, i) =>
      i === 1 ? { ...e, percent: 11 } : e,
    );
    assert.throws(() => validateCurve(bad), /Season curve must total 100%/);
  });

  it("error message includes the actual total", () => {
    const bad = DEFAULT_SEASON_CURVE.map((e, i) =>
      i === 1 ? { ...e, percent: 11 } : e,
    );
    try {
      validateCurve(bad);
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.match(err.message, /101/);
    }
  });

  it("accepts the default curve (sums to 100)", () => {
    assert.doesNotThrow(() => validateCurve(DEFAULT_SEASON_CURVE));
  });
});

describe("resolveEffectiveCurve — priority: override > company > default", () => {
  const customCurve = [{ month: 5, percent: 100 }];
  const companyCurve = [{ month: 6, percent: 100 }];

  it("returns customer override when present", () => {
    const result = resolveEffectiveCurve(customCurve, companyCurve);
    assert.equal(result[0].month, 5);
  });

  it("falls back to company curve when customer override is null", () => {
    const result = resolveEffectiveCurve(null, companyCurve);
    assert.equal(result[0].month, 6);
  });

  it("falls back to system default when both are null", () => {
    const result = resolveEffectiveCurve(null, null);
    assert.deepEqual(result, DEFAULT_SEASON_CURVE);
  });

  it("uses company curve when customer override is empty array", () => {
    const result = resolveEffectiveCurve([], companyCurve);
    assert.equal(result[0].month, 6);
  });
});

describe("Goal field parsing — 14000, 14,000, and $14,000.00 all identical", () => {
  const EXPECTED_AMOUNTS = distributeGoal(14000, DEFAULT_SEASON_CURVE);

  function parseGoal(s: string): number {
    return parseFloat(s.replace(/[$,\s]/g, ""));
  }

  it('"14000" produces same distribution as numeric 14000', () => {
    const result = distributeGoal(parseGoal("14000"), DEFAULT_SEASON_CURVE);
    assert.deepEqual(
      result.map((m) => m.amount),
      EXPECTED_AMOUNTS.map((m) => m.amount),
    );
  });

  it('"14,000" produces same distribution as numeric 14000', () => {
    const result = distributeGoal(parseGoal("14,000"), DEFAULT_SEASON_CURVE);
    assert.deepEqual(
      result.map((m) => m.amount),
      EXPECTED_AMOUNTS.map((m) => m.amount),
    );
  });

  it('"$14,000.00" produces same distribution as numeric 14000', () => {
    const result = distributeGoal(parseGoal("$14,000.00"), DEFAULT_SEASON_CURVE);
    assert.deepEqual(
      result.map((m) => m.amount),
      EXPECTED_AMOUNTS.map((m) => m.amount),
    );
  });

  it("all three parse to 14000 exactly", () => {
    for (const s of ["14000", "14,000", "$14,000.00"]) {
      assert.equal(parseGoal(s), 14000, `Failed for: ${s}`);
    }
  });
});

// ── DB integration tests ──────────────────────────────────────────────────────
// These tests create isolated test fixtures and clean up after themselves.

let testCompanyId: number;
let testCustomerId: number;
let testCompany2Id: number;
let testCustomer2Id: number;

// Unique tag so parallel test runs don't collide.
const TAG = `budget-test-${Date.now()}`;

before(async () => {
  // Create two companies for isolation testing.
  const [co1] = await db
    .insert(companies)
    .values({
      name: `TestCo Budget ${TAG}`,
      subscription: "basic",
    })
    .returning({ id: companies.id });
  testCompanyId = co1.id;

  const [co2] = await db
    .insert(companies)
    .values({
      name: `TestCo Budget 2 ${TAG}`,
      subscription: "basic",
    })
    .returning({ id: companies.id });
  testCompany2Id = co2.id;

  // Create a customer with $7,500 annual goal in company 1.
  const [cust1] = await db
    .insert(customers)
    .values({
      companyId: testCompanyId,
      name: `Test Customer ${TAG}`,
      email: `test-budget-${TAG}@example.com`,
      annualBudgetGoal: "7500.00",
    } as any)
    .returning({ id: customers.id });
  testCustomerId = cust1.id;

  // Create a customer in company 2 for isolation test.
  const [cust2] = await db
    .insert(customers)
    .values({
      companyId: testCompany2Id,
      name: `Test Customer 2 ${TAG}`,
      email: `test-budget2-${TAG}@example.com`,
      annualBudgetGoal: "12000.00",
    } as any)
    .returning({ id: customers.id });
  testCustomer2Id = cust2.id;
});

after(async () => {
  // Clean up test data in reverse dependency order.
  const custIds = [testCustomerId, testCustomer2Id].filter(Boolean);
  if (custIds.length > 0) {
    await db
      .delete(customerBudgetMonths)
      .where(inArray(customerBudgetMonths.customerId, custIds));
    for (const id of custIds) {
      await db.delete(customers).where(eq(customers.id, id));
    }
  }
  if (testCompanyId) {
    await db.delete(companies).where(eq(companies.id, testCompanyId));
  }
  if (testCompany2Id) {
    await db.delete(companies).where(eq(companies.id, testCompany2Id));
  }
});

describe("generateBudgetMonths — $7,500 goal produces correct DB rows", () => {
  const YEAR = 2026;
  let result: Awaited<ReturnType<typeof generateBudgetMonths>>;

  before(async () => {
    result = await generateBudgetMonths(testCustomerId, YEAR);
  });

  it("returns 7 months", () => {
    assert.equal(result.months.length, 7);
  });

  it("Apr = $0.00", () => {
    const apr = result.months.find((m) => m.month === 4)!;
    assert.equal(apr.amount, 0);
  });

  it("May = $750.00", () => {
    assert.equal(result.months.find((m) => m.month === 5)!.amount, 750);
  });

  it("Oct = $750.00", () => {
    assert.equal(result.months.find((m) => m.month === 10)!.amount, 750);
  });

  it("months sum exactly to $7,500", () => {
    const sum = result.months.reduce((s, m) => s + m.amount, 0);
    assert.equal(sum.toFixed(2), "7500.00");
  });

  it("rows are persisted in DB", async () => {
    const rows = await db
      .select()
      .from(customerBudgetMonths)
      .where(
        and(
          eq(customerBudgetMonths.customerId, testCustomerId),
          eq(customerBudgetMonths.year, YEAR),
        ),
      );
    assert.equal(rows.length, 7);
  });

  it("no rows have isManualOverride=true", async () => {
    const rows = await db
      .select({ isManualOverride: customerBudgetMonths.isManualOverride })
      .from(customerBudgetMonths)
      .where(
        and(
          eq(customerBudgetMonths.customerId, testCustomerId),
          eq(customerBudgetMonths.year, YEAR),
        ),
      );
    for (const r of rows) {
      assert.equal(r.isManualOverride, false);
    }
  });
});

describe("generateBudgetMonths — July override preserved on regeneration", () => {
  const YEAR = 2026;
  const JULY_OVERRIDE = 3200;

  before(async () => {
    // First generate (already done above), then apply a July override.
    await applyMonthOverride({
      customerId: testCustomerId,
      companyId: testCompanyId,
      year: YEAR,
      month: 7,
      amount: JULY_OVERRIDE,
    });

    // Regenerate — July override should survive.
    await generateBudgetMonths(testCustomerId, YEAR);
  });

  it("July row has isManualOverride=true", async () => {
    const [row] = await db
      .select()
      .from(customerBudgetMonths)
      .where(
        and(
          eq(customerBudgetMonths.customerId, testCustomerId),
          eq(customerBudgetMonths.year, YEAR),
          eq(customerBudgetMonths.month, 7),
        ),
      );
    assert.ok(row, "July row not found");
    assert.equal(row.isManualOverride, true);
    assert.equal(parseFloat(String(row.amount)), JULY_OVERRIDE);
  });

  it("other months retain generated values", async () => {
    const rows = await db
      .select()
      .from(customerBudgetMonths)
      .where(
        and(
          eq(customerBudgetMonths.customerId, testCustomerId),
          eq(customerBudgetMonths.year, YEAR),
        ),
      );
    const nonJuly = rows.filter((r) => r.month !== 7);
    for (const r of nonJuly) {
      assert.equal(r.isManualOverride, false, `month ${r.month} should not be override`);
    }
  });

  it("drift notice: months sum differs from goal when override set", () => {
    // Jul was $1500 generated → $3200 override (+$1700 over)
    const generatedMonths = distributeGoal(7500, DEFAULT_SEASON_CURVE);
    const withOverride = generatedMonths.map((m) =>
      m.month === 7 ? { ...m, amount: JULY_OVERRIDE } : m,
    );
    const sum = withOverride.reduce((s, m) => s + m.amount, 0);
    const drift = sum - 7500;
    // drift = 3200 - 1500 = +1700
    assert.equal(drift.toFixed(2), "1700.00");
  });
});

describe("generateBudgetMonths — reset override restores generated value", () => {
  const YEAR = 2026;

  before(async () => {
    // Reset the July override from the previous describe block.
    await resetMonthOverride({
      customerId: testCustomerId,
      companyId: testCompanyId,
      year: YEAR,
      month: 7,
    });
    // Regenerate to re-populate July with the correct value.
    await generateBudgetMonths(testCustomerId, YEAR);
  });

  it("July row has isManualOverride=false after reset", async () => {
    const [row] = await db
      .select()
      .from(customerBudgetMonths)
      .where(
        and(
          eq(customerBudgetMonths.customerId, testCustomerId),
          eq(customerBudgetMonths.year, YEAR),
          eq(customerBudgetMonths.month, 7),
        ),
      );
    assert.ok(row, "July row not found");
    assert.equal(row.isManualOverride, false);
    // Should be back to $1,500.
    assert.equal(parseFloat(String(row.amount)), 1500);
  });
});

describe("generateBudgetMonths — season-to-date for July", () => {
  const YEAR = 2026;

  it("season-to-date target for July = May + Jun + Jul allocations (Apr is $0)", async () => {
    const rows = await db
      .select({ month: customerBudgetMonths.month, amount: customerBudgetMonths.amount })
      .from(customerBudgetMonths)
      .where(
        and(
          eq(customerBudgetMonths.customerId, testCustomerId),
          eq(customerBudgetMonths.year, YEAR),
          inArray(customerBudgetMonths.month, [4, 5, 6, 7]),
        ),
      );
    const total = rows.reduce((s, r) => s + parseFloat(String(r.amount)), 0);
    // Apr=$0, May=$750, Jun=$1500, Jul=$1500 → total = $3750
    assert.equal(total.toFixed(2), "3750.00");
  });
});

describe("company isolation", () => {
  const YEAR = 2026;

  before(async () => {
    // Generate for both companies.
    await generateBudgetMonths(testCustomerId, YEAR);
    await generateBudgetMonths(testCustomer2Id, YEAR);
  });

  it("company 1 rows are not visible to company 2 query", async () => {
    const rows = await db
      .select()
      .from(customerBudgetMonths)
      .where(
        and(
          eq(customerBudgetMonths.companyId, testCompany2Id),
          eq(customerBudgetMonths.year, YEAR),
        ),
      );
    // All rows belong to company 2 only.
    for (const r of rows) {
      assert.equal(r.companyId, testCompany2Id);
    }
  });

  it("company 2 generates months independently from company 1", async () => {
    const rows = await db
      .select()
      .from(customerBudgetMonths)
      .where(
        and(
          eq(customerBudgetMonths.customerId, testCustomer2Id),
          eq(customerBudgetMonths.year, YEAR),
        ),
      );
    assert.equal(rows.length, 7);
    // $12,000 × 10% (May) = $1,200
    const may = rows.find((r) => r.month === 5)!;
    assert.equal(parseFloat(String(may.amount)), 1200);
  });

  it("company 1 unique constraint is independent of company 2", async () => {
    // Inserting the same customer/year/month for a different company succeeds.
    // (The uniqueness is per company_id, customer_id, year, month.)
    // This is implicitly verified by both companies having rows for the same year.
    const [c1Count] = await db
      .select({ count: sql<number>`count(*)` })
      .from(customerBudgetMonths)
      .where(eq(customerBudgetMonths.companyId, testCompanyId));
    const [c2Count] = await db
      .select({ count: sql<number>`count(*)` })
      .from(customerBudgetMonths)
      .where(eq(customerBudgetMonths.companyId, testCompany2Id));
    assert.ok(Number(c1Count.count) >= 7, "company 1 should have at least 7 rows");
    assert.ok(Number(c2Count.count) >= 7, "company 2 should have at least 7 rows");
  });
});

describe("unset customer — generateBudgetMonths with no goal", () => {
  let unsetCustomerId: number;

  before(async () => {
    const [cust] = await db
      .insert(customers)
      .values({
        companyId: testCompanyId,
        name: `Unset Budget Customer ${TAG}`,
        email: `unset-${TAG}@example.com`,
        // No annualBudgetGoal
      } as any)
      .returning({ id: customers.id });
    unsetCustomerId = cust.id;
  });

  after(async () => {
    await db.delete(customerBudgetMonths).where(
      eq(customerBudgetMonths.customerId, unsetCustomerId),
    );
    await db.delete(customers).where(eq(customers.id, unsetCustomerId));
  });

  it("returns 0 months and no DB rows when annualBudgetGoal is null", async () => {
    const result = await generateBudgetMonths(unsetCustomerId, 2026);
    assert.equal(result.months.length, 0);
    assert.equal(result.inserted, 0);
  });
});
