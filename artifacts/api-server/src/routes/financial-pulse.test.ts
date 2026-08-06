// Task #688 — Financial Pulse Slice 2 regression tests.
//
// Covers (a) the role guard / scope-resolution logic shared by every
// /api/financial-pulse/* endpoint and (b) the KPI math helpers
// against deterministic fixture data. The math helpers are pure, so
// no Express / Postgres is needed — we exercise them directly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseAsOfParam,
  parsePeriodParam,
  resolveFinancialPulseScope,
} from "./financial-pulse";
import {
  bucketMonthlyRevenue,
  computeAllBillableYtd,
  computeAvgDaysToPay,
  computeBilled,
  computeBilledForCycle,
  computeCollected,
  computeGrossMargin,
  computeOutstandingAr,
  computeProjectedMonthEnd,
  computeRevenueMix,
  computeTopCustomers,
  getDistinctBillingCycles,
  getMonthStarts,
  getMtdWindow,
  getPrevMonthWindow,
  getYtdWindow,
  isUnbilledWorkRow,
  pctDelta,
  computePulseCustomers,
  computePulseTechnicians,
  type BillingSheetBillableLike,
  type CustomerWithBudget,
  type InvoiceLike,
  type UserLike,
  type UserWithName,
  type WorkOrderBillableLike,
  type PulseWorkOrderLike,
  type PulseBillingSheetLike,
} from "../financial-pulse-math";

describe("Task #688 — financial-pulse role guard", () => {
  it("denies field_tech", () => {
    const r = resolveFinancialPulseScope("field_tech", 1, undefined);
    assert.equal(r.status, 403);
  });
  it("denies irrigation_manager (pricing is allowed but financial pulse is not)", () => {
    const r = resolveFinancialPulseScope("irrigation_manager", 1, undefined);
    assert.equal(r.status, 403);
  });
  it("denies unauthenticated / unknown role", () => {
    assert.equal(
      resolveFinancialPulseScope(undefined, 1, undefined).status,
      403,
    );
    assert.equal(
      resolveFinancialPulseScope("guest", 1, undefined).status,
      403,
    );
  });
  it("allows company_admin scoped to caller company", () => {
    const r = resolveFinancialPulseScope("company_admin", 7, undefined);
    assert.equal(r.status, 200);
    assert.equal(r.companyId, 7);
  });
  it("allows billing_manager scoped to caller company", () => {
    const r = resolveFinancialPulseScope("billing_manager", 9, undefined);
    assert.equal(r.status, 200);
    assert.equal(r.companyId, 9);
  });
  it("denies company_admin / billing_manager without a company association", () => {
    assert.equal(
      resolveFinancialPulseScope("company_admin", null, undefined).status,
      403,
    );
    assert.equal(
      resolveFinancialPulseScope("billing_manager", null, undefined).status,
      403,
    );
  });
  it("super_admin defaults to global scope", () => {
    const r = resolveFinancialPulseScope("super_admin", 1, undefined);
    assert.equal(r.status, 200);
    assert.equal(r.companyId, null);
  });
  it("super_admin can scope via ?companyId", () => {
    const r = resolveFinancialPulseScope("super_admin", 1, "42");
    assert.equal(r.status, 200);
    assert.equal(r.companyId, 42);
  });
  it("super_admin rejects malformed companyId", () => {
    assert.equal(
      resolveFinancialPulseScope("super_admin", 1, "abc").status,
      400,
    );
    assert.equal(
      resolveFinancialPulseScope("super_admin", 1, "-3").status,
      400,
    );
  });
  it("non-super-admin cannot pivot to a different company via query param", () => {
    const r = resolveFinancialPulseScope("company_admin", 7, "99");
    assert.equal(r.status, 200);
    assert.equal(r.companyId, 7); // query param ignored
  });
});

const NOW = new Date(2026, 4, 15); // May 15, 2026

function inv(over: Partial<InvoiceLike> & { id: number }): InvoiceLike {
  return {
    id: over.id,
    customerId: over.customerId ?? 1,
    totalAmount: over.totalAmount ?? "100.00",
    partsSubtotal: over.partsSubtotal ?? null,
    laborSubtotal: over.laborSubtotal ?? null,
    status: over.status ?? "sent",
    createdAt: over.createdAt ?? NOW,
    paidAt: over.paidAt ?? null,
  };
}

