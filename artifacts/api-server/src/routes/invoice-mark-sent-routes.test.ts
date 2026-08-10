// Task #1847 — HTTP tests for POST /api/invoices/:id/mark-sent and
// POST /api/invoices/:id/mark-unsent after the sent-ness / lifecycle decoupling.
//
// Covers:
//   (a) mark-sent on a `paid` invoice succeeds and stamps sentAt (leaves status=paid)
//   (b) mark-sent on an already-sent invoice (sentAt set) is rejected; original timestamp preserved
//   (c) mark-sent on terminal statuses (cancelled, superseded, merged) is rejected
//   (d) mark-unsent clears sentAt and leaves status untouched (including on a paid invoice)
//   (e) company isolation on both routes
//   (f) role guards (field_tech / irrigation_manager → 403)
//   (g) invalid id → 400

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { registerInvoiceMarkSentRoutes } from "./invoice-mark-sent-routes";
import { hasCapability, CAN_EDIT_INVOICES, CAN_SEND_INVOICE_EMAIL, type Capability } from "@workspace/shared";
import { storage } from "../storage";

const ORIG: Record<string, any> = {};
function patch(name: string, impl: any) {
  if (!(name in ORIG)) ORIG[name] = (storage as any)[name];
  (storage as any)[name] = impl;
}
function restoreAll() {
  for (const k of Object.keys(ORIG)) (storage as any)[k] = ORIG[k];
  for (const k of Object.keys(ORIG)) delete ORIG[k];
}

function makeAuth(role: string, companyId: number | null = 1): RequestHandler {
  return (req: any, _res, next) => {
    req.authenticatedUserRole = role;
    req.authenticatedUserId = 7;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
}

// Task #1886 — guards are backed by the real capability sets from the role
// registry rather than a hand-copied mirror of the middleware, so a change to
// membership shows up here instead of silently drifting.
function capabilityGuard(capability: Capability): RequestHandler {
  return (req: any, res, next) => {
    if (!hasCapability(req.authenticatedUserRole, capability)) {
      res.status(403).json({ message: "Access denied." });
      return;
    }
    next();
  };
}
const requireInvoiceSend = capabilityGuard(CAN_SEND_INVOICE_EMAIL);
const requireInvoiceWrite = capabilityGuard(CAN_EDIT_INVOICES);

function buildApp(role: string, companyId: number | null = 1): Express {
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
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, res));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    let body: Record<string, any> = {};
    try {
      body = (await r.json()) as Record<string, any>;
    } catch {
      body = {};
    }
    return { status: r.status, body };
  } finally {
    server.close();
  }
}

function invoice(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    invoiceNumber: "INV-1",
    customerId: 100,
    companyId: 1,
    invoiceMonth: 6,
    invoiceYear: 2026,
    status: "generated",
    sentAt: null,
    partsSubtotal: "100.00",
    laborSubtotal: "200.00",
    totalAmount: "300.00",
    items: [],
    ...overrides,
  };
}

// getInvoiceById stub honoring company scope; updateInvoice stub records the
// last patch and returns the merged row.
function stubStorage(rows: Record<number, any>) {
  const calls: { id: number; patch: any }[] = [];
  patch("getInvoiceById", async (id: number, companyId: number | null) => {
    const row = rows[id];
    if (!row) return undefined;
    if (companyId !== null && row.companyId !== companyId) return undefined;
    return row;
  });
  patch("updateInvoice", async (id: number, p: any) => {
    calls.push({ id, patch: p });
    rows[id] = { ...rows[id], ...p };
    return rows[id];
  });
  return calls;
}

// ── POST /api/invoices/:id/mark-sent ─────────────────────────────────────────

