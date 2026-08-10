// Task #768 — regression guard: managers can approve submitted billing sheets
// and work_completed work orders; billing_manager callers are rejected.
//
// Mounts the REAL registerApproveRoutes() handlers (extracted from routes.ts)
// with an in-memory storage stub and a stub auth middleware so tests do not
// require a live Postgres connection. Because the real handler logic from
// approve-routes.ts is imported and exercised, any future change to the role
// guard, status check, or response shape in production WILL break these tests.
//
// Covers:
//   POST /api/billing-sheets/:id/approve        (submitted → approved_passed_to_billing)
//   POST /api/billing-sheets/:id/return-for-correction  (submitted → draft)
//   POST /api/work-orders/:id/approve           (work_completed → approved_passed_to_billing)
//   POST /api/work-orders/:id/return-for-correction     (work_completed → in_progress)
//   POST /api/wet-check-billings/:id/approve    (submitted → approved_passed_to_billing)
//   403 guard — billing_manager is rejected by billing-sheet endpoints
//   Audit trail — Task #1255: each transition emits exactly one lifecycle audit row
//     with the caller's actorRole and the expected action string.
//
// Static-source tests (Task #1255) also verify that:
//   - POST /api/invoices/monthly is guarded by requireInvoiceWrite (Task #1886)
//   - Each "mark as billed" loop in the monthly route emits a *.billed audit row

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  registerApproveRoutes,
  type ApproveRoutesStorage,
} from "./approve-routes";

// ─── Types ────────────────────────────────────────────────────────────────────

type Role =
  | "irrigation_manager"
  | "company_admin"
  | "super_admin"
  | "billing_manager"
  | "field_tech";

interface StoredBillingSheet {
  id: number;
  status: string;
  partsSubtotal: string;
  totalHours: string;
  laborRate: string;
  laborSubtotal: string;
  totalAmount: string;
  notes: string | null;
  [key: string]: unknown;
}

interface StoredWorkOrder {
  id: number;
  workOrderNumber: string;
  status: string;
  partsSubtotal: string;
  totalHours: string;
  laborRate: string;
  appliedLaborRate?: string;
  laborSubtotal: string;
  totalAmount: string;
  notes: string | null;
  [key: string]: unknown;
}

// ─── Harness ──────────────────────────────────────────────────────────────────

interface StoredWetCheckBilling {
  id: number;
  status: string;
  partsSubtotal: string;
  totalHours: string;
  laborRate: string;
  appliedLaborRate?: string;
  laborSubtotal: string;
  totalAmount: string;
  [key: string]: unknown;
}

interface AuditCall {
  action: string;
  before: unknown;
  after: unknown;
  actorRole: string | null;
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  billingSheets: Map<number, StoredBillingSheet>;
  workOrders: Map<number, StoredWorkOrder>;
  wetCheckBillings: Map<number, StoredWetCheckBilling>;
  auditCalls: AuditCall[];
  setRole: (role: Role) => void;
}