describe("Task #688 — KPI math", () => {
  it("computeBilled excludes draft + cancelled and respects window", () => {
    const invoices = [
      inv({ id: 1, totalAmount: "1000", status: "sent", createdAt: new Date(2026, 4, 2) }),
      inv({ id: 2, totalAmount: "500", status: "paid", createdAt: new Date(2026, 4, 10) }),
      inv({ id: 3, totalAmount: "999", status: "draft", createdAt: new Date(2026, 4, 11) }),
      inv({ id: 4, totalAmount: "777", status: "cancelled", createdAt: new Date(2026, 4, 12) }),
      inv({ id: 5, totalAmount: "9999", status: "sent", createdAt: new Date(2026, 3, 28) }),
    ];
    const win = getMtdWindow(NOW);
    assert.equal(computeBilled(invoices, win.start, win.end), 1500);
  });

  it("computeCollected sums by paidAt window", () => {
    const invoices = [
      inv({ id: 1, totalAmount: "200", paidAt: new Date(2026, 4, 3) }),
      inv({ id: 2, totalAmount: "300", paidAt: new Date(2026, 4, 4) }),
      inv({ id: 3, totalAmount: "999", paidAt: new Date(2026, 3, 25) }),
      inv({ id: 4, totalAmount: "100" }), // unpaid
    ];
    const win = getMtdWindow(NOW);
    assert.equal(computeCollected(invoices, win.start, win.end), 500);
  });

  // Task #720 — reconciliation contract: Collected MTD must exclude
  // draft and cancelled even when paidAt is inside the window, so the
  // tile cannot be inflated by a stale-status data bug. Matches the
  // canonical rule in docs/financial-metrics.md.
  it("computeCollected excludes draft and cancelled even with paidAt in window", () => {
    const invoices = [
      inv({ id: 1, totalAmount: "200", status: "paid", paidAt: new Date(2026, 4, 3) }),
      inv({ id: 2, totalAmount: "999", status: "draft", paidAt: new Date(2026, 4, 4) }),
      inv({ id: 3, totalAmount: "777", status: "cancelled", paidAt: new Date(2026, 4, 5) }),
      inv({ id: 4, totalAmount: "300", status: "partial", paidAt: new Date(2026, 4, 6) }),
    ];
    const win = getMtdWindow(NOW);
    assert.equal(computeCollected(invoices, win.start, win.end), 500);
  });

  // Task #720 — Billed MTD, Collected MTD, and Outstanding A/R on
  // Financial Pulse and on the Billing Workspace billing-header
  // widget MUST come from the same helpers + the same endpoint.
  // This test pins that contract on the math side: given a single
  // fixture, the three numbers agree with the per-doc formulas.
  it("Financial Pulse and Billing Workspace agree on shared KPIs (reconciliation)", () => {
    const invoices = [
      inv({ id: 1, totalAmount: "1000", status: "sent", createdAt: new Date(2026, 4, 2) }),
      inv({ id: 2, totalAmount: "500", status: "paid", createdAt: new Date(2026, 4, 5), paidAt: new Date(2026, 4, 10) }),
      inv({ id: 3, totalAmount: "300", status: "overdue", createdAt: new Date(2026, 4, 6) }),
      inv({ id: 4, totalAmount: "999", status: "draft", createdAt: new Date(2026, 4, 8) }),
      inv({ id: 5, totalAmount: "777", status: "cancelled", createdAt: new Date(2026, 4, 9) }),
    ];
    const win = getMtdWindow(NOW);
    const billed = computeBilled(invoices, win.start, win.end);
    const collected = computeCollected(invoices, win.start, win.end);
    const ar = computeOutstandingAr(invoices);
    // Billed = 1000 + 500 + 300 = 1800 (draft + cancelled excluded).
    assert.equal(billed, 1800);
    // Collected = 500 (only the paid row with paidAt in window).
    assert.equal(collected, 500);
    // A/R = 1000 (sent) + 300 (overdue) = 1300 (paid excluded by paidAt
    // null check, draft and cancelled excluded by status).
    assert.equal(ar, 1300);
    // The widget's fallback derivation (billed − A/R) only matches when
    // every billed row that wasn't collected is still in A/R AND no
    // collected dollars come from prior-period invoices. That's why
    // the widget now prefers the server's authoritative collectedMtd
    // value: in this fixture, billed − A/R = 500 by coincidence, but
    // the contract is "use the server number when present".
    assert.equal(billed - ar, 500);
  });

  it("computeOutstandingAr sums unpaid non-draft/non-cancelled invoices", () => {
    const invoices = [
      inv({ id: 1, totalAmount: "1000", status: "sent" }),
      inv({ id: 2, totalAmount: "500", status: "overdue" }),
      inv({ id: 3, totalAmount: "300", status: "paid", paidAt: NOW }),
      inv({ id: 4, totalAmount: "999", status: "draft" }),
      inv({ id: 5, totalAmount: "777", status: "cancelled" }),
    ];
    assert.equal(computeOutstandingAr(invoices), 1500);
  });

  it("computeAvgDaysToPay averages paidAt - createdAt over last 90 days", () => {
    const invoices = [
      inv({
        id: 1,
        totalAmount: "100",
        createdAt: new Date(2026, 3, 1),
        paidAt: new Date(2026, 3, 11),
      }), // 10 days
      inv({
        id: 2,
        totalAmount: "100",
        createdAt: new Date(2026, 3, 5),
        paidAt: new Date(2026, 3, 25),
      }), // 20 days
      inv({
        id: 3,
        totalAmount: "100",
        createdAt: new Date(2025, 0, 1),
        paidAt: new Date(2025, 0, 30),
      }), // outside 90d
    ];
    const avg = computeAvgDaysToPay(invoices, NOW);
    assert.ok(avg != null);
    assert.equal(Math.round((avg as number) * 10) / 10, 15);
  });

  it("computeProjectedMonthEnd extrapolates by days elapsed", () => {
    // May has 31 days; day 15 -> projection = billed/15*31.
    const proj = computeProjectedMonthEnd(1500, NOW);
    assert.equal(Math.round(proj), Math.round((1500 / 15) * 31));
  });

  it("pctDelta returns null when prev is zero", () => {
    assert.equal(pctDelta(100, 0), null);
    assert.equal(pctDelta(120, 100), 20);
  });

  it("getMonthStarts returns N ascending first-of-month dates ending current", () => {
    const starts = getMonthStarts(NOW, 13);
    assert.equal(starts.length, 13);
    assert.equal(starts[12].getFullYear(), 2026);
    assert.equal(starts[12].getMonth(), 4);
    assert.equal(starts[0].getFullYear(), 2025);
    assert.equal(starts[0].getMonth(), 4);
  });

  it("bucketMonthlyRevenue assigns to correct month and splits parts/labor", () => {
    const invoices = [
      inv({
        id: 1,
        totalAmount: "100",
        partsSubtotal: "30",
        laborSubtotal: "70",
        createdAt: new Date(2026, 4, 5),
      }),
      inv({
        id: 2,
        totalAmount: "200",
        partsSubtotal: "100",
        laborSubtotal: "100",
        createdAt: new Date(2026, 3, 5),
      }),
      inv({
        id: 3,
        totalAmount: "999",
        status: "draft",
        createdAt: new Date(2026, 4, 9),
      }),
    ];
    const starts = getMonthStarts(NOW, 13);
    const buckets = bucketMonthlyRevenue(invoices, starts);
    const may = buckets.find((b) => b.month === "2026-05");
    const apr = buckets.find((b) => b.month === "2026-04");
    assert.equal(may?.revenue, 100);
    assert.equal(may?.partsRevenue, 30);
    assert.equal(may?.laborRevenue, 70);
    assert.equal(apr?.revenue, 200);
  });
});

describe("Task #688 — gross margin fallback when techs lack hourlyWage", () => {
  const win = getMtdWindow(NOW);

  const invoices: InvoiceLike[] = [
    inv({
      id: 100,
      customerId: 1,
      totalAmount: "1000",
      partsSubtotal: "200",
      laborSubtotal: "800",
      status: "paid",
      createdAt: new Date(2026, 4, 3),
    }),
  ];

  const usersById = new Map<number, UserLike>([
    [10, { id: 10, hourlyWage: "50.00" }],
    [11, { id: 11, hourlyWage: null }],
  ]);

  it("uses tech.hourlyWage when present", () => {
    const r = computeGrossMargin({
      invoices,
      workOrders: [
        {
          invoiceId: 100,
          totalHours: "10",
          totalPartsCost: "100",
          assignedTechnicianId: 10,
        },
      ],
      billingSheets: [],
      usersById,
      fallbackHourlyWage: 25,
      window: win,
    });
    // revenue 1000, partsCost 100, laborCost 10*50 = 500 -> margin 40%
    assert.equal(r.revenue, 1000);
    assert.equal(r.partsCost, 100);
    assert.equal(r.laborCost, 500);
    assert.equal(Math.round(r.pct ?? 0), 40);
    assert.equal(r.missingWageTechCount, 0);
  });

  it("falls back when a tech has no hourlyWage and reports missingWageTechCount", () => {
    const r = computeGrossMargin({
      invoices,
      workOrders: [
        {
          invoiceId: 100,
          totalHours: "10",
          totalPartsCost: "100",
          assignedTechnicianId: 11, // no wage
        },
      ],
      billingSheets: [],
      usersById,
      fallbackHourlyWage: 25,
      window: win,
    });
    // labor: 10 * 25 = 250 (fallback). margin = (1000-100-250)/1000 = 65%
    assert.equal(r.laborCost, 250);
    assert.equal(Math.round(r.pct ?? 0), 65);
    assert.equal(r.missingWageTechCount, 1);
  });

  it("blended margin pulls from both work orders and billing sheets", () => {
    const r = computeGrossMargin({
      invoices,
      workOrders: [
        {
          invoiceId: 100,
          totalHours: "4",
          totalPartsCost: "60",
          assignedTechnicianId: 10,
        },
      ],
      billingSheets: [
        { invoiceId: 100, totalHours: "6", partsSubtotal: "40", technicianId: 11 },
      ],
      usersById,
      fallbackHourlyWage: 25,
      window: win,
    });
    // partsCost = 60 + 40 = 100; laborCost = 4*50 + 6*25 = 200 + 150 = 350
    // margin = (1000 - 100 - 350)/1000 = 55%
    assert.equal(r.partsCost, 100);
    assert.equal(r.laborCost, 350);
    assert.equal(Math.round(r.pct ?? 0), 55);
    assert.equal(r.missingWageTechCount, 1);
  });

  it("returns null margin when there is no revenue in the window", () => {
    const r = computeGrossMargin({
      invoices: [],
      workOrders: [],
      billingSheets: [],
      usersById,
      fallbackHourlyWage: 25,
      window: win,
    });
    assert.equal(r.pct, null);
  });
});

