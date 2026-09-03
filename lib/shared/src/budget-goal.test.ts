import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBudgetGoalInput } from "./budget-goal";

describe("parseBudgetGoalInput", () => {
  it("preserves the forgiving customer-form formats", () => {
    assert.equal(parseBudgetGoalInput("$12,345.67"), 12345.67);
    assert.equal(parseBudgetGoalInput(" 1 250 "), 1250);
    assert.equal(parseBudgetGoalInput(4500), 4500);
    assert.equal(parseBudgetGoalInput("0"), 0);
  });

  it("rejects blank, negative, and non-numeric values", () => {
    assert.equal(parseBudgetGoalInput(""), null);
    assert.equal(parseBudgetGoalInput("   "), null);
    assert.equal(parseBudgetGoalInput("-1"), null);
    assert.equal(parseBudgetGoalInput("not money"), null);
    assert.equal(parseBudgetGoalInput(null), null);
  });
});