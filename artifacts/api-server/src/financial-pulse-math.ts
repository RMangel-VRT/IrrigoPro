// Task #688 — Financial Pulse Slice 2.
//
// Pure math helpers for the /api/financial-pulse/* endpoints. These are
// extracted from the route module so the KPI math can be exercised in a
// vanilla node:test fixture without spinning up Express or Postgres.

// Task #1890 — the due-date / aging rules are shared with the invoice list
// route and the web app. See lib/shared/src/invoice-aging.ts; the boundaries
// there are frozen because every aging total below depends on them.
import {
  AGING_BUCKET_KEYS,
  AGING_BUCKET_LABELS,
  agingBucketRank,
  classifyAgingBucket,
  computeEffectiveDueDate,
  daysOverdue,
  type AgingBucketKey,
} from "@workspace/shared";

export interface InvoiceLike {
  id: number;
  customerId: number;
  totalAmount: string | number;
  partsSubtotal?: string | number | null;
  laborSubtotal?: string | number | null;
  status: string;
  createdAt: Date | string;
  paidAt?: Date | string | null;
  // Task #726 — billing-cycle fields for computeBilledForCycle / computeAllBillableYtd.
  // Optional so existing fixtures without these fields keep compiling.
  invoiceMonth?: number | null;
  invoiceYear?: number | null;
  // Task #1831 — QBO payment-status sync fields.
  // `paymentStatus` is the 3-tier state: unpaid | partially_paid | paid.
  // `balance` is the remaining owed (null = not yet synced).
  // `dueDate` is used for overdue bucketing in AR aging.
  // `paymentTerms` is the customer's terms (net_30 / net_15 / due_on_receipt)
  // used as the fallback when `dueDate` is absent.
  paymentStatus?: string | null;
  balance?: string | number | null;
  dueDate?: Date | string | null;
  paymentTerms?: string | null;
}

// Task #726 — lightweight shapes used only by computeAllBillableYtd so the
// YTD helper stays pure (no Drizzle / Postgres dependency).
export interface WorkOrderBillableLike {
  invoiceId?: number | null;
  totalAmount?: string | number | null;
  status: string;
  createdAt?: Date | string | null;
}

export interface BillingSheetBillableLike {
  invoiceId?: number | null;
  totalAmount?: string | number | null;
  status: string;
  createdAt?: Date | string | null;
}

// Task #814 — wet_check_billings shape for computeAllBillableYtd.
// Uses workDate (logical work date) for year bucketing, parallel to
// billing_sheets.createdAt / work_orders.createdAt patterns.
export interface WetCheckBillingBillableLike {
  invoiceId?: number | null;
  totalAmount?: string | number | null;
  status: string;
  workDate?: Date | string | null;
}

// Task #814 — wet_check_billings shape for computeGrossMargin and
// computeByTechnician. Has pre-computed subtotals (no hours × wage needed
// for gross margin — task specifies adding laborSubtotal directly).
export interface WetCheckBillingLike {
  invoiceId?: number | null;
  partsSubtotal?: string | number | null;
  laborSubtotal?: string | number | null;
  technicianId?: number | null;
  totalHours?: string | number | null;
}

export interface InvoiceItemLike {
  invoiceId: number | null;
  laborRate?: string | number | null;
  laborTotal?: string | number | null;
  totalPrice?: string | number | null;
}

export interface CustomerLike {
  id: number;
  companyId: number;
  contractType?: string | null;
  emergencyLaborRate?: string | number | null;
}

export interface WorkOrderLike {
  invoiceId?: number | null;
  totalHours?: string | number | null;
  totalPartsCost?: string | number | null;
  assignedTechnicianId?: number | null;
  completedByUserId?: number | null;
}

export interface BillingSheetLike {
  invoiceId?: number | null;
  totalHours?: string | number | null;
  partsSubtotal?: string | number | null;
  technicianId?: number | null;
}

export interface UserLike {
  id: number;
  hourlyWage?: string | number | null;
}

export function toNum(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

function inWindow(d: Date | null, start: Date, end: Date): boolean {
  if (!d) return false;
  return d >= start && d < end;
}

// Windows are inclusive of `start` and exclusive of `end` (`d >= start
// && d < end`). MTD / YTD are intentionally "to-date" — the end is
// pinned to the millisecond AFTER `now`, NOT the start of the next
// month / year — so future-dated invoices never bleed into the rollup
// and the prior-period comparators line up calendar-day for
// calendar-day. See Task #688 review note.
export function getMtdWindow(now: Date) {
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getTime() + 1),
  };
}
export function getYtdWindow(now: Date) {
  return {
    start: new Date(now.getFullYear(), 0, 1),
    end: new Date(now.getTime() + 1),
  };
}
export function getPrevMonthWindow(now: Date) {
  // Same calendar slice in the previous month: from the 1st of last
  // month through `now`'s day-of-month, so MoM comparison is
  // calendar-day aligned (not full prior month vs partial current
  // month).
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(
    now.getFullYear(),
    now.getMonth() - 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds() + 1,
  );
  return { start, end };
}
export function getPrevFullMonthWindow(now: Date) {
  // Full prior calendar month: [first day of prev month, first day of
  // current month). Used by the "Billed Last Cycle" tile so it shows
  // the closed prior month total regardless of where we are in the
  // current month.
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start, end };
}
export function getPrevYearYtdWindow(now: Date) {
  // Same calendar slice in previous year — Jan 1 of last year through
  // `now`'s month/day, aligned to the millisecond after the matching
  // day-of-year. Calendar-day parity with `getYtdWindow`.
  const start = new Date(now.getFullYear() - 1, 0, 1);
  const end = new Date(
    now.getFullYear() - 1,
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds() + 1,
  );
  return { start, end };
}

