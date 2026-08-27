import type { Invoice, WorkOrder, WorkOrderItem, BillingSheet, BillingSheetItem, WetCheckBilling } from '@workspace/db';
import type { WetCheckBillingView } from './wet-check-billing-view';

// ── Sub-interfaces ──────────────────────────────────────────────────────────

export interface PdfCompanyHeader {
  name: string;
  logo: string;
  logoDataUri: string | null;
  address: string;
  phone: string;
  email: string;
}

export interface PdfInvoiceHeader {
  invoiceNumber: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** Task #1809 — 'monthly' (default) or 'standalone' (single-ticket). */
  billingType?: string;
}

export interface PdfWorkOrderItemRow {
  partName: string;
  partDescription: string;
  quantity: string;
  unitPrice: number;
  laborHours: number;
  rowTotal: number;
  notes: string;
}

export interface PdfWorkOrderRow {
  workOrderNumber: string;
  projectName: string;
  projectAddress: string;
  workLocationAddress?: string;
  branchName: string | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
  locationNotes: string;
  technicianName: string;
  completedAt: Date | null;
  totalHours: number;
  laborRate: number;
  workDescription: string;
  workSummary: string;
  aiDetailedDescription: string;
  photos: string[];
  items: PdfWorkOrderItemRow[];
  partsSubtotal: number;
  laborSubtotal: number;
  rowTotal: number;
  approvedBy: string | null;
  approvedAt: Date | null;
}

export interface PdfBillingSheetItemRow {
  partName: string;
  partDescription: string;
  quantity: string;
  unitPrice: number;
  laborHours: number;
  rowTotal: number;
  notes: string;
}

export interface PdfBillingSheetRow {
  billingNumber: string;
  workDescription: string;
  propertyAddress: string;
  workLocationAddress?: string;
  branchName: string | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
  technicianName: string;
  workDate: Date;
  totalHours: number;
  laborRate: number;
  aiDetailedDescription: string;
  notes: string;
  photos: string[];
  items: PdfBillingSheetItemRow[];
  partsSubtotal: number;
  laborSubtotal: number;
  rowTotal: number;
  approvedBy: string | null;
  approvedAt: Date | null;
  /** Present only for billing sheets backed by a wet check inspection. */
  wetCheckView?: WetCheckBillingView;
}

/**
 * Task #843 — per-zone photo group for the WCB PDF ticket.
 * Populated by invoice-pdf-service.ts from wet_check_photos metadata.
 */
export interface PdfWcbZonePhotoGroup {
  zoneLabel: string;
  zoneRecordId: number;
  /** Photos attached at the zone level (zoneRecordId set, findingId null). */
  zonePhotoUrls: string[];
  /** Photos linked to a specific finding within this zone. */
  findingGroups: Array<{
    findingId: number;
    issueDisplayLabel: string;
    photoUrls: string[];
  }>;
}

/**
 * Task #787 (WC Separate System Slice 2) — one entry per `wet_check_billings`
 * row on the invoice. Carries both the raw DB row (for the ticket header) and
 * the assembled zone-grouped view (for the Repairs Summary body).
 */
export interface PdfWetCheckBillingRow {
  wetCheckBillingId: number;
  wetCheckBilling: WetCheckBilling;
  wetCheckView: WetCheckBillingView;
  /**
   * Task #843 — new-system photo URLs for zone grouping.
   */
  photoUrls?: string[];
  /**
   * Task #843 — per-zone photo grouping. When present, ticketPageWCB renders
   * photos under the zone they belong to instead of a flat header gallery.
   * Falls back to the flat photoUrls gallery when absent.
   */
  zonePhotoGroups?: PdfWcbZonePhotoGroup[];
  /**
   * Merged, deduped photo URLs for this WCB ticket — populated by the
   * invoice PDF service by combining wet_check_photos (new system) with
   * the legacy wcb.photos array. Preferred over the denormalized
   * wetCheckBilling.photos snapshot, which may be stale or incomplete.
   * When present, the PDF generator uses this list exclusively.
   */
  mergedPhotoUrls?: string[];
}

export interface PdfTotals {
  partsSubtotal: number;
  laborSubtotal: number;
  grandTotal: number;
  storedTotalAmount: number;
}

export interface PdfBrandColors {
  navy: string;
  brown: string;
  green: string;
  black: string;
  gray: string;
}

