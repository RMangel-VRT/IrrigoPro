import {
  BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
  isLocationGateEnforced,
} from "@workspace/db/field-location-policy";

/**
 * Whether the billing sheet wizard enforces the work-location gate.
 *
 * Deliberately takes no role. The wizard shipped as `isFieldTech && …`, which
 * let an irrigation manager, company admin or billing manager walk past step 2
 * with no pin and no work type — and managers do field work. The server gate
 * has no role condition either, so both must turn on the same single fact: the
 * sheet's creation instant against the cutoff. A new sheet is created now; an
 * existing one is judged by when it was created, so legacy sheets stay
 * editable for everyone.
 *
 * The empty-registry fail-open is not decided here: the work-location controls
 * report the gate satisfied when the tenant has no active work types, which is
 * the same fact the server fails open on.
 */
export function shouldEnforceWizardLocationGate(
  sheetCreatedAt: Date | string | null,
): boolean {
  return isLocationGateEnforced(
    sheetCreatedAt,
    BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
  );
}

/** Step 2 may be left only when the gate does not apply or is satisfied. */
export function canContinueFromLocationStep(
  enforceLocationGate: boolean,
  locationGateComplete: boolean,
): boolean {
  return !enforceLocationGate || locationGateComplete;
}
