import { safeGet } from "@/utils/safeStorage";
import { useState, useRef, useEffect, useContext } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  MapPin,
  User,
  Calendar,
  Clock,
  Package,
  Camera,
  FileText,
  X,
  CheckCircle,
  CheckCircle2,
  DollarSign,
  ChevronLeft,
  ChevronRight,
  Hash,
  Edit,
  Plus,
  Upload,
  Trash2,
  Info,
  Save,
  Loader2,
  BookOpen,
  MessageSquare,
} from "lucide-react";
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
import type { WorkOrder, BillingSheet, WorkOrderItem, BillingSheetItem, Customer } from "@workspace/db/schema";
import { WetCheckBillingViewComponent, type WetCheckBillingView } from "@/components/billing/wet-check-billing-view";
import { canEditWetCheckBillingFields } from "@/components/wet-check-billings/wet-check-billing-permissions";
import {
  InspectionZoneChecklist,
  isInspectionOriginWorkOrder,
} from "@/components/work-orders/inspection-zone-checklist";
import { EditableField, InlineEditProvider, InlineEditContext } from "@/components/ui/editable-field";
import { format } from "date-fns";
import { PhotoImage, usePhotoSignedUrls } from "@/components/ui/photo-image";
import { apiRequest, parseApiError, useArrayQuery } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { preparePhotoForUpload } from "@/lib/photo-prep";
import { PricingAuditHistory } from "@/components/billing/pricing-audit-history";
import { ApprovalSignatureBlock } from "@/components/estimates/approval-signature-block";
import { History, Cpu, Droplets, Navigation } from "lucide-react";
import { buildMapsUrl } from "@/lib/maps-url";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RateModeToggle } from "@/components/billing-workspace/rate-mode-toggle";
import { PartPicker } from "@/components/parts/part-picker";
import type { Part } from "@workspace/db/schema";

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const saved = safeGet("user");
    if (saved) {
      const user = JSON.parse(saved);
      if (user?.role) {
        headers["x-user-role"] = user.role;
        headers["x-user-id"] = user.id?.toString() || "";
        headers["x-user-name"] = user.name || "";
        headers["x-user-company-id"] = user.companyId?.toString() || "";
      }
    }
  } catch {
    // ignore
  }
  return headers;
}

// `preparePhotoForUpload` lives in `@/lib/photo-prep` so the same single-pass
// display-copy prep is shared with the work-order upload path.

interface CompletedWorkDetailModalProps {
  type: "work_order" | "billing_sheet";
  id: number;
  data: WorkOrder | BillingSheet;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showPricing?: boolean;
  onApproveSuccess?: () => void;
  onSaved?: () => void;
}

const fmt = (date: string | Date | null | undefined) => {
  if (!date) return "—";
  try {
    return format(new Date(date), "MMM d, yyyy");
  } catch {
    return "—";
  }
};

const fmtDateTime = (date: string | Date | null | undefined) => {
  if (!date) return "—";
  try {
    return format(new Date(date), "MMM d, yyyy h:mm a");
  } catch {
    return "—";
  }
};

const currency = (val: number | string | null | undefined) => {
  const n = typeof val === "string" ? parseFloat(val) : (val ?? 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
};

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  assigned: "bg-blue-100 text-blue-800",
  in_progress: "bg-blue-100 text-blue-800",
  work_completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  draft: "bg-gray-100 text-gray-700",
  submitted: "bg-yellow-100 text-yellow-800",
  pending_manager_review: "bg-orange-100 text-orange-800",
  approved_passed_to_billing: "bg-teal-100 text-teal-800",
  billed: "bg-purple-100 text-purple-800",
};

const statusLabels: Record<string, string> = {
  pending_manager_review: "Pending Manager Review",
  approved_passed_to_billing: "Approved / Passed to Billing",
  in_progress: "In Progress",
};

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-sm text-gray-900 leading-snug">{value}</p>
    </div>
  );
}

