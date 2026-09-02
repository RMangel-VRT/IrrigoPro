// Task #687 — Financial Pulse Slice 1.
//
// Route-level tests for GET /api/customers/:id/budget-usage. Mounts the
// real registerBudgetRoutes() against a tiny in-memory storage stub so
// the threshold math, role gating, and multi-tenant guard all run
// against the production code path.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { registerBudgetRoutes } from "./budget-routes";
import { db } from "../db";
import { getTableName } from "drizzle-orm";

// Shim db.select to return empty WCBs so computeCustomerSpend's WCB leg
// is deterministic (tests only configure invoice data via storage stubs).
// Must be installed before any module that imports budget-spend is loaded.
function _makeMockChain(fromTableName?: string): any {
  const chain: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: any[]) => void) => {
          if (fromTableName === "customer_budget_months") {
            const amount = state.monthlyAllocs.get(state.activeCustomerId ?? -1);
            resolve(amount == null ? [] : [{ customerId: state.activeCustomerId, amount }]);
          } else {
            resolve([]);
          }
        };
      }
      if (prop === "from") {
        return (table: any) => {
          let name: string | undefined;
          try {
            name = getTableName(table);
          } catch {
            name = undefined;
          }
          return _makeMockChain(name);
        };
      }
      return () => _makeMockChain(fromTableName);
    },
  });
  return chain;
}
(db as any).select = () => _makeMockChain();

interface StubCustomer {
  id: number;
  companyId: number;
  annualBudgetGoal: string | null;
  budgetSoftThresholdPercent: number | null;
  budgetHardThresholdPercent: number | null;
}
interface StubInvoice {
  id: number;
  customerId: number;
  totalAmount: string;
  status: string;
  invoiceMonth: number;
  invoiceYear: number;
  createdAt: Date;
}

// Module-level mutable state used by the storage shim. The route file
// imports `storage` from "../storage" — we monkey-patch the two methods
// it touches before mounting the routes.
const state = {
  customers: new Map<number, StubCustomer>(),
  invoices: [] as StubInvoice[],
  monthlyAllocs: new Map<number, string>(),
  activeCustomerId: null as number | null,
};

// Patch the real storage singleton so the route under test reads from
// our in-memory map without touching Postgres.
import { storage } from "../storage";
(storage as any).getCustomer = async (id: number) => {
  state.activeCustomerId = id;
  return state.customers.get(id);
};
(storage as any).getInvoicesByCustomer = async (customerId: number) =>
  state.invoices.filter((i) => i.customerId === customerId);

