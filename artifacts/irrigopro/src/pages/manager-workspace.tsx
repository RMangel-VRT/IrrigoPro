// Task #1258 — Manager Workspace Simplification (Slice 1)
//
// Replaces the five-lane stage cockpit with a lightweight hub:
//   1. Needs Approval list — Work Orders + Billing Sheets awaiting manager action
//   2. Launchpad tiles — Wet Checks · Work Orders · Billing Sheets · Estimates
//      quick-nav (Estimates tile shows pending count; detail is on Estimates page)

import irrigoLogoUrl from "@assets/irrigopro - logo - BLUE - FINAL_1756061385150.png";
import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  DollarSign,
  Droplets,
  FileText,
  Loader2,
  Wrench,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { adaptiveRefetchInterval, apiRequest } from "@/lib/queryClient";
import { FinancialPulseWidget } from "@/components/financial-pulse/financial-pulse-widget";
import { useAuth } from "@/lib/auth-context";
import { BillingSheetViewModal } from "@/components/billing/billing-sheet-view-modal";
import { WorkOrderDetails } from "@/components/work-orders/work-order-details";
import type { WorkOrder, BillingSheet, Estimate } from "@workspace/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface NeedsApprovalResponse {
  workOrders: WorkOrder[];
  billingSheets: BillingSheet[];
}

interface StatusStripResponse {
  indicators: {
    wcsPendingReview: number;
    wosAwaitingApproval: number;
    approvedThisWeek: number;
  };
  quickbooks: {
    state: "ok" | "degraded" | "down" | "unknown";
    lastSyncAt: string | null;
    pendingSync: number;
    connectionStatus: string | null;
    recentErrorCount: number;
  } | null;
}

