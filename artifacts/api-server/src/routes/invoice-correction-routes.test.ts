// Task #1710 / #1739 — Integration tests for invoice correction routes.
//
// All tests mount the REAL `registerInvoiceCorrectionRoutes` function on a
// lightweight Express app and drive it via HTTP. DB and storage are supplied
// as injected test doubles through the `_db` / `_storageApi` dep fields so
// no live database is required and every behavioral assertion is against the
// actual route code, not a hand-written re-implementation.
//
// Coverage:
//   1. deriveRevisionNumber — pure-function unit tests (incl. multi-revision chain)
//      (deprecated; retained for back-compat)
//   2. cancel — 404 for unknown correction; 400 for already-reissued; 200 for draft;
//      verify update called with status:'canceled', no ticket mutations
//   3. qb-sync — 400 for non-reissued; 501 when dep absent; 200 when dep present
//      with syncInvoiceToQb called using the reissuedInvoiceId (not correction id)
//   4. reissue — new invoice keeps same invoiceNumber, bumps revision to 2;
//      paid-invoice gate returns 400 PAID_INVOICE_USE_CREDIT_NOTE;
//      original marked 'superseded'; supersededByInvoiceId FK stamped;
//      correction.status updated to 'reissued';
//      audit entries include reasonCategory / requestedBy / evidenceUrl
//   5. Company guard — correction lookup returns 404 when companyId filter excludes the row
//
// Mock-db contract:
//   createMockDb(tableData, opts) builds an object implementing the Drizzle
//   fluent builder interface (select/update/insert/delete/transaction) backed
//   by a Map<tableObject, rows[]>.  The REAL Drizzle table objects from
//   @workspace/db/schema are used as map keys so the route can pass them
//   directly to select().from(table) and the mock routes to the right rows.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { registerInvoiceCorrectionRoutes, deriveRevisionNumber } from "./invoice-correction-routes";
import { hasCapability, CAN_EDIT_INVOICES } from "@workspace/shared";
import {
  invoiceCorrections,
  invoiceCorrectionLines,
  invoices as invoicesTable,
  invoiceItems,
  billingSheets,
  workOrders,
  wetCheckBillings,
} from "@workspace/db/schema";

// ── deriveRevisionNumber unit tests ─────────────────────────────────────────

describe("deriveRevisionNumber", () => {
  it("appends -R1 to a plain invoice number", () => {
    assert.equal(deriveRevisionNumber("04723"), "04723-R1");
  });

  it("increments -R1 to -R2", () => {
    assert.equal(deriveRevisionNumber("04723-R1"), "04723-R2");
  });

  it("increments -R9 to -R10 (double-digit revision)", () => {
    assert.equal(deriveRevisionNumber("INV-99-R9"), "INV-99-R10");
  });

  it("handles numbers with internal dashes", () => {
    assert.equal(deriveRevisionNumber("2024-04723"), "2024-04723-R1");
  });

  it("R2 → R3 (multi-revision chain)", () => {
    assert.equal(deriveRevisionNumber("INV-001-R2"), "INV-001-R3");
  });

  it("R10 → R11", () => {
    assert.equal(deriveRevisionNumber("INV-001-R10"), "INV-001-R11");
  });
});

// ── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock Drizzle-compatible db backed by Map<tableObject → rows[]>.
 * The REAL Drizzle table objects are used as keys so routes that do
 * `db.select().from(billingSheets).where(...)` receive the right rows.
 *
 * select()  — returns the rows stored for that table (or []).
 * update()  — records the { table, set } call; returns [] by default, or the
 *             first entry from opts.updateReturns.get(table) when returning() is called.
 * insert()  — records the { table, values } call; returns { id:888, ...values } by default,
 *             or opts.insertReturns.get(table)[0].
 * delete()  — no-op (records the call for assertions if needed).
 * transaction() — calls fn(this) so mutations go through the same mock.
 */
