import { safeGet } from "@/utils/safeStorage";
import { ActivityTab } from "@/components/activity/ActivityTab";
import { useState, useEffect, useContext } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { FileUpload } from "@/components/ui/file-upload";

import { WorkOrderCompletion } from "./work-order-completion";
import { InspectionZoneChecklist, isInspectionOriginWorkOrder } from "./inspection-zone-checklist";
import { AssignmentConfirmationModal } from "./assignment-confirmation-modal";
import { WorkOrderWizard } from "./work-order-wizard";
import { BilledIndicator } from "@/components/ui/billed-indicator";
import { 
  FileText, 
  Calendar, 
  Clock, 
  User, 
  MapPin, 
  Phone, 
  Mail,
  CheckCircle,
  CheckCircle2,
  Play,
  Pause,
  AlertCircle,
  Edit,
  Receipt,
  Building,
  Hash,
  Target,
  Timer,
  MessageSquare,
  Users,
  Download,
  ArrowRight,
  Package,
  Wrench,
  List,
  Activity,
  Camera,
  DollarSign,
  History,
  X,
  Navigation,
  Cpu,
  ExternalLink,
  Loader2,
  Save,
  Link as LinkIcon,
} from "lucide-react";
import { PricingAuditHistory } from "@/components/billing/pricing-audit-history";
import { ApprovalSignatureBlock } from "@/components/estimates/approval-signature-block";
import { EditableField, InlineEditProvider, InlineEditContext } from "@/components/ui/editable-field";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, parseApiError, useArrayQuery } from "@/lib/queryClient";
import type { WorkOrder, User as UserType } from "@workspace/db/schema";
import { PhotoImage, usePhotoSignedUrls } from "@/components/ui/photo-image";
import { buildMapsUrl } from "@/lib/maps-url";

