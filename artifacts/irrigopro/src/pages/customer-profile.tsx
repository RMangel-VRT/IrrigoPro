import { safeGet } from "@/utils/safeStorage";
import { useState, useEffect } from "react";
import { useParams, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useArrayQuery } from "@/lib/queryClient";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft, MapPin, Phone, Mail, Building, FileText, Receipt, DollarSign,
  Bell, Droplets, Wrench, Calendar, Package, ChevronDown, ChevronRight, User,
  LayoutDashboard, Trees, Edit, ClipboardList, Clock, Building2, CheckCircle, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Customer, Estimate, WorkOrder, BillingSheetWithItems, SiteMap } from "@workspace/db/schema";
import { lifecycleOf, formatEstimateNumber } from "@workspace/shared";
import { InvoiceList } from "@/components/billing/invoice-list";
import { InvoicePdfPreviewModal } from "@/components/billing/invoice-pdf-preview-modal";
import { IrrigationSystemCard } from "@/components/customers/irrigation-system-card";
import { FinancialPulseWidget } from "@/components/financial-pulse/financial-pulse-widget";
import { EstimateDetailModal } from "@/components/estimates/estimate-detail-modal";
import { CompletedWorkDetailModal } from "@/components/billing/completed-work-detail-modal";
import { PropertyNotes } from "@/components/customers/property-notes";
import { PropertyBoundarySection } from "@/components/customers/property-boundary";
import { BillingNotes } from "@/components/customers/billing-notes";
import { BilledIndicator, BilledBadge } from "@/components/ui/billed-indicator";
import { displayCustomerAddress } from "@/lib/customer-address";

type TabId = "overview" | "jobs" | "billing" | "property" | "irrigation";

const ALL_TABS: TabId[] = ["overview", "jobs", "billing", "property", "irrigation"];

function parseTab(raw: string | null): TabId {
  if (raw && (ALL_TABS as string[]).includes(raw)) return raw as TabId;
  return "overview";
}

// Static per-tab active-state Tailwind class strings — defined at module level with complete
// literal values so Tailwind's content scanner includes them in the generated bundle.
// Never interpolate these: the data-[state=active]: prefix must appear verbatim.
const TAB_ACTIVE_CLASSES: Record<string, string> = {
  overview:   "data-[state=active]:border-blue-500 data-[state=active]:text-blue-700",
  jobs:       "data-[state=active]:border-indigo-500 data-[state=active]:text-indigo-700",
  billing:    "data-[state=active]:border-emerald-500 data-[state=active]:text-emerald-700",
  property:   "data-[state=active]:border-amber-500 data-[state=active]:text-amber-700",
  irrigation: "data-[state=active]:border-sky-500 data-[state=active]:text-sky-700",
};
const TAB_INACTIVE_CLASS = "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300";

// Financial summary shape from /api/financial-pulse/customer/:id/summary
interface CustomerFinancialSummary {
  customerId: number;
  billedMtd: number;
  billedYtd: number;
  outstandingAr: number;
  avgDaysToPay: number | null;
}

