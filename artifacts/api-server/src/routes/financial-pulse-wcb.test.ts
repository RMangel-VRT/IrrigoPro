// Task #815 — Verify wet check billing numbers appear correctly on the
// Financial Pulse page.
//
// Integration tests that seed real DB rows, mount the *real*
// registerFinancialPulseRoutes against a fresh Express app with a
// stub auth middleware, then call the three required endpoints over
// actual HTTP and assert on the JSON response fields.
//
// Seeding strategy (mirrors budget-alert-service.test.ts):
//   - All scratch IDs in the 90001-90002 range
//   - Company 2 (known-good anchor; exists in dev DB)
//   - Fixed SEED_DATE = 1st of current month noon UTC so all
//     MTD / YTD window filters include the test rows reliably

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { db } from "../db";
import {
  customers as customersTable,
  wetChecks as wetChecksTable,
  wetCheckBillings as wetCheckBillingsTable,
  invoices as invoicesTable,
} from "@workspace/db/schema";
import { eq, inArray, sql } from "drizzle-orm";

import { registerFinancialPulseRoutes } from "./financial-pulse";

// ── Constants ──────────────────────────────────────────────────────────────

const TEST_COMPANY_ID = 2;
// Scratch user/tech seeded in before() so loadTechs(companyId) finds them.
const TEST_USER_ID = 90001;
const TEST_CUSTOMER_ID = 90001;
const TEST_WET_CHECK_ID = 90001;
const TEST_WCB_UNINVOICED_ID = 90001;
const TEST_WCB_INVOICED_ID = 90002;
const TEST_INVOICE_ID = 90001;

const UNINVOICED_AMOUNT = 250;
const INVOICED_AMOUNT = 350;
const INVOICED_HOURS = 3;

const _SEED_REF = new Date();
const CURRENT_YEAR = _SEED_REF.getFullYear();
const CURRENT_MONTH = _SEED_REF.getMonth() + 1;
// 1st of current month, noon UTC — safely inside MTD and YTD windows.
const SEED_DATE = new Date(
  Date.UTC(CURRENT_YEAR, CURRENT_MONTH - 1, 1, 12, 0, 0),
);

// ── DB seeding / cleanup ───────────────────────────────────────────────────

