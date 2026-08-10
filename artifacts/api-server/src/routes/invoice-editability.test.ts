// Tests for invoice-editability-routes.ts — lifecycle guards, membership edits,
// QB confirmation, company isolation.
//
// All storage/db calls are stubbed via the injectable deps interface, so no real
// PostgreSQL or network access is required.
//
// Coverage:
//   A. PATCH /api/invoices/:id — lifecycle guards, strict schema, QB update trigger
//   B. POST  /api/invoices/:id/return-to-draft — from generated only
//   C. POST  /api/invoices/:id/tickets (add) — draft-only, strict unbilled, same customer
//   D. DELETE /api/invoices/:id/tickets/:ref (remove) — draft-only, cannot empty
//   E. POST  /api/invoices/:id/finalize — from draft only, QB sync fires
//   F. POST  /api/invoices/:id/void — any unpaid, paid blocked, QB confirm required
//   G. Company isolation — cross-company → 404

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerInvoiceEditabilityRoutes } from "./invoice-editability-routes";
import {
  billingSheets as billingSheetsTbl,
  workOrders as workOrdersTbl,
  wetCheckBillings as wetCheckBillingsTbl,
  invoiceItems as invoiceItemsTbl,
} from "@workspace/db/schema";

// ── Fixtures ────────────────────────────────────────────────────────────────

interface MockInvoice {
  id: number;
  status: string;
  customerId: number;
  companyId: number;
  invoiceNumber: string;
  totalAmount: string;
  partsSubtotal: string;
  laborSubtotal: string;
  quickbooksInvoiceId: string | null;
  quickbooksSyncToken: string | null;
  notes: string | null;
  dueDate: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  sentAt: Date | null;
  items?: MockItem[];
}

interface MockItem {
  id: number;
  invoiceId: number;
  sourceType: string;
  billingSheetId: number | null;
  workOrderId: number | null;
  wetCheckBillingId: number | null;
  description: string;
  totalPrice: string;
  laborHours: string;
  laborRate: string;
  laborTotal: string;
  quantity: string;
  unitPrice: string;
  workDate: Date | null;
}

interface MockBillingSheet {
  id: number;
  customerId: number;
  companyId: number;
  billingNumber: string;
  workDescription: string;
  invoiceId: number | null;
  totalAmount: string;
  partsSubtotal: string;
  laborSubtotal: string;
  totalHours: string;
  laborRate: string;
  workDate: Date | null;
}

// Pre-built fixtures for each status
function makeInvoice(overrides: Partial<MockInvoice> = {}): MockInvoice {
  return {
    id: 1,
    status: "generated",
    customerId: 100,
    companyId: 1,
    invoiceNumber: "INV-001",
    totalAmount: "150.00",
    partsSubtotal: "100.00",
    laborSubtotal: "50.00",
    quickbooksInvoiceId: null,
    quickbooksSyncToken: null,
    notes: null,
    dueDate: null,
    periodStart: null,
    periodEnd: null,
    sentAt: null,
    items: [makeItem()],
    ...overrides,
  };
}

function makeItem(overrides: Partial<MockItem> = {}): MockItem {
  return {
    id: 1,
    invoiceId: 1,
    sourceType: "billing_sheet",
    billingSheetId: 10,
    workOrderId: null,
    wetCheckBillingId: null,
    description: "BS #10",
    totalPrice: "150.00",
    laborHours: "2",
    laborRate: "25",
    laborTotal: "50.00",
    quantity: "1",
    unitPrice: "150.00",
    workDate: null,
    ...overrides,
  };
}

function makeBillingSheet(overrides: Partial<MockBillingSheet> = {}): MockBillingSheet {
  return {
    id: 10,
    customerId: 100,
    companyId: 1,
    billingNumber: "BS-010",
    workDescription: "Irrigation service",
    invoiceId: null,
    totalAmount: "200.00",
    partsSubtotal: "150.00",
    laborSubtotal: "50.00",
    totalHours: "2",
    laborRate: "25",
    workDate: null,
    ...overrides,
  };
}