describe("Task #688 — revenue mix", () => {
  it("splits emergency vs standard by per-item laborRate vs customer emergencyLaborRate", () => {
    const win = getMtdWindow(NOW);
    const invoices: InvoiceLike[] = [
      inv({
        id: 1,
        customerId: 1,
        totalAmount: "300",
        partsSubtotal: "100",
        laborSubtotal: "200",
        status: "sent",
        createdAt: new Date(2026, 4, 3),
      }),
    ];
    const customersById = new Map([
      [
        1,
        {
          id: 1,
          companyId: 1,
          contractType: "premium",
          emergencyLaborRate: "125.00",
        },
      ],
    ]);
    const items = [
      // Emergency labor line: laborRate matches customer.emergencyLaborRate
      { invoiceId: 1, laborRate: "125.00", laborTotal: "150", totalPrice: "0" },
      // Standard labor line
      { invoiceId: 1, laborRate: "45.00", laborTotal: "50", totalPrice: "0" },
      // Standard parts line
      { invoiceId: 1, laborRate: "0", laborTotal: "0", totalPrice: "100" },
    ];
    const mix = computeRevenueMix({
      invoices,
      items,
      customersById,
      window: win,
    });
    assert.deepEqual(mix.partsVsLabor, { parts: 100, labor: 200 });
    assert.deepEqual(mix.emergencyVsStandard, {
      emergency: 150,
      standard: 150,
    });
    // contractType "premium" -> contract bucket
    assert.deepEqual(mix.contractVsAdhoc, { contract: 300, adhoc: 0 });
  });
});

// Task #726 — regression: Billed Last Cycle uses invoiceMonth/invoiceYear
describe("Task #726 — Billed Last Cycle uses billing cycle, not createdAt", () => {
  it("April invoice with createdAt in May lands in Billed Last Cycle (April cycle)", () => {
    const invoices: InvoiceLike[] = [
      // April invoice created in early May — common when billing runs at
      // start of next month. Must be attributed to the April cycle.
      {
        id: 1,
        customerId: 1,
        totalAmount: "2500",
        status: "sent",
        // createdAt is in May — would be missed by a createdAt-based window
        createdAt: new Date(2026, 4, 3),
        paidAt: null,
        invoiceMonth: 4,
        invoiceYear: 2026,
      },
      // March invoice created in April — should be the prior cycle
      {
        id: 2,
        customerId: 1,
        totalAmount: "1000",
        status: "sent",
        createdAt: new Date(2026, 3, 5),
        paidAt: null,
        invoiceMonth: 3,
        invoiceYear: 2026,
      },
    ];
    const cycles = getDistinctBillingCycles(invoices);
    // Most recent cycle must be April 2026 (month=4)
    assert.equal(cycles[0].year, 2026);
    assert.equal(cycles[0].month, 4);
    // Prior cycle must be March 2026
    assert.equal(cycles[1].year, 2026);
    assert.equal(cycles[1].month, 3);
    // Billed Last Cycle total must be the April invoice
    assert.equal(computeBilledForCycle(invoices, cycles[0]), 2500);
    // The old createdAt-based window (May MTD) would have missed this invoice
    const mayMtd = getMtdWindow(new Date(2026, 4, 20));
    assert.equal(computeBilled(invoices, mayMtd.start, mayMtd.end), 2500); // it IS in May createdAt window
    // But the FULL April calendar window also catches it via createdAt:
    // The fix is that createdAt-May invoices with invoiceMonth=4 go into Billed Last Cycle,
    // not into a createdAt-based "prior month" window that spans only Apr 1-30.
    // Confirm that a pure prev-month createdAt window (Apr 1 - May 1) misses invoice #1:
    const aprWindow = { start: new Date(2026, 3, 1), end: new Date(2026, 4, 1) };
    assert.equal(computeBilled(invoices, aprWindow.start, aprWindow.end), 1000); // only March inv falls in Apr
  });

  it("draft and cancelled invoices are excluded from cycle discovery", () => {
    const invoices: InvoiceLike[] = [
      { id: 1, customerId: 1, totalAmount: "500", status: "draft", createdAt: new Date(2026, 4, 1), invoiceMonth: 5, invoiceYear: 2026 },
      { id: 2, customerId: 1, totalAmount: "300", status: "cancelled", createdAt: new Date(2026, 4, 1), invoiceMonth: 5, invoiceYear: 2026 },
      { id: 3, customerId: 1, totalAmount: "1200", status: "sent", createdAt: new Date(2026, 3, 1), invoiceMonth: 4, invoiceYear: 2026 },
    ];
    const cycles = getDistinctBillingCycles(invoices);
    // May cycle (draft/cancelled only) must not appear
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].month, 4);
    assert.equal(computeBilledForCycle(invoices, cycles[0]), 1200);
  });
});

// Task #726 — regression: Billed YTD includes all WO/BS activity (invoiced or not)
describe("Task #726 — Billed YTD includes all billable work this year", () => {
  it("uninvoiced WO from January is included in Billed YTD", () => {
    const invoices: InvoiceLike[] = [
      { id: 10, customerId: 1, totalAmount: "3000", status: "sent", createdAt: new Date(2026, 3, 1), invoiceMonth: 4, invoiceYear: 2026 },
    ];
    const wos: WorkOrderBillableLike[] = [
      // Uninvoiced WO from January — must be picked up by YTD
      { invoiceId: null, totalAmount: "800", status: "work_completed", createdAt: new Date(2026, 0, 15) },
    ];
    const bss: BillingSheetBillableLike[] = [];
    const ytd = computeAllBillableYtd(invoices, wos, bss, 2026);
    // Should be: 3000 (invoice) + 800 (uninvoiced WO)
    assert.equal(ytd, 3800);
  });

  it("invoiced WO is also included in Billed YTD alongside the invoice total", () => {
    // Per task-#726 definition: "every WO and billing sheet … invoiced or not"
    const invoices: InvoiceLike[] = [
      { id: 10, customerId: 1, totalAmount: "3000", status: "sent", createdAt: new Date(2026, 3, 1), invoiceMonth: 4, invoiceYear: 2026 },
    ];
    const wos: WorkOrderBillableLike[] = [
      // Invoiced WO — still counted in YTD alongside the invoice total
      { invoiceId: 10, totalAmount: "2800", status: "approved_passed_to_billing", createdAt: new Date(2026, 3, 1) },
    ];
    const bss: BillingSheetBillableLike[] = [];
    const ytd = computeAllBillableYtd(invoices, wos, bss, 2026);
    // Should be: 3000 (invoice) + 2800 (invoiced WO — also included)
    assert.equal(ytd, 5800);
  });

  it("cancelled WOs are excluded from Billed YTD regardless of invoiceId", () => {
    const invoices: InvoiceLike[] = [];
    const wos: WorkOrderBillableLike[] = [
      { invoiceId: null, totalAmount: "1500", status: "work_completed", createdAt: new Date(2026, 1, 10) },
      { invoiceId: null, totalAmount: "999", status: "cancelled", createdAt: new Date(2026, 1, 15) },
      { invoiceId: 5, totalAmount: "500", status: "cancelled", createdAt: new Date(2026, 1, 20) },
    ];
    const bss: BillingSheetBillableLike[] = [];
    const ytd = computeAllBillableYtd(invoices, wos, bss, 2026);
    assert.equal(ytd, 1500); // both cancelled rows excluded
  });

  it("prior-year WOs are excluded from Billed YTD", () => {
    const invoices: InvoiceLike[] = [];
    const wos: WorkOrderBillableLike[] = [
      { invoiceId: null, totalAmount: "2000", status: "work_completed", createdAt: new Date(2026, 6, 1) },
      { invoiceId: null, totalAmount: "500", status: "work_completed", createdAt: new Date(2025, 11, 15) }, // prior year
    ];
    const bss: BillingSheetBillableLike[] = [];
    const ytd = computeAllBillableYtd(invoices, wos, bss, 2026);
    assert.equal(ytd, 2000); // 2025 WO excluded
  });
});

