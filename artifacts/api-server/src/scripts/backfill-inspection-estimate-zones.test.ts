// Task #1409 — Tests for the inspection-estimate zone backfill.
//
// Two layers:
//   1. Pure unit tests for buildInspectionEstimateItems + isInspectionOriginEstimate
//   2. Operational tests for runBackfill using mock BackfillDeps — these cover
//      dry-run non-mutation, apply mutation, mismatch skip, no-findings skip,
//      already-zoned exclusion, resumability, and app_settings persistence.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInspectionEstimateItems,
  type FindingForEstimate,
  type ZoneForEstimate,
} from "../inspection-estimate-items";
import { isInspectionOriginEstimate } from "../estimate-pdf-html";
import {
  runBackfill,
  amountsMatch,
  type CandidateRow,
  type BackfillDeps,
  type BackfillOptions,
  type FailureEntry,
} from "./backfill-inspection-estimate-zones";

// ── buildInspectionEstimateItems ─────────────────────────────────────────────

describe("buildInspectionEstimateItems", () => {
  const zoneA1: ZoneForEstimate = { controllerLetter: "A", zoneNumber: 1 };
  const zoneA2: ZoneForEstimate = { controllerLetter: "A", zoneNumber: 2 };

  function makeFinding(
    overrides: Partial<FindingForEstimate> & { zoneRecordId: number },
  ): FindingForEstimate {
    return {
      partId: null,
      partName: null,
      partPrice: null,
      quantity: 1,
      laborHours: "0.50",
      issueType: "broken_head",
      notes: null,
      ...overrides,
    };
  }

  it("returns an empty item list when findings is empty", () => {
    const { items, totalLaborHours } = buildInspectionEstimateItems([], new Map());
    assert.equal(items.length, 0);
    assert.equal(totalLaborHours, 0);
  });

  it("stamps controllerLetter and zoneNumber from the zone map", () => {
    const findings = [makeFinding({ zoneRecordId: 10 })];
    const zones = new Map<number, ZoneForEstimate>([[10, zoneA1]]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    assert.equal(items.length, 1);
    assert.equal(items[0].controllerLetter, "A");
    assert.equal(items[0].zoneNumber, 1);
  });

  it("sets controllerLetter/zoneNumber to null when zone not found", () => {
    const findings = [makeFinding({ zoneRecordId: 99 })];
    const { items } = buildInspectionEstimateItems(findings, new Map());
    assert.equal(items[0].controllerLetter, null);
    assert.equal(items[0].zoneNumber, null);
  });

  it("merges findings with the same (controller, zone, partId, partName, issueType)", () => {
    const findings = [
      makeFinding({ zoneRecordId: 10, quantity: 2, laborHours: "0.50" }),
      makeFinding({ zoneRecordId: 10, quantity: 1, laborHours: "0.25" }),
    ];
    const zones = new Map<number, ZoneForEstimate>([[10, zoneA1]]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 3);
    assert.equal(parseFloat(items[0].laborHours), 0.75);
  });

  it("does not merge findings with different issueTypes", () => {
    const findings = [
      makeFinding({ zoneRecordId: 10, issueType: "broken_head" }),
      makeFinding({ zoneRecordId: 10, issueType: "leaking_valve" }),
    ];
    const zones = new Map<number, ZoneForEstimate>([[10, zoneA1]]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    assert.equal(items.length, 2);
  });

  it("sorts items controller → zone ascending", () => {
    const findings = [
      makeFinding({ zoneRecordId: 20, issueType: "broken_head" }),
      makeFinding({ zoneRecordId: 10, issueType: "leaking_valve" }),
    ];
    const zones = new Map<number, ZoneForEstimate>([
      [10, zoneA1],
      [20, zoneA2],
    ]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    assert.equal(items[0].zoneNumber, 1);
    assert.equal(items[1].zoneNumber, 2);
  });

  it("computes totalLaborHours as sum of all finding laborHours", () => {
    const findings = [
      makeFinding({ zoneRecordId: 10, laborHours: "1.00" }),
      makeFinding({ zoneRecordId: 10, issueType: "leaking_valve", laborHours: "0.50" }),
    ];
    const zones = new Map<number, ZoneForEstimate>([[10, zoneA1]]);
    const { totalLaborHours } = buildInspectionEstimateItems(findings, zones);
    assert.equal(totalLaborHours, 1.5);
  });

  it("sets totalPrice = partPrice * quantity", () => {
    const findings = [
      makeFinding({
        zoneRecordId: 10,
        partId: 5,
        partName: "Sprinkler Head",
        partPrice: "12.50",
        quantity: 3,
      }),
    ];
    const zones = new Map<number, ZoneForEstimate>([[10, zoneA1]]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    assert.equal(items[0].totalPrice, "37.50");
    assert.equal(items[0].partPrice, "12.50");
  });

  it("humanizes issueType as partName when partName is null", () => {
    const findings = [makeFinding({ zoneRecordId: 10, issueType: "broken_head" })];
    const zones = new Map<number, ZoneForEstimate>([[10, zoneA1]]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    assert.ok(items[0].partName.length > 0, "partName should be non-empty humanized label");
    assert.ok(!items[0].partName.includes("_"), "partName should not contain underscores");
  });

  it("carries issueType onto each item", () => {
    const findings = [makeFinding({ zoneRecordId: 10, issueType: "leaking_valve" })];
    const zones = new Map<number, ZoneForEstimate>([[10, zoneA1]]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    assert.equal(items[0].issueType, "leaking_valve");
  });

  it("sortOrder is zero-indexed per item", () => {
    const findings = [
      makeFinding({ zoneRecordId: 10, issueType: "broken_head" }),
      makeFinding({ zoneRecordId: 10, issueType: "leaking_valve" }),
    ];
    const zones = new Map<number, ZoneForEstimate>([[10, zoneA1]]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    assert.deepEqual(items.map((it) => it.sortOrder), [0, 1]);
  });
});

// ── isInspectionOriginEstimate ────────────────────────────────────────────────

describe("isInspectionOriginEstimate", () => {
  function makeItem(overrides: Partial<{
    controllerLetter: string | null;
    zoneNumber: number | null;
    issueType: string | null;
  }> = {}) {
    return {
      id: 1, estimateId: 1, description: "", partId: null, partName: "Part",
      partPrice: "0.00", quantity: 1, laborHours: "0.00", totalPrice: "0.00",
      sortOrder: 0, controllerId: null, controllerLetter: null, zoneNumber: null,
      issueType: null,
      ...overrides,
    };
  }

  it("returns false when all items have null zone fields (pre-#1385)", () => {
    assert.equal(isInspectionOriginEstimate([makeItem(), makeItem()]), false);
  });

  it("returns true when any item has a non-null controllerLetter (post-#1385)", () => {
    assert.equal(isInspectionOriginEstimate([makeItem({ controllerLetter: "A" }), makeItem()]), true);
  });

  it("returns true when any item has a non-null zoneNumber", () => {
    assert.equal(isInspectionOriginEstimate([makeItem({ zoneNumber: 3 })]), true);
  });

  it("returns false for empty items array", () => {
    assert.equal(isInspectionOriginEstimate([]), false);
  });
});

// ── amountsMatch ──────────────────────────────────────────────────────────────

describe("amountsMatch", () => {
  it("matches equal values", () => {
    assert.ok(amountsMatch("150.00", 150.0));
  });

  it("matches within $0.01 rounding tolerance", () => {
    assert.ok(amountsMatch("150.00", 150.009));
    assert.ok(amountsMatch("150.00", 149.991));
  });

  it("rejects difference of $1", () => {
    assert.ok(!amountsMatch("150.00", 151.0));
  });

  it("rejects when stored is null and regen is non-zero", () => {
    assert.ok(!amountsMatch(null, 50.0));
  });

  it("matches when stored is null and regen is zero", () => {
    assert.ok(amountsMatch(null, 0));
  });
});

// ── runBackfill operational tests ─────────────────────────────────────────────

/** Build a minimal mock BackfillDeps with sensible defaults. */
function makeMockDeps(overrides: Partial<BackfillDeps> = {}): BackfillDeps & {
  replacedEstimates: number[];
  savedKeys: Record<string, Set<number>>;
  failures: FailureEntry[];
} {
  const replacedEstimates: number[] = [];
  const savedKeys: Record<string, Set<number>> = {};
  const failures: FailureEntry[] = [];

  const deps: BackfillDeps = {
    loadIdSet: async (key) => savedKeys[key] ?? new Set(),
    saveIdSet: async (key, ids) => { savedKeys[key] = new Set(ids); },
    appendFailure: async (entry) => { failures.push(entry); },
    getCandidates: async () => [],
    getItemCount: async () => 0,
    getFindings: async () => [],
    getZoneRecords: async () => new Map(),
    replaceItems: async (id) => { replacedEstimates.push(id); },
    ...overrides,
  };

  return Object.assign(deps, { replacedEstimates, savedKeys, failures });
}

const silentOpts: BackfillOptions = {
  dryRun: false,
  batchSize: 50,
  log: () => {},
  logError: () => {},
};

function silentDry(): BackfillOptions {
  return { ...silentOpts, dryRun: true };
}

// ── Non-inspection / already-zoned: never selected ───────────────────────────

describe("runBackfill — non-inspection / already-zoned estimates never visited", () => {
  it("does nothing when getCandidates returns empty (no inspection estimates)", async () => {
    const mock = makeMockDeps({ getCandidates: async () => [] });
    const result = await runBackfill(mock, silentDry());
    assert.equal(result.totalSelected, 0);
    assert.equal(mock.replacedEstimates.length, 0);
  });

  it("getCandidates is responsible for excluding already-zoned rows; runBackfill trusts the list", async () => {
    // Simulate a correctly-implemented getCandidates that only returns unzoned rows.
    // runBackfill itself does not re-filter — test verifies it processes the row.
    const candidate: CandidateRow = {
      id: 1, originWetCheckId: 10, partsSubtotal: "0.00", totalLaborHours: "0.00",
    };
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => 2,
      getFindings: async () => [],  // no findings → SKIP
    });
    const result = await runBackfill(mock, silentOpts);
    assert.equal(result.totalSelected, 1);
    assert.equal(result.skippedNoFindings, 1);
    assert.equal(mock.replacedEstimates.length, 0);
  });
});

// ── Dry-run: no DB mutations ─────────────────────────────────────────────────

describe("runBackfill — dry-run does not mutate", () => {
  it("MATCH in dry-run: reports matchedDryRun but does not call replaceItems", async () => {
    const candidate: CandidateRow = {
      id: 5, originWetCheckId: 20, partsSubtotal: "25.00", totalLaborHours: "0.50",
    };
    const findings: FindingForEstimate[] = [
      {
        zoneRecordId: 100, partId: null, partName: "Sprinkler",
        partPrice: "25.00", quantity: 1, laborHours: "0.50",
        issueType: "broken_head", notes: null,
      },
    ];
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => 1,
      getFindings: async () => findings,
      getZoneRecords: async () =>
        new Map([[100, { controllerLetter: "A", zoneNumber: 1 }]]),
    });
    const result = await runBackfill(mock, silentDry());
    assert.equal(result.matchedDryRun, 1);
    assert.equal(result.matched, 0);
    assert.equal(mock.replacedEstimates.length, 0, "dry-run must not call replaceItems");
  });

  it("dry-run does not persist done/seen sets", async () => {
    const candidate: CandidateRow = {
      id: 5, originWetCheckId: 20, partsSubtotal: "0.00", totalLaborHours: "0.00",
    };
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getFindings: async () => [],
    });
    await runBackfill(mock, silentDry());
    assert.equal(
      Object.keys(mock.savedKeys).length,
      0,
      "dry-run must not write to app_settings",
    );
  });
});

// ── Apply: MATCH estimates are replaced ──────────────────────────────────────

describe("runBackfill — apply mode commits MATCH estimates", () => {
  it("calls replaceItems for each MATCH and adds id to done set", async () => {
    const candidate: CandidateRow = {
      id: 7, originWetCheckId: 30, partsSubtotal: "50.00", totalLaborHours: "1.00",
    };
    const findings: FindingForEstimate[] = [
      {
        zoneRecordId: 200, partId: null, partName: "Valve",
        partPrice: "50.00", quantity: 1, laborHours: "1.00",
        issueType: "leaking_valve", notes: null,
      },
    ];
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => 1,
      getFindings: async () => findings,
      getZoneRecords: async () =>
        new Map([[200, { controllerLetter: "B", zoneNumber: 2 }]]),
    });
    const result = await runBackfill(mock, silentOpts);
    assert.equal(result.matched, 1);
    assert.deepEqual(mock.replacedEstimates, [7]);
    // done set persisted
    const done = mock.savedKeys["backfill.inspectionEstimateZones.done"];
    assert.ok(done?.has(7), "estimate 7 should be in done set");
  });

  it("items passed to replaceItems carry zone fields (controllerLetter, zoneNumber, issueType)", async () => {
    let capturedItems: import("../inspection-estimate-items").EstimateItemDraft[] = [];
    const candidate: CandidateRow = {
      id: 9, originWetCheckId: 40, partsSubtotal: "10.00", totalLaborHours: "0.25",
    };
    const findings: FindingForEstimate[] = [
      {
        zoneRecordId: 300, partId: null, partName: "Head",
        partPrice: "10.00", quantity: 1, laborHours: "0.25",
        issueType: "broken_head", notes: null,
      },
    ];
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => 1,
      getFindings: async () => findings,
      getZoneRecords: async () =>
        new Map([[300, { controllerLetter: "C", zoneNumber: 3 }]]),
      replaceItems: async (_id, items) => { capturedItems = items; },
    });
    await runBackfill(mock, silentOpts);
    assert.equal(capturedItems.length, 1);
    assert.equal(capturedItems[0].controllerLetter, "C");
    assert.equal(capturedItems[0].zoneNumber, 3);
    assert.equal(capturedItems[0].issueType, "broken_head");
  });
});

