// Task #1866 — Budget Status Page + Manager Workspace Card.
//
// Compact card placed on manager-workspace.tsx alongside the Needs
// Approval card. Shows top ~4 at-risk customers (worst-first), a
// summary header line, and a "View all →" link to the Budget Status page.
//
// Only rendered for roles with full budget visibility (VISIBILITY_ROLES).
// invisible to field_tech.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { TrendingUp, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adaptiveRefetchInterval } from "@/lib/queryClient";
import { BudgetBar } from "./BudgetBar";
import { useAuth } from "@/lib/auth-context";

const FULL_VISIBILITY_ROLES = new Set([
  "super_admin",
  "company_admin",
  "billing_manager",
  "irrigation_manager",
]);

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
}

interface BudgetStatusResponse {
  rollup: {
    overCapCount: number;
    approachingCount: number;
  };
  rows: BudgetStatusRow[];
}

export function BudgetStatusCard() {
  const { user } = useAuth();

  // Only render for full-visibility roles.
  if (!user?.role || !FULL_VISIBILITY_ROLES.has(user.role)) return null;

  return <BudgetStatusCardInner />;
}

function BudgetStatusCardInner() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const { data, isLoading } = useQuery<BudgetStatusResponse | null>({
    queryKey: [`/api/budget/status?year=${year}&month=${month}`],
    refetchInterval: adaptiveRefetchInterval(60_000),
    staleTime: 30_000,
  });

  const rows = data?.rows ?? [];
  const rollup = data?.rollup;

  // Top ~4 at-risk customers (Stop or Slow down first, then Go, then Unset)
  const atRiskRows = rows
    .filter((r) => r.status === "Stop" || r.status === "Slow down")
    .slice(0, 4);

  // If fewer than 4 at-risk, fill with next worst (Go with allocation).
  const displayRows =
    atRiskRows.length >= 4
      ? atRiskRows
      : [
          ...atRiskRows,
          ...rows
            .filter((r) => r.status === "Go")
            .slice(0, 4 - atRiskRows.length),
        ].slice(0, 4);

  // Header summary
  const overCount = rollup?.overCapCount ?? 0;
  const approachingCount = rollup?.approachingCount ?? 0;

  return (
    <Card data-testid="budget-status-card">
      <CardContent className="p-0">
        {/* Card header */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-amber-600" />
          <h2 className="text-sm font-semibold text-gray-900">Budget Status</h2>
          {isLoading ? (
            <Skeleton className="h-4 w-20 ml-auto" />
          ) : (
            <span className="ml-auto text-xs text-gray-500">
              {overCount > 0 && (
                <span className="text-red-600 font-semibold">{overCount} over cap</span>
              )}
              {overCount > 0 && approachingCount > 0 && (
                <span className="text-gray-400 mx-1">·</span>
              )}
              {approachingCount > 0 && (
                <span className="text-amber-600 font-semibold">{approachingCount} approaching</span>
              )}
              {overCount === 0 && approachingCount === 0 && (
                <span className="text-green-600 font-semibold">All within budget</span>
              )}
            </span>
          )}
        </div>

        {/* Customer rows */}
        {isLoading ? (
          <div className="p-3 space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded" />
            ))}
          </div>
        ) : displayRows.length === 0 ? (
          <div className="px-4 py-5 text-center text-sm text-gray-400">
            No budgeted customers this month
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {displayRows.map((row) => (
              <li key={row.customerId} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <Link href={`/customers/${row.customerId}/profile?tab=billing#budget-and-alerts`}>
                    <a className="text-sm font-medium text-gray-800 hover:text-blue-600 truncate max-w-[200px]">
                      {row.customerName}
                    </a>
                  </Link>
                </div>
                <BudgetBar
                  invoicedAmount={row.invoicedAmount}
                  pendingAmount={row.pendingAmount}
                  allocation={row.allocation}
                  softThresholdPercent={row.softThresholdPercent}
                  hardThresholdPercent={row.hardThresholdPercent}
                />
              </li>
            ))}
          </ul>
        )}

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-100">
          <Link href="/budget-status">
            <a className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </a>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
