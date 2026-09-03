import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_GOAL_CONFIRMATION_TTL_MS,
  canonicalBudgetGoalRows,
  classifyBudgetGoalRows,
  issueBudgetGoalConfirmation,
  parseBudgetGoalPaste,
  verifyBudgetGoalConfirmation,
} from "./budget-goal-bulk";

describe("bulk annual budget paste parser", () => {
  it("accepts tabs, comma separators, money formats, headers, and blank lines", () => {
    const rows = parseBudgetGoalPaste([
      "Customer Name\tAnnual Goal",
      "",
      "Alpha Irrigation\t$12,500.25",
      "Beta HOA,9,000",
      "Gamma\t 1 250 ",
    ].join("\n"));
    assert.deepEqual(rows.map((row) => ({
      rowNumber: row.rowNumber,
      name: row.customerName,
      goal: row.goal,
      valid: row.valid,
    })), [
      { rowNumber: 3, name: "Alpha Irrigation", goal: 12500.25, valid: true },
      { rowNumber: 4, name: "Beta HOA", goal: 9000, valid: true },
      { rowNumber: 5, name: "Gamma", goal: 1250, valid: true },
    ]);
  });

  it("returns invalid rows instead of silently dropping malformed input", () => {
    const rows = parseBudgetGoalPaste("Missing goal\n\t100\nAlpha\tnegative");
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => !row.valid));
    assert.match(rows[0].reason ?? "", /exactly two columns/i);
    assert.match(rows[1].reason ?? "", /name is required/i);
    assert.match(rows[2].reason ?? "", /non-negative/i);
  });
});

describe("bulk annual budget exact matching", () => {
  const customers = [
    { id: 1, name: "Alpha HOA", annualBudgetGoal: "1000.00" },
    { id: 2, name: "Duplicate", annualBudgetGoal: null },
    { id: 3, name: " duplicate ", annualBudgetGoal: "50.00" },
  ];

  it("classifies changed, unchanged, unmatched, ambiguous, and invalid rows", () => {
    const rows = parseBudgetGoalPaste([
      " alpha hoa \t2000",
      "Alpha HOA\t1000",
      "Outside Tenant\t300",
      "Duplicate\t400",
      "Bad\tnope",
    ].join("\n"));
    assert.deepEqual(
      classifyBudgetGoalRows(rows, customers).map((row) => row.status),
      ["ambiguous", "ambiguous", "unmatched", "ambiguous", "invalid"],
    );
  });

  it("matches case-insensitively and reports a repeated paste as unchanged", () => {
    const rows = parseBudgetGoalPaste("  ALPHA hoa  \t$1,000.00");
    const [classified] = classifyBudgetGoalRows(rows, customers);
    assert.equal(classified.status, "unchanged");
    assert.equal(classified.customerId, 1);
  });

  it("never sees a same-named customer outside the supplied company set", () => {
    const [classified] = classifyBudgetGoalRows(
      parseBudgetGoalPaste("Cross Company\t500"),
      customers,
    );
    assert.equal(classified.status, "unmatched");
    assert.equal(classified.customerId, null);
    assert.doesNotMatch(classified.reason ?? "", /other|cross|company 2/i);
  });
});

describe("bulk annual budget confirmation", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");
  const rows = parseBudgetGoalPaste("Alpha HOA\t2000");
  const claims = {
    userId: 7,
    companyId: 10,
    year: 2027,
    canonicalRows: canonicalBudgetGoalRows(rows),
  };

  it("binds caller, company, year, and canonical row set", () => {
    const { token } = issueBudgetGoalConfirmation(claims, now);
    assert.equal(verifyBudgetGoalConfirmation(token, { ...claims, userId: 8 }, now).ok, false);
    assert.equal(verifyBudgetGoalConfirmation(token, { ...claims, companyId: 11 }, now).ok, false);
    assert.equal(verifyBudgetGoalConfirmation(token, { ...claims, year: 2028 }, now).ok, false);
    assert.equal(
      verifyBudgetGoalConfirmation(token, {
        ...claims,
        canonicalRows: canonicalBudgetGoalRows(parseBudgetGoalPaste("Alpha HOA\t3000")),
      }, now).ok,
      false,
    );
  });

  it("is single use", () => {
    const { token } = issueBudgetGoalConfirmation(claims, now);
    assert.deepEqual(verifyBudgetGoalConfirmation(token, claims, now), { ok: true });
    const replay = verifyBudgetGoalConfirmation(token, claims, now);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.reason, "confirmation_used");
  });

  it("expires and refuses a missing token", () => {
    const { token } = issueBudgetGoalConfirmation(claims, now);
    const expired = verifyBudgetGoalConfirmation(
      token,
      claims,
      new Date(now.getTime() + BUDGET_GOAL_CONFIRMATION_TTL_MS + 1),
    );
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.reason, "confirmation_expired");
    const missing = verifyBudgetGoalConfirmation(undefined, claims, now);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "confirmation_required");
  });
});