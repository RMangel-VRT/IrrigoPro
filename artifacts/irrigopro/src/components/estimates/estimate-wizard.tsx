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
import { ChevronLeft, FileText, Loader2 } from "lucide-react";
import { WizardHeader } from "@/components/wizard-shared/wizard-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Customer, EstimateWithItems, EstimateItem } from "@workspace/db/schema";
import type { UploadedFile } from "@/components/ui/file-upload";
import {
  EstimateWizardCustomerStep,
  type CustomerStepValue,
} from "./wizard/estimate-wizard-customer-step";
import {
  DEFAULT_LABOR_RATE,
  EstimateWizardLineItemsStep,
  computeTotals,
  type LaborRateSource,
  type WizardLineItem,
} from "./wizard/estimate-wizard-line-items-step";
import { EstimateWizardReviewStep } from "./wizard/estimate-wizard-review-step";
import {
  CustomerLocationStep,
  type CustomerLocationValue,
} from "@/components/location/customer-location-step";
import { submitEstimate, type SubmitMode } from "./estimate-wizard-submit";
import { isDraft, estimateSubmitStatusFields } from "@workspace/shared";
import { getCurrentUser } from "@/lib/impersonation";

interface EstimateApiPayloadEstimate {
  customerId: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  projectName: string;
  projectAddress: string;
  locationNotes: string;
  accessInstructions: string;
  workDescription: string;
  status: string;
  partsSubtotal: string;
  laborSubtotal: string;
  totalAmount: string;
  laborRate: string;
  // Task #657 — Labor is flat-only on the write path. The field is kept
  // on the wire for back-compat with the server's Zod input schema but
  // the wizard always sends `flat`.
  laborMode: "flat";
  totalLaborHours: string;
  photos: string[];
  attachments: string[];
  workLocationLat: number | null;
  workLocationLng: number | null;
  workLocationAddress: string | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
  internalStatus?: string;
  // Task #669 — present only when an admin renames an existing
  // estimate. Server validates uniqueness per company and ignores it
  // for non-admin roles.
  estimateNumber?: string;
}

interface EstimateApiPayloadItem {
  // Null when the line item has no catalog part assigned (inspection
  // finding without a part). The server accepts and persists null partId.
  partId: number | null;
  partName: string;
  partPrice: string;
  quantity: number;
  laborHours: string;
  totalPrice: string;
  description: string;
  sortOrder: number;
}

interface EstimateApiPayload {
  estimate: EstimateApiPayloadEstimate;
  items: EstimateApiPayloadItem[];
}


interface EstimateWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId?: number | null;
}

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
  1: "Customer & Scope",
  2: "Location",
  3: "Line Items",
  4: "Review & Send",
};

function makeRowId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function urlToUploadedFile(url: string): UploadedFile {
  const fileName = url.split("/").pop() || url;
  return { url, fileName, originalName: fileName };
}

// Task #657 — draft shape bumped to v2 to add `flatTotalHours`. The
// on-disk key prefix remains `…:v1:` so existing autosaved drafts are
// preserved across the upgrade; `loadDraft` migrates v1 payloads to v2
// in-memory by collapsing any per-row labor hours into a single
// `flatTotalHours` (Σ qty × per-unit hours) and zeroing per-row labor.
const DRAFT_STORAGE_VERSION = 2;
const DRAFT_KEY_PREFIX = "irrigopro:estimate-wizard-draft:v1:";

function draftKey(estimateId?: number | null): string {
  return `${DRAFT_KEY_PREFIX}${estimateId ?? "new"}`;
}

interface PersistedDraft {
  version: number;
  savedAt: number;
  step: Step;
  customerStep: CustomerStepValue;
  items: WizardLineItem[];
  laborRate: number;
  // Task #657 — flat-only labor: a single estimate-level "Total labor
  // hours" value persisted in the draft so a reload doesn't lose hours.
  flatTotalHours: number;
  photos: UploadedFile[];
  attachments: UploadedFile[];
}

function loadDraft(estimateId?: number | null): PersistedDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(draftKey(estimateId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedDraft> & {
      version?: number;
      items?: WizardLineItem[];
    };
    if (!parsed) return null;
    // Re-assign rowIds defensively in case of collisions on hydration.
    const rawItems = (parsed.items ?? []).map((it) => ({
      ...it,
      rowId: it.rowId || makeRowId(),
    }));
    // Task #657 — Migrate v1 drafts to v2 in-memory: collapse the
    // sum of per-row labor (Σ qty × per-unit hours) into a single
    // `flatTotalHours` and zero the per-row values so the restored
    // wizard renders the new flat-only contract without losing the
    // user's pending hours.
    if (parsed.version === 1) {
      const collapsedHours = rawItems.reduce((sum, it) => {
        const perUnit = parseFloat(String(it.laborHours ?? 0)) || 0;
        const qty = Number(it.quantity ?? 1) || 1;
        return sum + perUnit * qty;
      }, 0);
      const migrated: PersistedDraft = {
        version: DRAFT_STORAGE_VERSION,
        savedAt: Number(parsed.savedAt ?? Date.now()),
        step: (parsed.step ?? 1) as Step,
        customerStep: parsed.customerStep as CustomerStepValue,
        items: rawItems.map((it) => ({ ...it, laborHours: 0 })),
        laborRate: Number(parsed.laborRate ?? 45),
        flatTotalHours: collapsedHours,
        photos: parsed.photos ?? [],
        attachments: parsed.attachments ?? [],
      };
      return migrated;
    }
    if (parsed.version !== DRAFT_STORAGE_VERSION) return null;
    return {
      ...(parsed as PersistedDraft),
      items: rawItems,
      flatTotalHours: Number(parsed.flatTotalHours ?? 0),
    };
  } catch {
    return null;
  }
}

