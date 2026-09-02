import {
  WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
  checkLocationGate,
  resolveLocationGate,
  type FieldWorkTypeRule,
  type LocationGateDecision,
  type LocationGateViolation,
} from "@workspace/db";

// Intentionally re-export the shared 2099 cutoff. The online path is complete,
// but activation belongs to the separate offline-capability task so a
// signal-less technician cannot be trapped by a server gate they cannot satisfy.
export { WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT };

type WorkOrderLocationGateInput = {
  createdAt?: Date | string | null;
  workLocationLat?: string | number | null;
  workLocationLng?: string | number | null;
  fieldWorkType?: string | null;
  fieldWorkTypeDetails?: string | null;
  controllerLetter?: string | null;
  zoneNumber?: number | null;
};

/**
 * Both surfaces resolve through the shared policy so they cannot drift: the
 * cutoff decides grandfathering, and a tenant whose work-type registry is
 * confirmed empty fails open rather than being locked out by a Work Type
 * requirement nobody in that company is able to satisfy.
 */
export function resolveWorkOrderLocationGate(
  workOrder: WorkOrderLocationGateInput,
  activeWorkTypeCount?: number | null,
): LocationGateDecision {
  return resolveLocationGate({
    createdAt: workOrder.createdAt ?? null,
    effectiveAt: WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
    activeWorkTypeCount,
  });
}

export function isWorkOrderLocationGateEnforced(
  workOrder: WorkOrderLocationGateInput,
  activeWorkTypeCount?: number | null,
): boolean {
  return resolveWorkOrderLocationGate(workOrder, activeWorkTypeCount).enforced;
}

export function getWorkOrderLocationViolations(
  workOrder: WorkOrderLocationGateInput,
  rule: FieldWorkTypeRule | null,
  activeWorkTypeCount?: number | null,
): LocationGateViolation[] {
  if (!isWorkOrderLocationGateEnforced(workOrder, activeWorkTypeCount)) return [];
  return checkLocationGate(
    {
      workLocationLat: workOrder.workLocationLat ?? null,
      workLocationLng: workOrder.workLocationLng ?? null,
      fieldWorkType: workOrder.fieldWorkType ?? null,
      fieldWorkTypeDetails: workOrder.fieldWorkTypeDetails ?? null,
      controllerLetter: workOrder.controllerLetter ?? null,
      zoneNumber: workOrder.zoneNumber ?? null,
    },
    rule,
  );
}

export function workOrderLocationGateError(
  workOrder: WorkOrderLocationGateInput,
  rule: FieldWorkTypeRule | null = null,
  activeWorkTypeCount?: number | null,
): string | null {
  const violations = getWorkOrderLocationViolations(
    workOrder,
    rule,
    activeWorkTypeCount,
  );
  return violations.length > 0
    ? "Complete every required work location field before completing this work order."
    : null;
}