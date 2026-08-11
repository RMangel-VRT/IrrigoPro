/**
 * billing-preview-tenant-scope.test.ts (Task #1898)
 *
 * GET /api/customers/billing-preview scopes its *row* reads
 * (getBillingPreviewSources) to the caller's company, but it also has to scope
 * the customer list itself. An unscoped storage.getCustomers() would still
 * return every tenant's customers; their money would come back zeroed (because
 * the row sources are scoped), but their names, emails and phone numbers would
 * be rendered in the preview — a cross-tenant metadata leak that looks like
 * harmless empty rows.
 *
 * This exercises the real handler via registerBillingPreviewRoute (the same
 * function routes.ts registers), against an in-memory storage stub. No DB.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  registerBillingPreviewRoute,
  type BillingPreviewStorage,
  type BillingPreviewStorageCustomer,
} from "./billing-preview-route";
import type { BillingPreviewSources } from "../billing-preview-sources";

// Mirrors the production header-auth contract used by the sibling
// tenant-isolation tests: sets req.authenticated* from x-user-* headers.
const requireAuthentication: RequestHandler = (req: any, res, next) => {
  const userId = req.headers["x-user-id"];
  const role = req.headers["x-user-role"];
  if (!userId || !role) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }
  req.authenticatedUserId = parseInt(String(userId), 10);
  req.authenticatedUserRole = String(role);
  const cid = req.headers["x-user-company-id"];
  req.authenticatedUserCompanyId = cid ? parseInt(String(cid), 10) : null;
  next();
};

const CUSTOMERS: Record<number, BillingPreviewStorageCustomer[]> = {
  5: [
    { id: 501, name: "Acme Landscaping", email: "a@acme.test", phone: "555-0001" },
    { id: 502, name: "Blue Ridge HOA", email: "b@blue.test", phone: "555-0002" },
  ],
  9: [
    { id: 901, name: "Sunset Estates", email: "s@sunset.test", phone: "555-0003" },
  ],
};

interface Calls {
  getCustomers: (number | undefined)[];
  sources: { customerIds: number[]; companyId: number | null }[];
}

function makeStubStorage(): BillingPreviewStorage & { calls: Calls } {
  const calls: Calls = { getCustomers: [], sources: [] };
  return {
    calls,
    async getCustomers(companyId?: number) {
      calls.getCustomers.push(companyId);
      if (companyId === undefined) return Object.values(CUSTOMERS).flat();
      return CUSTOMERS[companyId] ?? [];
    },
    async getBillingPreviewSources(customerIds: number[], companyId: number | null) {
      calls.sources.push({ customerIds, companyId });
      const empty: BillingPreviewSources = {
        workOrdersByCustomer: new Map(),
        billingSheetsByCustomer: new Map(),
        wetCheckBillingsByCustomer: new Map(),
      };
      return empty;
    },
  };
}

let app: Express;
let server: Server;
let baseUrl: string;
let storage: ReturnType<typeof makeStubStorage>;

beforeEach(async () => {
  storage = makeStubStorage();
  app = express();
  registerBillingPreviewRoute(
    app,
    {
      storage,
      previousCalendarMonth: () => "2026-03",
      resolveAsOfCutoff: (m: string) => (m === "all" ? null : new Date("2026-03-31T23:59:59.999")),
    },
    requireAuthentication,
  );
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function get(headers: Record<string, string>, qs = "") {
  return fetch(`${baseUrl}/api/customers/billing-preview${qs}`, { headers });
}

const companyAdmin5 = { "x-user-id": "1", "x-user-role": "company_admin", "x-user-company-id": "5" };
const companyAdmin9 = { "x-user-id": "2", "x-user-role": "company_admin", "x-user-company-id": "9" };
const superAdmin = { "x-user-id": "3", "x-user-role": "super_admin" };

describe("billing-preview tenant scoping (Task #1898)", () => {
  it("scopes the customer list to the caller's company", async () => {
    const res = await get(companyAdmin5);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { id: number; name: string }[];

    assert.deepEqual(
      rows.map((r) => r.id).sort(),
      [501, 502],
      "company 5 must see only its own customers",
    );
    assert.equal(storage.calls.getCustomers[0], 5, "getCustomers must receive the caller's companyId");
  });

  it("does not leak another tenant's customer names as zero-value rows", async () => {
    const res = await get(companyAdmin9);
    const rows = (await res.json()) as { id: number; name: string }[];

    // The regression this guards: unscoped getCustomers returned every
    // tenant's customers. Their totals were zero (sources are scoped), so the
    // leak looked like harmless empty rows — but the names were real.
    const names = rows.map((r) => r.name);
    assert.deepEqual(names, ["Sunset Estates"]);
    assert.ok(!names.includes("Acme Landscaping"), "company 9 must not see company 5's customers");
    assert.ok(!names.includes("Blue Ridge HOA"), "company 9 must not see company 5's customers");
  });

  it("passes the same company scope to the batched row sources", async () => {
    await get(companyAdmin5);
    assert.equal(storage.calls.sources.length, 1, "row sources must be fetched in one batched call");
    assert.equal(storage.calls.sources[0].companyId, 5);
    assert.deepEqual(storage.calls.sources[0].customerIds.sort(), [501, 502]);
  });

  it("lets super_admin see every company", async () => {
    const res = await get(superAdmin);
    const rows = (await res.json()) as { id: number }[];

    assert.deepEqual(rows.map((r) => r.id).sort(), [501, 502, 901]);
    assert.equal(storage.calls.getCustomers[0], undefined, "super_admin is unscoped");
    assert.equal(storage.calls.sources[0].companyId, null);
  });

  it("rejects a non-super-admin with no company association", async () => {
    const res = await get({ "x-user-id": "4", "x-user-role": "company_admin" });
    assert.equal(res.status, 403);
    assert.equal(storage.calls.getCustomers.length, 0, "storage must not be touched");
  });

  it("requires authentication", async () => {
    const res = await get({});
    assert.equal(res.status, 401);
    assert.equal(storage.calls.getCustomers.length, 0);
  });

  it("issues a constant number of queries regardless of customer count", async () => {
    // Task #1898's core fix: this endpoint used to issue four-plus storage
    // calls *per customer*. Two calls total, for any tenant size.
    await get(companyAdmin5);
    assert.equal(storage.calls.getCustomers.length, 1);
    assert.equal(storage.calls.sources.length, 1);
  });

  it("excludes customers hidden from billing", async () => {
    CUSTOMERS[5].push({ id: 503, name: "Hidden Co", email: null, phone: null, hiddenFromBilling: true });
    try {
      const res = await get(companyAdmin5);
      const rows = (await res.json()) as { id: number }[];
      assert.deepEqual(rows.map((r) => r.id).sort(), [501, 502]);
    } finally {
      CUSTOMERS[5] = CUSTOMERS[5].filter((c) => c.id !== 503);
    }
  });
});
