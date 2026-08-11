// Task #1918 — the three reads behind an expanded invoice row.
//
// The expanded row asks the server for line items, reminder history, and the
// internal A/R note thread. This file covers what the server owes it:
//
//   (a) the line-item read carries the source ticket's human-readable number
//       and a work date derived from the source, not the item's snapshot
//   (b) that derivation is the audit view's rule, shared rather than copied —
//       proven both behaviourally and statically over the module source
//   (c) company isolation on every one of the three reads, with the invoice
//       resolved company-scoped BEFORE any source, note, or reminder row is
//       touched
//   (d) a role without CAN_READ_AR_NOTES gets no note data anywhere: 403 on
//       the note read, and no note field on the line-item read either
//   (e) a role without CAN_SEND_INVOICE_EMAIL is refused reminder history —
//       the capability is NOT widened to make the section appear
//   (f) empty reads answer with an empty collection, not a 404
//
// Real guards, real handlers, spied storage. Nothing here re-implements
// authorization or the derivation and then agrees with itself.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { registerInvoiceEditabilityRoutes } from "./invoice-editability-routes";
import { registerInvoiceArNoteRoutes } from "./invoice-ar-note-routes";
import { registerInvoiceReminderRoutes } from "./invoice-reminder-routes";
import {
  requireInvoiceRead,
  requireInvoiceSend,
  requireReminderHistoryRead,
  requireArNotesAccess,
  requireInvoiceWrite,
} from "./role-guards";
import {
  deriveSourceWorkDate,
  deriveSourceTicketNumber,
  enrichInvoiceItemsWithSource,
} from "./invoice-item-source";

// ── Harness ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function makeAuth(role: string, companyId: number | null = 1): RequestHandler {
  return (req: any, _res, next) => {
    req.authenticatedUserRole = role;
    req.authenticatedUserId = 7;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
}

async function request(app: Express, method: "GET" | "POST", path: string, body?: unknown) {
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed };
  } finally {
    server.close();
  }
}

interface SourceRows {
  billingSheets?: Record<number, any>;
  workOrders?: Record<number, any>;
  wetCheckBillings?: Record<number, any>;
}

interface ItemsHarnessOpts {
  role?: string;
  companyId?: number | null;
  invoices?: Record<number, any>;
  sources?: SourceRows;
}

/**
 * The line-item read, mounted with the REAL invoice-read guard so a role that
 * cannot read invoices is refused by the same code production uses.
 */
function itemsHarness(opts: ItemsHarnessOpts = {}) {
  const invoices: Record<number, any> = opts.invoices ?? {};
  const sources = opts.sources ?? {};
  /** Every source lookup, in order — proves ordering and de-duplication. */
  const sourceReads: string[] = [];

  const storageApi = {
    async getInvoiceById(id: number, companyId: number | null) {
      const row = invoices[id];
      if (!row) return undefined;
      if (companyId !== null && row.companyId !== companyId) return undefined;
      return row;
    },
    async getBillingSheetById(id: number, _companyId: number | null) {
      sourceReads.push(`billing_sheet:${id}`);
      return sources.billingSheets?.[id];
    },
    async getWorkOrder(id: number, _companyId: number | null) {
      sourceReads.push(`work_order:${id}`);
      return sources.workOrders?.[id];
    },
    async getWetCheckBillingById(id: number, _companyId: number | null) {
      sourceReads.push(`wet_check_billing:${id}`);
      return sources.wetCheckBillings?.[id];
    },
  };

  const app = express();
  app.use(express.json());
  registerInvoiceEditabilityRoutes(app, {
    requireAuthentication: makeAuth(opts.role ?? "billing_manager", opts.companyId ?? 1),
    requireInvoiceRead,
    requireInvoiceWrite,
    _storageApi: storageApi,
    _db: {},
  });

  return { app, sourceReads, storageApi };
}