// ── Minimal auth stub ────────────────────────────────────────────────────────
// Reads x-user-* headers set by the test fetch calls.
const requireAuthentication: RequestHandler = (req: any, res, next) => {
  const role = req.headers["x-user-role"];
  if (!role) { res.status(401).json({ message: "Authentication required" }); return; }
  req.authenticatedUserRole = String(role);
  req.authenticatedUserId = 1;
  const cid = req.headers["x-user-company-id"];
  req.authenticatedUserCompanyId = cid ? parseInt(String(cid), 10) : null;
  next();
};

// Invoice access guard stubs: always pass (we're testing at the route level;
// the role matrix itself is covered by bookkeeper-role-matrix.test.ts).
const requireInvoiceRead: RequestHandler = (_req, _res, next) => next();
const requireInvoiceWrite: RequestHandler = (_req, _res, next) => next();

// ── Minimal db mock ─────────────────────────────────────────────────────────
//
// The mock follows the drizzle ORM fluent builder pattern.
// Callers configure what each table's query should return.

interface DbMockOpts {
  billingSheetRow?: MockBillingSheet | null;
  invoiceItems?: MockItem[];
  txOk?: boolean; // if false, transaction throws
}

function makeMockDb(opts: DbMockOpts = {}) {
  const { billingSheetRow = null, invoiceItems = [], txOk = true } = opts;

  // Fluent builder that resolves to `rows` at the end of the chain.
  function builder(rows: unknown[]): any {
    const b: any = {
      from: () => b,
      where: () => b,
      limit: async () => rows,
      // Allow plain `await db.select().from(x).where(y)` (no .limit).
      then: (resolve: any, reject: any) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return b;
  }

  const db: any = {
    _txLog: [] as string[],

    select: (_fields?: any) => ({
      from: (table: any) => {
        // Compare by drizzle table object identity (not name string) so the
        // mock returns the right rows regardless of how drizzle exposes the
        // internal table name on the object.
        const rows: any[] =
          table === billingSheetsTbl ? (billingSheetRow ? [billingSheetRow] : [])
          : table === workOrdersTbl ? []
          : table === wetCheckBillingsTbl ? []
          : table === invoiceItemsTbl ? invoiceItems
          : [];
        return builder(rows);
      },
    }),

    insert: (_table: any) => ({
      values: (_vals: any) => ({ returning: async () => [{}] }),
    }),

    update: (_table: any) => ({
      set: (_vals: any) => ({
        where: async () => [],
      }),
    }),

    delete: (_table: any) => ({
      where: async () => [],
    }),

    transaction: async (fn: (tx: any) => Promise<any>) => {
      if (!txOk) throw new Error("transaction failed (injected)");
      // Pass a copy of `db` as the transaction executor.
      return fn(db);
    },
  };

  return db;
}

// ── Storage mock ─────────────────────────────────────────────────────────────

interface StorageMockOpts {
  invoices?: MockInvoice[];
}

function makeMockStorage(opts: StorageMockOpts = {}) {
  const { invoices = [] } = opts;
  const store = new Map(invoices.map((inv) => [inv.id, inv]));
  const updated: { id: number; patch: any }[] = [];

  return {
    _updated: updated,
    async getInvoiceById(id: number, companyId: number | null) {
      const inv = store.get(id);
      if (!inv) return undefined;
      if (companyId !== null && inv.companyId !== companyId) return undefined;
      return { ...inv, items: inv.items ?? [] };
    },
    async updateInvoice(id: number, patch: any) {
      const inv = store.get(id);
      if (!inv) return undefined;
      updated.push({ id, patch });
      Object.assign(inv, patch);
      return { ...inv, items: inv.items ?? [] };
    },
  };
}

// ── Test harness ─────────────────────────────────────────────────────────────

interface Harness {
  url: (path: string) => string;
  close: () => Promise<void>;
  qbCalls: string[];
}

async function startHarness(
  invoices: MockInvoice[],
  dbOpts: DbMockOpts = {},
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const qbCalls: string[] = [];
  const syncInvoiceToQb = async (invoiceId: number) => {
    qbCalls.push(String(invoiceId));
    return { quickbooksId: "QB-999" };
  };

  registerInvoiceEditabilityRoutes(app, {
    requireAuthentication,
    requireInvoiceRead,
    requireInvoiceWrite,
    syncInvoiceToQb,
    _db: makeMockDb(dbOpts),
    _storageApi: makeMockStorage({ invoices }),
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    qbCalls,
  };
}

// Authenticated fetch helper: sends x-user-role + x-user-company-id headers.
function authFetch(
  url: string,
  opts: { method?: string; body?: object; role?: string; companyId?: number | null } = {},
) {
  const { method = "GET", body, role = "billing_manager", companyId = 1 } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-user-role": role,
  };
  if (companyId !== null) headers["x-user-company-id"] = String(companyId);
  return fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── A. PATCH /api/invoices/:id — metadata edit lifecycle guards ───────────────

describe("A. PATCH /api/invoices/:id — metadata lifecycle guards", () => {
  let h: Harness;

  before(async () => {
    h = await startHarness([
      makeInvoice({ id: 1, status: "draft" }),
      makeInvoice({ id: 2, status: "generated" }),
      makeInvoice({ id: 3, status: "sent" }),
      makeInvoice({ id: 4, status: "paid" }),
      makeInvoice({ id: 5, status: "cancelled" }),
      makeInvoice({ id: 6, status: "superseded" }),
      makeInvoice({ id: 7, status: "merged" }),
      makeInvoice({ id: 8, status: "generated", quickbooksInvoiceId: "QB-42", quickbooksSyncToken: "3" }),
    ]);
  });

  after(() => h.close());

  it("200 on draft invoice (draft is unpaid and non-terminal)", async () => {
    const r = await authFetch(h.url("/api/invoices/1"), { method: "PATCH", body: { notes: "hello" } });
    assert.equal(r.status, 200);
  });

  it("200 on generated invoice", async () => {
    const r = await authFetch(h.url("/api/invoices/2"), { method: "PATCH", body: { notes: "updated" } });
    assert.equal(r.status, 200);
  });

  it("200 on sent invoice", async () => {
    const r = await authFetch(h.url("/api/invoices/3"), { method: "PATCH", body: { notes: "sent" } });
    assert.equal(r.status, 200);
  });

  it("409 on paid invoice", async () => {
    const r = await authFetch(h.url("/api/invoices/4"), { method: "PATCH", body: { notes: "paid" } });
    assert.equal(r.status, 409);
    const body = await r.json() as any;
    assert.ok((body.message as string).toLowerCase().includes("paid"));
  });

  it("409 on cancelled invoice (terminal)", async () => {
    const r = await authFetch(h.url("/api/invoices/5"), { method: "PATCH", body: { notes: "x" } });
    assert.equal(r.status, 409);
    const body = await r.json() as any;
    assert.ok((body.message as string).toLowerCase().includes("terminal") || (body.message as string).toLowerCase().includes("cancelled"));
  });

  it("409 on superseded invoice (terminal)", async () => {
    const r = await authFetch(h.url("/api/invoices/6"), { method: "PATCH", body: { notes: "x" } });
    assert.equal(r.status, 409);
  });

  it("409 on merged invoice (terminal)", async () => {
    const r = await authFetch(h.url("/api/invoices/7"), { method: "PATCH", body: { notes: "x" } });
    assert.equal(r.status, 409);
  });

  it("400 when an unknown field is included (strict schema)", async () => {
    const r = await authFetch(h.url("/api/invoices/2"), { method: "PATCH", body: { notes: "ok", hackyField: "x" } });
    assert.equal(r.status, 400);
  });

  it("400 when only unknown fields are sent", async () => {
    const r = await authFetch(h.url("/api/invoices/2"), { method: "PATCH", body: { amount: 99999 } });
    assert.equal(r.status, 400);
  });

  it("401 when no auth headers", async () => {
    const r = await fetch(h.url("/api/invoices/2"), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: "x" }) });
    assert.equal(r.status, 401);
  });

  it("404 when invoice not found", async () => {
    const r = await authFetch(h.url("/api/invoices/9999"), { method: "PATCH", body: { notes: "x" } });
    assert.equal(r.status, 404);
  });

  it("200 and no qb sync when period unchanged", async () => {
    h.qbCalls.length = 0;
    const r = await authFetch(h.url("/api/invoices/8"), { method: "PATCH", body: { notes: "just notes" } });
    assert.equal(r.status, 200);
    assert.equal(h.qbCalls.length, 0, "QB should not be called when period/dueDate not changed");
  });

  it("triggers QB sync when periodStart changed on QB-synced invoice", async () => {
    h.qbCalls.length = 0;
    const r = await authFetch(h.url("/api/invoices/8"), { method: "PATCH", body: { periodStart: "2026-01-01" } });
    assert.equal(r.status, 200);
    assert.equal(h.qbCalls.length, 1, "QB sync should be called when period changed on QB-synced invoice");
    assert.equal(h.qbCalls[0], "8");
  });
});

