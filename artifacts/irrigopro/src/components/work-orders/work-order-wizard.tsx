import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ClipboardList, Loader2 } from "lucide-react";
import { WizardHeader } from "@/components/wizard-shared/wizard-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Customer, WorkOrder } from "@workspace/db/schema";
import type { UploadedFile } from "@/components/ui/file-upload";
import { WoCustomerStep, type CustomerStepValue } from "./wizard/wo-customer-step";
import {
  CustomerLocationStep,
  type CustomerLocationValue,
  type WorkLocation,
} from "@/components/location/customer-location-step";

type LocationStepValue = CustomerLocationValue;

import { WoDescriptionStep, type DescriptionStepValue } from "./wizard/wo-description-step";
import { WoScheduleStep, type ScheduleStepValue } from "./wizard/wo-schedule-step";
import { WoReviewStep } from "./wizard/wo-review-step";

interface WorkOrderWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  workOrderId?: number | null;
}

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_TITLES: Record<Step, string> = {
  1: "Customer & Branch",
  2: "Work Location & Site",
  3: "Description",
  4: "Schedule & Assign",
  5: "Review",
};

function urlToUploadedFile(url: string): UploadedFile {
  const fileName = url.split("/").pop() || url;
  return { url, fileName, originalName: fileName };
}

interface DraftSnapshot {
  customerId: number | null;
  customerEmail: string;
  customerPhone: string;
  branchName: string;
  projectName: string;
  projectAddress: string;
  useDifferentAddress: boolean;
  description: string;
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
  priority: string;
  scheduledDate: string;
  assignedTechnicianId: number | null;
  assignedTechnicianName: string;
  specialInstructions: string;
  notes: string;
  photos: string[];
}

const blankCustomer = (): CustomerStepValue => ({
  customer: null,
  customerEmail: "",
  customerPhone: "",
  branchName: "",
});
const blankLocation = (): LocationStepValue => ({
  projectName: "",
  projectAddress: "",
  useDifferentAddress: false,
  locationNotes: "",
  accessInstructions: "",
  workLocation: null,
  controllerLetter: null,
  zoneNumber: null,
  fieldWorkType: null,
  fieldWorkTypeDetails: "",
  workLocationSource: null,
  workLocationAccuracyM: null,
  workLocationGpsError: null,
});
const blankDescription = (): DescriptionStepValue => ({ description: "" });
const blankSchedule = (): ScheduleStepValue => ({
  priority: "medium",
  scheduledDate: "",
  assignedTechnicianId: null,
  assignedTechnicianName: "",
  specialInstructions: "",
  notes: "",
});

function snapshot(
  cs: CustomerStepValue,
  ls: LocationStepValue,
  ds: DescriptionStepValue,
  ss: ScheduleStepValue,
  photos: UploadedFile[],
): DraftSnapshot {
  return {
    customerId: cs.customer?.id ?? null,
    customerEmail: cs.customerEmail.trim(),
    customerPhone: cs.customerPhone.trim(),
    branchName: cs.branchName,
    projectName: ls.projectName.trim(),
    projectAddress: ls.projectAddress.trim(),
    useDifferentAddress: ls.useDifferentAddress,
    description: ds.description.trim(),
    locationNotes: ls.locationNotes.trim(),
    accessInstructions: ls.accessInstructions.trim(),
    workLocation: ls.workLocation,
    controllerLetter: ls.controllerLetter,
    zoneNumber: ls.zoneNumber,
    fieldWorkType: ls.fieldWorkType,
    fieldWorkTypeDetails: ls.fieldWorkTypeDetails,
    workLocationSource: ls.workLocationSource,
    workLocationAccuracyM: ls.workLocationAccuracyM,
    workLocationGpsError: ls.workLocationGpsError,
    priority: ss.priority,
    scheduledDate: ss.scheduledDate,
    assignedTechnicianId: ss.assignedTechnicianId,
    assignedTechnicianName: ss.assignedTechnicianName,
    specialInstructions: ss.specialInstructions.trim(),
    notes: ss.notes.trim(),
    photos: photos.map((p) => p.url),
  };
}

