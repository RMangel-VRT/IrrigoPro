import { describe, it, expect } from "vitest";
import { computeCompletionPrefillHours } from "./completion-prefill";

describe("computeCompletionPrefillHours", () => {
  describe("flat mode (regression for doubled labor hours)", () => {
    it("uses the WO header totalHours, not Σ item hours × quantity", () => {
      // Woodglenn signature: estimate flat total 72.50, but items with
      // quantity > 1 whose laborHours are already line totals. The old
      // formula produced 140.25 (≈ 2× the estimate).
      const workOrder = { laborMode: "flat", totalHours: "72.50" };
      const items = [
        { laborHours: "0.25", quantity: 4 }, // "Adjust ×4" — 0.25 covers all 4
        { laborHours: "0.50", quantity: 5 },
        { laborHours: "2.50", quantity: 3 },
      ];
      expect(computeCompletionPrefillHours(workOrder, items)).toBe(72.5);
    });

    it("falls back to a plain sum of line hours (no × quantity) when header hours are missing", () => {
      const items = [
        { laborHours: "0.25", quantity: 4 },
        { laborHours: "0.50", quantity: 5 },
        { laborHours: "1.00", quantity: 1 },
      ];
      // 0.25 + 0.50 + 1.00 = 1.75 — NOT 0.25×4 + 0.50×5 + 1.00 = 4.75
      expect(computeCompletionPrefillHours({ laborMode: "flat", totalHours: null }, items)).toBe(1.75);
      expect(computeCompletionPrefillHours({ laborMode: "flat", totalHours: "0.00" }, items)).toBe(1.75);
    });

    it("treats missing laborMode as flat (system default)", () => {
      const items = [{ laborHours: "3.00", quantity: 2 }];
      expect(computeCompletionPrefillHours({ totalHours: "5.00" }, items)).toBe(5);
    });

    it("handles junk values without NaN", () => {
      const items = [{ laborHours: "abc", quantity: 2 }, { laborHours: null, quantity: null }];
      expect(computeCompletionPrefillHours({ laborMode: "flat", totalHours: "bad" }, items)).toBe(0);
    });
  });

  describe("per_part mode", () => {
    it("mirrors the server formula: Σ laborHours × quantity for field-added rows", () => {
      const workOrder = { laborMode: "per_part", totalHours: "99.00" };
      const items = [
        { laborHours: "0.50", quantity: 4 }, // per-unit hours — no issueType, treated field-added
        { laborHours: "1.00", quantity: 2 },
      ];
      expect(computeCompletionPrefillHours(workOrder, items)).toBe(4);
    });

    it("treats inspection-derived items (issueType non-null) as line totals, not per-unit", () => {
      // Inspection-derived rows have issueType set from the wet-check finding.
      // laborHours is a line total accumulated during the merge in
      // inspection-estimate-items.ts; multiplying by quantity would double-count.
      const workOrder = { laborMode: "per_part", totalHours: "99.00" };
      const items = [
        { laborHours: "0.25", quantity: 4, issueType: "head_adjustment" },
        { laborHours: "0.50", quantity: 5, issueType: "broken_head" },
      ];
      // 0.25 + 0.50 = 0.75 — NOT 0.25×4 + 0.50×5 = 3.50
      expect(computeCompletionPrefillHours(workOrder, items)).toBe(0.75);
    });

    it("handles mixed: inspection rows (issueType set) sum as line totals, field-added multiply", () => {
      const workOrder = { laborMode: "per_part" };
      const items = [
        { laborHours: "2.00", quantity: 3, issueType: "pipe_leak" }, // line total: 2.00
        { laborHours: "1.00", quantity: 2 },                          // field-added: 2.00
      ];
      // 2.00 + 2.00 = 4.00
      expect(computeCompletionPrefillHours(workOrder, items)).toBe(4);
    });
  });
});