// ── Totals mismatch: SKIP and persist to seen set ────────────────────────────

describe("runBackfill — totals mismatch → SKIP and persist to seen", () => {
  it("skips when regen parts subtotal differs from stored", async () => {
    const candidate: CandidateRow = {
      id: 11, originWetCheckId: 50, partsSubtotal: "999.00", totalLaborHours: "0.00",
    };
    const findings: FindingForEstimate[] = [
      {
        zoneRecordId: 400, partId: null, partName: "Head",
        partPrice: "10.00", quantity: 1, laborHours: "0.00",
        issueType: "broken_head", notes: null,
      },
    ];
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => 1,
      getFindings: async () => findings,
      getZoneRecords: async () =>
        new Map([[400, { controllerLetter: "A", zoneNumber: 1 }]]),
    });
    const result = await runBackfill(mock, silentOpts);
    assert.equal(result.skippedTotalsMismatch, 1);
    assert.equal(mock.replacedEstimates.length, 0);
    const seen = mock.savedKeys["backfill.inspectionEstimateZones.seen"];
    assert.ok(seen?.has(11), "mismatched estimate should be added to seen set");
  });

  it("skips when regen labor hours differ from stored", async () => {
    const candidate: CandidateRow = {
      id: 13, originWetCheckId: 55, partsSubtotal: "10.00", totalLaborHours: "99.00",
    };
    const findings: FindingForEstimate[] = [
      {
        zoneRecordId: 500, partId: null, partName: "Head",
        partPrice: "10.00", quantity: 1, laborHours: "0.50",
        issueType: "broken_head", notes: null,
      },
    ];
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => 1,
      getFindings: async () => findings,
      getZoneRecords: async () =>
        new Map([[500, { controllerLetter: "A", zoneNumber: 1 }]]),
    });
    const result = await runBackfill(mock, silentOpts);
    assert.equal(result.skippedTotalsMismatch, 1);
    assert.equal(mock.replacedEstimates.length, 0);
  });
});

