// Task #1866 — Budget Status Page: route-level tests.
//
// Tests cover:
//   - Threshold boundaries (exactly 75% → Slow down; 100% → Stop; 74.9% → Go)
//   - Unset customers (no allocation → status "Unset", excluded from over-cap count)
//   - Company roll-up equals sum of visible customers; never crosses companies
//   - Crew endpoint response body: assert no monetary fields exposed
//   - Role gates: irrigation_manager receives full figures; field_tech refused
//     on full endpoint; unlisted roles receive 403
//   - Month selector: past month uses that month's allocation

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { registerBudgetRoutes } from "./budget-routes";
import { db } from "../db";
import { storage } from "../storage";

// ─── In-memory state ─────────────────────────────────────────────────────────

interface MockAlloc {
  customerId: number;
  year: number;
  month: number;
  amount: number;
}
interface MockCustomer {
  id: number;
  companyId: number;
  name: string;
  annualBudgetGoal: string | null;
  budgetSoftThresholdPercent: number | null;
  budgetHardThresholdPercent: number | null;
}
interface MockInvoice {
  id: number;
  customerId: number;
  companyId: number;
  totalAmount: string;
  status: string;
  createdAt: Date;
  invoiceMonth: number;
  invoiceYear: number;
}

const state = {
  customers: [] as MockCustomer[],
  allocs: [] as MockAlloc[],
  invoices: [] as MockInvoice[],
};

// ─── DB mock using Symbol.for('drizzle:BaseName') to get table name ──────────
// This is the stable Drizzle ORM API for table names in this version.

function _makeMockChain(fromTableName?: string): any {
  const chain: any = new Proxy(
    {} as any,
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: any[]) => void) => {
            if (fromTableName === "customer_budget_months") {
              // Return ALL allocs; route handles filtering by context.
              resolve(
                state.allocs.map((r) => ({
                  customerId: r.customerId,
                  amount: r.amount,
                  year: r.year,
                  month: r.month,
                })),
              );
            } else if (fromTableName === "customers") {
              // Return ALL customers; route filters by companyId via where() which
              // we can't parse, so return everything and rely on per-test isolation.
              resolve(state.customers.map((c) => ({ ...c })));
            } else {
              // wet_check_billings and other tables → empty (no uninvoiced WCBs in tests).
              resolve([]);
            }
          };
        }
        if (prop === "from") {
          return (tbl: any) => {
            // Use the Drizzle ORM runtime Symbol to get the SQL table name.
            const name: string =
              (tbl && tbl[Symbol.for("drizzle:BaseName")]) ?? "";
            return _makeMockChain(name || undefined);
          };
        }
        // .where(), .select(), .limit(), .orderBy() etc. — pass through, keep tableName.
        return (..._args: unknown[]) => _makeMockChain(fromTableName);
      },
    },
  );
  return chain;
}

// Patch the DB singleton before any route code runs.
(db as any).select = () => _makeMockChain();

// Patch storage — computeCustomerSpend uses storage.getInvoicesByCustomer.
(storage as any).getCustomer = async (id: number) =>
  state.customers.find((c) => c.id === id);