function notesHarness(opts: {
  role?: string;
  companyId?: number | null;
  invoices?: Record<number, any>;
  notes?: any[];
} = {}) {
  const invoices: Record<number, any> = opts.invoices ?? {};
  const notes = opts.notes ?? [];
  const noteReads: number[] = [];

  const storageApi = {
    async getInvoiceById(id: number, companyId: number | null) {
      const row = invoices[id];
      if (!row) return undefined;
      if (companyId !== null && row.companyId !== companyId) return undefined;
      return row;
    },
    async getInvoiceArNotes(invoiceId: number, companyId: number | null) {
      noteReads.push(invoiceId);
      return notes
        .filter((n) => n.invoiceId === invoiceId)
        .filter((n) => companyId == null || n.companyId === companyId);
    },
    async getUser(_id: number) {
      return { id: 7, name: "Dana Books" };
    },
  };

  const app = express();
  app.use(express.json());
  registerInvoiceArNoteRoutes(app, {
    requireAuthentication: makeAuth(opts.role ?? "billing_manager", opts.companyId ?? 1),
    requireArNotesAccess,
    _storageApi: storageApi,
  });

  return { app, noteReads };
}

function reminderInvoice(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    invoiceNumber: "INV-1",
    companyId: 1,
    customerId: 100,
    customerName: "Acme Grounds",
    customerEmail: "ap@acme.test",
    status: "generated",
    createdAt: new Date(NOW.getTime() - 45 * DAY),
    dueDate: new Date(NOW.getTime() - 45 * DAY),
    sentAt: new Date(NOW.getTime() - 44 * DAY),
    paidAt: null,
    paymentStatus: "unpaid",
    paymentSyncedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    balance: "300.00",
    totalAmount: "300.00",
    qbVoidDetectedAt: null,
    ...overrides,
  };
}

function remindersHarness(opts: {
  role?: string;
  companyId?: number | null;
  invoices?: Record<number, any>;
  reminders?: any[];
} = {}) {
  const invoices: Record<number, any> = opts.invoices ?? { 1: reminderInvoice() };
  const reminders = opts.reminders ?? [];
  const historyReads: number[] = [];

  const storageApi = {
    async getInvoiceById(id: number, companyId: number | null) {
      const row = invoices[id];
      if (!row) return undefined;
      if (companyId !== null && row.companyId !== companyId) return undefined;
      return row;
    },
    async getInvoicePdfByInvoiceId(id: number) {
      return { id: 9, pdfUrl: `/pdf/${id}.pdf` };
    },
    async getUser(_id: number) {
      return { id: 7, name: "Dana Books" };
    },
    async getCompanyProfile(_id: number) {
      return { id: 1, name: "Green Valley Irrigation", email: "billing@gv.test", phone: null, logo: null };
    },
    async getInvoiceReminders(invoiceId: number, companyId: number | null) {
      historyReads.push(invoiceId);
      return reminders
        .filter((r) => r.invoiceId === invoiceId)
        .filter((r) => companyId == null || r.companyId === companyId);
    },
    async getLastDeliveredInvoiceReminder(invoiceId: number) {
      return reminders.filter((r) => r.invoiceId === invoiceId && r.deliveryStatus === "sent")[0];
    },
    async createInvoiceReminder(row: any) {
      return { id: 999, deliveryError: null, ...row };
    },
  };

  const app = express();
  app.use(express.json());
  registerInvoiceReminderRoutes(app, {
    requireAuthentication: makeAuth(opts.role ?? "bookkeeper", opts.companyId ?? 1),
    requireInvoiceSend,
    requireReminderHistoryRead,
    _storageApi: storageApi,
    _mailer: async () => ({ success: true }),
    _loadPaymentTerms: async () => "net_30",
    _now: () => NOW,
    _baseUrl: () => "https://irrigopro.test",
  });

  return { app, historyReads };
}

// Fixtures shared by the enrichment group. One invoice, one item per source
// type, each pointing at a ticket that has both a real number and a work date
// later than the item's own snapshot — so a reader that ignores the source is
// visibly wrong rather than accidentally right.
const ITEM_SNAPSHOT = new Date("2026-01-01T00:00:00.000Z");
const BS_WORK_DATE = new Date("2026-06-02T00:00:00.000Z");
const WO_COMPLETED = new Date("2026-06-03T00:00:00.000Z");
const WCB_WORK_DATE = new Date("2026-06-04T00:00:00.000Z");