// Task #1756 — canonical set of terminal/excluded statuses for every financial
// rollup. Extend this constant rather than duplicating the tuple.
export const INVOICE_EXCLUDED_STATUSES = new Set([
  "draft", "cancelled", "superseded", "merged", "failed",
]);

export function computeBilled(
  invoices: InvoiceLike[],
  start: Date,
  end: Date,
): number {
  let sum = 0;
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    const d = toDate(inv.createdAt);
    if (!inWindow(d, start, end)) continue;
    sum += toNum(inv.totalAmount);
  }
  return sum;
}

export function computeCollected(
  invoices: InvoiceLike[],
  start: Date,
  end: Date,
): number {
  // Task #720 — defend the tile against stale status: a row with a
  // non-null `paidAt` inside the window but still marked `draft` or
  // `cancelled` is a data bug, and must not inflate Collected MTD.
  // Reconciliation contract is in docs/financial-metrics.md.
  let sum = 0;
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    const d = toDate(inv.paidAt ?? null);
    if (!inWindow(d, start, end)) continue;
    sum += toNum(inv.totalAmount);
  }
  return sum;
}

export function computeOutstandingAr(invoices: InvoiceLike[]): number {
  let sum = 0;
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status) || inv.status === "paid")
      continue;
    if (inv.paidAt) continue;
    // Task #1831 — use remaining balance for partially-paid invoices
    const ps = inv.paymentStatus ?? "unpaid";
    if (ps === "paid") continue;
    if (ps === "partially_paid" && inv.balance != null) {
      const bal = toNum(inv.balance);
      if (bal > 0) sum += bal;
      continue;
    }
    sum += toNum(inv.totalAmount);
  }
  return sum;
}

export function computeAvgDaysToPay(
  invoices: InvoiceLike[],
  now: Date,
): number | null {
  const ninetyAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  let total = 0;
  let n = 0;
  for (const inv of invoices) {
    const paid = toDate(inv.paidAt ?? null);
    if (!paid || paid < ninetyAgo || paid > now) continue;
    const created = toDate(inv.createdAt);
    if (!created) continue;
    const days = (paid.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
    if (!Number.isFinite(days) || days < 0) continue;
    total += days;
    n++;
  }
  return n === 0 ? null : total / n;
}

export function computeProjectedMonthEnd(
  pipelineBase: number,
  now: Date,
): number {
  const day = now.getDate();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();
  if (day <= 0) return pipelineBase;
  return (pipelineBase / day) * daysInMonth;
}

// Task #726 — Tile 1: Billed Last Cycle.
// Returns all distinct billing cycles (non-draft, non-cancelled) sorted
// most-recent-first. Each entry is { year, month } matching the invoice
// invoiceYear / invoiceMonth columns. Invoices missing these columns are
// skipped.
export function getDistinctBillingCycles(
  invoices: InvoiceLike[],
): Array<{ year: number; month: number }> {
  const seen = new Map<number, { year: number; month: number }>();
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    if (inv.invoiceMonth == null || inv.invoiceYear == null) continue;
    const key = inv.invoiceYear * 100 + inv.invoiceMonth;
    if (!seen.has(key)) {
      seen.set(key, { year: inv.invoiceYear, month: inv.invoiceMonth });
    }
  }
  return Array.from(seen.values()).sort(
    (a, b) => (b.year * 100 + b.month) - (a.year * 100 + a.month),
  );
}

// Sums non-draft, non-cancelled invoices that belong to the given
// invoiceYear / invoiceMonth billing cycle.
export function computeBilledForCycle(
  invoices: InvoiceLike[],
  cycle: { year: number; month: number },
): number {
  let sum = 0;
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    if (inv.invoiceYear === cycle.year && inv.invoiceMonth === cycle.month) {
      sum += toNum(inv.totalAmount);
    }
  }
  return sum;
}

// Task #726 — Tile 5: Billed YTD (all billable activity this year).
//
// Formula:
//   invoices where invoiceYear = currentYear, status ≠ draft/cancelled
//   + ALL work_orders where status ≠ cancelled, createdAt year = currentYear
//     (invoiced OR uninvoiced — both count)
//   + ALL billing_sheets where status ≠ cancelled, createdAt year = currentYear
//     (invoiced OR uninvoiced — both count)
//   + uninvoiced wet_check_billings where workDate year = currentYear
//     (invoiced ones already flow through the invoices leg above)
//
// This intentionally includes WOs/BSs that have already been invoiced alongside
// the invoice totals, giving a complete picture of all billable work contracted
// this year per the task-#726 definition ("invoiced or not").
export function computeAllBillableYtd(
  invoices: InvoiceLike[],
  workOrders: WorkOrderBillableLike[],
  billingSheets: BillingSheetBillableLike[],
  currentYear: number,
  // Task #814 — uninvoiced wet check billings bucketed by workDate.
  wetCheckBillings: WetCheckBillingBillableLike[] = [],
): number {
  let sum = 0;
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    if (inv.invoiceYear !== currentYear) continue;
    sum += toNum(inv.totalAmount);
  }
  for (const wo of workOrders) {
    // invoiced or not — include all except cancelled
    if (wo.status === "cancelled") continue;
    const d = toDate(wo.createdAt ?? null);
    if (!d || d.getFullYear() !== currentYear) continue;
    sum += toNum(wo.totalAmount);
  }
  for (const bs of billingSheets) {
    if (bs.status === "cancelled") continue;
    const d = toDate(bs.createdAt ?? null);
    if (!d || d.getFullYear() !== currentYear) continue;
    sum += toNum(bs.totalAmount);
  }
  // Task #814 — uninvoiced WCBs only (invoiced ones already in the invoices
  // leg above). wet_check_billings has no cancelled status so no exclusion
  // needed beyond the invoiceId check.
  for (const wcb of wetCheckBillings) {
    if (wcb.invoiceId != null) continue; // already in invoice totals
    const d = toDate(wcb.workDate ?? null);
    if (!d || d.getFullYear() !== currentYear) continue;
    sum += toNum(wcb.totalAmount);
  }
  return sum;
}

