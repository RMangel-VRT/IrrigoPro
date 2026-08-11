// Task #1887 — payment reminder bodies.
//
// Three tones, one shape. Every body carries the same five facts (invoice
// number, effective due date, days overdue, balance due, and the attached PDF)
// because a reminder that makes the customer go looking for the invoice is a
// reminder that does not get paid.
//
// NOTHING HERE DECIDES A TONE. `suggestTemplateKey` is a suggestion the UI
// shows as a pre-selection; the sender picks and the picked key is what the
// endpoint records. Escalation is a person's judgement about a relationship,
// not a function of an integer.
//
// Days overdue and the aging bucket are passed in, already derived by the
// shared aging helpers. This module must never compute either one — the number
// in the email has to be the number on the A/R list for the same invoice on
// the same day.

import type { AgingBucketKey } from "@workspace/shared";

export const REMINDER_TEMPLATE_KEYS = ["friendly", "firm", "final_notice"] as const;
export type ReminderTemplateKey = (typeof REMINDER_TEMPLATE_KEYS)[number];

export function isReminderTemplateKey(v: unknown): v is ReminderTemplateKey {
  return typeof v === "string" && (REMINDER_TEMPLATE_KEYS as readonly string[]).includes(v);
}

/** What the bookkeeper sees in the tone picker and in the reminder history. */
export const REMINDER_TEMPLATE_LABELS: Record<ReminderTemplateKey, string> = {
  friendly: "Friendly reminder",
  firm: "Firm reminder",
  final_notice: "Final notice",
};

/**
 * The tone the UI pre-selects, keyed off the shared bucket helper.
 *
 * `current` and `days30` → friendly, `days60` → firm, `days90` (60+) → final
 * notice. The boundaries are the frozen ones from the aging module; this
 * function reads a bucket and never re-derives one.
 */
export function suggestTemplateKey(bucket: AgingBucketKey): ReminderTemplateKey {
  switch (bucket) {
    case "days90":
      return "final_notice";
    case "days60":
      return "firm";
    default:
      return "friendly";
  }
}

export interface ReminderCompanyBranding {
  name: string;
  /** Absolute URL, already resolved. Null when the company has no logo. */
  logo?: string | null;
  /** Reply-To for the send. Null when the company profile has no email. */
  email?: string | null;
  phone?: string | null;
}

export interface ReminderTemplateInput {
  templateKey: ReminderTemplateKey;
  customerName: string;
  invoiceNumber: string;
  /** Already derived by `computeEffectiveDueDate`. Never re-derived here. */
  effectiveDueDate: Date;
  /** Already derived by the shared aging helper, floored for display. */
  daysOverdue: number;
  /** Already resolved by `resolveBalanceDue`. */
  balanceDue: number;
  company: ReminderCompanyBranding;
}

