// Task #1886 — bookkeeper role matrix.
//
// Asserted on real server responses, not rendered UI, following the pattern in
// billing-workspace-role-access.test.ts. Every guard under test is the REAL
// middleware imported from role-guards.ts — nothing here re-implements
// authorization logic, so a membership change shows up as a test failure
// rather than drifting silently.
//
// Coverage map (mirrors the ticket's acceptance list):
//   (a) registry: hasCapability is false for unknown / null / undefined
//   (b) invoice read/write/send guards across the full role set
//   (c) irrigation_manager 200 on invoice list; field_tech 403 (the hole closed)
//   (d) QuickBooks allowlist: bookkeeper in; irrigation_manager, field_tech,
//       an unrecognised role string, and a missing role all out
//   (e) real route modules: mark-sent, mark-unsent, merge, budget, financial
//       pulse, estimate approval
//   (f) company_admin / billing_manager parity across the guard split
//   (g) multi-tenant: bookkeeper in company A gets nothing for a company B id
//   (h) wiring proof: the routes in the monolith carry the right guard

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ROLES,
  hasCapability,
  CAN_READ_INVOICES,
  CAN_EDIT_INVOICES,
  CAN_SEND_INVOICE_EMAIL,
  CAN_MANAGE_QUICKBOOKS,
  CAN_VIEW_BUDGETS,
  CAN_VIEW_COSTS,
  CAN_APPROVE_ESTIMATES,
  CAN_APPROVE_PARTS,
} from "@workspace/shared";
import {
  requireInvoiceRead,
  requireInvoiceWrite,
  requireInvoiceSend,
  requireQuickBooksAccess,
} from "./role-guards";
import { registerInvoiceMarkSentRoutes } from "./invoice-mark-sent-routes";
import { registerInvoiceMergeRoutes } from "./invoice-merge-routes";
import { registerInvoiceReminderRoutes } from "./invoice-reminder-routes";
import { registerBudgetRoutes } from "./budget-routes";
import { registerFinancialPulseRoutes } from "./financial-pulse";
import { requireEstimateApprovalAccess } from "./estimate-role-guards";
import { storage } from "../storage";

// ── helpers ──────────────────────────────────────────────────────────────────

/** NO_ROLE models the undefined-role case the old denylist let through. */
const NO_ROLE = Symbol("no-role");
type TestRole = string | typeof NO_ROLE;