// Task #730 — shared predicate for "is this row part of the unbilled pipeline?"
// Used by computeUnbilledExposure (global tile) and the per-customer summary
// endpoint so both surfaces apply exactly the same rule. A row is unbilled when
// it has no invoice yet AND was not explicitly cancelled.
export function isUnbilledWorkRow(row: {
  invoiceId?: number | null | undefined;
  status: string;
}): boolean {
  return row.invoiceId == null && row.status !== "cancelled";
}

export interface GrossMarginResult {
  pct: number | null;
  revenue: number;
  partsCost: number;
  laborCost: number;
  missingWageTechCount: number;
  /** Task #730 — total dollar amount of labor cost computed using the fallback
   * wage (both missing-wage techs and unknown techs). Exposed on the tile
   * warning so users understand the magnitude of the estimate. */
  estimatedLaborCostShortfall: number;
}

export function computeGrossMargin(input: {
  invoices: InvoiceLike[];
  workOrders: WorkOrderLike[];
  billingSheets: BillingSheetLike[];
  // Task #814 — wet check billings linked to invoices in the window.
  // partsSubtotal added to partsCost; laborSubtotal added directly to
  // laborCost (WCBs already carry a computed rate-based subtotal).
  wetCheckBillings?: WetCheckBillingLike[];
  usersById: Map<number, UserLike>;
  fallbackHourlyWage: number;
  window: { start: Date; end: Date };
}): GrossMarginResult {
  const {
    invoices,
    workOrders,
    billingSheets,
    wetCheckBillings = [],
    usersById,
    fallbackHourlyWage,
    window,
  } = input;
  const invoiceIdsInWindow = new Set<number>();
  let revenue = 0;
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    const d = toDate(inv.createdAt);
    if (!inWindow(d, window.start, window.end)) continue;
    invoiceIdsInWindow.add(inv.id);
    revenue += toNum(inv.totalAmount);
  }

  let partsCost = 0;
  let laborCost = 0;
  let estimatedLaborCostShortfall = 0;
  const missingWageTechs = new Set<number>();
  const usedFallbackForUnknownTech = { flag: false };

  const tally = (techId: number | null | undefined, hours: number) => {
    if (!Number.isFinite(hours) || hours <= 0) return;
    let wage = fallbackHourlyWage;
    let usedFallback = false;
    if (techId != null) {
      const u = usersById.get(techId);
      const w = toNum(u?.hourlyWage, NaN);
      if (Number.isFinite(w) && w > 0) {
        wage = w;
      } else {
        missingWageTechs.add(techId);
        usedFallback = true;
      }
    } else {
      usedFallbackForUnknownTech.flag = true;
      usedFallback = true;
    }
    const cost = hours * wage;
    laborCost += cost;
    if (usedFallback) {
      estimatedLaborCostShortfall += cost;
    }
  };

  for (const wo of workOrders) {
    if (wo.invoiceId == null || !invoiceIdsInWindow.has(wo.invoiceId)) continue;
    partsCost += toNum(wo.totalPartsCost);
    tally(
      wo.assignedTechnicianId ?? wo.completedByUserId ?? null,
      toNum(wo.totalHours),
    );
  }
  for (const bs of billingSheets) {
    if (bs.invoiceId == null || !invoiceIdsInWindow.has(bs.invoiceId)) continue;
    partsCost += toNum(bs.partsSubtotal);
    tally(bs.technicianId ?? null, toNum(bs.totalHours));
  }
  // Task #814 — wet check billings linked to invoices in the window.
  // Use pre-computed subtotals directly (labor rate already baked in).
  for (const wcb of wetCheckBillings) {
    if (wcb.invoiceId == null || !invoiceIdsInWindow.has(wcb.invoiceId)) continue;
    partsCost += toNum(wcb.partsSubtotal);
    laborCost += toNum(wcb.laborSubtotal);
  }

  const pct =
    revenue > 0 ? ((revenue - partsCost - laborCost) / revenue) * 100 : null;
  return {
    pct,
    revenue,
    partsCost,
    laborCost,
    missingWageTechCount: missingWageTechs.size,
    estimatedLaborCostShortfall,
  };
}

