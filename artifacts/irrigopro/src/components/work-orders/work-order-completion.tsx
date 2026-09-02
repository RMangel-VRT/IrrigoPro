import { safeGet } from "@/utils/safeStorage";
import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { AiExpandButton, AiSuggestionCard } from "@/components/ui/ai-expand-button";
import { zodResolver } from "@/lib/zod-resolver";
import { z } from "zod/v4";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FileUpload } from "@/components/ui/file-upload";
import { PhotoImage, usePhotoSignedUrls } from "@/components/ui/photo-image";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  completeWorkOrder,
  isProbablyOffline,
  patchWorkOrderLocation,
} from "@/lib/offline/api";
import type { WorkOrderLocationPatchPayload } from "@/lib/offline/types";
import { buildMapsUrl } from "@/lib/maps-url";
import {
  WorkLocationControls,
  type WorkLocationRequirementsValue,
} from "@/components/location/work-location-controls";
import {
  WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
  isLocationGateEnforced,
  type LocationGateViolation,
} from "@workspace/db/field-location-policy";
import {
  CheckCircle,
  Plus,
  Minus,
  Camera,
  FileText,
  AlertCircle,
  Wrench,
  Edit,
  Check,
  Activity,
  User,
  Loader2,
  Navigation,
} from "lucide-react";
import { PartPicker } from "@/components/parts/part-picker";
import { CustomerLocationPicker } from "@/components/location/customer-location-picker";
import { computeCompletionPrefillHours } from "./completion-prefill";
import type { WorkOrder, Part, Customer } from "@workspace/db/schema";

const workOrderCompletionSchema = z.object({
  workSummary: z.string().min(10, "Work summary must be at least 10 characters"),
  customerNotes: z.string().min(5, "Customer notes must be at least 5 characters"),
  totalHours: z.number().min(0.1, "Total hours must be at least 0.1"),
  // Task #396 — labor mode at field completion. 'flat' uses the
  // single Total Hours input; 'per_part' derives total hours from
  // the work order's per-line breakdown (Σ laborHours × qty).
  laborMode: z.enum(["flat", "per_part"]).default("flat"),
});

type WorkOrderCompletionData = z.infer<typeof workOrderCompletionSchema>;

interface CompletionUploadedFile {
  url: string;
  fileName: string;
  originalName: string;
  previewUrl?: string;
}

interface UsedPart {
  id: number;
  partId: number;
  partName: string;
  partPrice: string;
  quantity: number;
  totalCost: number;
  source: 'estimate' | 'field_added';
  laborHours: string;
  // Slice 2 (client) — id of the prior work_order_items row this UsedPart was
  // prefilled from. Lets the server do an exact-id lookup instead of the
  // stacking-by-partId heuristic, which fixes the cross-wire bug when the
  // same part appears in two different zones and one is removed.
  // null on field-added parts; undefined on legacy rows (treated as null).
  sourceItemId?: number | null;
}