function makeApp(role: string, companyId: number | null): { app: Express } {
  const app = express();
  app.use(express.json());
  // Tiny stand-in for the real requireAuthentication. Sets the same
  // fields the production middleware populates.
  const requireAuthentication: express.RequestHandler = (req: any, _res, next) => {
    req.authenticatedUserRole = role;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
  registerBudgetRoutes(app, { requireAuthentication });
  return { app };
}

async function startServer(app: Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

function setSeed() {
  state.customers.clear();
  state.invoices.length = 0;
  state.monthlyAllocs.clear();
  state.activeCustomerId = null;
  state.customers.set(1, {
    id: 1,
    companyId: 10,
    annualBudgetGoal: "10000.00",
    budgetSoftThresholdPercent: 75,
    budgetHardThresholdPercent: 100,
  });
  state.monthlyAllocs.set(1, "1000.00");
  state.customers.set(2, {
    id: 2,
    companyId: 20,
    annualBudgetGoal: null,
    budgetSoftThresholdPercent: null,
    budgetHardThresholdPercent: null,
  });
  // Three invoices for customer 1, all created in the current month
  // (bucketed by createdAt to match the dashboard rollup convention).
  const now = new Date();
  const im = now.getMonth() + 1;
  const iy = now.getFullYear();
  state.invoices.push(
    { id: 1, customerId: 1, totalAmount: "500.00", status: "paid", invoiceMonth: im, invoiceYear: iy, createdAt: now },
    { id: 2, customerId: 1, totalAmount: "300.00", status: "sent", invoiceMonth: im, invoiceYear: iy, createdAt: now },
    // draft and cancelled must be excluded.
    { id: 3, customerId: 1, totalAmount: "9999.00", status: "draft", invoiceMonth: im, invoiceYear: iy, createdAt: now },
    { id: 4, customerId: 1, totalAmount: "9999.00", status: "cancelled", invoiceMonth: im, invoiceYear: iy, createdAt: now },
  );
}

describe("GET /api/customers/:id/budget-usage", () => {
  let server: Server | undefined;
  let base = "";

  after(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  });

  it("denies field_tech with 403", async () => {
    setSeed();
    const { app } = makeApp("field_tech", 10);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    assert.equal(res.status, 403);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("denies irrigation_manager with 403 (slice 1 scope: company_admin/billing_manager/super_admin only)", async () => {
    setSeed();
    const { app } = makeApp("irrigation_manager", 10);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    assert.equal(res.status, 403);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("allows billing_manager with 200", async () => {
    setSeed();
    const { app } = makeApp("billing_manager", 10);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.monthlyStatus, "approaching");
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("denies cross-tenant reads for company_admin", async () => {
    setSeed();
    const { app } = makeApp("company_admin", 99);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    assert.equal(res.status, 404);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("computes monthly+annual spend, excluding draft/cancelled", async () => {
    setSeed();
    const { app } = makeApp("company_admin", 10);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.monthlyCap, 1000);
    assert.equal(body.monthlySpend, 800); // 500 + 300, drafts excluded
    assert.equal(body.monthlyStatus, "approaching"); // 80% of 1000 > 75% soft
    assert.equal(body.annualCap, 10000);
    assert.equal(body.annualSpend, 800);
    assert.equal(body.annualStatus, "healthy"); // 8% of 10000
    assert.ok(/^\d{4}-\d{2}$/.test(body.currentMonthKey));
    assert.ok(/^\d{4}$/.test(body.currentYearKey));
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("returns unset for both buckets when no caps are configured", async () => {
    setSeed();
    const { app } = makeApp("company_admin", 20);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/2/budget-usage`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.monthlyStatus, "unset");
    assert.equal(body.annualStatus, "unset");
    assert.equal(body.monthlyCap, null);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("classifies as over when spend equals hard threshold (boundary)", async () => {
    setSeed();
    // Bump customer 1's invoices so monthly spend == cap exactly.
    const now = new Date();
    state.invoices.push({
      id: 5, customerId: 1, totalAmount: "200.00", status: "paid",
      invoiceMonth: now.getMonth() + 1, invoiceYear: now.getFullYear(), createdAt: now,
    });
    const { app } = makeApp("super_admin", null);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    const body = (await res.json()) as any;
    assert.equal(body.monthlySpend, 1000);
    assert.equal(body.monthlyStatus, "over"); // 100% == hard threshold
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("excludes merged invoices from spend (regression: was counted before Task #1864)", async () => {
    setSeed();
    const now = new Date();
    const im = now.getMonth() + 1;
    const iy = now.getFullYear();
    // The surviving invoice (paid) + the merged ghost — merged must NOT inflate spend.
    state.invoices.push({
      id: 10, customerId: 1, totalAmount: "500.00", status: "merged",
      invoiceMonth: im, invoiceYear: iy, createdAt: now,
    });
    // Without fix: spend = 800 (paid+sent) + 500 (merged) = 1300 → over.
    // With fix: spend = 800 → approaching.
    const { app } = makeApp("company_admin", 10);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.monthlySpend, 800, "merged invoice must not inflate spend");
    assert.equal(body.monthlyStatus, "approaching");
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("excludes failed invoices from spend", async () => {
    setSeed();
    const now = new Date();
    const im = now.getMonth() + 1;
    const iy = now.getFullYear();
    state.invoices.push({
      id: 11, customerId: 1, totalAmount: "9999.00", status: "failed",
      invoiceMonth: im, invoiceYear: iy, createdAt: now,
    });
    const { app } = makeApp("company_admin", 10);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    const body = (await res.json()) as any;
    assert.equal(body.monthlySpend, 800, "failed invoice must not inflate spend");
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("response includes monthlyInvoiced and monthlyPendingNotBilled breakdown fields", async () => {
    setSeed();
    const { app } = makeApp("company_admin", 10);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/1/budget-usage`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    // WCBs stubbed to [] by the db shim so pendingNotBilled = 0.
    assert.equal(typeof body.monthlyInvoiced, "number", "monthlyInvoiced must be numeric");
    assert.equal(typeof body.monthlyPendingNotBilled, "number");
    assert.equal(typeof body.annualInvoiced, "number");
    assert.equal(typeof body.annualPendingNotBilled, "number");
    // monthlySpend = monthlyInvoiced + monthlyPendingNotBilled
    assert.equal(body.monthlySpend, body.monthlyInvoiced + body.monthlyPendingNotBilled);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("returns 404 for unknown customer ids", async () => {
    setSeed();
    const { app } = makeApp("super_admin", null);
    ({ server, base } = await startServer(app));
    const res = await fetch(`${base}/api/customers/9999/budget-usage`);
    assert.equal(res.status, 404);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });
});