async function seedAll() {
  const sd = SEED_DATE.toISOString();

  // Scratch user in company 2 — required so loadTechs(companyId=2) returns
  // this tech and computeByTechnician / computePulseTechnicians can attribute
  // WCB hours and in-flight amounts to them.
  await db.execute(
    sql`INSERT INTO users
          (id, username, password, name, email, role, company_id,
           is_active, is_deleted, email_verified, mfa_enabled,
           created_at, updated_at)
        VALUES
          (${TEST_USER_ID}, ${"test-wcb-tech-90001"}, ${"x"}, ${"Test WCB Tech 90001"},
           ${"test-wcb-tech-90001@example.test"}, ${"field_tech"}, ${TEST_COMPANY_ID},
           true, false, false, false, ${sd}, ${sd})
        ON CONFLICT (id) DO NOTHING`,
  );

  await db.execute(
    sql`INSERT INTO customers (id, company_id, name, email)
        VALUES (${TEST_CUSTOMER_ID}, ${TEST_COMPANY_ID},
                ${"Test WCB Customer 90001"}, ${"test-wcb-90001@example.test"})
        ON CONFLICT (id) DO NOTHING`,
  );

  await db.execute(
    sql`INSERT INTO wet_checks
          (id, company_id, customer_id, technician_id, technician_name,
           customer_name, num_controllers, status, labor_mode,
           total_labor_hours, started_at, created_at, updated_at)
        VALUES
          (${TEST_WET_CHECK_ID}, ${TEST_COMPANY_ID}, ${TEST_CUSTOMER_ID},
           ${TEST_USER_ID}, ${"Test WCB Tech 90001"},
           ${"Test WCB Customer 90001"}, 1, ${"submitted"}, ${"flat"},
           ${"0.00"}, ${sd}, ${sd}, ${sd})
        ON CONFLICT (id) DO NOTHING`,
  );

  // Invoice scoped to TEST_CUSTOMER_ID so per-customer assertions are exact.
  await db.execute(
    sql`INSERT INTO invoices
          (id, invoice_number, customer_id, customer_name, customer_email,
           invoice_month, invoice_year, period_start, period_end,
           status, parts_subtotal, labor_subtotal, total_amount,
           created_at, updated_at)
        VALUES
          (${TEST_INVOICE_ID}, ${"TEST-INV-90001"}, ${TEST_CUSTOMER_ID},
           ${"Test WCB Customer 90001"}, ${"test-wcb-90001@example.test"},
           ${CURRENT_MONTH}, ${CURRENT_YEAR}, ${sd}, ${sd},
           ${"pending"}, ${"0.00"}, ${"0.00"}, ${String(INVOICED_AMOUNT)},
           ${sd}, ${sd})
        ON CONFLICT (id) DO NOTHING`,
  );

  // WCB 90001: uninvoiced — contributes to in-flight and unbilled exposure.
  await db.execute(
    sql`INSERT INTO wet_check_billings
          (id, billing_number, customer_id, customer_name, property_address,
           work_date, technician_name, technician_id, wet_check_id,
           status, total_hours, labor_rate, labor_subtotal, parts_subtotal,
           total_amount, created_at, updated_at)
        VALUES
          (${TEST_WCB_UNINVOICED_ID}, ${"TEST-WCB-90001"}, ${TEST_CUSTOMER_ID},
           ${"Test WCB Customer 90001"}, ${"123 Test St"},
           ${sd}, ${"Test WCB Tech 90001"}, ${TEST_USER_ID}, ${TEST_WET_CHECK_ID},
           ${"submitted"}, ${"2.00"}, ${"50.00"}, ${"100.00"}, ${"150.00"},
           ${String(UNINVOICED_AMOUNT)}, ${sd}, ${sd})
        ON CONFLICT (id) DO NOTHING`,
  );

  // WCB 90002: invoiced — links to TEST_INVOICE_ID for by-technician attribution.
  await db.execute(
    sql`INSERT INTO wet_check_billings
          (id, billing_number, customer_id, customer_name, property_address,
           work_date, technician_name, technician_id, wet_check_id,
           status, total_hours, labor_rate, labor_subtotal, parts_subtotal,
           total_amount, invoice_id, created_at, updated_at)
        VALUES
          (${TEST_WCB_INVOICED_ID}, ${"TEST-WCB-90002"}, ${TEST_CUSTOMER_ID},
           ${"Test WCB Customer 90001"}, ${"123 Test St"},
           ${sd}, ${"Test WCB Tech 90001"}, ${TEST_USER_ID}, ${TEST_WET_CHECK_ID},
           ${"billed"}, ${String(INVOICED_HOURS)}, ${"50.00"}, ${"150.00"}, ${"200.00"},
           ${String(INVOICED_AMOUNT)}, ${TEST_INVOICE_ID}, ${sd}, ${sd})
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function cleanupAll() {
  // Delete in FK-safe order.
  await db
    .delete(wetCheckBillingsTable)
    .where(
      inArray(wetCheckBillingsTable.id, [
        TEST_WCB_UNINVOICED_ID,
        TEST_WCB_INVOICED_ID,
      ]),
    );
  await db.delete(invoicesTable).where(eq(invoicesTable.id, TEST_INVOICE_ID));
  await db
    .delete(wetChecksTable)
    .where(eq(wetChecksTable.id, TEST_WET_CHECK_ID));
  await db
    .delete(customersTable)
    .where(eq(customersTable.id, TEST_CUSTOMER_ID));
  // Delete user last (WCBs / wet_checks reference it).
  await db.execute(
    sql`DELETE FROM users WHERE id = ${TEST_USER_ID}`,
  );
}

// ── HTTP harness ───────────────────────────────────────────────────────────
//
// Mounts the real registerFinancialPulseRoutes against a lightweight Express
// app. The stub auth middleware sets role=company_admin scoped to
// TEST_COMPANY_ID so scope checks pass and all DB queries are tenant-filtered.

async function startServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app: Express = express();
  app.use(express.json());

  const stubAuth: RequestHandler = (req, _res, next) => {
    (req as any).authenticatedUserRole = "company_admin";
    (req as any).authenticatedUserCompanyId = TEST_COMPANY_ID;
    (req as any).authenticatedUserId = TEST_USER_ID;
    next();
  };

  registerFinancialPulseRoutes(app, { requireAuthentication: stubAuth });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Financial Pulse WCB endpoint integration (Task #815)", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  before(async () => {
    await seedAll();
    const srv = await startServer();
    baseUrl = srv.baseUrl;
    closeServer = srv.close;
  });

  after(async () => {
    await closeServer();
    await cleanupAll();
  });

  // ── 1. pulse-summary: in-flight tile and per-customer/tech rows ───────────

  it("GET /api/financial-pulse/pulse-summary — uninvoiced WCB appears in inFlight total and breakdowns", async () => {
    const res = await fetch(`${baseUrl}/api/financial-pulse/pulse-summary`);
    assert.strictEqual(res.status, 200, "pulse-summary should return 200");

    const body = (await res.json()) as {
      inFlight: { value: number; customerCount: number; techCount: number };
      customers: Array<{ customerId: number; inFlight: number; ytd: number }>;
      technicians: Array<{ technicianId: number; inFlight: number; ytd: number }>;
    };

    // The global in-flight tile must include the uninvoiced WCB.
    assert.ok(
      body.inFlight.value >= UNINVOICED_AMOUNT,
      `inFlight.value (${body.inFlight.value}) must be >= ${UNINVOICED_AMOUNT} (uninvoiced WCB amount)`,
    );

    // Customer 90001 has no uninvoiced WOs or BSs — only the uninvoiced WCB.
    // So the per-customer inFlight must be exactly UNINVOICED_AMOUNT.
    const custRow = body.customers.find(
      (r) => r.customerId === TEST_CUSTOMER_ID,
    );
    assert.ok(custRow, "test customer 90001 must appear in pulse customers");
    assert.strictEqual(
      custRow.inFlight,
      UNINVOICED_AMOUNT,
      `customer inFlight must be exactly ${UNINVOICED_AMOUNT} (only the uninvoiced WCB)`,
    );

    // Tech 90001 has no uninvoiced WOs or BSs — only the uninvoiced WCB.
    // The per-tech inFlight must be exactly UNINVOICED_AMOUNT.
    const techRow = body.technicians.find(
      (r) => r.technicianId === TEST_USER_ID,
    );
    assert.ok(
      techRow,
      "test tech 90001 must appear in pulse technicians because of uninvoiced WCB",
    );
    assert.strictEqual(
      techRow.inFlight,
      UNINVOICED_AMOUNT,
      `tech inFlight must be exactly ${UNINVOICED_AMOUNT} (only the uninvoiced WCB)`,
    );
  });

  // ── 2. by-technician: invoiced WCB flows through tech revenue ─────────────

  it("GET /api/financial-pulse/by-technician — tech with only WCB work shows non-zero revenue", async () => {
    const res = await fetch(
      `${baseUrl}/api/financial-pulse/by-technician?period=mtd`,
    );
    assert.strictEqual(res.status, 200, "by-technician should return 200");

    const body = (await res.json()) as {
      rows: Array<{
        technicianId: number;
        revenue: number;
        hoursBilled: number;
        billingSheetCount: number;
        workOrderCount: number;
      }>;
    };

    // Tech 90001 must appear with revenue == INVOICED_AMOUNT (the invoice
    // linked to their WCB) and hoursBilled == INVOICED_HOURS. No other WOs
    // or BSs exist for customer 90001 / tech 90001 in company 2.
    const techRow = body.rows.find(
      (r) => r.technicianId === TEST_USER_ID,
    );
    assert.ok(
      techRow,
      "tech 90001 must appear in by-technician because of WCB linked to invoice in window",
    );
    assert.strictEqual(
      techRow.revenue,
      INVOICED_AMOUNT,
      `tech revenue must be exactly ${INVOICED_AMOUNT} (the WCB-linked invoice)`,
    );
    assert.strictEqual(
      techRow.hoursBilled,
      INVOICED_HOURS,
      `tech hoursBilled must be exactly ${INVOICED_HOURS} (from the invoiced WCB)`,
    );
  });

  // ── 3. customer/:id/summary: uninvoiced WCB in unbilledExposure ───────────

  it("GET /api/financial-pulse/customer/:id/summary — uninvoiced WCB in unbilledExposure", async () => {
    const res = await fetch(
      `${baseUrl}/api/financial-pulse/customer/${TEST_CUSTOMER_ID}/summary`,
    );
    assert.strictEqual(res.status, 200, "customer summary should return 200");

    const body = (await res.json()) as {
      customerId: number;
      unbilledExposure: number;
      billedMtd: number;
      billedYtd: number;
    };

    assert.strictEqual(body.customerId, TEST_CUSTOMER_ID);

    // Customer 90001 has no WOs or BSs — unbilledExposure comes entirely
    // from the uninvoiced WCB, so it must be exactly UNINVOICED_AMOUNT.
    assert.strictEqual(
      body.unbilledExposure,
      UNINVOICED_AMOUNT,
      `unbilledExposure must be exactly ${UNINVOICED_AMOUNT} (only the uninvoiced WCB)`,
    );

    // billedMtd = invoiced amount (invoice with status='pending', inside MTD)
    //           + uninvoiced WCB workDate addend (SEED_DATE is inside MTD)
    const expectedBilledMtd = INVOICED_AMOUNT + UNINVOICED_AMOUNT;
    assert.strictEqual(
      body.billedMtd,
      expectedBilledMtd,
      `billedMtd must be ${expectedBilledMtd} = invoice(${INVOICED_AMOUNT}) + WCB(${UNINVOICED_AMOUNT})`,
    );
    assert.strictEqual(
      body.billedYtd,
      expectedBilledMtd,
      `billedYtd must be ${expectedBilledMtd} (same data, current year)`,
    );
  });
});

// ── Slice 2: Invoice Audit Enrichment (WCB branch) ────────────────────────────
//
// Tests the wet_check_billing enrichment branch added to
// GET /api/invoices/:invoiceId/audit.
//
// Strategy: mount the *real* registerRoutes on a fresh Express app so the
// tests hit the production endpoint exactly as it runs in the API server.
// Header-based auth (x-user-role / x-user-company-id) is used — it is the
// documented dev-mode auth path in requireAuthentication and does not require
// a DB-backed session. All fixture rows are inserted into the real test DB.
// storage.getWetCheckBillingById is never mocked.

interface EnrichedItem {
  id: number;
  sourceType: string;
  sourceId: number;
  workOrderId: number | null;
  billingSheetId: number | null;
  wetCheckBillingId: number | null;
  description: string;
  status: string;
  laborTotal: number;
  partsTotal: number;
  ticketTotal: number;
  workDate: unknown;
  createdAt: string | null;
  approvedAt: string | null;
  billedAt: string | null;
  approvedLaborSnapshot: number | null;
  approvedPartsSnapshot: number | null;
}

const AUDIT_TAG = `fp-wcb-audit-${Date.now()}`;
let auditCompanyId: number;
let auditCustomerId: number;
let auditTechId: number;
let auditWcId: number;
let auditWcbId: number;
let auditInvoiceId: number;
let auditInvoiceItemId: number;
let auditBaseUrl: string;
let closeAuditServer: () => Promise<void>;

async function setupInvoiceWithWcb() {
  const companyRows = await db.execute(sql`
    INSERT INTO companies (name, subscription, is_active)
    VALUES (${`FP WCB Audit Co ${AUDIT_TAG}`}, 'basic', true)
    RETURNING id
  `);
  auditCompanyId = Number((companyRows.rows[0] as { id: number }).id);

  const customerRows = await db.execute(sql`
    INSERT INTO customers (company_id, name, email)
    VALUES (${auditCompanyId}, 'FP WCB Audit Customer', ${`fp-wcb-audit-${AUDIT_TAG}@example.com`})
    RETURNING id
  `);
  auditCustomerId = Number((customerRows.rows[0] as { id: number }).id);

  const userRows = await db.execute(sql`
    INSERT INTO users (username, password, name, role, company_id, is_active)
    VALUES (${`fp-wcb-audit-tech-${AUDIT_TAG}`}, 'hashed', 'FP WCB Audit Tech', 'field_tech', ${auditCompanyId}, true)
    RETURNING id
  `);
  auditTechId = Number((userRows.rows[0] as { id: number }).id);

  const wcRows = await db.execute(sql`
    INSERT INTO wet_checks (company_id, customer_id, technician_id, technician_name,
      customer_name, num_controllers, status, labor_mode)
    VALUES (${auditCompanyId}, ${auditCustomerId}, ${auditTechId},
      'FP WCB Audit Tech', 'FP WCB Audit Customer', 1, 'submitted', 'flat')
    RETURNING id
  `);
  auditWcId = Number((wcRows.rows[0] as { id: number }).id);

  const wcbRows = await db.execute(sql`
    INSERT INTO wet_check_billings (
      billing_number, customer_id, customer_name, property_address,
      work_date, technician_name, technician_id, wet_check_id,
      status, total_hours, labor_rate, labor_subtotal, parts_subtotal,
      total_amount, billed_at, photos
    ) VALUES (
      ${`WC-FP-AUDIT-${AUDIT_TAG}`}, ${auditCustomerId}, 'FP WCB Audit Customer', '42 Audit Ave',
      '2026-04-10T00:00:00Z', 'FP WCB Audit Tech', ${auditTechId}, ${auditWcId},
      'approved_passed_to_billing', '3.00', '80.00', '240.00', '55.00', '295.00',
      '2026-04-15T12:00:00Z', '{}'
    ) RETURNING id
  `);
  auditWcbId = Number((wcbRows.rows[0] as { id: number }).id);

  const invoiceRows = await db.execute(sql`
    INSERT INTO invoices (
      invoice_number, customer_id, company_id, customer_name, customer_email,
      invoice_month, invoice_year, period_start, period_end,
      status, parts_subtotal, labor_subtotal, total_amount
    ) VALUES (
      ${`INV-FP-AUDIT-${AUDIT_TAG}`}, ${auditCustomerId}, ${auditCompanyId},
      'FP WCB Audit Customer', ${`fp-wcb-audit-${AUDIT_TAG}@example.com`},
      4, 2026, '2026-04-01', '2026-04-30',
      'draft', '55.00', '240.00', '295.00'
    ) RETURNING id
  `);
  auditInvoiceId = Number((invoiceRows.rows[0] as { id: number }).id);

  // Invoice item with intentionally different amounts from the WCB row
  // (total_price=100, labor_total=50) — the enrichment branch must override these.
  const itemRows = await db.execute(sql`
    INSERT INTO invoice_items (
      invoice_id, source_type, source_id,
      wet_check_billing_id, work_date, description,
      total_price, labor_total
    ) VALUES (
      ${auditInvoiceId}, 'wet_check_billing', ${auditWcbId},
      ${auditWcbId}, '2026-04-10', 'original item description',
      '100.00', '50.00'
    ) RETURNING id
  `);
  auditInvoiceItemId = Number((itemRows.rows[0] as { id: number }).id);
}

describe("invoice audit — WCB enrichment branch (Slice 2)", () => {
  before(async () => {
    await setupInvoiceWithWcb();
    // Mount the real production app. registerRoutes is imported dynamically to
    // avoid tsx/esm compiling the entire 16k-line routes.ts dependency tree at
    // module-load time, which would hang the test process before any tests run.
    // The dynamic import is fast because tsx caches the compiled output.
    const { registerRoutes } = await import("./routes");
    const app: Express = express();
    app.use(express.json());
    const httpServer = await registerRoutes(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    auditBaseUrl = `http://127.0.0.1:${port}`;
    closeAuditServer = () => new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  after(async () => {
    await closeAuditServer?.();
    if (auditInvoiceItemId) {
      await db.execute(sql`DELETE FROM invoice_items WHERE id = ${auditInvoiceItemId}`);
    }
    if (auditInvoiceId) {
      await db.execute(sql`DELETE FROM invoices WHERE id = ${auditInvoiceId}`);
    }
    if (auditWcbId) {
      await db.execute(sql`DELETE FROM wet_check_billings WHERE id = ${auditWcbId}`);
    }
    if (auditWcId) {
      await db.execute(sql`DELETE FROM wet_checks WHERE id = ${auditWcId}`);
    }
    if (auditTechId) {
      await db.execute(sql`DELETE FROM users WHERE id = ${auditTechId}`);
    }
    if (auditCustomerId) {
      await db.execute(sql`DELETE FROM customers WHERE id = ${auditCustomerId}`);
    }
    if (auditCompanyId) {
      await db.execute(sql`DELETE FROM companies WHERE id = ${auditCompanyId}`);
    }
  });

  // Dev-mode header auth: billing_manager in the test company, no DB user lookup.
  // requireInvoiceRead (Task #1886) allows company_admin and billing_manager.
  // x-user-company-id scopes getInvoiceById and the tenant guard to auditCompanyId.
  function auditFetch(): Promise<Response> {
    return fetch(`${auditBaseUrl}/api/invoices/${auditInvoiceId}/audit`, {
      headers: {
        "x-user-id": "1",
        "x-user-role": "billing_manager",
        "x-user-company-id": String(auditCompanyId),
      },
    });
  }

  it("wetCheckBillingId is present and matches the WCB row on every enriched WCB item", async () => {
    const res = await auditFetch();
    assert.equal(res.status, 200, "Expected HTTP 200");
    const body = await res.json() as { invoiceId: number; items: EnrichedItem[] };
    assert.ok(Array.isArray(body.items), "items must be an array");
    assert.ok(body.items.length > 0, "items must be non-empty");
    const wcbItem = body.items.find((i) => i.sourceType === "wet_check_billing");
    assert.ok(wcbItem, "Must have at least one enriched item with sourceType='wet_check_billing'");
    assert.equal(
      wcbItem.wetCheckBillingId,
      auditWcbId,
      `wetCheckBillingId should equal ${auditWcbId}`,
    );
  });

  it("authoritative totals (ticketTotal / laborTotal / partsTotal) are sourced from the WCB row", async () => {
    const res = await auditFetch();
    assert.equal(res.status, 200, "Expected HTTP 200");
    const body = await res.json() as { invoiceId: number; items: EnrichedItem[] };
    const wcbItem = body.items.find((i) => i.sourceType === "wet_check_billing");
    assert.ok(wcbItem, "Must have at least one WCB enriched item");
    // WCB row: total_amount=295, labor_subtotal=240, parts_subtotal=55
    // Invoice item: total_price=100, labor_total=50 — must be overridden by WCB
    assert.equal(wcbItem.ticketTotal, 295, "ticketTotal must come from WCB totalAmount (295)");
    assert.equal(wcbItem.laborTotal, 240, "laborTotal must come from WCB laborSubtotal (240)");
    assert.equal(wcbItem.partsTotal, 55, "partsTotal must come from WCB partsSubtotal (55)");
  });

  it("status, description, billedAt, and workDate are sourced from the WCB row", async () => {
    const res = await auditFetch();
    assert.equal(res.status, 200, "Expected HTTP 200");
    const body = await res.json() as { invoiceId: number; items: EnrichedItem[] };
    const wcbItem = body.items.find((i) => i.sourceType === "wet_check_billing");
    assert.ok(wcbItem, "Must have at least one WCB enriched item");
    assert.equal(wcbItem.status, "approved_passed_to_billing", "status must come from WCB row");
    assert.equal(
      wcbItem.description,
      `WC-FP-AUDIT-${AUDIT_TAG}`,
      "description must be the WCB billingNumber",
    );
    assert.ok(
      typeof wcbItem.billedAt === "string" && wcbItem.billedAt.startsWith("2026-04-15"),
      "billedAt must be sourced from the WCB row (2026-04-15)",
    );
    assert.ok(
      wcbItem.workDate !== null && String(wcbItem.workDate).startsWith("2026-04-10"),
      "workDate must be sourced from the WCB row (2026-04-10)",
    );
    // Legacy WCB inserted without snapshot columns — both must be null
    assert.equal(wcbItem.approvedLaborSnapshot, null, "approvedLaborSnapshot must be null for legacy WCB without snapshots");
    assert.equal(wcbItem.approvedPartsSnapshot, null, "approvedPartsSnapshot must be null for legacy WCB without snapshots");
  });

  it("post-Slice-7 WCB: approvedLaborSnapshot and approvedPartsSnapshot are parsed numeric values when present", async () => {
    // Insert a post-Slice-7 WCB that has snapshot columns populated
    const laborSnap = JSON.stringify({ laborSubtotal: "240.00", totalHours: "3.00", appliedLaborRate: "80.00" });
    const partsSnap = JSON.stringify({ partsSubtotal: "55.00", totalAmount: "295.00" });
    const postRows = await db.execute(sql`
      INSERT INTO wet_check_billings (
        billing_number, customer_id, customer_name, property_address,
        work_date, technician_name, technician_id, wet_check_id,
        status, total_hours, labor_rate, labor_subtotal, parts_subtotal,
        total_amount, approved_labor_snapshot, approved_parts_snapshot, photos
      ) VALUES (
        ${`WC-FP-SNAP-${AUDIT_TAG}`}, ${auditCustomerId}, 'FP WCB Snap Customer', '99 Snap Ave',
        '2026-04-10T00:00:00Z', 'FP WCB Snap Tech', ${auditTechId}, ${auditWcId},
        'approved_passed_to_billing', '3.00', '80.00', '240.00', '55.00', '295.00',
        ${laborSnap}, ${partsSnap}, '{}'
      ) RETURNING id
    `);
    const postWcbId = Number((postRows.rows[0] as { id: number }).id);

    // Link it to the existing invoice via an invoice item
    const postItemRows = await db.execute(sql`
      INSERT INTO invoice_items (
        invoice_id, source_type, source_id, wet_check_billing_id,
        work_date, description, total_price, labor_total
      ) VALUES (
        ${auditInvoiceId}, 'wet_check_billing', ${postWcbId},
        ${postWcbId}, '2026-04-10', 'post-slice-7 snap item', '295.00', '240.00'
      ) RETURNING id
    `);
    const postItemId = Number((postItemRows.rows[0] as { id: number }).id);

    try {
      const res = await auditFetch();
      assert.equal(res.status, 200, "Expected HTTP 200");
      const body = await res.json() as { invoiceId: number; items: EnrichedItem[] };
      const snapItem = body.items.find(
        (i) => i.sourceType === "wet_check_billing" && i.wetCheckBillingId === postWcbId,
      );
      assert.ok(snapItem, "Must find the post-Slice-7 WCB item");
      assert.equal(snapItem.approvedLaborSnapshot, 240, "approvedLaborSnapshot must be parsed to numeric laborSubtotal (240)");
      assert.equal(snapItem.approvedPartsSnapshot, 55, "approvedPartsSnapshot must be parsed to numeric partsSubtotal (55)");
    } finally {
      await db.execute(sql`DELETE FROM invoice_items WHERE id = ${postItemId}`);
      await db.execute(sql`DELETE FROM wet_check_billings WHERE id = ${postWcbId}`);
    }
  });

  it("legacy WCB without snapshot columns returns null for both snapshot fields", async () => {
    // The existing auditWcbId WCB was inserted without snapshot columns — verify null is returned
    const res = await auditFetch();
    assert.equal(res.status, 200, "Expected HTTP 200");
    const body = await res.json() as { invoiceId: number; items: EnrichedItem[] };
    const legacyItem = body.items.find(
      (i) => i.sourceType === "wet_check_billing" && i.wetCheckBillingId === auditWcbId,
    );
    assert.ok(legacyItem, "Must find the legacy WCB item");
    assert.equal(legacyItem.approvedLaborSnapshot, null, "Legacy WCB: approvedLaborSnapshot must be null");
    assert.equal(legacyItem.approvedPartsSnapshot, null, "Legacy WCB: approvedPartsSnapshot must be null");
  });
});