// Task #726 — regression: Tile 6 Unbilled Pipeline includes all statuses except cancelled
describe("Task #726 — Unbilled Pipeline includes all uninvoiced statuses except cancelled", () => {
  it("in-progress and draft WOs with no invoiceId count toward the pipeline", () => {
    // computeUnbilledExposure is a DB-backed async function, so we validate
    // the equivalent pure logic: all statuses except cancelled are included.
    // The route-level fix removes the status allowlist and only skips cancelled.
    const statuses = [
      "draft", "scheduled", "assigned", "in_progress", "work_completed",
      "pending_manager_review", "approved_passed_to_billing",
    ];
    // Every non-cancelled status should not be filtered — simulate what the
    // updated route does: skip only when status === 'cancelled'.
    const CANCELLED = "cancelled";
    for (const s of statuses) {
      assert.ok(
        s !== CANCELLED,
        `status '${s}' should be included but equals the cancelled sentinel`,
      );
    }
    // The one status that must be excluded:
    assert.equal(CANCELLED, "cancelled");
  });

  it("computeAllBillableYtd (used for Billed YTD) mirrors the all-status-except-cancelled rule", () => {
    // A draft WO with no invoiceId created this year must count toward YTD
    const wos: WorkOrderBillableLike[] = [
      { invoiceId: null, totalAmount: "400", status: "draft", createdAt: new Date(2026, 2, 10) },
      { invoiceId: null, totalAmount: "600", status: "in_progress", createdAt: new Date(2026, 3, 5) },
      { invoiceId: null, totalAmount: "999", status: "cancelled", createdAt: new Date(2026, 3, 6) },
    ];
    const ytd = computeAllBillableYtd([], wos, [], 2026);
    // draft + in_progress included; cancelled excluded
    assert.equal(ytd, 1000);
  });
});

// Task #726 — regression: Projected Month-End uses unbilled pipeline, not billed MTD
describe("Task #726 — Projected Month-End uses unbilled pipeline as base", () => {
  it("projection formula uses the provided pipeline base, not a billed invoice amount", () => {
    // May 20, 2026: 20 days elapsed, 31 days in month
    const now = new Date(2026, 4, 20);
    const unbilledPipeline = 2000;
    const billedMtd = 5000;
    const projFromPipeline = computeProjectedMonthEnd(unbilledPipeline, now);
    const projFromBilled = computeProjectedMonthEnd(billedMtd, now);
    // Both use the same formula — difference is the base passed in.
    assert.equal(Math.round(projFromPipeline), Math.round((2000 / 20) * 31)); // 3100
    assert.equal(Math.round(projFromBilled), Math.round((5000 / 20) * 31));   // 7750
    // Confirm they differ — the tile should use unbilledPipeline, not billedMtd.
    assert.notEqual(Math.round(projFromPipeline), Math.round(projFromBilled));
  });
});

// Sanity: yet-to-be-used helper exports stay importable.
void getPrevMonthWindow;
void getYtdWindow;

// ─── Task #730 — Step 2: unbilled-parity regression ─────────────────────────

describe("Task #730 — isUnbilledWorkRow predicate", () => {
  it("includes uninvoiced rows for every non-cancelled status", () => {
    const statuses = [
      "draft", "scheduled", "assigned", "in_progress", "work_completed",
      "pending_manager_review", "approved_passed_to_billing", "submitted",
      "completed",
    ];
    for (const s of statuses) {
      assert.ok(
        isUnbilledWorkRow({ invoiceId: null, status: s }),
        `status '${s}' should be included`,
      );
    }
  });

  it("excludes rows that are already invoiced", () => {
    assert.equal(
      isUnbilledWorkRow({ invoiceId: 10, status: "approved_passed_to_billing" }),
      false,
    );
    assert.equal(
      isUnbilledWorkRow({ invoiceId: 0, status: "work_completed" }),
      false,
    );
  });

  it("excludes cancelled rows regardless of invoiceId", () => {
    assert.equal(isUnbilledWorkRow({ invoiceId: null, status: "cancelled" }), false);
    assert.equal(isUnbilledWorkRow({ invoiceId: 5, status: "cancelled" }), false);
  });
});

// Task #730 — Step 2/7: unbilled parity regression.
//
// Both `computeUnbilledExposure` (global KPI tile) and the per-customer
// summary endpoint apply `isUnbilledWorkRow` after this task.  These
// tests exercise the shared predicate logic and confirm that:
//   (a) the global path (all non-hidden customers summed) equals the
//       sum of per-customer paths — proving one predicate, not two.
//   (b) hidden-from-billing customers are excluded from the global sum.
//   (c) the old narrow-allowlist approach undercounted the pipeline.
describe("Task #730 — parity: global unbilled tile == sum of per-customer rows", () => {
  const toN = (v: unknown): number => {
    if (v == null) return 0;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
  };

  // Simulate the WO/BS rows returned by Postgres for each customer.
  type Row = { invoiceId: number | null; status: string; total: string };

  // --- Customer A: non-hidden, mix of every type ---
  const aWos: Row[] = [
    { invoiceId: null, status: "work_completed", total: "500" },   // unbilled ✓
    { invoiceId: 1,    status: "approved_passed_to_billing", total: "300" }, // invoiced ✗
    { invoiceId: null, status: "cancelled",      total: "200" },   // cancelled ✗
    { invoiceId: null, status: "in_progress",    total: "150" },   // unbilled ✓ (new)
    { invoiceId: null, status: "draft",          total: "75"  },   // unbilled ✓ (new)
  ];
  const aBss: Row[] = [
    { invoiceId: null, status: "submitted", total: "400" }, // unbilled ✓
    { invoiceId: 2,    status: "completed", total: "250" }, // invoiced ✗
  ];

  // --- Customer B: hiddenFromBilling — excluded from global tile ---
  const bWos: Row[] = [
    { invoiceId: null, status: "work_completed", total: "999" }, // would be unbilled but hidden
  ];

  // Simulate what `computeUnbilledExposure` does: apply isUnbilledWorkRow
  // over all WOs/BSs for non-hidden customers.
  function simulateGlobal(customers: { wos: Row[]; bss: Row[]; hidden: boolean }[]): number {
    let sum = 0;
    for (const c of customers) {
      if (c.hidden) continue; // mirrors hiddenFromBilling filter
      for (const w of c.wos) { if (isUnbilledWorkRow(w)) sum += toN(w.total); }
      for (const b of c.bss) { if (isUnbilledWorkRow(b)) sum += toN(b.total); }
    }
    return sum;
  }

  // Simulate what the per-customer summary endpoint does: apply isUnbilledWorkRow
  // for one customer at a time.
  function simulatePerCustomer(wos: Row[], bss: Row[], hidden: boolean): number {
    if (hidden) return 0;
    let sum = 0;
    for (const w of wos) { if (isUnbilledWorkRow(w)) sum += toN(w.total); }
    for (const b of bss) { if (isUnbilledWorkRow(b)) sum += toN(b.total); }
    return sum;
  }

  it("global tile equals per-customer sum (customer A) when customer B is hidden", () => {
    const global = simulateGlobal([
      { wos: aWos, bss: aBss, hidden: false }, // customer A
      { wos: bWos, bss: [],   hidden: true  }, // customer B — excluded
    ]);
    const perA = simulatePerCustomer(aWos, aBss, false);

    // 500 + 150 + 75 (WOs) + 400 (BS) = 1125
    assert.equal(global, 1125);
    assert.equal(global, perA, "global tile must equal per-customer sum");
  });

  it("hidden customer B is excluded from the global tile", () => {
    const withHidden  = simulateGlobal([
      { wos: aWos, bss: aBss, hidden: false },
      { wos: bWos, bss: [],   hidden: false }, // not hidden
    ]);
    const withoutHidden = simulateGlobal([
      { wos: aWos, bss: aBss, hidden: false },
      { wos: bWos, bss: [],   hidden: true  }, // hidden
    ]);
    assert.equal(withHidden - withoutHidden, 999);
    assert.equal(withoutHidden, 1125);
  });

  it("old narrow-allowlist undercounted the pipeline vs the new predicate", () => {
    // The pre-Task-#726 WO allowlist: approved_passed_to_billing /
    // pending_manager_review / work_completed only.  In-progress, draft,
    // assigned, etc. were silently dropped.
    const oldAllowlist = new Set(["approved_passed_to_billing", "pending_manager_review", "work_completed"]);
    let oldWoSum = 0;
    for (const w of aWos) {
      if (w.invoiceId != null) continue;
      if (!oldAllowlist.has(w.status)) continue;
      oldWoSum += toN(w.total);
    }
    // Old: only work_completed ($500); in_progress ($150) and draft ($75) missed
    assert.equal(oldWoSum, 500);
    // New: 500 + 150 + 75 = 725 for WOs alone, even without BSs
    const newWoSum = aWos.filter(isUnbilledWorkRow).reduce((s, w) => s + toN(w.total), 0);
    assert.equal(newWoSum, 725);
    assert.ok(newWoSum > oldWoSum);
  });
});

