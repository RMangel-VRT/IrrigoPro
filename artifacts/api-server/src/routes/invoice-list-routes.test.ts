// Task #1890 — A/R collections view on the invoice list.
//
// Every assertion here runs the REAL handler from invoice-list-routes.ts over a
// storage spy. Nothing in this file re-implements filtering, sorting or
// bucketing — that was the whole point of extracting the handler, so a drift
// between the handler and the expectation shows up as a failure rather than as
// two copies of the same bug agreeing with each other.
//
// Coverage map:
//   (a) no-parameter behaviour unchanged: newest first, 50-row default slice
//   (b) annotation happens before pagination (a page-2 row is still annotated,
//       and a filter can exclude a row that would have been on page 1)
//   (c) each filter individually, and filters composing to an intersection
//   (d) existing ?aging= deep-link values select the same buckets as before
//   (e) the collections default sort: oldest bucket first, biggest balance
//       first within a bucket
//   (f) balance falls back to the invoice total, with the stale-sync flag
//   (g) flags on a fixture invoice, absent on a clean one, draft never
//       "never sent"
//   (h) X-Total-Count is the post-filter total
//   (i) company isolation — the handler only ever sees its own company's rows
//   (j) a compile-time proof that the collections UI default cannot be used as
//       an authorization capability

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  registerInvoiceListRoutes,
  parseArListQuery,
  isUnfilteredArListQuery,
  annotateInvoiceForAr,
  sortAnnotatedInvoices,
  type InvoiceRowLike,
} from "./invoice-list-routes";
import {
  hasCapability,
  usesUiDefault,
  CAN_READ_INVOICES,
  CAN_EDIT_INVOICES,
  COLLECTIONS_LANDING_DEFAULT,
  OVERDUE_AGING_FILTER,
  AGING_BUCKET_KEYS,
  AGING_BUCKET_LABELS,
  classifyAgingBucket,
  computeEffectiveDueDate,
  isInvoiceOverdue,
  type Capability,
} from "@workspace/shared";
import { requireInvoiceRead } from "./role-guards";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** An invoice created `daysAgo` days before NOW with net_30 terms. */
function inv(over: Partial<InvoiceRowLike> & { id: number }): InvoiceRowLike {
  return {
    customerId: 100,
    customerName: `Customer ${over.id}`,
    customerEmail: `c${over.id}@example.com`,
    invoiceNumber: `INV-${String(over.id).padStart(4, "0")}`,
    status: "generated",
    totalAmount: "100.00",
    createdAt: NOW,
    periodStart: NOW,
    dueDate: null,
    sentAt: NOW,
    paidAt: null,
    paymentStatus: "unpaid",
    balance: "100.00",
    paymentSyncedAt: NOW,
    quickbooksInvoiceId: "QB-1",
    qbVoidDetectedAt: null,
    qbNote: null,
    ...over,
  };
}

/** An invoice whose effective due date is exactly `days` days in the past. */
function overdueBy(id: number, days: number, over: Partial<InvoiceRowLike> = {}) {
  return inv({
    id,
    dueDate: new Date(NOW.getTime() - days * DAY),
    ...over,
  });
}

function makeAuth(role: string, companyId: number | null = 1): RequestHandler {
  return (req: any, _res, next) => {
    req.authenticatedUserRole = role;
    req.authenticatedUserId = 7;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
}

interface SpyCalls {
  getInvoices: (number | null)[];
  paymentTermsFor: number[][];
}

function buildApp(
  rows: InvoiceRowLike[],
  {
    role = "billing_manager",
    companyId = 1 as number | null,
    terms = new Map<number, string | null>(),
    rowsByCompany,
    reminders,
  }: {
    role?: string;
    companyId?: number | null;
    terms?: Map<number, string | null>;
    rowsByCompany?: Map<number | null, InvoiceRowLike[]>;
    /** Task #1887 — delivered-reminder rollup, keyed by invoice id. */
    reminders?: Map<number, { reminderCount: number; lastReminderAt: Date }>;
  } = {},
): { app: Express; calls: SpyCalls } {
  const calls: SpyCalls = { getInvoices: [], paymentTermsFor: [] };
  const app = express();
  app.use(express.json());
  registerInvoiceListRoutes(app, {
    requireAuthentication: makeAuth(role, companyId),
    requireInvoiceRead,
    applyPricingVisibility: (_req, data) => data,
    applyArNoteVisibility: (_req, data) => data,
    _storageApi: {
      async getInvoices(scoped) {
        calls.getInvoices.push(scoped);
        if (rowsByCompany) return rowsByCompany.get(scoped) ?? [];
        return rows;
      },
      async getInvoiceReminderSummaries() {
        return reminders ?? new Map();
      },
    },
    _loadPaymentTerms: async (ids) => {
      calls.paymentTermsFor.push([...ids]);
      return terms;
    },
    _now: () => NOW,
  });
  return { app, calls };
}

async function get(app: Express, path: string) {
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = res.status === 204 ? null : await res.json();
    return {
      status: res.status,
      body: body as any,
      total: res.headers.get("x-total-count"),
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const ids = (rows: any[]) => rows.map((r) => r.id);

// ── (a) legacy behaviour ─────────────────────────────────────────────────────

describe("GET /api/invoices — no A/R parameters", () => {
  it("returns newest first, exactly as before", async () => {
    const rows = [
      inv({ id: 1, createdAt: new Date(NOW.getTime() - 3 * DAY) }),
      inv({ id: 2, createdAt: new Date(NOW.getTime() - 1 * DAY) }),
      inv({ id: 3, createdAt: new Date(NOW.getTime() - 2 * DAY) }),
    ];
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices");
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res.body), [2, 3, 1]);
  });

  it("defaults to a 50-row slice with no X-Total-Count", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      inv({ id: i + 1, createdAt: new Date(NOW.getTime() - i * DAY) }),
    );
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices");
    assert.equal(res.body.length, 50);
    assert.equal(res.total, null);
  });

  it("honours ?limit= without an offset, as before", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      inv({ id: i + 1, createdAt: new Date(NOW.getTime() - i * DAY) }),
    );
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices?limit=3");
    assert.deepEqual(ids(res.body), [1, 2, 3]);
  });

  it("still carries isOverdue and effectiveDueDate on every row", async () => {
    const { app } = buildApp([overdueBy(1, 5)]);
    const res = await get(app, "/api/invoices");
    assert.equal(res.body[0].isOverdue, true);
    assert.equal(
      res.body[0].effectiveDueDate,
      new Date(NOW.getTime() - 5 * DAY).toISOString(),
    );
  });

  it("parseArListQuery reports an empty query as unfiltered", () => {
    assert.equal(isUnfilteredArListQuery(parseArListQuery({})), true);
    assert.equal(
      isUnfilteredArListQuery(parseArListQuery({ limit: "50", offset: "0" })),
      true,
    );
    assert.equal(isUnfilteredArListQuery(parseArListQuery({ aging: "days30" })), false);
  });

  it("ignores unrecognised filter values rather than returning nothing", async () => {
    const { app } = buildApp([inv({ id: 1 })]);
    const res = await get(
      app,
      "/api/invoices?aging=bogus&paymentStatus=bogus&sent=bogus&sort=bogus",
    );
    assert.deepEqual(ids(res.body), [1]);
  });
});

