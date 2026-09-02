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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  FileText,
  Loader2,
  Receipt,
  User,
  Mail,
  Phone,
  Building2,
  Calendar,
  Pencil,
  Package,
  Plus,
  Trash2,
  Search,
  Camera,
  Calculator,
  Check,
} from "lucide-react";
import { CustomerSelector } from "@/components/ui/customer-selector";
import { FileUpload, type UploadedFile } from "@/components/ui/file-upload";
import { PhotoImage } from "@/components/ui/photo-image";
import { AiExpandButton, AiSuggestionCard } from "@/components/ui/ai-expand-button";
import { PartPicker } from "@/components/parts/part-picker";
import {
  CustomerLocationStep,
  type CustomerLocationValue,
  type WorkLocation,
} from "@/components/location/customer-location-step";

import { WizardSummaryStrip } from "@/components/work-orders/wizard/wo-summary-strip";
import { WizardHeader } from "@/components/wizard-shared/wizard-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, useArrayQuery } from "@/lib/queryClient";
import { safeGet } from "@/utils/safeStorage";
import type {
  Customer,
  Part,
  BillingSheet,
  BillingSheetItem,
  FieldWorkType,
} from "@workspace/db/schema";
import {
  canContinueFromLocationStep,
  shouldEnforceWizardLocationGate,
} from "@/components/billing/billing-sheet-wizard-gate";

type WizardLocationValue = CustomerLocationValue;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BillingSheetWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  /** Edit mode: numeric id → fetch + open on Step 2. */
  billingSheetId?: number | null;
  /** Edit mode (legacy): full draft object → hydrate immediately, no fetch. */
  draftData?: (BillingSheet & { items?: BillingSheetItem[] }) | null;
  /** Optional prefill (e.g. from a customer page). */
  prefillFromWorkOrder?: {
    customerId?: number;
    customerName?: string;
    propertyAddress?: string;
  };
}

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_TITLES: Record<Step, string> = {
  1: "Customer & Work Date",
  2: "Work Location & Site",
  3: "Parts & Labor",
  4: "Description & Photos",
  5: "Review",
};

interface CustomerStepValue {
  customer: Customer | null;
  customerEmail: string;
  customerPhone: string;
  branchName: string;
  workDate: string; // YYYY-MM-DD
}

interface ItemValue {
  partId: number | null;
  partName: string;
  partDescription: string;
  quantity: number;
  unitPrice: number;
  laborHours: number;
  notes: string;
}

interface PartsLaborValue {
  items: ItemValue[];
  totalHours: number;
  // Task #396 — labor mode for the billing sheet. 'flat' uses the
  // single Hours Worked field; 'per_part' sums per-row laborHours×qty.
  laborMode: "flat" | "per_part";
}

interface DescriptionValue {
  workDescription: string;
  notes: string;
  aiInputs: string | null;
  aiShortDescription: string | null;
  aiDetailedDescription: string | null;
}

const blankCustomer = (): CustomerStepValue => ({
  customer: null,
  customerEmail: "",
  customerPhone: "",
  branchName: "",
  workDate: new Date().toISOString().split("T")[0],
});