function SectionCard({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-100">
        <span className="text-gray-500">{icon}</span>
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Parts List Editor ────────────────────────────────────────────────────────
interface PartsEditorRow {
  partId: number | null;
  partName: string;
  quantity: string;
  unitPrice: string;
  laborHours: string;
  notes: string;
}

export function PartsListEditorDialog({
  open,
  onOpenChange,
  type,
  id,
  initialItems,
  canSeePricing,
  readOnly = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: "work_order" | "billing_sheet";
  id: number;
  initialItems: (WorkOrderItem | BillingSheetItem)[];
  canSeePricing: boolean;
  readOnly?: boolean;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const toEditorRows = (items: (WorkOrderItem | BillingSheetItem)[]): PartsEditorRow[] =>
    items.map((item) => ({
      partId: (item as any).partId ?? null,
      partName: item.partName ?? "",
      quantity: String((item as BillingSheetItem).quantity ?? (item as WorkOrderItem).quantity ?? "1"),
      unitPrice: String(
        (item as BillingSheetItem).unitPrice ?? (item as WorkOrderItem).partPrice ?? "0"
      ),
      laborHours: String((item as any).laborHours ?? "0"),
      notes: String((item as any).notes ?? ""),
    }));

  const [rows, setRows] = useState<PartsEditorRow[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(toEditorRows(initialItems));
  }, [open]);

  // Add from library — reads the part's real `price` (the price-fill bug fix:
  // the catalog row's price field is `price`, not `unitPrice`). Merges quantity
  // when the same catalog part is added again.
  const handleSelectFromLibrary = (part: Part, qty?: number) => {
    setRows((prev) => {
      const existingIdx = prev.findIndex((r) => r.partId === part.id);
      if (existingIdx >= 0) {
        return prev.map((r, i) =>
          i === existingIdx
            ? { ...r, quantity: String((parseFloat(r.quantity) || 0) + (qty || 1)) }
            : r,
        );
      }
      return [
        ...prev,
        {
          partId: part.id,
          partName: part.name,
          quantity: String(qty || 1),
          unitPrice: String(parseFloat(part.price ?? "0") || 0),
          laborHours: "0",
          notes: "",
        },
      ];
    });
  };

  const updateRow = (idx: number, updates: Partial<PartsEditorRow>) => {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...updates };
      return next;
    });
  };

  const addCustomLine = () =>
    setRows((prev) => [
      ...prev,
      { partId: null, partName: "", quantity: "1", unitPrice: "0", laborHours: "0", notes: "" },
    ]);

  const removeRow = (idx: number) =>
    setRows((prev) => prev.filter((_, i) => i !== idx));

  // ── Live totals (display-only — server recomputes authoritatively on save) ──
  const partsSubtotal = rows.reduce(
    (sum, r) => sum + (parseFloat(r.quantity) || 0) * (parseFloat(r.unitPrice) || 0),
    0,
  );
  const laborTotal = rows.reduce((sum, r) => sum + (parseFloat(r.laborHours) || 0), 0);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const validRows = rows.filter((r) => r.partName.trim());
      const items = validRows.map((r) => ({
        ...(r.partId != null ? { partId: r.partId } : {}),
        partName: r.partName.trim(),
        quantity: Math.max(0, parseFloat(r.quantity) || 0),
        unitPrice: Math.max(0, parseFloat(r.unitPrice) || 0),
        laborHours: Math.max(0, parseFloat(r.laborHours) || 0),
        ...(r.notes.trim() ? { notes: r.notes.trim() } : {}),
      }));
      const endpoint =
        type === "work_order"
          ? `/api/work-orders/${id}/items`
          : `/api/billing-sheets/${id}/items`;
      return apiRequest(endpoint, "PATCH", { items });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [type === "work_order" ? "/api/work-orders" : "/api/billing-sheets", id, "items"],
      });
      queryClient.invalidateQueries({
        queryKey: [type === "work_order" ? "/api/work-orders" : "/api/billing-sheets"],
      });
      toast({ title: "Parts saved", description: "Parts list updated successfully." });
      onOpenChange(false);
      onSaved?.();
    },
    onError: (err: Error) => {
      toast({
        title: "Could not save parts",
        description: parseApiError(err, err.message),
        variant: "destructive",
      });
    },
  });

  const inputCls =
    "flex h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-gray-50 disabled:text-gray-500";

  // Column template: Part · Qty · [Unit $] · Labor h · [Line total] · remove.
  // Pricing columns (Unit $, Line total) are hidden when the caller can't see pricing.
  const gridCols = canSeePricing
    ? "grid-cols-[1fr_56px_84px_64px_84px_32px]"
    : "grid-cols-[1fr_56px_64px_32px]";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5 text-gray-500" />
            Edit Parts List
          </DialogTitle>
        </DialogHeader>

        {readOnly && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>This record has been billed or invoiced — the parts list is read-only.</span>
          </div>
        )}

        <div className="space-y-2 max-h-[50vh] overflow-y-auto py-1 pr-0.5">
          {rows.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-6">
              No parts yet. Use <strong>Add from library</strong> or <strong>Add custom line</strong> below.
            </p>
          )}

          {/* Header row */}
          {rows.length > 0 && (
            <div className={`grid gap-2 text-xs font-medium text-gray-500 px-1 pb-1 ${gridCols}`}>
              <span>Part</span>
              <span className="text-right">Qty</span>
              {canSeePricing && <span className="text-right">Unit $</span>}
              <span className="text-right">Labor h</span>
              {canSeePricing && <span className="text-right">Line total</span>}
              <span />
            </div>
          )}

          {rows.map((row, idx) => {
            const isCatalog = row.partId != null;
            const lineTotal = (parseFloat(row.quantity) || 0) * (parseFloat(row.unitPrice) || 0);
            return (
              <div key={idx} className={`grid gap-2 items-center px-1 ${gridCols}`}>
                {/* Part name + source badge */}
                <div className="min-w-0 flex flex-col gap-1">
                  <span
                    className={`inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      isCatalog
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {isCatalog ? <BookOpen className="w-2.5 h-2.5" /> : null}
                    {isCatalog ? "Catalog" : "Custom"}
                  </span>
                  {isCatalog ? (
                    <span className="truncate text-sm font-medium text-gray-900" title={row.partName}>
                      {row.partName}
                    </span>
                  ) : (
                    <input
                      type="text"
                      value={row.partName}
                      onChange={(e) => updateRow(idx, { partName: e.target.value })}
                      placeholder="Part name"
                      disabled={readOnly}
                      className={`${inputCls} min-w-0`}
                    />
                  )}
                </div>

                {/* Qty */}
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={row.quantity}
                  onChange={(e) => updateRow(idx, { quantity: e.target.value })}
                  disabled={readOnly}
                  className={`${inputCls} text-right`}
                />

                {/* Unit $ */}
                {canSeePricing && (
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                      $
                    </span>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={row.unitPrice}
                      onChange={(e) => updateRow(idx, { unitPrice: e.target.value })}
                      disabled={readOnly}
                      className={`${inputCls} pl-5 text-right`}
                    />
                  </div>
                )}

                {/* Labor hours */}
                <input
                  type="number"
                  min={0}
                  step={0.25}
                  value={row.laborHours}
                  onChange={(e) => updateRow(idx, { laborHours: e.target.value })}
                  disabled={readOnly}
                  className={`${inputCls} text-right`}
                />

                {/* Line total */}
                {canSeePricing && (
                  <span className="text-right text-sm font-medium text-gray-900 tabular-nums">
                    {currency(lineTotal)}
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  disabled={readOnly}
                  className="flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:hover:text-gray-400 disabled:hover:bg-transparent"
                  title="Remove row"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Live totals footer */}
        {rows.length > 0 && (
          <div className="flex items-center justify-end gap-6 pt-2 text-sm border-t border-gray-100">
            <span className="text-gray-500">
              Labor hours:{" "}
              <span className="font-semibold text-gray-900 tabular-nums">{laborTotal.toFixed(2)}</span>
            </span>
            {canSeePricing && (
              <span className="text-gray-500">
                Parts subtotal:{" "}
                <span className="font-semibold text-gray-900 tabular-nums">
                  {currency(partsSubtotal)}
                </span>
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
          {!readOnly && (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => setShowPicker(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                <BookOpen className="w-4 h-4 mr-1.5" />
                Add from library
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={addCustomLine}>
                <Plus className="w-4 h-4 mr-1.5" />
                Add custom line
              </Button>
            </>
          )}
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!readOnly && (
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || rows.every((r) => !r.partName.trim())}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {saveMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1.5" />
              )}
              Save Changes
            </Button>
          )}
        </div>
      </DialogContent>

      <PartPicker
        open={showPicker}
        onOpenChange={setShowPicker}
        onSelectPart={handleSelectFromLibrary}
        selectMode="multi"
        title="Add from Library"
      />
    </Dialog>
  );
}

// ─── Modal Footer (reads InlineEditContext for Save & Close) ──────────────────
function ModalFooter({ title, onClose }: { title: string; onClose: () => void }) {
  const { activeField, triggerSave } = useContext(InlineEditContext);
  const [isSaving, setIsSaving] = useState(false);

  const handleSaveAndClose = async () => {
    setIsSaving(true);
    let ok = false;
    try {
      ok = await triggerSave();
    } finally {
      setIsSaving(false);
    }
    // Only close when the save succeeded. If it failed (validation error or API
    // error), keep the modal open so the inline field error remains visible.
    if (ok) onClose();
  };

  return (
    <div className="flex-shrink-0 border-t border-gray-100 px-5 py-3 bg-gray-50">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Hash className="w-3.5 h-3.5" />
          <span>{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {activeField !== null && (
            <Button
              variant="default"
              size="sm"
              disabled={isSaving}
              onClick={handleSaveAndClose}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {isSaving ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1.5" />
              )}
              Save & Close
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            <X className="w-4 h-4 mr-1.5" />
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Approval Action Row ──────────────────────────────────────────────────────
// Rendered when the modal is opened from the Manager Workspace.
// Must be mounted inside <InlineEditProvider> to access InlineEditContext.
function ApprovalActionRow({
  type,
  id,
  isLocked,
  onSuccess,
  beforeAction,
}: {
  type: "work_order" | "billing_sheet";
  id: number;
  isLocked: boolean;
  onSuccess: () => void;
  beforeAction?: () => Promise<void>;
}) {
  const { toast } = useToast();
  const { triggerSave } = useContext(InlineEditContext);
  const [approving, setApproving] = useState(false);
  const [showReturnInput, setShowReturnInput] = useState(false);
  const [returnNotes, setReturnNotes] = useState("");
  const [returning, setReturning] = useState(false);

  const prefix = type === "billing_sheet" ? "/api/billing-sheets" : "/api/work-orders";

  const doApprove = async () => {
    setApproving(true);
    try {
      if (beforeAction) await beforeAction();
      await apiRequest(`${prefix}/${id}/approve`, "POST", {});
      toast({ title: "Approved", description: "Item approved and passed to billing." });
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
      if (beforeAction) await beforeAction();
      await apiRequest(`${prefix}/${id}/approve`, "POST", {});
      toast({ title: "Saved & Approved", description: "Item saved and passed to billing." });
      onSuccess();
    } catch (err: any) {
      toast({ title: "Save & Approve failed", description: parseApiError(err, "Save & Approve failed"), variant: "destructive" });
    } finally {
      setApproving(false);
    }
  };

  const doReturn = async () => {
    setReturning(true);
    try {
      await apiRequest(`${prefix}/${id}/return-for-correction`, "POST", { notes: returnNotes });
      toast({ title: "Returned for correction", description: "Item returned to technician." });
      onSuccess();
    } catch (err: any) {
      toast({ title: "Return failed", description: parseApiError(err, "Return failed"), variant: "destructive" });
    } finally {
      setReturning(false);
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
            <Button
              size="sm"
              variant="destructive"
              onClick={doReturn}
              disabled={returning}
              data-testid="confirm-return-button"
            >
              {returning && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
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
            onClick={async () => {
              if (beforeAction) await beforeAction();
              await triggerSave();
            }}
            disabled={isLocked || approving}
            data-testid="save-button"
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            Save
          </Button>
          <Button
            size="sm"
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={doApprove}
            disabled={isLocked || approving}
            data-testid="approve-button"
          >
            {approving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
            Approve
          </Button>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={doSaveAndApprove}
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

export function CompletedWorkDetailModal({
  type,
  id,
  data,
  open,
  onOpenChange,
  showPricing,
  onApproveSuccess,
  onSaved,
}: CompletedWorkDetailModalProps) {
  const [lightboxPhoto, setLightboxPhoto] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [photoToRemove, setPhotoToRemove] = useState<number | null>(null);
  const [confirmNoPhotosNeeded, setConfirmNoPhotosNeeded] = useState(false);
  const [showReassignDialog, setShowReassignDialog] = useState(false);
  const [showPartsEditor, setShowPartsEditor] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(() => {
    try { return !!localStorage.getItem("irrigopro:inlineEditHintDismissed"); } catch { return false; }
  });
  const [reassignTechId, setReassignTechId] = useState<string>("");
  const [localTechName, setLocalTechName] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Determine pricing visibility
  const savedUser = safeGet("user");
  const parsedUser = savedUser ? (() => { try { return JSON.parse(savedUser); } catch { return null; } })() : null;
  const userRole = parsedUser?.role ?? "";
  const userId = parsedUser?.id;
  const canSeePricing = showPricing !== undefined ? showPricing : userRole !== "field_tech";
  // Aligned with the server allowlist for the pricing-audit-events endpoints
  // so non-manager roles never see a stray 403 panel.
  const canSeeRepriceHistory = [
    "super_admin",
    "company_admin",
    "billing_manager",
    "irrigation_manager",
  ].includes(userRole);

  const bs = type === "billing_sheet" ? (data as BillingSheet) : null;

  // Optimistic local mirror of the no-photos-needed flag so the modal updates
  // immediately after marking, before the parent's list refetches.
  const [localNoPhotosNeeded, setLocalNoPhotosNeeded] = useState<{
    noPhotosNeeded: boolean;
    noPhotosNeededAt: string | Date | null;
    noPhotosNeededBy: number | null;
  } | null>(null);
  useEffect(() => {
    setLocalNoPhotosNeeded(null);
  }, [id, open]);

  const effectiveNoPhotosNeeded = localNoPhotosNeeded?.noPhotosNeeded ?? !!bs?.noPhotosNeeded;
  const effectiveNoPhotosNeededAt = localNoPhotosNeeded?.noPhotosNeededAt ?? bs?.noPhotosNeededAt ?? null;

  // Same role allowlist as the server endpoint POST /api/billing-sheets/:id/no-photos-needed
  const canMarkNoPhotosNeeded =
    type === "billing_sheet" &&
    [
      "company_admin",
      "super_admin",
      "irrigation_manager",
      "billing_manager",
    ].includes(userRole);

  const noPhotosNeededMutation = useMutation<BillingSheet, Error, void>({
    mutationFn: async () => {
      return apiRequest(`/api/billing-sheets/${id}/no-photos-needed`, "POST");
    },
    onSuccess: (updated) => {
      setLocalNoPhotosNeeded({
        noPhotosNeeded: true,
        noPhotosNeededAt: updated?.noPhotosNeededAt ?? new Date().toISOString(),
        noPhotosNeededBy: updated?.noPhotosNeededBy ?? userId ?? null,
      });
      toast({
        title: "Marked as 'No Photos Needed'",
        description: "This billing sheet no longer needs photos.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/billing-sheets/missing-photos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/billing-sheets"] });
      onSaved?.();
    },
    onError: (err) => {
      toast({
        title: "Could not mark sheet",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Task #765 — Reassign Technician (company_admin / super_admin only).
  // Reset local state whenever the dialog closes or a different sheet opens.
  useEffect(() => {
    if (!showReassignDialog) {
      setReassignTechId("");
    }
  }, [showReassignDialog]);
  useEffect(() => {
    setLocalTechName(null);
  }, [id, open]);

  const isBilledOrInvoiced = !!(data.status === 'billed' || (data as BillingSheet).invoiceId);
  const canReassignTechnician =
    type === "billing_sheet" &&
    (userRole === "company_admin" || userRole === "super_admin");

  // Fetch assignable technicians when the reassign dialog is open (field techs + irrigation managers).
  // Hook must be called unconditionally; filtering happens below after customerForRateCheck is available.
  type TechUser = { id: number; name: string; role: string; companyId: number | null; isActive: boolean };
  const { data: allFieldTechs = [] } = useArrayQuery<TechUser>({
    queryKey: ["/api/users/field-techs"],
    enabled: showReassignDialog,
  });

  const reassignMutation = useMutation<BillingSheet, Error, { technicianId: number }>({
    mutationFn: async ({ technicianId }) => {
      return apiRequest(`/api/billing-sheets/${id}/reassign-technician`, "PATCH", { technicianId });
    },
    onSuccess: (updated) => {
      setLocalTechName(updated.technicianName ?? null);
      toast({ title: "Technician reassigned", description: `Now assigned to ${updated.technicianName}.` });
      setShowReassignDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/billing-sheets"] });
      onSaved?.();
    },
    onError: (err) => {
      toast({ title: "Could not reassign technician", description: parseApiError(err, err.message), variant: "destructive" });
    },
  });

  // Fetch the customer to compare their current labor rate vs stored rate on billing sheet.
  // Also needed to scope the technician list to the right company in the reassign dialog.
  // Also used to supply Normal/Emergency rates to the RateModeToggle for work orders.
  const entityCustomerId = type === "work_order" ? (data as WorkOrder)?.customerId : bs?.customerId;
  const canInlineEditRole = ["billing_manager", "company_admin", "super_admin"].includes(userRole);
  const { data: customerForRateCheck } = useQuery<Customer>({
    queryKey: ["/api/customers", entityCustomerId],
    enabled: open && !!entityCustomerId && (canSeePricing || canReassignTechnician || canInlineEditRole),
  });

  // Detect rate mismatch for billing sheets
  const storedRate = bs ? parseFloat(bs.laborRate || '0') : null;
  const currentCustomerRate = customerForRateCheck ? parseFloat(customerForRateCheck.laborRate || '0') : null;
  const hasRateMismatch = canSeePricing && storedRate !== null && currentCustomerRate !== null && Math.abs(storedRate - currentCustomerRate) > 0.001;

  // Task #765 — filter available techs to the same company as this billing sheet.
  // customerForRateCheck is available here so companyId can be used for filtering.
  const sheetCompanyId = customerForRateCheck?.companyId ?? null;
  const availableTechs = sheetCompanyId != null
    ? allFieldTechs.filter((u) => u.companyId === sheetCompanyId && u.isActive)
    : allFieldTechs.filter((u) => u.isActive);

  // Fetch items
  const itemsEndpoint =
    type === "work_order"
      ? `/api/work-orders/${id}/items`
      : `/api/billing-sheets/${id}/items`;

  const { data: items = [] } = useArrayQuery<WorkOrderItem | BillingSheetItem>({
    queryKey: [type === "work_order" ? "/api/work-orders" : "/api/billing-sheets", id, "items"],
    queryFn: () => fetch(itemsEndpoint).then((r) => r.json()),
    enabled: open && !!id,
  });

  // WC Billing Slice 5 — zone-grouped view for billing sheets backed by a wet check.
  // HTTP 200 → parsed WetCheckBillingView; 422 (not a WC sheet) or any error → null.
  const { data: wetCheckView = null } = useQuery<WetCheckBillingView | null>({
    queryKey: ["/api/billing-sheets", id, "wet-check-view"],
    queryFn: async () => {
      const res = await fetch(`/api/billing-sheets/${id}/wet-check-view`, {
        headers: getAuthHeaders(),
        credentials: "include",
      });
      if (res.status === 422 || !res.ok) return null;
      return res.json() as Promise<WetCheckBillingView>;
    },
    enabled: open && type === "billing_sheet" && !!id,
    staleTime: 60_000,
    retry: false,
  });
  const canEditWetCheckSnapshot = !!wetCheckView?.wetCheckBillingId &&
    canEditWetCheckBillingFields(userRole, {
      status: wetCheckView.wetCheckBillingStatus,
      invoiceId: wetCheckView.wetCheckBillingInvoiceId,
    });

  const isWorkOrder = type === "work_order";
  const wo = isWorkOrder ? (data as WorkOrder) : null;

  const title = isWorkOrder
    ? `Work Order ${wo?.workOrderNumber ?? `#${id}`}`
    : `Billing Sheet ${bs?.billingNumber ?? `#${id}`}`;

  const status = data.status ?? "unknown";
  const customerName = isWorkOrder ? wo?.customerName : bs?.customerName;
  const address = isWorkOrder ? wo?.projectAddress : bs?.propertyAddress;
  const techName = isWorkOrder ? wo?.assignedTechnicianName : (localTechName ?? bs?.technicianName);
  const workDate = isWorkOrder ? wo?.scheduledDate : bs?.workDate;
  const completedDate = isWorkOrder ? wo?.completedAt : null;
  const completedBy = isWorkOrder ? wo?.completedByUserName : null;
  const workDescription = isWorkOrder ? wo?.description : bs?.workDescription;
  const totalHours = isWorkOrder ? wo?.totalHours : bs?.totalHours;
  // Immediately reflect computed totals returned by dedicated WO save endpoints
  // (labor-hours, labor-rate) so the open modal doesn't wait for parent refetch.
  // Declared here (before first use below) to avoid a temporal-dead-zone crash.
  const [localWoTotals, setLocalWoTotals] = useState<{
    laborRate?: string | null;
    laborSubtotal?: string | null;
    totalAmount?: string | null;
  } | null>(null);
  // For WOs, prefer localWoTotals (immediately set from dedicated-endpoint responses)
  // over the prop value so totals reflect edits before the parent query refetches.
  const laborRate = canSeePricing
    ? (isWorkOrder
        ? (localWoTotals?.laborRate ?? wo?.appliedLaborRate ?? wo?.laborRate)
        : (localWoTotals?.laborRate ?? bs?.laborRate))
    : null;
  const laborSubtotal = canSeePricing
    ? (localWoTotals?.laborSubtotal ?? (isWorkOrder ? wo?.laborSubtotal : bs?.laborSubtotal))
    : null;
  const partsSubtotal = canSeePricing ? (isWorkOrder ? wo?.partsSubtotal : bs?.partsSubtotal) : null;
  const totalAmount = canSeePricing
    ? (localWoTotals?.totalAmount ?? (isWorkOrder ? wo?.totalAmount : bs?.totalAmount))
    : null;
  const sourcePhotos: string[] = (isWorkOrder ? wo?.photos : bs?.photos) ?? [];

  // Local photos state mirrors the source but allows optimistic updates so the
  // open modal reflects add/remove immediately, before the parent refetches.
  const [localPhotos, setLocalPhotos] = useState<string[]>(sourcePhotos);
  useEffect(() => {
    setLocalPhotos(sourcePhotos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(sourcePhotos), id, open]);
  const photos = localPhotos;
  const { getUrl: getPhotoSignedUrl } = usePhotoSignedUrls(photos, "thumb");

  // Photo edit access (billing sheet only — work orders use their own detail view).
  // Task #191: photos may still be added/removed even when the sheet has been
  // moved to billing (status === 'billed' or has an invoiceId), so techs can
  // backfill missing photos. The "billed lock notice" still shows below; this
  // exception applies only to the photo control.
  const canEditPhotos =
    type === 'billing_sheet' &&
    (
      userRole === 'company_admin' ||
      userRole === 'super_admin' ||
      userRole === 'irrigation_manager' ||
      userRole === 'billing_manager' ||
      (userRole === 'field_tech' && bs?.technicianId === userId)
    );

  const updatePhotos = useMutation({
    mutationFn: async (nextPhotos: string[]) => {
      try {
        await apiRequest(`/api/billing-sheets/${id}`, "PATCH", { photos: nextPhotos });
      } catch (err) {
        const detail = parseApiError(err, err instanceof Error ? err.message : "save failed");
        throw new Error(`Save to sheet failed: ${detail}`);
      }
      return nextPhotos;
    },
    onSuccess: (nextPhotos) => {
      setLocalPhotos(nextPhotos);
      queryClient.invalidateQueries({ queryKey: ["/api/billing-sheets"] });
      onSaved?.();
    },
    onError: (error: any) => {
      toast({
        title: "Couldn't save photos to sheet",
        description: error?.message || "Failed to update photos",
        variant: "destructive",
      });
    },
  });

  const handlePhotoUpload = async (selectedFiles: FileList | null) => {
    if (!selectedFiles?.length) return;
    setIsUploadingPhoto(true);
    const partialWarnings: string[] = [];
    try {
      const newUrls: string[] = [];
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        // 1. Ask the server for a signed PUT URL for the display copy.
        let signedUrl: string;
        let canonicalUrl: string;
        try {
          const signUrlRes = await fetch(
            `/api/upload/photo?originalName=${encodeURIComponent(file.name)}`,
            { method: 'POST', headers: getAuthHeaders(), credentials: 'include' }
          );
          if (!signUrlRes.ok) {
            const body = await signUrlRes.text();
            throw new Error(`${signUrlRes.status}: ${body || signUrlRes.statusText}`);
          }
          const json = await signUrlRes.json();
          signedUrl = json.signedUrl;
          canonicalUrl = json.url;
        } catch (err: any) {
          throw new Error(`Get upload URL failed for ${file.name}: ${err?.message || err}`);
        }

        // 2. Prepare the display copy (HEIC → JPEG once, then a tight
        //    ~1600px / ~0.35MB JPEG that drives the server-generated
        //    thumb / medium variants).
        const { displayFile } = await preparePhotoForUpload(file);

        // 3. Single upload: tight display bytes go to the canonical key.
        let displayPut: Response;
        try {
          displayPut = await fetch(signedUrl, {
            method: 'PUT',
            body: displayFile,
            headers: { 'Content-Type': displayFile.type || 'application/octet-stream' },
          });
        } catch (err: any) {
          throw new Error(`Upload to storage failed for ${file.name}: ${err?.message || err}`);
        }
        if (!displayPut.ok) {
          const body = await displayPut.text().catch(() => '');
          throw new Error(`Upload to storage failed for ${file.name} (${displayPut.status}${body ? `: ${body.slice(0, 120)}` : ''})`);
        }

        // 4. Ask the server to generate thumb/medium variants. Variant
        //    work runs in the background server-side, so a 2xx here just
        //    means the request was accepted. A non-2xx is non-fatal (the
        //    base path still serves) but worth surfacing so users know
        //    thumbnails may be delayed.
        try {
          const finalizeRes = await fetch('/api/upload/photo/finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            credentials: 'include',
            body: JSON.stringify({ photoId: canonicalUrl }),
          });
          if (!finalizeRes.ok) {
            const body = await finalizeRes.text().catch(() => '');
            console.warn(`[detail-modal] finalize failed for ${file.name}`, finalizeRes.status, body);
            partialWarnings.push(
              `Finalize failed for ${file.name} (${finalizeRes.status}${body ? `: ${body.slice(0, 80)}` : ''}). Thumbnails may be delayed.`
            );
          }
        } catch (err: any) {
          console.warn('[detail-modal] finalize call failed', err);
          partialWarnings.push(
            `Finalize request for ${file.name} couldn't be sent: ${err?.message || err}. Thumbnails may be delayed.`
          );
        }

        newUrls.push(canonicalUrl);
      }

      // 5. Save to the sheet. Use localPhotos (current modal state) — not
      //    bs?.photos (server snapshot) — so rapid successive uploads
      //    don't drop just-added photos.
      const existing: string[] = Array.isArray(localPhotos) ? localPhotos : [];
      try {
        await updatePhotos.mutateAsync([...existing, ...newUrls]);
        if (partialWarnings.length > 0) {
          toast({
            title: "Photos saved with warnings",
            description: partialWarnings.join(" "),
            variant: "destructive",
          });
        } else {
          toast({
            title: "Photos Added",
            description: `${newUrls.length} photo${newUrls.length > 1 ? 's' : ''} uploaded successfully`,
          });
        }
      } catch {
        // updatePhotos.onError already toasted with a specific message.
      }
    } catch (error: any) {
      toast({
        title: "Upload Failed",
        description: error?.message || "Failed to upload photos",
        variant: "destructive",
      });
    } finally {
      setIsUploadingPhoto(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  };

  const handleConfirmRemovePhoto = () => {
    if (photoToRemove === null) return;
    const existing: string[] = Array.isArray(localPhotos) ? localPhotos : [];
    const updated = existing.filter((_, i) => i !== photoToRemove);
    updatePhotos.mutate(updated);
    setPhotoToRemove(null);
    toast({ title: "Photo Removed", description: "Photo has been removed from this billing sheet" });
  };
  const notes = isWorkOrder ? wo?.notes : bs?.notes;
  const workSummary = isWorkOrder ? wo?.workSummary : null;
  const customerNotes = isWorkOrder ? wo?.customerNotes : null;
  const locationNotes = isWorkOrder ? wo?.locationNotes : null;

  // ── Manager billing notes (irrigation_manager side, Task #1459) ─────────
  // Irrigation managers (and admins) leave billing-specific instructions for
  // the billing manager before or during approval. Billing managers see them
  // as a highlighted callout ("Notes from Irrigation Manager") that catches
  // their eye. The field is never cleared by billing-manager saves.
  const canEditManagerBillingNotes =
    type === "billing_sheet" &&
    ["irrigation_manager", "company_admin", "super_admin"].includes(userRole) &&
    !isBilledOrInvoiced;

  const [managerBillingNotesLocal, setManagerBillingNotesLocal] = useState<string>("");
  useEffect(() => {
    setManagerBillingNotesLocal(bs?.managerBillingNotes ?? "");
  }, [id, open]);

  const saveManagerBillingNotes = async (): Promise<void> => {
    if (!canEditManagerBillingNotes) return;
    const next = managerBillingNotesLocal.trim();
    const prev = (bs?.managerBillingNotes ?? "").trim();
    if (next === prev) return;
    await patchRecordMutation.mutateAsync({ managerBillingNotes: next || null });
  };

  // ── Inline editing (billing_manager / admin, unlocked records only) ──────
  const canInlineEdit =
    ["billing_manager", "company_admin", "super_admin"].includes(userRole) &&
    !isBilledOrInvoiced;

  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string>>({});

  // Reset local totals whenever the modal opens with a different record
  // (localWoTotals is declared earlier, before its first use).
  useEffect(() => {
    setLocalWoTotals(null);
  }, [id, open]);
  useEffect(() => { setFieldOverrides({}); }, [id, open]);
  // After a successful save the server refetches and updatedAt changes.
  // Clear all overrides at that point so server-normalized values show through.
  const updatedAtStamp = (wo ?? bs)?.updatedAt as string | undefined;
  useEffect(() => {
    setFieldOverrides({});
    // Clear local WO total overrides so fresh server-recomputed values win.
    // This fires whenever any mutation (rate-mode toggle, items editor, etc.)
    // invalidates the query and the refetched wo.updatedAt advances.
    setLocalWoTotals(null);
  }, [updatedAtStamp]);

  const patchRecordMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const endpoint = isWorkOrder ? `/api/work-orders/${id}` : `/api/billing-sheets/${id}`;
      return apiRequest(endpoint, "PATCH", patch);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: isWorkOrder ? ["/api/work-orders"] : ["/api/billing-sheets"],
      });
      onSaved?.();
    },
    onError: (err: Error) => {
      toast({ title: "Could not save", description: parseApiError(err, err.message), variant: "destructive" });
    },
  });

  const patchField = async (key: string, value: string, patch: Record<string, unknown>) => {
    await patchRecordMutation.mutateAsync(patch);
    setFieldOverrides((prev) => ({ ...prev, [key]: value }));
  };

  const fv = (key: string, raw: string | null | undefined) =>
    key in fieldOverrides ? fieldOverrides[key] : (raw ?? "");
  const branchName = isWorkOrder ? (wo as any)?.branchName : (bs as any)?.branchName;

  // Approval stamp fields
  const approvedBy = (data as any)?.approvedBy;
  const approvedAt = (data as any)?.approvedAt;
  const approvedTotal = (data as any)?.approvedTotal;

  const openLightbox = (url: string, index: number) => {
    setLightboxPhoto(url);
    setLightboxIndex(index);
  };

  const prevPhoto = () => {
    const newIdx = (lightboxIndex - 1 + photos.length) % photos.length;
    setLightboxIndex(newIdx);
    setLightboxPhoto(photos[newIdx]);
  };

  const nextPhoto = () => {
    const newIdx = (lightboxIndex + 1) % photos.length;
    setLightboxIndex(newIdx);
    setLightboxPhoto(photos[newIdx]);
  };

  // Compute totals from items if financial fields missing
  const itemsPartsTotal = canSeePricing
    ? items.reduce((sum, item) => {
        const price = (item as any).totalPrice ?? (item as any).partPrice ?? 0;
        return sum + parseFloat(price || "0");
      }, 0)
    : 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[95vw] max-w-3xl max-h-[95vh] overflow-hidden p-0 flex flex-col">
          {/* Header */}
          <DialogHeader className="flex-shrink-0 p-0">
            <div
              className={`px-5 py-4 border-b ${
                status === "work_completed" || status === "billed"
                  ? "bg-gradient-to-r from-green-50 to-emerald-50 border-green-100"
                  : "bg-gradient-to-r from-blue-50 to-slate-50 border-gray-100"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`p-2.5 rounded-xl flex-shrink-0 ${
                      status === "work_completed" || status === "billed"
                        ? "bg-green-100"
                        : "bg-blue-100"
                    }`}
                  >
                    {status === "work_completed" || status === "billed" ? (
                      <CheckCircle className="w-5 h-5 text-green-600" />
                    ) : (
                      <FileText className="w-5 h-5 text-blue-600" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <DialogTitle className="text-lg font-bold text-gray-900 leading-tight">
                      {title}
                    </DialogTitle>
                    <p className="text-sm text-gray-600 mt-0.5 truncate">{customerName}</p>
                  </div>
                </div>
                <div className="flex-shrink-0 flex items-center gap-2">
                  {data.invoiceId && status !== 'billed' && (
                    <Badge className="bg-purple-100 text-purple-800">Billed</Badge>
                  )}
                  <Badge className={`capitalize ${statusColors[status] ?? "bg-gray-100 text-gray-700"}`}>
                    {statusLabels[status] ?? status.replace(/_/g, " ")}
                  </Badge>
                </div>
              </div>
            </div>
          </DialogHeader>

          {/* Scrollable body */}
          <InlineEditProvider>
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">

            {/* Billed lock notice */}
            {(status === 'billed' || data.invoiceId) && (
              <div className="flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-4 py-3 text-sm text-purple-800">
                <span className="font-medium">This record has been billed and cannot be edited.</span>
              </div>
            )}

            {/* Pending Manager Review notice */}
            {status === 'pending_manager_review' && (
              <div className="flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
                <span className="font-medium">Awaiting irrigation manager review before passing to billing.</span>
              </div>
            )}

            {/* No Photos Needed — admin/manager action and audit note */}
            {type === 'billing_sheet' && effectiveNoPhotosNeeded && (
              <div
                className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
                data-testid="banner-no-photos-needed"
              >
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
                <span>
                  <span className="font-medium">Marked as not needing photos</span>
                  {effectiveNoPhotosNeededAt ? ` on ${fmtDateTime(effectiveNoPhotosNeededAt)}` : ''}.
                </span>
              </div>
            )}
            {type === 'billing_sheet' && !effectiveNoPhotosNeeded && canMarkNoPhotosNeeded && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
                <span className="text-gray-700">
                  Photos missing or not applicable? Clear this sheet from the missing-photos report.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmNoPhotosNeeded(true)}
                  disabled={noPhotosNeededMutation.isPending}
                  data-testid="button-no-photos-needed"
                >
                  <CheckCircle2 className="w-4 h-4 mr-1.5" />
                  {noPhotosNeededMutation.isPending ? "Marking…" : "No Photos Needed"}
                </Button>
              </div>
            )}

            {/* Reassign Technician — admin correction action (company_admin / super_admin only) */}
            {canReassignTechnician && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
                <span className="text-gray-700">
                  Wrong technician on this sheet? Reassign it to the correct person.
                </span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setReassignTechId(bs?.technicianId?.toString() ?? "");
                            setShowReassignDialog(true);
                          }}
                          disabled={isBilledOrInvoiced || reassignMutation.isPending}
                          data-testid="button-reassign-technician"
                        >
                          <Edit className="w-4 h-4 mr-1.5" />
                          Reassign Technician
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {isBilledOrInvoiced && (
                      <TooltipContent side="left">
                        <p>Cannot reassign — this sheet has already been invoiced or billed.</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}

            {/* Rate mismatch warning — flags when stored rate differs from customer's current rate */}
            {hasRateMismatch && type === 'billing_sheet' && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <div className="flex items-start gap-2">
                  <span className="text-amber-600 font-bold text-base leading-none mt-0.5">⚠</span>
                  <div>
                    <p className="font-semibold">Rate mismatch detected</p>
                    <p className="mt-0.5">
                      The rate on this sheet (${storedRate?.toFixed(2)}/hr) differs from the customer's current rate (${currentCustomerRate?.toFixed(2)}/hr).
                      {(status === 'billed' || data.invoiceId)
                        ? ' Already billed — review manually before reissuing.'
                        : ' The server will use the customer\'s current rate for any new billing sheets.'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Approval stamp */}
            {(status === 'approved_passed_to_billing' || status === 'billed') && approvedBy && (
              <div className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle className="w-4 h-4 flex-shrink-0 text-teal-600" />
                  <span className="font-semibold">Manager Approved</span>
                </div>
                <div className="text-teal-700 space-y-0.5 pl-6">
                  <div>Approved by <strong>{approvedBy}</strong></div>
                  {approvedAt && <div>on {fmtDateTime(approvedAt)}</div>}
                  {approvedTotal && canSeePricing && (
                    <div>Approved total: <strong>{currency(approvedTotal)}</strong></div>
                  )}
                </div>
              </div>
            )}

            {/* Approval signature — shown for work orders that originated from
                a customer-signed estimate (Task #1500). The signature fields
                are merged into the WO payload by GET /api/work-orders/:id;
                they are never present on pure billing-sheet records. */}
            {isWorkOrder && (wo as any)?.approvalSignatureData && (
              <ApprovalSignatureBlock
                approvalSignatureType={(wo as any).approvalSignatureType}
                approvalSignatureData={(wo as any).approvalSignatureData}
                approvalSignerName={(wo as any).approvalSignerName}
                approvalSignedAt={(wo as any).approvalSignedAt}
                approvalSignerIp={(wo as any).approvalSignerIp}
                approvalConsentText={(wo as any).approvalConsentText}
                approvalConsentAcceptedAt={(wo as any).approvalConsentAcceptedAt}
              />
            )}

            {/* Notes from Irrigation Manager — billing manager callout (Task #1459).
                Visible whenever the field is non-empty to any role that can see this
                modal. Styled as a distinct amber callout so it isn't missed. */}
            {type === "billing_sheet" && bs?.managerBillingNotes && !canEditManagerBillingNotes && (
              <div
                className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm"
                data-testid="manager-billing-notes-callout"
              >
                <div className="flex items-center gap-2 mb-2">
                  <MessageSquare className="w-4 h-4 flex-shrink-0 text-amber-600" />
                  <span className="font-semibold text-amber-900">Notes from Irrigation Manager</span>
                </div>
                <p className="text-amber-800 pl-6 leading-relaxed whitespace-pre-wrap">
                  {bs.managerBillingNotes}
                </p>
              </div>
            )}

            {/* Inline-edit hint — shown once to eligible users, dismissed to localStorage */}
            {canInlineEdit && !hintDismissed && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800">
                <div className="flex items-center gap-2">
                  <Info className="w-4 h-4 flex-shrink-0 text-blue-500" />
                  <span>Click any <strong>✏</strong> pencil icon to edit a field. Changes save automatically.</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setHintDismissed(true);
                    try { localStorage.setItem("irrigopro:inlineEditHintDismissed", "1"); } catch {}
                  }}
                  className="flex-shrink-0 p-0.5 text-blue-400 hover:text-blue-700 transition-colors"
                  aria-label="Dismiss"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Location & Job Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <SectionCard title="Location" icon={<MapPin className="w-4 h-4" />}>
                <div className="space-y-3">
                  <InfoRow label="Customer" value={customerName} />
                  <InfoRow label="Property Address" value={address} />
                  {(() => {
                    const lat = isWorkOrder ? wo?.workLocationLat : bs?.workLocationLat;
                    const lng = isWorkOrder ? wo?.workLocationLng : bs?.workLocationLng;
                    const pinAddr = isWorkOrder ? wo?.workLocationAddress : bs?.workLocationAddress;
                    if (lat == null && lng == null && !pinAddr) return null;
                    const mapsUrl = buildMapsUrl({
                      lat: lat ?? null,
                      lng: lng ?? null,
                      address: pinAddr ?? null,
                      label: address,
                    });
                    const latNum = lat == null ? NaN : (typeof lat === "number" ? lat : parseFloat(String(lat)));
                    const lngNum = lng == null ? NaN : (typeof lng === "number" ? lng : parseFloat(String(lng)));
                    const pinLabel =
                      pinAddr ||
                      (Number.isFinite(latNum) && Number.isFinite(lngNum)
                        ? `${latNum.toFixed(6)}, ${lngNum.toFixed(6)}`
                        : "");
                    if (!pinLabel) return null;
                    return (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">
                          Pinned Location
                        </p>
                        <div className="flex items-start gap-2">
                          <p className="text-sm text-gray-900 leading-snug flex-1 min-w-0 break-words">
                            {pinLabel}
                          </p>
                          {mapsUrl && (
                            <a
                              href={mapsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 flex-shrink-0"
                            >
                              <Navigation className="w-3.5 h-3.5" /> Navigate
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {(() => {
                    const ctrl = isWorkOrder ? wo?.controllerLetter : bs?.controllerLetter;
                    const zone = isWorkOrder ? wo?.zoneNumber : bs?.zoneNumber;
                    if (!ctrl && zone == null) return null;
                    const parts: string[] = [];
                    if (ctrl) parts.push(`Clock ${ctrl}`);
                    if (zone != null) parts.push(`Zone ${zone}`);
                    return (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">
                          Clock / Zone
                        </p>
                        <span className="inline-flex items-center gap-1.5 text-sm text-gray-900">
                          <Cpu className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                          {parts.join(' · ')}
                        </span>
                      </div>
                    );
                  })()}
                  {(locationNotes || (isWorkOrder && canInlineEdit)) && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">Location Notes</p>
                      <EditableField
                        fieldId="locationNotes"
                        value={fv("locationNotes", isWorkOrder ? (wo?.locationNotes ?? "") : "")}
                        onSave={async (v) => patchField("locationNotes", v, { locationNotes: v })}
                        canEdit={canInlineEdit && isWorkOrder}
                        type="textarea"
                        placeholder="Add location notes…"
                      >
                        <span className="text-sm text-gray-900 leading-snug whitespace-pre-wrap">
                          {fv("locationNotes", isWorkOrder ? (wo?.locationNotes ?? "") : "") || (
                            <span className="text-gray-400 italic">No location notes</span>
                          )}
                        </span>
                      </EditableField>
                    </div>
                  )}
                </div>
              </SectionCard>

              <SectionCard title="Job Info" icon={<Calendar className="w-4 h-4" />}>
                <div className="space-y-3">
                  <InfoRow label="Technician" value={techName ?? "—"} />
                  {branchName && <InfoRow label="Branch" value={branchName} />}
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">
                      {isWorkOrder ? "Scheduled Date" : "Work Date"}
                    </p>
                    <EditableField
                      fieldId={isWorkOrder ? "scheduledDate" : "workDate"}
                      value={fv(
                        isWorkOrder ? "scheduledDate" : "workDate",
                        workDate
                          ? (() => {
                              try {
                                // Use local date parts — not toISOString (UTC) — to avoid
                                // off-by-one when the server stores UTC midnight timestamps.
                                const d = new Date(workDate as string | Date);
                                if (isNaN(d.getTime())) return "";
                                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                              } catch { return ""; }
                            })()
                          : ""
                      )}
                      onSave={async (v) =>
                        patchField(
                          isWorkOrder ? "scheduledDate" : "workDate",
                          v,
                          isWorkOrder ? { scheduledDate: v } : { workDate: v }
                        )
                      }
                      canEdit={canInlineEdit}
                      type="date"
                    >
                      <span className="text-sm text-gray-900 leading-snug">
                        {(() => {
                          const override = fieldOverrides[isWorkOrder ? "scheduledDate" : "workDate"];
                          return override ? fmt(override) : fmt(workDate);
                        })()}
                      </span>
                    </EditableField>
                  </div>
                  {completedDate && (
                    <InfoRow
                      label="Completed"
                      value={`${fmtDateTime(completedDate)}${completedBy ? ` by ${completedBy}` : ""}`}
                    />
                  )}
                  {isWorkOrder && wo?.startedAt && (
                    <InfoRow label="Started" value={fmtDateTime(wo.startedAt)} />
                  )}
                </div>
              </SectionCard>
            </div>

            {/* Time & Labor */}
            <SectionCard title="Time & Labor" icon={<Clock className="w-4 h-4" />}>
              {wetCheckView && type === "billing_sheet" ? (
                canSeePricing ? (
                  <div className="space-y-3">
                    <div className="flex items-center flex-wrap gap-3">
                      <div className="bg-gray-50 rounded-lg px-4 py-3 text-center min-w-[80px]">
                        <p className="text-2xl font-bold text-gray-900">{totalHours ?? "0"}</p>
                        <p className="text-xs text-gray-500 mt-0.5">Hours (WC)</p>
                      </div>
                      <span className="text-xl font-semibold text-gray-400">×</span>
                      <div className="bg-gray-50 rounded-lg px-4 py-3 text-center min-w-[80px]">
                        <p className="text-2xl font-bold text-gray-900">{currency(localWoTotals?.laborRate ?? wetCheckView.laborRate)}</p>
                        <p className="text-xs text-gray-500 mt-0.5">Rate / hr</p>
                      </div>
                      <span className="text-xl font-semibold text-gray-400">=</span>
                      <div className="bg-blue-50 rounded-lg px-4 py-3 text-center min-w-[80px] border border-blue-100">
                        <p className="text-2xl font-bold text-blue-700">{currency(laborSubtotal)}</p>
                        <p className="text-xs text-gray-500 mt-0.5">Irrigation Labor</p>
                      </div>
                    </div>
                    {canInlineEditRole && customerForRateCheck && (
                      <RateModeToggle
                        entityPath={wetCheckView.wetCheckBillingId ? "wet-check-billings" : "billing-sheets"}
                        entityId={wetCheckView.wetCheckBillingId ?? id}
                        currentMode={(bs?.rateMode ?? "normal") as "normal" | "emergency"}
                        normalRate={customerForRateCheck.laborRate ?? null}
                        emergencyRate={customerForRateCheck.emergencyLaborRate ?? null}
                        detailQueryKey={
                          wetCheckView.wetCheckBillingId
                            ? ["/api/billing-sheets", id, "wet-check-view"]
                            : ["/api/billing-sheets"]
                        }
                        disabled={isBilledOrInvoiced}
                        onApplied={(u) =>
                          setLocalWoTotals({
                            laborRate: String(u.appliedLaborRate ?? u.laborRate ?? ""),
                            laborSubtotal: String(u.laborSubtotal ?? ""),
                            totalAmount: String(u.totalAmount ?? ""),
                          })
                        }
                      />
                    )}
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-2xl font-bold text-gray-900">{totalHours ?? "0"}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Hours Worked</p>
                  </div>
                )
              ) : canSeePricing ? (
                <div className="space-y-3">
                  <div className="flex items-center flex-wrap gap-3">
                    <div className="bg-gray-50 rounded-lg px-4 py-3 text-center min-w-[80px]">
                      {canInlineEdit ? (
                        <EditableField
                          fieldId="totalHours"
                          value={fv("totalHours", String(totalHours ?? "0"))}
                          onSave={async (v) => {
                            const hrs = parseFloat(v) || 0;
                            if (isWorkOrder) {
                              // Use the dedicated WO labor-hours endpoint so the server
                              // calls updateWorkOrderLaborHours + recalculates totals.
                              const result = await apiRequest(`/api/work-orders/${id}/labor-hours`, "PATCH", { totalHours: hrs });
                              queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
                              setFieldOverrides((prev) => ({ ...prev, totalHours: v }));
                              // Immediately reflect recomputed totals without waiting for refetch
                              if (result && typeof result === "object") {
                                setLocalWoTotals((prev) => ({
                                  ...prev,
                                  laborSubtotal: String((result as any).laborSubtotal ?? ""),
                                  totalAmount: String((result as any).totalAmount ?? ""),
                                }));
                              }
                              onSaved?.();
                            } else {
                              await patchField("totalHours", v, { totalHours: v });
                              onSaved?.();
                            }
                          }}
                          canEdit={true}
                          type="number"
                          min={0}
                          max={100}
                          step={0.25}
                          validate={(v) => {
                            const n = parseFloat(v);
                            if (isNaN(n) || n < 0) return "Hours must be 0 or greater";
                            if (n > 100) return "Hours seem unusually high (max 100)";
                            return null;
                          }}
                          className="justify-center"
                          inputClassName="text-center w-20"
                        >
                          <p className="text-2xl font-bold text-gray-900">
                            {fv("totalHours", String(totalHours ?? "0"))}
                          </p>
                        </EditableField>
                      ) : (
                        <p className="text-2xl font-bold text-gray-900">{totalHours ?? "0"}</p>
                      )}
                      <p className="text-xs text-gray-500 mt-0.5">Hours</p>
                    </div>
                    <span className="text-xl font-semibold text-gray-400">×</span>
                    <div className="bg-gray-50 rounded-lg px-4 py-3 text-center min-w-[80px]">
                      {/* Rate is chosen via the Normal/Emergency rate-mode
                          control below — never free-text. Read-only display. */}
                      <p className="text-2xl font-bold text-gray-900">{currency(parseFloat(String(laborRate ?? "0")) || 0)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Rate / hr</p>
                    </div>
                    <span className="text-xl font-semibold text-gray-400">=</span>
                    <div className="bg-blue-50 rounded-lg px-4 py-3 text-center min-w-[80px] border border-blue-100">
                      <p className="text-2xl font-bold text-blue-700">{currency(laborSubtotal)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Labor Total</p>
                    </div>
                  </div>
                  {canInlineEditRole && customerForRateCheck && (
                    <RateModeToggle
                      entityPath={isWorkOrder ? "work-orders" : "billing-sheets"}
                      entityId={id}
                      currentMode={((isWorkOrder ? (wo as any)?.rateMode : bs?.rateMode) ?? "normal") as "normal" | "emergency"}
                      normalRate={customerForRateCheck.laborRate ?? null}
                      emergencyRate={customerForRateCheck.emergencyLaborRate ?? null}
                      detailQueryKey={[isWorkOrder ? "/api/work-orders" : "/api/billing-sheets"]}
                      disabled={isBilledOrInvoiced}
                      onApplied={(u) =>
                        setLocalWoTotals({
                          laborRate: String(u.appliedLaborRate ?? u.laborRate ?? ""),
                          laborSubtotal: String(u.laborSubtotal ?? ""),
                          totalAmount: String(u.totalAmount ?? ""),
                        })
                      }
                    />
                  )}
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-2xl font-bold text-gray-900">{totalHours ?? "0"}</p>
                  <p className="text-xs text-gray-500 mt-0.5">Hours Worked</p>
                </div>
              )}
            </SectionCard>

            {/* Parts & Materials — replaced by zone-grouped view for WC billing sheets */}
            {wetCheckView && type === "billing_sheet" ? (
              <WetCheckBillingViewComponent
                view={wetCheckView}
                canSeePricing={canSeePricing}
                wcbId={wetCheckView.wetCheckBillingId}
                canEditLabor={canEditWetCheckSnapshot}
                canEditQuantity={canEditWetCheckSnapshot}
                laborRate={wetCheckView.laborRate}
                canEditInspectionNotes={canInlineEdit}
                onSaveInspectionNotes={async (notes) => {
                  await apiRequest(
                    `/api/wet-checks/${wetCheckView.inspection.wetCheckId}`,
                    "PATCH",
                    { notes }
                  );
                  queryClient.invalidateQueries({
                    queryKey: ["/api/billing-sheets", id, "wet-check-view"],
                  });
                }}
              />
            ) : isWorkOrder && wo != null && isInspectionOriginWorkOrder(wo, items as WorkOrderItem[]) ? (
              <InspectionZoneChecklist workOrder={wo} readOnly />
            ) : (items.length > 0 || canInlineEdit) && (
              <SectionCard
                title={`Parts & Materials${items.length > 0 ? ` (${items.length} item${items.length !== 1 ? "s" : ""})` : ""}`}
                icon={<Package className="w-4 h-4" />}
                action={canInlineEdit ? (
                  <button
                    type="button"
                    onClick={() => setShowPartsEditor(true)}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                  >
                    <Edit className="w-3 h-3" />
                    Edit Parts List
                  </button>
                ) : undefined}
              >
                {items.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">
                    No parts on this record.{canInlineEdit && ' Click \u201cEdit Parts List\u201d above to add some.'}
                  </p>
                ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left pb-2 font-medium text-gray-600 pr-3">Part</th>
                        <th className="text-center pb-2 font-medium text-gray-600 px-2 whitespace-nowrap">Qty</th>
                        {canSeePricing && (
                          <>
                            <th className="text-right pb-2 font-medium text-gray-600 px-2 whitespace-nowrap">Unit $</th>
                            <th className="text-right pb-2 font-medium text-gray-600 pl-2 whitespace-nowrap">Total</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {items.map((item, idx) => {
                        const unitPrice = canSeePricing
                          ? ((item as BillingSheetItem).unitPrice ?? (item as WorkOrderItem).partPrice)
                          : null;
                        const totalPrice = canSeePricing
                          ? (item as any).totalPrice
                          : null;
                        const qty = (item as BillingSheetItem).quantity ?? (item as WorkOrderItem).quantity;
                        const desc = (item as BillingSheetItem).partDescription;
                        return (
                          <tr key={idx} className="hover:bg-gray-50">
                            <td className="py-2.5 pr-3">
                              <p className="font-medium text-gray-900">{item.partName}</p>
                              {desc && <p className="text-xs text-gray-500 mt-0.5">{desc}</p>}
                              {(item as WorkOrderItem).notes && (
                                <p className="text-xs text-gray-400 mt-0.5 italic">{(item as WorkOrderItem).notes}</p>
                              )}
                            </td>
                            <td className="py-2.5 px-2 text-center text-gray-700">{qty}</td>
                            {canSeePricing && (
                              <>
                                <td className="py-2.5 px-2 text-right text-gray-700">
                                  {unitPrice ? currency(unitPrice) : "—"}
                                </td>
                                <td className="py-2.5 pl-2 text-right font-medium text-gray-900">
                                  {totalPrice ? currency(totalPrice) : "—"}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                    {canSeePricing && (
                      <tfoot>
                        <tr className="border-t border-gray-200">
                          <td colSpan={canSeePricing ? 3 : 2} className="pt-2 text-sm text-gray-600 font-medium">
                            Parts Subtotal
                          </td>
                          <td className="pt-2 text-right font-semibold text-gray-900">
                            {currency(partsSubtotal ?? itemsPartsTotal)}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                )}
              </SectionCard>
            )}

            {/* Total Bill */}
            {canSeePricing && (
              <SectionCard title="Total Bill" icon={<DollarSign className="w-4 h-4" />}>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-gray-600">
                    <span>Labor Subtotal</span>
                    <span className="font-medium text-gray-900">{currency(laborSubtotal ?? 0)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-gray-600">
                    <span>Parts Subtotal</span>
                    <span className="font-medium text-gray-900">{currency(partsSubtotal ?? itemsPartsTotal)}</span>
                  </div>
                  <Separator className="my-2" />
                  <div className="flex justify-between items-center">
                    <span className="text-base font-semibold text-gray-900">Grand Total</span>
                    <span className="text-xl font-bold text-blue-700">
                      {currency(
                        totalAmount ??
                          (parseFloat(String(laborSubtotal ?? 0)) +
                            parseFloat(String(partsSubtotal ?? itemsPartsTotal)))
                      )}
                    </span>
                  </div>
                </div>
              </SectionCard>
            )}

            {/* Photos */}
            {(photos.length > 0 || canEditPhotos) && (
              <SectionCard
                title={`Photos (${photos.length})`}
                icon={<Camera className="w-4 h-4" />}
              >
                {canEditPhotos && (
                  <div className="flex justify-end mb-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => photoInputRef.current?.click()}
                      disabled={isUploadingPhoto || updatePhotos.isPending}
                      className="flex items-center gap-1.5"
                      data-testid="button-add-photos"
                    >
                      {isUploadingPhoto ? (
                        <>
                          <Upload className="w-4 h-4 animate-pulse" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" />
                          Add Photos
                        </>
                      )}
                    </Button>
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      multiple
                      onChange={(e) => handlePhotoUpload(e.target.files)}
                      className="hidden"
                    />
                  </div>
                )}
                {photos.length > 0 ? (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {photos.map((url, idx) => (
                      <div key={idx} className="relative group">
                        <button
                          onClick={() => openLightbox(url, idx)}
                          className="aspect-square w-full rounded-lg overflow-hidden border border-gray-100 hover:border-blue-300 hover:shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-blue-400"
                        >
                          <PhotoImage
                            photoUrl={url}
                            alt={`Photo ${idx + 1}`}
                            variant="thumb"
                            batchManaged
                            signedUrlOverride={getPhotoSignedUrl(url)}
                            className="w-full h-full object-cover"
                          />
                        </button>
                        {canEditPhotos && (
                          <button
                            onClick={() => setPhotoToRemove(idx)}
                            disabled={updatePhotos.isPending}
                            className="absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
                            title="Remove photo"
                            data-testid={`button-remove-photo-${idx}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 text-center py-4">No photos yet. Click "Add Photos" to upload.</p>
                )}
              </SectionCard>
            )}

            {/* Notes */}
            {(workDescription || workSummary || notes || customerNotes || canInlineEdit) && (
              <SectionCard title="Notes & Description" icon={<FileText className="w-4 h-4" />}>
                <div className="space-y-3">
                  {(workDescription || canInlineEdit) && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Work Description</p>
                      <EditableField
                        fieldId={isWorkOrder ? "description" : "workDescription"}
                        value={fv(
                          isWorkOrder ? "description" : "workDescription",
                          isWorkOrder ? (wo?.description ?? "") : (bs?.workDescription ?? "")
                        )}
                        onSave={async (v) =>
                          patchField(
                            isWorkOrder ? "description" : "workDescription",
                            v,
                            isWorkOrder ? { description: v } : { workDescription: v }
                          )
                        }
                        canEdit={canInlineEdit}
                        type="textarea"
                        placeholder="Add a work description…"
                      >
                        <p className="text-sm text-gray-800 bg-gray-50 rounded-lg p-3 leading-relaxed whitespace-pre-wrap min-h-[2.5rem]">
                          {fv(
                            isWorkOrder ? "description" : "workDescription",
                            isWorkOrder ? (wo?.description ?? "") : (bs?.workDescription ?? "")
                          ) || <span className="text-gray-400 italic">No description</span>}
                        </p>
                      </EditableField>
                    </div>
                  )}
                  {workSummary && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Completion Summary</p>
                      <p className="text-sm text-gray-800 bg-green-50 rounded-lg p-3 leading-relaxed whitespace-pre-wrap border border-green-100">
                        {workSummary}
                      </p>
                    </div>
                  )}
                  {(notes || canInlineEdit) && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                        {isWorkOrder ? "Additional Notes" : "Internal Notes"}
                      </p>
                      <EditableField
                        fieldId="notes"
                        value={fv("notes", isWorkOrder ? (wo?.notes ?? "") : (bs?.notes ?? ""))}
                        onSave={async (v) => patchField("notes", v, { notes: v })}
                        canEdit={canInlineEdit}
                        type="textarea"
                        placeholder="Add internal notes…"
                      >
                        <p className="text-sm text-gray-800 bg-gray-50 rounded-lg p-3 leading-relaxed whitespace-pre-wrap min-h-[2.5rem]">
                          {fv("notes", isWorkOrder ? (wo?.notes ?? "") : (bs?.notes ?? "")) || (
                            <span className="text-gray-400 italic">No notes</span>
                          )}
                        </p>
                      </EditableField>
                    </div>
                  )}
                  {customerNotes && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Customer Notes</p>
                      <p className="text-sm text-gray-800 bg-blue-50 rounded-lg p-3 leading-relaxed whitespace-pre-wrap border border-blue-100">
                        {customerNotes}
                      </p>
                    </div>
                  )}
                </div>
              </SectionCard>
            )}

            {/* Billing Notes for Billing Manager — editable by irrigation_manager / admin (Task #1459).
                Saved on blur so the note is persisted before the manager hits Approve.
                Also flushed by the Save and Save & Approve buttons in ApprovalActionRow
                via the beforeAction callback. Hidden once the sheet is billed. */}
            {canEditManagerBillingNotes && (
              <SectionCard
                title="Billing Notes for Billing Manager"
                icon={<MessageSquare className="w-4 h-4" />}
              >
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">
                    Leave instructions or context for the billing manager (e.g. "only charge 2 hours", "confirm with customer before billing"). Saved when you approve or click Save.
                  </p>
                  <textarea
                    className="w-full rounded-md border border-gray-200 bg-white text-sm px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-amber-400 placeholder-gray-400"
                    rows={3}
                    value={managerBillingNotesLocal}
                    onChange={(e) => setManagerBillingNotesLocal(e.target.value)}
                    onBlur={saveManagerBillingNotes}
                    placeholder="Add billing instructions for the billing manager…"
                    data-testid="manager-billing-notes-input"
                  />
                  {patchRecordMutation.isPending && (
                    <p className="text-xs text-gray-400 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                    </p>
                  )}
                </div>
              </SectionCard>
            )}

            {/* Financial Summary */}
            {canSeePricing && totalAmount && parseFloat(String(totalAmount)) > 0 && (
              <SectionCard title="Financial Summary" icon={<DollarSign className="w-4 h-4" />}>
                <div className="space-y-2">
                  {partsSubtotal && (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-gray-600">Parts Subtotal</span>
                      <span className="font-medium text-gray-900">{currency(partsSubtotal)}</span>
                    </div>
                  )}
                  {laborSubtotal && (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-gray-600">
                        Labor ({totalHours} hrs{laborRate ? ` × ${currency(laborRate)}/hr` : ""})
                      </span>
                      <span className="font-medium text-gray-900">{currency(laborSubtotal)}</span>
                    </div>
                  )}
                  <Separator />
                  <div className="flex justify-between items-center">
                    <span className="text-base font-bold text-gray-900">Total</span>
                    <span className="text-xl font-bold text-green-700">{currency(totalAmount)}</span>
                  </div>
                </div>
              </SectionCard>
            )}

            {/* Reprice History (Task #212) — managers/admins only.
                 Aligned with the server allowlist (super_admin,
                 company_admin, billing_manager, irrigation_manager). */}
            {canSeeRepriceHistory && (
              <SectionCard title="Reprice History" icon={<History className="w-4 h-4" />}>
                <PricingAuditHistory
                  source={isWorkOrder ? 'work_order' : 'billing_sheet'}
                  parentId={id}
                  enabled={open}
                />
              </SectionCard>
            )}
          </div>

          {/* Approval action row — only when opened from Manager Workspace */}
          {onApproveSuccess && (
            <ApprovalActionRow
              type={type}
              id={id}
              isLocked={isBilledOrInvoiced}
              onSuccess={() => { onOpenChange(false); onApproveSuccess!(); }}
              beforeAction={canEditManagerBillingNotes ? saveManagerBillingNotes : undefined}
            />
          )}

          {/* Footer */}
          <ModalFooter title={title} onClose={() => onOpenChange(false)} />
          </InlineEditProvider>
        </DialogContent>
      </Dialog>

      {/* Parts List Editor */}
      <PartsListEditorDialog
        open={showPartsEditor}
        onOpenChange={setShowPartsEditor}
        type={type}
        id={id}
        initialItems={items}
        canSeePricing={canSeePricing}
        readOnly={isBilledOrInvoiced}
        onSaved={onSaved}
      />

      {/* Lightbox */}
      {lightboxPhoto && (
        <Dialog open={!!lightboxPhoto} onOpenChange={() => setLightboxPhoto(null)}>
          <DialogContent className="w-screen h-screen max-w-none max-h-none p-0 bg-black/95 flex items-center justify-center border-0">
            <button
              onClick={() => setLightboxPhoto(null)}
              className="absolute top-4 right-4 z-50 bg-white/10 hover:bg-white/20 text-white rounded-full p-2 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            {photos.length > 1 && (
              <>
                <button
                  onClick={prevPhoto}
                  className="absolute left-4 z-50 bg-white/10 hover:bg-white/20 text-white rounded-full p-2 transition-colors"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={nextPhoto}
                  className="absolute right-14 z-50 bg-white/10 hover:bg-white/20 text-white rounded-full p-2 transition-colors"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </>
            )}
            <PhotoImage
              photoUrl={lightboxPhoto}
              alt="Full size photo"
              className="max-w-full max-h-full object-contain"
            />
            {photos.length > 1 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-sm">
                {lightboxIndex + 1} / {photos.length}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* Reassign Technician dialog */}
      <Dialog open={showReassignDialog} onOpenChange={setShowReassignDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reassign Technician</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-gray-600">
              Select the correct technician for billing sheet{" "}
              <strong>{bs?.billingNumber}</strong>.
            </p>
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Technician</p>
              <Select
                value={reassignTechId}
                onValueChange={setReassignTechId}
              >
                <SelectTrigger className="w-full" data-testid="select-reassign-tech">
                  <SelectValue placeholder="Select a technician…" />
                </SelectTrigger>
                <SelectContent>
                  {availableTechs.length === 0 && (
                    <SelectItem value="_none" disabled>No technicians found</SelectItem>
                  )}
                  {availableTechs.map((tech) => (
                    <SelectItem key={tech.id} value={String(tech.id)}>
                      {tech.name}
                      {tech.id === bs?.technicianId && " (current)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReassignDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const newId = parseInt(reassignTechId);
                if (!isNaN(newId) && newId > 0) {
                  reassignMutation.mutate({ technicianId: newId });
                }
              }}
              disabled={
                !reassignTechId ||
                reassignTechId === (bs?.technicianId?.toString() ?? "") ||
                reassignMutation.isPending
              }
              data-testid="button-confirm-reassign-technician"
            >
              {reassignMutation.isPending ? "Reassigning…" : "Confirm Reassignment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* No Photos Needed confirmation */}
      <AlertDialog
        open={confirmNoPhotosNeeded}
        onOpenChange={(open) => { if (!open) setConfirmNoPhotosNeeded(false); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as 'No Photos Needed'</AlertDialogTitle>
            <AlertDialogDescription>
              Mark this billing sheet as not needing photos? It will be removed from the missing-photos report.
              {bs ? (
                <span className="block mt-2 text-gray-700">
                  <strong>{bs.billingNumber}</strong>
                  {bs.customerName ? ` — ${bs.customerName}` : ''}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-no-photos-needed">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmNoPhotosNeeded(false);
                noPhotosNeededMutation.mutate();
              }}
              data-testid="button-confirm-no-photos-needed"
            >
              Mark as not needed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Photo remove confirmation */}
      <Dialog open={photoToRemove !== null} onOpenChange={() => setPhotoToRemove(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove this photo?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            This photo will be removed from this billing sheet. This cannot be undone.
          </p>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setPhotoToRemove(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleConfirmRemovePhoto}
              disabled={updatePhotos.isPending}
              data-testid="button-confirm-remove-photo"
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