function threeSourceInvoice() {
  return {
    1: {
      id: 1,
      companyId: 1,
      invoiceNumber: "INV-1",
      items: [
        {
          id: 11,
          invoiceId: 1,
          sourceType: "billing_sheet",
          billingSheetId: 10,
          workOrderId: null,
          wetCheckBillingId: null,
          description: "Zone 3 head replacement",
          totalPrice: "150.00",
          workDate: ITEM_SNAPSHOT,
        },
        {
          id: 12,
          invoiceId: 1,
          sourceType: "work_order",
          billingSheetId: null,
          workOrderId: 20,
          wetCheckBillingId: null,
          description: "Controller diagnostics",
          totalPrice: "90.00",
          workDate: ITEM_SNAPSHOT,
        },
        {
          id: 13,
          invoiceId: 1,
          sourceType: "wet_check_billing",
          billingSheetId: null,
          workOrderId: null,
          wetCheckBillingId: 30,
          description: "Spring wet check",
          totalPrice: "60.00",
          workDate: ITEM_SNAPSHOT,
        },
      ],
    },
  };
}

const THREE_SOURCES: SourceRows = {
  billingSheets: { 10: { id: 10, billingNumber: "BS-010", workDate: BS_WORK_DATE } },
  workOrders: {
    20: {
      id: 20,
      workOrderNumber: "WO-2026-020",
      completedAt: WO_COMPLETED,
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  },
  wetCheckBillings: { 30: { id: 30, billingNumber: "WCB-030", workDate: WCB_WORK_DATE } },
};

// ── (a) The enriched line-item read ─────────────────────────────────────────

describe("GET /api/invoices/:id/items — the expanded row's line items", () => {
  it("carries each source ticket's human-readable number, not its internal id", async () => {
    const h = itemsHarness({ invoices: threeSourceInvoice(), sources: THREE_SOURCES });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/items");

    assert.equal(status, 200);
    assert.deepEqual(
      body.items.map((i: any) => i.sourceNumber),
      ["BS-010", "WO-2026-020", "WCB-030"],
    );
    // The type label travels with it so the client does not have to keep its
    // own source-type table beside the server's.
    assert.deepEqual(
      body.items.map((i: any) => i.sourceTypeLabel),
      ["BS", "WO", "WCB"],
    );
  });

  it("derives the work date from the source ticket, not the item's snapshot", async () => {
    const h = itemsHarness({ invoices: threeSourceInvoice(), sources: THREE_SOURCES });
    const { body } = await request(h.app, "GET", "/api/invoices/1/items");

    assert.deepEqual(
      body.items.map((i: any) => i.workDate),
      [
        BS_WORK_DATE.toISOString(),
        WO_COMPLETED.toISOString(),
        WCB_WORK_DATE.toISOString(),
      ],
    );
    // And emphatically not the stale snapshot every item carried.
    for (const item of body.items) {
      assert.notEqual(item.workDate, ITEM_SNAPSHOT.toISOString());
    }
  });

  it("falls back to the work order's last update when it was never completed", async () => {
    const invoices = threeSourceInvoice();
    invoices[1].items = [invoices[1].items[1]];
    const updatedAt = new Date("2026-07-09T00:00:00.000Z");
    const h = itemsHarness({
      invoices,
      sources: { workOrders: { 20: { id: 20, workOrderNumber: "WO-2026-020", completedAt: null, updatedAt } } },
    });
    const { body } = await request(h.app, "GET", "/api/invoices/1/items");

    assert.equal(body.items[0].workDate, updatedAt.toISOString());
  });

  it("keeps the item's own snapshot, and no invented number, when the source is gone", async () => {
    const invoices = threeSourceInvoice();
    invoices[1].items = [invoices[1].items[0]];
    const h = itemsHarness({ invoices, sources: { billingSheets: {} } });
    const { body } = await request(h.app, "GET", "/api/invoices/1/items");

    assert.equal(body.items[0].sourceNumber, null);
    assert.equal(body.items[0].workDate, ITEM_SNAPSHOT.toISOString());
  });

  it("reads each source ticket once even when several items share it", async () => {
    const invoices = threeSourceInvoice();
    invoices[1].items = [
      { ...invoices[1].items[0], id: 11 },
      { ...invoices[1].items[0], id: 14, description: "Second line, same sheet" },
      { ...invoices[1].items[0], id: 15, description: "Third line, same sheet" },
    ];
    const h = itemsHarness({ invoices, sources: THREE_SOURCES });
    const { body } = await request(h.app, "GET", "/api/invoices/1/items");

    assert.equal(body.items.length, 3);
    assert.deepEqual(h.sourceReads, ["billing_sheet:10"]);
  });

  it("answers an invoice with no items with an empty list, not a 404", async () => {
    const h = itemsHarness({ invoices: { 1: { id: 1, companyId: 1, invoiceNumber: "INV-1", items: [] } } });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/items");

    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
  });
});

// ── (b) One derivation rule, shared with the audit view ─────────────────────

describe("the source-derivation rule is shared, not copied", () => {
  it("matches the audit view's preference order for every source type", () => {
    const fallback = ITEM_SNAPSHOT;
    assert.equal(
      deriveSourceWorkDate("work_order", { completedAt: WO_COMPLETED, updatedAt: BS_WORK_DATE }, fallback),
      WO_COMPLETED,
    );
    assert.equal(
      deriveSourceWorkDate("work_order", { completedAt: null, updatedAt: BS_WORK_DATE }, fallback),
      BS_WORK_DATE,
    );
    assert.equal(deriveSourceWorkDate("work_order", { completedAt: null, updatedAt: null }, fallback), fallback);
    assert.equal(deriveSourceWorkDate("billing_sheet", { workDate: BS_WORK_DATE }, fallback), BS_WORK_DATE);
    assert.equal(deriveSourceWorkDate("billing_sheet", { workDate: null }, fallback), fallback);
    assert.equal(deriveSourceWorkDate("wet_check_billing", { workDate: WCB_WORK_DATE }, fallback), WCB_WORK_DATE);
    assert.equal(deriveSourceWorkDate("wet_check_billing", null, fallback), fallback);
  });

  it("returns no ticket number rather than a fabricated one", () => {
    assert.equal(deriveSourceTicketNumber("billing_sheet", null), null);
    assert.equal(deriveSourceTicketNumber("work_order", { id: 20 }), null);
    assert.equal(deriveSourceTicketNumber("billing_sheet", { billingNumber: "BS-010" }), "BS-010");
  });

  it("leaves the audit route with no work-date derivation of its own", () => {
    const src = readFileSync(join(import.meta.dirname, "routes.ts"), "utf8");
    // The three expressions the audit view used to derive its own work date.
    // Any of them reappearing means a second rule has grown beside the shared
    // one. The invoice-generation path has its own, different work-date choice
    // (`wo.completedAt ? … : currentDate`) which is not this rule and is not
    // matched here.
    assert.ok(!/wo\.completedAt\s*\|\|\s*wo\.updatedAt/.test(src));
    assert.ok(!/workDate\s*=\s*bs\.workDate\s*\|\|/.test(src));
    assert.ok(!/workDate\s*=\s*wcb\.workDate\s*\|\|/.test(src));
    assert.ok(src.includes("deriveSourceWorkDate"));
  });

  it("never reads a source for an item that points at nothing", async () => {
    const reads: string[] = [];
    const storage = {
      async getWorkOrder(id: number) { reads.push(`wo:${id}`); return null; },
      async getBillingSheetById(id: number) { reads.push(`bs:${id}`); return null; },
      async getWetCheckBillingById(id: number) { reads.push(`wcb:${id}`); return null; },
    };
    const out = await enrichInvoiceItemsWithSource(
      [{ sourceType: "billing_sheet", billingSheetId: null, sourceId: null, workDate: ITEM_SNAPSHOT }],
      { storage, callerCompanyId: 1 },
    );

    assert.deepEqual(reads, []);
    assert.equal(out[0].sourceNumber, null);
    assert.equal(out[0].workDate, ITEM_SNAPSHOT);
  });
});

// ── (c) Company isolation on every expanded read ────────────────────────────

describe("company isolation on every expanded read", () => {
  it("refuses another company's invoice on the line-item read, before any source is touched", async () => {
    const h = itemsHarness({
      companyId: 2,
      invoices: threeSourceInvoice(), // company 1
      sources: THREE_SOURCES,
    });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/items");

    assert.equal(status, 404);
    assert.equal(body.items, undefined);
    // The point of resolving the invoice first: not one ticket of another
    // company's invoice was read on the way to the refusal.
    assert.deepEqual(h.sourceReads, []);
  });

  it("refuses another company's invoice on the A/R note read, before any note is selected", async () => {
    const h = notesHarness({
      companyId: 2,
      invoices: { 1: { id: 1, companyId: 1, invoiceNumber: "INV-1" } },
      notes: [{ id: 1, invoiceId: 1, companyId: 1, note: "Left a voicemail", authorName: "Dana" }],
    });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/ar-notes");

    assert.equal(status, 404);
    assert.equal(body.notes, undefined);
    assert.deepEqual(h.noteReads, []);
  });

  it("refuses another company's invoice on the reminder-history read", async () => {
    const h = remindersHarness({ companyId: 2 });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/reminders");

    assert.equal(status, 404);
    assert.equal(body.reminders, undefined);
    assert.deepEqual(h.historyReads, []);
  });
});

// ── (d) A role without note access gets no note data, anywhere ──────────────

describe("a role without CAN_READ_AR_NOTES", () => {
  it("is refused the note thread outright", async () => {
    const h = notesHarness({
      role: "irrigation_manager",
      invoices: { 1: { id: 1, companyId: 1, invoiceNumber: "INV-1" } },
      notes: [{ id: 1, invoiceId: 1, companyId: 1, note: "Left a voicemail", authorName: "Dana" }],
    });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/ar-notes");

    assert.equal(status, 403);
    assert.equal(body.notes, undefined);
    assert.deepEqual(h.noteReads, []);
    // The refusal does not admit that a thread exists.
    assert.ok(!/note/i.test(String(body.message)));
  });

  it("still reads line items — that is the whole point of the narrower gate", async () => {
    const h = itemsHarness({
      role: "irrigation_manager",
      invoices: threeSourceInvoice(),
      sources: THREE_SOURCES,
    });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/items");

    assert.equal(status, 200);
    assert.equal(body.items.length, 3);
  });

  it("gets no note field anywhere in the line-item response body", async () => {
    const h = itemsHarness({
      role: "irrigation_manager",
      invoices: threeSourceInvoice(),
      sources: THREE_SOURCES,
    });
    const { body } = await request(h.app, "GET", "/api/invoices/1/items");

    const wire = JSON.stringify(body);
    assert.ok(!/arNote/i.test(wire));
    assert.ok(!/"note"/.test(wire));
  });
});

// ── (e) Reminder history is a read, separate from the send (task #1921) ─────

describe("reminder history read vs reminder send", () => {
  it("serves history to irrigation_manager, who reads invoices but cannot send", async () => {
    const h = remindersHarness({ role: "irrigation_manager" });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/reminders");

    assert.equal(status, 200);
    assert.ok(Array.isArray(body.reminders));
  });

  it("still refuses irrigation_manager the send — the read grants no write", async () => {
    const h = remindersHarness({ role: "irrigation_manager" });
    const { status } = await request(h.app, "POST", "/api/invoices/1/reminders", {
      templateKey: "firm",
    });

    assert.equal(status, 403);
  });

  it("refuses a role outside invoice-read the history entirely", async () => {
    const h = remindersHarness({ role: "field_tech" });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/reminders");

    assert.equal(status, 403);
    assert.equal(body.reminders, undefined);
    assert.deepEqual(h.historyReads, []);
  });

  it("serves the history to a bookkeeper, who holds it", async () => {
    const h = remindersHarness({
      role: "bookkeeper",
      reminders: [
        {
          id: 1,
          invoiceId: 1,
          companyId: 1,
          sentAt: new Date(NOW.getTime() - 3 * DAY),
          sentByUserId: 7,
          sentByName: "Dana Books",
          recipientEmail: "old-ap@acme.test",
          sequenceNumber: 1,
          templateKey: "gentle",
          balanceAtSend: "500.00",
          daysOverdueAtSend: 42,
          deliveryStatus: "sent",
          deliveryError: null,
        },
      ],
    });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/reminders");

    assert.equal(status, 200);
    assert.equal(body.reminders.length, 1);
    // As recorded: the address it actually went to and the balance then, even
    // though the invoice now carries a different email and balance.
    assert.equal(body.reminders[0].recipientEmail, "old-ap@acme.test");
    assert.equal(body.reminders[0].balanceAtSend, "500.00");
  });

  it("answers an invoice with no reminders with an empty list, not a 404", async () => {
    const h = remindersHarness({ role: "bookkeeper", reminders: [] });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/reminders");

    assert.equal(status, 200);
    assert.deepEqual(body.reminders, []);
  });
});

// ── (f) Empty note thread ───────────────────────────────────────────────────

describe("an invoice with no A/R notes", () => {
  it("answers with an empty thread rather than a 404", async () => {
    const h = notesHarness({
      invoices: { 1: { id: 1, companyId: 1, invoiceNumber: "INV-1" } },
      notes: [],
    });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/ar-notes");

    assert.equal(status, 200);
    assert.deepEqual(body.notes, []);
    assert.equal(body.internalOnly, true);
  });
});
