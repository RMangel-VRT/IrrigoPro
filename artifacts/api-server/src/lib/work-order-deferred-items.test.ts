// Task #1935 — tests for computeDeferredItems.
//
// All tests are pure-logic: no DB, no Express, no side effects.
// See also inspection-zone-lineage.test.ts for completion-path integration tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeDeferredItems,
  type EstimateItemInput,
  type CompletedItemInput,
} from "./work-order-deferred-items";

// ── Helper builders ────────────────────────────────────────────────────────────

function estItem(
  partName: string,
  qty: number,
  laborHours: string,
  opts: { controllerLetter?: string | null; zoneNumber?: number | null; issueType?: string | null; partId?: number | null; partPrice?: string } = {},
): EstimateItemInput {
  return {
    partName,
    quantity: qty,
    laborHours,
    partPrice: opts.partPrice ?? "10.00",
    partId: opts.partId ?? null,
    controllerLetter: opts.controllerLetter ?? null,
    zoneNumber: opts.zoneNumber ?? null,
    issueType: opts.issueType ?? null,
  };
}

function woItem(
  partName: string,
  qty: number,
  opts: { controllerLetter?: string | null; zoneNumber?: number | null; issueType?: string | null } = {},
): CompletedItemInput {
  return {
    partName,
    quantity: qty,
    controllerLetter: opts.controllerLetter ?? null,
    zoneNumber: opts.zoneNumber ?? null,
    issueType: opts.issueType ?? null,
  };
}

// ── Woodglenn fixture ──────────────────────────────────────────────────────────
//
// Estimate 50017: 162 lines, of which 144 are fully covered by the completed
// WO and 18 are deferred (17 lines at qty=1, one line at qty=2).
// Total deferred hours: 22.50.
// Controllers A, C, D, E, F, I, J contribute deferred items.
// Controllers B, G, H contribute zero deferred items.