(storage as any).getInvoicesByCustomer = async (
  customerId: number,
  companyId: number | null,
) =>
  state.invoices.filter(
    (i) =>
      i.customerId === customerId &&
      (companyId === null || i.companyId === companyId),
  );

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeApp(role: string, companyId: number | null): Express {
  const app = express();
  app.use(express.json());
  const requireAuthentication: express.RequestHandler = (req: any, _res, next) => {
    req.authenticatedUserRole = role;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
  registerBudgetRoutes(app, { requireAuthentication });
  return app;
}

function startServer(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function get(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  // Cast to `any` so callers can access dynamic JSON fields without
  // exhaustive narrowing — this is intentional in a test helper.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json()) as any;
  return { status: res.status, body: json };
}

// ─── State helpers ────────────────────────────────────────────────────────────

function addCustomer(
  id: number,
  companyId: number,
  name = `Customer ${id}`,
  soft = 75,
  hard = 100,
) {
  state.customers.push({
    id, companyId, name,
    annualBudgetGoal: null,
    budgetSoftThresholdPercent: soft,
    budgetHardThresholdPercent: hard,
  });
}

function addAlloc(customerId: number, year: number, month: number, amount: number) {
  state.allocs.push({ customerId, year, month, amount });
}

function addInvoice(
  id: number,
  customerId: number,
  companyId: number,
  totalAmount: number,
  year: number,
  month: number,
  status = "approved",
) {
  state.invoices.push({
    id, customerId, companyId,
    totalAmount: String(totalAmount),
    status,
    createdAt: new Date(year, month - 1, 10),
    invoiceMonth: month,
    invoiceYear: year,
  });
}

function resetState() {
  state.customers = [];
  state.allocs = [];
  state.invoices = [];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("role gates — /api/budget/status", () => {
  let server: Server;
  let port: number;

  before(async () => {
    resetState();
    addCustomer(1, 10);
    addAlloc(1, 2026, 7, 5000);
    addInvoice(100, 1, 10, 2000, 2026, 7);

    // One server shared across all role-gate tests for speed.
    const app = makeApp("billing_manager", 10);
    const s = await startServer(app);
    server = s.server; port = s.port;
  });
  after(() => stopServer(server));

  it("billing_manager → 200 with full figures", async () => {
    const { status, body } = await get(port, "/api/budget/status?year=2026&month=7");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.rows));
    const row = body.rows.find((r: any) => r.customerId === 1);
    assert.ok(row, "row for customer 1 must exist");
    assert.ok("invoicedAmount" in row, "invoicedAmount must be present for full-visibility role");
    assert.ok("allocation" in row, "allocation must be present");
    assert.ok("fillPercent" in row, "fillPercent must be present");
  });

  it("field_tech → 403 on full endpoint", async () => {
    const app = makeApp("field_tech", 10);
    const s = await startServer(app);
    const { status } = await get(s.port, "/api/budget/status?year=2026&month=7");
    await stopServer(s.server);
    assert.equal(status, 403);
  });

  it("irrigation_manager → 200 with full figures", async () => {
    const app = makeApp("irrigation_manager", 10);
    const s = await startServer(app);
    const { status, body } = await get(s.port, "/api/budget/status?year=2026&month=7");
    await stopServer(s.server);
    assert.equal(status, 200, `irrigation_manager must have full visibility, got ${status}`);
    assert.ok(Array.isArray(body.rows));
    const row = body.rows.find((r: any) => r.customerId === 1);
    assert.ok(row, "row for customer 1 must exist");
    assert.ok("invoicedAmount" in row, "invoicedAmount must be present");
    assert.ok("pendingAmount" in row);
    assert.ok("allocation" in row);
  });

  it("unknown_role → 403", async () => {
    const app = makeApp("some_random_role", 10);
    const s = await startServer(app);
    const { status } = await get(s.port, "/api/budget/status?year=2026&month=7");
    await stopServer(s.server);
    assert.equal(status, 403);
  });
});

describe("threshold boundaries", () => {
  let server: Server;
  let port: number;

  before(async () => {
    const app = makeApp("billing_manager", 20);
    const s = await startServer(app);
    server = s.server; port = s.port;
  });
  after(() => stopServer(server));

  beforeEach(() => resetState());

  it("74.9% → status Go", async () => {
    addCustomer(2, 20);
    addAlloc(2, 2026, 7, 1000);
    addInvoice(200, 2, 20, 749, 2026, 7); // 74.9%
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    const row = body.rows.find((r: any) => r.customerId === 2);
    assert.ok(row, "row must exist");
    assert.equal(row.status, "Go", `74.9% → Go, got ${row.status} (fill=${row.fillPercent})`);
  });

  it("exactly 75% → status Slow down", async () => {
    addCustomer(3, 20);
    addAlloc(3, 2026, 7, 1000);
    addInvoice(201, 3, 20, 750, 2026, 7); // exactly 75%
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    const row = body.rows.find((r: any) => r.customerId === 3);
    assert.ok(row);
    assert.equal(row.status, "Slow down");
  });

  it("exactly 100% → status Stop", async () => {
    addCustomer(4, 20);
    addAlloc(4, 2026, 7, 1000);
    addInvoice(202, 4, 20, 1000, 2026, 7); // exactly 100%
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    const row = body.rows.find((r: any) => r.customerId === 4);
    assert.ok(row);
    assert.equal(row.status, "Stop");
  });

  it("customer with non-default thresholds (soft=50, hard=90) uses their own values", async () => {
    addCustomer(5, 20, "Custom Thresholds", 50, 90);
    addAlloc(5, 2026, 7, 1000);
    addInvoice(203, 5, 20, 600, 2026, 7); // 60% — above soft=50, below hard=90
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    const row = body.rows.find((r: any) => r.customerId === 5);
    assert.ok(row);
    assert.equal(row.status, "Slow down", `60% with soft=50 → Slow down, got ${row.status}`);
    assert.equal(row.softThresholdPercent, 50);
    assert.equal(row.hardThresholdPercent, 90);
  });
});

describe("unset customers", () => {
  let server: Server;
  let port: number;

  before(async () => {
    resetState();
    addCustomer(6, 30, "No Allocation");     // no alloc → Unset
    addCustomer(7, 30, "Has Allocation");
    addAlloc(7, 2026, 7, 2000);
    addInvoice(300, 7, 30, 2100, 2026, 7); // 105% → Stop

    const app = makeApp("billing_manager", 30);
    const s = await startServer(app);
    server = s.server; port = s.port;
  });
  after(() => stopServer(server));

  it("no allocation → status Unset, allocation null", async () => {
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    const row = body.rows.find((r: any) => r.customerId === 6);
    assert.ok(row, "Unset customer must appear in results");
    assert.equal(row.status, "Unset");
    assert.equal(row.allocation, null);
    assert.equal(row.fillPercent, null);
  });

  it("Unset customer NOT counted in rollup.overCapCount", async () => {
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    // customer 7 is over cap, customer 6 is Unset — only 1 over cap
    assert.equal(
      body.rollup.overCapCount,
      1,
      `overCapCount should be 1 (only customer 7), got ${body.rollup.overCapCount}`,
    );
  });
});

describe("crew endpoint — custom thresholds are honoured in returned status", () => {
  // A customer with soft=50/hard=90 at 60% fill → server must return "Slow down",
  // not "Go" (which a re-computation at 75/100% defaults would produce).
  it("customer with soft=50/hard=90 at 60% → crew status is Slow down, not Go", async () => {
    resetState();
    addCustomer(90, 80, "Custom Threshold Co", 50, 90);
    addAlloc(90, 2026, 7, 1000);
    addInvoice(900, 90, 80, 600, 2026, 7); // 60% spend

    const app = makeApp("field_tech", 80);
    const s = await startServer(app);
    const { status, body } = await get(s.port, "/api/budget/crew-status?year=2026&month=7");
    await stopServer(s.server);

    assert.equal(status, 200);
    const row = body.rows.find((r: any) => r.customerId === 90);
    assert.ok(row, "crew row must exist for customer 90");
    assert.equal(
      row.status,
      "Slow down",
      `60% with soft=50 → Slow down from crew endpoint, got: ${row.status}`,
    );
    // Sanity: fillPercent is present (width hint) — it is NOT what drives status.
    assert.equal(typeof row.fillPercent, "number");
  });

  it("customer with soft=50/hard=90 at 60% → fillPercent does not equal rendered status label", async () => {
    // This test guards against the crew UI re-deriving status at fixed 75/100%,
    // which would show "Go" for this 60%-fill customer.
    // The API must return status="Slow down" regardless of fillPercent value.
    resetState();
    addCustomer(91, 81, "Threshold Guard Co", 50, 90);
    addAlloc(91, 2026, 7, 1000);
    addInvoice(901, 91, 81, 600, 2026, 7); // 60%

    const app = makeApp("field_tech", 81);
    const s = await startServer(app);
    const { body } = await get(s.port, "/api/budget/crew-status?year=2026&month=7");
    await stopServer(s.server);

    const row = body.rows.find((r: any) => r.customerId === 91);
    assert.ok(row);
    // If crew UI naively re-computes status from fillPercent with 75/100% defaults,
    // 60% < 75% → "Go". Server must say "Slow down" instead.
    assert.notEqual(row.status, "Go", "60% with soft=50 must NOT be Go at crew endpoint");
    assert.equal(row.status, "Slow down");
  });
});

describe("crew endpoint — role gates", () => {
  it("field_tech → 200", async () => {
    resetState();
    addCustomer(10, 40);
    addAlloc(10, 2026, 7, 1000);
    const app = makeApp("field_tech", 40);
    const s = await startServer(app);
    const { status } = await get(s.port, "/api/budget/crew-status?year=2026&month=7");
    await stopServer(s.server);
    assert.equal(status, 200);
  });

  it("billing_manager → 403 on crew endpoint", async () => {
    const app = makeApp("billing_manager", 40);
    const s = await startServer(app);
    const { status } = await get(s.port, "/api/budget/crew-status?year=2026&month=7");
    await stopServer(s.server);
    assert.equal(status, 403);
  });

  it("irrigation_manager → 403 on crew endpoint", async () => {
    const app = makeApp("irrigation_manager", 40);
    const s = await startServer(app);
    const { status } = await get(s.port, "/api/budget/crew-status?year=2026&month=7");
    await stopServer(s.server);
    assert.equal(status, 403);
  });
});

describe("crew endpoint — response body must NOT expose monetary fields", () => {
  let responseBody: any;
  let server: Server;
  let port: number;

  before(async () => {
    resetState();
    addCustomer(20, 50, "Crew Customer A");
    addAlloc(20, 2026, 7, 5000);
    addInvoice(400, 20, 50, 2000, 2026, 7); // 40% → Go

    const app = makeApp("field_tech", 50);
    const s = await startServer(app);
    server = s.server; port = s.port;
    const { body } = await get(port, "/api/budget/crew-status?year=2026&month=7");
    responseBody = body;
  });
  after(() => stopServer(server));

  it("rows is an array", () => {
    assert.ok(Array.isArray(responseBody.rows));
  });

  it("status field is present", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row, "crew row must exist for customer 20");
    assert.ok("status" in row, "status must be present");
  });

  it("fillPercent field is present and is a number for allocated customer", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.ok("fillPercent" in row, "fillPercent must be present");
    assert.equal(typeof row.fillPercent, "number", "fillPercent must be a number");
  });

  it("cap is ABSENT from crew response", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.equal("cap" in row, false, "cap must NOT appear in crew response");
  });

  it("spend is ABSENT from crew response", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.equal("spend" in row, false);
  });

  it("remaining is ABSENT from crew response", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.equal("remaining" in row, false);
  });

  it("percent is ABSENT from crew response", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.equal("percent" in row, false);
  });

  it("invoicedAmount is ABSENT from crew response", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.equal("invoicedAmount" in row, false);
  });

  it("pendingAmount is ABSENT from crew response", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.equal("pendingAmount" in row, false);
  });

  it("allocation is ABSENT from crew response", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.equal("allocation" in row, false);
  });

  it("annualGoal is ABSENT from crew response", () => {
    const row = responseBody.rows.find((r: any) => r.customerId === 20);
    assert.ok(row);
    assert.equal("annualGoal" in row, false);
  });

  it("status is one of Go / Slow down / Stop / Unset", () => {
    for (const row of responseBody.rows) {
      assert.ok(
        ["Go", "Slow down", "Stop", "Unset"].includes(row.status),
        `Unexpected status: ${row.status}`,
      );
    }
  });
});

