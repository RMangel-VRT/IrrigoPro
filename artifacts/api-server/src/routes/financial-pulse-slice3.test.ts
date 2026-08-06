// Task #692 — Financial Pulse Slice 3 regression tests.
//
// Covers (a) role guards on each new endpoint, (b) A/R aging buckets
// summing to Outstanding A/R, and (c) sort=budget_risk ordering.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { db } from "../db";
import {
  computeArAging,
  computeOutstandingAr,
  computeTopCustomers,
  sortTopCustomers,
  type InvoiceLike,
  type CustomerWithBudget,
} from "../financial-pulse-math";

// Patch db.select to return [] for the HTTP role-guard tests (no DB).
const emptyResult: any[] = [];
const chain: any = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: any) => void) => resolve(emptyResult);
      }
      return () => chain;
    },
  },
);
(db as any).select = () => chain;

const { registerFinancialPulseRoutes } = await import("./financial-pulse");

function makeApp(role: string | undefined, companyId: number | null): Express {
  const app = express();
  app.use(express.json());
  const requireAuthentication: express.RequestHandler = (req: any, _res, next) => {
    if (role) req.authenticatedUserRole = role;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
  registerFinancialPulseRoutes(app, { requireAuthentication });
  return app;
}

async function start(app: Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

interface ServerCtx { server: Server; base: string }
const SERVERS: ServerCtx[] = [];
async function spin(role: string | undefined, companyId: number | null) {
  const ctx = await start(makeApp(role, companyId));
  SERVERS.push(ctx);
  return ctx;
}

after(async () => {
  await Promise.all(
    SERVERS.map((s) => new Promise<void>((r) => s.server.close(() => r()))),
  );
});

const SLICE3_ENDPOINTS = [
  "/api/financial-pulse/top-customers",
  "/api/financial-pulse/by-technician",
  "/api/financial-pulse/by-service-type",
  "/api/financial-pulse/ar-aging",
  "/api/financial-pulse/projections",
];

describe("Task #692 — Slice 3 role matrix", () => {
  for (const path of SLICE3_ENDPOINTS) {
    it(`${path} → 403 for field_tech`, async () => {
      const { base } = await spin("field_tech", 10);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 403);
    });

    it(`${path} → 403 for irrigation_manager`, async () => {
      const { base } = await spin("irrigation_manager", 10);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 403);
    });

    it(`${path} → 200 for company_admin`, async () => {
      const { base } = await spin("company_admin", 10);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
    });

    it(`${path} → 200 for billing_manager`, async () => {
      const { base } = await spin("billing_manager", 10);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
    });

    it(`${path} → 200 for super_admin`, async () => {
      const { base } = await spin("super_admin", null);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
    });
  }
});

describe("Task #692 — period propagation on all 5 endpoints", () => {
  for (const path of SLICE3_ENDPOINTS) {
    it(`${path} accepts ?period=mtd`, async () => {
      const { base } = await spin("super_admin", null);
      const r = await fetch(`${base}${path}?period=mtd`);
      assert.equal(r.status, 200);
    });

    it(`${path} accepts ?period=ytd`, async () => {
      const { base } = await spin("super_admin", null);
      const r = await fetch(`${base}${path}?period=ytd`);
      assert.equal(r.status, 200);
    });

    it(`${path} rejects ?period=bogus with 400`, async () => {
      const { base } = await spin("super_admin", null);
      const r = await fetch(`${base}${path}?period=bogus`);
      assert.equal(r.status, 400);
    });
  }

  it("ar-aging echoes period in response body", async () => {
    const { base } = await spin("super_admin", null);
    const r = await fetch(`${base}/api/financial-pulse/ar-aging?period=ytd`);
    const body = (await r.json()) as { period?: string };
    assert.equal(body.period, "ytd");
  });
});