function makeAuth(role: TestRole, companyId: number | null = 1): RequestHandler {
  return (req: any, _res, next) => {
    if (role !== NO_ROLE) req.authenticatedUserRole = role;
    req.authenticatedUserId = 1;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
}

/** Mounts a guard in front of a trivial 200 handler and returns the status. */
async function guardStatus(
  guard: RequestHandler,
  role: TestRole,
  { method = "get", companyId = 1 as number | null } = {},
): Promise<number> {
  const app = express();
  app.use(express.json());
  (app as any)[method]("/probe", makeAuth(role, companyId), guard, (_req: any, res: any) =>
    res.status(200).json({ ok: true }),
  );
  const { url, server } = await listen(app);
  try {
    const res = await fetch(`${url}/probe`, {
      method: method.toUpperCase(),
      headers: { "content-type": "application/json" },
      body: method === "get" ? undefined : "{}",
    });
    return res.status;
  } finally {
    await close(server);
  }
}

async function listen(app: Express): Promise<{ url: string; server: Server }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

const ORIG: Record<string, any> = {};
function patch(name: string, impl: any) {
  if (!(name in ORIG)) ORIG[name] = (storage as any)[name];
  (storage as any)[name] = impl;
}
function restoreAll() {
  for (const k of Object.keys(ORIG)) (storage as any)[k] = ORIG[k];
  for (const k of Object.keys(ORIG)) delete ORIG[k];
}

const ROUTES_SRC = readFileSync(join(import.meta.dirname, "routes.ts"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// (a) Registry — the property the whole allowlist conversion rests on
// ─────────────────────────────────────────────────────────────────────────────

describe("role registry — hasCapability is closed by default", () => {
  it("is false for an unrecognised role string", () => {
    for (const cap of [CAN_READ_INVOICES, CAN_EDIT_INVOICES, CAN_MANAGE_QUICKBOOKS]) {
      assert.equal(hasCapability("auditor", cap), false);
      assert.equal(hasCapability("", cap), false);
      assert.equal(hasCapability("BOOKKEEPER", cap), false, "must be case-sensitive");
    }
  });

  it("is false for null and undefined", () => {
    for (const cap of [CAN_READ_INVOICES, CAN_EDIT_INVOICES, CAN_MANAGE_QUICKBOOKS]) {
      assert.equal(hasCapability(null, cap), false);
      assert.equal(hasCapability(undefined, cap), false);
    }
  });

  it("declares the membership the ticket fixed", () => {
    // Invoice read — irrigation_manager is DELIBERATE (see roles.ts), field_tech
    // is the one removal in this ticket.
    assert.deepEqual(
      ROLES.filter((r) => hasCapability(r, CAN_READ_INVOICES)).sort(),
      ["billing_manager", "bookkeeper", "company_admin", "irrigation_manager", "super_admin"],
    );
    // Invoice write — unchanged from the old requireBillingAccess membership.
    assert.deepEqual(
      ROLES.filter((r) => hasCapability(r, CAN_EDIT_INVOICES)).sort(),
      ["billing_manager", "company_admin", "super_admin"],
    );
    // QuickBooks — exactly who passed the old denylist, plus the bookkeeper.
    assert.deepEqual(
      ROLES.filter((r) => hasCapability(r, CAN_MANAGE_QUICKBOOKS)).sort(),
      ["billing_manager", "bookkeeper", "company_admin", "super_admin"],
    );
  });

  it("keeps the bookkeeper out of budgets, costs, and approvals", () => {
    for (const cap of [CAN_VIEW_BUDGETS, CAN_VIEW_COSTS, CAN_APPROVE_ESTIMATES, CAN_APPROVE_PARTS]) {
      assert.equal(hasCapability("bookkeeper", cap), false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b)(c)(f) Invoice guards across the role set
// ─────────────────────────────────────────────────────────────────────────────

describe("requireInvoiceRead — who may read an invoice, its PDF, and the list", () => {
  const expected: Array<[TestRole, number]> = [
    ["super_admin", 200],
    ["company_admin", 200],
    ["billing_manager", 200],
    ["bookkeeper", 200],
    // Declared, not accidental: a manager needs a customer's invoice history.
    ["irrigation_manager", 200],
    // The pre-existing hole this ticket closes.
    ["field_tech", 403],
    ["auditor", 403],
    [NO_ROLE, 403],
  ];

  for (const [role, status] of expected) {
    const label = role === NO_ROLE ? "(no role)" : role;
    it(`${label} → ${status}`, async () => {
      assert.equal(await guardStatus(requireInvoiceRead, role), status);
    });
  }
});

describe("requireInvoiceWrite — authoring stays where it was", () => {
  const expected: Array<[TestRole, number]> = [
    ["super_admin", 200],
    ["company_admin", 200],
    ["billing_manager", 200],
    // The bookkeeper may read and send, never author.
    ["bookkeeper", 403],
    ["irrigation_manager", 403],
    ["field_tech", 403],
    ["auditor", 403],
    [NO_ROLE, 403],
  ];

  for (const [role, status] of expected) {
    const label = role === NO_ROLE ? "(no role)" : role;
    it(`${label} → ${status}`, async () => {
      assert.equal(await guardStatus(requireInvoiceWrite, role, { method: "post" }), status);
    });
  }
});

describe("requireInvoiceSend — delivery is not authorship", () => {
  const expected: Array<[TestRole, number]> = [
    ["super_admin", 200],
    ["company_admin", 200],
    ["billing_manager", 200],
    ["bookkeeper", 200],
    ["irrigation_manager", 403],
    ["field_tech", 403],
    ["auditor", 403],
    [NO_ROLE, 403],
  ];

  for (const [role, status] of expected) {
    const label = role === NO_ROLE ? "(no role)" : role;
    it(`${label} → ${status}`, async () => {
      assert.equal(await guardStatus(requireInvoiceSend, role, { method: "post" }), status);
    });
  }
});

describe("guard split — company_admin and billing_manager are unaffected", () => {
  it("both still pass every former requireBillingAccess guard", async () => {
    for (const role of ["company_admin", "billing_manager"]) {
      assert.equal(await guardStatus(requireInvoiceRead, role), 200, `${role} read`);
      assert.equal(
        await guardStatus(requireInvoiceWrite, role, { method: "post" }),
        200,
        `${role} write`,
      );
      assert.equal(
        await guardStatus(requireInvoiceSend, role, { method: "post" }),
        200,
        `${role} send`,
      );
      assert.equal(await guardStatus(requireQuickBooksAccess, role), 200, `${role} quickbooks`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) QuickBooks — denylist → allowlist
// ─────────────────────────────────────────────────────────────────────────────

describe("requireQuickBooksAccess — allowlist conversion", () => {
  const expected: Array<[TestRole, number]> = [
    ["super_admin", 200],
    ["company_admin", 200],
    ["billing_manager", 200],
    // She is the person who reconnects the integration when the token expires.
    ["bookkeeper", 200],
    // Still refused — now by absence from the allowlist, not by being named.
    ["irrigation_manager", 403],
    ["field_tech", 403],
  ];

  for (const [role, status] of expected) {
    it(`${String(role)} → ${status}`, async () => {
      assert.equal(await guardStatus(requireQuickBooksAccess, role), status);
    });
  }

  it("an unrecognised role string is refused (the denylist silently allowed it)", async () => {
    assert.equal(await guardStatus(requireQuickBooksAccess, "auditor"), 403);
    assert.equal(await guardStatus(requireQuickBooksAccess, "bookeeper"), 403); // typo'd role
  });

  it("a missing role is refused — do NOT 'fix' this back into a bypass", async () => {
    // Under the denylist an undefined role matched neither named role and fell
    // through to next(). This assertion is the security fix; if it ever starts
    // failing, someone has re-added a null/undefined special case.
    assert.equal(await guardStatus(requireQuickBooksAccess, NO_ROLE), 403);
  });

  it("keeps the header-auth fallback for roles that have the capability", async () => {
    const app = express();
    app.get(
      "/probe",
      (req: any, _res, next) => {
        // No authenticatedUserRole — forces the headerUserRole(req) fallback.
        req.authenticatedUserCompanyId = 1;
        next();
      },
      requireQuickBooksAccess,
      (_req, res) => res.status(200).json({ ok: true }),
    );
    const { url, server } = await listen(app);
    try {
      const ok = await fetch(`${url}/probe`, { headers: { "x-user-role": "bookkeeper" } });
      assert.equal(ok.status, 200, "header role with the capability passes");
      const denied = await fetch(`${url}/probe`, { headers: { "x-user-role": "field_tech" } });
      assert.equal(denied.status, 403, "header role without the capability is refused");
      const none = await fetch(`${url}/probe`);
      assert.equal(none.status, 403, "no header at all is refused");
    } finally {
      await close(server);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e)(g) Real route modules mounted with the real guards
// ─────────────────────────────────────────────────────────────────────────────

describe("invoice mark-sent / mark-unsent — real routes, real guards", () => {
  before(() => {
    patch("getInvoiceById", async (id: number, companyId: number | null) => {
      // Invoice 1 belongs to company 1; invoice 2 belongs to company 2.
      const owner = id === 2 ? 2 : 1;
      if (companyId !== null && companyId !== owner) return undefined;
      return { id, status: "generated", sentAt: null, companyId: owner };
    });
    patch("updateInvoice", async (id: number, patchData: any) => ({ id, ...patchData }));
  });
  after(restoreAll);

  function buildApp(role: TestRole, companyId: number | null = 1) {
    const app = express();
    app.use(express.json());
    registerInvoiceMarkSentRoutes(app, {
      requireAuthentication: makeAuth(role, companyId),
      requireInvoiceSend,
      requireInvoiceWrite,
    });
    return app;
  }

  async function post(app: Express, path: string) {
    const { url, server } = await listen(app);
    try {
      const res = await fetch(`${url}${path}`, { method: "POST" });
      return res.status;
    } finally {
      await close(server);
    }
  }

  it("bookkeeper CAN mark an invoice sent (200)", async () => {
    assert.equal(await post(buildApp("bookkeeper"), "/api/invoices/1/mark-sent"), 200);
  });

  it("bookkeeper CANNOT mark it unsent (403) — un-sending is a write", async () => {
    assert.equal(await post(buildApp("bookkeeper"), "/api/invoices/1/mark-unsent"), 403);
  });

  it("field_tech and irrigation_manager are refused both directions", async () => {
    for (const role of ["field_tech", "irrigation_manager"]) {
      assert.equal(await post(buildApp(role), "/api/invoices/1/mark-sent"), 403, `${role} sent`);
      assert.equal(await post(buildApp(role), "/api/invoices/1/mark-unsent"), 403, `${role} unsent`);
    }
  });

  it("a bookkeeper in company A gets nothing for a company B invoice id", async () => {
    // Passes the capability gate, then dies on the company scope — 404, not 200.
    assert.equal(await post(buildApp("bookkeeper", 1), "/api/invoices/2/mark-sent"), 404);
    // Sanity: the same id resolves for the company that owns it.
    assert.equal(await post(buildApp("bookkeeper", 2), "/api/invoices/2/mark-sent"), 200);
  });
});

// Task #1887 — the reminder endpoints are the one place in the product where a
// misclick reaches a customer's inbox, so their gate is proven against the real
// guard and the real route module, not against a copy of the capability set.
describe("invoice payment reminders — real routes, real guards", () => {
  const mailed: string[] = [];

  function buildApp(role: TestRole, companyId: number | null = 1) {
    const app = express();
    app.use(express.json());
    registerInvoiceReminderRoutes(app, {
      requireAuthentication: makeAuth(role, companyId),
      requireInvoiceSend,
      _storageApi: {
        async getInvoiceById(id: number, scoped: number | null) {
          // Invoice 1 belongs to company 1; invoice 2 belongs to company 2.
          const owner = id === 2 ? 2 : 1;
          if (scoped !== null && scoped !== owner) return undefined;
          return {
            id,
            companyId: owner,
            invoiceNumber: `INV-${id}`,
            customerId: 100,
            customerName: "Acme",
            customerEmail: "ap@acme.test",
            status: "generated",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            dueDate: new Date("2026-06-01T00:00:00.000Z"),
            sentAt: new Date("2026-06-02T00:00:00.000Z"),
            paymentStatus: "unpaid",
            paymentSyncedAt: new Date("2026-08-10T00:00:00.000Z"),
            balance: "100.00",
            totalAmount: "100.00",
          };
        },
        async getInvoicePdfByInvoiceId() {
          return { id: 5, pdfUrl: "/pdf/x.pdf" };
        },
        async getUser() {
          return { id: 7, name: "Tester" };
        },
        async getCompanyProfile() {
          return { id: 1, name: "Co", email: "billing@co.test", logo: null };
        },
        async getInvoiceReminders() {
          return [];
        },
        async getLastDeliveredInvoiceReminder() {
          return undefined;
        },
        async createInvoiceReminder(row: any) {
          return { id: 1, ...row };
        },
      },
      _mailer: async (to: string) => {
        mailed.push(to);
        return { success: true };
      },
      _loadPaymentTerms: async () => "net_30",
      _now: () => new Date("2026-08-11T12:00:00.000Z"),
    });
    return app;
  }

  async function call(app: Express, method: "GET" | "POST", path: string) {
    const { url, server } = await listen(app);
    try {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ templateKey: "firm" }) : undefined,
      });
      return res.status;
    } finally {
      await close(server);
    }
  }

  it("bookkeeper CAN send a reminder and read its history", async () => {
    assert.equal(await call(buildApp("bookkeeper"), "POST", "/api/invoices/1/reminders"), 201);
    assert.equal(await call(buildApp("bookkeeper"), "GET", "/api/invoices/1/reminders"), 200);
  });

  it("field_tech and irrigation_manager are refused, and no email is attempted", async () => {
    for (const role of ["field_tech", "irrigation_manager", NO_ROLE as TestRole]) {
      mailed.length = 0;
      assert.equal(await call(buildApp(role), "POST", "/api/invoices/1/reminders"), 403);
      assert.equal(mailed.length, 0, `${String(role)} must never reach the mailer`);
    }
  });

  it("a bookkeeper in company A gets nothing for a company B invoice, and no email is attempted", async () => {
    mailed.length = 0;
    assert.equal(await call(buildApp("bookkeeper", 1), "POST", "/api/invoices/2/reminders"), 404);
    assert.equal(mailed.length, 0);
    // Sanity: the same id resolves for the company that owns it.
    assert.equal(await call(buildApp("bookkeeper", 2), "POST", "/api/invoices/2/reminders"), 201);
  });
});

describe("invoice merge — bookkeeper is refused by the real route", () => {
  function buildApp(role: TestRole) {
    const app = express();
    app.use(express.json());
    registerInvoiceMergeRoutes(app, {
      requireAuthentication: makeAuth(role),
      requireInvoiceWrite,
    });
    return app;
  }

  it("bookkeeper → 403 before any body validation happens", async () => {
    const { url, server } = await listen(buildApp("bookkeeper"));
    try {
      const res = await fetch(`${url}/api/invoices/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Deliberately valid, so a 403 proves the guard fired, not the schema.
        body: JSON.stringify({ survivingInvoiceId: 1, mergedInvoiceIds: [2] }),
      });
      assert.equal(res.status, 403);
    } finally {
      await close(server);
    }
  });

  it("billing_manager gets past the guard (400 from the body, not 403)", async () => {
    const { url, server } = await listen(buildApp("billing_manager"));
    try {
      const res = await fetch(`${url}/api/invoices/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nope: true }),
      });
      assert.equal(res.status, 400, "reached the handler");
    } finally {
      await close(server);
    }
  });
});

describe("budgets, costs, and approvals already refuse the bookkeeper", () => {
  // Regression guards: these needed no production change, which is the point.
  it("GET /api/customers/:id/budget-usage → 403 for bookkeeper", async () => {
    const app = express();
    registerBudgetRoutes(app, { requireAuthentication: makeAuth("bookkeeper") });
    const { url, server } = await listen(app);
    try {
      assert.equal((await fetch(`${url}/api/customers/1/budget-usage`)).status, 403);
    } finally {
      await close(server);
    }
  });

  it("GET /api/financial-pulse/kpis → 403 for bookkeeper", async () => {
    const app = express();
    registerFinancialPulseRoutes(app, { requireAuthentication: makeAuth("bookkeeper") });
    const { url, server } = await listen(app);
    try {
      assert.equal((await fetch(`${url}/api/financial-pulse/kpis`)).status, 403);
    } finally {
      await close(server);
    }
  });

  it("estimate approval → 403 for bookkeeper", async () => {
    assert.equal(await guardStatus(requireEstimateApprovalAccess, "bookkeeper", { method: "post" }), 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (h) Wiring proof — the monolith's routes carry the guard we think they do
// ─────────────────────────────────────────────────────────────────────────────

describe("routes.ts wiring", () => {
  function guardFor(routeDecl: string): string {
    const i = ROUTES_SRC.indexOf(routeDecl);
    assert.notEqual(i, -1, `route not found: ${routeDecl}`);
    return ROUTES_SRC.slice(i, i + routeDecl.length + 120);
  }

  it("the invoice preview endpoint is gated on invoice write", () => {
    // Preview assembles the contents of an invoice that does not exist yet —
    // a customer's billable work orders, billing sheets, and wet-check
    // billings. It was authenticated-only, so any role could read it.
    assert.match(
      guardFor('app.post("/api/invoices/preview",'),
      /requireInvoiceWrite/,
      "POST /api/invoices/preview must be write-gated — it exposes billable work",
    );
  });

  it("no invoice route is left authenticated-only", () => {
    // The hole this task closes is a route with authentication but no role
    // gate. Assert the property, not a list of known routes.
    const decls = ROUTES_SRC.match(
      /app\.(?:get|post|put|patch|delete)\("\/api\/invoices[^"]*",[^)]*?requireAuthentication,\s*(\w+)/g,
    ) ?? [];
    assert.ok(decls.length > 0, "expected to find invoice routes");
    for (const d of decls) {
      assert.match(
        d,
        /requireInvoice(Read|Write|Send)/,
        `invoice route is authenticated but not role-gated: ${d.slice(0, 90)}`,
      );
    }
  });

  it("the invoice list endpoint is gated on invoice read", () => {
    assert.match(
      guardFor('app.get("/api/invoices",'),
      /requireInvoiceRead/,
      "GET /api/invoices must be role-gated — it previously had no gate at all",
    );
  });

  it("invoice PDF routes are gated on invoice read", () => {
    for (const decl of [
      'app.get("/api/invoices/:invoiceId/pdf"',
      'app.get("/api/invoices/:invoiceId/pdf/download"',
    ]) {
      assert.match(guardFor(decl), /requireInvoiceRead/, decl);
    }
  });

  it("both previously-ungated QuickBooks routes now carry the allowlist", () => {
    for (const decl of [
      'app.get("/api/quickbooks/connection/stale"',
      'app.get("/api/quickbooks/health"',
    ]) {
      assert.match(guardFor(decl), /requireQuickBooksAccess/, decl);
    }
  });

  it("no route uses the old requireBillingAccess guard any more", () => {
    const calls = ROUTES_SRC.match(/requireBillingAccess/g) ?? [];
    assert.equal(calls.length, 0, "requireBillingAccess should be fully replaced");
  });

  it("the role-ceiling rank map knows about the bookkeeper", () => {
    assert.match(ROUTES_SRC, /bookkeeper:\s*2/, "bookkeeper must be assignable");
  });
});