export function pctDelta(curr: number, prev: number): number | null {
  if (!Number.isFinite(prev) || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

export interface MonthBucket {
  month: string; // YYYY-MM
  revenue: number;
  partsRevenue: number;
  laborRevenue: number;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function getMonthStarts(now: Date, count: number): Date[] {
  // `count` first-of-month dates ending with the current month, ascending.
  const out: Date[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  }
  return out;
}

export function bucketMonthlyRevenue(
  invoices: InvoiceLike[],
  monthStarts: Date[],
): MonthBucket[] {
  const buckets = monthStarts.map((d) => ({
    month: monthKey(d),
    revenue: 0,
    partsRevenue: 0,
    laborRevenue: 0,
  }));
  const idx = new Map(buckets.map((b, i) => [b.month, i]));
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    const d = toDate(inv.createdAt);
    if (!d) continue;
    const i = idx.get(monthKey(d));
    if (i == null) continue;
    buckets[i].revenue += toNum(inv.totalAmount);
    buckets[i].partsRevenue += toNum(inv.partsSubtotal);
    buckets[i].laborRevenue += toNum(inv.laborSubtotal);
  }
  return buckets;
}

export interface RevenueMixResult {
  partsVsLabor: { parts: number; labor: number };
  emergencyVsStandard: { emergency: number; standard: number };
  contractVsAdhoc: { contract: number; adhoc: number };
}

// ─── Slice 3 helpers (Task #692) ────────────────────────────────────────────

// Task #1890 — the bucket keys, labels and boundary rule now come from the
// shared module so this computation, the invoice list route and the invoice
// page's client-side matcher cannot drift apart. The key type is re-exported
// under its original name for existing importers.
export type { AgingBucketKey };
export interface AgingBucket {
  key: AgingBucketKey;
  label: string;
  amount: number;
  count: number;
}

/**
 * A/R aging buckets, keyed off how far past its effective due date each
 * outstanding invoice is: Current (not yet due), 0–29, 30–59, 60+ days
 * overdue. Uses the same outstanding-invoice filter as `computeOutstandingAr`
 * so the four bucket amounts sum to the Outstanding A/R KPI within rounding.
 */
export function computeArAging(
  invoices: InvoiceLike[],
  now: Date,
): AgingBucket[] {
  const buckets: AgingBucket[] = AGING_BUCKET_KEYS.map((key) => ({
    key,
    label: AGING_BUCKET_LABELS[key],
    amount: 0,
    count: 0,
  }));
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status) || inv.status === "paid")
      continue;
    if (inv.paidAt) continue;
    // Task #1831 — skip fully-paid rows, use balance for partially-paid
    const ps = inv.paymentStatus ?? "unpaid";
    if (ps === "paid") continue;
    const created = toDate(inv.createdAt);
    if (!created) continue;
    // Bucket by effective due date: dueDate if set, else createdAt + customer
    // payment terms (net_30=30d, net_15=15d, due_on_receipt=0d; default net_30).
    const due = computeEffectiveDueDate(inv.dueDate, created, inv.paymentTerms);
    const bucket = classifyAgingBucket(daysOverdue(due, now));
    const i = agingBucketRank(bucket);
    const amount = ps === "partially_paid" && inv.balance != null ? Math.max(0, toNum(inv.balance)) : toNum(inv.totalAmount);
    buckets[i].amount += amount;
    buckets[i].count += 1;
  }
  return buckets;
}

export interface BudgetFields {
  monthlyBudgetCap?: string | number | null;
  annualBudgetCap?: string | number | null;
  budgetSoftThresholdPercent?: number | null;
  budgetHardThresholdPercent?: number | null;
}

export type BudgetStatus = "unset" | "healthy" | "approaching" | "over";

export function classifyStatus(
  percent: number | null,
  soft: number,
  hard: number,
): BudgetStatus {
  if (percent == null) return "unset";
  const p = percent * 100;
  if (p >= hard) return "over";
  if (p >= soft) return "approaching";
  return "healthy";
}

export interface TopCustomerRow {
  customerId: number;
  name: string;
  revenue: number;
  monthlyCap: number | null;
  monthlySpend: number;
  monthlyUsedPct: number | null;
  monthlyStatus: BudgetStatus;
  annualCap: number | null;
  annualSpend: number;
  annualUsedPct: number | null;
  annualStatus: BudgetStatus;
  avgDaysToPay: number | null;
  lastInvoiceAt: string | null;
  monthlySpark: { month: string; revenue: number }[];
}

export interface CustomerWithBudget extends CustomerLike, BudgetFields {
  name?: string | null;
  hiddenFromBilling?: boolean | null;
}

