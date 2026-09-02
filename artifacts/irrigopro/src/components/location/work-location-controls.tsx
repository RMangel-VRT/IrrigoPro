import { useEffect, useRef } from "react";
import { Briefcase, Cpu, Droplets } from "lucide-react";
import type { FieldWorkType } from "@workspace/db/schema";
import {
  checkLocationGate,
  type LocationGateViolation,
} from "@workspace/db/field-location-policy";
import { useArrayQuery } from "@/lib/queryClient";
import type { CustomerController } from "@/lib/controller-types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface WorkLocationRequirementsValue {
  workLocation: { lat: number; lng: number; address?: string } | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
  fieldWorkType: string | null;
  fieldWorkTypeDetails: string;
}

interface WorkLocationControlsProps<T extends WorkLocationRequirementsValue> {
  customerId: number | null | undefined;
  value: T;
  onChange: (next: T) => void;
  enforceLocationGate?: boolean;
  onGateStateChange?: (
    complete: boolean,
    violations: LocationGateViolation[],
  ) => void;
  showStatus?: boolean;
  grouped?: boolean;
}

export const LOCATION_GATE_VIOLATION_LABELS: Record<LocationGateViolation, string> = {
  pin_missing: "Pin the exact work location (use “I’m here” or click the map).",
  work_type_missing: "Choose a work type.",
  controller_missing: "Choose the controller.",
  zone_missing: "Choose the zone.",
  details_missing: "Add details for this work type.",
};