// ── (b) annotation before pagination ─────────────────────────────────────────

describe("annotation happens before pagination", () => {
  it("resolves payment terms for the whole set, not the page", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      inv({ id: i + 1, customerId: 100 + i, createdAt: new Date(NOW.getTime() - i * DAY) }),
    );
    const { app, calls } = buildApp(rows);
    await get(app, "/api/invoices?limit=10&offset=0");
    assert.equal(calls.paymentTermsFor.length, 1);
    assert.equal(calls.paymentTermsFor[0].length, 60);
  });

  it("a filter can promote a row that would have been on a later page", async () => {
    // 60 fresh invoices, then one very old overdue one that would sort last.
    const rows = [
      ...Array.from({ length: 60 }, (_, i) =>
        inv({ id: i + 1, createdAt: new Date(NOW.getTime() - i * DAY), dueDate: new Date(NOW.getTime() + 10 * DAY) }),
      ),
      overdueBy(999, 200, { createdAt: new Date(NOW.getTime() - 300 * DAY) }),
    ];
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices?aging=days90Plus&limit=10&offset=0");
    assert.deepEqual(ids(res.body), [999]);
    assert.equal(res.total, "1");
  });
});

// ── (c) filters ──────────────────────────────────────────────────────────────

describe("A/R filters", () => {
  const rows = [
    inv({ id: 1, customerId: 100, totalAmount: "50.00", sentAt: null, status: "generated", paymentStatus: "unpaid", dueDate: new Date(NOW.getTime() - 5 * DAY) }),
    inv({ id: 2, customerId: 200, totalAmount: "500.00", sentAt: NOW, paymentStatus: "partially_paid", balance: "250.00", dueDate: new Date(NOW.getTime() - 40 * DAY) }),
    inv({ id: 3, customerId: 100, totalAmount: "5000.00", sentAt: NOW, paymentStatus: "paid", status: "paid", dueDate: new Date(NOW.getTime() - 90 * DAY) }),
    inv({ id: 4, customerId: 300, totalAmount: "900.00", sentAt: NOW, paymentStatus: "unpaid", dueDate: new Date(NOW.getTime() + 5 * DAY) }),
  ];

  it("filters by customer", async () => {
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices?customerId=100");
    assert.deepEqual(ids(res.body).sort(), [1, 3]);
  });

  it("filters by payment status", async () => {
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices?paymentStatus=partially_paid");
    assert.deepEqual(ids(res.body), [2]);
  });

  it("filters by sent state in both directions", async () => {
    const { app } = buildApp(rows);
    assert.deepEqual(ids((await get(app, "/api/invoices?sent=unsent")).body), [1]);
    assert.deepEqual(ids((await get(app, "/api/invoices?sent=sent")).body).sort(), [2, 3, 4]);
  });

  it("filters by amount range", async () => {
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices?amountMin=100&amountMax=1000");
    assert.deepEqual(ids(res.body).sort(), [2, 4]);
  });

  it("filters by created date range, treating a bare end date as the whole day", async () => {
    const dated = [
      inv({ id: 1, createdAt: new Date("2026-06-15T09:00:00.000Z") }),
      inv({ id: 2, createdAt: new Date("2026-07-01T23:30:00.000Z") }),
      inv({ id: 3, createdAt: new Date("2026-07-02T00:30:00.000Z") }),
    ];
    const { app } = buildApp(dated);
    const res = await get(app, "/api/invoices?dateFrom=2026-06-16&dateTo=2026-07-01");
    assert.deepEqual(ids(res.body), [2]);
  });

  it("flags-only keeps flagged rows and drops a clean one", async () => {
    const clean = inv({ id: 10 });
    const flagged = inv({ id: 11, quickbooksInvoiceId: null });
    const { app } = buildApp([clean, flagged]);
    const res = await get(app, "/api/invoices?flagged=1");
    assert.deepEqual(ids(res.body), [11]);
  });

  it("filters by search over invoice number and customer name", async () => {
    const named = [
      inv({ id: 1, invoiceNumber: "INV-7001", customerName: "Woodglenn HOA" }),
      inv({ id: 2, invoiceNumber: "INV-7002", customerName: "Cedar Ridge" }),
      inv({ id: 3, invoiceNumber: "INV-8003", customerName: "Ridgeview Park" }),
    ];
    const { app } = buildApp(named);
    // invoice number, case-insensitively
    assert.deepEqual(ids((await get(app, "/api/invoices?search=inv-70")).body).sort(), [1, 2]);
    // customer name, matching mid-string
    assert.deepEqual(ids((await get(app, "/api/invoices?search=ridge")).body).sort(), [2, 3]);
    // and a search nobody matches empties the list rather than ignoring itself
    assert.deepEqual(ids((await get(app, "/api/invoices?search=nobody")).body), []);
  });

  it("filters by billing month, on the invoice's own month, not its created date", async () => {
    const monthly = [
      inv({ id: 1, invoiceYear: 2026, invoiceMonth: 6, createdAt: new Date("2026-07-02T00:00:00.000Z") }),
      inv({ id: 2, invoiceYear: 2026, invoiceMonth: 7, createdAt: new Date("2026-07-02T00:00:00.000Z") }),
    ];
    const { app } = buildApp(monthly);
    assert.deepEqual(ids((await get(app, "/api/invoices?month=2026-06")).body), [1]);
    assert.deepEqual(ids((await get(app, "/api/invoices?month=2026-07")).body), [2]);
    // a malformed month is ignored rather than emptying the list
    assert.deepEqual(ids((await get(app, "/api/invoices?month=2026-13")).body).sort(), [1, 2]);
  });

  it("composes filters as an intersection, not a union", async () => {
    const { app } = buildApp(rows);
    // customer 100 AND unsent → only invoice 1 (invoice 3 is customer 100 but sent)
    const res = await get(app, "/api/invoices?customerId=100&sent=unsent");
    assert.deepEqual(ids(res.body), [1]);
    // …and adding a contradictory filter empties the result rather than widening it
    const none = await get(app, "/api/invoices?customerId=100&sent=unsent&paymentStatus=paid");
    assert.deepEqual(ids(none.body), []);
  });
});

// ── (d) aging deep links ─────────────────────────────────────────────────────