function buildWoodglennFixture(): {
  estimateItems: EstimateItemInput[];
  completedItems: CompletedItemInput[];
} {
  const estimateItems: EstimateItemInput[] = [];
  const completedItems: CompletedItemInput[] = [];

  // ── Non-deferred items (144 lines) fully covered by the WO ──────────────────
  // Spread across controllers including B, G, H so we can assert those
  // controllers contribute nothing to the deferred set.

  const NON_DEFERRED: Array<[string, number, string]> = [
    // [controllerLetter, zoneCount, issueType]
    ["A", 20, "broken_head"],
    ["B", 10, "lateral_leak"],   // B: all covered → 0 deferred
    ["C", 20, "broken_head"],
    ["D", 20, "broken_head"],
    ["E", 17, "valve_failure"],
    ["F", 17, "valve_failure"],
    ["G", 10, "lateral_leak"],   // G: all covered → 0 deferred
    ["H", 10, "lateral_leak"],   // H: all covered → 0 deferred
    ["I", 10, "broken_head"],
    ["J", 10, "broken_head"],
  ];

  for (const [ctrl, count, issueType] of NON_DEFERRED) {
    for (let z = 1; z <= count; z++) {
      const partName = `${ctrl}-zone${z}-${issueType}`;
      const item = estItem(partName, 1, "0.25", { controllerLetter: ctrl, zoneNumber: z, issueType });
      estimateItems.push(item);
      completedItems.push(woItem(partName, 1, { controllerLetter: ctrl, zoneNumber: z, issueType }));
    }
  }

  // ── Deferred items (18 lines) NOT on the completed WO ──────────────────────
  // Distribution across A, C, D, E, F, I, J.
  // 17 lines at qty=1 × laborHours=1.00 + 1 line at qty=2 × laborHours=5.50
  // Total deferred hours = 17.00 + 5.50 = 22.50.

  const DEFERRED_QTY1: Array<[string, number]> = [
    // [controllerLetter, zone]
    ["A", 51], ["A", 52], ["A", 53],
    ["C", 51], ["C", 52], ["C", 53],
    ["D", 51], ["D", 52], ["D", 53],
    ["E", 51], ["E", 52],
    ["F", 51], ["F", 52],
    ["I", 51], ["I", 52],
    ["J", 51], ["J", 52],
  ]; // 17 entries

  for (const [ctrl, zone] of DEFERRED_QTY1) {
    const partName = `${ctrl}-zone${zone}-missing`;
    estimateItems.push(estItem(partName, 1, "1.00", { controllerLetter: ctrl, zoneNumber: zone, issueType: "broken_head" }));
    // NOT added to completedItems — fully missing from WO
  }

  // 1 line at qty=2, laborHours=5.50
  estimateItems.push(
    estItem("J-zone53-double", 2, "5.50", { controllerLetter: "J", zoneNumber: 53, issueType: "broken_head" }),
  );
  // NOT added to completedItems

  return { estimateItems, completedItems };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("computeDeferredItems — Woodglenn fixture (estimate 50017)", () => {
  const { estimateItems, completedItems } = buildWoodglennFixture();

  it("estimate has 162 lines", () => {
    assert.equal(estimateItems.length, 162);
  });

  it("completed WO has 144 lines", () => {
    assert.equal(completedItems.length, 144);
  });

  it("produces exactly 18 deferred items", () => {
    const deferred = computeDeferredItems(estimateItems, completedItems);
    assert.equal(deferred.length, 18, `Expected 18 deferred items, got ${deferred.length}`);
  });

  it("17 deferred items have quantity 1", () => {
    const deferred = computeDeferredItems(estimateItems, completedItems);
    const atQty1 = deferred.filter(d => d.quantity === 1);
    assert.equal(atQty1.length, 17);
  });

  it("1 deferred item has quantity 2", () => {
    const deferred = computeDeferredItems(estimateItems, completedItems);
    const atQty2 = deferred.filter(d => d.quantity === 2);
    assert.equal(atQty2.length, 1);
  });

  it("total deferred hours equals exactly 22.50", () => {
    const deferred = computeDeferredItems(estimateItems, completedItems);
    const totalHours = deferred.reduce((s, d) => s + parseFloat(d.laborHours || "0"), 0);
    assert.ok(
      Math.abs(totalHours - 22.50) < 0.001,
      `Expected 22.50 total deferred hours, got ${totalHours}`,
    );
  });

  it("controller B produces zero deferred items", () => {
    const deferred = computeDeferredItems(estimateItems, completedItems);
    assert.equal(deferred.filter(d => d.controllerLetter === "B").length, 0);
  });

  it("controller G produces zero deferred items", () => {
    const deferred = computeDeferredItems(estimateItems, completedItems);
    assert.equal(deferred.filter(d => d.controllerLetter === "G").length, 0);
  });

  it("controller H produces zero deferred items", () => {
    const deferred = computeDeferredItems(estimateItems, completedItems);
    assert.equal(deferred.filter(d => d.controllerLetter === "H").length, 0);
  });

  it("controllers A, C, D, E, F, I, J all appear in deferred items", () => {
    const deferred = computeDeferredItems(estimateItems, completedItems);
    const controllers = new Set(deferred.map(d => d.controllerLetter));
    for (const ctrl of ["A", "C", "D", "E", "F", "I", "J"]) {
      assert.ok(controllers.has(ctrl), `Expected controller ${ctrl} in deferred set`);
    }
  });
});

// ── Edge-case tests ────────────────────────────────────────────────────────────

describe("computeDeferredItems — empty diff", () => {
  it("returns empty array when all estimate items are covered", () => {
    const estimate = [estItem("Valve", 1, "0.50", { controllerLetter: "A", zoneNumber: 1, issueType: "broken_head" })];
    const completed = [woItem("Valve", 1, { controllerLetter: "A", zoneNumber: 1, issueType: "broken_head" })];
    assert.deepEqual(computeDeferredItems(estimate, completed), []);
  });

  it("returns empty array when no estimate items exist", () => {
    assert.deepEqual(computeDeferredItems([], []), []);
  });

  it("returns empty array when completed qty exceeds estimate qty (over-delivery)", () => {
    const estimate = [estItem("Valve", 1, "0.50", { controllerLetter: "A", zoneNumber: 1 })];
    const completed = [woItem("Valve", 3, { controllerLetter: "A", zoneNumber: 1 })];
    assert.deepEqual(computeDeferredItems(estimate, completed), []);
  });
});

describe("computeDeferredItems — quantity shortfall", () => {
  it("estimate qty=3 WO qty=1 → deferred qty=2", () => {
    const estimate = [estItem("Valve", 3, "3.00", { controllerLetter: "A", zoneNumber: 1, issueType: "valve_failure" })];
    const completed = [woItem("Valve", 1, { controllerLetter: "A", zoneNumber: 1, issueType: "valve_failure" })];
    const deferred = computeDeferredItems(estimate, completed);
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].quantity, 2);
    assert.equal(deferred[0].partName, "Valve");
  });

  it("carries the full estimate laborHours on the shortfall item", () => {
    const estimate = [estItem("Valve", 3, "6.00", { controllerLetter: "A", zoneNumber: 1 })];
    const completed = [woItem("Valve", 1, { controllerLetter: "A", zoneNumber: 1 })];
    const deferred = computeDeferredItems(estimate, completed);
    assert.equal(deferred[0].laborHours, "6.00");
  });

  it("fully missing item (estimate qty=1 WO qty=0) → deferred qty=1", () => {
    const estimate = [estItem("Sprinkler Head", 1, "0.75", { controllerLetter: "C", zoneNumber: 5 })];
    const deferred = computeDeferredItems(estimate, []);
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].quantity, 1);
  });
});

