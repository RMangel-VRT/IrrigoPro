// Task #708 — Financial Pulse Slice 5: consolidation & widgetization.
//
// Shared FP widget used across Admin Dashboard, Customer Profile,
// Customer Billing, and the Invoices page. Backed by the existing
// /api/financial-pulse/* endpoints (plus the new
// /api/financial-pulse/customer/:id/summary added in this slice) so
// every surface reads from a single source of truth.

import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, AlertCircle, TrendingUp } from "lucide-react";
import { MetricTile } from "@/components/financial-pulse/metric-tile";
import { adaptiveRefetchInterval } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { AGING_BUCKET_LABELS } from "@workspace/shared";

export type FinancialPulseVariant =
  | "admin-dashboard"
  | "billing-header"
  | "customer-detail"
  | "ar-aging"
  | "top-customers-compact"
  | "billing-header";

interface BaseProps {
  variant: FinancialPulseVariant;
  className?: string;
}
interface AdminDashboardProps extends BaseProps {
  variant: "admin-dashboard";
}
interface BillingHeaderProps extends BaseProps {
  variant: "billing-header";
}
interface CustomerDetailProps extends BaseProps {
  variant: "customer-detail";
  customerId: number;
}
interface ArAgingProps extends BaseProps {
  variant: "ar-aging";
}
interface TopCustomersCompactProps extends BaseProps {
  variant: "top-customers-compact";
  limit?: number;
}
interface BillingHeaderProps extends BaseProps {
  variant: "billing-header";
}
export type FinancialPulseWidgetProps =
  | AdminDashboardProps
  | BillingHeaderProps
  | CustomerDetailProps
  | ArAgingProps
  | TopCustomersCompactProps
  | BillingHeaderProps;

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return CURRENCY.format(n);
}

// ─── KPIs response (admin-dashboard variant) ──────────────────────────────
interface KpiTile {
  value: number | null;
  deltaPct?: number | null;
  comparedTo?: string;
}
interface KpisResponse {
  billedMtd: KpiTile;
  billedYtd: KpiTile;
  // Task #720 — preferred source for the Collected MTD tile. Older
  // server responses without this field fall back to the derive helper
  // below so we don't regress existing fixtures.
  collectedMtd?: KpiTile;
  outstandingAr: KpiTile;
  unbilledExposure: KpiTile;
  projectedMonthEnd: KpiTile & { method: string };
}

// Task #720 — canonical per-tile captions (matches
// `docs/financial-metrics.md` and the FP page's INFO_TIPS).
const BILLING_HEADER_TIPS = {
  billedMtd:
    "From invoices · month-to-date by createdAt · excludes draft, cancelled · includes tax and markup.",
  collectedMtd:
    "From invoices · month-to-date by paidAt · excludes draft, cancelled · includes tax and markup.",
  outstandingAr:
    "From invoices · point-in-time · excludes draft, cancelled, paid · live from this app, not QuickBooks.",
} as const;

interface CustomerSummary {
  customerId: number;
  name: string | null;
  billedMtd: number;
  billedYtd: number;
  outstandingAr: number;
  unbilledExposure: number;
  avgDaysToPay: number | null;
  lastInvoiceAt: string | null;
  monthly: BudgetBucket;
  annual: BudgetBucket;
}
interface BudgetBucket {
  cap: number | null;
  spend: number;
  percent: number | null;
  status: "unset" | "healthy" | "approaching" | "over";
}

interface AgingBucket {
  key: "current" | "days30" | "days60" | "days90";
  label: string;
  amount: number;
  count: number;
}
interface ArAgingResponse {
  buckets: AgingBucket[];
  total: number;
}

interface TopCustomerRow {
  customerId: number;
  name: string;
  revenue: number;
  monthlyCap: number | null;
  monthlyUsedPct: number | null;
  monthlyStatus: BudgetBucket["status"];
}
interface TopCustomersResponse {
  rows: TopCustomerRow[];
  total: number;
}

// Generic fetch with role-aware soft fail. Returns `null` on 403 so
// the widget can render nothing for roles outside FP's allow-list.
async function fetchFp<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 403 || res.status === 401) return null;
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// ─── Hook ─────────────────────────────────────────────────────────────────