describe("?aging= deep links", () => {
  // One invoice per bucket, at the boundary values the rule is defined on.
  const rows = [
    overdueBy(1, -5), // not yet due       → current
    overdueBy(2, 0), //  exactly due today → days30 (frozen day-zero rule)
    overdueBy(3, 29),
    overdueBy(4, 30),
    overdueBy(5, 59),
    overdueBy(6, 60),
  ];

  it("current selects only the not-yet-due invoice", async () => {
    const { app } = buildApp(rows);
    assert.deepEqual(ids((await get(app, "/api/invoices?aging=current")).body), [1]);
  });

  it("days30 covers 0 through 29 days overdue", async () => {
    const { app } = buildApp(rows);
    assert.deepEqual(ids((await get(app, "/api/invoices?aging=days30")).body).sort(), [2, 3]);
  });

  it("days60 covers 30 through 59 days overdue", async () => {
    const { app } = buildApp(rows);
    assert.deepEqual(ids((await get(app, "/api/invoices?aging=days60")).body).sort(), [4, 5]);
  });

  it("days90Plus covers 60 days and beyond", async () => {
    const { app } = buildApp(rows);
    assert.deepEqual(ids((await get(app, "/api/invoices?aging=days90Plus")).body), [6]);
  });

  it("overdue is every bucket except current", async () => {
    const { app } = buildApp(rows);
    assert.deepEqual(
      ids((await get(app, "/api/invoices?aging=overdue")).body).sort(),
      [2, 3, 4, 5, 6],
    );
  });

  it("an aging filter excludes invoices that are not open A/R", async () => {
    const notAr = [
      overdueBy(1, 45, { status: "draft" }),
      overdueBy(2, 45, { status: "cancelled" }),
      overdueBy(3, 45, { status: "superseded" }),
      overdueBy(4, 45, { status: "merged" }),
      overdueBy(5, 45, { status: "paid", paymentStatus: "paid" }),
      overdueBy(6, 45, { paidAt: NOW }),
      overdueBy(7, 45),
    ];
    const { app } = buildApp(notAr);
    assert.deepEqual(ids((await get(app, "/api/invoices?aging=days60")).body), [7]);
  });

  it("the bucket the route reports matches the shared classifier", async () => {
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices");
    for (const row of res.body) {
      assert.equal(row.agingBucket, classifyAgingBucket(row.daysOverdue));
    }
  });
});

// ── (e) collections default sort ─────────────────────────────────────────────

describe("collections sort — oldest bucket first, biggest balance first", () => {
  it("orders by bucket then by balance descending", async () => {
    const rows = [
      overdueBy(1, 5, { totalAmount: "900.00", balance: "900.00" }), // days30, big
      overdueBy(2, 70, { totalAmount: "100.00", balance: "100.00" }), // days90, small
      overdueBy(3, 70, { totalAmount: "800.00", balance: "800.00" }), // days90, big
      overdueBy(4, 35, { totalAmount: "400.00", balance: "400.00" }), // days60
    ];
    const { app } = buildApp(rows);
    const res = await get(app, "/api/invoices?sort=agingBucket&dir=desc");
    assert.deepEqual(ids(res.body), [3, 2, 4, 1]);
  });

  it("sorts across the whole set, not just the first page", async () => {
    // The biggest, oldest balance is the OLDEST row, so a page-then-sort
    // implementation would never surface it.
    const filler = Array.from({ length: 60 }, (_, i) =>
      overdueBy(i + 1, 1, {
        totalAmount: "10.00",
        balance: "10.00",
        createdAt: new Date(NOW.getTime() - i * DAY),
      }),
    );
    const buried = overdueBy(999, 400, {
      totalAmount: "50000.00",
      balance: "50000.00",
      createdAt: new Date(NOW.getTime() - 500 * DAY),
    });
    const { app } = buildApp([...filler, buried]);
    const res = await get(app, "/api/invoices?sort=agingBucket&dir=desc&limit=5&offset=0");
    assert.equal(res.body[0].id, 999);
    assert.equal(res.total, "61");
  });

  it("every A/R column is sortable in both directions", async () => {
    const rows = [
      inv({ id: 1, customerName: "Alpha", invoiceNumber: "INV-0003", totalAmount: "100.00", balance: "100.00", sentAt: null, status: "generated", paymentStatus: "unpaid", dueDate: new Date(NOW.getTime() - 1 * DAY) }),
      inv({ id: 2, customerName: "Beta", invoiceNumber: "INV-0002", totalAmount: "300.00", balance: "300.00", sentAt: NOW, status: "sent", paymentStatus: "partially_paid", dueDate: new Date(NOW.getTime() - 70 * DAY) }),
      inv({ id: 3, customerName: "Gamma", invoiceNumber: "INV-0001", totalAmount: "200.00", balance: "200.00", sentAt: NOW, status: "paid", paymentStatus: "paid", dueDate: new Date(NOW.getTime() + 5 * DAY) }),
    ];
    // Read the value each sort claims to order by straight off the response,
    // then assert monotonicity. This checks the ordering without re-deriving
    // it — comparing "desc is the reverse of asc" would be wrong, because a
    // tie keeps its stable fallback order in both directions.
    const valueOf: Record<string, (r: any) => number | string> = {
      balanceDue: (r) => parseFloat(r.balanceDue),
      effectiveDueDate: (r) => new Date(r.effectiveDueDate).getTime(),
      daysOverdue: (r) => r.daysOverdue,
      agingBucket: (r) => ["current", "days30", "days60", "days90"].indexOf(r.agingBucket),
      paymentStatus: (r) => r.paymentStatus,
      sent: (r) => Number(!!r.sentAt),
      customer: (r) => r.customerName,
      invoiceNumber: (r) => r.invoiceNumber,
      status: (r) => r.status,
      amount: (r) => parseFloat(r.totalAmount),
    };
    const { app } = buildApp(rows);
    for (const [key, read] of Object.entries(valueOf)) {
      for (const dir of ["asc", "desc"] as const) {
        const res = await get(app, `/api/invoices?sort=${key}&dir=${dir}`);
        assert.equal(res.body.length, 3, `${key} ${dir} returned the wrong count`);
        const values = res.body.map(read);
        for (let i = 1; i < values.length; i++) {
          const ordered = dir === "asc" ? values[i - 1] <= values[i] : values[i - 1] >= values[i];
          assert.ok(
            ordered,
            `${key} ${dir} is out of order: ${JSON.stringify(values)}`,
          );
        }
      }
    }
  });
});

// ── (f) balance fallback ─────────────────────────────────────────────────────