export interface RenderedReminder {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(amount: number): string {
  return `$${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "3 days overdue" / "1 day overdue" / "due today" when not yet past. */
function overduePhrase(days: number): string {
  if (days < 0) return "not yet past due";
  if (days === 0) return "due today";
  return `${days} day${days === 1 ? "" : "s"} overdue`;
}

interface ToneCopy {
  subject: (invoiceNumber: string, companyName: string) => string;
  heading: string;
  accent: string;
  opening: (customerName: string, days: number) => string;
  closing: string;
}

const TONES: Record<ReminderTemplateKey, ToneCopy> = {
  friendly: {
    subject: (n, c) => `Friendly reminder: invoice ${n} from ${c}`,
    heading: "A quick reminder about your invoice",
    accent: "#1E5A99",
    opening: (name, days) =>
      `Hi ${name}, we hope all is well. Our records show invoice below is ${overduePhrase(days)}. ` +
      `If it is already on its way, thank you — please ignore this note.`,
    closing:
      "If anything about this invoice does not look right, just reply to this email and we will sort it out.",
  },
  firm: {
    subject: (n, c) => `Payment past due: invoice ${n} from ${c}`,
    heading: "This invoice is past due",
    accent: "#B45309",
    opening: (name, days) =>
      `Hi ${name}, invoice below is now ${overduePhrase(days)} and remains unpaid. ` +
      `We would appreciate payment, or a date we can expect it, at your earliest convenience.`,
    closing:
      "If payment has already been sent, please reply with the date and reference so we can match it up.",
  },
  final_notice: {
    subject: (n, c) => `Final notice: invoice ${n} from ${c}`,
    heading: "Final notice before collections",
    accent: "#B91C1C",
    opening: (name, days) =>
      `${name}, invoice below is ${overduePhrase(days)} and has not been paid despite previous contact. ` +
      `This is our final notice before this account is escalated.`,
    closing:
      "Please reply to this email today with payment or with the date payment will be made, so we can keep this account out of collections.",
  },
};

/**
 * Renders one reminder. Pure: same inputs, same bytes — which is what lets a
 * test assert the days-overdue figure in the body against the A/R list.
 */
export function renderReminderEmail(input: ReminderTemplateInput): RenderedReminder {
  const tone = TONES[input.templateKey];
  const companyName = input.company.name || "IrrigoPro";
  const subject = tone.subject(input.invoiceNumber, companyName);

  const due = formatDate(input.effectiveDueDate);
  const balance = formatMoney(input.balanceDue);
  const daysLabel = overduePhrase(input.daysOverdue);
  const opening = tone.opening(input.customerName || "there", input.daysOverdue);

  const logoHtml = input.company.logo
    ? `<img src="${escapeHtml(input.company.logo)}" alt="${escapeHtml(companyName)}" style="max-height:48px;margin-bottom:8px;" />`
    : "";

  const contactLines = [input.company.email, input.company.phone]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => escapeHtml(v))
    .join(" · ");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:${tone.accent};color:#ffffff;padding:24px;border-radius:12px 12px 0 0;">
    ${logoHtml}
    <h1 style="margin:0;font-size:22px;">${escapeHtml(tone.heading)}</h1>
    <p style="margin:6px 0 0 0;font-size:15px;opacity:0.92;">${escapeHtml(companyName)}</p>
  </div>
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:24px;">
    <p style="font-size:15px;">${escapeHtml(opening)}</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:15px;">
      <tr>
        <td style="padding:8px 0;color:#6b7280;">Invoice</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;">${escapeHtml(input.invoiceNumber)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#6b7280;border-top:1px solid #e5e7eb;">Due date</td>
        <td style="padding:8px 0;text-align:right;border-top:1px solid #e5e7eb;">${escapeHtml(due)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#6b7280;border-top:1px solid #e5e7eb;">Status</td>
        <td style="padding:8px 0;text-align:right;border-top:1px solid #e5e7eb;">${escapeHtml(daysLabel)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#6b7280;border-top:1px solid #e5e7eb;">Balance due</td>
        <td style="padding:8px 0;text-align:right;font-weight:700;font-size:18px;border-top:1px solid #e5e7eb;">${escapeHtml(balance)}</td>
      </tr>
    </table>
    <div style="background:#f3f4f6;border-radius:8px;padding:14px;margin:16px 0;font-size:14px;color:#374151;">
      A copy of invoice ${escapeHtml(input.invoiceNumber)} is attached to this email as a PDF.
    </div>
    <p style="font-size:14px;color:#4b5563;">${escapeHtml(tone.closing)}</p>
    <p style="font-size:13px;color:#6b7280;margin-top:24px;">— ${escapeHtml(companyName)}${contactLines ? `<br />${contactLines}` : ""}</p>
  </div>
</body></html>`;

  const text = `${tone.heading} — ${companyName}

${opening}

Invoice:     ${input.invoiceNumber}
Due date:    ${due}
Status:      ${daysLabel}
Balance due: ${balance}

A copy of invoice ${input.invoiceNumber} is attached to this email as a PDF.

${tone.closing}

— ${companyName}${contactLines ? `\n${[input.company.email, input.company.phone].filter(Boolean).join(" · ")}` : ""}
`;

  return { subject, html, text };
}