// ── No findings: SKIP and persist to seen ────────────────────────────────────

describe("runBackfill — no findings → SKIP and persist to seen", () => {
  it("skips and adds to seen when wet check has no findings", async () => {
    const candidate: CandidateRow = {
      id: 15, originWetCheckId: 60, partsSubtotal: "0.00", totalLaborHours: "0.00",
    };
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => 0,
      getFindings: async () => [],
    });
    const result = await runBackfill(mock, silentOpts);
    assert.equal(result.skippedNoFindings, 1);
    assert.equal(mock.replacedEstimates.length, 0);
    const seen = mock.savedKeys["backfill.inspectionEstimateZones.seen"];
    assert.ok(seen?.has(15), "no-findings estimate should be added to seen set");
  });
});

// ── Resumability ──────────────────────────────────────────────────────────────

describe("runBackfill — resumability", () => {
  it("skips estimates already in done set", async () => {
    const doneSet = new Set([7]);
    const candidate: CandidateRow = {
      id: 7, originWetCheckId: 30, partsSubtotal: "50.00", totalLaborHours: "0.00",
    };
    const mock = makeMockDeps({
      loadIdSet: async (key) =>
        key === "backfill.inspectionEstimateZones.done" ? doneSet : new Set(),
      getCandidates: async () => [candidate],
    });
    const result = await runBackfill(mock, silentOpts);
    assert.equal(result.alreadyProcessed, 1);
    assert.equal(mock.replacedEstimates.length, 0);
  });

  it("skips estimates already in seen set (mismatch from prior run)", async () => {
    const seenSet = new Set([11]);
    const candidate: CandidateRow = {
      id: 11, originWetCheckId: 50, partsSubtotal: "999.00", totalLaborHours: "0.00",
    };
    const mock = makeMockDeps({
      loadIdSet: async (key) =>
        key === "backfill.inspectionEstimateZones.seen" ? seenSet : new Set(),
      getCandidates: async () => [candidate],
    });
    const result = await runBackfill(mock, silentOpts);
    assert.equal(result.alreadyProcessed, 1);
    assert.equal(mock.replacedEstimates.length, 0);
  });

  it("persists done set after processing a batch", async () => {
    const candidate: CandidateRow = {
      id: 20, originWetCheckId: 70, partsSubtotal: "0.00", totalLaborHours: "0.00",
    };
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => 0,
      getFindings: async () => [],
    });
    await runBackfill(mock, silentOpts);
    // seen set should be persisted (no-findings skips go into seen)
    const seen = mock.savedKeys["backfill.inspectionEstimateZones.seen"];
    assert.ok(seen?.has(20));
  });
});