// ── B. POST /api/invoices/:id/return-to-draft ────────────────────────────────

describe("B. POST /return-to-draft — from generated only", () => {
  let h: Harness;

  before(async () => {
    h = await startHarness([
      makeInvoice({ id: 1, status: "generated" }),
      makeInvoice({ id: 2, status: "draft" }),
      makeInvoice({ id: 3, status: "sent" }),
      makeInvoice({ id: 4, status: "paid" }),
      makeInvoice({ id: 5, status: "cancelled" }),
    ]);
  });

  after(() => h.close());

  it("200 from generated", async () => {
    const r = await authFetch(h.url("/api/invoices/1/return-to-draft"), { method: "POST" });
    assert.equal(r.status, 200);
  });

  it("400 from draft (already draft)", async () => {
    const r = await authFetch(h.url("/api/invoices/2/return-to-draft"), { method: "POST" });
    assert.equal(r.status, 400);
  });

  it("400 from sent (cannot walk back past generated)", async () => {
    const r = await authFetch(h.url("/api/invoices/3/return-to-draft"), { method: "POST" });
    assert.equal(r.status, 400);
  });

  it("400 from paid", async () => {
    const r = await authFetch(h.url("/api/invoices/4/return-to-draft"), { method: "POST" });
    assert.equal(r.status, 400);
  });

  it("400 from cancelled", async () => {
    const r = await authFetch(h.url("/api/invoices/5/return-to-draft"), { method: "POST" });
    assert.equal(r.status, 400);
  });

  it("404 when invoice not found", async () => {
    const r = await authFetch(h.url("/api/invoices/9999/return-to-draft"), { method: "POST" });
    assert.equal(r.status, 404);
  });
});

