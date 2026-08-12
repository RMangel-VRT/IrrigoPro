import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sumCompletionLaborHours } from "./work-order-labor-hours.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const oldFormula = (items: { laborHours?: string | number | null; quantity?: string | number | null }[]) =>
  items.reduce(
    (s, it) =>
      s +
      (parseFloat(String(it.laborHours ?? "0")) || 0) *
        (parseFloat(String(it.quantity ?? "0")) || 0),
    0,
  );

describe("sumCompletionLaborHours", () => {
  // -------------------------------------------------------------------------
  // Woodglenn regression (server-side)
  // -------------------------------------------------------------------------
  describe("Woodglenn regression — inspection-derived items (issueType non-null)", () => {
    it("sums laborHours directly, NOT × quantity (per_part inspection WO)", () => {
      // Mirrors the Woodglenn signature: items whose laborHours are line totals
      // (accumulated across merged findings) but quantity > 1.
      const items = [
        { laborHours: "0.25", quantity: 4, issueType: "head_adjustment", findingId: null },
        { laborHours: "0.50", quantity: 5, issueType: "broken_head", findingId: null },
        { laborHours: "2.50", quantity: 3, issueType: "pipe_leak", findingId: null },
      ];
      // Correct: 0.25 + 0.50 + 2.50 = 3.25
      // Old broken formula: 0.25×4 + 0.50×5 + 2.50×3 = 1 + 2.5 + 7.5 = 11
      assert.equal(sumCompletionLaborHours(items), 3.25);
    });

    it("also treats findingId (when present) as an inspection discriminator", () => {
      const items = [
        { laborHours: "1.00", quantity: 3, issueType: null, findingId: 42 },
      ];
      // findingId non-null → line total: 1.00 (not 3.00)
      assert.equal(sumCompletionLaborHours(items), 1);
    });

    it("old formula produces a different (wrong) result for the same items", () => {
      const items = [
        { laborHours: "0.25", quantity: 4, issueType: "head_adjustment", findingId: null },
        { laborHours: "0.50", quantity: 5, issueType: "broken_head", findingId: null },
        { laborHours: "2.50", quantity: 3, issueType: "pipe_leak", findingId: null },
      ];
      const brokenResult = oldFormula(items);
      assert.equal(brokenResult, 11);
      assert.notEqual(sumCompletionLaborHours(items), brokenResult);
    });
  });

  // -------------------------------------------------------------------------
  // Field-added only (issueType null, findingId null) — old behaviour preserved
  // -------------------------------------------------------------------------
  describe("field-added only (issueType null, findingId null)", () => {
    it("multiplies laborHours × quantity — per-unit hours", () => {
      const items = [
        { laborHours: "0.50", quantity: 4, issueType: null, findingId: null }, // 2.00
        { laborHours: "1.00", quantity: 2, issueType: null, findingId: null }, // 2.00
      ];
      // 0.50×4 + 1.00×2 = 4.00
      assert.equal(sumCompletionLaborHours(items), 4);
    });

    it("matches the old formula when all rows are field-added", () => {
      const items = [
        { laborHours: "0.50", quantity: 4, issueType: null, findingId: null },
        { laborHours: "1.00", quantity: 2, issueType: null, findingId: null },
      ];
      assert.equal(sumCompletionLaborHours(items), oldFormula(items));
    });

    it("tripwire condition is false (values agree) — no warn fires", () => {
      const items = [
        { laborHours: "0.50", quantity: 4, issueType: null, findingId: null },
        { laborHours: "1.00", quantity: 2, issueType: null, findingId: null },
      ];
      const diff = Math.abs(oldFormula(items) - sumCompletionLaborHours(items));
      assert.ok(diff <= 0.001, `Expected no diff but got ${diff}`);
    });
  });

  // -------------------------------------------------------------------------
  // Mixed: some inspection rows, some field-added
  // -------------------------------------------------------------------------
  describe("mixed work order — inspection + field-added rows", () => {
    it("computes each subset correctly in one pass", () => {
      const items = [
        { laborHours: "2.00", quantity: 3, issueType: "head_adjustment", findingId: null }, // line total: 2.00
        { laborHours: "1.00", quantity: 2, issueType: null, findingId: null },              // per-unit: 2.00
        { laborHours: "0.50", quantity: 4, issueType: "broken_head", findingId: null },     // line total: 0.50
        { laborHours: "0.75", quantity: 1, issueType: null, findingId: null },              // per-unit: 0.75
      ];
      // 2.00 + 2.00 + 0.50 + 0.75 = 5.25
      assert.equal(sumCompletionLaborHours(items), 5.25);
    });

    it("old formula would over-count inspection rows", () => {
      const items = [
        { laborHours: "2.00", quantity: 3, issueType: "head_adjustment", findingId: null },
        { laborHours: "1.00", quantity: 2, issueType: null, findingId: null },
        { laborHours: "0.50", quantity: 4, issueType: "broken_head", findingId: null },
        { laborHours: "0.75", quantity: 1, issueType: null, findingId: null },
      ];
      // Old formula: 2×3 + 1×2 + 0.5×4 + 0.75×1 = 6 + 2 + 2 + 0.75 = 10.75
      assert.equal(oldFormula(items), 10.75);
      assert.notEqual(sumCompletionLaborHours(items), oldFormula(items));
    });
  });

  // -------------------------------------------------------------------------
  // Incoming payload path: sourceItemId but no issueType on payload.
  // The server resolves issueType via the persisted-item lookup before calling
  // sumCompletionLaborHours. This test proves that path.
  // -------------------------------------------------------------------------
  describe("payload sourceItemId resolved to issueType via prior rows", () => {
    it("resolves to Σ laborHours when prior rows have issueType", () => {
      const priorItems = [
        { id: 1, partId: 100, laborHours: "1.50", quantity: 3, issueType: "head_adjustment", findingId: null },
        { id: 2, partId: 101, laborHours: "0.75", quantity: 2, issueType: "broken_head", findingId: null },
      ];
      const payloadParts = [
        { sourceItemId: 1, partId: 100, laborHours: "1.50", quantity: 3 },
        { sourceItemId: 2, partId: 101, laborHours: "0.75", quantity: 2 },
      ];

      // Mirror the server-side resolution logic from routes.ts
      const persistedById = new Map(priorItems.map(it => [it.id, it]));
      const resolvedItems = payloadParts.map(p => {
        const prior = persistedById.get(p.sourceItemId);
        return {
          laborHours: p.laborHours,
          quantity: p.quantity,
          issueType: prior?.issueType ?? null,
          findingId: prior?.findingId ?? null,
        };
      });

      // 1.50 + 0.75 = 2.25 (line totals, not ×qty)
      assert.equal(sumCompletionLaborHours(resolvedItems), 2.25);
    });

    it("treats un-matched payload parts as field-added (no issueType → × quantity)", () => {
      const priorItems = [
        { id: 1, partId: 100, laborHours: "1.00", quantity: 2, issueType: "pipe_leak", findingId: null },
      ];
      const payloadParts = [
        { sourceItemId: 1, partId: 100, laborHours: "1.00", quantity: 2 }, // inspection
        { sourceItemId: 999, partId: 101, laborHours: "0.50", quantity: 4 }, // field-added (stale id → no match)
      ];

      const persistedById = new Map(priorItems.map(it => [it.id, it]));
      const resolvedItems = payloadParts.map(p => {
        const prior = persistedById.get(p.sourceItemId);
        return {
          laborHours: p.laborHours,
          quantity: p.quantity,
          issueType: prior?.issueType ?? null,
          findingId: prior?.findingId ?? null,
        };
      });

      // 1.00 (inspection line total) + 0.50×4 (field-added per-unit) = 3.00
      assert.equal(sumCompletionLaborHours(resolvedItems), 3);
    });
  });

  // -------------------------------------------------------------------------
  // Reproduces existing client completion-prefill fixtures
  // -------------------------------------------------------------------------
  describe("reproduces existing client completion-prefill fixtures", () => {
    it("per_part field-added items: 0.50×4 + 1.00×2 = 4.00", () => {
      // Matches completion-prefill.test.ts "mirrors the server formula" case.
      const items = [
        { laborHours: "0.50", quantity: 4, issueType: null, findingId: null },
        { laborHours: "1.00", quantity: 2, issueType: null, findingId: null },
      ];
      assert.equal(sumCompletionLaborHours(items), 4);
    });

    it("Woodglenn inspection shape: line totals, qty > 1 → Σ laborHours only", () => {
      // Same item shapes as the Woodglenn WO with per_part mode.
      const items = [
        { laborHours: "0.25", quantity: 4, issueType: "head_adjustment", findingId: null },
        { laborHours: "0.50", quantity: 5, issueType: "broken_head", findingId: null },
        { laborHours: "2.50", quantity: 3, issueType: "pipe_leak", findingId: null },
      ];
      // 0.25 + 0.50 + 2.50 = 3.25 — NOT 11
      assert.equal(sumCompletionLaborHours(items), 3.25);
    });
  });

  // -------------------------------------------------------------------------
  // Tripwire log condition (the logic in routes.ts that gates the warn)
  // -------------------------------------------------------------------------
  describe("tripwire log condition", () => {
    it("fires (values diverge) on a per_part inspection work order", () => {
      const items = [
        { laborHours: "1.00", quantity: 3, issueType: "head_adjustment", findingId: null },
      ];
      const shared = sumCompletionLaborHours(items);
      const old = oldFormula(items);
      assert.equal(shared, 1);   // line total
      assert.equal(old, 3);      // old formula over-counts
      assert.ok(Math.abs(old - shared) > 0.001, "Expected tripwire condition to be true");
    });

    it("silent (values agree) on field-added-only per_part work orders", () => {
      const items = [
        { laborHours: "1.00", quantity: 3, issueType: null, findingId: null },
      ];
      const shared = sumCompletionLaborHours(items);
      const old = oldFormula(items);
      assert.equal(shared, 3);
      assert.equal(old, 3);
      assert.ok(Math.abs(old - shared) <= 0.001, "Expected tripwire condition to be false");
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("handles null/undefined laborHours and quantity without NaN", () => {
      const items = [
        { laborHours: null, quantity: null, issueType: null, findingId: null },
        { laborHours: undefined, quantity: undefined, issueType: "head_adjustment", findingId: null },
        { laborHours: "bad", quantity: 2, issueType: null, findingId: null },
      ];
      assert.equal(sumCompletionLaborHours(items), 0);
    });

    it("handles empty array", () => {
      assert.equal(sumCompletionLaborHours([]), 0);
    });

    it("handles numeric laborHours and quantity values", () => {
      const items = [
        { laborHours: 1.5, quantity: 2, issueType: null, findingId: null },       // field-added: 3.0
        { laborHours: 2.0, quantity: 3, issueType: "pipe_leak", findingId: null }, // inspection: 2.0
      ];
      assert.equal(sumCompletionLaborHours(items), 5);
    });

    it("items with no issueType or findingId property at all are treated as field-added", () => {
      const items = [
        { laborHours: "2.00", quantity: 3 }, // no issueType or findingId → field-added: 6.00
      ];
      assert.equal(sumCompletionLaborHours(items), 6);
    });
  });
});