function dateToInputLocal(date: string | Date | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function WorkOrderWizard({ open, onClose, onCreated, workOrderId }: WorkOrderWizardProps) {
  const isEdit = !!workOrderId;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>(isEdit ? 2 : 1);
  const [customerStep, setCustomerStep] = useState<CustomerStepValue>(blankCustomer);
  const [locationStep, setLocationStep] = useState<LocationStepValue>(blankLocation);
  const [descriptionStep, setDescriptionStep] = useState<DescriptionStepValue>(blankDescription);
  const [scheduleStep, setScheduleStep] = useState<ScheduleStepValue>(blankSchedule);
  const [photos, setPhotos] = useState<UploadedFile[]>([]);
  const [discardOpen, setDiscardOpen] = useState(false);
  const initialSnapshotRef = useRef<DraftSnapshot | null>(null);
  const hydratedRef = useRef(false);

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setStep(isEdit ? 2 : 1);
    hydratedRef.current = false;
    if (!isEdit) {
      const c = blankCustomer();
      const l = blankLocation();
      const d = blankDescription();
      const s = blankSchedule();
      setCustomerStep(c);
      setLocationStep(l);
      setDescriptionStep(d);
      setScheduleStep(s);
      setPhotos([]);
      initialSnapshotRef.current = snapshot(c, l, d, s, []);
    }
  }, [open, isEdit]);

  // When customer changes in Step 1, reset location/controller state and
  // pre-fill email/phone from the new customer record. The "use customer
  // address" toggle stays at its current value but the actual project address
  // syncs in Step 2.
  const handleCustomerStepChange = (next: CustomerStepValue) => {
    const prev = customerStep;
    setCustomerStep(next);
    if (prev.customer?.id !== next.customer?.id) {
      setLocationStep((cur) => ({
        ...cur,
        projectAddress: cur.useDifferentAddress
          ? cur.projectAddress
          : next.customer?.address || "",
        workLocation: null,
        controllerLetter: null,
        zoneNumber: null,
        workLocationSource: null,
        workLocationAccuracyM: null,
        workLocationGpsError: null,
      }));
    }
  };

  // Load existing work order in edit mode.
  const { data: existing, isLoading: existingLoading } = useQuery<WorkOrder>({
    queryKey: ["/api/work-orders", workOrderId],
    enabled: isEdit && open && !!workOrderId,
  });

  // Wait for the real customer record to load before hydrating Step 1 so the
  // wizard mounts the real customer in a single pass — never the synthetic
  // fallback first, then a swap. `isFetched` (rather than `!realCustomer`)
  // also lets hydration proceed if the customer query errors out, so the
  // user is never stuck on a spinner forever.
  const {
    data: realCustomer,
    isFetched: realCustomerFetched,
    isLoading: realCustomerLoading,
  } = useQuery<Customer>({
    queryKey: ["/api/customers", existing?.customerId],
    enabled: isEdit && open && !!existing?.customerId,
  });

  useEffect(() => {
    if (!isEdit || !existing || !open || hydratedRef.current) return;
    if (existing.customerId && !realCustomerFetched) return;

    const cust = realCustomer ?? ({
      id: existing.customerId,
      name: existing.customerName,
      email: existing.customerEmail,
      phone: existing.customerPhone,
      address: existing.projectAddress,
    } as Customer);

    const lat = existing.workLocationLat != null ? parseFloat(String(existing.workLocationLat)) : NaN;
    const lng = existing.workLocationLng != null ? parseFloat(String(existing.workLocationLng)) : NaN;
    const wl: WorkLocation | null = Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng, address: existing.workLocationAddress ?? undefined }
      : null;

    const projectAddress = existing.projectAddress ?? "";
    const customerAddress = realCustomer?.address ?? "";
    const useDifferentAddress =
      projectAddress.trim().length > 0 &&
      projectAddress.trim() !== (customerAddress ?? "").trim();

    const c: CustomerStepValue = {
      customer: cust,
      customerEmail: existing.customerEmail ?? "",
      customerPhone: existing.customerPhone ?? "",
      branchName: existing.branchName ?? "",
    };
    const l: LocationStepValue = {
      projectName: existing.projectName ?? "",
      projectAddress,
      useDifferentAddress,
      locationNotes: existing.locationNotes ?? "",
      accessInstructions: existing.accessInstructions ?? "",
      workLocation: wl,
      controllerLetter: existing.controllerLetter ?? null,
      zoneNumber: existing.zoneNumber ?? null,
      fieldWorkType: existing.fieldWorkType ?? null,
      fieldWorkTypeDetails: existing.fieldWorkTypeDetails ?? "",
      workLocationSource:
        existing.workLocationSource === "gps" || existing.workLocationSource === "manual"
          ? existing.workLocationSource
          : null,
      workLocationAccuracyM:
        existing.workLocationAccuracyM != null
          ? parseFloat(String(existing.workLocationAccuracyM))
          : null,
      workLocationGpsError: existing.workLocationGpsError ?? null,
    };
    const d: DescriptionStepValue = { description: existing.description ?? "" };
    const s: ScheduleStepValue = {
      priority: existing.priority ?? "medium",
      scheduledDate: dateToInputLocal(existing.scheduledDate),
      assignedTechnicianId: existing.assignedTechnicianId ?? null,
      assignedTechnicianName: existing.assignedTechnicianName ?? "",
      specialInstructions: existing.specialInstructions ?? "",
      notes: existing.notes ?? "",
    };
    const ph = (existing.photos ?? []).map(urlToUploadedFile);
    setCustomerStep(c);
    setLocationStep(l);
    setDescriptionStep(d);
    setScheduleStep(s);
    setPhotos(ph);
    initialSnapshotRef.current = snapshot(c, l, d, s, ph);
    hydratedRef.current = true;
  }, [isEdit, existing, realCustomer, realCustomerFetched, open]);

  const isDirty = useMemo(() => {
    const baseline = initialSnapshotRef.current;
    if (!baseline) return false;
    return (
      JSON.stringify(baseline) !==
      JSON.stringify(snapshot(customerStep, locationStep, descriptionStep, scheduleStep, photos))
    );
  }, [customerStep, locationStep, descriptionStep, scheduleStep, photos]);

  const saveMutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      if (!customerStep.customer) throw new Error("Customer required");
      if (!locationStep.projectName.trim()) throw new Error("Project name required");
      if (!descriptionStep.description.trim()) throw new Error("Description required");

      // Project address is what the user explicitly entered/confirmed in the
      // Address & Notes form — never silently inferred from the pin or the
      // customer record at save time.
      const payload: Record<string, unknown> = {
        customerId: customerStep.customer.id,
        customerName: customerStep.customer.name,
        customerEmail: customerStep.customerEmail.trim(),
        customerPhone: customerStep.customerPhone.trim() || null,
        branchName: customerStep.branchName || null,
        projectName: locationStep.projectName.trim(),
        description: descriptionStep.description.trim(),
        projectAddress: locationStep.projectAddress.trim(),
        locationNotes: locationStep.locationNotes.trim() || "",
        accessInstructions: locationStep.accessInstructions.trim() || "",
        workLocationLat:
          locationStep.workLocation?.lat != null
            ? String(locationStep.workLocation.lat)
            : null,
        workLocationLng:
          locationStep.workLocation?.lng != null
            ? String(locationStep.workLocation.lng)
            : null,
        workLocationAddress: locationStep.workLocation?.address ?? null,
        controllerLetter: locationStep.controllerLetter,
        zoneNumber: locationStep.zoneNumber,
        fieldWorkType: locationStep.fieldWorkType,
        fieldWorkTypeDetails: locationStep.fieldWorkTypeDetails.trim() || null,
        workLocationSource: locationStep.workLocationSource,
        workLocationAccuracyM: locationStep.workLocationAccuracyM,
        workLocationGpsError: locationStep.workLocationGpsError,
        priority: scheduleStep.priority,
        scheduledDate: scheduleStep.scheduledDate
          ? new Date(scheduleStep.scheduledDate).toISOString()
          : null,
        assignedTechnicianId: scheduleStep.assignedTechnicianId,
        assignedTechnicianName: scheduleStep.assignedTechnicianId
          ? scheduleStep.assignedTechnicianName
          : "",
        specialInstructions: scheduleStep.specialInstructions.trim() || "",
        notes: scheduleStep.notes.trim() || "",
        photos: photos.map((p) => p.url),
      };

      if (isEdit) {
        return await apiRequest(`/api/work-orders/${workOrderId}`, "PATCH", payload);
      }
      return await apiRequest("/api/work-orders", "POST", {
        ...payload,
        workType: "direct_billing",
        status: "pending",
        estimateId: null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      if (isEdit && workOrderId) {
        queryClient.invalidateQueries({ queryKey: ["/api/work-orders", workOrderId] });
        queryClient.invalidateQueries({ queryKey: ["/api/work-orders", workOrderId, "items"] });
      }
      toast({ title: isEdit ? "Work order updated" : "Work order created" });
      onCreated?.();
      onClose();
    },
    onError: (err) => {
      toast({
        title: isEdit ? "Failed to update work order" : "Failed to create work order",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = () => {
    if (!customerStep.customer) {
      toast({ title: "Customer required", variant: "destructive" });
      setStep(1);
      return;
    }
    if (!locationStep.projectName.trim()) {
      toast({ title: "Project name required", variant: "destructive" });
      setStep(2);
      return;
    }
    if (!descriptionStep.description.trim()) {
      toast({ title: "Description required", variant: "destructive" });
      setStep(3);
      return;
    }
    saveMutation.mutate();
  };

  const requestClose = () => {
    if (isDirty) setDiscardOpen(true);
    else onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (target?.isContentEditable) return;
      if (tag === "BUTTON" || tag === "A") return;
      if (step === 5 && !saveMutation.isPending) {
        e.preventDefault();
        handleSubmit();
      }
    }
  };

  const headerContextLine = useMemo(() => {
    const parts: string[] = [];
    const customerLabel = customerStep.customer?.name
      ? customerStep.branchName
        ? `${customerStep.customer.name} · ${customerStep.branchName}`
        : customerStep.customer.name
      : null;
    if (customerLabel) parts.push(customerLabel);
    if (locationStep.projectName.trim()) parts.push(locationStep.projectName.trim());
    if (step >= 4 && scheduleStep.scheduledDate) {
      const d = new Date(scheduleStep.scheduledDate);
      if (!isNaN(d.getTime())) {
        parts.push(
          d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
        );
      }
    }
    if (step >= 4 && scheduleStep.assignedTechnicianName) {
      parts.push(scheduleStep.assignedTechnicianName);
    }
    return parts.length ? parts.join(" · ") : null;
  }, [
    customerStep.customer?.name,
    customerStep.branchName,
    locationStep.projectName,
    scheduleStep.scheduledDate,
    scheduleStep.assignedTechnicianName,
    step,
  ]);

  const customerBranches: string[] = Array.isArray(customerStep.customer?.branches)
    ? (customerStep.customer!.branches as string[])
    : [];
  const canContinueFrom: Record<Step, boolean> = {
    1:
      !!customerStep.customer &&
      (customerBranches.length === 0 || !!customerStep.branchName),
    2: true,
    3: descriptionStep.description.trim().length > 0,
    4: true,
    5: true,
  };

  const goNext = () => {
    if (step < 5) setStep((s) => (s + 1) as Step);
  };
  const goBack = () => {
    if (step > 1) setStep((s) => (s - 1) as Step);
  };

  const stickyMobileFooter = (
    <div className="sm:hidden sticky bottom-0 -mx-4 px-4 py-2 bg-white border-t z-10 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {step === 1 ? (
          <Button type="button" variant="outline" onClick={requestClose} className="flex-1">
            Cancel
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={goBack} className="flex-1">
            ← Back
          </Button>
        )}
        {step < 5 ? (
          <Button
            type="button"
            onClick={goNext}
            disabled={!canContinueFrom[step]}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
          >
            Continue
          </Button>
        ) : (
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={saveMutation.isPending}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
          >
            {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isEdit ? "Save Changes" : "Create Work Order"}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) requestClose();
        }}
      >
        <DialogContent
          onKeyDown={handleKeyDown}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            requestClose();
          }}
          onInteractOutside={(e) => {
            // When the form is dirty, suppress Radix's auto-close and route
            // through requestClose() so the discard-confirmation dialog opens
            // instead of silently losing the user's edits.
            if (isDirty) {
              e.preventDefault();
              requestClose();
            }
          }}
          className="
            p-0 overflow-hidden
            inset-0 left-0 top-0 translate-x-0 translate-y-0
            w-screen h-screen max-w-none max-h-none rounded-none
            sm:inset-auto sm:left-[50%] sm:top-[50%] sm:-translate-x-1/2 sm:-translate-y-1/2
            sm:w-[95vw] sm:max-w-3xl md:max-w-4xl lg:max-w-5xl sm:max-h-[95vh] sm:rounded-2xl
            flex flex-col
          "
          aria-describedby={undefined}
        >
          <WizardHeader
            icon={ClipboardList}
            kindLabel="Work Order"
            mode={isEdit ? "edit" : "new"}
            recordIdentifier={isEdit && workOrderId ? `#${workOrderId}` : null}
            currentStep={step}
            totalSteps={5}
            stepTitles={[
              STEP_TITLES[1],
              STEP_TITLES[2],
              STEP_TITLES[3],
              STEP_TITLES[4],
              STEP_TITLES[5],
            ]}
            contextLine={headerContextLine}
            loading={isEdit && (existingLoading || realCustomerLoading) && !hydratedRef.current}
            loadingLabel="Loading work order…"
            accent="blue"
            leading={
              step > 1 && !isEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 sm:hidden -ml-1"
                  onClick={goBack}
                  aria-label="Back"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
              ) : null
            }
          />

          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
            {isEdit && (existingLoading || realCustomerLoading) && !hydratedRef.current ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
              </div>
            ) : step === 1 ? (
              <WoCustomerStep
                value={customerStep}
                onChange={handleCustomerStepChange}
                onContinue={goNext}
                onCancel={requestClose}
              />
            ) : step === 2 ? (
              <CustomerLocationStep
                customer={customerStep.customer}
                value={locationStep}
                onChange={setLocationStep}
                onBack={isEdit ? requestClose : goBack}
                onContinue={goNext}
              />
            ) : step === 3 ? (
              <WoDescriptionStep
                value={descriptionStep}
                onChange={setDescriptionStep}
                customerName={customerStep.customer?.name ?? ""}
                branchName={customerStep.branchName}
                pinnedLocation={locationStep.workLocation}
                onEditPin={() => setStep(2)}
                onBack={goBack}
                onContinue={goNext}
              />
            ) : step === 4 ? (
              <WoScheduleStep
                value={scheduleStep}
                onChange={setScheduleStep}
                customerName={customerStep.customer?.name ?? ""}
                branchName={customerStep.branchName}
                pinnedLocation={locationStep.workLocation}
                photos={photos}
                onPhotosChange={setPhotos}
                onEditPin={() => setStep(2)}
                onBack={goBack}
                onContinue={goNext}
              />
            ) : (
              <WoReviewStep
                customer={customerStep.customer}
                customerEmail={customerStep.customerEmail}
                customerPhone={customerStep.customerPhone}
                branchName={customerStep.branchName}
                projectName={locationStep.projectName}
                projectAddress={locationStep.projectAddress}
                description={descriptionStep.description}
                locationNotes={locationStep.locationNotes}
                accessInstructions={locationStep.accessInstructions}
                workLocation={locationStep.workLocation}
                controllerLetter={locationStep.controllerLetter}
                zoneNumber={locationStep.zoneNumber}
                priority={scheduleStep.priority}
                scheduledDate={scheduleStep.scheduledDate}
                assignedTechnicianName={scheduleStep.assignedTechnicianName}
                specialInstructions={scheduleStep.specialInstructions}
                notes={scheduleStep.notes}
                photos={photos}
                onPhotosChange={setPhotos}
                onEditPin={() => setStep(2)}
                onBack={goBack}
                onSubmit={handleSubmit}
                submitting={saveMutation.isPending}
                isEdit={isEdit}
              />
            )}
          </div>

          {stickyMobileFooter}
        </DialogContent>
      </Dialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isEdit ? "Discard your edits?" : "Discard this work order?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isEdit
                ? "You have unsaved changes. Closing now will discard them and keep the saved version."
                : "You have unsaved work on this new work order. Closing now will discard it and nothing will be saved."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isEdit ? "Keep editing" : "Keep working"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDiscardOpen(false);
                onClose();
              }}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {isEdit ? "Discard edits" : "Discard work order"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