describe("balance due", () => {
  it("uses the synced balance when a payment sync has run", async () => {
    const { app } = buildApp([
      inv({ id: 1, totalAmount: "500.00", balance: "125.50", paymentSyncedAt: NOW }),
    ]);
    const res = await get(app, "/api/invoices");
    assert.equal(res.body[0].balanceDue, "125.50");
    assert.equal(res.body[0].balanceIsFallback, false);
    assert.equal(res.body[0].arFlags.includes("stale_sync"), false);
  });

  it("falls back to the invoice total when no sync has run, flagged stale", async () => {
    const { app } = buildApp([
      inv({ id: 1, totalAmount: "500.00", balance: null, paymentSyncedAt: null }),
    ]);
    const res = await get(app, "/api/invoices");
    assert.equal(res.body[0].balanceDue, "500.00");
    assert.equal(res.body[0].balanceIsFallback, true);
    assert.equal(res.body[0].arFlags.includes("stale_sync"), true);
  });

  it("treats a sync older than 24 hours as stale", async () => {
    const { app } = buildApp([
      inv({ id: 1, paymentSyncedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) }),
      inv({ id: 2, paymentSyncedAt: new Date(NOW.getTime() - 23 * 60 * 60 * 1000) }),
    ]);
    const res = await get(app, "/api/invoices");
    const byId = new Map(res.body.map((r: any) => [r.id, r]));
    assert.equal((byId.get(1) as any).arFlags.includes("stale_sync"), true);
    assert.equal((byId.get(2) as any).arFlags.includes("stale_sync"), false);
  });
});

// ── (g) flags ────────────────────────────────────────────────────────────────

describe("A/R flags", () => {
  it("a clean invoice carries no flags at all", async () => {
    const { app } = buildApp([inv({ id: 1, dueDate: new Date(NOW.getTime() + 10 * DAY) })]);
    const res = await get(app, "/api/invoices");
    assert.deepEqual(res.body[0].arFlags, []);
  });

  it("every flag fires on an invoice that earns it", async () => {
    const { app } = buildApp([
      inv({
        id: 1,
        status: "generated",
        sentAt: null,
        dueDate: new Date(NOW.getTime() - 10 * DAY),
        qbVoidDetectedAt: NOW,
        quickbooksInvoiceId: null,
        paymentSyncedAt: null,
        customerEmail: "",
        qbNote: "Manually delete QB invoice INV-123",
      }),
    ]);
    const res = await get(app, "/api/invoices");
    assert.deepEqual(res.body[0].arFlags.sort(), [
      "needs_qb_cleanup",
      "never_sent",
      "no_billing_email",
      "not_in_qb",
      "overdue",
      "qb_voided",
      "stale_sync",
    ]);
  });

  it("a draft is never flagged never-sent", async () => {
    const { app } = buildApp([inv({ id: 1, status: "draft", sentAt: null })]);
    const res = await get(app, "/api/invoices");
    assert.equal(res.body[0].arFlags.includes("never_sent"), false);
  });

  it("a finalised invoice with no sent timestamp is flagged never-sent", async () => {
    const { app } = buildApp([inv({ id: 1, status: "generated", sentAt: null })]);
    const res = await get(app, "/api/invoices");
    assert.equal(res.body[0].arFlags.includes("never_sent"), true);
  });
});

// ── (h) pagination totals ────────────────────────────────────────────────────

describe("pagination", () => {
  it("reports the post-filter total so paging stays honest", async () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => overdueBy(i + 1, 70)),
      ...Array.from({ length: 40 }, (_, i) => inv({ id: 500 + i, dueDate: new Date(NOW.getTime() + 5 * DAY) })),
    ];
    const { app } = buildApp(rows);
    const unfiltered = await get(app, "/api/invoices?limit=10&offset=0");
    assert.equal(unfiltered.total, "80");
    const filtered = await get(app, "/api/invoices?aging=days90Plus&limit=10&offset=0");
    assert.equal(filtered.total, "40");
    assert.equal(filtered.body.length, 10);
  });

  it("pages through a sorted, filtered set without repeating a row", async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      overdueBy(i + 1, 70, { totalAmount: `${(i + 1) * 10}.00`, balance: `${(i + 1) * 10}.00` }),
    );
    const { app } = buildApp(rows);
    const p1 = await get(app, "/api/invoices?aging=overdue&sort=balanceDue&dir=desc&limit=10&offset=0");
    const p2 = await get(app, "/api/invoices?aging=overdue&sort=balanceDue&dir=desc&limit=10&offset=10");
    const seen = new Set([...ids(p1.body), ...ids(p2.body)]);
    assert.equal(seen.size, 20);
    assert.equal(p1.body[0].balanceDue, "250.00");
    assert.equal(p2.body[0].balanceDue, "150.00");
  });
});

// ── (i) company isolation ────────────────────────────────────────────────────

describe("company isolation", () => {
  it("scopes the storage read to the caller's company", async () => {
    const byCompany = new Map<number | null, InvoiceRowLike[]>([
      [1, [inv({ id: 1 })]],
      [2, [inv({ id: 2 })]],
    ]);
    const { app, calls } = buildApp([], { companyId: 2, rowsByCompany: byCompany });
    const res = await get(app, "/api/invoices?aging=overdue&flagged=1&sort=agingBucket");
    assert.deepEqual(calls.getInvoices, [2]);
    for (const row of res.body) assert.equal(row.id, 2);
  });

  it("passes null (global) only for super_admin", async () => {
    const byCompany = new Map<number | null, InvoiceRowLike[]>([[null, [inv({ id: 9 })]]]);
    const { app, calls } = buildApp([], {
      role: "super_admin",
      companyId: null,
      rowsByCompany: byCompany,
    });
    await get(app, "/api/invoices");
    assert.deepEqual(calls.getInvoices, [null]);
  });

  it("refuses a non-super-admin with no company association", async () => {
    const { app, calls } = buildApp([inv({ id: 1 })], { companyId: null });
    const res = await get(app, "/api/invoices");
    assert.equal(res.status, 403);
    assert.deepEqual(calls.getInvoices, []);
  });

  it("still refuses a field_tech at the guard", async () => {
    const { app, calls } = buildApp([inv({ id: 1 })], { role: "field_tech" });
    const res = await get(app, "/api/invoices");
    assert.equal(res.status, 403);
    assert.deepEqual(calls.getInvoices, []);
  });
});

// ── pure-helper checks ───────────────────────────────────────────────────────

describe("sortAnnotatedInvoices", () => {
  it("defaults to newest first when no sort key is given", () => {
    const rows = [1, 2, 3].map((id) =>
      annotateInvoiceForAr(inv({ id, createdAt: new Date(NOW.getTime() - id * DAY) }), null, NOW),
    );
    assert.deepEqual(ids(sortAnnotatedInvoices(rows, null, "desc")), [1, 2, 3]);
  });

  it("breaks ties deterministically", () => {
    const rows = [3, 1, 2].map((id) => annotateInvoiceForAr(inv({ id }), null, NOW));
    assert.deepEqual(
      ids(sortAnnotatedInvoices(rows, "status", "asc")),
      ids(sortAnnotatedInvoices([...rows].reverse(), "status", "asc")),
    );
  });
});

