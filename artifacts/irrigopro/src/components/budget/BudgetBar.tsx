// Task #1866 — Budget Status Page + Manager Workspace Card.
//
// Shared BudgetBar component used by BudgetStatusCard (manager workspace),
// BudgetStatusPage, and the crew view. One source of truth for rendering
// so both surfaces can never drift.
//
// Props:
//   invoicedAmount      — already-invoiced portion of spend
//   pendingAmount       — worked-but-not-yet-billed (pending) portion
//   allocation          — monthly allocation cap; null → "Unset" track
//   softThresholdPercent — percent at which "Slow down" begins (default 75)
//   hardThresholdPercent — percent at which "Stop" begins (default 100)
//   thin                — renders a shorter track height (season-to-date row)
//   hideLabel           — suppresses the status pill (crew bar variant)
//
// Accessibility: colour is NOT the only differentiator — the pill text
// carries the accessible label for every status ("Go", "Slow down",
// "Stop", "Unset"). Segments are visually distinct via solid vs hatched
// opacity, not just hue.

import { cn } from "@/lib/utils";

export type BudgetStatus = "healthy" | "approaching" | "over" | "unset";

export interface BudgetBarProps {
  /** Invoiced (billed) portion of the monthly spend. */
  invoicedAmount: number;
  /** Pending / worked-but-not-yet-billed portion. */
  pendingAmount: number;
  /** Monthly allocation cap. Pass null for "Unset". */
  allocation: number | null;
  /** Percent at which status becomes "Slow down". Default 75. */
  softThresholdPercent?: number;
  /** Percent at which status becomes "Stop". Default 100. */
  hardThresholdPercent?: number;
  /**
   * Override the computed status entirely. Used by the crew view to surface
   * the server-derived status (which honours each customer's custom thresholds)
   * without re-deriving it client-side with fixed 75/100% defaults.
   */
  forcedStatus?: BudgetStatus;
  /** Use a shorter track height (season-to-date variant). */
  thin?: boolean;
  /** Hide the status pill (crew-view: show bar width only). */
  hideLabel?: boolean;
  /** Hide dollar amounts row entirely (crew view). */
  hideDollars?: boolean;
  /** Extra CSS on the outermost wrapper. */
  className?: string;
}

function classifyStatus(
  fillPercent: number | null,
  soft: number,
  hard: number,
): BudgetStatus {
  if (fillPercent === null) return "unset";
  if (fillPercent >= hard) return "over";
  if (fillPercent >= soft) return "approaching";
  return "healthy";
}

const STATUS_PILL_CLASSES: Record<BudgetStatus, string> = {
  healthy:    "bg-green-100 text-green-800 border border-green-300",
  approaching: "bg-amber-100 text-amber-800 border border-amber-300",
  over:       "bg-red-100 text-red-800 border border-red-300",
  unset:      "bg-gray-100 text-gray-500 border border-gray-200",
};

const STATUS_LABEL: Record<BudgetStatus, string> = {
  healthy:    "Go",
  approaching: "Slow down",
  over:       "Stop",
  unset:      "Unset",
};

const INVOICED_TRACK_CLASSES: Record<BudgetStatus, string> = {
  healthy:    "bg-green-500",
  approaching: "bg-amber-500",
  over:       "bg-red-500",
  unset:      "bg-gray-300",
};

const PENDING_TRACK_CLASSES: Record<BudgetStatus, string> = {
  healthy:    "bg-green-200",
  approaching: "bg-amber-200",
  over:       "bg-red-200",
  unset:      "bg-gray-200",
};

const fmtCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function fmt(n: number) { return fmtCurrency.format(n); }

