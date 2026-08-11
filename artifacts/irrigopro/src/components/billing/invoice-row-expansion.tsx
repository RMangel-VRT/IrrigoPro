// Task #1918 — the expanded region under an invoice row.
//
// Working an aging list means asking the same three questions of one invoice
// after another: what is on it, has anyone chased it, and what did the last
// person record. Those were three separate detours — a PDF modal, a version
// toggle, an audit modal — and none of them put the three side by side while
// the list stayed put. This is the three of them, inline, under the row.
//
// Two properties matter more than the layout:
//
//   * Nothing here is requested until a row opens. The page renders this
//     component only for the row that is expanded, and every query inside it
//     is additionally gated on `open`, so a fifty-row list issues none of
//     these three reads and "Load more" adds none either.
//
//   * Nothing here writes to the URL, the A/R params, or the list query. The
//     page holds the expansion in plain local state for exactly that reason —
//     the effect that clears selection when the A/R params change must never
//     see an expand.
//
// Read-only, deliberately: void, merge, correct, the draft editor, and sending
// a reminder all stay where they already are. The one exception is the A/R
// note compose box, which is append-only and is the panel's own affordance.
//
// Role gating is by absence. A role without the invoice-send capability cannot
// read reminder history at all, so it gets no reminder section rather than a
// 403 rendered as an error or a spinner that never resolves; a role without
// A/R-note access gets no note section and issues no note request. Neither
// gate is the protection — the server refuses both regardless, and the note
// stripping on the server stays authoritative. These gates exist so the UI
// does not show a section it knows will be refused.

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { InvoiceArNotesPanel } from "@/components/billing/invoice-ar-notes-panel";
import { InvoiceReminderPanel } from "@/components/billing/invoice-reminder-panel";
import {
  InvoiceLineItemsList,
  type InvoiceLineItem,
} from "@/components/billing/invoice-line-items";

export function InvoiceRowExpansion({
  invoiceId,
  invoiceNumber,
  open,
  canReadReminders,
  canReadArNotes,
  testIdSuffix = "",
}: {
  invoiceId: number;
  invoiceNumber: string;
  open: boolean;
  /** CAN_SEND_INVOICE_EMAIL — the capability the reminder read is gated on. */
  canReadReminders: boolean;
  /** CAN_READ_AR_NOTES — narrower than invoice-read on purpose. */
  canReadArNotes: boolean;
  /** Desktop and mobile both render an expansion; keeps their testids apart. */
  testIdSuffix?: string;
}) {
  const { data: itemsData, isLoading: itemsLoading } = useQuery<{ items: InvoiceLineItem[] }>({
    queryKey: ["/api/invoices", invoiceId, "items"],
    enabled: open,
  });

  if (!open) return null;

  const items = itemsData?.items ?? [];

  return (
    <div className="space-y-4" data-testid={`invoice-expansion-body${testIdSuffix}`}>
      <div className="space-y-2">
        <h4 className="font-medium text-gray-900 flex items-center gap-1.5 text-sm">
          <FileText className="w-3.5 h-3.5 text-gray-500" />
          Line items
        </h4>
        <InvoiceLineItemsList
          items={items}
          isLoading={itemsLoading}
          emptyLabel="This invoice has no line items."
          testId={`expansion-line-items${testIdSuffix}`}
        />
      </div>

      {canReadReminders && (
        <InvoiceReminderPanel
          invoiceId={invoiceId}
          invoiceNumber={invoiceNumber}
          open={open}
          historyOnly
        />
      )}

      {canReadArNotes && (
        <div className="border-t border-gray-200 pt-4">
          <InvoiceArNotesPanel
            invoiceId={invoiceId}
            invoiceNumber={invoiceNumber}
            open={open}
          />
        </div>
      )}
    </div>
  );
}