// ── (j) the collections UI default is not a capability ───────────────────────
//
// A runtime test cannot catch this class of mistake: if the UI default were
// another ReadonlySet<Role>, handing it to hasCapability would compile, run,
// and quietly authorise whoever is in it. So the assertion is a compile-time
// one. `@ts-expect-error` fails the typecheck when the error DISAPPEARS, which
// is exactly the regression we are guarding against — the day someone
// "simplifies" UiDefaultRoles back into a Set, this file stops compiling.

// Never called. Every line below is a deliberate type error, and
// `@ts-expect-error` turns each one into a failing typecheck the moment it
// starts compiling — which is precisely when the safety has been lost.
// These must NOT run: at runtime they would throw, and a throw is a much
// weaker signal than "this mistake cannot be written down".
export function __collectionsDefaultIsNotACapability(): void {
  // @ts-expect-error — a UI landing default is not a Capability.
  hasCapability("bookkeeper", COLLECTIONS_LANDING_DEFAULT);
  // @ts-expect-error — UiDefaultRoles is not a ReadonlySet<Role>.
  const asCapability: Capability = COLLECTIONS_LANDING_DEFAULT;
  void asCapability;
  // @ts-expect-error — the invoice-read allowlist is a Capability, not a UI default.
  usesUiDefault("bookkeeper", CAN_READ_INVOICES);
  // @ts-expect-error — CAN_EDIT_INVOICES is a Capability, not a UiDefaultRoles.
  usesUiDefault("billing_manager", CAN_EDIT_INVOICES);
}

describe("collections landing default is not usable as an authorization guard", () => {
  it("returns true for every invoice-reading role and false for everything else", () => {
    // All roles in CAN_READ_INVOICES get the AR-first landing.
    assert.equal(usesUiDefault("bookkeeper", COLLECTIONS_LANDING_DEFAULT), true);
    assert.equal(usesUiDefault("billing_manager", COLLECTIONS_LANDING_DEFAULT), true);
    assert.equal(usesUiDefault("company_admin", COLLECTIONS_LANDING_DEFAULT), true);
    assert.equal(usesUiDefault("irrigation_manager", COLLECTIONS_LANDING_DEFAULT), true);
    assert.equal(usesUiDefault("super_admin", COLLECTIONS_LANDING_DEFAULT), true);
    // Non-invoice roles and bad inputs always return false.
    assert.equal(usesUiDefault("field_tech", COLLECTIONS_LANDING_DEFAULT), false);
    assert.equal(usesUiDefault("not_a_role", COLLECTIONS_LANDING_DEFAULT), false);
    assert.equal(usesUiDefault(null, COLLECTIONS_LANDING_DEFAULT), false);
    assert.equal(usesUiDefault(undefined, COLLECTIONS_LANDING_DEFAULT), false);
    // The bookkeeper still reads invoices via the capability registry.
    assert.equal(hasCapability("bookkeeper", CAN_READ_INVOICES), true);
    assert.equal(hasCapability("bookkeeper", CAN_EDIT_INVOICES), false);
  });
});

// ── Task #1887 — reminder data on the A/R list ───────────────────────────────
//
// The reminder column, count and filter already rendered on this list and did
// nothing. These tests are the proof that they now carry real data, and that
// the filter runs over the whole invoice set on the server rather than over
// whichever page happens to be loaded.

function reminded(
  count: number,
  daysAgo: number,
): { reminderCount: number; lastReminderAt: Date } {
  return { reminderCount: count, lastReminderAt: new Date(NOW.getTime() - daysAgo * DAY) };
}

describe("GET /api/invoices — reminder columns", () => {
  it("serves last-reminder and reminder-count on each row", async () => {
    const { app } = buildApp([overdueBy(1, 45), overdueBy(2, 45)], {
      reminders: new Map([[1, reminded(2, 3)]]),
    });
    const { body } = await get(app, "/api/invoices");
    const byId = new Map(body.map((r: any) => [r.id, r]));
    assert.equal((byId.get(1) as any).reminderCount, 2);
    assert.equal(
      (byId.get(1) as any).lastReminderAt,
      new Date(NOW.getTime() - 3 * DAY).toISOString(),
    );
    // A never-reminded invoice says so explicitly rather than omitting it.
    assert.equal((byId.get(2) as any).reminderCount, 0);
    assert.equal((byId.get(2) as any).lastReminderAt, null);
  });

  it("raises 'Reminded, still unpaid' only when reminders exist AND it is still overdue", async () => {
    const rows = [
      overdueBy(1, 45), // reminded + overdue → flagged
      overdueBy(2, 45), // overdue, never reminded → not flagged
      inv({ id: 3, dueDate: new Date(NOW.getTime() + 10 * DAY) }), // reminded, not overdue
    ];
    const { app } = buildApp(rows, {
      reminders: new Map([
        [1, reminded(1, 2)],
        [3, reminded(1, 2)],
      ]),
    });
    const { body } = await get(app, "/api/invoices");
    const byId = new Map(body.map((r: any) => [r.id, r]));
    assert.equal((byId.get(1) as any).arFlags.includes("reminded_still_unpaid"), true);
    assert.equal((byId.get(2) as any).arFlags.includes("reminded_still_unpaid"), false);
    assert.equal(
      (byId.get(3) as any).arFlags.includes("reminded_still_unpaid"),
      false,
      "a reminded invoice that is no longer overdue leaves the escalation queue",
    );
  });

  it("drops the flag once the invoice is paid", async () => {
    const rows = [overdueBy(1, 45, { paymentStatus: "paid", paidAt: NOW, status: "paid" })];
    const { app } = buildApp(rows, { reminders: new Map([[1, reminded(3, 1)]]) });
    const { body } = await get(app, "/api/invoices");
    assert.equal(body[0].arFlags.includes("reminded_still_unpaid"), false);
  });
});

