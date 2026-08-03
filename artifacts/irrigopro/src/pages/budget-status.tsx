// Task #1866 — Budget Status Page.
//
// Full-visibility page for managers showing all budgeted customers ranked
// worst-first. Accessible to: super_admin, company_admin, billing_manager,
// irrigation_manager.
//
// Layout:
//   1. Company roll-up header (combined spend vs. combined allocations,
//      season-to-date vs. target)
//   2. Filter bar (status: All / Go / Slow down / Stop / Unset, hide Unset
//      toggle, month selector)
//   3. Per-customer table sorted worst-first.
//   4. lastRefreshedAt timestamp.
//
// NO edit controls anywhere on this page.

import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Calendar,
  RefreshCw,
  TrendingUp,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { adaptiveRefetchInterval } from "@/lib/queryClient";
import { BudgetBar } from "@/components/budget/BudgetBar";

// ─── Types ──────────────────────────────────────────────────────────────────

interface BudgetStatusRow {
  customerId: number;
  customerName: string;
  allocation: number | null;
  invoicedAmount: number;
  pendingAmount: number;
  totalSpend: number;
  fillPercent: number | null;
  status: "Go" | "Slow down" | "Stop" | "Unset";
  softThresholdPercent: number;
  hardThresholdPercent: number;
  seasonToDateTarget: number;
  seasonToDateSpend: number;
  seasonToDateInvoiced: number;
  seasonToDatePending: number;
  annualGoal: number | null;
}

