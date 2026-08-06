// Task #708 — HTTP test for /api/financial-pulse/customer/:id/summary.
//
// Verifies the role guard matches the rest of FP, the response shape
// is what the customer-detail widget consumes, and the
// monthly-budget bucket math matches the BudgetCard contract.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { db } from "../db";

// Stub `db.select()` to return the same chainable shim used by the
// existing FP HTTP tests. We override the resolver per-test to inject
// the rows each endpoint expects (customer row, invoices, work orders,
// billing sheets).
let nextResolver: () => any[] = () => [];
const chain: any = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: any) => void) => resolve(nextResolver());
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

const SERVERS: { server: Server }[] = [];
async function spin(role: string | undefined, companyId: number | null) {
  const ctx = await start(makeApp(role, companyId));
  SERVERS.push(ctx);
  return ctx;
}

after(async () => {
  await Promise.all(
    SERVERS.map(
      (s) => new Promise<void>((r) => s.server.close(() => r())),
    ),
  );
});

const PATH = "/api/financial-pulse/customer/42/summary";

describe("Task #708 — /api/financial-pulse/customer/:id/summary", () => {
  it("→ 403 for field_tech", async () => {
    nextResolver = () => [];
    const { base } = await spin("field_tech", 10);
    const r = await fetch(`${base}${PATH}`);
    assert.equal(r.status, 403);
  });

  it("→ 403 for irrigation_manager", async () => {
    nextResolver = () => [];
    const { base } = await spin("irrigation_manager", 10);
    const r = await fetch(`${base}${PATH}`);
    assert.equal(r.status, 403);
  });

  it("→ 404 when the customer id does not exist", async () => {
    nextResolver = () => []; // customer lookup returns []
    const { base } = await spin("company_admin", 10);
    const r = await fetch(`${base}${PATH}`);
    assert.equal(r.status, 404);
  });

  it("→ 403 when caller's company doesn't own the customer", async () => {
    // First select (customer row) returns a row from company 99, but
    // the caller is in company 10.
    let callCount = 0;
    nextResolver = () => {
      callCount += 1;
      if (callCount === 1) {
        return [
          {
            id: 42,
            companyId: 99,
            name: "Other tenant",
            hiddenFromBilling: false,
            monthlyBudgetCap: null,
            annualBudgetCap: null,
            budgetSoftThresholdPercent: 75,
            budgetHardThresholdPercent: 100,
          },
        ];
      }
      return [];
    };
    const { base } = await spin("company_admin", 10);
    const r = await fetch(`${base}${PATH}`);
    assert.equal(r.status, 403);
  });

  it("→ 200 with the documented shape for billing_manager", async () => {
    // Sequence of selects executed by the handler:
    //   1) customer row
    //   2) invoices for customer
    //   3) work orders for customer
    //   4) billing sheets for customer
    let callCount = 0;
    nextResolver = () => {
      callCount += 1;
      switch (callCount) {
        case 1:
          return [
            {
              id: 42,
              companyId: 10,
              name: "Acme Co",
              hiddenFromBilling: false,
              monthlyBudgetCap: "1000.00",
              annualBudgetCap: "12000.00",
              budgetSoftThresholdPercent: 75,
              budgetHardThresholdPercent: 100,
            },
          ];
        case 2:
          return []; // no invoices
        case 3:
          return []; // no work orders
        case 4:
          return []; // no billing sheets
        default:
          return [];
      }
    };
    const { base } = await spin("billing_manager", 10);
    const r = await fetch(`${base}${PATH}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      customerId: number;
      name: string;
      billedMtd: number;
      billedYtd: number;
      outstandingAr: number;
      unbilledExposure: number;
      lastInvoiceAt: string | null;
      monthly: { cap: number | null; spend: number; status: string };
      annual: { cap: number | null; spend: number; status: string };
    };
    assert.equal(body.customerId, 42);
    assert.equal(body.name, "Acme Co");
    assert.equal(body.billedMtd, 0);
    assert.equal(body.billedYtd, 0);
    assert.equal(body.outstandingAr, 0);
    assert.equal(body.unbilledExposure, 0);
    assert.equal(body.lastInvoiceAt, null);
    // monthly bucket — cap is set, spend 0, status healthy
    assert.equal(body.monthly.cap, 1000);
    assert.equal(body.monthly.spend, 0);
    assert.equal(body.monthly.status, "healthy");
    assert.equal(body.annual.cap, 12000);
    assert.equal(body.annual.spend, 0);
    assert.equal(body.annual.status, "healthy");
  });

  it("→ 400 on a non-numeric id", async () => {
    nextResolver = () => [];
    const { base } = await spin("company_admin", 10);
    const r = await fetch(`${base}/api/financial-pulse/customer/abc/summary`);
    assert.equal(r.status, 400);
  });
});
