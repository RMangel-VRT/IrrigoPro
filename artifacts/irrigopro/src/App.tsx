import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import { useEffect, lazy, Suspense, type ComponentType } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Navigation from "@/components/layout/navigation";
import { clearStaleCache } from "@/utils/clearStaleCache";

// Eager: login + first paint screens (so first paint is not behind a chunk fetch).
import Login from "@/pages/login";
import NotFound from "@/pages/not-found";
import FieldTechDashboard from "@/pages/field-tech-dashboard";
import AdminDashboard from "@/pages/admin-dashboard";
import ManagerWorkspace from "@/pages/manager-workspace";
// Eager: public token-gated page — must cold-load from a direct URL with no session.
import EstimateApproval from "@/pages/estimate-approval";

// Task #532 — every other page is route-split via React.lazy. Vite emits
// per-route chunks; shared deps (React, React Query, Wouter, Tailwind
// runtime, lucide) stay in the common chunk.
const lazyPage = <T extends ComponentType<any>>(loader: () => Promise<{ default: T }>) =>
  lazy(loader);

const Dashboard = lazyPage(() => import("@/pages/dashboard"));
const Estimates = lazyPage(() => import("@/pages/estimates"));
const PartsCatalog = lazyPage(() => import("@/pages/parts-catalog"));
const Customers = lazyPage(() => import("@/pages/customers"));
// FieldTech page removed by Task #1857 (Slice 5 — retire prototype stores).
const WorkOrders = lazyPage(() => import("@/pages/work-orders"));
const ForgotPassword = lazyPage(() => import("@/pages/forgot-password"));
const ResetPassword = lazyPage(() => import("@/pages/reset-password"));
// FieldPortal page removed by Task #1857 (Slice 5 — retire prototype stores).
const BillingSheets = lazyPage(() => import("@/pages/billing-sheets"));
const MissingPhotosReport = lazyPage(() => import("@/pages/missing-photos-report"));
const WorkOrdersMissingPhotosReport = lazyPage(() => import("@/pages/work-orders-missing-photos-report"));
const BillingZeroPriceAuditPage = lazyPage(() => import("@/pages/billing-zero-price-audit"));
const AdminIssueTypesPage = lazyPage(() => import("@/pages/admin-issue-types"));
const AdminClientErrorsPage = lazyPage(() => import("@/pages/admin-client-errors"));
const FinancialPulsePage = lazyPage(() => import("@/pages/financial-pulse"));
const SuperAdminAppHealthPage = lazyPage(() => import("@/pages/super-admin-app-health"));
const SuperAdminLoosePhotosPage = lazyPage(() => import("@/pages/super-admin-loose-photos"));
const LaborRateAuditPage = lazyPage(() => import("@/pages/labor-rate-audit"));
const MissingLocationDataReportPage = lazyPage(() => import("@/pages/missing-location-data-report"));
const MissingLocationTicketDetail = lazyPage(() => import("@/pages/missing-location-ticket-detail"));
const CustomerBilling = lazyPage(() => import("@/pages/customer-billing"));
const QuickBooksPage = lazyPage(() => import("@/pages/quickbooks"));
const AdminControllers = lazyPage(() => import("@/pages/admin-controllers"));
const Operations = lazyPage(() => import("@/pages/operations"));
const SystemUserManagement = lazyPage(() => import("@/pages/system-user-management"));
const CompanyUserManagement = lazyPage(() => import("@/pages/company-user-management"));
const CompanyProfile = lazyPage(() => import("@/pages/company-profile"));
const UserProfile = lazyPage(() => import("@/pages/user-profile"));
const LicenseAgreement = lazyPage(() => import("@/pages/license-agreement"));
const PrivacyPolicy = lazyPage(() => import("@/pages/privacy-policy"));
const SwitchUser = lazyPage(() => import("@/pages/switch-user"));
const CustomerProfile = lazyPage(() => import("@/pages/customer-profile"));
const PartsSettings = lazyPage(() => import("@/pages/parts-settings"));
const PartsPendingApproval = lazyPage(() => import("@/pages/parts-pending-approval"));
const EstimatesPendingApproval = lazyPage(() => import("@/pages/estimates-pending-approval"));
const EstimateCommandCenter = lazyPage(() => import("@/pages/estimate-command-center"));
const RedirectPendingApprovalToCC = lazy(() => import("@/components/estimates/redirect-to-command-center"));
const InvoicesPage = lazyPage(() => import("@/pages/invoices"));
const WetChecksListPage = lazyPage(() => import("@/pages/wet-checks"));
const WetCheckSystemPage = lazyPage(() => import("@/pages/wet-checks/WetCheckSystemPage"));
const WetChecksRoutingPage = lazyPage(() => import("@/pages/wet-checks/WetChecksPage"));
const WetCustomerPickerPage = lazyPage(() => import("@/pages/wet-checks/CustomerPickerPage"));
const NewWetCheckPage = lazyPage(() => import("@/pages/wet-checks/NewWetCheckPage"));
const WetCheckModeSelectorPage = lazyPage(() => import("@/pages/wet-checks/WetCheckModeSelectorPage"));
const WetCheckBillingsPage = lazyPage(() => import("@/pages/wet-check-billings"));
const WetCheckConfirm = lazy(() => import("@/components/manager/wet-check-confirm").then((m) => ({ default: m.WetCheckConfirm })));
const WetCheckDone = lazy(() => import("@/components/manager/wet-check-done").then((m) => ({ default: m.WetCheckDone })));
const WetCheckInspectionSummaryPage = lazyPage(() => import("@/pages/wet-checks/WetCheckInspectionSummaryPage"));
const ManagerWetCheckDetailPage = lazyPage(() => import("@/pages/wet-checks/ManagerWetCheckDetailPage"));
const CombinedReviewPage = lazyPage(() => import("@/pages/wet-checks/CombinedReviewPage"));

