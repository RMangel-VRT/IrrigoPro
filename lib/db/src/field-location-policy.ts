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
 * Which location fields a surface should actually show for the selected work
 * type, and which of those are required.
 *
 * Presentation and validation must agree: a field the user cannot see must
 * never be able to block a save, and a field the rule does not use must not
 * be offered as an "optional" extra. Deriving both from this one function is
 * what keeps the billing sheet wizard and work-order completion identical.
 *
 * `hasController` / `hasZone` describe values already stored on the record.
 * They exist purely as a legacy escape hatch: a ticket saved before the work
 * type registry existed can carry a controller with no work type at all, and
 * silently hiding a stored value would make it uneditable and invisible.
 * Nothing is ever hidden while it still holds data.
 */
export type LocationFieldVisibility = {
  showControllerZoneGroup: boolean;
  showController: boolean;
  showZone: boolean;
  controllerRequired: boolean;
  zoneRequired: boolean;
};

export function resolveLocationFieldVisibility(
  rule: FieldWorkTypeRule | null | undefined,
  stored: { hasController?: boolean; hasZone?: boolean } = {},
): LocationFieldVisibility {
  const requiresController = rule?.requiresController === true;
  const requiresZone = rule?.requiresZone === true;
  // A zone is always picked underneath a controller, so a rule that wants a
  // zone implies the controller picker even if it does not require the
  // controller value in its own right.
  const showController =
    requiresController || requiresZone || stored.hasController === true;
  const showZone = requiresZone || stored.hasZone === true;
  return {
    showControllerZoneGroup: showController || showZone,
    showController,
    showZone,
    controllerRequired: requiresController,
    zoneRequired: requiresZone,
  };
}

/**
 * Drop controller/zone values the newly selected work type does not use.
 *
 * Returned as an explicit patch rather than applied in the UI so the billing
 * sheet wizard (local state) and work-order completion (optimistic PATCH)
 * clear exactly the same fields.
 */
export function clearLocationFieldsForRule(
  rule: FieldWorkTypeRule | null | undefined,
  current: { controllerLetter: string | null; zoneNumber: number | null },
): { controllerLetter: string | null; zoneNumber: number | null } {
  const { showController, showZone } = resolveLocationFieldVisibility(rule);
  return {
    controllerLetter: showController ? current.controllerLetter : null,
    zoneNumber: showZone ? current.zoneNumber : null,
  };
}

/**
 * Tickets created before this instant are grandfathered.
 *
 * Billing sheets activated the gate on 2026-09-02 and it is live. Work orders
 * stay parked at 2099 until offline work-order mutations ship: as the
 * work-order gate module records, a signal-less technician must never be
 * trapped by a server requirement he has no way to satisfy in the field.
 */
export const BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT = new Date(
  "2026-09-02T00:00:00.000Z",
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

/**
 * The single place both surfaces decide whether a gate evaluation runs.
 *
 * Work Type is required by the gate, but the registry is per-tenant and there
 * is no way for a company with zero active work types to add one from inside
 * the product. Enforcing there is not enforcement, it is an outage: it happened
 * in production and blocked every field tech until a seed was run. So a
 * confirmed-empty registry fails open, and says so explicitly (rather than
 * merely returning `false`) because the skip has to be audited — a tenant that
 * has silently lost field capture must be visible to Super Admin instead of
 * being discovered by a tech who cannot finish his day.
 *
 * An *unknown* count (null/undefined) is not the same as a confirmed-empty one
 * and keeps the gate on, so an unresolved lookup can never quietly disable it.
 *
 * This module stays pure: the count is an input, never a query performed here.
 */
export type LocationGateDecision = {
  enforced: boolean;
  skippedEmptyRegistry: boolean;
};

export function isEmptyWorkTypeRegistry(
  activeWorkTypeCount: number | null | undefined,
): boolean {
  return (
    typeof activeWorkTypeCount === "number" &&
    Number.isFinite(activeWorkTypeCount) &&
    activeWorkTypeCount <= 0
  );
}

export function resolveLocationGate(input: {
  createdAt: Date | string | null;
  effectiveAt: Date;
  activeWorkTypeCount?: number | null;
}): LocationGateDecision {
  if (!isLocationGateEnforced(input.createdAt, input.effectiveAt)) {
    return { enforced: false, skippedEmptyRegistry: false };
  }
  if (isEmptyWorkTypeRegistry(input.activeWorkTypeCount)) {
    return { enforced: false, skippedEmptyRegistry: true };
  }
  return { enforced: true, skippedEmptyRegistry: false };
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