describe("POST /api/invoices/:id/mark-sent", () => {
  it("returns 403 for field_tech (and never touches storage)", async () => {
    try {
      const calls = stubStorage({ 1: invoice() });
      const app = buildApp("field_tech");
      const { status } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 403);
      assert.equal(calls.length, 0);
    } finally {
      restoreAll();
    }
  });

  it("returns 403 for irrigation_manager", async () => {
    try {
      stubStorage({ 1: invoice() });
      const app = buildApp("irrigation_manager");
      const { status } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 403);
    } finally {
      restoreAll();
    }
  });

  it("(a) mark-sent on a generated invoice stamps sentAt without touching status", async () => {
    try {
      const calls = stubStorage({ 1: invoice({ status: "generated" }) });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 200);
      // status must not be changed by mark-sent
      assert.equal(body.status, "generated");
      assert.equal(calls.length, 1);
      // patch must only include sentAt — no status change
      assert.equal(calls[0].patch.status, undefined, "mark-sent must not write status");
      assert.ok(calls[0].patch.sentAt instanceof Date);
    } finally {
      restoreAll();
    }
  });

  it("(a) mark-sent on a PAID invoice succeeds and stamps sentAt, leaves status=paid", async () => {
    try {
      const calls = stubStorage({ 1: invoice({ status: "paid", sentAt: null }) });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 200);
      assert.equal(body.status, "paid", "status must remain paid after mark-sent");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].patch.status, undefined, "mark-sent must not write status");
      assert.ok(calls[0].patch.sentAt instanceof Date);
    } finally {
      restoreAll();
    }
  });

  it("(b) mark-sent on already-sent invoice (sentAt set) is rejected; original timestamp preserved", async () => {
    try {
      const originalSentAt = new Date("2026-05-01T10:00:00.000Z");
      const calls = stubStorage({
        1: invoice({ status: "generated", sentAt: originalSentAt }),
      });
      const app = buildApp("billing_manager");
      const { status } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 400);
      // Must not touch storage
      assert.equal(calls.length, 0);
    } finally {
      restoreAll();
    }
  });

  it("(c) mark-sent on terminal status 'cancelled' is rejected", async () => {
    try {
      const calls = stubStorage({ 1: invoice({ status: "cancelled", sentAt: null }) });
      const app = buildApp("company_admin");
      const { status } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 400);
      assert.equal(calls.length, 0);
    } finally {
      restoreAll();
    }
  });

  it("(c) mark-sent on terminal status 'superseded' is rejected", async () => {
    try {
      const calls = stubStorage({ 1: invoice({ status: "superseded", sentAt: null }) });
      const app = buildApp("company_admin");
      const { status } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 400);
      assert.equal(calls.length, 0);
    } finally {
      restoreAll();
    }
  });

  it("(c) mark-sent on terminal status 'merged' is rejected", async () => {
    try {
      const calls = stubStorage({ 1: invoice({ status: "merged", sentAt: null }) });
      const app = buildApp("company_admin");
      const { status } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 400);
      assert.equal(calls.length, 0);
    } finally {
      restoreAll();
    }
  });

  it("(e) returns 404 for a cross-tenant invoice (company isolation)", async () => {
    try {
      stubStorage({ 1: invoice({ companyId: 999 }) });
      const app = buildApp("billing_manager", 1);
      const { status } = await post(app, "/api/invoices/1/mark-sent");
      assert.equal(status, 404);
    } finally {
      restoreAll();
    }
  });

  it("(g) returns 400 for an invalid id", async () => {
    try {
      stubStorage({});
      const app = buildApp("billing_manager");
      const { status } = await post(app, "/api/invoices/0/mark-sent");
      assert.equal(status, 400);
    } finally {
      restoreAll();
    }
  });
});

// ── POST /api/invoices/:id/mark-unsent ────────────────────────────────────────

describe("POST /api/invoices/:id/mark-unsent", () => {
  it("returns 403 for field_tech", async () => {
    try {
      stubStorage({ 1: invoice({ status: "generated", sentAt: new Date() }) });
      const app = buildApp("field_tech");
      const { status } = await post(app, "/api/invoices/1/mark-unsent");
      assert.equal(status, 403);
    } finally {
      restoreAll();
    }
  });

  it("(d) mark-unsent clears sentAt and leaves status unchanged (generated)", async () => {
    try {
      const calls = stubStorage({
        1: invoice({ status: "generated", sentAt: new Date() }),
      });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, "/api/invoices/1/mark-unsent");
      assert.equal(status, 200);
      assert.equal(body.status, "generated");
      assert.equal(calls.length, 1);
      // patch must not include status
      assert.equal(calls[0].patch.status, undefined, "mark-unsent must not write status");
      assert.equal(calls[0].patch.sentAt, null);
    } finally {
      restoreAll();
    }
  });

  it("(d) mark-unsent clears sentAt on a PAID invoice, leaves status=paid", async () => {
    try {
      const calls = stubStorage({
        1: invoice({ status: "paid", sentAt: new Date() }),
      });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, "/api/invoices/1/mark-unsent");
      assert.equal(status, 200);
      assert.equal(body.status, "paid", "status must remain paid after mark-unsent");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].patch.status, undefined, "mark-unsent must not write status");
      assert.equal(calls[0].patch.sentAt, null);
    } finally {
      restoreAll();
    }
  });

  it("(d) mark-unsent on an invoice with sentAt=null is rejected (no write)", async () => {
    try {
      const calls = stubStorage({ 1: invoice({ status: "generated", sentAt: null }) });
      const app = buildApp("company_admin");
      const { status } = await post(app, "/api/invoices/1/mark-unsent");
      assert.equal(status, 400);
      assert.equal(calls.length, 0);
    } finally {
      restoreAll();
    }
  });

  it("(c) mark-unsent on terminal status is rejected (no write)", async () => {
    for (const st of ["cancelled", "superseded", "merged"]) {
      try {
        const calls = stubStorage({ 1: invoice({ status: st, sentAt: new Date() }) });
        const app = buildApp("company_admin");
        const { status } = await post(app, "/api/invoices/1/mark-unsent");
        assert.equal(status, 400, `expected 400 for status=${st}`);
        assert.equal(calls.length, 0);
      } finally {
        restoreAll();
      }
    }
  });

  it("(e) returns 404 for a cross-tenant invoice (company isolation)", async () => {
    try {
      stubStorage({ 1: invoice({ companyId: 999, sentAt: new Date() }) });
      const app = buildApp("billing_manager", 1);
      const { status } = await post(app, "/api/invoices/1/mark-unsent");
      assert.equal(status, 404);
    } finally {
      restoreAll();
    }
  });
});