const SiteMapsPage = lazyPage(() => import("@/pages/site-maps"));
const AdminMigrationsPage = lazyPage(() => import("@/pages/admin/migrations"));
const AdminWcLaborBackfillPage = lazyPage(() => import("@/pages/admin-wc-labor-backfill"));
const WetCheckReconciliationPage = lazyPage(() => import("@/pages/wet-check-reconciliation"));
const CustomerSiteMapsPage = lazyPage(() => import("@/pages/customer-site-maps-page"));
const IrrigationProfilePage = lazyPage(() => import("@/pages/customers/IrrigationProfile"));
const FieldTechMaps = lazyPage(() => import("@/pages/field-tech-maps"));
import { NotificationPermissionBanner } from "@/components/notifications/notification-permission-banner";
import CompanyAdminApp from "@/components/company-admin-app";
import PoweredByFooter from "@/components/layout/powered-by-footer";
import { DesktopShell } from "@/components/layout/desktop-shell";
import { billingManagerNav, bookkeeperNav, managerNav, superAdminNav } from "@/components/layout/nav-config";
import { ServiceWorkerRegistration, ServiceWorkerUpdatePrompt } from "@/components/offline/service-worker-update-prompt";
import { ConflictToastBridge } from "@/components/offline/conflict-toast-bridge";
import { SessionExpiredBanner } from "@/components/auth/session-expired-banner";


function RedirectToCommandCenter() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/billing/command-center"); }, [navigate]);
  return null;
}

// Legacy billing-dashboard / billing-workspace URLs redirect to the merged
// /manager-workspace. We use a `replace` navigation (no history entry) so
// back-button still works, mirroring a 301.
function RedirectToBillingWorkspace() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/manager-workspace", { replace: true }); }, [navigate]);
  return null;
}

function RedirectToWetChecks() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/wet-checks", { replace: true }); }, [navigate]);
  return null;
}

function RedirectToWetChecksNeedsReview() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/wet-checks?tab=needs-review", { replace: true }); }, [navigate]);
  return null;
}

function RedirectToWetChecksApproved() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/wet-checks?tab=approved", { replace: true }); }, [navigate]);
  return null;
}

function RedirectToAppHealth() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/super-admin/app-health", { replace: true }); }, [navigate]);
  return null;
}

function RedirectToManagerWorkspace() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/manager-workspace", { replace: true }); }, [navigate]);
  return null;
}

