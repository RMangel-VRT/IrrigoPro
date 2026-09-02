import {
  WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
  checkLocationGate,
  isLocationGateEnforced,
  type FieldWorkTypeRule,
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

export function isWorkOrderLocationGateEnforced(
  workOrder: WorkOrderLocationGateInput,
): boolean {
  return isLocationGateEnforced(
    workOrder.createdAt ?? null,
    WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
  );
}

export function getWorkOrderLocationViolations(
  workOrder: WorkOrderLocationGateInput,
  rule: FieldWorkTypeRule | null,
): LocationGateViolation[] {
  if (!isWorkOrderLocationGateEnforced(workOrder)) return [];
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
): string | null {
  const violations = getWorkOrderLocationViolations(workOrder, rule);
  return violations.length > 0
    ? "Complete every required work location field before completing this work order."
    : null;
}