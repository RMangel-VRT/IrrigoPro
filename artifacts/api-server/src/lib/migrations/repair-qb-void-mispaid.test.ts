// Task #1848 — Tests for the repair-qb-void-mispaid-v1 migration.
//
// All tests use injectable in-memory deps — no real DB or QBO connection required.
// Covers both sentAt branches (→ 'generated' and → 'draft'), the acknowledge
// gate, the $0-without-void-marker safety guard, and no-candidates path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runRepairQbVoid,
  type RepairQbVoidDeps,
} from "./repair-qb-void-mispaid.js";

// ── In-memory state helpers ──────────────────────────────────────────────────

type MutableInvoice = {
  id: number;
  invoiceNumber: string;
  companyId: number;
  quickbooksInvoiceId: string;
  sentAt: Date | null;
  status: string;
  paymentStatus: string;
  paidAt: Date | null;
  qbVoidDetectedAt: Date | null;
};

type QbData = { Id: string; Balance: number; TotalAmt: number; PrivateNote?: string };

function makeDeps(opts: {
  candidates: MutableInvoice[];
  integration: { realmId: string; accessToken: string } | null;
  qbData: QbData[];
}): { deps: RepairQbVoidDeps; getRepaired: () => MutableInvoice[]; doneCalled: () => boolean } {
  const invoiceMap = new Map(opts.candidates.map((inv) => [inv.id, { ...inv }]));
  let doneCalled = false;
  const repairedIds: number[] = [];

  const deps: RepairQbVoidDeps = {
    getCandidates: async () =>
      opts.candidates.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        companyId: inv.companyId,
        quickbooksInvoiceId: inv.quickbooksInvoiceId,
        sentAt: inv.sentAt,
      })),

    getIntegration: async (_companyId) => opts.integration,

    fetchBalances: async (_accessToken, _realmId, _qbIds) => opts.qbData,

    applyRepair: async (invoiceId, newStatus, now) => {
      const inv = invoiceMap.get(invoiceId);
      if (!inv) throw new Error(`invoice ${invoiceId} not found`);
      inv.status = newStatus;
      inv.paymentStatus = 'unpaid';
      inv.paidAt = null;
      inv.qbVoidDetectedAt = now;
      repairedIds.push(invoiceId);
    },

    markDone: async () => { doneCalled = true; },
  };

  // getRepaired() is lazy — call it AFTER runRepairQbVoid() completes
  return {
    deps,
    getRepaired: () => repairedIds.map((id) => invoiceMap.get(id)!),
    doneCalled: () => doneCalled,
  };
}

// ── Acknowledge gate ──────────────────────────────────────────────────────────

describe("repair-qb-void-mispaid — acknowledge gate", () => {
  it("refuses to run without acknowledged=true", async () => {
    const { deps } = makeDeps({ candidates: [], integration: null, qbData: [] });
    const results = await runRepairQbVoid(deps, () => {});
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "acknowledge_gate");
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].error && results[0].error.length > 0);
  });

  it("runs when acknowledged=true", async () => {
    const { deps } = makeDeps({ candidates: [], integration: null, qbData: [] });
    const results = await runRepairQbVoid(deps, () => {}, { acknowledged: true });
    // No candidates → no_candidates step, not the gate failure
    assert.ok(results.every((r) => r.id !== "acknowledge_gate"));
  });
});

// ── sentAt branch: with sentAt → 'generated' ─────────────────────────────────

describe("repair-qb-void-mispaid — sentAt set → restores to 'generated'", () => {
  it("repairs a mis-paid invoice with sentAt to status='generated'", async () => {
    const sentInvoice: MutableInvoice = {
      id: 101,
      invoiceNumber: "INV-101",
      companyId: 1,
      quickbooksInvoiceId: "QB-101",
      sentAt: new Date("2026-01-10T12:00:00Z"),
      status: "paid",
      paymentStatus: "paid",
      paidAt: new Date("2026-01-20"),
      qbVoidDetectedAt: null,
    };

    const { deps, getRepaired, doneCalled } = makeDeps({
      candidates: [sentInvoice],
      integration: { realmId: "r1", accessToken: "t1" },
      qbData: [{ Id: "QB-101", Balance: 0, TotalAmt: 0, PrivateNote: "Voided" }],
    });

    const results = await runRepairQbVoid(deps, () => {}, { acknowledged: true });
    const repaired = getRepaired();

    const repairStep = results.find((r) => r.id === "invoice_101");
    assert.ok(repairStep, "should have a step for invoice 101");
    assert.equal(repairStep.status, "success");

    assert.equal(repaired[0].status, "generated",
      "sentAt-set invoice should be restored to 'generated' (Task #1847: retired status=sent)");
    assert.equal(repaired[0].paymentStatus, "unpaid");
    assert.equal(repaired[0].paidAt, null);
    assert.ok(repaired[0].qbVoidDetectedAt instanceof Date);

    const summary = results.find((r) => r.id === "repair_summary");
    assert.equal(summary?.status, "success");
    assert.equal(summary?.rowsAffected, 1);

    assert.ok(doneCalled(), "markDone should be called on success");
  });
});

// ── sentAt branch: without sentAt → 'draft' ──────────────────────────────────

