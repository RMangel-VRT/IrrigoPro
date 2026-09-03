import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requireBulkBudgetGoalsAdmin } from "./role-guards";
import { CAN_MANAGE_BULK_BUDGET_GOALS, hasCapability } from "@workspace/shared";

function guardStatus(role: unknown): number {
  let status = 200;
  let nextCalled = false;
  const res = {
    status(value: number) {
      status = value;
      return this;
    },
    json() {
      return this;
    },
  };
  requireBulkBudgetGoalsAdmin(
    { authenticatedUserRole: role } as any,
    res as any,
    () => {
      nextCalled = true;
    },
  );
  return nextCalled ? 200 : status;
}

describe("bulk annual budget authority", () => {
  it("allows only super_admin and company_admin", () => {
    for (const role of ["super_admin", "company_admin"]) {
      assert.equal(hasCapability(role, CAN_MANAGE_BULK_BUDGET_GOALS), true);
      assert.equal(guardStatus(role), 200);
    }
    for (const role of [
      "billing_manager",
      "irrigation_manager",
      "field_tech",
      "bookkeeper",
      "auditor",
      "",
      null,
      undefined,
    ]) {
      assert.equal(hasCapability(role, CAN_MANAGE_BULK_BUDGET_GOALS), false);
      assert.equal(guardStatus(role), 403);
    }
  });
});