function createMockDb(
  tableData: Map<any, any>,
  opts: {
    updateReturns?: Map<any, any>;
    insertReturns?: Map<any, any>;
  } = {},
) {
  const updateCalls: Array<{ table: any; set: any }> = [];
  const insertCalls: Array<{ table: any; values: any }> = [];
  const deleteCalls: Array<{ table: any }> = [];

  // select().from(table).where(cond)          — returns rows (thenable)
  // select().from(table).where(cond).limit(n) — returns rows.slice(0,n)
  function makeWhereResult(rows: any[]) {
    return Object.assign(Promise.resolve(rows), {
      limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    });
  }

  const mockDb: any = {
    // expose calls for assertions in tests
    updateCalls,
    insertCalls,
    deleteCalls,

    select(_cols?: any) {
      return {
        from: (table: any) => ({
          where: (_c: any) => makeWhereResult(tableData.get(table) ?? []),
        }),
      };
    },

    update(table: any) {
      return {
        set(values: any) {
          updateCalls.push({ table, set: values });
          const returns = opts.updateReturns?.get(table) ?? [];
          const returnVal = (returns as any[]).shift() ?? [];
          return {
            where(_c: any) {
              return Object.assign(Promise.resolve([]), {
                returning: () => Promise.resolve(Array.isArray(returnVal) ? returnVal : [returnVal]),
              });
            },
          };
        },
      };
    },

    insert(table: any) {
      return {
        values(vals: any) {
          const row = Array.isArray(vals) ? vals[0] : vals;
          const def = { id: 888, ...row };
          const result = opts.insertReturns?.get(table) ?? def;
          const resultArr = Array.isArray(result) ? result : [result];
          insertCalls.push({ table, values: resultArr[0] ?? def });
          return Object.assign(Promise.resolve(resultArr), {
            returning: () => Promise.resolve(resultArr),
          });
        },
      };
    },

    delete(table: any) {
      deleteCalls.push({ table });
      return {
        where: (_c: any) => Promise.resolve([]),
      };
    },

    async transaction(fn: (tx: any) => Promise<any>) {
      return fn(mockDb);
    },
  };

  return mockDb;
}

/** Minimal mock storage — supply overrides as needed per test. */
function createMockStorage(overrides: Partial<{
  getInvoiceById: (id: number, companyId: number | null) => Promise<any>;
  getOpenCorrectionForInvoice: (invoiceId: number, companyId: number | null) => Promise<any>;
  getBillingSheetById: (id: number, companyId: number | null) => Promise<any>;
  getWorkOrder: (id: number, companyId: number | null) => Promise<any>;
  getWetCheckBillingById: (id: number, companyId: number | null) => Promise<any>;
}> = {}) {
  return {
    getInvoiceById: overrides.getInvoiceById ?? (async () => null),
    getOpenCorrectionForInvoice: overrides.getOpenCorrectionForInvoice ?? (async () => null),
    getBillingSheetById: overrides.getBillingSheetById ?? (async () => null),
    getWorkOrder: overrides.getWorkOrder ?? (async () => null),
    getWetCheckBillingById: overrides.getWetCheckBillingById ?? (async () => null),
  };
}

// ── HTTP test harness ────────────────────────────────────────────────────────

function buildApp(
  db: ReturnType<typeof createMockDb>,
  storage: ReturnType<typeof createMockStorage>,
  syncInvoiceToQb?: (id: number, opts: { callerCompanyId: number | null }) => Promise<{ quickbooksId?: string }>,
) {
  const app = express();
  app.use(express.json());
  // Minimal auth middleware — sets expected req properties from test headers.
  app.use((req: any, _res, next) => {
    req.authenticatedUserRole = req.headers["x-test-role"] ?? "billing_manager";
    req.authenticatedUserCompanyId = Number(req.headers["x-test-company"] ?? "1");
    req.authenticatedUserId = 42;
    next();
  });
  registerInvoiceCorrectionRoutes(app, {
    requireAuthentication: (_req, _res, next) => next(),
    // Task #1886 — backed by the real CAN_EDIT_INVOICES set.
    requireInvoiceWrite: (req: any, res: any, next: any) => {
      if (!hasCapability(req.authenticatedUserRole, CAN_EDIT_INVOICES)) {
        res.status(403).json({ message: "Forbidden" });
        return;
      }
      next();
    },
    syncInvoiceToQb,
    _db: db,
    _storageApi: storage,
  });
  return app;
}