export function computeTopCustomers(input: {
  customers: CustomerWithBudget[];
  invoices: InvoiceLike[];
  window: { start: Date; end: Date };
  now: Date;
}): TopCustomerRow[] {
  const { customers: custs, invoices, window, now } = input;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getTime() + 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const yearEnd = new Date(now.getTime() + 1);
  const sparkStarts = getMonthStarts(now, 7);
  const sparkKeys = sparkStarts.map(
    (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
  );
  const sparkIdx = new Map(sparkKeys.map((k, i) => [k, i]));

  const byCust = new Map<
    number,
    {
      revenue: number;
      monthSpend: number;
      yearSpend: number;
      spark: number[];
      lastInvoiceAt: Date | null;
      payDays: { sum: number; n: number };
    }
  >();
  const ninetyAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    const d = toDate(inv.createdAt);
    if (!d) continue;
    const total = toNum(inv.totalAmount);
    let row = byCust.get(inv.customerId);
    if (!row) {
      row = {
        revenue: 0,
        monthSpend: 0,
        yearSpend: 0,
        spark: new Array(sparkStarts.length).fill(0),
        lastInvoiceAt: null,
        payDays: { sum: 0, n: 0 },
      };
      byCust.set(inv.customerId, row);
    }
    if (d >= window.start && d < window.end) row.revenue += total;
    if (d >= monthStart && d < monthEnd) row.monthSpend += total;
    if (d >= yearStart && d < yearEnd) row.yearSpend += total;
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const idx = sparkIdx.get(k);
    if (idx != null) row.spark[idx] += total;
    if (!row.lastInvoiceAt || d > row.lastInvoiceAt) row.lastInvoiceAt = d;
    const paid = toDate(inv.paidAt ?? null);
    if (paid && paid >= ninetyAgo && paid <= now) {
      const days = (paid.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
      if (Number.isFinite(days) && days >= 0) {
        row.payDays.sum += days;
        row.payDays.n += 1;
      }
    }
  }

  const out: TopCustomerRow[] = [];
  for (const c of custs) {
    if (c.hiddenFromBilling) continue;
    const r = byCust.get(c.id);
    const monthSpend = r?.monthSpend ?? 0;
    const yearSpend = r?.yearSpend ?? 0;
    const mCap = c.monthlyBudgetCap == null || c.monthlyBudgetCap === ""
      ? null
      : toNum(c.monthlyBudgetCap);
    const aCap = c.annualBudgetCap == null || c.annualBudgetCap === ""
      ? null
      : toNum(c.annualBudgetCap);
    const soft = c.budgetSoftThresholdPercent ?? 75;
    const hard = c.budgetHardThresholdPercent ?? 100;
    const mPct = mCap != null && mCap > 0 ? monthSpend / mCap : null;
    const aPct = aCap != null && aCap > 0 ? yearSpend / aCap : null;
    out.push({
      customerId: c.id,
      name: c.name ?? `Customer #${c.id}`,
      revenue: r?.revenue ?? 0,
      monthlyCap: mCap,
      monthlySpend: monthSpend,
      monthlyUsedPct: mPct,
      monthlyStatus: classifyStatus(mPct, soft, hard),
      annualCap: aCap,
      annualSpend: yearSpend,
      annualUsedPct: aPct,
      annualStatus: classifyStatus(aPct, soft, hard),
      avgDaysToPay:
        r && r.payDays.n > 0 ? r.payDays.sum / r.payDays.n : null,
      lastInvoiceAt: r?.lastInvoiceAt ? r.lastInvoiceAt.toISOString() : null,
      monthlySpark: sparkKeys.map((m, i) => ({
        month: m,
        revenue: r?.spark[i] ?? 0,
      })),
    });
  }
  return out;
}

/**
 * Rank rows by `revenue` (desc) or `budget_risk`. Budget-risk ordering:
 * customers over 100% (status='over') come first, then 'approaching',
 * then 'healthy', then 'unset', and within each band by `monthlyUsedPct`
 * descending. Customers with no cap have `monthlyUsedPct = null` and
 * sort last.
 */
export function sortTopCustomers(
  rows: TopCustomerRow[],
  sort: "revenue" | "budget_risk",
): TopCustomerRow[] {
  const copy = rows.slice();
  if (sort === "revenue") {
    copy.sort((a, b) => b.revenue - a.revenue);
    return copy;
  }
  const rank: Record<BudgetStatus, number> = {
    over: 0,
    approaching: 1,
    healthy: 2,
    unset: 3,
  };
  copy.sort((a, b) => {
    const r = rank[a.monthlyStatus] - rank[b.monthlyStatus];
    if (r !== 0) return r;
    const ap = a.monthlyUsedPct ?? -1;
    const bp = b.monthlyUsedPct ?? -1;
    if (bp !== ap) return bp - ap;
    return b.revenue - a.revenue;
  });
  return copy;
}

export interface TechnicianRow {
  technicianId: number;
  name: string;
  hoursBilled: number;
  revenue: number;
  laborCost: number | null;
  marginPct: number | null;
  avgTicket: number | null;
  billingSheetCount: number;
  workOrderCount: number;
  partsRevenue: number;
  hasWageSet: boolean;
}

export interface UserWithName extends UserLike {
  name?: string | null;
  role?: string | null;
}

export function computeByTechnician(input: {
  techs: UserWithName[];
  invoices: InvoiceLike[];
  workOrders: WorkOrderLike[];
  billingSheets: BillingSheetLike[];
  // Task #814 — wet check billings linked to invoices in the window,
  // attributed by technicianId. Hours tallied for margin; invoice revenue
  // and partsRevenue come from the invoice (no double-count).
  wetCheckBillings?: WetCheckBillingLike[];
  window: { start: Date; end: Date };
}): TechnicianRow[] {
  const { techs, invoices, workOrders, billingSheets, wetCheckBillings = [], window } = input;
  const invoiceIdsInWindow = new Set<number>();
  const invoiceById = new Map<number, InvoiceLike>();
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    const d = toDate(inv.createdAt);
    if (!inWindow(d, window.start, window.end)) continue;
    invoiceIdsInWindow.add(inv.id);
    invoiceById.set(inv.id, inv);
  }

  interface Acc {
    hours: number;
    invoiceIds: Set<number>;
    woCount: number;
    bsCount: number;
    wcbCount: number;
  }
  const acc = new Map<number, Acc>();
  const ensure = (id: number): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = { hours: 0, invoiceIds: new Set(), woCount: 0, bsCount: 0, wcbCount: 0 };
      acc.set(id, a);
    }
    return a;
  };

  for (const wo of workOrders) {
    if (wo.invoiceId == null || !invoiceIdsInWindow.has(wo.invoiceId)) continue;
    const techId = wo.assignedTechnicianId ?? wo.completedByUserId ?? null;
    if (techId == null) continue;
    const a = ensure(techId);
    a.hours += toNum(wo.totalHours);
    a.invoiceIds.add(wo.invoiceId);
    a.woCount += 1;
  }
  for (const bs of billingSheets) {
    if (bs.invoiceId == null || !invoiceIdsInWindow.has(bs.invoiceId)) continue;
    if (bs.technicianId == null) continue;
    const a = ensure(bs.technicianId);
    a.hours += toNum(bs.totalHours);
    a.invoiceIds.add(bs.invoiceId);
    a.bsCount += 1;
  }
  // Task #814 — wet check billings attributed to technician for hours + invoice.
  for (const wcb of wetCheckBillings) {
    if (wcb.invoiceId == null || !invoiceIdsInWindow.has(wcb.invoiceId)) continue;
    if (wcb.technicianId == null) continue;
    const a = ensure(wcb.technicianId);
    a.hours += toNum(wcb.totalHours);
    a.invoiceIds.add(wcb.invoiceId);
    a.wcbCount += 1;
  }

  const techById = new Map(techs.map((t) => [t.id, t]));
  const out: TechnicianRow[] = [];
  for (const [techId, a] of acc) {
    const tech = techById.get(techId);
    if (!tech) continue;
    let revenue = 0;
    let partsRevenue = 0;
    for (const iid of a.invoiceIds) {
      const inv = invoiceById.get(iid);
      if (!inv) continue;
      revenue += toNum(inv.totalAmount);
      partsRevenue += toNum(inv.partsSubtotal);
    }
    const wage = toNum(tech.hourlyWage, NaN);
    const hasWage = Number.isFinite(wage) && wage > 0;
    const laborCost = hasWage ? a.hours * wage : null;
    const marginPct =
      hasWage && revenue > 0 ? ((revenue - laborCost!) / revenue) * 100 : null;
    out.push({
      technicianId: techId,
      name: tech.name ?? `Tech #${techId}`,
      hoursBilled: a.hours,
      revenue,
      laborCost,
      marginPct,
      avgTicket: a.invoiceIds.size > 0 ? revenue / a.invoiceIds.size : null,
      billingSheetCount: a.bsCount,
      workOrderCount: a.woCount,
      partsRevenue,
      hasWageSet: hasWage,
    });
  }
  out.sort((a, b) => b.revenue - a.revenue);
  return out;
}

