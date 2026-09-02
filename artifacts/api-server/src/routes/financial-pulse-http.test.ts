// Task #688 — HTTP-level role guard tests for /api/financial-pulse/*.
//
// Mounts the real registerFinancialPulseRoutes() against a stubbed
// `db` proxy so the route guard, query parsing, and response shape
// all run end-to-end without Postgres.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { db } from "../db";

// Swap `db.select` for a chainable shim that always resolves to an
// empty array. The route handlers call patterns like:
//   db.select().from(tbl).where(cond)
// so we return an object whose methods all return itself, with the
// final `.where(...)` resolving as a thenable.
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

// Import AFTER patching so the route module sees the patched db.
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
    SERVERS.map(
      (s) => new Promise<void>((r) => s.server.close(() => r())),
    ),
  );
});

const ENDPOINTS = [
  "/api/financial-pulse/kpis",
  "/api/financial-pulse/revenue-trend",
  "/api/financial-pulse/revenue-mix",
];

describe("Task #688 — /api/financial-pulse/* role matrix", () => {
  for (const path of ENDPOINTS) {
    it(`${path} → 403 for field_tech`, async () => {
      const { base } = await spin("field_tech", 10);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 403);
    });

    it(`${path} → 200 for irrigation_manager`, async () => {
      const { base } = await spin("irrigation_manager", 10);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
    });

    it(`${path} → 200 for company_admin`, async () => {
      const { base } = await spin("company_admin", 10);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok(body && typeof body === "object");
    });

    it(`${path} → 200 for billing_manager`, async () => {
      const { base } = await spin("billing_manager", 10);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
    });

    it(`${path} → 200 for super_admin (global)`, async () => {
      const { base } = await spin("super_admin", null);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
    });

    it(`${path} → 403 for company_admin without a company`, async () => {
      const { base } = await spin("company_admin", null);
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 403);
    });

    it(`${path} → 400 for super_admin with malformed companyId`, async () => {
      const { base } = await spin("super_admin", null);
      const r = await fetch(`${base}${path}?companyId=abc`);
      assert.equal(r.status, 400);
    });

    it(`${path} → 200 when ?asOf=YYYY-MM-DD is well-formed (value ignored in v1)`, async () => {
      const { base } = await spin("super_admin", null);
      const r = await fetch(`${base}${path}?asOf=2026-05-19`);
      assert.equal(r.status, 200);
    });

    it(`${path} → 400 when ?asOf is malformed`, async () => {
      const { base } = await spin("super_admin", null);
      const r = await fetch(`${base}${path}?asOf=not-a-date`);
      assert.equal(r.status, 400);
    });
  }
});

describe("Task #688 — /api/financial-pulse/kpis response shape", () => {
  it("returns all 8 KPI tiles with the documented contract", async () => {
    const { base } = await spin("super_admin", null);
    const r = await fetch(`${base}/api/financial-pulse/kpis`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    for (const k of [
      "billedMtd",
      "billedLastCycle",
      "billedYtd",
      "collectedMtd",
      "outstandingAr",
      "unbilledExposure",
      "projectedMonthEnd",
      "avgDaysToPay",
      "grossMarginPct",
    ]) {
      assert.ok(k in body, `missing tile ${k}`);
    }
    assert.ok("missingWageTechCount" in body.grossMarginPct);
    assert.equal(body.grossMarginPct.missingWageTechCount, 0);
    // Task #723 — billedLastCycle carries value + monthLabel + monthIso.
    assert.ok("value" in body.billedLastCycle);
    assert.ok(
      typeof body.billedLastCycle.monthLabel === "string" &&
        body.billedLastCycle.monthLabel.length > 0,
      "billedLastCycle.monthLabel should be a non-empty string",
    );
    assert.ok(
      typeof body.billedLastCycle.monthIso === "string" &&
        /^\d{4}-\d{2}$/.test(body.billedLastCycle.monthIso),
      "billedLastCycle.monthIso should be YYYY-MM",
    );
  });

  it("MTD vs YTD period selector is reflected in the response", async () => {
    const { base } = await spin("super_admin", null);
    const r = await fetch(`${base}/api/financial-pulse/kpis?period=ytd`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.period, "ytd");
  });
});
