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
  classifyAgingBucket,
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
  }: {
    role?: string;
    companyId?: number | null;
    terms?: Map<number, string | null>;
    rowsByCompany?: Map<number | null, InvoiceRowLike[]>;
  } = {},
): { app: Express; calls: SpyCalls } {
  const calls: SpyCalls = { getInvoices: [], paymentTermsFor: [] };
  const app = express();
  app.use(express.json());
  registerInvoiceListRoutes(app, {
    requireAuthentication: makeAuth(role, companyId),
    requireInvoiceRead,
    applyPricingVisibility: (_req, data) => data,
    _storageApi: {
      async getInvoices(scoped) {
        calls.getInvoices.push(scoped);
        if (rowsByCompany) return rowsByCompany.get(scoped) ?? [];
        return rows;
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
  it("resolves the bookkeeper default through the helper, not a role string", () => {
    assert.equal(usesUiDefault("bookkeeper", COLLECTIONS_LANDING_DEFAULT), true);
    assert.equal(usesUiDefault("billing_manager", COLLECTIONS_LANDING_DEFAULT), false);
    assert.equal(usesUiDefault("company_admin", COLLECTIONS_LANDING_DEFAULT), false);
    assert.equal(usesUiDefault("not_a_role", COLLECTIONS_LANDING_DEFAULT), false);
    assert.equal(usesUiDefault(null, COLLECTIONS_LANDING_DEFAULT), false);
    assert.equal(usesUiDefault(undefined, COLLECTIONS_LANDING_DEFAULT), false);
    // The bookkeeper still reads invoices via the capability registry.
    assert.equal(hasCapability("bookkeeper", CAN_READ_INVOICES), true);
    assert.equal(hasCapability("bookkeeper", CAN_EDIT_INVOICES), false);
  });
});