async function withServer(
  app: ReturnType<typeof express>,
  fn: (port: number) => Promise<void>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const draftCorrection = {
  id: 1,
  companyId: 1,
  customerId: 10,
  originalInvoiceId: 5,
  status: "draft",
  reasonCategory: "pricing_error",
  requestedBy: "Jane Doe",
  evidenceUrl: "https://example.com/evidence.pdf",
  reissuedInvoiceId: null,
  qbSyncStatus: "pending",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const reissuedCorrection = {
  ...draftCorrection,
  id: 2,
  status: "reissued",
  reissuedInvoiceId: 77,
};

const originalInvoice = {
  id: 5,
  companyId: 1,
  customerId: 10,
  invoiceNumber: "INV-001",
  revision: 1,
  customerName: "Acme Corp",
  customerEmail: "acme@example.com",
  customerPhone: null,
  invoiceMonth: 6,
  invoiceYear: 2026,
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  status: "generated",
  partsSubtotal: "100.00",
  laborSubtotal: "50.00",
  totalAmount: "150.00",
  dueDate: null,
  quickbooksInvoiceId: null,
  quickbooksSyncToken: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── POST /api/invoice-corrections/:id/cancel ────────────────────────────────

describe("POST /api/invoice-corrections/:id/cancel — real routes", () => {

  it("returns 404 when correction is not found (company filter excludes it)", async () => {
    // Mock returns empty rows — simulates company-ID filter eliminating the row.
    const db = createMockDb(new Map([
      [invoiceCorrections, []],
    ]));
    const app = buildApp(db, createMockStorage());

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/99/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 404, "unknown correction must return 404");
    });
  });

  it("returns 400 when correction is already reissued", async () => {
    const db = createMockDb(new Map([
      [invoiceCorrections, [{ ...draftCorrection, status: "reissued" }]],
    ]));
    const app = buildApp(db, createMockStorage());

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { message: string };
      assert.match(body.message, /reissued/i);
    });
  });

  it("returns 200 for a draft correction and calls update with status:'canceled'", async () => {
    const canceledRow = { ...draftCorrection, status: "canceled" };
    const db = createMockDb(
      new Map([[invoiceCorrections, [draftCorrection]]]),
      { updateReturns: new Map([[invoiceCorrections, [canceledRow]]]) },
    );
    const app = buildApp(db, createMockStorage());

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { correction: { status: string }; message: string };
      assert.equal(body.correction.status, "canceled");
    });

    // The db received exactly one update call, setting status:'canceled'
    assert.equal(db.updateCalls.length, 1, "cancel must issue exactly one UPDATE");
    assert.equal(db.updateCalls[0].set.status, "canceled");

    // Cancel must NOT touch any ticket tables
    const ticketTables = [billingSheets, workOrders, wetCheckBillings];
    for (const call of db.updateCalls) {
      assert.ok(!ticketTables.includes(call.table), "cancel must not mutate ticket tables");
    }
    assert.equal(db.insertCalls.length, 0, "cancel must not insert any rows");
  });

  it("returns 400 when correction is already canceled", async () => {
    const db = createMockDb(new Map([
      [invoiceCorrections, [{ ...draftCorrection, status: "canceled" }]],
    ]));
    const app = buildApp(db, createMockStorage());

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 400);
    });
  });

});

// ── POST /api/invoice-corrections/:id/qb-sync ────────────────────────────────

