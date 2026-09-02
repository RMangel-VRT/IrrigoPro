export const WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT =
  new Date("2026-09-02T00:00:00.000Z");

type WorkOrderLocationGateInput = {
  createdAt?: Date | string | null;
  workLocationLat?: string | number | null;
  workLocationLng?: string | number | null;
};

export function isWorkOrderLocationGateEnforced(
  workOrder: WorkOrderLocationGateInput,
): boolean {
  if (!workOrder.createdAt) return false;
  const createdAt = new Date(workOrder.createdAt).getTime();
  return Number.isFinite(createdAt) &&
    createdAt >= WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT.getTime();
}

function validCoordinate(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

export function workOrderLocationGateError(
  workOrder: WorkOrderLocationGateInput,
): string | null {
  if (!isWorkOrderLocationGateEnforced(workOrder)) return null;
  if (
    !validCoordinate(workOrder.workLocationLat) ||
    !validCoordinate(workOrder.workLocationLng)
  ) {
    return "Add the work location pin before completing this work order.";
  }
  return null;
}