describe("repair-qb-void-mispaid — sentAt null → restores to 'draft'", () => {
  it("repairs a mis-paid invoice without sentAt to status='draft'", async () => {
    const unsentInvoice: MutableInvoice = {
      id: 102,
      invoiceNumber: "INV-102",
      companyId: 1,
      quickbooksInvoiceId: "QB-102",
      sentAt: null,
      status: "paid",
      paymentStatus: "paid",
      paidAt: new Date("2026-01-21"),
      qbVoidDetectedAt: null,
    };

    const { deps, getRepaired } = makeDeps({
      candidates: [unsentInvoice],
      integration: { realmId: "r1", accessToken: "t1" },
      qbData: [{ Id: "QB-102", Balance: 0, TotalAmt: 0, PrivateNote: "Voided" }],
    });

    const results = await runRepairQbVoid(deps, () => {}, { acknowledged: true });
    const repaired = getRepaired();

    const repairStep = results.find((r) => r.id === "invoice_102");
    assert.ok(repairStep, "should have a step for invoice 102");
    assert.equal(repairStep.status, "success");

    assert.equal(repaired[0].status, "draft",
      "sentAt-null invoice should be restored to 'draft' (never sent)");
    assert.equal(repaired[0].paymentStatus, "unpaid");
    assert.equal(repaired[0].paidAt, null);
    assert.ok(repaired[0].qbVoidDetectedAt instanceof Date);
  });
});

// ── Safety guard: $0 without void marker ──────────────────────────────────────

describe("repair-qb-void-mispaid — $0 without void marker is not touched", () => {
  it("skips a $0 invoice that has no 'Voided' marker (legitimate $0 membership work)", async () => {
    const legitimateZero: MutableInvoice = {
      id: 103,
      invoiceNumber: "INV-103",
      companyId: 1,
      quickbooksInvoiceId: "QB-103",
      sentAt: new Date("2026-02-01"),
      status: "paid",
      paymentStatus: "paid",
      paidAt: new Date("2026-02-10"),
      qbVoidDetectedAt: null,
    };

    const { deps, getRepaired } = makeDeps({
      candidates: [legitimateZero],
      integration: { realmId: "r1", accessToken: "t1" },
      // TotalAmt=0 but no PrivateNote void marker
      qbData: [{ Id: "QB-103", Balance: 0, TotalAmt: 0, PrivateNote: "" }],
    });

    const results = await runRepairQbVoid(deps, () => {}, { acknowledged: true });

    const step = results.find((r) => r.id === "invoice_103");
    assert.equal(step?.status, "skipped", "$0 invoice without void marker must be skipped");
    assert.equal(getRepaired().length, 0, "no invoices should be repaired");
  });

  it("skips an invoice with positive TotalAmt (legitimately paid)", async () => {
    const legitPaid: MutableInvoice = {
      id: 104,
      invoiceNumber: "INV-104",
      companyId: 1,
      quickbooksInvoiceId: "QB-104",
      sentAt: new Date("2026-02-15"),
      status: "paid",
      paymentStatus: "paid",
      paidAt: new Date("2026-02-28"),
      qbVoidDetectedAt: null,
    };

    const { deps, getRepaired } = makeDeps({
      candidates: [legitPaid],
      integration: { realmId: "r1", accessToken: "t1" },
      qbData: [{ Id: "QB-104", Balance: 0, TotalAmt: 500, PrivateNote: "Voided" }],
    });

    const results = await runRepairQbVoid(deps, () => {}, { acknowledged: true });

    const step = results.find((r) => r.id === "invoice_104");
    assert.equal(step?.status, "skipped");
    assert.equal(getRepaired().length, 0);
  });
});

// ── Mixed batch (both sentAt branches in one run) ─────────────────────────────

describe("repair-qb-void-mispaid — mixed batch", () => {
  it("correctly restores both sentAt and non-sentAt invoices in one run", async () => {
    const sent: MutableInvoice = {
      id: 201,
      invoiceNumber: "INV-201",
      companyId: 10,
      quickbooksInvoiceId: "QB-201",
      sentAt: new Date("2026-03-01"),
      status: "paid",
      paymentStatus: "paid",
      paidAt: new Date("2026-03-10"),
      qbVoidDetectedAt: null,
    };
    const unsent: MutableInvoice = {
      id: 202,
      invoiceNumber: "INV-202",
      companyId: 10,
      quickbooksInvoiceId: "QB-202",
      sentAt: null,
      status: "paid",
      paymentStatus: "paid",
      paidAt: new Date("2026-03-11"),
      qbVoidDetectedAt: null,
    };

    const { deps, getRepaired, doneCalled } = makeDeps({
      candidates: [sent, unsent],
      integration: { realmId: "r1", accessToken: "t1" },
      qbData: [
        { Id: "QB-201", Balance: 0, TotalAmt: 0, PrivateNote: "Voided" },
        { Id: "QB-202", Balance: 0, TotalAmt: 0, PrivateNote: "voided by QB" },
      ],
    });

    const results = await runRepairQbVoid(deps, () => {}, { acknowledged: true });
    const repaired = getRepaired();

    const summary = results.find((r) => r.id === "repair_summary");
    assert.equal(summary?.rowsAffected, 2, "both invoices should be repaired");

    const sentResult = repaired.find((r) => r.id === 201);
    const unsentResult = repaired.find((r) => r.id === 202);

    assert.ok(sentResult, "sent invoice should appear in repaired list");
    assert.ok(unsentResult, "unsent invoice should appear in repaired list");

    assert.equal(sentResult!.status, "generated",
      "invoice with sentAt should be restored to 'generated'");
    assert.equal(unsentResult!.status, "draft",
      "invoice without sentAt should be restored to 'draft'");

    assert.ok(doneCalled(), "markDone should be called after successful batch");
  });
});

// ── No candidates path ────────────────────────────────────────────────────────

describe("repair-qb-void-mispaid — no candidates", () => {
  it("marks done and returns no_candidates step when nothing to repair", async () => {
    const { deps, doneCalled } = makeDeps({
      candidates: [],
      integration: null,
      qbData: [],
    });

    const results = await runRepairQbVoid(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "no_candidates");
    assert.equal(results[0].status, "skipped");
    assert.ok(doneCalled(), "markDone should be called even when nothing to repair");
  });
});
