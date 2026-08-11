// ─── Invoice due-date, aging, and A/R flag rules ────────────────────────────
//
// Task #1890 — one home for the rules that decide when an invoice is due, how
// overdue it is, which aging bucket it lands in, what its outstanding balance
// is, and which collections flags apply to it.
//
// Before this module the effective-due-date helper lived in the API server's
// QuickBooks payment-sync module, the bucket boundary rule was written out
// three separate times (Financial Pulse aging, the invoice list route, the
// invoice page's client-side matcher), and the payment-terms table was
// duplicated inline. All of those now import from here, so the number a
// bookkeeper reads on the invoice list and the number Financial Pulse reports
// for the same invoice on the same day cannot drift apart.
//
// BOUNDARIES ARE FROZEN. The shipped rule is:
//   not yet due          → current
//   0  <= days <  30     → days30
//   30 <= days <  60     → days60
//   60 <= days           → days90
// Note the day-zero asymmetry: an invoice due *today* is already classified as
// overdue rather than current. That is the behaviour that shipped and every
// Financial Pulse aging total ever reported depends on it, so it is preserved
// here deliberately. Changing it is a separate ticket with a before/after
// comparison — do not "fix" it inside a refactor.

// ─── Payment terms ──────────────────────────────────────────────────────────

/** Customer payment terms → days from creation until the invoice is due. */
export const PAYMENT_TERMS_DAYS: Record<string, number> = {
  net_30: 30,
  net_15: 15,
  due_on_receipt: 0,
};

/** Terms assumed when a customer has none recorded. */
export const DEFAULT_PAYMENT_TERMS = "net_30";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The date an invoice is actually due.
 *
 * `dueDate` wins when it is set and parseable. Otherwise the due date is
 * derived from `createdAt` plus the customer's payment terms, defaulting to
 * net_30 both when terms are missing and when they are a string we do not
 * recognise. An explicit-but-unparseable `dueDate` also falls back to the
 * terms calculation rather than producing an Invalid Date.
 */
