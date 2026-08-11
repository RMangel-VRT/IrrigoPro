// Task #1911 — five storage readers used to catch a database error, log to
// console, and return `[]` or `null`. To every caller that is indistinguishable
// from a successful query that found nothing: no QuickBooks integration, no
// active integrations, no invoices for this customer.
//
// These tests pin BOTH halves of the fix, because only pinning one is how the
// bug comes back:
//
//   1. a failing query throws — the caller gets a visible failure, not a fact;
//   2. a genuinely empty result still returns `[]` / `null` without error.
//
// Seam: the storage methods call `db.select()` at call time, so swapping that
// one property gives a database client that either resolves rows or rejects,
// with no Postgres involved.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "./db";
import { storage } from "./storage";

const realSelect = (db as any).select.bind(db);

/** A drizzle-shaped chain whose await resolves to `rows`. */
function resolvingChain(rows: unknown[]): any {
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown[]) => void) => resolve(rows);
        }
        return () => chain;
      },
    },
  );
  return chain;
}

/** A drizzle-shaped chain whose await rejects with `err`. */
function rejectingChain(err: Error): any {
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (_resolve: unknown, reject: (e: Error) => void) => reject(err);
        }
        return () => chain;
      },
    },
  );
  return chain;
}

function installFailingDb(): Error {
  const err = new Error("Failed query: timeout exceeded when trying to connect");
  (db as any).select = () => rejectingChain(err);
  return err;
}

function installEmptyDb(): void {
  (db as any).select = () => resolvingChain([]);
}

function installRowsDb(rows: unknown[]): void {
  (db as any).select = () => resolvingChain(rows);
}

// Each reader, described by how it is called and what a genuinely empty
// result must still produce.
const READERS: Array<{
  name: string;
  call: () => Promise<unknown>;
  emptyValue: "null" | "[]";
}> = [
  {
    name: "getQuickBooksIntegration",
    call: () => storage.getQuickBooksIntegration("realm-1"),
    emptyValue: "null",
  },
  {
    name: "getQuickBooksIntegrationByCompanyId",
    call: () => storage.getQuickBooksIntegrationByCompanyId("7"),
    emptyValue: "null",
  },
  {
    name: "getQuickBooksAllIntegrations",
    call: () => storage.getQuickBooksAllIntegrations(),
    emptyValue: "[]",
  },
  {
    name: "getAllActiveQuickBooksIntegrations",
    call: () => storage.getAllActiveQuickBooksIntegrations(),
    emptyValue: "[]",
  },
  {
    name: "getInvoicesByCustomer",
    call: () => storage.getInvoicesByCustomer(42, 10),
    emptyValue: "[]",
  },
];

describe("storage readers separate 'nothing found' from 'lookup failed' (Task #1911)", () => {
  before(() => {
    installEmptyDb();
  });

  after(() => {
    (db as any).select = realSelect;
  });

  beforeEach(() => {
    installEmptyDb();
  });

  describe("a failing database query throws instead of being reported as nothing", () => {
    for (const reader of READERS) {
      it(`${reader.name} propagates the database error`, async () => {
        const err = installFailingDb();
        await assert.rejects(
          reader.call(),
          (thrown: unknown) => {
            assert.equal(thrown, err, "the original database error must reach the caller");
            return true;
          },
          `${reader.name} must not swallow the error and return ${reader.emptyValue}`,
        );
      });
    }
  });

  describe("a genuinely empty result is still an empty result", () => {
    it("getQuickBooksIntegration returns null when the realm has no integration", async () => {
      installEmptyDb();
      assert.equal(await storage.getQuickBooksIntegration("realm-1"), null);
    });

    it("getQuickBooksIntegrationByCompanyId returns null when the company has no connection", async () => {
      installEmptyDb();
      assert.equal(await storage.getQuickBooksIntegrationByCompanyId("7"), null);
    });

    it("getQuickBooksAllIntegrations returns [] when there are no integrations", async () => {
      installEmptyDb();
      assert.deepEqual(await storage.getQuickBooksAllIntegrations(), []);
    });

    it("getAllActiveQuickBooksIntegrations returns [] when nothing is connected", async () => {
      installEmptyDb();
      assert.deepEqual(await storage.getAllActiveQuickBooksIntegrations(), []);
    });

    it("getInvoicesByCustomer returns [] for a customer with no invoices", async () => {
      installEmptyDb();
      assert.deepEqual(await storage.getInvoicesByCustomer(42, 10), []);
    });
  });

  describe("the success path is unchanged", () => {
    it("getQuickBooksIntegration returns the single matching row", async () => {
      const row = { realmId: "realm-1", companyId: "7", connectionStatus: "connected" };
      installRowsDb([row]);
      assert.deepEqual(await storage.getQuickBooksIntegration("realm-1"), row);
    });

    it("getQuickBooksIntegrationByCompanyId returns the single matching row", async () => {
      const row = { realmId: "realm-1", companyId: "7", connectionStatus: "connected" };
      installRowsDb([row]);
      assert.deepEqual(await storage.getQuickBooksIntegrationByCompanyId("7"), row);
    });

    it("getAllActiveQuickBooksIntegrations returns every connected row", async () => {
      const rows = [
        { realmId: "realm-1", connectionStatus: "connected" },
        { realmId: "realm-2", connectionStatus: "connected" },
      ];
      installRowsDb(rows);
      assert.deepEqual(await storage.getAllActiveQuickBooksIntegrations(), rows);
    });

    it("getInvoicesByCustomer returns the customer's invoices", async () => {
      const rows = [{ id: 1, customerId: 42, totalAmount: "100.00" }];
      installRowsDb(rows);
      assert.deepEqual(await storage.getInvoicesByCustomer(42, 10), rows);
    });
  });
});