// ── C. POST /api/invoices/:id/tickets — add ticket ───────────────────────────

describe("C. POST /tickets — add ticket (draft-only, strict unbilled, same customer)", () => {
  let h: Harness;
  const unbilledSheet = makeBillingSheet({ id: 10, customerId: 100, invoiceId: null });
  const billedSheet = makeBillingSheet({ id: 11, customerId: 100, invoiceId: 99 });
  const otherCustomerSheet = makeBillingSheet({ id: 12, customerId: 999, invoiceId: null });

  before(async () => {
    h = await startHarness(
      [
        makeInvoice({ id: 1, status: "draft", customerId: 100 }),
        makeInvoice({ id: 2, status: "generated", customerId: 100 }),
        makeInvoice({ id: 3, status: "paid", customerId: 100 }),
      ],
      // Return the unbilled sheet by default — individual tests use different ticket IDs.
      { billingSheetRow: unbilledSheet },
    );
  });

  after(() => h.close());

  it("400 when target invoice is generated (not draft)", async () => {
    const r = await authFetch(h.url("/api/invoices/2/tickets"), {
      method: "POST",
      body: { ticketType: "billing_sheet", ticketId: 10 },
    });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.ok((body.message as string).toLowerCase().includes("draft"));
  });

  it("400 when target invoice is paid", async () => {
    const r = await authFetch(h.url("/api/invoices/3/tickets"), {
      method: "POST",
      body: { ticketType: "billing_sheet", ticketId: 10 },
    });
    assert.equal(r.status, 400);
  });

  it("400 with invalid ticketType", async () => {
    const r = await authFetch(h.url("/api/invoices/1/tickets"), {
      method: "POST",
      body: { ticketType: "bad_type", ticketId: 10 },
    });
    assert.equal(r.status, 400);
  });

  it("400 with missing ticketId", async () => {
    const r = await authFetch(h.url("/api/invoices/1/tickets"), {
      method: "POST",
      body: { ticketType: "billing_sheet" },
    });
    assert.equal(r.status, 400);
  });

  it("404 when invoice not found", async () => {
    const r = await authFetch(h.url("/api/invoices/9999/tickets"), {
      method: "POST",
      body: { ticketType: "billing_sheet", ticketId: 10 },
    });
    assert.equal(r.status, 404);
  });
});