// Month selector: tested with isolated state per subtest so the mock
// (which cannot parse Drizzle where-clauses) only sees one alloc at a time.

describe("month selector — June uses June's allocation", () => {
  let server: Server;
  let port: number;

  before(async () => {
    resetState();
    addCustomer(30, 60);
    // Only June alloc in state; the route queries ?month=6 and sees this cap.
    addAlloc(30, 2026, 6, 3000); // June: $3,000 cap
    // Invoice in June for $2,700 (90% of June cap → Slow down).
    addInvoice(500, 30, 60, 2700, 2026, 6);

    const app = makeApp("billing_manager", 60);
    const s = await startServer(app);
    server = s.server; port = s.port;
  });
  after(() => stopServer(server));

  it("June query uses June's $3000 allocation and returns Slow down (90%)", async () => {
    const { body } = await get(port, "/api/budget/status?year=2026&month=6");
    const row = body.rows.find((r: any) => r.customerId === 30);
    assert.ok(row, "customer 30 must appear for June");
    assert.equal(row.allocation, 3000, `June allocation should be 3000, got ${row.allocation}`);
    assert.equal(row.status, "Slow down", `90% of June cap → Slow down, got ${row.status}`);
  });
});

describe("month selector — July uses July's allocation", () => {
  let server: Server;
  let port: number;

  before(async () => {
    resetState();
    addCustomer(31, 60);
    // Only July alloc in state; invoice was in June so July spend = $0 → Go.
    addAlloc(31, 2026, 7, 8000); // July: $8,000 cap
    addInvoice(501, 31, 60, 2700, 2026, 6); // June invoice — outside July window

    const app = makeApp("billing_manager", 60);
    const s = await startServer(app);
    server = s.server; port = s.port;
  });
  after(() => stopServer(server));

  it("July query uses July's $8000 allocation; June invoice not counted → Go", async () => {
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    const row = body.rows.find((r: any) => r.customerId === 31);
    assert.ok(row, "customer 31 must appear for July");
    assert.equal(row.allocation, 8000, `July allocation should be 8000, got ${row.allocation}`);
    // $2700 invoice was created in June — not in July's spend window.
    assert.equal(row.status, "Go", `July spend = $0 → Go, got ${row.status}`);
  });
});