export const DEFAULT_BRAND_COLORS: PdfBrandColors = {
  navy: '#1E5A99',
  brown: '#8B4F2B',
  green: '#7DBE3F',
  black: '#000000',
  gray: '#F5F5F5',
};

export interface PdfBranchSubtotal {
  branchName: string;
  workOrders: PdfWorkOrderRow[];
  billingSheets: PdfBillingSheetRow[];
  subtotal: number;
}

export interface PdfViewModel {
  company: PdfCompanyHeader;
  invoice: PdfInvoiceHeader;
  workOrders: PdfWorkOrderRow[];
  billingSheets: PdfBillingSheetRow[];
  wetCheckBillings: PdfWetCheckBillingRow[];
  totals: PdfTotals;
  totalJobs: number;
  validationWarning: string | null;
  brandColors: PdfBrandColors;
  customerHasBranches: boolean;
  branchSubtotals: PdfBranchSubtotal[];
}

// ── Raw input type ──────────────────────────────────────────────────────────

export interface InvoiceDetailData {
  invoice: Invoice;
  company: {
    name: string;
    logo?: string;
    logoDataUri?: string | null;
    address?: string;
    phone?: string;
    email?: string;
  };
  workOrders: Array<{
    workOrder: WorkOrder;
    items: WorkOrderItem[];
  }>;
  billingSheets: Array<{
    billingSheet: BillingSheet;
    items: BillingSheetItem[];
    wetCheckView?: WetCheckBillingView;
  }>;
  /**
   * Task #787 (WC Separate System Slice 2) — wet_check_billings rows on the
   * invoice. Empty array until Slice 5 routes the WCB path end-to-end.
   */
  wetCheckBillings?: PdfWetCheckBillingRow[];
  laborRate?: string;
  brandColors?: PdfBrandColors;
  customerHasBranches?: boolean;
}

// ── Build result ────────────────────────────────────────────────────────────

