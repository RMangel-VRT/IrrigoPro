/**
 * The invoice page header (Task #1942).
 *
 * Answers the two questions a bookkeeper opens this page with — how much is
 * outstanding, and is QuickBooks telling us the truth — before she scrolls.
 *
 * THE DOLLAR TOTAL IS NOT SUMMED FROM THE LOADED ROWS. The list is an
 * infinite query paginated at 50, so summing what is on screen reports the
 * first page's balance and calls it the filter's balance. It comes from
 * `/api/invoices/aging-summary`, which sums the whole filtered set on the
 * server; the count comes from the list's own post-filter total header.
 */

import type { ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronLeft, FileText, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format-currency";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sync older than this is reported as stale rather than as a tick. */
export const QB_SYNC_STALE_AFTER_MS = DAY_MS;

export type QbSyncState = "fresh" | "stale" | "never";

export function qbSyncStateOf(
  paymentSyncedAt: string | null | undefined,
  now: Date,
): QbSyncState {
  if (!paymentSyncedAt) return "never";
  const at = new Date(paymentSyncedAt).getTime();
  if (Number.isNaN(at)) return "never";
  return now.getTime() - at > QB_SYNC_STALE_AFTER_MS ? "stale" : "fresh";
}

function formatWhen(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function InvoicePageHeader({
  outstandingBalance,
  invoiceCount,
  summaryLoading,
  canSeeQuickBooksStatus,
  canRunPaymentSync,
  lastPaymentSyncAt,
  onRunPaymentSync,
  isSyncing,
  now,
  actions,
}: {
  /** Server-computed, for the whole filtered set. Null while it is loading. */
  outstandingBalance: string | null;
  /** The list response's post-filter total. */
  invoiceCount: number | null;
  summaryLoading: boolean;
  canSeeQuickBooksStatus: boolean;
  canRunPaymentSync: boolean;
  lastPaymentSyncAt: string | null;
  onRunPaymentSync: () => void;
  isSyncing: boolean;
  now: Date;
  actions?: ReactNode;
}) {
  const syncState = qbSyncStateOf(lastPaymentSyncAt, now);
  const warn = syncState !== "fresh";

  return (
    <div className="mb-6" data-testid="invoice-page-header">
      <div className="mb-1 flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="sm" className="h-auto p-1 text-gray-500 hover:text-gray-700">
            <ChevronLeft className="mr-1 h-4 w-4" />
            Dashboard
          </Button>
        </Link>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <FileText className="h-6 w-6 text-blue-600" />
            Invoices
          </h1>
          <p className="mt-0.5 text-sm text-gray-600" data-testid="invoice-header-summary">
            <span className="font-semibold text-gray-900" data-testid="invoice-header-outstanding">
              {outstandingBalance == null
                ? summaryLoading
                  ? "…"
                  : "—"
                : formatCurrency(outstandingBalance)}
            </span>{" "}
            outstanding ·{" "}
            <span data-testid="invoice-header-count">
              {invoiceCount == null ? "…" : invoiceCount}
            </span>{" "}
            open invoice{invoiceCount === 1 ? "" : "s"} in this view
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Gated by absence, not by disabling: a role that cannot manage the
              QuickBooks connection is not shown its health either. */}
          {canSeeQuickBooksStatus && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                warn
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
              data-testid="qb-sync-pill"
              data-sync-state={syncState}
              title={
                syncState === "never"
                  ? "No QuickBooks payment sync has ever run for this company, so every balance below is the invoice total rather than what is actually owed."
                  : syncState === "stale"
                    ? `QuickBooks payments were last read on ${formatWhen(lastPaymentSyncAt!)} — more than 24 hours ago. Balances may be out of date.`
                    : `QuickBooks payments last read on ${formatWhen(lastPaymentSyncAt!)}.`
              }
            >
              {warn ? (
                <AlertTriangle className="h-3.5 w-3.5" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              {syncState === "never"
                ? "QuickBooks: never synced"
                : syncState === "stale"
                  ? "QuickBooks: out of date"
                  : "QuickBooks: up to date"}
            </span>
          )}
          {canRunPaymentSync && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRunPaymentSync}
              disabled={isSyncing}
              data-testid="button-refresh-payment-status"
              title="Refresh payment status from QuickBooks"
            >
              {isSyncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Sync payments
            </Button>
          )}
          {actions}
        </div>
      </div>
    </div>
  );
}