// ─── Approval Action Row ──────────────────────────────────────────────────────
// Rendered inside InlineEditProvider when opened from Manager Workspace.
function WOApprovalActionRow({
  workOrderId,
  isLocked,
  onClose,
  onSuccess,
}: {
  workOrderId: number;
  isLocked: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const { triggerSave } = useContext(InlineEditContext);
  const [approving, setApproving] = useState(false);
  const [showReturnInput, setShowReturnInput] = useState(false);
  const [returnNotes, setReturnNotes] = useState("");

  const doSave = async () => {
    try {
      await triggerSave();
      toast({ title: "Saved", description: "Work order changes saved." });
    } catch (err: any) {
      toast({ title: "Save failed", description: parseApiError(err, "Save failed"), variant: "destructive" });
    }
  };

  const doApprove = async () => {
    setApproving(true);
    try {
      await apiRequest(`/api/work-orders/${workOrderId}/approve`, "POST", {});
      toast({ title: "Approved", description: "Work order approved and passed to billing." });
      onClose();
      onSuccess();
    } catch (err: any) {
      toast({ title: "Approval failed", description: parseApiError(err, "Approval failed"), variant: "destructive" });
    } finally {
      setApproving(false);
    }
  };

  const doSaveAndApprove = async () => {
    setApproving(true);
    try {
      const saved = await triggerSave();
      if (!saved) { setApproving(false); return; }
      await apiRequest(`/api/work-orders/${workOrderId}/approve`, "POST", {});
      toast({ title: "Saved & Approved", description: "Work order saved and passed to billing." });
      onClose();
      onSuccess();
    } catch (err: any) {
      toast({ title: "Save & Approve failed", description: parseApiError(err, "Save & Approve failed"), variant: "destructive" });
    } finally {
      setApproving(false);
    }
  };

  const doReturn = async () => {
    setApproving(true);
    try {
      await apiRequest(`/api/work-orders/${workOrderId}/return-for-correction`, "POST", { notes: returnNotes });
      toast({ title: "Returned for correction", description: "Work order returned to technician." });
      onClose();
      onSuccess();
    } catch (err: any) {
      toast({ title: "Return failed", description: parseApiError(err, "Return failed"), variant: "destructive" });
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="flex-shrink-0 border-t border-amber-100 bg-amber-50 px-5 py-3 space-y-2" data-testid="approval-action-row">
      {showReturnInput ? (
        <div className="space-y-2">
          <p className="text-xs text-gray-600 font-medium">Return notes (optional)</p>
          <textarea
            className="w-full rounded-md border border-gray-200 text-sm px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={2}
            value={returnNotes}
            onChange={(e) => setReturnNotes(e.target.value)}
            placeholder="Describe what needs to be corrected…"
            data-testid="return-notes-input"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="destructive" onClick={() => void doReturn()} disabled={approving} data-testid="confirm-return-button">
              {approving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Send back
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setShowReturnInput(false); setReturnNotes(""); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void doSave()}
            disabled={isLocked || approving}
            data-testid="save-button"
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            Save
          </Button>
          <Button
            size="sm"
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={() => void doApprove()}
            disabled={isLocked || approving}
            data-testid="approve-button"
          >
            {approving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
            Approve
          </Button>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => void doSaveAndApprove()}
            disabled={isLocked || approving}
            data-testid="save-and-approve-button"
          >
            {approving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
            Save & Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-amber-700 border-amber-300 hover:bg-amber-100"
            onClick={() => setShowReturnInput(true)}
            disabled={isLocked || approving}
            data-testid="return-for-correction-button"
          >
            Return for Correction
          </Button>
        </div>
      )}
    </div>
  );
}

interface WorkOrderDetailsProps {
  workOrder: WorkOrder;
  onClose: () => void;
  onUpdate: () => void;
  showAddDetailsButton?: boolean;
  onStartWork?: (workOrder: WorkOrder) => void;
  onApproveSuccess?: () => void;
}

export function WorkOrderDetails({ workOrder, onClose, onUpdate, showAddDetailsButton = false, onStartWork, onApproveSuccess }: WorkOrderDetailsProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const [showCompletionForm, setShowCompletionForm] = useState(false);
  const [selectedTechnicianId, setSelectedTechnicianId] = useState<string>("");
  const [showAssignmentConfirmation, setShowAssignmentConfirmation] = useState(false);
  const [pendingTechnicianId, setPendingTechnicianId] = useState<string>("");
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<string | null>(null);
  const [photoToRemove, setPhotoToRemove] = useState<number | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  // Tracks photo URLs we've sent to the server but that haven't yet
  // round-tripped back into the workOrder prop. Without this, two
  // back-to-back upload batches would each compute their merged
  // photo list off the same stale workOrder.photos and the second
  // PATCH would overwrite the first.
  const [inFlightPhotoAdditions, setInFlightPhotoAdditions] = useState<string[]>([]);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const woPhotoList: string[] = Array.isArray(workOrder.photos) ? (workOrder.photos as string[]) : [];
  const { getUrl: getWoPhotoUrl } = usePhotoSignedUrls(woPhotoList, "thumb");
  const { getUrl: getWoMediumUrl } = usePhotoSignedUrls(woPhotoList, "medium");

  // When the server's photo list catches up with our in-flight
  // additions, drop the entries that have been confirmed.
  useEffect(() => {
    setInFlightPhotoAdditions(prev => prev.filter(url => !woPhotoList.includes(url)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [woPhotoList.join("|")]);

  // Get current user from localStorage
  useEffect(() => {
    const savedUser = safeGet("user");
    if (savedUser) {
      setCurrentUser(JSON.parse(savedUser));
    }
  }, []);

  // Get field technicians for reassignment
  const { data: fieldTechs = [] } = useArrayQuery<UserType>({
    queryKey: ["/api/users/field-techs"],
  });

  // Task #187 — resolve the noPhotosNeededBy user id to a display name.
  // Only fetched when there's actually an id to look up so we don't add
  // an extra request for every work-order open.
  const { data: allUsers = [] } = useArrayQuery<UserType>({
    queryKey: ["/api/users"],
    enabled: !!workOrder.noPhotosNeededBy,
  });

  // Get work order items and zones for work plan display
  const { data: workOrderItems } = useQuery({
    queryKey: ["/api/work-orders", workOrder.id, "items"],
  });

  const canInlineEditWO =
    ["billing_manager", "company_admin", "super_admin"].includes(currentUser?.role ?? "") &&
    !(workOrder.status === 'billed' || workOrder.invoiceId != null);

  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string>>({});
  useEffect(() => { setFieldOverrides({}); }, [workOrder.id]);
  // After a successful save the server refetches and workOrder.updatedAt changes.
  // Clear all overrides at that point so any server-normalized values show through.
  useEffect(() => { setFieldOverrides({}); }, [(workOrder as any).updatedAt]);

  const patchWOMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      apiRequest(`/api/work-orders/${workOrder.id}`, "PATCH", patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      onUpdate();
    },
    onError: (err: Error) => {
      toast({ title: "Could not save", description: parseApiError(err, err.message), variant: "destructive" });
    },
  });

  const patchWOField = async (key: string, value: string, patch: Record<string, unknown>) => {
    await patchWOMutation.mutateAsync(patch);
    setFieldOverrides((prev) => ({ ...prev, [key]: value }));
  };

  const fv = (key: string, raw: string | null | undefined) =>
    key in fieldOverrides ? fieldOverrides[key] : (raw ?? "");

  const updatePriority = useMutation({
    mutationFn: async (priority: string) => {
      return apiRequest(`/api/work-orders/${workOrder.id}`, "PATCH", { priority });
    },
    onSuccess: () => {
      toast({
        title: "Priority Updated",
        description: "Work order priority has been updated successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      onUpdate();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update priority",
        variant: "destructive",
      });
    },
  });

  const reassignWorkOrder = useMutation({
    mutationFn: async (technicianId: string) => {
      // Check if manager is assigning to themselves
      if (technicianId === currentUser?.id.toString()) {
        return apiRequest(`/api/work-orders/${workOrder.id}/assign`, "POST", {
          technicianId: currentUser.id,
          technicianName: currentUser.name,
        });
      }
      
      // Otherwise, find the selected field technician
      const selectedTech = fieldTechs?.find(tech => tech.id.toString() === technicianId);
      if (!selectedTech) throw new Error("Technician not found");
      
      return apiRequest(`/api/work-orders/${workOrder.id}/assign`, "POST", {
        technicianId: selectedTech.id,
        technicianName: selectedTech.name,
      });
    },
    onSuccess: () => {
      toast({
        title: "Work Order Reassigned",
        description: "Work order has been successfully reassigned to field technician",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      setSelectedTechnicianId("");
      onUpdate();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to reassign work order",
        variant: "destructive",
      });
    },
  });

  const handleCreateInvoice = async () => {
    try {
      await apiRequest(`/api/work-orders/${workOrder.id}/create-invoice`, "POST");
      toast({
        title: "Success",
        description: "Invoice created successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create invoice",
        variant: "destructive",
      });
    }
  };

  const handleSyncToQuickBooks = async () => {
    try {
      await apiRequest(`/api/work-orders/${workOrder.id}/sync-quickbooks`, "POST");
      toast({
        title: "Success",
        description: "Synced to QuickBooks successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to sync to QuickBooks",
        variant: "destructive",
      });
    }
  };

  const updateWorkOrderStatus = useMutation({
    mutationFn: async (status: string) => {
      const updateData: any = { status };
      
      return apiRequest(`/api/work-orders/${workOrder.id}`, "PATCH", updateData);
    },
    onSuccess: (data, status) => {
      toast({
        title: "Work Order Updated",
        description: `Work order status changed to ${status.replace('_', ' ')}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      onUpdate();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update work order",
        variant: "destructive",
      });
    },
  });

  const canEditPhotos =
    currentUser?.role === 'company_admin' ||
    currentUser?.role === 'super_admin' ||
    currentUser?.role === 'irrigation_manager' ||
    currentUser?.role === 'billing_manager' ||
    (currentUser?.role === 'field_tech' && workOrder.assignedTechnicianId === currentUser?.id);

  const updatePhotos = useMutation({
    mutationFn: async (photos: string[]) => {
      return apiRequest(`/api/work-orders/${workOrder.id}`, "PATCH", { photos });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      onUpdate();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update photos",
        variant: "destructive",
      });
    },
  });

  // Task #187 — undo the "No Photos Needed" flag from the detail view.
  const clearNoPhotosNeeded = useMutation({
    mutationFn: async () => apiRequest(`/api/work-orders/${workOrder.id}/no-photos-needed/clear`, "POST"),
    onSuccess: () => {
      toast({ title: "Undone", description: "'No Photos Needed' flag has been cleared." });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders/missing-photos"] });
      onUpdate();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to clear flag", variant: "destructive" });
    },
  });

  const canManageNoPhotosNeeded =
    currentUser?.role === 'company_admin' ||
    currentUser?.role === 'super_admin' ||
    currentUser?.role === 'irrigation_manager' ||
    currentUser?.role === 'billing_manager';

  const noPhotosNeededByName = (() => {
    const id = workOrder.noPhotosNeededBy;
    if (!id || !allUsers) return null;
    const u = allUsers.find((user: UserType) => user.id === id);
    return u ? (u.name || u.username) : null;
  })();

  const handleConfirmRemovePhoto = () => {
    if (photoToRemove === null) return;
    const existingPhotos: string[] = Array.isArray(workOrder.photos) ? workOrder.photos as string[] : [];
    const updatedPhotos = existingPhotos.filter((_, i) => i !== photoToRemove);
    updatePhotos.mutate(updatedPhotos);
    setPhotoToRemove(null);
    toast({ title: "Photo Removed", description: "Photo has been removed from this work order" });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">Pending</Badge>;
      case 'in_progress':
        return <Badge className="bg-blue-100 text-blue-800 border-blue-200">In Progress</Badge>;
      case 'work_completed':
        return <Badge className="bg-green-100 text-green-800 border-green-200">Completed</Badge>;
      case 'billed':
        return <Badge className="bg-purple-100 text-purple-800 border-purple-200">Billed</Badge>;
      case 'cancelled':
        return <Badge className="bg-red-100 text-red-800 border-red-200">Cancelled</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const isBilledWorkOrder = workOrder.status === 'billed' || workOrder.invoiceId != null;

  const getPriorityBadge = (priority: string, showLabel: boolean = false) => {
    const priorityMap = {
      'urgent': { bg: 'bg-red-100 text-red-800 border-red-200', label: 'Emergency' },
      'high': { bg: 'bg-orange-100 text-orange-800 border-orange-200', label: 'High Priority' },
      'medium': { bg: 'bg-yellow-100 text-yellow-800 border-yellow-200', label: 'Standard' },
      'low': { bg: 'bg-green-100 text-green-800 border-green-200', label: 'Low Priority' }
    };
    
    const config = priorityMap[priority as keyof typeof priorityMap];
    if (!config) return <Badge variant="outline">{priority}</Badge>;
    
    const label = showLabel ? config.label : priority.charAt(0).toUpperCase() + priority.slice(1);
    return <Badge className={config.bg}>{label}</Badge>;
  };



  const toDateInput = (d: string | Date | null | undefined): string => {
    if (!d) return "";
    try {
      // Use local date parts (not toISOString which is UTC) so the value shown
      // in the <input type="date"> matches the user's local calendar date.
      const date = new Date(d as string | Date);
      if (isNaN(date.getTime())) return "";
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    } catch { return ""; }
  };

  const formatDate = (date: string | Date | null) => {
    if (!date) return "Not set";
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusActions = () => {
    const buttons = [];
    
    // Start button moved to bottom section - not included here
    
    // Only show cancel button for non-field technicians on non-billed records
    if (!isBilledWorkOrder && workOrder.status !== 'cancelled' && workOrder.status !== 'work_completed' && currentUser?.role !== 'field_tech') {
      buttons.push(
        <Button
          key="cancel"
          onClick={() => updateWorkOrderStatus.mutate('cancelled')}
          disabled={updateWorkOrderStatus.isPending}
          variant="outline"
          className="text-red-600 hover:text-red-700"
        >
          <AlertCircle className="w-4 h-4 mr-2" />
          Cancel
        </Button>
      );
    }
    
    return buttons;
  };

  return (
    <>
      <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="w-screen h-screen sm:w-[95vw] sm:max-w-4xl sm:h-[95vh] sm:max-h-[95vh] sm:rounded-lg overflow-hidden p-0 flex flex-col">
        <DialogHeader className="p-3 sm:p-6 border-b border-gray-200 flex-shrink-0">
          <DialogTitle className="flex items-center space-x-2 text-lg sm:text-xl">
            <FileText className="w-5 h-5" />
            <span>Work Order Details</span>
          </DialogTitle>
        </DialogHeader>

        {/* Status Banner - Only for Completed */}
        {workOrder.status === 'work_completed' && (
          <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4 sm:p-6 flex-shrink-0 border-b">
            <div className="flex items-center justify-center space-x-3">
              <CheckCircle className="w-8 h-8 flex-shrink-0" />
              <div className="text-center">
                <h3 className="text-xl sm:text-2xl font-bold">✅ WORK COMPLETED</h3>
                <p className="text-green-100 text-sm sm:text-base mt-1">
                  Work order finished • Ready for invoicing
                </p>
              </div>
              <CheckCircle className="w-8 h-8 flex-shrink-0" />
            </div>
          </div>
        )}

        <InlineEditProvider>
        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-6">

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity" data-testid="tab-activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="activity" className="mt-6">
            <ActivityTab resource="work-orders" id={workOrder?.id} />
          </TabsContent>

          <TabsContent value="overview" className="space-y-6 mt-6">
            {/* Header Status Bar */}
            <div className="flex items-center justify-between bg-gray-50 p-4 rounded-lg">
              <div className="flex items-center gap-3">
                {getStatusBadge(workOrder.status)}
                {isBilledWorkOrder && workOrder.status !== 'billed' && (
                  <Badge className="bg-purple-100 text-purple-800 border-purple-200">Billed</Badge>
                )}
                <div className="flex items-center gap-2">
                  {getPriorityBadge(fv("priority", workOrder.priority ?? ""), true)}
                </div>
                {workOrder.estimateId && (
                  <Badge className="bg-green-100 text-green-800 border-green-200">
                    From estimate #{workOrder.estimateId}
                  </Badge>
                )}
                {(workOrder as any).originWetCheckId != null && (
                  <a
                    href={`/wet-checks/${(workOrder as any).originWetCheckId}/review`}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-teal-100 text-teal-800 border border-teal-200 hover:bg-teal-200 transition-colors"
                    data-testid="wo-from-wet-check-banner"
                  >
                    <LinkIcon className="w-3 h-3" />
                    From Wet Check #{(workOrder as any).originWetCheckId}
                  </a>
                )}
                {/* Task #1935 — follow-up WO lineage links */}
                {(workOrder as any).parentWorkOrderLink != null && (
                  <a
                    href={`/work-orders/${(workOrder as any).parentWorkOrderLink.id}`}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200 transition-colors"
                    data-testid="wo-parent-wo-banner"
                  >
                    <LinkIcon className="w-3 h-3" />
                    Follow-up for {(workOrder as any).parentWorkOrderLink.workOrderNumber}
                  </a>
                )}
                {(workOrder as any).followUpWorkOrderLink != null && (
                  <a
                    href={`/work-orders/${(workOrder as any).followUpWorkOrderLink.id}`}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200 transition-colors"
                    data-testid="wo-follow-up-wo-banner"
                  >
                    <LinkIcon className="w-3 h-3" />
                    Has follow-up: {(workOrder as any).followUpWorkOrderLink.workOrderNumber}
                  </a>
                )}
                {workOrder.noPhotosNeeded && (
                  <div className="flex items-center gap-2" data-testid="no-photos-needed-banner">
                    <Badge className="bg-gray-200 text-gray-800 border-gray-300">
                      No Photos Needed
                      {workOrder.noPhotosNeededAt && (
                        <span className="ml-1 font-normal">
                          (marked by {noPhotosNeededByName || `user #${workOrder.noPhotosNeededBy}`} on{' '}
                          {new Date(workOrder.noPhotosNeededAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})
                        </span>
                      )}
                    </Badge>
                    {canManageNoPhotosNeeded && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => clearNoPhotosNeeded.mutate()}
                        disabled={clearNoPhotosNeeded.isPending}
                        className="h-6 px-2 text-xs"
                        data-testid="undo-no-photos-needed"
                      >
                        {clearNoPhotosNeeded.isPending ? "Undoing…" : "Undo"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                {canEditPhotos && workOrder.status !== 'cancelled' && !isBilledWorkOrder && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowEditModal(true)}
                    className="text-blue-600 hover:text-blue-700"
                  >
                    <Edit className="w-4 h-4 mr-1" />
                    Edit
                  </Button>
                )}
                {getStatusActions()}
              </div>
            </div>

            {/* Billed Banner */}
            {isBilledWorkOrder && (
              <BilledIndicator
                invoiceId={workOrder.invoiceId}
                billedAt={workOrder.billedAt}
              />
            )}

            {/* Approval signature — present when this WO originated from an
                estimate the customer signed online (Task #1500). The seven
                approvalSignature* fields are read-through from the estimate
                by GET /api/work-orders/:id and merged into the WO payload. */}
            {(workOrder as any).approvalSignatureData && (
              <ApprovalSignatureBlock
                approvalSignatureType={(workOrder as any).approvalSignatureType}
                approvalSignatureData={(workOrder as any).approvalSignatureData}
                approvalSignerName={(workOrder as any).approvalSignerName}
                approvalSignedAt={(workOrder as any).approvalSignedAt}
                approvalSignerIp={(workOrder as any).approvalSignerIp}
                approvalConsentText={(workOrder as any).approvalConsentText}
                approvalConsentAcceptedAt={(workOrder as any).approvalConsentAcceptedAt}
              />
            )}

            {/* Main Content Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Work Order Information */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center space-x-2">
                    <FileText className="w-5 h-5" />
                    <span>Work Order Information</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <span className="font-medium text-gray-700">Work Order Number:</span>
                    <p className="text-lg font-semibold text-gray-900">{workOrder.workOrderNumber}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Project Name:</span>
                    <p className="text-gray-900">{workOrder.projectName}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Status:</span>
                    <div className="mt-1 flex items-center gap-2">
                      {getStatusBadge(workOrder.status)}
                      {isBilledWorkOrder && workOrder.status !== 'billed' && (
                        <Badge className="bg-purple-100 text-purple-800 border-purple-200">Billed</Badge>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Priority:</span>
                    <div className="mt-1">
                      <EditableField
                        fieldId="priority"
                        value={fv("priority", workOrder.priority ?? "")}
                        onSave={async (v) => patchWOField("priority", v, { priority: v })}
                        canEdit={canInlineEditWO}
                        type="select"
                        options={[
                          { value: "low", label: "Low Priority" },
                          { value: "medium", label: "Standard" },
                          { value: "high", label: "High Priority" },
                          { value: "urgent", label: "Emergency" },
                        ]}
                      >
                        {getPriorityBadge(fv("priority", workOrder.priority ?? ""), true)}
                      </EditableField>
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Scheduled Date:</span>
                    <EditableField
                      fieldId="scheduledDate"
                      value={toDateInput(fv("scheduledDate", workOrder.scheduledDate as string | null))}
                      onSave={async (v) => patchWOField("scheduledDate", v, { scheduledDate: v })}
                      canEdit={canInlineEditWO}
                      type="date"
                    >
                      <p className="text-gray-900">
                        {formatDate(fv("scheduledDate", workOrder.scheduledDate as string | null) || workOrder.scheduledDate)}
                      </p>
                    </EditableField>
                  </div>
                </CardContent>
              </Card>

              {/* Customer Information */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center space-x-2">
                    <Users className="w-5 h-5" />
                    <span>Customer Information</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <span className="font-medium text-gray-700">Customer Name:</span>
                    <p className="text-gray-900">{workOrder.customerName}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Email:</span>
                    <p className="text-gray-900">{workOrder.customerEmail}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Phone:</span>
                    <p className="text-gray-900">{workOrder.customerPhone || 'Not provided'}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Project Address:</span>
                    {(() => {
                      const displayAddress =
                        workOrder.workLocationAddress || workOrder.projectAddress;
                      const mapsUrl = buildMapsUrl({
                        lat: workOrder.workLocationLat,
                        lng: workOrder.workLocationLng,
                        address: displayAddress,
                        label:
                          displayAddress || workOrder.customerName,
                      });
                      const hasLocation =
                        workOrder.workLocationLat != null || !!displayAddress;
                      return (
                        <div className="mt-1 flex flex-wrap items-start gap-2">
                          <p className="text-gray-900 flex-1 min-w-0">
                            {displayAddress || 'Not provided'}
                          </p>
                          {hasLocation && mapsUrl && (
                            <a
                              href={mapsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 underline"
                              data-testid="link-get-directions"
                            >
                              <Navigation className="w-3.5 h-3.5" />
                              Get directions
                            </a>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {(workOrder.controllerLetter || workOrder.zoneNumber != null) && (
                    <div data-testid="text-clock-zone-customer-info">
                      <span className="font-medium text-gray-700">Clock / Zone:</span>
                      <p className="text-gray-900">
                        {[
                          workOrder.controllerLetter ? `Clock ${workOrder.controllerLetter}` : null,
                          workOrder.zoneNumber != null ? `Zone ${workOrder.zoneNumber}` : null,
                        ].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Pinned Work Location & Controller/Zone (Task #344) */}
            {(() => {
              const lat =
                workOrder.workLocationLat != null
                  ? parseFloat(String(workOrder.workLocationLat))
                  : NaN;
              const lng =
                workOrder.workLocationLng != null
                  ? parseFloat(String(workOrder.workLocationLng))
                  : NaN;
              const hasPin = Number.isFinite(lat) && Number.isFinite(lng);
              const hasControllerZone =
                !!workOrder.controllerLetter || workOrder.zoneNumber != null;
              if (!hasPin && !hasControllerZone) return null;
              const cardTitle = hasPin
                ? "Pinned Work Location"
                : "Location & Controller/Zone";
              const mapsUrl = hasPin
                ? buildMapsUrl({
                    lat: workOrder.workLocationLat,
                    lng: workOrder.workLocationLng,
                    address:
                      workOrder.workLocationAddress ||
                      workOrder.projectAddress ||
                      undefined,
                    label:
                      workOrder.workLocationAddress ||
                      workOrder.projectAddress ||
                      workOrder.customerName ||
                      undefined,
                  })
                : null;
              return (
                <Card data-testid="card-pinned-location">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <MapPin className="w-5 h-5 text-blue-600" />
                      {cardTitle}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {hasPin && (
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span
                          className="font-mono text-gray-700"
                          data-testid="text-pinned-coords"
                        >
                          {lat.toFixed(6)}, {lng.toFixed(6)}
                        </span>
                        {mapsUrl && (
                          <a
                            href={mapsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 underline"
                            data-testid="link-view-pin-on-map"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            View on map
                          </a>
                        )}
                      </div>
                    )}
                    {(workOrder.controllerLetter || workOrder.zoneNumber != null) && (
                      <div
                        className="flex items-center gap-1.5 text-sm"
                        data-testid="text-controller-zone"
                      >
                        <Cpu className="w-4 h-4 text-blue-600 flex-shrink-0" />
                        <span className="text-gray-900 font-medium">
                          {[
                            workOrder.controllerLetter ? `Clock ${workOrder.controllerLetter}` : null,
                            workOrder.zoneNumber != null ? `Zone ${workOrder.zoneNumber}` : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                    )}
                    {hasPin && (
                      <div className="rounded-lg overflow-hidden border border-gray-200">
                        <iframe
                          title="Pinned work location"
                          width="100%"
                          height="220"
                          loading="lazy"
                          referrerPolicy="no-referrer-when-downgrade"
                          src={`https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.003}%2C${lat - 0.002}%2C${lng + 0.003}%2C${lat + 0.002}&layer=mapnik&marker=${lat}%2C${lng}`}
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            {/* Assignment and Progress Details */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Assignment & Progress Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-blue-50 p-4 rounded-lg">
                    <div className="flex items-center space-x-2">
                      <User className="w-5 h-5 text-blue-600" />
                      <span className="font-medium text-blue-900">Assigned Technician</span>
                    </div>
                    <p className="text-lg font-bold text-blue-900 mt-1">
                      {workOrder.assignedTechnicianName || 'Unassigned'}
                    </p>
                  </div>
                  
                  <div className="bg-green-50 p-4 rounded-lg">
                    <div className="flex items-center space-x-2">
                      <Calendar className="w-5 h-5 text-green-600" />
                      <span className="font-medium text-green-900">Started</span>
                    </div>
                    <p className="text-lg font-bold text-green-900 mt-1">
                      {workOrder.startedAt ? formatDate(workOrder.startedAt) : 'Not started'}
                    </p>
                  </div>

                  <div className="bg-purple-50 p-4 rounded-lg">
                    <div className="flex items-center space-x-2">
                      <Target className="w-5 h-5 text-purple-600" />
                      <span className="font-medium text-purple-900">Status</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      {getStatusBadge(workOrder.status)}
                      {isBilledWorkOrder && workOrder.status !== 'billed' && (
                        <Badge className="bg-purple-100 text-purple-800 border-purple-200">Billed</Badge>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Work Plan Details */}
            {workOrder.estimateId && (
              <>
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Activity className="w-5 h-5 text-blue-600" />
                      Work Plan Details
                    </CardTitle>
                    <p className="text-sm text-gray-600">
                      Based on Estimate #{workOrder.estimateId}
                    </p>
                  </CardHeader>
                </Card>

                {isInspectionOriginWorkOrder(workOrder, workOrderItems as any[]) ? (
                  <InspectionZoneChecklist
                    workOrder={workOrder}
                    readOnly={isBilledWorkOrder || workOrder.status === 'completed'}
                    onComplete={
                      !isBilledWorkOrder && workOrder.status === 'in_progress'
                        ? () => setShowCompletionForm(true)
                        : undefined
                    }
                  />
                ) : Array.isArray(workOrderItems) && workOrderItems.length > 0 ? (
                  <Card className="border-l-4 border-l-blue-500">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base flex items-center gap-2">
                          <Wrench className="w-4 h-4 text-blue-600" />
                          Line Items
                        </CardTitle>
                        <Badge variant="outline" className="text-xs">
                          {workOrderItems.length} item{workOrderItems.length !== 1 ? 's' : ''}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 mb-3">
                          <Package className="w-4 h-4 text-gray-600" />
                          <span className="font-medium text-gray-700">Parts & Materials:</span>
                        </div>

                        {workOrderItems.map((item: any) => (
                          <div key={item.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                            <div className="flex-1">
                              <p className="font-medium text-gray-900">{item.partName}</p>
                              {item.description && (
                                <p className="text-sm text-gray-600 mt-0.5">{item.description}</p>
                              )}
                              <div className="flex items-center gap-4 mt-1 text-sm text-gray-600">
                                <span>Qty: {item.quantity}</span>
                                <span>Labor: {item.laborHours}h</span>
                                <span>Total: ${item.totalPrice}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="p-8 text-center">
                      <List className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                      <p className="text-gray-600">Loading work plan details...</p>
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {/* Timeline */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Timer className="w-5 h-5 text-blue-600" />
                  Timeline
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                    <div>
                      <p className="font-medium text-gray-900">Work Order Created</p>
                      <p className="text-sm text-gray-600">{formatDate(workOrder.createdAt)}</p>
                    </div>
                  </div>
                  
                  {workOrder.startedAt && (
                    <div className="flex items-center gap-4">
                      <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
                      <div>
                        <p className="font-medium text-gray-900">Work Started</p>
                        <p className="text-sm text-gray-600">{formatDate(workOrder.startedAt)}</p>
                      </div>
                    </div>
                  )}
                  
                  {workOrder.completedAt && (
                    <div className="flex items-center gap-4">
                      <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                      <div>
                        <p className="font-medium text-gray-900">
                          Completed by {workOrder.completedByUserName || 'Unknown'} on {formatDate(workOrder.completedAt)}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Reassignment Section - Show for managers/admins, not field technicians, not billed, not cancelled.
                Admin roles (company_admin, super_admin) can reassign up to the point of billing, including
                work_completed and pending_manager_review states. Non-admin roles retain the original
                restriction of not being able to reassign once work_completed. */}
            {!isBilledWorkOrder && fieldTechs && fieldTechs.length > 0 && currentUser?.role !== 'field_tech' && workOrder.status !== 'cancelled' && (() => {
              const isAdminRole = currentUser?.role === 'company_admin' || currentUser?.role === 'super_admin';
              if (!isAdminRole && workOrder.status === 'work_completed') return null;
              const managers = fieldTechs.filter(u => u.role === 'irrigation_manager');
              const techs = fieldTechs.filter(u => u.role === 'field_tech');
              return (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Users className="w-5 h-5 text-blue-600" />
                      Assign Work Order
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-gray-600">
                      Current assignment: <span className="font-medium">{workOrder.assignedTechnicianName || "Unassigned"}</span>. 
                      Select a person to reassign this work order.
                    </p>
                    <div className="flex gap-3">
                      <Select 
                        value={selectedTechnicianId} 
                        onValueChange={setSelectedTechnicianId}
                      >
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder="Choose a person..." />
                        </SelectTrigger>
                        <SelectContent>
                          {currentUser?.id && (
                            <SelectItem value={currentUser.id.toString()}>
                              Assign to Me
                            </SelectItem>
                          )}
                          {managers.length > 0 && (
                            <>
                              <div className="px-2 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider border-t mt-1 pt-1">Managers</div>
                              {managers.map((user) => (
                                <SelectItem key={user.id} value={user.id.toString()}>
                                  {user.name}
                                </SelectItem>
                              ))}
                            </>
                          )}
                          {techs.length > 0 && (
                            <>
                              <div className="px-2 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider border-t mt-1 pt-1">Field Techs</div>
                              {techs.map((user) => (
                                <SelectItem key={user.id} value={user.id.toString()}>
                                  {user.name}
                                </SelectItem>
                              ))}
                            </>
                          )}
                        </SelectContent>
                      </Select>
                      <Button 
                        onClick={() => {
                          if (selectedTechnicianId) {
                            setPendingTechnicianId(selectedTechnicianId);
                            setShowAssignmentConfirmation(true);
                          }
                        }}
                        disabled={!selectedTechnicianId || reassignWorkOrder.isPending}
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        Assign
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            {/* Photos section - editable for managers/admins */}
            {(( workOrder.photos && Array.isArray(workOrder.photos) && workOrder.photos.length > 0) || canEditPhotos) && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Camera className="w-5 h-5 text-blue-600" />
                    Photos {workOrder.photos && Array.isArray(workOrder.photos) && workOrder.photos.length > 0 ? `(${workOrder.photos.length})` : ''}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {(isBilledWorkOrder || workOrder.status === 'approved_passed_to_billing') && workOrder.status !== 'cancelled' && canEditPhotos && (
                    <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                      This ticket is locked, but you can still add or remove photos.
                    </div>
                  )}
                  {canEditPhotos && workOrder.status !== 'cancelled' && (
                    <FileUpload
                      type="photo"
                      label="Photos"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      multiple
                      // Existing photos are rendered in the grid below; pass an empty
                      // list here so FileUpload only handles the upload + progress UI
                      // (and emits its own success toast on completion).
                      files={[]}
                      onFilesChange={(uploaded) => {
                        if (!uploaded.length) return;
                        const newUrls = uploaded.map(f => f.url);
                        // Merge against the freshest known list: persisted photos
                        // from props plus any additions that are still in flight
                        // to the server. This prevents a second back-to-back
                        // upload from overwriting the previous PATCH.
                        const merged = [...woPhotoList, ...inFlightPhotoAdditions, ...newUrls];
                        setInFlightPhotoAdditions(prev => [...prev, ...newUrls]);
                        updatePhotos.mutate(merged);
                      }}
                    />
                  )}
                  {woPhotoList.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-4">No photos yet. Click "Add Photos" to upload.</p>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {woPhotoList.map((url: string, idx: number) => (
                        <div key={idx} className="relative group">
                          <button
                            onClick={() => setLightboxPhoto(url)}
                            className="aspect-square w-full rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <PhotoImage photoUrl={url} alt={`Photo ${idx + 1}`} className="w-full h-full object-cover" variant="thumb" batchManaged signedUrlOverride={getWoPhotoUrl(url)} />
                          </button>
                          {canEditPhotos && workOrder.status !== 'cancelled' && (
                            <button
                              onClick={() => setPhotoToRemove(idx)}
                              disabled={updatePhotos.isPending}
                              className="absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
                              title="Remove photo"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Notes and Instructions */}
            {(workOrder.description || workOrder.specialInstructions || workOrder.notes || canInlineEditWO) && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-blue-600" />
                    Notes & Instructions
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {(workOrder.description || canInlineEditWO) && (
                    <div>
                      <h4 className="font-medium text-gray-900 mb-2">Description</h4>
                      <EditableField
                        fieldId="description"
                        value={fv("description", workOrder.description ?? "")}
                        onSave={async (v) => patchWOField("description", v, { description: v })}
                        canEdit={canInlineEditWO}
                        type="textarea"
                        placeholder="Add a work description…"
                      >
                        <p className="text-gray-700 bg-gray-50 p-3 rounded-lg min-h-[2.5rem] whitespace-pre-wrap">
                          {fv("description", workOrder.description ?? "") || (
                            <span className="text-gray-400 italic">No description</span>
                          )}
                        </p>
                      </EditableField>
                    </div>
                  )}

                  {(workOrder.specialInstructions || canInlineEditWO) && (
                    <div>
                      <h4 className="font-medium text-gray-900 mb-2">Special Instructions</h4>
                      <EditableField
                        fieldId="specialInstructions"
                        value={fv("specialInstructions", workOrder.specialInstructions ?? "")}
                        onSave={async (v) => patchWOField("specialInstructions", v, { specialInstructions: v })}
                        canEdit={canInlineEditWO}
                        type="textarea"
                        placeholder="Add special instructions…"
                      >
                        <p className="text-gray-700 bg-yellow-50 p-3 rounded-lg border border-yellow-200 min-h-[2.5rem] whitespace-pre-wrap">
                          {fv("specialInstructions", workOrder.specialInstructions ?? "") || (
                            <span className="text-gray-400 italic">No special instructions</span>
                          )}
                        </p>
                      </EditableField>
                    </div>
                  )}

                  {(workOrder.notes || canInlineEditWO) && (
                    <div>
                      <h4 className="font-medium text-gray-900 mb-2">Notes</h4>
                      <EditableField
                        fieldId="notes"
                        value={fv("notes", workOrder.notes ?? "")}
                        onSave={async (v) => patchWOField("notes", v, { notes: v })}
                        canEdit={canInlineEditWO}
                        type="textarea"
                        placeholder="Add internal notes…"
                      >
                        <p className="text-gray-700 bg-blue-50 p-3 rounded-lg border border-blue-200 min-h-[2.5rem] whitespace-pre-wrap">
                          {fv("notes", workOrder.notes ?? "") || (
                            <span className="text-gray-400 italic">No notes</span>
                          )}
                        </p>
                      </EditableField>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Reprice History (Task #212) — managers/admins only.
                 Aligned with the server allowlist (super_admin,
                 company_admin, billing_manager, irrigation_manager) so
                 unauthorized roles never see a stray 403 panel. */}
            {currentUser?.role && [
              'super_admin',
              'company_admin',
              'billing_manager',
              'irrigation_manager',
            ].includes(currentUser.role) && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <History className="w-5 h-5 text-blue-600" />
                    Reprice History
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <PricingAuditHistory source="work_order" parentId={workOrder.id} />
                </CardContent>
              </Card>
            )}

            {/* Completion Details — shown for all post-completion statuses */}
            {(['work_completed', 'pending_manager_review', 'approved_passed_to_billing'] as string[]).includes(workOrder.status) && (() => {
              const showPricing = currentUser?.role !== 'field_tech';
              const items = (workOrderItems as any[]) || [];
              const completedItems = items.filter((item: any) => item.actualQuantityUsed != null || item.partPrice != null);
              const photos: string[] = workOrder.photos || [];
              const laborRate = parseFloat(workOrder.laborRate || '0');
              const totalHours = parseFloat(workOrder.totalHours || '0');
              const laborSubtotal = parseFloat((workOrder as any).laborSubtotal || String(laborRate * totalHours));
              const partsCost = parseFloat((workOrder as any).totalPartsCost || '0');
              const total = laborSubtotal + partsCost;

              return (
                <Card className="border-green-200 bg-green-50/30">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2 text-green-800">
                      <CheckCircle className="w-5 h-5 text-green-600" />
                      Completion Details
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-5">

                    {/* Completion Summary Row */}
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      {workOrder.completedAt && (
                        <div>
                          <p className="text-gray-500 font-medium mb-1">Completed On</p>
                          <p className="text-gray-900">
                            {new Date(workOrder.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                        </div>
                      )}
                      {workOrder.completedByUserName && (
                        <div>
                          <p className="text-gray-500 font-medium mb-1">Completed By</p>
                          <p className="text-gray-900">{workOrder.completedByUserName}</p>
                        </div>
                      )}
                      {totalHours > 0 && (
                        <div>
                          <p className="text-gray-500 font-medium mb-1">Total Hours</p>
                          <p className="text-gray-900">{totalHours.toFixed(2)} hrs</p>
                        </div>
                      )}
                    </div>

                    {/* Work Summary */}
                    {workOrder.workSummary && (
                      <div>
                        <p className="text-sm font-medium text-gray-700 mb-1">Work Summary</p>
                        <p className="text-sm text-gray-700 bg-white border border-green-200 p-3 rounded-lg">{workOrder.workSummary}</p>
                      </div>
                    )}

                    {/* Customer Notes */}
                    {workOrder.customerNotes && (
                      <div>
                        <p className="text-sm font-medium text-gray-700 mb-1">Customer Notes</p>
                        <p className="text-sm text-gray-700 bg-white border border-green-200 p-3 rounded-lg">{workOrder.customerNotes}</p>
                      </div>
                    )}

                    {/* Parts Used Table */}
                    {completedItems.length > 0 && (
                      <div>
                        <p className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
                          <Package className="w-4 h-4" /> Parts Used
                        </p>
                        <div className="rounded-lg border border-green-200 overflow-hidden bg-white">
                          <table className="w-full text-sm">
                            <thead className="bg-green-50 text-green-800">
                              <tr>
                                <th className="text-left p-2 font-medium">Part</th>
                                <th className="text-right p-2 font-medium">Qty</th>
                                <th className="text-right p-2 font-medium">Labor Hrs</th>
                                {showPricing && <th className="text-right p-2 font-medium">Unit Price</th>}
                                {showPricing && <th className="text-right p-2 font-medium">Total</th>}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-green-100">
                              {completedItems.map((item: any, idx: number) => {
                                const qty = item.actualQuantityUsed ?? item.quantity ?? 0;
                                const price = parseFloat(item.partPrice || '0');
                                const lineTotal = price * qty;
                                return (
                                  <tr key={idx} className="hover:bg-green-50/50">
                                    <td className="p-2">
                                      <p className="font-medium text-gray-900">{item.partName}</p>
                                      {item.partDescription && <p className="text-xs text-gray-500">{item.partDescription}</p>}
                                    </td>
                                    <td className="p-2 text-right text-gray-700">{qty}</td>
                                    <td className="p-2 text-right text-gray-700">{item.actualLaborHours ? parseFloat(item.actualLaborHours).toFixed(2) : '—'}</td>
                                    {showPricing && <td className="p-2 text-right text-gray-700">${price.toFixed(2)}</td>}
                                    {showPricing && <td className="p-2 text-right font-medium text-gray-900">${lineTotal.toFixed(2)}</td>}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Financial Summary */}
                    {showPricing && (totalHours > 0 || partsCost > 0) && (
                      <div className="border-t border-green-200 pt-4">
                        <p className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
                          <DollarSign className="w-4 h-4" /> Financial Summary
                        </p>
                        <div className="bg-white border border-green-200 rounded-lg p-3 space-y-2 text-sm">
                          {totalHours > 0 && (
                            <div className="flex justify-between text-gray-700">
                              <span>Labor ({totalHours.toFixed(2)} hrs × ${laborRate.toFixed(2)}/hr)</span>
                              <span>${laborSubtotal.toFixed(2)}</span>
                            </div>
                          )}
                          {partsCost > 0 && (
                            <div className="flex justify-between text-gray-700">
                              <span>Parts</span>
                              <span>${partsCost.toFixed(2)}</span>
                            </div>
                          )}
                          <div className="flex justify-between font-bold text-gray-900 border-t border-green-200 pt-2 text-base">
                            <span>Total</span>
                            <span className="text-green-700">${total.toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                    )}

                  </CardContent>
                </Card>
              );
            })()}

            {/* Lightbox */}
            {lightboxPhoto && (
              <Dialog open={!!lightboxPhoto} onOpenChange={() => setLightboxPhoto(null)}>
                <DialogContent className="max-w-3xl p-2 bg-black border-0">
                  <PhotoImage photoUrl={lightboxPhoto} alt="Full size" className="w-full h-auto max-h-[85vh] object-contain rounded" variant="medium" batchManaged signedUrlOverride={getWoMediumUrl(lightboxPhoto)} />
                </DialogContent>
              </Dialog>
            )}
          </TabsContent>
        </Tabs>

        </div>
        {/* Action Buttons - Bottom Section */}
        {/* Start Work Order button - for pending/assigned work orders */}
        {!isBilledWorkOrder && (workOrder.status === 'pending' || workOrder.status === 'assigned') && (
          <div className="border-t border-gray-200 p-4 sm:p-6 bg-gray-50">
            <div className="flex justify-center">
              <Button
                onClick={() => {
                  // Use callback if provided, otherwise fall back to internal state
                  if (onStartWork) {
                    onClose();
                    onStartWork(workOrder);
                  } else {
                    setShowCompletionForm(true);
                  }
                }}
                className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 text-lg font-semibold"
                size="lg"
              >
                <Play className="w-5 h-5 mr-2" />
                Start Work Order
              </Button>
            </div>
          </div>
        )}
        
        {!isBilledWorkOrder && workOrder.status === 'in_progress' && (
          <div className="border-t border-gray-200 p-4 sm:p-6 bg-gray-50">
            <div className="flex justify-center">
              <Button
                onClick={() => setShowCompletionForm(true)}
                className="bg-green-600 hover:bg-green-700 text-white px-8 py-3 text-lg font-semibold"
                size="lg"
              >
                <CheckCircle className="w-5 h-5 mr-2" />
                Complete Work Order
              </Button>
            </div>
          </div>
        )}
        {/* Approval action row — only when opened from Manager Workspace */}
        {onApproveSuccess && (
          <WOApprovalActionRow
            workOrderId={workOrder.id}
            isLocked={workOrder.status === 'billed' || workOrder.invoiceId != null}
            onClose={onClose}
            onSuccess={onApproveSuccess}
          />
        )}

        </InlineEditProvider>

      </DialogContent>
    </Dialog>

    {/* Work Order Completion Modal */}
    {showCompletionForm && (
      <WorkOrderCompletion
        workOrder={workOrder}
        open={showCompletionForm}
        onClose={() => setShowCompletionForm(false)}
        onComplete={onUpdate}
      />
    )}

    {/* Photo Remove Confirmation */}
    <Dialog open={photoToRemove !== null} onOpenChange={() => setPhotoToRemove(null)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove Photo</DialogTitle>
          <DialogDescription>
            Are you sure you want to remove this photo? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={() => setPhotoToRemove(null)}>Cancel</Button>
          <Button variant="destructive" onClick={handleConfirmRemovePhoto} disabled={updatePhotos.isPending}>
            Remove
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    {/* Assignment Confirmation Modal */}
    <AssignmentConfirmationModal
      isOpen={showAssignmentConfirmation}
      onClose={() => {
        setShowAssignmentConfirmation(false);
        setPendingTechnicianId("");
      }}
      onConfirm={() => {
        if (pendingTechnicianId) {
          reassignWorkOrder.mutate(pendingTechnicianId);
          setShowAssignmentConfirmation(false);
          setSelectedTechnicianId("");
          setPendingTechnicianId("");
        }
      }}
      workOrder={workOrder}
      selectedTechnician={fieldTechs?.find(tech => tech.id.toString() === pendingTechnicianId) || null}
      isLoading={reassignWorkOrder.isPending}
    />

    {/* Edit Work Order Wizard (opens on Step 2 — Work Location & Site) */}
    {showEditModal && (
      <WorkOrderWizard
        open={showEditModal}
        workOrderId={workOrder.id}
        onClose={() => setShowEditModal(false)}
        onCreated={onUpdate}
      />
    )}
    </>
  );
}