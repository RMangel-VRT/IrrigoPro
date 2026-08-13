import { Fragment, useState, useMemo, useEffect, useRef } from "react";
import { useInfiniteQuery, useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import {
  hasCapability,
  usesUiDefault,
  CAN_EDIT_INVOICES,
  CAN_MANAGE_QUICKBOOKS,
  CAN_READ_AR_NOTES,
  CAN_SEND_INVOICE_EMAIL,
  CAN_VIEW_REMINDER_HISTORY,
  CAN_VIEW_COSTS,
  COLLECTIONS_LANDING_DEFAULT,
  AGING_BUCKET_LABELS,
  AR_FLAG_LABELS,
  AR_FLAG_TOOLTIPS,
  classifyAgingBucket,
  computeArFlags,
  daysOverdue as daysOverdueOf,
  isBalanceFallback,
  resolveBalanceDue,
  type AgingBucketKey,
  type ArFlag,
} from "@workspace/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Calendar,
  FileText,
  CheckCircle2,
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronDown,
  ClipboardList,
  Download,
  GitMerge,
  X,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  MoreHorizontal,
  Edit3,
  RotateCcw,
  Trash2,
  CheckSquare,
  Send,
  MessageSquare,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { InvoicePdfPreviewModal } from "@/components/billing/invoice-pdf-preview-modal";
import { InvoiceAuditModal } from "@/components/billing/invoice-audit-modal";
// Task #1918 — the expanded row and the one line-item view it shares with the
// draft editor below.
import { InvoiceRowExpansion } from "@/components/billing/invoice-row-expansion";
import {
  InvoiceLineItemsList,
  ticketIdOf,
  type InvoiceLineItem,
} from "@/components/billing/invoice-line-items";
import { BatchReminderDialog } from "@/components/billing/batch-reminder-dialog";
import { FinancialPulseWidget } from "@/components/financial-pulse/financial-pulse-widget";
// Task #1942 — the AR-first layout. Each of these owns one band of the page:
// the header's totals, the aging strip, the collapsed filter bar, and the one
// named action on a row.
import { InvoicePageHeader } from "@/components/billing/invoice-page-header";
import {
  InvoiceAgingStrip,
  agingTotalsForView,
  type AgingSummary,
} from "@/components/billing/invoice-aging-strip";
import { InvoiceFilterBar } from "@/components/billing/invoice-filter-bar";
import {
  InvoicePrimaryAction,
  type ReminderEligibility,
  type ReminderEligibilityResponse,
} from "@/components/billing/invoice-primary-action";
import { formatCurrency } from "@/lib/format-currency";
// Task #1942 — the A/R query model moved out of this file so the filter bar,
// the strip and the header can share it without importing the page.
import {
  AR_SORT_LABELS,
  BUCKET_TO_AGING_VALUE,
  COLLECTIONS_DEFAULT_QUERY,
  EMPTY_AR_QUERY,
  agingSummaryParams,
  arQueryToParams,
  isEmptyArQuery,
  readArQuery,
  type AgingFilter,
  type ArQuery,
  type ArSortKey,
} from "@/lib/invoice-ar-query";
import { exportSingleInvoiceCsv } from "@/lib/invoice-csv";
import { safeGet } from "@/utils/safeStorage";

import { InvoiceCorrectionFlow } from "@/pages/invoices/InvoiceCorrectionFlow";

function parseApiErrorCode(err: Error): string | null {
  try {
    const colon = err.message.indexOf(': ');
    if (colon < 0) return null;
    const body = JSON.parse(err.message.slice(colon + 2));
    return typeof body?.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

function getCurrentUserRole(): string | null {
  try {
    const raw = safeGet("user");
    if (!raw) return null;
    const u = JSON.parse(raw);
    return typeof u?.role === "string" ? u.role : null;
  } catch {
    return null;
  }
}

/**
 * Task #1942 — the company the aging aggregate should be summed over.
 *
 * Sent whenever the session carries one, for every role. The server scopes
 * ordinary callers from their own session and ignores the parameter; only
 * `super_admin`, who has no implicit company, actually needs it (the endpoint
 * returns 400 rather than summing across every company). Deciding that here
 * would mean a role comparison in this page, and the page holds none: the
 * scoping rule is the server's to enforce, not the client's to predict.
 */
function getCurrentUserCompanyId(): number | null {
  try {
    const raw = safeGet("user");
    if (!raw) return null;
    const u = JSON.parse(raw);
    return typeof u?.companyId === "number" ? u.companyId : null;
  } catch {
    return null;
  }
}

interface Invoice {
  id: number;
  invoiceNumber: string;
  revision?: number;
  customerId: number;
  customerName: string;
  customerEmail: string;
  totalAmount: string;
  partsSubtotal?: string;
  laborSubtotal?: string;
  periodStart: string;
  periodEnd: string;
  invoiceMonth: number;
  invoiceYear: number;
  status: string;
  createdAt: string;
  sentAt?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  quickbooksInvoiceId?: string;
  supersededByInvoiceId?: number | null;
  mergedIntoInvoiceId?: number | null;
  // Task #1831 — QBO payment-status sync fields
  paymentStatus?: string | null;
  balance?: string | null;
  paymentSyncedAt?: string | null;
  isOverdue?: boolean;
  // Task #1833 — pre-computed effective due date from the API (accounts for
  // customer payment terms: net_30 / net_15 / due_on_receipt). Use this
  // instead of re-deriving due date client-side so aging buckets match the
  // server-side computeArAging logic exactly.
  effectiveDueDate?: string | null;
  // Task #1848 — QBO void detection. Set when the sync loop detects the
  // invoice was voided in QuickBooks. Null means no void detected.
  qbVoidDetectedAt?: string | null;
  // Task #1890 — A/R annotation. The server computes all of these across the
  // whole invoice set before paginating, so they are correct for sorting and
  // filtering rather than only for the rows already on screen. Every field is
  // optional so a cached payload from before this change still renders; the
  // fallbacks below re-derive each one from the same shared helpers.
  paidAt?: string | null;
  qbNote?: string | null;
  daysOverdue?: number;
  agingBucket?: AgingBucketKey;
  balanceDue?: string;
  balanceIsFallback?: boolean;
  arFlags?: ArFlag[];
  // Task #1887 — payment reminders. Delivered reminders only: a failed send is
  // recorded but is not a reminder the customer received, so it never appears
  // in either of these. Optional for the same cached-payload reason as above.
  lastReminderAt?: string | null;
  reminderCount?: number;
  // Task #1889 — internal A/R notes, rolled up server-side in one query so the
  // indicator does not cost a request per row.
  //
  // ABSENT, not zero, for a role without CAN_READ_AR_NOTES: the server strips
  // these three keys from the payload entirely, because a count of 3 on a row
  // is itself the disclosure that a dispute is in flight. Do not "fix" a
  // missing badge by defaulting the count somewhere upstream — if the key is
  // gone, the reader was not meant to know.
  arNoteCount?: number;
  lastArNoteAt?: string | null;
  lastArNotePreview?: string | null;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function generateMonthOptions() {
  const months = [];
  const currentDate = new Date();
  for (let i = 0; i < 24; i++) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const label = `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
    months.push({ value, label });
  }
  return months;
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function toIsoDate(value: string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function csvEscape(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Neutralize CSV/spreadsheet formula injection: prefix risky leading chars
  // so Excel/Sheets/Numbers do not evaluate them as formulas.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildInvoicesCsv(invoices: Invoice[]) {
  const headers = [
    "Billing Period",
    "Invoice Number",
    "Customer",
    "Status",
    "QuickBooks Sync Status",
    "Subtotal",
    "Tax",
    "Total",
    "Issued Date",
    "Due Date",
  ];
  const rows = invoices.map((inv) => {
    const period = `${inv.invoiceYear}-${String(inv.invoiceMonth).padStart(2, "0")}`;
    const total = parseFloat(inv.totalAmount) || 0;
    const parts = parseFloat(inv.partsSubtotal ?? "0") || 0;
    const labor = parseFloat(inv.laborSubtotal ?? "0") || 0;
    const subtotal = parts + labor;
    const tax = Math.max(0, +(total - subtotal).toFixed(2));
    const issued = toIsoDate(inv.sentAt ?? inv.createdAt);
    const due = toIsoDate(inv.dueDate);
    const qbStatus = inv.quickbooksInvoiceId ? "Synced" : "Not synced";
    return [
      period,
      inv.invoiceNumber,
      inv.customerName,
      inv.status,
      qbStatus,
      subtotal.toFixed(2),
      tax.toFixed(2),
      total.toFixed(2),
      issued,
      due,
    ].map(csvEscape).join(",");
  });
  return [headers.join(","), ...rows].join("\r\n") + "\r\n";
}

// Task #1847 — sentAt is now the single source of delivery truth. The
// lifecycle badge no longer has a "sent" case; a separate Sent badge is
// rendered at each site when sentAt != null. This allows "Paid · Sent"
// to appear simultaneously as independent badges.
function getSentBadge(sentAt: string | null | undefined) {
  if (!sentAt) return null;
  return <Badge className="bg-green-100 text-green-800">Sent</Badge>;
}

function getStatusBadge(status: string) {
  switch (status.toLowerCase()) {
    case "draft":
      return <Badge className="bg-yellow-100 text-yellow-800 border border-yellow-300">Draft</Badge>;
    case "generated":
      return <Badge className="bg-blue-100 text-blue-800">Generated</Badge>;
    case "paid":
      return <Badge className="bg-emerald-100 text-emerald-800">Paid</Badge>;
    case "overdue":
      return <Badge className="bg-red-100 text-red-800">Overdue</Badge>;
    case "superseded":
      return <Badge className="bg-amber-100 text-amber-700">Superseded</Badge>;
    case "merged":
      return <Badge className="bg-purple-100 text-purple-700">Merged in</Badge>;
    case "cancelled":
      return <Badge className="bg-gray-100 text-gray-500">Cancelled</Badge>;
    default:
      // Task #1942 — never print the raw column value.
      //
      // The old default rendered `status` verbatim, which is how a database
      // string ("sent") ended up on screen beside the Sent badge that replaced
      // it, reading as two different facts about the same invoice. A status
      // this badge does not know about is a data problem, and it says so
      // rather than dressing the raw string up as a label.
      return (
        <Badge
          className="border border-amber-300 bg-amber-50 text-amber-800"
          title={`This invoice carries a status this screen does not recognise. Report it — the raw value is "${status}".`}
          data-testid="status-badge-unknown"
        >
          Unknown status
        </Badge>
      );
  }
}

function groupByBillingPeriod(invoices: Invoice[]) {
  const groups: Record<string, Invoice[]> = {};
  for (const invoice of invoices) {
    const key = `${invoice.invoiceYear}-${String(invoice.invoiceMonth).padStart(2, "0")}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(invoice);
  }
  const sorted = Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  return sorted.map(([key, items]) => {
    const [year, month] = key.split("-");
    return {
      key,
      label: `${MONTH_NAMES[parseInt(month) - 1]} ${year}`,
      invoices: items,
    };
  });
}

type SortKey = "customer" | "invoiceNumber" | "status" | "quickbooks" | "amount" | "period";
type SortDir = "asc" | "desc";
interface SortState {
  key: SortKey;
  dir: SortDir;
}

function compareInvoices(a: Invoice, b: Invoice, key: SortKey): number {
  switch (key) {
    case "customer":
      return a.customerName.localeCompare(b.customerName, undefined, { sensitivity: "base" });
    case "invoiceNumber":
      return a.invoiceNumber.localeCompare(b.invoiceNumber, undefined, { numeric: true, sensitivity: "base" });
    case "status":
      return a.status.localeCompare(b.status, undefined, { sensitivity: "base" });
    case "quickbooks":
      return Number(!!a.quickbooksInvoiceId) - Number(!!b.quickbooksInvoiceId);
    case "amount":
      return (parseFloat(a.totalAmount) || 0) - (parseFloat(b.totalAmount) || 0);
    case "period":
      return new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime();
  }
}

function sortInvoices(invoices: Invoice[], sort: SortState | null): Invoice[] {
  if (!sort) return invoices;
  const sorted = [...invoices].sort((a, b) => {
    const cmp = compareInvoices(a, b, sort.key);
    return sort.dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

function SortableHeader({
  sortKey,
  label,
  sort,
  onSort,
  align = "left",
}: {
  sortKey: SortKey;
  label: string;
  sort: SortState | null;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort?.key === sortKey;
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 whitespace-nowrap font-medium hover:text-gray-900 ${
          active ? "text-gray-900" : "text-muted-foreground"
        } ${align === "right" ? "flex-row-reverse" : ""}`}
        data-testid={`sort-${sortKey}`}
        aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        {active ? (
          sort?.dir === "asc" ? (
            <ArrowUp className="w-3.5 h-3.5" />
          ) : (
            <ArrowDown className="w-3.5 h-3.5" />
          )
        ) : (
          <ChevronsUpDown className="w-3.5 h-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

// Same exclusion set as `computeOutstandingAr` — paid / draft /
// cancelled / superseded invoices are not part of A/R aging.
function isOpenAr(inv: Invoice): boolean {
  if (inv.status === "draft" || inv.status === "cancelled" || inv.status === "paid" || inv.status === "superseded") {
    return false;
  }
  // The server's `computeOutstandingAr` also excludes any invoice
  // with a non-null paidAt. We mirror that here.
  return !inv.sentAt || true; // keep all non-terminal statuses; paidAt check below
}

// Task #1833 — buckets are now based on days past effective due date.
// The server pre-computes `effectiveDueDate` (dueDate if set, else
// createdAt + customer payment terms) so client-side bucketing aligns
// exactly with the backend computeArAging logic for all payment term
// variations (net_30 / net_15 / due_on_receipt).
function daysPastDue(inv: Invoice, now: Date): number {
  // Prefer the days-overdue figure the API already computed (Task #1890) —
  // then the number on this row and the number Financial Pulse reports for the
  // same invoice cannot disagree. Fall back through the pre-computed effective
  // due date (Task #1833), then explicit dueDate, then a net_30 approximation
  // so this stays safe on cached payloads that pre-date those fields.
  if (typeof inv.daysOverdue === "number") return inv.daysOverdue;
  const due = inv.effectiveDueDate
    ? new Date(inv.effectiveDueDate)
    : inv.dueDate
      ? new Date(inv.dueDate)
      : new Date(new Date(inv.createdAt).getTime() + 30 * 86_400_000);
  return daysOverdueOf(due, now);
}

/** The bucket an invoice sits in — the server's answer when it sent one. */
function agingBucketOf(inv: Invoice, now: Date): AgingBucketKey {
  return inv.agingBucket ?? classifyAgingBucket(daysPastDue(inv, now));
}

function matchesAging(inv: Invoice, filter: AgingFilter, now: Date): boolean {
  if (filter === "all") return true;
  if (!isOpenAr(inv)) return false;
  if (inv.paidAt) return false;
  // Skip fully-paid records even if status hasn't caught up.
  if (inv.paymentStatus === "paid") return false;
  // Task #1890 — the boundary rule lives in classifyAgingBucket now. This used
  // to be a hand-written comparison chain whose comments ("1–30", "31–60",
  // "61–90+") had drifted a full day away from the boundaries beside them.
  const bucket = agingBucketOf(inv, now);
  if (filter === "overdue") return bucket !== "current";
  return BUCKET_TO_AGING_VALUE[bucket] === filter;
}

// ─── A/R flags and balance (Task #1890) ─────────────────────────────────────

/** The flags the server annotated, or the same rules applied locally. */
function arFlagsOf(inv: Invoice, now: Date): ArFlag[] {
  if (inv.arFlags) return inv.arFlags;
  const overdue = inv.isOverdue ?? daysPastDue(inv, now) >= 0;
  // The reminder count rides along so the local fallback can raise
  // "Reminded, still unpaid" on the same terms the server does.
  return computeArFlags({ ...inv, reminderCount: inv.reminderCount ?? 0 }, now, overdue);
}

/** Outstanding balance, falling back to the invoice total when unsynced. */
function balanceDueOf(inv: Invoice): number {
  if (inv.balanceDue != null) return parseFloat(inv.balanceDue) || 0;
  return resolveBalanceDue(inv);
}

function balanceIsFallbackOf(inv: Invoice): boolean {
  return inv.balanceIsFallback ?? isBalanceFallback(inv);
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partially paid",
  paid: "Paid",
};

/**
 * Every flag as a text badge with a plain-language tooltip.
 *
 * Text, not colour alone — a bookkeeper reading this list in greyscale, or
 * with a colour-vision deficiency, has to get the same information.
 */
function ArFlagBadges({
  invoice,
  now,
  variant = "",
}: {
  invoice: Invoice;
  now: Date;
  /** Suffix for the test ids, so the desktop row and the mobile card — which
   *  render the same badges — stay individually addressable. */
  variant?: "" | "mobile-";
}) {
  const flags = arFlagsOf(invoice, now);
  if (flags.length === 0) {
    return (
      <span className="text-xs text-gray-300" data-testid={`ar-flags-none-${variant}${invoice.id}`}>
        —
      </span>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid={`ar-flags-${variant}${invoice.id}`}
    >
      {flags.map((flag) => (
        <Badge
          key={flag}
          variant="outline"
          className="text-[11px] font-medium cursor-help border-gray-300 bg-gray-50 text-gray-700"
          title={AR_FLAG_TOOLTIPS[flag]}
          data-testid={`ar-flag-${variant}${flag}-${invoice.id}`}
        >
          {AR_FLAG_LABELS[flag]}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Task #1889 — "there is already a conversation about this one".
 *
 * A bookkeeper scanning the A/R list needs to know which invoices someone is
 * already chasing before they pick up the phone and repeat the last person's
 * call. The count and the preview arrive with the row (one rollup query for
 * the whole set, not one request per row), so hovering costs nothing.
 *
 * Renders NOTHING when `arNoteCount` is undefined. That is not the "no notes"
 * case — it is the "you are not allowed to know" case: the server strips these
 * keys for a role without CAN_READ_AR_NOTES, so an irrigation manager reading
 * this list never learns from a badge that a payment dispute exists. `0` is
 * the genuine no-notes case and also renders nothing, quietly.
 */
function ArNoteIndicator({
  invoice,
  variant = "",
}: {
  invoice: Invoice;
  variant?: "" | "mobile-";
}) {
  const count = invoice.arNoteCount;
  if (count === undefined || count === null || count <= 0) return null;
  const when = invoice.lastArNoteAt ? formatDate(invoice.lastArNoteAt) : null;
  const preview = invoice.lastArNotePreview?.trim();
  const title = [
    `${count} internal follow-up note${count === 1 ? "" : "s"}${when ? ` · latest ${when}` : ""}`,
    preview ? `“${preview}”` : null,
    "Internal only — never shown to the customer. Open the invoice to read the full thread.",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[11px] font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded px-1 py-0.5 cursor-help"
      title={title}
      aria-label={`${count} internal follow-up note${count === 1 ? "" : "s"}`}
      data-testid={`ar-note-indicator-${variant}${invoice.id}`}
    >
      <MessageSquare className="w-3 h-3" />
      {count}
    </span>
  );
}
/**
 * A column header that drives the SERVER-side sort via the URL, as opposed to
 * `SortableHeader`, which sorts the loaded rows inside their month group.
 * Only one of the two can be active at a time; each clears the other.
 */
function ArSortableHeader({
  sortKey,
  align = "left",
  sort,
  dir,
  onSort,
}: {
  sortKey: ArSortKey;
  align?: "left" | "right";
  sort: ArSortKey | null;
  dir: SortDir;
  onSort: (key: ArSortKey) => void;
}) {
  const active = sort === sortKey;
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 whitespace-nowrap font-medium hover:text-gray-900 ${
          active ? "text-gray-900" : "text-muted-foreground"
        } ${align === "right" ? "flex-row-reverse" : ""}`}
        data-testid={`ar-sort-${sortKey}`}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      >
        {AR_SORT_LABELS[sortKey]}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="w-3.5 h-3.5" />
          ) : (
            <ArrowDown className="w-3.5 h-3.5" />
          )
        ) : (
          <ChevronsUpDown className="w-3.5 h-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

export default function InvoicesPage() {
  const { toast } = useToast();
  // Task #708 — deep-linked A/R aging filter, driven by `?aging=` in
  // the URL when arriving from the FP A/R Aging widget. The
  // `useSearch()` hook from wouter is reactive to query-string
  // changes (including `setLocation('/invoices?aging=…')` from the
  // FP widget on the same mounted page), so an in-page bucket click
  // re-applies the filter immediately. We still keep local state so
  // the `<Select>` control can override the URL without triggering a
  // navigation. The effect below resyncs state whenever the URL
  // changes underneath us.
  const search = useSearch();
  const [, setLocation] = useLocation();
  // Task #1890 — the URL is the single source of truth for every A/R filter
  // and for the A/R sort. State derived from it (rather than mirrored into
  // useState) is what makes a view survive a reload and share as a link.
  const arQuery = useMemo(() => readArQuery(search ?? ""), [search]);
  const agingFilter = arQuery.aging;
  const setArQuery = (next: ArQuery) => {
    const qs = arQueryToParams(next).toString();
    setLocation(qs ? `/invoices?${qs}` : "/invoices");
  };
  // Patches merge against the URL as it is when the patch runs, not as it was
  // when the callback was created. The debounced search below writes up to
  // 250 ms after the keystroke, and in that window the reader may have picked
  // an aging card or a month; a render-time closure would carry the older
  // query and quietly drop that filter, leaving the rows, the aggregate and
  // select-all describing a set nobody asked for.
  const arQueryRef = useRef(arQuery);
  arQueryRef.current = arQuery;
  const patchArQuery = (patch: Partial<ArQuery>) =>
    setArQuery({ ...arQueryRef.current, ...patch });

  // Task #1942 — the search box echoes locally so typing stays responsive,
  // but the value that filters anything lives in the URL and is applied by
  // the server. See the note on `ArQuery.search`: a browser-only narrowing
  // makes the header total, the aging strip and a multi-page select-all each
  // describe a wider set than the table shows. The debounce below only
  // decides how often we ask the server, never which rows a user is looking
  // at when they act on a selection.
  const [searchInput, setSearchInput] = useState(() => arQuery.search);
  const pushedSearchRef = useRef(arQuery.search);
  useEffect(() => {
    // A change we did not make — a chip removal, a deep link, Clear all.
    if (arQuery.search === pushedSearchRef.current) return;
    pushedSearchRef.current = arQuery.search;
    setSearchInput(arQuery.search);
  }, [arQuery.search]);
  useEffect(() => {
    const next = searchInput.trim();
    if (next === arQuery.search) return;
    const t = setTimeout(() => {
      pushedSearchRef.current = next;
      patchArQuery({ search: next });
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput, arQuery.search]);

  const [sort, setSort] = useState<SortState | null>(null);
  const [cancelledExpanded, setCancelledExpanded] = useState(false);
  // The legacy within-month sort and the A/R global sort are mutually
  // exclusive: two active orderings would be ambiguous, so each clears the
  // other rather than silently layering.
  const toggleSort = (key: SortKey) => {
    if (arQuery.sort) patchArQuery({ sort: null });
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };
  const toggleArSort = (key: ArSortKey) => {
    setSort(null);
    if (arQuery.sort !== key) {
      // Descending first: the biggest balance and the oldest bucket are what a
      // bookkeeper wants at the top, not the smallest and newest.
      patchArQuery({ sort: key, dir: "desc" });
    } else if (arQuery.dir === "desc") {
      patchArQuery({ sort: key, dir: "asc" });
    } else {
      patchArQuery({ sort: null });
    }
  };
  const arSortActive = arQuery.sort != null;
  const [pdfModal, setPdfModal] = useState<{ id: number; number: string; email: string } | null>(null);
  const [auditInvoice, setAuditInvoice] = useState<{ id: number; label: string; total: string } | null>(null);
  const [exportingInvoiceId, setExportingInvoiceId] = useState<number | null>(null);
  const userRole = getCurrentUserRole();
  // Task #1942 — the last role-string comparison on this page is gone. The
  // single-invoice CSV carries the invoice's cost and margin breakdown and is
  // built from `/api/invoices/:id/audit`, so it is gated on the capability
  // that already governs cost visibility rather than on a hand-written role
  // list that no server guard corresponds to.
  const canExportSingleCsv = hasCapability(userRole, CAN_VIEW_COSTS);
  // Task #1886 — these were one shared MERGE_ROLES set; they are now two
  // distinct capabilities, because the bookkeeper may send an invoice but may
  // not change one. Mirrors requireInvoiceSend / requireInvoiceWrite server-side.
  const canMerge = hasCapability(userRole, CAN_EDIT_INVOICES);
  const canMarkSent = hasCapability(userRole, CAN_SEND_INVOICE_EMAIL);
  const canBillingEdit = hasCapability(userRole, CAN_EDIT_INVOICES);
  // Task #1886 — Financial Pulse is denied to the bookkeeper by scope, and its
  // routes enforce that. Rendering the widget anyway would fire a background
  // 403 on her landing page, so it is gated on the same capability the server
  // checks. CAN_VIEW_COSTS mirrors the financial-pulse allowlist exactly.
  const canViewCosts = hasCapability(userRole, CAN_VIEW_COSTS);
  // Task #1918 — what an expanded row is allowed to show.
  //
  // Both mirror a server guard exactly, and both gate by *absence*: the
  // section is not rendered and its request is never issued. Neither is the
  // protection — the server refuses either read on its own, and the note
  // stripping on the invoice list stays authoritative.
  //
  // Task #1921 — reminder history is a read, gated on its own capability
  // (CAN_VIEW_REMINDER_HISTORY, which matches invoice-read), not on the send.
  // An irrigation manager can now see that a reminder already went out without
  // gaining the power to send one — the POST stays behind the send capability.
  const canReadReminderHistory = hasCapability(userRole, CAN_VIEW_REMINDER_HISTORY);
  const canReadArNotes = hasCapability(userRole, CAN_READ_AR_NOTES);
  // Task #1942 — who is answerable for the QuickBooks connection: shown its
  // freshness, and allowed to refresh it. The sync endpoint was re-gated to
  // match (`requireQuickBooksAccess`), so the pill and the button now sit on
  // one capability and neither can 403. Copying QuickBooks' own payment state
  // back is not authoring an invoice, and the bookkeeper — whose page this is
  // — is the person who does it. See
  // docs/audits/invoice-page-capability-audit-2026-08.md.
  const canManageQuickBooks = hasCapability(userRole, CAN_MANAGE_QUICKBOOKS);

  // Task #1890 — the collections landing default.
  //
  // Resolved through `usesUiDefault` against a UI-default membership, never a
  // role-string comparison and never a capability set. The distinction is
  // enforced by the type: `COLLECTIONS_LANDING_DEFAULT` is not a
  // `ReadonlySet<Role>`, so it cannot be handed to `hasCapability` and quietly
  // turned into an authorization decision. It grants nothing — a bookkeeper
  // already reads invoices via CAN_READ_INVOICES; this only decides what she
  // sees first. Every other role keeps the newest-first landing.
  const usesCollectionsDefault = usesUiDefault(userRole, COLLECTIONS_LANDING_DEFAULT);
  const defaultArQuery = usesCollectionsDefault ? COLLECTIONS_DEFAULT_QUERY : EMPTY_AR_QUERY;
  // Applied once per mount, and only when the caller arrived with no view of
  // their own — a shared link or a Financial Pulse deep link must win.
  const appliedLandingDefault = useRef(false);
  useEffect(() => {
    if (appliedLandingDefault.current) return;
    appliedLandingDefault.current = true;
    if (!usesCollectionsDefault) return;
    if (!isEmptyArQuery(arQuery)) return;
    setArQuery(COLLECTIONS_DEFAULT_QUERY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usesCollectionsDefault]);

  // Task #1425 — invoice merge selection. `selectedIds` holds the invoices
  // ticked for merging; `survivingId` is the chosen survivor in the confirm
  // dialog; `mergeConfirmOpen` toggles that dialog.
  // Task #1888 — the same selection now also feeds the batch reminder send, so
  // it is no longer merge-specific: a bookkeeper who cannot merge anything
  // still gets the checkboxes.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchReminderOpen, setBatchReminderOpen] = useState(false);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [survivingId, setSurvivingId] = useState<number | null>(null);
  // Task #1443 — invoice queued for a confirmed QuickBooks re-sync (it already
  // carries a quickbooksInvoiceId, so this forces a fresh QB invoice).
  const [resyncInvoice, setResyncInvoice] = useState<Invoice | null>(null);
  // Task #1767 — track QB auth expiry inside the resync modal so we can show an
  // inline reconnect CTA instead of closing the dialog on error.
  const [resyncQbAuthError, setResyncQbAuthError] = useState(false);
  // Task #1710 — Invoice Correction & Reissue.
  const [correctionInvoice, setCorrectionInvoice] = useState<Invoice | null>(null);
  const canCorrect = hasCapability(userRole, CAN_EDIT_INVOICES);
  // Task #1811 — Invoice editability state.
  const [editMetadataInvoice, setEditMetadataInvoice] = useState<Invoice | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editPeriodStart, setEditPeriodStart] = useState("");
  const [editPeriodEnd, setEditPeriodEnd] = useState("");
  const [voidConfirmInvoice, setVoidConfirmInvoice] = useState<Invoice | null>(null);
  const [voidQbAction, setVoidQbAction] = useState<"void" | "unlink" | null>(null);
  // Draft ticket editor sheet
  const [draftEditorInvoice, setDraftEditorInvoice] = useState<Invoice | null>(null);
  const [addTicketType, setAddTicketType] = useState<"billing_sheet" | "work_order" | "wet_check_billing">("billing_sheet");
  const [addTicketId, setAddTicketId] = useState("");
  // Draft period metadata fields (populated when the draft editor opens)
  const [draftPeriodStart, setDraftPeriodStart] = useState("");
  const [draftPeriodEnd, setDraftPeriodEnd] = useState("");
  const [draftDueDate, setDraftDueDate] = useState("");
  const [draftNotes, setDraftNotes] = useState("");

  // Populate draft period fields when the editor opens on a new invoice
  useEffect(() => {
    if (draftEditorInvoice) {
      setDraftPeriodStart(toIsoDate(draftEditorInvoice.periodStart));
      setDraftPeriodEnd(toIsoDate(draftEditorInvoice.periodEnd));
      setDraftDueDate(toIsoDate(draftEditorInvoice.dueDate));
      setDraftNotes(draftEditorInvoice.notes ?? "");
    }
  }, [draftEditorInvoice?.id]);

  // Metadata save from within the draft editor (same PATCH endpoint; no dialog close needed)
  const draftMetaSaveMutation = useMutation({
    mutationFn: (vars: { id: number; notes?: string; dueDate?: string | null; periodStart?: string; periodEnd?: string }) => {
      const { id: invoiceId, ...body } = vars;
      return apiRequest(`/api/invoices/${invoiceId}`, "PATCH", body);
    },
    onSuccess: (data: any) => {
      toast({ title: "Period metadata saved" });
      if (data && draftEditorInvoice) {
        setDraftEditorInvoice((prev) =>
          prev ? { ...prev, totalAmount: data.totalAmount ?? prev.totalAmount, periodStart: data.periodStart ?? prev.periodStart, periodEnd: data.periodEnd ?? prev.periodEnd, dueDate: data.dueDate ?? prev.dueDate, notes: data.notes ?? prev.notes } : prev
        );
      }
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  // Fetch live invoice items when the draft editor is open
  const { data: draftItemsData, isLoading: draftItemsLoading } = useQuery<{
    items: InvoiceLineItem[];
  }>({
    queryKey: ["/api/invoices", draftEditorInvoice?.id, "items"],
    queryFn: async () => {
      const r = await fetch(`/api/invoices/${draftEditorInvoice!.id}/items`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load items");
      return r.json();
    },
    enabled: draftEditorInvoice != null,
  });
  const draftItems = draftItemsData?.items ?? [];

  // Version-chain history toggle: key is the active invoice id; value true = expanded.
  const [expandedHistory, setExpandedHistory] = useState<Set<number>>(new Set());
  const toggleHistory = (id: number) =>
    setExpandedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Task #1918 — the expanded row.
  //
  // One id, not a set: only one row is open at a time, so opening a second row
  // closes the first by construction rather than by a rule someone has to
  // remember. Working an aging list is a sequence, not a comparison.
  //
  // Local state, deliberately. It is not in the URL and it is not in
  // `arQuery`/`arParams`: the effect below clears the merge selection whenever
  // the A/R params or the month filter change, so an expand routed through
  // those would silently drop the ticks she had already made. Keeping it here
  // also means the list query key never changes, so no page is refetched and
  // no loaded page is dropped.
  const [expandedRowId, setExpandedRowId] = useState<number | null>(null);
  const toggleRowExpansion = (id: number) =>
    setExpandedRowId((prev) => (prev === id ? null : id));

  // The row is a control, so it answers to Enter and Space. Guarded on the row
  // itself as the event target: a keypress inside the checkbox, the version
  // chevron, or the actions menu belongs to that control, not to the row.
  const handleRowKeyDown = (e: React.KeyboardEvent, id: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggleRowExpansion(id);
  };

  // Version history and row expansion are siblings, never nested: the version
  // chevron is its own button inside the row, so a click on it must not also
  // toggle the expansion underneath. Anything interactive in the row — the
  // select checkbox, the chevron, the reminder link, the ⋯ menu — swallows the
  // row click the same way.
  const handleRowClick = (e: React.MouseEvent, id: number) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, textarea, [role='menuitem'], [role='checkbox']")) {
      return;
    }
    toggleRowExpansion(id);
  };

  const handleExportSingleCsv = async (invoice: Invoice) => {
    if (!canExportSingleCsv) return;
    setExportingInvoiceId(invoice.id);
    try {
      await exportSingleInvoiceCsv(invoice);
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Unable to export CSV",
        variant: "destructive",
      });
    } finally {
      setExportingInvoiceId(null);
    }
  };

  // Task #532 — switched from useQuery(limit=500) to useInfiniteQuery
  // with 50-row pages. First paint shows 50 invoices instead of waiting
  // for up to 500. Driven by the X-Total-Count header set by the
  // server's `paginate()` helper.
  const PAGE_SIZE = 50;
  // Task #1890 — the A/R filters and sort go to the server, which applies them
  // across every invoice before slicing a page. The query string is part of
  // the cache key so changing a filter refetches from offset 0 rather than
  // re-filtering whatever happened to be loaded.
  // Task #1942 — the company scope travels with EVERY request this page makes,
  // list and aggregate alike, so the two always describe the same population.
  // The server ignores it for a scoped role and honours it for a super_admin;
  // sending it to only one of the two endpoints is what produced a
  // single-company total printed over a cross-company list.
  const companyScopeParam = useMemo(() => {
    const companyId = getCurrentUserCompanyId();
    return companyId != null ? `companyId=${encodeURIComponent(String(companyId))}` : "";
  }, []);
  const arParams = useMemo(() => {
    const base = arQueryToParams(arQuery).toString();
    return [base, companyScopeParam].filter(Boolean).join("&");
  }, [arQuery, companyScopeParam]);
  const {
    data: invoicePages,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<{ rows: Invoice[]; total: number; nextOffset: number | null }>({
    queryKey: ["/api/invoices", { paginated: true, pageSize: PAGE_SIZE, ar: arParams }],
    initialPageParam: 0,
    queryFn: async ({ pageParam = 0 }) => {
      const offset = Number(pageParam) || 0;
      const suffix = arParams ? `&${arParams}` : "";
      const res = await fetch(`/api/invoices?limit=${PAGE_SIZE}&offset=${offset}${suffix}`);
      if (!res.ok) throw new Error("Failed to fetch invoices");
      const rows = (await res.json()) as Invoice[];
      const total = Number(res.headers.get("X-Total-Count") ?? rows.length);
      const consumed = offset + rows.length;
      return { rows, total, nextOffset: consumed < total ? consumed : null };
    },
    getNextPageParam: (last) => last.nextOffset,
  });
  const invoices = useMemo<Invoice[]>(
    () => invoicePages?.pages.flatMap((p) => p.rows) ?? [],
    [invoicePages],
  );
  /**
   * The POST-filter total the server reports, NOT `invoices.length`.
   *
   * With 50-row pages the loaded array is the first page until the reader asks
   * for more, so counting it would report "50 invoices" for a filter matching
   * three hundred.
   */
  const filteredInvoiceTotal = invoicePages?.pages[0]?.total ?? null;

  // Task #1942 — the aging aggregate behind the strip and the header total.
  //
  // Server-computed over the whole filtered set. The header used to sum the
  // loaded rows, which is the same error class #1890 fixed by moving filtering
  // and sorting server-side: with more than one page of results a client sum
  // reports the first page's balance and calls it the outstanding balance.
  //
  // `?aging=` is deliberately dropped from the request (see
  // `agingSummaryParams`) — a strip re-filtered by the bucket already selected
  // would show one populated card and three zeroes.
  const agingParams = useMemo(() => {
    const p = new URLSearchParams(agingSummaryParams(arQuery));
    for (const [k, v] of new URLSearchParams(companyScopeParam)) p.set(k, v);
    return p.toString();
  }, [arQuery, companyScopeParam]);
  const {
    data: agingSummary,
    isLoading: agingSummaryLoading,
    error: agingSummaryError,
  } = useQuery<AgingSummary>({
    // Keyed UNDER the list's own key on purpose. Every mutation on this page
    // already invalidates ["/api/invoices"], and TanStack Query matches keys
    // by prefix, so the aggregate refetches with the rows. A sibling key would
    // leave the header and the strip quoting pre-sync totals over refreshed
    // rows until something unrelated happened to refetch them.
    queryKey: ["/api/invoices", "aging-summary", agingParams],
    queryFn: async () => {
      const res = await fetch(
        `/api/invoices/aging-summary${agingParams ? `?${agingParams}` : ""}`,
      );
      if (!res.ok) throw new Error("Failed to load aging summary");
      return (await res.json()) as AgingSummary;
    },
  });

  // The header's balance and count, both drawn from the aggregate so they
  // describe one population — see `agingTotalsForView`. The list's own total
  // (`filteredInvoiceTotal`) counts every row the table shows, paid and voided
  // included, and is used where that is the right question: the select-all
  // banner, which is about rows.
  const agingTotals = useMemo(
    () => agingTotalsForView(agingSummary, arQuery.aging),
    [agingSummary, arQuery.aging],
  );

  // Task #1443 — sync/re-sync a single invoice to QuickBooks. A re-sync
  // (existing quickbooksInvoiceId) must pass force:true; the server rejects a
  // non-forced double-create. A fresh sync (null id) omits force.
  const syncMutation = useMutation({
    mutationFn: (vars: { id: number; force?: boolean }) =>
      apiRequest(`/api/invoices/${vars.id}/sync-quickbooks`, "POST", { force: vars.force }),
    onSuccess: () => {
      toast({ title: "Invoice synced to QuickBooks successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      if (parseApiErrorCode(err) === "QB_AUTH_EXPIRED") {
        if (resyncInvoice != null) {
          // Resync dialog is open — keep it open and show inline reconnect banner.
          setResyncQbAuthError(true);
        } else {
          // Plain "Sync to QuickBooks" table action — no dialog, show a toast.
          toast({
            title: "QuickBooks not connected",
            description: "Your QuickBooks session has expired. Go to QuickBooks Settings to reconnect.",
            variant: "destructive",
          });
        }
      } else {
        toast({ title: "QuickBooks sync failed", description: err.message, variant: "destructive" });
      }
    },
  });

  // Task #1831/#1832 — Refresh payment status from QBO Balance field.
  // isAutoSyncRef distinguishes the on-mount auto-trigger (silent on no
  // changes) from manual button clicks (always shows a result toast).
  const isAutoSyncRef = useRef(false);

  const paymentSyncMutation = useMutation({
    mutationFn: () => apiRequest("/api/invoices/sync-payment-status", "POST"),
    onSuccess: (result: any) => {
      const wasAuto = isAutoSyncRef.current;
      isAutoSyncRef.current = false;

      if (result?.throttled) {
        // Auto-trigger: always silent when throttled (background operation).
        // Manual click: show a toast with how long until the next sync is available.
        if (!wasAuto) {
          const secs = result?.nextAllowedIn ?? 0;
          const mins = Math.ceil(secs / 60);
          toast({
            title: "Recently synced",
            description: `Next refresh available in ${mins} minute${mins !== 1 ? "s" : ""}.`,
          });
        }
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });

      const paid = result?.paid ?? 0;
      const partial = result?.partiallyPaid ?? 0;
      const voided = result?.qbVoided ?? 0;
      const hasChanges = paid > 0 || partial > 0;

      // Auto-trigger: only toast when something actually changed
      if (wasAuto && !hasChanges && voided === 0) return;

      const parts: string[] = [];
      if (hasChanges) parts.push(`Updated ${paid} paid, ${partial} partially paid`);
      else parts.push("All invoices are up to date");
      if (voided > 0) parts.push(`${voided} voided in QuickBooks — review required`);
      toast({ title: "Payment status refreshed from QuickBooks", description: parts.join(". ") });
    },
    onError: (err: Error) => {
      const wasAuto = isAutoSyncRef.current;
      isAutoSyncRef.current = false;

      // Auto-trigger errors are silent — it's a background operation
      if (wasAuto) return;

      toast({
        title: "Payment sync failed",
        description: err.message || "Could not read payment status from QuickBooks.",
        variant: "destructive",
      });
    },
  });

  // Task #1832 — Auto-trigger payment sync on page load. The endpoint is
  // throttled server-side (5 min per company), so calling it on every mount
  // is safe — it returns immediately with {throttled:true} when recently run.
  // Silent when throttled or when nothing changed; toast only on actual updates.
  //
  // Task #1886 — gated on CAN_EDIT_INVOICES. The endpoint stamps
  // paymentStatus/balance/paidAt, so it is write-classified; firing it on mount
  // for a read-only role (bookkeeper) produced a silent background 403 on the
  // role's own landing page.
  useEffect(() => {
    if (!canBillingEdit) return;
    isAutoSyncRef.current = true;
    paymentSyncMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canBillingEdit]);

  // Task #1438 — record/undo manual delivery of an invoice. mark-sent flips
  // a draft → sent (stamping sentAt); mark-unsent reverts a sent → draft.
  // No email is sent; this only records delivery state.
  const markSentMutation = useMutation({
    mutationFn: (invoiceId: number) => apiRequest(`/api/invoices/${invoiceId}/mark-sent`, "POST"),
    onSuccess: () => {
      toast({ title: "Invoice marked as sent" });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't mark invoice as sent", description: err.message, variant: "destructive" });
    },
  });

  const markUnsentMutation = useMutation({
    mutationFn: (invoiceId: number) => apiRequest(`/api/invoices/${invoiceId}/mark-unsent`, "POST"),
    onSuccess: () => {
      toast({ title: "Invoice marked unsent" });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't mark invoice unsent", description: err.message, variant: "destructive" });
    },
  });

  // Task #1811 — Invoice editability mutations.
  const returnToDraftMutation = useMutation({
    mutationFn: (invoiceId: number) =>
      apiRequest(`/api/invoices/${invoiceId}/return-to-draft`, "POST"),
    onSuccess: () => {
      toast({ title: "Invoice returned to draft" });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't return to draft", description: err.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: (invoiceId: number) =>
      apiRequest(`/api/invoices/${invoiceId}/finalize`, "POST", {}),
    onSuccess: () => {
      toast({ title: "Invoice finalized" });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't finalize invoice", description: err.message, variant: "destructive" });
    },
  });

  const metadataPatchMutation = useMutation({
    mutationFn: (vars: {
      id: number;
      notes?: string;
      dueDate?: string | null;
      periodStart?: string;
      periodEnd?: string;
    }) => {
      const { id: invoiceId, ...body } = vars;
      return apiRequest(`/api/invoices/${invoiceId}`, "PATCH", body);
    },
    onSuccess: () => {
      toast({ title: "Invoice updated" });
      setEditMetadataInvoice(null);
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const voidMutation = useMutation({
    mutationFn: (vars: { id: number; qbAction?: "void" | "unlink" }) =>
      apiRequest(`/api/invoices/${vars.id}/void`, "POST", vars.qbAction ? { qbAction: vars.qbAction } : {}),
    onSuccess: () => {
      toast({ title: "Invoice voided and tickets released" });
      setVoidConfirmInvoice(null);
      setVoidQbAction(null);
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Void failed", description: err.message, variant: "destructive" });
    },
  });

  const addTicketMutation = useMutation({
    mutationFn: (vars: {
      invoiceId: number;
      ticketType: "billing_sheet" | "work_order" | "wet_check_billing";
      ticketId: number;
    }) =>
      apiRequest(`/api/invoices/${vars.invoiceId}/tickets`, "POST", {
        ticketType: vars.ticketType,
        ticketId: vars.ticketId,
      }),
    onSuccess: (data: any) => {
      toast({ title: "Ticket added" });
      setAddTicketId("");
      if (data && draftEditorInvoice) {
        setDraftEditorInvoice((prev) => prev ? { ...prev, totalAmount: data.totalAmount, partsSubtotal: data.partsSubtotal, laborSubtotal: data.laborSubtotal } : prev);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      if (draftEditorInvoice) {
        queryClient.invalidateQueries({ queryKey: ["/api/invoices", draftEditorInvoice.id, "items"] });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't add ticket", description: err.message, variant: "destructive" });
    },
  });

  const removeTicketMutation = useMutation({
    mutationFn: (vars: {
      invoiceId: number;
      ticketType: string;
      ticketId: number;
    }) =>
      apiRequest(`/api/invoices/${vars.invoiceId}/tickets/${vars.ticketType}:${vars.ticketId}`, "DELETE"),
    onSuccess: (data: any) => {
      toast({ title: "Ticket removed" });
      if (data && draftEditorInvoice) {
        setDraftEditorInvoice((prev) => prev ? { ...prev, totalAmount: data.totalAmount, partsSubtotal: data.partsSubtotal, laborSubtotal: data.laborSubtotal } : prev);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      if (draftEditorInvoice) {
        queryClient.invalidateQueries({ queryKey: ["/api/invoices", draftEditorInvoice.id, "items"] });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't remove ticket", description: err.message, variant: "destructive" });
    },
  });

  const openEditMetadata = (invoice: Invoice) => {
    setEditNotes(invoice.notes ?? "");
    setEditDueDate(toIsoDate(invoice.dueDate));
    setEditPeriodStart(toIsoDate(invoice.periodStart));
    setEditPeriodEnd(toIsoDate(invoice.periodEnd));
    setEditMetadataInvoice(invoice);
  };

  const openVoidConfirm = (invoice: Invoice) => {
    setVoidQbAction(invoice.quickbooksInvoiceId ? null : "unlink");
    setVoidConfirmInvoice(invoice);
  };

  const confirmVoid = () => {
    if (!voidConfirmInvoice) return;
    const hasQb = !!voidConfirmInvoice.quickbooksInvoiceId;
    if (hasQb && !voidQbAction) return;
    voidMutation.mutate({ id: voidConfirmInvoice.id, qbAction: voidQbAction ?? undefined });
  };

  // Task #1425 — merge mutation. Body is the surviving id plus the rest of
  // the selected ids as the merged set. On success the merged invoices are
  // cancelled (kept for audit) and the survivor carries the combined total.
  const mergeMutation = useMutation({
    mutationFn: (vars: { survivingInvoiceId: number; mergedInvoiceIds: number[] }) =>
      apiRequest(`/api/invoices/merge`, "POST", vars),
    onSuccess: (data: any) => {
      const count = data?.cancelledInvoiceNumbers?.length ?? 0;
      toast({
        title: "Invoices merged",
        description:
          data?.survivingInvoiceNumber
            ? `${count} invoice${count !== 1 ? "s" : ""} merged into ${data.survivingInvoiceNumber}.`
            : "Selected invoices were merged.",
      });
      setMergeConfirmOpen(false);
      setSelectedIds(new Set());
      setSurvivingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Merge failed", description: err.message, variant: "destructive" });
    },
  });

  const filteredInvoices = useMemo(() => {
    let result = [...invoices];

    // Task #1942 — search and billing month are applied by the server now, so
    // they are absent here on purpose: the rows, the header total, the aging
    // strip and a select-all across pages all answer the same question.

    if (agingFilter !== "all") {
      const now = new Date();
      result = result.filter((inv) => matchesAging(inv, agingFilter, now));
    }

    return result;
  }, [invoices, agingFilter]);

  // Split into active (non-cancelled) and cancelled for separate display.
  // Cancelled invoices are excluded from all totals and the main table;
  // they appear in a collapsible drawer at the bottom for audit access.
  const activeFilteredInvoices = useMemo(
    () => filteredInvoices.filter((inv) => inv.status !== "cancelled"),
    [filteredInvoices],
  );
  const cancelledInvoices = useMemo(
    () => filteredInvoices.filter((inv) => inv.status === "cancelled"),
    [filteredInvoices],
  );

  const groups = useMemo(() => groupByBillingPeriod(activeFilteredInvoices), [activeFilteredInvoices]);

  // Sorting is applied within each month group so the outer
  // most-recent-first month structure stays intact (Task #1423).
  const sortedInvoices = (items: Invoice[]) => sortInvoices(items, sort);

  // Task #1890 — reconciling the two orderings.
  //
  // The month grouping exists because someone producing invoices thinks in
  // billing periods. Someone chasing them does not: "the oldest, biggest
  // balance" is a statement about the whole ledger, and a global ordering
  // sliced back into month buckets is not that ordering any more. So when an
  // A/R sort is active the list renders flat, in exactly the order the server
  // returned; when it is not, the grouped view is untouched. The cancelled
  // drawer is unaffected either way.
  const flatSections = useMemo(
    () =>
      arSortActive
        ? [{ key: "__flat__", label: null as string | null, invoices: activeFilteredInvoices }]
        : groups,
    [arSortActive, activeFilteredInvoices, groups],
  );

  // One clock for the whole render, so two rows cannot be bucketed a
  // millisecond apart and disagree about the same boundary.
  const nowForAr = useMemo(() => new Date(), [invoices]);

  // Task #1942 — what each row's primary action is allowed to be.
  //
  // The label and the disabled state are the server's answer, read from the
  // same refusal payload the send route itself would produce. Re-deriving
  // "can this be reminded?" in the client is how a button comes to promise
  // something the endpoint then refuses: the throttle window, the missing PDF
  // and the missing customer email all live server-side, and only one of the
  // three is even visible on the row.
  //
  // The endpoint caps a request at 100 ids, so the loaded rows are asked for
  // in chunks rather than one request per row.
  const ELIGIBILITY_CHUNK = 100;
  const eligibilityChunks = useMemo(() => {
    if (!canMarkSent) return [] as number[][];
    const ids = activeFilteredInvoices.map((inv) => inv.id);
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += ELIGIBILITY_CHUNK) {
      chunks.push(ids.slice(i, i + ELIGIBILITY_CHUNK));
    }
    return chunks;
  }, [activeFilteredInvoices, canMarkSent]);
  const eligibilityQueries = useQueries({
    queries: eligibilityChunks.map((ids) => ({
      queryKey: ["/api/invoices/reminder-eligibility", ids.join(",")],
      queryFn: async (): Promise<ReminderEligibilityResponse> => {
        const res = await fetch(`/api/invoices/reminder-eligibility?ids=${ids.join(",")}`);
        if (!res.ok) throw new Error("Failed to load reminder eligibility");
        return (await res.json()) as ReminderEligibilityResponse;
      },
    })),
  });
  const eligibilityById = new Map<number, ReminderEligibility>();
  for (const q of eligibilityQueries) {
    for (const row of q.data?.rows ?? []) eligibilityById.set(row.invoiceId, row);
  }
  /** Undefined until the answer arrives — the button stays inert until then. */
  const eligibilityFor = (invoiceId: number): ReminderEligibility | undefined =>
    eligibilityById.get(invoiceId);

  // Customer options for the A/R filter, accumulated from every invoice seen
  // so far. Deliberately not a separate /api/customers fetch: the bookkeeper's
  // landing page should not fire a request she may not be allowed to make, and
  // the names are already on the rows. Accumulating means selecting a customer
  // does not collapse the list to that one customer.
  const seenCustomers = useRef(new Map<number, string>());
  const customerOptions = useMemo(() => {
    for (const inv of invoices) seenCustomers.current.set(inv.customerId, inv.customerName);
    return [...seenCustomers.current.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [invoices]);

  // ── Task #1942 — the five-column row ──────────────────────────────────────
  //
  // The old row was fifteen columns wide and scrolled sideways: balance, due,
  // days overdue, bucket, payment status, sent, flags and two reminder columns
  // each had their own header, and every action lived in a kebab. Nine columns
  // of A/R are now three cells — who owes it, how much and how late, and where
  // it stands — with one named action at the end. Nothing was dropped; each
  // fact moved into the cell it belongs to, and its test id moved with it.

  /**
   * Who owes it, which invoice, when it was due. Also carries the version
   * history toggle and the note indicator, which are both statements about
   * this invoice's identity rather than its money.
   */
  const renderInvoiceCell = (invoice: Invoice, history: Invoice[], isExpanded: boolean) => {
    const mergedCount = history.filter((p) => p.status === "merged").length;
    return (
      <TableCell className="max-w-[300px]">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-gray-900">{invoice.customerName}</span>
          {/* Task #1889 — a conversation is already in flight on this invoice.
              Absent entirely for a role the server strips the data for. */}
          <ArNoteIndicator invoice={invoice} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-gray-500">
          <span className="whitespace-nowrap">#{invoice.invoiceNumber}</span>
          {(invoice.revision ?? 1) > 1 && (
            <span className="rounded bg-amber-100 px-1 py-0.5 font-medium text-amber-700">
              Rev {invoice.revision}
            </span>
          )}
          {mergedCount > 0 && (
            <span className="rounded bg-purple-100 px-1 py-0.5 font-medium text-purple-700">
              Merged from {mergedCount}
            </span>
          )}
          <span aria-hidden="true" className="text-gray-300">
            ·
          </span>
          <span className="whitespace-nowrap" data-testid={`ar-due-${invoice.id}`}>
            {invoice.effectiveDueDate ? `Due ${formatDate(invoice.effectiveDueDate)}` : "No due date"}
          </span>
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => toggleHistory(invoice.id)}
              className="ml-1 flex items-center gap-0.5 text-gray-400 hover:text-gray-600"
              title={isExpanded ? "Hide version history" : "Show version history"}
              aria-label={
                isExpanded
                  ? "Hide version history"
                  : `Show ${history.length} prior version${history.length !== 1 ? "s" : ""}`
              }
            >
              <ChevronDown
                className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-180" : ""}`}
              />
              {history.length}
            </button>
          )}
        </div>
      </TableCell>
    );
  };

  /**
   * What is owed and how late it is. The balance is the figure a bookkeeper
   * chases, so it leads; days overdue sits under it in a danger treatment
   * because "how late" is the second question, never the first.
   */
  const renderBalanceCell = (invoice: Invoice) => {
    const bucket = agingBucketOf(invoice, nowForAr);
    const dpd = daysPastDue(invoice, nowForAr);
    const fallback = balanceIsFallbackOf(invoice);
    return (
      <TableCell className="text-right whitespace-nowrap align-top">
        <div
          className={fallback ? "text-gray-500" : "font-semibold text-gray-900"}
          title={
            fallback
              ? "No payment balance has been synced from QuickBooks for this invoice, so the invoice total is shown instead. It may not reflect payments already received."
              : `Balance last synced from QuickBooks${invoice.paymentSyncedAt ? ` on ${formatDate(invoice.paymentSyncedAt)}` : ""}.`
          }
          data-testid={`ar-balance-${invoice.id}`}
        >
          {formatCurrency(balanceDueOf(invoice))}
          {fallback && (
            <span
              className="ml-1 text-xs font-normal text-amber-700"
              title="No payment sync has run for this invoice."
            >
              (unsynced)
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs" data-testid={`ar-days-overdue-${invoice.id}`}>
          {bucket === "current" ? (
            <span className="text-gray-400">Not yet due</span>
          ) : (
            <span className="font-medium text-red-700">
              {Math.max(0, Math.floor(dpd))} days overdue
            </span>
          )}
        </div>
        <div className="sr-only" data-testid={`ar-bucket-${invoice.id}`}>
          {AGING_BUCKET_LABELS[bucket]}
        </div>
      </TableCell>
    );
  };

  /**
   * Two lines: where the money stands, then what has already been done about
   * it. Every badge and flag the old row spread across four columns lands
   * here, which is what makes one glance enough to decide whether this row
   * needs chasing.
   */
  const renderStatusCell = (invoice: Invoice) => {
    const paymentStatus = invoice.paymentStatus ?? "unpaid";
    const reminderCount = invoice.reminderCount ?? 0;
    return (
      <TableCell className="max-w-[300px] align-top">
        {/* Line 1 — the money state. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {getStatusBadge(invoice.status)}
          {invoice.isOverdue && (
            <Badge className="bg-red-100 text-red-800 text-xs" data-testid={`overdue-badge-${invoice.id}`}>
              Overdue
            </Badge>
          )}
          {invoice.paymentStatus === "partially_paid" && (
            <Badge className="bg-amber-100 text-amber-800 text-xs" data-testid={`partial-badge-${invoice.id}`}>
              Partial
            </Badge>
          )}
          {invoice.paymentSyncedAt && invoice.paymentStatus === "unpaid" && !invoice.qbVoidDetectedAt && (
            <Badge className="bg-gray-100 text-gray-700 text-xs" data-testid={`unpaid-badge-${invoice.id}`}>
              Unpaid
            </Badge>
          )}
          {invoice.qbVoidDetectedAt && (
            <Badge
              className="bg-orange-100 text-orange-800 border border-orange-300 text-xs cursor-help"
              title="This invoice was voided in QuickBooks but is still open in IrrigoPro. Void it here or restore it in QuickBooks."
              data-testid={`qb-voided-badge-${invoice.id}`}
            >
              <AlertCircle className="w-3 h-3 mr-1" />
              Voided in QB
            </Badge>
          )}
          {renderQbIcon(invoice)}
          <span className="sr-only" data-testid={`ar-payment-status-${invoice.id}`}>
            {PAYMENT_STATUS_LABELS[paymentStatus] ?? paymentStatus}
          </span>
        </div>
        {/* Line 2 — the action history: what has already been done. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
          <span data-testid={`ar-sent-${invoice.id}`}>
            {invoice.sentAt ? `Sent ${formatDate(invoice.sentAt)}` : "Not sent"}
          </span>
          <span aria-hidden="true" className="text-gray-300">
            ·
          </span>
          {/* Task #1887 — real reminder data. Delivered reminders only. */}
          <span data-testid={`ar-last-reminder-${invoice.id}`}>
            {invoice.lastReminderAt
              ? `Reminded ${formatDate(invoice.lastReminderAt)}${reminderCount > 1 ? ` (${reminderCount}×)` : ""}`
              : "No reminders"}
          </span>
          <ArFlagBadges invoice={invoice} now={nowForAr} />
        </div>
      </TableCell>
    );
  };

  /**
   * One named action, then the two one-click reads, then everything else.
   *
   * The primary button's label and enabled state are the server's answer, not
   * a guess assembled here — see `InvoicePrimaryAction`. PDF and QuickBooks
   * re-sync are inline because they are the two things done most often and
   * neither needs a confirmation; everything destructive or state-changing
   * stays in the kebab behind the confirmation it already had.
   */
  const renderActionCell = (invoice: Invoice) => (
    <TableCell className="text-right align-top">
      <div className="flex items-center justify-end gap-1">
        {canMarkSent && (
          <InvoicePrimaryAction
            invoiceId={invoice.id}
            eligibility={eligibilityFor(invoice.id)}
            now={nowForAr}
            onSendInvoice={() =>
              setPdfModal({
                id: invoice.id,
                number: invoice.invoiceNumber,
                email: invoice.customerEmail,
              })
            }
            onRemind={() => {
              // Reuses the #1888 confirmation flow with a single invoice in it
              // rather than opening a second, one-off send path.
              setSelectedIds(new Set([invoice.id]));
              setBatchReminderOpen(true);
            }}
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-gray-500 hover:text-gray-900"
          title={`View PDF for invoice ${invoice.invoiceNumber}`}
          aria-label={`View PDF for invoice ${invoice.invoiceNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            window.open(`/api/invoices/${invoice.id}/pdf`, "_blank");
          }}
          data-testid={`button-view-pdf-inline-${invoice.id}`}
        >
          <FileText className="w-4 h-4" />
        </Button>
        {canManageQuickBooks && invoice.status !== "draft" && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-gray-500 hover:text-gray-900"
            title={
              invoice.quickbooksInvoiceId
                ? `Re-sync invoice ${invoice.invoiceNumber} to QuickBooks`
                : `Sync invoice ${invoice.invoiceNumber} to QuickBooks`
            }
            aria-label={
              invoice.quickbooksInvoiceId
                ? `Re-sync invoice ${invoice.invoiceNumber} to QuickBooks`
                : `Sync invoice ${invoice.invoiceNumber} to QuickBooks`
            }
            disabled={syncMutation.isPending}
            onClick={(e) => {
              e.stopPropagation();
              // A re-sync replaces a QuickBooks invoice that already exists, so
              // it keeps its confirmation; a first sync creates one and does not.
              if (invoice.quickbooksInvoiceId) setResyncInvoice(invoice);
              else syncMutation.mutate({ id: invoice.id });
            }}
            data-testid={`button-sync-qb-inline-${invoice.id}`}
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        )}
        {renderActionsMenu(invoice)}
      </div>
    </TableCell>
  );

  // Task #1942 — when payment data was last pulled from QuickBooks.
  //
  // Company-level, from the aggregate: the pill is a statement about the
  // connection, so it must not move when the reader filters the table. Taken
  // from the loaded rows it would call a healthy connection stale the moment
  // a search or a month filter excluded the most recently synced invoice.
  const lastPaymentSyncAt = agingSummary?.lastPaymentSyncAt ?? null;

  const monthOptions = generateMonthOptions();

  // Task #1425 — an invoice is mergeable only when it isn't already cancelled.
  const isMergeable = (inv: Invoice) => inv.status !== "cancelled";

  // Task #1888 — the row checkbox is shared between merge and batch reminders.
  // Both are gated on their own capability through the shared registry; the
  // checkbox appears for either one, and the action bar shows only the
  // actions this user actually holds.
  const canBatchRemind = canMarkSent;
  const canSelectRows = canMerge || canBatchRemind;

  // Task #1918 — how wide the expanded region has to span on the desktop
  // table.
  //
  // Task #1942 — four columns now (invoice, balance, status, action) plus the
  // select column when it is present. The history rows above render the same
  // four cells rather than spanning a constant, so there is no second number
  // here to drift out of step with this one.
  const desktopColumnCount = (canSelectRows ? 1 : 0) + 4;

  const selectedInvoices = useMemo(
    () => activeFilteredInvoices.filter((inv) => selectedIds.has(inv.id)),
    [activeFilteredInvoices, selectedIds],
  );

  // A selection is valid for merge when 2+ invoices share the SAME customer
  // and the SAME billing period (month + year). This mirrors the server's
  // validateMerge guard so the UI never offers an action the API will reject.
  const mergeValidation = useMemo(() => {
    if (selectedInvoices.length < 2) {
      return { ok: false as const, reason: "Select at least two invoices to merge." };
    }
    const first = selectedInvoices[0];
    const sameCustomer = selectedInvoices.every((inv) => inv.customerId === first.customerId);
    if (!sameCustomer) {
      return { ok: false as const, reason: "All selected invoices must belong to the same customer." };
    }
    const samePeriod = selectedInvoices.every(
      (inv) => inv.invoiceMonth === first.invoiceMonth && inv.invoiceYear === first.invoiceYear,
    );
    if (!samePeriod) {
      return { ok: false as const, reason: "All selected invoices must be from the same billing period." };
    }
    return { ok: true as const, reason: "" };
  }, [selectedInvoices]);

  // Task #1942 — totals for invoices selected by "select all" that are not on
  // a loaded page. Without these the selection bar would say "312 selected"
  // over the value of the first fifty.
  const [offPageSelectionTotals, setOffPageSelectionTotals] = useState<Map<number, string>>(
    new Map(),
  );
  const loadedTotalsById = useMemo(
    () => new Map(invoices.map((inv) => [inv.id, inv.totalAmount])),
    [invoices],
  );
  const selectedTotal = Array.from(selectedIds).reduce((sum, id) => {
    const amount = loadedTotalsById.get(id) ?? offPageSelectionTotals.get(id);
    return sum + (amount ? parseFloat(amount) || 0 : 0);
  }, 0);

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setOffPageSelectionTotals(new Map());
  };

  // Task #1888 — "select what I am looking at". The visible set is whatever
  // the active server-side filters left on screen, so this can never tick a
  // row the user cannot see.
  const selectableVisibleIds = useMemo(
    () => activeFilteredInvoices.filter(isMergeable).map((inv) => inv.id),
    [activeFilteredInvoices],
  );
  const allVisibleSelected =
    selectableVisibleIds.length > 0 &&
    selectableVisibleIds.every((id) => selectedIds.has(id));
  const [selectAllPending, setSelectAllPending] = useState(false);

  /**
   * Task #1942 — select-all covers the filtered set, not the loaded page.
   *
   * The list is paginated at 50, so ticking only what is mounted quietly
   * redefines "all" as "the first page" — a bookkeeper who filters to 312
   * overdue invoices, hits select-all and sends reminders would reach fifty
   * customers and believe she had reached all of them. When the server says
   * the filter matches more than is loaded, the ids are fetched for the same
   * filter before selecting.
   *
   * The fetch is capped at the endpoint's own 500-row maximum. Beyond that
   * the loaded set is selected instead, which under-selects rather than
   * over-promising.
   */
  const toggleSelectAllVisible = async () => {
    if (allVisibleSelected) {
      clearSelection();
      return;
    }
    const total = filteredInvoiceTotal;
    if (total != null && total > invoices.length) {
      setSelectAllPending(true);
      try {
        const suffix = arParams ? `&${arParams}` : "";
        const res = await fetch(`/api/invoices?limit=500&offset=0${suffix}`);
        if (res.ok) {
          const rows = (await res.json()) as Invoice[];
          const selectable = rows.filter(isMergeable);
          setOffPageSelectionTotals(new Map(selectable.map((r) => [r.id, r.totalAmount])));
          setSelectedIds(new Set(selectable.map((r) => r.id)));
          return;
        }
      } catch {
        // Fall through: selecting what is loaded is still a correct, smaller
        // answer, and the count in the bar says exactly what it selected.
      } finally {
        setSelectAllPending(false);
      }
    }
    setSelectedIds(new Set(selectableVisibleIds));
  };

  // Changing the filters changes what "selected" means, and a selection that
  // outlives its filter is a selection nobody has actually looked at. Drop it.
  useEffect(() => {
    setSelectedIds(new Set());
    setOffPageSelectionTotals(new Map());
  }, [arParams]);

  const openMergeConfirm = () => {
    if (!mergeValidation.ok) return;
    // Default survivor: the lowest invoice id (earliest created) in the set.
    const defaultSurvivor = selectedInvoices.reduce(
      (min, inv) => (inv.id < min ? inv.id : min),
      selectedInvoices[0].id,
    );
    setSurvivingId(defaultSurvivor);
    setMergeConfirmOpen(true);
  };

  const confirmMerge = () => {
    if (!mergeValidation.ok || survivingId == null) return;
    const mergedInvoiceIds = selectedInvoices
      .map((inv) => inv.id)
      .filter((id) => id !== survivingId);
    mergeMutation.mutate({ survivingInvoiceId: survivingId, mergedInvoiceIds });
  };

  const handleExportCsv = () => {
    if (activeFilteredInvoices.length === 0) return;
    try {
      const csv = buildInvoicesCsv(activeFilteredInvoices);
      const today = new Date().toISOString().slice(0, 10);
      const filename =
        arQuery.month
          ? `monthly-invoices-${arQuery.month}.csv`
          : `monthly-invoices-${today}.csv`;
      const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Unable to generate CSV",
        variant: "destructive",
      });
    }
  };

  // Task #1439 — compact presentation helpers shared by the desktop
  // table and the mobile card fallback.
  const periodLabelOf = (inv: Invoice) =>
    `${MONTH_NAMES[inv.invoiceMonth - 1]} ${inv.invoiceYear}`;
  const periodRangeOf = (inv: Invoice) =>
    `${formatDate(inv.periodStart)} – ${formatDate(inv.periodEnd)}`;

  const renderQbIcon = (inv: Invoice) => (
    <span
      className="inline-flex"
      title={inv.quickbooksInvoiceId ? "Synced to QuickBooks" : "Not synced to QuickBooks"}
    >
      <CheckCircle2
        className={`w-3.5 h-3.5 ${inv.quickbooksInvoiceId ? "text-emerald-600" : "text-gray-300"}`}
        aria-label={inv.quickbooksInvoiceId ? "Synced to QuickBooks" : "Not synced to QuickBooks"}
      />
    </span>
  );

  const renderActionsMenu = (invoice: Invoice) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          data-testid={`button-invoice-actions-${invoice.id}`}
        >
          <span className="sr-only">Open actions for invoice {invoice.invoiceNumber}</span>
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onSelect={() =>
            setAuditInvoice({
              id: invoice.id,
              label: `${periodLabelOf(invoice)} · #${invoice.invoiceNumber}`,
              total: formatCurrency(invoice.totalAmount),
            })
          }
        >
          <ClipboardList className="w-3.5 h-3.5 mr-2" />
          Audit
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            setPdfModal({
              id: invoice.id,
              number: invoice.invoiceNumber,
              email: invoice.customerEmail,
            })
          }
        >
          <FileText className="w-3.5 h-3.5 mr-2" />
          View PDF
        </DropdownMenuItem>
        {canMarkSent && invoice.sentAt == null && !["cancelled", "superseded", "merged", "draft"].includes(invoice.status) && (
          <DropdownMenuItem
            disabled={markSentMutation.isPending && markSentMutation.variables === invoice.id}
            onSelect={(e) => {
              e.preventDefault();
              markSentMutation.mutate(invoice.id);
            }}
            data-testid={`button-mark-sent-invoice-${invoice.id}`}
          >
            {markSentMutation.isPending && markSentMutation.variables === invoice.id ? (
              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5 mr-2" />
            )}
            Mark sent
          </DropdownMenuItem>
        )}
        {/* Task #1886 — mark-unsent is WRITE-classified on the server
            (requireInvoiceWrite), so it is gated on CAN_EDIT_INVOICES, not on
            the send capability. A bookkeeper may mark an invoice sent but not
            reverse it; showing this to her would render a control that 403s. */}
        {canBillingEdit && invoice.sentAt != null && (
          <DropdownMenuItem
            disabled={markUnsentMutation.isPending && markUnsentMutation.variables === invoice.id}
            onSelect={(e) => {
              e.preventDefault();
              markUnsentMutation.mutate(invoice.id);
            }}
            data-testid={`button-mark-unsent-invoice-${invoice.id}`}
          >
            {markUnsentMutation.isPending && markUnsentMutation.variables === invoice.id ? (
              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            ) : (
              <X className="w-3.5 h-3.5 mr-2" />
            )}
            Mark unsent
          </DropdownMenuItem>
        )}
        {canExportSingleCsv && (
          <DropdownMenuItem
            disabled={exportingInvoiceId === invoice.id}
            onSelect={(e) => {
              e.preventDefault();
              handleExportSingleCsv(invoice);
            }}
            data-testid={`button-export-invoice-csv-${invoice.id}`}
          >
            {exportingInvoiceId === invoice.id ? (
              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5 mr-2" />
            )}
            Export CSV
          </DropdownMenuItem>
        )}
        {/* Task #1942 — /api/invoices/:id/sync-quickbooks now answers to
            requireQuickBooksAccess, so both branches are gated on
            CAN_MANAGE_QUICKBOOKS: the whole QuickBooks surface (connection,
            payment-status sync, freshness pill, per-invoice push) sits behind
            one capability instead of splitting the integration from the push
            it exists to perform. Nothing about the IrrigoPro invoice changes. */}
        {canManageQuickBooks &&
          (!invoice.quickbooksInvoiceId ? (
            <DropdownMenuItem
              disabled={syncMutation.isPending}
              onSelect={(e) => {
                e.preventDefault();
                syncMutation.mutate({ id: invoice.id });
              }}
              data-testid={`button-sync-quickbooks-invoice-${invoice.id}`}
            >
              {syncMutation.isPending && syncMutation.variables?.id === invoice.id ? (
                <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-2" />
              )}
              Sync to QuickBooks
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={syncMutation.isPending}
              onSelect={(e) => {
                e.preventDefault();
                setResyncInvoice(invoice);
              }}
              data-testid={`button-resync-quickbooks-invoice-${invoice.id}`}
            >
              {syncMutation.isPending && syncMutation.variables?.id === invoice.id ? (
                <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-2" />
              )}
              Re-sync to QuickBooks
            </DropdownMenuItem>
          ))}
        {/* Task #1710 — Correct / Reissue. Available on generated invoices. */}
        {canCorrect && invoice.status === "generated" && (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setCorrectionInvoice(invoice);
            }}
            data-testid={`button-correct-invoice-${invoice.id}`}
          >
            <Edit3 className="w-3.5 h-3.5 mr-2" />
            Correct / Reissue
          </DropdownMenuItem>
        )}
        {/* Task #1811 — Edit metadata. Available on generated (not draft — use the manage-tickets sheet for draft). */}
        {canBillingEdit && invoice.status === "generated" && (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              openEditMetadata(invoice);
            }}
            data-testid={`button-edit-invoice-metadata-${invoice.id}`}
          >
            <Edit3 className="w-3.5 h-3.5 mr-2" />
            Edit invoice
          </DropdownMenuItem>
        )}
        {/* Task #1811 — Manage tickets: add/remove tickets. Draft only. */}
        {canBillingEdit && invoice.status === "draft" && (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setAddTicketId("");
              setDraftEditorInvoice(invoice);
            }}
            data-testid={`button-manage-tickets-invoice-${invoice.id}`}
          >
            <ClipboardList className="w-3.5 h-3.5 mr-2" />
            Manage tickets
          </DropdownMenuItem>
        )}
        {/* Task #1811 — Return to draft. Only from generated. */}
        {canBillingEdit && invoice.status === "generated" && (
          <DropdownMenuItem
            disabled={returnToDraftMutation.isPending && returnToDraftMutation.variables === invoice.id}
            onSelect={(e) => {
              e.preventDefault();
              returnToDraftMutation.mutate(invoice.id);
            }}
            data-testid={`button-return-to-draft-invoice-${invoice.id}`}
          >
            {returnToDraftMutation.isPending && returnToDraftMutation.variables === invoice.id ? (
              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5 mr-2" />
            )}
            Return to draft
          </DropdownMenuItem>
        )}
        {/* Task #1811 — Finalize draft → generated. Only from draft. */}
        {canBillingEdit && invoice.status === "draft" && (
          <DropdownMenuItem
            disabled={finalizeMutation.isPending && finalizeMutation.variables === invoice.id}
            onSelect={(e) => {
              e.preventDefault();
              finalizeMutation.mutate(invoice.id);
            }}
            data-testid={`button-finalize-invoice-${invoice.id}`}
          >
            {finalizeMutation.isPending && finalizeMutation.variables === invoice.id ? (
              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            ) : (
              <CheckSquare className="w-3.5 h-3.5 mr-2" />
            )}
            Finalize invoice
          </DropdownMenuItem>
        )}
        {/* Task #1811 — Void & Release. Available on unpaid invoices: draft or generated. */}
        {canBillingEdit && ["draft", "generated"].includes(invoice.status) && (
          <DropdownMenuItem
            className="text-red-600 focus:text-red-600"
            onSelect={(e) => {
              e.preventDefault();
              openVoidConfirm(invoice);
            }}
            data-testid={`button-void-invoice-${invoice.id}`}
          >
            <Trash2 className="w-3.5 h-3.5 mr-2" />
            Void &amp; release
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-64 p-8">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        <span className="ml-2 text-gray-600">Loading invoices...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <AlertCircle className="w-8 h-8 mx-auto mb-2 text-red-600" />
            <p className="text-gray-600">Failed to load invoices. Please try again.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-4 lg:p-6">
        {/* Task #1942 — the header states the two numbers this page exists to
            answer: how much is outstanding under the current filter, and how
            many invoices that is. Both are server-computed. */}
        <InvoicePageHeader
          outstandingBalance={agingTotals?.balanceDue ?? null}
          invoiceCount={agingTotals?.count ?? null}
          summaryLoading={agingSummaryLoading}
          canSeeQuickBooksStatus={canManageQuickBooks}
          canRunPaymentSync={canManageQuickBooks}
          lastPaymentSyncAt={lastPaymentSyncAt}
          onRunPaymentSync={() => paymentSyncMutation.mutate()}
          isSyncing={paymentSyncMutation.isPending}
          now={nowForAr}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={activeFilteredInvoices.length === 0}
              data-testid="button-export-csv"
            >
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </Button>
          }
        />

        {/* Task #708 — A/R Aging widget. Bucket clicks deep-link
            back to this page with `?aging=<key>`, which hydrates the
            aging filter below. */}
        {canViewCosts && (
          <div className="mb-6">
            <FinancialPulseWidget variant="ar-aging" />
          </div>
        )}

        {/* Task #1942 — the aging strip. Server-computed totals per bucket;
            clicking a card writes the same `?aging=` the Financial Pulse
            widget deep-links with, so the two agree by construction. */}
        <InvoiceAgingStrip
          summary={agingSummary}
          isLoading={agingSummaryLoading}
          isError={!!agingSummaryError}
          active={arQuery.aging}
          onSelect={(value) => patchArQuery({ aging: value })}
        />

        {/* Task #1890 — every filter is in the query string, so this whole
            view is a link: it survives a reload and can be handed to someone
            else. They combine with AND, and the server applies them across
            the entire invoice set.
            Task #1942 — the same filters, collapsed into one popover with a
            chip for each one that is actually doing something. */}
        <InvoiceFilterBar
          searchTerm={searchInput}
          onSearchChange={setSearchInput}
          query={arQuery}
          onPatch={patchArQuery}
          onClearAll={() => {
            setSearchInput("");
            setArQuery(defaultArQuery);
          }}
          hasActiveFilters={!isEmptyArQuery(arQuery)}
          customerOptions={customerOptions}
          monthFilter={arQuery.month || "all"}
          monthOptions={monthOptions}
          onMonthChange={(value) => patchArQuery({ month: value === "all" ? "" : value })}
        />

        {/* Empty state */}
        {flatSections.length === 0 && (
          <Card>
            <CardContent className="p-12 text-center">
              <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p className="font-medium text-gray-500">No invoices found</p>
              <p className="text-sm text-gray-400 mt-1">
                {!isEmptyArQuery(arQuery)
                  ? "Try adjusting your filters."
                  : "Invoices will appear here once they are generated."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Invoice list — grouped by billing month, or flat when an A/R sort
            is active (Task #1890). */}
        <div className="space-y-8">
          {flatSections.map((group) => {
            // Terminal invoices (superseded, merged) are excluded from the
            // group total and collapsed as version history beneath their survivor.
            const activeInvoices = group.invoices.filter(
              (inv) => inv.status !== "superseded" && inv.status !== "merged",
            );
            const terminalInvoices = group.invoices.filter(
              (inv) => inv.status === "superseded" || inv.status === "merged",
            );
            // Build a unified predecessor map keyed by the survivor/replacement
            // invoice id. Supports both correction chains (supersededByInvoiceId)
            // and merge chains (mergedIntoInvoiceId).
            const predecessorMap = new Map<number, Invoice[]>();
            for (const inv of terminalInvoices) {
              const linkId = inv.supersededByInvoiceId ?? inv.mergedIntoInvoiceId ?? null;
              if (linkId != null) {
                const arr = predecessorMap.get(linkId) ?? [];
                arr.push(inv);
                predecessorMap.set(linkId, arr);
              }
            }
            const groupTotal = activeInvoices.reduce((s, inv) => s + parseFloat(inv.totalAmount), 0);
            // Collect all terminal predecessors for a given active invoice id.
            // Correction chains are linear (R1 → R2 → R3): follow prevs[0] each step.
            // Merge chains are fan-in (N absorbed → 1 survivor): all N are at the
            // first level, so push them all and stop walking (absorbed invoices have
            // no further predecessors of their own).
            const predecessorsFor = (activeId: number): Invoice[] => {
              const result: Invoice[] = [];
              let currentId = activeId;
              while (true) {
                const prevs = predecessorMap.get(currentId) ?? [];
                if (prevs.length === 0) break;
                // Fan-in case (merges): all predecessors link directly to the same
                // survivor. Push them all and stop — absorbed invoices don't have
                // further predecessors in the map.
                if (prevs.length > 1) {
                  result.push(...prevs);
                  break;
                }
                // Linear correction chain: push the single predecessor and keep walking.
                result.push(prevs[0]);
                currentId = prevs[0].id;
              }
              return result;
            };
            return (
              <div key={group.key}>
                {/* Month Header — suppressed under an A/R sort, where the
                    ordering is global and a month heading would imply a
                    grouping that is no longer there. */}
                {group.label != null && (
                  <div
                    className="flex items-center justify-between mb-3"
                    data-testid="invoice-group-header"
                  >
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-blue-600" />
                      <h2 className="text-base font-semibold text-gray-800">{group.label}</h2>
                      <Badge variant="secondary" className="text-xs">
                        {activeInvoices.length} invoice{activeInvoices.length !== 1 ? "s" : ""}
                      </Badge>
                    </div>
                    <span className="text-sm font-semibold text-gray-700">{formatCurrency(groupTotal)}</span>
                  </div>
                )}

                {/* Invoice Table — desktop (Task #1439: compacted to
                    fit one view; QuickBooks folded into a status icon,
                    period shortened, row actions in a ⋯ menu).
                    Task #1890 added the A/R columns, so the table scrolls
                    horizontally rather than crushing the existing ones. */}
                <div className="hidden md:block rounded-lg border border-gray-200 bg-white overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-gray-50 hover:bg-gray-50">
                        {canSelectRows && (
                          <TableHead className="w-8">
                            {/* Selects exactly what the active filters are
                                showing — "select what I am looking at". */}
                            <Checkbox
                              checked={allVisibleSelected}
                              disabled={selectAllPending}
                              onCheckedChange={() => {
                                void toggleSelectAllVisible();
                              }}
                              aria-label="Select every invoice matching these filters"
                              data-testid="checkbox-select-all-invoices"
                            />
                          </TableHead>
                        )}
                        {/* Task #1942 — five columns. The customer sort stays on
                            the Invoice header and the balance sort on the
                            Balance header; both are the same controls as
                            before, on the cell that now carries the data. */}
                        <SortableHeader sortKey="customer" label="Invoice" sort={sort} onSort={toggleSort} />
                        <ArSortableHeader sortKey="balanceDue" align="right" sort={arQuery.sort} dir={arQuery.dir} onSort={toggleArSort} />
                        <TableHead className="whitespace-nowrap">Status</TableHead>
                        <TableHead className="w-10 text-right whitespace-nowrap">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedInvoices(activeInvoices).map((invoice) => {
                        const history = predecessorsFor(invoice.id);
                        const isExpanded = expandedHistory.has(invoice.id);
                        const isRowExpanded = expandedRowId === invoice.id;
                        const rowId = `invoice-row-${invoice.id}`;
                        const regionId = `invoice-row-region-${invoice.id}`;
                        return (
                        <Fragment key={invoice.id}>
                        <TableRow
                          className="hover:bg-gray-50 cursor-pointer"
                          id={rowId}
                          tabIndex={0}
                          aria-expanded={isRowExpanded}
                          aria-controls={isRowExpanded ? regionId : undefined}
                          onClick={(e) => handleRowClick(e, invoice.id)}
                          onKeyDown={(e) => handleRowKeyDown(e, invoice.id)}
                          data-testid={`invoice-row-${invoice.id}`}
                        >
                          {canSelectRows && (
                            <TableCell className="w-8">
                              {isMergeable(invoice) && (
                                <Checkbox
                                  checked={selectedIds.has(invoice.id)}
                                  onCheckedChange={() => toggleSelected(invoice.id)}
                                  aria-label={`Select invoice ${invoice.invoiceNumber}`}
                                  data-testid={`checkbox-select-invoice-${invoice.id}`}
                                />
                              )}
                            </TableCell>
                          )}
                          {renderInvoiceCell(invoice, history, isExpanded)}
                          {renderBalanceCell(invoice)}
                          {renderStatusCell(invoice)}
                          {renderActionCell(invoice)}
                        </TableRow>
                        {/* Version history rows — shown when the user expands the chain */}
                        {isExpanded && history.map((prev) => (
                          <TableRow key={prev.id} className="bg-amber-50 text-xs text-gray-400 italic">
                            {canSelectRows && <TableCell />}
                            <TableCell className="max-w-[300px] pl-8">
                              <div className="truncate">{prev.customerName}</div>
                              <div className="mt-0.5">
                                ↳ #{prev.invoiceNumber}
                                <span className="ml-1">Rev {prev.revision ?? 1}</span>
                                <span className="ml-1" title={periodRangeOf(prev)}>
                                  · {periodLabelOf(prev)}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right whitespace-nowrap line-through">
                              {formatCurrency(prev.totalAmount)}
                            </TableCell>
                            {/* A superseded/merged predecessor carries no live
                                A/R position — the survivor holds the money. */}
                            <TableCell className="whitespace-nowrap">
                              {getStatusBadge(prev.status)}
                            </TableCell>
                            <TableCell />
                          </TableRow>
                        ))}
                        {/* Task #1918 — the expanded region, mounted only for
                            the open row so a fifty-row list issues none of its
                            three reads. */}
                        {isRowExpanded && (
                          <TableRow className="bg-gray-50 hover:bg-gray-50">
                            <TableCell colSpan={desktopColumnCount} className="p-0">
                              <div
                                id={regionId}
                                role="region"
                                aria-labelledby={rowId}
                                className="px-4 py-4"
                                data-testid={`invoice-row-expansion-${invoice.id}`}
                              >
                                <InvoiceRowExpansion
                                  invoiceId={invoice.id}
                                  invoiceNumber={invoice.invoiceNumber}
                                  open
                                  canReadReminders={canReadReminderHistory}
                                  canReadArNotes={canReadArNotes}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                        </Fragment>
                      );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Invoice cards — mobile fallback (Task #1439) so the
                    list never overflows on narrow screens. */}
                <div className="md:hidden space-y-3">
                  {sortedInvoices(activeInvoices).map((invoice) => {
                    const history = predecessorsFor(invoice.id);
                    const isExpanded = expandedHistory.has(invoice.id);
                    // Task #1918 — the card list gets the same expansion as the
                    // table. It is the same list on a narrower screen, and the
                    // detour it removes is the one that hurts most on a phone.
                    const isRowExpanded = expandedRowId === invoice.id;
                    const rowId = `invoice-card-${invoice.id}`;
                    const regionId = `invoice-card-region-${invoice.id}`;
                    return (
                    <div key={invoice.id} className="space-y-0">
                    <Card className="border-gray-200">
                      <CardContent
                        className="p-4 cursor-pointer"
                        role="button"
                        id={rowId}
                        tabIndex={0}
                        aria-expanded={isRowExpanded}
                        aria-controls={isRowExpanded ? regionId : undefined}
                        onClick={(e) => handleRowClick(e, invoice.id)}
                        onKeyDown={(e) => handleRowKeyDown(e, invoice.id)}
                        data-testid={`invoice-row-mobile-${invoice.id}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {canSelectRows && isMergeable(invoice) && (
                              <Checkbox
                                checked={selectedIds.has(invoice.id)}
                                onCheckedChange={() => toggleSelected(invoice.id)}
                                aria-label={`Select invoice ${invoice.invoiceNumber}`}
                                data-testid={`checkbox-select-invoice-mobile-${invoice.id}`}
                              />
                            )}
                            <div className="min-w-0">
                              <p className="font-medium text-gray-900 truncate">
                                {invoice.customerName}
                              </p>
                              <div className="flex items-center gap-1">
                                <p className="text-xs text-gray-500">
                                  #{invoice.invoiceNumber}
                                  {(invoice.revision ?? 1) > 1 && (
                                    <span className="ml-1 font-medium text-amber-700">Rev {invoice.revision}</span>
                                  )}
                                </p>
                                {history.length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => toggleHistory(invoice.id)}
                                    className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                                    aria-label={isExpanded ? "Hide version history" : `Show ${history.length} prior version${history.length !== 1 ? "s" : ""}`}
                                  >
                                    <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                                    {history.length}
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                          {renderActionsMenu(invoice)}
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            {getStatusBadge(invoice.status)}
                            {getSentBadge(invoice.sentAt)}
                            {renderQbIcon(invoice)}
                          </div>
                          <span className="font-bold text-gray-900">
                            {formatCurrency(invoice.totalAmount)}
                          </span>
                        </div>
                        {/* Task #1890 — the A/R position, condensed for a
                            narrow screen. Same numbers as the desktop
                            columns, same shared helpers. */}
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
                          <span data-testid={`ar-balance-mobile-${invoice.id}`}>
                            <span className="text-gray-400">Balance </span>
                            <span className={balanceIsFallbackOf(invoice) ? "" : "font-semibold text-gray-900"}>
                              {formatCurrency(balanceDueOf(invoice))}
                            </span>
                          </span>
                          <span data-testid={`ar-due-mobile-${invoice.id}`}>
                            <span className="text-gray-400">Due </span>
                            {invoice.effectiveDueDate ? formatDate(invoice.effectiveDueDate) : "—"}
                          </span>
                          <span data-testid={`ar-bucket-mobile-${invoice.id}`}>
                            {AGING_BUCKET_LABELS[agingBucketOf(invoice, nowForAr)]}
                          </span>
                        </div>
                        <div className="mt-1">
                          <ArFlagBadges invoice={invoice} now={nowForAr} variant="mobile-" />
                        </div>
                        <div
                          className="mt-1 text-xs text-gray-500"
                          data-testid={`ar-last-reminder-mobile-${invoice.id}`}
                        >
                          {`Last reminder ${
                            invoice.lastReminderAt ? formatDate(invoice.lastReminderAt) : "never"
                          } · Reminders ${invoice.reminderCount ?? 0}`}
                        </div>
                        {/* Task #1889 — same indicator as the desktop row. */}
                        <div className="mt-1">
                          <ArNoteIndicator invoice={invoice} variant="mobile-" />
                        </div>
                        {/* Task #1942 — the same named action the desktop row
                            offers, driven by the same server answer. */}
                        {canMarkSent && (
                          <div className="mt-2">
                            <InvoicePrimaryAction
                              invoiceId={invoice.id}
                              eligibility={eligibilityFor(invoice.id)}
                              now={nowForAr}
                              onSendInvoice={() =>
                                setPdfModal({
                                  id: invoice.id,
                                  number: invoice.invoiceNumber,
                                  email: invoice.customerEmail,
                                })
                              }
                              onRemind={() => {
                                setSelectedIds(new Set([invoice.id]));
                                setBatchReminderOpen(true);
                              }}
                            />
                          </div>
                        )}
                        <div
                          className="mt-2 text-xs text-gray-500"
                          title={periodRangeOf(invoice)}
                        >
                          {periodLabelOf(invoice)}
                        </div>
                      </CardContent>
                    </Card>
                    {/* Version history cards — collapsed by default */}
                    {isExpanded && history.map((prev) => (
                      <Card key={prev.id} className="border-amber-200 bg-amber-50 ml-4">
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs text-gray-500 italic truncate">
                                ↳ #{prev.invoiceNumber} Rev {prev.revision ?? 1} — {prev.customerName}
                              </p>
                            </div>
                            {getStatusBadge(prev.status)}
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <span className="text-xs text-gray-400 italic" title={periodRangeOf(prev)}>
                              {periodLabelOf(prev)}
                            </span>
                            <span className="text-xs text-gray-400 line-through">
                              {formatCurrency(prev.totalAmount)}
                            </span>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                    {isRowExpanded && (
                      <Card className="border-gray-200 bg-gray-50 mt-2">
                        <CardContent className="p-4">
                          <div
                            id={regionId}
                            role="region"
                            aria-labelledby={rowId}
                            data-testid={`invoice-row-expansion-mobile-${invoice.id}`}
                          >
                            <InvoiceRowExpansion
                              invoiceId={invoice.id}
                              invoiceNumber={invoice.invoiceNumber}
                              open
                              canReadReminders={canReadReminderHistory}
                              canReadArNotes={canReadArNotes}
                              testIdSuffix="-mobile"
                            />
                          </div>
                        </CardContent>
                      </Card>
                    )}
                    </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Task #532 — Load more pagination control */}
        {hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              data-testid="button-load-more-invoices"
            >
              {isFetchingNextPage ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Loading more invoices…
                </>
              ) : (
                <>Load more invoices</>
              )}
            </Button>
          </div>
        )}

        {/* Cancelled invoices — collapsible audit drawer, hidden from main list and totals */}
        {cancelledInvoices.length > 0 && (
          <div className="mt-8 border border-gray-200 rounded-lg bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => setCancelledExpanded((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-left bg-gray-50 hover:bg-gray-100 transition-colors"
              data-testid="button-cancelled-drawer-toggle"
              aria-expanded={cancelledExpanded}
            >
              <div className="flex items-center gap-2">
                <ChevronDown
                  className={`w-4 h-4 text-gray-500 transition-transform ${cancelledExpanded ? "rotate-180" : ""}`}
                />
                <span className="text-sm font-medium text-gray-700">
                  Cancelled ({cancelledInvoices.length})
                </span>
              </div>
              <span className="text-xs text-gray-400">Audit view — read only</span>
            </button>
            {cancelledExpanded && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-gray-50 hover:bg-gray-50">
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cancelledInvoices.map((invoice) => (
                      <TableRow key={invoice.id} className="text-gray-400 italic">
                        <TableCell className="whitespace-nowrap text-xs">
                          #{invoice.invoiceNumber}
                        </TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">
                          {invoice.customerName}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {periodLabelOf(invoice)}
                        </TableCell>
                        <TableCell className="text-right text-xs whitespace-nowrap line-through">
                          {formatCurrency(invoice.totalAmount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* PDF Preview Modal */}
      {pdfModal && (
        <InvoicePdfPreviewModal
          invoiceId={pdfModal.id}
          invoiceNumber={pdfModal.number}
          customerEmail={pdfModal.email}
          open={!!pdfModal}
          onOpenChange={(open) => { if (!open) setPdfModal(null); }}
          onExportCsv={
            canExportSingleCsv
              ? async () => {
                  const inv = invoices.find((i) => i.id === pdfModal.id);
                  if (inv) await handleExportSingleCsv(inv);
                }
              : undefined
          }
          isExportingCsv={exportingInvoiceId === pdfModal.id}
        />
      )}

      {/* Audit Modal */}
      {auditInvoice && (
        <InvoiceAuditModal
          open={!!auditInvoice}
          onClose={() => setAuditInvoice(null)}
          invoiceId={auditInvoice.id}
          invoiceLabel={auditInvoice.label}
          invoiceTotal={auditInvoice.total}
        />
      )}

      {/* Task #1425 — selection action bar (Task #1888: shared with the batch
          reminder send, so it shows whichever actions this user holds) */}
      {canSelectRows && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white shadow-lg">
          <div className="max-w-6xl mx-auto px-4 lg:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Button
                variant="ghost"
                size="sm"
                className="text-gray-500"
                onClick={clearSelection}
                data-testid="button-clear-selection"
              >
                <X className="w-4 h-4 mr-1" />
                Clear
              </Button>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900" data-testid="text-selection-count">
                  {selectedIds.size} selected · {formatCurrency(selectedTotal)}
                </p>
                {canMerge && !mergeValidation.ok && (
                  <p className="text-xs text-amber-600 truncate">{mergeValidation.reason}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Task #1888 — nothing is sent from this button. It opens the
                  confirmation list, which is where the send actually lives. */}
              {canBatchRemind && (
                <Button
                  variant={canMerge ? "outline" : "default"}
                  onClick={() => setBatchReminderOpen(true)}
                  data-testid="button-batch-remind"
                >
                  <Send className="w-4 h-4 mr-2" />
                  Send reminders
                </Button>
              )}
              {canMerge && (
                <Button
                  onClick={openMergeConfirm}
                  disabled={!mergeValidation.ok}
                  data-testid="button-merge-invoices"
                >
                  <GitMerge className="w-4 h-4 mr-2" />
                  Merge invoices
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Task #1888 — batch reminders. Opening this sends nothing: it previews
          every selected invoice and waits for a human to confirm. */}
      {canBatchRemind && (
        <BatchReminderDialog
          open={batchReminderOpen}
          onOpenChange={setBatchReminderOpen}
          invoiceIds={Array.from(selectedIds)}
          onSent={clearSelection}
        />
      )}

      {/* Task #1425 — merge confirmation dialog */}
      <Dialog open={canMerge && mergeConfirmOpen} onOpenChange={(open) => { if (!open) setMergeConfirmOpen(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Merge invoices</DialogTitle>
            <DialogDescription>
              Choose the invoice to keep. The others will be combined into it and
              marked cancelled (kept for audit). This does not touch QuickBooks.
            </DialogDescription>
          </DialogHeader>

          {mergeValidation.ok && (
            <div className="space-y-4">
              <RadioGroup
                value={survivingId != null ? String(survivingId) : undefined}
                onValueChange={(v) => setSurvivingId(Number(v))}
              >
                <p className="text-sm font-medium text-gray-700">Keep this invoice</p>
                {selectedInvoices.map((inv) => (
                  <label
                    key={inv.id}
                    htmlFor={`survivor-${inv.id}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-gray-200 p-3 cursor-pointer hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <RadioGroupItem
                        value={String(inv.id)}
                        id={`survivor-${inv.id}`}
                        data-testid={`radio-survivor-${inv.id}`}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          #{inv.invoiceNumber}
                        </p>
                        <p className="text-xs text-gray-500 truncate">{inv.customerName}</p>
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-gray-700 flex-shrink-0">
                      {formatCurrency(inv.totalAmount)}
                    </span>
                  </label>
                ))}
              </RadioGroup>

              <div className="flex items-center justify-between rounded-md bg-blue-50 border border-blue-200 px-4 py-2">
                <span className="text-sm text-blue-700">Combined total</span>
                <span className="text-base font-bold text-blue-800">
                  {formatCurrency(selectedTotal)}
                </span>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMergeConfirmOpen(false)}
              disabled={mergeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmMerge}
              disabled={!mergeValidation.ok || survivingId == null || mergeMutation.isPending}
              data-testid="button-confirm-merge"
            >
              {mergeMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Merging…
                </>
              ) : (
                <>
                  <GitMerge className="w-4 h-4 mr-2" />
                  Merge {selectedInvoices.length} invoices
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Re-sync confirmation. The backend updates the existing QB invoice
          in-place (DocNumber-first lookup → sparse update). No duplicate is
          created; the old QB invoice is NOT deleted or voided. */}
      <Dialog
        open={canManageQuickBooks && resyncInvoice != null}
        onOpenChange={(open) => {
          if (!open) {
            setResyncInvoice(null);
            setResyncQbAuthError(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Re-sync #{resyncInvoice?.invoiceNumber} to QuickBooks</DialogTitle>
            <DialogDescription>
              {resyncInvoice
                ? `Updates the existing QuickBooks invoice for #${resyncInvoice.invoiceNumber} in place with the current totals — same QB invoice, corrected amount, no duplicate.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {resyncQbAuthError && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 space-y-2 mx-1">
              <div className="flex gap-2 items-start">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>QuickBooks not connected.</strong> Your session has expired — reconnect QuickBooks in Settings and retry.
                </span>
              </div>
              <a
                href="/quickbooks"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700"
              >
                Go to QuickBooks Settings →
              </a>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResyncInvoice(null); setResyncQbAuthError(false); }}>
              {resyncQbAuthError ? "Close" : "Cancel"}
            </Button>
            {!resyncQbAuthError && (
            <Button
              disabled={syncMutation.isPending}
              onClick={() => {
                if (!resyncInvoice) return;
                setResyncQbAuthError(false);
                syncMutation.mutate(
                  { id: resyncInvoice.id, force: true },
                  { onSuccess: () => setResyncInvoice(null) },
                );
              }}
            >
              {syncMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Updating…
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Update QuickBooks invoice
                </>
              )}
            </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task #1710 — Invoice Correction & Reissue flow */}
      {correctionInvoice && (
        <InvoiceCorrectionFlow
          invoice={correctionInvoice}
          open={canCorrect && correctionInvoice != null}
          onClose={() => setCorrectionInvoice(null)}
        />
      )}

      {/* Task #1811 — Draft ticket editor sheet */}
      <Sheet
        open={canBillingEdit && draftEditorInvoice != null}
        onOpenChange={(open) => { if (!open) setDraftEditorInvoice(null); }}
      >
        <SheetContent className="sm:max-w-xl w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              Edit draft invoice #{draftEditorInvoice?.invoiceNumber}
            </SheetTitle>
            <SheetDescription>
              Add or remove tickets, then finalize to generate the invoice.
            </SheetDescription>
          </SheetHeader>

          {draftEditorInvoice && (
            <div className="mt-6 space-y-6">
              {/* Live total */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-gray-500">Current total</span>
                <span className="text-lg font-semibold text-gray-900">
                  ${parseFloat(draftEditorInvoice.totalAmount).toFixed(2)}
                </span>
              </div>

              {/* Period metadata fields — editable on draft invoices */}
              <div className="space-y-3 border border-gray-200 rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-700">Period & labels</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-gray-500">Period start</label>
                    <Input
                      type="date"
                      className="h-8 text-xs"
                      value={draftPeriodStart}
                      onChange={(e) => setDraftPeriodStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-gray-500">Period end</label>
                    <Input
                      type="date"
                      className="h-8 text-xs"
                      value={draftPeriodEnd}
                      onChange={(e) => setDraftPeriodEnd(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-gray-500">Due date</label>
                    <Input
                      type="date"
                      className="h-8 text-xs"
                      value={draftDueDate}
                      onChange={(e) => setDraftDueDate(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-gray-500">Notes</label>
                  <textarea
                    className="w-full text-xs border border-input rounded-md px-3 py-2 min-h-[60px] resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                    value={draftNotes}
                    onChange={(e) => setDraftNotes(e.target.value)}
                    placeholder="Internal notes…"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={draftMetaSaveMutation.isPending}
                  onClick={() => {
                    if (!draftEditorInvoice) return;
                    draftMetaSaveMutation.mutate({
                      id: draftEditorInvoice.id,
                      ...(draftPeriodStart ? { periodStart: draftPeriodStart } : {}),
                      ...(draftPeriodEnd ? { periodEnd: draftPeriodEnd } : {}),
                      dueDate: draftDueDate || null,
                      notes: draftNotes,
                    });
                  }}
                >
                  {draftMetaSaveMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                  ) : null}
                  Save metadata
                </Button>
              </div>

              {/* Attached tickets — the shared read-only line-item list, with
                  the draft editor's own per-row Remove passed in.
                  Task #1918: the rows themselves are rendered by
                  InvoiceLineItemsList so the expanded row on the list and this
                  editor cannot drift apart. The remove button stays here
                  because the mutation does. */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-700">Attached tickets</h3>
                <InvoiceLineItemsList
                  items={draftItems}
                  isLoading={draftItemsLoading}
                  testId="draft-line-items"
                  renderRowAction={(item) => {
                    const ticketId = ticketIdOf(item);
                    const isRemoving =
                      removeTicketMutation.isPending &&
                      removeTicketMutation.variables?.ticketId === ticketId &&
                      removeTicketMutation.variables?.ticketType === item.sourceType;
                    const isLast = draftItems.length === 1;
                    return (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50 shrink-0"
                        disabled={isRemoving || isLast}
                        title={isLast ? "Cannot remove the last ticket — void the invoice instead" : "Remove ticket"}
                        onClick={() => {
                          if (!draftEditorInvoice) return;
                          removeTicketMutation.mutate({
                            invoiceId: draftEditorInvoice.id,
                            ticketType: item.sourceType as "billing_sheet" | "work_order" | "wet_check_billing",
                            ticketId,
                          });
                        }}
                      >
                        {isRemoving ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </Button>
                    );
                  }}
                />
              </div>

              {/* Add a ticket */}
              <div className="space-y-3 border border-blue-100 bg-blue-50 rounded-lg p-4">
                <h3 className="text-sm font-medium text-blue-800 flex items-center gap-1.5">
                  <CheckSquare className="w-3.5 h-3.5" />
                  Add a ticket
                </h3>
                <p className="text-xs text-blue-700">
                  Ticket must belong to the same customer and not be attached to another invoice.
                </p>
                <div className="flex gap-2">
                  <Select
                    value={addTicketType}
                    onValueChange={(v) => setAddTicketType(v as typeof addTicketType)}
                  >
                    <SelectTrigger className="w-44 text-xs h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="billing_sheet">Billing Sheet</SelectItem>
                      <SelectItem value="work_order">Work Order</SelectItem>
                      <SelectItem value="wet_check_billing">WC Billing</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    className="w-24 text-xs h-8"
                    placeholder="ID"
                    value={addTicketId}
                    onChange={(e) => setAddTicketId(e.target.value)}
                    type="number"
                    min={1}
                  />
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={!addTicketId || isNaN(parseInt(addTicketId)) || addTicketMutation.isPending}
                    onClick={() => {
                      const tid = parseInt(addTicketId);
                      if (!tid || !draftEditorInvoice) return;
                      addTicketMutation.mutate({
                        invoiceId: draftEditorInvoice.id,
                        ticketType: addTicketType,
                        ticketId: tid,
                      });
                    }}
                  >
                    {addTicketMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      "Add"
                    )}
                  </Button>
                </div>
              </div>

              {/* Finalize */}
              <div className="pt-2 border-t border-gray-200">
                <Button
                  className="w-full"
                  disabled={finalizeMutation.isPending}
                  onClick={() => {
                    if (!draftEditorInvoice) return;
                    finalizeMutation.mutate(draftEditorInvoice.id, {
                      onSuccess: () => setDraftEditorInvoice(null),
                    });
                  }}
                  data-testid="button-finalize-from-draft-editor"
                >
                  {finalizeMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Finalizing…
                    </>
                  ) : (
                    <>
                      <CheckSquare className="w-4 h-4 mr-2" />
                      Finalize invoice
                    </>
                  )}
                </Button>
                <p className="text-xs text-gray-400 text-center mt-2">
                  Recomputes totals and syncs to QuickBooks.
                </p>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Task #1811 — Edit invoice metadata dialog */}
      <Dialog
        open={canBillingEdit && editMetadataInvoice != null}
        onOpenChange={(open) => { if (!open) setEditMetadataInvoice(null); }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit invoice #{editMetadataInvoice?.invoiceNumber}</DialogTitle>
            <DialogDescription>
              Update notes, due date, or billing period. Changes do not re-sync to QuickBooks automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea
                id="edit-notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Internal notes visible on the invoice…"
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-due-date">Due date</Label>
              <Input
                id="edit-due-date"
                type="date"
                value={editDueDate}
                onChange={(e) => setEditDueDate(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-period-start">Period start</Label>
                <Input
                  id="edit-period-start"
                  type="date"
                  value={editPeriodStart}
                  onChange={(e) => setEditPeriodStart(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-period-end">Period end</Label>
                <Input
                  id="edit-period-end"
                  type="date"
                  value={editPeriodEnd}
                  onChange={(e) => setEditPeriodEnd(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditMetadataInvoice(null)}
              disabled={metadataPatchMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={metadataPatchMutation.isPending}
              onClick={() => {
                if (!editMetadataInvoice) return;
                metadataPatchMutation.mutate({
                  id: editMetadataInvoice.id,
                  notes: editNotes || undefined,
                  dueDate: editDueDate || null,
                  periodStart: editPeriodStart || undefined,
                  periodEnd: editPeriodEnd || undefined,
                });
              }}
              data-testid="button-save-invoice-metadata"
            >
              {metadataPatchMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task #1811 — Void & Release confirmation dialog */}
      <Dialog
        open={canBillingEdit && voidConfirmInvoice != null}
        onOpenChange={(open) => {
          if (!open) {
            setVoidConfirmInvoice(null);
            setVoidQbAction(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-red-700">
              Void invoice #{voidConfirmInvoice?.invoiceNumber}?
            </DialogTitle>
            <DialogDescription>
              This will cancel the invoice and release all attached tickets back to the billing queue.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {voidConfirmInvoice?.quickbooksInvoiceId && (
            <div className="space-y-3 border border-amber-200 bg-amber-50 rounded-lg p-3">
              <p className="text-sm font-medium text-amber-800 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 shrink-0" />
                This invoice is synced to QuickBooks. How should we handle it?
              </p>
              <RadioGroup
                value={voidQbAction ?? ""}
                onValueChange={(v) => setVoidQbAction(v as "void" | "unlink")}
                className="space-y-2"
              >
                <label
                  htmlFor="qb-void"
                  className="flex items-start gap-2 cursor-pointer"
                >
                  <RadioGroupItem value="void" id="qb-void" className="mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-gray-800">Acknowledge QB void</p>
                    <p className="text-xs text-gray-500">Mark that the QB invoice will be voided manually in QuickBooks Online.</p>
                  </div>
                </label>
                <label
                  htmlFor="qb-unlink"
                  className="flex items-start gap-2 cursor-pointer"
                >
                  <RadioGroupItem value="unlink" id="qb-unlink" className="mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-gray-800">Unlink only (leave QB untouched)</p>
                    <p className="text-xs text-gray-500">Cancel only in IrrigoPro. The QuickBooks invoice remains unchanged.</p>
                  </div>
                </label>
              </RadioGroup>
            </div>
          )}

          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            All {voidConfirmInvoice?.quickbooksInvoiceId ? "QB-synced " : ""}tickets will be released back to "Approved — passed to billing" status.
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setVoidConfirmInvoice(null); setVoidQbAction(null); }}
              disabled={voidMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                voidMutation.isPending ||
                (!!voidConfirmInvoice?.quickbooksInvoiceId && !voidQbAction)
              }
              onClick={confirmVoid}
              data-testid="button-confirm-void-invoice"
            >
              {voidMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Voiding…
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Void invoice
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