// ── C2. Strict unbilled precondition tests ────────────────────────────────────

describe("C2. Add ticket — strict unbilled precondition (invoiceId must be null)", () => {
  it("409 when ticket is already on THIS invoice", async () => {
    // Sheet has invoiceId = 1 (same as target)
    const h = await startHarness(
      [makeInvoice({ id: 1, status: "draft", customerId: 100 })],
      { billingSheetRow: makeBillingSheet({ id: 10, customerId: 100, invoiceId: 1 }) },
    );
    try {
      const r = await authFetch(h.url("/api/invoices/1/tickets"), {
        method: "POST",
        body: { ticketType: "billing_sheet", ticketId: 10 },
      });
      assert.equal(r.status, 409);
      const body = await r.json() as any;
      assert.ok((body.message as string).toLowerCase().includes("already"));
    } finally {
      await h.close();
    }
  });

  it("409 when ticket is on a DIFFERENT invoice (even if cancelled)", async () => {
    // Sheet has invoiceId = 99 (different invoice — even if that invoice were cancelled,
    // the strict precondition rejects this)
    const h = await startHarness(
      [makeInvoice({ id: 1, status: "draft", customerId: 100 })],
      { billingSheetRow: makeBillingSheet({ id: 10, customerId: 100, invoiceId: 99 }) },
    );
    try {
      const r = await authFetch(h.url("/api/invoices/1/tickets"), {
        method: "POST",
        body: { ticketType: "billing_sheet", ticketId: 10 },
      });
      assert.equal(r.status, 409);
      const body = await r.json() as any;
      // Must mention the other invoice id so the user knows what to release first.
      assert.ok(String(body.message).includes("99"));
    } finally {
      await h.close();
    }
  });
});

// ── D. DELETE /api/invoices/:id/tickets/:ref — remove ticket ─────────────────

describe("D. DELETE /tickets/:ref — draft-only, cannot empty", () => {
  let h: Harness;

  before(async () => {
    h = await startHarness(
      [
        makeInvoice({ id: 1, status: "draft", items: [makeItem()] }),
        makeInvoice({ id: 2, status: "generated", items: [makeItem()] }),
      ],
      { invoiceItems: [makeItem()] },
    );
  });

  after(() => h.close());

  it("400 when target invoice is generated (not draft)", async () => {
    const r = await authFetch(h.url("/api/invoices/2/tickets/billing_sheet:10"), { method: "DELETE" });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.ok((body.message as string).toLowerCase().includes("draft"));
  });

  it("400 when removing the only ticket (would empty the invoice)", async () => {
    const r = await authFetch(h.url("/api/invoices/1/tickets/billing_sheet:10"), { method: "DELETE" });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.ok((body.message as string).toLowerCase().includes("last") || (body.message as string).toLowerCase().includes("void"));
  });

  it("400 on invalid ticket ref format (no colon)", async () => {
    const r = await authFetch(h.url("/api/invoices/1/tickets/badformat"), { method: "DELETE" });
    assert.equal(r.status, 400);
  });

  it("400 on invalid ticket type in ref", async () => {
    const r = await authFetch(h.url("/api/invoices/1/tickets/bad_type:10"), { method: "DELETE" });
    assert.equal(r.status, 400);
  });

  it("404 when invoice not found", async () => {
    const r = await authFetch(h.url("/api/invoices/9999/tickets/billing_sheet:10"), { method: "DELETE" });
    assert.equal(r.status, 404);
  });
});