interface WetCheckCounts {
  needsReview: number;
  inProgress: number;
  readyToBill: number;
  billed: number;
  all: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function fmtMoney(val: number | string | null | undefined): string {
  const n = typeof val === "string" ? parseFloat(val) : val;
  return n == null || !Number.isFinite(n) ? "—" : CURRENCY.format(n);
}

function ageDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function statusLabel(status: string): string {
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface ApprovalRow {
  id: number;
  number: string;
  customerName: string | null;
  branchName?: string | null;
  status: string;
  total: number | string | null;
  age: number | null;
  locked: boolean;
}

function NeedsApprovalSection({
  title,
  icon,
  items,
  loading,
  onSelect,
  emptyLabel,
}: {
  title: string;
  icon: React.ReactNode;
  items: ApprovalRow[];
  loading: boolean;
  onSelect: (id: number) => void;
  emptyLabel: string;
}) {
  return (
    <div>
      <div className="px-4 py-2 flex items-center gap-2 bg-gray-50 border-b border-gray-100">
        {icon}
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{title}</span>
        <Badge variant="outline" className="ml-auto text-xs">
          {loading ? "…" : items.length}
        </Badge>
      </div>

      {loading ? (
        <div className="p-3 space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div
          className="px-4 py-5 text-center text-sm text-gray-400"
          data-testid={`empty-${title.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {emptyLabel}
        </div>
      ) : (
        <ul className="divide-y divide-gray-50">
          {items.map((row) => (
            <li key={row.id}>
              <button
                className="w-full text-left px-4 py-3 hover:bg-blue-50 transition-colors flex items-center gap-3 group"
                onClick={() => onSelect(row.id)}
                data-testid={`approval-row-${row.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate">{row.number}</span>
                    <Badge className="text-[10px] px-1.5 py-0.5 shrink-0 bg-orange-100 text-orange-800 border-0">
                      {statusLabel(row.status)}
                    </Badge>
                    {row.locked && (
                      <Badge className="text-[10px] px-1.5 py-0.5 shrink-0 bg-gray-100 text-gray-500 border-0">
                        Locked
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    {row.customerName && (
                      <span className="text-xs text-gray-500 truncate">{row.customerName}</span>
                    )}
                    {row.branchName && (
                      <span className="text-xs text-gray-400 flex items-center gap-0.5 shrink-0">
                        <Building2 className="w-3 h-3" />
                        {row.branchName}
                      </span>
                    )}
                    {row.age !== null && (
                      <span className="text-xs text-gray-400 flex items-center gap-0.5 shrink-0">
                        <Clock className="w-3 h-3" />
                        {row.age}d old
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-sm font-medium text-gray-700">{fmtMoney(row.total)}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-400 ml-auto mt-0.5 transition-colors" />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LaunchpadTile({
  label,
  icon,
  href,
  count,
  colorClass,
}: {
  label: string;
  icon: React.ReactNode;
  href: string;
  count?: number;
  colorClass: string;
}) {
  return (
    <Link href={href}>
      <div
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-l-4 ${colorClass} bg-white shadow-sm p-4 hover:shadow-md transition-shadow cursor-pointer min-h-[100px]`}
        data-testid={`launchpad-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        {icon}
        <span className="text-sm font-medium text-gray-700 text-center leading-tight">{label}</span>
        {count !== undefined && (
          <Badge className="bg-gray-100 text-gray-600 border-0 text-xs">
            {count}
          </Badge>
        )}
      </div>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function ManagerWorkspacePage() {
  const qc = useQueryClient();
  const { user } = useAuth();

  // Modal state
  const [selectedWo, setSelectedWo] = useState<WorkOrder | null>(null);
  const [selectedBs, setSelectedBs] = useState<BillingSheet | null>(null);

  const canSeeEstimates = !!user?.role && user.role !== "field_tech";

  const { data: approval, isLoading: approvalLoading } = useQuery<NeedsApprovalResponse | null>({
    queryKey: ["/api/manager-workspace/needs-approval"],
    refetchInterval: adaptiveRefetchInterval(30_000),
  });

  const { data: strip } = useQuery<StatusStripResponse | null>({
    queryKey: ["/api/manager-workspace/status-strip"],
    refetchInterval: adaptiveRefetchInterval(60_000),
  });

  const { data: wcCounts } = useQuery<WetCheckCounts>({
    queryKey: ["/api/wet-checks/admin/counts"],
    queryFn: async () => {
      try {
        return (await apiRequest("/api/wet-checks/admin/counts", "GET")) as WetCheckCounts;
      } catch {
        return { needsReview: 0, inProgress: 0, readyToBill: 0, billed: 0, all: 0 };
      }
    },
    staleTime: 30_000,
    refetchInterval: adaptiveRefetchInterval(30_000),
    enabled: user?.role !== "billing_manager",
  });

  // ── Pending estimates — count only, for the launchpad tile ─────────────
  const { data: pendingEstimatesRaw = [] } = useQuery<Estimate[]>({
    queryKey: ["/api/estimates/pending-approval"],
    refetchInterval: adaptiveRefetchInterval(30_000),
    enabled: canSeeEstimates,
  });

  const pendingEstimatesCount = pendingEstimatesRaw.length;

  const invalidateQueue = () => {
    qc.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey[0] === "string" &&
        q.queryKey[0].startsWith("/api/manager-workspace/"),
    });
  };

  const workOrders = approval?.workOrders ?? [];
  const billingSheets = approval?.billingSheets ?? [];
  const totalCount = workOrders.length + billingSheets.length;

  // QB status bar styles
  const qbState = strip?.quickbooks?.state ?? "unknown";
  const qbBorderClass =
    qbState === "ok"
      ? "border-l-green-500"
      : qbState === "degraded"
        ? "border-l-amber-400"
        : qbState === "down"
          ? "border-l-red-500"
          : "border-l-gray-300";

  return (
    <div
      className="max-w-5xl mx-auto py-4 px-4 space-y-4"
      data-testid="manager-workspace"
    >
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-xl bg-gradient-brand px-6 py-5 shadow-lg">
        <img
          src={irrigoLogoUrl}
          alt=""
          aria-hidden="true"
          className="pointer-events-none select-none absolute right-4 top-1/2 -translate-y-1/2 h-[70%] max-h-28 object-contain opacity-[0.07]"
        />
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Manager Workspace</h1>
            <p className="text-sm mt-1" style={{ color: "hsl(var(--primary-light))" }}>
              {user?.role === "billing_manager"
                ? "Review and approve billing sheets."
                : "Review and approve your queue."}
            </p>
          </div>
          {user?.role !== "billing_manager" && (
            <Link href="/billing/command-center">
              <a className="border border-white/30 text-white bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-md text-sm transition-colors">
                Command Center
              </a>
            </Link>
          )}
        </div>
      </div>

      {/* ── Financial Pulse ────────────────────────────────────────────────── */}
      <FinancialPulseWidget variant="billing-header" />

      {/* ── QuickBooks status bar ─────────────────────────────────────────── */}
      {strip?.quickbooks && (
        <div
          className={`rounded-lg border-l-4 ${qbBorderClass} bg-white shadow-sm px-4 py-2 flex items-center gap-3`}
          data-testid="qb-status-bar"
        >
          <DollarSign className="w-4 h-4 text-gray-400 shrink-0" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-600">
            <span className="font-semibold capitalize">
              QuickBooks: {qbState}
            </span>
            {strip.quickbooks.lastSyncAt && (
              <span className="text-gray-400">
                Synced {new Date(strip.quickbooks.lastSyncAt).toLocaleString()}
              </span>
            )}
            {strip.quickbooks.pendingSync > 0 && (
              <span className="text-amber-700">
                {strip.quickbooks.pendingSync} queued
              </span>
            )}
            {strip.quickbooks.recentErrorCount > 0 && (
              <span className="text-red-700">
                {strip.quickbooks.recentErrorCount} sync error
                {strip.quickbooks.recentErrorCount === 1 ? "" : "s"}
              </span>
            )}
            <Link href="/quickbooks">
              <a className="text-blue-600 hover:underline">
                QuickBooks settings →
              </a>
            </Link>
          </div>
        </div>
      )}

      {/* ── Needs Approval ────────────────────────────────────────────────── */}
      <Card data-testid="needs-approval-card">
        <CardContent className="p-0">
          {/* Card header */}
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-semibold text-gray-900">Needs Approval</h2>
            {approvalLoading ? (
              <Loader2 className="w-3 h-3 animate-spin text-gray-400 ml-auto" />
            ) : (
              <Badge variant="outline" className="ml-auto text-xs">
                {totalCount}
              </Badge>
            )}
          </div>

          {/* Work Orders sub-section */}
          <NeedsApprovalSection
            title="Work Orders"
            icon={<Wrench className="w-3.5 h-3.5 text-purple-600" />}
            items={workOrders.map((w) => ({
              id: w.id,
              number: (w as any).workOrderNumber ?? `#${w.id}`,
              customerName: (w as any).customerName ?? null,
              branchName: (w as any).branchName ?? null,
              status: w.status,
              total: (w as any).totalAmount,
              age: ageDays((w as any).createdAt),
              locked: w.status === "billed" || !!(w as any).invoiceId,
            }))}
            loading={approvalLoading}
            onSelect={(id) => {
              const wo = workOrders.find((w) => w.id === id);
              if (wo) setSelectedWo(wo);
            }}
            emptyLabel="No work orders awaiting approval"
          />

          <div className="border-t border-gray-100" />

          {/* Billing Sheets sub-section */}
          <NeedsApprovalSection
            title="Billing Sheets"
            icon={<ClipboardList className="w-3.5 h-3.5 text-blue-600" />}
            items={billingSheets.map((s) => ({
              id: s.id,
              number:
                (s as any).billingNumber ??
                (s as any).billingSheetNumber ??
                `#${s.id}`,
              customerName: (s as any).customerName ?? null,
              branchName: (s as any).branchName ?? null,
              status: s.status,
              total: (s as any).totalAmount ?? (s as any).grandTotal,
              age: ageDays((s as any).createdAt),
              locked: s.status === "billed" || !!(s as any).invoiceId,
            }))}
            loading={approvalLoading}
            onSelect={(id) => {
              const bs = billingSheets.find((s) => s.id === id);
              if (bs) setSelectedBs(bs);
            }}
            emptyLabel="No billing sheets awaiting approval"
          />
        </CardContent>
      </Card>

      {/* ── Launchpad ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3" data-testid="launchpad">
        {user?.role !== "billing_manager" && (
          <LaunchpadTile
            label="Wet Checks"
            icon={<Droplets className="w-6 h-6 text-cyan-600" />}
            href="/wet-checks/pending-review"
            count={wcCounts?.needsReview}
            colorClass="border-l-cyan-500"
          />
        )}
        <LaunchpadTile
          label="Work Orders"
          icon={<Wrench className="w-6 h-6 text-purple-600" />}
          href="/work-orders"
          count={workOrders.length}
          colorClass="border-l-purple-500"
        />
        <LaunchpadTile
          label="Billing Sheets"
          icon={<ClipboardList className="w-6 h-6 text-blue-600" />}
          href="/billing-sheets"
          count={billingSheets.length}
          colorClass="border-l-blue-500"
        />
        {canSeeEstimates && (
          <LaunchpadTile
            label="Estimates"
            icon={<FileText className="w-6 h-6 text-green-600" />}
            href="/estimates/command-center"
            count={pendingEstimatesCount}
            colorClass="border-l-green-500"
          />
        )}
      </div>

      {/* ── Modals ────────────────────────────────────────────────────────── */}

      {/* Work Order detail modal */}
      {selectedWo && (
        <WorkOrderDetails
          workOrder={selectedWo}
          onClose={() => setSelectedWo(null)}
          onUpdate={invalidateQueue}
          onApproveSuccess={() => {
            setSelectedWo(null);
            invalidateQueue();
          }}
        />
      )}

      {/* Billing Sheet detail modal */}
      {selectedBs && (
        <BillingSheetViewModal
          sheet={selectedBs}
          open={!!selectedBs}
          onOpenChange={(o) => {
            if (!o) setSelectedBs(null);
          }}
          onApproveSuccess={() => {
            setSelectedBs(null);
            invalidateQueue();
          }}
        />
      )}

    </div>
  );
}
