import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, Pencil, Trash2 } from "lucide-react";
import { WetCheckBillingViewComponent } from "@/components/billing/wet-check-billing-view";
import type { WetCheckBillingView } from "@/components/billing/wet-check-billing-view";
import type { WetCheckBilling } from "@workspace/db/schema";
import { safeGet } from "@/utils/safeStorage";
import { WcbLaborRateEdit } from "./wcb-labor-rate-edit";
import { ActivityFeed } from "@/components/billing-workspace/activity-feed";
import { RateModeToggle } from "@/components/billing-workspace/rate-mode-toggle";
import { canEditWetCheckBillingFields } from "./wet-check-billing-permissions";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUserRole(): string | null {
  try {
    const raw = safeGet("user");
    if (!raw) return null;
    return JSON.parse(raw)?.role ?? null;
  } catch {
    return null;
  }
}

function canSeePricing(): boolean {
  const role = getUserRole();
  return role !== "field_tech";
}

/**
 * Returns true when the current user can delete an unbilled WCB.
 * Requires billing_manager or company_admin role AND no invoiceId on the WCB.
 */
function canDeleteWcb(wcb: WetCheckBilling): boolean {
  const role = getUserRole();
  if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin") return false;
  return wcb.invoiceId == null;
}

// ── Edit affordances panel (Task #977 / #1027 / #1093) ──────────────────────
// Shown only for billing_manager+ on unlocked (not billed / invoiced) WCBs.
// Contains labor rate editor and rate-mode toggle.