// ── Error isolation ───────────────────────────────────────────────────────────

describe("runBackfill — per-estimate error isolation", () => {
  it("continues processing remaining estimates when one throws", async () => {
    let callCount = 0;
    const candidates: CandidateRow[] = [
      { id: 1, originWetCheckId: 10, partsSubtotal: "0.00", totalLaborHours: "0.00" },
      { id: 2, originWetCheckId: 11, partsSubtotal: "0.00", totalLaborHours: "0.00" },
    ];
    const mock = makeMockDeps({
      getCandidates: async () => candidates,
      getItemCount: async () => 0,
      getFindings: async (wcId) => {
        callCount++;
        if (wcId === 10) throw new Error("DB timeout");
        return [];
      },
    });
    const result = await runBackfill(mock, silentOpts);
    assert.equal(result.errors, 1);
    assert.equal(result.skippedNoFindings, 1);
    assert.equal(callCount, 2, "both estimates should be attempted");
  });

  it("persists error to failures list via appendFailure", async () => {
    const candidate: CandidateRow = {
      id: 3, originWetCheckId: 12, partsSubtotal: "0.00", totalLaborHours: "0.00",
    };
    const mock = makeMockDeps({
      getCandidates: async () => [candidate],
      getItemCount: async () => { throw new Error("simulated error"); },
    });
    await runBackfill(mock, silentOpts);
    assert.equal(mock.failures.length, 1);
    assert.equal(mock.failures[0].id, 3);
    assert.ok(mock.failures[0].error.includes("simulated error"));
  });
});