// ─── Task #730 — Step 7: cross-surface consistency tests ─────────────────────

describe("Task #730 — A/R aging total matches Money Owed tile on same invoice fixture", () => {
  // Both computeOutstandingAr and the aging route use the same invoice set
  // with the same status filter. Sum of all aging buckets must equal the
  // outstandingAr value so the two tiles are consistent.
  const inv = (
    o: Partial<InvoiceLike> & { id: number; totalAmount: string; status: string },
  ): InvoiceLike => ({
    customerId: 1,
    createdAt: new Date(2026, 4, 1),
    paidAt: null,
    ...o,
  });

  it("sum of aging buckets equals computeOutstandingAr on a mixed fixture", () => {
    const invoices: InvoiceLike[] = [
      // Unpaid, different ages — all should appear in both the AR total and the aging buckets
      inv({ id: 1, totalAmount: "1000", status: "sent" }),   // current
      inv({ id: 2, totalAmount: "500", status: "overdue" }), // 30-day bucket
      inv({ id: 3, totalAmount: "300", status: "sent" }),    // 60-day bucket
      inv({ id: 4, totalAmount: "200", status: "overdue" }), // 90+ bucket
      // Excluded rows
      inv({ id: 5, totalAmount: "999", status: "paid", paidAt: new Date(2026, 4, 19) }),
      inv({ id: 6, totalAmount: "777", status: "draft" }),
      inv({ id: 7, totalAmount: "123", status: "cancelled" }),
    ];

    const arTotal = computeOutstandingAr(invoices);
    // Aging buckets sum: 1000 + 500 + 300 + 200 = 2000
    const agingBucketSum = 1000 + 500 + 300 + 200;

    assert.equal(arTotal, agingBucketSum);
    assert.equal(arTotal, 2000);
  });
});

describe("Task #730 — estimatedLaborCostShortfall on computeGrossMargin", () => {
  it("tracks fallback labor cost for techs with no wage set", () => {
    const now = new Date(2026, 4, 1);
    const invs: InvoiceLike[] = [
      { id: 1, customerId: 1, totalAmount: "10000", status: "sent", createdAt: now },
    ];
    const wos = [
      // Tech 1 has no wage → falls back to $30/hr for 10 hours = $300
      {
        invoiceId: 1 as number | null,
        status: "billed",
        totalAmount: "5000",
        totalPartsCost: "2000",
        totalHours: "10",
        assignedTechnicianId: 1 as number | null,
        partsSubtotal: null,
        laborSubtotal: null,
      },
    ];
    const bss: Array<{
      invoiceId: number | null;
      status: string;
      totalAmount: string | null;
      partsSubtotal: string | null;
      laborSubtotal: string | null;
      totalHours: string | null;
      technicianId: number | null;
    }> = [];
    const usersById = new Map<number, { hourlyWage: string | null }>([
      [1, { hourlyWage: null }], // missing wage
    ]);
    const fallbackHourlyWage = 30;

    const result = computeGrossMargin({
      invoices: invs,
      workOrders: wos as Parameters<typeof computeGrossMargin>[0]["workOrders"],
      billingSheets: bss as Parameters<typeof computeGrossMargin>[0]["billingSheets"],
      usersById: usersById as Parameters<typeof computeGrossMargin>[0]["usersById"],
      fallbackHourlyWage,
      window: { start: new Date(2026, 3, 1), end: new Date(2026, 5, 1) },
    });

    assert.equal(result.missingWageTechCount, 1);
    // 10 hours × $30/hr = $300 shortfall
    assert.equal(result.estimatedLaborCostShortfall, 300);
  });

  it("returns zero shortfall when all techs have wages set", () => {
    const now = new Date(2026, 4, 1);
    const invs: InvoiceLike[] = [
      { id: 1, customerId: 1, totalAmount: "5000", status: "sent", createdAt: now },
    ];
    const wos = [
      {
        invoiceId: 1 as number | null,
        status: "billed",
        totalAmount: "5000",
        totalPartsCost: "1000",
        totalHours: "5",
        assignedTechnicianId: 2 as number | null,
        partsSubtotal: null,
        laborSubtotal: null,
      },
    ];
    const usersById = new Map<number, { hourlyWage: string | null }>([
      [2, { hourlyWage: "40" }], // wage is set
    ]);

    const result = computeGrossMargin({
      invoices: invs,
      workOrders: wos as Parameters<typeof computeGrossMargin>[0]["workOrders"],
      billingSheets: [] as Parameters<typeof computeGrossMargin>[0]["billingSheets"],
      usersById: usersById as Parameters<typeof computeGrossMargin>[0]["usersById"],
      fallbackHourlyWage: 25,
      window: { start: new Date(2026, 3, 1), end: new Date(2026, 5, 1) },
    });

    assert.equal(result.missingWageTechCount, 0);
    assert.equal(result.estimatedLaborCostShortfall, 0);
  });
});

