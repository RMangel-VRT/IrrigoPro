// Task #1890 — GET /api/invoices, extracted from the routes.ts monolith.
//
// This handler used to live inline. It is a module now for two reasons:
//
//   1. The A/R query logic below (annotate → filter → sort → paginate) is the
//      part a bookkeeper's whole working day depends on, and it needs tests
//      that exercise the real handler against a storage spy rather than a test
//      that re-implements the same filtering and then agrees with itself.
//   2. Annotation moved *in front of* pagination. Previously the effective due
//      date was computed only for the 50 rows already sliced out, which meant
//      "oldest bucket, biggest balance first" could only ever sort the 50
//      newest invoices — backwards from what collections needs.
//
// Behaviour for a caller that passes no A/R parameters is unchanged: newest
// first by createdAt, same pagination semantics, same X-Total-Count header.
// The derived fields (isOverdue, effectiveDueDate, and the A/R additions) are
// annotated unconditionally, exactly as isOverdue/effectiveDueDate already were.

import type { Express, RequestHandler } from "express";
import { inArray } from "drizzle-orm";
import { customers } from "@workspace/db/schema";
import { db as dbModule } from "../db";
import { storage as storageModule } from "../storage";
import { paginate } from "./pagination";
// Shared with the notes endpoints so the list hover preview and the thread can
// never disagree about which note is latest or how it is truncated.
import { arNotePreview } from "./invoice-ar-note-routes";
import {
  agingBucketRank,
  AGING_BUCKET_KEYS,
  AGING_BUCKET_LABELS,
  classifyAgingBucket,
  computeArFlags,
  computeEffectiveDueDate,
  daysOverdue,
  isBalanceFallback,
  isInvoiceOverdue,
  OVERDUE_AGING_FILTER,
  resolveBalanceDue,
  hasCapability,
  CAN_READ_AR_NOTES,
  type AgingBucketKey,
  type ArFlag,
} from "@workspace/shared";

// ── Query contract ──────────────────────────────────────────────────────────

/**
 * Wire values for `?aging=`.
 *
 * `current` / `days30` / `days60` / `days90Plus` are the values the Financial
 * Pulse widget has always deep-linked with — unchanged, deliberately, so
 * existing links keep working. `overdue` is added for "anything at or past its
 * due date", which is what the collections landing default needs; it reuses
 * this parameter rather than introducing a second one. Its literal is
 * `OVERDUE_AGING_FILTER` in the shared aging module — the sidebar's overdue
 * badge (Task #1914) counts through this same filter, so the two surfaces
 * cannot drift on what they ask for.
 */
export type AgingFilterValue =
  | "all"
  | "current"
  | "days30"
  | "days60"
  | "days90Plus"
  | "overdue";

const AGING_VALUE_TO_BUCKET: Record<string, AgingBucketKey> = {
  current: "current",
  days30: "days30",
  days60: "days60",
  days90Plus: "days90",
};

export type PaymentStatusFilter = "all" | "unpaid" | "partially_paid" | "paid";
export type SentFilter = "all" | "sent" | "unsent";

/**
 * Task #1887 — `?reminders=`.
 *
 * The A/R list already rendered this control; it filtered nothing. It lives on
 * the server with the others because the list now sorts and filters over the
 * whole invoice set — a reminder filter applied to the loaded page would
 * silently mean "…among the 50 rows you happen to be looking at".
 *
 *   never       — no reminder has ever been delivered
 *   last7/30/60 — a reminder was delivered within that many days
 *   thrice      — three or more delivered reminders, the escalation queue
 */
export type ReminderFilterValue =
  | "all"
  | "never"
  | "last7"
  | "last30"
  | "last60"
  | "thrice";

const REMINDER_FILTER_WINDOW_DAYS: Partial<Record<ReminderFilterValue, number>> = {
  last7: 7,
  last30: 30,
  last60: 60,
};
export type SortDir = "asc" | "desc";

export type ArSortKey =
  | "customer"
  | "invoiceNumber"
  | "status"
  | "amount"
  | "period"
  | "balanceDue"
  | "effectiveDueDate"
  | "daysOverdue"
  | "agingBucket"
  | "paymentStatus"
  | "sent";