export function useFinancialPulseData<T>(
  variant: FinancialPulseVariant,
  url: string,
  enabled: boolean = true,
) {
  return useQuery<T | null>({
    queryKey: [url],
    queryFn: () => fetchFp<T>(url),
    enabled,
    refetchInterval: adaptiveRefetchInterval(60_000),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

// ─── Card shell ───────────────────────────────────────────────────────────

function WidgetCard({
  title,
  href,
  children,
  className,
  testId,
}: {
  title: string;
  href: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Card className={cn(className)} data-testid={testId}>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base font-semibold text-gray-800 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-gray-500" />
          {title}
        </CardTitle>
        <Link href={href}>
          <a
            className="text-xs text-blue-600 hover:underline flex items-center gap-0.5"
            data-testid={testId ? `${testId}-link` : undefined}
          >
            View on Financial Pulse <ChevronRight className="w-3.5 h-3.5" />
          </a>
        </Link>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ErrorState({ testId }: { testId?: string }) {
  return (
    <div
      className="flex items-center gap-2 text-sm text-gray-500 py-2"
      data-testid={testId ? `${testId}-error` : undefined}
    >
      <AlertCircle className="w-4 h-4 text-amber-500" />
      Financial Pulse data is temporarily unavailable.
    </div>
  );
}

// ─── Variant: admin-dashboard ─────────────────────────────────────────────

function AdminDashboardVariant() {
  const url = "/api/financial-pulse/kpis?period=mtd";
  const { data, isLoading, error } = useFinancialPulseData<KpisResponse>(
    "admin-dashboard",
    url,
  );
  // 403 collapses to null → render nothing so non-FP roles see no chrome.
  if (!isLoading && data == null && !error) return null;
  return (
    <WidgetCard
      title="Financial Pulse"
      href="/financial-pulse"
      testId="fp-widget-admin-dashboard"
    >
      {error ? (
        <ErrorState testId="fp-widget-admin-dashboard" />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricTile
            label="Money Owed"
            value={data?.outstandingAr.value ?? null}
            format="currency"
            isLoading={isLoading}
            testId="fp-tile-outstanding-ar"
          />
          <MetricTile
            label="Work Not Yet Billed"
            value={data?.unbilledExposure.value ?? null}
            format="currency"
            isLoading={isLoading}
            testId="fp-tile-unbilled-exposure"
          />
          <MetricTile
            label="Billed MTD"
            value={data?.billedMtd.value ?? null}
            format="currency"
            deltaPct={data?.billedMtd.deltaPct ?? null}
            isLoading={isLoading}
            testId="fp-tile-billed-mtd"
          />
          <MetricTile
            label="Projected by Month-End"
            value={data?.projectedMonthEnd.value ?? null}
            format="currency"
            isLoading={isLoading}
            testId="fp-tile-projected-month-end"
          />
        </div>
      )}
    </WidgetCard>
  );
}

// ─── Variant: billing-header ──────────────────────────────────────────────
//
// Task #711 — Financial Pulse Slice 5.1: slim status strip mounted at
// the top of the Billing Dashboard. Reuses the same /financial-pulse/
// kpis?period=mtd endpoint as the admin-dashboard variant so Outstanding
// A/R and Billed MTD are guaranteed to match across pages. The third
// tile (Collected MTD) is derived from billedMtd - outstandingAr if the
// endpoint does not yet expose a dedicated collected field — currently
// the response has no `collectedMtd`, so the tile renders the same way
// it would on a soft-fail until that field lands.

// Derive Collected MTD's prev-month delta from the two tiles we DO
// have deltas on (billedMtd / outstandingAr). collected ≈ billed - AR,
// so prevCollected ≈ prevBilled - prevAR; recover prev values from the
// current value + deltaPct. Falls back to `null` (MetricTile renders no
// delta) when any input is missing or the prev value is non-positive.
function deriveCollectedMtdDeltaPct(
  data: KpisResponse | null | undefined,
  currentCollected: number | null,
): number | null {
  if (currentCollected == null) return null;
  const billedNow = data?.billedMtd?.value;
  const billedDelta = data?.billedMtd?.deltaPct;
  const arNow = data?.outstandingAr?.value;
  const arDelta = data?.outstandingAr?.deltaPct;
  if (
    billedNow == null ||
    billedDelta == null ||
    arNow == null ||
    arDelta == null ||
    !Number.isFinite(billedDelta) ||
    !Number.isFinite(arDelta)
  ) {
    return null;
  }
  const prevBilled = billedNow / (1 + billedDelta / 100);
  const prevAr = arNow / (1 + arDelta / 100);
  if (!Number.isFinite(prevBilled) || !Number.isFinite(prevAr)) return null;
  const prevCollected = Math.max(0, prevBilled - prevAr);
  if (prevCollected <= 0) return null;
  return ((currentCollected - prevCollected) / prevCollected) * 100;
}

function BillingHeaderVariant({ className }: { className?: string }) {
  const url = "/api/financial-pulse/kpis?period=mtd";
  const { data, isLoading, error, refetch } =
    useFinancialPulseData<KpisResponse>("billing-header", url);
  // 403 → render nothing for field techs, the only role excluded from FP.
  if (!isLoading && data == null && !error) return null;

  // Task #720 — prefer the server's authoritative `collectedMtd` value
  // when present (the canonical source per docs/financial-metrics.md);
  // fall back to billed − A/R only when older responses omit the field.
  const serverCollected = data?.collectedMtd?.value;
  const hasServerCollected =
    typeof serverCollected === "number" && Number.isFinite(serverCollected);
  const collectedMtdValue = hasServerCollected
    ? serverCollected
    : data &&
        data.billedMtd?.value != null &&
        data.outstandingAr?.value != null
      ? Math.max(0, data.billedMtd.value - data.outstandingAr.value)
      : null;
  const collectedMtdDeltaPct = hasServerCollected
    ? (data?.collectedMtd?.deltaPct ?? null)
    : deriveCollectedMtdDeltaPct(data ?? null, collectedMtdValue);

  return (
    <div
      className={cn(
        "rounded-md px-3 py-2",
        className,
      )}
      style={{
        background: "hsl(var(--primary)/0.05)",
        borderBottom: "1px solid hsl(var(--primary)/0.15)",
      }}
      data-testid="fp-widget-billing-header"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 uppercase tracking-wide">
          <TrendingUp className="w-3.5 h-3.5 text-gray-500" />
          Financial Pulse
        </div>
        <Link href="/financial-pulse">
          <a
            className="text-xs text-blue-600 hover:underline flex items-center gap-0.5"
            data-testid="fp-widget-billing-header-link"
          >
            View Financial Pulse <ChevronRight className="w-3.5 h-3.5" />
          </a>
        </Link>
      </div>
      {error ? (
        <div
          className="flex items-center gap-2"
          data-testid="fp-widget-billing-header-error"
        >
          <div className="grid grid-cols-3 gap-3 flex-1">
            <MetricTile
              label="Billed MTD"
              value={null}
              format="currency"
              isError
              testId="fp-tile-billing-header-billed-mtd"
            />
            <MetricTile
              label="Collected MTD"
              value={null}
              format="currency"
              isError
              testId="fp-tile-billing-header-collected-mtd"
            />
            <MetricTile
              label="Money Owed"
              value={null}
              format="currency"
              isError
              testId="fp-tile-billing-header-outstanding-ar"
            />
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-xs text-blue-600 hover:underline shrink-0"
            data-testid="fp-widget-billing-header-retry"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <MetricTile
            label="Billed MTD"
            value={data?.billedMtd.value ?? null}
            format="currency"
            deltaPct={data?.billedMtd.deltaPct ?? null}
            deltaLabel="vs prev month"
            isLoading={isLoading}
            testId="fp-tile-billing-header-billed-mtd"
            windowBadge="MTD"
            infoTip={BILLING_HEADER_TIPS.billedMtd}
          />
          <MetricTile
            label="Collected MTD"
            value={collectedMtdValue}
            format="currency"
            deltaPct={collectedMtdDeltaPct}
            deltaLabel="vs prev month"
            isLoading={isLoading}
            testId="fp-tile-billing-header-collected-mtd"
            windowBadge="MTD"
            infoTip={BILLING_HEADER_TIPS.collectedMtd}
          />
          <MetricTile
            label="Money Owed"
            value={data?.outstandingAr.value ?? null}
            format="currency"
            deltaPct={data?.outstandingAr.deltaPct ?? null}
            deltaLabel="vs prev month"
            deltaGoodDirection="down"
            isLoading={isLoading}
            testId="fp-tile-billing-header-outstanding-ar"
            infoTip={BILLING_HEADER_TIPS.outstandingAr}
          />
        </div>
      )}
    </div>
  );
}

// ─── Variant: customer-detail ─────────────────────────────────────────────
//
// Task #1003 — audit + fix: "Billed MTD" and "Billed YTD" renamed to
// "Invoiced MTD" / "Invoiced YTD" so the label matches the underlying
// formula (invoice createdAt window, not cash collected). infoTips added
// to all four tiles so first-time viewers can understand each number.

const CUSTOMER_DETAIL_TIPS = {
  invoicedMtd:
    "Invoices created for this customer this month · anchored on invoice date · excludes draft and cancelled · includes tax and markup.",
  invoicedYtd:
    "Invoices created for this customer this calendar year · anchored on invoice date · excludes draft and cancelled · includes uninvoiced wet-check billings by work date.",
  moneyOwed:
    "Unpaid invoices for this customer · point-in-time balance · excludes draft, cancelled, and paid invoices · accuracy depends on QuickBooks payment sync.",
  avgTimeToPay:
    "Average days from invoice creation to payment · measured over the last 90 days · shows '—' when no paid invoices exist in that window.",
} as const;

function statusColor(status: BudgetBucket["status"]): string {
  switch (status) {
    case "over":
      return "bg-rose-500";
    case "approaching":
      return "bg-amber-500";
    case "healthy":
      return "bg-emerald-500";
    default:
      return "bg-gray-300";
  }
}

function BudgetMeter({ bucket }: { bucket: BudgetBucket }) {
  if (bucket.status === "unset" || bucket.cap == null) {
    return (
      <div
        className="text-xs text-gray-500"
        data-testid="fp-widget-budget-meter-unset"
      >
        No monthly budget set
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, (bucket.percent ?? 0) * 100));
  return (
    <div data-testid="fp-widget-budget-meter">
      <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
        <span>
          {formatCurrency(bucket.spend)} of {formatCurrency(bucket.cap)} this month
        </span>
        <span className="font-medium">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={cn("h-full transition-all", statusColor(bucket.status))}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CustomerDetailVariant({ customerId }: { customerId: number }) {
  const url = `/api/financial-pulse/customer/${customerId}/summary`;
  const { data, isLoading, error } = useFinancialPulseData<CustomerSummary>(
    "customer-detail",
    url,
  );
  if (!isLoading && data == null && !error) return null;
  return (
    <WidgetCard
      title="Financial Pulse"
      href={`/financial-pulse?customerId=${customerId}`}
      testId="fp-widget-customer-detail"
    >
      {error ? (
        <ErrorState testId="fp-widget-customer-detail" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricTile
              label="Invoiced MTD"
              value={data?.billedMtd ?? null}
              format="currency"
              isLoading={isLoading}
              testId="fp-tile-cust-billed-mtd"
              accent="blue"
              windowBadge="MTD"
              infoTip={CUSTOMER_DETAIL_TIPS.invoicedMtd}
            />
            <MetricTile
              label="Invoiced YTD"
              value={data?.billedYtd ?? null}
              format="currency"
              isLoading={isLoading}
              testId="fp-tile-cust-billed-ytd"
              accent="blue"
              windowBadge="YTD"
              infoTip={CUSTOMER_DETAIL_TIPS.invoicedYtd}
            />
            <MetricTile
              label="Money Owed"
              value={data?.outstandingAr ?? null}
              format="currency"
              isLoading={isLoading}
              testId="fp-tile-cust-outstanding-ar"
              accent="amber"
              infoTip={CUSTOMER_DETAIL_TIPS.moneyOwed}
            />
            <MetricTile
              label="Avg. Time to Get Paid"
              value={data?.avgDaysToPay ?? null}
              format="days"
              isLoading={isLoading}
              testId="fp-tile-cust-avg-days-to-pay"
              infoTip={CUSTOMER_DETAIL_TIPS.avgTimeToPay}
            />
          </div>
          {data?.monthly && <BudgetMeter bucket={data.monthly} />}
        </div>
      )}
    </WidgetCard>
  );
}

// ─── Variant: ar-aging ────────────────────────────────────────────────────

const AGING_TO_QUERY: Record<
  AgingBucket["key"],
  "current" | "days30" | "days60" | "days90Plus"
> = {
  current: "current",
  days30: "days30",
  days60: "days60",
  days90: "days90Plus",
};

function ArAgingVariant() {
  const url = "/api/financial-pulse/ar-aging?period=mtd";
  const [, setLocation] = useLocation();
  const { data, isLoading, error } = useFinancialPulseData<ArAgingResponse>(
    "ar-aging",
    url,
  );
  if (!isLoading && data == null && !error) return null;
  const buckets =
    data?.buckets ??
    ([
      // Task #1890 — labels come from the shared aging module so this
      // placeholder cannot disagree with what the server sends.
      { key: "current", label: AGING_BUCKET_LABELS.current, amount: 0, count: 0 },
      { key: "days30", label: AGING_BUCKET_LABELS.days30, amount: 0, count: 0 },
      { key: "days60", label: AGING_BUCKET_LABELS.days60, amount: 0, count: 0 },
      { key: "days90", label: AGING_BUCKET_LABELS.days90, amount: 0, count: 0 },
    ] as AgingBucket[]);
  return (
    <WidgetCard
      title="Money Owed by Age"
      href="/financial-pulse"
      testId="fp-widget-ar-aging"
    >
      {error ? (
        <ErrorState testId="fp-widget-ar-aging" />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {buckets.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setLocation(`/invoices?aging=${AGING_TO_QUERY[b.key]}`)}
              className="text-left"
              data-testid={`fp-aging-bucket-${b.key}`}
            >
              <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="pt-5 pb-4">
                  <p className="text-xs sm:text-sm font-medium text-gray-500">
                    {b.label}
                  </p>
                  <div className="mt-1">
                    {isLoading ? (
                      <Skeleton className="h-8 w-24" />
                    ) : (
                      <p className="text-2xl font-bold text-gray-900">
                        {formatCurrency(b.amount)}
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    {b.count} invoice{b.count === 1 ? "" : "s"}
                  </p>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

// ─── Variant: top-customers-compact ───────────────────────────────────────

function statusPill(status: BudgetBucket["status"]) {
  switch (status) {
    case "over":
      return (
        <Badge className="bg-rose-100 text-rose-800 hover:bg-rose-100">Over</Badge>
      );
    case "approaching":
      return (
        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
          Approaching
        </Badge>
      );
    case "healthy":
      return (
        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
          Healthy
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-gray-500">
          —
        </Badge>
      );
  }
}

function TopCustomersCompactVariant({ limit = 5 }: { limit?: number }) {
  const url = `/api/financial-pulse/top-customers?sort=revenue&period=mtd&limit=${limit}`;
  const [, setLocation] = useLocation();
  const { data, isLoading, error } = useFinancialPulseData<TopCustomersResponse>(
    "top-customers-compact",
    url,
  );
  if (!isLoading && data == null && !error) return null;
  const rows = data?.rows ?? [];
  return (
    <WidgetCard
      title="Top Customers"
      href="/financial-pulse"
      testId="fp-widget-top-customers"
    >
      {error ? (
        <ErrorState testId="fp-widget-top-customers" />
      ) : isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-4">No revenue this period</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((r, idx) => {
            const pct =
              r.monthlyUsedPct == null
                ? null
                : Math.max(0, Math.min(100, r.monthlyUsedPct * 100));
            return (
              <li
                key={r.customerId}
                className="flex items-center justify-between gap-3 py-2 cursor-pointer hover:bg-gray-50 -mx-2 px-2 rounded"
                onClick={() => setLocation(`/customers/${r.customerId}/profile`)}
                data-testid={`fp-top-customer-${r.customerId}`}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-xs font-bold text-gray-400 w-4 shrink-0">
                    {idx + 1}
                  </span>
                  <span className="text-sm font-medium text-gray-800 truncate">
                    {r.name}
                  </span>
                </div>
                <span className="text-sm font-semibold text-gray-900 shrink-0 tabular-nums">
                  {formatCurrency(r.revenue)}
                </span>
                <div className="w-16 shrink-0 hidden sm:block">
                  {pct == null ? (
                    <span className="text-xs text-gray-400">—</span>
                  ) : (
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full",
                          statusColor(r.monthlyStatus),
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
                <div className="shrink-0">{statusPill(r.monthlyStatus)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}

// ─── Public component ────────────────────────────────────────────────────

export function FinancialPulseWidget(props: FinancialPulseWidgetProps) {
  switch (props.variant) {
    case "admin-dashboard":
      return <AdminDashboardVariant />;
    case "billing-header":
      return <BillingHeaderVariant className={props.className} />;
    case "customer-detail":
      return <CustomerDetailVariant customerId={props.customerId} />;
    case "ar-aging":
      return <ArAgingVariant />;
    case "top-customers-compact":
      return <TopCustomersCompactVariant limit={props.limit} />;
  }
}
