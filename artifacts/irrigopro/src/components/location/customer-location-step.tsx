/**
 * CustomerLocationStep — the canonical shared wizard location step used by
 * the work order, estimate, and billing sheet wizards.
 *
 * Internally wires CustomerLocationPicker (which handles the boundary hook),
 * so callers never deal with useCustomerBoundary directly.
 *
 * Replaces WizardLocationStep + WoLocationStep.
 */
import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { useArrayQuery } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LocationFields } from "@/components/location/location-fields";
import { CustomerLocationPicker } from "@/components/location/customer-location-picker";
import { useCustomerBoundary } from "@/hooks/use-customer-boundary";
import { MapPin, Cpu, Droplets, Briefcase } from "lucide-react";
import type { Customer, FieldWorkType } from "@workspace/db/schema";
import {
  checkLocationGate,
  type LocationGateViolation,
} from "@workspace/db/field-location-policy";
import type { CustomerController } from "@/lib/controller-types";

export interface WorkLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface CustomerLocationValue {
  projectName: string;
  projectAddress: string;
  useDifferentAddress: boolean;
  locationNotes: string;
  accessInstructions: string;
  workLocation: WorkLocation | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
  fieldWorkType: string | null;
  fieldWorkTypeDetails: string;
  workLocationSource: "gps" | "manual" | null;
  workLocationAccuracyM: number | null;
  workLocationGpsError: string | null;
}

interface Props {
  customer: Customer | null;
  value: CustomerLocationValue;
  onChange: (next: CustomerLocationValue) => void;
  onBack: () => void;
  onContinue: () => void;
  /** Override the heading on the project name card. Defaults to "Project". */
  projectCardTitle?: string;
  /** Override the project name input label. Defaults to "Project Name". */
  projectNameLabel?: string;
  /** Override the project name input placeholder. */
  projectNamePlaceholder?: string;
  /** Hide the Project Name card entirely (e.g. when the wizard captures it
   *  in a different step). */
  hideProjectName?: boolean;
  /** Opt into the field-location policy. */
  enforceLocationGate?: boolean;
  onGateStateChange?: (
    complete: boolean,
    violations: LocationGateViolation[],
  ) => void;
}

interface AddressFormValues {
  projectAddress: string;
  locationNotes: string;
  accessInstructions: string;
}

