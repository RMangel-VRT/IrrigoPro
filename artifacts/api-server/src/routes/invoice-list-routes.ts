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
import {
  agingBucketRank,
  classifyAgingBucket,
  computeArFlags,
  computeEffectiveDueDate,
  daysOverdue,
  isBalanceFallback,
  isInvoiceOverdue,
  resolveBalanceDue,
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
 * this parameter rather than introducing a second one.
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
    agingRaw === "overdue"
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

  return {
    customerId:
      customerIdRaw != null && Number.isInteger(customerIdRaw) ? customerIdRaw : null,
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
}

/** Task #1887 — per-invoice reminder rollup, keyed by invoice id. */
export interface ReminderSummary {
  reminderCount: number;
  lastReminderAt: Date;
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

function matchesAging(row: AnnotatedInvoice, aging: AgingFilterValue): boolean {
  if (aging === "all") return true;
  if (!isOpenAr(row)) return false;
  if (aging === "overdue") return row.agingBucket !== "current";
  return row.agingBucket === AGING_VALUE_TO_BUCKET[aging];
}

/** Every filter combines with AND. */
export function matchesArFilters(
  row: AnnotatedInvoice,
  q: ArListQuery,
  now: Date = new Date(),
): boolean {
  if (q.customerId != null && row.customerId !== q.customerId) return false;
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

// ── Route registration ──────────────────────────────────────────────────────

export interface RegisterInvoiceListRoutesDeps {
  requireAuthentication: RequestHandler;
  /** CAN_READ_INVOICES. field_tech never reaches this endpoint. */
  requireInvoiceRead: RequestHandler;
  /** Defence in depth — the guard above already excludes field_tech. */
  applyPricingVisibility: (req: any, data: any) => any;
  /** Test seams. Production passes neither. */
  _storageApi?: {
    getInvoices(companyId: number | null): Promise<any[]>;
    getInvoiceReminderSummaries?(
      companyId: number | null,
    ): Promise<Map<number, ReminderSummary>>;
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
        if (callerRole !== "super_admin" && !req.authenticatedUserCompanyId) {
          res.status(403).json({ message: "Forbidden: user has no company association" });
          return;
        }
        const callerCompanyId =
          callerRole === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);

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

        const now = nowFn();
        const annotated = all.map((inv) =>
          annotateInvoiceForAr(inv, termsMap.get(inv.customerId), now, reminderMap.get(inv.id)),
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

        res.json(deps.applyPricingVisibility(req, page));
      } catch (error) {
        console.error("Error fetching invoices:", error);
        res.status(500).json({ message: "Failed to fetch invoices" });
      }
    },
  );
}