async function startHarness(initialRole: Role = "irrigation_manager"): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());

  let currentRole: Role = initialRole;

  // ── Seed data ───────────────────────────────────────────────────────────────
  const billingSheets = new Map<number, StoredBillingSheet>([
    [1, { id: 1, status: "submitted",              partsSubtotal: "100.00", totalHours: "2.00", laborRate: "75.00", laborSubtotal: "150.00", totalAmount: "250.00", notes: null }],
    [2, { id: 2, status: "pending_manager_review", partsSubtotal: "50.00",  totalHours: "1.00", laborRate: "75.00", laborSubtotal: "75.00",  totalAmount: "125.00", notes: null }],
    [3, { id: 3, status: "draft",                  partsSubtotal: "0.00",   totalHours: "0.00", laborRate: "75.00", laborSubtotal: "0.00",   totalAmount: "0.00",   notes: null }],
  ]);

  const workOrders = new Map<number, StoredWorkOrder>([
    [10, { id: 10, workOrderNumber: "WO-0010", status: "work_completed",       partsSubtotal: "200.00", totalHours: "3.00", laborRate: "80.00", laborSubtotal: "240.00", totalAmount: "440.00", notes: null }],
    [11, { id: 11, workOrderNumber: "WO-0011", status: "pending_manager_review", partsSubtotal: "60.00", totalHours: "1.50", laborRate: "80.00", laborSubtotal: "120.00", totalAmount: "180.00", notes: null }],
    [12, { id: 12, workOrderNumber: "WO-0012", status: "in_progress",           partsSubtotal: "0.00",  totalHours: "0.00", laborRate: "80.00", laborSubtotal: "0.00",   totalAmount: "0.00",   notes: null }],
  ]);

  const wetCheckBillings = new Map<number, StoredWetCheckBilling>([
    [20, { id: 20, status: "submitted",              partsSubtotal: "80.00",  totalHours: "1.00", laborRate: "75.00", laborSubtotal: "75.00",  totalAmount: "155.00" }],
    [21, { id: 21, status: "pending_manager_review", partsSubtotal: "40.00",  totalHours: "0.50", laborRate: "75.00", laborSubtotal: "37.50",  totalAmount: "77.50"  }],
    [22, { id: 22, status: "draft",                  partsSubtotal: "0.00",   totalHours: "0.00", laborRate: "75.00", laborSubtotal: "0.00",   totalAmount: "0.00"   }],
  ]);

  // ── Storage stub ─────────────────────────────────────────────────────────────
  // Satisfies ApproveRoutesStorage so the REAL handler logic runs against it.
  const storage: ApproveRoutesStorage = {
    async getBillingSheetById(id, _companyId) {
      return billingSheets.get(id);
    },
    async updateBillingSheet(id, data) {
      const existing = billingSheets.get(id);
      if (!existing) throw new Error(`billing sheet ${id} not found`);
      const updated = { ...existing, ...data } as StoredBillingSheet;
      billingSheets.set(id, updated);
      return updated;
    },
    async getWorkOrder(id, _companyId) {
      return workOrders.get(id);
    },
    async updateWorkOrder(id, data) {
      const existing = workOrders.get(id);
      if (!existing) throw new Error(`work order ${id} not found`);
      const updated = { ...existing, ...data } as StoredWorkOrder;
      workOrders.set(id, updated);
      return updated;
    },
    async getWetCheckBillingById(id, _companyId) {
      return wetCheckBillings.get(id);
    },
    async updateWetCheckBilling(id, data) {
      const existing = wetCheckBillings.get(id);
      if (!existing) return {};
      const updated = { ...existing, ...data } as StoredWetCheckBilling;
      wetCheckBillings.set(id, updated);
      return updated;
    },
    async getUser(_id) {
      return { name: "Alice Manager" };
    },
  };

  // ── Stub auth middleware ─────────────────────────────────────────────────────
  const stubAuth: RequestHandler = (req: any, _res, next) => {
    req.authenticatedUserId = 7;
    req.authenticatedUserRole = currentRole;
    req.authenticatedUserCompanyId = 1;
    next();
  };

  // ── Audit spy ────────────────────────────────────────────────────────────────
  // Captures action, before/after state, and actorRole (read from req at emit time).
  const auditCalls: AuditCall[] = [];

  // ── Mount REAL handlers ───────────────────────────────────────────────────────
  registerApproveRoutes(app, storage, stubAuth, {
    recordLifecycleAudit: async (req, opts) => {
      auditCalls.push({
        action: opts.action,
        before: opts.before,
        after: opts.after,
        actorRole: (req as any)?.authenticatedUserRole ?? null,
      });
    },
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    billingSheets,
    workOrders,
    wetCheckBillings,
    auditCalls,
    setRole: (role) => { currentRole = role; },
  };
}

// ─── Billing sheet: approve ───────────────────────────────────────────────────