export function CustomerLocationStep({
  customer,
  value,
  onChange,
  onBack,
  onContinue,
  projectCardTitle = "Project",
  projectNameLabel = "Project Name",
  projectNamePlaceholder = "e.g., Sprinkler head replacement",
  hideProjectName = false,
  enforceLocationGate = false,
  onGateStateChange,
}: Props) {
  const valueRef = useRef(value);
  valueRef.current = value;

  const form = useForm<AddressFormValues>({
    defaultValues: {
      projectAddress: value.projectAddress,
      locationNotes: value.locationNotes,
      accessInstructions: value.accessInstructions,
    },
  });

  // Mirror form changes back into wizard state.
  useEffect(() => {
    const sub = form.watch((v) => {
      const cur = valueRef.current;
      const projectAddress = v.projectAddress ?? "";
      const locationNotes = v.locationNotes ?? "";
      const accessInstructions = v.accessInstructions ?? "";
      if (
        projectAddress === cur.projectAddress &&
        locationNotes === cur.locationNotes &&
        accessInstructions === cur.accessInstructions
      ) {
        return;
      }
      onChange({ ...cur, projectAddress, locationNotes, accessInstructions });
    });
    return () => sub.unsubscribe();
  }, [form, onChange]);

  // Sync project address with customer when "use customer address" is on.
  useEffect(() => {
    if (customer && !value.useDifferentAddress) {
      const next = customer.address || "";
      if (form.getValues("projectAddress") !== next) {
        form.setValue("projectAddress", next, { shouldDirty: false });
      }
    }
  }, [customer?.id, value.useDifferentAddress, form]);

  const { data: controllers = [], isLoading: controllersLoading } = useArrayQuery<CustomerController>({
    queryKey: ["/api/properties", customer?.id, "controllers"],
    enabled: !!customer,
  });
  const { data: workTypes = [], isLoading: workTypesLoading } = useArrayQuery<FieldWorkType>({
    queryKey: ["/api/field-work-types"],
    enabled: !!customer,
  });

  const selectedController = controllers.find(
    (c) => c.controllerLetter === value.controllerLetter,
  );
  const zoneCount = selectedController?.zoneCount ?? 0;
  const selectedWorkType = workTypes.find((type) => type.code === value.fieldWorkType);
  const gateViolations = enforceLocationGate
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
  const gateComplete = gateViolations.length === 0;
  const violationLabels: Record<LocationGateViolation, string> = {
    pin_missing: "Pin the exact work location (use “I’m here” or click the map).",
    work_type_missing: "Choose a work type.",
    controller_missing: "Choose the controller.",
    zone_missing: "Choose the zone.",
    details_missing: "Add details for this work type.",
  };
  const handleContinue = () => {
    if (!gateComplete) return;
    onContinue();
  };

  useEffect(() => {
    onGateStateChange?.(gateComplete, gateViolations);
  }, [gateComplete, gateViolations.join("|"), onGateStateChange]);

  useEffect(() => {
    if (controllersLoading) return;
    if (!value.controllerLetter) return;
    const stillThere = controllers.some(
      (c) => c.controllerLetter === value.controllerLetter,
    );
    if (!stillThere) {
      onChange({ ...valueRef.current, controllerLetter: null, zoneNumber: null });
    }
  }, [controllers, controllersLoading, value.controllerLetter, onChange]);

  useEffect(() => {
    if (value.zoneNumber == null) return;
    if (!selectedController) return;
    if (value.zoneNumber > zoneCount) {
      onChange({ ...valueRef.current, zoneNumber: null });
    }
  }, [selectedController, zoneCount, value.zoneNumber, onChange]);

  const handleToggleAddress = () => {
    const newUseDifferent = !value.useDifferentAddress;
    const nextAddress = newUseDifferent ? value.projectAddress : (customer?.address || "");
    onChange({ ...value, useDifferentAddress: newUseDifferent, projectAddress: nextAddress });
    form.setValue("projectAddress", nextAddress, { shouldDirty: false });
  };

  const { data: customerBoundary } = useCustomerBoundary(customer?.id);
  const addressReadOnly = !!customer && !value.useDifferentAddress;

  return (
    <div className="space-y-4">
      {!hideProjectName && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-4">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <Briefcase className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">{projectCardTitle}</h2>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-project-name" className="text-sm">
                {projectNameLabel} <span className="text-red-500">*</span>
              </Label>
              <Input
                id="wizard-project-name"
                autoFocus
                value={value.projectName}
                onChange={(e) => onChange({ ...value, projectName: e.target.value })}
                placeholder={projectNamePlaceholder}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <MapPin className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">Address &amp; Notes</h2>
            </div>
            {customer && (
              <button
                type="button"
                onClick={handleToggleAddress}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                {value.useDifferentAddress ? "Use customer address" : "Use a different address"}
              </button>
            )}
          </div>
          <Form {...form}>
            <LocationFields
              control={form.control}
              readOnlyAddress={addressReadOnly}
              propertyAcres={customerBoundary?.areaAcres ?? null}
            />
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="bg-blue-50 p-2 rounded-md">
              <MapPin className="w-4 h-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">
              Pin Work Location{" "}
              <span className="text-xs text-gray-500 font-normal">
                {enforceLocationGate ? "(required)" : "(optional)"}
              </span>
            </h2>
          </div>

          {customer ? (
            <>
              <p className="text-xs text-gray-600">
                {enforceLocationGate
                  ? "Required — use “I’m here” for GPS or click the map to place a pin manually."
                  : "Optional — drop a pin on the map if you want the field tech to navigate straight to the work area."}
              </p>
              <CustomerLocationPicker
                key={customer.id}
                customerId={customer.id}
                hasCustomerAddress={!!customer.address}
                onLocationSelect={(loc) =>
                  onChange({
                    ...valueRef.current,
                    workLocation: { lat: loc.lat, lng: loc.lng, address: loc.address },
                    workLocationSource: loc.source ?? "manual",
                    workLocationAccuracyM: loc.accuracyM ?? null,
                    workLocationGpsError: loc.gpsError ?? null,
                  })
                }
                selectedLocation={value.workLocation}
              />

              {value.workLocation && (
                <div className="border-l-4 border-l-blue-500 bg-blue-50/50 border border-blue-200 rounded-lg p-3">
                  <p className="text-sm font-medium text-blue-900">Pinned Location:</p>
                  <p className="text-sm text-blue-800 mt-1">
                    {value.workLocation.address ||
                      `${value.workLocation.lat.toFixed(6)}, ${value.workLocation.lng.toFixed(6)}`}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onChange({
                        ...valueRef.current,
                        workLocation: null,
                        workLocationSource: null,
                        workLocationAccuracyM: null,
                        workLocationGpsError: null,
                      })
                    }
                    className="mt-2 text-blue-700 hover:text-blue-900"
                  >
                    Clear pin
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-500">Pick a customer first.</p>
          )}
        </CardContent>
      </Card>

      {customer && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <Briefcase className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">
                Work Type{" "}
                {enforceLocationGate ? (
                  <span className="text-red-500">*</span>
                ) : (
                  <span className="text-xs text-gray-500 font-normal">(optional)</span>
                )}
              </h2>
            </div>
            <Select
              value={value.fieldWorkType ?? "__none__"}
              onValueChange={(workType) =>
                onChange({
                  ...valueRef.current,
                  fieldWorkType: workType === "__none__" ? null : workType,
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
                  onChange={(e) =>
                    onChange({ ...valueRef.current, fieldWorkTypeDetails: e.target.value })
                  }
                  placeholder="Describe the work"
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {customer && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <Cpu className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">
                Controller &amp; Zone{" "}
                <span className="text-xs text-gray-500 font-normal">
                  {enforceLocationGate &&
                  (selectedWorkType?.requiresController || selectedWorkType?.requiresZone)
                    ? "(required by work type)"
                    : "(optional)"}
                </span>
              </h2>
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
                    {controllers.map((c) => (
                      <SelectItem key={c.controllerLetter} value={c.controllerLetter}>
                        Controller {c.controllerLetter}{" "}
                        <span className="text-gray-500">({c.zoneCount} zones)</span>
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
                    {Array.from({ length: zoneCount }, (_, i) => i + 1).map((z) => (
                      <SelectItem key={z} value={String(z)}>
                        Zone {z}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {enforceLocationGate && (
        <div
          className={
            gateComplete
              ? "rounded-lg border border-green-200 bg-green-50 p-3"
              : "rounded-lg border border-red-200 bg-red-50 p-3"
          }
          role="status"
          data-testid="location-gate-status"
        >
          {gateComplete ? (
            <p className="text-sm font-medium text-green-800">Location details complete.</p>
          ) : (
            <>
              <p className="text-sm font-semibold text-red-800">Before you continue:</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-red-700">
                {gateViolations.map((violation) => (
                  <li key={violation}>{violationLabels[violation]}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="hidden sm:flex justify-between gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onBack}>← Back</Button>
        <Button
          type="button"
          onClick={handleContinue}
          disabled={!gateComplete}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