describe("POST /api/invoice-corrections/:id/qb-sync — real routes", () => {

  it("returns 400 when correction is not in reissued status", async () => {
    const db = createMockDb(new Map([
      [invoiceCorrections, [draftCorrection]],
    ]));
    const app = buildApp(db, createMockStorage());

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/qb-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { message: string };
      assert.match(body.message, /reissued/i);
    });
  });

  it("returns 501 when syncInvoiceToQb dep is absent", async () => {
    const db = createMockDb(new Map([
      [invoiceCorrections, [reissuedCorrection]],
    ]));
    // No syncInvoiceToQb injected
    const app = buildApp(db, createMockStorage(), undefined);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/2/qb-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 501);
      const body = await res.json() as { qbSyncStatus: string };
      assert.equal(body.qbSyncStatus, "skipped");
    });
  });

  it("calls syncInvoiceToQb with reissuedInvoiceId (not the correction id) and returns 200", async () => {
    let syncCalledWith: number | null = null;

    const db = createMockDb(new Map([
      [invoiceCorrections, [reissuedCorrection]],
    ]));
    const syncInvoiceToQb = async (invoiceId: number) => {
      syncCalledWith = invoiceId;
      return { quickbooksId: "QB-SYNCED" };
    };
    const app = buildApp(db, createMockStorage(), syncInvoiceToQb);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/2/qb-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { qbSyncStatus: string; quickbooksId: string };
      assert.equal(body.qbSyncStatus, "synced");
      assert.equal(body.quickbooksId, "QB-SYNCED");
    });

    // syncInvoiceToQb must be called with the REISSUED invoice id (77), not
    // the correction id (2) — this ensures in-place QB update, not a duplicate.
    assert.equal(syncCalledWith, 77, "syncInvoiceToQb must be called with reissuedCorrection.reissuedInvoiceId");
  });

});

// ── POST /api/invoice-corrections/:id/reissue ────────────────────────────────

