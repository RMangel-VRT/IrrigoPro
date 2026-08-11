// Task #1864 — Unit tests for computeCustomerSpend.
//
// These tests exercise the canonical spend function that replaces three
// diverging hand-rolled loops in budget-routes, budget-alert-service, and
// financial-pulse customer summary. The function has two I/O seams:
//
//   1. storage.getInvoicesByCustomer  — patched in-memory (no Postgres)
//   2. db.select                      — proxied via a tiny chainable shim
//
// The shim approach mirrors financial-pulse-customer-summary.test.ts which
// uses the same technique. Each test controls what the shim returns.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// ── db shim must be installed BEFORE the module under test is imported ──
import { db } from "./db";

// Configurable WCB rows returned by the db.select shim.
let nextWcbRows: Array<{
  invoiceId: number | null;
  totalAmount: string;
  workDate: Date;
}> = [];

const chain: any = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: any) => void) => resolve(nextWcbRows);
      }
      return () => chain;
    },
  },
);
(db as any).select = () => chain;

// ── storage shim ─────────────────────────────────────────────────────────────
import { storage } from "./storage";

interface FakeInvoice {
  id: number;
  customerId: number;
  companyId: number;
  status: string;
  totalAmount: string;
  createdAt: Date;
}

let nextInvoices: FakeInvoice[] = [];
let capturedCompanyId: number | null | undefined = undefined;

(storage as any).getInvoicesByCustomer = async (
  customerId: number,
  companyId: number | null,
) => {
  capturedCompanyId = companyId;
  return nextInvoices.filter((i) => i.customerId === customerId);
};

// ── module under test — imported AFTER shims ─────────────────────────────────
const { computeCustomerSpend } = await import("./budget-spend");

// ── helpers ───────────────────────────────────────────────────────────────────
const now = new Date();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
const monthWindow = { start: monthStart, end: monthEnd };

function inv(
  id: number,
  status: string,
  amount: string,
  createdAt: Date = now,
): FakeInvoice {
  return { id, customerId: 1, companyId: 10, status, totalAmount: amount, createdAt };
}