export function WorkLocationGateStatus({
  violations,
}: {
  violations: LocationGateViolation[];
}) {
  const complete = violations.length === 0;
  return (
    <div
      className={
        complete
          ? "rounded-lg border border-green-200 bg-green-50 p-3"
          : "rounded-lg border border-red-200 bg-red-50 p-3"
      }
      role="status"
      data-testid="location-gate-status"
    >
      {complete ? (
        <p className="text-sm font-medium text-green-800">Location details complete.</p>
      ) : (
        <>
          <p className="text-sm font-semibold text-red-800">Before you continue:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-red-700">
            {violations.map((violation) => (
              <li key={violation}>{LOCATION_GATE_VIOLATION_LABELS[violation]}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function WorkLocationControls<T extends WorkLocationRequirementsValue>({
  customerId,
  value,
  onChange,
  enforceLocationGate = false,
  onGateStateChange,
  showStatus = false,
  grouped = false,
}: WorkLocationControlsProps<T>) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onGateStateChangeRef = useRef(onGateStateChange);
  onGateStateChangeRef.current = onGateStateChange;

  const { data: controllers = [], isLoading: controllersLoading } =
    useArrayQuery<CustomerController>({
      queryKey: ["/api/properties", customerId, "controllers"],
      enabled: !!customerId,
    });
  const { data: workTypes = [], isLoading: workTypesLoading } =
    useArrayQuery<FieldWorkType>({
      queryKey: ["/api/field-work-types"],
      enabled: !!customerId,
    });

  const selectedController = controllers.find(
    (controller) => controller.controllerLetter === value.controllerLetter,
  );
  const zoneCount = selectedController?.zoneCount ?? 0;
  const selectedWorkType = workTypes.find((type) => type.code === value.fieldWorkType);
  const violations = enforceLocationGate
    ? checkLocationGate(
        {
          workLocationLat: value.workLocation?.lat ?? null,
          workLocationLng: value.workLocation?.lng ?? null,
          fieldWorkType: value.fieldWorkType,
          fieldWorkTypeDetails: value.fieldWorkTypeDetails,
          controllerLetter: value.controllerLetter,
          zoneNumber: value.zoneNumber,
        },
        selectedWorkType
          ? {
              code: selectedWorkType.code,
              requiresController: selectedWorkType.requiresController,
              requiresZone: selectedWorkType.requiresZone,
              requiresDetails: selectedWorkType.requiresDetails,
            }
          : null,
      )
    : [];

  useEffect(() => {
    onGateStateChangeRef.current?.(violations.length === 0, violations);
  }, [violations.join("|")]);

  useEffect(() => {
    if (controllersLoading || !value.controllerLetter) return;
    if (!controllers.some((controller) => controller.controllerLetter === value.controllerLetter)) {
      onChange({
        ...valueRef.current,
        controllerLetter: null,
        zoneNumber: null,
      });
    }
  }, [controllers, controllersLoading, onChange, value.controllerLetter]);

  useEffect(() => {
    if (value.zoneNumber == null || !selectedController) return;
    if (value.zoneNumber > zoneCount) {
      onChange({ ...valueRef.current, zoneNumber: null });
    }
  }, [onChange, selectedController, value.zoneNumber, zoneCount]);

  const workTypeContent = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="bg-blue-50 p-2 rounded-md">
          <Briefcase className="w-4 h-4 text-blue-600" />
        </div>
        <h3 className="text-base font-semibold text-gray-900">
          Work Type{" "}
          {enforceLocationGate ? (
            <span className="text-red-500">*</span>
          ) : (
            <span className="text-xs text-gray-500 font-normal">(optional)</span>
          )}
        </h3>
      </div>
      <Select
        value={value.fieldWorkType ?? "__none__"}
        onValueChange={(workType) =>
          onChange({
            ...valueRef.current,
            fieldWorkType: workType === "__none__" ? null : workType,
            fieldWorkTypeDetails:
              workType === valueRef.current.fieldWorkType
                ? valueRef.current.fieldWorkTypeDetails
                : "",
          })
        }
        disabled={workTypesLoading}
      >
        <SelectTrigger>
          <SelectValue
            placeholder={workTypesLoading ? "Loading work types…" : "Select work type"}
          />
        </SelectTrigger>
        <SelectContent>
          {!enforceLocationGate && <SelectItem value="__none__">— None —</SelectItem>}
          {workTypes.map((type) => (
            <SelectItem key={type.code} value={type.code}>
              {type.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedWorkType?.requiresDetails && (
        <div className="space-y-1">
          <Label htmlFor="field-work-type-details" className="text-xs text-gray-600">
            Work type details{" "}
            {enforceLocationGate && <span className="text-red-500">*</span>}
          </Label>
          <Input
            id="field-work-type-details"
            value={value.fieldWorkTypeDetails}
            onChange={(event) =>
              onChange({
                ...valueRef.current,
                fieldWorkTypeDetails: event.target.value,
              })
            }
            placeholder="Describe the work"
          />
        </div>
      )}
    </div>
  );

  const controllerContent = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="bg-blue-50 p-2 rounded-md">
          <Cpu className="w-4 h-4 text-blue-600" />
        </div>
        <h3 className="text-base font-semibold text-gray-900">
          Controller &amp; Zone{" "}
          <span className="text-xs text-gray-500 font-normal">
            {enforceLocationGate &&
            (selectedWorkType?.requiresController || selectedWorkType?.requiresZone)
              ? "(required by work type)"
              : "(optional)"}
          </span>
        </h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-gray-600">
            Controller{" "}
            {enforceLocationGate && selectedWorkType?.requiresController && (
              <span className="text-red-500">*</span>
            )}
          </Label>
          <Select
            value={value.controllerLetter ?? "__none__"}
            onValueChange={(letter) =>
              onChange({
                ...valueRef.current,
                controllerLetter: letter === "__none__" ? null : letter,
                zoneNumber: null,
              })
            }
            disabled={controllersLoading || controllers.length === 0}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  controllersLoading
                    ? "Loading controllers…"
                    : controllers.length === 0
                      ? "No controllers on file"
                      : "Select controller"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {(!enforceLocationGate || !selectedWorkType?.requiresController) && (
                <SelectItem value="__none__">— None —</SelectItem>
              )}
              {controllers.map((controller) => (
                <SelectItem
                  key={controller.controllerLetter}
                  value={controller.controllerLetter}
                >
                  Controller {controller.controllerLetter}{" "}
                  <span className="text-gray-500">({controller.zoneCount} zones)</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-gray-600 flex items-center gap-1">
            <Droplets className="w-3 h-3" /> Zone
            {enforceLocationGate && selectedWorkType?.requiresZone && (
              <span className="text-red-500">*</span>
            )}
          </Label>
          <Select
            value={value.zoneNumber == null ? "__none__" : String(value.zoneNumber)}
            onValueChange={(zone) =>
              onChange({
                ...valueRef.current,
                zoneNumber: zone === "__none__" ? null : Number(zone),
              })
            }
            disabled={!selectedController || zoneCount === 0}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={!selectedController ? "Pick a controller first" : "Select zone"}
              />
            </SelectTrigger>
            <SelectContent>
              {(!enforceLocationGate || !selectedWorkType?.requiresZone) && (
                <SelectItem value="__none__">— None —</SelectItem>
              )}
              {Array.from({ length: zoneCount }, (_, index) => index + 1).map((zone) => (
                <SelectItem key={zone} value={String(zone)}>
                  Zone {zone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {grouped ? (
        <>
          {workTypeContent}
          {controllerContent}
        </>
      ) : (
        <>
          <div className="rounded-lg border p-4">{workTypeContent}</div>
          <div className="rounded-lg border p-4">{controllerContent}</div>
        </>
      )}
      {showStatus && enforceLocationGate && (
        <WorkLocationGateStatus violations={violations} />
      )}
    </div>
  );
}