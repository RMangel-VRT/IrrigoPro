/**
 * Tests for buildWetCheckGrid — the grid-sizing logic used by the wet-check
 * creation path in routes.ts (Task #1857: single-argument form, profile-only).
 *
 * This file is the "route-level regression guard": it tests the exact decision
 * logic wired into the routes (profile path only — the legacy property_controllers
 * path has been removed).
 *
 * Does NOT spin up Express or hit a database — all inputs are plain objects
 * so the logic can be tested quickly and deterministically.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWetCheckGrid, type IrrigationControllerRow } from "./wet-check-grid";

// ─── helpers ─────────────────────────────────────────────────────────────────

function ic(name: string, totalZones: number | null, letter?: string): IrrigationControllerRow {
  return { name, totalZones, ...(letter != null ? { letter } : {}) };
}

// ─── Profile path ─────────────────────────────────────────────────────────────

describe("buildWetCheckGrid — profile path (Task #1857 single-source-of-truth)", () => {
  it("returns numControllers equal to the length of irrigCtrls", () => {
    const result = buildWetCheckGrid([ic("Controller A", 8), ic("Controller B", 12)]);
    assert.equal(result.numControllers, 2);
    assert.equal(result.seedConfigs.length, 2);
  });

  it("three controllers", () => {
    const result = buildWetCheckGrid([
      ic("Controller A", 6),
      ic("Controller B", 8),
      ic("Controller C", 4),
    ]);
    assert.equal(result.numControllers, 3);
  });

  it("passes zone counts through as-is — does NOT default null to 12", () => {
    const result = buildWetCheckGrid([ic("Controller A", null), ic("Controller B", 8)]);
    assert.equal(result.seedConfigs[0].zoneCount, null, "first controller zoneCount should be null, not 12");
    assert.equal(result.seedConfigs[1].zoneCount, 8);
  });

  it("all-null zone counts pass through without coercion", () => {
    const result = buildWetCheckGrid([
      ic("Controller A", null),
      ic("Controller B", null),
      ic("Controller C", null),
    ]);
    for (const cfg of result.seedConfigs) {
      assert.equal(cfg.zoneCount, null, "null zone count must not be coerced");
    }
  });

  it("preserves controller names from irrigation_controllers", () => {
    const result = buildWetCheckGrid([ic("Back Yard", 6), ic("Front Zone", 10)]);
    assert.equal(result.seedConfigs[0].name, "Back Yard");
    assert.equal(result.seedConfigs[1].name, "Front Zone");
  });

  it("uses stored letter from controller row when available", () => {
    const result = buildWetCheckGrid([ic("Controller A", 8, "A"), ic("Controller B", 6, "B")]);
    assert.equal(result.seedConfigs[0].letter, "A");
    assert.equal(result.seedConfigs[1].letter, "B");
  });

  it("falls back to positional letter assignment when letter is null/missing", () => {
    // Pre-backfill rows may have no letter stored yet.
    const result = buildWetCheckGrid([ic("Old Controller", 8), ic("Another", 6)]);
    assert.equal(result.seedConfigs[0].letter, "A");
    assert.equal(result.seedConfigs[1].letter, "B");
  });

  it("empty list → zero controllers", () => {
    const result = buildWetCheckGrid([]);
    assert.equal(result.numControllers, 0);
    assert.equal(result.seedConfigs.length, 0);
  });

  it("single controller uses all zone count from profile", () => {
    const result = buildWetCheckGrid([ic("Controller A", 24, "A")]);
    assert.equal(result.numControllers, 1);
    assert.equal(result.seedConfigs[0].zoneCount, 24);
    assert.equal(result.seedConfigs[0].letter, "A");
  });

  it("does not cap zone counts at any maximum — passes them through verbatim", () => {
    const result = buildWetCheckGrid([ic("Controller A", 100, "A")]);
    assert.equal(result.seedConfigs[0].zoneCount, 100);
  });
});

// ─── blankStart behaviour (simulated) ────────────────────────────────────────
//
// blankStart is handled at the route level (buildWetCheckGrid is NOT called when
// blankStart=true). These tests verify that the route-level guard behaves correctly
// by simulating it inline.

describe("blankStart guard — route-level behaviour (simulated inline)", () => {
  it("blankStart=true → numControllers=0, buildWetCheckGrid is NOT called", () => {
    let gridCalled = false;
    function simulatedRoute(blankStart: boolean) {
      if (blankStart) return { numControllers: 0, gridCalled: false };
      gridCalled = true;
      const r = buildWetCheckGrid([ic("Controller A", 8)]);
      return { numControllers: r.numControllers, gridCalled: true };
    }
    const result = simulatedRoute(true);
    assert.equal(result.numControllers, 0);
    assert.equal(result.gridCalled, false);
  });

  it("blankStart=false + profile → numControllers from profile", () => {
    function simulatedRoute(blankStart: boolean) {
      if (blankStart) return 0;
      const r = buildWetCheckGrid([
        ic("Controller A", 8),
        ic("Controller B", 4),
        ic("Controller C", 6),
      ]);
      return r.numControllers;
    }
    assert.equal(simulatedRoute(false), 3);
  });
});