describe("computeDeferredItems — null controller/zone matching", () => {
  it("null controllerLetter matches null controllerLetter (IS NOT DISTINCT FROM)", () => {
    const estimate = [estItem("Valve", 1, "0.50", { controllerLetter: null, zoneNumber: null })];
    const completed = [woItem("Valve", 1, { controllerLetter: null, zoneNumber: null })];
    // Should be fully covered — no deferred items
    assert.deepEqual(computeDeferredItems(estimate, completed), []);
  });

  it("null issueType matches null issueType", () => {
    const estimate = [estItem("Valve", 1, "0.50", { controllerLetter: "A", zoneNumber: 1, issueType: null })];
    const completed = [woItem("Valve", 1, { controllerLetter: "A", zoneNumber: 1, issueType: null })];
    assert.deepEqual(computeDeferredItems(estimate, completed), []);
  });

  it("null does NOT match a non-null value (partName still differentiates)", () => {
    // Different zoneNumber: one has null, one has 1 — different keys
    const estimate = [estItem("Valve", 1, "0.50", { controllerLetter: "A", zoneNumber: null })];
    const completed = [woItem("Valve", 1, { controllerLetter: "A", zoneNumber: 1 })];
    const deferred = computeDeferredItems(estimate, completed);
    assert.equal(deferred.length, 1, "null zoneNumber should not match zoneNumber=1");
  });

  it("both fields null → match; deferred only when WO is absent", () => {
    const estimate = [
      estItem("Pipe", 1, "0.25", { controllerLetter: null, zoneNumber: null, issueType: null }),
      estItem("Valve", 1, "0.50", { controllerLetter: null, zoneNumber: null, issueType: null }),
    ];
    const completed = [woItem("Pipe", 1, { controllerLetter: null, zoneNumber: null, issueType: null })];
    const deferred = computeDeferredItems(estimate, completed);
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].partName, "Valve");
  });
});

describe("computeDeferredItems — duplicate estimate rows (multiset semantics)", () => {
  // Two estimate rows that share the same identity key must compete for completed
  // units rather than each independently consuming the full completed quantity.
  // Regression: the pre-fix version applied the total completed qty to every
  // matching row independently, silently dropping deferred work.

  it("two identical estimate rows qty=1 with one completed unit → one deferred row", () => {
    const estimate = [
      estItem("Valve", 1, "0.50", { controllerLetter: "A", zoneNumber: 1, issueType: "broken_head" }),
      estItem("Valve", 1, "0.50", { controllerLetter: "A", zoneNumber: 1, issueType: "broken_head" }),
    ];
    const completed = [woItem("Valve", 1, { controllerLetter: "A", zoneNumber: 1, issueType: "broken_head" })];
    const deferred = computeDeferredItems(estimate, completed);
    assert.equal(deferred.length, 1, "should have exactly one deferred row");
    assert.equal(deferred[0].quantity, 1);
  });

  it("three identical rows qty=1 with two completed units → one deferred row", () => {
    const estimate = [
      estItem("Head", 1, "0.25", { controllerLetter: "B", zoneNumber: 2 }),
      estItem("Head", 1, "0.25", { controllerLetter: "B", zoneNumber: 2 }),
      estItem("Head", 1, "0.25", { controllerLetter: "B", zoneNumber: 2 }),
    ];
    const completed = [woItem("Head", 2, { controllerLetter: "B", zoneNumber: 2 })];
    const deferred = computeDeferredItems(estimate, completed);
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].quantity, 1);
  });

  it("two identical rows qty=1 with two completed units → zero deferred rows (fully covered)", () => {
    const estimate = [
      estItem("Valve", 1, "0.50", { controllerLetter: "A", zoneNumber: 1 }),
      estItem("Valve", 1, "0.50", { controllerLetter: "A", zoneNumber: 1 }),
    ];
    const completed = [woItem("Valve", 2, { controllerLetter: "A", zoneNumber: 1 })];
    assert.deepEqual(computeDeferredItems(estimate, completed), []);
  });

  it("two identical rows qty=2 with one completed unit → first row partially deferred, second fully deferred", () => {
    // Estimate: [qty=2, qty=2] for same key, completed: qty=1
    // First row consumes 1 unit → shortfall=1; second row consumes 0 → shortfall=2
    const estimate = [
      estItem("Valve", 2, "1.00", { controllerLetter: "C", zoneNumber: 3 }),
      estItem("Valve", 2, "1.00", { controllerLetter: "C", zoneNumber: 3 }),
    ];
    const completed = [woItem("Valve", 1, { controllerLetter: "C", zoneNumber: 3 })];
    const deferred = computeDeferredItems(estimate, completed);
    assert.equal(deferred.length, 2, "should produce two deferred rows");
    const totalDeferredQty = deferred.reduce((s, d) => s + d.quantity, 0);
    assert.equal(totalDeferredQty, 3, "total deferred qty should be 3 (2+2-1)");
  });
});

describe("computeDeferredItems — null estimateId guard (caller-level)", () => {
  // The function itself doesn't care about estimateId — the route is responsible
  // for skipping the call when estimateId is null. This test documents the
  // caller contract rather than testing the function's internals.
  it("returns empty array for empty inputs (baseline for callers with no estimateId)", () => {
    assert.deepEqual(computeDeferredItems([], []), []);
  });
});
