/**
 * The billing sheet wizard's step-2 gate.
 *
 * It shipped as `isFieldTech && isLocationGateEnforced(…)`, so an irrigation
 * manager, company admin or billing manager could walk straight past step 2
 * with no pin, no work type, no controller and no zone — and then save clean,
 * because the server gate carried the same role condition. Managers do field
 * work, so that produced exactly the unanswerable record the gate exists to
 * prevent.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT } from "@workspace/db/field-location-policy";
import {
  canContinueFromLocationStep,
  shouldEnforceWizardLocationGate,
} from "./billing-sheet-wizard-gate";

const ROLES = [
  "field_tech",
  "irrigation_manager",
  "company_admin",
  "billing_manager",
  "super_admin",
];

// What the wizard passes for a brand new sheet, and for a legacy one.
const NEW_SHEET_CREATED_AT = new Date(
  BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT.getTime() + 86_400_000,
);
const LEGACY_SHEET_CREATED_AT = new Date(
  BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT.getTime() - 1,
).toISOString();

describe("billing sheet wizard location gate", () => {
  it.each(ROLES)("blocks step 2 on a new sheet for %s", (role) => {
    // The signed-in role is not an input to the decision, so every role lands
    // on the same answer. The loop is the contract: if a role condition ever
    // returns, these rows stop agreeing.
    const enforce = shouldEnforceWizardLocationGate(NEW_SHEET_CREATED_AT);
    expect(enforce, role).toBe(true);
    expect(canContinueFromLocationStep(enforce, false), role).toBe(false);
    expect(canContinueFromLocationStep(enforce, true), role).toBe(true);
  });

  it.each(ROLES)("blocks nobody on a legacy sheet, including %s", (role) => {
    const enforce = shouldEnforceWizardLocationGate(LEGACY_SHEET_CREATED_AT);
    expect(enforce, role).toBe(false);
    expect(canContinueFromLocationStep(enforce, false), role).toBe(true);
  });

  it("treats a sheet with no creation instant as ungated", () => {
    expect(shouldEnforceWizardLocationGate(null)).toBe(false);
  });

  it("keeps the role condition out of the wizard's gate for good", () => {
    const source = readFileSync(
      "src/components/billing/billing-sheet-wizard.tsx",
      "utf8",
    );
    const assignment = source
      .split("\n")
      .find((line) => line.includes("const enforceBillingLocationGate"));
    expect(assignment).toBeDefined();
    expect(assignment).not.toMatch(/isFieldTech|isManagerClass|role/);
  });
});