describe("GET /api/invoices — ?reminders= filter", () => {
  const rows = [
    overdueBy(1, 45), // never reminded
    overdueBy(2, 45), // reminded once, 3 days ago
    overdueBy(3, 45), // reminded 4 times, 40 days ago
    overdueBy(4, 45), // reminded twice, 20 days ago
  ];
  const summaries = new Map([
    [2, reminded(1, 3)],
    [3, reminded(4, 40)],
    [4, reminded(2, 20)],
  ]);

  it("never reminded", async () => {
    const { app } = buildApp(rows, { reminders: summaries });
    const { body, total } = await get(app, "/api/invoices?reminders=never&offset=0");
    assert.deepEqual(ids(body), [1]);
    assert.equal(total, "1", "X-Total-Count is the post-filter total");
  });

  it("reminded in the last 7 days", async () => {
    const { app } = buildApp(rows, { reminders: summaries });
    const { body } = await get(app, "/api/invoices?reminders=last7");
    assert.deepEqual(ids(body), [2]);
  });

  it("reminded in the last 30 days", async () => {
    const { app } = buildApp(rows, { reminders: summaries });
    const { body } = await get(app, "/api/invoices?reminders=last30");
    assert.deepEqual(ids(body).sort(), [2, 4]);
  });

  it("reminded three or more times", async () => {
    const { app } = buildApp(rows, { reminders: summaries });
    const { body } = await get(app, "/api/invoices?reminders=thrice");
    assert.deepEqual(ids(body), [3]);
  });

  it("filters over the whole set, not the loaded page", async () => {
    // 60 invoices, only the last one ever reminded — it would never appear in
    // the default 50-row page if the filter ran client-side.
    const many = Array.from({ length: 60 }, (_, i) =>
      overdueBy(i + 1, 45, { createdAt: new Date(NOW.getTime() - (60 - i) * DAY) }),
    );
    const { app } = buildApp(many, { reminders: new Map([[1, reminded(1, 2)]]) });
    const { body, total } = await get(app, "/api/invoices?reminders=last7&offset=0");
    assert.deepEqual(ids(body), [1]);
    assert.equal(total, "1");
  });

  it("composes with the other filters as an intersection", async () => {
    const mixed = [
      overdueBy(1, 45),
      overdueBy(2, 5),
      inv({ id: 3, dueDate: new Date(NOW.getTime() + 10 * DAY) }),
    ];
    const { app } = buildApp(mixed, {
      reminders: new Map([
        [1, reminded(1, 2)],
        [2, reminded(1, 2)],
        [3, reminded(1, 2)],
      ]),
    });
    const { body } = await get(app, "/api/invoices?reminders=last7&aging=days60");
    assert.deepEqual(ids(body), [1]);
  });

  it("an unknown value falls back to no reminder filtering", async () => {
    const { app } = buildApp(rows, { reminders: summaries });
    const { body } = await get(app, "/api/invoices?reminders=whenever");
    assert.equal(body.length, 4);
    assert.equal(parseArListQuery({ reminders: "whenever" }).reminders, "all");
    assert.equal(isUnfilteredArListQuery(parseArListQuery({ reminders: "whenever" })), true);
  });

  it("counts as a filter for the legacy-shape check", () => {
    assert.equal(isUnfilteredArListQuery(parseArListQuery({ reminders: "never" })), false);
  });
});

// ── (k) Task #1914 — the number behind the sidebar's overdue badge ───────────
//
// The desktop sidebar shows a bookkeeper how many invoices are overdue by
// calling this endpoint with the overdue aging filter and reading
// X-Total-Count. That badge writes no definition of its own, so what has to
// hold is that this endpoint's ?aging=overdue population is the shared aging
// module's overdue population — computed here straight from the fixtures with
// `computeEffectiveDueDate` + `isInvoiceOverdue`, never hardcoded.

describe("GET /api/invoices — the count the overdue nav badge reads", () => {
  const BADGE_QUERY = `/api/invoices?aging=${OVERDUE_AGING_FILTER}&limit=1&offset=0`;

  /** Overdue per lib/shared/src/invoice-aging.ts, over the fixture rows. */
  function sharedOverdueCount(rows: InvoiceRowLike[]): number {
    return rows.filter((r) =>
      isInvoiceOverdue(
        r.paymentStatus,
        computeEffectiveDueDate(r.dueDate, r.createdAt, null),
        NOW,
      ),
    ).length;
  }

  const openArRows: InvoiceRowLike[] = [
    overdueBy(1, 75),
    overdueBy(2, 40),
    overdueBy(3, 2),
    overdueBy(4, 90, { paymentStatus: "paid", paidAt: NOW, status: "paid" }),
    inv({ id: 5, dueDate: new Date(NOW.getTime() + 3 * DAY) }),
    inv({ id: 6, dueDate: new Date(NOW.getTime() + 20 * DAY) }),
  ];

  it("reports the shared module's overdue count in X-Total-Count", async () => {
    const expected = sharedOverdueCount(openArRows);
    assert.equal(expected, 3, "fixtures exercise the rule");
    assert.ok(expected < openArRows.length, "…and the filter actually filters");
    const { app } = buildApp(openArRows);
    const res = await get(app, BADGE_QUERY);
    assert.equal(res.status, 200);
    assert.equal(res.total, String(expected));
  });

  it("reports the whole total even though only one row is asked for", async () => {
    // The badge requests a minimal page on purpose: counting returned rows
    // would silently cap the badge at the page size.
    const many = Array.from({ length: 120 }, (_, i) => overdueBy(i + 1, 5 + i));
    const { app } = buildApp(many);
    const res = await get(app, BADGE_QUERY);
    assert.equal(res.body.length, 1);
    assert.equal(res.total, String(sharedOverdueCount(many)));
    assert.equal(res.total, "120");
  });

  it("reports zero when nothing is overdue, so the badge renders nothing", async () => {
    const rows = [
      inv({ id: 1, dueDate: new Date(NOW.getTime() + 5 * DAY) }),
      inv({ id: 2, dueDate: new Date(NOW.getTime() + 30 * DAY) }),
    ];
    assert.equal(sharedOverdueCount(rows), 0);
    const { app } = buildApp(rows);
    const res = await get(app, BADGE_QUERY);
    assert.equal(res.total, "0");
    assert.deepEqual(res.body, []);
  });

  it("excludes rows that are not open A/R, which the shared rule alone would count", async () => {
    // Documented intersection, not a drift: ?aging= is an A/R filter, so it
    // also requires `isOpenAr`. A past-due DRAFT is overdue by the shared
    // date rule but is not money anyone is owed yet, and the bookkeeper's
    // badge must not chase her towards it.
    const rows = [overdueBy(1, 30), overdueBy(2, 30, { status: "draft" })];
    assert.equal(sharedOverdueCount(rows), 2, "the date rule counts both");
    const { app } = buildApp(rows);
    const res = await get(app, BADGE_QUERY);
    assert.equal(res.total, "1");
    assert.deepEqual(ids(res.body), [1]);
  });

  it("is company-scoped, like every other read here", async () => {
    const rowsByCompany = new Map<number | null, InvoiceRowLike[]>([
      [1, [overdueBy(1, 30)]],
      [2, [overdueBy(2, 30), overdueBy(3, 30)]],
    ]);
    const { app } = buildApp([], { companyId: 2, rowsByCompany });
    const res = await get(app, BADGE_QUERY);
    assert.equal(res.total, "2");
  });

  it("a role without invoice-read capability cannot reach the count at all", async () => {
    // The client gates the query on the same capability; this is the server
    // half of that pair.
    assert.equal(hasCapability("field_tech", CAN_READ_INVOICES), false);
    const { app } = buildApp(openArRows, { role: "field_tech" });
    const res = await get(app, BADGE_QUERY);
    assert.equal(res.status, 403);
    assert.equal(res.total, null);
  });
});

