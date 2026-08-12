// Task #1934 — Tests for the repair-woodglenn-wo-hours-v1 migration.
//
// All tests use injectable in-memory deps — no real DB required.
//
// The runner enforces:
//   1. Acknowledge gate (no writes without acknowledged=true)
//   2. All-or-nothing preflight (any failure blocks ALL writes)
//   3. Zero-rows-affected guard (concurrent modification → fail + no markDone)
//   4. Idempotency (rows already at correctHours → skip, markDone still called)
//
// The production `run()` additionally wraps updates in a DB transaction with
// row-locking and conditional WHERE guards — those guarantees are at the DB
// layer and are not repeated here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runRepairWoodglennWoHours,
  type RepairWoodglennDeps,
  type WoCandidateRow,
} from "./repair-woodglenn-wo-hours.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const WO_314 = 'WO-1783955816671-314';
const WO_62  = 'WO-1783955809401-62';

function makeRow(overrides: Partial<WoCandidateRow> & { workOrderNumber: string }): WoCandidateRow {
  const defaults: Record<string, WoCandidateRow> = {
    [WO_314]: {
      workOrderNumber: WO_314,
      companyId: 1,
      totalHours: '140.00',
      laborRate: '85.00',
      appliedLaborRate: '85.00',
      laborSubtotal: '11900.00',
      partsSubtotal: '3131.70',
      totalAmount: '15031.70',
      invoiceId: null,
      billingSheetExists: false,
    },
    [WO_62]: {
      workOrderNumber: WO_62,
      companyId: 1,
      totalHours: '22.00',
      laborRate: '85.00',
      appliedLaborRate: '85.00',
      laborSubtotal: '1870.00',
      partsSubtotal: '972.50',
      totalAmount: '2842.50',
      invoiceId: null,
      billingSheetExists: false,
    },
  };
  return { ...defaults[overrides.workOrderNumber]!, ...overrides };
}

type WrittenUpdate = {
  workOrderNumber: string;
  companyId: number;
  updates: { totalHours: string; laborSubtotal: string; totalAmount: string };
};

function makeDeps(
  rows: WoCandidateRow[],
  opts: {
    /** If provided, applyCorrection returns 0 rowsAffected for these WO numbers */
    zeroRowsFor?: string[];
    /** If provided, applyCorrection throws for these WO numbers */
    throwFor?: string[];
  } = {},
): {
  deps: RepairWoodglennDeps;
  written: WrittenUpdate[];
  doneCalled: () => boolean;
} {
  const written: WrittenUpdate[] = [];
  let doneCalled = false;

  const deps: RepairWoodglennDeps = {
    getCandidates: async () => rows,
    applyCorrection: async (workOrderNumber, companyId, updates) => {
      if (opts.throwFor?.includes(workOrderNumber)) {
        throw new Error(`Simulated DB error on ${workOrderNumber}`);
      }
      if (opts.zeroRowsFor?.includes(workOrderNumber)) {
        return { rowsAffected: 0 };
      }
      written.push({ workOrderNumber, companyId, updates });
      return { rowsAffected: 1 };
    },
    markDone: async () => { doneCalled = true; },
  };

  return { deps, written, doneCalled: () => doneCalled };
}

// ── Acknowledge gate ──────────────────────────────────────────────────────────

describe("repair-woodglenn-wo-hours — acknowledge gate", () => {
  it("refuses to run without acknowledged=true", async () => {
    const { deps, written } = makeDeps([]);
    const results = await runRepairWoodglennWoHours(deps, () => {});
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "acknowledge_gate");
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].error && results[0].error.length > 0);
    assert.equal(written.length, 0, "nothing should be written without ack");
  });

  it("runs when acknowledged=true", async () => {
    const rows = [makeRow({ workOrderNumber: WO_314 }), makeRow({ workOrderNumber: WO_62 })];
    const { deps } = makeDeps(rows);
    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });
    assert.ok(results.every((r) => r.id !== "acknowledge_gate"), "gate should not fire when acknowledged");
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("repair-woodglenn-wo-hours — happy path", () => {
  it("corrects both WOs; parts_subtotal, total_parts_cost, estimated_total are not written", async () => {
    const rows = [makeRow({ workOrderNumber: WO_314 }), makeRow({ workOrderNumber: WO_62 })];
    const { deps, written, doneCalled } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    const r314 = results.find((r) => r.id.includes(WO_314));
    const r62  = results.find((r) => r.id.includes(WO_62));
    assert.ok(r314, "should have a step for WO_314");
    assert.ok(r62, "should have a step for WO_62");
    assert.equal(r314!.status, "success");
    assert.equal(r62!.status, "success");

    const w314 = written.find((w) => w.workOrderNumber === WO_314);
    assert.ok(w314, "should have written WO_314");
    assert.equal(w314!.updates.totalHours, "50.00");
    assert.equal(w314!.updates.laborSubtotal, "4250.00");
    assert.equal(w314!.updates.totalAmount, "7381.70");

    const w62 = written.find((w) => w.workOrderNumber === WO_62);
    assert.ok(w62, "should have written WO_62");
    assert.equal(w62!.updates.totalHours, "10.75");
    assert.equal(w62!.updates.laborSubtotal, "913.75");
    assert.equal(w62!.updates.totalAmount, "1886.25");

    for (const w of written) {
      assert.ok(!('partsSubtotal' in w.updates), "partsSubtotal must not be written");
      assert.ok(!('totalPartsCost' in w.updates), "totalPartsCost must not be written");
      assert.ok(!('estimatedTotal' in w.updates), "estimatedTotal must not be written");
    }

    assert.ok(doneCalled(), "markDone should be called on clean completion");
  });
});