interface WorkOrderCompletionProps {
  workOrder: WorkOrder;
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

export function WorkOrderCompletion({ 
  workOrder, 
  open, 
  onClose, 
  onComplete 
}: WorkOrderCompletionProps) {
  const [usedParts, setUsedParts] = useState<UsedPart[]>([]);
  const [photos, setPhotos] = useState<CompletionUploadedFile[]>([]);
  const photoUrls = photos.map(p => p.url);
  const { getUrl: getPhotoSignedUrl } = usePhotoSignedUrls(photoUrls, "thumb");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  type CompletionLocation = WorkLocationRequirementsValue & {
    workLocationLat: number | null;
    workLocationLng: number | null;
    workLocationAddress: string | null;
    workLocationSource: "gps" | "manual" | null;
    workLocationAccuracyM: number | null;
    workLocationGpsError: string | null;
  };
  const initialCompletionLocation = (): CompletionLocation => {
    const workLocationLat =
      workOrder.workLocationLat != null ? Number(workOrder.workLocationLat) : null;
    const workLocationLng =
      workOrder.workLocationLng != null ? Number(workOrder.workLocationLng) : null;
    const hasPin =
      Number.isFinite(workLocationLat) && Number.isFinite(workLocationLng);
    return {
      workLocationLat: hasPin ? workLocationLat : null,
      workLocationLng: hasPin ? workLocationLng : null,
      workLocationAddress: workOrder.workLocationAddress ?? null,
      workLocation: hasPin
        ? {
            lat: workLocationLat!,
            lng: workLocationLng!,
            address: workOrder.workLocationAddress ?? undefined,
          }
        : null,
      controllerLetter: workOrder.controllerLetter ?? null,
      zoneNumber: workOrder.zoneNumber ?? null,
      fieldWorkType: workOrder.fieldWorkType ?? null,
      fieldWorkTypeDetails: workOrder.fieldWorkTypeDetails ?? "",
      workLocationSource:
        workOrder.workLocationSource === "gps" ||
        workOrder.workLocationSource === "manual"
          ? workOrder.workLocationSource
          : null,
      workLocationAccuracyM:
        workOrder.workLocationAccuracyM != null
          ? Number(workOrder.workLocationAccuracyM)
          : null,
      workLocationGpsError: workOrder.workLocationGpsError ?? null,
    };
  };
  const [completionLocation, setCompletionLocation] =
    useState<CompletionLocation>(initialCompletionLocation);
  const [locationViolations, setLocationViolations] =
    useState<LocationGateViolation[]>([]);
  const [locationGateEvaluated, setLocationGateEvaluated] = useState(false);
  const locationRevisionRef = useRef(0);
  const enforceLocationGate = isLocationGateEnforced(
    workOrder.createdAt,
    WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
  );

  const applyOptimisticLocation = (next: CompletionLocation) => {
    setCompletionLocation(next);
    const cachePatch: Partial<WorkOrder> = {
      workLocationLat: next.workLocationLat != null ? String(next.workLocationLat) : null,
      workLocationLng: next.workLocationLng != null ? String(next.workLocationLng) : null,
      workLocationAddress: next.workLocationAddress,
      controllerLetter: next.controllerLetter,
      zoneNumber: next.zoneNumber,
      fieldWorkType: next.fieldWorkType,
      fieldWorkTypeDetails: next.fieldWorkTypeDetails.trim() || null,
      workLocationSource: next.workLocationSource,
      workLocationAccuracyM:
        next.workLocationAccuracyM != null
          ? String(next.workLocationAccuracyM)
          : null,
      workLocationGpsError: next.workLocationGpsError,
    };
    queryClient.setQueryData<WorkOrder | undefined>(
      ["/api/work-orders", workOrder.id],
      (old) => (old ? { ...old, ...cachePatch } : old),
    );
    queryClient.setQueriesData<WorkOrder[] | undefined>(
      { queryKey: ["/api/work-orders"], exact: false },
      (old) => {
        if (!Array.isArray(old)) return old;
        return old.map((w) => (w.id === workOrder.id ? { ...w, ...cachePatch } : w));
      },
    );
  };

  const updateLocationMutation = useMutation({
    mutationFn: async ({
      payload,
    }: {
      payload: WorkOrderLocationPatchPayload;
      next: CompletionLocation;
      previous: CompletionLocation;
      revision: number;
    }) => {
      return await patchWorkOrderLocation(workOrder.id, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders", workOrder.id] });
    },
  });

  const [completionData, setCompletionData] = useState<WorkOrderCompletionData | null>(null);
  const [partsPickerOpen, setPartsPickerOpen] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>(workOrder.branchName || "");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customer, isLoading: isCustomerLoading } = useQuery<Customer>({
    queryKey: ["/api/customers", workOrder.customerId],
    enabled: !!workOrder.customerId,
  });

  const persistLocation = (
    next: CompletionLocation,
    previous: CompletionLocation,
  ) => {
    const revision = ++locationRevisionRef.current;
    applyOptimisticLocation(next);
    const payload: WorkOrderLocationPatchPayload = {
        workLocationLat: next.workLocationLat,
        workLocationLng: next.workLocationLng,
        workLocationAddress: next.workLocationAddress,
        controllerLetter: next.controllerLetter,
        zoneNumber: next.zoneNumber,
        fieldWorkType: next.fieldWorkType,
        fieldWorkTypeDetails: next.fieldWorkTypeDetails.trim() || null,
        workLocationSource: next.workLocationSource,
        workLocationAccuracyM: next.workLocationAccuracyM,
        workLocationGpsError: next.workLocationGpsError,
    };
    updateLocationMutation.mutate(
      { payload, next, previous, revision },
      {
        onSuccess: () => {
          if (locationRevisionRef.current === revision) {
            applyOptimisticLocation(next);
          }
        },
        onError: (err: unknown) => {
          if (locationRevisionRef.current !== revision) return;
          applyOptimisticLocation(previous);
          const message =
            err instanceof Error
              ? err.message
              : "We restored your previous location details. Please try again.";
          toast({
            title: "Couldn't save the work location",
            description: message,
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleLocationSelect = (location: {
    lat: number;
    lng: number;
    address?: string;
    source?: "gps" | "manual";
    accuracyM?: number | null;
    gpsError?: string | null;
  }) => {
    const previous = completionLocation;
    const next: CompletionLocation = {
      ...completionLocation,
      workLocationLat: location.lat,
      workLocationLng: location.lng,
      workLocationAddress: location.address ?? null,
      workLocation: {
        lat: location.lat,
        lng: location.lng,
        address: location.address,
      },
      workLocationSource: location.source ?? "manual",
      workLocationAccuracyM: location.accuracyM ?? null,
      workLocationGpsError: location.gpsError ?? null,
    };
    persistLocation(next, previous);
  };

  const customerBranches: string[] = Array.isArray(customer?.branches) ? customer.branches : [];
  const needsBranchSelection = customerBranches.length > 0 && !workOrder.branchName;
  // Block submit while customer data is still being fetched (prevents timing-window bypass of branch check)
  const isBranchCheckPending = !!workOrder.customerId && isCustomerLoading;

  // Get user from localStorage (production-compatible)
  const [currentUser, setCurrentUser] = useState<any>(null);
  
  useEffect(() => {
    const savedUser = safeGet("user");
    if (savedUser) {
      try {
        setCurrentUser(JSON.parse(savedUser));
      } catch (error) {
        console.error("Error parsing user data:", error);
      }
    }
  }, []);

  // Get work order items and estimate zones for prefilling
  const { data: workOrderItems } = useQuery({
    queryKey: ["/api/work-orders", workOrder.id, "items"],
  });

  // Task #1935 — count estimate items not covered by the current usedParts
  // selection. Used to show an informational sentence in the summary view.
  const deferredItemCount = useMemo(() => {
    if (!workOrder.estimateId || !Array.isArray(workOrderItems) || workOrderItems.length === 0) return 0;
    const usedSourceIds = new Set(
      usedParts
        .filter((p) => p.sourceItemId != null)
        .map((p) => p.sourceItemId!),
    );
    return (workOrderItems as Array<{ id?: number }>).filter(
      (item) => item.id != null && !usedSourceIds.has(item.id as number),
    ).length;
  }, [workOrder.estimateId, workOrderItems, usedParts]);

  const form = useForm<WorkOrderCompletionData>({
    resolver: zodResolver(workOrderCompletionSchema),
    defaultValues: {
      workSummary: "",
      customerNotes: "",
      totalHours: 1,
      // Task #396 — inherit the work order's persisted labor mode so
      // a per-part WO (e.g. converted from a per-part estimate) keeps
      // its mode through field completion. New direct WOs default to
      // flat (the new system-wide default).
      laborMode: workOrder.laborMode === "per_part" ? "per_part" : "flat",
    },
  });

  // Pre-fill form with estimate data when available
  useEffect(() => {
    if (Array.isArray(workOrderItems) && workOrder.estimateId && usedParts.length === 0) {
      const prefilledParts: UsedPart[] = workOrderItems.map((item: any) => ({
        id: Date.now() + Math.random(),
        partId: item.partId,
        partName: item.partName,
        partPrice: item.partPrice,
        quantity: item.quantity,
        totalCost: parseFloat(item.totalPrice),
        source: 'estimate' as const,
        laborHours: String(item.laborHours ?? '0.00'),
        // Slice 2 (client) — stamp the prior row's db id so the server can
        // match by exact id instead of the stacking-by-partId heuristic.
        sourceItemId: typeof item.id === 'number' ? item.id : null,
      }));

      setUsedParts(prefilledParts);

      // Task #1869 — flat-mode pre-fill uses the WO header totalHours (the
      // approved estimate's flat total). The old Σ laborHours × quantity
      // formula double-counted because line laborHours already include the
      // full quantity; see completion-prefill.ts for details.
      const estimatedHours = computeCompletionPrefillHours(workOrder, workOrderItems);

      form.reset({
        workSummary: "",
        customerNotes: "Work completed according to estimate specifications",
        totalHours: Math.max(estimatedHours, 0.1),
        // Preserve the WO's persisted labor mode through the prefill.
        laborMode: workOrder.laborMode === "per_part" ? "per_part" : "flat",
      });
    }
    // Depend on the header fields the prefill consumes (totalHours, laborMode)
    // so a refreshed work order prop can't leave stale hours behind. The
    // usedParts.length guard still prevents overwriting user-entered values
    // after the initial prefill.
  }, [workOrderItems, workOrder.estimateId, workOrder.totalHours, workOrder.laborMode, form, usedParts.length]);

  const completeWorkOrderMutation = useMutation({
    mutationFn: async (data: any) => {
      return completeWorkOrder(data);
    },
    onSuccess: (result) => {
      toast({
        title: result.queued ? "Work order completion queued" : "Work Order Completed",
        description: result.queued
          ? "Saved on this device and will finish when you're back online."
          : "Work order has been successfully completed with all documentation.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      onComplete();
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to complete work order. Please try again.",
        variant: "destructive",
      });
    },
  });

  const addUsedPart = (part: Part) => {
    // Only merge into an existing row if it is field_added (sourceItemId is null).
    // Estimate-origin rows (sourceItemId set) must stay as their own origin even
    // when they share a partId with the new field-added part — merging them would
    // silently clobber the zone lineage carried on the estimate row.
    const existingFieldAdded = usedParts.find(
      up => up.partId === part.id && up.source === 'field_added' && !up.sourceItemId,
    );

    if (existingFieldAdded) {
      setUsedParts(prev => prev.map(up =>
        up.id === existingFieldAdded.id
          ? {
              ...up,
              quantity: up.quantity + 1,
              totalCost: (up.quantity + 1) * parseFloat(part.price),
            }
          : up,
      ));
    } else {
      const newUsedPart: UsedPart = {
        id: Date.now(),
        partId: part.id,
        partName: part.name,
        partPrice: part.price,
        quantity: 1,
        totalCost: parseFloat(part.price),
        source: 'field_added',
        laborHours: '0.00',
        sourceItemId: null,
      };
      setUsedParts(prev => [...prev, newUsedPart]);
    }
  };



  const updatePartQuantity = (id: number, quantity: number) => {
    if (quantity <= 0) {
      setUsedParts(prev => prev.filter(up => up.id !== id));
      return;
    }
    
    setUsedParts(prev => prev.map(up => 
      up.id === id 
        ? { 
            ...up, 
            quantity,
            totalCost: quantity * parseFloat(up.partPrice)
          }
        : up
    ));
  };

  const getTotalPartsCost = () => {
    return usedParts.reduce((sum, part) => sum + part.totalCost, 0);
  };

  const onSubmit = async (data: WorkOrderCompletionData) => {
    if (needsBranchSelection && !selectedBranch) {
      toast({
        title: "Branch Required",
        description: "Please select a branch location before completing this work order.",
        variant: "destructive",
      });
      return;
    }

    if (usedParts.length === 0) {
      toast({
        title: "Parts Required",
        description: "Please add at least one part used during the repair, or add a 'No Parts' entry.",
        variant: "destructive",
      });
      return;
    }

    if (
      enforceLocationGate &&
      (!locationGateEvaluated || locationViolations.length > 0)
    ) {
      toast({
        title: "Work location incomplete",
        description: "Complete every item in the location card before reviewing this work order.",
        variant: "destructive",
      });
      return;
    }

    // Store the form data and show summary
    setCompletionData(data);
    setShowSummary(true);
  };

  const onFinalSubmit = async () => {
    if (!completionData) return;
    if (
      enforceLocationGate &&
      (!locationGateEvaluated || locationViolations.length > 0)
    ) {
      toast({
        title: "Work location incomplete",
        description: "Return to the form and complete every item in the location card.",
        variant: "destructive",
      });
      return;
    }
    if (updateLocationMutation.isPending) {
      toast({
        title: "Saving work location",
        description: "Wait for the location to be saved before completing this work order.",
      });
      return;
    }

    setIsSubmitting(true);
    
    try {
      // If work order hasn't been started yet, start it first
      if (workOrder.status === 'assigned' || workOrder.status === 'pending') {
        if (!isProbablyOffline()) {
          await apiRequest(`/api/work-orders/${workOrder.id}`, "PATCH", {
            status: 'in_progress',
            startedAt: new Date().toISOString()
          });
        }
      }
      
      // Now complete the work order
      const finalData = {
        workOrderId: workOrder.id,
        workSummary: completionData.workSummary,
        customerNotes: completionData.customerNotes,
        completedAt: new Date().toISOString(),
        // Task #396 — completion form now exposes a Flat | Per-part
        // toggle. Send the user-selected mode so the server records
        // the audit trail and recomputes totals against the chosen
        // formula.
        laborMode: completionData.laborMode,
        totalHours: completionData.totalHours,
        usedParts: usedParts.map(up => ({
          partId: up.partId,
          partName: up.partName,
          partPrice: up.partPrice,
          laborHours: up.laborHours,
          quantity: up.quantity,
          totalCost: up.totalCost.toFixed(2),
          // Slice 2 (client) — carry the db id of the prior row so the server
          // can do an exact-id lookup. null for field-added parts.
          sourceItemId: up.sourceItemId ?? null,
        })),
        photos: photos.map(photo => photo.url),
        totalPartsCost: getTotalPartsCost().toFixed(2),
        branchName: selectedBranch || workOrder.branchName || undefined,
      };

      await completeWorkOrderMutation.mutateAsync(finalData);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to complete work order",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const onEditClick = () => {
    setShowSummary(false);
  };

  // Reset states when modal closes
  const handleClose = () => {
    setShowSummary(false);
    setCompletionData(null);
    form.reset();
    setUsedParts([]);
    setPhotos([]);
    setCompletionLocation(initialCompletionLocation());
    setLocationViolations([]);
    setLocationGateEvaluated(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="w-screen h-screen sm:w-[95vw] sm:max-w-4xl sm:h-[95vh] sm:max-h-[95vh] sm:rounded-lg overflow-hidden p-0 flex flex-col">
        <DialogHeader className="p-3 sm:p-6 border-b border-gray-200 flex-shrink-0">
          <DialogTitle className="flex items-center gap-3 text-lg sm:text-xl">
            <div className="bg-green-50 p-2 rounded-lg">
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <span className="text-xl font-semibold">
                {showSummary ? "Review Work Order Summary" : "Complete Work Order"}
              </span>
              <p className="text-sm text-gray-600 font-normal mt-1">
                {workOrder.workOrderNumber} - {workOrder.projectName}
              </p>
            </div>
          </DialogTitle>
          <DialogDescription>
            {showSummary 
              ? "Review the work order details before final submission."
              : "Document the completed work, parts used, and provide customer notes before marking as complete."
            }
          </DialogDescription>
        </DialogHeader>

        {workOrder.estimateId && Array.isArray(workOrderItems) && workOrderItems.length > 0 && !showSummary && (
          <div className="border-b border-gray-200 bg-blue-50 p-4">
            <h3 className="text-sm font-semibold text-blue-900 mb-2 flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Planned Work (Based on Estimate #{workOrder.estimateId})
            </h3>
            <div className="space-y-2">
              {workOrderItems.slice(0, 3).map((item: any) => (
                <div key={item.id} className="text-xs text-blue-800">
                  <span className="font-medium">{item.description || item.partName}:</span> {item.quantity} × ${item.partPrice}
                </div>
              ))}
              {workOrderItems.length > 3 && (
                <div className="text-xs text-blue-600 italic">
                  +{workOrderItems.length - 3} more items...
                </div>
              )}
            </div>
            <div className="text-xs text-blue-700 mt-2 italic">
              Parts and hours below are pre-filled from estimate. Adjust as needed for actual work performed.
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-3 sm:p-6 min-w-0">
          {showSummary ? (
            // Summary View
            <div className="space-y-6">
            {/* Work Summary Card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Wrench className="w-5 h-5 text-blue-600" />
                  Work Completed Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="font-medium text-gray-700">Work Summary:</span>
                  <p className="text-gray-900 mt-1 p-3 bg-gray-50 rounded-lg">{completionData?.workSummary}</p>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Customer Notes:</span>
                  <p className="text-gray-900 mt-1 p-3 bg-gray-50 rounded-lg">{completionData?.customerNotes}</p>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Total Hours Worked:</span>
                  <p className="text-gray-900 mt-1 text-xl font-bold text-blue-600">{completionData?.totalHours} hours</p>
                </div>
              </CardContent>
            </Card>

            {/* Parts Used Summary */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" />
                    Parts Used Summary
                  </span>
                  {currentUser?.role !== 'field_tech' && (
                    <div className="text-sm font-normal text-gray-600">
                      Total: ${getTotalPartsCost().toFixed(2)}
                    </div>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {usedParts.map((part) => (
                    <div key={part.id} className="flex items-center justify-between p-3 border rounded-lg bg-gray-50 min-w-0">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{part.partName}</div>
                        {currentUser?.role !== 'field_tech' ? (
                          <div className="text-sm text-gray-500">
                            ${part.partPrice} each × {part.quantity}
                          </div>
                        ) : (
                          <div className="text-sm text-gray-500">
                            Quantity: {part.quantity}
                          </div>
                        )}
                      </div>
                      {currentUser?.role !== 'field_tech' && (
                        <div className="text-lg font-bold text-blue-600">
                          ${part.totalCost.toFixed(2)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Photos Summary */}
            {photos.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Camera className="w-5 h-5 text-blue-600" />
                    Completion Photos ({photos.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 min-w-0">
                    {photos.map((photo, index) => (
                      <div key={index} className="aspect-square bg-gray-100 rounded-lg overflow-hidden">
                        {(photo as { previewUrl?: string }).previewUrl ? (
                          <img
                            src={(photo as { previewUrl?: string }).previewUrl}
                            alt={`Completion photo ${index + 1}`}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <PhotoImage
                            photoUrl={photo.url}
                            alt={`Completion photo ${index + 1}`}
                            variant="thumb"
                            batchManaged
                            signedUrlOverride={getPhotoSignedUrl(photo.url)}
                            className="w-full h-full object-cover"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            <Separator />

            {/* Task #1935 — deferred items informational notice */}
            {deferredItemCount > 0 && workOrder.estimateId && (
              <div className="rounded-md bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
                {deferredItemCount} {deferredItemCount === 1 ? "item" : "items"} from the estimate{" "}
                {deferredItemCount === 1 ? "isn't" : "aren't"} on this work order. {deferredItemCount === 1 ? "It" : "They"}&apos;ll move
                to a follow-up work order and won&apos;t be billed here.
              </div>
            )}

            {/* Action Buttons for Summary */}
            <div className="flex flex-col sm:flex-row justify-end gap-3">
              <Button 
                type="button" 
                variant="outline" 
                onClick={onEditClick}
                className="px-6 w-full sm:w-auto min-h-[44px]"
              >
                <Edit className="w-4 h-4 mr-2" />
                Edit Details
              </Button>
              <Button 
                onClick={onFinalSubmit}
                disabled={
                  isSubmitting ||
                  (enforceLocationGate &&
                    (!locationGateEvaluated ||
                      locationViolations.length > 0))
                }
                className="bg-green-600 hover:bg-green-700 text-white px-6 w-full sm:w-auto min-h-[44px]"
              >
                {isSubmitting ? "Submitting..." : "Submit Work Order"}
              </Button>
            </div>
          </div>
        ) : (
          // Form View (existing form code)

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Branch selector — shown when the customer has branches but the work order has no branch set */}
            {needsBranchSelection && (
              <Card className="border-2 border-orange-300 bg-orange-50">
                <CardContent className="p-4">
                  <div className="space-y-2">
                    <label className="font-semibold text-sm text-orange-800 flex items-center gap-1">
                      <User className="w-4 h-4" />
                      Branch Location *
                    </label>
                    <p className="text-xs text-orange-700">This customer has multiple branch locations. Please select the branch for this work order.</p>
                    <Select value={selectedBranch} onValueChange={setSelectedBranch}>
                      <SelectTrigger className="bg-white border-orange-300">
                        <SelectValue placeholder="Select branch location..." />
                      </SelectTrigger>
                      <SelectContent>
                        {customerBranches.map((branch) => (
                          <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!selectedBranch && (
                      <p className="text-xs text-red-600 font-medium">Branch selection is required before completing this work order.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Canonical online work-location capture */}
            <CustomerLocationPicker
              customerId={workOrder.customerId}
              hasCustomerAddress={!!customer?.address}
              selectedLocation={completionLocation.workLocation}
              onLocationSelect={handleLocationSelect}
            >
              <div className="border-t pt-4">
                <WorkLocationControls
                  customerId={workOrder.customerId}
                  value={completionLocation}
                  onChange={(next) =>
                    persistLocation(next, completionLocation)
                  }
                  enforceLocationGate={enforceLocationGate}
                  onGateStateChange={(_complete, violations) =>
                    {
                      setLocationViolations(violations);
                      setLocationGateEvaluated(true);
                    }
                  }
                  showStatus
                  grouped
                />
              </div>
              <div className="flex items-center gap-2 justify-end border-t pt-3">
                {(() => {
                  const mapsUrl = buildMapsUrl({
                    lat: completionLocation.workLocationLat,
                    lng: completionLocation.workLocationLng,
                    address: completionLocation.workLocationAddress,
                    label:
                      completionLocation.workLocationAddress ||
                      workOrder.projectAddress ||
                      workOrder.customerName,
                  });
                  const hasPin =
                    completionLocation.workLocationLat != null &&
                    completionLocation.workLocationLng != null;
                  if (!hasPin || !mapsUrl) return null;
                  return (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      asChild
                      className="border-blue-600 text-blue-700 hover:bg-blue-50"
                    >
                      <a
                        href={mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="link-get-directions"
                      >
                        <Navigation className="w-3.5 h-3.5 mr-1.5" />
                        Get directions
                      </a>
                    </Button>
                  );
                })()}
              </div>
            </CustomerLocationPicker>

            {/* Work Summary */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Wrench className="w-5 h-5 text-blue-600" />
                  Work Completed
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="workSummary"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Work Summary *</FormLabel>
                        <AiExpandButton
                          getValue={() => field.value || ""}
                          onSuggestion={setAiSuggestion}
                        />
                      </div>
                      <FormControl>
                        <Textarea
                          placeholder="Describe the work performed — parts used are recorded separately below."
                          className="min-h-[100px]"
                          {...field}
                        />
                      </FormControl>
                      <AiSuggestionCard
                        suggestion={aiSuggestion}
                        onAccept={() => { form.setValue("workSummary", aiSuggestion!); setAiSuggestion(null); }}
                        onDismiss={() => setAiSuggestion(null)}
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Task #396 — Flat | Per-part labor toggle. */}
                <FormField
                  control={form.control}
                  name="laborMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Labor Mode</FormLabel>
                      <FormControl>
                        <div
                          className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5 text-xs"
                          role="tablist"
                          data-testid="wo-complete-labor-mode-toggle"
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected={field.value !== "per_part"}
                            className={`px-3 py-1 rounded ${
                              field.value !== "per_part"
                                ? "bg-white shadow-sm font-semibold text-gray-900"
                                : "text-gray-500"
                            }`}
                            onClick={() => field.onChange("flat")}
                            data-testid="wo-complete-labor-mode-flat"
                          >
                            Flat
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={field.value === "per_part"}
                            className={`px-3 py-1 rounded ${
                              field.value === "per_part"
                                ? "bg-white shadow-sm font-semibold text-gray-900"
                                : "text-gray-500"
                            }`}
                            onClick={() => field.onChange("per_part")}
                            data-testid="wo-complete-labor-mode-per-part"
                          >
                            Per part
                          </button>
                        </div>
                      </FormControl>
                      <p className="text-xs text-gray-500 mt-1">
                        Flat uses the single Total Hours field below. Per part
                        derives total hours from the per-line breakdown carried
                        on this work order.
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="totalHours"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Total Hours Worked *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="0.1"
                          min="0.1"
                          placeholder="Enter hours (e.g., 2.5)"
                          {...field}
                          onChange={e => field.onChange(parseFloat(e.target.value))}
                          disabled={form.watch("laborMode") === "per_part"}
                          data-testid="wo-complete-total-hours"
                        />
                      </FormControl>
                      {form.watch("laborMode") === "per_part" && (
                        <p className="text-xs text-gray-500 mt-1">
                          In Per-part mode, total hours come from Σ(laborHours × qty)
                          across line items and are recomputed on the server.
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Parts Used */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" />
                    Parts Used
                  </span>
                  {currentUser?.role !== 'field_tech' && (
                    <div className="text-sm font-normal text-gray-600">
                      Total: ${getTotalPartsCost().toFixed(2)}
                    </div>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Add Part button */}
                <Button
                  type="button"
                  onClick={() => setPartsPickerOpen(true)}
                  className="bg-blue-600 hover:bg-blue-700 text-white min-h-[44px]"
                  data-testid="wo-complete-add-part"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Part
                </Button>

                <PartPicker
                  open={partsPickerOpen}
                  onOpenChange={setPartsPickerOpen}
                  presentation="sheet"
                  selectMode="multi"
                  showCategoryChips
                  keyboardNav
                  onSelectPart={(part) => addUsedPart(part)}
                />

                {/* Used Parts List */}
                {usedParts.length > 0 ? (
                  <div className="space-y-4">
                    {/* Estimate Parts Section */}
                    {usedParts.filter(part => part.source === 'estimate').length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-blue-200">
                          <div className="w-3 h-3 bg-blue-100 border border-blue-300 rounded"></div>
                          <h4 className="font-medium text-blue-800">Planned Parts (From Estimate)</h4>
                        </div>
                        <div className="space-y-2">
                          {usedParts.filter(part => part.source === 'estimate').map((usedPart) => (
                            <div key={usedPart.id} className="flex items-center justify-between p-3 border border-blue-200 rounded-lg bg-blue-50 min-w-0">
                              <div className="flex-1 min-w-0">
                                <div className="font-medium flex items-center gap-2">
                                  {usedPart.partName}
                                  <span className="text-xs bg-blue-200 text-blue-800 px-2 py-1 rounded">Estimate</span>
                                </div>
                                {currentUser?.role !== 'field_tech' ? (
                                  <div className="text-sm text-blue-600">
                                    ${usedPart.partPrice} each × {usedPart.quantity} = ${usedPart.totalCost.toFixed(2)}
                                  </div>
                                ) : (
                                  <div className="text-sm text-blue-600">
                                    Quantity: {usedPart.quantity}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => updatePartQuantity(usedPart.id, usedPart.quantity - 1)}
                                  className="border-blue-300 hover:bg-blue-100 h-11 w-11 p-0"
                                >
                                  <Minus className="w-4 h-4" />
                                </Button>
                                <span className="w-8 text-center font-medium text-blue-800">{usedPart.quantity}</span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => updatePartQuantity(usedPart.id, usedPart.quantity + 1)}
                                  className="border-blue-300 hover:bg-blue-100 h-11 w-11 p-0"
                                >
                                  <Plus className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Field Added Parts Section */}
                    {usedParts.filter(part => part.source === 'field_added').length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-orange-200">
                          <div className="w-3 h-3 bg-orange-100 border border-orange-300 rounded"></div>
                          <h4 className="font-medium text-orange-800">Additional Parts (Field Added)</h4>
                        </div>
                        <div className="space-y-2">
                          {usedParts.filter(part => part.source === 'field_added').map((usedPart) => (
                            <div key={usedPart.id} className="flex items-center justify-between p-3 border border-orange-200 rounded-lg bg-orange-50 min-w-0">
                              <div className="flex-1 min-w-0">
                                <div className="font-medium flex items-center gap-2">
                                  {usedPart.partName}
                                  <span className="text-xs bg-orange-200 text-orange-800 px-2 py-1 rounded">Field Added</span>
                                </div>
                                {currentUser?.role !== 'field_tech' ? (
                                  <div className="text-sm text-orange-600">
                                    ${usedPart.partPrice} each × {usedPart.quantity} = ${usedPart.totalCost.toFixed(2)}
                                  </div>
                                ) : (
                                  <div className="text-sm text-orange-600">
                                    Quantity: {usedPart.quantity}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => updatePartQuantity(usedPart.id, usedPart.quantity - 1)}
                                  className="border-orange-300 hover:bg-orange-100 h-11 w-11 p-0"
                                >
                                  <Minus className="w-4 h-4" />
                                </Button>
                                <span className="w-8 text-center font-medium text-orange-800">{usedPart.quantity}</span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => updatePartQuantity(usedPart.id, usedPart.quantity + 1)}
                                  className="border-orange-300 hover:bg-orange-100 h-11 w-11 p-0"
                                >
                                  <Plus className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8 text-gray-500">
                    <AlertCircle className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                    <p>No parts added yet. Add parts used during the repair.</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Customer Notes */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Customer Communication</CardTitle>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="customerNotes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Customer Notes *</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Notes to share with the customer about the repair, recommendations, follow-up needed..."
                          className="min-h-[80px]"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Photos */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Camera className="w-5 h-5 text-blue-600" />
                  Completion Photos
                </CardTitle>
              </CardHeader>
              <CardContent>
                <FileUpload
                  type="photo"
                  label="Photos"
                  accept="image/*"
                  multiple={true}
                  files={photos.map(p => ({ url: p.url, fileName: p.fileName, originalName: p.originalName, previewUrl: p.previewUrl }))}
                  onFilesChange={(files) => setPhotos(files.map(f => ({ url: f.url, fileName: f.fileName, originalName: f.originalName, previewUrl: f.previewUrl })))}
                />
              </CardContent>
            </Card>


            <Separator />

            {/* Submit Button */}
            <div className="flex flex-col sm:flex-row justify-end gap-3">
              {currentUser?.role !== 'field_tech' && (
                <Button type="button" variant="outline" onClick={handleClose} className="w-full sm:w-auto min-h-[44px]">
                  Cancel
                </Button>
              )}
              <Button 
                type="submit" 
                disabled={
                  isSubmitting ||
                  isBranchCheckPending ||
                  updateLocationMutation.isPending ||
                  (enforceLocationGate &&
                    (!locationGateEvaluated ||
                      locationViolations.length > 0))
                }
                className="bg-green-600 hover:bg-green-700 text-white w-full sm:w-auto min-h-[44px]"
              >
                {isBranchCheckPending
                  ? "Loading..."
                  : updateLocationMutation.isPending
                    ? "Saving location..."
                    : isSubmitting
                      ? "Reviewing..."
                      : "Review Work Order"}
              </Button>
            </div>
          </form>
        </Form>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}