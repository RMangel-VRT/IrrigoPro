// Financial Pulse access contract.
//
// This suite intentionally exercises the real route registration and shared
// scope resolver, including the three content-negotiated CSV responses. The
// database is replaced with a chainable empty-result shim so authorization
// behavior is tested without requiring tenant fixtures.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db } from "../db";
import { resolveFinancialPulseScope, registerFinancialPulseRoutes } from "./financial-pulse";

const CUSTOMER_ID = 42;
let customerSummaryRequest = false;
let customerSelectCalls = 0;
let customerCompanyId = 10;

const chain: any = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: any[]) => void) => {
          customerSelectCalls += 1;
          if (customerSummaryRequest && customerSelectCalls === 1) {
            resolve([
              {
                id: CUSTOMER_ID,
                companyId: customerCompanyId,
                name: "Access Test Customer",
                hiddenFromBilling: false,
                monthlyBudgetCap: null,
                annualBudgetCap: null,
                budgetSoftThresholdPercent: 75,
                budgetHardThresholdPercent: 100,
              },
            ]);
          } else {
            resolve([]);
          }
        };
      }
      return () => chain;
    },
  },
);
(db as any).select = () => chain;

function makeApp(role: string | undefined, companyId: number | null): Express {
  const app = express();
  const requireAuthentication: express.RequestHandler = (req: any, _res, next) => {
    if (role !== undefined) req.authenticatedUserRole = role;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
  registerFinancialPulseRoutes(app, { requireAuthentication });
  return app;
}

async function start(app: Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const servers: Server[] = [];

async function request(
  role: string | undefined,
  path: string,
  companyId = 10,
  init?: RequestInit,
): Promise<Response> {
  customerSummaryRequest = path.includes("/customer/");
  customerSelectCalls = 0;
  const { server, base } = await start(makeApp(role, companyId));
  servers.push(server);
  return fetch(`${base}${path}`, init);
}

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const ENDPOINTS = [
  "/api/financial-pulse/kpis",
  "/api/financial-pulse/revenue-trend",
  "/api/financial-pulse/revenue-mix",
  "/api/financial-pulse/top-customers",
  "/api/financial-pulse/by-technician",
  "/api/financial-pulse/by-service-type",
  "/api/financial-pulse/ar-aging",
  "/api/financial-pulse/projections",
  `/api/financial-pulse/customer/${CUSTOMER_ID}/summary`,
  "/api/financial-pulse/pulse-summary",
] as const;

const CSV_REQUESTS = [
  {
    path: "/api/financial-pulse/top-customers",
    init: { headers: { Accept: "text/csv" } },
    header: "Customer ID,",
  },
  {
    path: "/api/financial-pulse/by-technician?format=csv",
    init: undefined,
    header: "Technician ID,",
  },
  {
    path: "/api/financial-pulse/by-service-type",
    init: { headers: { Accept: "text/csv" } },
    header: "Key,Label,",
  },
] as const;

describe("Financial Pulse access — irrigation managers", () => {
  for (const path of ENDPOINTS) {
    it(`${path} returns 200 for irrigation_manager`, async () => {
      const response = await request("irrigation_manager", path);
      assert.equal(response.status, 200);
    });
  }

  for (const csv of CSV_REQUESTS) {
    it(`${csv.path} CSV export returns 200 for irrigation_manager`, async () => {
      const response = await request("irrigation_manager", csv.path, 10, csv.init);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
      assert.match(await response.text(), new RegExp(`^${csv.header}`));
    });
  }
});

describe("Financial Pulse access — field technicians", () => {
  for (const path of ENDPOINTS) {
    it(`${path} returns a hard 403 for field_tech`, async () => {
      const response = await request("field_tech", path);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { message: "Forbidden" });
    });
  }

  for (const csv of CSV_REQUESTS) {
    it(`${csv.path} CSV export returns a hard 403 for field_tech`, async () => {
      const response = await request("field_tech", csv.path, 10, csv.init);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { message: "Forbidden" });
    });
  }
});

describe("Financial Pulse access — scope and ownership", () => {
  it("refuses a role outside the allowlist", async () => {
    const response = await request("bookkeeper", "/api/financial-pulse/kpis");
    assert.equal(response.status, 403);
  });

  it("keeps an irrigation manager in company A on company A when company B is requested", () => {
    const scope = resolveFinancialPulseScope("irrigation_manager", 10, "99");
    assert.equal(scope.status, 200);
    assert.equal(scope.companyId, 10);
  });

  it("preserves the customer-summary tenant ownership check", async () => {
    customerCompanyId = 99;
    const response = await request(
      "irrigation_manager",
      `/api/financial-pulse/customer/${CUSTOMER_ID}/summary`,
      10,
    );
    assert.equal(response.status, 403);
    customerCompanyId = 10;
  });

  it("allows super_admin to pass an explicit company scope", async () => {
    const response = await request(
      "super_admin",
      "/api/financial-pulse/kpis?companyId=42",
      10,
    );
    assert.equal(response.status, 200);
  });
});

describe("Financial Pulse access — client/server allowlist parity", () => {
  function extractAllowedRoles(source: string): string[] {
    const match = source.match(
      /const ALLOWED_ROLES\s*=\s*new Set\(\[\s*([\s\S]*?)\s*\]\);/,
    );
    assert.ok(match, "ALLOWED_ROLES declaration is missing");
    return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)]
      .map((role) => role[1])
      .sort();
  }

  it("keeps the page and API allowlists identical", () => {
    const serverSource = readFileSync(
      join(import.meta.dirname, "financial-pulse.ts"),
      "utf8",
    );
    const clientSource = readFileSync(
      join(import.meta.dirname, "../../../irrigopro/src/pages/financial-pulse.tsx"),
      "utf8",
    );
    const expected = [
      "billing_manager",
      "company_admin",
      "irrigation_manager",
      "super_admin",
    ];
    assert.deepEqual(extractAllowedRoles(serverSource), expected);
    assert.deepEqual(extractAllowedRoles(clientSource), expected);
  });

  it("routes every Financial Pulse endpoint through the shared scope resolver", () => {
    const source = readFileSync(
      join(import.meta.dirname, "financial-pulse.ts"),
      "utf8",
    );
    for (const path of ENDPOINTS) {
      const sourcePath =
        path === `/api/financial-pulse/customer/${CUSTOMER_ID}/summary`
          ? "/api/financial-pulse/customer/:id/summary"
          : path;
      const routeStart = source.indexOf(`"${sourcePath}"`);
      assert.notEqual(routeStart, -1, `route not found: ${path}`);
      const routeBody = source.slice(routeStart, routeStart + 1_800);
      assert.match(
        routeBody,
        /resolveFinancialPulseScope/,
        `${path} is missing the shared scope resolver`,
      );
    }
  });
});