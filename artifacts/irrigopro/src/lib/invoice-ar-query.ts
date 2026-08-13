/**
 * The invoice list's A/R view, as a URL.
 *
 * Task #1942 — extracted from `pages/invoices.tsx` so the collapsed filter bar,
 * the aging strip and the header can each read and write the same query model
 * without importing the page. Nothing here changed shape in the extraction:
 * the parameter names, their accepted values and the "only non-default values
 * are written" rule are exactly what shipped with #1890/#1887, because every
 * Financial Pulse deep link and every shared link depends on them.
 */

import { AGING_BUCKET_LABELS, type AgingBucketKey } from "@workspace/shared";

// Task #708 — A/R aging filter values mirror the
// `/api/financial-pulse/ar-aging` bucket keys (with `days90Plus` matching the
// inclusive 60+ bucket), so the widget can deep-link via `?aging=`.
// Task #1890 — `overdue` is an addition to this same parameter, NOT a second
// one: the collections landing default and the widget's deep links share it.
export type AgingFilter = "all" | "current" | "days30" | "days60" | "days90Plus" | "overdue";

export const AGING_OPTIONS: { value: AgingFilter; label: string }[] = [
  { value: "all", label: "All ages" },
  { value: "overdue", label: "Any overdue" },
  { value: "current", label: "Not yet due" },
  { value: "days30", label: AGING_BUCKET_LABELS.days30 },
  { value: "days60", label: AGING_BUCKET_LABELS.days60 },
  { value: "days90Plus", label: AGING_BUCKET_LABELS.days90 },
];

export const AGING_FILTER_LABELS: Record<AgingFilter, string> = Object.fromEntries(
  AGING_OPTIONS.map((o) => [o.value, o.label]),
) as Record<AgingFilter, string>;

/** Bucket key (as the server reports it) → the wire value of this filter. */
export const BUCKET_TO_AGING_VALUE: Record<AgingBucketKey, AgingFilter> = {
  current: "current",
  days30: "days30",
  days60: "days60",
  days90: "days90Plus",
};

export type PaymentStatusFilter = "all" | "unpaid" | "partially_paid" | "paid";
export type SentFilter = "all" | "sent" | "unsent";
/** Task #1887 — filters on the server, over every invoice, not the loaded page. */
export type ReminderFilter = "all" | "never" | "last7" | "last30" | "last60" | "thrice";

export const PAYMENT_STATUS_FILTER_LABELS: Record<PaymentStatusFilter, string> = {
  all: "Any payment",
  unpaid: "Unpaid",
  partially_paid: "Partially paid",
  paid: "Paid",
};

export const SENT_FILTER_LABELS: Record<SentFilter, string> = {
  all: "Sent or not",
  sent: "Sent",
  unsent: "Never sent",
};

export const REMINDER_FILTER_LABELS: Record<ReminderFilter, string> = {
  all: "Any",
  never: "Never reminded",
  last7: "Reminded in last 7 days",
  last30: "Reminded in last 30 days",
  last60: "Reminded in last 60 days",
  thrice: "Reminded 3+ times",
};

export type ArSortKey =
  | "balanceDue"
  | "effectiveDueDate"
  | "daysOverdue"
  | "agingBucket"
  | "paymentStatus"
  | "sent";

export const AR_SORT_KEYS: readonly ArSortKey[] = [
  "balanceDue",
  "effectiveDueDate",
  "daysOverdue",
  "agingBucket",
  "paymentStatus",
  "sent",
];

export const AR_SORT_LABELS: Record<ArSortKey, string> = {
  balanceDue: "Balance due",
  effectiveDueDate: "Due",
  daysOverdue: "Days overdue",
  agingBucket: "Aging",
  paymentStatus: "Payment",
  sent: "Sent",
};

export type ArSortDir = "asc" | "desc";

export interface ArQuery {
  /**
   * Task #1942 — free text over invoice number and customer name. It lives in
   * the URL and is applied by the server, like every other narrowing here.
   * When it filtered in the browser instead, the header total, the aging
   * strip and a select-all over a multi-page result each described a wider
   * set than the table showed.
   */
  search: string;
  /** Task #1942 — billing month as `YYYY-MM`, server-applied for the same reason. */
  month: string;
  aging: AgingFilter;
  paymentStatus: PaymentStatusFilter;
  sent: SentFilter;
  reminders: ReminderFilter;
  customerId: string;
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  flagged: boolean;
  sort: ArSortKey | null;
  dir: ArSortDir;
}

export const EMPTY_AR_QUERY: ArQuery = {
  search: "",
  month: "",
  aging: "all",
  paymentStatus: "all",
  sent: "all",
  reminders: "all",
  customerId: "",
  dateFrom: "",
  dateTo: "",
  amountMin: "",
  amountMax: "",
  flagged: false,
  sort: null,
  dir: "desc",
};

/**
 * The collections landing view: unpaid and overdue, oldest bucket first with
 * the biggest balance first inside it. Expressed as a URL rather than a
 * separate route, so there is still exactly one canonical invoice list.
 */
export const COLLECTIONS_DEFAULT_QUERY: ArQuery = {
  ...EMPTY_AR_QUERY,
  aging: "overdue",
  paymentStatus: "unpaid",
  // Task #1942 — biggest first, not oldest-bucket first. Both orderings are
  // "collections work", but the money is the thing being chased: bucket-first
  // puts a $40 invoice from last quarter above a $9,000 one from last month.
  // The ordering is applied by the server across the whole filtered set, and
  // an A/R sort renders the list flat rather than sliced back into months.
  sort: "balanceDue",
  dir: "desc",
};