const SORT_KEYS: readonly ArSortKey[] = [
  "customer",
  "invoiceNumber",
  "status",
  "amount",
  "period",
  "balanceDue",
  "effectiveDueDate",
  "daysOverdue",
  "agingBucket",
  "paymentStatus",
  "sent",
];

export interface ArListQuery {
  customerId: number | null;
  /**
   * Task #1942 — free text over invoice number and customer name. It used to
   * be applied in the browser over the loaded page only, which made the
   * header total, the aging strip and a select-all over a multi-page result
   * disagree with what the table showed. Every narrowing the user can see has
   * to be applied here, or the aggregate and the selection describe a
   * different set than the rows.
   */
  search: string | null;
  /** Task #1942 — billing month as `YYYY-MM`, same reason as `search`. */
  month: string | null;
  aging: AgingFilterValue;
  paymentStatus: PaymentStatusFilter;
  sent: SentFilter;
  dateFrom: Date | null;
  dateTo: Date | null;
  amountMin: number | null;
  amountMax: number | null;
  flaggedOnly: boolean;
  reminders: ReminderFilterValue;
  sort: ArSortKey | null;
  dir: SortDir;
}

/** The query a caller that passes nothing gets: no filters, no sort. */
export const DEFAULT_AR_LIST_QUERY: ArListQuery = {
  customerId: null,
  search: null,
  month: null,
  aging: "all",
  paymentStatus: "all",
  sent: "all",
  dateFrom: null,
  dateTo: null,
  amountMin: null,
  amountMax: null,
  flaggedOnly: false,
  reminders: "all",
  sort: null,
  dir: "desc",
};

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

/**
 * The company's last QuickBooks payment sync: the newest `paymentSyncedAt`
 * across every invoice given, or null if none has ever been synced.
 *
 * A maximum, not a per-row read — the sync stamps the company in one pass, so
 * a single never-synced invoice does not make the connection stale.
 */
/**
 * The one company-scoping contract for the invoice page (Task #1942).
 *
 * The list and the aggregate above it must describe the same population, so
 * they resolve their scope the same way rather than each inventing one. A
 * scoped caller is pinned to her own company and cannot ask for another's; a
 * super_admin may name a company with `?companyId=`, and gets the same
 * cross-company view the list has always given when she names none. What is
 * not allowed is the pair disagreeing: a per-company total printed over a
 * cross-company list is a number the reader cannot act on and cannot detect.
 */
export type InvoiceScope =
  | { ok: true; companyId: number | null }
  | { ok: false; status: number; message: string };

export function resolveInvoiceScope(req: any): InvoiceScope {
  const callerRole = req?.authenticatedUserRole as string | undefined;
  if (callerRole === "super_admin") {
    const raw = req?.query?.companyId;
    const requested = num(raw);
    const given = str(raw);
    if (given != null && given.trim() !== "") {
      if (requested == null || !Number.isInteger(requested) || requested <= 0) {
        return {
          ok: false,
          status: 400,
          message: "Invalid companyId: expected a positive integer.",
        };
      }
      return { ok: true, companyId: requested };
    }
    // No company named — every company, exactly as the list has always done.
    return { ok: true, companyId: null };
  }
  if (!req?.authenticatedUserCompanyId) {
    return {
      ok: false,
      status: 403,
      message: "Forbidden: user has no company association",
    };
  }
  // A scoped caller's own company wins; a `?companyId=` she sends is ignored,
  // never honoured, so the parameter can never be used to widen her view.
  return { ok: true, companyId: req.authenticatedUserCompanyId };
}

export function latestPaymentSyncAt(rows: InvoiceRowLike[]): string | null {
  let latest: number | null = null;
  for (const row of rows) {
    const at = row.paymentSyncedAt;
    if (!at) continue;
    const t = new Date(at as any).getTime();
    if (Number.isNaN(t)) continue;
    if (latest == null || t > latest) latest = t;
  }
  return latest == null ? null : new Date(latest).toISOString();
}

