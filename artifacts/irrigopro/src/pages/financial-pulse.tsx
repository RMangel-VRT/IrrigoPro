// Task #688 — Financial Pulse Slice 2.
// Task #692, #693, #708, #720, #731 — subsequent slices.
// Task #817 — Aesthetic makeover: gradient header, accent tiles, chart palette.
//
// /financial-pulse page — two-tab layout (Task #731):
//   Pulse tab:      daily-ops KPI tiles, revenue trend, in-flight by customer/tech
//   Accounting tab: existing KPI snapshot, charts, drill-downs, forward look

import irrigoLogoUrl from "@assets/irrigopro - logo - BLUE - FINAL_1756061385150.png";
import { useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RefreshCw,
  AlertTriangle,
  Download,
  MoreHorizontal,
  ArrowUpDown,
  Search,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { MetricTile } from "@/components/financial-pulse/metric-tile";
import {
  compareCustomers,
  type CustomerSortKey,
  type SortDir,
} from "./financial-pulse-customer-sort";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as ReTooltip,
  Legend,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from "recharts";

type Period = "mtd" | "ytd";

interface KpiTile {
  value: number | null;
  deltaPct?: number | null;
  comparedTo?: string;
}
interface MarginTile extends KpiTile {
  missingWageTechCount?: number;
  estimatedLaborCostShortfall?: number;
}
interface BilledLastCycleTile extends KpiTile {
  monthLabel: string;
  monthIso: string;
}
interface KpisResponse {
  billedMtd: KpiTile;
  billedLastCycle: BilledLastCycleTile;
  billedYtd: KpiTile;
  collectedMtd: KpiTile;
  outstandingAr: KpiTile;
  unbilledExposure: KpiTile;
  projectedMonthEnd: KpiTile & { method: string };
  avgDaysToPay: KpiTile;
  grossMarginPct: MarginTile;
  period: Period;
  asOf: string;
}
interface TrendPoint {
  month: string;
  revenue: number;
  partsRevenue: number;
  laborRevenue: number;
  prevYearRevenue: number;
}
interface TrendResponse {
  series: TrendPoint[];
}
interface MixResponse {
  partsVsLabor: { parts: number; labor: number };
  emergencyVsStandard: { emergency: number; standard: number };
  contractVsAdhoc: { contract: number; adhoc: number };
}

// ─── Slice 3 (Task #692) ──────────────────────────────────────────────────
type BudgetStatus = "unset" | "healthy" | "approaching" | "over";

interface TopCustomerRow {
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
interface TopCustomersResponse {
  rows: TopCustomerRow[];
  total: number;
  period: Period;
  sort: "revenue" | "budget_risk";
}
interface TechnicianRow {
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
interface ByTechResponse {
  rows: TechnicianRow[];
  period: Period;
}
interface ServiceTypeRow {
  key: "emergency" | "standard" | "contract" | "adhoc";
  label: string;
  revenue: number;
  pctOfTotal: number | null;
  invoiceCount: number;
  avgTicket: number | null;
}
interface ByServiceTypeResponse {
  rows: ServiceTypeRow[];
  period: Period;
}
interface ArAgingBucket {
  key: "current" | "days30" | "days60" | "days90";
  label: string;
  amount: number;
  count: number;
}
interface ArAgingResponse {
  buckets: ArAgingBucket[];
  total: number;
}
interface ProjectionsResponse {
  mtd: number;
  projectedMonthEnd: number;
  prevMonthActual: number;
  prevMonthSameDay: number;
  daysElapsed: number;
  daysInMonth: number;
  method: string;
}

// ─── Slice 5.3: Pulse tab types (Task #731) ──────────────────────────────
type PulseTabKey = "pulse" | "accounting";
type PulseSortKey = "name" | "inFlight" | "ytd";

interface PulseLastCycle {
  value: number;
  monthLabel: string;
  monthIso: string;
  invoiceCount: number;
}
interface PulseInFlight {
  value: number;
  customerCount: number;
  techCount: number;
}
interface PulseCustomerRow {
  customerId: number;
  name: string;
  inFlight: number;
  ytd: number;
  budgetStatus: BudgetStatus;
  monthlyCap: number | null;
  monthlySpend: number;
}
interface PulseTechRow {
  technicianId: number;
  name: string;
  inFlight: number;
  ytd: number;
}
interface PulseSummaryResponse {
  lastCycle: PulseLastCycle;
  inFlight: PulseInFlight;
  yearToDate: { value: number };
  customers: PulseCustomerRow[];
  technicians: PulseTechRow[];
  asOf: string;
}

// QuickBooks connection-status payload shape. Matches the
// `/api/quickbooks/connection` contract used by
// `components/quickbooks/quickbooks-integration.tsx` — see
// `QbConnectionStatus` there. We treat the response as a partial
// payload because the endpoint can return `{}` on transient failures
// (queryFn catches the error above) and we don't want banner state
// to flip when a field is missing.
export interface QbStatusPayload {
  isConnected?: boolean;
  connectionStatus?: string;
  reconnectRequiredReason?: string;
}

// Statuses that indicate sync is NOT healthy and the banner must show.
// Mirrors the backend semantics in routes.ts where token-refresh
// failures persist `reconnect_required`, and the integration UI which
// treats `error` as a degraded state. `disconnected` / `expired` are
// kept for back-compat with older responses.
const QB_BAD_STATUSES = new Set([
  "disconnected",
  "error",
  "expired",
  "reconnect_required",
]);

// Pure helper so the banner logic is unit-testable. Exported for the
// banner-visibility test below in
// `pages/financial-pulse-qb-banner.test.tsx`.
export function isQbUnhealthy(payload: QbStatusPayload | undefined): boolean {
  if (!payload) return false;
  if (payload.isConnected === false) return true;
  if (payload.connectionStatus && QB_BAD_STATUSES.has(payload.connectionStatus))
    return true;
  return false;
}

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

const ALLOWED_ROLES = new Set([
  "super_admin",
  "company_admin",
  "billing_manager",
]);

// Task #720 — canonical per-tile captions. Source wording lives in
// `docs/financial-metrics.md`; if you change one, change the doc.
export const INFO_TIPS = {
  billedMtd:
    "From invoices · current month-to-date by createdAt · excludes draft, cancelled · includes tax and markup.",
  billedLastCycle:
    "From invoices · most recent billing cycle by invoiceMonth/invoiceYear · excludes draft, cancelled · includes tax and markup. April invoices created in May still land in the April cycle.",
  collectedMtd:
    "From invoices · current month-to-date by paidAt · excludes draft, cancelled · includes tax and markup. Reflects QuickBooks payment sync — may show $0 without an active QBO connection.",
  outstandingAr:
    "From invoices · point-in-time snapshot · excludes draft, cancelled, paid · live from this app. Accuracy depends on QuickBooks payment sync.",
  billedYtd:
    "All billable work this year — invoice totals (by billing month) plus work order and billing sheet amounts whether invoiced or not, excluding cancelled. Invoiced work appears in both the invoice total and the WO/BS total to show full contracted scope alongside realized revenue.",
  unbilledExposure:
    "Work orders + billing sheets with no invoice yet, regardless of status (except cancelled) · excludes customers hidden from billing.",
  projectedMonthEnd:
    "Work Not Yet Billed ÷ days elapsed × days in month — forecast based on current uninvoiced work.",
  avgDaysToPay:
    "Average (paidAt − createdAt) across invoices paid in the last 90 days. Requires QuickBooks payment sync.",
  grossMargin:
    "(Revenue − parts cost − labor cost) ÷ revenue for invoices created this period.",
} as const;

function useUserRole(): string | null {
  try {
    const raw = localStorage.getItem("user");
    if (!raw) return null;
    const u = JSON.parse(raw);
    return typeof u?.role === "string" ? u.role : null;
  } catch {
    return null;
  }
}

export default function FinancialPulsePage() {
  const role = useUserRole();
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const activeTab: PulseTabKey =
    params.get("tab") === "accounting" ? "accounting" : "pulse";

  const setTab = (t: PulseTabKey) => {
    navigate(`/financial-pulse?tab=${t}`);
  };

  if (!role || !ALLOWED_ROLES.has(role)) {
    return (
      <div className="py-10">
        <Card>
          <CardContent className="py-12 text-center">
            <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
            <h2 className="text-lg font-semibold text-gray-900">
              Not authorized
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              You don't have access to the Financial Pulse dashboard.
            </p>
            <Button className="mt-4" onClick={() => navigate("/")}>
              Back to dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="py-6 space-y-6" data-testid="financial-pulse-page">
      {/* Page header — Task #817: brand-palette gradient with logo watermark */}
      <div className="relative overflow-hidden rounded-xl bg-gradient-brand px-6 py-5 shadow-lg">
        {/* Decorative logo watermark */}
        <img
          src={irrigoLogoUrl}
          alt=""
          aria-hidden="true"
          className="pointer-events-none select-none absolute right-4 top-1/2 -translate-y-1/2 h-[70%] max-h-28 object-contain opacity-[0.07]"
        />
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Financial Pulse</h1>
            <p className="text-sm mt-1" style={{ color: "hsl(var(--primary-light))" }}>
              {activeTab === "pulse"
                ? "Daily operations view — in-flight pipeline and revenue trend."
                : "Accounting metrics — KPIs, drill-downs, and forward look."}
            </p>
          </div>
          {/* Tab switcher — Task #817: brand-blue active state */}
          <div className="flex rounded-lg overflow-hidden self-start shadow-sm">
            <button
              type="button"
              onClick={() => setTab("pulse")}
              data-testid="tab-pulse"
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === "pulse"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "bg-blue-900/30 text-blue-100 hover:bg-blue-800/40"
              }`}
            >
              Pulse
            </button>
            <button
              type="button"
              onClick={() => setTab("accounting")}
              data-testid="tab-accounting"
              className={`px-4 py-2 text-sm font-medium transition-colors border-l border-blue-700/40 ${
                activeTab === "accounting"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "bg-blue-900/30 text-blue-100 hover:bg-blue-800/40"
              }`}
            >
              Accounting
            </button>
          </div>
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "pulse" ? (
        <PulseTab setTab={setTab} navigate={navigate} />
      ) : (
        <AccountingTab navigate={navigate} />
      )}
    </div>
  );
}

// ─── Accounting Tab ───────────────────────────────────────────────────────
//
// Contains all existing Financial Pulse content: KPI tiles, stacked bar
// chart, revenue-mix donut, drill-down tables, A/R aging, projections.
// The revenue trend line chart has moved to PulseTab (Task #731).

function AccountingTab({ navigate }: { navigate: (path: string) => void }) {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>("mtd");
  const [customRange, setCustomRange] = useState<{ asOf: string | null }>({
    asOf: null,
  });

  const kpis = useQuery<KpisResponse>({
    queryKey: ["/api/financial-pulse/kpis", period],
    queryFn: () =>
      apiRequest(`/api/financial-pulse/kpis?period=${period}`, "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const trend = useQuery<TrendResponse>({
    queryKey: ["/api/financial-pulse/revenue-trend", 13],
    queryFn: () =>
      apiRequest("/api/financial-pulse/revenue-trend?months=13", "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const mix = useQuery<MixResponse>({
    queryKey: ["/api/financial-pulse/revenue-mix", period],
    queryFn: () =>
      apiRequest(`/api/financial-pulse/revenue-mix?period=${period}`, "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const qb = useQuery<QbStatusPayload>({
    queryKey: ["/api/quickbooks/connection"],
    queryFn: async () => {
      try {
        return await apiRequest("/api/quickbooks/connection", "GET");
      } catch {
        return {};
      }
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const lastRefreshed = kpis.dataUpdatedAt
    ? new Date(kpis.dataUpdatedAt).toISOString()
    : null;

  const refresh = () => {
    queryClient.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        typeof q.queryKey[0] === "string" &&
        (q.queryKey[0] as string).startsWith("/api/financial-pulse/"),
    });
  };

  const qbUnhealthy = isQbUnhealthy(qb.data);

  return (
    <div className="space-y-6" data-testid="accounting-tab">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <ToggleGroup
          type="single"
          value={period}
          onValueChange={(v) => v && setPeriod(v as Period)}
          data-testid="period-toggle"
        >
          <ToggleGroupItem value="mtd" data-testid="period-mtd">
            MTD
          </ToggleGroupItem>
          <ToggleGroupItem value="ytd" data-testid="period-ytd">
            YTD
          </ToggleGroupItem>
        </ToggleGroup>
        <input
          type="date"
          value={customRange.asOf ?? ""}
          onChange={(e) =>
            setCustomRange((r) => ({ ...r, asOf: e.target.value }))
          }
          disabled
          aria-label="Custom date range (coming soon)"
          title="Custom date range — coming in Slice 3"
          className="hidden sm:inline-block h-9 rounded-md border border-gray-200 bg-gray-50 px-2 text-xs text-gray-400 cursor-not-allowed"
          data-testid="custom-range-asof"
        />
        <span className="text-xs text-gray-500 hidden sm:inline">
          Last refreshed {formatRelative(lastRefreshed)}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          data-testid="refresh-button"
        >
          <RefreshCw className="w-4 h-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* QB health banner */}
      {qbUnhealthy && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 text-amber-800 px-4 py-3 text-sm flex items-center gap-2"
          data-testid="qb-health-banner"
        >
          <AlertTriangle className="w-4 h-4" />
          QuickBooks sync is unhealthy — invoice totals may be out of date.
        </div>
      )}

      {/* Band 1 — KPI snapshot */}
      <KpiBand data={kpis.data} isLoading={kpis.isLoading} isError={kpis.isError} />

      {/* Band 2 — Parts vs labor stacked bar (revenue trend line moved to Pulse tab) */}
      <Card className="shadow-md hover:shadow-lg transition-shadow">
        <CardHeader>
          <CardTitle>Revenue trends</CardTitle>
        </CardHeader>
        <CardContent>
          <PartsVsLaborChart
            data={trend.data?.series ?? []}
            isLoading={trend.isLoading}
          />
        </CardContent>
      </Card>

      {/* Revenue mix donut */}
      <RevenueMixCard data={mix.data} isLoading={mix.isLoading} />

      {/* Band 3 — Drill-downs */}
      <DrillDownBand period={period} />

      {/* Band 4 — Forward look */}
      <ForwardLookBand period={period} navigate={navigate} />

    </div>
  );
}

// ─── Pulse Tab ────────────────────────────────────────────────────────────
//
// Daily-ops view: three KPI tiles (Last Cycle, In-Flight, Year-to-Date),
// the 13-month revenue trend line chart, and simplified per-customer and
// per-tech in-flight / YTD tables.

function PulseTab({
  setTab,
  navigate,
}: {
  setTab: (t: PulseTabKey) => void;
  navigate: (path: string) => void;
}) {
  const tableRef = useRef<HTMLDivElement>(null);

  const pulse = useQuery<PulseSummaryResponse>({
    queryKey: ["/api/financial-pulse/pulse-summary"],
    queryFn: () => apiRequest("/api/financial-pulse/pulse-summary", "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const trend = useQuery<TrendResponse>({
    queryKey: ["/api/financial-pulse/revenue-trend", 13],
    queryFn: () =>
      apiRequest("/api/financial-pulse/revenue-trend?months=13", "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Customer table state
  const [custSearch, setCustSearch] = useState("");
  const [custSortKey, setCustSortKey] = useState<PulseSortKey>("inFlight");
  const [custSortDir, setCustSortDir] = useState<SortDir>("desc");
  const [custPage, setCustPage] = useState(0);
  const CUST_PAGE_SIZE = 25;

  // Tech table state
  const [techSortKey, setTechSortKey] = useState<PulseSortKey>("inFlight");
  const [techSortDir, setTechSortDir] = useState<SortDir>("desc");

  const onCustSort = (key: PulseSortKey) => {
    setCustPage(0);
    if (custSortKey === key) {
      setCustSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setCustSortKey(key);
      setCustSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const onTechSort = (key: PulseSortKey) => {
    if (techSortKey === key) {
      setTechSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setTechSortKey(key);
      setTechSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const sortedCustomers = useMemo(() => {
    const raw = pulse.data?.customers ?? [];
    const filtered = custSearch
      ? raw.filter((r) =>
          r.name.toLowerCase().includes(custSearch.toLowerCase()),
        )
      : raw;
    const copy = [...filtered];
    copy.sort((a, b) => {
      let diff = 0;
      if (custSortKey === "name") diff = a.name.localeCompare(b.name);
      else if (custSortKey === "inFlight") diff = a.inFlight - b.inFlight;
      else diff = a.ytd - b.ytd;
      return custSortDir === "desc" ? -diff : diff;
    });
    return copy;
  }, [pulse.data?.customers, custSearch, custSortKey, custSortDir]);

  const custPageRows = sortedCustomers.slice(
    custPage * CUST_PAGE_SIZE,
    (custPage + 1) * CUST_PAGE_SIZE,
  );
  const custTotalPages = Math.max(
    1,
    Math.ceil(sortedCustomers.length / CUST_PAGE_SIZE),
  );

  const sortedTechs = useMemo(() => {
    const raw = pulse.data?.technicians ?? [];
    const copy = [...raw];
    copy.sort((a, b) => {
      let diff = 0;
      if (techSortKey === "name") diff = a.name.localeCompare(b.name);
      else if (techSortKey === "inFlight") diff = a.inFlight - b.inFlight;
      else diff = a.ytd - b.ytd;
      return techSortDir === "desc" ? -diff : diff;
    });
    return copy;
  }, [pulse.data?.technicians, techSortKey, techSortDir]);

  const isLoading = pulse.isLoading;
  const isError = pulse.isError;

  return (
    <div className="space-y-6" data-testid="pulse-tab">
      {/* ── KPI tiles ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Last Cycle — clickable → invoices filtered to that month */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            const iso = pulse.data?.lastCycle.monthIso;
            if (iso) navigate(`/invoices?month=${iso}`);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              const iso = pulse.data?.lastCycle.monthIso;
              if (iso) navigate(`/invoices?month=${iso}`);
            }
          }}
          className="cursor-pointer hover:opacity-90 transition-opacity"
          data-testid="pulse-tile-last-cycle"
        >
          <MetricTile
            label="Last Cycle Billed"
            value={pulse.data?.lastCycle.value ?? null}
            format="currency"
            helper={
              pulse.data?.lastCycle.monthLabel && pulse.data.lastCycle.monthIso
                ? `${pulse.data.lastCycle.monthLabel} · ${pulse.data.lastCycle.invoiceCount} invoices`
                : pulse.data
                ? "No cycles yet"
                : undefined
            }
            deltaGoodDirection="up"
            isLoading={isLoading}
            isError={isError}
            infoTip="Total billed in the most recent billing cycle. Click to view those invoices."
            accent="blue"
          />
        </div>

        {/* In-Flight — scrolls to customers table */}
        <div
          role="button"
          tabIndex={0}
          onClick={() =>
            tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ")
              tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className="cursor-pointer hover:opacity-90 transition-opacity"
          data-testid="pulse-tile-in-flight"
        >
          <MetricTile
            label="In-Flight Pipeline"
            value={pulse.data?.inFlight.value ?? null}
            format="currency"
            helper={
              pulse.data?.inFlight != null
                ? `${pulse.data.inFlight.customerCount} customers · ${pulse.data.inFlight.techCount} techs`
                : undefined
            }
            deltaGoodDirection="up"
            isLoading={isLoading}
            isError={isError}
            infoTip="Uninvoiced work orders + billing sheets with no invoice yet. Click to scroll to the customer breakdown."
            accent="indigo"
          />
        </div>

        {/* Year to Date — switches to Accounting tab */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setTab("accounting")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setTab("accounting");
          }}
          className="cursor-pointer hover:opacity-90 transition-opacity"
          data-testid="pulse-tile-ytd"
        >
          <MetricTile
            label="Year to Date"
            value={pulse.data?.yearToDate.value ?? null}
            format="currency"
            helper="Invoiced + in-flight"
            deltaGoodDirection="up"
            isLoading={isLoading}
            isError={isError}
            windowBadge="YTD"
            infoTip="Invoiced this calendar year plus current in-flight pipeline. Click to see full accounting metrics."
            accent="emerald"
          />
        </div>
      </div>

      {/* ── Revenue trend (13-month line chart) ────────────────────── */}
      <Card className="shadow-md hover:shadow-lg transition-shadow">
        <CardHeader>
          <CardTitle>Revenue trend</CardTitle>
        </CardHeader>
        <CardContent>
          <RevenueTrendChart
            data={trend.data?.series ?? []}
            isLoading={trend.isLoading}
          />
        </CardContent>
      </Card>

      {/* ── In-Flight by Customer + Technician (side-by-side on lg+) ── */}
      <div
        ref={tableRef}
        className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start"
        data-testid="pulse-tables-row"
      >
        <Card className="shadow-md hover:shadow-lg transition-shadow" data-testid="pulse-customers-card">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>In-Flight by Customer</CardTitle>
            <div className="relative w-56">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400 pointer-events-none" />
              <Input
                value={custSearch}
                onChange={(e) => {
                  setCustSearch(e.target.value);
                  setCustPage(0);
                }}
                placeholder="Search customers…"
                className="pl-8 h-8 text-sm"
                data-testid="pulse-customer-search"
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="rounded-md overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-white">
                  <TableRow>
                    <TableHead>
                      <SortHeader
                        label="Customer"
                        active={custSortKey === "name"}
                        dir={custSortDir}
                        onClick={() => onCustSort("name")}
                        testId="pulse-sort-cust-name"
                      />
                    </TableHead>
                    <TableHead>Budget</TableHead>
                    <TableHead className="text-right">
                      <SortHeader
                        label="In-Flight"
                        active={custSortKey === "inFlight"}
                        dir={custSortDir}
                        align="right"
                        onClick={() => onCustSort("inFlight")}
                        testId="pulse-sort-cust-inflight"
                      />
                    </TableHead>
                    <TableHead className="text-right">
                      <SortHeader
                        label="YTD"
                        active={custSortKey === "ytd"}
                        dir={custSortDir}
                        align="right"
                        onClick={() => onCustSort("ytd")}
                        testId="pulse-sort-cust-ytd"
                      />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-8 text-center text-sm text-gray-500"
                      >
                        Loading…
                      </TableCell>
                    </TableRow>
                  ) : custPageRows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-8 text-center text-sm text-gray-400"
                      >
                        {custSearch ? "No customers match your search." : "No in-flight work found."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    custPageRows.map((r) => (
                      <TableRow
                        key={r.customerId}
                        className="cursor-pointer hover:bg-gray-50"
                        onClick={() => navigate(`/customers/${r.customerId}`)}
                        data-testid={`pulse-customer-row-${r.customerId}`}
                      >
                        <TableCell className="font-medium">
                          <span>{r.name}</span>
                        </TableCell>
                        <TableCell>
                          <StatusPill status={r.budgetStatus} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {r.inFlight > 0
                            ? CURRENCY.format(r.inFlight)
                            : <span className="text-gray-400">—</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {CURRENCY.format(r.ytd)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            {sortedCustomers.length > CUST_PAGE_SIZE && (
              <div className="flex items-center justify-between px-4 py-3 text-xs text-gray-600 border-t">
                <span>
                  Page {custPage + 1} of {custTotalPages} ·{" "}
                  {sortedCustomers.length} customers
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={custPage === 0}
                    onClick={() => setCustPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={custPage >= custTotalPages - 1}
                    onClick={() =>
                      setCustPage((p) => Math.min(custTotalPages - 1, p + 1))
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── In-Flight by Technician ──────────────────────────────── */}
        <Card className="shadow-md hover:shadow-lg transition-shadow" data-testid="pulse-techs-card">
        <CardHeader>
          <CardTitle>In-Flight by Technician</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="rounded-md overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-white">
                <TableRow>
                  <TableHead>
                    <SortHeader
                      label="Technician"
                      active={techSortKey === "name"}
                      dir={techSortDir}
                      onClick={() => onTechSort("name")}
                      testId="pulse-sort-tech-name"
                    />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader
                      label="In-Flight"
                      active={techSortKey === "inFlight"}
                      dir={techSortDir}
                      align="right"
                      onClick={() => onTechSort("inFlight")}
                      testId="pulse-sort-tech-inflight"
                    />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader
                      label="YTD"
                      active={techSortKey === "ytd"}
                      dir={techSortDir}
                      align="right"
                      onClick={() => onTechSort("ytd")}
                      testId="pulse-sort-tech-ytd"
                    />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-8 text-center text-sm text-gray-500"
                    >
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : sortedTechs.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-8 text-center text-sm text-gray-400"
                    >
                      No technician activity found.
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedTechs.map((r) => (
                    <TableRow
                      key={r.technicianId}
                      data-testid={`pulse-tech-row-${r.technicianId}`}
                    >
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {r.inFlight > 0
                          ? CURRENCY.format(r.inFlight)
                          : <span className="text-gray-400">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {CURRENCY.format(r.ytd)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}

// ─── Slice 3 components ───────────────────────────────────────────────────

const PERCENT0 = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0,
});
const PERCENT1 = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

function statusTone(s: BudgetStatus): string {
  switch (s) {
    case "over":
      return "bg-red-50 text-red-800 border-red-200";
    case "approaching":
      return "bg-amber-50 text-amber-800 border-amber-200";
    case "healthy":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    default:
      return "bg-gray-50 text-gray-600 border-gray-200";
  }
}
function statusLabel(s: BudgetStatus): string {
  if (s === "over") return "Over cap";
  if (s === "approaching") return "Approaching";
  if (s === "healthy") return "On track";
  return "Unset";
}
function StatusPill({ status }: { status: BudgetStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}
      data-testid={`status-pill-${status}`}
    >
      {statusLabel(status)}
    </span>
  );
}

function BudgetMeter({
  pct,
  status,
}: {
  pct: number | null;
  status: BudgetStatus;
}) {
  if (pct == null) {
    return <span className="text-gray-400 text-sm">—</span>;
  }
  const display = Math.min(100, Math.max(0, pct * 100));
  const cls =
    status === "over"
      ? "[&>div]:bg-red-500"
      : status === "approaching"
        ? "[&>div]:bg-amber-500"
        : "[&>div]:bg-emerald-500";
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <Progress value={display} className={`h-2 w-24 ${cls}`} />
      <span className="text-xs text-gray-600 tabular-nums">
        {PERCENT0.format(pct)}
      </span>
    </div>
  );
}

function Sparkline({ data }: { data: { month: string; revenue: number }[] }) {
  if (data.length === 0) return null;
  const max = Math.max(1, ...data.map((d) => d.revenue));
  const W = 80;
  const H = 24;
  const step = data.length > 1 ? W / (data.length - 1) : W;
  const pts = data
    .map((d, i) => `${i * step},${H - (d.revenue / max) * (H - 2) - 1}`)
    .join(" ");
  return (
    <svg width={W} height={H} aria-hidden="true" className="text-blue-500">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        points={pts}
      />
    </svg>
  );
}

function downloadCsv(url: string, filename: string): void {
  fetch(url, { headers: { Accept: "text/csv" }, credentials: "include" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    })
    .catch(() => {
      /* best-effort — silently ignore network failure */
    });
}

type DrillTab = "customers" | "technicians" | "service";

function DrillDownBand({ period }: { period: Period }) {
  const [tab, setTab] = useState<DrillTab>("customers");
  return (
    <Card className="shadow-md hover:shadow-lg transition-shadow" data-testid="financial-pulse-drilldown">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Drill-downs</CardTitle>
        <Tabs value={tab} onValueChange={(v) => setTab(v as DrillTab)}>
          <TabsList>
            <TabsTrigger value="customers" data-testid="drill-tab-customers">
              By Customer
            </TabsTrigger>
            <TabsTrigger value="technicians" data-testid="drill-tab-technicians">
              By Technician
            </TabsTrigger>
            <TabsTrigger value="service" data-testid="drill-tab-service">
              By Service Type
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as DrillTab)}>
          <TabsContent value="customers" className="mt-0">
            <CustomersTab period={period} />
          </TabsContent>
          <TabsContent value="technicians" className="mt-0">
            <TechniciansTab period={period} />
          </TabsContent>
          <TabsContent value="service" className="mt-0">
            <ServiceTypeTab period={period} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function SortHeader({
  label,
  active,
  dir,
  align = "left",
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  align?: "left" | "right";
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex items-center gap-1 select-none hover:text-gray-900 ${align === "right" ? "justify-end w-full" : ""} ${active ? "text-gray-900" : "text-gray-600"}`}
    >
      <span>{label}</span>
      <ArrowUpDown className={`w-3 h-3 ${active ? "opacity-100" : "opacity-30"}`} />
      {active && (
        <span className="text-[10px] font-normal text-gray-500">
          {dir === "desc" ? "↓" : "↑"}
        </span>
      )}
    </button>
  );
}

function CustomersTab({ period }: { period: Period }) {
  const [, navigate] = useLocation();
  // `mode` drives the API-level ranking. Column clicks switch into
  // `revenue` mode and then sort locally — the API always returns
  // up to 500 rows so client-side column sorting is exhaustive.
  const [mode, setMode] = useState<"revenue" | "budget_risk">("revenue");
  const [sortKey, setSortKey] = useState<CustomerSortKey>("revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;
  const url = `/api/financial-pulse/top-customers?period=${period}&sort=${mode}&limit=500`;
  const { data, isLoading } = useQuery<TopCustomersResponse>({
    queryKey: [url],
    queryFn: () => apiRequest(url, "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const raw = data?.rows ?? [];
  const rows = useMemo(() => {
    // Budget-risk mode preserves the server-side ranking (over →
    // approaching → healthy → unset) and ignores local column sort.
    if (mode === "budget_risk") return raw;
    const copy = [...raw];
    copy.sort((a, b) => compareCustomers(a, b, sortKey, sortDir));
    return copy;
  }, [raw, mode, sortKey, sortDir]);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  const onColumnSort = (key: CustomerSortKey, defaultDir: SortDir) => {
    setPage(0);
    setMode("revenue"); // any column click drops out of budget-risk mode
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return key;
      }
      setSortDir(defaultDir);
      return key;
    });
  };
  const isActive = (k: CustomerSortKey) =>
    mode === "revenue" && sortKey === k;

  const onExport = () => {
    const suffix = period === "ytd"
      ? String(new Date().getFullYear())
      : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    downloadCsv(
      `${url}&format=csv`,
      `financial-pulse-customers-${suffix}.csv`,
    );
  };

  return (
    <div data-testid="customers-tab">
      <div className="flex items-center justify-between mb-3 gap-2">
        <Button
          variant={mode === "budget_risk" ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setPage(0);
            setMode((m) => (m === "budget_risk" ? "revenue" : "budget_risk"));
            if (mode !== "budget_risk") {
              // entering budget_risk — local sort is suspended
            } else {
              // returning to revenue mode — re-anchor on revenue desc
              setSortKey("revenue");
              setSortDir("desc");
            }
          }}
          data-testid="customers-sort-budget-risk"
        >
          <ArrowUpDown className="w-3.5 h-3.5 mr-1" />
          {mode === "budget_risk" ? "Sorted by budget risk" : "Sort by budget risk"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          data-testid="customers-csv-export"
        >
          <Download className="w-3.5 h-3.5 mr-1" /> CSV
        </Button>
      </div>
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-white">
            <TableRow>
              <TableHead>
                <SortHeader
                  label="Customer"
                  active={isActive("name")}
                  dir={sortDir}
                  onClick={() => onColumnSort("name", "asc")}
                  testId="sort-customer-name"
                />
              </TableHead>
              <TableHead className="text-right">
                <SortHeader
                  label="Revenue"
                  active={isActive("revenue")}
                  dir={sortDir}
                  align="right"
                  onClick={() => onColumnSort("revenue", "desc")}
                  testId="sort-customer-revenue"
                />
              </TableHead>
              <TableHead>Trend (7m)</TableHead>
              <TableHead>
                <SortHeader
                  label="Monthly used"
                  active={isActive("monthlyUsedPct")}
                  dir={sortDir}
                  onClick={() => onColumnSort("monthlyUsedPct", "desc")}
                  testId="sort-customer-monthly"
                />
              </TableHead>
              <TableHead>
                <SortHeader
                  label="Annual used"
                  active={isActive("annualUsedPct")}
                  dir={sortDir}
                  onClick={() => onColumnSort("annualUsedPct", "desc")}
                  testId="sort-customer-annual"
                />
              </TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">
                <SortHeader
                  label="Avg. time to pay"
                  active={isActive("avgDaysToPay")}
                  dir={sortDir}
                  align="right"
                  onClick={() => onColumnSort("avgDaysToPay", "desc")}
                  testId="sort-customer-dtp"
                />
              </TableHead>
              <TableHead>
                <SortHeader
                  label="Last invoice"
                  active={isActive("lastInvoiceAt")}
                  dir={sortDir}
                  onClick={() => onColumnSort("lastInvoiceAt", "desc")}
                  testId="sort-customer-last"
                />
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-sm text-gray-500">
                  Loading…
                </TableCell>
              </TableRow>
            ) : pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-sm text-gray-400">
                  No customers in this period.
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((r) => (
                <TableRow
                  key={r.customerId}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => navigate(`/customers/${r.customerId}`)}
                  data-testid={`customer-row-${r.customerId}`}
                >
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {CURRENCY.format(r.revenue)}
                  </TableCell>
                  <TableCell>
                    <Sparkline data={r.monthlySpark} />
                  </TableCell>
                  <TableCell>
                    <BudgetMeter pct={r.monthlyUsedPct} status={r.monthlyStatus} />
                  </TableCell>
                  <TableCell>
                    <BudgetMeter pct={r.annualUsedPct} status={r.annualStatus} />
                  </TableCell>
                  <TableCell>
                    <StatusPill status={r.monthlyStatus} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.avgDaysToPay == null ? "—" : r.avgDaysToPay.toFixed(0)}
                  </TableCell>
                  <TableCell className="text-xs text-gray-600">
                    {r.lastInvoiceAt
                      ? new Date(r.lastInvoiceAt).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" data-testid={`customer-kebab-${r.customerId}`}>
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate(`/customers/${r.customerId}`)}>
                          View customer
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate(`/invoices?customerId=${r.customerId}`)}>
                          View invoices
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-600">
          <span>
            Page {page + 1} of {totalPages} · {rows.length} customers
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TechniciansTab({ period }: { period: Period }) {
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;
  const url = `/api/financial-pulse/by-technician?period=${period}`;
  const { data, isLoading } = useQuery<ByTechResponse>({
    queryKey: [url],
    queryFn: () => apiRequest(url, "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const rows = data?.rows ?? [];
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  const onExport = () => {
    const suffix = period === "ytd"
      ? String(new Date().getFullYear())
      : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    downloadCsv(
      `${url}&format=csv`,
      `financial-pulse-technicians-${suffix}.csv`,
    );
  };

  return (
    <div data-testid="technicians-tab">
      <div className="flex items-center justify-end mb-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          data-testid="technicians-csv-export"
        >
          <Download className="w-3.5 h-3.5 mr-1" /> CSV
        </Button>
      </div>
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-white">
            <TableRow>
              <TableHead>Technician</TableHead>
              <TableHead className="text-right">Hours</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Labor cost</TableHead>
              <TableHead className="text-right">Margin %</TableHead>
              <TableHead className="text-right">Avg ticket</TableHead>
              <TableHead className="text-right"># BS</TableHead>
              <TableHead className="text-right"># WO</TableHead>
              <TableHead className="text-right">Parts revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-sm text-gray-500">
                  Loading…
                </TableCell>
              </TableRow>
            ) : pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-sm text-gray-400">
                  No technician activity in this period.
                </TableCell>
              </TableRow>
            ) : (
              <TooltipProvider>
                {pageRows.map((r) => (
                  <TableRow key={r.technicianId} data-testid={`tech-row-${r.technicianId}`}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.hoursBilled.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {CURRENCY.format(r.revenue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.laborCost == null ? (
                        <Tooltip>
                          <TooltipTrigger className="text-gray-400">—</TooltipTrigger>
                          <TooltipContent>No hourly wage set.</TooltipContent>
                        </Tooltip>
                      ) : (
                        CURRENCY.format(r.laborCost)
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.marginPct == null ? (
                        <Tooltip>
                          <TooltipTrigger className="text-gray-400">—</TooltipTrigger>
                          <TooltipContent>No hourly wage set.</TooltipContent>
                        </Tooltip>
                      ) : (
                        `${r.marginPct.toFixed(1)}%`
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.avgTicket == null ? "—" : CURRENCY.format(r.avgTicket)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.billingSheetCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.workOrderCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {CURRENCY.format(r.partsRevenue)}
                    </TableCell>
                  </TableRow>
                ))}
              </TooltipProvider>
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-600">
          <span>
            Page {page + 1} of {totalPages} · {rows.length} technicians
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ServiceTypeTab({ period }: { period: Period }) {
  const url = `/api/financial-pulse/by-service-type?period=${period}`;
  const { data, isLoading } = useQuery<ByServiceTypeResponse>({
    queryKey: [url],
    queryFn: () => apiRequest(url, "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const rows = data?.rows ?? [];

  const onExport = () => {
    const suffix = period === "ytd"
      ? String(new Date().getFullYear())
      : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    downloadCsv(
      `${url}&format=csv`,
      `financial-pulse-service-type-${suffix}.csv`,
    );
  };

  return (
    <div data-testid="service-type-tab">
      <div className="flex items-center justify-end mb-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          data-testid="service-csv-export"
        >
          <Download className="w-3.5 h-3.5 mr-1" /> CSV
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service type</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">% of total</TableHead>
              <TableHead className="text-right"># invoices</TableHead>
              <TableHead className="text-right">Avg ticket</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-gray-500">
                  Loading…
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.key} data-testid={`service-row-${r.key}`}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {CURRENCY.format(r.revenue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.pctOfTotal == null
                      ? "—"
                      : PERCENT1.format(r.pctOfTotal / 100)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.invoiceCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.avgTicket == null ? "—" : CURRENCY.format(r.avgTicket)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ForwardLookBand({
  period,
  navigate,
}: {
  period: Period;
  navigate: (path: string) => void;
}) {
  const agingUrl = `/api/financial-pulse/ar-aging?period=${period}`;
  const projUrl = `/api/financial-pulse/projections?period=${period}`;
  const aging = useQuery<ArAgingResponse>({
    queryKey: [agingUrl],
    queryFn: () => apiRequest(agingUrl, "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const proj = useQuery<ProjectionsResponse>({
    queryKey: [projUrl],
    queryFn: () => apiRequest(projUrl, "GET"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" data-testid="forward-look-band">
      <ArAgingCard data={aging.data} isLoading={aging.isLoading} navigate={navigate} />
      <ProjectionCard data={proj.data} isLoading={proj.isLoading} />
    </div>
  );
}

const AGING_COLORS: Record<ArAgingBucket["key"], string> = {
  current: "bg-emerald-100 border-emerald-300 text-emerald-900",
  days30: "bg-yellow-100 border-yellow-300 text-yellow-900",
  days60: "bg-orange-100 border-orange-300 text-orange-900",
  days90: "bg-red-100 border-red-300 text-red-900",
};

function ArAgingCard({
  data,
  isLoading,
  navigate,
}: {
  data: ArAgingResponse | undefined;
  isLoading: boolean;
  navigate: (path: string) => void;
}) {
  const buckets = data?.buckets ?? [];
  const total = data?.total ?? 0;
  return (
    <Card className="shadow-md hover:shadow-lg transition-shadow" data-testid="ar-aging-card">
      <CardHeader>
        <CardTitle>Money Owed by Age</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-24 rounded-md bg-gray-50 animate-pulse" />
        ) : (
          <>
            <div className="text-xs text-gray-500 mb-2">
              Total outstanding: {CURRENCY.format(total)}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {buckets.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => navigate(`/invoices?aging=${b.key === "days90" ? "days90Plus" : b.key}`)}
                  className={`rounded-md border p-3 text-left transition hover:opacity-90 ${AGING_COLORS[b.key]}`}
                  data-testid={`aging-bucket-${b.key}`}
                >
                  <div className="text-xs font-medium">{b.label}</div>
                  <div className="text-lg font-semibold tabular-nums mt-1">
                    {CURRENCY.format(b.amount)}
                  </div>
                  <div className="text-xs opacity-75 mt-0.5">
                    {b.count} {b.count === 1 ? "invoice" : "invoices"}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectionCard({
  data,
  isLoading,
}: {
  data: ProjectionsResponse | undefined;
  isLoading: boolean;
}) {
  if (isLoading || !data) {
    return (
      <Card className="shadow-md hover:shadow-lg transition-shadow" data-testid="projection-card">
        <CardHeader>
          <CardTitle>Month-End Projection</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-24 rounded-md bg-gray-50 animate-pulse" />
        </CardContent>
      </Card>
    );
  }
  const { mtd, projectedMonthEnd, prevMonthActual, daysElapsed, daysInMonth } =
    data;
  const max = Math.max(projectedMonthEnd, prevMonthActual, mtd, 1);
  const mtdWidth = (mtd / max) * 100;
  const projectedWidth = (projectedMonthEnd / max) * 100;
  const prevWidth = (prevMonthActual / max) * 100;
  return (
    <Card className="shadow-md hover:shadow-lg transition-shadow" data-testid="projection-card">
      <CardHeader>
        <CardTitle>Month-End Projection</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="text-3xl font-bold text-gray-900 tabular-nums"
          data-testid="projected-month-end-value"
        >
          {CURRENCY.format(projectedMonthEnd)}
        </div>
        <div className="text-xs text-gray-600 mt-1">
          {CURRENCY.format(mtd)} billed over {daysElapsed}{" "}
          {daysElapsed === 1 ? "day" : "days"} × {daysInMonth} days ={" "}
          {CURRENCY.format(projectedMonthEnd)}
        </div>

        <div className="mt-5 space-y-2 text-xs">
          <div>
            <div className="flex justify-between mb-1 text-gray-600">
              <span>Prior month</span>
              <span className="tabular-nums">{CURRENCY.format(prevMonthActual)}</span>
            </div>
            <div className="h-2 bg-gray-100 rounded">
              <div
                className="h-2 bg-gray-400 rounded"
                style={{ width: `${prevWidth}%` }}
              />
            </div>
          </div>
          <div>
            <div className="flex justify-between mb-1 text-gray-600">
              <span>Projected (MTD + run-rate)</span>
              <span className="tabular-nums">
                {CURRENCY.format(projectedMonthEnd)}
              </span>
            </div>
            <div className="relative h-2 bg-gray-100 rounded">
              <div
                className="absolute inset-y-0 left-0 h-2 bg-blue-500 rounded-l"
                style={{ width: `${mtdWidth}%` }}
              />
              <div
                className="absolute inset-y-0 h-2 border-t-2 border-b-2 border-dashed border-blue-500 rounded-r"
                style={{
                  left: `${mtdWidth}%`,
                  width: `${Math.max(0, projectedWidth - mtdWidth)}%`,
                }}
              />
            </div>
            <div className="flex justify-between mt-1 text-[10px] text-gray-500">
              <span>MTD {CURRENCY.format(mtd)}</span>
              <span>Projection (dashed)</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function KpiBand({
  data,
  isLoading,
  isError,
}: {
  data: KpisResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {/* Revenue group — blue */}
      <MetricTile
        testId="kpi-billed-mtd"
        label="Billed MTD"
        value={data?.billedMtd.value ?? null}
        format="currency"
        deltaPct={data?.billedMtd.deltaPct ?? null}
        deltaLabel="vs last month"
        deltaGoodDirection="up"
        isLoading={isLoading}
        isError={isError}
        windowBadge="MTD"
        infoTip={INFO_TIPS.billedMtd}
        accent="blue"
      />
      <MetricTile
        testId="kpi-billed-last-cycle"
        label="Billed Last Cycle"
        value={data?.billedLastCycle.value ?? null}
        format="currency"
        deltaPct={data?.billedLastCycle.deltaPct ?? null}
        deltaLabel="vs prior month"
        deltaGoodDirection="up"
        helper={data?.billedLastCycle.monthLabel}
        isLoading={isLoading}
        isError={isError}
        infoTip={INFO_TIPS.billedLastCycle}
        accent="blue"
      />
      <MetricTile
        testId="kpi-collected-mtd"
        label="Collected MTD"
        value={data?.collectedMtd.value ?? null}
        format="currency"
        deltaPct={data?.collectedMtd.deltaPct ?? null}
        deltaLabel="vs last month"
        deltaGoodDirection="up"
        isLoading={isLoading}
        isError={isError}
        windowBadge="MTD"
        infoTip={INFO_TIPS.collectedMtd}
        accent="emerald"
      />
      <MetricTile
        testId="kpi-outstanding-ar"
        label="Money Owed"
        value={data?.outstandingAr.value ?? null}
        format="currency"
        deltaGoodDirection="down"
        isLoading={isLoading}
        isError={isError}
        infoTip={INFO_TIPS.outstandingAr}
        accent="amber"
      />
      <MetricTile
        testId="kpi-projected-month-end"
        label="Projected by Month-End"
        value={data?.projectedMonthEnd.value ?? null}
        format="currency"
        helper="Run-rate projection"
        deltaGoodDirection="up"
        isLoading={isLoading}
        isError={isError}
        infoTip={INFO_TIPS.projectedMonthEnd}
        accent="indigo"
      />
      <MetricTile
        testId="kpi-billed-ytd"
        label="Billed YTD"
        value={data?.billedYtd.value ?? null}
        format="currency"
        deltaPct={data?.billedYtd.deltaPct ?? null}
        deltaLabel="vs last year"
        deltaGoodDirection="up"
        isLoading={isLoading}
        isError={isError}
        windowBadge="YTD"
        infoTip={INFO_TIPS.billedYtd}
        accent="blue"
      />
      <MetricTile
        testId="kpi-unbilled-exposure"
        label="Work Not Yet Billed"
        value={data?.unbilledExposure.value ?? null}
        format="currency"
        deltaGoodDirection="down"
        isLoading={isLoading}
        isError={isError}
        infoTip={INFO_TIPS.unbilledExposure}
        accent="orange"
      />
      <MetricTile
        testId="kpi-avg-days-to-pay"
        label="Avg. Time to Get Paid"
        value={data?.avgDaysToPay.value ?? null}
        format="days"
        deltaGoodDirection="down"
        isLoading={isLoading}
        isError={isError}
        infoTip={INFO_TIPS.avgDaysToPay}
        accent="teal"
      />
      <MetricTile
        testId="kpi-gross-margin"
        label="Profit Margin"
        value={data?.grossMarginPct.value ?? null}
        format="percent"
        deltaGoodDirection="up"
        isLoading={isLoading}
        isError={isError}
        infoTip={INFO_TIPS.grossMargin}
        accent="violet"
        warning={
          data?.grossMarginPct.missingWageTechCount &&
          data.grossMarginPct.missingWageTechCount > 0
            ? `Margin uses fallback wage for ${data.grossMarginPct.missingWageTechCount} technician${
                data.grossMarginPct.missingWageTechCount === 1 ? "" : "s"
              } with no hourly rate set${
                data.grossMarginPct.estimatedLaborCostShortfall
                  ? ` (${CURRENCY.format(data.grossMarginPct.estimatedLaborCostShortfall)} of labor cost is estimated)`
                  : ""
              }. Set their wages for a more accurate number.`
            : undefined
        }
      />
    </div>
  );
}

function RevenueTrendChart({
  data,
  isLoading,
}: {
  data: TrendPoint[];
  isLoading: boolean;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 mb-2">
        Revenue (13 months, with year-over-year)
      </h3>
      <div className="h-72" data-testid="revenue-trend-chart">
        {isLoading ? (
          <ChartSkeleton />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis
                tickFormatter={(v) => CURRENCY.format(v)}
                tick={{ fontSize: 11 }}
                width={70}
              />
              <ReTooltip
                formatter={(value: number, name: string) => [
                  CURRENCY.format(value),
                  name === "revenue" ? "This year" : "Last year",
                ]}
                labelFormatter={(l, payload) => {
                  if (Array.isArray(payload) && payload.length >= 2) {
                    const curr = Number(payload[0]?.value ?? 0);
                    const prev = Number(payload[1]?.value ?? 0);
                    const yoy = prev > 0 ? ((curr - prev) / prev) * 100 : null;
                    return `${l}${yoy != null ? ` · YoY ${yoy.toFixed(1)}%` : ""}`;
                  }
                  return String(l);
                }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="revenue"
                name="This year"
                stroke="#1d4ed8"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="prevYearRevenue"
                name="Last year"
                stroke="#4338ca"
                strokeDasharray="4 4"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function PartsVsLaborChart({
  data,
  isLoading,
}: {
  data: TrendPoint[];
  isLoading: boolean;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 mb-2">
        Parts vs labor by month
      </h3>
      <div className="h-72" data-testid="parts-vs-labor-chart">
        {isLoading ? (
          <ChartSkeleton />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis
                tickFormatter={(v) => CURRENCY.format(v)}
                tick={{ fontSize: 11 }}
                width={70}
              />
              <ReTooltip formatter={(v: number) => CURRENCY.format(v)} />
              <Legend />
              <Bar
                dataKey="partsRevenue"
                name="Parts"
                stackId="rev"
                fill="#1d4ed8"
              />
              <Bar
                dataKey="laborRevenue"
                name="Labor"
                stackId="rev"
                fill="#059669"
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

type MixTab = "partsLabor" | "emergency" | "contract";

function RevenueMixCard({
  data,
  isLoading,
}: {
  data: MixResponse | undefined;
  isLoading: boolean;
}) {
  const [tab, setTab] = useState<MixTab>("partsLabor");

  const slices = useMemo(() => {
    if (!data) return [];
    if (tab === "partsLabor") {
      return [
        { name: "Parts", value: data.partsVsLabor.parts, fill: "#1d4ed8" },
        { name: "Labor", value: data.partsVsLabor.labor, fill: "#059669" },
      ];
    }
    if (tab === "emergency") {
      return [
        {
          name: "Emergency",
          value: data.emergencyVsStandard.emergency,
          fill: "#f59e0b",
        },
        {
          name: "Standard",
          value: data.emergencyVsStandard.standard,
          fill: "#1d4ed8",
        },
      ];
    }
    return [
      { name: "Contract", value: data.contractVsAdhoc.contract, fill: "#4338ca" },
      { name: "Ad-hoc", value: data.contractVsAdhoc.adhoc, fill: "#f59e0b" },
    ];
  }, [data, tab]);

  const total = slices.reduce((s, x) => s + x.value, 0);

  return (
    <Card className="shadow-md hover:shadow-lg transition-shadow" data-testid="revenue-mix-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Revenue mix</CardTitle>
        <Tabs value={tab} onValueChange={(v) => setTab(v as MixTab)}>
          <TabsList>
            <TabsTrigger value="partsLabor" data-testid="mix-tab-parts-labor">
              Parts vs Labor
            </TabsTrigger>
            <TabsTrigger value="emergency" data-testid="mix-tab-emergency">
              Emergency vs Standard
            </TabsTrigger>
            <TabsTrigger value="contract" data-testid="mix-tab-contract">
              Contract vs Ad-hoc
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        <div className="h-72 relative" data-testid="revenue-mix-donut">
          {isLoading ? (
            <ChartSkeleton />
          ) : total === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-400">
              No revenue in this period.
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={70}
                    outerRadius={110}
                    paddingAngle={2}
                  >
                    {slices.map((s, i) => (
                      <Cell key={i} fill={s.fill} />
                    ))}
                  </Pie>
                  <ReTooltip formatter={(v: number) => CURRENCY.format(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center">
                  <div className="text-xs text-gray-500">Total</div>
                  <div className="text-xl font-semibold text-gray-900">
                    {CURRENCY.format(total)}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-full w-full rounded-md bg-gray-50 animate-pulse" />
  );
}
