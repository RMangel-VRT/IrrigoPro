import { useState, useEffect, lazy, Suspense } from "react";
import { safeSet } from "@/utils/safeStorage";
import { Switch, Route, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { DesktopShell } from "@/components/layout/desktop-shell";
import { companyAdminNav } from "@/components/layout/nav-config";
import InvoicesPage from "@/pages/invoices";
import AdminDashboard from "@/pages/admin-dashboard";
import Operations from "@/pages/operations";
import CompanyUserManagement from "@/pages/company-user-management";
import CompanyProfile from "@/pages/company-profile";
import QuickBooksPage from "@/pages/quickbooks";
import PartsCatalog from "@/pages/parts-catalog";
import Customers from "@/pages/customers";
import SiteMapsPage from "@/pages/site-maps";
import CustomerSiteMapsPage from "@/pages/customer-site-maps-page";
import CustomerProfile from "@/pages/customer-profile";
import CustomerBilling from "@/pages/customer-billing";
const IrrigationProfilePage = lazy(() => import("@/pages/customers/IrrigationProfile"));
import ManagerWorkspace from "@/pages/manager-workspace";

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
import FinancialPulsePage from "@/pages/financial-pulse";
// FieldTech import removed by Task #1857 (Slice 5).
import BillingSheets from "@/pages/billing-sheets";
import WorkOrders from "@/pages/work-orders";
import WetCheckSystemPage from "@/pages/wet-checks/WetCheckSystemPage";
import WetChecksRoutingPage from "@/pages/wet-checks/WetChecksPage";
import NewWetCheckPage from "@/pages/wet-checks/NewWetCheckPage";
const WetCheckConfirm = lazy(() => import("@/components/manager/wet-check-confirm").then((m) => ({ default: m.WetCheckConfirm })));
const WetCheckDone = lazy(() => import("@/components/manager/wet-check-done").then((m) => ({ default: m.WetCheckDone })));
import AdminIssueTypesPage from "@/pages/admin-issue-types";
import AdminClientErrorsPage from "@/pages/admin-client-errors";
import WetCheckInspectionSummaryPage from "@/pages/wet-checks/WetCheckInspectionSummaryPage";
import ManagerWetCheckDetailPage from "@/pages/wet-checks/ManagerWetCheckDetailPage";
import CombinedReviewPage from "@/pages/wet-checks/CombinedReviewPage";
import BillingZeroPriceAuditPage from "@/pages/billing-zero-price-audit";
import LaborRateAuditPage from "@/pages/labor-rate-audit";
import MissingPhotosReport from "@/pages/missing-photos-report";
import WorkOrdersMissingPhotosReport from "@/pages/work-orders-missing-photos-report";
import PartsSettings from "@/pages/parts-settings";
import LaborRates from "@/pages/labor-rates";
import AdminCustomers from "@/pages/admin-customers";
import AdminControllers from "@/pages/admin-controllers";
import WetCheckReconciliationPage from "@/pages/wet-check-reconciliation";
import PartsPendingApproval from "@/pages/parts-pending-approval";
import EstimateCommandCenter from "@/pages/estimate-command-center";
import RedirectPendingApprovalToCC from "@/components/estimates/redirect-to-command-center";

import UserProfile from "@/pages/user-profile";
import LicenseAgreement from "@/pages/license-agreement";
import PrivacyPolicy from "@/pages/privacy-policy";
import SwitchUser from "@/pages/switch-user";
import Login from "@/pages/login";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
// FieldPortal import removed by Task #1857 (Slice 5).
import NotFound from "@/pages/not-found";
import OnboardingFlow from "@/components/onboarding/onboarding-flow";
import type { Role } from "@workspace/shared";

function RedirectToCommandCenter() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/billing/command-center"); }, [navigate]);
  return null;
}

interface User {
  id: number;
  username: string;
  name: string;
  email: string;
  role: Role;
  companyId?: number | null;
  isActive: boolean;
}

interface CompanyAdminAppProps {
  user: User;
}

