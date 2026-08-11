// Task #1889 — the internal A/R note thread on the invoice detail.
//
// This sits directly beside the reminder history, and the two together are the
// collections record for an invoice: what we sent the customer, and what the
// customer said back. Before this existed the second half lived in whoever
// made the call, and when that person was out the next one started from zero.
//
// Three things this panel must never stop saying out loud:
//
//   1. INTERNAL. The banner at the top is not decoration. There is already a
//      customer-visible notes field on an invoice, it is printed on the PDF,
//      and someone typing "AP is stalling again" into the wrong box is exactly
//      the failure this feature can cause. So the panel says where the text
//      goes before the compose box appears, not after.
//   2. PERMANENT. There is no edit control and no delete control here, and
//      there is no endpoint behind them either. The confirmation copy says so
//      before the note is written, because "you cannot take this back" is only
//      fair as a warning.
//   3. WHO AND WHEN. Every entry is attributed and timestamped off the stored
//      row, so the thread reads as a history rather than as a wall of text.
//
// The panel is only rendered for a caller with CAN_READ_AR_NOTES; the server
// refuses everyone else on both endpoints regardless of what the client does.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Lock, MessageSquare, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

/** Mirrors AR_NOTE_MAX_LENGTH on the server. */
const NOTE_MAX_LENGTH = 4000;

interface ArNoteRow {
  id: number;
  invoiceId: number;
  note: string;
  authorUserId: number | null;
  authorName: string | null;
  createdAt: string;
}

interface ArNotesState {
  notes: ArNoteRow[];
  internalOnly: boolean;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

function readServerMessage(err: unknown, fallback: string): string {
  let description = (err as any)?.message ?? fallback;
  const match = /^(\d+):\s*([\s\S]*)$/.exec(String(description));
  if (match) {
    try {
      description = JSON.parse(match[2]).message ?? match[2];
    } catch {
      description = match[2];
    }
  }
  return description;
}

export function InvoiceArNotesPanel({
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
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useQuery<ArNotesState>({
    queryKey: ["/api/invoices", invoiceId, "ar-notes"],
    enabled: open,
  });

  const addMutation = useMutation({
    mutationFn: async (note: string) =>
      apiRequest(`/api/invoices/${invoiceId}/ar-notes`, "POST", { note }),
    onSuccess: () => {
      setDraft("");
      toast({
        title: "Note added",
        description: `Your note on ${invoiceNumber} is part of the follow-up history. It is internal and cannot be edited or removed.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices", invoiceId, "ar-notes"] });
      // The A/R list carries the note indicator, so it is stale now.
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: unknown) => {
      toast({
        title: "Note not added",
        description: readServerMessage(err, "The note could not be saved."),
        variant: "destructive",
      });
    },
  });

  if (!open) return null;

  if (isLoading || !data) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-gray-600"
        data-testid="ar-notes-panel-loading"
      >
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading follow-up notes…
      </div>
    );
  }

  const trimmed = draft.trim();
  const tooLong = trimmed.length > NOTE_MAX_LENGTH;

  return (
    <div className="border-t border-gray-200 pt-4 space-y-3" data-testid="ar-notes-panel">
      <div className="flex items-baseline justify-between">
        <h4 className="font-medium text-gray-900 flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-gray-500" />
          Internal follow-up notes
        </h4>
        <span className="text-xs text-gray-500">{data.notes.length} note{data.notes.length === 1 ? "" : "s"}</span>
      </div>

      {/* Said before the compose box, not after it. */}
      <div
        className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-start gap-2"
        data-testid="ar-notes-internal-banner"
      >
        <Lock className="w-4 h-4 text-slate-500 mt-0.5 flex-shrink-0" />
        <div className="text-xs text-slate-700">
          <p className="font-medium text-slate-900">
            Internal only — the customer never sees these notes.
          </p>
          <p className="mt-0.5">
            Nothing here is printed on the invoice PDF, included in any email to the customer, or
            written to the CSV export. This is not the invoice's notes field. Notes are permanent:
            once added, a note cannot be edited or deleted by anyone.
          </p>
        </div>
      </div>

      {/* Compose */}
      <div className="space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={NOTE_MAX_LENGTH + 1}
          placeholder="What happened on the follow-up? e.g. Left a voicemail for Dana in AP — says the cheque run is the 15th."
          data-testid="input-ar-note"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-gray-500">
            {tooLong
              ? `That is ${trimmed.length} characters — the limit is ${NOTE_MAX_LENGTH}.`
              : "Saved permanently, attributed to you."}
          </span>
          <Button
            size="sm"
            onClick={() => addMutation.mutate(trimmed)}
            disabled={trimmed === "" || tooLong || addMutation.isPending}
            data-testid="button-add-ar-note"
          >
            {addMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Plus className="w-4 h-4 mr-2" />
            )}
            Add note
          </Button>
        </div>
      </div>

      {/* Thread — newest first, as the server returns it. */}
      {data.notes.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="ar-notes-empty">
          No follow-up notes yet. The first one starts the collections history for this invoice.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="ar-notes-thread">
          {data.notes.map((n) => (
            <li
              key={n.id}
              className="text-sm border border-gray-200 rounded-md p-2"
              data-testid={`ar-note-row-${n.id}`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600">
                <span className="font-medium text-gray-900">
                  {n.authorName ?? "A former user"}
                </span>
                <span className="text-gray-400">·</span>
                <span>{formatWhen(n.createdAt)}</span>
              </div>
              <p className="mt-1 text-gray-800 whitespace-pre-wrap">{n.note}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