export function computeEffectiveDueDate(
  dueDate: Date | string | null | undefined,
  createdAt: Date | string,
  paymentTerms?: string | null,
): Date {
  if (dueDate) {
    const d = dueDate instanceof Date ? dueDate : new Date(dueDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const days = PAYMENT_TERMS_DAYS[paymentTerms ?? DEFAULT_PAYMENT_TERMS] ?? 30;
  return new Date(created.getTime() + days * MS_PER_DAY);
}

/**
 * Overdue = not fully paid AND past the effective due date.
 * A null/absent payment status is treated as `unpaid`.
 */
export function isInvoiceOverdue(
  paymentStatus: string | null | undefined,
  effectiveDueDate: Date,
  now: Date,
): boolean {
  const ps = paymentStatus ?? "unpaid";
  if (ps === "paid") return false;
  return effectiveDueDate < now;
}

/**
 * Fractional days past the effective due date. Negative when not yet due.
 *
 * Fractional on purpose: the bucket boundaries have always been applied to the
 * fractional value, so rounding here would move invoices between buckets and
 * change Financial Pulse totals. Round for display only.
 */
export function daysOverdue(effectiveDueDate: Date, now: Date): number {
  return (now.getTime() - effectiveDueDate.getTime()) / MS_PER_DAY;
}

// ─── Aging buckets ──────────────────────────────────────────────────────────

export type AgingBucketKey = "current" | "days30" | "days60" | "days90";

/** Oldest-last ordering, matching the Financial Pulse bucket array order. */
export const AGING_BUCKET_KEYS: readonly AgingBucketKey[] = [
  "current",
  "days30",
  "days60",
  "days90",
];

/**
 * Labels shown wherever a bucket is named. These describe exactly what
 * `classifyAgingBucket` does — an invoice one day past due is 0 days overdue
 * under the frozen day-zero rule, so the first overdue bucket reads 0–29.
 */
export const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
  current: "Current",
  days30: "0–29 days overdue",
  days60: "30–59 days overdue",
  days90: "60+ days overdue",
};

/**
 * Days overdue → bucket. The single copy of the boundary rule.
 *
 * `NaN` falls through every comparison to `days90`, which is what the previous
 * inline `age < 0 ? 0 : age < 30 ? 1 : age < 60 ? 2 : 3` chain did. Preserved
 * so the refactor moves no numbers.
 */
export function classifyAgingBucket(days: number): AgingBucketKey {
  if (days < 0) return "current";
  if (days < 30) return "days30";
  if (days < 60) return "days60";
  return "days90";
}

/** 0 (newest) … 3 (oldest). Sorting "oldest bucket first" is descending rank. */
export function agingBucketRank(key: AgingBucketKey): number {
  return AGING_BUCKET_KEYS.indexOf(key);
}

// ─── A/R flags ──────────────────────────────────────────────────────────────

/** Anything a bookkeeper needs to notice about an invoice at a glance. */
export type ArFlag =
  | "never_sent"
  | "overdue"
  | "reminded_still_unpaid"
  | "qb_voided"
  | "not_in_qb"
  | "stale_sync"
  | "no_billing_email"
  | "needs_qb_cleanup";

export const AR_FLAGS: readonly ArFlag[] = [
  "never_sent",
  "overdue",
  "reminded_still_unpaid",
  "qb_voided",
  "not_in_qb",
  "stale_sync",
  "no_billing_email",
  "needs_qb_cleanup",
];

/** Short badge text. Every flag reads as words — never colour alone. */
export const AR_FLAG_LABELS: Record<ArFlag, string> = {
  never_sent: "Never sent",
  overdue: "Overdue",
  reminded_still_unpaid: "Reminded, still unpaid",
  qb_voided: "Voided in QB",
  not_in_qb: "Not in QB",
  stale_sync: "Stale sync",
  no_billing_email: "No billing email",
  needs_qb_cleanup: "Needs QB cleanup",
};

/** Plain-language explanation shown on hover. No jargon, no field names. */
export const AR_FLAG_TOOLTIPS: Record<ArFlag, string> = {
  never_sent:
    "This invoice was finalised but there is no record of it ever being sent to the customer.",
  overdue: "The due date has passed and the invoice is not fully paid.",
  reminded_still_unpaid:
    "A payment reminder has already gone out and the invoice is still past due. This is the escalation queue.",
  qb_voided:
    "QuickBooks shows this invoice as voided, but it is still open here. Void it here or restore it in QuickBooks.",
  not_in_qb:
    "This invoice has never been pushed to QuickBooks, so QuickBooks does not know about the money.",
  stale_sync:
    "The payment balance has not been refreshed from QuickBooks in the last 24 hours, so the balance shown may be out of date.",
  no_billing_email:
    "There is no billing email on the customer, so this invoice cannot be emailed.",
  needs_qb_cleanup:
    "Someone left a note about manual QuickBooks work still outstanding on this invoice.",
};

/** A payment sync older than this is treated as stale. */
export const STALE_SYNC_AFTER_MS = 24 * 60 * 60 * 1000;

/** The invoice fields the A/R helpers read. Deliberately structural. */
export interface ArInvoiceLike {
  status: string;
  totalAmount: string | number;
  sentAt?: Date | string | null;
  customerEmail?: string | null;
  quickbooksInvoiceId?: string | null;
  qbVoidDetectedAt?: Date | string | null;
  qbNote?: string | null;
  paymentStatus?: string | null;
  balance?: string | number | null;
  paymentSyncedAt?: Date | string | null;
  /**
   * Task #1887 — how many reminders were actually delivered for this invoice.
   * Absent on callers that do not carry reminder data (Financial Pulse), in
   * which case the reminder flag simply never fires rather than guessing.
   */
  reminderCount?: number | null;
}

function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function toTime(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * True when the balance figure shown for this invoice is the invoice total
 * standing in for a real synced balance. Always accompanied by `stale_sync`.
 */
export function isBalanceFallback(inv: ArInvoiceLike): boolean {
  return toTime(inv.paymentSyncedAt) == null || inv.balance == null;
}

/**
 * What the customer still owes: the balance QuickBooks last reported, or the
 * invoice total when no payment sync has run for this invoice.
 */
export function resolveBalanceDue(inv: ArInvoiceLike): number {
  if (isBalanceFallback(inv)) return toNum(inv.totalAmount);
  return toNum(inv.balance);
}

/**
 * Every collections flag that applies to an invoice, in a stable order.
 *
 * `overdue` is passed in rather than recomputed so a caller that has already
 * annotated the row (the invoice list route does) cannot disagree with itself.
 */
export function computeArFlags(
  inv: ArInvoiceLike,
  now: Date,
  overdue: boolean,
): ArFlag[] {
  const flags: ArFlag[] = [];
  // A draft has not been finalised, so "never sent" is not a finding about it.
  if (!inv.sentAt && inv.status !== "draft") flags.push("never_sent");
  if (overdue) flags.push("overdue");
  // Task #1887 — the escalation queue: we have already chased this one and the
  // money still has not arrived. Only meaningful while it is still overdue, so
  // a reminded invoice that got paid drops out of the queue on its own.
  if (overdue && (inv.reminderCount ?? 0) > 0) flags.push("reminded_still_unpaid");
  if (inv.qbVoidDetectedAt) flags.push("qb_voided");
  if (!inv.quickbooksInvoiceId) flags.push("not_in_qb");
  const syncedAt = toTime(inv.paymentSyncedAt);
  if (syncedAt == null || now.getTime() - syncedAt > STALE_SYNC_AFTER_MS) {
    flags.push("stale_sync");
  }
  if (!inv.customerEmail || inv.customerEmail.trim() === "") {
    flags.push("no_billing_email");
  }
  if (inv.qbNote != null && String(inv.qbNote).trim() !== "") {
    flags.push("needs_qb_cleanup");
  }
  return flags;
}
