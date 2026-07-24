import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Plus,
  Trash2,
  Pencil,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Package,
  Minus,
  ChevronLeft,
} from "lucide-react";
import type { Part } from "@workspace/db/schema";
import { PartPicker } from "@/components/parts/part-picker";

// Task #399 — shared default so the helper text in this file, the review
// step, and the parent wizard's `deriveCustomerLaborRate` can never drift
// apart if the company-wide fallback ever changes.
export const DEFAULT_LABOR_RATE = 45;

// Task #399 — discriminator for where the active labor rate originated.
// * "customer" — the selected customer has a valid master rate and the
//   wizard is using it.
// * "default"  — the customer has no master rate; we're using the system
//   fallback (`DEFAULT_LABOR_RATE`).
// * "stored"   — edit mode for an existing estimate whose stored rate
//   differs from the customer's current master rate. The server will
//   snap it back to the master rate on save (or on a customer swap).
export type LaborRateSource = "customer" | "default" | "stored";

export interface WizardLineItem {
  rowId: string;
  // Null when the line item came from an inspection finding that had no
  // catalog part assigned yet (e.g. a $0 documentation-only finding).
  // The wizard allows saving and approving these as-is, or the manager
  // can click the part name cell to assign a catalog part before approval.
  partId: number | null;
  partName: string;
  partPrice: number;
  // Task #1827 — tracks whether the manager has manually typed a price
  // override. When true, part re-selection via the picker does NOT clobber
  // the typed value. False (default) means the price is still catalog-derived
  // and a part re-select is safe to update it.
  priceManuallySet?: boolean;
  quantity: number;
  // Task #657 — Per-row labor entry is gone from the estimate wizard;
  // labor is captured as a single flat "Total labor hours" value at the
  // estimate level. The field is kept on the shape so the autosave
  // draft + edit-mode hydration paths can ferry a zero through without
  // diff churn; nothing in the UI reads or writes it anymore.
  laborHours: number;
  description: string;
}

export interface RunningTotals {
  partsSubtotal: number;
  laborSubtotal: number;
  totalAmount: number;
  totalLaborHours: number;
}

interface EstimateWizardLineItemsStepProps {
  customerName: string;
  projectName: string;
  laborRate: number;
  // Task #399 — origin of the active labor rate. Drives a small helper line
  // so managers know typing a different value here will be silently
  // overridden on save by the customer's master rate.
  laborRateSource: LaborRateSource;
  // When `laborRateSource === "stored"`, this is the customer's current
  // master rate that the server will snap back to on save. Ignored
  // otherwise.
  customerMasterRate?: number;
  items: WizardLineItem[];
  onItemsChange: (next: WizardLineItem[]) => void;
  onBack: () => void;
  onContinue: () => void;
  onChangeCustomer?: () => void;
  // Task #657 — Flat-only labor: a single "Total labor hours" field at
  // the estimate level. Per-row labor entry has been removed.
  flatTotalHours: number;
  onFlatTotalHoursChange: (hours: number) => void;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

// Task #657 — Flat labor only. Per-row labor entry is gone from the
// wizard; labor is computed from the single estimate-level
// `flatTotalHours` field × the customer labor rate. The signature
// keeps `flatTotalHours` as a trailing optional so existing callers
// don't need to pass it when they only care about parts totals.
export function computeTotals(
  items: WizardLineItem[],
  laborRate: number,
  flatTotalHours = 0,
): RunningTotals {
  const partsSubtotal = items.reduce((s, it) => s + it.partPrice * it.quantity, 0);
  const totalLaborHours = Math.max(0, flatTotalHours);
  const laborSubtotal = totalLaborHours * laborRate;
  return {
    partsSubtotal,
    laborSubtotal,
    totalAmount: partsSubtotal + laborSubtotal,
    totalLaborHours,
  };
}

function makeRowId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function EstimateWizardLineItemsStep({
  customerName,
  projectName,
  laborRate,
  laborRateSource,
  customerMasterRate,
  items,
  onItemsChange,
  onBack,
  onContinue,
  onChangeCustomer,
  flatTotalHours,
  onFlatTotalHoursChange,
}: EstimateWizardLineItemsStepProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"add" | "change">("add");
  const [changeRowId, setChangeRowId] = useState<string | null>(null);
  const [dragRowId, setDragRowId] = useState<string | null>(null);

  const totals = computeTotals(items, laborRate, flatTotalHours);

  const updateItem = (rowId: string, patch: Partial<WizardLineItem>) =>
    onItemsChange(items.map((it) => (it.rowId === rowId ? { ...it, ...patch } : it)));

  const removeItem = (rowId: string) => onItemsChange(items.filter((it) => it.rowId !== rowId));

  const moveItem = (rowId: string, dir: -1 | 1) => {
    const idx = items.findIndex((it) => it.rowId === rowId);
    if (idx < 0) return;
    const next = [...items];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onItemsChange(next);
  };

  const handlePartPicked = (part: Part) => {
    if (pickerMode === "change" && changeRowId) {
      const existing = items.find((it) => it.rowId === changeRowId);
      // Task #1827 — no-clobber: only update price from catalog when the
      // manager has NOT yet typed a manual override on this row.
      const catalogPrice = parseFloat(String(part.price ?? "0")) || 0;
      const priceUpdate = existing?.priceManuallySet
        ? {}
        : { partPrice: catalogPrice };
      updateItem(changeRowId, {
        partId: part.id,
        partName: part.name,
        ...priceUpdate,
      });
      setChangeRowId(null);
    } else {
      onItemsChange([
        ...items,
        {
          rowId: makeRowId(),
          partId: part.id,
          partName: part.name,
          partPrice: parseFloat(String(part.price ?? "0")) || 0,
          priceManuallySet: false,
          quantity: 1,
          // Parts catalog has no per-part labor hours; tech enters labor inline.
          laborHours: 0,
          description: "",
        },
      ]);
    }
  };

  const openAdd = () => {
    setPickerMode("add");
    setChangeRowId(null);
    setPickerOpen(true);
  };

  const openChange = (rowId: string) => {
    setPickerMode("change");
    setChangeRowId(rowId);
    setPickerOpen(true);
  };

  // Native HTML5 drag-and-drop reorder on desktop. We keep `onDragOver` as a
  // no-op preventDefault (required for drop targets) and only commit the
  // splice on `onDrop`, so hovering between rows never thrashes the list.
  const onDragStart = (rowId: string) => () => setDragRowId(rowId);
  const onDragOver = () => (e: React.DragEvent) => {
    e.preventDefault();
  };
  const onDrop = (rowId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragRowId || dragRowId === rowId) return;
    const fromIdx = items.findIndex((i) => i.rowId === dragRowId);
    const toIdx = items.findIndex((i) => i.rowId === rowId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...items];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    onItemsChange(next);
  };
  const onDragEnd = () => setDragRowId(null);