export function parseAging(search: string): AgingFilter {
  const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("aging");
  if (
    v === "current" ||
    v === "days30" ||
    v === "days60" ||
    v === "days90Plus" ||
    v === "overdue"
  ) {
    return v;
  }
  return "all";
}

/** Billing month, matching the server's own accepted shape. */
const BILLING_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function readArQuery(search: string): ArQuery {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const ps = p.get("paymentStatus");
  const sent = p.get("sent");
  const sort = p.get("sort");
  const rem = p.get("reminders");
  return {
    search: p.get("search") ?? "",
    month: BILLING_MONTH.test(p.get("month") ?? "") ? (p.get("month") as string) : "",
    aging: parseAging(search),
    paymentStatus:
      ps === "unpaid" || ps === "partially_paid" || ps === "paid" ? ps : "all",
    sent: sent === "sent" || sent === "unsent" ? sent : "all",
    reminders:
      rem === "never" || rem === "last7" || rem === "last30" || rem === "last60" || rem === "thrice"
        ? rem
        : "all",
    customerId: p.get("customerId") ?? "",
    dateFrom: p.get("dateFrom") ?? "",
    dateTo: p.get("dateTo") ?? "",
    amountMin: p.get("amountMin") ?? "",
    amountMax: p.get("amountMax") ?? "",
    flagged: p.get("flagged") === "1",
    sort: AR_SORT_KEYS.includes(sort as ArSortKey) ? (sort as ArSortKey) : null,
    dir: p.get("dir") === "asc" ? "asc" : "desc",
  };
}

/** Only non-default values are written, so a clean view has a clean URL. */
export function arQueryToParams(q: ArQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.search.trim()) p.set("search", q.search.trim());
  if (q.month) p.set("month", q.month);
  if (q.aging !== "all") p.set("aging", q.aging);
  if (q.paymentStatus !== "all") p.set("paymentStatus", q.paymentStatus);
  if (q.sent !== "all") p.set("sent", q.sent);
  if (q.reminders !== "all") p.set("reminders", q.reminders);
  if (q.customerId) p.set("customerId", q.customerId);
  if (q.dateFrom) p.set("dateFrom", q.dateFrom);
  if (q.dateTo) p.set("dateTo", q.dateTo);
  if (q.amountMin) p.set("amountMin", q.amountMin);
  if (q.amountMax) p.set("amountMax", q.amountMax);
  if (q.flagged) p.set("flagged", "1");
  if (q.sort) {
    p.set("sort", q.sort);
    p.set("dir", q.dir);
  }
  return p;
}

/** True when nothing is narrowing or reordering the list. */
export function isEmptyArQuery(q: ArQuery): boolean {
  return arQueryToParams(q).toString() === "";
}

/**
 * The aggregate endpoint is asked the same question as the list, minus the
 * bucket the user is standing in: the strip has to keep showing the other
 * three buckets while one of them is selected, or clicking a card would
 * empty the strip that produced it.
 */
export function agingSummaryParams(q: ArQuery): string {
  const p = arQueryToParams(q);
  p.delete("aging");
  p.delete("sort");
  p.delete("dir");
  return p.toString();
}

/**
 * Task #1942 — one removable chip per active filter.
 *
 * `clear` is the patch that removes just that filter, so a chip can never
 * accidentally reset a neighbour. Sort is deliberately absent: it is an
 * ordering, not a narrowing, and it has its own control.
 */
export interface ArFilterChip {
  key: string;
  label: string;
  clear: Partial<ArQuery>;
}

export function describeActiveFilters(
  q: ArQuery,
  customerName?: (id: string) => string | undefined,
): ArFilterChip[] {
  const chips: ArFilterChip[] = [];
  if (q.search.trim()) {
    chips.push({
      key: "search",
      label: `Search: ${q.search.trim()}`,
      clear: { search: "" },
    });
  }
  if (q.aging !== "all") {
    chips.push({
      key: "aging",
      label: `Aging: ${AGING_FILTER_LABELS[q.aging]}`,
      clear: { aging: "all" },
    });
  }
  if (q.paymentStatus !== "all") {
    chips.push({
      key: "paymentStatus",
      label: `Payment: ${PAYMENT_STATUS_FILTER_LABELS[q.paymentStatus]}`,
      clear: { paymentStatus: "all" },
    });
  }
  if (q.sent !== "all") {
    chips.push({
      key: "sent",
      label: `Sent: ${SENT_FILTER_LABELS[q.sent]}`,
      clear: { sent: "all" },
    });
  }
  if (q.reminders !== "all") {
    chips.push({
      key: "reminders",
      label: REMINDER_FILTER_LABELS[q.reminders],
      clear: { reminders: "all" },
    });
  }
  if (q.customerId) {
    const name = customerName?.(q.customerId);
    chips.push({
      key: "customerId",
      label: `Customer: ${name ?? `#${q.customerId}`}`,
      clear: { customerId: "" },
    });
  }
  if (q.dateFrom) {
    chips.push({ key: "dateFrom", label: `Created from ${q.dateFrom}`, clear: { dateFrom: "" } });
  }
  if (q.dateTo) {
    chips.push({ key: "dateTo", label: `Created to ${q.dateTo}`, clear: { dateTo: "" } });
  }
  if (q.amountMin) {
    chips.push({ key: "amountMin", label: `Min $${q.amountMin}`, clear: { amountMin: "" } });
  }
  if (q.amountMax) {
    chips.push({ key: "amountMax", label: `Max $${q.amountMax}`, clear: { amountMax: "" } });
  }
  if (q.flagged) {
    chips.push({ key: "flagged", label: "Flagged only", clear: { flagged: false } });
  }
  return chips;
}