describe("Task #692 — CSV export on tab endpoints", () => {
  it("top-customers honors Accept: text/csv", async () => {
    const { base } = await spin("super_admin", null);
    const r = await fetch(`${base}/api/financial-pulse/top-customers`, {
      headers: { Accept: "text/csv" },
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(r.headers.get("content-disposition") ?? "", /attachment/);
    const body = await r.text();
    assert.match(body, /^Customer ID,/);
  });

  it("by-technician honors ?format=csv", async () => {
    const { base } = await spin("super_admin", null);
    const r = await fetch(
      `${base}/api/financial-pulse/by-technician?format=csv`,
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/csv/);
    const body = await r.text();
    assert.match(body, /^Technician ID,/);
  });

  it("by-service-type honors Accept: text/csv", async () => {
    const { base } = await spin("super_admin", null);
    const r = await fetch(
      `${base}/api/financial-pulse/by-service-type`,
      { headers: { Accept: "text/csv" } },
    );
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /^Key,Label,/);
  });
});

// ─── Math-level parity / ordering checks ──────────────────────────────────

describe("Task #692 — A/R aging totals match Outstanding A/R KPI", () => {
  it("bucket sum equals computeOutstandingAr() within rounding", () => {
    const now = new Date("2026-05-19T12:00:00Z");
    const day = (n: number): Date =>
      new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
    const invoices: InvoiceLike[] = [
      // outstanding, current
      { id: 1, customerId: 1, totalAmount: "100.00", status: "sent", createdAt: day(5), paidAt: null },
      // outstanding, 30
      { id: 2, customerId: 1, totalAmount: "250.00", status: "sent", createdAt: day(35), paidAt: null },
      // outstanding, 60
      { id: 3, customerId: 1, totalAmount: "500.00", status: "sent", createdAt: day(75), paidAt: null },
      // outstanding, 90+
      { id: 4, customerId: 1, totalAmount: "1000.00", status: "sent", createdAt: day(120), paidAt: null },
      // paid — should NOT count
      { id: 5, customerId: 1, totalAmount: "9999.00", status: "paid", createdAt: day(10), paidAt: day(2) },
      // draft — should NOT count
      { id: 6, customerId: 1, totalAmount: "8888.00", status: "draft", createdAt: day(45), paidAt: null },
      // cancelled — should NOT count
      { id: 7, customerId: 1, totalAmount: "7777.00", status: "cancelled", createdAt: day(15), paidAt: null },
    ];
    const expected = computeOutstandingAr(invoices);
    const buckets = computeArAging(invoices, now);
    const sum = buckets.reduce((s, b) => s + b.amount, 0);
    assert.ok(
      Math.abs(sum - expected) < 0.01,
      `bucket sum ${sum} != outstanding ${expected}`,
    );
    // Spot-check buckets
    assert.equal(buckets[0].amount, 100);
    assert.equal(buckets[1].amount, 250);
    assert.equal(buckets[2].amount, 500);
    assert.equal(buckets[3].amount, 1000);
  });
});

describe("Task #692 — sort=budget_risk ordering", () => {
  it("orders over-cap first, then approaching, then healthy/unset by used pct desc", () => {
    const now = new Date("2026-05-19T12:00:00Z");
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const inMonth = (cid: number, amt: number): InvoiceLike => ({
      id: Math.random(),
      customerId: cid,
      totalAmount: amt,
      status: "sent",
      createdAt: new Date(monthStart.getTime() + 24 * 60 * 60 * 1000),
      paidAt: null,
    });
    const custs: CustomerWithBudget[] = [
      // c1 — over (150% of 1000 cap)
      {
        id: 1,
        companyId: 1,
        name: "C1 over",
        monthlyBudgetCap: "1000",
        budgetSoftThresholdPercent: 75,
        budgetHardThresholdPercent: 100,
      },
      // c2 — approaching (80% of 1000 cap)
      {
        id: 2,
        companyId: 1,
        name: "C2 approaching",
        monthlyBudgetCap: "1000",
        budgetSoftThresholdPercent: 75,
        budgetHardThresholdPercent: 100,
      },
      // c3 — healthy (20% of 1000 cap)
      {
        id: 3,
        companyId: 1,
        name: "C3 healthy",
        monthlyBudgetCap: "1000",
        budgetSoftThresholdPercent: 75,
        budgetHardThresholdPercent: 100,
      },
      // c4 — unset (no cap) with huge revenue, must NOT come first
      {
        id: 4,
        companyId: 1,
        name: "C4 no cap big",
        monthlyBudgetCap: null,
      },
      // c5 — over by 200% — should beat c1
      {
        id: 5,
        companyId: 1,
        name: "C5 over harder",
        monthlyBudgetCap: "1000",
        budgetSoftThresholdPercent: 75,
        budgetHardThresholdPercent: 100,
      },
    ];
    const invoices: InvoiceLike[] = [
      inMonth(1, 1500),
      inMonth(2, 800),
      inMonth(3, 200),
      inMonth(4, 999999),
      inMonth(5, 2000),
    ];
    const rows = computeTopCustomers({
      customers: custs,
      invoices,
      window: { start: monthStart, end: new Date(now.getTime() + 1) },
      now,
    });
    const sorted = sortTopCustomers(rows, "budget_risk");
    const order = sorted.map((r) => r.customerId);
    // c5 (200%) before c1 (150%) before c2 (80%) before c3 (20%) before c4 (unset)
    assert.deepEqual(order, [5, 1, 2, 3, 4]);

    // Sanity: all "over" come before any "approaching", etc.
    const statuses = sorted.map((r) => r.monthlyStatus);
    const rank: Record<string, number> = {
      over: 0,
      approaching: 1,
      healthy: 2,
      unset: 3,
    };
    for (let i = 1; i < statuses.length; i++) {
      assert.ok(
        rank[statuses[i - 1]] <= rank[statuses[i]],
        `status ordering broken at ${i}: ${statuses.join(",")}`,
      );
    }
  });

  it("default sort=revenue puts highest revenue first regardless of cap", () => {
    const now = new Date("2026-05-19T12:00:00Z");
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const custs: CustomerWithBudget[] = [
      { id: 1, companyId: 1, name: "A" },
      { id: 2, companyId: 1, name: "B" },
    ];
    const invoices: InvoiceLike[] = [
      {
        id: 10,
        customerId: 1,
        totalAmount: 100,
        status: "sent",
        createdAt: new Date(monthStart.getTime() + 1),
        paidAt: null,
      },
      {
        id: 11,
        customerId: 2,
        totalAmount: 5000,
        status: "sent",
        createdAt: new Date(monthStart.getTime() + 1),
        paidAt: null,
      },
    ];
    const rows = computeTopCustomers({
      customers: custs,
      invoices,
      window: { start: monthStart, end: new Date(now.getTime() + 1) },
      now,
    });
    const sorted = sortTopCustomers(rows, "revenue");
    assert.deepEqual(sorted.map((r) => r.customerId), [2, 1]);
  });
});