export default function CustomerProfile() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const search = useSearch();

  const activeTab = parseTab(new URLSearchParams(search).get("tab"));

  function setTab(tab: TabId) {
    const params = new URLSearchParams(search);
    params.set("tab", tab);
    setLocation(`/customers/${id}/profile?${params.toString()}`);
  }

  const [userRole, setUserRole] = useState<string>("");

  // Invoice PDF modal
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [selectedPdfInvoice, setSelectedPdfInvoice] = useState<{
    invoiceId: number;
    invoiceNumber: string;
    customerEmail: string;
  } | null>(null);

  // Jobs list modals
  const [selectedEstimateId, setSelectedEstimateId] = useState<number | null>(null);
  const [estimateModalOpen, setEstimateModalOpen] = useState(false);
  const [selectedWorkOrder, setSelectedWorkOrder] = useState<WorkOrder | null>(null);
  const [workOrderModalOpen, setWorkOrderModalOpen] = useState(false);
  const [selectedBillingSheet, setSelectedBillingSheet] = useState<BillingSheetWithItems | null>(null);
  const [billedWOExpanded, setBilledWOExpanded] = useState(false);
  const [billedBSExpanded, setBilledBSExpanded] = useState(false);

  useEffect(() => {
    const savedUser = safeGet("user");
    if (savedUser) {
      try {
        const userData = JSON.parse(savedUser);
        setUserRole(userData.role || "");
      } catch {}
    }
  }, []);

  const { data: customer, isLoading } = useQuery<Customer>({
    queryKey: [`/api/customers/${id}`],
  });

  const { data: estimates = [] } = useArrayQuery<Estimate>({
    queryKey: [`/api/customers/${id}/estimates`],
    enabled: !!id,
  });

  const { data: workOrders = [] } = useArrayQuery<WorkOrder>({
    queryKey: [`/api/customers/${id}/work-orders`],
    enabled: !!id,
  });

  const { data: billingSheets = [] } = useArrayQuery<BillingSheetWithItems>({
    queryKey: [`/api/customers/${id}/billing-sheets`],
    enabled: !!id,
  });

  // Financial summary for Overview compact snapshot — same endpoint as FinancialPulseWidget
  const { data: financialSummary } = useQuery<CustomerFinancialSummary>({
    queryKey: [`/api/financial-pulse/customer/${id}/summary`],
    enabled: !!id && !!userRole,
  });

  const isAdmin = userRole === "company_admin" || userRole === "super_admin";
  const isBillingRole =
    userRole === "company_admin" ||
    userRole === "super_admin" ||
    userRole === "billing_manager";
  const canEditIrrigation =
    userRole === "company_admin" ||
    userRole === "super_admin" ||
    userRole === "billing_manager";

  const isWOBilled = (wo: WorkOrder) => wo.status === "billed" || !!wo.invoiceId;
  const isBSBilled = (bs: BillingSheetWithItems) => bs.status === "billed" || !!bs.invoiceId;

  const handleOpenPdf = (invoiceId: number, invoiceNumber: string, customerEmail: string) => {
    setSelectedPdfInvoice({ invoiceId, invoiceNumber, customerEmail });
    setShowPdfModal(true);
  };

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

  const formatDate = (date: string | Date) =>
    new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

  const totalEstimateValue = estimates.reduce((s, e) => s + Number(e.totalAmount || 0), 0);
  const totalBillingValue = billingSheets.reduce((s, b) => s + Number(b.totalAmount || 0), 0);

  const getStatusBadge = (status: string) => {
    const cfg: Record<string, { color: string; icon: string; bg: string }> = {
      pending:                { color: "text-amber-700",   icon: "⏳", bg: "bg-amber-50 border-amber-200" },
      approved:               { color: "text-emerald-700", icon: "✅", bg: "bg-emerald-50 border-emerald-200" },
      rejected:               { color: "text-red-700",     icon: "❌", bg: "bg-red-50 border-red-200" },
      converted_to_work_order:{ color: "text-blue-700",   icon: "🔄", bg: "bg-blue-50 border-blue-200" },
      sent:                   { color: "text-blue-700",    icon: "📨", bg: "bg-blue-50 border-blue-200" },
      draft:                  { color: "text-gray-700",    icon: "📝", bg: "bg-gray-50 border-gray-200" },
      assigned:               { color: "text-indigo-700",  icon: "👤", bg: "bg-indigo-50 border-indigo-200" },
      in_progress:            { color: "text-purple-700",  icon: "🔧", bg: "bg-purple-50 border-purple-200" },
      completed:              { color: "text-green-700",   icon: "✅", bg: "bg-green-50 border-green-200" },
      cancelled:              { color: "text-gray-700",    icon: "🚫", bg: "bg-gray-50 border-gray-200" },
      billed:                 { color: "text-orange-700",  icon: "💰", bg: "bg-orange-50 border-orange-200" },
    };
    const c = cfg[status] ?? { color: "text-gray-700", icon: "?", bg: "bg-gray-50 border-gray-200" };
    return (
      <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border font-medium text-xs ${c.bg} ${c.color}`}>
        <span>{c.icon}</span>
        {status.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())}
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="px-4 py-6 max-w-[1600px] mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-32 bg-gray-200 rounded" />
          <div className="h-24 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="px-4 py-6 max-w-[1600px] mx-auto">
        <div className="text-center py-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Customer Not Found</h2>
          <p className="text-gray-600 mb-4">The customer you're looking for doesn't exist.</p>
          <Button onClick={() => setLocation("/customers")}>
            <ArrowLeft className="w-4 h-4 mr-2" />Back to Customers
          </Button>
        </div>
      </div>
    );
  }

  const displayName = customer.irrigoName || customer.name;
  const addr = displayCustomerAddress(customer);

  // ── Tab visibility (role-derived) ───────────────────────────────────────────
  // A tab is hidden if ALL its content sections are gated away for this role.
  // Each entry is computed from the same gates used inside the matching TabsContent.
  const tabVisibility: Record<TabId, boolean> = {
    // Overview: KPI tiles + Customer Info — both ungated for every role
    overview: true,

    // Jobs: Estimates, Work Orders, Billing Sheets — all three lists are ungated
    jobs: true,

    // Billing Details: contains two categories of sections:
    //   1. Billing-specific (Rates, Notes, FinancialPulse, Budget, Alerts) — isBillingRole
    //   2. InvoiceList — ungated (visible to all roles, same as original long-scroll page)
    // Tab has content for ANY role because InvoiceList is always present.
    billing: isBillingRole || true, // always true; derived for auditability

    // Property: PropertyNotes + PropertyBoundarySection + Site Maps — all ungated
    property: true,

    // Irrigation System: IrrigationSystemCard is ungated;
    // canEditIrrigation only gates the edit/modify actions inside the card
    irrigation: true,
  };

  // If the URL tab is not visible for this role, fall back to overview
  const safeActiveTab: TabId = tabVisibility[activeTab] ? activeTab : "overview";

  interface TabDef {
    id: TabId;
    label: string;
    Icon: React.ElementType;
  }

  const tabDefs = ([
    { id: "overview" as TabId, label: "Overview",          Icon: LayoutDashboard },
    { id: "jobs",              label: "Jobs",              Icon: Wrench          },
    { id: "billing",           label: "Billing Details",   Icon: Receipt         },
    { id: "property",          label: "Property",          Icon: Trees           },
    { id: "irrigation",        label: "Irrigation System", Icon: Droplets        },
  ] as TabDef[]).filter((t) => tabVisibility[t.id]);

  return (
    <div className="px-4 sm:px-6 py-4 max-w-[1600px] mx-auto">
      <Tabs
        value={safeActiveTab}
        onValueChange={(v) => setTab(v as TabId)}
        className="w-full"
      >
        {/* ── Persistent Sticky Header ────────────────────────────────── */}
        <div className="bg-white border-b border-gray-200 sticky top-0 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6">
          {/* Top row */}
          <div className="flex flex-wrap items-start gap-3 pt-4 pb-3">
            <Button variant="ghost" size="sm" onClick={() => setLocation("/customers")} className="shrink-0 -ml-2 mt-0.5">
              <ArrowLeft className="w-4 h-4 mr-1" />Back
            </Button>
            {/* Gradient avatar tile */}
            <div className="shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center shadow-sm mt-0.5">
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900 leading-tight">{displayName}</h1>
                {/* Green "Active" chip */}
                <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200 text-xs font-medium">
                  <CheckCircle className="w-3.5 h-3.5" />Active
                </span>
                {/* Sky "QuickBooks Synced" chip */}
                {customer.quickbooksId && (
                  <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-sky-300 text-sky-700 text-xs font-medium">
                    <RefreshCw className="w-3 h-3" />QuickBooks Synced
                  </span>
                )}
              </div>
              {customer.irrigoName && customer.irrigoName !== customer.name && (
                <p className="text-sm text-gray-500 mt-0.5">Official: {customer.name}</p>
              )}
              {/* Compact contact line */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 mt-1 text-sm text-gray-500">
                {customer.email && (
                  <span className="flex items-center gap-1"><Mail className="w-3.5 h-3.5 text-gray-400" />{customer.email}</span>
                )}
                {customer.phone && (
                  <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5 text-gray-400" />{customer.phone}</span>
                )}
                {addr && (
                  <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5 text-gray-400" />{addr}</span>
                )}
              </div>
            </div>
            {/* Primary action buttons */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button size="sm" onClick={() => setLocation(`/customers/${id}/site-maps`)} className="bg-blue-600 hover:bg-blue-700 text-white">
                <MapPin className="w-4 h-4 mr-1.5" />View Site Map
              </Button>
              <Button size="sm" variant="outline" className="border-sky-300 text-sky-700 hover:bg-sky-50" onClick={() => setLocation(`/customers/${id}/irrigation-profile`)}>
                <Droplets className="w-4 h-4 mr-1.5" />Controllers &amp; Zones
              </Button>
              {isAdmin && (
                <Button size="sm" variant="outline" onClick={() => setLocation(`/customers?edit=${id}`)}>
                  <Edit className="w-4 h-4 mr-1.5" />Edit Customer
                </Button>
              )}
            </div>
          </div>

          {/* Tab bar — uses Tabs primitives; scrolls horizontally on mobile */}
          <div className="overflow-x-auto -mx-1 px-1">
            <TabsList className="inline-flex gap-0 bg-transparent p-0 h-auto rounded-none min-w-max">
              {tabDefs.map(({ id: tabId, label, Icon }) => (
                <TabsTrigger
                  key={tabId}
                  value={tabId}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap rounded-none bg-transparent shadow-none",
                    "data-[state=active]:bg-transparent data-[state=active]:shadow-none",
                    TAB_ACTIVE_CLASSES[tabId],
                    TAB_INACTIVE_CLASS,
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                  {tabId === "jobs" && (
                    <span className="ml-1 text-xs font-bold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 data-[state=active]:bg-indigo-100 data-[state=active]:text-indigo-700">
                      {estimates.length + workOrders.length + billingSheets.length}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>

        {/* ── Tab Content ─────────────────────────────────────────────── */}
        <div className="pt-6">

          {/* ── Overview Tab ──────────────────────────────────────────── */}
          <TabsContent value="overview" className="space-y-6 mt-0">
            {/* KPI tiles */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <button
                onClick={() => setTab("jobs")}
                className="bg-white rounded-xl p-4 shadow-sm border border-blue-100 hover:shadow-md hover:border-blue-200 transition-all text-left"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="bg-blue-100 p-2 rounded-lg"><FileText className="w-5 h-5 text-blue-600" /></div>
                  <div className="text-3xl font-bold text-blue-700">{estimates.length}</div>
                </div>
                <div className="text-sm font-semibold text-gray-700">Estimates</div>
                <div className="text-sm text-blue-600 font-medium mt-0.5">{formatCurrency(totalEstimateValue)}</div>
              </button>
              <button
                onClick={() => setTab("jobs")}
                className="bg-white rounded-xl p-4 shadow-sm border border-indigo-100 hover:shadow-md hover:border-indigo-200 transition-all text-left"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="bg-indigo-100 p-2 rounded-lg"><Wrench className="w-5 h-5 text-indigo-600" /></div>
                  <div className="text-3xl font-bold text-indigo-700">{workOrders.length}</div>
                </div>
                <div className="text-sm font-semibold text-gray-700">Work Orders</div>
                <div className="text-sm text-indigo-600 font-medium mt-0.5">Active Projects</div>
              </button>
              <button
                onClick={() => setTab("jobs")}
                className="bg-white rounded-xl p-4 shadow-sm border border-amber-100 hover:shadow-md hover:border-amber-200 transition-all text-left"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="bg-amber-100 p-2 rounded-lg"><ClipboardList className="w-5 h-5 text-amber-600" /></div>
                  <div className="text-3xl font-bold text-amber-700">{billingSheets.length}</div>
                </div>
                <div className="text-sm font-semibold text-gray-700">Billing Sheets</div>
                <div className="text-sm text-amber-600 font-medium mt-0.5">{formatCurrency(totalBillingValue)}</div>
              </button>
            </div>

            {/* lg:grid-cols-3 layout: Customer Info (main) + Financial Snapshot (side rail) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Customer Information */}
              <div className="lg:col-span-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Building className="w-5 h-5" />Customer Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {customer.email && (
                      <div className="flex items-center gap-3">
                        <Mail className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{customer.email}</span>
                      </div>
                    )}
                    {customer.phone && (
                      <div className="flex items-center gap-3">
                        <Phone className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{customer.phone}</span>
                      </div>
                    )}
                    {addr && (
                      <div className="flex items-start gap-3">
                        <MapPin className="w-4 h-4 text-gray-500 mt-0.5" />
                        <span className="text-sm">{addr}</span>
                      </div>
                    )}
                    {!customer.email && !customer.phone && !addr && (
                      <p className="text-sm text-gray-400">No contact information on file.</p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Financial Snapshot side rail */}
              <div className="lg:col-span-1">
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <DollarSign className="w-4 h-4 text-emerald-600" />Financial Snapshot
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {financialSummary ? (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
                            <p className="text-xs text-blue-700 font-medium uppercase tracking-wide mb-1">Invoiced MTD</p>
                            <p className="text-base font-bold text-blue-800">{formatCurrency(financialSummary.billedMtd)}</p>
                          </div>
                          <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
                            <p className="text-xs text-blue-700 font-medium uppercase tracking-wide mb-1">Invoiced YTD</p>
                            <p className="text-base font-bold text-blue-800">{formatCurrency(financialSummary.billedYtd)}</p>
                          </div>
                          <div className="bg-amber-50 rounded-lg p-3 border border-amber-100">
                            <p className="text-xs text-amber-700 font-medium uppercase tracking-wide mb-1">Money Owed</p>
                            <p className="text-base font-bold text-amber-800">{formatCurrency(financialSummary.outstandingAr)}</p>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                            <p className="text-xs text-gray-600 font-medium uppercase tracking-wide mb-1 flex items-center gap-1">
                              <Clock className="w-3 h-3" />Avg to Pay
                            </p>
                            <p className="text-base font-bold text-gray-800">
                              {financialSummary.avgDaysToPay != null
                                ? `${Math.round(financialSummary.avgDaysToPay)}d`
                                : "—"}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="outline" size="sm"
                          className="w-full text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                          onClick={() => setTab("billing")}
                        >
                          <Receipt className="w-4 h-4 mr-1.5" />View Billing Details
                        </Button>
                      </>
                    ) : (
                      <div className="space-y-3">
                        <div className="bg-emerald-50 rounded-lg p-3 border border-emerald-100">
                          <p className="text-xs text-emerald-700 font-medium uppercase tracking-wide mb-1">Total Billed</p>
                          <p className="text-xl font-bold text-emerald-800">{formatCurrency(totalBillingValue)}</p>
                          <p className="text-xs text-emerald-600 mt-0.5">{billingSheets.length} billing sheets</p>
                        </div>
                        <Button
                          variant="outline" size="sm"
                          className="w-full text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                          onClick={() => setTab("billing")}
                        >
                          <Receipt className="w-4 h-4 mr-1.5" />View Billing Details
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>

          {/* ── Jobs Tab — three lists side-by-side at lg ─────────────── */}
          <TabsContent value="jobs" className="mt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

              {/* Estimates column */}
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                  <h2 className="font-semibold text-gray-800 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-jobtype-est" />
                    Estimates
                    <span className="text-xs bg-jobtype-est/10 text-jobtype-est font-bold px-1.5 py-0.5 rounded-full">{estimates.length}</span>
                  </h2>
                  <span className="text-xs font-medium text-jobtype-est">{formatCurrency(totalEstimateValue)}</span>
                </div>
                {estimates.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center text-gray-400">
                    <FileText className="w-8 h-8 mb-2 opacity-40" />
                    <p className="text-sm">No estimates yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {estimates.map((estimate) => (
                      <div
                        key={estimate.id}
                        className="group bg-white rounded-lg border border-l-4 border-l-jobtype-est hover:shadow-md transition-all cursor-pointer p-3"
                        onClick={() => { setSelectedEstimateId(estimate.id); setEstimateModalOpen(true); }}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm text-gray-900 group-hover:text-jobtype-est transition-colors truncate">
                              {formatEstimateNumber(estimate.estimateNumber)}
                            </p>
                            <p className="text-xs text-gray-500 truncate">{estimate.projectName}</p>
                          </div>
                          <div className="shrink-0">{getStatusBadge(lifecycleOf(estimate))}</div>
                        </div>
                        <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />{formatDate(estimate.createdAt)}
                          </span>
                          <span className="font-semibold text-jobtype-est">{formatCurrency(Number(estimate.totalAmount || 0))}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Work Orders column */}
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                  <h2 className="font-semibold text-gray-800 flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-jobtype-wo" />
                    Work Orders
                    <span className="text-xs bg-jobtype-wo/10 text-jobtype-wo font-bold px-1.5 py-0.5 rounded-full">{workOrders.length}</span>
                  </h2>
                </div>
                {workOrders.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center text-gray-400">
                    <Wrench className="w-8 h-8 mb-2 opacity-40" />
                    <p className="text-sm">No work orders yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {workOrders.filter((wo) => !isWOBilled(wo)).map((workOrder) => (
                      <div
                        key={workOrder.id}
                        className="group bg-white rounded-lg border border-l-4 border-l-jobtype-wo hover:shadow-md transition-all cursor-pointer p-3"
                        onClick={() => { setSelectedWorkOrder(workOrder); setWorkOrderModalOpen(true); }}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm text-gray-900 group-hover:text-jobtype-wo transition-colors truncate">
                              {workOrder.workOrderNumber}
                            </p>
                            <p className="text-xs text-gray-500 truncate">{workOrder.projectName}</p>
                          </div>
                          <div className="shrink-0">{getStatusBadge(workOrder.status)}</div>
                        </div>
                        <div className="mt-2 text-xs text-gray-500 flex items-center gap-1">
                          <Calendar className="w-3 h-3" />{formatDate(workOrder.createdAt)}
                        </div>
                      </div>
                    ))}
                    {workOrders.filter((wo) => isWOBilled(wo)).length > 0 && (
                      <div className="border border-green-200 rounded-lg overflow-hidden">
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 bg-green-50 hover:bg-green-100 transition-colors text-left text-sm font-medium text-green-800"
                          onClick={() => setBilledWOExpanded(!billedWOExpanded)}
                        >
                          {billedWOExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          Billed ({workOrders.filter((wo) => isWOBilled(wo)).length})
                        </button>
                        {billedWOExpanded && (
                          <div className="space-y-2 p-2 bg-green-50/30">
                            {workOrders.filter((wo) => isWOBilled(wo)).map((workOrder) => (
                              <div
                                key={workOrder.id}
                                className="bg-green-50/60 border border-l-4 border-l-green-400 rounded-lg cursor-pointer hover:shadow-sm transition-shadow p-3"
                                onClick={() => { setSelectedWorkOrder(workOrder); setWorkOrderModalOpen(true); }}
                              >
                                <div className="flex items-start gap-2">
                                  <div className="flex-1 min-w-0">
                                    <p className="font-semibold text-sm text-gray-900 truncate">{workOrder.workOrderNumber}</p>
                                    <p className="text-xs text-gray-500 truncate">{workOrder.projectName}</p>
                                  </div>
                                  <BilledBadge />
                                </div>
                                <div className="mt-2">
                                  <BilledIndicator compact invoiceId={workOrder.invoiceId} billedAt={workOrder.billedAt} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Billing Sheets column */}
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                  <h2 className="font-semibold text-gray-800 flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-jobtype-bs" />
                    Billing Sheets
                    <span className="text-xs bg-jobtype-bs/10 text-jobtype-bs font-bold px-1.5 py-0.5 rounded-full">{billingSheets.length}</span>
                  </h2>
                  <span className="text-xs font-medium text-jobtype-bs">{formatCurrency(totalBillingValue)}</span>
                </div>
                {billingSheets.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center text-gray-400">
                    <ClipboardList className="w-8 h-8 mb-2 opacity-40" />
                    <p className="text-sm">No billing sheets yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {billingSheets.filter((bs) => !isBSBilled(bs)).map((billingSheet) => (
                      <div
                        key={billingSheet.id}
                        className="group bg-white rounded-lg border border-l-4 border-l-jobtype-bs hover:shadow-md transition-all cursor-pointer p-3"
                        onClick={() => setSelectedBillingSheet(billingSheet)}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm text-gray-900 group-hover:text-jobtype-bs transition-colors truncate">
                              {billingSheet.billingNumber}
                            </p>
                            <p className="text-xs text-gray-500 truncate">{billingSheet.notes || "Billing sheet"}</p>
                          </div>
                          <div className="shrink-0">{getStatusBadge(billingSheet.status)}</div>
                        </div>
                        <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                          <span className="flex items-center gap-1"><User className="w-3 h-3" />{billingSheet.technicianName}</span>
                          <span className="font-bold text-jobtype-bs">{formatCurrency(Number(billingSheet.totalAmount || 0))}</span>
                        </div>
                      </div>
                    ))}
                    {billingSheets.filter((bs) => isBSBilled(bs)).length > 0 && (
                      <div className="border border-purple-200 rounded-lg overflow-hidden">
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 bg-purple-50 hover:bg-purple-100 transition-colors text-left text-sm font-medium text-purple-800"
                          onClick={() => setBilledBSExpanded(!billedBSExpanded)}
                        >
                          {billedBSExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          Billed ({billingSheets.filter((bs) => isBSBilled(bs)).length})
                        </button>
                        {billedBSExpanded && (
                          <div className="space-y-2 p-2 bg-purple-50/30">
                            {billingSheets.filter((bs) => isBSBilled(bs)).map((billingSheet) => (
                              <div
                                key={billingSheet.id}
                                className="bg-purple-50/60 border border-l-4 border-l-purple-400 rounded-lg cursor-pointer hover:shadow-sm transition-shadow p-3"
                                onClick={() => setSelectedBillingSheet(billingSheet)}
                              >
                                <div className="flex items-start gap-2">
                                  <div className="flex-1 min-w-0">
                                    <p className="font-semibold text-sm text-gray-900 truncate">{billingSheet.billingNumber}</p>
                                    <p className="text-xs text-gray-500 truncate">{billingSheet.notes || "Billing sheet"}</p>
                                  </div>
                                  <div className="flex flex-col items-end gap-1">
                                    <BilledBadge />
                                    <span className="text-xs font-bold text-purple-700">{formatCurrency(Number(billingSheet.totalAmount || 0))}</span>
                                  </div>
                                </div>
                                <div className="mt-2">
                                  <BilledIndicator compact invoiceId={billingSheet.invoiceId} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── Billing Details Tab ──────────────────────────────────────── */}
          <TabsContent value="billing" className="space-y-6 mt-0">
            {/* Billing-role-only sections */}
            {isBillingRole && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <DollarSign className="w-5 h-5" />Billing Rates
                        <span className="text-xs font-normal text-gray-400 ml-1">(billing team only)</span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-gray-50 rounded-lg p-3 border">
                          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Labor Rate</p>
                          <p className="text-lg font-semibold text-gray-900">
                            {formatCurrency(Number(customer.laborRate || 45))}
                            <span className="text-sm font-normal text-gray-500">/hr</span>
                          </p>
                        </div>
                        <div className="bg-orange-50 rounded-lg p-3 border border-orange-200">
                          <p className="text-xs text-orange-600 uppercase tracking-wide mb-1">Emergency Rate</p>
                          <p className="text-lg font-semibold text-orange-700">
                            {formatCurrency(Number(customer.emergencyLaborRate || 125))}
                            <span className="text-sm font-normal text-orange-500">/hr</span>
                          </p>
                        </div>
                        {customer.discountPercent && parseFloat(customer.discountPercent) > 0 && (
                          <div className="bg-gray-50 rounded-lg p-3 border col-span-2">
                            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Discount</p>
                            <p className="text-lg font-semibold text-gray-900">
                              {parseFloat(customer.discountPercent).toFixed(0)}
                              <span className="text-sm font-normal text-gray-500">%</span>
                            </p>
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-3">
                        These rates are applied automatically when invoices are generated. Use Edit Customer to update.
                      </p>
                    </CardContent>
                  </Card>
                  <BillingNotes customer={customer} userRole={userRole} />
                </div>
                <FinancialPulseWidget variant="customer-detail" customerId={parseInt(id!, 10)} />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <BudgetCard customerId={parseInt(id!, 10)} />
                  <RecentBudgetAlertsCard customerId={parseInt(id!, 10)} />
                </div>
              </>
            )}
            {/* InvoiceList — visible to all roles (same as original long-scroll page) */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Receipt className="w-5 h-5" />Invoices
                </CardTitle>
              </CardHeader>
              <CardContent>
                <InvoiceList customerId={parseInt(id!)} limit={10} onOpenPdf={handleOpenPdf} />
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Property Tab ────────────────────────────────────────────── */}
          <TabsContent value="property" className="space-y-6 mt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <PropertyNotes customer={customer} userRole={userRole} />
              <PropertyBoundarySection customer={customer} userRole={userRole} />
            </div>
            <SiteMapsSection customerId={parseInt(id!, 10)} onViewFull={() => setLocation(`/customers/${id}/site-maps`)} />
          </TabsContent>

          {/* ── Irrigation System Tab ────────────────────────────────────── */}
          <TabsContent value="irrigation" className="mt-0">
            <IrrigationSystemCard customer={customer} canManageControllers={canEditIrrigation} />
          </TabsContent>
        </div>
      </Tabs>

      {/* ── Modals (outside Tabs so they render regardless of active tab) ── */}
      {estimateModalOpen && selectedEstimateId && (
        <EstimateDetailModal
          open={estimateModalOpen}
          onOpenChange={(open) => { setEstimateModalOpen(open); if (!open) setSelectedEstimateId(null); }}
          estimateId={selectedEstimateId}
        />
      )}
      {workOrderModalOpen && selectedWorkOrder && (
        <CompletedWorkDetailModal
          type="work_order"
          id={selectedWorkOrder.id}
          data={selectedWorkOrder}
          open={workOrderModalOpen}
          onOpenChange={(open) => { setWorkOrderModalOpen(open); if (!open) setSelectedWorkOrder(null); }}
          showPricing={true}
        />
      )}
      {selectedBillingSheet && (
        <CompletedWorkDetailModal
          type="billing_sheet"
          id={selectedBillingSheet.id}
          data={selectedBillingSheet}
          open={!!selectedBillingSheet}
          onOpenChange={(open) => { if (!open) setSelectedBillingSheet(null); }}
          showPricing={true}
        />
      )}
      {selectedPdfInvoice && (
        <InvoicePdfPreviewModal
          invoiceId={selectedPdfInvoice.invoiceId}
          invoiceNumber={selectedPdfInvoice.invoiceNumber}
          customerEmail={selectedPdfInvoice.customerEmail}
          open={showPdfModal}
          onOpenChange={setShowPdfModal}
        />
      )}
    </div>
  );
}

// ─── Site Maps section (Property tab) ────────────────────────────────────────

function SiteMapsSection({
  customerId,
  onViewFull,
}: {
  customerId: number;
  onViewFull: () => void;
}) {
  const { data: siteMaps = [], isLoading } = useArrayQuery<SiteMap>({
    queryKey: [`/api/customers/${customerId}/site-maps`],
    enabled: !!customerId,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-amber-600" />Site Maps
          </CardTitle>
          <Button size="sm" onClick={onViewFull} className="bg-amber-600 hover:bg-amber-700">
            <MapPin className="w-4 h-4 mr-1.5" />Open Site Maps
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : siteMaps.length === 0 ? (
          <div className="text-center py-8">
            <MapPin className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500 mb-3">No site maps yet</p>
            <Button size="sm" variant="outline" onClick={onViewFull}>
              Create a site map
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {siteMaps.map((sm) => (
              <button
                key={sm.id}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-amber-100 bg-amber-50/40 hover:bg-amber-50 hover:border-amber-200 transition-all text-left group"
                onClick={onViewFull}
              >
                <div className="bg-amber-100 p-1.5 rounded-md shrink-0">
                  <MapPin className="w-4 h-4 text-amber-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-gray-900 group-hover:text-amber-800 transition-colors truncate">
                    {sm.name}
                  </p>
                  {sm.description && (
                    <p className="text-xs text-gray-500 truncate">{sm.description}</p>
                  )}
                </div>
              </button>
            ))}
            {siteMaps.length > 0 && (
              <p className="text-xs text-gray-400 text-center pt-1">
                {siteMaps.length} site map{siteMaps.length !== 1 ? "s" : ""} · click to open the full map editor
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Budget & Alerts cards (billing roles only) ──────────────────────────────
type BudgetStatus = "unset" | "healthy" | "approaching" | "over";
interface BudgetUsage {
  customerId: number;
  softThresholdPercent: number;
  hardThresholdPercent: number;
  currentMonthKey: string;
  currentYearKey: string;
  monthlyCap: number | null;
  monthlySpend: number;
  monthlyPercent: number | null;
  monthlyStatus: BudgetStatus;
  annualCap: number | null;
  annualSpend: number;
  annualPercent: number | null;
  annualStatus: BudgetStatus;
}

function statusBadge(status: BudgetStatus) {
  switch (status) {
    case "over":        return <Badge className="bg-red-600 text-white">Over cap</Badge>;
    case "approaching": return <Badge className="bg-amber-500 text-white">Approaching cap</Badge>;
    case "healthy":     return <Badge className="bg-emerald-600 text-white">On track</Badge>;
    default:            return <Badge variant="outline">No cap set</Badge>;
  }
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

interface BudgetBucket {
  cap: number | null;
  spend: number;
  percent: number | null;
  status: BudgetStatus;
  periodKey: string;
}

const BUCKET_ACCENT: Record<BudgetStatus, string> = {
  healthy:    "border-l-4 border-emerald-400 bg-emerald-50/40",
  approaching:"border-l-4 border-amber-400 bg-amber-50/40",
  over:       "border-l-4 border-rose-400 bg-rose-50/40",
  unset:      "",
};

function BudgetBucketRow({ label, bucket }: { label: string; bucket: BudgetBucket }) {
  const pct = bucket.percent != null ? Math.min(100, Math.round(bucket.percent * 100)) : 0;
  return (
    <div className={`rounded-md border p-3 bg-white shadow-sm ${BUCKET_ACCENT[bucket.status] ?? ""}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-sm text-gray-700">
          {label} <span className="text-xs text-gray-400">({bucket.periodKey})</span>
        </span>
        {statusBadge(bucket.status)}
      </div>
      {bucket.cap == null ? (
        <p className="text-xs text-gray-500">Spent {fmtCurrency(bucket.spend)} — no cap configured.</p>
      ) : (
        <>
          <Progress value={pct} />
          <p className="text-xs text-gray-600 mt-1">
            {fmtCurrency(bucket.spend)} of {fmtCurrency(bucket.cap)}
            {bucket.percent != null && ` (${Math.round(bucket.percent * 100)}%)`}
          </p>
        </>
      )}
    </div>
  );
}