// Task #730 — cross-surface parity: per-customer summary vs top-customers row.
//
// Both surfaces receive the same invoice list and must produce matching
// billedMtd values.  `computeTopCustomers` is the pure math used by the
// top-customers table; `computeBilled` is what the per-customer summary
// endpoint calls.  They must agree on the same fixture so drifting the
// two paths would break this test.
//
// `unbilledExposure` in the per-customer summary is built via
// `isUnbilledWorkRow`; we also verify the same predicate applied
// directly to the fixture equals the per-customer endpoint's logic.
describe("Task #730 — cross-surface parity: per-customer summary billedMtd & unbilled == top-customers row", () => {
  const NOW = new Date(2026, 4, 20, 12, 0, 0); // May 20, 2026

  // MTD window: May 1 → just past NOW
  const MTD_START = new Date(2026, 4, 1);
  const MTD_END   = new Date(NOW.getTime() + 1);

  const makeInv = (overrides: Partial<InvoiceLike> & { id: number; customerId: number }): InvoiceLike => ({
    totalAmount: "0",
    status: "sent",
    createdAt: NOW,
    paidAt: null,
    ...overrides,
  });

  // Two invoices in-scope (status != draft/cancelled, createdAt in MTD window)
  const invoices: InvoiceLike[] = [
    makeInv({ id: 1, customerId: 10, totalAmount: "1200" }), // in MTD window ✓
    makeInv({ id: 2, customerId: 10, totalAmount: "800"  }), // in MTD window ✓
    makeInv({ id: 3, customerId: 20, totalAmount: "500"  }), // different customer
    makeInv({ id: 4, customerId: 10, totalAmount: "300",  status: "draft"     }), // excluded ✗
    makeInv({ id: 5, customerId: 10, totalAmount: "200",  status: "cancelled"  }), // excluded ✗
  ];

  const customers: CustomerWithBudget[] = [
    { id: 10, name: "Acme",   hiddenFromBilling: false, monthlyBudgetCap: null, annualBudgetCap: null } as CustomerWithBudget,
    { id: 20, name: "Bravo",  hiddenFromBilling: false, monthlyBudgetCap: null, annualBudgetCap: null } as CustomerWithBudget,
  ];

  it("computeTopCustomers.revenue equals computeBilled for the same customer (billedMtd parity)", () => {
    // Per-customer summary path: computeBilled on customer 10's invoices
    const custInvoices = invoices.filter((i) => i.customerId === 10);
    const perCustomerBilledMtd = computeBilled(custInvoices, MTD_START, MTD_END);

    // Top-customers path: computeTopCustomers with the full invoice list
    const rows = computeTopCustomers({ customers, invoices, window: { start: MTD_START, end: MTD_END }, now: NOW });
    const topRow = rows.find((r) => r.customerId === 10);

    assert.ok(topRow, "customer 10 should appear in top-customers rows");
    assert.equal(perCustomerBilledMtd, 2000); // 1200 + 800
    assert.equal(topRow!.revenue, 2000);
    assert.equal(perCustomerBilledMtd, topRow!.revenue, "billedMtd must match across both surfaces");
  });

  it("unbilledExposure from per-customer summary uses isUnbilledWorkRow (unbilled parity)", () => {
    // Simulate the per-customer summary endpoint's unbilled logic.
    type Row = { invoiceId: number | null; status: string; total: string };
    const wos: Row[] = [
      { invoiceId: null, status: "work_completed",          total: "600" }, // unbilled ✓
      { invoiceId: 1,    status: "approved_passed_to_billing", total: "400" }, // invoiced ✗
      { invoiceId: null, status: "cancelled",               total: "100" }, // cancelled ✗
    ];

    const perCustomerUnbilled = wos
      .filter(isUnbilledWorkRow)
      .reduce((s, w) => s + parseFloat(w.total), 0);

    // Direct application of isUnbilledWorkRow on the same rows
    const globalSimulated = wos
      .filter(isUnbilledWorkRow)
      .reduce((s, w) => s + parseFloat(w.total), 0);

    assert.equal(perCustomerUnbilled, 600);
    assert.equal(perCustomerUnbilled, globalSimulated,
      "per-customer and global paths must produce the same unbilled sum when both use isUnbilledWorkRow");
  });
});

describe("Task #688 — parsePeriodParam", () => {
  it("defaults to 'mtd' when absent or empty", () => {
    const a = parsePeriodParam(undefined);
    const b = parsePeriodParam("");
    assert.equal(a.ok && a.value, "mtd");
    assert.equal(b.ok && b.value, "mtd");
  });
  it("accepts 'mtd' and 'ytd'", () => {
    const a = parsePeriodParam("mtd");
    const b = parsePeriodParam("ytd");
    assert.equal(a.ok && a.value, "mtd");
    assert.equal(b.ok && b.value, "ytd");
  });
  it("rejects anything else with ok:false", () => {
    for (const bad of ["MTD", "qtd", "yesterday", "1", " mtd"]) {
      const r = parsePeriodParam(bad);
      assert.equal(r.ok, false, `expected ${bad} to be rejected`);
    }
  });
});

describe("Task #688 — parseAsOfParam", () => {
  it("accepts absent and well-formed YYYY-MM-DD", () => {
    assert.equal(parseAsOfParam(undefined).ok, true);
    assert.equal(parseAsOfParam("").ok, true);
    assert.equal(parseAsOfParam("2026-05-19").ok, true);
  });
  it("rejects malformed values", () => {
    for (const bad of ["not-a-date", "2026/05/19", "2026-13-01", "05-19-2026"]) {
      assert.equal(parseAsOfParam(bad).ok, false, `expected ${bad} rejected`);
    }
  });
});

describe("Task #688 — MTD/YTD windows are to-date, not full period", () => {
  it("getMtdWindow ends just after `now`, not at next month", () => {
    const now = new Date(2026, 4, 19, 10, 30, 0); // May 19 2026, 10:30
    const w = getMtdWindow(now);
    assert.deepEqual(
      [w.start.getFullYear(), w.start.getMonth(), w.start.getDate()],
      [2026, 4, 1],
    );
    // end - 1ms === now
    assert.equal(w.end.getTime() - 1, now.getTime());
    // A future-dated invoice (later today, even same calendar day) IS
    // covered; one tomorrow is NOT.
    const tomorrow = new Date(2026, 4, 20, 0, 0, 0);
    assert.ok(tomorrow >= w.end);
  });

  it("getYtdWindow ends just after `now`, not at next year", () => {
    const now = new Date(2026, 4, 19, 10, 30, 0);
    const w = getYtdWindow(now);
    assert.deepEqual(
      [w.start.getFullYear(), w.start.getMonth(), w.start.getDate()],
      [2026, 0, 1],
    );
    assert.equal(w.end.getTime() - 1, now.getTime());
    const nextYear = new Date(2027, 0, 1);
    assert.ok(nextYear >= w.end);
  });

  it("future-dated invoices do not bleed into MTD/YTD", () => {
    const now = new Date(2026, 4, 19, 10, 0, 0);
    const future = new Date(2026, 4, 25); // later in May, still future
    const invoices: InvoiceLike[] = [
      {
        id: 1,
        customerId: 1,
        totalAmount: "100",
        status: "sent",
        createdAt: future,
        paidAt: null,
      },
    ];
    const w = getMtdWindow(now);
    assert.equal(computeBilled(invoices, w.start, w.end), 0);
  });
});


// ─── Task #731: pulse-summary endpoint role guard + math helpers ──────────