describe("POST /api/billing-sheets/:id/approve — Task #768 (real handler)", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness("irrigation_manager"); });
  afterEach(async () => { await h.close(); });

  it("irrigation_manager approving a submitted sheet → 200 + approved_passed_to_billing", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.billingSheet.status, "approved_passed_to_billing");
    assert.ok(body.billingSheet.approvedAt, "approvedAt must be set");
    assert.equal(body.billingSheet.approvedTotal, "250.00");
    assert.equal(body.billingSheet.approvedBy, "Alice Manager");
  });

  it("in-memory store is updated — re-reading the sheet reflects the new status", async () => {
    await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    const sheet = h.billingSheets.get(1);
    assert.equal(sheet?.status, "approved_passed_to_billing");
  });

  it("irrigation_manager approving a pending_manager_review sheet → 200 + approved_passed_to_billing", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/2/approve`, { method: "POST" });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.billingSheet.status, "approved_passed_to_billing");
  });

  it("company_admin can approve a submitted sheet → 200", async () => {
    h.setRole("company_admin");
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.billingSheet.status, "approved_passed_to_billing");
  });

  it("super_admin can approve a submitted sheet → 200", async () => {
    h.setRole("super_admin");
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(res.status, 200);
  });

  it("billing_manager is rejected with 403", async () => {
    h.setRole("billing_manager");
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    const body = await res.json() as any;
    assert.match(String(body.message), /irrigation manager/i);
  });

  it("field_tech is rejected with 403", async () => {
    h.setRole("field_tech");
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(res.status, 403);
  });

  it("billing_manager rejection leaves the sheet status unchanged", async () => {
    h.setRole("billing_manager");
    await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(h.billingSheets.get(1)?.status, "submitted", "sheet must not be mutated on 403");
  });

  it("draft sheet cannot be approved — returns 400 with informative message", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/3/approve`, { method: "POST" });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(String(body.message), /submitted/i);
  });

  it("unknown billing sheet id → 404", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/9999/approve`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("approvedPartsSnapshot and approvedLaborSnapshot are written and correctly shaped", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    const body = await res.json() as any;
    const parts = JSON.parse(body.billingSheet.approvedPartsSnapshot);
    const labor = JSON.parse(body.billingSheet.approvedLaborSnapshot);
    assert.equal(parts.partsSubtotal, "100.00");
    assert.equal(labor.totalHours, "2.00");
    assert.equal(labor.laborRate, "75.00");
    assert.equal(labor.laborSubtotal, "150.00");
  });
});

// ─── Billing sheet: return-for-correction ────────────────────────────────────

describe("POST /api/billing-sheets/:id/return-for-correction — Task #768 (real handler)", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness("irrigation_manager"); });
  afterEach(async () => { await h.close(); });

  it("irrigation_manager returning a submitted sheet → 200 + draft, notes appended", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/return-for-correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "Missing zone 4 readings" }),
    });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.billingSheet.status, "draft");
    assert.match(String(body.billingSheet.notes), /Missing zone 4 readings/);
    assert.match(String(body.billingSheet.notes), /Returned for correction/);
  });

  it("in-memory store is updated to draft after return-for-correction", async () => {
    await fetch(`${h.baseUrl}/api/billing-sheets/1/return-for-correction`, { method: "POST" });
    assert.equal(h.billingSheets.get(1)?.status, "draft");
  });

  it("irrigation_manager returning a pending_manager_review sheet → 200 + draft", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/2/return-for-correction`, {
      method: "POST",
    });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.billingSheet.status, "draft");
  });

  it("no notes body → status still flips to draft, notes field stays null", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/return-for-correction`, {
      method: "POST",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.billingSheet.status, "draft");
    assert.equal(body.billingSheet.notes, null);
  });

  it("billing_manager is rejected with 403", async () => {
    h.setRole("billing_manager");
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/1/return-for-correction`, {
      method: "POST",
    });
    assert.equal(res.status, 403);
  });

  it("wrong starting status (draft) → 400 with informative message", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/3/return-for-correction`, {
      method: "POST",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(String(body.message), /submitted/i);
  });

  it("unknown billing sheet id → 404", async () => {
    const res = await fetch(`${h.baseUrl}/api/billing-sheets/9999/return-for-correction`, {
      method: "POST",
    });
    assert.equal(res.status, 404);
  });
});

// ─── Work order: approve ──────────────────────────────────────────────────────

describe("POST /api/work-orders/:id/approve — Task #768 (real handler)", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness("irrigation_manager"); });
  afterEach(async () => { await h.close(); });

  it("irrigation_manager approving a work_completed order → 200 + approved_passed_to_billing", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.workOrder.status, "approved_passed_to_billing");
    assert.ok(body.workOrder.approvedAt, "approvedAt must be set");
    assert.equal(body.workOrder.approvedTotal, "440.00");
    assert.equal(body.workOrder.approvedBy, "Alice Manager");
  });

  it("in-memory store is updated — status flips to approved_passed_to_billing", async () => {
    await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    assert.equal(h.workOrders.get(10)?.status, "approved_passed_to_billing");
  });

  it("work_order.approved lifecycle audit row is emitted", async () => {
    await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    assert.equal(h.auditCalls.length, 1, "expected exactly one audit call");
    const call = h.auditCalls[0]!;
    assert.equal(call.action, "work_order.approved");
    assert.deepEqual(call.before, { status: "work_completed" });
    assert.deepEqual(call.after, { status: "approved_passed_to_billing" });
  });

  it("irrigation_manager approving a pending_manager_review order → 200", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/11/approve`, { method: "POST" });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.workOrder.status, "approved_passed_to_billing");
  });

  it("company_admin can approve a work_completed order → 200", async () => {
    h.setRole("company_admin");
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.workOrder.status, "approved_passed_to_billing");
  });

  it("super_admin can approve a work_completed order → 200", async () => {
    h.setRole("super_admin");
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    assert.equal(res.status, 200);
  });

  it("billing_manager is rejected with 403", async () => {
    h.setRole("billing_manager");
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    const body = await res.json() as any;
    assert.match(String(body.message), /irrigation manager/i);
  });

  it("field_tech is rejected with 403", async () => {
    h.setRole("field_tech");
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    assert.equal(res.status, 403);
  });

  it("billing_manager rejection leaves the work order status unchanged", async () => {
    h.setRole("billing_manager");
    await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    assert.equal(h.workOrders.get(10)?.status, "work_completed", "order must not be mutated on 403");
  });

  it("in_progress order cannot be approved — returns 400 with informative message", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/12/approve`, { method: "POST" });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(String(body.message), /work completed/i);
  });

  it("unknown work order id → 404", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/9999/approve`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("approvedPartsSnapshot and approvedLaborSnapshot are written and correctly shaped", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/approve`, { method: "POST" });
    const body = await res.json() as any;
    const parts = JSON.parse(body.workOrder.approvedPartsSnapshot);
    const labor = JSON.parse(body.workOrder.approvedLaborSnapshot);
    assert.equal(parts.partsSubtotal, "200.00");
    assert.equal(labor.totalHours, "3.00");
    assert.equal(labor.laborRate, "80.00");
    assert.equal(labor.laborSubtotal, "240.00");
  });
});

// ─── Work order: return-for-correction ────────────────────────────────────────

describe("POST /api/work-orders/:id/return-for-correction — Task #768 (real handler)", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness("irrigation_manager"); });
  afterEach(async () => { await h.close(); });

  it("irrigation_manager returning a work_completed order → 200 + in_progress, notes appended", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/return-for-correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "Head 3 reading missing" }),
    });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.workOrder.status, "in_progress");
    assert.match(String(body.workOrder.notes), /Head 3 reading missing/);
    assert.match(String(body.workOrder.notes), /Returned for correction/);
  });

  it("in-memory store is updated to in_progress after return-for-correction", async () => {
    await fetch(`${h.baseUrl}/api/work-orders/10/return-for-correction`, { method: "POST" });
    assert.equal(h.workOrders.get(10)?.status, "in_progress");
  });

  it("work_order.returned_for_correction lifecycle audit row is emitted with note", async () => {
    await fetch(`${h.baseUrl}/api/work-orders/10/return-for-correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "Fix zone 2" }),
    });
    assert.equal(h.auditCalls.length, 1, "expected exactly one audit call");
    const call = h.auditCalls[0]!;
    assert.equal(call.action, "work_order.returned_for_correction");
    assert.deepEqual(call.before, { status: "work_completed" });
    assert.deepEqual(call.after, { status: "in_progress" });
  });

  it("irrigation_manager returning a pending_manager_review order → 200 + in_progress", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/11/return-for-correction`, {
      method: "POST",
    });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.workOrder.status, "in_progress");
  });

  it("no notes body → status still flips to in_progress, notes stays null", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/return-for-correction`, {
      method: "POST",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.workOrder.status, "in_progress");
    assert.equal(body.workOrder.notes, null);
  });

  it("billing_manager is rejected with 403", async () => {
    h.setRole("billing_manager");
    const res = await fetch(`${h.baseUrl}/api/work-orders/10/return-for-correction`, {
      method: "POST",
    });
    assert.equal(res.status, 403);
  });

  it("wrong starting status (in_progress) → 400 with informative message", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/12/return-for-correction`, {
      method: "POST",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(String(body.message), /work completed/i);
  });

  it("unknown work order id → 404", async () => {
    const res = await fetch(`${h.baseUrl}/api/work-orders/9999/return-for-correction`, {
      method: "POST",
    });
    assert.equal(res.status, 404);
  });
});

// ─── Task #1255 — Billing sheet audit trail ───────────────────────────────────

describe("POST /api/billing-sheets/:id/approve — lifecycle audit (Task #1255)", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness("irrigation_manager"); });
  afterEach(async () => { await h.close(); });

  it("emits exactly one billing_sheet.approved audit row", async () => {
    await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(h.auditCalls.length, 1, "expected exactly one audit call");
    const call = h.auditCalls[0]!;
    assert.equal(call.action, "billing_sheet.approved");
    assert.deepEqual(call.before, { status: "submitted" });
    assert.deepEqual(call.after, { status: "approved_passed_to_billing" });
  });

  it("audit row carries the caller's actorRole (irrigation_manager)", async () => {
    await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(h.auditCalls[0]!.actorRole, "irrigation_manager");
  });

  it("actorRole is company_admin when that role approves", async () => {
    h.setRole("company_admin");
    await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(h.auditCalls[0]!.actorRole, "company_admin");
  });

  it("no audit row is emitted on 403 (billing_manager rejected)", async () => {
    h.setRole("billing_manager");
    await fetch(`${h.baseUrl}/api/billing-sheets/1/approve`, { method: "POST" });
    assert.equal(h.auditCalls.length, 0, "no audit row must be written on rejected request");
  });

  it("no audit row is emitted on 400 (wrong starting status)", async () => {
    await fetch(`${h.baseUrl}/api/billing-sheets/3/approve`, { method: "POST" });
    assert.equal(h.auditCalls.length, 0, "no audit row must be written on status validation failure");
  });
});

describe("POST /api/billing-sheets/:id/return-for-correction — lifecycle audit (Task #1255)", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness("irrigation_manager"); });
  afterEach(async () => { await h.close(); });

  it("emits exactly one billing_sheet.returned_for_correction audit row", async () => {
    await fetch(`${h.baseUrl}/api/billing-sheets/1/return-for-correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "Needs zone 4" }),
    });
    assert.equal(h.auditCalls.length, 1, "expected exactly one audit call");
    const call = h.auditCalls[0]!;
    assert.equal(call.action, "billing_sheet.returned_for_correction");
    assert.deepEqual(call.before, { status: "submitted" });
    assert.deepEqual(call.after, { status: "draft" });
  });

  it("audit row carries the caller's actorRole", async () => {
    await fetch(`${h.baseUrl}/api/billing-sheets/1/return-for-correction`, { method: "POST" });
    assert.equal(h.auditCalls[0]!.actorRole, "irrigation_manager");
  });

  it("no audit row on billing_manager rejection", async () => {
    h.setRole("billing_manager");
    await fetch(`${h.baseUrl}/api/billing-sheets/1/return-for-correction`, { method: "POST" });
    assert.equal(h.auditCalls.length, 0);
  });
});

