// Task #1918 — one rule for "which ticket is this line item, and when was the
// work actually done".
//
// Two readers need the same answer and must not answer it differently:
//
//   1. the invoice audit view (`/api/invoices/:invoiceId/audit`), which has
//      derived a real source work date since long before this module existed;
//   2. the single-invoice line-item read (`/api/invoices/:id/items`), which
//      feeds the draft editor and the expanded row on the invoices list.
//
// `invoice_items.work_date` is a snapshot taken when the item was written. The
// source ticket is the authority — a billing sheet whose work date was
// corrected after invoicing has the right date, and the item row does not. The
// audit view already preferred the source; this module is that preference,
// lifted out so the second reader shares it rather than growing a second rule
// beside it.
//
// The ticket *number* is the other half. An item row carries internal ids and
// nothing a human can look up: "10" is not a ticket anyone can find, "BS-010"
// is. The number lives only on the source row, so resolving it means loading
// the source anyway — which is exactly what the work date already needs.
//
// Nothing here reads the invoice. Callers resolve the invoice company-scoped
// first and hand the items in; this module never widens that scope.

/** The subset of an `invoice_items` row this module reads. */
export interface InvoiceItemSourceRef {
  sourceType: string;
  sourceId?: number | null;
  workOrderId?: number | null;
  billingSheetId?: number | null;
  wetCheckBillingId?: number | null;
  workDate?: Date | string | null;
}

/** A loaded work order / billing sheet / wet-check billing row, or nothing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LoadedTicketSource = Record<string, any> | null | undefined;

/** Short human label for a source type — the badge on a line-item row. */
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  work_order: "WO",
  billing_sheet: "BS",
  wet_check_billing: "WCB",
};

/**
 * Which source row this item points at. The typed column wins; `sourceId` is
 * the fallback for legacy rows written before the per-type columns existed.
 */
export function sourceIdOf(item: InvoiceItemSourceRef): number | null {
  switch (item.sourceType) {
    case "work_order":
      return item.workOrderId ?? item.sourceId ?? null;
    case "billing_sheet":
      return item.billingSheetId ?? item.sourceId ?? null;
    case "wet_check_billing":
      return item.wetCheckBillingId ?? item.sourceId ?? null;
    default:
      return item.sourceId ?? null;
  }
}

/**
 * The work date, preferring the source ticket over the item's snapshot.
 *
 * This is the audit view's rule, unchanged: a work order has no work date of
 * its own, so completion is the closest thing to one and the last update is
 * the closest thing to that. A billing sheet and a wet-check billing both
 * carry a real `workDate`.
 *
 * With no source row loaded — deleted, or simply not resolvable for this
 * caller — the item's own snapshot stands. It is stale, not wrong.
 */
export function deriveSourceWorkDate(
  sourceType: string,
  source: LoadedTicketSource,
  fallback: Date | string | null | undefined,
): Date | string | null {
  if (!source) return fallback ?? null;
  switch (sourceType) {
    case "work_order":
      return source.completedAt || source.updatedAt || fallback || null;
    case "billing_sheet":
      return source.workDate || fallback || null;
    case "wet_check_billing":
      return source.workDate || fallback || null;
    default:
      return fallback ?? null;
  }
}

/**
 * The human-readable ticket number off the source row, or `null` when there is
 * no source row to read it from. `null` is deliberate: a caller must render
 * something honest ("BS #10") rather than being handed a fabricated number.
 */
export function deriveSourceTicketNumber(
  sourceType: string,
  source: LoadedTicketSource,
): string | null {
  if (!source) return null;
  switch (sourceType) {
    case "work_order":
      return source.workOrderNumber ?? null;
    case "billing_sheet":
      return source.billingNumber ?? null;
    case "wet_check_billing":
      return source.billingNumber ?? null;
    default:
      return null;
  }
}

/** The storage surface this module needs. Narrow on purpose — easy to spy. */
export interface TicketSourceStorage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getWorkOrder(id: number, companyId: number | null): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getBillingSheetById(id: number, companyId: number | null): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getWetCheckBillingById(id: number, companyId: number | null): Promise<any>;
}

async function loadTicketSource(
  storage: TicketSourceStorage,
  sourceType: string,
  id: number,
  callerCompanyId: number | null,
): Promise<LoadedTicketSource> {
  try {
    switch (sourceType) {
      case "work_order":
        return await storage.getWorkOrder(id, callerCompanyId);
      case "billing_sheet":
        return await storage.getBillingSheetById(id, callerCompanyId);
      case "wet_check_billing":
        // `wet_check_billings` has no company column of its own, so the audit
        // view passes null here too. The invoice this item belongs to has
        // already been resolved company-scoped by the caller, which is what
        // keeps this from being a cross-company read.
        return await storage.getWetCheckBillingById(id, null);
      default:
        return null;
    }
  } catch {
    // A source that cannot be read degrades to the item's own snapshot rather
    // than failing the whole line-item read.
    return null;
  }
}

export interface EnrichedInvoiceItem {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  /** e.g. "BS-010". Null when the source row could not be read. */
  sourceNumber: string | null;
  /** "BS" / "WO" / "WCB", or the raw source type for anything unrecognised. */
  sourceTypeLabel: string;
  workDate: Date | string | null;
}

/**
 * Item rows plus the source ticket's number and the derived work date.
 *
 * Source rows are loaded once per ticket, not once per item: several item rows
 * can share one ticket, and a fifty-item invoice should not issue fifty reads
 * of the same billing sheet.
 */
export async function enrichInvoiceItemsWithSource<T extends InvoiceItemSourceRef>(
  items: readonly T[],
  deps: { storage: TicketSourceStorage; callerCompanyId: number | null },
): Promise<EnrichedInvoiceItem[]> {
  const cache = new Map<string, LoadedTicketSource>();
  const out: EnrichedInvoiceItem[] = [];

  for (const item of items) {
    const id = sourceIdOf(item);
    let source: LoadedTicketSource = null;
    if (id != null) {
      const key = `${item.sourceType}:${id}`;
      if (cache.has(key)) {
        source = cache.get(key);
      } else {
        source = await loadTicketSource(deps.storage, item.sourceType, id, deps.callerCompanyId);
        cache.set(key, source);
      }
    }
    out.push({
      ...(item as object),
      sourceNumber: deriveSourceTicketNumber(item.sourceType, source),
      sourceTypeLabel: SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType,
      workDate: deriveSourceWorkDate(item.sourceType, source, item.workDate),
    } as EnrichedInvoiceItem);
  }

  return out;
}