// ── Task #1942 — GET /api/invoices/aging-summary ─────────────────────────────
//
// The aging strip and the page header both read this. Two properties matter
// more than any other and are asserted first: the totals cover the WHOLE
// filtered set rather than a page, and they agree with what the table would
// show for the same filters — which is why the endpoint forces `aging: all`
// and applies `isOpenAr`, exactly as the list's own aging matcher does.

const SUMMARY = "/api/invoices/aging-summary";

/** Bucket key → the card's totals, for readable assertions. */
function bucketMap(body: any): Record<string, { balanceDue: string; count: number }> {
  const out: Record<string, { balanceDue: string; count: number }> = {};
  for (const b of body.buckets) out[b.key] = { balanceDue: b.balanceDue, count: b.count };
  return out;
}

describe("aging summary — shape", () => {
  it("reports the company's last payment sync, unmoved by the filters on the table", async () => {
    // The pill above the table describes the QuickBooks connection. If this
    // came from the filtered set, a search or a month filter that excluded
    // the most recently synced invoice would report a healthy connection as
    // stale — so it is computed over every invoice in the company.
    const recent = new Date(NOW.getTime() - 60_000);
    const older = new Date(NOW.getTime() - 5 * DAY);
    const rows = [
      overdueBy(1, 40, { invoiceNumber: "INV-CEDAR", paymentSyncedAt: older }),
      overdueBy(2, 40, { invoiceNumber: "INV-WOODGLENN", paymentSyncedAt: recent }),
    ];
    const { app } = buildApp(rows);

    const all = await get(app, SUMMARY);
    assert.equal(new Date(all.body.lastPaymentSyncAt).getTime(), recent.getTime());

    // Filter the recently-synced invoice out of the aggregate entirely.
    const filtered = await get(app, `${SUMMARY}?search=cedar`);
    assert.equal(filtered.body.overall.count, 1, "the filter really did narrow the aggregate");
    assert.equal(
      new Date(filtered.body.lastPaymentSyncAt).getTime(),
      recent.getTime(),
      "sync freshness is a company fact, not a property of the filtered rows",
    );
  });

  it("reports no sync at all when the company has never synced", async () => {
    const { app } = buildApp([overdueBy(1, 10, { paymentSyncedAt: null })]);
    const res = await get(app, SUMMARY);
    assert.equal(res.body.lastPaymentSyncAt, null);
  });

  it("returns the four shared buckets, in order, with the shared labels", async () => {
    const { app } = buildApp([]);
    const res = await get(app, SUMMARY);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.buckets.map((b: any) => b.key),
      [...AGING_BUCKET_KEYS],
    );
    for (const b of res.body.buckets) {
      assert.equal(
        b.label,
        AGING_BUCKET_LABELS[b.key as keyof typeof AGING_BUCKET_LABELS],
        "labels come from the shared aging module, never from this endpoint",
      );
    }
  });

  it("names the ?aging= value each card selects, including days90 → days90Plus", async () => {
    const { app } = buildApp([]);
    const res = await get(app, SUMMARY);
    assert.deepEqual(
      Object.fromEntries(res.body.buckets.map((b: any) => [b.key, b.filterValue])),
      { current: "current", days30: "days30", days60: "days60", days90: "days90Plus" },
    );
  });

  it("sums balanceDue and counts per bucket, and totals across all four", async () => {
    const rows = [
      overdueBy(1, 90, { totalAmount: "500.00", balance: "500.00" }),
      overdueBy(2, 45, { totalAmount: "300.00", balance: "300.00" }),
      overdueBy(3, 10, { totalAmount: "200.00", balance: "200.00" }),
      overdueBy(4, 10, { totalAmount: "100.00", balance: "100.00" }),
      inv({ id: 5, dueDate: new Date(NOW.getTime() + 10 * DAY), totalAmount: "50.00", balance: "50.00" }),
    ];
    const { app } = buildApp(rows);
    const res = await get(app, SUMMARY);
    const buckets = bucketMap(res.body);
    assert.deepEqual(buckets.current, { balanceDue: "50.00", count: 1 });
    assert.deepEqual(buckets.days30, { balanceDue: "300.00", count: 2 });
    assert.deepEqual(buckets.days60, { balanceDue: "300.00", count: 1 });
    assert.deepEqual(buckets.days90, { balanceDue: "500.00", count: 1 });
    assert.deepEqual(res.body.overall, { balanceDue: "1150.00", count: 5 });
  });

  it("counts only open A/R, so the strip and the table cannot disagree", async () => {
    const rows = [
      overdueBy(1, 40, { totalAmount: "100.00", balance: "100.00" }),
      overdueBy(2, 40, { status: "draft" }),
      overdueBy(3, 40, { status: "paid", paymentStatus: "paid" }),
      overdueBy(4, 40, { paidAt: NOW }),
      overdueBy(5, 40, { status: "cancelled" }),
    ];
    const { app } = buildApp(rows);
    const res = await get(app, SUMMARY);
    assert.deepEqual(res.body.overall, { balanceDue: "100.00", count: 1 });
  });
});

describe("aging summary — the whole filtered set, not a page", () => {
  it("totals every matching invoice even when the list would paginate", async () => {
    // 60 > the list's 50-row page. A header that summed the loaded rows would
    // report 50 here; the aggregate reports all 60. This is the assertion the
    // header's dollar total exists to satisfy.
    const rows = Array.from({ length: 60 }, (_, i) =>
      overdueBy(i + 1, 40, { totalAmount: "10.00", balance: "10.00" }),
    );
    const { app } = buildApp(rows);
    const list = await get(app, "/api/invoices?offset=0");
    assert.equal(list.body.length, 50, "the list itself still pages at 50");
    assert.equal(list.total, "60");

    const res = await get(app, SUMMARY);
    assert.deepEqual(res.body.overall, { balanceDue: "600.00", count: 60 });
  });
});