interface BudgetStatusResponse {
  year: number;
  month: number;
  lastRefreshedAt: string;
  rollup: {
    totalAllocation: number;
    totalSpend: number;
    totalInvoiced: number;
    totalPending: number;
    customersWithAllocation: number;
    overCapCount: number;
    approachingCount: number;
    seasonToDateTarget: number;
    seasonToDateSpend: number;
  };
  rows: BudgetStatusRow[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmtCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
function fmt(n: number) { return fmtCurrency.format(n); }

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type StatusFilter = "All" | "Go" | "Slow down" | "Stop" | "Unset";

const STATUS_BADGE: Record<string, string> = {
  Go:          "bg-green-100 text-green-800 border-green-300",
  "Slow down": "bg-amber-100 text-amber-800 border-amber-300",
  Stop:        "bg-red-100 text-red-800 border-red-300",
  Unset:       "bg-gray-100 text-gray-500 border-gray-200",
};

// ─── Roll-up header ──────────────────────────────────────────────────────────

function RollupHeader({ rollup, year, month }: {
  rollup: BudgetStatusResponse["rollup"];
  year: number;
  month: number;
}) {
  const fillPct = rollup.totalAllocation > 0
    ? (rollup.totalSpend / rollup.totalAllocation) * 100
    : null;
  const seasonFillPct = rollup.seasonToDateTarget > 0
    ? (rollup.seasonToDateSpend / rollup.seasonToDateTarget) * 100
    : null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-blue-600" />
          <h2 className="text-sm font-semibold text-gray-900">
            Company Roll-up — {MONTH_NAMES[month]} {year}
          </h2>
          {rollup.overCapCount > 0 && (
            <Badge className="ml-auto bg-red-100 text-red-800 border border-red-300 text-xs">
              {rollup.overCapCount} over cap
            </Badge>
          )}
          {rollup.approachingCount > 0 && (
            <Badge className={`${rollup.overCapCount > 0 ? "" : "ml-auto"} bg-amber-100 text-amber-800 border border-amber-300 text-xs`}>
              {rollup.approachingCount} approaching
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">Monthly Allocation</p>
            <p className="text-lg font-bold text-gray-900">{fmt(rollup.totalAllocation)}</p>
            <p className="text-xs text-gray-400 mt-0.5">{rollup.customersWithAllocation} customers set</p>
          </div>
          <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
            <p className="text-xs text-blue-700 font-medium uppercase tracking-wide mb-1">Monthly Spend</p>
            <p className="text-lg font-bold text-blue-900">{fmt(rollup.totalSpend)}</p>
            {fillPct !== null && (
              <p className="text-xs text-blue-600 mt-0.5">{fillPct.toFixed(0)}% of cap</p>
            )}
          </div>
          <div className="bg-purple-50 rounded-lg p-3 border border-purple-100">
            <p className="text-xs text-purple-700 font-medium uppercase tracking-wide mb-1">Season-to-Date Target</p>
            <p className="text-lg font-bold text-purple-900">{fmt(rollup.seasonToDateTarget)}</p>
          </div>
          <div className="bg-emerald-50 rounded-lg p-3 border border-emerald-100">
            <p className="text-xs text-emerald-700 font-medium uppercase tracking-wide mb-1">Season-to-Date Spend</p>
            <p className="text-lg font-bold text-emerald-900">{fmt(rollup.seasonToDateSpend)}</p>
            {seasonFillPct !== null && (
              <p className="text-xs text-emerald-600 mt-0.5">{seasonFillPct.toFixed(0)}% of target</p>
            )}
          </div>
        </div>

        {/* Monthly company bar */}
        <BudgetBar
          invoicedAmount={rollup.totalInvoiced}
          pendingAmount={rollup.totalPending}
          allocation={rollup.totalAllocation > 0 ? rollup.totalAllocation : null}
          softThresholdPercent={75}
          hardThresholdPercent={100}
        />
      </CardContent>
    </Card>
  );
}

// ─── Customer row ─────────────────────────────────────────────────────────────

function CustomerRow({ row }: { row: BudgetStatusRow }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="border-b border-gray-50 last:border-0">
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href={`/customers/${row.customerId}/profile?tab=billing#budget-and-alerts`}>
                <a className="text-sm font-medium text-gray-900 hover:text-blue-600 truncate">
                  {row.customerName}
                </a>
              </Link>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_BADGE[row.status] ?? STATUS_BADGE.Unset}`}
              >
                {row.status}
              </span>
            </div>
          </div>
          <button
            onClick={() => setExpanded((p) => !p)}
            className="text-gray-400 hover:text-gray-600 shrink-0 mt-0.5"
            aria-label={expanded ? "Collapse details" : "Expand details"}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {/* Monthly bar */}
        <BudgetBar
          invoicedAmount={row.invoicedAmount}
          pendingAmount={row.pendingAmount}
          allocation={row.allocation}
          softThresholdPercent={row.softThresholdPercent}
          hardThresholdPercent={row.hardThresholdPercent}
        />

        {/* Season-to-date bar (expanded) */}
        {expanded && (
          <div className="mt-3 pl-0 space-y-1">
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Season-to-Date</p>
            <BudgetBar
              invoicedAmount={row.seasonToDateInvoiced}
              pendingAmount={row.seasonToDatePending}
              allocation={row.seasonToDateTarget > 0 ? row.seasonToDateTarget : null}
              softThresholdPercent={row.softThresholdPercent}
              hardThresholdPercent={row.hardThresholdPercent}
              thin
            />
            {row.annualGoal !== null && (
              <p className="text-[10px] text-gray-400 mt-1">
                Annual goal: {fmt(row.annualGoal)}
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BudgetStatusPage() {
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [hideUnset, setHideUnset] = useState(false);

  const { data, isLoading } = useQuery<BudgetStatusResponse | null>({
    queryKey: [`/api/budget/status?year=${selectedYear}&month=${selectedMonth}`],
    refetchInterval: adaptiveRefetchInterval(60_000),
    staleTime: 30_000,
  });

  const filteredRows = useMemo(() => {
    let rows = data?.rows ?? [];
    if (hideUnset) {
      rows = rows.filter((r) => r.status !== "Unset");
    }
    if (statusFilter !== "All") {
      rows = rows.filter((r) => r.status === statusFilter);
    }
    return rows;
  }, [data?.rows, statusFilter, hideUnset]);

  // Month selector: current year going back 12 months.
  const monthOptions = useMemo(() => {
    const opts: Array<{ year: number; month: number; label: string }> = [];
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let i = 0; i < 12; i++) {
      opts.push({
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        label: `${MONTH_NAMES[d.getMonth() + 1]} ${d.getFullYear()}`,
      });
      d.setMonth(d.getMonth() - 1);
    }
    return opts;
  }, []);

  const STATUS_FILTERS: StatusFilter[] = ["All", "Stop", "Slow down", "Go", "Unset"];

  return (
    <div className="max-w-5xl mx-auto py-4 px-4 space-y-4" data-testid="budget-status-page">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Budget Status</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Customer spend vs. monthly allocation — sorted worst-first.
        </p>
      </div>

      {/* Roll-up header */}
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : data ? (
        <RollupHeader
          rollup={data.rollup}
          year={data.year}
          month={data.month}
        />
      ) : null}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Month selector */}
        <div className="flex items-center gap-1.5 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
          <Calendar className="w-3.5 h-3.5 text-gray-400" />
          <select
            data-testid="month-selector"
            className="text-sm text-gray-700 bg-transparent border-0 outline-none cursor-pointer"
            value={`${selectedYear}-${selectedMonth}`}
            onChange={(e) => {
              const [y, m] = e.target.value.split("-").map(Number);
              setSelectedYear(y);
              setSelectedMonth(m);
            }}
          >
            {monthOptions.map((o) => (
              <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Status filter pills */}
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                statusFilter === f
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
              data-testid={`filter-${f.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Hide Unset toggle */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideUnset}
            onChange={(e) => setHideUnset(e.target.checked)}
            className="w-3.5 h-3.5 rounded"
          />
          <span className="text-xs text-gray-600">Hide Unset</span>
        </label>
      </div>

      {/* Customer table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded" />
              ))}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-400">
              No customers match the current filter.
            </div>
          ) : (
            <ul data-testid="customer-list">
              {filteredRows.map((row) => (
                <CustomerRow key={row.customerId} row={row} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Last refreshed */}
      {data?.lastRefreshedAt && (
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <RefreshCw className="w-3 h-3" />
          Last refreshed: {new Date(data.lastRefreshedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