function BudgetCard({ customerId }: { customerId: number }) {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useQuery<BudgetUsage>({
    queryKey: [`/api/customers/${customerId}/budget-usage`],
  });
  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Bell className="w-5 h-5" />Budget &amp; Alerts</CardTitle></CardHeader>
        <CardContent><div className="h-16 bg-gray-100 rounded animate-pulse" /></CardContent>
      </Card>
    );
  }
  if (!data) return null;
  const monthlyBucket: BudgetBucket = { cap: data.monthlyCap, spend: data.monthlySpend, percent: data.monthlyPercent, status: data.monthlyStatus, periodKey: data.currentMonthKey };
  const annualBucket: BudgetBucket  = { cap: data.annualCap,  spend: data.annualSpend,  percent: data.annualPercent,  status: data.annualStatus,  periodKey: data.currentYearKey };
  const bothUnset = data.monthlyStatus === "unset" && data.annualStatus === "unset";
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Bell className="w-5 h-5" />Budget &amp; Alerts</CardTitle></CardHeader>
      <CardContent>
        {bothUnset ? (
          <div className="text-sm text-gray-600">
            <p className="mb-2">No budget caps set for this customer yet.</p>
            <Button type="button" variant="outline" size="sm"
              onClick={() => setLocation(`/customers?edit=${customerId}#budget-and-alerts`)}>
              Set a budget
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <BudgetBucketRow label="This month" bucket={monthlyBucket} />
            <BudgetBucketRow label="This year"  bucket={annualBucket} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface BudgetAlertEvent {
  id: number;
  customerId: number;
  period: "monthly" | "annual";
  threshold: "soft" | "hard";
  periodKey: string;
  firedAt: string;
  triggeringInvoiceId: number | null;
  triggeringInvoiceNumber: string | null;
}

function RecentBudgetAlertsCard({ customerId }: { customerId: number }) {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useQuery<{ customerId: number; events: BudgetAlertEvent[] }>({
    queryKey: [`/api/customers/${customerId}/budget-alert-events`],
  });
  if (isLoading) {
    return (
      <Card className="shadow-md">
        <CardHeader><CardTitle className="flex items-center gap-2"><Bell className="w-5 h-5" />Recent Budget Alerts</CardTitle></CardHeader>
        <CardContent><div className="h-12 bg-gray-100 rounded animate-pulse" /></CardContent>
      </Card>
    );
  }
  const events = Array.isArray(data?.events) ? data!.events : [];
  return (
    <Card className="shadow-md">
      <CardHeader><CardTitle className="flex items-center gap-2"><Bell className="w-5 h-5" />Recent Budget Alerts</CardTitle></CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-gray-500">No budget alerts have fired for this customer yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {events.map((ev) => {
              const periodLabel = ev.period === "monthly" ? "Monthly" : "Annual";
              const thresholdLabel = ev.threshold === "hard" ? "Exceeded" : "Warning";
              const thresholdClass = ev.threshold === "hard" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800";
              const firedAt = new Date(ev.firedAt);
              const firedLabel = isNaN(firedAt.getTime())
                ? ev.firedAt
                : firedAt.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
              return (
                <li key={ev.id} className="py-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-xs px-2 py-0.5 rounded ${thresholdClass}`}>{thresholdLabel}</span>
                    <span className="text-sm font-medium text-gray-800 truncate">{periodLabel} · {ev.periodKey}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500 shrink-0">
                    {ev.triggeringInvoiceId && ev.triggeringInvoiceNumber && (
                      <button type="button" className="underline hover:text-gray-700"
                        onClick={() => setLocation(`/invoices/${ev.triggeringInvoiceId}`)}>
                        {ev.triggeringInvoiceNumber}
                      </button>
                    )}
                    <span>{firedLabel}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
