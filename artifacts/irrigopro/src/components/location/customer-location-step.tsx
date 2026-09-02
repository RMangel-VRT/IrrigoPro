/**
 * CustomerLocationStep — the canonical shared wizard location step used by
 * the work order, estimate, and billing sheet wizards.
 *
 * Internally wires CustomerLocationPicker (which handles the boundary hook),
 * so callers never deal with useCustomerBoundary directly.
 *
 * Replaces WizardLocationStep + WoLocationStep.
 */
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { LocationFields } from "@/components/location/location-fields";
import { CustomerLocationPicker } from "@/components/location/customer-location-picker";
import {
  WorkLocationControls,
  WorkLocationGateStatus,
} from "@/components/location/work-location-controls";
import { useCustomerBoundary } from "@/hooks/use-customer-boundary";
import { MapPin, Briefcase } from "lucide-react";
import type { Customer } from "@workspace/db/schema";
import type { LocationGateViolation } from "@workspace/db/field-location-policy";

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
  const [gateViolations, setGateViolations] = useState<LocationGateViolation[]>([]);

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

  const gateComplete = gateViolations.length === 0;
  const handleContinue = () => {
    if (!gateComplete) return;
    onContinue();
  };

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
        <WorkLocationControls
          customerId={customer.id}
          value={value}
          onChange={onChange}
          enforceLocationGate={enforceLocationGate}
          onGateStateChange={(complete, violations) => {
            setGateViolations(violations);
            onGateStateChange?.(complete, violations);
          }}
        />
      )}

      {enforceLocationGate && (
        <WorkLocationGateStatus violations={gateViolations} />
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