export interface ServiceTypeRow {
  key: "emergency" | "standard" | "contract" | "adhoc";
  label: string;
  revenue: number;
  pctOfTotal: number | null;
  invoiceCount: number;
  avgTicket: number | null;
}

/**
 * Four-row service-type breakdown. emergency/standard split is per
 * invoice (an invoice is "emergency" if it has at least one line item
 * priced at the customer's emergencyLaborRate). contract/adhoc split is
 * by `customer.contractType != null && != ''`.
 */
export function computeByServiceType(input: {
  invoices: InvoiceLike[];
  items: InvoiceItemLike[];
  customersById: Map<number, CustomerLike>;
  window: { start: Date; end: Date };
}): ServiceTypeRow[] {
  const { invoices, items, customersById, window } = input;
  const inWin: InvoiceLike[] = [];
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    const d = toDate(inv.createdAt);
    if (!inWindow(d, window.start, window.end)) continue;
    inWin.push(inv);
  }
  const itemsByInvoice = new Map<number, InvoiceItemLike[]>();
  for (const it of items) {
    if (it.invoiceId == null) continue;
    const arr = itemsByInvoice.get(it.invoiceId) ?? [];
    arr.push(it);
    itemsByInvoice.set(it.invoiceId, arr);
  }
  const buckets = {
    emergency: { revenue: 0, count: 0 },
    standard: { revenue: 0, count: 0 },
    contract: { revenue: 0, count: 0 },
    adhoc: { revenue: 0, count: 0 },
  };
  for (const inv of inWin) {
    const total = toNum(inv.totalAmount);
    const c = customersById.get(inv.customerId);
    const emergencyRate =
      c?.emergencyLaborRate == null || c?.emergencyLaborRate === ""
        ? null
        : toNum(c.emergencyLaborRate);
    const lines = itemsByInvoice.get(inv.id) ?? [];
    let isEmergency = false;
    if (emergencyRate != null) {
      for (const it of lines) {
        const rate = it.laborRate == null ? null : toNum(it.laborRate);
        if (rate != null && Math.abs(rate - emergencyRate) < 0.005) {
          isEmergency = true;
          break;
        }
      }
    }
    if (isEmergency) {
      buckets.emergency.revenue += total;
      buckets.emergency.count += 1;
    } else {
      buckets.standard.revenue += total;
      buckets.standard.count += 1;
    }
    const ctype = c?.contractType;
    if (ctype != null && ctype !== "") {
      buckets.contract.revenue += total;
      buckets.contract.count += 1;
    } else {
      buckets.adhoc.revenue += total;
      buckets.adhoc.count += 1;
    }
  }
  const total = inWin.reduce((s, inv) => s + toNum(inv.totalAmount), 0);
  const mk = (
    key: ServiceTypeRow["key"],
    label: string,
    b: { revenue: number; count: number },
  ): ServiceTypeRow => ({
    key,
    label,
    revenue: b.revenue,
    pctOfTotal: total > 0 ? (b.revenue / total) * 100 : null,
    invoiceCount: b.count,
    avgTicket: b.count > 0 ? b.revenue / b.count : null,
  });
  return [
    mk("emergency", "Emergency", buckets.emergency),
    mk("standard", "Standard", buckets.standard),
    mk("contract", "Contract", buckets.contract),
    mk("adhoc", "Ad-hoc", buckets.adhoc),
  ];
}