function num(v: unknown): number | null {
  const s = str(v);
  if (s == null || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function boolish(v: unknown): boolean {
  const s = str(v);
  if (s == null) return false;
  return s === "1" || s.toLowerCase() === "true" || s.toLowerCase() === "yes";
}

/** `YYYY-MM-DD` with no time component means "the whole of that day". */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Billing month, as the invoice's own `invoiceYear`/`invoiceMonth` columns. */
const BILLING_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseDate(v: unknown, endOfDay: boolean): Date | null {
  const s = str(v);
  if (s == null || s.trim() === "") return null;
  const bare = BARE_DATE.test(s.trim());
  const d = new Date(bare ? `${s.trim()}T00:00:00.000Z` : s);
  if (Number.isNaN(d.getTime())) return null;
  if (bare && endOfDay) return new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
  return d;
}

/** Reads the A/R query parameters off a request query object. Total, never throws. */
export function parseArListQuery(query: Record<string, unknown>): ArListQuery {
  const agingRaw = str(query.aging);
  const aging: AgingFilterValue =
    agingRaw === "current" ||
    agingRaw === "days30" ||
    agingRaw === "days60" ||
    agingRaw === "days90Plus" ||
    agingRaw === OVERDUE_AGING_FILTER
      ? agingRaw
      : "all";

  const psRaw = str(query.paymentStatus);
  const paymentStatus: PaymentStatusFilter =
    psRaw === "unpaid" || psRaw === "partially_paid" || psRaw === "paid" ? psRaw : "all";

  const sentRaw = str(query.sent);
  const sent: SentFilter = sentRaw === "sent" || sentRaw === "unsent" ? sentRaw : "all";

  const remRaw = str(query.reminders);
  const reminders: ReminderFilterValue =
    remRaw === "never" ||
    remRaw === "last7" ||
    remRaw === "last30" ||
    remRaw === "last60" ||
    remRaw === "thrice"
      ? remRaw
      : "all";

  const sortRaw = str(query.sort);
  const sort = SORT_KEYS.includes(sortRaw as ArSortKey) ? (sortRaw as ArSortKey) : null;

  const dirRaw = str(query.dir);
  const dir: SortDir = dirRaw === "asc" ? "asc" : "desc";

  const customerIdRaw = num(query.customerId);

  const searchRaw = str(query.search)?.trim() ?? "";
  // A search box is free text from the browser: cap it rather than matching an
  // unbounded string against every row.
  const search = searchRaw === "" ? null : searchRaw.slice(0, 100);

  const monthRaw = str(query.month)?.trim() ?? "";
  const month = BILLING_MONTH.test(monthRaw) ? monthRaw : null;

  return {
    customerId:
      customerIdRaw != null && Number.isInteger(customerIdRaw) ? customerIdRaw : null,
    search,
    month,
    aging,
    paymentStatus,
    sent,
    dateFrom: parseDate(query.dateFrom, false),
    dateTo: parseDate(query.dateTo, true),
    amountMin: num(query.amountMin),
    amountMax: num(query.amountMax),
    flaggedOnly: boolish(query.flagged),
    reminders,
    sort,
    dir,
  };
}

/** True when nothing narrows or reorders the list — the legacy call shape. */
export function isUnfilteredArListQuery(q: ArListQuery): boolean {
  return (
    q.search == null &&
    q.month == null &&
    q.aging === "all" &&
    q.paymentStatus === "all" &&
    q.sent === "all" &&
    q.dateFrom == null &&
    q.dateTo == null &&
    q.amountMin == null &&
    q.amountMax == null &&
    !q.flaggedOnly &&
    q.reminders === "all" &&
    q.sort == null
  );
}

// ── Annotation ──────────────────────────────────────────────────────────────

/** The invoice-row fields this module reads. Structural so tests can use fixtures. */
export interface InvoiceRowLike {
  id: number;
  customerId: number;
  customerName: string;
  customerEmail: string;
  invoiceNumber: string;
  status: string;
  totalAmount: string;
  createdAt: Date | string;
  /** Billing month the invoice belongs to — its own columns, not createdAt. */
  invoiceYear?: number | null;
  invoiceMonth?: number | null;
  periodStart?: Date | string | null;
  dueDate?: Date | string | null;
  sentAt?: Date | string | null;
  paidAt?: Date | string | null;
  paymentStatus?: string | null;
  balance?: string | null;
  paymentSyncedAt?: Date | string | null;
  quickbooksInvoiceId?: string | null;
  qbVoidDetectedAt?: Date | string | null;
  qbNote?: string | null;
  [key: string]: unknown;
}

export interface AnnotatedInvoice extends InvoiceRowLike {
  isOverdue: boolean;
  effectiveDueDate: string;
  /** Whole days past the effective due date. Negative when not yet due. */
  daysOverdue: number;
  agingBucket: AgingBucketKey;
  /** Synced balance, or the invoice total when no payment sync has run. */
  balanceDue: string;
  /** True when `balanceDue` is the invoice total standing in for a real balance. */
  balanceIsFallback: boolean;
  arFlags: ArFlag[];
  /** Task #1887 — delivered reminders only. Null when none has ever gone out. */
  lastReminderAt: string | null;
  reminderCount: number;
  // ── Task #1889 — internal A/R notes ───────────────────────────────────────
  //
  // OPTIONAL ON PURPOSE. These three keys are present only for a caller with
  // CAN_READ_AR_NOTES. For anyone else — an irrigation_manager, who can read
  // invoices — they are stripped out of the payload entirely by
  // `applyArNoteVisibility` before the response is written, because a note
  // count of 3 on a row is itself the disclosure that a dispute is in flight.
  // Do not make them required, and do not "fix" a role's missing badge in the
  // client. See AR_NOTE_FIELDS_TO_STRIP in lib/db/src/ar-note-fields.ts.
  arNoteCount?: number;
  lastArNoteAt?: string | null;
  /** Truncated text of the most recent note, for the list hover preview. */
  lastArNotePreview?: string | null;
}

/** Task #1887 — per-invoice reminder rollup, keyed by invoice id. */
export interface ReminderSummary {
  reminderCount: number;
  lastReminderAt: Date;
}

/** Task #1889 — per-invoice A/R note rollup, keyed by invoice id. */
export interface ArNoteSummary {
  noteCount: number;
  lastNoteAt: Date;
  lastNoteText: string;
}

/**
 * Adds every derived A/R field to one invoice row.
 *
 * `isOverdue` and `effectiveDueDate` are computed exactly as before; the rest
 * are additive. All of them come from the shared aging module, so a row here
 * and the same row inside Financial Pulse land in the same bucket.
 */
export function annotateInvoiceForAr(
  inv: InvoiceRowLike,
  paymentTerms: string | null | undefined,
  now: Date,
  reminders?: ReminderSummary,
  // Task #1889 — passed only when the caller holds CAN_READ_AR_NOTES. When it
  // is undefined the three note keys are never written onto the row at all, so
  // the strip below has nothing to do for an unauthorized caller and a bug in
  // one of the two layers cannot leak the count on its own.
  notes?: { summary?: ArNoteSummary; visible: boolean },
): AnnotatedInvoice {
  const effDue = computeEffectiveDueDate(inv.dueDate, inv.createdAt, paymentTerms);
  const overdue = isInvoiceOverdue(inv.paymentStatus, effDue, now);
  const days = daysOverdue(effDue, now);
  const reminderCount = reminders?.reminderCount ?? 0;
  return {
    ...inv,
    isOverdue: overdue,
    effectiveDueDate: effDue.toISOString(),
    daysOverdue: Number.isFinite(days) ? Math.floor(days) : 0,
    agingBucket: classifyAgingBucket(days),
    balanceDue: resolveBalanceDue(inv).toFixed(2),
    balanceIsFallback: isBalanceFallback(inv),
    // The reminder count reaches computeArFlags so the shared helper can raise
    // "Reminded, still unpaid" — the flag has to come from the same place as
    // every other flag, not be bolted on here.
    arFlags: computeArFlags({ ...inv, reminderCount }, now, overdue),
    lastReminderAt: reminders?.lastReminderAt
      ? new Date(reminders.lastReminderAt).toISOString()
      : null,
    reminderCount,
    ...(notes?.visible
      ? {
          arNoteCount: notes.summary?.noteCount ?? 0,
          lastArNoteAt: notes.summary?.lastNoteAt
            ? new Date(notes.summary.lastNoteAt).toISOString()
            : null,
          lastArNotePreview: notes.summary
            ? arNotePreview(notes.summary.lastNoteText)
            : null,
        }
      : {}),
  };
}

// ── Filtering ───────────────────────────────────────────────────────────────

/**
 * Statuses that are not part of A/R at all. Same membership as Financial
 * Pulse's `INVOICE_EXCLUDED_STATUSES` plus `paid`, so an aging deep-link from
 * the A/R Aging widget selects the same population the widget counted.
 */
const NON_AR_STATUSES = new Set([
  "draft",
  "cancelled",
  "superseded",
  "merged",
  "failed",
  "paid",
]);

/** Outstanding money the business is still owed. */
export function isOpenAr(inv: InvoiceRowLike): boolean {
  if (NON_AR_STATUSES.has(inv.status)) return false;
  if (inv.paidAt) return false;
  return (inv.paymentStatus ?? "unpaid") !== "paid";
}

/** Invoice number or customer name, case-insensitive substring. */
function matchesSearch(row: AnnotatedInvoice, search: string | null): boolean {
  if (search == null) return true;
  const needle = search.toLowerCase();
  return (
    row.invoiceNumber.toLowerCase().includes(needle) ||
    row.customerName.toLowerCase().includes(needle)
  );
}

/** The invoice's own billing month, not its creation date. */
function matchesBillingMonth(row: AnnotatedInvoice, month: string | null): boolean {
  if (month == null) return true;
  const [year, mon] = month.split("-").map(Number);
  return row.invoiceYear === year && row.invoiceMonth === mon;
}

function matchesAging(row: AnnotatedInvoice, aging: AgingFilterValue): boolean {
  if (aging === "all") return true;
  if (!isOpenAr(row)) return false;
  if (aging === OVERDUE_AGING_FILTER) return row.agingBucket !== "current";
  return row.agingBucket === AGING_VALUE_TO_BUCKET[aging];
}

/** Every filter combines with AND. */
export function matchesArFilters(
  row: AnnotatedInvoice,
  q: ArListQuery,
  now: Date = new Date(),
): boolean {
  if (q.customerId != null && row.customerId !== q.customerId) return false;
  if (!matchesSearch(row, q.search)) return false;
  if (!matchesBillingMonth(row, q.month)) return false;
  if (!matchesAging(row, q.aging)) return false;
  if (q.paymentStatus !== "all" && (row.paymentStatus ?? "unpaid") !== q.paymentStatus) {
    return false;
  }
  if (q.sent === "sent" && !row.sentAt) return false;
  if (q.sent === "unsent" && row.sentAt) return false;
  if (q.dateFrom != null || q.dateTo != null) {
    const created = new Date(row.createdAt).getTime();
    if (Number.isNaN(created)) return false;
    if (q.dateFrom != null && created < q.dateFrom.getTime()) return false;
    if (q.dateTo != null && created > q.dateTo.getTime()) return false;
  }
  if (q.amountMin != null || q.amountMax != null) {
    const amount = parseFloat(row.totalAmount) || 0;
    if (q.amountMin != null && amount < q.amountMin) return false;
    if (q.amountMax != null && amount > q.amountMax) return false;
  }
  if (q.flaggedOnly && row.arFlags.length === 0) return false;
  if (!matchesReminders(row, q.reminders, now)) return false;
  return true;
}

/** Task #1887 — reminder filter, over delivered reminders only. */
function matchesReminders(
  row: AnnotatedInvoice,
  filter: ReminderFilterValue,
  now: Date,
): boolean {
  if (filter === "all") return true;
  if (filter === "never") return row.reminderCount === 0;
  if (filter === "thrice") return row.reminderCount >= 3;
  const windowDays = REMINDER_FILTER_WINDOW_DAYS[filter];
  if (windowDays == null) return true;
  if (!row.lastReminderAt) return false;
  const last = new Date(row.lastReminderAt).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last <= windowDays * 24 * 60 * 60 * 1000;
}

// ── Sorting ─────────────────────────────────────────────────────────────────

function timeOf(v: Date | string | null | undefined): number {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function compareBy(a: AnnotatedInvoice, b: AnnotatedInvoice, key: ArSortKey): number {
  switch (key) {
    case "customer":
      return a.customerName.localeCompare(b.customerName, undefined, { sensitivity: "base" });
    case "invoiceNumber":
      return a.invoiceNumber.localeCompare(b.invoiceNumber, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    case "status":
      return a.status.localeCompare(b.status, undefined, { sensitivity: "base" });
    case "amount":
      return (parseFloat(a.totalAmount) || 0) - (parseFloat(b.totalAmount) || 0);
    case "period":
      return timeOf(a.periodStart) - timeOf(b.periodStart);
    case "balanceDue":
      return (parseFloat(a.balanceDue) || 0) - (parseFloat(b.balanceDue) || 0);
    case "effectiveDueDate":
      return timeOf(a.effectiveDueDate) - timeOf(b.effectiveDueDate);
    case "daysOverdue":
      return a.daysOverdue - b.daysOverdue;
    case "agingBucket":
      return agingBucketRank(a.agingBucket) - agingBucketRank(b.agingBucket);
    case "paymentStatus":
      return (a.paymentStatus ?? "unpaid").localeCompare(b.paymentStatus ?? "unpaid");
    case "sent":
      return Number(!!a.sentAt) - Number(!!b.sentAt);
  }
}

/**
 * Orders the whole filtered set, not just a page.
 *
 * With no sort key this is the legacy ordering: createdAt descending.
 *
 * Sorting by `agingBucket` descending is the collections view — oldest bucket
 * first — and its secondary key is always balance descending, which is what
 * makes "biggest balance first within the oldest bucket first" a single sort
 * rather than two controls the user has to combine.
 */
export function sortAnnotatedInvoices(
  rows: AnnotatedInvoice[],
  sort: ArSortKey | null,
  dir: SortDir,
): AnnotatedInvoice[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (sort != null) {
      const primary = compareBy(a, b, sort);
      if (primary !== 0) return dir === "asc" ? primary : -primary;
      if (sort === "agingBucket") {
        const byBalance = (parseFloat(b.balanceDue) || 0) - (parseFloat(a.balanceDue) || 0);
        if (byBalance !== 0) return byBalance;
      }
    }
    // Stable, deterministic fallback: newest first, then id.
    const byCreated = timeOf(b.createdAt) - timeOf(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return b.id - a.id;
  });
  return sorted;
}

// ── Aging aggregate ─────────────────────────────────────────────────────────
//
// Task #1942 — the aging strip and the page header both need a total for the
// WHOLE filtered set, not for the page the client happens to have loaded. The
// list is paginated at 50, so a client-side sum reports the first page's
// balance and calls it the outstanding balance. That is the same error class
// #1890 fixed by moving filtering and sorting server-side, so the totals are
// computed here, over the same annotated rows, with the same filter matcher.

/** Bucket key → the `?aging=` wire value that selects exactly that bucket. */
const BUCKET_TO_AGING_VALUE: Record<AgingBucketKey, AgingFilterValue> = {
  current: "current",
  days30: "days30",
  days60: "days60",
  days90: "days90Plus",
};

export interface AgingBucketTotal {
  key: AgingBucketKey;
  /** From the shared aging module. The client never writes its own label. */
  label: string;
  /** What clicking this card should set `?aging=` to. */
  filterValue: AgingFilterValue;
  balanceDue: string;
  count: number;
}

export interface AgingSummary {
  buckets: AgingBucketTotal[];
  /** Across all four buckets — the header's outstanding balance and count. */
  overall: { balanceDue: string; count: number };
}

/**
 * Sums open A/R by bucket.
 *
 * Only open A/R rows are counted, which is the same precondition `matchesAging`
 * itself applies before comparing buckets. Without it a paid invoice would
 * carry a bucket it can never be filtered into, and the strip would report a
 * total the table could not reproduce.
 *
 * Boundaries are never recomputed here: `agingBucket` was assigned by
 * `classifyAgingBucket` during annotation, and the labels come from
 * `AGING_BUCKET_LABELS`.
 */
export function summarizeAging(rows: AnnotatedInvoice[]): AgingSummary {
  const totals = new Map<AgingBucketKey, { balance: number; count: number }>(
    AGING_BUCKET_KEYS.map((k) => [k, { balance: 0, count: 0 }]),
  );

  for (const row of rows) {
    if (!isOpenAr(row)) continue;
    const slot = totals.get(row.agingBucket);
    if (!slot) continue;
    slot.balance += parseFloat(row.balanceDue) || 0;
    slot.count += 1;
  }

  let overallBalance = 0;
  let overallCount = 0;
  const buckets = AGING_BUCKET_KEYS.map((key) => {
    const slot = totals.get(key)!;
    overallBalance += slot.balance;
    overallCount += slot.count;
    return {
      key,
      label: AGING_BUCKET_LABELS[key],
      filterValue: BUCKET_TO_AGING_VALUE[key],
      balanceDue: slot.balance.toFixed(2),
      count: slot.count,
    };
  });

  return {
    buckets,
    overall: { balanceDue: overallBalance.toFixed(2), count: overallCount },
  };
}

// ── Route registration ──────────────────────────────────────────────────────

export interface RegisterInvoiceListRoutesDeps {
  requireAuthentication: RequestHandler;
  /** CAN_READ_INVOICES. field_tech never reaches this endpoint. */
  requireInvoiceRead: RequestHandler;
  /** Defence in depth — the guard above already excludes field_tech. */
  applyPricingVisibility: (req: any, data: any) => any;
  /**
   * Task #1889 — strips arNoteCount / lastArNoteAt / lastArNotePreview for a
   * caller without CAN_READ_AR_NOTES. Defence in depth: the handler already
   * declines to fetch or annotate note data for such a caller, so this is the
   * second of two independent reasons the keys cannot reach the wire.
   */
  applyArNoteVisibility: (req: any, data: any) => any;
  /** Test seams. Production passes neither. */
  _storageApi?: {
    getInvoices(companyId: number | null): Promise<any[]>;
    getInvoiceReminderSummaries?(
      companyId: number | null,
    ): Promise<Map<number, ReminderSummary>>;
    getInvoiceArNoteSummaries?(
      companyId: number | null,
    ): Promise<Map<number, ArNoteSummary>>;
  };
  _loadPaymentTerms?: (customerIds: number[]) => Promise<Map<number, string | null>>;
  _now?: () => Date;
}

async function loadPaymentTermsFromDb(
  customerIds: number[],
): Promise<Map<number, string | null>> {
  if (customerIds.length === 0) return new Map();
  const rows = await dbModule
    .select({ id: customers.id, paymentTerms: customers.paymentTerms })
    .from(customers)
    .where(inArray(customers.id, customerIds));
  return new Map(rows.map((c) => [c.id, c.paymentTerms]));
}

export function registerInvoiceListRoutes(
  app: Express,
  deps: RegisterInvoiceListRoutesDeps,
): void {
  const storage = deps._storageApi ?? storageModule;
  const loadPaymentTerms = deps._loadPaymentTerms ?? loadPaymentTermsFromDb;
  const nowFn = deps._now ?? (() => new Date());

  app.get(
    "/api/invoices",
    deps.requireAuthentication,
    deps.requireInvoiceRead,
    async (req: any, res) => {
      try {
        const callerRole = req.authenticatedUserRole as string | undefined;
        const scope = resolveInvoiceScope(req);
        if (!scope.ok) {
          res.status(scope.status).json({ message: scope.message });
          return;
        }
        const callerCompanyId = scope.companyId;

        const q = parseArListQuery(req.query ?? {});
        const all = (await storage.getInvoices(callerCompanyId)) as InvoiceRowLike[];

        // Resolve payment terms across the WHOLE company-scoped set, not the
        // page. Filtering on aging is meaningless otherwise: the due date of a
        // row we have not annotated is unknown, so it could not be excluded.
        const uniqueCustomerIds = [...new Set(all.map((inv) => inv.customerId))];
        const termsMap = await loadPaymentTerms(uniqueCustomerIds);

        // Task #1887 — one rollup query for the whole scoped set, for the same
        // reason: the reminder filter runs server-side over every invoice, so
        // reminder data cannot be a per-page lookup.
        const reminderMap: Map<number, ReminderSummary> =
          (await storage.getInvoiceReminderSummaries?.(callerCompanyId)) ?? new Map();

        // Task #1889 — the note rollup is fetched ONLY for a caller who may see
        // notes. An irrigation_manager reaches this endpoint legitimately and
        // must leave with no note data at all, so the cheapest and safest thing
        // is not to load it. One query for the whole scoped set, never one per
        // row.
        const arNotesVisible = hasCapability(callerRole, CAN_READ_AR_NOTES);
        const arNoteMap: Map<number, ArNoteSummary> = arNotesVisible
          ? ((await storage.getInvoiceArNoteSummaries?.(callerCompanyId)) ?? new Map())
          : new Map();

        const now = nowFn();
        const annotated = all.map((inv) =>
          annotateInvoiceForAr(inv, termsMap.get(inv.customerId), now, reminderMap.get(inv.id), {
            summary: arNoteMap.get(inv.id),
            visible: arNotesVisible,
          }),
        );

        const filtered = annotated.filter((row) => matchesArFilters(row, q, now));
        const ordered = sortAnnotatedInvoices(filtered, q.sort, q.dir);

        // Task #532 — opt-in pagination via ?limit=&offset=. Falls back to the
        // legacy single-page slice (50 rows by default) when only `limit` is
        // provided and no `offset`. X-Total-Count is the POST-filter total, so
        // "load more" stops at the right place under an active filter.
        let page: AnnotatedInvoice[];
        if (req.query.offset != null && req.query.offset !== "") {
          page = paginate(req, res, ordered, { limit: 50, max: 500 });
        } else {
          const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;
          page = ordered.slice(0, Math.max(1, Math.min(500, limit)));
        }

        res.json(deps.applyArNoteVisibility(req, deps.applyPricingVisibility(req, page)));
      } catch (error) {
        console.error("Error fetching invoices:", error);
        res.status(500).json({ message: "Failed to fetch invoices" });
      }
    },
  );

  // Task #1942 — aging aggregate for the strip and the page header.
  //
  // Registered after /api/invoices and before any `/api/invoices/:id` route,
  // so the literal path wins. It respects every active filter EXCEPT `?aging=`
  // itself: the strip has to show what each bucket would select, and a strip
  // that re-filtered itself by the bucket already selected would report one
  // populated card and three zeroes.
  app.get(
    "/api/invoices/aging-summary",
    deps.requireAuthentication,
    deps.requireInvoiceRead,
    async (req: any, res) => {
      try {
        // Same contract as the list above, from the same helper: the totals in
        // the header and the strip describe exactly the rows the table shows.
        // A super_admin who names a company gets that company here and in the
        // list; one who names none gets the cross-company view in both.
        const scope = resolveInvoiceScope(req);
        if (!scope.ok) {
          res.status(scope.status).json({ message: scope.message });
          return;
        }
        const scopeCompanyId = scope.companyId;

        // `aging: "all"` is forced, not read: see the note above.
        const q: ArListQuery = { ...parseArListQuery(req.query ?? {}), aging: "all" };

        const all = (await storage.getInvoices(scopeCompanyId)) as InvoiceRowLike[];
        const uniqueCustomerIds = [...new Set(all.map((inv) => inv.customerId))];
        const termsMap = await loadPaymentTerms(uniqueCustomerIds);
        const reminderMap: Map<number, ReminderSummary> =
          (await storage.getInvoiceReminderSummaries?.(scopeCompanyId)) ?? new Map();

        const now = nowFn();
        // Notes are never loaded here — an aggregate has no note fields, so
        // there is nothing for a caller without CAN_READ_AR_NOTES to leak.
        const annotated = all.map((inv) =>
          annotateInvoiceForAr(inv, termsMap.get(inv.customerId), now, reminderMap.get(inv.id)),
        );
        const filtered = annotated.filter((row) => matchesArFilters(row, q, now));

        // The QuickBooks freshness pill reads `lastPaymentSyncAt` from here.
        // It is deliberately computed over `all` — every invoice in the
        // company, before any filter — because the pill is a statement about
        // the connection, not about the rows on screen. Derived from the
        // filtered set, a search or a month filter that happened to exclude
        // the most recently synced invoice would report a healthy connection
        // as stale.
        res.json({
          ...deps.applyPricingVisibility(req, summarizeAging(filtered)),
          lastPaymentSyncAt: latestPaymentSyncAt(all),
        });
      } catch (error) {
        console.error("Error summarizing invoice aging:", error);
        res.status(500).json({ message: "Failed to summarize invoice aging" });
      }
    },
  );
}
