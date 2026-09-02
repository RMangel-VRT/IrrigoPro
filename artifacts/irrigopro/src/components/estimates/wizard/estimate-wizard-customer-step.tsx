import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { CustomerSelector } from "@/components/ui/customer-selector";
import { AiExpandButton, AiSuggestionCard } from "@/components/ui/ai-expand-button";
import {
  User,
  Mail,
  Phone,
  MapPin,
  Pencil,
  Briefcase,
  ClipboardList,
} from "lucide-react";
import type { Customer } from "@workspace/db/schema";

export interface WorkLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface CustomerStepValue {
  customer: Customer | null;
  customerEmail: string;
  customerPhone: string;
  projectName: string;
  projectAddress: string;
  useDifferentAddress: boolean;
  locationNotes: string;
  accessInstructions: string;
  workDescription: string;
  workLocation: WorkLocation | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
  fieldWorkType: string | null;
  fieldWorkTypeDetails: string;
  workLocationSource: "gps" | "manual" | null;
  workLocationAccuracyM: number | null;
  workLocationGpsError: string | null;
}

interface EstimateWizardCustomerStepProps {
  value: CustomerStepValue;
  onChange: (next: CustomerStepValue) => void;
  onContinue: () => void;
  onCancel: () => void;
  customerLocked?: boolean;
}

export function EstimateWizardCustomerStep({
  value,
  onChange,
  onContinue,
  onCancel,
  customerLocked,
}: EstimateWizardCustomerStepProps) {
  const projectNameRef = useRef<HTMLInputElement | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);

  const lastCustomerIdRef = useRef<number | null>(value.customer?.id ?? null);
  useEffect(() => {
    const currentId = value.customer?.id ?? null;
    if (currentId !== lastCustomerIdRef.current) {
      lastCustomerIdRef.current = currentId;
      setAiSuggestion(null);
    }
  }, [value.customer?.id]);

  useEffect(() => {
    if (value.customer) {
      projectNameRef.current?.focus();
    }
  }, [value.customer?.id]);

  const handleSelectCustomer = (c: Customer) => {
    const nextAddress = c.address || "";
    onChange({
      ...value,
      customer: c,
      customerEmail: c.email ?? "",
      customerPhone: c.phone ?? "",
      projectAddress: nextAddress,
      useDifferentAddress: false,
      workLocation: null,
      controllerLetter: null,
      zoneNumber: null,
      workLocationSource: null,
      workLocationAccuracyM: null,
      workLocationGpsError: null,
    });
    setShowCustomerPicker(false);
  };

  const canContinue = !!value.customer && value.projectName.trim().length > 0;

  return (
    <div className="space-y-4">
      {/* Customer card */}
      <Card className={value.customer ? "border-l-4 border-l-blue-500" : ""}>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="bg-blue-50 p-2 rounded-md">
              <User className="w-4 h-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Customer</h2>
          </div>

          {(!value.customer || showCustomerPicker) && !customerLocked ? (
            <CustomerSelector
              selectedCustomer={value.customer}
              onSelectCustomer={handleSelectCustomer}
              hideLabel
              placeholder="Search and select a customer..."
              autoOpen
            />
          ) : value.customer ? (
            <div className="space-y-3">
              <div className="text-base font-semibold text-gray-900" data-testid="wizard-customer-name">
                {value.customer.name}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label
                    htmlFor="wizard-customer-email"
                    className="text-xs text-gray-600 flex items-center gap-1.5"
                  >
                    <Mail className="w-3.5 h-3.5 text-gray-400" /> Email
                  </Label>
                  <Input
                    id="wizard-customer-email"
                    type="email"
                    value={value.customerEmail}
                    onChange={(e) => onChange({ ...value, customerEmail: e.target.value })}
                    placeholder="customer@example.com"
                    className="focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                    data-testid="wizard-customer-email"
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor="wizard-customer-phone"
                    className="text-xs text-gray-600 flex items-center gap-1.5"
                  >
                    <Phone className="w-3.5 h-3.5 text-gray-400" /> Phone
                  </Label>
                  <Input
                    id="wizard-customer-phone"
                    type="tel"
                    value={value.customerPhone}
                    onChange={(e) => onChange({ ...value, customerPhone: e.target.value })}
                    placeholder="(555) 555-5555"
                    className="focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                    data-testid="wizard-customer-phone"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Used for this estimate only — won't update the customer record.
              </p>
              {value.customer.address && (
                <div className="flex items-center gap-2 text-sm text-gray-700">
                  <MapPin className="w-3.5 h-3.5 text-gray-400" />
                  <span className="truncate">{value.customer.address}</span>
                </div>
              )}
              {!customerLocked && (
                <button
                  type="button"
                  onClick={() => setShowCustomerPicker(true)}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium inline-flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded"
                  data-testid="wizard-change-customer"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Change customer
                </button>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Scope of Work */}
      {value.customer && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="bg-blue-50 p-2 rounded-md">
                  <ClipboardList className="w-4 h-4 text-blue-600" />
                </div>
                <h2 className="text-base font-semibold text-gray-900">Scope of Work</h2>
              </div>
              <AiExpandButton
                getValue={() => value.workDescription}
                onSuggestion={setAiSuggestion}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-work-description" className="sr-only">
                Scope of Work
              </Label>
              <Textarea
                id="wizard-work-description"
                value={value.workDescription}
                onChange={(e) => onChange({ ...value, workDescription: e.target.value })}
                placeholder="Describe the work to be performed — what's being installed, repaired, or serviced. This appears on the estimate sent to the customer."
                rows={8}
                className="min-h-[160px] focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                data-testid="wizard-work-description"
              />
              <AiSuggestionCard
                suggestion={aiSuggestion}
                onAccept={() => {
                  onChange({ ...value, workDescription: aiSuggestion! });
                  setAiSuggestion(null);
                }}
                onDismiss={() => setAiSuggestion(null)}
              />
              <p className="text-xs text-gray-500">
                This is the description the customer will see on their estimate.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Project Details — project name only; address/map/controller move to Location step */}
      {value.customer && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-4">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <Briefcase className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">Project Details</h2>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-project-name" className="text-sm">
                Project Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="wizard-project-name"
                ref={projectNameRef}
                value={value.projectName}
                onChange={(e) => onChange({ ...value, projectName: e.target.value })}
                placeholder="e.g., Backyard Irrigation System"
                className="focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                data-testid="wizard-project-name"
              />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="hidden sm:flex justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel} data-testid="wizard-cancel">
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className="bg-blue-600 hover:bg-blue-700 text-white"
          data-testid="wizard-continue-1"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
