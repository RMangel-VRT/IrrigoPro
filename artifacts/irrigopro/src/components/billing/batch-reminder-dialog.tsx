// Task #1888 — batch payment reminders, and the confirmation list that gates
// them.
//
// This dialog is the only place in the product where one click can put mail in
// twenty customers' inboxes, so the confirmation list is the feature and not a
// courtesy. Three rules shape it:
//
//   1. Nothing is sent until the reader has seen WHO gets mail and at WHICH
//      address. The preview endpoint is a dry run; opening this dialog cannot
//      send anything. The server enforces the order, not this component: the
//      preview issues a confirmation bound to this selection and tone, and the
//      send endpoint refuses anything that does not carry one.
//   2. Both groups are rendered in full and expanded. No accordion, no "7
//      invoices will be skipped" summary line standing in for the reasons — a
//      count is not a confirmation.
//   3. Every skip carries the server's own sentence. The refusal text already
//      names the fix; restating it here would only lose information.
//
// No eligibility, throttle or tone logic lives here. Every reason on screen
// came from the same core the single send runs.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, CheckCircle2, Clock, Loader2, Mail, Send, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

const TONE_OPTIONS = [
  { key: "suggested", label: "Suggested by age" },
  { key: "friendly", label: "Friendly reminder" },
  { key: "firm", label: "Firm reminder" },
  { key: "final_notice", label: "Final notice" },
];

interface WillSendRow {
  invoiceId: number;
  invoiceNumber: string;
  customerName: string;
  recipientEmail: string;
  templateKey: string;
  templateLabel: string;
  balanceDue: string;
  daysOverdue: number;
}

interface WillSkipRow {
  invoiceId: number;
  invoiceNumber: string;
  customerName: string;
  reason: string;
  message: string;
  nextAllowedAt: string | null;
}

interface PreviewResponse {
  templateKey: string;
  willSend: WillSendRow[];
  willSkip: WillSkipRow[];
  notFound: number[];
  /**
   * Issued by the preview and required by the send. The server will not mail
   * anyone without it, so this dialog cannot be bypassed by a client that
   * simply posts to the batch endpoint — and this one has nothing to send
   * until the list it belongs to has been fetched and rendered.
   */
  confirmationToken: string;
  confirmationExpiresAt: string;
  counts: { selected: number; willSend: number; willSkip: number; notFound: number };
}

interface ResultRow {
  invoiceId: number;
  invoiceNumber: string;
  customerName: string;
  outcome: "sent" | "skipped" | "failed";
  recipientEmail: string | null;
  templateLabel: string | null;
  reason: string | null;
  message: string;
  nextAllowedAt: string | null;
  error: string | null;
}