export default function CompanyAdminApp({ user }: CompanyAdminAppProps) {
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [isCheckingSetup, setIsCheckingSetup] = useState(true);

  // Check if onboarding has been completed
  useEffect(() => {
    const onboardingCompleted = localStorage.getItem("onboarding_completed");
    if (!onboardingCompleted && user.companyId) {
      // Check if company profile exists
      fetch(`/api/company/${user.companyId}/setup-status`, {
        headers: {
          'x-user-role': user.role,
          'x-user-company-id': user.companyId.toString(),
        }
      })
        .then(res => res.json())
        .then(data => {
          if (data.requiresSetup) {
            setNeedsOnboarding(true);
          }
          setIsCheckingSetup(false);
        })
        .catch(() => {
          setNeedsOnboarding(true);
          setIsCheckingSetup(false);
        });
    } else {
      setIsCheckingSetup(false);
    }
  }, [user.companyId, user.role]);

  const handleOnboardingComplete = () => {
    setNeedsOnboarding(false);
    safeSet("onboarding_completed", "true");
  };

  // Show loading while checking setup
  if (isCheckingSetup) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Show onboarding flow if needed
  if (needsOnboarding && user.companyId) {
    return (
      <OnboardingFlow
        companyId={user.companyId}
        currentUser={user}
        onComplete={handleOnboardingComplete}
      />
    );
  }

  // Regular company admin app
  return (
    <DesktopShell navConfig={companyAdminNav}>
      <div className="px-4 bg-gray-50">
        <Switch>
          <Route path="/" component={AdminDashboard} />
          <Route path="/admin" component={AdminDashboard} />
          <Route path="/operations" component={Operations} />
          <Route path="/users" component={CompanyUserManagement} />
          <Route path="/company-profile" component={CompanyProfile} />
          <Route path="/quickbooks" component={QuickBooksPage} />
          <Route path="/invoices" component={InvoicesPage} />
          <Route path="/parts-pending-approval" component={PartsPendingApproval} />
          <Route path="/estimates/command-center" component={EstimateCommandCenter} />
          <Route path="/estimates/pending-approval" component={RedirectPendingApprovalToCC} />
          <Route path="/parts" component={PartsCatalog} />
          <Route path="/parts-settings" component={PartsSettings} />
          <Route path="/labor-rates" component={LaborRates} />
          <Route path="/admin/customers" component={AdminCustomers} />
          <Route path="/admin/controllers" component={AdminControllers} />
          <Route path="/customers" component={Customers} />
          <Route path="/customers/:id/profile" component={CustomerProfile} />
          <Route path="/customers/:customerId/site-maps" component={CustomerSiteMapsPage} />
          <Route path="/customers/:customerId/irrigation-profile" component={IrrigationProfilePage} />
          <Route path="/site-maps" component={SiteMapsPage} />
          <Route path="/manager-workspace" component={ManagerWorkspace} />
          <Route path="/billing-workspace" component={RedirectToBillingWorkspace} />
          <Route path="/billing" component={RedirectToBillingWorkspace} />
          <Route path="/billing/dashboard" component={RedirectToBillingWorkspace} />
          <Route path="/billing-dashboard" component={RedirectToBillingWorkspace} />
          <Route path="/financial-pulse" component={FinancialPulsePage} />
          <Route path="/billing/command-center" component={CustomerBilling} />
          <Route path="/customer-billing" component={RedirectToCommandCenter} />
          {/* /field-tech route removed by Task #1857 */}
          <Route path="/work-orders/missing-photos" component={WorkOrdersMissingPhotosReport} />
          <Route path="/billing-sheets/missing-photos" component={MissingPhotosReport} />
          <Route path="/billing-sheets/zero-price-audit" component={BillingZeroPriceAuditPage} />
          <Route path="/billing-sheets/labor-rate-audit" component={LaborRateAuditPage} />
          <Route path="/billing-sheets" component={BillingSheets} />
          <Route path="/wet-check-billings" component={RedirectToWetChecksApproved} />
          <Route path="/manager/wet-checks" component={RedirectToWetChecks} />
          <Route path="/manager/wet-checks/:id/confirm">
            {(params) => <Suspense fallback={null}><WetCheckConfirm id={parseInt(params.id)} /></Suspense>}
          </Route>
          <Route path="/manager/wet-checks/:id/done">
            {(params) => <Suspense fallback={null}><WetCheckDone id={parseInt(params.id)} returnTo="/wet-checks/pending-review" /></Suspense>}
          </Route>
          <Route path="/manager/wet-checks/:id" component={CombinedReviewPage} />
          <Route path="/wet-checks/admin" component={RedirectToWetChecks} />
          <Route path="/admin/issue-types" component={AdminIssueTypesPage} />
          <Route path="/admin/client-errors" component={AdminClientErrorsPage} />
          <Route path="/admin/wet-check-reconciliation" component={WetCheckReconciliationPage} />
          <Route path="/wet-checks/pending-review" component={RedirectToWetChecksNeedsReview} />
          <Route path="/wet-checks/:id/review" component={CombinedReviewPage} />
          <Route path="/wet-checks" component={WetCheckSystemPage} />
          <Route path="/wet-checks/c/:customerId/new" component={NewWetCheckPage} />
          <Route path="/wet-checks/c/:clientId" component={WetChecksRoutingPage} />
          <Route path="/wet-checks/:id/summary" component={WetCheckInspectionSummaryPage} />
          <Route path="/wet-checks/:id" component={WetChecksRoutingPage} />
          <Route path="/work-orders" component={WorkOrders} />
          <Route path="/user-profile" component={UserProfile} />
          <Route path="/switch-user" component={SwitchUser} />
          <Route path="/license-agreement" component={LicenseAgreement} />
          <Route path="/privacy-policy" component={PrivacyPolicy} />
          <Route path="/login" component={Login} />
          <Route path="/forgot-password" component={ForgotPassword} />
          <Route path="/reset-password" component={ResetPassword} />
          {/* /field-portal route removed by Task #1857 */}
          {/* Estimates still routes through the Operations page */}
          <Route path="/estimates" component={Operations} />
          <Route component={NotFound} />
        </Switch>
      </div>
    </DesktopShell>
  );
}