export function computeRevenueMix(input: {
  invoices: InvoiceLike[];
  items: InvoiceItemLike[];
  customersById: Map<number, CustomerLike>;
  window: { start: Date; end: Date };
  // Task #814 — uninvoiced wet check billings add their parts/labor
  // directly to the mix since they're not yet captured in any invoice.
  uninvoicedWetCheckBillings?: WetCheckBillingLike[];
  // Task #814 — WCBs linked to invoices in the window contribute
  // parts/labor costs that may not be reflected in invoice subtotals.
  invoicedWetCheckBillings?: WetCheckBillingLike[];
}): RevenueMixResult {
  const {
    invoices, items, customersById, window,
    uninvoicedWetCheckBillings = [],
    invoicedWetCheckBillings = [],
  } = input;
  const invoiceIdsInWindow = new Set<number>();
  let parts = 0;
  let labor = 0;
  let contract = 0;
  let adhoc = 0;
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue;
    const d = toDate(inv.createdAt);
    if (!inWindow(d, window.start, window.end)) continue;
    invoiceIdsInWindow.add(inv.id);
    parts += toNum(inv.partsSubtotal);
    labor += toNum(inv.laborSubtotal);
    const c = customersById.get(inv.customerId);
    const total = toNum(inv.totalAmount);
    if (c?.contractType != null && c.contractType !== "") {
      contract += total;
    } else {
      adhoc += total;
    }
  }
  // Task #814 — uninvoiced WCBs contribute parts/labor to the mix.
  for (const wcb of uninvoicedWetCheckBillings) {
    parts += toNum(wcb.partsSubtotal);
    labor += toNum(wcb.laborSubtotal);
  }
  // Task #814 — invoiced WCBs linked to invoices in the window contribute
  // their parts/labor subtotals (contract/adhoc split stays at invoice level).
  for (const wcb of invoicedWetCheckBillings) {
    parts += toNum(wcb.partsSubtotal);
    labor += toNum(wcb.laborSubtotal);
  }

  // Emergency vs standard — bucket per invoice item, comparing each
  // item's laborRate to the parent customer's emergencyLaborRate. If
  // a single invoice spans both, both buckets collect their slice.
  let emergency = 0;
  let standard = 0;
  // Quick lookup invoice -> customer.emergencyLaborRate
  const emergencyRateByInvoice = new Map<number, number | null>();
  const customerByInvoice = new Map<number, CustomerLike | undefined>();
  for (const inv of invoices) {
    if (!invoiceIdsInWindow.has(inv.id)) continue;
    const c = customersById.get(inv.customerId);
    customerByInvoice.set(inv.id, c);
    const rate = c?.emergencyLaborRate;
    emergencyRateByInvoice.set(
      inv.id,
      rate == null || rate === "" ? null : toNum(rate),
    );
  }
  for (const it of items) {
    if (it.invoiceId == null || !invoiceIdsInWindow.has(it.invoiceId)) continue;
    const lineLabor = toNum(it.laborTotal);
    const lineParts = toNum(it.totalPrice);
    const lineRev = lineLabor + lineParts;
    if (lineRev <= 0) continue;
    const emergencyRate = emergencyRateByInvoice.get(it.invoiceId);
    const itemRate = it.laborRate == null ? null : toNum(it.laborRate);
    const isEmergency =
      emergencyRate != null &&
      itemRate != null &&
      Math.abs(itemRate - emergencyRate) < 0.005;
    if (isEmergency) emergency += lineRev;
    else standard += lineRev;
  }

  return {
    partsVsLabor: { parts, labor },
    emergencyVsStandard: { emergency, standard },
    contractVsAdhoc: { contract, adhoc },
  };
}

// ─── Slice 5.3: Pulse-tab helpers (Task #731) ─────────────────────────────
// isUnbilledWorkRow is defined in Task #730 above (line ~314) — shared with
// computeUnbilledExposure. These interfaces extend it for per-customer/tech
// attribution in the pulse-summary endpoint.

/**
 * Extended WO shape used by the pulse-summary endpoint to enable
 * per-customer and per-tech attribution without extra round-trips.
 */
export interface PulseWorkOrderLike extends WorkOrderBillableLike {
  customerId: number;
  assignedTechnicianId?: number | null;
}

/**
 * Extended BS shape used by the pulse-summary endpoint.
 */
export interface PulseBillingSheetLike extends BillingSheetBillableLike {
  customerId: number;
  technicianId?: number | null;
}

/**
 * Task #814 — Extended WCB shape used by the pulse-summary endpoint.
 * Uses workDate for bucketing (logical work date).
 */
export interface PulseWetCheckBillingLike extends WetCheckBillingBillableLike {
  customerId: number;
  technicianId?: number | null;
}

export interface PulseCustomerRow {
  customerId: number;
  name: string;
  inFlight: number;
  ytd: number;
  budgetStatus: BudgetStatus;
  monthlyCap: number | null;
  monthlySpend: number;
}

export interface PulseTechRow {
  technicianId: number;
  name: string;
  inFlight: number;
  ytd: number;
}

/**
 * Compute per-customer in-flight + YTD rows for the Pulse tab.
 * Customers flagged hiddenFromBilling are excluded.
 *
 * - inFlight: sum of uninvoiced non-cancelled WOs + BSs for this customer
 * - ytd:      sum of invoices in the current calendar year (by invoiceYear)
 * - budgetStatus: classified from monthly spend / cap (same logic as budget-usage)
 */
export function computePulseCustomers(input: {
  customers: CustomerWithBudget[];
  invoices: InvoiceLike[];
  workOrders: PulseWorkOrderLike[];
  billingSheets: PulseBillingSheetLike[];
  // Task #814 — uninvoiced WCBs contribute to inFlight per customer.
  wetCheckBillings?: PulseWetCheckBillingLike[];
  currentYear: number;
  now: Date;
}): PulseCustomerRow[] {
  const { customers: custs, invoices, workOrders, billingSheets, wetCheckBillings = [], currentYear, now } = input;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const ytdByCust = new Map<number, number>();
  const monthlySpendByCust = new Map<number, number>();

  for (const inv of invoices) {
    if (inv.status === "draft" || inv.status === "cancelled" || inv.status === "superseded") continue;
    const amt = toNum(inv.totalAmount);
    if ((inv.invoiceYear ?? 0) === currentYear) {
      ytdByCust.set(inv.customerId, (ytdByCust.get(inv.customerId) ?? 0) + amt);
    }
    const d = inv.createdAt instanceof Date ? inv.createdAt : new Date(inv.createdAt as string);
    if (!Number.isNaN(d.getTime()) && d >= monthStart) {
      monthlySpendByCust.set(inv.customerId, (monthlySpendByCust.get(inv.customerId) ?? 0) + amt);
    }
  }

  const inFlightByCust = new Map<number, number>();
  for (const wo of workOrders) {
    if (!isUnbilledWorkRow(wo)) continue;
    inFlightByCust.set(wo.customerId, (inFlightByCust.get(wo.customerId) ?? 0) + toNum(wo.totalAmount));
  }
  for (const bs of billingSheets) {
    if (!isUnbilledWorkRow(bs)) continue;
    inFlightByCust.set(bs.customerId, (inFlightByCust.get(bs.customerId) ?? 0) + toNum(bs.totalAmount));
  }
  // Task #814 — uninvoiced WCBs (no cancelled status, so only invoiceId check).
  for (const wcb of wetCheckBillings) {
    if (wcb.invoiceId != null) continue;
    inFlightByCust.set(wcb.customerId, (inFlightByCust.get(wcb.customerId) ?? 0) + toNum(wcb.totalAmount));
  }

  const out: PulseCustomerRow[] = [];
  for (const c of custs) {
    if (c.hiddenFromBilling) continue;
    const rawCap = c.monthlyBudgetCap;
    const capN = rawCap == null || rawCap === "" ? null : toNum(rawCap) || null;
    const monthlySpend = monthlySpendByCust.get(c.id) ?? 0;
    const mPct = capN != null && capN > 0 ? monthlySpend / capN : null;
    const soft = c.budgetSoftThresholdPercent ?? 75;
    const hard = c.budgetHardThresholdPercent ?? 100;
    out.push({
      customerId: c.id,
      name: c.name ?? `Customer #${c.id}`,
      inFlight: inFlightByCust.get(c.id) ?? 0,
      ytd: ytdByCust.get(c.id) ?? 0,
      budgetStatus: classifyStatus(mPct, soft, hard),
      monthlyCap: capN,
      monthlySpend,
    });
  }
  return out;
}

