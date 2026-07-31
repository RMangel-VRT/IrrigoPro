// Task #1848 — QBO void backfill: unit tests for the repair logic.
//
// Tests the pure `deriveRepairedState` function. Does not require a DB or QBO
// connection. Importing this module has no side effects — `run()` in the
// backfill is guarded behind an entrypoint check.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveRepairedState } from "./qb-void-backfill.js";

describe("deriveRepairedState", () => {
  // ── Should NOT repair ─────────────────────────────────────────────────────

  it("does not repair a legitimately paid invoice (TotalAmt > 0)", () => {
    const result = deriveRepairedState(
      { Id: "QB-1", Balance: 0, TotalAmt: 500 },
      { sentAt: new Date() },
    );
    assert.equal(result.shouldRepair, false);
  });

  it("does not repair a partial-balance invoice (TotalAmt > 0)", () => {
    const result = deriveRepairedState(
      { Id: "QB-2", Balance: 200, TotalAmt: 500 },
      { sentAt: null },
    );
    assert.equal(result.shouldRepair, false);
  });

  it("does NOT repair a $0 invoice without a QBO void marker (e.g. fully-covered membership)", () => {
    // A legitimate $0 invoice that was genuinely paid must not be reopened.
    const result = deriveRepairedState(
      { Id: "QB-5", Balance: 0, TotalAmt: 0 },
      { sentAt: new Date("2026-02-01") },
    );
    assert.equal(result.shouldRepair, false);
  });

  it("does NOT repair when PrivateNote is an empty string (no void marker)", () => {
    const result = deriveRepairedState(
      { Id: "QB-6", Balance: 0, TotalAmt: 0, PrivateNote: "" },
      { sentAt: new Date() },
    );
    assert.equal(result.shouldRepair, false);
  });

  it("does NOT repair when PrivateNote is undefined (no void marker)", () => {
    const result = deriveRepairedState(
      { Id: "QB-7", Balance: 0, TotalAmt: 0 },
      { sentAt: null },
    );
    assert.equal(result.shouldRepair, false);
  });

  it("does NOT repair when PrivateNote has unrelated text", () => {
    const result = deriveRepairedState(
      { Id: "QB-8", Balance: 0, TotalAmt: 0, PrivateNote: "IrrigoPro sync 2026-01-15" },
      { sentAt: null },
    );
    assert.equal(result.shouldRepair, false);
  });

  // ── Should repair ─────────────────────────────────────────────────────────

  it("repairs a QBO-voided invoice with sentAt — restores to 'generated'", () => {
    // Task #1847 retired status='sent'; sentAt tracks delivery; 'generated'
    // is the active status for invoices that have been sent to the customer.
    const result = deriveRepairedState(
      { Id: "QB-10", Balance: 0, TotalAmt: 0, PrivateNote: "Voided" },
      { sentAt: new Date("2026-01-10") },
    );
    assert.equal(result.shouldRepair, true);
    assert.equal(result.newStatus, "generated");
  });

  it("repairs a QBO-voided invoice without sentAt — restores to 'draft'", () => {
    const result = deriveRepairedState(
      { Id: "QB-11", Balance: 0, TotalAmt: 0, PrivateNote: "Voided" },
      { sentAt: null },
    );
    assert.equal(result.shouldRepair, true);
    assert.equal(result.newStatus, "draft");
  });

  it("detects void marker case-insensitively ('voided' lowercase)", () => {
    const result = deriveRepairedState(
      { Id: "QB-12", Balance: 0, TotalAmt: 0, PrivateNote: "voided on 2026-01-15" },
      { sentAt: null },
    );
    assert.equal(result.shouldRepair, true);
  });

  it("detects void marker case-insensitively ('VOIDED' uppercase)", () => {
    const result = deriveRepairedState(
      { Id: "QB-13", Balance: 0, TotalAmt: 0, PrivateNote: "VOIDED BY QB" },
      { sentAt: new Date() },
    );
    assert.equal(result.shouldRepair, true);
  });

  it("repairs when sentAt is undefined (treated as no sentAt → 'draft')", () => {
    const result = deriveRepairedState(
      { Id: "QB-14", Balance: 0, TotalAmt: 0, PrivateNote: "Voided" },
      {},
    );
    assert.equal(result.shouldRepair, true);
    assert.equal(result.newStatus, "draft");
  });
});