  const empty = items.length === 0;

  return (
    <div className="space-y-4">
      {/* Sticky strip: customer/project + running total */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-3 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85 border-b sm:mx-0 sm:px-0 sm:border-0 sm:bg-transparent sm:backdrop-blur-0 sm:static">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-stretch">
          <Card className="sm:col-span-2 border-l-4 border-l-blue-500">
            <CardContent className="p-3 sm:p-4 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-xs uppercase tracking-wide text-gray-500">For</div>
                <div className="text-sm font-semibold text-gray-900 truncate" data-testid="wizard-strip-customer">
                  {customerName || "—"}
                </div>
                <div className="text-xs text-gray-600 truncate">{projectName || "Untitled project"}</div>
              </div>
              {onChangeCustomer && (
                <button
                  type="button"
                  onClick={onChangeCustomer}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium inline-flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded shrink-0"
                  data-testid="wizard-strip-change-customer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Change customer
                </button>
              )}
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-green-500">
            <CardContent className="p-3 sm:p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Running total</div>
              <div className="grid grid-cols-3 gap-2 mt-1 items-end">
                <div>
                  <div className="text-[10px] text-gray-500 uppercase">Parts</div>
                  <div className="text-sm font-semibold text-gray-900" data-testid="wizard-total-parts">
                    {fmt(totals.partsSubtotal)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-500 uppercase">Labor</div>
                  <div className="text-sm font-semibold text-gray-900" data-testid="wizard-total-labor">
                    {fmt(totals.laborSubtotal)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-green-700 uppercase font-semibold">Total</div>
                  <div className="text-base font-bold text-green-700" data-testid="wizard-total-amount">
                    {fmt(totals.totalAmount)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Task #657 — Flat-only labor: single Total labor hours field. */}
      <Card>
        <CardContent className="p-3 sm:p-4 space-y-3">
          {/* Task #399 — surface where the labor rate comes from so managers
              don't try to override a value that the server will reset to the
              customer's master labor rate on save. */}
          <div
            className="text-xs text-gray-600 flex flex-wrap items-center gap-x-1"
            data-testid="estimate-labor-rate-source"
            data-source={laborRateSource}
          >
            <span className="font-medium text-gray-700">Labor rate:</span>
            <span className="font-semibold text-gray-900">{fmt(laborRate)}/hr</span>
            <span className="text-gray-500">
              {laborRateSource === "customer" && (
                <>
                  — from{" "}
                  <span className="font-medium text-gray-700">
                    {customerName || "this customer"}
                  </span>
                  's master rate. Change it on the customer record to update
                  future estimates.
                </>
              )}
              {laborRateSource === "default" && (
                <>
                  — default fallback ({fmt(DEFAULT_LABOR_RATE)}/hr). Set a
                  labor rate on the customer record to override this for
                  future estimates.
                </>
              )}
              {laborRateSource === "stored" && (
                <>
                  — stored from a previous save. Will reset to{" "}
                  <span className="font-medium text-gray-700">
                    {customerName || "this customer"}
                  </span>
                  's current master rate
                  {typeof customerMasterRate === "number"
                    ? ` (${fmt(customerMasterRate)}/hr)`
                    : ""}{" "}
                  on save.
                </>
              )}
            </span>
          </div>
          <div className="flex items-end gap-3 flex-wrap pt-1">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                Total labor hours
              </div>
              <Input
                type="number"
                min={0}
                step={0.25}
                value={flatTotalHours}
                onChange={(e) =>
                  onFlatTotalHoursChange(Math.max(0, parseFloat(e.target.value || "0") || 0))
                }
                className="h-9 w-32 focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                data-testid="estimate-flat-total-hours"
              />
            </div>
            <div className="text-xs text-gray-600 mb-1">
              × {fmt(laborRate)}/hr ={" "}
              <span className="font-semibold text-gray-900">
                {fmt(totals.laborSubtotal)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Add Part button */}
      <div className="flex items-center justify-between">
        <Button
          type="button"
          onClick={openAdd}
          className="bg-blue-600 hover:bg-blue-700 text-white focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          data-testid="wizard-add-part"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Part
        </Button>
        {!empty && (
          <div className="text-xs text-gray-500">
            {items.length} item{items.length === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* Empty state */}
      {empty && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-3">
            <div className="bg-blue-50 p-4 rounded-full">
              <Package className="w-8 h-8 text-blue-600" />
            </div>
            <div>
              <div className="text-base font-semibold text-gray-900">No parts yet</div>
              <p className="text-sm text-gray-500 mt-1">Add a part from the catalog to start the estimate.</p>
            </div>
            <Button
              type="button"
              onClick={openAdd}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="wizard-add-part-empty"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Part
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Desktop table */}
      {!empty && (
        <div className="hidden md:block">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="w-8 py-2"></th>
                    <th className="py-2 pl-2">Part</th>
                    <th className="py-2 px-2 w-28">Qty</th>
                    <th className="py-2 px-2 w-28 text-right">Unit Price</th>
                    <th className="py-2 px-2 w-28 text-right">Line Total</th>
                    <th className="py-2 pr-2 w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => {
                    // Task #657 — line totals are parts-only; labor is
                    // owned by the single Total labor hours field.
                    const lineTotal = it.partPrice * it.quantity;
                    return (
                      <tr
                        key={it.rowId}
                        className="border-b last:border-b-0 align-top"
                        draggable
                        onDragStart={onDragStart(it.rowId)}
                        onDragOver={onDragOver()}
                        onDrop={onDrop(it.rowId)}
                        onDragEnd={onDragEnd}
                        data-testid={`wizard-row-${it.rowId}`}
                      >
                        <td className="py-3 pl-2 text-gray-400 align-middle cursor-move">
                          <GripVertical className="w-4 h-4" />
                        </td>
                        <td className="py-3 pl-2 pr-2">
                          <button
                            type="button"
                            onClick={() => openChange(it.rowId)}
                            className="font-medium hover:text-blue-700 inline-flex items-center gap-1 group focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded"
                            data-testid={`wizard-row-change-${it.rowId}`}
                          >
                            {it.partName ? (
                              <span className="text-gray-900">{it.partName}</span>
                            ) : (
                              <span className="text-amber-600 italic text-sm">
                                No part — click to assign
                              </span>
                            )}
                            <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 text-gray-400" />
                          </button>
                          <Input
                            value={it.description}
                            onChange={(e) => updateItem(it.rowId, { description: e.target.value })}
                            placeholder="Description (optional)"
                            className="mt-1 h-8 text-xs focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                          />
                        </td>
                        <td className="py-3 px-2">
                          <div className="inline-flex items-center border rounded-md">
                            <button
                              type="button"
                              className="p-1 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded-l"
                              onClick={() => updateItem(it.rowId, { quantity: Math.max(1, it.quantity - 1) })}
                              aria-label="Decrease quantity"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <Input
                              type="number"
                              min={1}
                              value={it.quantity}
                              onChange={(e) =>
                                updateItem(it.rowId, { quantity: Math.max(1, parseInt(e.target.value || "1") || 1) })
                              }
                              className="h-7 w-12 text-center border-0 px-0 focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                              data-testid={`wizard-row-qty-${it.rowId}`}
                            />
                            <button
                              type="button"
                              className="p-1 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded-r"
                              onClick={() => updateItem(it.rowId, { quantity: it.quantity + 1 })}
                              aria-label="Increase quantity"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                        <td className="py-3 px-2 text-right">
                          <Input
                            type="number"
                            min={0}
                            step={0.01}
                            value={it.partPrice}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value || "0");
                              updateItem(it.rowId, {
                                partPrice: isNaN(val) ? 0 : Math.max(0, val),
                                priceManuallySet: true,
                              });
                            }}
                            className="h-8 w-24 text-right [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ml-auto"
                            data-testid={`wizard-row-price-${it.rowId}`}
                            aria-label="Unit price"
                          />
                        </td>
                        <td
                          className="py-3 px-2 text-right font-semibold text-gray-900"
                          data-testid={`wizard-row-total-${it.rowId}`}
                        >
                          {fmt(lineTotal)}
                        </td>
                        <td className="py-3 pr-2 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeItem(it.rowId)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            data-testid={`wizard-row-delete-${it.rowId}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Mobile cards */}
      {!empty && (
        <div className="md:hidden space-y-3">
          {items.map((it, idx) => {
            const lineTotal = it.partPrice * it.quantity;
            return (
              <Card key={it.rowId} data-testid={`wizard-card-${it.rowId}`}>
                <CardContent className="p-3 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => openChange(it.rowId)}
                      className="text-left font-semibold hover:text-blue-700 inline-flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded"
                    >
                      {it.partName ? (
                        <span className="text-gray-900">{it.partName}</span>
                      ) : (
                        <span className="text-amber-600 italic text-sm font-medium">
                          No part — tap to assign
                        </span>
                      )}
                      <Pencil className="w-3 h-3 text-gray-400" />
                    </button>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => moveItem(it.rowId, -1)}
                        disabled={idx === 0}
                        aria-label="Move up"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => moveItem(it.rowId, 1)}
                        disabled={idx === items.length - 1}
                        aria-label="Move down"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  <Input
                    value={it.description}
                    onChange={(e) => updateItem(it.rowId, { description: e.target.value })}
                    placeholder="Description (optional)"
                    className="h-9 text-sm focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                  />
                  <div className="grid grid-cols-2 max-[400px]:grid-cols-1 gap-2">
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase mb-1">Qty</div>
                      <div className="inline-flex items-center border rounded-md">
                        <button
                          type="button"
                          className="p-2 hover:bg-gray-50"
                          onClick={() => updateItem(it.rowId, { quantity: Math.max(1, it.quantity - 1) })}
                          aria-label="Decrease quantity"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <Input
                          type="number"
                          min={1}
                          value={it.quantity}
                          onChange={(e) =>
                            updateItem(it.rowId, { quantity: Math.max(1, parseInt(e.target.value || "1") || 1) })
                          }
                          className="h-8 w-12 text-center border-0 px-0 focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                        <button
                          type="button"
                          className="p-2 hover:bg-gray-50"
                          onClick={() => updateItem(it.rowId, { quantity: it.quantity + 1 })}
                          aria-label="Increase quantity"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase mb-1">Unit price</div>
                      <Input
                        type="number"
                        min={0}
                        step={0.01}
                        value={it.partPrice}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value || "0");
                          updateItem(it.rowId, {
                            partPrice: isNaN(val) ? 0 : Math.max(0, val),
                            priceManuallySet: true,
                          });
                        }}
                        className="h-9 text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        data-testid={`wizard-card-price-${it.rowId}`}
                        aria-label="Unit price"
                      />
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase mb-1">Line total</div>
                      <div className="h-9 px-3 flex items-center text-sm font-semibold text-gray-900 bg-gray-50 border rounded-md">
                        {fmt(lineTotal)}
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeItem(it.rowId)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      Remove
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Desktop footer (mobile uses sheet footer) */}
      <div className="hidden sm:flex justify-between items-center gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onBack} data-testid="wizard-back-2">
          ← Back
        </Button>
        <div className="flex items-center gap-3">
          {empty && (
            <span className="text-xs text-gray-500" data-testid="wizard-continue-2-helper">
              Add at least one part to continue.
            </span>
          )}
          <Button
            type="button"
            onClick={onContinue}
            disabled={empty}
            className="bg-blue-600 hover:bg-blue-700 text-white"
            data-testid="wizard-continue-2"
          >
            Continue to Review
          </Button>
        </div>
      </div>

      <PartPicker
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) setChangeRowId(null);
        }}
        onSelectPart={handlePartPicked}
        presentation="sheet"
        selectMode={pickerMode === "add" ? "multi" : "single"}
        showCategoryChips
        keyboardNav
        title={pickerMode === "add" ? "Add part" : "Change part"}
      />
    </div>
  );
}
