import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { type LifecycleStatus } from "@workspace/shared";
import type { Estimate } from "@workspace/db/schema";
import { EstimateListRow } from "./estimate-list-row";
import { EstimateListStatusBadge } from "./estimate-list-status-badge";
import { ResendConfirmDialog } from "@/components/estimates/resend-confirm-dialog";
import { useEstimateResend } from "@/hooks/use-estimate-resend";
import {
  lifecycleOf,
  nextSort,
  sortEstimates,
  type SortDir,
  type SortField,
} from "./estimate-list.helpers";

export interface EstimateFilterState {
  customerIds: number[];
  statuses: LifecycleStatus[];
}

interface Props {
  estimates: Estimate[];
  filters: EstimateFilterState;
  onOpen: (id: number) => void;
  onEdit: (id: number) => void;
  /**
   * Task #1898 — the fetch failed. Without this the list rendered its empty
   * state ("No estimates yet") for a failed request, so a connection-pool
   * timeout looked exactly like an account with no estimates and nobody
   * reported it.
   */
  isError?: boolean;
  onRetry?: () => void;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

function ageLabel(date: string | Date | null | undefined): string {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function EstimateList({ estimates, filters, onOpen, onEdit, isError, onRetry }: Props) {
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [resendDialogEstimate, setResendDialogEstimate] = useState<Estimate | null>(null);
  const { resendEstimate, isResending } = useEstimateResend();

  const handleConfirmResend = async (payload: Parameters<typeof resendEstimate>[1]) => {
    if (!resendDialogEstimate) return;
    try {
      await resendEstimate(resendDialogEstimate.id, payload);
      setResendDialogEstimate(null);
    } catch {
      // Error toast surfaced by hook; keep dialog open for retry.
    }
  };

  const filtered = useMemo(() => {
    return estimates.filter((e) => {
      if (filters.customerIds.length > 0 && !filters.customerIds.includes(e.customerId ?? -1)) {
        return false;
      }
      const lc = lifecycleOf(e);
      if (filters.statuses.length > 0 && !filters.statuses.includes(lc)) return false;
      return true;
    });
  }, [estimates, filters]);

  const sorted = useMemo(
    () => sortEstimates(filtered, sortField, sortDir),
    [filtered, sortField, sortDir],
  );

  const onHeaderClick = (field: SortField) => {
    const next = nextSort({ field: sortField, dir: sortDir }, field);
    setSortField(next.field);
    setSortDir(next.dir);
  };

  const Chevron = ({ field }: { field: SortField }) => {
    if (field !== sortField) return null;
    return sortDir === "asc" ? (
      <ChevronUp className="inline w-3 h-3 ml-0.5" />
    ) : (
      <ChevronDown className="inline w-3 h-3 ml-0.5" />
    );
  };

  // Task #1898 — check the failure BEFORE the empty case. A failed fetch
  // yields an empty array too, and reporting it as "no estimates yet" is how
  // the connection-pool timeouts stayed invisible for so long.
  if (isError) {
    return (
      <div
        className="border border-red-200 bg-red-50 rounded-md p-6 text-center"
        data-testid="estimate-list-error"
      >
        <p className="text-sm text-red-800 mb-3">Couldn't load estimates.</p>
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            onClick={onRetry}
            data-testid="estimate-list-error-retry"
          >
            Retry
          </Button>
        )}
      </div>
    );
  }

  if (estimates.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p>No estimates yet. Create one with the + New Estimate button.</p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop list */}
      <Card className="hidden md:block">
        <CardContent className="p-0">
          <div className="grid grid-cols-[2fr_1fr_1.5fr_1fr_auto] gap-4 px-4 py-2 bg-gray-50 border-b text-xs font-semibold text-gray-600 uppercase tracking-wider">
            <button
              onClick={() => onHeaderClick("customer")}
              className="text-left hover:text-gray-900"
            >
              Customer<Chevron field="customer" />
            </button>
            <button
              onClick={() => onHeaderClick("amount")}
              className="text-left hover:text-gray-900"
            >
              Amount<Chevron field="amount" />
            </button>
            <button
              onClick={() => onHeaderClick("status")}
              className="text-left hover:text-gray-900"
            >
              Status<Chevron field="status" />
            </button>
            <button
              onClick={() => onHeaderClick("date")}
              className="text-left hover:text-gray-900"
            >
              Age<Chevron field="date" />
            </button>
            <span className="text-right">Actions</span>
          </div>
          {sorted.length === 0 ? (
            <p className="text-center text-sm text-gray-500 py-8">No estimates match your filters</p>
          ) : (
            sorted.map((e) => (
              <EstimateListRow
                key={e.id}
                estimate={e}
                lifecycle={lifecycleOf(e)}
                onOpen={onOpen}
                onEdit={onEdit}
                onResendClick={(est) => setResendDialogEstimate(est)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500">Sort by</span>
          <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
            <SelectTrigger className="h-8 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="customer">Customer</SelectItem>
              <SelectItem value="amount">Amount</SelectItem>
              <SelectItem value="status">Status</SelectItem>
              <SelectItem value="date">Date</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          >
            {sortDir === "asc" ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
        {sorted.length === 0 ? (
          <p className="text-center text-sm text-gray-500 py-8">No estimates match your filters</p>
        ) : (
          sorted.map((e) => {
            const lc = lifecycleOf(e);
            return (
              <Card
                key={e.id}
                className="cursor-pointer hover:shadow-sm"
                onClick={() => onOpen(e.id)}
              >
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="font-medium text-sm text-gray-900 truncate flex-1">
                      {e.customerName}
                    </div>
                    <EstimateListStatusBadge status={lc} />
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-gray-900">
                      {fmt(parseFloat(e.totalAmount))}
                    </span>
                    <span className="text-gray-500">
                      {ageLabel(e.estimateDate ?? e.createdAt)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <ResendConfirmDialog
        estimate={resendDialogEstimate}
        open={resendDialogEstimate !== null}
        onOpenChange={(open) => {
          if (!open) setResendDialogEstimate(null);
        }}
        onConfirm={handleConfirmResend}
        isResending={isResending}
      />
    </>
  );
}
