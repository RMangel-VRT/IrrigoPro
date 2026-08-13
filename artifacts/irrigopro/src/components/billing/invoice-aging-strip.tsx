/**
 * The aging strip (Task #1942).
 *
 * Four cards across the top of the invoice list — Not yet due, 0–29, 30–59,
 * 60+ — each showing what is sitting in that bucket and filtering the table
 * when clicked.
 *
 * Every number and every label comes from `GET /api/invoices/aging-summary`,
 * which sums the same annotated rows the list itself filters and labels them
 * from `lib/shared/src/invoice-aging.ts`. Nothing here re-derives a bucket, a
 * boundary or a total: a strip that computed its own answer from the loaded
 * page would disagree with the table underneath it the moment the list
 * paginated.
 */

import { Loader2 } from "lucide-react";
import { formatCurrency } from "@/lib/format-currency";
import type { AgingFilter } from "@/lib/invoice-ar-query";

export interface AgingBucketTotal {
  key: string;
  /** From the shared aging module. The client never writes its own label. */
  label: string;
  /** What clicking this card sets `?aging=` to. */
  filterValue: AgingFilter;
  balanceDue: string;
  count: number;
}

export interface AgingSummary {
  buckets: AgingBucketTotal[];
  overall: { balanceDue: string; count: number };
  /**
   * The company's last QuickBooks payment sync, computed server-side over
   * every invoice in the company rather than the filtered set — the pill
   * describes the connection, not the rows on screen.
   */
  lastPaymentSyncAt?: string | null;
}

/**
 * The header's two numbers, taken from one population.
 *
 * The aggregate is deliberately fetched without `?aging=` — the strip has to
 * keep showing the other three buckets while one is selected. The header does
 * not: it says "in this view", so once a bucket is selected it must report
 * that bucket.
 *
 * Balance *and* count both come from here, and that matters. The list's
 * post-filter total counts every row the table shows, including paid, void
 * and superseded invoices; the aggregate counts only open A/R. Pairing the
 * aggregate's dollars with the list's count would put a balance and a count
 * from two different populations side by side — "$12,400 outstanding across
 * 61 invoices" when only 45 of them owe anything.
 */
export function agingTotalsForView(
  summary: AgingSummary | undefined,
  aging: AgingFilter,
): { balanceDue: string; count: number } | null {
  if (!summary) return null;
  if (aging === "all") {
    return summary.overall
      ? { balanceDue: summary.overall.balanceDue, count: summary.overall.count }
      : null;
  }
  const buckets = summary.buckets ?? [];
  const wanted =
    aging === "overdue"
      ? buckets.filter((b) => b.filterValue !== "current")
      : buckets.filter((b) => b.filterValue === aging);
  if (wanted.length === 0) return null;
  return {
    balanceDue: wanted
      .reduce((sum, b) => sum + (parseFloat(b.balanceDue) || 0), 0)
      .toFixed(2),
    count: wanted.reduce((sum, b) => sum + b.count, 0),
  };
}

export function InvoiceAgingStrip({
  summary,
  isLoading,
  isError,
  active,
  onSelect,
}: {
  summary: AgingSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  /** The `?aging=` value currently in the URL. */
  active: AgingFilter;
  onSelect: (value: AgingFilter) => void;
}) {
  if (isError) {
    return (
      <div
        className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        data-testid="ar-aging-strip-error"
      >
        Aging totals could not be loaded. The list below is unaffected.
      </div>
    );
  }

  const buckets = summary?.buckets ?? [];

  return (
    <div
      className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"
      data-testid="ar-aging-strip"
      role="group"
      aria-label="Outstanding balance by age"
    >
      {isLoading && buckets.length === 0
        ? [0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-lg border border-gray-200 bg-white px-4 py-3"
              data-testid={`ar-aging-card-skeleton-${i}`}
            >
              <Loader2 className="h-4 w-4 animate-spin text-gray-300" />
            </div>
          ))
        : buckets.map((bucket) => {
            const isActive = active === bucket.filterValue;
            return (
              <button
                key={bucket.key}
                type="button"
                // Clicking the bucket you are already in steps back out of it,
                // so the strip can undo itself without hunting for the chip.
                onClick={() => onSelect(isActive ? "all" : bucket.filterValue)}
                aria-pressed={isActive}
                className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                  isActive
                    ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500"
                    : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
                }`}
                data-testid={`ar-aging-card-${bucket.filterValue}`}
              >
                <div className="text-xs font-medium text-gray-500">{bucket.label}</div>
                <div
                  className={`mt-1 text-lg font-bold ${
                    bucket.key === "days90" && parseFloat(bucket.balanceDue) > 0
                      ? "text-red-700"
                      : "text-gray-900"
                  }`}
                  data-testid={`ar-aging-card-total-${bucket.filterValue}`}
                >
                  {formatCurrency(bucket.balanceDue)}
                </div>
                <div
                  className="text-xs text-gray-500"
                  data-testid={`ar-aging-card-count-${bucket.filterValue}`}
                >
                  {bucket.count} invoice{bucket.count === 1 ? "" : "s"}
                </div>
              </button>
            );
          })}
    </div>
  );
}