function EditAffordancesPanel({
  wcb,
  onLabourSaved,
  initialAction,
}: {
  wcb: WetCheckBilling & { customer?: { laborRate?: string | null; emergencyLaborRate?: string | null } | null };
  onLabourSaved: () => void;
  initialAction?: "labor-rate" | "zone-labor";
}) {
  const [editingLaborRate, setEditingLaborRate] = useState(initialAction === "labor-rate");

  const currentRate = String(wcb.laborRate ?? "0");
  const rateMode = (wcb as any).rateMode ?? "normal";
  const customerRates = wcb.customer;

  return (
    <div className="space-y-3" data-testid="wcb-edit-affordances">
      {/* Task #1093 — Rate mode toggle */}
      {customerRates && (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <RateModeToggle
            entityPath="wet-check-billings"
            entityId={wcb.id}
            currentMode={rateMode as "normal" | "emergency"}
            normalRate={customerRates.laborRate ?? null}
            emergencyRate={customerRates.emergencyLaborRate ?? null}
            detailQueryKey={["/api/wet-check-billings", wcb.id]}
            disabled={false}
          />
        </div>
      )}
      {/* Labor rate row */}
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Labor Rate</span>
            <span
              className="text-sm text-gray-900 font-semibold"
              data-testid="wcb-labor-rate-display"
            >
              ${parseFloat(currentRate).toFixed(2)}/hr
            </span>
          </div>
          {!editingLaborRate && (
            <button
              type="button"
              onClick={() => setEditingLaborRate(true)}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
              data-testid="wcb-labor-rate-pencil"
              aria-label="Edit labor rate"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {editingLaborRate && (
          <div className="mt-3">
            <WcbLaborRateEdit
              wcbId={wcb.id}
              currentRate={currentRate}
              onSuccess={onLabourSaved}
              onClose={() => setEditingLaborRate(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface WetCheckBillingViewModalProps {
  wetCheckBillingId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialAction?: "labor-rate" | "zone-labor";
}

export function WetCheckBillingViewModal({
  wetCheckBillingId,
  open,
  onOpenChange,
  initialAction,
}: WetCheckBillingViewModalProps) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading, isError } = useQuery<{
    wetCheckBilling: WetCheckBilling;
    customer: { laborRate: string | null; emergencyLaborRate: string | null } | null;
    view: WetCheckBillingView | null;
  }>({
    queryKey: ["/api/wet-check-billings", wetCheckBillingId],
    queryFn: () => apiRequest(`/api/wet-check-billings/${wetCheckBillingId}`),
    enabled: open,
  });

  // customer rates live at top level of the envelope (moved from wcb.customer
  // to avoid coupling the WetCheckBilling DB type to UI-only rate fields).
  const wcb = data?.wetCheckBilling
    ? { ...data.wetCheckBilling, customer: data.customer ?? undefined }
    : undefined;
  const view = data?.view ?? null;
  const canEditSnapshotFields = !!wcb && canEditWetCheckBillingFields(getUserRole(), wcb);
  const showEditAffordances = !!view && canEditSnapshotFields;

  function handleViewOriginating(e: React.MouseEvent) {
    e.preventDefault();
    if (!wcb) return;
    onOpenChange(false);
    navigate(`/wet-checks/${wcb.wetCheckId}?from=wet-check-billings`);
  }

  function handleLaborSaved() {
    queryClient.invalidateQueries({ queryKey: ["/api/wet-check-billings", wetCheckBillingId] });
    queryClient.invalidateQueries({ queryKey: ["/api/wet-check-billings"] });
    queryClient.invalidateQueries({ queryKey: ["/api/customers/billing-preview"] });
    // Task #1097 — refresh the activity feed after a labor-rate save.
    queryClient.invalidateQueries({
      queryKey: [`/api/wet-check-billings/${wetCheckBillingId}/activity`],
    });
  }

  async function handleDeleteConfirm() {
    if (!wcb) return;
    setDeleting(true);
    try {
      await apiRequest(`/api/wet-check-billings/${wcb.id}`, "DELETE");
      queryClient.invalidateQueries({ queryKey: ["/api/wet-check-billings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/billing-preview"] });
      setDeleteConfirmOpen(false);
      onOpenChange(false);
    } catch (err: any) {
      setDeleting(false);
      const msg = err?.message ?? "Failed to delete WC Snapshot. Please retry.";
      alert(msg);
    }
  }

  const appliedRate = String(wcb?.appliedLaborRate ?? wcb?.laborRate ?? "0");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle data-testid="wcb-modal-title">
              {wcb ? wcb.billingNumber : <Skeleton className="h-6 w-40" />}
            </DialogTitle>
            <DialogDescription data-testid="wcb-modal-subtitle">
              {wcb ? (
                <>
                  {wcb.customerName}
                  {wcb.propertyAddress ? ` · ${wcb.propertyAddress}` : ""}
                </>
              ) : (
                <Skeleton className="h-4 w-64 mt-1" />
              )}
            </DialogDescription>
          </DialogHeader>

          {/* View originating wet check link */}
          {wcb && (
            <div className="mb-2">
              <Button
                variant="link"
                className="p-0 h-auto text-blue-600 hover:text-blue-800 text-sm"
                onClick={handleViewOriginating}
                data-testid="wcb-modal-originating-link"
              >
                <ExternalLink className="w-3.5 h-3.5 mr-1" />
                View originating wet check
              </Button>
            </div>
          )}

          {/* Body */}
          <div className="mt-1 space-y-4">
            {isLoading && (
              <div className="space-y-3">
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}

            {isError && (
              <p className="text-sm text-red-600 py-4 text-center" data-testid="wcb-modal-error">
                Failed to load wet check billing details.
              </p>
            )}

            {!isLoading && !isError && view && wcb && (
              <>
                {/* Task #977 — billing-manager edit affordances (labor rate) for unlocked WCBs */}
                {showEditAffordances && (
                  <EditAffordancesPanel
                    wcb={wcb}
                    onLabourSaved={handleLaborSaved}
                    initialAction={initialAction}
                  />
                )}
                {/* Task #1027 — zone labor inline editing wired through view props */}
                <WetCheckBillingViewComponent
                  view={view}
                  canSeePricing={canSeePricing()}
                  wcbId={wcb.id}
                  canEditLabor={canEditSnapshotFields}
                  canEditQuantity={canEditSnapshotFields}
                  laborRate={appliedRate}
                />
                {/* Task #1097 — activity log for this WCB */}
                <ActivityFeed url={`/api/wet-check-billings/${wcb.id}/activity`} />
              </>
            )}

            {!isLoading && !isError && wcb && !view && (
              <p className="text-sm text-gray-500 py-4 text-center italic">
                No zone-grouped view available for this billing yet.
              </p>
            )}
          </div>

          <DialogFooter className="flex-col-reverse sm:flex-row gap-2 sm:justify-between">
            {/* Delete WC Snapshot — visible only to billing_manager+ on unbilled WCBs */}
            {wcb && canDeleteWcb(wcb) ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteConfirmOpen(true)}
                data-testid="wcb-modal-delete-btn"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Delete WC Snapshot
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="wcb-modal-close"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm dialog — mounted outside the main Dialog to avoid nesting issues */}
      {wcb && (
        <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete WC Snapshot?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete <strong>{wcb.billingNumber}</strong> and clear all
                finding links (billing references, conversion timestamps, and resolutions will be
                reset to <em>pending</em>). The originating wet check will become deletable again.
                <br /><br />
                This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="wcb-modal-delete-confirm"
              >
                {deleting ? "Deleting…" : "Delete WC Snapshot"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