// ── All-or-nothing preflight: billing sheet on either target blocks both ──────

describe("repair-woodglenn-wo-hours — all-or-nothing: billing sheet", () => {
  it("billing sheet on WO_314 aborts entire run — WO_62 also not written", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314, billingSheetExists: true }),
      makeRow({ workOrderNumber: WO_62 }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].error && results[0].error.includes("billing sheet"));
    assert.equal(written.length, 0, "no work orders must be written when preflight fails");
  });

  it("billing sheet on WO_62 aborts entire run — WO_314 also not written", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314 }),
      makeRow({ workOrderNumber: WO_62, billingSheetExists: true }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.equal(written.length, 0, "WO_314 must not be written either");
  });
});

// ── All-or-nothing preflight: invoice_id on either target blocks both ─────────

describe("repair-woodglenn-wo-hours — all-or-nothing: invoice_id", () => {
  it("invoice_id on WO_62 aborts entire run — WO_314 also not written", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314 }),
      makeRow({ workOrderNumber: WO_62, invoiceId: 9999 }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].error && results[0].error.includes("invoice_id=9999"));
    assert.equal(written.length, 0, "WO_314 must not be written when WO_62 preflight fails");
  });

  it("invoice_id on WO_314 aborts entire run — WO_62 also not written", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314, invoiceId: 1234 }),
      makeRow({ workOrderNumber: WO_62 }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.equal(written.length, 0, "WO_62 must not be written when WO_314 preflight fails");
  });
});

// ── Cross-check guard (preflight) ─────────────────────────────────────────────

describe("repair-woodglenn-wo-hours — cross-check guard", () => {
  it("aborts entire run when WO_314 appliedLaborRate has changed", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314, appliedLaborRate: '90.00' }),
      makeRow({ workOrderNumber: WO_62 }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].error && results[0].error.includes("cross-check failed"));
    assert.equal(written.length, 0);
  });

  it("aborts entire run when WO_62 parts_subtotal has changed", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314 }),
      makeRow({ workOrderNumber: WO_62, partsSubtotal: '999.99' }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.equal(written.length, 0);
  });
});

// ── Third-state hours guard (preflight) ───────────────────────────────────────

describe("repair-woodglenn-wo-hours — third-state hours guard", () => {
  it("aborts entire run when WO_314 has unexpected hours — WO_62 also not written", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314, totalHours: '99.00' }),
      makeRow({ workOrderNumber: WO_62 }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].error && results[0].error.includes("99.00") && results[0].error.includes("refusing to guess"));
    assert.equal(written.length, 0);
  });

  it("aborts entire run when WO_62 has unexpected hours and reports the actual value", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314 }),
      makeRow({ workOrderNumber: WO_62, totalHours: '15.50' }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].error && results[0].error.includes("15.50"));
    assert.equal(written.length, 0);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("repair-woodglenn-wo-hours — idempotency", () => {
  it("skips both WOs already at correctHours; markDone still called", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314, totalHours: '50.00' }),
      makeRow({ workOrderNumber: WO_62,  totalHours: '10.75' }),
    ];
    const { deps, written, doneCalled } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.ok(results.every((r) => r.status === 'skipped'), "all steps should be skipped");
    assert.equal(written.length, 0, "nothing should be written on second run");
    assert.ok(doneCalled(), "markDone should still be called on clean no-op");
  });
});

// ── Zero-rows-affected guard (concurrent modification protection) ─────────────

