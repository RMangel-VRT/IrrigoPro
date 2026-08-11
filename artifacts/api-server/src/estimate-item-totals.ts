// Task #1898 — pure estimate-total math, extracted so the three list readers
// (getEstimates, getEstimatesPendingApproval, getEstimateSummary) can share
// ONE batched item read instead of each issuing a query per estimate.
//
// The three readers previously repeated this arithmetic inline, each inside
// its own `Promise.all(list.map(async ...))` that fetched estimate_items for a
// single estimate. On a 365-estimate list that is 366 pooled connection
// acquisitions for one HTTP request; under the manager dashboard's fan-out
// those acquisitions queued past the pool timeout and the list 500'd.
//
// Keeping the math here also guarantees the batched path produces byte-identical
// numbers to the per-row path it replaced.

import { money } from "./lib/money";

/** Per-estimate roll-up of its `estimate_items` rows. */
export interface EstimateItemTotals {
  /** Sum of `estimate_items.total_price`. */
  partsSubtotal: number;
  /** Sum of `estimate_items.labor_hours` (used only in per_part labor mode). */
  perPartLaborHours: number;
}

export const EMPTY_ESTIMATE_ITEM_TOTALS: EstimateItemTotals = {
  partsSubtotal: 0,
  perPartLaborHours: 0,
};

/** The estimate fields the total math depends on. */
export interface EstimateTotalsInput {
  laborMode?: string | null;
  laborRate?: string | number | null;
  appliedLaborRate?: string | number | null;
  totalLaborHours?: string | number | null;
}

export interface EstimateTotals {
  partsSubtotal: number;
  laborSubtotal: number;
  totalAmount: number;
}

/**
 * Recompute an estimate's money fields from its item roll-up.
 *
 * Prefers the SNAPSHOT `appliedLaborRate` (locked at creation / conversion)
 * over the mutable `laborRate`, so a later rate change never reprices an
 * existing estimate. Flat labor mode uses the persisted `totalLaborHours`;
 * per_part mode sums the line hours.
 */
export function computeEstimateTotals(
  estimate: EstimateTotalsInput,
  totals: EstimateItemTotals | undefined,
): EstimateTotals {
  const { partsSubtotal, perPartLaborHours } = totals ?? EMPTY_ESTIMATE_ITEM_TOTALS;
  const laborRate = money(estimate.appliedLaborRate ?? estimate.laborRate);
  const totalLaborHours =
    estimate.laborMode === "flat" ? money(estimate.totalLaborHours ?? 0) : perPartLaborHours;
  const laborSubtotal = totalLaborHours * laborRate;
  return {
    partsSubtotal,
    laborSubtotal,
    totalAmount: partsSubtotal + laborSubtotal,
  };
}
