import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, X } from "lucide-react";
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
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export const QUANTITY_CONFIRM_THRESHOLD = 25;
export const LABOR_HOURS_CONFIRM_THRESHOLD = 4;

interface QuantityLineItem {
  findingId: number;
  quantity: number;
  unitPrice: string;
  partsTotal: string;
  noPartNeeded: boolean;
  /** Catalog default labor per unit, supplied by the shared view assembler. */
  catalogLaborHours?: string;
  laborHours: string;
}

export interface FindingQuantityEditInlineProps {
  wcbId: number;
  item: QuantityLineItem;
  zoneLabel: string;
  zoneLaborHours: string;
  laborRate: string;
  allItems: QuantityLineItem[];
  canEdit: boolean;
  laborWasManual: boolean;
  billingSheetId?: number;
}

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

const numberValue = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
};

function resultingValues(
  item: QuantityLineItem,
  allItems: QuantityLineItem[],
  nextQuantity: number,
  laborRate: string,
) {
  const parts = allItems.reduce((sum, line) => {
    const quantity = line.findingId === item.findingId ? nextQuantity : line.quantity;
    return sum + (line.noPartNeeded ? 0 : numberValue(line.unitPrice) * quantity);
  }, 0);
  const hours = allItems.reduce((sum, line) => {
    const quantity = line.findingId === item.findingId ? nextQuantity : line.quantity;
    const perUnit = numberValue(line.catalogLaborHours ?? line.laborHours);
    const catalogQuantity = Number.isInteger(quantity) && quantity >= 1 ? quantity : 1;
    return sum + perUnit * catalogQuantity;
  }, 0);
  return { parts, hours, labor: hours * numberValue(laborRate) };
}

export function FindingQuantityEditInline({
  wcbId,
  item,
  zoneLabel,
  zoneLaborHours,
  laborRate,
  allItems,
  canEdit,
  laborWasManual,
  billingSheetId,
}: FindingQuantityEditInlineProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [localQuantity, setLocalQuantity] = useState(String(item.quantity));
  const [confirmationQuantity, setConfirmationQuantity] = useState<number | null>(null);

  useEffect(() => {
    setLocalQuantity(String(item.quantity));
  }, [item.quantity]);

  const currentHours = numberValue(zoneLaborHours);
  const nextQuantity = Number(localQuantity);
  function invalidateAfterSave() {
    queryClient.invalidateQueries({ queryKey: ["/api/wet-check-billings", wcbId] });
    queryClient.invalidateQueries({ queryKey: ["/api/wet-check-billings"] });
    queryClient.invalidateQueries({ queryKey: ["/api/customers/billing-preview"] });
    queryClient.invalidateQueries({
      queryKey: [`/api/wet-check-billings/${wcbId}/activity`],
    });
    if (billingSheetId != null) {
      queryClient.invalidateQueries({
        queryKey: ["/api/billing-sheets", billingSheetId, "wet-check-view"],
      });
    }
  }

  const saveMutation = useMutation({
    mutationFn: (quantity: number) =>
      apiRequest(`/api/wet-check-billings/${wcbId}/finding-quantity`, "PATCH", {
        findingId: item.findingId,
        quantity,
      }),
    onSuccess: () => {
      setEditing(false);
      setConfirmationQuantity(null);
      invalidateAfterSave();
    },
    onError: (error: any) => {
      toast({
        title: "Couldn't save quantity",
        description: error?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (item.noPartNeeded) {
    return <span data-testid={`finding-quantity-readonly-${item.findingId}`}>—</span>;
  }

  if (!canEdit) {
    return <span data-testid={`finding-quantity-readonly-${item.findingId}`}>{item.quantity}</span>;
  }

  function requestSave() {
    if (!Number.isInteger(nextQuantity) || nextQuantity < 1 || nextQuantity > 999) {
      toast({
        title: "Invalid quantity",
        description: "Enter a whole number from 1 through 999.",
        variant: "destructive",
      });
      return;
    }
    if (nextQuantity === item.quantity) {
      setEditing(false);
      return;
    }

    const nextValues = resultingValues(item, allItems, nextQuantity, laborRate);
    const requiresConfirmation =
      nextQuantity > QUANTITY_CONFIRM_THRESHOLD ||
      Math.abs(nextValues.hours - currentHours) > LABOR_HOURS_CONFIRM_THRESHOLD;
    if (requiresConfirmation) {
      setConfirmationQuantity(nextQuantity);
      return;
    }
    saveMutation.mutate(nextQuantity);
  }

  const confirmationValues = confirmationQuantity == null
    ? null
    : resultingValues(item, allItems, confirmationQuantity, laborRate);

  return (
    <>
      {editing ? (
        <span className="inline-flex flex-col items-center gap-1">
          <span className="inline-flex items-center gap-1">
            <input
              type="number"
              min={1}
              max={999}
              step={1}
              value={localQuantity}
              onChange={(event) => setLocalQuantity(event.target.value)}
              disabled={saveMutation.isPending}
              className="w-16 rounded border border-blue-300 px-1.5 py-1 text-center text-sm"
              data-testid={`finding-quantity-input-${item.findingId}`}
              aria-label={`Quantity for ${item.findingId}`}
            />
            <button
              type="button"
              onClick={requestSave}
              disabled={saveMutation.isPending}
              className="rounded p-1 text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"
              data-testid={`finding-quantity-save-${item.findingId}`}
              aria-label="Save quantity"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => { setLocalQuantity(String(item.quantity)); setEditing(false); }}
              disabled={saveMutation.isPending}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50"
              data-testid={`finding-quantity-cancel-${item.findingId}`}
              aria-label="Cancel quantity edit"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
          {laborWasManual && (
            <span
              className="max-w-44 text-[10px] leading-tight text-amber-700"
              data-testid={`finding-quantity-manual-warning-${item.findingId}`}
            >
              Saving replaces the manual zone labor with the catalog calculation.
            </span>
          )}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <span data-testid={`finding-quantity-${item.findingId}`}>{item.quantity}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            data-testid={`finding-quantity-pencil-${item.findingId}`}
            aria-label={`Edit quantity for ${item.findingId}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </span>
      )}

      <AlertDialog
        open={confirmationQuantity != null}
        onOpenChange={(open) => { if (!open && !saveMutation.isPending) setConfirmationQuantity(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm quantity correction</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Update Zone {zoneLabel} from quantity {item.quantity} to {confirmationQuantity}?
                </p>
                {confirmationValues && (
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                    <div>Resulting parts: <strong>{money(confirmationValues.parts)}</strong></div>
                    <div>Resulting zone labor: <strong>{confirmationValues.hours.toFixed(2)} hours</strong></div>
                    <div>Resulting labor dollars: <strong>{money(confirmationValues.labor)}</strong></div>
                  </div>
                )}
                <p className="text-amber-700">
                  This recalculates catalog labor for the zone.
                </p>
                {laborWasManual && (
                  <p className="text-amber-700">
                    The existing manual labor value will be replaced by the catalog calculation.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (confirmationQuantity != null) saveMutation.mutate(confirmationQuantity); }}
              disabled={saveMutation.isPending}
              data-testid={`finding-quantity-confirm-${item.findingId}`}
            >
              {saveMutation.isPending ? "Saving…" : "Confirm correction"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