function saveDraft(estimateId: number | null | undefined, draft: Omit<PersistedDraft, "version" | "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedDraft = {
      version: DRAFT_STORAGE_VERSION,
      savedAt: Date.now(),
      ...draft,
    };
    window.localStorage.setItem(draftKey(estimateId), JSON.stringify(payload));
  } catch {
    // Ignore quota / serialization errors — draft autosave is best-effort.
  }
}

function clearDraft(estimateId?: number | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftKey(estimateId));
  } catch {
    // ignore
  }
}

interface DraftSnapshot {
  customerId: number | null;
  customerEmail: string;
  customerPhone: string;
  projectName: string;
  projectAddress: string;
  locationNotes: string;
  accessInstructions: string;
  workDescription: string;
  laborRate: number;
  // Task #657 — flat-only labor; dirty-check must catch changes to the
  // single Total labor hours value.
  flatTotalHours: number;
  items: Array<Pick<WizardLineItem, "partId" | "partName" | "partPrice" | "quantity" | "laborHours" | "description">>;
  photos: string[];
  attachments: string[];
  workLocation: { lat: number; lng: number; address?: string } | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
  fieldWorkType: string | null;
  fieldWorkTypeDetails: string;
  workLocationSource: "gps" | "manual" | null;
  workLocationAccuracyM: number | null;
  workLocationGpsError: string | null;
}