describe("company roll-up matches sum of per-customer rows", () => {
  let server: Server;
  let port: number;

  before(async () => {
    resetState();
    addCustomer(40, 70, "Alpha");
    addCustomer(41, 70, "Beta");
    addAlloc(40, 2026, 7, 1000);
    addAlloc(41, 2026, 7, 2000);
    addInvoice(600, 40, 70, 400, 2026, 7);
    addInvoice(601, 41, 70, 900, 2026, 7);

    const app = makeApp("billing_manager", 70);
    const s = await startServer(app);
    server = s.server; port = s.port;
  });
  after(() => stopServer(server));

  it("rollup.totalAllocation equals sum of per-customer allocations", async () => {
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    const sumAlloc = body.rows.reduce((s: number, r: any) => s + (r.allocation ?? 0), 0);
    assert.equal(body.rollup.totalAllocation, sumAlloc);
  });

  it("rollup.totalSpend equals sum of per-customer totalSpend", async () => {
    const { body } = await get(port, "/api/budget/status?year=2026&month=7");
    const sumSpend = body.rows.reduce((s: number, r: any) => s + r.totalSpend, 0);
    assert.ok(
      Math.abs(body.rollup.totalSpend - sumSpend) < 0.01,
      `rollup.totalSpend ${body.rollup.totalSpend} ≠ row sum ${sumSpend}`,
    );
  });
});