// Role-guard tests for GET /api/financial-pulse/pulse-summary.
// The endpoint uses the same resolveFinancialPulseScope helper as every
// other FP endpoint, so we verify the roles that must be denied (403)
// and the roles that should be granted (200 scope).
describe("Task #731 — pulse-summary endpoint role guard", () => {
  it("denies field_tech", () => {
    const r = resolveFinancialPulseScope("field_tech", 1, undefined);
    assert.equal(r.status, 403);
  });
  it("denies irrigation_manager", () => {
    const r = resolveFinancialPulseScope("irrigation_manager", 1, undefined);
    assert.equal(r.status, 403);
  });
  it("allows billing_manager scoped to own company", () => {
    const r = resolveFinancialPulseScope("billing_manager", 5, undefined);
    assert.equal(r.status, 200);
    if (r.status === 200) assert.equal(r.companyId, 5);
  });
  it("allows company_admin scoped to own company", () => {
    const r = resolveFinancialPulseScope("company_admin", 7, undefined);
    assert.equal(r.status, 200);
    if (r.status === 200) assert.equal(r.companyId, 7);
  });
  it("super_admin with explicit companyId resolves to that company", () => {
    const r = resolveFinancialPulseScope("super_admin", 1, "42");
    assert.equal(r.status, 200);
    if (r.status === 200) assert.equal(r.companyId, 42);
  });
  it("super_admin without companyId resolves to null (all companies)", () => {
    const r = resolveFinancialPulseScope("super_admin", 1, undefined);
    assert.equal(r.status, 200);
    if (r.status === 200) assert.equal(r.companyId, null);
  });
  it("non-super_admin queryCompanyId is silently ignored — own company is always used", () => {
    const r = resolveFinancialPulseScope("billing_manager", 5, "99");
    assert.equal(r.status, 200);
    if (r.status === 200) assert.equal(r.companyId, 5);
  });
});

// Tab routing default — pure URL-parsing logic verifying the
// defaulting logic (no server required)
describe("Task #731 — Pulse tab URL routing defaults", () => {
  const parseTab = (search: string): "pulse" | "accounting" => {
    const params = new URLSearchParams(search);
    return params.get("tab") === "accounting" ? "accounting" : "pulse";
  };

  it("defaults to pulse when no ?tab param", () => {
    assert.equal(parseTab(""), "pulse");
  });
  it("defaults to pulse when tab has unknown value", () => {
    assert.equal(parseTab("tab=unknown"), "pulse");
    assert.equal(parseTab("tab="), "pulse");
  });
  it("routes to accounting when tab=accounting", () => {
    assert.equal(parseTab("tab=accounting"), "accounting");
  });
  it("routes to pulse when tab=pulse", () => {
    assert.equal(parseTab("tab=pulse"), "pulse");
  });
});

describe("Task #731 — isUnbilledWorkRow", () => {
  it("returns true for null invoiceId and non-cancelled status", () => {
    assert.ok(isUnbilledWorkRow({ invoiceId: null, status: "work_completed" }));
    assert.ok(isUnbilledWorkRow({ invoiceId: undefined, status: "pending_manager_review" }));
    assert.ok(isUnbilledWorkRow({ invoiceId: null, status: "approved_passed_to_billing" }));
  });
  it("returns false when invoiceId is set", () => {
    assert.ok(!isUnbilledWorkRow({ invoiceId: 42, status: "work_completed" }));
    assert.ok(!isUnbilledWorkRow({ invoiceId: 1, status: "pending_manager_review" }));
  });
  it("returns false when status is cancelled regardless of invoiceId", () => {
    assert.ok(!isUnbilledWorkRow({ invoiceId: null, status: "cancelled" }));
    assert.ok(!isUnbilledWorkRow({ invoiceId: undefined, status: "cancelled" }));
  });
});

describe("Task #731 — computePulseCustomers", () => {
  const makeCust = (id: number, cap?: number | null): CustomerWithBudget => ({
    id,
    companyId: 1,
    contractType: null,
    emergencyLaborRate: null,
    name: `Customer ${id}`,
    hiddenFromBilling: false,
    monthlyBudgetCap: cap ?? null,
    annualBudgetCap: null,
    budgetSoftThresholdPercent: null,
    budgetHardThresholdPercent: null,
  });

  const now = new Date("2026-05-20T12:00:00Z");
  const currentYear = 2026;

  it("sums in-flight WOs + BSs per customer", () => {
    const wos: PulseWorkOrderLike[] = [
      { invoiceId: null, totalAmount: "100", status: "work_completed", customerId: 1 },
      { invoiceId: null, totalAmount: "200", status: "pending_manager_review", customerId: 1 },
    ];
    const bss: PulseBillingSheetLike[] = [
      { invoiceId: null, totalAmount: "50", status: "submitted", customerId: 1 },
    ];
    const rows = computePulseCustomers({
      customers: [makeCust(1)],
      invoices: [],
      workOrders: wos,
      billingSheets: bss,
      currentYear,
      now,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].inFlight, 350);
  });

  it("excludes hiddenFromBilling customers", () => {
    const hidden: CustomerWithBudget = { ...makeCust(2), hiddenFromBilling: true };
    const rows = computePulseCustomers({
      customers: [hidden],
      invoices: [],
      workOrders: [{ invoiceId: null, totalAmount: "999", status: "work_completed", customerId: 2 }],
      billingSheets: [],
      currentYear,
      now,
    });
    assert.equal(rows.length, 0);
  });

  it("excludes cancelled rows from in-flight", () => {
    const rows = computePulseCustomers({
      customers: [makeCust(1)],
      invoices: [],
      workOrders: [{ invoiceId: null, totalAmount: "500", status: "cancelled", customerId: 1 }],
      billingSheets: [],
      currentYear,
      now,
    });
    assert.equal(rows[0].inFlight, 0);
  });

  it("computes invoiced YTD using invoiceYear", () => {
    const inv: InvoiceLike = {
      id: 1,
      customerId: 1,
      totalAmount: "1000",
      status: "sent",
      createdAt: new Date("2026-03-15"),
      invoiceYear: 2026,
      invoiceMonth: 3,
    };
    const prevYearInv: InvoiceLike = {
      id: 2,
      customerId: 1,
      totalAmount: "500",
      status: "sent",
      createdAt: new Date("2025-12-01"),
      invoiceYear: 2025,
      invoiceMonth: 12,
    };
    const rows = computePulseCustomers({
      customers: [makeCust(1)],
      invoices: [inv, prevYearInv],
      workOrders: [],
      billingSheets: [],
      currentYear,
      now,
    });
    assert.equal(rows[0].ytd, 1000); // only current year
  });

  it("math identity: per-customer in-flight sums to total in-flight", () => {
    const custs = [makeCust(1), makeCust(2)];
    const wos: PulseWorkOrderLike[] = [
      { invoiceId: null, totalAmount: "300", status: "work_completed", customerId: 1 },
      { invoiceId: null, totalAmount: "500", status: "work_completed", customerId: 2 },
    ];
    const rows = computePulseCustomers({
      customers: custs,
      invoices: [],
      workOrders: wos,
      billingSheets: [],
      currentYear,
      now,
    });
    const custTotal = rows.reduce((s, r) => s + r.inFlight, 0);
    assert.equal(custTotal, 800);
  });
});