// Task #399 — single source of truth for the wizard's labor-rate derivation.
// Used both by the effect that sets `laborRate` after a customer change AND
// by the helper line that explains the rate's origin to the user, so the
// displayed provenance can never drift from the value actually applied.
// `DEFAULT_LABOR_RATE` is exported from the line items step so the helper
// text in the children always renders the same fallback number.
function deriveCustomerLaborRate(customer: Customer | null | undefined): {
  rate: number;
  fromCustomer: boolean;
} {
  const raw = customer?.laborRate;
  if (raw === null || raw === undefined || raw === "") {
    return { rate: DEFAULT_LABOR_RATE, fromCustomer: false };
  }
  const parsed = parseFloat(String(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { rate: DEFAULT_LABOR_RATE, fromCustomer: false };
  }
  return { rate: parsed, fromCustomer: true };
}

function snapshot(
  cs: CustomerStepValue,
  items: WizardLineItem[],
  laborRate: number,
  flatTotalHours: number,
  photos: UploadedFile[],
  attachments: UploadedFile[],
): DraftSnapshot {
  return {
    customerId: cs.customer?.id ?? null,
    customerEmail: cs.customerEmail.trim(),
    customerPhone: cs.customerPhone.trim(),
    projectName: cs.projectName.trim(),
    projectAddress: cs.projectAddress.trim(),
    locationNotes: cs.locationNotes.trim(),
    accessInstructions: cs.accessInstructions.trim(),
    workDescription: cs.workDescription.trim(),
    laborRate,
    flatTotalHours,
    items: items.map((it) => ({
      partId: it.partId,
      partName: it.partName,
      partPrice: it.partPrice,
      quantity: it.quantity,
      laborHours: it.laborHours,
      description: it.description,
    })),
    photos: photos.map((p) => p.url),
    attachments: attachments.map((a) => a.url),
    workLocation: cs.workLocation,
    controllerLetter: cs.controllerLetter,
    zoneNumber: cs.zoneNumber,
    fieldWorkType: cs.fieldWorkType,
    fieldWorkTypeDetails: cs.fieldWorkTypeDetails,
    workLocationSource: cs.workLocationSource,
    workLocationAccuracyM: cs.workLocationAccuracyM,
    workLocationGpsError: cs.workLocationGpsError,
  };
}

export function EstimateWizard({ open, onOpenChange, estimateId }: EstimateWizardProps) {
  const isEdit = !!estimateId;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Task #603 — both new and edit flows land on Step 1 (Customer & Project /
  // Scope of Work). Previously edit jumped to Step 2, which hid the scope-
  // of-work field on existing estimates because there was no obvious way to
  // navigate back to Step 1.
  const [step, setStep] = useState<Step>(1);
  const [customerStep, setCustomerStep] = useState<CustomerStepValue>({
    customer: null,
    customerEmail: "",
    customerPhone: "",
    projectName: "",
    projectAddress: "",
    useDifferentAddress: false,
    locationNotes: "",
    accessInstructions: "",
    workDescription: "",
    workLocation: null,
    controllerLetter: null,
    zoneNumber: null,
    fieldWorkType: null,
    fieldWorkTypeDetails: "",
    workLocationSource: null,
    workLocationAccuracyM: null,
    workLocationGpsError: null,
  });
  const [items, setItems] = useState<WizardLineItem[]>([]);
  const [laborRate, setLaborRate] = useState<number>(45);
  // Task #657 — Labor is flat-only; the wizard owns a single
  // "Total labor hours" value at the estimate level.
  const [flatTotalHours, setFlatTotalHours] = useState<number>(0);
  const [photos, setPhotos] = useState<UploadedFile[]>([]);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  // Task #669 — editable estimate number on edit (admin only). Empty
  // string in create mode; the server allocates the number from the
  // per-company sequence on insert.
  const [estimateNumber, setEstimateNumber] = useState<string>("");
  const [originalEstimateNumber, setOriginalEstimateNumber] = useState<string>("");
  // Task #669 — server-side uniqueness conflict for the estimate
  // number rename. Surfaced as an inline error under the input on
  // the review step; cleared as soon as the user edits the field.
  const [estimateNumberError, setEstimateNumberError] = useState<string | null>(null);
  // Task #669 — only company_admin / super_admin can rename. Computed
  // once at mount from the cached session user — role doesn't change
  // mid-edit so re-reading on every render is unnecessary.
  const canEditEstimateNumber = useMemo(() => {
    if (!isEdit) return false;
    const role = getCurrentUser()?.role ?? null;
    return role === "super_admin" || role === "company_admin";
  }, [isEdit]);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<PersistedDraft | null>(null);
  const initialSnapshotRef = useRef<DraftSnapshot | null>(null);
  const hydratedRef = useRef(false);
  const restorePromptedRef = useRef(false);
  const draftReadyRef = useRef(false);

  // Reset state whenever the wizard opens.
  useEffect(() => {
    if (open) {
      setStep(1);
      hydratedRef.current = false;
      restorePromptedRef.current = false;
      draftReadyRef.current = false;
      if (!isEdit) {
        const blank: CustomerStepValue = {
          customer: null,
          customerEmail: "",
          customerPhone: "",
          projectName: "",
          projectAddress: "",
          useDifferentAddress: false,
          locationNotes: "",
          accessInstructions: "",
          workDescription: "",
          workLocation: null,
          controllerLetter: null,
          zoneNumber: null,
          fieldWorkType: null,
          fieldWorkTypeDetails: "",
          workLocationSource: null,
          workLocationAccuracyM: null,
          workLocationGpsError: null,
        };
        setCustomerStep(blank);
        setItems([]);
        setLaborRate(45);
        // Task #657 — flat-only labor; new sessions start at 0 hours.
        setFlatTotalHours(0);
        setPhotos([]);
        setAttachments([]);
        initialSnapshotRef.current = snapshot(blank, [], 45, 0, [], []);
      }
    } else {
      // When the dialog fully closes, also dismiss any open restore prompt
      // so it doesn't reappear stale on next open.
      setRestoreOpen(false);
      setPendingDraft(null);
    }
  }, [open, isEdit]);

  // Load existing estimate in edit mode.
  const { data: existing, isLoading: existingLoading } = useQuery<EstimateWithItems>({
    queryKey: ["/api/estimates", estimateId],
    enabled: isEdit && open,
  });

  // Load the real customer record so the "Use customer address" toggle
  // reverts to the customer's stored address (not a synthesised one). We
  // wait for this to resolve before hydrating Step 1 so the user never
  // sees a synthetic-customer → real-customer swap that looks like the
  // address (and contact info) is changing on its own.
  const {
    data: realCustomer,
    isFetched: realCustomerFetched,
    isLoading: realCustomerLoading,
  } = useQuery<Customer>({
    queryKey: ["/api/customers", existing?.customerId],
    enabled: isEdit && open && !!existing?.customerId,
  });

  // Spinner gate: only show "Loading estimate…" while one of the queries
  // is actually in flight before hydration completes. If a query errors
  // out, the spinner clears (instead of hanging forever) and hydration
  // falls back to the synthetic customer record so the user can still
  // make progress on the estimate.
  const hydrating =
    isEdit && !hydratedRef.current && (existingLoading || realCustomerLoading);

  useEffect(() => {
    if (!isEdit || !existing || !open || hydratedRef.current) return;
    // If the estimate references a customer, wait for that customer record
    // to come back before hydrating, so we hydrate the real customer in a
    // single pass (no flicker, no apparent re-pick prompt).
    if (existing.customerId && !realCustomerFetched) return;
    // Prefer the snapshot appliedLaborRate so edit mode matches what the
    // server uses to compute totals (storage.getEstimate prefers
    // appliedLaborRate over laborRate). Falls back to the stamped
    // laborRate, then the schema default.
    const lr = parseFloat(String(existing.appliedLaborRate ?? existing.laborRate ?? "45")) || 45;
    setLaborRate(lr);
    // Task #657 — Labor is flat-only. Hydrate the single
    // "Total labor hours" value from the persisted estimate. For legacy
    // `per_part` rows (pre-backfill / in-flight), fall back to summing
    // the stored per-line totals so the user doesn't lose hours on an
    // edit before the backfill consolidates them.
    const existingMode =
      (existing as unknown as { laborMode?: string }).laborMode === "per_part"
        ? "per_part"
        : "flat";
    const persistedFlatHours = parseFloat(
      String((existing as unknown as { totalLaborHours?: string }).totalLaborHours ?? "0"),
    ) || 0;
    const legacyPerPartHours = (existing.items ?? []).reduce((sum, it: EstimateItem) => {
      const v = parseFloat(String(it.laborHours ?? "0")) || 0;
      return sum + v;
    }, 0);
    setFlatTotalHours(
      existingMode === "per_part" && legacyPerPartHours > 0
        ? legacyPerPartHours
        : persistedFlatHours,
    );
    const cust: Customer = realCustomer ?? ({
      id: existing.customerId,
      name: existing.customerName,
      email: existing.customerEmail,
      phone: existing.customerPhone,
      address: existing.projectAddress,
    } as Customer);
    // If the estimate has a recorded projectAddress, default the toggle to
    // "different address" so the field is fully editable on open. The user
    // can flip back to "Use customer address" to lock it to the customer
    // record's address.
    const usingDifferent = !!(existing.projectAddress && existing.projectAddress.trim());
    const lat = existing.workLocationLat != null ? parseFloat(String(existing.workLocationLat)) : NaN;
    const lng = existing.workLocationLng != null ? parseFloat(String(existing.workLocationLng)) : NaN;
    const wl = Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng, address: existing.workLocationAddress ?? undefined }
      : null;
    const cs: CustomerStepValue = {
      customer: cust,
      customerEmail: existing.customerEmail ?? "",
      customerPhone: existing.customerPhone ?? "",
      projectName: existing.projectName ?? "",
      projectAddress: existing.projectAddress ?? "",
      useDifferentAddress: usingDifferent,
      locationNotes: existing.locationNotes ?? "",
      accessInstructions: existing.accessInstructions ?? "",
      workDescription: existing.workDescription ?? "",
      workLocation: wl,
      controllerLetter: existing.controllerLetter ?? null,
      zoneNumber: existing.zoneNumber ?? null,
      fieldWorkType: null,
      fieldWorkTypeDetails: "",
      workLocationSource: null,
      workLocationAccuracyM: null,
      workLocationGpsError: null,
    };
    setCustomerStep(cs);
    const loaded: WizardLineItem[] = (existing.items ?? []).map((it: EstimateItem) => {
      const qty = Math.max(Number(it.quantity ?? 1), 1);
      return {
        rowId: makeRowId(),
        partId: it.partId ?? null,
        partName: it.partName,
        partPrice: parseFloat(String(it.partPrice ?? "0")) || 0,
        quantity: qty,
        // Stored laborHours is per-line total; editor stores per-unit.
        laborHours: (parseFloat(String(it.laborHours ?? "0")) || 0) / qty,
        description: it.description ?? "",
      };
    });
    // Task #657 — flat-only: zero in-memory per-row labor after edit
    // hydration so the wizard state is fully aligned with the new
    // write contract. Any legacy labor was already folded into
    // `flatTotalHours` by `setFlatTotalHours` above.
    const loadedFlat = loaded.map((it) => ({ ...it, laborHours: 0 }));
    setItems(loadedFlat);
    const ph = (existing.photos ?? []).map(urlToUploadedFile);
    const at = (existing.attachments ?? []).map(urlToUploadedFile);
    setPhotos(ph);
    setAttachments(at);
    // Task #657 — pass the hydrated flatTotalHours into the dirty-check
    // baseline so a legacy per_part edit that collapses into flat hours
    // doesn't show as dirty before the user touches anything. Note the
    // baseline must match what `setFlatTotalHours` was just called with
    // above; we re-derive the same value here to keep them in lock-step.
    const baselineFlatHours = (() => {
      const existingMode =
        (existing as unknown as { laborMode?: string }).laborMode === "per_part"
          ? "per_part"
          : "flat";
      const persistedFlat = parseFloat(
        String((existing as unknown as { totalLaborHours?: string }).totalLaborHours ?? "0"),
      ) || 0;
      // For legacy per_part rows we hydrate by summing the stored per-line
      // labor totals (stored value = per-unit × quantity, per Task #228),
      // which is equivalent to Σ(quantity × per-unit hours).
      const legacyPerPartHours = (existing.items ?? []).reduce((sum, it: EstimateItem) => {
        const v = parseFloat(String(it.laborHours ?? "0")) || 0;
        return sum + v;
      }, 0);
      return existingMode === "per_part" && legacyPerPartHours > 0
        ? legacyPerPartHours
        : persistedFlat;
    })();
    initialSnapshotRef.current = snapshot(cs, loadedFlat, lr, baselineFlatHours, ph, at);
    // Task #669 — hydrate the editable estimate number from the
    // persisted estimate (read-only on the wire for non-admin roles).
    const persistedNumber = String(existing.estimateNumber ?? "");
    setEstimateNumber(persistedNumber);
    setOriginalEstimateNumber(persistedNumber);
    hydratedRef.current = true;
  }, [isEdit, existing, open, realCustomer, realCustomerFetched]);

  // Re-derive labor rate from the selected customer whenever the customer
  // changes — including in edit mode, since the user can swap customers from
  // Step 2 ("Change customer" → Step 1) and the submitted labor rate must
  // stay consistent with the chosen customer.
  useEffect(() => {
    if (!customerStep.customer) return;
    if (isEdit && existing && customerStep.customer.id === existing.customerId) {
      // Original customer unchanged in edit mode — preserve the stored rate.
      return;
    }
    const { rate } = deriveCustomerLaborRate(customerStep.customer);
    setLaborRate(rate);
  }, [customerStep.customer?.id, isEdit, existing]);

  const isDirty = useMemo(() => {
    const baseline = initialSnapshotRef.current;
    if (!baseline) return false;
    const current = snapshot(customerStep, items, laborRate, flatTotalHours, photos, attachments);
    return JSON.stringify(baseline) !== JSON.stringify(current);
  }, [customerStep, items, laborRate, flatTotalHours, photos, attachments]);

  // Task #399 — single derivation of where the active labor rate came from.
  // Uses the same `deriveCustomerLaborRate` helper as `setLaborRate`, then
  // factors in edit mode: if the stored rate differs from the customer's
  // current master rate, we tag it as "stored" so the helper text can
  // explain that the server will reset it to the master rate on save.
  // Tolerance keeps two-decimal money comparisons stable.
  const { source: laborRateSource, masterRate: customerMasterRateForUi } =
    useMemo<{ source: LaborRateSource; masterRate: number | undefined }>(() => {
      const { rate: masterRate, fromCustomer } = deriveCustomerLaborRate(
        customerStep.customer,
      );
      if (!fromCustomer) {
        return { source: "default", masterRate: undefined };
      }
      const isUnchangedCustomerEdit =
        isEdit &&
        existing != null &&
        customerStep.customer?.id === existing.customerId;
      if (
        isUnchangedCustomerEdit &&
        Math.abs(laborRate - masterRate) > 0.005
      ) {
        return { source: "stored", masterRate };
      }
      return { source: "customer", masterRate: undefined };
    }, [customerStep.customer, isEdit, existing, laborRate]);

  // Offer to restore a saved draft once the wizard is ready (immediately for
  // new estimates; after the existing estimate has hydrated for edits).
  useEffect(() => {
    if (!open) return;
    if (restorePromptedRef.current) return;
    const ready = isEdit ? hydratedRef.current : true;
    if (!ready) return;
    restorePromptedRef.current = true;
    const draft = loadDraft(estimateId ?? null);
    if (!draft) {
      // Nothing to restore — autosave can begin immediately.
      draftReadyRef.current = true;
      return;
    }
    // Only prompt if the draft actually differs from the current baseline.
    const baseline = initialSnapshotRef.current;
    const draftSnap = snapshot(
      draft.customerStep,
      draft.items,
      draft.laborRate,
      draft.flatTotalHours ?? 0,
      draft.photos,
      draft.attachments,
    );
    if (baseline && JSON.stringify(baseline) === JSON.stringify(draftSnap)) {
      clearDraft(estimateId ?? null);
      draftReadyRef.current = true;
      return;
    }
    setPendingDraft(draft);
    setRestoreOpen(true);
  }, [open, isEdit, estimateId, existing]);

  // Debounced autosave of the in-progress wizard state to localStorage.
  useEffect(() => {
    if (!open) return;
    if (!draftReadyRef.current) return;
    if (!isDirty) {
      // No pending changes — make sure no stale draft lingers.
      clearDraft(estimateId ?? null);
      return;
    }
    const handle = window.setTimeout(() => {
      saveDraft(estimateId ?? null, {
        step,
        customerStep,
        items,
        laborRate,
        flatTotalHours,
        photos,
        attachments,
      });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [open, isDirty, step, customerStep, items, laborRate, flatTotalHours, photos, attachments, estimateId]);

  const applyDraft = (draft: PersistedDraft) => {
    setCustomerStep(draft.customerStep);
    setItems(draft.items);
    setLaborRate(draft.laborRate);
    // Task #657 — restore the persisted estimate-level Total labor hours.
    // Falls back to 0 defensively so a partially-corrupted draft doesn't
    // crash the wizard (the version check on `loadDraft` should have
    // already discarded pre-v2 drafts that lack this field).
    setFlatTotalHours(draft.flatTotalHours ?? 0);
    setPhotos(draft.photos);
    setAttachments(draft.attachments);
    setStep(draft.step);
    setRestoreOpen(false);
    setPendingDraft(null);
    draftReadyRef.current = true;
    toast({ title: "Draft restored" });
  };

  const dismissDraft = () => {
    clearDraft(estimateId ?? null);
    setRestoreOpen(false);
    setPendingDraft(null);
    draftReadyRef.current = true;
  };

  // Task #638 — never read `existing.internalStatus` directly; the
  // `isDraft` lifecycle predicate is the canonical signal.
  const isDraftEdit = isEdit && isDraft(existing ?? null);

  const saveMutation = useMutation<
    { mode: SubmitMode; id: number | null },
    Error,
    { payload: EstimateApiPayload; mode: SubmitMode }
  >({
    mutationFn: ({ payload, mode }) =>
      submitEstimate(
        payload,
        mode,
        { isEdit, isDraftEdit, estimateId: estimateId ?? null },
        apiRequest as unknown as Parameters<typeof submitEstimate>[3],
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates/pending-approval"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      if (isEdit && estimateId) {
        queryClient.invalidateQueries({ queryKey: ["/api/estimates", estimateId] });
      }
      clearDraft(estimateId ?? null);
      if (result.mode === "draft") {
        toast({ title: isDraftEdit ? "Draft saved" : "Saved to drafts" });
      } else if (isDraftEdit) {
        toast({ title: "Submitted for review" });
      } else {
        toast({ title: isEdit ? "Estimate updated" : "Estimate sent to approval queue" });
      }
      onOpenChange(false);
    },
    onError: (err, variables) => {
      // Task #606 — submit is now a single atomic call. On failure we
      // keep the wizard open so the user can retry without re-entering
      // anything; the draft autosave already preserved their work to
      // localStorage. No "Saved as draft" half-step toast — the server
      // either fully accepted the submit or rolled the whole thing
      // back. We derive the wording from the mutation's `mode` so a
      // "Save as draft" failure on an existing draft doesn't get
      // misreported as a failed submit.
      const submitting = variables.mode === "submit" && isDraftEdit;
      // Task #669 — surface the estimate-number uniqueness conflict
      // (HTTP 409 with `field: "estimateNumber"`) as an inline error
      // on the review step input. apiRequest packs the response into
      // `Error("<status>: <body>")`, so we parse both halves here.
      const raw = String(err.message ?? "");
      const m = raw.match(/^(\d{3}):\s*(.*)$/s);
      if (m && m[1] === "409") {
        try {
          const body = JSON.parse(m[2]);
          if (body && body.field === "estimateNumber") {
            setEstimateNumberError(
              typeof body.message === "string"
                ? body.message
                : "Estimate number already in use for this company",
            );
            // Stop here — the inline error is the user-facing signal;
            // a competing toast would just be noise.
            return;
          }
        } catch {
          // Fall through to the generic toast below.
        }
      }
      toast({
        title: submitting
          ? "Couldn't submit for review"
          : isEdit
            ? "Failed to update estimate"
            : "Failed to create estimate",
        description: submitting
          ? `${err.message} — your changes are still here, try again.`
          : err.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (mode: SubmitMode = "submit") => {
    if (!customerStep.customer) {
      toast({ title: "Customer required", variant: "destructive" });
      setStep(1);
      return;
    }
    if (items.length === 0) {
      toast({ title: "Add at least one line item", variant: "destructive" });
      setStep(3);
      return;
    }
    const totals = computeTotals(items, laborRate, flatTotalHours);
    const estimate: EstimateApiPayloadEstimate = {
      customerId: customerStep.customer.id,
      customerName: customerStep.customer.name,
      customerEmail: customerStep.customerEmail.trim(),
      customerPhone: customerStep.customerPhone.trim(),
      projectName: customerStep.projectName.trim(),
      projectAddress: customerStep.projectAddress.trim() || "",
      locationNotes: customerStep.locationNotes.trim() || "",
      accessInstructions: customerStep.accessInstructions.trim() || "",
      workDescription: customerStep.workDescription.trim() || "",
      // Task #638 — round-trip the existing customer-response and
      // review-track enums via the lifecycle helper so the wizard
      // doesn't read raw enum fields. Slice 10c — Save as draft sets
      // internalStatus="draft". For edit/submit we round-trip the
      // existing review status; for new submits we let the server
      // default to "pending_approval".
      status: estimateSubmitStatusFields(existing).nextStatus,
      ...(mode === "draft"
        ? { internalStatus: "draft" }
        : isEdit && estimateSubmitStatusFields(existing).nextInternalStatus
          ? { internalStatus: estimateSubmitStatusFields(existing).nextInternalStatus! }
          : {}),
      partsSubtotal: totals.partsSubtotal.toFixed(2),
      laborSubtotal: totals.laborSubtotal.toFixed(2),
      totalAmount: totals.totalAmount.toFixed(2),
      laborRate: laborRate.toFixed(2),
      // Task #657 — Labor is flat-only on the write path.
      laborMode: "flat",
      totalLaborHours: totals.totalLaborHours.toFixed(2),
      photos: photos.map((p) => p.url),
      attachments: attachments.map((a) => a.url),
      workLocationLat: customerStep.workLocation?.lat ?? null,
      workLocationLng: customerStep.workLocation?.lng ?? null,
      workLocationAddress: customerStep.workLocation?.address ?? null,
      controllerLetter: customerStep.controllerLetter,
      zoneNumber: customerStep.zoneNumber,
      // Task #669 — only include the estimate number in the payload
      // when the admin actually changed it. The server uniqueness check
      // and `estimate.number_changed` audit row fire on the rename.
      ...(canEditEstimateNumber &&
      estimateNumber &&
      estimateNumber !== originalEstimateNumber
        ? { estimateNumber }
        : {}),
    };
    const itemsPayload: EstimateApiPayloadItem[] = items.map((it, index) => ({
      partId: it.partId,
      partName: it.partName,
      partPrice: it.partPrice.toFixed(2),
      quantity: it.quantity,
      // Task #657 — Per-line labor is always zeroed at the payload
      // boundary; the estimate-level totalLaborHours is the single
      // source of truth.
      laborHours: "0.00",
      totalPrice: (it.partPrice * it.quantity).toFixed(2),
      description: it.description,
      sortOrder: index,
    }));
    saveMutation.mutate({ payload: { estimate, items: itemsPayload }, mode });
  };

  const requestClose = () => {
    if (isDirty) setDiscardOpen(true);
    else onOpenChange(false);
  };

  // Enter handling at the wizard level. Esc is delegated to Radix's
  // `onEscapeKeyDown` so a nested dismissable layer (e.g. the part picker
  // Sheet) gets to handle Esc first instead of the wizard intercepting it.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Never let Enter inside a text/number/select input or textarea
      // advance the wizard — it's a foot-gun for users typing in fields.
      // Buttons/links handle their own Enter activation.
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (target?.isContentEditable) return;
      if (tag === "BUTTON" || tag === "A") return;
      if (step === 4 && !saveMutation.isPending) {
        e.preventDefault();
        handleSubmit("submit");
      }
    }
  };

  const headerContextLine = useMemo(() => {
    const parts: string[] = [];
    if (customerStep.customer?.name) parts.push(customerStep.customer.name);
    if (customerStep.projectName.trim()) parts.push(customerStep.projectName.trim());
    if (step >= 3 && items.length > 0) {
      const totals = computeTotals(items, laborRate, flatTotalHours);
      parts.push(
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        }).format(totals.totalAmount),
      );
    }
    return parts.length ? parts.join(" · ") : null;
  }, [customerStep.customer?.name, customerStep.projectName, items, laborRate, flatTotalHours, step]);

  const stickyMobileFooter = (
    <div className="sm:hidden sticky bottom-0 -mx-4 px-4 py-2 bg-white border-t z-10 flex flex-col gap-1.5">
      {step === 3 && items.length === 0 && (
        <p
          className="text-xs text-gray-500 text-center"
          data-testid="wizard-continue-2-helper-mobile"
        >
          Add at least one part to continue.
        </p>
      )}
      <div className="flex items-center gap-2">
      {step === 1 && (
        <>
          <Button type="button" variant="outline" onClick={requestClose} className="flex-1">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => setStep(2)}
            disabled={!customerStep.customer || !customerStep.projectName.trim()}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
          >
            Continue
          </Button>
        </>
      )}
      {step === 2 && (
        <>
          <Button type="button" variant="outline" onClick={() => setStep(1)} className="flex-1">
            ← Back
          </Button>
          <Button
            type="button"
            onClick={() => setStep(3)}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
          >
            Continue
          </Button>
        </>
      )}
      {step === 3 && (
        <>
          <Button type="button" variant="outline" onClick={() => setStep(2)} className="flex-1">
            ← Back
          </Button>
          <Button
            type="button"
            onClick={() => setStep(4)}
            disabled={items.length === 0}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
          >
            Continue
          </Button>
        </>
      )}
      {step === 4 && (
        <>
          <Button type="button" variant="outline" onClick={() => setStep(3)} className="flex-1">
            ← Back
          </Button>
          {(!isEdit || isDraftEdit) && (
            <Button
              type="button"
              variant="outline"
              onClick={() => handleSubmit("draft")}
              disabled={saveMutation.isPending}
              className="flex-1"
              data-testid="wizard-save-draft-mobile"
            >
              {isDraftEdit ? "Save" : "Draft"}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => handleSubmit("submit")}
            disabled={saveMutation.isPending}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
          >
            {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isEdit && !isDraftEdit ? "Save" : "Submit"}
          </Button>
        </>
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
          else onOpenChange(o);
        }}
      >
        <DialogContent
          onKeyDown={handleKeyDown}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            requestClose();
          }}
          onInteractOutside={(e) => {
            // Prevent click-outside from auto-closing while dirty; user must use Cancel/Esc.
            if (isDirty) e.preventDefault();
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
            icon={FileText}
            kindLabel="Estimate"
            mode={isEdit ? "edit" : "new"}
            recordIdentifier={isEdit && estimateId ? `#${estimateId}` : null}
            currentStep={step}
            totalSteps={4}
            stepTitles={[STEP_TITLES[1], STEP_TITLES[2], STEP_TITLES[3], STEP_TITLES[4]]}
            contextLine={headerContextLine}
            loading={hydrating}
            loadingLabel="Loading estimate…"
            accent="blue"
            leading={
              step > 1 && !isEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 sm:hidden -ml-1"
                  onClick={() =>
                    setStep((s) =>
                      s === 4 ? 3 : s === 3 ? 2 : 1,
                    )
                  }
                  aria-label="Back"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
              ) : null
            }
          />

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
            {hydrating ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
              </div>
            ) : step === 1 ? (
              <EstimateWizardCustomerStep
                value={customerStep}
                onChange={setCustomerStep}
                onContinue={() => setStep(2)}
                onCancel={requestClose}
              />
            ) : step === 2 ? (
              <CustomerLocationStep
                customer={customerStep.customer}
                value={{
                  projectName: customerStep.projectName,
                  projectAddress: customerStep.projectAddress,
                  useDifferentAddress: customerStep.useDifferentAddress,
                  locationNotes: customerStep.locationNotes,
                  accessInstructions: customerStep.accessInstructions,
                  workLocation: customerStep.workLocation,
                  controllerLetter: customerStep.controllerLetter,
                  zoneNumber: customerStep.zoneNumber,
                  fieldWorkType: customerStep.fieldWorkType,
                  fieldWorkTypeDetails: customerStep.fieldWorkTypeDetails,
                  workLocationSource: customerStep.workLocationSource,
                  workLocationAccuracyM: customerStep.workLocationAccuracyM,
                  workLocationGpsError: customerStep.workLocationGpsError,
                }}
                onChange={(next: CustomerLocationValue) =>
                  setCustomerStep((prev) => ({
                    ...prev,
                    projectName: next.projectName,
                    projectAddress: next.projectAddress,
                    useDifferentAddress: next.useDifferentAddress,
                    locationNotes: next.locationNotes,
                    accessInstructions: next.accessInstructions,
                    workLocation: next.workLocation,
                    controllerLetter: next.controllerLetter,
                    zoneNumber: next.zoneNumber,
                    fieldWorkType: next.fieldWorkType,
                    fieldWorkTypeDetails: next.fieldWorkTypeDetails,
                    workLocationSource: next.workLocationSource,
                    workLocationAccuracyM: next.workLocationAccuracyM,
                    workLocationGpsError: next.workLocationGpsError,
                  }))
                }
                onBack={() => setStep(1)}
                onContinue={() => setStep(3)}
                hideProjectName
              />
            ) : step === 3 ? (
              <EstimateWizardLineItemsStep
                customerName={customerStep.customer?.name ?? ""}
                projectName={customerStep.projectName}
                laborRate={laborRate}
                laborRateSource={laborRateSource}
                customerMasterRate={customerMasterRateForUi}
                items={items}
                onItemsChange={setItems}
                onBack={() => setStep(2)}
                onContinue={() => setStep(4)}
                onChangeCustomer={() => setStep(1)}
                flatTotalHours={flatTotalHours}
                onFlatTotalHoursChange={setFlatTotalHours}
              />
            ) : (
              <EstimateWizardReviewStep
                customer={customerStep.customer}
                customerEmail={customerStep.customerEmail}
                customerPhone={customerStep.customerPhone}
                projectName={customerStep.projectName}
                projectAddress={customerStep.projectAddress}
                workDescription={customerStep.workDescription}
                workLocation={customerStep.workLocation}
                controllerLetter={customerStep.controllerLetter}
                zoneNumber={customerStep.zoneNumber}
                locationNotes={customerStep.locationNotes}
                accessInstructions={customerStep.accessInstructions}
                laborRate={laborRate}
                laborRateSource={laborRateSource}
                customerMasterRate={customerMasterRateForUi}
                flatTotalHours={flatTotalHours}
                items={items}
                photos={photos}
                attachments={attachments}
                onPhotosChange={setPhotos}
                onAttachmentsChange={setAttachments}
                onBack={() => setStep(3)}
                onSubmit={(mode) => handleSubmit(mode ?? "submit")}
                submitting={saveMutation.isPending}
                isEdit={isEdit}
                isDraftEdit={isDraftEdit}
                estimateNumber={estimateNumber}
                canEditNumber={canEditEstimateNumber}
                onEstimateNumberChange={(next) => {
                  setEstimateNumber(next);
                  // Clear the server-side conflict the moment the user
                  // edits the value so the inline error doesn't linger.
                  if (estimateNumberError) setEstimateNumberError(null);
                }}
                estimateNumberError={estimateNumberError}
              />
            )}
          </div>

          {/* Mobile sticky footer */}
          {stickyMobileFooter}
        </DialogContent>
      </Dialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isEdit ? "Discard your edits?" : "Discard this estimate?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isEdit
                ? "You have unsaved changes to this estimate. Closing now will discard them and keep the saved version."
                : "You have unsaved work on this new estimate. Closing now will discard it and nothing will be saved."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isEdit ? "Keep editing" : "Keep working"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                clearDraft(estimateId ?? null);
                setDiscardOpen(false);
                onOpenChange(false);
              }}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {isEdit ? "Discard edits" : "Discard estimate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={restoreOpen}
        onOpenChange={(o) => {
          // Treat outside dismiss as "start fresh" so we don't reprompt.
          if (!o) dismissDraft();
        }}
      >
        <AlertDialogContent data-testid="estimate-wizard-restore-draft">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore your unsaved draft?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDraft
                ? `We saved your in-progress ${isEdit ? "edits" : "estimate"} from ${new Date(
                    pendingDraft.savedAt,
                  ).toLocaleString()}. Restore where you left off, or start fresh.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={dismissDraft}>Start fresh</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDraft) applyDraft(pendingDraft);
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              Restore draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
