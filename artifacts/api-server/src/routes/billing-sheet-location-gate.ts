import {
  BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
  checkLocationGate,
  resolveLocationGate,
  type FieldWorkTypeRule,
  type LocationGateDecision,
  type LocationGateInput,
  type LocationGateViolation,
} from "@workspace/db";

const LOCATION_PATCH_KEYS = new Set([
  "workLocationLat",
  "workLocationLng",
  "workLocationAddress",
  "fieldWorkType",
  "fieldWorkTypeDetails",
  "workLocationSource",
  "workLocationAccuracyM",
  "workLocationGpsError",
  "controllerLetter",
  "zoneNumber",
]);

/**
 * The gate deliberately takes no role.
 *
 * It shipped as `role === "field_tech" && …`, which was never in the spec and
 * left an irrigation manager, company admin or billing manager free to save a
 * sheet with no pin, work type, controller or zone. Managers do field work —
 * an assigned irrigation manager can complete a work order exactly like a tech
 * — so that produced precisely the unanswerable record this gate exists to
 * prevent, and it made the two surfaces disagree (the work-order gate has no
 * role condition at all). A parameter that always passes is dead weight and
 * invites the condition creeping back, so it is gone rather than widened.
 */
export function resolveBillingLocationCreateGate(
  now: Date = new Date(),
  activeWorkTypeCount?: number | null,
): LocationGateDecision {
  return resolveLocationGate({
    createdAt: now,
    effectiveAt: BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
    activeWorkTypeCount,
  });
}

export function resolveBillingLocationPatchGate(
  createdAt: Date | string | null | undefined,
  patch: Record<string, unknown>,
  activeWorkTypeCount?: number | null,
): LocationGateDecision {
  // A status transition is location-relevant on purpose: otherwise the gate
  // could be walked past by patching `status` instead of a location field.
  const locationRelevant =
    Object.keys(patch).some((key) => LOCATION_PATCH_KEYS.has(key)) ||
    patch.status === "submitted" ||
    patch.status === "pending_manager_review" ||
    patch.status === "completed";

  if (!locationRelevant) return { enforced: false, skippedEmptyRegistry: false };

  return resolveLocationGate({
    createdAt: createdAt ?? null,
    effectiveAt: BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
    activeWorkTypeCount,
  });
}

export function getBillingLocationViolations(
  input: LocationGateInput,
  rule: FieldWorkTypeRule | null | undefined,
): LocationGateViolation[] {
  return checkLocationGate(input, rule ?? null);
}