const blankLocation = (): WizardLocationValue => ({
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

const blankPartsLabor = (): PartsLaborValue => ({
  items: [],
  totalHours: 0,
  laborMode: "flat",
});

const blankDescription = (): DescriptionValue => ({
  workDescription: "",
  notes: "",
  aiInputs: null,
  aiShortDescription: null,
  aiDetailedDescription: null,
});

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);

function urlToUploadedFile(url: string): UploadedFile {
  const fileName = url.split("/").pop() || url;
  return { url, fileName, originalName: fileName };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Customer & Work Date
// ─────────────────────────────────────────────────────────────────────────────

function CustomerDateStep({
  value,
  onChange,
  onContinue,
  onCancel,
  isEdit,
  originalTechnicianName,
}: {
  value: CustomerStepValue;
  onChange: (v: CustomerStepValue) => void;
  onContinue: () => void;
  onCancel: () => void;
  isEdit?: boolean;
  originalTechnicianName?: string;
}) {
  const [showPicker, setShowPicker] = useState(!value.customer);

  const branches: string[] = Array.isArray(value.customer?.branches)
    ? (value.customer!.branches as string[])
    : [];
  const branchRequired = branches.length > 0;

  useEffect(() => {
    if (value.customer) setShowPicker(false);
  }, [value.customer?.id]);

  const handleSelect = (c: Customer) => {
    onChange({
      ...value,
      customer: c,
      customerEmail: c.email ?? "",
      customerPhone: c.phone ?? "",
      branchName: "",
    });
    setShowPicker(false);
  };

  const canContinue =
    !!value.customer &&
    (!branchRequired || !!value.branchName) &&
    !!value.workDate;

  return (
    <div className="space-y-4">
      <Card className={value.customer ? "border-l-4 border-l-blue-500" : ""}>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="bg-blue-50 p-2 rounded-md">
              <User className="w-4 h-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Customer</h2>
          </div>

          {!value.customer || showPicker ? (
            <CustomerSelector
              selectedCustomer={value.customer}
              onSelectCustomer={handleSelect}
              hideLabel
              placeholder="Search and select a customer..."
              autoOpen
            />
          ) : (
            <div className="space-y-3">
              <div className="text-base font-semibold text-gray-900">{value.customer.name}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-gray-600 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-gray-400" /> Email
                  </Label>
                  <Input
                    type="email"
                    value={value.customerEmail}
                    onChange={(e) => onChange({ ...value, customerEmail: e.target.value })}
                    placeholder="customer@example.com"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-gray-600 flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5 text-gray-400" /> Phone
                  </Label>
                  <Input
                    type="tel"
                    value={value.customerPhone}
                    onChange={(e) => onChange({ ...value, customerPhone: e.target.value })}
                    placeholder="(555) 555-5555"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Used for this billing sheet only — won't update the customer record.
              </p>
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                className="text-sm text-blue-600 hover:text-blue-700 font-medium inline-flex items-center gap-1"
              >
                <Pencil className="w-3.5 h-3.5" /> Change customer
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {value.customer && branchRequired && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <Building2 className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">
                Branch Location <span className="text-red-500">*</span>
              </h2>
            </div>
            <Select
              value={value.branchName || ""}
              onValueChange={(v) => onChange({ ...value, branchName: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select branch location..." />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      {/* Work Date card — gated until a customer is chosen so the customer
          picker is the obvious first step (matches estimate wizard pattern). */}
      {value.customer && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <Calendar className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">
                Work Date <span className="text-red-500">*</span>
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={value.workDate}
                onChange={(e) => onChange({ ...value, workDate: e.target.value })}
                className="max-w-[220px]"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange({ ...value, workDate: new Date().toISOString().split("T")[0] })
                }
              >
                Today
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Read-only technician display in edit mode — the technician is the
          person who performed the work and is locked after creation. */}
      {isEdit && originalTechnicianName && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-2">
            <div className="flex items-center gap-2">
              <div className="bg-gray-50 p-2 rounded-md">
                <User className="w-4 h-4 text-gray-500" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">Technician</h2>
              <span className="text-xs text-gray-500 ml-auto">Read-only</span>
            </div>
            <div className="flex items-center h-10 px-3 rounded-md border border-gray-200 bg-gray-50 text-gray-700 text-sm">
              {originalTechnicianName}
            </div>
            <p className="text-xs text-gray-500">
              The technician is locked to the person who performed the work and cannot be changed.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="hidden sm:flex justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Parts & Labor
// ─────────────────────────────────────────────────────────────────────────────

function PartsLaborStep({
  value,
  onChange,
  customer,
  workDate,
  pinnedLocation,
  isFieldTech,
  onEditPin,
  onBack,
  onContinue,
}: {
  value: PartsLaborValue;
  onChange: (v: PartsLaborValue) => void;
  customer: Customer | null;
  workDate: string;
  pinnedLocation: WorkLocation | null;
  isFieldTech: boolean;
  onEditPin: () => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [partsPickerOpen, setPartsPickerOpen] = useState(false);

  const laborRate = customer?.laborRate ? parseFloat(customer.laborRate) : 0;
  const partsSubtotal = value.items.reduce(
    (sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
    0,
  );
  // Task #396 — per_part labor sums (laborHours × quantity) per item.
  const isFlatBs = value.laborMode !== "per_part";
  const perPartHoursSum = value.items.reduce(
    (sum, it) => sum + (Number(it.laborHours) || 0) * (Number(it.quantity) || 0),
    0,
  );
  const effectiveHours = isFlatBs
    ? Number(value.totalHours) || 0
    : perPartHoursSum;
  const laborSubtotal = effectiveHours * laborRate;
  const total = partsSubtotal + laborSubtotal;

  const addPart = (part: Part, qty: number = 1) => {
    const idx = value.items.findIndex((it) => it.partId === part.id);
    if (idx >= 0) {
      const next = [...value.items];
      next[idx] = { ...next[idx], quantity: next[idx].quantity + qty };
      onChange({ ...value, items: next });
    } else {
      onChange({
        ...value,
        items: [
          ...value.items,
          {
            partId: part.id,
            partName: part.name,
            partDescription: part.description || "",
            quantity: qty,
            unitPrice: parseFloat(part.price) || 0,
            laborHours: 0,
            notes: "",
          },
        ],
      });
    }
  };

  const addManual = () => {
    onChange({
      ...value,
      items: [
        ...value.items,
        { partId: null, partName: "", partDescription: "", quantity: 1, unitPrice: 0, laborHours: 0, notes: "" },
      ],
    });
  };

  const removeItem = (i: number) => {
    onChange({ ...value, items: value.items.filter((_, idx) => idx !== i) });
  };

  const updateItem = (i: number, patch: Partial<ItemValue>) => {
    const next = [...value.items];
    next[i] = { ...next[i], ...patch };
    onChange({ ...value, items: next });
  };

  const canContinue = value.items.length > 0 || effectiveHours > 0;

  return (
    <div className="space-y-4">
      <WizardSummaryStrip
        customerName={customer?.name ?? ""}
        branchName=""
        pinnedLocation={pinnedLocation}
        onEditPin={onEditPin}
      />

      <div className="flex items-center gap-2 text-xs text-gray-600 -mt-1">
        <Calendar className="w-3.5 h-3.5" />
        <span>Work date: {workDate ? new Date(workDate + "T00:00:00").toLocaleDateString() : "—"}</span>
      </div>

      {/* Labor */}
      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <Calculator className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">Labor</h2>
            </div>
            {/* Task #396 — Flat | Per-part toggle for billing sheet labor. */}
            <div
              className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5 text-xs"
              role="tablist"
              data-testid="bs-labor-mode-toggle"
            >
              <button
                type="button"
                role="tab"
                aria-selected={isFlatBs}
                className={`px-2.5 py-1 rounded ${
                  isFlatBs ? "bg-white shadow-sm font-semibold text-gray-900" : "text-gray-500"
                }`}
                onClick={() => {
                  // Switching per_part → flat: prepopulate from the
                  // current per-row sum so totals don't snap to 0.
                  const prefill =
                    value.laborMode === "per_part" && perPartHoursSum > 0
                      ? perPartHoursSum
                      : Number(value.totalHours) || 0;
                  onChange({ ...value, laborMode: "flat", totalHours: prefill });
                }}
                data-testid="bs-labor-mode-flat"
              >
                Flat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={!isFlatBs}
                className={`px-2.5 py-1 rounded ${
                  !isFlatBs ? "bg-white shadow-sm font-semibold text-gray-900" : "text-gray-500"
                }`}
                onClick={() => onChange({ ...value, laborMode: "per_part" })}
                data-testid="bs-labor-mode-per-part"
              >
                Per part
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {isFlatBs ? (
              <div className="space-y-1">
                <Label className="text-xs text-gray-600">
                  Hours Worked <span className="text-red-500">*</span>
                </Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.25"
                  min="0"
                  value={value.totalHours}
                  onChange={(e) =>
                    onChange({ ...value, totalHours: parseFloat(e.target.value) || 0 })
                  }
                  className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  data-testid="bs-flat-total-hours"
                />
              </div>
            ) : (
              <div className="space-y-1">
                <Label className="text-xs text-gray-600">Total Hours (summed per part)</Label>
                <div
                  className="flex items-center h-10 px-3 rounded-md border border-gray-200 bg-gray-50 text-gray-700 text-sm"
                  data-testid="bs-per-part-total-hours"
                >
                  {perPartHoursSum.toFixed(2)} hr
                  <span className="ml-2 text-xs text-gray-500">
                    (Σ laborHours × qty across items)
                  </span>
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs text-gray-600">Labor Rate</Label>
              {customer ? (
                <div className="flex items-center h-10 px-3 rounded-md border border-gray-200 bg-gray-50 text-gray-700 text-sm">
                  ${laborRate.toFixed(2)}/hr
                  <span className="ml-2 text-xs text-gray-500">(from customer record)</span>
                </div>
              ) : (
                <div className="flex items-center h-10 px-3 rounded-md border border-gray-200 bg-gray-50 text-gray-400 text-sm">
                  Pick a customer first
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Parts catalog picker */}
      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="bg-blue-50 p-2 rounded-md">
                <Package className="w-4 h-4 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">Parts &amp; Materials</h2>
            </div>
            <Button
              type="button"
              onClick={() => setPartsPickerOpen(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              size="sm"
            >
              <Plus className="w-4 h-4 mr-1" /> Add Part
            </Button>
          </div>
          {!isFieldTech && (
            <Button type="button" variant="outline" onClick={addManual} className="w-full">
              <Plus className="w-4 h-4 mr-2" />
              Add Manual Item
            </Button>
          )}
        </CardContent>
      </Card>

      <PartPicker
        open={partsPickerOpen}
        onOpenChange={setPartsPickerOpen}
        presentation="sheet"
        selectMode="multi"
        showCategoryChips
        keyboardNav
        onSelectPart={(part, qty) => addPart(part, qty ?? 1)}
      />


      {/* Added items */}
      {value.items.length > 0 && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">
                Added Items ({value.items.length})
              </h2>
              {!isFieldTech && (
                <span className="text-sm text-gray-600">Parts: {fmtMoney(partsSubtotal)}</span>
              )}
            </div>
            <div className="space-y-2">
              {value.items.map((item, i) => (
                <div key={i} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <Input
                      value={item.partName}
                      onChange={(e) => updateItem(i, { partName: e.target.value })}
                      placeholder="Part name"
                      readOnly={!!item.partId}
                      disabled={!!item.partId}
                      className={`text-sm font-medium ${item.partId ? "bg-gray-50" : ""}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeItem(i)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 flex-shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  {item.partDescription && (
                    <div className="text-xs text-gray-600 px-2 py-1 bg-gray-50 rounded">
                      {item.partDescription}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-gray-600">Qty</Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        value={item.quantity}
                        onChange={(e) => updateItem(i, { quantity: parseFloat(e.target.value) || 0 })}
                        className="text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </div>
                    {!isFieldTech && (
                      <div className="space-y-1">
                        <Label className="text-xs text-gray-600">Unit Price</Label>
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min="0"
                          value={item.unitPrice}
                          onChange={(e) => updateItem(i, { unitPrice: parseFloat(e.target.value) || 0 })}
                          readOnly={!!item.partId}
                          disabled={!!item.partId}
                          className={`text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
                            item.partId ? "bg-gray-50" : ""
                          }`}
                        />
                      </div>
                    )}
                  </div>
                  {/* Task #396 — per-row labor input only renders in
                      per_part mode. Stored values are preserved when
                      switching back. */}
                  {!isFlatBs && (
                    <div className="space-y-1">
                      <Label className="text-xs text-gray-600">
                        Labor Hours (per unit, for this item)
                      </Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.25"
                        min="0"
                        value={item.laborHours}
                        onChange={(e) =>
                          updateItem(i, { laborHours: parseFloat(e.target.value) || 0 })
                        }
                        placeholder="0"
                        className="text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        data-testid={`bs-item-labor-hours-${i}`}
                      />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs text-gray-600">Notes (optional)</Label>
                    <Input
                      value={item.notes}
                      onChange={(e) => updateItem(i, { notes: e.target.value })}
                      placeholder="Notes for this item..."
                      className="text-sm"
                    />
                  </div>
                  {!isFieldTech && (
                    <div className="flex justify-between text-sm pt-1 border-t">
                      <span className="text-gray-600">Item Total</span>
                      <span className="font-semibold">
                        {fmtMoney((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0))}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Running total */}
      {!isFieldTech && customer && (
        <Card className="border-l-4 border-l-blue-500 bg-blue-50/40">
          <CardContent className="p-4 sm:p-5 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-700">Parts Subtotal</span>
              <span className="font-medium">{fmtMoney(partsSubtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-700">
                Labor {isFlatBs ? "" : "(per part) "}
                ({effectiveHours.toFixed(2)} hrs × ${laborRate.toFixed(2)})
              </span>
              <span className="font-medium">{fmtMoney(laborSubtotal)}</span>
            </div>
            <div className="flex justify-between text-base pt-2 border-t border-blue-200">
              <span className="font-semibold text-gray-900">Total</span>
              <span className="font-bold text-blue-700">{fmtMoney(total)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {!canContinue && (
        <p className="text-xs text-gray-500 text-center">
          Add at least one part or labor entry to continue.
        </p>
      )}

      <div className="hidden sm:flex justify-between gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onBack}>← Back</Button>
        <Button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Description & Photos
// ─────────────────────────────────────────────────────────────────────────────

function DescriptionPhotosStep({
  value,
  onChange,
  photos,
  onPhotosChange,
  customer,
  pinnedLocation,
  onEditPin,
  onBack,
  onContinue,
}: {
  value: DescriptionValue;
  onChange: (v: DescriptionValue) => void;
  photos: UploadedFile[];
  onPhotosChange: (p: UploadedFile[]) => void;
  customer: Customer | null;
  pinnedLocation: WorkLocation | null;
  onEditPin: () => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const canContinue = value.workDescription.trim().length > 0;

  return (
    <div className="space-y-4">
      <WizardSummaryStrip
        customerName={customer?.name ?? ""}
        branchName=""
        pinnedLocation={pinnedLocation}
        onEditPin={onEditPin}
      />

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="bg-blue-50 p-2 rounded-md">
              <FileText className="w-4 h-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Work Description</h2>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">
                Description <span className="text-red-500">*</span>
              </Label>
              <AiExpandButton
                getValue={() => value.workDescription}
                onSuggestion={setAiSuggestion}
              />
            </div>
            <Textarea
              autoFocus
              value={value.workDescription}
              onChange={(e) => onChange({ ...value, workDescription: e.target.value })}
              placeholder="Describe the work performed..."
              className="min-h-[140px]"
            />
            <AiSuggestionCard
              suggestion={aiSuggestion}
              onAccept={() => {
                onChange({ ...value, workDescription: aiSuggestion! });
                setAiSuggestion(null);
              }}
              onDismiss={() => setAiSuggestion(null)}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm">Additional Notes</Label>
            <Textarea
              value={value.notes}
              onChange={(e) => onChange({ ...value, notes: e.target.value })}
              placeholder="Any additional notes about the work performed..."
              className="min-h-[80px]"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="bg-blue-50 p-2 rounded-md">
              <Camera className="w-4 h-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Photos</h2>
          </div>
          <FileUpload
            type="photo"
            label="Photos"
            accept="image/*"
            multiple
            files={photos}
            onFilesChange={onPhotosChange}
          />
          <p className="text-xs text-gray-500">
            Optional. Photos help managers and customers verify the work performed.
          </p>
        </CardContent>
      </Card>

      <div className="hidden sm:flex justify-between gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onBack}>← Back</Button>
        <Button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — Review
// ─────────────────────────────────────────────────────────────────────────────

function ReviewStep({
  customerStep,
  locationStep,
  partsLabor,
  description,
  photos,
  isFieldTech,
  isEdit,
  submitting,
  onEditPin,
  onBack,
  onSubmit,
  workTypeLabel,
}: {
  customerStep: CustomerStepValue;
  locationStep: WizardLocationValue;
  partsLabor: PartsLaborValue;
  description: DescriptionValue;
  photos: UploadedFile[];
  isFieldTech: boolean;
  isEdit: boolean;
  submitting: boolean;
  onEditPin: () => void;
  onBack: () => void;
  onSubmit: () => void;
  workTypeLabel: string | null;
}) {
  const laborRate = customerStep.customer?.laborRate
    ? parseFloat(customerStep.customer.laborRate)
    : 0;
  const partsSubtotal = partsLabor.items.reduce(
    (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
    0,
  );
  // Task #396 — review step honors active labor mode so the displayed
  // totals match what's about to be persisted.
  const isFlatBsReview = partsLabor.laborMode !== "per_part";
  const reviewHours = isFlatBsReview
    ? Number(partsLabor.totalHours) || 0
    : partsLabor.items.reduce(
        (s, it) => s + (Number(it.laborHours) || 0) * (Number(it.quantity) || 0),
        0,
      );
  const laborSubtotal = reviewHours * laborRate;
  const total = partsSubtotal + laborSubtotal;

  const pinDisplay = locationStep.workLocation
    ? locationStep.workLocation.address ||
      `${locationStep.workLocation.lat.toFixed(6)}, ${locationStep.workLocation.lng.toFixed(6)}`
    : null;

  const photosToShow = photos.slice(0, 6);
  const extraPhotos = photos.length - photosToShow.length;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 sm:p-5 space-y-2">
          <h3 className="text-sm font-semibold text-gray-900">Customer</h3>
          <p className="text-sm text-gray-700">{customerStep.customer?.name ?? "—"}</p>
          {customerStep.branchName && (
            <p className="text-xs text-gray-500">Branch: {customerStep.branchName}</p>
          )}
          <p className="text-xs text-gray-500">
            Work date:{" "}
            {customerStep.workDate
              ? new Date(customerStep.workDate + "T00:00:00").toLocaleDateString()
              : "—"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Work Location</h3>
            <button
              type="button"
              onClick={onEditPin}
              className="text-xs text-blue-600 hover:text-blue-700 font-medium"
            >
              Edit pin
            </button>
          </div>
          <p className="text-sm text-gray-700">{locationStep.projectAddress || "—"}</p>
          {workTypeLabel && (
            <p className="text-xs text-gray-600">
              Work type: {workTypeLabel}
              {locationStep.fieldWorkTypeDetails
                ? ` — ${locationStep.fieldWorkTypeDetails}`
                : ""}
            </p>
          )}
          {pinDisplay && <p className="text-xs text-gray-500">Pinned: {pinDisplay}</p>}
          {(locationStep.controllerLetter || locationStep.zoneNumber != null) && (
            <p className="text-xs text-gray-500">
              {locationStep.controllerLetter
                ? `Controller ${locationStep.controllerLetter}`
                : ""}
              {locationStep.controllerLetter && locationStep.zoneNumber != null ? " · " : ""}
              {locationStep.zoneNumber != null ? `Zone ${locationStep.zoneNumber}` : ""}
            </p>
          )}
          {locationStep.locationNotes && (
            <p className="text-xs text-gray-600">Notes: {locationStep.locationNotes}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">Parts &amp; Labor</h3>
          {partsLabor.items.length === 0 ? (
            <p className="text-sm text-gray-500">No parts on this sheet.</p>
          ) : (
            <div className="text-sm divide-y">
              {partsLabor.items.map((it, i) => (
                <div key={i} className="py-2 flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{it.partName}</p>
                    <p className="text-xs text-gray-500">
                      Qty {it.quantity}
                      {!isFieldTech ? ` × ${fmtMoney(it.unitPrice)}` : ""}
                    </p>
                  </div>
                  {!isFieldTech && (
                    <span className="text-sm font-semibold">
                      {fmtMoney((it.quantity || 0) * (it.unitPrice || 0))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {!isFieldTech && (
            <div className="space-y-1 pt-2 border-t text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Parts</span>
                <span>{fmtMoney(partsSubtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">
                  Labor {isFlatBsReview ? "" : "(per part) "}
                  ({reviewHours.toFixed(2)} hrs × ${laborRate.toFixed(2)})
                </span>
                <span>{fmtMoney(laborSubtotal)}</span>
              </div>
              <div className="flex justify-between font-bold pt-1 border-t">
                <span>Total</span>
                <span className="text-blue-700">{fmtMoney(total)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Description</h3>
            {description.aiDetailedDescription && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">
                AI assisted
              </span>
            )}
          </div>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">
            {description.workDescription || "—"}
          </p>
          {description.notes && (
            <p className="text-xs text-gray-500 whitespace-pre-wrap">Notes: {description.notes}</p>
          )}
        </CardContent>
      </Card>

      {photos.length > 0 && (
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Photos ({photos.length})</h3>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {photosToShow.map((p, i) => (
                <div key={i} className="aspect-square bg-gray-100 rounded overflow-hidden">
                  {p.previewUrl ? (
                    <img
                      src={p.previewUrl}
                      alt={`Photo ${i + 1}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <PhotoImage
                      photoUrl={p.url}
                      alt={`Photo ${i + 1}`}
                      className="w-full h-full object-cover"
                      variant="thumb"
                    />
                  )}
                </div>
              ))}
            </div>
            {extraPhotos > 0 && (
              <p className="text-xs text-gray-500">+{extraPhotos} more not shown</p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="hidden sm:flex justify-between gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onBack}>← Back</Button>
        <Button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {isEdit ? "Save Changes" : "Create Billing Sheet"}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

interface DraftSnapshot {
  cs: CustomerStepValue;
  ls: WizardLocationValue;
  pl: PartsLaborValue;
  ds: DescriptionValue;
  photos: string[];
}

function snapshot(
  cs: CustomerStepValue,
  ls: WizardLocationValue,
  pl: PartsLaborValue,
  ds: DescriptionValue,
  photos: UploadedFile[],
): DraftSnapshot {
  return { cs, ls, pl, ds, photos: photos.map((p) => p.url) };
}

export function BillingSheetWizard({
  open,
  onClose,
  onCreated,
  billingSheetId,
  draftData,
  prefillFromWorkOrder,
}: BillingSheetWizardProps) {
  const isEdit = !!(billingSheetId || draftData?.id);
  const editingId = billingSheetId ?? draftData?.id ?? null;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Current user (role) from local storage — same source the rest of the app uses.
  const currentUser = useMemo(() => {
    const raw = safeGet("user");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, []);
  const isFieldTech = currentUser?.role === "field_tech";
  const isManagerClass =
    currentUser?.role === "irrigation_manager" ||
    currentUser?.role === "billing_manager" ||
    currentUser?.role === "company_admin" ||
    currentUser?.role === "super_admin";

  const [step, setStep] = useState<Step>(isEdit ? 2 : 1);
  const [customerStep, setCustomerStep] = useState<CustomerStepValue>(blankCustomer);
  const [locationStep, setLocationStep] = useState<WizardLocationValue>(blankLocation);
  const [partsLabor, setPartsLabor] = useState<PartsLaborValue>(blankPartsLabor);
  const [descriptionStep, setDescriptionStep] = useState<DescriptionValue>(blankDescription);
  const [photos, setPhotos] = useState<UploadedFile[]>([]);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [locationGateComplete, setLocationGateComplete] = useState(false);
  const initialSnapshotRef = useRef<DraftSnapshot | null>(null);
  const hydratedRef = useRef(false);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setStep(isEdit ? 2 : 1);
    hydratedRef.current = false;
    if (!isEdit) {
      const cs = blankCustomer();
      if (prefillFromWorkOrder?.customerName) {
        cs.customer = {
          id: prefillFromWorkOrder.customerId ?? 0,
          name: prefillFromWorkOrder.customerName,
        } as Customer;
      }
      const ls = blankLocation();
      if (prefillFromWorkOrder?.propertyAddress) ls.projectAddress = prefillFromWorkOrder.propertyAddress;
      const pl = blankPartsLabor();
      const ds = blankDescription();
      setCustomerStep(cs);
      setLocationStep(ls);
      setPartsLabor(pl);
      setDescriptionStep(ds);
      setPhotos([]);
      initialSnapshotRef.current = snapshot(cs, ls, pl, ds, []);
    }
  }, [open, isEdit, prefillFromWorkOrder?.customerId, prefillFromWorkOrder?.propertyAddress]);

  // Edit-mode fetch (when only id was provided)
  const { data: fetched, isLoading: fetchedLoading } = useQuery<BillingSheet & { items?: BillingSheetItem[] }>({
    queryKey: ["/api/billing-sheets", editingId],
    enabled: isEdit && open && !!billingSheetId && !draftData,
  });
  const existing = (draftData ?? fetched) as
    | (BillingSheet & { items?: BillingSheetItem[] })
    | undefined;
  const { data: workTypes = [] } = useArrayQuery<FieldWorkType>({
    queryKey: ["/api/field-work-types"],
    enabled: open,
  });
  const selectedWorkTypeLabel =
    workTypes.find((type) => type.code === locationStep.fieldWorkType)?.label ?? null;
  // No role condition — see billing-sheet-wizard-gate.ts.
  const enforceBillingLocationGate = shouldEnforceWizardLocationGate(
    isEdit ? existing?.createdAt ?? null : new Date(),
  );

  // Wait for the real customer record before hydrating Step 1 so the wizard
  // mounts the real customer in a single pass — never the synthetic fallback
  // first, then a swap. `isFetched` (rather than `!realCustomer`) also lets
  // hydration proceed if the customer query errors out so the user never
  // sees an indefinite spinner.
  const {
    data: realCustomer,
    isFetched: realCustomerFetched,
    isLoading: realCustomerLoading,
  } = useQuery<Customer>({
    queryKey: ["/api/customers", existing?.customerId],
    enabled: isEdit && open && !!existing?.customerId,
  });

  // Hydrate from existing
  useEffect(() => {
    if (!isEdit || !existing || !open || hydratedRef.current) return;
    if (existing.customerId && !realCustomerFetched) return;

    const cust =
      realCustomer ??
      ({
        id: existing.customerId ?? 0,
        name: existing.customerName,
      } as Customer);

    const lat =
      existing.workLocationLat != null ? parseFloat(String(existing.workLocationLat)) : NaN;
    const lng =
      existing.workLocationLng != null ? parseFloat(String(existing.workLocationLng)) : NaN;
    const wl: WorkLocation | null =
      Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat, lng, address: existing.workLocationAddress ?? undefined }
        : null;

    const propertyAddress = existing.propertyAddress ?? "";
    const customerAddress = realCustomer?.address ?? "";
    const useDifferentAddress =
      propertyAddress.trim().length > 0 &&
      propertyAddress.trim() !== (customerAddress ?? "").trim();

    const cs: CustomerStepValue = {
      customer: cust,
      customerEmail: cust.email ?? "",
      customerPhone: cust.phone ?? "",
      branchName: existing.branchName ?? "",
      workDate: existing.workDate
        ? new Date(existing.workDate).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0],
    };
    const ls: WizardLocationValue = {
      projectName: "",
      projectAddress: propertyAddress,
      useDifferentAddress,
      locationNotes: "",
      accessInstructions: "",
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
    const pl: PartsLaborValue = {
      // Task #396 — hydrate persisted laborMode (default flat) so edits
      // reopen in the same mode the sheet was saved in.
      laborMode:
        (existing as unknown as { laborMode?: string }).laborMode === "per_part"
          ? "per_part"
          : "flat",
      totalHours: existing.totalHours ? parseFloat(String(existing.totalHours)) : 0,
      items: Array.isArray(existing.items)
        ? existing.items.map((it: BillingSheetItem) => ({
            partId: it.partId ?? null,
            partName: it.partName ?? "",
            partDescription: it.partDescription ?? "",
            quantity: parseFloat(String(it.quantity ?? 0)) || 0,
            unitPrice: parseFloat(String(it.unitPrice ?? 0)) || 0,
            laborHours: parseFloat(String(it.laborHours ?? 0)) || 0,
            notes: it.notes ?? "",
          }))
        : [],
    };
    const ds: DescriptionValue = {
      workDescription: existing.workDescription ?? "",
      notes: existing.notes ?? "",
      aiInputs: existing.aiInputs ?? null,
      aiShortDescription: existing.aiShortDescription ?? null,
      aiDetailedDescription: existing.aiDetailedDescription ?? null,
    };
    const ph = (existing.photos ?? []).map(urlToUploadedFile);

    setCustomerStep(cs);
    setLocationStep(ls);
    setPartsLabor(pl);
    setDescriptionStep(ds);
    setPhotos(ph);
    initialSnapshotRef.current = snapshot(cs, ls, pl, ds, ph);
    hydratedRef.current = true;
  }, [isEdit, existing, realCustomer, realCustomerFetched, open]);

  // Customer change → reset map pin / controller / zone, and snap the project
  // address back to the new customer's address unless the user has explicitly
  // toggled "use a different address" (in which case their typed address is
  // preserved). Matches the estimate wizard pattern.
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

  const isDirty = useMemo(() => {
    const baseline = initialSnapshotRef.current;
    if (!baseline) return false;
    return (
      JSON.stringify(baseline) !==
      JSON.stringify(snapshot(customerStep, locationStep, partsLabor, descriptionStep, photos))
    );
  }, [customerStep, locationStep, partsLabor, descriptionStep, photos]);

  const requestClose = () => {
    if (isDirty) setDiscardOpen(true);
    else onClose();
  };

  // Submit
  const saveMutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      if (!customerStep.customer) throw new Error("Customer required");
      if (!customerStep.workDate) throw new Error("Work date required");
      if (!descriptionStep.workDescription.trim()) throw new Error("Description required");
      if (enforceBillingLocationGate && !locationGateComplete) {
        throw new Error("Complete every required work-location detail before saving.");
      }

      // Field tech edit: server enforces status-only patch.
      if (isEdit && isFieldTech) {
        return await apiRequest(`/api/billing-sheets/${editingId}`, "PATCH", { status: "submitted" });
      }

      // Strip pricing for field tech creates so the server's authoritative
      // pricing helper resolves catalog prices instead of any client values.
      const itemsForWire = partsLabor.items.map((it) => {
        const base: Record<string, unknown> = {
          partId: it.partId ?? null,
          partName: it.partName,
          partDescription: it.partDescription || null,
          quantity: it.quantity,
          laborHours: it.laborHours,
          notes: it.notes || null,
        };
        if (!isFieldTech) base.unitPrice = it.unitPrice;
        return base;
      });

      const status = isEdit
        ? existing?.status ?? "draft"
        : isFieldTech
          ? "submitted"
          : isManagerClass
            ? "approved_passed_to_billing"
            : "draft";

      const laborRate = customerStep.customer.laborRate
        ? parseFloat(customerStep.customer.laborRate)
        : 0;
      const partsSubtotal = partsLabor.items.reduce(
        (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
        0,
      );
      // Task #396 — labor totals must follow the active mode so the
      // payload's authoritative subtotals match what the server will
      // recompute (and what the wizard's running total just showed).
      const isFlatBsSubmit = partsLabor.laborMode !== "per_part";
      const perPartHoursSubmit = partsLabor.items.reduce(
        (s, it) => s + (Number(it.laborHours) || 0) * (Number(it.quantity) || 0),
        0,
      );
      const submitTotalHours = isFlatBsSubmit
        ? Number(partsLabor.totalHours) || 0
        : perPartHoursSubmit;
      const laborSubtotal = submitTotalHours * laborRate;

      // Task #764 — in edit mode, the technician must always come from the
      // original record. Never use currentUser here to avoid silently
      // overwriting the field tech with the manager who is editing.
      const technicianId = isEdit
        ? (existing?.technicianId ?? null)
        : (currentUser?.id ?? null);
      const technicianName = isEdit
        ? (existing?.technicianName ?? "")
        : (currentUser?.name || currentUser?.username || "");

      const payload: Record<string, unknown> = {
        customerId: customerStep.customer.id,
        customerName: customerStep.customer.name,
        customerEmail: customerStep.customerEmail.trim() || null,
        propertyAddress: locationStep.projectAddress.trim() || customerStep.customer.address || "",
        workLocationLat: locationStep.workLocation?.lat ?? null,
        workLocationLng: locationStep.workLocation?.lng ?? null,
        workLocationAddress: locationStep.workLocation?.address ?? null,
        controllerLetter: locationStep.controllerLetter,
        zoneNumber: locationStep.zoneNumber,
        fieldWorkType: locationStep.fieldWorkType,
        fieldWorkTypeDetails: locationStep.fieldWorkTypeDetails.trim() || null,
        workLocationSource: locationStep.workLocationSource,
        workLocationAccuracyM: locationStep.workLocationAccuracyM,
        workLocationGpsError: locationStep.workLocationGpsError,
        workDate: customerStep.workDate,
        technicianName,
        technicianId,
        workDescription: descriptionStep.workDescription.trim(),
        notes: descriptionStep.notes,
        branchName: customerStep.branchName || null,
        // Task #396 — honor the user-selected labor mode. Flat sends the
        // wizard's totalHours; per-part lets the server recompute from
        // per-row laborHours × quantity (we still send our own totalHours
        // so the totals shown in the wizard match what gets persisted).
        laborMode: partsLabor.laborMode,
        totalHours: submitTotalHours,
        laborRate,
        laborSubtotal,
        partsSubtotal,
        totalAmount: partsSubtotal + laborSubtotal,
        photos: photos.map((p) => p.url),
        items: itemsForWire,
        aiInputs: descriptionStep.aiInputs,
        aiShortDescription: descriptionStep.aiShortDescription,
        aiDetailedDescription: descriptionStep.aiDetailedDescription,
        status,
        companyId: currentUser?.companyId,
      };

      if (isEdit) {
        return await apiRequest(`/api/billing-sheets/${editingId}`, "PATCH", payload);
      }
      return await apiRequest("/api/billing-sheets", "POST", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/billing-sheets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      if (currentUser?.role === "field_tech" && currentUser?.id) {
        queryClient.invalidateQueries({
          queryKey: ["/api/billing-sheets", "technician", currentUser.id],
        });
      }
      toast({
        title: isEdit ? "Billing sheet updated" : "Billing sheet saved",
      });
      onCreated?.();
      onClose();
    },
    onError: (err) => {
      toast({
        title: isEdit ? "Failed to update billing sheet" : "Failed to save billing sheet",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const goNext = () => {
    if (step < 5) setStep((s) => (s + 1) as Step);
  };
  const goBack = () => {
    if (step > 1) setStep((s) => (s - 1) as Step);
  };

  const customerBranches: string[] = Array.isArray(customerStep.customer?.branches)
    ? (customerStep.customer!.branches as string[])
    : [];
  const canContinueFrom: Record<Step, boolean> = {
    1:
      !!customerStep.customer &&
      (customerBranches.length === 0 || !!customerStep.branchName) &&
      !!customerStep.workDate,
    2: canContinueFromLocationStep(enforceBillingLocationGate, locationGateComplete),
    3:
      partsLabor.items.length > 0 ||
      (partsLabor.laborMode === "per_part"
        ? partsLabor.items.some((it) => (Number(it.laborHours) || 0) > 0)
        : (Number(partsLabor.totalHours) || 0) > 0),
    4: descriptionStep.workDescription.trim().length > 0,
    5: true,
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
        saveMutation.mutate();
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
    if (customerStep.workDate) {
      const d = new Date(customerStep.workDate);
      if (!isNaN(d.getTime())) {
        parts.push(
          d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          }),
        );
      }
    }
    if (selectedWorkTypeLabel) parts.push(selectedWorkTypeLabel);
    return parts.length ? parts.join(" · ") : null;
  }, [
    customerStep.customer?.name,
    customerStep.branchName,
    customerStep.workDate,
    selectedWorkTypeLabel,
  ]);

  const stepCtaLabel: Record<Step, string> = {
    1: "Continue",
    2: "Continue",
    3: "Continue",
    4: "Continue",
    5: isEdit ? "Save Changes" : "Create Billing Sheet",
  };

  const stickyMobileFooter = (
    <div className="sm:hidden sticky bottom-0 -mx-4 px-4 py-2 bg-white border-t z-10 flex flex-col gap-1.5">
      {step === 2 && enforceBillingLocationGate && !locationGateComplete && (
        <p className="text-xs text-red-700 text-center">
          Complete the required location details above to continue.
        </p>
      )}
      {step === 3 && !canContinueFrom[3] && (
        <p className="text-xs text-gray-500 text-center">
          Add at least one part or labor entry to continue.
        </p>
      )}
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
            {stepCtaLabel[step]}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
          >
            {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {stepCtaLabel[5]}
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
            icon={Receipt}
            kindLabel="Billing Sheet"
            mode={isEdit ? "edit" : "new"}
            recordIdentifier={isEdit && editingId ? `#${editingId}` : null}
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
            loading={isEdit && (fetchedLoading || realCustomerLoading) && !hydratedRef.current}
            loadingLabel="Loading billing sheet…"
            accent="orange"
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
            {isEdit && (fetchedLoading || realCustomerLoading) && !hydratedRef.current ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
              </div>
            ) : step === 1 ? (
              <CustomerDateStep
                value={customerStep}
                onChange={handleCustomerStepChange}
                onContinue={goNext}
                onCancel={requestClose}
                isEdit={isEdit}
                originalTechnicianName={
                  isEdit && !isFieldTech
                    ? (existing?.technicianName ?? undefined)
                    : undefined
                }
              />
            ) : step === 2 ? (
              <CustomerLocationStep
                customer={customerStep.customer}
                value={locationStep}
                onChange={setLocationStep}
                onBack={isEdit ? requestClose : goBack}
                onContinue={goNext}
                hideProjectName
                enforceLocationGate={enforceBillingLocationGate}
                onGateStateChange={(complete) => setLocationGateComplete(complete)}
              />
            ) : step === 3 ? (
              <PartsLaborStep
                value={partsLabor}
                onChange={setPartsLabor}
                customer={customerStep.customer}
                workDate={customerStep.workDate}
                pinnedLocation={locationStep.workLocation}
                isFieldTech={isFieldTech}
                onEditPin={() => setStep(2)}
                onBack={goBack}
                onContinue={goNext}
              />
            ) : step === 4 ? (
              <DescriptionPhotosStep
                value={descriptionStep}
                onChange={setDescriptionStep}
                photos={photos}
                onPhotosChange={setPhotos}
                customer={customerStep.customer}
                pinnedLocation={locationStep.workLocation}
                onEditPin={() => setStep(2)}
                onBack={goBack}
                onContinue={goNext}
              />
            ) : (
              <ReviewStep
                customerStep={customerStep}
                locationStep={locationStep}
                partsLabor={partsLabor}
                description={descriptionStep}
                photos={photos}
                isFieldTech={isFieldTech}
                isEdit={isEdit}
                submitting={saveMutation.isPending}
                onEditPin={() => setStep(2)}
                onBack={goBack}
                onSubmit={() => saveMutation.mutate()}
                workTypeLabel={selectedWorkTypeLabel}
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
              {isEdit ? "Discard your edits?" : "Discard this billing sheet?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isEdit
                ? "You have unsaved changes. Closing now will discard them and keep the saved version."
                : "You have unsaved work on this new billing sheet. Closing now will discard it and nothing will be saved."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isEdit ? "Keep editing" : "Keep working"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDiscardOpen(false);
                onClose();
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
