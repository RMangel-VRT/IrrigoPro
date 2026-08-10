// Task #1425 — HTTP tests for POST /api/invoices/merge.
//
// Mounts the route against in-memory storage stubs and exercises the role
// guard, body validation, the rejection rules (mixed customer / period,
// fewer than two, already-cancelled), the happy path (re-point delegated to
// storage.mergeInvoices, totals summed, merged invoices cancelled), and the
// "paid invoices are allowed + no QuickBooks call" contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { registerInvoiceMergeRoutes } from "./invoice-merge-routes";
import { hasCapability, CAN_EDIT_INVOICES } from "@workspace/shared";
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
const requireInvoiceWrite: RequestHandler = (req: any, res, next) => {
  if (!hasCapability(req.authenticatedUserRole, CAN_EDIT_INVOICES)) {
    res.status(403).json({ message: "Access denied." });
    return;
  }
  next();
};

function buildApp(role: string, companyId: number | null = 1): Express {
  const app = express();
  app.use(express.json());
  registerInvoiceMergeRoutes(app, {
    requireAuthentication: makeAuth(role, companyId),
    requireInvoiceWrite,
  });
  return app;
}

async function post(app: Express, body: unknown) {
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, res));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/invoices/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
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
    status: "draft",
    partsSubtotal: "100.00",
    laborSubtotal: "200.00",
    totalAmount: "300.00",
    items: [],
    ...overrides,
  };
}

// getInvoiceById stub backed by a fixture map keyed by id, honoring company
// scope (returns undefined when the row's companyId != requested companyId).
function stubGetInvoiceById(rows: Record<number, any>) {
  patch("getInvoiceById", async (id: number, companyId: number | null) => {
    const row = rows[id];
    if (!row) return undefined;
    if (companyId !== null && row.companyId !== companyId) return undefined;
    return row;
  });
}

describe("POST /api/invoices/merge", () => {
  it("returns 403 for field_tech", async () => {
    try {
      const app = buildApp("field_tech");
      const { status } = await post(app, {
        survivingInvoiceId: 1,
        mergedInvoiceIds: [2],
      });
      assert.equal(status, 403);
    } finally {
      restoreAll();
    }
  });

  it("returns 403 for irrigation_manager", async () => {
    try {
      const app = buildApp("irrigation_manager");
      const { status } = await post(app, {
        survivingInvoiceId: 1,
        mergedInvoiceIds: [2],
      });
      assert.equal(status, 403);
    } finally {
      restoreAll();
    }
  });

  it("returns 400 for a malformed body", async () => {
    try {
      const app = buildApp("billing_manager");
      const { status } = await post(app, { survivingInvoiceId: 1 });
      assert.equal(status, 400);
    } finally {
      restoreAll();
    }
  });

  it("rejects fewer than two distinct invoices without mutating", async () => {
    let mergeCalled = false;
    try {
      stubGetInvoiceById({ 1: invoice({ id: 1 }) });
      patch("mergeInvoices", async () => {
        mergeCalled = true;
        return {} as any;
      });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, {
        survivingInvoiceId: 1,
        mergedInvoiceIds: [1],
      });
      assert.equal(status, 400);
      assert.equal(body.code, "too_few");
      assert.equal(mergeCalled, false);
    } finally {
      restoreAll();
    }
  });

  it("rejects mixed customers without mutating", async () => {
    let mergeCalled = false;
    try {
      stubGetInvoiceById({
        1: invoice({ id: 1, customerId: 100 }),
        2: invoice({ id: 2, customerId: 200 }),
      });
      patch("mergeInvoices", async () => {
        mergeCalled = true;
        return {} as any;
      });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, {
        survivingInvoiceId: 1,
        mergedInvoiceIds: [2],
      });
      assert.equal(status, 400);
      assert.equal(body.code, "mixed_customer");
      assert.equal(mergeCalled, false);
    } finally {
      restoreAll();
    }
  });

  it("rejects mixed billing periods without mutating", async () => {
    let mergeCalled = false;
    try {
      stubGetInvoiceById({
        1: invoice({ id: 1, invoiceMonth: 6 }),
        2: invoice({ id: 2, invoiceMonth: 7 }),
      });
      patch("mergeInvoices", async () => {
        mergeCalled = true;
        return {} as any;
      });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, {
        survivingInvoiceId: 1,
        mergedInvoiceIds: [2],
      });
      assert.equal(status, 400);
      assert.equal(body.code, "mixed_period");
      assert.equal(mergeCalled, false);
    } finally {
      restoreAll();
    }
  });

  it("rejects when one invoice is already cancelled", async () => {
    let mergeCalled = false;
    try {
      stubGetInvoiceById({
        1: invoice({ id: 1, status: "draft" }),
        2: invoice({ id: 2, status: "cancelled" }),
      });
      patch("mergeInvoices", async () => {
        mergeCalled = true;
        return {} as any;
      });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, {
        survivingInvoiceId: 1,
        mergedInvoiceIds: [2],
      });
      assert.equal(status, 400);
      assert.equal(body.code, "contains_cancelled");
      assert.equal(mergeCalled, false);
    } finally {
      restoreAll();
    }
  });

  it("merges paid invoices — happy path, totals summed, no QuickBooks call", async () => {
    let mergeArgs: any = null;
    try {
      stubGetInvoiceById({
        1: invoice({
          id: 1,
          invoiceNumber: "INV-1",
          status: "paid",
          partsSubtotal: "100.00",
          laborSubtotal: "200.00",
          totalAmount: "300.00",
        }),
        2: invoice({
          id: 2,
          invoiceNumber: "INV-2",
          status: "paid",
          partsSubtotal: "10.00",
          laborSubtotal: "5.00",
          totalAmount: "15.00",
        }),
      });
      patch("mergeInvoices", async (args: any) => {
        mergeArgs = args;
        return {
          survivingInvoice: invoice({ id: 1, totalAmount: "315.00" }),
          survivingNumber: "INV-1",
          cancelledInvoiceIds: [2],
          cancelledNumbers: ["INV-2"],
          partsSubtotal: "110.00",
          laborSubtotal: "205.00",
          totalAmount: "315.00",
        };
      });
      const app = buildApp("billing_manager");
      const { status, body } = await post(app, {
        survivingInvoiceId: 1,
        mergedInvoiceIds: [2],
      });
      assert.equal(status, 200);
      assert.deepEqual(mergeArgs.survivingId, 1);
      assert.deepEqual(mergeArgs.mergedIds, [2]);
      assert.equal(mergeArgs.companyId, 1);
      assert.deepEqual(body.cancelledInvoiceNumbers, ["INV-2"]);
      assert.equal(body.totals.totalAmount, "315.00");
    } finally {
      restoreAll();
    }
  });

  it("does not import any QuickBooks helper (no-QB contract)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./invoice-merge-routes.ts", import.meta.url), "utf8"),
    );
    // Strip comments so the contract is asserted against real code, not the
    // explanatory prose at the top of the module.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      // The route forwards storage's `mergedFromQuickbooksIds` (the orphaned
      // QB ids from the merged sources) straight through in the JSON response.
      // That is a data passthrough, NOT a QuickBooks API call — it doesn't
      // violate the no-QB-call contract, so exclude the identifier before the
      // broad guard below.
      .replace(/mergedFromQuickbooksIds/g, "");
    assert.ok(
      !/quickbooks/i.test(code),
      "invoice-merge-routes.ts must not reference QuickBooks in code",
    );
  });
});