export interface BuildPdfViewModelResult {
  viewModel: PdfViewModel;
  validationWarning: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeNum(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return isNaN(n) ? fallback : n;
}

function safeStr(value: string | null | undefined, fallback = ''): string {
  return value ?? fallback;
}

function safePhotos(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(p => typeof p === 'string' && p.length > 0);
}

// ── Builder ─────────────────────────────────────────────────────────────────

export function buildPdfViewModel(data: InvoiceDetailData): BuildPdfViewModelResult {
  const { invoice, company, workOrders: rawWorkOrders, billingSheets: rawBillingSheets, laborRate: passedLaborRate } = data;

  const defaultLaborRate = safeNum(passedLaborRate, 0);

  const companyHeader: PdfCompanyHeader = {
    name: safeStr(company.name, 'Company'),
    logo: safeStr(company.logo),
    logoDataUri: company.logoDataUri ?? null,
    address: safeStr(company.address),
    phone: safeStr(company.phone),
    email: safeStr(company.email),
  };

  const invoiceHeader: PdfInvoiceHeader = {
    invoiceNumber: safeStr(invoice.invoiceNumber),
    periodStart: new Date(invoice.periodStart),
    periodEnd: new Date(invoice.periodEnd),
    generatedAt: new Date(),
    customerName: safeStr(invoice.customerName),
    customerEmail: safeStr(invoice.customerEmail),
    customerPhone: safeStr(invoice.customerPhone),
    billingType: safeStr((invoice as any).billingType, 'monthly'),
  };

  const workOrderRows: PdfWorkOrderRow[] = (rawWorkOrders ?? []).map(({ workOrder, items }) => {
    const totalHours = safeNum(workOrder.totalHours);
    const storedLaborSubtotal = safeNum(workOrder.laborSubtotal);
    const storedAppliedRate = safeNum(workOrder.appliedLaborRate);
    const storedLaborRate = safeNum(workOrder.laborRate);
    // Rate priority: appliedLaborRate snapshot → legacy laborRate field → customer's current rate.
    // Math-derivation (laborSubtotal / totalHours) is intentionally excluded: it would lock in
    // stale/incorrect rates from before applied_labor_rate was consistently stored.
    const woLaborRate =
      storedAppliedRate > 0 ? storedAppliedRate :
      storedLaborRate > 0 ? storedLaborRate :
      defaultLaborRate;

    const itemRows: PdfWorkOrderItemRow[] = (items ?? []).map(item => {
      const unitPrice = safeNum(item.partPrice);
      const qty = safeNum(item.quantity);
      const laborHours = safeNum(item.laborHours);
      const rowTotal = safeNum(item.totalPrice, unitPrice * qty);
      return {
        partName: safeStr(item.partName, 'Unknown Part'),
        partDescription: '',
        quantity: safeStr(String(item.quantity), '0'),
        unitPrice,
        laborHours,
        rowTotal,
        notes: safeStr(item.notes),
      };
    });

    const partsSubtotal = safeNum(workOrder.totalPartsCost, itemRows.reduce((s, r) => s + r.rowTotal, 0));
    const laborSubtotal = safeNum(workOrder.laborSubtotal, totalHours * woLaborRate);
    const rowTotal = safeNum(workOrder.totalAmount, partsSubtotal + laborSubtotal);

    return {
      workOrderNumber: safeStr(workOrder.workOrderNumber),
      projectName: safeStr(workOrder.projectName, 'Service Work'),
      projectAddress: safeStr(workOrder.projectAddress),
      workLocationAddress: safeStr(workOrder.workLocationAddress),
      branchName: workOrder.branchName && workOrder.branchName.trim().length > 0 ? workOrder.branchName.trim() : null,
      controllerLetter: safeStr(workOrder.controllerLetter) || null,
      zoneNumber: workOrder.zoneNumber != null ? Number(workOrder.zoneNumber) : null,
      locationNotes: safeStr(workOrder.locationNotes),
      technicianName: safeStr(workOrder.completedByUserName || workOrder.assignedTechnicianName, 'N/A'),
      completedAt: workOrder.completedAt ? new Date(workOrder.completedAt) : null,
      totalHours,
      laborRate: woLaborRate,
      workDescription: safeStr(workOrder.description),
      workSummary: safeStr(workOrder.workSummary),
      aiDetailedDescription: safeStr(workOrder.aiDetailedDescription),
      photos: safePhotos(workOrder.photos),
      items: itemRows,
      partsSubtotal,
      laborSubtotal,
      rowTotal,
      approvedBy: safeStr(workOrder.approvedBy) || null,
      approvedAt: workOrder.approvedAt ? new Date(workOrder.approvedAt) : null,
    };
  });

  const billingSheetRows: PdfBillingSheetRow[] = (rawBillingSheets ?? []).map(({ billingSheet, items, wetCheckView }) => {
    const totalHours = safeNum(billingSheet.totalHours);
    const bsStoredLaborSubtotal = safeNum(billingSheet.laborSubtotal);
    const bsStoredLaborRate = safeNum(billingSheet.laborRate);
    // Rate priority: stored laborRate field → customer's current rate.
    // Math-derivation is excluded for the same reason as work orders.
    const bsLaborRate =
      bsStoredLaborRate > 0 ? bsStoredLaborRate :
      defaultLaborRate;

    const itemRows: PdfBillingSheetItemRow[] = (items ?? []).map(item => {
      const unitPrice = safeNum(item.unitPrice);
      const qty = safeNum(item.quantity);
      const laborHours = safeNum(item.laborHours);
      const rowTotal = safeNum(item.totalPrice, unitPrice * qty);
      return {
        partName: safeStr(item.partName, 'Unknown Part'),
        partDescription: safeStr(item.partDescription),
        quantity: safeStr(String(item.quantity), '0'),
        unitPrice,
        laborHours,
        rowTotal,
        notes: safeStr(item.notes),
      };
    });

    const partsSubtotal = safeNum(billingSheet.partsSubtotal, itemRows.reduce((s, r) => s + r.rowTotal, 0));
    const laborSubtotal = safeNum(billingSheet.laborSubtotal, totalHours * bsLaborRate);
    const rowTotal = safeNum(billingSheet.totalAmount, partsSubtotal + laborSubtotal);

    return {
      billingNumber: safeStr(billingSheet.billingNumber),
      workDescription: safeStr(billingSheet.workDescription, 'Additional Work'),
      propertyAddress: safeStr(billingSheet.propertyAddress),
      workLocationAddress: safeStr(billingSheet.workLocationAddress),
      branchName: billingSheet.branchName && billingSheet.branchName.trim().length > 0 ? billingSheet.branchName.trim() : null,
      controllerLetter: safeStr(billingSheet.controllerLetter) || null,
      zoneNumber: billingSheet.zoneNumber != null ? Number(billingSheet.zoneNumber) : null,
      technicianName: safeStr(billingSheet.technicianName, 'N/A'),
      workDate: new Date(billingSheet.workDate),
      totalHours,
      laborRate: bsLaborRate,
      aiDetailedDescription: safeStr(billingSheet.aiDetailedDescription),
      notes: safeStr(billingSheet.notes),
      photos: safePhotos(billingSheet.photos),
      items: itemRows,
      partsSubtotal,
      laborSubtotal,
      rowTotal,
      approvedBy: safeStr(billingSheet.approvedBy) || null,
      approvedAt: billingSheet.approvedAt ? new Date(billingSheet.approvedAt) : null,
      wetCheckView: wetCheckView ?? undefined,
    };
  });

  const wcbRows: PdfWetCheckBillingRow[] = data.wetCheckBillings ?? [];

  const computedPartsSubtotal =
    workOrderRows.reduce((s, r) => s + r.partsSubtotal, 0) +
    billingSheetRows.reduce((s, r) => s + r.partsSubtotal, 0) +
    wcbRows.reduce((s, r) => s + safeNum(r.wetCheckBilling.partsSubtotal), 0);

  const computedLaborSubtotal =
    workOrderRows.reduce((s, r) => s + r.laborSubtotal, 0) +
    billingSheetRows.reduce((s, r) => s + r.laborSubtotal, 0) +
    wcbRows.reduce((s, r) => s + safeNum(r.wetCheckBilling.laborSubtotal), 0);

  const computedGrandTotal =
    workOrderRows.reduce((s, r) => s + r.rowTotal, 0) +
    billingSheetRows.reduce((s, r) => s + r.rowTotal, 0) +
    wcbRows.reduce((s, r) => s + safeNum(r.wetCheckBilling.totalAmount), 0);

  const storedTotalAmount = safeNum(invoice.totalAmount);

  const totals: PdfTotals = {
    partsSubtotal: safeNum(invoice.partsSubtotal, computedPartsSubtotal),
    laborSubtotal: safeNum(invoice.laborSubtotal, computedLaborSubtotal),
    grandTotal: storedTotalAmount,
    storedTotalAmount,
  };

  let validationWarning: string | null = null;
  const TOLERANCE = 0.01;
  const delta = Math.abs(computedGrandTotal - storedTotalAmount);
  if (delta > TOLERANCE) {
    validationWarning =
      `Invoice total mismatch: computed $${computedGrandTotal.toFixed(2)} vs stored $${storedTotalAmount.toFixed(2)} (delta $${delta.toFixed(2)}) for invoice ${invoice.invoiceNumber}`;
    console.warn('[PDF View Model]', validationWarning);
  }

  const customerHasBranches = data.customerHasBranches === true;

  const branchSubtotals: PdfBranchSubtotal[] = [];
  if (customerHasBranches) {
    const groups = new Map<string, PdfBranchSubtotal>();
    const getGroup = (label: string) => {
      let g = groups.get(label);
      if (!g) {
        g = { branchName: label, workOrders: [], billingSheets: [], subtotal: 0 };
        groups.set(label, g);
      }
      return g;
    };
    const UNASSIGNED = '(No branch)';
    for (const wo of workOrderRows) {
      const g = getGroup(wo.branchName ?? UNASSIGNED);
      g.workOrders.push(wo);
      g.subtotal += wo.rowTotal;
    }
    for (const bs of billingSheetRows) {
      const g = getGroup(bs.branchName ?? UNASSIGNED);
      g.billingSheets.push(bs);
      g.subtotal += bs.rowTotal;
    }
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return a.localeCompare(b);
    });
    for (const k of sortedKeys) branchSubtotals.push(groups.get(k)!);
  }

  const viewModel: PdfViewModel = {
    company: companyHeader,
    invoice: invoiceHeader,
    workOrders: workOrderRows,
    billingSheets: billingSheetRows,
    wetCheckBillings: wcbRows,
    totals,
    totalJobs: workOrderRows.length + billingSheetRows.length + wcbRows.length,
    validationWarning,
    brandColors: data.brandColors ?? DEFAULT_BRAND_COLORS,
    customerHasBranches,
    branchSubtotals,
  };

  return { viewModel, validationWarning };
}