function wcb(
  invoiceId: number | null,
  amount: string,
  workDate: Date = now,
): { invoiceId: number | null; totalAmount: string; workDate: Date } {
  return { invoiceId, totalAmount: amount, workDate };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("computeCustomerSpend", () => {
  it("counts a normal (paid/sent) invoice in invoiced", async () => {
    nextInvoices = [inv(1, "paid", "500.00"), inv(2, "sent", "300.00")];
    nextWcbRows = [];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 800);
    assert.equal(r.pendingNotBilled, 0);
    assert.equal(r.total, 800);
  });

  it("excludes merged invoices (regression — was counted before)", async () => {
    // The surviving invoice is also present; the merged one must not inflate.
    nextInvoices = [
      inv(1, "paid", "500.00"),
      inv(2, "merged", "500.00"), // same amount as surviving — must not double-count
    ];
    nextWcbRows = [];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 500, "merged invoice must be excluded");
    assert.equal(r.total, 500);
  });

  it("excludes failed invoices", async () => {
    nextInvoices = [inv(1, "paid", "300.00"), inv(2, "failed", "200.00")];
    nextWcbRows = [];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 300);
    assert.equal(r.total, 300);
  });

  it("excludes draft, cancelled, superseded", async () => {
    nextInvoices = [
      inv(1, "paid", "100.00"),
      inv(2, "draft", "9999.00"),
      inv(3, "cancelled", "9999.00"),
      inv(4, "superseded", "9999.00"),
    ];
    nextWcbRows = [];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 100);
    assert.equal(r.total, 100);
  });

  it("counts uninvoiced WCB in pendingNotBilled", async () => {
    nextInvoices = [inv(1, "paid", "400.00")];
    nextWcbRows = [wcb(null, "150.00")]; // uninvoiced → pendingNotBilled
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 400);
    assert.equal(r.pendingNotBilled, 150);
    assert.equal(r.total, 550);
  });

  it("does not double-count an invoiced WCB", async () => {
    // WCB with invoiceId set → already in invoice totals, must be skipped.
    nextInvoices = [inv(1, "paid", "400.00")];
    nextWcbRows = [wcb(1, "400.00")]; // invoiceId=1 → skip
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 400);
    assert.equal(r.pendingNotBilled, 0);
    assert.equal(r.total, 400);
  });

  it("window boundary: invoice on first instant of window is included", async () => {
    nextInvoices = [inv(1, "paid", "100.00", monthStart)];
    nextWcbRows = [];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 100);
  });

  it("window boundary: invoice one ms before window start is excluded", async () => {
    const justBefore = new Date(monthStart.getTime() - 1);
    nextInvoices = [inv(1, "paid", "100.00", justBefore)];
    nextWcbRows = [];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 0);
  });

  it("window boundary: invoice at end instant (exclusive) is excluded", async () => {
    nextInvoices = [inv(1, "paid", "100.00", monthEnd)];
    nextWcbRows = [];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.invoiced, 0);
  });

  it("window boundary: WCB workDate on first instant is included", async () => {
    nextInvoices = [];
    nextWcbRows = [wcb(null, "75.00", monthStart)];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.pendingNotBilled, 75);
  });

  it("window boundary: WCB workDate one ms before window start is excluded", async () => {
    const justBefore = new Date(monthStart.getTime() - 1);
    nextInvoices = [];
    nextWcbRows = [wcb(null, "75.00", justBefore)];
    const r = await computeCustomerSpend(1, 10, monthWindow);
    assert.equal(r.pendingNotBilled, 0);
  });

  it("company isolation: passes companyId to getInvoicesByCustomer (not null)", async () => {
    nextInvoices = [];
    nextWcbRows = [];
    capturedCompanyId = undefined;
    await computeCustomerSpend(1, 42, monthWindow);
    assert.equal(capturedCompanyId, 42, "must scope invoice query to company 42");
  });

  it("company isolation: super_admin can pass null for global view", async () => {
    nextInvoices = [];
    nextWcbRows = [];
    capturedCompanyId = undefined;
    await computeCustomerSpend(1, null, monthWindow);
    assert.equal(capturedCompanyId, null, "null companyId → global view for super_admin");
  });
});

// Task #1911 — budget regression guard. Do not delete these as duplicates of
// the storage-reader tests: they pin the *consequence*, not the mechanism.
//
// getInvoicesByCustomer used to swallow database errors and return []. That
// made the invoice leg of this calculation compute to zero, so a customer
// already over their cap read as comfortably under it — the single most
// dangerous way this function can be wrong, because nothing about the output
// looks broken. The failure has to travel.
describe("computeCustomerSpend — an over-budget customer must never read as under budget", () => {
  it("propagates a failing invoice query instead of reporting zero invoiced", async () => {
    const dbDown = new Error("Failed query: timeout exceeded when trying to connect");
    const prev = (storage as any).getInvoicesByCustomer;
    (storage as any).getInvoicesByCustomer = async () => {
      throw dbDown;
    };
    nextWcbRows = [];

    try {
      await assert.rejects(
        computeCustomerSpend(1, 10, monthWindow),
        (err: unknown) => {
          assert.equal(err, dbDown, "the database error must reach the caller");
          return true;
        },
        "a failed invoice lookup must not resolve to a spend total",
      );
    } finally {
      (storage as any).getInvoicesByCustomer = prev;
    }
  });

  it("does not fall back to the wet-check leg alone when invoices fail to load", async () => {
    // The specific bad outcome: $9,000 of invoices are invisible, $50 of
    // uninvoiced wet-check work is not, and the caller is handed $50 as if it
    // were this customer's whole spend.
    const prev = (storage as any).getInvoicesByCustomer;
    (storage as any).getInvoicesByCustomer = async () => {
      throw new Error("Failed query: connection terminated unexpectedly");
    };
    nextWcbRows = [wcb(null, "50.00")];

    try {
      await assert.rejects(
        computeCustomerSpend(1, 10, monthWindow),
        "a partial total is worse than no total — it looks like a real number",
      );
    } finally {
      (storage as any).getInvoicesByCustomer = prev;
    }
  });
});
