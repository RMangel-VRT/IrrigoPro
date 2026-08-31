import { useEffect, useMemo, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ChipList } from "./chip-list";
import type { Estimate } from "@workspace/db/schema";
import type { ResendPayload } from "@/hooks/use-estimate-resend";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NOTE = 2000;

const isValidEmail = (v: string): boolean => EMAIL_RE.test(v.trim());

interface ResendConfirmDialogProps {
  estimate: Estimate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (payload: ResendPayload) => void;
  isResending: boolean;
  isExpiredResend?: boolean;
}

export function ResendConfirmDialog({
  estimate,
  open,
  onOpenChange,
  onConfirm,
  isResending,
  isExpiredResend = true,
}: ResendConfirmDialogProps) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [toError, setToError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTo((estimate?.customerEmail ?? "").trim());
      setCc([]);
      setBcc([]);
      setNote("");
      setToError(null);
    }
  }, [open, estimate?.customerEmail]);

  const toValid = useMemo(() => isValidEmail(to), [to]);
  const noteOver = note.length > MAX_NOTE;
  const canSend = toValid && !noteOver && !isResending;

  const submit = () => {
    if (!toValid) {
      setToError("Please enter a valid email address");
      return;
    }
    onConfirm({
      to: to.trim(),
      cc,
      bcc,
      note: note.trim() || undefined,
    });
  };

  const customerName = estimate?.customerName ?? "this customer";
  const title = isExpiredResend ? "Resend estimate" : "Re-deliver estimate";
  // Task #1955 — the 30-day window runs from the last send, so any
  // re-send restarts it (whether or not the estimate had expired).
  const description = isExpiredResend
    ? `Send ${customerName} a fresh approval link. The estimate date will be reset and the 30-day window restarted from today's send.`
    : `Re-deliver the approval email to ${customerName}. The estimate date and approval link remain unchanged, and the 30-day window restarts from today's send.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="resend-confirm-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-blue-600" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="resend-to" className="text-sm font-medium text-gray-700">
              To
            </Label>
            <Input
              id="resend-to"
              type="email"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                if (toError) setToError(null);
              }}
              placeholder="customer@example.com"
              data-testid="resend-dialog-to"
            />
            {toError && <p className="text-xs text-red-600">{toError}</p>}
            {!toError && !toValid && to.length > 0 && (
              <p className="text-xs text-red-600">Please enter a valid email address</p>
            )}
            {!toError && to.length === 0 && (
              <p className="text-xs text-gray-500">
                No email on file — enter an address to send to.
              </p>
            )}
          </div>

          <ChipList
            label="Cc (optional)"
            values={cc}
            onChange={setCc}
            testIdPrefix="resend-cc"
          />
          <ChipList
            label="Bcc (optional)"
            values={bcc}
            onChange={setBcc}
            testIdPrefix="resend-bcc"
          />

          <div className="space-y-1.5">
            <Label htmlFor="resend-note" className="text-sm font-medium text-gray-700">
              Note (optional)
            </Label>
            <Textarea
              id="resend-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a short message that will appear above the estimate summary in the email."
              data-testid="resend-dialog-note"
            />
            <div className={`text-xs ${noteOver ? "text-red-600" : "text-gray-500"}`}>
              {note.length}/{MAX_NOTE}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isResending}
            data-testid="resend-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSend}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="resend-dialog-confirm"
          >
            {isResending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {isExpiredResend ? "Resending…" : "Re-delivering…"}
              </>
            ) : (
              <>
                <Mail className="w-4 h-4 mr-2" />
                {isExpiredResend ? "Resend" : "Re-deliver"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