export function BudgetBar({
  invoicedAmount,
  pendingAmount,
  allocation,
  softThresholdPercent = 75,
  hardThresholdPercent = 100,
  forcedStatus,
  thin = false,
  hideLabel = false,
  hideDollars = false,
  className,
}: BudgetBarProps) {
  const totalSpend = invoicedAmount + pendingAmount;

  // fillPercent: null when unset; clamped at 100% for display purposes only.
  // The true (unclamped) value drives the pill label.
  let rawPercent: number | null = null;
  let invoicedPct = 0;
  let pendingPct = 0;
  if (allocation !== null && allocation > 0) {
    rawPercent = (totalSpend / allocation) * 100;
    const clampedTotal = Math.min(totalSpend, allocation);
    invoicedPct = Math.min((invoicedAmount / allocation) * 100, 100);
    // Pending fills up to the cap; cannot push total beyond track width.
    const pendingCapped = Math.max(0, clampedTotal - invoicedAmount);
    pendingPct = (pendingCapped / allocation) * 100;
  }

  // forcedStatus overrides the locally-computed status. The crew view uses
  // this to pass the server-derived status (which reflects each customer's
  // custom soft/hard thresholds) without re-deriving it at 75/100% defaults.
  const status = forcedStatus ?? classifyStatus(rawPercent, softThresholdPercent, hardThresholdPercent);

  // Build pill label: for "over", show clamped percentage.
  let pillLabel = STATUS_LABEL[status];
  if (status === "over" && rawPercent !== null) {
    pillLabel = `Stop — ${Math.round(rawPercent)}%`;
  }

  const trackHeight = thin ? "h-1.5" : "h-3";

  return (
    <div className={cn("space-y-1", className)}>
      {/* Status pill + (optional) dollar amounts */}
      {(!hideLabel || !hideDollars) && (
        <div className="flex items-center justify-between gap-2 min-h-[18px]">
          {!hideLabel && (
            <span
              className={cn(
                "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-none",
                STATUS_PILL_CLASSES[status],
              )}
              aria-label={`Budget status: ${pillLabel}`}
            >
              {pillLabel}
            </span>
          )}
          {hideLabel && <span />}
          {!hideDollars && allocation !== null && (
            <span className="text-[10px] text-gray-500 shrink-0">
              {fmt(totalSpend)} / {fmt(allocation)}
            </span>
          )}
          {!hideDollars && allocation === null && (
            <span className="text-[10px] text-gray-400 italic shrink-0">No allocation</span>
          )}
        </div>
      )}

      {/* Track */}
      <div
        className={cn(
          "relative w-full rounded-full overflow-hidden bg-gray-100",
          trackHeight,
        )}
        role="progressbar"
        aria-valuenow={rawPercent !== null ? Math.round(Math.min(rawPercent, 100)) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Budget usage: ${pillLabel}`}
      >
        {/* Invoiced segment (solid) */}
        {invoicedPct > 0 && (
          <div
            className={cn(
              "absolute left-0 top-0 h-full transition-all duration-300",
              INVOICED_TRACK_CLASSES[status],
            )}
            style={{ width: `${invoicedPct}%` }}
          />
        )}
        {/* Pending segment (lighter tint, starts right after invoiced) */}
        {pendingPct > 0 && (
          <div
            className={cn(
              "absolute top-0 h-full transition-all duration-300",
              PENDING_TRACK_CLASSES[status],
            )}
            style={{
              left: `${invoicedPct}%`,
              width: `${pendingPct}%`,
            }}
          />
        )}
        {/* Cap marker at 100% — always visible on allocated tracks */}
        {allocation !== null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-gray-400 opacity-60"
            style={{ left: "100%" }}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Segment legend (only on non-thin, non-crew bars with allocation) */}
      {!thin && !hideDollars && allocation !== null && (invoicedAmount > 0 || pendingAmount > 0) && (
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          {invoicedAmount > 0 && (
            <span className="flex items-center gap-1">
              <span className={cn("inline-block w-2 h-2 rounded-sm", INVOICED_TRACK_CLASSES[status])} />
              Invoiced {fmt(invoicedAmount)}
            </span>
          )}
          {pendingAmount > 0 && (
            <span className="flex items-center gap-1">
              <span className={cn("inline-block w-2 h-2 rounded-sm", PENDING_TRACK_CLASSES[status])} />
              Pending {fmt(pendingAmount)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
