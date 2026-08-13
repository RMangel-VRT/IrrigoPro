/**
 * The one named action on an invoice row (Task #1942).
 *
 * The label and the enabled state are the SERVER'S answer, not a second copy
 * of it. `GET /api/invoices/reminder-eligibility` runs the same refusal matrix
 * and the same throttle the send route runs, so this button says "Send",
 * "Remind", "In 3 days" or nothing at all for exactly the reasons the POST
 * would accept or refuse. Re-deriving any of that here would be a second
 * refusal matrix free to drift from the first — which is the specific mistake
 * #1887 wrote the matrix to avoid.
 */

import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ReminderThrottleInfo {
  windowDays: number;
  lastSentAt: string | null;
  nextAllowedAt: string | null;
  throttled: boolean;
  message: string | null;
}

export interface ReminderRefusalPayload {
  reason: string;
  message: string;
  action?: { kind: "send_invoice" | "generate_pdf"; label: string };
}

export interface ReminderEligibility {
  invoiceId: number;
  canSend: boolean;
  refusal: ReminderRefusalPayload | null;
  throttle: ReminderThrottleInfo;
}

export interface ReminderEligibilityResponse {
  rows: ReminderEligibility[];
  notFound: number[];
}

export type PrimaryActionKind =
  | "pending"
  | "remind"
  | "send_invoice"
  | "throttled"
  | "blocked";

export interface PrimaryActionState {
  kind: PrimaryActionKind;
  label: string;
  disabled: boolean;
  tooltip: string;
}

/**
 * Refusals that mean there is no action to offer at all.
 *
 * A paid, cancelled, superseded, merged or QB-voided invoice is not a piece of
 * collections work, so the row shows no button rather than a disabled one: a
 * greyed-out control in a fifty-row list reads as a bug, not as an answer.
 */
const NO_BUTTON_REASONS = new Set([
  "paid",
  "zero_balance",
  "cancelled",
  "superseded",
  "merged",
  "qb_voided",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Server payload → what the row's button says.
 *
 * Returns null when the row should carry no primary action at all.
 * `now` is passed in so a whole render shares one clock.
 */
export function primaryActionFor(
  eligibility: ReminderEligibility | null | undefined,
  now: Date,
): PrimaryActionState | null {
  if (!eligibility) {
    return {
      kind: "pending",
      label: "Remind",
      disabled: true,
      tooltip: "Checking whether a reminder can be sent…",
    };
  }

  const { refusal, throttle } = eligibility;

  if (refusal) {
    if (NO_BUTTON_REASONS.has(refusal.reason)) return null;
    // The refusal names the alternative; the button takes its name from it.
    if (refusal.action?.kind === "send_invoice") {
      return { kind: "send_invoice", label: "Send", disabled: false, tooltip: refusal.message };
    }
    return { kind: "blocked", label: "Remind", disabled: true, tooltip: refusal.message };
  }

  if (throttle?.throttled) {
    return {
      kind: "throttled",
      label: throttleLabel(throttle, now),
      disabled: true,
      tooltip:
        throttle.message ??
        `A reminder already went out inside the ${throttle.windowDays}-day window.`,
    };
  }

  if (eligibility.canSend) {
    return {
      kind: "remind",
      label: "Remind",
      disabled: false,
      tooltip: "Send a payment reminder for this invoice.",
    };
  }

  // canSend false with no refusal and no throttle should not happen; refuse
  // rather than invent an enabled control.
  return {
    kind: "blocked",
    label: "Remind",
    disabled: true,
    tooltip: "This invoice cannot be reminded right now.",
  };
}

function throttleLabel(throttle: ReminderThrottleInfo, now: Date): string {
  if (!throttle.nextAllowedAt) return "Later";
  const at = new Date(throttle.nextAllowedAt).getTime();
  if (Number.isNaN(at)) return "Later";
  const days = Math.ceil((at - now.getTime()) / DAY_MS);
  if (days <= 1) return "In 1 day";
  return `In ${days} days`;
}

export function InvoicePrimaryAction({
  invoiceId,
  eligibility,
  now,
  isBusy,
  onRemind,
  onSendInvoice,
}: {
  invoiceId: number;
  eligibility: ReminderEligibility | null | undefined;
  now: Date;
  isBusy?: boolean;
  onRemind: () => void;
  onSendInvoice: () => void;
}) {
  const state = primaryActionFor(eligibility, now);
  if (!state) return null;

  return (
    <Button
      size="sm"
      variant={state.kind === "remind" || state.kind === "send_invoice" ? "default" : "outline"}
      className="h-8 whitespace-nowrap"
      disabled={state.disabled || !!isBusy}
      title={state.tooltip}
      data-testid={`invoice-primary-action-${invoiceId}`}
      data-action-kind={state.kind}
      onClick={(e) => {
        e.stopPropagation();
        if (state.disabled) return;
        if (state.kind === "send_invoice") onSendInvoice();
        else onRemind();
      }}
    >
      {isBusy ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Send className="mr-1.5 h-3.5 w-3.5" />
      )}
      {state.label}
    </Button>
  );
}