// ── E. POST /api/invoices/:id/finalize ───────────────────────────────────────

describe("E. POST /finalize — draft only, QB sync fires", () => {
  let h: Harness;

  before(async () => {
    h = await startHarness(
      [
        makeInvoice({ id: 1, status: "draft", items: [makeItem()] }),
        makeInvoice({ id: 2, status: "generated", items: [makeItem()] }),
        makeInvoice({ id: 3, status: "paid", items: [makeItem()] }),
      ],
      { invoiceItems: [makeItem()] },
    );
  });

  after(() => h.close());

  it("200 from draft (happy path)", async () => {
    const r = await authFetch(h.url("/api/invoices/1/finalize"), { method: "POST", body: {} });
    assert.equal(r.status, 200);
  });

  it("400 when already generated", async () => {
    const r = await authFetch(h.url("/api/invoices/2/finalize"), { method: "POST", body: {} });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.ok((body.message as string).toLowerCase().includes("draft"));
  });

  it("400 when paid", async () => {
    const r = await authFetch(h.url("/api/invoices/3/finalize"), { method: "POST", body: {} });
    assert.equal(r.status, 400);
  });

  it("triggers QB sync on finalize", async () => {
    // Use a fresh harness so invoice 1 is still draft (not mutated by the happy-path test above).
    const h2 = await startHarness(
      [makeInvoice({ id: 1, status: "draft", items: [makeItem()] })],
      { invoiceItems: [makeItem()] },
    );
    try {
      const r = await authFetch(h2.url("/api/invoices/1/finalize"), { method: "POST", body: {} });
      assert.equal(r.status, 200);
      assert.equal(h2.qbCalls.length, 1, "QB sync should be triggered by finalize");
    } finally {
      await h2.close();
    }
  });

  it("404 when invoice not found", async () => {
    const r = await authFetch(h.url("/api/invoices/9999/finalize"), { method: "POST", body: {} });
    assert.equal(r.status, 404);
  });
});

// ── F. POST /api/invoices/:id/void — void & release ──────────────────────────

describe("F. POST /void — any unpaid, paid blocked, QB confirm required", () => {
  let h: Harness;

  before(async () => {
    h = await startHarness(
      [
        makeInvoice({ id: 1, status: "draft" }),
        makeInvoice({ id: 2, status: "generated" }),
        makeInvoice({ id: 3, status: "sent" }),
        makeInvoice({ id: 4, status: "paid" }),
        makeInvoice({ id: 5, status: "cancelled" }),
        makeInvoice({ id: 6, status: "generated", quickbooksInvoiceId: "QB-42", quickbooksSyncToken: "3" }),
      ],
      { invoiceItems: [] },
    );
  });

  after(() => h.close());

  it("200 from draft (draft is unpaid)", async () => {
    const r = await authFetch(h.url("/api/invoices/1/void"), { method: "POST", body: {} });
    assert.equal(r.status, 200);
  });

  it("200 from generated with no QB link", async () => {
    const r = await authFetch(h.url("/api/invoices/2/void"), { method: "POST", body: {} });
    assert.equal(r.status, 200);
  });

  it("200 from sent with no QB link", async () => {
    const r = await authFetch(h.url("/api/invoices/3/void"), { method: "POST", body: {} });
    assert.equal(r.status, 200);
  });

  it("409 when paid — locked, never voidable", async () => {
    const r = await authFetch(h.url("/api/invoices/4/void"), { method: "POST", body: {} });
    assert.equal(r.status, 409);
    const body = await r.json() as any;
    assert.ok((body.message as string).toLowerCase().includes("paid"));
  });

  it("409 when already cancelled (terminal)", async () => {
    const r = await authFetch(h.url("/api/invoices/5/void"), { method: "POST", body: {} });
    assert.equal(r.status, 409);
  });

  it("409 with {requiresQbConfirm: true} when QB-synced and no qbAction", async () => {
    const r = await authFetch(h.url("/api/invoices/6/void"), { method: "POST", body: {} });
    assert.equal(r.status, 409);
    const body = await r.json() as any;
    assert.equal(body.requiresQbConfirm, true, "must include requiresQbConfirm flag");
  });

  it("200 from QB-synced with qbAction: unlink", async () => {
    const r = await authFetch(h.url("/api/invoices/6/void"), { method: "POST", body: { qbAction: "unlink" } });
    assert.equal(r.status, 200);
  });

  it("200 from QB-synced with qbAction: void", async () => {
    // Need a fresh harness since the previous unlink already voided invoice 6
    const h2 = await startHarness(
      [makeInvoice({ id: 6, status: "generated", quickbooksInvoiceId: "QB-42" })],
      { invoiceItems: [] },
    );
    try {
      const r = await authFetch(h2.url("/api/invoices/6/void"), { method: "POST", body: { qbAction: "void" } });
      assert.equal(r.status, 200);
    } finally {
      await h2.close();
    }
  });

  it("400 with invalid qbAction value", async () => {
    const r = await authFetch(h.url("/api/invoices/6/void"), { method: "POST", body: { qbAction: "delete" } });
    assert.equal(r.status, 400);
  });

  it("404 when invoice not found", async () => {
    const r = await authFetch(h.url("/api/invoices/9999/void"), { method: "POST", body: {} });
    assert.equal(r.status, 404);
  });
});

