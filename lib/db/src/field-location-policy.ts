/**
 * Shared field-location requirement policy.
 *
 * This module is deliberately pure and is exported from @workspace/db so the
 * API and client can evaluate exactly the same facts. Stored ticket columns
 * remain the source of truth; confidence is a projection, not another field.
 */

export type FieldWorkTypeRule = {
  code: string;
  requiresController: boolean;
  requiresZone: boolean;
  requiresDetails: boolean;
};

export type LocationGateViolation =
  | "pin_missing"
  | "work_type_missing"
  | "controller_missing"
  | "zone_missing"
  | "details_missing";

export type LocationGateInput = {
  workLocationLat: string | number | null;
  workLocationLng: string | number | null;
  fieldWorkType: string | null;
  fieldWorkTypeDetails: string | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
};

function isFiniteCoordinate(value: string | number | null | undefined): boolean {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return false;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric);
}

/**
 * Return every missing requirement in stable, user-presentable order.
 *
 * A missing/unknown work type cannot safely provide a requirement matrix, so
 * it reports only the pin and work-type violations rather than guessing at
 * controller/zone/details requirements.
 */
export function checkLocationGate(
  input: LocationGateInput,
  rule: FieldWorkTypeRule | null,
): LocationGateViolation[] {
  const violations: LocationGateViolation[] = [];

  if (!isFiniteCoordinate(input.workLocationLat) || !isFiniteCoordinate(input.workLocationLng)) {
    violations.push("pin_missing");
  }

  const hasWorkType =
    typeof input.fieldWorkType === "string" && input.fieldWorkType.trim().length > 0;
  if (!hasWorkType || rule == null || rule.code !== input.fieldWorkType!.trim()) {
    violations.push("work_type_missing");
    return violations;
  }

  if (
    rule.requiresController &&
    !(typeof input.controllerLetter === "string" && input.controllerLetter.trim().length > 0)
  ) {
    violations.push("controller_missing");
  }
  if (
    rule.requiresZone &&
    (input.zoneNumber == null || !Number.isFinite(Number(input.zoneNumber)))
  ) {
    violations.push("zone_missing");
  }
  if (
    rule.requiresDetails &&
    !(typeof input.fieldWorkTypeDetails === "string" && input.fieldWorkTypeDetails.trim().length > 0)
  ) {
    violations.push("details_missing");
  }

  return violations;
}

/**
 * Tickets created before this instant are grandfathered. Both rollout
 * surfaces intentionally ship disabled by using a far-future date.
 */
export const BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT = new Date(
  "2099-01-01T00:00:00.000Z",
);
export const WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT = new Date(
  "2099-01-01T00:00:00.000Z",
);

export function isLocationGateEnforced(
  createdAt: Date | string | null,
  effectiveAt: Date,
): boolean {
  if (createdAt == null || Number.isNaN(effectiveAt.getTime())) return false;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  return created.getTime() >= effectiveAt.getTime();
}

export type LocationConfidence = "high" | "low" | "unknown";

export function deriveLocationConfidence(input: {
  workLocationSource: string | null;
  workLocationGpsError: string | null;
}): LocationConfidence {
  if (
    input.workLocationSource === "manual" &&
    typeof input.workLocationGpsError === "string" &&
    input.workLocationGpsError.trim().length > 0
  ) {
    return "low";
  }
  if (input.workLocationSource === "manual" || input.workLocationSource === "gps") {
    return "high";
  }
  return "unknown";
}