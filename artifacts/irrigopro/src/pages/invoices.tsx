import { useState, useMemo, useEffect, useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import {
  hasCapability,
  CAN_EDIT_INVOICES,
  CAN_SEND_INVOICE_EMAIL,
  CAN_VIEW_COSTS,
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
  Search,
  Calendar,
  FileText,
  CheckCircle2,
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronDown,
  DollarSign,
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
import { FinancialPulseWidget } from "@/components/financial-pulse/financial-pulse-widget";
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

// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const CSV_EXPORT_ROLES = new Set([
  "company_admin",
  "billing_manager",
]);

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

function formatCurrency(amount: string | number) {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
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
      return <Badge className="bg-gray-100 text-gray-800">{status}</Badge>;
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

// Task #708 — A/R aging filter values mirror the
// `/api/financial-pulse/ar-aging` bucket keys (with `days90Plus`
// matching the inclusive 90+ bucket). The mapping lives here so the
// widget can deep-link via `?aging=`.
// Task #1833 — labels updated to "days past due" framing to match
// the updated computeArAging bucket labels.
type AgingFilter = "all" | "current" | "days30" | "days60" | "days90Plus";
const AGING_OPTIONS: { value: AgingFilter; label: string }[] = [
  { value: "all", label: "All ages" },
  { value: "current", label: "Not yet due" },
  { value: "days30", label: "1–30 days overdue" },
  { value: "days60", label: "31–60 days overdue" },
  { value: "days90Plus", label: "60+ days overdue" },
];

function parseAging(search: string): AgingFilter {
  const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("aging");
  if (v === "current" || v === "days30" || v === "days60" || v === "days90Plus") {
    return v;
  }
  return "all";
}

function readAgingFromUrl(): AgingFilter {
  if (typeof window === "undefined") return "all";
  return parseAging(window.location.search);
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
  // Prefer the pre-computed effective due date the API returns (Task #1833).
  // Fall back through explicit dueDate, then a safe net_30 approximation so
  // this function stays safe on cached/stale payloads that pre-date the field.
  const due = inv.effectiveDueDate
    ? new Date(inv.effectiveDueDate)
    : inv.dueDate
      ? new Date(inv.dueDate)
      : new Date(new Date(inv.createdAt).getTime() + 30 * 86_400_000);
  return (now.getTime() - due.getTime()) / 86_400_000;
}

function matchesAging(inv: Invoice, filter: AgingFilter, now: Date): boolean {
  if (filter === "all") return true;
  if (!isOpenAr(inv)) return false;
  // `paidAt` may or may not be on the wire — guard it.
  if ((inv as unknown as { paidAt?: string | null }).paidAt) return false;
  // Skip fully-paid records even if status hasn't caught up.
  if (inv.paymentStatus === "paid") return false;
  const dpd = daysPastDue(inv, now);
  switch (filter) {
    case "current":
      return dpd < 0;           // not yet past due
    case "days30":
      return dpd >= 0 && dpd < 30;   // 1–30 days overdue
    case "days60":
      return dpd >= 30 && dpd < 60;  // 31–60 days overdue
    case "days90Plus":
      return dpd >= 60;              // 61–90+ days overdue
  }
}

export default function InvoicesPage() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [monthFilter, setMonthFilter] = useState("all");
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
  const [agingFilter, setAgingFilter] = useState<AgingFilter>(() => readAgingFromUrl());
  useEffect(() => {
    const next = parseAging(search ?? "");
    setAgingFilter((prev) => (prev === next ? prev : next));
  }, [search]);
  const [sort, setSort] = useState<SortState | null>(null);
  const [cancelledExpanded, setCancelledExpanded] = useState(false);
  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };
  const [pdfModal, setPdfModal] = useState<{ id: number; number: string; email: string } | null>(null);
  const [auditInvoice, setAuditInvoice] = useState<{ id: number; label: string; total: string } | null>(null);
  const [exportingInvoiceId, setExportingInvoiceId] = useState<number | null>(null);
  const userRole = getCurrentUserRole();
  const canExportSingleCsv = !!userRole && CSV_EXPORT_ROLES.has(userRole);
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

  // Task #1425 — invoice merge selection. `selectedIds` holds the invoices
  // ticked for merging; `survivingId` is the chosen survivor in the confirm
  // dialog; `mergeConfirmOpen` toggles that dialog.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
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
  const { data: draftItemsData, isLoading: draftItemsLoading } = useQuery<{ items: Array<{
    id: number;
    sourceType: string;
    billingSheetId: number | null;
    workOrderId: number | null;
    wetCheckBillingId: number | null;
    description: string;
    totalPrice: string;
  }> }>({
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
  const {
    data: invoicePages,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<{ rows: Invoice[]; total: number; nextOffset: number | null }>({
    queryKey: ["/api/invoices", { paginated: true, pageSize: PAGE_SIZE }],
    initialPageParam: 0,
    queryFn: async ({ pageParam = 0 }) => {
      const offset = Number(pageParam) || 0;
      const res = await fetch(`/api/invoices?limit=${PAGE_SIZE}&offset=${offset}`);
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

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      result = result.filter(
        (inv) =>
          inv.customerName.toLowerCase().includes(q) ||
          inv.invoiceNumber.toLowerCase().includes(q)
      );
    }

    if (monthFilter !== "all") {
      const [filterYear, filterMonth] = monthFilter.split("-").map(Number);
      result = result.filter(
        (inv) => inv.invoiceYear === filterYear && inv.invoiceMonth === filterMonth
      );
    }

    if (agingFilter !== "all") {
      const now = new Date();
      result = result.filter((inv) => matchesAging(inv, agingFilter, now));
    }

    return result;
  }, [invoices, searchTerm, monthFilter, agingFilter]);

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

  // Superseded invoices are kept in activeFilteredInvoices so they can be shown as
  // version history beneath their replacement; exclude them from every total.
  // Cancelled invoices are already excluded by activeFilteredInvoices.
  const totalBilled = activeFilteredInvoices
    .filter((inv) => inv.status !== "superseded")
    .reduce((sum, inv) => sum + parseFloat(inv.totalAmount), 0);

  const monthOptions = generateMonthOptions();

  // Task #1425 — an invoice is mergeable only when it isn't already cancelled.
  const isMergeable = (inv: Invoice) => inv.status !== "cancelled";

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

  const selectedTotal = selectedInvoices.reduce(
    (sum, inv) => sum + (parseFloat(inv.totalAmount) || 0),
    0,
  );

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

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
        monthFilter !== "all"
          ? `monthly-invoices-${monthFilter}.csv`
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
        {/* Task #1886 — /api/invoices/:id/sync-quickbooks is WRITE-guarded
            (requireInvoiceWrite), so both branches are gated on
            CAN_EDIT_INVOICES. Managing the QuickBooks *integration* is a
            bookkeeper capability; pushing invoice content into it is not. */}
        {canBillingEdit &&
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
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <Link href="/">
              <Button variant="ghost" size="sm" className="text-gray-500 hover:text-gray-700 p-1 h-auto">
                <ChevronLeft className="w-4 h-4 mr-1" />
                Dashboard
              </Button>
            </Link>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                <FileText className="w-6 h-6 text-blue-600" />
                Monthly Invoices
              </h1>
              <p className="text-sm text-gray-500 mt-0.5">All invoices sent across all customers</p>
            </div>
            <div className="flex items-center gap-3">
              {/* Task #1886 — write-classified: this stamps payment state. */}
              {canBillingEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => paymentSyncMutation.mutate()}
                  disabled={paymentSyncMutation.isPending}
                  data-testid="button-refresh-payment-status"
                  title="Refresh payment status from QuickBooks"
                >
                  {paymentSyncMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-2" />
                  )}
                  Refresh QB Payments
                </Button>
              )}
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
              {activeFilteredInvoices.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-right">
                  <div className="text-xs text-blue-600 font-medium">Total Billed</div>
                  <div className="text-lg font-bold text-blue-800">{formatCurrency(totalBilled)}</div>
                  <div className="text-xs text-blue-500">{activeFilteredInvoices.length} invoice{activeFilteredInvoices.length !== 1 ? "s" : ""}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Task #708 — A/R Aging widget. Bucket clicks deep-link
            back to this page with `?aging=<key>`, which hydrates the
            aging filter below. */}
        {canViewCosts && (
          <div className="mb-6">
            <FinancialPulseWidget variant="ar-aging" />
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="Search by customer name or invoice number..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger className="w-full sm:w-52">
              <Calendar className="w-4 h-4 mr-2 text-gray-400" />
              <SelectValue placeholder="All months" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Months</SelectItem>
              {monthOptions.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={agingFilter}
            onValueChange={(v) => setAgingFilter(v as AgingFilter)}
          >
            <SelectTrigger
              className="w-full sm:w-52"
              data-testid="invoices-aging-filter"
            >
              <AlertCircle className="w-4 h-4 mr-2 text-gray-400" />
              <SelectValue placeholder="All ages" />
            </SelectTrigger>
            <SelectContent>
              {AGING_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Empty state */}
        {groups.length === 0 && (
          <Card>
            <CardContent className="p-12 text-center">
              <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p className="font-medium text-gray-500">No invoices found</p>
              <p className="text-sm text-gray-400 mt-1">
                {searchTerm || monthFilter !== "all"
                  ? "Try adjusting your filters."
                  : "Invoices will appear here once they are generated."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Grouped invoice list */}
        <div className="space-y-8">
          {groups.map((group) => {
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
                {/* Month Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-blue-600" />
                    <h2 className="text-base font-semibold text-gray-800">{group.label}</h2>
                    <Badge variant="secondary" className="text-xs">
                      {activeInvoices.length} invoice{activeInvoices.length !== 1 ? "s" : ""}
                    </Badge>
                  </div>
                  <span className="text-sm font-semibold text-gray-700">{formatCurrency(groupTotal)}</span>
                </div>

                {/* Invoice Table — desktop (Task #1439: compacted to
                    fit one view; QuickBooks folded into a status icon,
                    period shortened, row actions in a ⋯ menu). */}
                <div className="hidden md:block rounded-lg border border-gray-200 bg-white overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-gray-50 hover:bg-gray-50">
                        {canMerge && <TableHead className="w-8" />}
                        <SortableHeader sortKey="customer" label="Customer" sort={sort} onSort={toggleSort} />
                        <SortableHeader sortKey="invoiceNumber" label="Invoice #" sort={sort} onSort={toggleSort} />
                        <SortableHeader sortKey="status" label="Status" sort={sort} onSort={toggleSort} />
                        <SortableHeader sortKey="amount" label="Amount" sort={sort} onSort={toggleSort} align="right" />
                        <SortableHeader sortKey="period" label="Period" sort={sort} onSort={toggleSort} />
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedInvoices(activeInvoices).map((invoice) => {
                        const history = predecessorsFor(invoice.id);
                        const isExpanded = expandedHistory.has(invoice.id);
                        return (
                        <>
                        <TableRow key={invoice.id} className="hover:bg-gray-50">
                          {canMerge && (
                            <TableCell className="w-8">
                              {isMergeable(invoice) && (
                                <Checkbox
                                  checked={selectedIds.has(invoice.id)}
                                  onCheckedChange={() => toggleSelected(invoice.id)}
                                  aria-label={`Select invoice ${invoice.invoiceNumber} for merge`}
                                  data-testid={`checkbox-merge-invoice-${invoice.id}`}
                                />
                              )}
                            </TableCell>
                          )}
                          <TableCell className="font-medium text-gray-900 whitespace-nowrap max-w-[200px] truncate">
                            {invoice.customerName}
                          </TableCell>
                          <TableCell className="text-gray-600 whitespace-nowrap">
                            <div className="flex items-center gap-1">
                            #{invoice.invoiceNumber}
                            {(invoice.revision ?? 1) > 1 && (
                              <span className="text-xs font-medium text-amber-700 bg-amber-100 px-1 py-0.5 rounded">
                                Rev {invoice.revision}
                              </span>
                            )}
                            {(() => {
                              const mergedCount = history.filter((p) => p.status === "merged").length;
                              return mergedCount > 0 ? (
                                <span className="text-xs font-medium text-purple-700 bg-purple-100 px-1 py-0.5 rounded">
                                  Merged from {mergedCount}
                                </span>
                              ) : null;
                            })()}
                            {history.length > 0 && (
                              <button
                                type="button"
                                onClick={() => toggleHistory(invoice.id)}
                                className="ml-1 text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                                title={isExpanded ? "Hide version history" : "Show version history"}
                                aria-label={isExpanded ? "Hide version history" : `Show ${history.length} prior version${history.length !== 1 ? "s" : ""}`}
                              >
                                <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                                {history.length}
                              </button>
                            )}
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {getStatusBadge(invoice.status)}
                              {getSentBadge(invoice.sentAt)}
                              {invoice.isOverdue && (
                                <Badge className="bg-red-100 text-red-800 text-xs" data-testid={`overdue-badge-${invoice.id}`}>Overdue</Badge>
                              )}
                              {invoice.paymentStatus === "partially_paid" && (
                                <Badge className="bg-amber-100 text-amber-800 text-xs" data-testid={`partial-badge-${invoice.id}`}>Partial</Badge>
                              )}
                              {invoice.paymentSyncedAt && invoice.paymentStatus === "unpaid" && !invoice.qbVoidDetectedAt && (
                                <Badge className="bg-gray-100 text-gray-700 text-xs" data-testid={`unpaid-badge-${invoice.id}`}>Unpaid</Badge>
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
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-bold text-gray-900 whitespace-nowrap">
                            {invoice.paymentStatus === "partially_paid" && invoice.balance != null ? (
                              <span title={`Total: ${formatCurrency(invoice.totalAmount)}`}>
                                <span className="text-amber-700">{formatCurrency(invoice.balance)}</span>
                                <span className="text-xs text-gray-400 ml-1">due</span>
                              </span>
                            ) : formatCurrency(invoice.totalAmount)}
                          </TableCell>
                          <TableCell
                            className="text-xs text-gray-600 whitespace-nowrap"
                            title={periodRangeOf(invoice)}
                          >
                            {periodLabelOf(invoice)}
                          </TableCell>
                          <TableCell className="text-right">
                            {renderActionsMenu(invoice)}
                          </TableCell>
                        </TableRow>
                        {/* Version history rows — shown when the user expands the chain */}
                        {isExpanded && history.map((prev) => (
                          <TableRow key={prev.id} className="bg-amber-50 text-xs text-gray-400 italic">
                            {canMerge && <TableCell />}
                            <TableCell className="whitespace-nowrap max-w-[200px] truncate pl-8">
                              {prev.customerName}
                            </TableCell>
                            <TableCell className="whitespace-nowrap pl-6">
                              ↳ #{prev.invoiceNumber}
                              {(prev.revision ?? 1) >= 1 && (
                                <span className="ml-1 text-xs text-gray-400">Rev {prev.revision ?? 1}</span>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {getStatusBadge(prev.status)}
                            </TableCell>
                            <TableCell className="text-right whitespace-nowrap line-through">
                              {formatCurrency(prev.totalAmount)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap" title={periodRangeOf(prev)}>
                              {periodLabelOf(prev)}
                            </TableCell>
                            <TableCell />
                          </TableRow>
                        ))}
                        </>
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
                    return (
                    <div key={invoice.id} className="space-y-0">
                    <Card className="border-gray-200">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {canMerge && isMergeable(invoice) && (
                              <Checkbox
                                checked={selectedIds.has(invoice.id)}
                                onCheckedChange={() => toggleSelected(invoice.id)}
                                aria-label={`Select invoice ${invoice.invoiceNumber} for merge`}
                                data-testid={`checkbox-merge-invoice-mobile-${invoice.id}`}
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

      {/* Task #1425 — merge selection action bar */}
      {canMerge && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white shadow-lg">
          <div className="max-w-6xl mx-auto px-4 lg:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Button
                variant="ghost"
                size="sm"
                className="text-gray-500"
                onClick={clearSelection}
                data-testid="button-clear-merge-selection"
              >
                <X className="w-4 h-4 mr-1" />
                Clear
              </Button>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {selectedIds.size} selected · {formatCurrency(selectedTotal)}
                </p>
                {!mergeValidation.ok && (
                  <p className="text-xs text-amber-600 truncate">{mergeValidation.reason}</p>
                )}
              </div>
            </div>
            <Button
              onClick={openMergeConfirm}
              disabled={!mergeValidation.ok}
              data-testid="button-merge-invoices"
            >
              <GitMerge className="w-4 h-4 mr-2" />
              Merge invoices
            </Button>
          </div>
        </div>
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
        open={canBillingEdit && resyncInvoice != null}
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

              {/* Attached tickets — live item list with per-row Remove */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-700">Attached tickets</h3>
                {draftItemsLoading ? (
                  <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Loading…
                  </div>
                ) : draftItems.length === 0 ? (
                  <p className="text-xs text-gray-400">No tickets attached yet.</p>
                ) : (
                  <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
                    {draftItems.map((item) => {
                      const typeLabel =
                        item.sourceType === "billing_sheet" ? "BS"
                        : item.sourceType === "work_order" ? "WO"
                        : "WCB";
                      const ticketId =
                        item.billingSheetId ?? item.workOrderId ?? item.wetCheckBillingId ?? 0;
                      const isRemoving =
                        removeTicketMutation.isPending &&
                        removeTicketMutation.variables?.ticketId === ticketId &&
                        removeTicketMutation.variables?.ticketType === item.sourceType;
                      const isLast = draftItems.length === 1;
                      return (
                        <li
                          key={item.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 bg-white text-sm"
                        >
                          <span className="shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600">
                            {typeLabel} #{ticketId}
                          </span>
                          <span className="flex-1 text-xs text-gray-700 truncate" title={item.description}>
                            {item.description}
                          </span>
                          <span className="shrink-0 text-xs font-medium text-gray-900">
                            ${parseFloat(item.totalPrice || "0").toFixed(2)}
                          </span>
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
                        </li>
                      );
                    })}
                  </ul>
                )}
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
