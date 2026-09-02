import {
  BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
  checkLocationGate,
  isLocationGateEnforced,
  type FieldWorkTypeRule,
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

export function shouldEnforceBillingLocationCreate(
  role: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return (
    role === "field_tech" &&
    isLocationGateEnforced(now, BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT)
  );
}

export function shouldEnforceBillingLocationPatch(
  role: string | null | undefined,
  createdAt: Date | string | null | undefined,
  patch: Record<string, unknown>,
): boolean {
  const locationRelevant =
    Object.keys(patch).some((key) => LOCATION_PATCH_KEYS.has(key)) ||
    patch.status === "submitted" ||
    patch.status === "pending_manager_review" ||
    patch.status === "completed";

  return (
    role === "field_tech" &&
    locationRelevant &&
    isLocationGateEnforced(
      createdAt ?? null,
      BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
    )
  );
}

export function getBillingLocationViolations(
  input: LocationGateInput,
  rule: FieldWorkTypeRule | null | undefined,
): LocationGateViolation[] {
  return checkLocationGate(input, rule ?? null);
}