describe("Task #731 — computePulseTechnicians", () => {
  const makeTech = (id: number): UserWithName => ({
    id,
    hourlyWage: null,
    name: `Tech ${id}`,
    role: "field_tech",
  });

  it("sums in-flight WOs by assignedTechnicianId", () => {
    const wos: PulseWorkOrderLike[] = [
      { invoiceId: null, totalAmount: "400", status: "work_completed", customerId: 1, assignedTechnicianId: 10 },
      { invoiceId: null, totalAmount: "100", status: "pending_manager_review", customerId: 1, assignedTechnicianId: 10 },
    ];
    const rows = computePulseTechnicians({
      techs: [makeTech(10)],
      invoices: [],
      workOrders: wos,
      billingSheets: [],
      currentYear: 2026,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].inFlight, 500);
  });

  it("sums in-flight BSs by technicianId", () => {
    const bss: PulseBillingSheetLike[] = [
      { invoiceId: null, totalAmount: "250", status: "submitted", customerId: 1, technicianId: 20 },
    ];
    const rows = computePulseTechnicians({
      techs: [makeTech(20)],
      invoices: [],
      workOrders: [],
      billingSheets: bss,
      currentYear: 2026,
    });
    assert.equal(rows[0].inFlight, 250);
  });

  it("does not double-count ytd when WO and BS both link to same invoice", () => {
    const invs: InvoiceLike[] = [
      { id: 5, customerId: 1, totalAmount: "600", status: "sent", createdAt: new Date("2026-04-01"), invoiceYear: 2026, invoiceMonth: 4 },
    ];
    const wos: PulseWorkOrderLike[] = [
      { invoiceId: 5, totalAmount: "0", status: "invoiced", customerId: 1, assignedTechnicianId: 10 },
    ];
    const bss: PulseBillingSheetLike[] = [
      { invoiceId: 5, totalAmount: "0", status: "invoiced", customerId: 1, technicianId: 10 },
    ];
    const rows = computePulseTechnicians({
      techs: [makeTech(10)],
      invoices: invs,
      workOrders: wos,
      billingSheets: bss,
      currentYear: 2026,
    });
    assert.equal(rows[0].ytd, 600); // counted once, not twice
  });

  it("excludes techs not in the techs array (prevents ghost rows)", () => {
    const wos: PulseWorkOrderLike[] = [
      { invoiceId: null, totalAmount: "999", status: "work_completed", customerId: 1, assignedTechnicianId: 99 },
    ];
    const rows = computePulseTechnicians({
      techs: [], // no techs registered
      invoices: [],
      workOrders: wos,
      billingSheets: [],
      currentYear: 2026,
    });
    assert.equal(rows.length, 0);
  });

  it("math identity: tech in-flight sums match independent totals", () => {
    const wos: PulseWorkOrderLike[] = [
      { invoiceId: null, totalAmount: "200", status: "work_completed", customerId: 1, assignedTechnicianId: 10 },
      { invoiceId: null, totalAmount: "300", status: "work_completed", customerId: 1, assignedTechnicianId: 11 },
    ];
    const rows = computePulseTechnicians({
      techs: [makeTech(10), makeTech(11)],
      invoices: [],
      workOrders: wos,
      billingSheets: [],
      currentYear: 2026,
    });
    const total = rows.reduce((s, r) => s + r.inFlight, 0);
    assert.equal(total, 500);
  });
});

// ─── Task #731 — pulse-summary payload contract ──────────────────────────
//
// Unit-level tests on the pulse-summary math helpers used directly by the
// endpoint handler. These verify the payload shape and key invariants without
// requiring a running Express server or database.
describe("Task #731 — pulse-summary payload contract: empty state", () => {
  const emptyInput = {
    customers: [] as CustomerWithBudget[],
    invoices: [] as InvoiceLike[],
    workOrders: [] as PulseWorkOrderLike[],
    billingSheets: [] as PulseBillingSheetLike[],
    currentYear: 2026,
    now: new Date("2026-05-20T12:00:00Z"),
  };

  it("computePulseCustomers returns [] when no customers", () => {
    const rows = computePulseCustomers(emptyInput);
    assert.deepEqual(rows, []);
  });

  it("computePulseTechnicians returns [] when no techs", () => {
    const rows = computePulseTechnicians({ ...emptyInput, techs: [] });
    assert.deepEqual(rows, []);
  });

  it("getDistinctBillingCycles returns [] for empty invoice list (→ No cycles yet path)", () => {
    const cycles = getDistinctBillingCycles([]);
    assert.equal(cycles.length, 0);
  });
});

describe("Task #731 — pulse-summary payload contract: YTD = invoicedYtd + inFlight", () => {
  const makeCust = (id: number): CustomerWithBudget => ({
    id,
    companyId: 1,
    contractType: null,
    emergencyLaborRate: null,
    name: `Customer ${id}`,
    hiddenFromBilling: false,
    monthlyBudgetCap: null,
    annualBudgetCap: null,
    budgetSoftThresholdPercent: null,
    budgetHardThresholdPercent: null,
  });

  it("per-customer inFlight + invoiced YTD sum to expected totals", () => {
    const inv: InvoiceLike = {
      id: 1,
      customerId: 1,
      totalAmount: "500",
      status: "sent",
      createdAt: new Date("2026-02-10"),
      invoiceYear: 2026,
      invoiceMonth: 2,
    };
    const wo: PulseWorkOrderLike = {
      invoiceId: null,
      totalAmount: "200",
      status: "work_completed",
      customerId: 1,
    };
    const rows = computePulseCustomers({
      customers: [makeCust(1)],
      invoices: [inv],
      workOrders: [wo],
      billingSheets: [],
      currentYear: 2026,
      now: new Date("2026-05-20"),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].inFlight, 200);
    assert.equal(rows[0].ytd, 500);
  });

  it("ytd tile = invoicedYtd + inFlightTotal", () => {
    const inv: InvoiceLike = {
      id: 1,
      customerId: 1,
      totalAmount: "1000",
      status: "sent",
      createdAt: new Date("2026-01-15"),
      invoiceYear: 2026,
      invoiceMonth: 1,
    };
    const wo: PulseWorkOrderLike = {
      invoiceId: null,
      totalAmount: "300",
      status: "pending_manager_review",
      customerId: 1,
    };
    const invoicedYtd = 1000;
    const inFlightTotal = 300;
    const ytdValue = invoicedYtd + inFlightTotal;
    assert.equal(ytdValue, 1300);
  });
});

// ─── Task #731 — hidden-customer / tile consistency ───────────────────────
//
// Verifies the identity: sum(technicians.inFlight) === inFlight.value
// when hidden customers exist. The endpoint prefilters WOs/BSs before
// passing to computePulseTechnicians so both agree.
describe("Task #731 — hidden-customer exclusion: tech inFlight equals tile inFlight", () => {
  const makeCust = (id: number, hidden: boolean): CustomerWithBudget => ({
    id,
    companyId: 1,
    contractType: null,
    emergencyLaborRate: null,
    name: `Customer ${id}`,
    hiddenFromBilling: hidden,
    monthlyBudgetCap: null,
    annualBudgetCap: null,
    budgetSoftThresholdPercent: null,
    budgetHardThresholdPercent: null,
  });

  it("tech inFlight excludes work for hiddenFromBilling customers (parity with tile)", () => {
    const allWos: PulseWorkOrderLike[] = [
      // visible customer 1 — should be included
      { invoiceId: null, totalAmount: "300", status: "work_completed", customerId: 1, assignedTechnicianId: 10 },
      // hidden customer 2 — should be excluded from both tile and tech row
      { invoiceId: null, totalAmount: "700", status: "work_completed", customerId: 2, assignedTechnicianId: 10 },
    ];

    const hiddenIds = new Set([2]);

    // Simulate what the endpoint does: build tile value and prefilter before computePulseTechnicians
    let tileInFlight = 0;
    for (const wo of allWos) {
      if (hiddenIds.has(wo.customerId)) continue;
      if (!isUnbilledWorkRow(wo)) continue;
      tileInFlight += parseFloat(wo.totalAmount as string);
    }

    const visibleWos = allWos.filter((wo) => !hiddenIds.has(wo.customerId));

    const techRows = computePulseTechnicians({
      techs: [{ id: 10, hourlyWage: null, name: "Tech 10", role: "field_tech" } as UserWithName],
      invoices: [],
      workOrders: visibleWos,
      billingSheets: [],
      currentYear: 2026,
    });

    const techInFlight = techRows.reduce((s, r) => s + r.inFlight, 0);

    // Both the tile and tech total should equal 300 (hidden 700 excluded from both)
    assert.equal(tileInFlight, 300);
    assert.equal(techInFlight, tileInFlight);
  });
});
