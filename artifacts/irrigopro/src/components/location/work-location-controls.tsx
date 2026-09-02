import { useEffect, useRef } from "react";
import { Briefcase, Cpu, Droplets } from "lucide-react";
import {
  checkLocationGate,
  clearLocationFieldsForRule,
  resolveLocationFieldVisibility,
  type FieldWorkTypeRule,
  type LocationGateViolation,
} from "@workspace/db/field-location-policy";
import { useArrayQuery } from "@/lib/queryClient";
import { useFieldWorkTypeRegistry } from "@/hooks/use-field-work-type-registry";
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

/**
 * Radix treats only `""` and `undefined` as "nothing selected". Passing a
 * sentinel such as `__none__` while the matching `SelectItem` is not rendered
 * leaves the trigger blank — no value AND no placeholder — which reads as a
 * dead control. Every select here therefore uses `""` for the empty state and
 * keeps the sentinel for the optional "— None —" item only.
 */
const NONE_VALUE = "__none__";

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
  const {
    selectable: selectableWorkTypes,
    resolveLabel: resolveWorkTypeLabel,
    resolveRule: resolveWorkTypeRule,
    isLoading: workTypesLoading,
    isError: workTypesError,
  } = useFieldWorkTypeRegistry({ customerId });

  const selectedController = controllers.find(
    (controller) => controller.controllerLetter === value.controllerLetter,
  );
  const zoneCount = selectedController?.zoneCount ?? 0;
  // Two questions live a few lines apart here and must not be conflated:
  // what the user may *choose* (the active list, below) and what the code
  // already on this record *requires* (the full registry, here). A retired
  // type resolves the rule it was saved under, matching the server gate and
  // the Missing Location Data report.
  const selectedRule: FieldWorkTypeRule | null = resolveWorkTypeRule(
    value.fieldWorkType,
  );

  // The registry is per-tenant, so "no work types" is a real configuration
  // state, not just a loading frame. Left unsaid it renders an empty menu that
  // simply does not appear to open. Say it out loud instead — and, because
  // nothing in the product lets anyone add a work type, treat the confirmed
  // empty registry as "the gate does not apply" rather than as a requirement
  // this company has no way to satisfy. The server fails open on exactly the
  // same fact and audits the skip.
  // Driven by the *selectable* list alone: a company left holding nothing but
  // retired rows still has no work type anyone can pick, so it is empty here
  // exactly as the server's active-only count reads it.
  const workTypesUnavailable =
    !!customerId &&
    !workTypesLoading &&
    !workTypesError &&
    selectableWorkTypes.length === 0;
  const gateApplies = enforceLocationGate && !workTypesUnavailable;
  const workTypePlaceholder = !customerId
    ? "Pick a customer first"
    : workTypesLoading
      ? "Loading work types…"
      : workTypesError
        ? "Could not load work types"
        : workTypesUnavailable
          ? "No work types configured"
          : "Select work type";
  const workTypeDisabled =
    !customerId || workTypesLoading || workTypesError || workTypesUnavailable;
  // A code stored on the record but no longer offered (renamed or retired)
  // must still render, or the trigger goes blank again. It is added as an
  // extra option purely so the record can display itself — never to make a
  // retired type choosable for new work.
  const storedWorkTypeMissing =
    !!value.fieldWorkType &&
    !selectableWorkTypes.some((type) => type.code === value.fieldWorkType) &&
    !workTypesLoading;

  const visibility = resolveLocationFieldVisibility(selectedRule, {
    hasController: !!value.controllerLetter,
    hasZone: value.zoneNumber != null,
  });

  const violations = gateApplies
    ? checkLocationGate(
        {
          workLocationLat: value.workLocation?.lat ?? null,
          workLocationLng: value.workLocation?.lng ?? null,
          fieldWorkType: value.fieldWorkType,
          fieldWorkTypeDetails: value.fieldWorkTypeDetails,
          controllerLetter: value.controllerLetter,
          zoneNumber: value.zoneNumber,
        },
        selectedRule,
      )
    : [];

  useEffect(() => {
    onGateStateChangeRef.current?.(violations.length === 0, violations);
  }, [violations.join("|")]);

  // Switching to a different customer invalidates a controller picked for the
  // previous one. That is the only automatic clear here, and it is keyed off
  // an explicit user action rather than off the fetched list disagreeing with
  // the stored value: `useArrayQuery` reports a failed or forbidden controller
  // fetch as an empty array, and work-order completion persists every onChange
  // immediately, so reconciling against list contents would silently delete a
  // legacy controller the moment the request failed. Values that no longer
  // match the list are surfaced as explicit "no longer on file" options below.
  const previousCustomerIdRef = useRef(customerId);
  useEffect(() => {
    const previous = previousCustomerIdRef.current;
    previousCustomerIdRef.current = customerId;
    if (previous == null || previous === customerId) return;
    const current = valueRef.current;
    if (current.controllerLetter == null && current.zoneNumber == null) return;
    onChange({ ...current, controllerLetter: null, zoneNumber: null });
  }, [customerId, onChange]);

  const storedControllerMissing =
    !!value.controllerLetter && !selectedController && !controllersLoading;
  const storedZoneOutOfRange =
    value.zoneNumber != null && (!selectedController || value.zoneNumber > zoneCount);

  const handleWorkTypeChange = (nextCode: string) => {
    const code = nextCode === NONE_VALUE ? null : nextCode;
    const current = valueRef.current;
    // Values the new rule does not use are dropped here rather than in an
    // effect: clearing must follow an explicit choice by the user, never a
    // mount, so opening a legacy ticket can never quietly erase its data.
    const cleared = clearLocationFieldsForRule(
      resolveWorkTypeRule(code),
      { controllerLetter: current.controllerLetter, zoneNumber: current.zoneNumber },
    );
    onChange({
      ...current,
      fieldWorkType: code,
      fieldWorkTypeDetails:
        code === current.fieldWorkType ? current.fieldWorkTypeDetails : "",
      ...cleared,
    });
  };

  const workTypeContent = (
    <div className="space-y-3" data-testid="work-type-section">
      <div className="flex items-center gap-2">
        <div className="bg-blue-50 p-2 rounded-md">
          <Briefcase className="w-4 h-4 text-blue-600" />
        </div>
        <h3 className="text-base font-semibold text-gray-900">
          Work Type{" "}
          {gateApplies ? (
            <span className="text-red-500">*</span>
          ) : (
            <span className="text-xs text-gray-500 font-normal">(optional)</span>
          )}
        </h3>
      </div>
      <Select
        value={value.fieldWorkType ?? ""}
        onValueChange={handleWorkTypeChange}
        disabled={workTypeDisabled}
      >
        <SelectTrigger data-testid="select-work-type">
          <SelectValue placeholder={workTypePlaceholder} />
        </SelectTrigger>
        <SelectContent>
          {!gateApplies && <SelectItem value={NONE_VALUE}>— None —</SelectItem>}
          {storedWorkTypeMissing && (
            <SelectItem value={value.fieldWorkType!}>
              {resolveWorkTypeLabel(value.fieldWorkType) ?? value.fieldWorkType}{" "}
              (no longer offered)
            </SelectItem>
          )}
          {selectableWorkTypes.map((type) => (
            <SelectItem key={type.code} value={type.code}>
              {type.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {workTypesError && (
        <p className="text-xs text-red-600" data-testid="text-work-types-error">
          Work types could not be loaded. Check your connection and try again.
        </p>
      )}
      {workTypesUnavailable && (
        <p className="text-xs text-gray-600" data-testid="text-work-types-unavailable">
          No work types are set up for this company yet, so work type is not
          required here. You can save without one.
        </p>
      )}
      {selectedRule?.requiresDetails && (
        <div className="space-y-1">
          <Label htmlFor="field-work-type-details" className="text-xs text-gray-600">
            Work type details{" "}
            {gateApplies && <span className="text-red-500">*</span>}
          </Label>
          <Input
            id="field-work-type-details"
            data-testid="input-work-type-details"
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

  const groupRequired = visibility.controllerRequired || visibility.zoneRequired;
  const controllerContent = (
    <div className="space-y-3" data-testid="controller-zone-section">
      <div className="flex items-center gap-2">
        <div className="bg-blue-50 p-2 rounded-md">
          <Cpu className="w-4 h-4 text-blue-600" />
        </div>
        <h3 className="text-base font-semibold text-gray-900">
          {visibility.showZone ? "Controller & Zone" : "Controller"}{" "}
          <span className="text-xs text-gray-500 font-normal">
            {gateApplies && groupRequired
              ? "(required by work type)"
              : "(optional)"}
          </span>
        </h3>
      </div>
      <div
        className={
          visibility.showController && visibility.showZone
            ? "grid grid-cols-1 sm:grid-cols-2 gap-3"
            : "grid grid-cols-1 gap-3"
        }
      >
        {visibility.showController && (
          <div className="space-y-1">
            <Label className="text-xs text-gray-600">
              Controller{" "}
              {gateApplies && visibility.controllerRequired && (
                <span className="text-red-500">*</span>
              )}
            </Label>
            <Select
              value={value.controllerLetter ?? ""}
              onValueChange={(letter) =>
                onChange({
                  ...valueRef.current,
                  controllerLetter: letter === NONE_VALUE ? null : letter,
                  zoneNumber: null,
                })
              }
              disabled={controllersLoading || controllers.length === 0}
            >
              <SelectTrigger data-testid="select-controller">
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
                {!visibility.controllerRequired && (
                  <SelectItem value={NONE_VALUE}>— None —</SelectItem>
                )}
                {storedControllerMissing && (
                  <SelectItem value={value.controllerLetter!}>
                    Controller {value.controllerLetter}{" "}
                    <span className="text-gray-500">(no longer on file)</span>
                  </SelectItem>
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
            {visibility.zoneRequired && !visibility.controllerRequired && (
              <p className="text-xs text-gray-500">
                Needed to pick the zone.
              </p>
            )}
          </div>
        )}
        {visibility.showZone && (
          <div className="space-y-1">
            <Label className="text-xs text-gray-600 flex items-center gap-1">
              <Droplets className="w-3 h-3" /> Zone
              {gateApplies && visibility.zoneRequired && (
                <span className="text-red-500">*</span>
              )}
            </Label>
            <Select
              value={value.zoneNumber == null ? "" : String(value.zoneNumber)}
              onValueChange={(zone) =>
                onChange({
                  ...valueRef.current,
                  zoneNumber: zone === NONE_VALUE ? null : Number(zone),
                })
              }
              disabled={!selectedController || zoneCount === 0}
            >
              <SelectTrigger data-testid="select-zone">
                <SelectValue
                  placeholder={!selectedController ? "Pick a controller first" : "Select zone"}
                />
              </SelectTrigger>
              <SelectContent>
                {!visibility.zoneRequired && (
                  <SelectItem value={NONE_VALUE}>— None —</SelectItem>
                )}
                {storedZoneOutOfRange && (
                  <SelectItem value={String(value.zoneNumber)}>
                    Zone {value.zoneNumber}{" "}
                    <span className="text-gray-500">(not on this controller)</span>
                  </SelectItem>
                )}
                {Array.from({ length: zoneCount }, (_, index) => index + 1).map((zone) => (
                  <SelectItem key={zone} value={String(zone)}>
                    Zone {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {grouped ? (
        <>
          {workTypeContent}
          {visibility.showControllerZoneGroup && controllerContent}
        </>
      ) : (
        <>
          <div className="rounded-lg border p-4">{workTypeContent}</div>
          {visibility.showControllerZoneGroup && (
            <div className="rounded-lg border p-4">{controllerContent}</div>
          )}
        </>
      )}
      {showStatus && gateApplies && (
        <WorkLocationGateStatus violations={violations} />
      )}
    </div>
  );
}
