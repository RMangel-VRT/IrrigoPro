/**
 * estimate-item-totals.test.ts (Task #1898)
 *
 * `getEstimates`, `getEstimatesPendingApproval` and `getEstimateSummary` used
 * to each fetch estimate_items with one query per estimate. They now share a
 * single batched roll-up and this pure helper. These tests pin the arithmetic
 * so the batched path cannot silently reprice an estimate.
 *
 * Pure-function: no DB, no Express. node:test / node:assert.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeEstimateTotals,
  EMPTY_ESTIMATE_ITEM_TOTALS,
} from "./estimate-item-totals.js";

describe("computeEstimateTotals (Task #1898)", () => {
  it("per_part mode multiplies the summed line hours by the labor rate", () => {
    const t = computeEstimateTotals(
      { laborMode: "per_part", laborRate: "50.00", totalLaborHours: "999" },
      { partsSubtotal: 120.5, perPartLaborHours: 3 },
    );
    assert.equal(t.partsSubtotal, 120.5);
    assert.equal(t.laborSubtotal, 150);
    assert.equal(t.totalAmount, 270.5);
  });

  it("flat mode ignores line hours and uses the persisted totalLaborHours", () => {
    const t = computeEstimateTotals(
      { laborMode: "flat", laborRate: "50.00", totalLaborHours: "2.5" },
      { partsSubtotal: 100, perPartLaborHours: 99 },
    );
    assert.equal(t.laborSubtotal, 125);
    assert.equal(t.totalAmount, 225);
  });

  it("prefers the appliedLaborRate snapshot over the mutable laborRate", () => {
    // The snapshot is locked at creation / conversion. A later change to the
    // customer's rate must not reprice an existing estimate.
    const t = computeEstimateTotals(
      { laborMode: "per_part", laborRate: "200.00", appliedLaborRate: "50.00" },
      { partsSubtotal: 0, perPartLaborHours: 2 },
    );
    assert.equal(t.laborSubtotal, 100);
  });

  it("falls back to laborRate when there is no snapshot", () => {
    const t = computeEstimateTotals(
      { laborMode: "per_part", laborRate: "75.00", appliedLaborRate: null },
      { partsSubtotal: 0, perPartLaborHours: 2 },
    );
    assert.equal(t.laborSubtotal, 150);
  });

  it("treats an estimate with no items row as all-zero, not NaN", () => {
    // The batched query only returns a row for estimates that HAVE items, so
    // the lookup misses for empty estimates. That must read as 0, matching
    // the old per-estimate query that returned an empty item array.
    const t = computeEstimateTotals(
      { laborMode: "per_part", laborRate: "50.00" },
      undefined,
    );
    assert.equal(t.partsSubtotal, 0);
    assert.equal(t.laborSubtotal, 0);
    assert.equal(t.totalAmount, 0);
    assert.equal(t.totalAmount.toFixed(2), "0.00");
  });

  it("coerces null/NaN money columns to zero rather than poisoning the sum", () => {
    const t = computeEstimateTotals(
      { laborMode: "flat", laborRate: null, totalLaborHours: null },
      EMPTY_ESTIMATE_ITEM_TOTALS,
    );
    assert.equal(Number.isFinite(t.totalAmount), true);
    assert.equal(t.totalAmount, 0);
  });
});