/**
 * Compute per-technician in-flight + YTD rows for the Pulse tab.
 *
 * - inFlight: sum of uninvoiced non-cancelled WOs (via assignedTechnicianId)
 *             + BSs (via technicianId)
 * - ytd:      revenue from invoices this year whose linked WOs/BSs attribute
 *             to this tech. Each invoice counted at most once per tech to
 *             avoid double-counting when a WO and BS both link to the same
 *             invoice for the same technician.
 */
export function computePulseTechnicians(input: {
  techs: UserWithName[];
  invoices: InvoiceLike[];
  workOrders: PulseWorkOrderLike[];
  billingSheets: PulseBillingSheetLike[];
  // Task #814 — WCBs: invoiced ones credit the invoice amount to technician;
  // uninvoiced ones contribute directly to inFlight.
  wetCheckBillings?: PulseWetCheckBillingLike[];
  currentYear: number;
}): PulseTechRow[] {
  const { techs, invoices, workOrders, billingSheets, wetCheckBillings = [], currentYear } = input;

  const ytdInvoiceAmount = new Map<number, number>();
  for (const inv of invoices) {
    if (inv.status === "draft" || inv.status === "cancelled" || inv.status === "superseded") continue;
    if ((inv.invoiceYear ?? 0) !== currentYear) continue;
    ytdInvoiceAmount.set(inv.id, toNum(inv.totalAmount));
  }

  const ytdByTech = new Map<number, number>();
  const seenByTech = new Map<number, Set<number>>();

  const creditInvoice = (techId: number, invoiceId: number | null | undefined) => {
    if (invoiceId == null) return;
    const amount = ytdInvoiceAmount.get(invoiceId);
    if (amount == null) return;
    let seen = seenByTech.get(techId);
    if (!seen) { seen = new Set(); seenByTech.set(techId, seen); }
    if (seen.has(invoiceId)) return;
    seen.add(invoiceId);
    ytdByTech.set(techId, (ytdByTech.get(techId) ?? 0) + amount);
  };

  for (const wo of workOrders) {
    if (wo.assignedTechnicianId == null) continue;
    creditInvoice(wo.assignedTechnicianId, wo.invoiceId);
  }
  for (const bs of billingSheets) {
    if (bs.technicianId == null) continue;
    creditInvoice(bs.technicianId, bs.invoiceId);
  }
  // Task #814 — invoiced WCBs credit the invoice to the technician.
  for (const wcb of wetCheckBillings) {
    if (wcb.technicianId == null) continue;
    creditInvoice(wcb.technicianId, wcb.invoiceId);
  }

  const inFlightByTech = new Map<number, number>();
  for (const wo of workOrders) {
    if (!isUnbilledWorkRow(wo) || wo.assignedTechnicianId == null) continue;
    inFlightByTech.set(
      wo.assignedTechnicianId,
      (inFlightByTech.get(wo.assignedTechnicianId) ?? 0) + toNum(wo.totalAmount),
    );
  }
  for (const bs of billingSheets) {
    if (!isUnbilledWorkRow(bs) || bs.technicianId == null) continue;
    inFlightByTech.set(
      bs.technicianId,
      (inFlightByTech.get(bs.technicianId) ?? 0) + toNum(bs.totalAmount),
    );
  }
  // Task #814 — uninvoiced WCBs contribute to technician in-flight.
  for (const wcb of wetCheckBillings) {
    if (wcb.invoiceId != null || wcb.technicianId == null) continue;
    inFlightByTech.set(
      wcb.technicianId,
      (inFlightByTech.get(wcb.technicianId) ?? 0) + toNum(wcb.totalAmount),
    );
  }

  const techById = new Map(techs.map((t) => [t.id, t]));
  const allIds = new Set([...ytdByTech.keys(), ...inFlightByTech.keys()]);
  const out: PulseTechRow[] = [];
  for (const id of allIds) {
    const t = techById.get(id);
    if (!t) continue;
    out.push({
      technicianId: id,
      name: t.name ?? `Tech #${id}`,
      inFlight: inFlightByTech.get(id) ?? 0,
      ytd: ytdByTech.get(id) ?? 0,
    });
  }
  out.sort((a, b) => b.inFlight - a.inFlight);
  return out;
}