// ─── Task #1255 — WCB audit trail ────────────────────────────────────────────

describe("POST /api/wet-check-billings/:id/approve — basic (Task #1255)", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness("irrigation_manager"); });
  afterEach(async () => { await h.close(); });

  it("irrigation_manager approving a submitted WCB → 200 + approved_passed_to_billing", async () => {
    const res = await fetch(`${h.baseUrl}/api/wet-check-billings/20/approve`, { method: "POST" });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.wetCheckBilling.status, "approved_passed_to_billing");
  });

  it("in-memory store is updated after WCB approve", async () => {
    await fetch(`${h.baseUrl}/api/wet-check-billings/20/approve`, { method: "POST" });
    assert.equal(h.wetCheckBillings.get(20)?.status, "approved_passed_to_billing");
  });

  it("emits exactly one wet_check_billing.approved audit row", async () => {
    await fetch(`${h.baseUrl}/api/wet-check-billings/20/approve`, { method: "POST" });
    assert.equal(h.auditCalls.length, 1, "expected exactly one audit call");
    const call = h.auditCalls[0]!;
    assert.equal(call.action, "wet_check_billing.approved");
    assert.deepEqual(call.before, { status: "submitted" });
    assert.deepEqual(call.after, { status: "approved_passed_to_billing" });
  });

  it("audit row carries the caller's actorRole (irrigation_manager)", async () => {
    await fetch(`${h.baseUrl}/api/wet-check-billings/20/approve`, { method: "POST" });
    assert.equal(h.auditCalls[0]!.actorRole, "irrigation_manager");
  });

  it("billing_manager can also approve a WCB → 200 with billing_manager actorRole", async () => {
    h.setRole("billing_manager");
    const res = await fetch(`${h.baseUrl}/api/wet-check-billings/20/approve`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(h.auditCalls[0]!.actorRole, "billing_manager");
  });

  it("field_tech cannot approve a WCB → 403, no audit row", async () => {
    h.setRole("field_tech");
    const res = await fetch(`${h.baseUrl}/api/wet-check-billings/20/approve`, { method: "POST" });
    assert.equal(res.status, 403);
    assert.equal(h.auditCalls.length, 0);
  });

  it("wrong starting status (draft) → 400, no audit row", async () => {
    const res = await fetch(`${h.baseUrl}/api/wet-check-billings/22/approve`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.equal(h.auditCalls.length, 0);
  });

  it("pending_manager_review WCB → 200 + audit row", async () => {
    const res = await fetch(`${h.baseUrl}/api/wet-check-billings/21/approve`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(h.auditCalls[0]!.action, "wet_check_billing.approved");
  });

  it("unknown WCB id → 404, no audit row", async () => {
    const res = await fetch(`${h.baseUrl}/api/wet-check-billings/9999/approve`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.equal(h.auditCalls.length, 0);
  });
});

// ─── Task #1255 — Monthly invoice: role guard and billed audit (static-source) ─

{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const routesPath = path.join(__dirname, "routes.ts");
  const src = fs.readFileSync(routesPath, "utf8");

  const monthlyStart = src.indexOf('app.post("/api/invoices/monthly"');
  const nextRoute = src.indexOf("\n  app.", monthlyStart + 1);
  const monthlySrc = nextRoute === -1 ? src.slice(monthlyStart) : src.slice(monthlyStart, nextRoute);

  describe("POST /api/invoices/monthly — role guard (Task #1255)", () => {
    // Task #1886 — was requireBillingAccess; generating monthly invoices is an
    // invoice mutation, so it is write-classified. Membership is unchanged.
    it("requireInvoiceWrite guard is wired between requireAuthentication and the async handler", () => {
      assert.match(
        monthlySrc,
        /requireAuthentication,\s*requireInvoiceWrite,\s*async/,
        "requireInvoiceWrite must appear between requireAuthentication and async in the monthly route",
      );
    });
  });

  describe("POST /api/invoices/monthly — billed audit emissions (Task #1255)", () => {
    it("work_order.billed lifecycle audit is emitted inside the work-orders billed loop", () => {
      // Locate the "mark as billed" section that starts after QuickBooks succeeds
      const billedSection = monthlySrc.slice(monthlySrc.indexOf("QuickBooks succeeded"));
      assert.match(
        billedSection,
        /work_order\.billed/,
        "work_order.billed action must be referenced in the monthly billing loop",
      );
    });

    it("billing_sheet.billed lifecycle audit is emitted inside the billing-sheets billed loop", () => {
      const billedSection = monthlySrc.slice(monthlySrc.indexOf("QuickBooks succeeded"));
      assert.match(
        billedSection,
        /billing_sheet\.billed/,
        "billing_sheet.billed action must be referenced in the monthly billing loop",
      );
    });

    it("wet_check_billing.billed lifecycle audit is emitted inside the WCB billed loop", () => {
      const billedSection = monthlySrc.slice(monthlySrc.indexOf("QuickBooks succeeded"));
      assert.match(
        billedSection,
        /wet_check_billing\.billed/,
        "wet_check_billing.billed action must be referenced in the monthly billing loop",
      );
    });

    it("all three billed audit calls include invoiceId and invoiceNumber in extra payload", () => {
      const billedSection = monthlySrc.slice(monthlySrc.indexOf("QuickBooks succeeded"));
      assert.match(billedSection, /invoiceId.*invoice\.id|invoice\.id.*invoiceId/, "invoiceId must be in the extra payload");
      assert.match(billedSection, /invoiceNumber.*invoice\.invoiceNumber|invoice\.invoiceNumber.*invoiceNumber/, "invoiceNumber must be in the extra payload");
    });
  });
}
