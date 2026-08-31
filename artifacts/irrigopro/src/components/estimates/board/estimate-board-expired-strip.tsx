import { useState } from "react";
import type { Estimate } from "@workspace/db/schema";
import { Button } from "@/components/ui/button";
import { ChevronRight, ChevronDown, Send } from "lucide-react";
import { useEstimateResend } from "@/hooks/use-estimate-resend";
import { ResendConfirmDialog } from "@/components/estimates/resend-confirm-dialog";
import { ESTIMATE_EXPIRATION_DAYS, estimateExpiryAnchor } from "@workspace/shared";

interface EstimateBoardExpiredStripProps {
  estimates: Estimate[];
  onCardClick: (estimateId: number) => void;
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

// Task #1955 — expiry is measured from the last send, so the card shows
// when the estimate went out rather than when it was created.
function formatSentDate(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function EstimateBoardExpiredStrip({
  estimates,
  onCardClick,
}: EstimateBoardExpiredStripProps) {
  const [expanded, setExpanded] = useState(false);
  const [resendDialogEstimate, setResendDialogEstimate] = useState<Estimate | null>(null);
  const { resendEstimate, isResending } = useEstimateResend();

  if (estimates.length === 0) return null;

  const handleConfirmResend = async (payload: Parameters<typeof resendEstimate>[1]) => {
    if (!resendDialogEstimate) return;
    try {
      await resendEstimate(resendDialogEstimate.id, payload);
      setResendDialogEstimate(null);
    } catch {
      // Error toast surfaced by hook; keep dialog open for retry.
    }
  };

  return (
    <div className="border border-orange-200 bg-orange-50 rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-orange-800 hover:bg-orange-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
        data-testid="board-expired-toggle"
      >
        <span className="font-medium">
          Expired · {estimates.length}{" "}
          {estimates.length === 1 ? "estimate" : "estimates"} sent more than{" "}
          {ESTIMATE_EXPIRATION_DAYS} days ago · ready to resend
        </span>
        {expanded ? (
          <ChevronDown className="w-4 h-4 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 flex-shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-orange-200 bg-white">
          <div className="overflow-x-auto">
            <div className="flex gap-2 p-3 min-w-min">
              {estimates.map((est) => {
                const sentDate = estimateExpiryAnchor(est);
                const amount = parseFloat(est.totalAmount);
                return (
                  <div
                    key={est.id}
                    className="flex-shrink-0 w-56 bg-white border border-orange-200 rounded-md p-3 hover:border-orange-300 hover:shadow-sm transition-all"
                    data-testid={`board-expired-card-${est.id}`}
                  >
                    <button
                      type="button"
                      onClick={() => onCardClick(est.id)}
                      className="block w-full text-left focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded"
                    >
                      <div className="font-medium text-sm text-gray-900 truncate">
                        {est.customerName}
                      </div>
                      <div className="flex items-center justify-between mt-1 text-xs">
                        <span className="font-medium text-gray-700">
                          {formatCurrency(
                            Number.isFinite(amount) ? amount : 0,
                          )}
                        </span>
                        <span className="text-orange-600">
                          Sent {formatSentDate(sentDate)}
                        </span>
                      </div>
                    </button>
                    <div className="mt-2 pt-2 border-t border-gray-100">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="w-full text-xs h-7"
                        data-testid={`board-expired-resend-${est.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setResendDialogEstimate(est);
                        }}
                      >
                        <Send className="w-3 h-3 mr-1" />
                        Resend
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <ResendConfirmDialog
        estimate={resendDialogEstimate}
        open={resendDialogEstimate !== null}
        onOpenChange={(open) => {
          if (!open) setResendDialogEstimate(null);
        }}
        onConfirm={handleConfirmResend}
        isResending={isResending}
      />
    </div>
  );
}