// Lightweight Suspense fallback that mirrors the existing loading style
// in the auth bootstrap below. Used as the default for every route-split
// page boundary so there's no jarring "blank page" while the chunk loads.
function RouteSuspenseFallback() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-3 text-gray-600 text-sm">Loading…</p>
      </div>
    </div>
  );
}

function Router() {
  // User state comes from the AuthProvider (wraps the app in main.tsx).
  // The provider reads localStorage synchronously so the very first render
  // already knows the correct role — no stale-null window.
  const { user, isLoading } = useAuth();
  const [currentPath] = useLocation();

  useEffect(() => {
    // Run cache cleanup on mount.
    try {
      clearStaleCache();
    } catch (cacheErr) {
      console.warn("[boot] clearStaleCache failed:", cacheErr);
    }
  }, []);

  // Public token-gated page — renders regardless of auth state and before the
  // login gate. No app shell, no sidebar, no authenticated API calls. Hoisted
  // above the loading check so a direct URL works even during auth bootstrap.
  if (currentPath.startsWith("/estimate-approval/")) {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <EstimateApproval />
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // If no user is logged in, show the original login design
  if (!user) {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={<RouteSuspenseFallback />}>
            <Switch>
              <Route path="/login" component={Login} />

              <Route path="/forgot-password" component={ForgotPassword} />
              <Route path="/reset-password" component={ResetPassword} />
              <Route path="/estimate-approval/:token" component={EstimateApproval} />
              <Route path="/license-agreement" component={LicenseAgreement} />
              <Route path="/" component={Login} />
              <Route component={Login} />
            </Switch>
          </Suspense>
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  // Task #550 — App Health is reachable from any authenticated role at the
  // same URL. The page's own super-admin guard renders the canonical
  // "Super admin access required" UI when the role is wrong, instead of
  // letting non-super-admin roles fall through to NotFound from their
  // role-scoped Switch. Super admins are excluded from this short-circuit
  // so the route renders inside their DesktopShell (Task #592).
  if (currentPath === "/super-admin/app-health" && user.role !== "super_admin") {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <div className="min-h-screen bg-gray-50 pb-20 lg:pb-0 flex flex-col">
            <Navigation />
            <div className="px-4 flex-1">
              <Suspense fallback={<RouteSuspenseFallback />}>
                <SuperAdminAppHealthPage />
              </Suspense>
            </div>
            <PoweredByFooter />
          </div>
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  // Field tech gets simplified dashboard
  if (user.role === "field_tech") {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <div className="min-h-screen bg-gray-50 pb-20 lg:pb-0 flex flex-col">
            <Navigation />
            <div className="px-4 flex-1">
              <SessionExpiredBanner />
              <Suspense fallback={<RouteSuspenseFallback />}>
                <Switch>
                  <Route path="/" component={FieldTechDashboard} />
                  <Route path="/field-tech" component={FieldTechDashboard} />
                  <Route path="/work-orders" component={WorkOrders} />
                  <Route path="/billing-sheets" component={BillingSheets} />
                  <Route path="/wet-check-billings" component={WetCheckBillingsPage} />
                  <Route path="/wet-checks/new" component={WetCheckModeSelectorPage} />
                  <Route path="/wet-checks" component={WetCustomerPickerPage} />
                  <Route path="/wet-checks/c/:customerId/new" component={NewWetCheckPage} />
                  <Route path="/wet-checks/c/:clientId" component={WetChecksRoutingPage} />
                  {/* Both /review and /summary intentionally load the same component for field techs — diverges from manager blocks where /review uses ManagerWetCheckDetailPage */}
                  <Route path="/wet-checks/:id/review" component={WetCheckInspectionSummaryPage} />
                  <Route path="/wet-checks/:id/summary" component={WetCheckInspectionSummaryPage} />
                  <Route path="/wet-checks/:id" component={WetChecksRoutingPage} />
                  <Route path="/customers" component={Customers} />
                  <Route path="/customers/:id/profile" component={CustomerProfile} />
                  <Route path="/customers/:customerId/site-maps" component={CustomerSiteMapsPage} />
                  <Route path="/customers/:customerId/irrigation-profile" component={IrrigationProfilePage} />
                  <Route path="/site-maps" component={FieldTechMaps} />
                  <Route path="/financial-pulse" component={FinancialPulsePage} />
                  <Route path="/switch-user" component={SwitchUser} />
                  <Route path="/user-profile" component={UserProfile} />
                  <Route path="/license-agreement" component={LicenseAgreement} />
                  <Route path="/privacy-policy" component={PrivacyPolicy} />
                  <Route path="/login" component={Login} />
                  <Route component={NotFound} />
                </Switch>
              </Suspense>
            </div>
            <PoweredByFooter />
          </div>
          <ServiceWorkerUpdatePrompt />
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  // Irrigation manager gets access to specific pages
  if (user.role === "irrigation_manager") {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <DesktopShell navConfig={managerNav}>
            <div className="px-4">
              <Suspense fallback={<RouteSuspenseFallback />}>
                <Switch>
                  <Route path="/" component={ManagerWorkspace} />
                  <Route path="/manager-workspace" component={ManagerWorkspace} />
                  <Route path="/manager-dashboard" component={RedirectToManagerWorkspace} />
                  <Route path="/manager" component={RedirectToManagerWorkspace} />
                  <Route path="/estimates" component={Estimates} />
                  <Route path="/parts" component={PartsCatalog} />
                  <Route path="/parts-settings" component={PartsSettings} />
                  <Route path="/work-orders" component={WorkOrders} />
                  <Route path="/customers" component={Customers} />
                  <Route path="/customers/:id/profile" component={CustomerProfile} />
                  <Route path="/customers/:customerId/site-maps" component={CustomerSiteMapsPage} />
                  <Route path="/customers/:customerId/irrigation-profile" component={IrrigationProfilePage} />
                  <Route path="/site-maps" component={SiteMapsPage} />
                  <Route path="/work-orders/missing-photos" component={WorkOrdersMissingPhotosReport} />
                  <Route path="/billing-sheets/missing-photos" component={MissingPhotosReport} />
                  <Route path="/billing-sheets/zero-price-audit" component={BillingZeroPriceAuditPage} />
                  <Route path="/billing-sheets/labor-rate-audit" component={LaborRateAuditPage} />
                  <Route path="/reports/missing-location-data" component={MissingLocationDataReportPage} />
                  <Route path="/billing-sheets" component={BillingSheets} />
                  <Route path="/wet-check-billings" component={RedirectToWetChecksApproved} />
                  <Route path="/admin/issue-types" component={AdminIssueTypesPage} />
                  <Route path="/manager/wet-checks" component={RedirectToWetChecks} />
                  <Route path="/manager/wet-checks/:id/confirm">
                    {(params) => <WetCheckConfirm id={parseInt(params.id)} />}
                  </Route>
                  <Route path="/manager/wet-checks/:id/done">
                    {(params) => <WetCheckDone id={parseInt(params.id)} />}
                  </Route>
                  <Route path="/manager/wet-checks/:id" component={CombinedReviewPage} />
                  <Route path="/wet-checks/admin" component={RedirectToWetChecks} />
                  <Route path="/financial-pulse" component={FinancialPulsePage} />
                  <Route path="/billing-workspace" component={RedirectToBillingWorkspace} />
                  <Route path="/billing" component={RedirectToBillingWorkspace} />
                  <Route path="/billing/dashboard" component={RedirectToBillingWorkspace} />
                  <Route path="/billing-dashboard" component={RedirectToBillingWorkspace} />
                  <Route path="/wet-checks/pending-review" component={RedirectToWetChecksNeedsReview} />
                  <Route path="/wet-checks/new" component={WetCheckModeSelectorPage} />
                  <Route path="/wet-checks" component={WetCheckSystemPage} />
                  <Route path="/wet-checks/c/:customerId/new" component={NewWetCheckPage} />
                  <Route path="/wet-checks/c/:clientId" component={WetChecksRoutingPage} />
                  <Route path="/wet-checks/:id/review" component={CombinedReviewPage} />
                  <Route path="/wet-checks/:id/summary" component={WetCheckInspectionSummaryPage} />
                  <Route path="/wet-checks/:id" component={WetChecksRoutingPage} />
                  <Route path="/switch-user" component={SwitchUser} />
                  <Route path="/user-profile" component={UserProfile} />
                  <Route path="/license-agreement" component={LicenseAgreement} />
                  <Route path="/privacy-policy" component={PrivacyPolicy} />
                  <Route path="/login" component={Login} />
                  <Route component={NotFound} />
                </Switch>
              </Suspense>
            </div>
          </DesktopShell>
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  // Task #1886 — Bookkeeper: invoice visibility and QuickBooks custody, nothing
  // else. Shares the DesktopShell component with the billing manager but gets
  // its own nav config and its own (much shorter) route list. Work Orders and
  // Billing Sheets are deep-link targets for the read-only location report;
  // they remain absent from navigation and their mutation controls stay
  // role-gated. Landing route is the invoice list.
  if (user.role === "bookkeeper") {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <DesktopShell navConfig={bookkeeperNav}>
            <div className="px-4">
              <Suspense fallback={<RouteSuspenseFallback />}>
                <Switch>
                  <Route path="/" component={InvoicesPage} />
                  <Route path="/invoices" component={InvoicesPage} />
                  <Route path="/reports/missing-location-data" component={MissingLocationDataReportPage} />
                  <Route path="/work-orders">
                    {() => <MissingLocationTicketDetail ticketType="work_order" />}
                  </Route>
                  <Route path="/billing-sheets">
                    {() => <MissingLocationTicketDetail ticketType="billing_sheet" />}
                  </Route>
                  <Route path="/customers" component={Customers} />
                  <Route path="/customers/:id/profile" component={CustomerProfile} />
                  <Route path="/quickbooks" component={QuickBooksPage} />
                  <Route path="/user-profile" component={UserProfile} />
                  <Route path="/license-agreement" component={LicenseAgreement} />
                  <Route path="/privacy-policy" component={PrivacyPolicy} />
                  <Route path="/login" component={Login} />
                  <Route component={NotFound} />
                </Switch>
              </Suspense>
            </div>
          </DesktopShell>
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  // Billing manager gets customer billing interface
  if (user.role === "billing_manager") {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <DesktopShell navConfig={billingManagerNav}>
            <div className="px-4">
              <Suspense fallback={<RouteSuspenseFallback />}>
                <Switch>
                  <Route path="/" component={ManagerWorkspace} />
                  <Route path="/manager-workspace" component={ManagerWorkspace} />
                  <Route path="/billing-workspace" component={RedirectToBillingWorkspace} />
                  <Route path="/billing" component={RedirectToBillingWorkspace} />
                  <Route path="/billing/dashboard" component={RedirectToBillingWorkspace} />
                  <Route path="/billing-dashboard" component={RedirectToBillingWorkspace} />
                  <Route path="/billing/command-center" component={CustomerBilling} />
                  <Route path="/financial-pulse" component={FinancialPulsePage} />
                  <Route path="/customer-billing" component={RedirectToCommandCenter} />
                  <Route path="/customers" component={Customers} />
                  <Route path="/customers/:id/profile" component={CustomerProfile} />
                  <Route path="/customers/:customerId/irrigation-profile" component={IrrigationProfilePage} />
                  <Route path="/work-orders/missing-photos" component={WorkOrdersMissingPhotosReport} />
                  <Route path="/work-orders" component={WorkOrders} />
                  <Route path="/billing-sheets/missing-photos" component={MissingPhotosReport} />
                  <Route path="/billing-sheets/zero-price-audit" component={BillingZeroPriceAuditPage} />
                  <Route path="/billing-sheets/labor-rate-audit" component={LaborRateAuditPage} />
                  <Route path="/reports/missing-location-data" component={MissingLocationDataReportPage} />
                  <Route path="/billing-sheets" component={BillingSheets} />
                  <Route path="/wet-check-billings" component={RedirectToWetChecksApproved} />
                  <Route path="/manager/wet-checks" component={RedirectToWetChecks} />
                  <Route path="/manager/wet-checks/:id" component={CombinedReviewPage} />
                  <Route path="/wet-checks/admin" component={RedirectToWetChecks} />
                  <Route path="/wet-checks/pending-review" component={RedirectToWetChecksNeedsReview} />
                  <Route path="/wet-checks/new" component={WetCheckModeSelectorPage} />
                  <Route path="/wet-checks/:id/review" component={CombinedReviewPage} />
                  <Route path="/wet-checks" component={WetCheckSystemPage} />
                  <Route path="/wet-checks/c/:customerId/new" component={NewWetCheckPage} />
                  <Route path="/wet-checks/c/:clientId" component={WetChecksRoutingPage} />
                  <Route path="/wet-checks/:id/summary" component={WetCheckInspectionSummaryPage} />
                  <Route path="/wet-checks/:id" component={WetChecksRoutingPage} />
                  <Route path="/parts" component={PartsCatalog} />
                  <Route path="/parts-settings" component={PartsSettings} />
                  <Route path="/parts-pending-approval" component={PartsPendingApproval} />
                  <Route path="/estimates/pending-approval" component={EstimatesPendingApproval} />
                  <Route path="/quickbooks" component={QuickBooksPage} />
                  <Route path="/invoices" component={InvoicesPage} />
                  <Route path="/reports/missing-location-data" component={MissingLocationDataReportPage} />
                  <Route path="/admin/issue-types" component={AdminIssueTypesPage} />
                  <Route path="/switch-user" component={SwitchUser} />
                  <Route path="/user-profile" component={UserProfile} />
                  <Route path="/license-agreement" component={LicenseAgreement} />
                  <Route path="/privacy-policy" component={PrivacyPolicy} />
                  <Route path="/login" component={Login} />
                  <Route component={NotFound} />
                </Switch>
              </Suspense>
            </div>
          </DesktopShell>
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  // Super Admin gets system-wide access (Task #592 — wrapped in DesktopShell)
  if (user.role === "super_admin") {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <DesktopShell navConfig={superAdminNav}>
            <div className="px-4">
              <Suspense fallback={<RouteSuspenseFallback />}>
                <Switch>
                  <Route path="/" component={RedirectToAppHealth} />
                  <Route path="/super-admin" component={SuperAdminAppHealthPage} />
                  <Route path="/manager-workspace" component={ManagerWorkspace} />
                  <Route path="/billing-workspace" component={RedirectToBillingWorkspace} />
                  <Route path="/manager/wet-checks" component={RedirectToWetChecks} />
                  <Route path="/manager/wet-checks/:id/confirm">
                    {(params) => <WetCheckConfirm id={parseInt(params.id)} />}
                  </Route>
                  <Route path="/manager/wet-checks/:id/done">
                    {(params) => <WetCheckDone id={parseInt(params.id)} />}
                  </Route>
                  <Route path="/manager/wet-checks/:id" component={CombinedReviewPage} />
                  <Route path="/wet-checks/admin" component={RedirectToWetChecks} />
                  <Route path="/wet-checks/pending-review" component={RedirectToWetChecksNeedsReview} />
                  <Route path="/wet-checks/new" component={WetCheckModeSelectorPage} />
                  <Route path="/wet-checks/:id/review" component={CombinedReviewPage} />
                  <Route path="/wet-checks" component={WetCheckSystemPage} />
                  <Route path="/wet-checks/c/:customerId/new" component={NewWetCheckPage} />
                  <Route path="/wet-checks/c/:clientId" component={WetChecksRoutingPage} />
                  <Route path="/wet-checks/:id/summary" component={WetCheckInspectionSummaryPage} />
                  <Route path="/wet-checks/:id" component={WetChecksRoutingPage} />
                  <Route path="/wet-check-billings" component={RedirectToWetChecksApproved} />
                  <Route path="/work-orders" component={WorkOrders} />
                  <Route path="/billing-sheets" component={BillingSheets} />
                  <Route path="/customers" component={Customers} />
                  <Route path="/customers/:id/profile" component={CustomerProfile} />
                  <Route path="/customers/:customerId/site-maps" component={CustomerSiteMapsPage} />
                  <Route path="/customers/:customerId/irrigation-profile" component={IrrigationProfilePage} />
                  <Route path="/system-users" component={SystemUserManagement} />
                  <Route path="/admin/controllers" component={AdminControllers} />
                  <Route path="/admin/client-errors" component={AdminClientErrorsPage} />
                  <Route path="/super-admin/app-health" component={SuperAdminAppHealthPage} />
                  <Route path="/super-admin/loose-photos" component={SuperAdminLoosePhotosPage} />
                  <Route path="/admin/migrations" component={AdminMigrationsPage} />
                  <Route path="/admin/wc-labor-backfill" component={AdminWcLaborBackfillPage} />
                  <Route path="/admin/wet-check-reconciliation" component={WetCheckReconciliationPage} />
                  <Route path="/reports/missing-location-data" component={MissingLocationDataReportPage} />
                  <Route path="/quickbooks" component={QuickBooksPage} />
                  <Route path="/admin/issue-types" component={AdminIssueTypesPage} />
                  <Route path="/financial-pulse" component={FinancialPulsePage} />
                  <Route path="/user-manager" component={SystemUserManagement} />
                  <Route path="/switch-user" component={SwitchUser} />
                  <Route path="/user-profile" component={UserProfile} />
                  <Route path="/license-agreement" component={LicenseAgreement} />
                  <Route path="/privacy-policy" component={PrivacyPolicy} />
                  <Route path="/login" component={Login} />
                  <Route component={NotFound} />
                </Switch>
              </Suspense>
            </div>
          </DesktopShell>
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  // Company Admin gets access to company-specific dashboard and management
  if (user.role === "company_admin") {
    return (
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <CompanyAdminApp user={user} />
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    );
  }

  // Default fallback - treat as regular admin
  return (
    <TooltipProvider>
      <QueryClientProvider client={queryClient}>
        <div className="min-h-screen pb-20 lg:pb-0 flex flex-col">
          <Navigation />
          <div className="px-4 bg-gray-50 flex-1">
            <Suspense fallback={<RouteSuspenseFallback />}>
              <Switch>
                <Route path="/" component={AdminDashboard} />
                <Route path="/admin" component={AdminDashboard} />
                <Route path="/operations" component={Operations} />
                <Route path="/parts" component={PartsCatalog} />
                <Route path="/customers" component={Customers} />
                <Route path="/site-maps" component={SiteMapsPage} />
                <Route path="/customer-billing" component={CustomerBilling} />
                {/* /field-tech route removed by Task #1857 */}
                <Route path="/billing-sheets/zero-price-audit" component={BillingZeroPriceAuditPage} />
                <Route path="/billing-sheets/labor-rate-audit" component={LaborRateAuditPage} />
                <Route path="/billing-sheets" component={BillingSheets} />
                <Route path="/wet-checks/pending-review" component={RedirectToWetChecksNeedsReview} />
                <Route path="/wet-checks/:id/review" component={CombinedReviewPage} />
                <Route path="/wet-checks" component={WetCustomerPickerPage} />
                <Route path="/wet-checks/c/:clientId" component={WetChecksRoutingPage} />
                <Route path="/wet-checks/:id/summary" component={WetCheckInspectionSummaryPage} />
                <Route path="/wet-checks/:id" component={WetChecksRoutingPage} />
                <Route path="/user-manager" component={SystemUserManagement} />
                <Route path="/user-profile" component={UserProfile} />
                <Route path="/license-agreement" component={LicenseAgreement} />
                <Route path="/privacy-policy" component={PrivacyPolicy} />
                <Route path="/login" component={Login} />
                {/* /field-portal route removed by Task #1857 */}
                {/* Redirect estimates and work-orders to operations page */}
                <Route path="/estimates/command-center" component={EstimateCommandCenter} />
                <Route path="/estimates/pending-approval" component={RedirectPendingApprovalToCC} />
                <Route path="/estimates" component={Operations} />
                <Route path="/work-orders" component={Operations} />
                <Route component={NotFound} />
              </Switch>
            </Suspense>
          </div>
          <PoweredByFooter />
        </div>
        <NotificationPermissionBanner />
        <Toaster />
      </QueryClientProvider>
    </TooltipProvider>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <ServiceWorkerRegistration />
      <ConflictToastBridge />
      <Router />
    </WouterRouter>
  );
}

export default App;
