// Task #1898 — batched data sources + pure assembler for
// GET /api/customers/billing-preview.
//
// The handler used to loop over every visible customer and issue four
// storage calls each (work orders, estimates, billing sheets, wet check
// billings), with `getBillingSheetsByCustomer` fanning out further to one
// query per sheet for its items. On the largest tenant (2,030 visible
// customers) that is more than 8,000 pooled connection acquisitions for a
// single HTTP request. Every other dashboard call had to queue behind it,
// and the ones that waited longer than the pool's acquisition timeout threw
// "timeout exceeded when trying to connect".
//
// Three observations made the rewrite safe:
//   1. The `estimates` fetch was dead — `approvedEstimates` was computed and
//      never read. It is gone.
//   2. Billing-sheet *items* were never used by the preview; only the sheet's
//      status / invoiceId / totalAmount / workDate feed the partition. The
//      per-sheet item query is gone with them.
//   3. Everything else is a per-customer GROUP BY of rows the database can
//      return in one pass.
//
// The result is a fixed three queries regardless of customer count, and this
// module holds the grouping/shaping so it can be unit-tested without a DB.

import {
  computeUnbilledPartition,
  type BillingSheetLike,
  type WetCheckBillingLike,
  type WorkOrderLike,
} from "./billing-unbilled-selectors.js";

/** Work-order columns the preview actually needs. */
export interface BillingPreviewWorkOrder extends WorkOrderLike {
  id: number;
  customerId: number | null;
  status: string;
  invoiceId: number | null;
  totalAmount: string | null;
  completedAt: Date | string | null;
}

/** Billing-sheet columns the preview actually needs (no items). */
export interface BillingPreviewBillingSheet extends BillingSheetLike {
  id: number;
  customerId: number | null;
  status: string;
  invoiceId: number | null;
  totalAmount: string | null;
  workDate: Date | string | null;
}

/** Wet-check billings are returned whole — the client renders them. */
export interface BillingPreviewWetCheckBilling extends WetCheckBillingLike {
  id: number;
  customerId: number | null;
  status: string;
  invoiceId: number | null;
  totalAmount: string | null;
  workDate: Date | string | null;
}

export interface BillingPreviewSources {
  workOrdersByCustomer: Map<number, BillingPreviewWorkOrder[]>;
  billingSheetsByCustomer: Map<number, BillingPreviewBillingSheet[]>;
  wetCheckBillingsByCustomer: Map<number, BillingPreviewWetCheckBilling[]>;
}

export interface BillingPreviewCustomer {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface BillingPreviewRow {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  unbilledAmount: number;
  approvedTotal: number;
  unapprovedTotal: number;
  combinedTotal: number;
  total: number;
  allOpenTotal: number;
  totalUnbilled: number;
  allTimeApprovedTotal: number;
  currentMonthUnbilled: number;
  currentMonthBilling: number;
  monthlyAverage: number;
  billingPace: number;
  lastInvoiceDate: null;
  totalWorkOrders: number;
  pendingWorkOrders: number;
  wetCheckBillings: BillingPreviewWetCheckBilling[];
}

/** Statuses that count toward the "pending work orders" badge. */
const PENDING_WO_STATUSES = new Set(["pending", "assigned", "in_progress"]);

const EMPTY: never[] = [];

/**
 * Build the billing-preview payload from pre-grouped sources.
 *
 * Pure: no DB, no request. The arithmetic is delegated wholesale to
 * `computeUnbilledPartition` so this endpoint and `/api/customers/:id/billing`
 * cannot drift apart (see customer-billing-parity.test.ts).
 */
export function buildBillingPreviewRows(
  customers: BillingPreviewCustomer[],
  sources: BillingPreviewSources,
  asOfCutoff: Date | null,
): BillingPreviewRow[] {
  return customers.map((customer) => {
    const workOrders = sources.workOrdersByCustomer.get(customer.id) ?? EMPTY;
    const billingSheets = sources.billingSheetsByCustomer.get(customer.id) ?? EMPTY;
    const wetCheckBillings = sources.wetCheckBillingsByCustomer.get(customer.id) ?? EMPTY;

    const partition = computeUnbilledPartition(
      workOrders,
      billingSheets,
      wetCheckBillings,
      asOfCutoff,
    );

    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      // unbilledAmount kept for backward-compat (same as approvedTotal)
      unbilledAmount: partition.approvedTotal,
      approvedTotal: partition.approvedTotal,
      unapprovedTotal: partition.unapprovedTotal,
      // cutoff-scoped approved + unapproved
      combinedTotal: partition.total,
      total: partition.total, // cutoff-scoped; list card "Total"
      allOpenTotal: partition.allOpenTotal, // no-cutoff; "All open" view
      totalUnbilled: partition.allOpenTotal,
      allTimeApprovedTotal: partition.allOpenTotal,
      // currentMonthUnbilled removed — billing-month picker supersedes it.
      currentMonthUnbilled: 0,
      currentMonthBilling: 0,
      monthlyAverage: 0,
      billingPace: 1,
      lastInvoiceDate: null,
      totalWorkOrders: workOrders.length,
      pendingWorkOrders: workOrders.filter((wo) => PENDING_WO_STATUSES.has(wo.status)).length,
      wetCheckBillings: wetCheckBillings as BillingPreviewWetCheckBilling[],
    };
  });
}

/** Group a flat, customer-keyed result set into the per-customer map. */
export function groupByCustomerId<T extends { customerId: number | null }>(
  rows: T[],
): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    if (row.customerId == null) continue;
    const bucket = map.get(row.customerId);
    if (bucket) bucket.push(row);
    else map.set(row.customerId, [row]);
  }
  return map;
}