interface BatchResponse {
  results: ResultRow[];
  notFound: number[];
  summary: {
    selected: number;
    sent: number;
    skipped: number;
    failed: number;
    notFound: number;
  };
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function BatchReminderDialog({
  open,
  onOpenChange,
  invoiceIds,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceIds: number[];
  /** Called once a batch has run, so the caller can clear its selection. */
  onSent?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [templateKey, setTemplateKey] = useState("suggested");
  const [results, setResults] = useState<BatchResponse | null>(null);

  // A fresh dialog is always a fresh decision: reopening never shows the
  // previous run's results, and never carries a stale preview.
  useEffect(() => {
    if (!open) {
      setResults(null);
      setTemplateKey("suggested");
    }
  }, [open]);

  const idsKey = invoiceIds.join(",");

  const {
    data: preview,
    isLoading,
    error: previewError,
  } = useQuery<PreviewResponse>({
    queryKey: ["/api/invoices/reminders/preview", idsKey, templateKey],
    // A dry run. It reads; it cannot send.
    queryFn: () =>
      apiRequest("/api/invoices/reminders/preview", "POST", { invoiceIds, templateKey }),
    enabled: open && invoiceIds.length > 0 && !results,
    // Re-fetched every open: a confirmation list has to describe the invoices
    // as they are now, not as they were the last time this dialog ran.
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  const sendMutation = useMutation({
    mutationFn: (confirmationToken: string): Promise<BatchResponse> =>
      apiRequest("/api/invoices/reminders/batch", "POST", {
        invoiceIds,
        templateKey,
        confirmationToken,
      }),
    onSuccess: (data) => {
      setResults(data);
      // The A/R list carries Last reminder / Reminders columns, so refresh it
      // straight away — the results have to be visible where she works, not
      // only in this dialog.
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      onSent?.();
      toast({
        title:
          data.summary.sent > 0
            ? `${data.summary.sent} reminder${data.summary.sent === 1 ? "" : "s"} sent`
            : "No reminders sent",
        description: `${data.summary.skipped} skipped · ${data.summary.failed} failed`,
        variant: data.summary.failed > 0 ? "destructive" : undefined,
      });
    },
    onError: (err: any) => {
      let description = err?.message ?? "The reminders could not be sent.";
      const match = /^(\d+):\s*([\s\S]*)$/.exec(String(description));
      if (match) {
        try {
          description = JSON.parse(match[2]).message ?? match[2];
        } catch {
          description = match[2];
        }
      }
      toast({ title: "Reminders not sent", description, variant: "destructive" });
      // A refused confirmation means the list on screen is no longer the list
      // the server would act on. Fetch it again rather than leaving a stale
      // one in front of a live Send button.
      if (err?.status === 409 || /^409:/.test(String(err?.message ?? ""))) {
        queryClient.invalidateQueries({
          queryKey: ["/api/invoices/reminders/preview"],
        });
      }
    },
  });

  const sendable = preview?.willSend ?? [];
  const skipped = preview?.willSkip ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="batch-reminder-dialog">
        <DialogHeader>
          <DialogTitle>
            {results ? "Reminder results" : "Send payment reminders"}
          </DialogTitle>
          <DialogDescription>
            {results
              ? "What each selected invoice did."
              : "Nothing is sent until you confirm. Check who is about to be emailed, and at which address."}
          </DialogDescription>
        </DialogHeader>

        {/* ── Results ───────────────────────────────────────────────────── */}
        {results ? (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto" data-testid="batch-reminder-results">
            <p className="text-sm text-gray-600" data-testid="batch-reminder-summary">
              {results.summary.sent} sent · {results.summary.skipped} skipped ·{" "}
              {results.summary.failed} failed
            </p>
            {results.results.map((row) => (
              <div
                key={row.invoiceId}
                className="flex items-start gap-2 rounded-lg border border-gray-200 p-3"
                data-testid={`batch-reminder-result-${row.invoiceId}`}
              >
                {row.outcome === "sent" ? (
                  <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                ) : row.outcome === "failed" ? (
                  <XCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                )}
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-gray-900">
                    #{row.invoiceNumber} · {row.customerName}
                  </p>
                  <p className="text-gray-600">{row.message}</p>
                  {row.error && (
                    <p className="text-red-700" data-testid={`batch-reminder-error-${row.invoiceId}`}>
                      {row.error}
                    </p>
                  )}
                  {row.nextAllowedAt && (
                    <p className="text-gray-500">Next allowed {formatWhen(row.nextAllowedAt)}</p>
                  )}
                </div>
              </div>
            ))}
            {results.notFound.length > 0 && (
              <p className="text-sm text-gray-500" data-testid="batch-reminder-results-notfound">
                {results.notFound.length} selected invoice
                {results.notFound.length === 1 ? " is" : "s are"} no longer available and
                {results.notFound.length === 1 ? " was" : " were"} not sent.
              </p>
            )}
          </div>
        ) : (
          /* ── The confirmation list ───────────────────────────────────── */
          <div className="space-y-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Tone</label>
              <Select value={templateKey} onValueChange={setTemplateKey}>
                <SelectTrigger className="w-56" data-testid="batch-reminder-tone-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONE_OPTIONS.map((t) => (
                    <SelectItem
                      key={t.key}
                      value={t.key}
                      data-testid={`batch-reminder-tone-${t.key}`}
                    >
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {isLoading ? (
              <div
                className="flex items-center gap-2 text-sm text-gray-600"
                data-testid="batch-reminder-loading"
              >
                <Loader2 className="w-4 h-4 animate-spin" />
                Checking each selected invoice…
              </div>
            ) : previewError ? (
              <p className="text-sm text-red-700" data-testid="batch-reminder-preview-error">
                The selected invoices could not be checked, so nothing has been sent.
              </p>
            ) : (
              <div className="space-y-4 max-h-[50vh] overflow-y-auto">
                {/* Group 1 — expanded, always, with the addresses in full. */}
                <section data-testid="batch-reminder-will-send">
                  <h4 className="text-sm font-semibold text-gray-900">
                    Will be emailed ({sendable.length})
                  </h4>
                  {sendable.length === 0 ? (
                    <p className="text-sm text-gray-600" data-testid="batch-reminder-none-sendable">
                      None of the selected invoices can be emailed right now.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {sendable.map((row) => (
                        <li
                          key={row.invoiceId}
                          className="flex items-start gap-2 rounded-lg border border-gray-200 p-3 text-sm"
                          data-testid={`batch-reminder-send-row-${row.invoiceId}`}
                        >
                          <Mail className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900">
                              #{row.invoiceNumber} · {row.customerName}
                            </p>
                            <p className="text-gray-700" data-testid={`batch-reminder-email-${row.invoiceId}`}>
                              {row.recipientEmail}
                            </p>
                            <p className="text-gray-500">
                              {row.templateLabel} · ${row.balanceDue} · {row.daysOverdue} days
                              overdue
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Group 2 — every skip, with its own reason, in full. */}
                {skipped.length > 0 && (
                  <section data-testid="batch-reminder-will-skip">
                    <h4 className="text-sm font-semibold text-gray-900">
                      Will be skipped ({skipped.length})
                    </h4>
                    <ul className="mt-2 space-y-2">
                      {skipped.map((row) => (
                        <li
                          key={row.invoiceId}
                          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
                          data-testid={`batch-reminder-skip-row-${row.invoiceId}`}
                        >
                          {row.reason === "throttled" ? (
                            <Clock className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                          ) : (
                            <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                          )}
                          <div className="min-w-0">
                            <p className="font-medium text-amber-900">
                              #{row.invoiceNumber} · {row.customerName}
                            </p>
                            <p
                              className="text-amber-900"
                              data-testid={`batch-reminder-skip-reason-${row.invoiceId}`}
                            >
                              {row.message}
                            </p>
                            {row.nextAllowedAt && (
                              <p className="text-amber-800">
                                Next allowed {formatWhen(row.nextAllowedAt)}
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {(preview?.notFound.length ?? 0) > 0 && (
                  <p className="text-sm text-gray-500" data-testid="batch-reminder-notfound">
                    {preview!.notFound.length} selected invoice
                    {preview!.notFound.length === 1 ? " is" : "s are"} no longer available and
                    will not be emailed.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={() => onOpenChange(false)} data-testid="batch-reminder-close">
              Close
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="batch-reminder-cancel"
              >
                Cancel
              </Button>
              <Button
                onClick={() => preview && sendMutation.mutate(preview.confirmationToken)}
                disabled={
                  !preview ||
                  sendable.length === 0 ||
                  sendMutation.isPending ||
                  isLoading
                }
                data-testid="batch-reminder-confirm"
              >
                {sendMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Send className="w-4 h-4 mr-2" />
                )}
                {`Send ${sendable.length} reminder${sendable.length === 1 ? "" : "s"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