describe("aging summary — filters", () => {
  const mixed = () => [
    overdueBy(1, 40, { customerId: 100, totalAmount: "100.00", balance: "100.00" }),
    overdueBy(2, 40, { customerId: 200, totalAmount: "700.00", balance: "700.00" }),
    overdueBy(3, 5, { customerId: 100, totalAmount: "20.00", balance: "20.00" }),
  ];

  it("ignores ?aging= so every card keeps its own total", async () => {
    const { app } = buildApp(mixed());
    const unfiltered = await get(app, SUMMARY);
    for (const aging of ["current", "days30", "days60", "days90Plus", OVERDUE_AGING_FILTER]) {
      const res = await get(app, `${SUMMARY}?aging=${aging}`);
      assert.deepEqual(
        res.body,
        unfiltered.body,
        `?aging=${aging} must not narrow the strip's own totals`,
      );
    }
  });

  it("respects every other filter, so the strip tracks the table", async () => {
    const { app } = buildApp(mixed());
    const res = await get(app, `${SUMMARY}?customerId=100`);
    assert.deepEqual(res.body.overall, { balanceDue: "120.00", count: 2 });
    const buckets = bucketMap(res.body);
    assert.deepEqual(buckets.days30, { balanceDue: "20.00", count: 1 });
    assert.deepEqual(buckets.days60, { balanceDue: "100.00", count: 1 });
  });

  it("respects search and billing month, so the strip cannot outgrow the table", async () => {
    const rows = [
      overdueBy(1, 40, { invoiceNumber: "INV-9001", customerName: "Woodglenn HOA", invoiceYear: 2026, invoiceMonth: 6, totalAmount: "100.00", balance: "100.00" }),
      overdueBy(2, 40, { invoiceNumber: "INV-9002", customerName: "Cedar Ridge", invoiceYear: 2026, invoiceMonth: 6, totalAmount: "700.00", balance: "700.00" }),
      overdueBy(3, 40, { invoiceNumber: "INV-9003", customerName: "Woodglenn HOA", invoiceYear: 2026, invoiceMonth: 7, totalAmount: "40.00", balance: "40.00" }),
    ];
    const { app } = buildApp(rows);
    const searched = await get(app, `${SUMMARY}?search=woodglenn`);
    assert.deepEqual(searched.body.overall, { balanceDue: "140.00", count: 2 });
    const monthed = await get(app, `${SUMMARY}?month=2026-06`);
    assert.deepEqual(monthed.body.overall, { balanceDue: "800.00", count: 2 });
    const both = await get(app, `${SUMMARY}?search=woodglenn&month=2026-06`);
    assert.deepEqual(both.body.overall, { balanceDue: "100.00", count: 1 });
  });

  it("respects the amount filter too", async () => {
    const { app } = buildApp(mixed());
    const res = await get(app, `${SUMMARY}?amountMin=50`);
    assert.deepEqual(res.body.overall, { balanceDue: "800.00", count: 2 });
  });
});

describe("aging summary — scoping", () => {
  it("only ever sums the caller's own company", async () => {
    const rowsByCompany = new Map<number | null, InvoiceRowLike[]>([
      [1, [overdueBy(1, 40, { totalAmount: "100.00", balance: "100.00" })]],
      [
        2,
        [
          overdueBy(2, 40, { totalAmount: "900.00", balance: "900.00" }),
          overdueBy(3, 40, { totalAmount: "900.00", balance: "900.00" }),
        ],
      ],
    ]);
    const { app, calls } = buildApp([], { companyId: 2, rowsByCompany });
    const res = await get(app, SUMMARY);
    assert.deepEqual(res.body.overall, { balanceDue: "1800.00", count: 2 });
    assert.deepEqual(calls.getInvoices, [2], "the fetch itself is scoped, not the sum");
  });

  // Task #1942 — the aggregate and the list answer to ONE scoping contract.
  // The first cut refused an unscoped super_admin here while the list happily
  // returned every company's rows, so the page showed a per-company total (or
  // an error strip) over a cross-company table. Whatever the population is, it
  // is the same population in both.
  it("gives an unscoped super_admin the same global set the list gives", async () => {
    const rowsByCompany = new Map<number | null, InvoiceRowLike[]>([
      [null, [overdueBy(1, 40, { totalAmount: "100.00", balance: "100.00" })]],
      [2, [overdueBy(2, 40, { totalAmount: "900.00", balance: "900.00" })]],
    ]);
    const { app, calls } = buildApp([], { role: "super_admin", companyId: null, rowsByCompany });
    const res = await get(app, SUMMARY);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.overall, { balanceDue: "100.00", count: 1 });
    assert.deepEqual(calls.getInvoices, [null], "global, exactly as GET /api/invoices reads");
  });

  it("rejects a malformed companyId rather than silently going global", async () => {
    const { app, calls } = buildApp([overdueBy(1, 40)], { role: "super_admin", companyId: null });
    const res = await get(app, `${SUMMARY}?companyId=abc`);
    assert.equal(res.status, 400);
    assert.deepEqual(calls.getInvoices, [], "nothing is read on a bad scope");
  });

  it("list and aggregate read the same company for the same request", async () => {
    const rowsByCompany = new Map<number | null, InvoiceRowLike[]>([
      [null, [overdueBy(1, 40, { totalAmount: "100.00", balance: "100.00" })]],
      [2, [overdueBy(2, 40, { totalAmount: "900.00", balance: "900.00" })]],
    ]);
    for (const suffix of ["", "?companyId=2"]) {
      const { app, calls } = buildApp([], { role: "super_admin", companyId: null, rowsByCompany });
      await get(app, `/api/invoices${suffix}`);
      await get(app, `${SUMMARY}${suffix ? suffix : ""}`);
      assert.equal(calls.getInvoices.length, 2, `two reads for ${suffix || "(unscoped)"}`);
      assert.equal(
        calls.getInvoices[0],
        calls.getInvoices[1],
        `list and aggregate disagree on scope for ${suffix || "(unscoped)"}`,
      );
    }
  });

  it("ignores a companyId a scoped caller sends for someone else's company", async () => {
    const rowsByCompany = new Map<number | null, InvoiceRowLike[]>([
      [1, [overdueBy(1, 40, { totalAmount: "100.00", balance: "100.00" })]],
      [2, [overdueBy(2, 40, { totalAmount: "900.00", balance: "900.00" })]],
    ]);
    const { app, calls } = buildApp([], { role: "bookkeeper", companyId: 2, rowsByCompany });
    const res = await get(app, `${SUMMARY}?companyId=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.overall, { balanceDue: "900.00", count: 1 });
    assert.deepEqual(calls.getInvoices, [2], "her own company, never the one she asked for");
  });

  it("scopes a super_admin request to the company it names", async () => {
    const rowsByCompany = new Map<number | null, InvoiceRowLike[]>([
      [1, [overdueBy(1, 40, { totalAmount: "100.00", balance: "100.00" })]],
      [2, [overdueBy(2, 40, { totalAmount: "900.00", balance: "900.00" })]],
    ]);
    const { app, calls } = buildApp([], { role: "super_admin", companyId: null, rowsByCompany });
    const res = await get(app, `${SUMMARY}?companyId=2`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.overall, { balanceDue: "900.00", count: 1 });
    assert.deepEqual(calls.getInvoices, [2]);
  });

  it("a role without invoice-read cannot reach the aggregate", async () => {
    assert.equal(hasCapability("field_tech", CAN_READ_INVOICES), false);
    const { app, calls } = buildApp([overdueBy(1, 40)], { role: "field_tech" });
    const res = await get(app, SUMMARY);
    assert.equal(res.status, 403);
    assert.deepEqual(calls.getInvoices, []);
  });
});