describe("POST /api/invoice-corrections/:id/reissue — real routes", () => {

  it("returns 404 when correction not found", async () => {
    const db = createMockDb(new Map([
      [invoiceCorrections, []],
    ]));
    const storage = createMockStorage();
    const app = buildApp(db, storage);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/reissue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 404);
    });
  });

  it("returns 400 when correction is already reissued", async () => {
    const db = createMockDb(new Map([
      [invoiceCorrections, [reissuedCorrection]],
    ]));
    const storage = createMockStorage();
    const app = buildApp(db, storage);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/2/reissue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 400);
    });
  });

  it("returns 400 when a correction line references a ticket NOT on the original invoice (forged ID)", async () => {
    // Forged line: ticketId 999 is NOT in invoiceItems for invoice 5
    const forgedLine = {
      id: 20,
      correctionId: 1,
      companyId: 1,
      ticketType: "billing_sheet",
      ticketId: 999,           // NOT in invoiceItems below
      action: "zero_line",
      lineNote: "Forged",
      afterParts: null, afterLabor: null, afterTotal: null,
      beforeParts: null, beforeLabor: null, beforeTotal: null,
    };
    const db = createMockDb(
      new Map<object, any[]>([
        [invoiceCorrections, [draftCorrection]],
        [invoiceCorrectionLines, [forgedLine]],
        [invoiceItems, [
          // Only billing_sheet 55 is on invoice 5 — not 999
          { id: 100, invoiceId: 5, billingSheetId: 55, workOrderId: null, wetCheckBillingId: null },
        ]],
        [invoicesTable, []],
        [billingSheets, []],
        [workOrders, []],
        [wetCheckBillings, []],
      ]),
    );
    const storage = createMockStorage({
      getInvoiceById: async () => originalInvoice,
    });
    const app = buildApp(db, storage);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/reissue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 400, "forged line must be rejected with 400");
      const body = await res.json() as { message: string; invalidLines: any[] };
      assert.match(body.message, /not belonging to the original invoice/i);
      assert.equal(body.invalidLines.length, 1);
      assert.equal(body.invalidLines[0].ticketId, 999);
    });

    // No ticket mutations and no new invoice must have been inserted
    assert.equal(db.insertCalls.length, 0, "forged line must not trigger any INSERT");
    const ticketUpdates = db.updateCalls.filter(
      (c: any) => c.table === billingSheets || c.table === workOrders || c.table === wetCheckBillings,
    );
    assert.equal(ticketUpdates.length, 0, "forged line must not mutate any ticket tables");
  });

  it("membership check passes and reissue proceeds when all lines reference valid invoice tickets", async () => {
    // Line points to billing_sheet 55 which IS on invoice 5 → should pass guard
    const validLine = {
      id: 21,
      correctionId: 1,
      companyId: 1,
      ticketType: "billing_sheet",
      ticketId: 55,
      action: "zero_line",
      lineNote: "Zero valid sheet",
      afterParts: null, afterLabor: null, afterTotal: null,
      beforeParts: null, beforeLabor: null, beforeTotal: null,
    };
    const bsRow = { id: 55, companyId: 1, laborSubtotal: "50.00", partsSubtotal: "100.00", totalAmount: "150.00" };
    const newInvoiceRow = { id: 890, invoiceNumber: "INV-001", revision: 2, status: "generated", companyId: 1, customerId: 10, totalAmount: "100.00", partsSubtotal: "100.00", laborSubtotal: "0.00" };
    const updatedCorrectionRow = { ...draftCorrection, status: "reissued", reissuedInvoiceId: 890 };

    const db = createMockDb(
      new Map<object, any[]>([
        [invoiceCorrections, [draftCorrection]],
        [invoiceCorrectionLines, [validLine]],
        [invoiceItems, [
          // billing_sheet 55 IS on invoice 5 → line is valid
          { id: 100, invoiceId: 5, billingSheetId: 55, workOrderId: null, wetCheckBillingId: null, sourceType: "billing_sheet", sourceId: 55, workDate: new Date(), description: "svc", totalPrice: "150.00" },
        ]],
        [invoicesTable, []],
        [billingSheets, [bsRow]],
        [workOrders, []],
        [wetCheckBillings, []],
      ]),
      {
        insertReturns: new Map([[invoicesTable, newInvoiceRow]]),
        updateReturns: new Map([[invoiceCorrections, [updatedCorrectionRow]]]),
      },
    );
    const storage = createMockStorage({ getInvoiceById: async () => originalInvoice });
    const app = buildApp(db, storage);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/reissue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 200, `valid line should pass guard; got ${res.status}`);
    });
  });

  it("creates new invoice with status:generated and marks original superseded", async () => {
    const newInvoiceRow = {
      id: 888,
      invoiceNumber: "INV-001",
      revision: 2,
      status: "generated",
      companyId: 1,
      customerId: 10,
      totalAmount: "0.00",
      partsSubtotal: "0.00",
      laborSubtotal: "0.00",
    };
    const updatedCorrectionRow = {
      ...draftCorrection,
      status: "reissued",
      reissuedInvoiceId: 888,
    };

    const db = createMockDb(
      new Map<object, any[]>([
        [invoiceCorrections, [draftCorrection]],
        [invoiceCorrectionLines, []],
        [invoiceItems, []],
        [invoicesTable, []],
        [billingSheets, []],
        [workOrders, []],
        [wetCheckBillings, []],
      ]),
      {
        insertReturns: new Map([
          [invoicesTable, newInvoiceRow],
        ]),
        updateReturns: new Map([
          [invoiceCorrections, [updatedCorrectionRow]],
        ]),
      },
    );

    const storage = createMockStorage({
      getInvoiceById: async (_id, _companyId) => originalInvoice,
    });

    const app = buildApp(db, storage);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/reissue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      const body = await res.json() as {
        reissuedInvoice: { status: string; invoiceNumber: string; revision: number };
        correction: { status: string; reissuedInvoiceId: number };
      };
      assert.equal(body.reissuedInvoice.status, "generated", "new invoice must have status:generated");
      // Stable number protocol: same base number, revision bumped to 2.
      assert.equal(body.reissuedInvoice.invoiceNumber, "INV-001", "base invoice number must not change");
      assert.equal(body.reissuedInvoice.revision, 2, "revision must be bumped from 1 to 2");
      assert.equal(body.correction.status, "reissued");
      assert.equal(body.correction.reissuedInvoiceId, 888);
    });

    // The invoice INSERT must have been called with status:'generated' and
    // the stable-number protocol: same invoiceNumber, revision bumped.
    const invoiceInsert = db.insertCalls.find((c: any) => c.table === invoicesTable);
    assert.ok(invoiceInsert, "must insert a new invoice row");
    assert.equal(invoiceInsert!.values.status, "generated");
    assert.equal(invoiceInsert!.values.invoiceNumber, "INV-001", "INSERT must keep same base invoiceNumber");
    assert.equal(invoiceInsert!.values.revision, 2, "INSERT must set revision = 2");

    // The original invoice must be marked 'superseded'
    const supersededUpdate = db.updateCalls.find(
      (c: any) => c.table === invoicesTable && c.set.status === "superseded",
    );
    assert.ok(supersededUpdate, "original invoice must be updated to status:superseded");

    // The original invoice must have supersededByInvoiceId stamped
    const linkUpdate = db.updateCalls.find(
      (c: any) => c.table === invoicesTable && c.set.supersededByInvoiceId != null,
    );
    assert.ok(linkUpdate, "supersededByInvoiceId must be stamped on the original invoice");
    assert.equal(linkUpdate!.values?.supersededByInvoiceId ?? linkUpdate!.set.supersededByInvoiceId, 888);

    // The correction must be updated to reissued status
    const correctionUpdate = db.updateCalls.find(
      (c: any) => c.table === invoiceCorrections && c.set.status === "reissued",
    );
    assert.ok(correctionUpdate, "correction must be updated to status:reissued");
  });

  it("returns 400 PAID_INVOICE_USE_CREDIT_NOTE when original invoice is paid", async () => {
    const paidInvoice = { ...originalInvoice, status: "paid" };
    const db = createMockDb(new Map<object, any[]>([
      [invoiceCorrections, [draftCorrection]],
      [invoiceCorrectionLines, []],
      [invoiceItems, []],
      [invoicesTable, []],
      [billingSheets, []],
      [workOrders, []],
      [wetCheckBillings, []],
    ]));
    const storage = createMockStorage({ getInvoiceById: async () => paidInvoice });
    const app = buildApp(db, storage);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/reissue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 400, "paid invoice must block reissue");
      const body = await res.json() as { code: string; message: string };
      assert.equal(body.code, "PAID_INVOICE_USE_CREDIT_NOTE", "must return PAID_INVOICE_USE_CREDIT_NOTE code");
    });
  });

  it("audit entries carry correction metadata (reasonCategory / requestedBy / evidenceUrl)", async () => {
    // Use a zero_line billing_sheet line so an audit event is recorded
    const bsLine = {
      id: 10,
      correctionId: 1,
      companyId: 1,
      ticketType: "billing_sheet",
      ticketId: 55,
      action: "zero_line",
      lineNote: "Zero out labor",
      afterParts: null, afterLabor: null, afterTotal: null,
      beforeParts: null, beforeLabor: null, beforeTotal: null,
    };
    const bsRow = {
      id: 55,
      companyId: 1,
      laborSubtotal: "50.00",
      partsSubtotal: "100.00",
      totalAmount: "150.00",
    };
    const newInvoiceRow = {
      id: 889,
      invoiceNumber: "INV-001",
      revision: 2,
      status: "generated",
      companyId: 1,
      customerId: 10,
      totalAmount: "100.00",
      partsSubtotal: "100.00",
      laborSubtotal: "0.00",
    };
    const updatedCorrectionRow = { ...draftCorrection, status: "reissued", reissuedInvoiceId: 889 };

    // billingSheets returns the BS row for the zero_line select,
    // and also for the computeLiveTotalsFromTickets pass.
    const db = createMockDb(
      new Map<object, any[]>([
        [invoiceCorrections, [draftCorrection]],
        [invoiceCorrectionLines, [bsLine]],
        [invoiceItems, [
          // one item that resolves to this billing sheet
          {
            id: 100,
            invoiceId: 5,
            sourceType: "billing_sheet",
            billingSheetId: 55,
            workOrderId: null,
            wetCheckBillingId: null,
            sourceId: "55",
            workDate: "2026-06-10",
            description: "Service",
            totalPrice: "150.00",
          },
        ]],
        [billingSheets, [bsRow]],
        [invoicesTable, []],
        [workOrders, []],
        [wetCheckBillings, []],
      ]),
      {
        insertReturns: new Map([[invoicesTable, newInvoiceRow]]),
        updateReturns: new Map([[invoiceCorrections, [updatedCorrectionRow]]]),
      },
    );

    // Capture audit events via the real recordAuditEvent call — since it goes
    // through the mock db's insert(), we can inspect insertCalls for the audit_log table.
    // Note: auditLog table is imported in audit-log.ts; it shows up in insertCalls.
    const storage = createMockStorage({
      getInvoiceById: async () => originalInvoice,
    });
    const app = buildApp(db, storage);

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/reissue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      // If the response fails the next assertions will still tell us what happened
      if (res.status !== 200) {
        const body = await res.json().catch(() => ({})) as any;
        assert.fail(`Expected 200 but got ${res.status}: ${JSON.stringify(body)}`);
      }
    });

    // The audit insert should carry the correction's reasonCategory, requestedBy, evidenceUrl
    // Note: The mock db captures all inserts including the auditLog insert.
    const auditInserts = db.insertCalls.filter(
      (c: any) => c.values && c.values.details,
    );
    assert.ok(auditInserts.length > 0, "at least one audit entry must be recorded");
    const auditEntry = auditInserts[0];
    assert.equal(
      auditEntry.values.details.reasonCategory,
      "pricing_error",
      "audit entry must carry correction.reasonCategory",
    );
    assert.equal(
      auditEntry.values.details.requestedBy,
      "Jane Doe",
      "audit entry must carry correction.requestedBy",
    );
    assert.equal(
      auditEntry.values.details.evidenceUrl,
      "https://example.com/evidence.pdf",
      "audit entry must carry correction.evidenceUrl",
    );
  });

});

// ── Company guard — FK-keyed correction lookup ────────────────────────────────

describe("Company guard — correction not visible across tenants", () => {

  it("cancel returns 404 when caller companyId does not match correction companyId", async () => {
    // Caller is company 2 but the mock returns [] (simulating the AND companyId=2 filter
    // finding no rows because the correction belongs to company 1).
    const db = createMockDb(new Map([
      [invoiceCorrections, []],   // empty because company filter excluded the row
    ]));
    const app = buildApp(db, createMockStorage());

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-company": "2",   // caller is company 2
        },
      });
      assert.equal(res.status, 404, "cross-tenant access must return 404 (correction not found)");
    });
  });

  it("reissue returns 404 when correction not found for caller company", async () => {
    const db = createMockDb(new Map<object, any[]>([
      [invoiceCorrections, []],
      [invoiceCorrectionLines, []],
    ]));
    const app = buildApp(db, createMockStorage());

    await withServer(app, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/invoice-corrections/1/reissue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-company": "999" },
      });
      assert.equal(res.status, 404);
    });
  });

});