// ── G. Company isolation ──────────────────────────────────────────────────────

describe("G. Company isolation — cross-company access → 404", () => {
  let h: Harness;

  before(async () => {
    // Invoice belongs to company 1; tests call as company 2.
    h = await startHarness([
      makeInvoice({ id: 1, status: "generated", companyId: 1 }),
    ]);
  });

  after(() => h.close());

  it("PATCH returns 404 for wrong company", async () => {
    const r = await authFetch(h.url("/api/invoices/1"), {
      method: "PATCH",
      body: { notes: "x" },
      companyId: 2,
    });
    assert.equal(r.status, 404);
  });

  it("return-to-draft returns 404 for wrong company", async () => {
    const r = await authFetch(h.url("/api/invoices/1/return-to-draft"), {
      method: "POST",
      companyId: 2,
    });
    assert.equal(r.status, 404);
  });

  it("finalize returns 404 for wrong company", async () => {
    const r = await authFetch(h.url("/api/invoices/1/finalize"), {
      method: "POST",
      body: {},
      companyId: 2,
    });
    assert.equal(r.status, 404);
  });

  it("void returns 404 for wrong company", async () => {
    const r = await authFetch(h.url("/api/invoices/1/void"), {
      method: "POST",
      body: {},
      companyId: 2,
    });
    assert.equal(r.status, 404);
  });

  it("super_admin bypasses company isolation (companyId header absent → null scope)", async () => {
    const r = await authFetch(h.url("/api/invoices/1"), {
      method: "PATCH",
      body: { notes: "super admin edit" },
      role: "super_admin",
      companyId: null,
    });
    assert.equal(r.status, 200, "super_admin with no company header should see all companies");
  });
});

// ── H. GET /api/invoices/:id/items — draft editor items endpoint ──────────────

describe("H. GET /api/invoices/:id/items — draft editor", () => {
  let h: Harness;

  before(async () => {
    h = await startHarness([
      makeInvoice({ id: 1, status: "draft", items: [makeItem()] }),
    ]);
  });

  after(() => h.close());

  it("200 and returns items array", async () => {
    const r = await authFetch(h.url("/api/invoices/1/items"));
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.items), "response should have an items array");
  });

  it("404 when invoice not found", async () => {
    const r = await authFetch(h.url("/api/invoices/9999/items"));
    assert.equal(r.status, 404);
  });

  it("401 without auth headers", async () => {
    const r = await fetch(h.url("/api/invoices/1/items"));
    assert.equal(r.status, 401);
  });

  it("404 for cross-company request", async () => {
    const r = await authFetch(h.url("/api/invoices/1/items"), { companyId: 2 });
    assert.equal(r.status, 404);
  });
});
