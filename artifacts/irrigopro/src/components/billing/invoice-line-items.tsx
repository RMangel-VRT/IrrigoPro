// Task #1918 — the one line-item view.
//
// This markup used to live inline inside the draft-invoice editor on the
// invoices page, wired straight to the remove-ticket mutation and the draft
// editor's own state. The expanded row on the invoices list needs the same
// list, read-only, so it is here rather than copied — two renderings of the
// same rows drift, and the one nobody is looking at drifts first.
//
// The component itself is read-only and carries no mutation wiring at all. The
// draft editor still needs a per-row Remove, so it passes that control in
// through `renderRowAction`: the button belongs to the editor, the row belongs
// to this file.
//
// Line items say four things: which ticket this is, when the work happened,
// what was done, and what it cost. The ticket is named the way a human can
// look it up ("BS-010"), falling back to the type and the internal id only
// when the server could not resolve the source row.

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export interface InvoiceLineItem {
  id: number;
  sourceType: string;
  billingSheetId?: number | null;
  workOrderId?: number | null;
  wetCheckBillingId?: number | null;
  /** Human-readable source ticket number, e.g. "BS-010". Server-derived. */
  sourceNumber?: string | null;
  /** "BS" / "WO" / "WCB". Server-derived; recomputed here for older payloads. */
  sourceTypeLabel?: string | null;
  description: string;
  totalPrice: string;
  /** Derived from the source ticket by the server, not the item snapshot. */
  workDate?: string | null;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  billing_sheet: "BS",
  work_order: "WO",
  wet_check_billing: "WCB",
};

export function sourceTypeLabelOf(item: InvoiceLineItem): string {
  return item.sourceTypeLabel ?? SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType;
}

/** The internal id, for the fallback label and for the remove mutation. */
export function ticketIdOf(item: InvoiceLineItem): number {
  return item.billingSheetId ?? item.workOrderId ?? item.wetCheckBillingId ?? 0;
}

/**
 * "BS-010" when the server resolved the source ticket, "BS #10" when it could
 * not. The second form is deliberately not dressed up as a ticket number — an
 * id nobody can look up should not look like one that can be.
 */
export function ticketRefOf(item: InvoiceLineItem): string {
  const label = sourceTypeLabelOf(item);
  const number = item.sourceNumber?.trim();
  return number ? number : `${label} #${ticketIdOf(item)}`;
}

function formatWorkDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString();
}

function formatAmount(value: string | null | undefined): string {
  return `$${parseFloat(value || "0").toFixed(2)}`;
}

export function InvoiceLineItemsList({
  items,
  isLoading = false,
  emptyLabel = "No tickets attached yet.",
  testId = "invoice-line-items",
  renderRowAction,
}: {
  items: InvoiceLineItem[];
  isLoading?: boolean;
  emptyLabel?: string;
  testId?: string;
  /** Draft-editor-only slot. Absent everywhere the list is read-only. */
  renderRowAction?: (item: InvoiceLineItem) => ReactNode;
}) {
  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-gray-400 py-2"
        data-testid={`${testId}-loading`}
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-xs text-gray-400" data-testid={`${testId}-empty`}>
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul
      className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden"
      data-testid={testId}
    >
      {items.map((item) => {
        const workDate = formatWorkDate(item.workDate);
        return (
          <li
            key={item.id}
            className="flex items-center justify-between gap-3 px-3 py-2 bg-white text-sm"
            data-testid={`${testId}-row-${item.id}`}
          >
            <span
              className="shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600"
              title={`${sourceTypeLabelOf(item)} · internal id ${ticketIdOf(item)}`}
            >
              {ticketRefOf(item)}
            </span>
            <span
              className="shrink-0 text-xs text-gray-500 w-24"
              data-testid={`${testId}-work-date-${item.id}`}
            >
              {workDate ?? "—"}
            </span>
            <span className="flex-1 text-xs text-gray-700 truncate" title={item.description}>
              {item.description}
            </span>
            <span className="shrink-0 text-xs font-medium text-gray-900">
              {formatAmount(item.totalPrice)}
            </span>
            {renderRowAction?.(item)}
          </li>
        );
      })}
    </ul>
  );
}
