// Task #708 — Cross-surface consistency tests.
//
// Slice 5 widgetizes FP across four surfaces (admin dashboard,
// customer detail, A/R aging on /invoices, and the top-customers
// compact list). The contract is that every surface reads from the
// same underlying math helpers, so equivalent rollups must agree.
//
// These tests pin the math-layer invariants the widgets depend on:
//
//   1. A/R parity — `computeOutstandingAr(all)` equals the sum of
//      every bucket returned by `computeArAging(all, now)`.
//   2. Top-customer row revenue agrees with the per-customer summary
//      `billedYtd` computed via `computeBilled` filtered to that
//      same customer.
//   3. Per-customer `billedMtd` is exactly `computeBilled(invoices,
//      mtdStart, mtdEnd)` filtered to that customer — i.e. the
//      consolidated admin KPI is just the sum of per-customer
//      summaries over the same window.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeArAging,
  computeBilled,
  computeOutstandingAr,
  computeTopCustomers,
  getMtdWindow,
  getYtdWindow,
  type InvoiceLike,
} from "../financial-pulse-math";

// Build a small, deterministic invoice fixture spanning multiple
// customers, statuses, ages, and time buckets. All money values are
// strings to match Drizzle's numeric() shape; createdAt as Date
// because the math helpers normalize both.
const NOW = new Date("2026-05-19T12:00:00Z");

function daysAgo(d: number): Date {
  return new Date(NOW.getTime() - d * 86_400_000);
}

const INVOICES: InvoiceLike[] = [
  // Customer 1 — paid in window, in-A/R outstanding, and one draft
  // (excluded everywhere).
  { id: 1, customerId: 1, totalAmount: "500.00", status: "paid",   createdAt: daysAgo(10), paidAt: daysAgo(2) },
  { id: 2, customerId: 1, totalAmount: "300.00", status: "sent",   createdAt: daysAgo(15), paidAt: null },
  { id: 3, customerId: 1, totalAmount: "999.99", status: "draft",  createdAt: daysAgo(5),  paidAt: null },
  // Customer 2 — three open invoices in different aging buckets.
  { id: 4, customerId: 2, totalAmount: "100.00", status: "sent",      createdAt: daysAgo(5),   paidAt: null },
  { id: 5, customerId: 2, totalAmount: "200.00", status: "sent",      createdAt: daysAgo(45),  paidAt: null },
  { id: 6, customerId: 2, totalAmount: "400.00", status: "overdue",   createdAt: daysAgo(120), paidAt: null },
  // Customer 3 — paid invoice this year, one cancelled (excluded).
  { id: 7, customerId: 3, totalAmount: "800.00", status: "paid",      createdAt: daysAgo(60),  paidAt: daysAgo(30) },
  { id: 8, customerId: 3, totalAmount: "150.00", status: "cancelled", createdAt: daysAgo(20),  paidAt: null },
];

describe("Task #708 — FP cross-surface math invariants", () => {
  it("A/R aging buckets sum to outstanding A/R total (parity)", () => {
    const ar = computeOutstandingAr(INVOICES);
    const buckets = computeArAging(INVOICES, NOW);
    const bucketSum = buckets.reduce((acc, b) => acc + b.amount, 0);
    // Use a sub-cent tolerance to absorb decimal rounding.
    assert.ok(
      Math.abs(ar - bucketSum) < 0.01,
      `A/R total ${ar} != bucket sum ${bucketSum}`,
    );
  });

  it("Per-customer billedYtd agrees with the consolidated admin rollup", () => {
    const ytd = getYtdWindow(NOW);
    const adminBilledYtd = computeBilled(INVOICES, ytd.start, ytd.end);

    // The per-customer summary endpoint filters invoices to one
    // customer and runs the same helper. The sum across all
    // customers must equal the admin rollup.
    const perCustomer = [1, 2, 3].map((cid) =>
      computeBilled(
        INVOICES.filter((i) => i.customerId === cid),
        ytd.start,
        ytd.end,
      ),
    );
    const sum = perCustomer.reduce((acc, n) => acc + n, 0);
    assert.ok(
      Math.abs(adminBilledYtd - sum) < 0.01,
      `admin YTD ${adminBilledYtd} != Σ per-customer ${sum}`,
    );
  });

  it("Top-customers row revenue == per-customer summary billedYtd for the same customer", () => {
    const ytd = getYtdWindow(NOW);
    // computeTopCustomers groups invoices by customer over a window.
    // Use the YTD window so the result is directly comparable to the
    // per-customer summary `billedYtd`.
    const rows = computeTopCustomers({
      customers: [
        { id: 1, companyId: 10, name: "Customer 1", hiddenFromBilling: false,
          monthlyBudgetCap: null, annualBudgetCap: null,
          budgetSoftThresholdPercent: null, budgetHardThresholdPercent: null },
        { id: 2, companyId: 10, name: "Customer 2", hiddenFromBilling: false,
          monthlyBudgetCap: null, annualBudgetCap: null,
          budgetSoftThresholdPercent: null, budgetHardThresholdPercent: null },
        { id: 3, companyId: 10, name: "Customer 3", hiddenFromBilling: false,
          monthlyBudgetCap: null, annualBudgetCap: null,
          budgetSoftThresholdPercent: null, budgetHardThresholdPercent: null },
      ],
      invoices: INVOICES,
      window: { start: ytd.start, end: ytd.end },
      now: NOW,
    });
    for (const row of rows) {
      const summaryBilledYtd = computeBilled(
        INVOICES.filter((i) => i.customerId === row.customerId),
        ytd.start,
        ytd.end,
      );
      assert.ok(
        Math.abs(row.revenue - summaryBilledYtd) < 0.01,
        `top-customer row ${row.customerId} revenue ${row.revenue} != summary ${summaryBilledYtd}`,
      );
    }
  });

  it("Per-customer billedMtd matches admin billedMtd window-for-window", () => {
    const mtd = getMtdWindow(NOW);
    const adminBilledMtd = computeBilled(INVOICES, mtd.start, mtd.end);
    const perCustomerSum = [1, 2, 3]
      .map((cid) =>
        computeBilled(
          INVOICES.filter((i) => i.customerId === cid),
          mtd.start,
          mtd.end,
        ),
      )
      .reduce((acc, n) => acc + n, 0);
    assert.ok(
      Math.abs(adminBilledMtd - perCustomerSum) < 0.01,
      `admin MTD ${adminBilledMtd} != Σ per-customer ${perCustomerSum}`,
    );
  });
});