describe("repair-woodglenn-wo-hours — zero-rows-affected guard", () => {
  it("fails and does NOT call markDone when WO_314 applyCorrection returns 0 rows", async () => {
    const rows = [makeRow({ workOrderNumber: WO_314 }), makeRow({ workOrderNumber: WO_62 })];
    const { deps, doneCalled } = makeDeps(rows, { zeroRowsFor: [WO_314] });

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    const failed = results.find((r) => r.status === 'failed');
    assert.ok(failed, "should have a failed step");
    assert.ok(failed!.error && failed!.error.includes("0 rows"), `expected '0 rows' error, got: ${failed!.error}`);
    assert.ok(!doneCalled(), "markDone must NOT be called when an update returns 0 rows");
  });

  it("fails and does NOT call markDone when WO_62 applyCorrection returns 0 rows", async () => {
    const rows = [makeRow({ workOrderNumber: WO_314 }), makeRow({ workOrderNumber: WO_62 })];
    const { deps, written, doneCalled } = makeDeps(rows, { zeroRowsFor: [WO_62] });

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    const failed = results.find((r) => r.status === 'failed');
    assert.ok(failed, "should have a failed step");
    assert.ok(failed!.error && failed!.error.includes("0 rows"));
    assert.ok(!doneCalled(), "markDone must NOT be called");
  });

  it("fails and does NOT call markDone when applyCorrection throws (simulated DB error)", async () => {
    const rows = [makeRow({ workOrderNumber: WO_314 }), makeRow({ workOrderNumber: WO_62 })];
    const { deps, doneCalled } = makeDeps(rows, { throwFor: [WO_314] });

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    const failed = results.find((r) => r.status === 'failed');
    assert.ok(failed, "should have a failed step");
    assert.ok(failed!.error && failed!.error.includes("Simulated DB error"));
    assert.ok(!doneCalled(), "markDone must NOT be called when applyCorrection throws");
  });
});

// ── Company scoping ───────────────────────────────────────────────────────────

describe("repair-woodglenn-wo-hours — company scoping", () => {
  it("aborts with preflight failure when getCandidates returns no rows", async () => {
    const { deps, written } = makeDeps([]);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "preflight");
    assert.equal(results[0].status, "failed");
    assert.equal(written.length, 0);
  });

  it("applyCorrection is called with companyId=1 for both WOs", async () => {
    const rows = [makeRow({ workOrderNumber: WO_314 }), makeRow({ workOrderNumber: WO_62 })];
    const { deps, written } = makeDeps(rows);

    await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    for (const w of written) {
      assert.equal(w.companyId, 1, "applyCorrection must be called with companyId=1");
    }
  });
});

// ── Money comparison: .toFixed(2) string comparison, not float equality ───────

describe("repair-woodglenn-wo-hours — money comparison via .toFixed(2)", () => {
  it("string-typed correct hours '50.00' / '10.75' detected as already done", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314, totalHours: '50.00' }),
      makeRow({ workOrderNumber: WO_62,  totalHours: '10.75' }),
    ];
    const { deps, written } = makeDeps(rows);

    const results = await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    assert.ok(results.every((r) => r.status === 'skipped'), "already-correct hours must be detected as done");
    assert.equal(written.length, 0);
  });

  it("WO_62: 10.75 * 85.00 = 913.75 and 913.75 + 972.50 = 1886.25 via .toFixed(2)", async () => {
    const rows = [
      makeRow({ workOrderNumber: WO_314 }),
      makeRow({ workOrderNumber: WO_62, appliedLaborRate: '85.00', partsSubtotal: '972.50' }),
    ];
    const { deps, written } = makeDeps(rows);

    await runRepairWoodglennWoHours(deps, () => {}, { acknowledged: true });

    const w62 = written.find((w) => w.workOrderNumber === WO_62);
    assert.ok(w62, "WO_62 should be written");
    assert.equal(w62!.updates.laborSubtotal, "913.75");
    assert.equal(w62!.updates.totalAmount, "1886.25");
  });
});

// ── Preview writes nothing ────────────────────────────────────────────────────

describe("repair-woodglenn-wo-hours — preview writes nothing", () => {
  it("run() without acknowledged is a no-op (gate fires before any write)", async () => {
    const rows = [makeRow({ workOrderNumber: WO_314 }), makeRow({ workOrderNumber: WO_62 })];
    const { deps, written } = makeDeps(rows);

    await runRepairWoodglennWoHours(deps, () => {});

    assert.equal(written.length, 0, "preview path must not write anything");
  });
});
