// Task #1887 — payment reminders on the invoice detail.
//
// Two jobs, in this order of importance:
//
//   1. Never show a dead button. When the server refuses, this panel shows the
//      refusal's own sentence, and where the refusal names an action ("send
//      the invoice", "generate the PDF first") that sentence is what occupies
//      the space the button would have taken. A greyed-out control with a
//      shrug for a tooltip is the thing this replaces.
//   2. Show the reminder history as it was, not as the invoice is now. Every
//      value in the table below comes off the recorded row — the balance and
//      the address are the ones the customer actually saw.
//
// Sending is always deliberate: a tone has to be chosen and a confirmation
// naming the recipient has to be accepted.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertCircle, Clock, Loader2, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface ReminderRow {
  id: number;
  sentAt: string;
  sentByUserId: number | null;
  sentByName: string | null;
  recipientEmail: string;
  sequenceNumber: number | null;
  templateKey: string;
  templateLabel: string;
  balanceAtSend: string;
  daysOverdueAtSend: number;
  deliveryStatus: string;
  deliveryError: string | null;
}

interface ReminderState {
  reminders: ReminderRow[];
  canSend: boolean;
  refusal: {
    reason: string;
    message: string;
    action?: { kind: string; label: string };
  } | null;
  throttle: {
    windowDays: number;
    lastSentAt: string | null;
    nextAllowedAt: string | null;
    throttled: boolean;
    message: string | null;
  };
  suggestedTemplateKey: string;
  templates: { key: string; label: string }[];
  balanceDue: string;
  daysOverdue: number;
  recipientEmail: string | null;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function InvoiceReminderPanel({
  invoiceId,
  invoiceNumber,
  open,
}: {
  invoiceId: number;
  invoiceNumber: string;
  open: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [templateKey, setTemplateKey] = useState<string>("");
  const [confirming, setConfirming] = useState(false);

  const { data, isLoading } = useQuery<ReminderState>({
    queryKey: ["/api/invoices", invoiceId, "reminders"],
    enabled: open,
  });

  // The bucket only *suggests* a tone — it pre-selects, and the sender is free
  // to override it before sending. Nothing auto-escalates.
  useEffect(() => {
    if (data?.suggestedTemplateKey && !templateKey) setTemplateKey(data.suggestedTemplateKey);
  }, [data?.suggestedTemplateKey, templateKey]);

  const sendMutation = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/invoices/${invoiceId}/reminders`, "POST", { templateKey }),
    onSuccess: () => {
      toast({
        title: "Reminder sent",
        description: `A payment reminder for ${invoiceNumber} was sent to ${data?.recipientEmail ?? "the customer"}.`,
      });
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["/api/invoices", invoiceId, "reminders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: any) => {
      // The server's refusal text is the message. It already names what to do
      // next, so restating it in our own words would only lose information.
      let description = err?.message ?? "The reminder could not be sent.";
      const match = /^(\d+):\s*([\s\S]*)$/.exec(String(description));
      if (match) {
        try {
          description = JSON.parse(match[2]).message ?? match[2];
        } catch {
          description = match[2];
        }
      }
      toast({ title: "Reminder not sent", description, variant: "destructive" });
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["/api/invoices", invoiceId, "reminders"] });
    },
  });

  if (!open) return null;

  if (isLoading || !data) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-gray-600"
        data-testid="reminder-panel-loading"
      >
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading reminder history…
      </div>
    );
  }

  const { refusal, throttle } = data;

  return (
    <div className="border-t border-gray-200 pt-4 space-y-3" data-testid="reminder-panel">
      <div className="flex items-baseline justify-between">
        <h4 className="font-medium text-gray-900">Payment reminders</h4>
        <span className="text-xs text-gray-500" data-testid="reminder-current-state">
          {`Balance $${data.balanceDue} · ${data.daysOverdue} days overdue`}
        </span>
      </div>

      {/* The send control, or the reason there isn't one. */}
      {refusal ? (
        <div
          className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2"
          data-testid={`reminder-refusal-${refusal.reason}`}
        >
          <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-amber-900">
            <p>{refusal.message}</p>
            {refusal.action && (
              <p className="mt-1 font-medium" data-testid="reminder-refusal-action">
                {refusal.action.label}
              </p>
            )}
          </div>
        </div>
      ) : throttle.throttled ? (
        <div
          className="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-start gap-2"
          data-testid="reminder-throttled"
        >
          <Clock className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-gray-700">{throttle.message}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Tone</label>
            <Select value={templateKey} onValueChange={setTemplateKey}>
              <SelectTrigger className="w-52" data-testid="reminder-template-select">
                <SelectValue placeholder="Choose a reminder" />
              </SelectTrigger>
              <SelectContent>
                {data.templates.map((t) => (
                  <SelectItem key={t.key} value={t.key} data-testid={`reminder-template-${t.key}`}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={!templateKey || sendMutation.isPending}
            data-testid="button-send-reminder"
          >
            {sendMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Send className="w-4 h-4 mr-2" />
            )}
            Send reminder
          </Button>
        </div>
      )}

      {/* History — recorded values, not today's. */}
      {data.reminders.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="reminder-history-empty">
          No reminders have been sent for this invoice.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="reminder-history">
          {data.reminders.map((r) => (
            <li
              key={r.id}
              className="text-sm border border-gray-200 rounded-md p-2"
              data-testid={`reminder-history-row-${r.id}`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-gray-900">
                  {r.sequenceNumber ? `Reminder ${r.sequenceNumber}` : "Failed attempt"}
                </span>
                <span className="text-gray-500">·</span>
                <span className="text-gray-700">{r.templateLabel}</span>
                <span className="text-gray-500">·</span>
                <span className="text-gray-700">{formatWhen(r.sentAt)}</span>
                {r.deliveryStatus !== "sent" && (
                  <span
                    className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5"
                    data-testid={`reminder-failed-${r.id}`}
                  >
                    Not delivered
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-600 mt-1">
                {`Sent by ${r.sentByName ?? "a former user"} to ${r.recipientEmail} · balance at the time $${r.balanceAtSend} · ${r.daysOverdueAtSend} days overdue`}
              </div>
              {r.deliveryError && (
                <div className="text-xs text-red-700 mt-1">{r.deliveryError}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send a payment reminder?</AlertDialogTitle>
            <AlertDialogDescription>
              This sends the{" "}
              <strong>
                {data.templates.find((t) => t.key === templateKey)?.label ?? "selected"}
              </strong>{" "}
              for invoice <strong>{invoiceNumber}</strong>, with the invoice PDF attached, to:
              <br />
              <strong className="text-blue-600">{data.recipientEmail}</strong>
              <br />
              <br />
              This reaches the customer's inbox immediately and is recorded permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reminder">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => sendMutation.mutate()}
              disabled={sendMutation.isPending}
              data-testid="button-confirm-reminder"
            >
              {sendMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Send reminder
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