// ── Post-backfill: isInspectionOriginEstimate after zone-stamping ─────────────

describe("post-backfill isInspectionOriginEstimate", () => {
  it("returns true after items are stamped with zone data", () => {
    const findings: FindingForEstimate[] = [
      {
        zoneRecordId: 10, partId: null, partName: null, partPrice: null,
        quantity: 1, laborHours: "0.50", issueType: "broken_head", notes: null,
      },
    ];
    const zones = new Map<number, ZoneForEstimate>([
      [10, { controllerLetter: "A", zoneNumber: 1 }],
    ]);
    const { items } = buildInspectionEstimateItems(findings, zones);
    const fakeItems = items.map((d, i) => ({
      id: i + 1, estimateId: 99, controllerId: null, ...d,
    }));
    assert.equal(isInspectionOriginEstimate(fakeItems), true);
  });

  it("remains false for non-inspection estimate items (no zone fields)", () => {
    const fakeItems = [
      {
        id: 1, estimateId: 1, description: "Repair pipe", partId: null,
        partName: "PVC Pipe", partPrice: "5.00", quantity: 2,
        laborHours: "0.00", totalPrice: "10.00", sortOrder: 0,
        controllerId: null, controllerLetter: null, zoneNumber: null,
        issueType: null,
      },
    ];
    assert.equal(isInspectionOriginEstimate(fakeItems), false);
  });
});
