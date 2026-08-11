/**
 * billing-preview-sources.test.ts (Task #1898)
 *
 * GET /api/customers/billing-preview used to issue four storage calls per
 * customer (plus one query per billing sheet for its items). On the largest
 * tenant that was >8,000 queries for one request, which starved the shared
 * connection pool and made unrelated dashboard calls fail with
 * "timeout exceeded when trying to connect".
 *
 * The handler now makes three batched reads and assembles the payload here.
 * These tests pin the assembly: the response shape, the per-customer
 * grouping, and the fact that the money still comes from the shared
 * computeUnbilledPartition selector (so this endpoint cannot drift from
 * /api/customers/:id/billing — see customer-billing-parity.test.ts).
 *
 * Pure-function: no DB, no Express. node:test / node:assert.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBillingPreviewRows,
  groupByCustomerId,
  type BillingPreviewBillingSheet,
  type BillingPreviewCustomer,
  type BillingPreviewSources,
  type BillingPreviewWetCheckBilling,
  type BillingPreviewWorkOrder,
} from "./billing-preview-sources.js";
import { computeUnbilledPartition, resolveAsOfCutoff } from "./billing-unbilled-selectors.js";

let nextId = 1;

function wo(
  customerId: number,
  status: string,
  totalAmount: string,
  completedAt: string | null,
  invoiceId: number | null = null,
): BillingPreviewWorkOrder {
  return { id: nextId++, customerId, status, totalAmount, completedAt, invoiceId };
}

function bs(
  customerId: number,
  status: string,
  totalAmount: string,
  workDate: string | null,
  invoiceId: number | null = null,
): BillingPreviewBillingSheet {
  return { id: nextId++, customerId, status, totalAmount, workDate, invoiceId };
}

function customer(id: number, name: string): BillingPreviewCustomer {
  return { id, name, email: `c${id}@example.com`, phone: null };
}

function sources(
  wos: BillingPreviewWorkOrder[] = [],
  bss: BillingPreviewBillingSheet[] = [],
  wcbs: BillingPreviewWetCheckBilling[] = [],
): BillingPreviewSources {
  return {
    workOrdersByCustomer: groupByCustomerId(wos),
    billingSheetsByCustomer: groupByCustomerId(bss),
    wetCheckBillingsByCustomer: groupByCustomerId(wcbs),
  };
}

describe("groupByCustomerId (Task #1898)", () => {
  it("buckets rows by customer id", () => {
    const rows = [wo(1, "pending", "10", null), wo(2, "pending", "20", null), wo(1, "pending", "30", null)];
    const grouped = groupByCustomerId(rows);
    assert.equal(grouped.get(1)?.length, 2);
    assert.equal(grouped.get(2)?.length, 1);
  });

  it("drops rows with a null customer id", () => {
    // The old per-customer queries filtered on customerId = N, so an
    // unattributed row was never visible to any customer. Grouping must
    // preserve that — otherwise an orphan row would leak into a bucket.
    const orphan = { ...wo(1, "pending", "10", null), customerId: null };
    const grouped = groupByCustomerId([orphan]);
    assert.equal(grouped.size, 0);
  });
});

describe("buildBillingPreviewRows (Task #1898)", () => {
  it("returns one row per customer, in input order", () => {
    const rows = buildBillingPreviewRows(
      [customer(1, "Alpha"), customer(2, "Beta"), customer(3, "Gamma")],
      sources(),
      null,
    );
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(rows.map((r) => r.name), ["Alpha", "Beta", "Gamma"]);
  });

  it("zeroes a customer with no work at all and still emits every field", () => {
    // A customer with no rows previously got a fully-populated zero object
    // from the per-customer loop. Batching must not turn that into a sparse
    // row — the client reads every one of these fields.
    const [row] = buildBillingPreviewRows([customer(1, "Alpha")], sources(), null);
    assert.deepEqual(row, {
      id: 1,
      name: "Alpha",
      email: "c1@example.com",
      phone: null,
      unbilledAmount: 0,
      approvedTotal: 0,
      unapprovedTotal: 0,
      combinedTotal: 0,
      total: 0,
      allOpenTotal: 0,
      totalUnbilled: 0,
      allTimeApprovedTotal: 0,
      currentMonthUnbilled: 0,
      currentMonthBilling: 0,
      monthlyAverage: 0,
      billingPace: 1,
      lastInvoiceDate: null,
      totalWorkOrders: 0,
      pendingWorkOrders: 0,
      wetCheckBillings: [],
    });
  });

  it("does not leak one customer's work into another's totals", () => {
    const rows = buildBillingPreviewRows(
      [customer(1, "Alpha"), customer(2, "Beta")],
      sources([
        wo(1, "approved_passed_to_billing", "100.00", "2025-03-01T00:00:00Z"),
        wo(2, "approved_passed_to_billing", "250.00", "2025-03-01T00:00:00Z"),
      ]),
      null,
    );
    assert.equal(rows[0].approvedTotal, 100);
    assert.equal(rows[1].approvedTotal, 250);
  });

  it("delegates the money to computeUnbilledPartition rather than re-deriving it", () => {
    // If this endpoint ever grows its own arithmetic it will drift from
    // /api/customers/:id/billing. Assert equality with the selector directly.
    const wos = [
      wo(1, "approved_passed_to_billing", "100.00", "2025-03-15T00:00:00Z"),
      wo(1, "approved_passed_to_billing", "200.00", "2025-04-15T00:00:00Z"),
      wo(1, "pending_manager_review", "50.00", "2025-03-20T00:00:00Z"),
    ];
    const bss = [bs(1, "approved_passed_to_billing", "40.00", "2025-03-10T00:00:00Z")];
    const cutoff = resolveAsOfCutoff("2025-03");
    const expected = computeUnbilledPartition(wos, bss, [], cutoff);

    const [row] = buildBillingPreviewRows([customer(1, "Alpha")], sources(wos, bss), cutoff);
    assert.equal(row.approvedTotal, expected.approvedTotal);
    assert.equal(row.unapprovedTotal, expected.unapprovedTotal);
    assert.equal(row.total, expected.total);
    assert.equal(row.combinedTotal, expected.total);
    assert.equal(row.allOpenTotal, expected.allOpenTotal);
  });

  it("keeps the backward-compat aliases pointing at the right numbers", () => {
    // unbilledAmount === approvedTotal; totalUnbilled and allTimeApprovedTotal
    // are both the no-cutoff figure. Older frontend code reads all of these.
    const wos = [
      wo(1, "approved_passed_to_billing", "100.00", "2025-03-15T00:00:00Z"),
      wo(1, "approved_passed_to_billing", "200.00", "2025-09-15T00:00:00Z"),
    ];
    const cutoff = resolveAsOfCutoff("2025-03");
    const [row] = buildBillingPreviewRows([customer(1, "Alpha")], sources(wos), cutoff);

    assert.equal(row.unbilledAmount, row.approvedTotal);
    assert.equal(row.totalUnbilled, row.allOpenTotal);
    assert.equal(row.allTimeApprovedTotal, row.allOpenTotal);
    // The future-dated WO is outside the March cutoff but inside "all open".
    assert.ok(row.allOpenTotal > row.approvedTotal);
  });

  it("counts every work order, and only open ones as pending", () => {
    const wos = [
      wo(1, "pending", "10", null),
      wo(1, "assigned", "10", null),
      wo(1, "in_progress", "10", null),
      wo(1, "completed", "10", null),
      wo(1, "approved_passed_to_billing", "10", null),
    ];
    const [row] = buildBillingPreviewRows([customer(1, "Alpha")], sources(wos), null);
    assert.equal(row.totalWorkOrders, 5);
    assert.equal(row.pendingWorkOrders, 3);
  });

  it("passes wet check billings through untouched for the client to render", () => {
    const wcb: BillingPreviewWetCheckBilling = {
      id: 900,
      customerId: 1,
      status: "submitted",
      totalAmount: "75.00",
      workDate: "2025-03-05T00:00:00Z",
      invoiceId: null,
    };
    const [row] = buildBillingPreviewRows([customer(1, "Alpha")], sources([], [], [wcb]), null);
    assert.deepEqual(row.wetCheckBillings, [wcb]);
  });
});
