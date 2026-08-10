import { safeGet } from "@/utils/safeStorage";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, adaptiveRefetchInterval, clearSessionAndLogout } from "@/lib/queryClient";
import irrigoProLogo from "@assets/IrrigoPro_2026-03_1780427958317.png";
import { useMemo } from "react";
import { Home, FileText, Package, Users, Wrench, ClipboardList, Calculator, UserCheck, Settings, LogOut, User, ChevronDown, MapIcon, DollarSign, ShieldCheck, Receipt, Droplets, Cpu, Activity, type LucideIcon } from "lucide-react";
import { NotificationSystem } from "@/components/notifications/notification-system";
import type { Part, ManualPartReview, Estimate } from "@workspace/db/schema";

type NavDropdownItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
};

type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  isCenter?: boolean;
  isDropdown?: boolean;
  dropdownItems?: NavDropdownItem[];
};

export default function Navigation() {
  const [location] = useLocation();

  const isActive = (path: string) => {  
    if (path === "/" && location === "/") return true;
    if (path !== "/" && location.startsWith(path)) return true;
    return false;
  };

  // Get current user role from localStorage
  const user = JSON.parse(safeGet("user") || "{}");
  const userRole = user.role;
  const companyId = user.companyId;

  // Task #532 — connection-aware polling. The 60s cadence is fine on a
  // good wifi connection but is too aggressive on a tech's truck on
  // 1-bar LTE. `adaptiveRefetchInterval` keeps it at 60s on fast links,
  // doubles it on 3G, and backs off to 5min on 2G/saveData.
  const badgePollMs = adaptiveRefetchInterval(60_000);

  // Fetch pending parts approval count for billing manager badge.
  // Task #539 — these badge counts use `?.length || 0` already, but the
  // workspace queryFn default returns `null` on 401, so be explicit:
  // coerce to a real array before any `.length` / `.some` access so a
  // logged-out probe can never resurface as a render-time crash.
  const { data: pendingPartsRaw } = useQuery<Part[] | null>({
    queryKey: ["/api/parts/pending-approval"],
    enabled: userRole === 'billing_manager' || userRole === 'company_admin',
    refetchInterval: badgePollMs,
  });
  const { data: pendingReviewsRaw } = useQuery<ManualPartReview[] | null>({
    queryKey: ["/api/manual-part-reviews"],
    enabled: userRole === 'billing_manager' || userRole === 'company_admin',
    refetchInterval: badgePollMs,
  });
  const pendingParts: Part[] = Array.isArray(pendingPartsRaw) ? pendingPartsRaw : [];
  const pendingReviews: ManualPartReview[] = Array.isArray(pendingReviewsRaw) ? pendingReviewsRaw : [];
  const pendingApprovalCount = pendingParts.length + pendingReviews.length;

  // Slice 7: estimates awaiting manager review. Surfaced as a badge on the
  // Operations dropdown for company_admin and the Billing dropdown for
  // billing_manager so reviewers can see at a glance there is work to do.
  const { data: pendingEstimatesRaw } = useQuery<Estimate[] | null>({
    queryKey: ["/api/estimates/pending-approval"],
    enabled: userRole === 'billing_manager' || userRole === 'company_admin',
    refetchInterval: badgePollMs,
  });
  const pendingEstimates: Estimate[] = Array.isArray(pendingEstimatesRaw) ? pendingEstimatesRaw : [];
  const pendingEstimateCount = pendingEstimates.length;

  // Fetch company profile to get company logo
  const { data: company } = useQuery({
    queryKey: [`/api/company/${companyId}/profile`],
    queryFn: async () => {
      return await apiRequest(`/api/company/${companyId}/profile`, 'GET');
    },
    enabled: !!companyId,
    retry: false,
    staleTime: 0, // Always refetch for logo changes
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });

  // Compute the public logo API URL synchronously. /api/company-logo/:id is a
  // public route (no requireAuthentication), so <img src> works without any
  // custom headers. Routing through the API endpoint avoids exposing the raw
  // object-storage URL and keeps the fallback from ever pointing at a
  // potentially inaccessible direct storage path.
  //
  // Handles two stored formats:
  //   new:    company-logos/<uuid>          → /api/company-logo/<uuid>
  //   legacy: /api/company-logo/<uuid>      → pass through as-is
  const logoApiUrl = useMemo(() => {
    const logo = company?.logo;
    if (!logo || logo.trim() === '' || logo === 'null') return null;
    // New format: company-logos/<id>
    const m = logo.match(/company-logos\/([^?]+)/);
    if (m) return `/api/company-logo/${m[1]}`;
    // Legacy format: /api/company-logo/<id> stored directly in DB
    const legacy = logo.match(/\/api\/company-logo\/([^?/]+)/);
    if (legacy) return `/api/company-logo/${legacy[1]}`;
    return null;
  }, [company?.logo]);

  // Define navigation items based on user role
  const getNavItems = () => {
    switch (userRole) {
      case "super_admin":
        return [
          { path: "/super-admin", label: "Companies", icon: Settings },
          { path: "/", label: "Dashboard", icon: Home, isCenter: true },
          { path: "/system-users", label: "All Users", icon: Users },
          { path: "/admin/controllers", label: "Controllers & Zones", icon: Cpu },
          { path: "/super-admin/app-health", label: "App Health", icon: Activity },
        ];
      case "company_admin":
        return [
          {
            path: "/operations",
            label: "Operations",
            icon: FileText,
            isDropdown: true,
            dropdownItems: [
              { path: "/work-orders", label: "Work Orders", icon: Wrench },
              { path: "/billing-sheets", label: "Billing Sheets", icon: ClipboardList },
              { path: "/estimates/pending-approval", label: "Estimates Pending Approval", icon: ShieldCheck, badge: pendingEstimateCount > 0 ? pendingEstimateCount : undefined },
              { path: "/wet-checks/admin", label: "Wet Checks", icon: Droplets },
            ]
          },
          { 
            path: "/customers", 
            label: "Customers", 
            icon: Users, 
            isDropdown: true,
            dropdownItems: [
              { path: "/customers", label: "Customers", icon: Users },
              { path: "/site-maps", label: "Maps", icon: MapIcon },
            ]
          },
          { 
            path: "/parts", 
            label: "Parts", 
            icon: Package, 
            isDropdown: true,
            dropdownItems: [
              { path: "/parts", label: "Parts Catalog", icon: Package },
              { path: "/parts-settings", label: "Parts Settings", icon: Settings },
            ]
          },
          { path: "/", label: "Dashboard", icon: Home, isCenter: true },
          { 
            path: "/billing", 
            label: "Billing", 
            icon: DollarSign, 
            isDropdown: true,
            dropdownItems: [
              { path: "/billing/dashboard", label: "Dashboard", icon: Home },
              { path: "/billing/command-center", label: "Command Center", icon: ClipboardList },
            ]
          },
          { 
            path: "/admin", 
            label: "Admin", 
            icon: Settings, 
            isDropdown: true,
            dropdownItems: [
              { path: "/users", label: "Team", icon: Users },
              { path: "/company-profile", label: "Company", icon: Settings },
              { path: "/quickbooks", label: "QuickBooks", icon: Calculator },
              { path: "/labor-rates", label: "Labor Rates", icon: DollarSign },
              { path: "/admin/issue-types", label: "Wet Check Issue Types", icon: Droplets },
              { path: "/admin/customers", label: "All Customers", icon: Users },
              { path: "/admin/controllers", label: "Controllers & Zones", icon: Cpu },
            ]
          },
        ];
      case "irrigation_manager":
        return [
          { path: "/estimates", label: "Estimates", icon: FileText },
          { path: "/work-orders", label: "Work Orders", icon: Wrench },
          { path: "/billing-sheets", label: "Billing", icon: ClipboardList },
          {
            path: "/wet-checks/admin",
            label: "Wet Checks",
            icon: Droplets,
            isDropdown: true,
            dropdownItems: [
              { path: "/wet-checks/admin", label: "Wet Checks", icon: Droplets },
              { path: "/admin/issue-types", label: "Issue Types", icon: Droplets },
            ],
          },
          { 
            path: "/customers", 
            label: "Customers", 
            icon: Users, 
            isDropdown: true,
            dropdownItems: [
              { path: "/customers", label: "Customers", icon: Users },
              { path: "/site-maps", label: "Maps", icon: MapIcon },
            ]
          },
          { path: "/", label: "Dashboard", icon: Home, isCenter: true },
          { 
            path: "/parts", 
            label: "Parts", 
            icon: Package, 
            isDropdown: true,
            dropdownItems: [
              { path: "/parts", label: "Parts Catalog", icon: Package },
              { path: "/parts-settings", label: "Parts Settings", icon: Settings },
            ]
          },
        ];
      case "field_tech":
        return [
          { path: "/work-orders", label: "Work Orders", icon: Wrench },
          { path: "/wet-checks", label: "Wet Checks", icon: Droplets },
          { path: "/", label: "Home", icon: Home, isCenter: true },
          { path: "/billing-sheets", label: "Onsite", icon: ClipboardList },
          { path: "/customers", label: "Customers", icon: Users },
        ];
      case "billing_manager":
        return [
          { path: "/work-orders", label: "Work Orders", icon: Wrench },
          { 
            path: "/billing", 
            label: "Billing", 
            icon: DollarSign, 
            isDropdown: true,
            dropdownItems: [
              { path: "/billing-sheets", label: "Billing Sheets", icon: ClipboardList },
              { path: "/billing/command-center", label: "Command Center", icon: ClipboardList },
              { path: "/estimates/pending-approval", label: "Estimates Pending Approval", icon: ShieldCheck, badge: pendingEstimateCount > 0 ? pendingEstimateCount : undefined },
            ]
          },
          { path: "/", label: "Home", icon: Home, isCenter: true },
          { path: "/invoices", label: "Invoices", icon: Receipt },
          { path: "/customers", label: "Customers", icon: Users },
          { path: "/quickbooks", label: "QuickBooks", icon: Calculator },
          { 
            path: "/parts", 
            label: "Parts", 
            icon: Package, 
            isDropdown: true,
            dropdownItems: [
              { path: "/parts", label: "Parts Catalog", icon: Package },
              { path: "/parts-settings", label: "Parts Settings", icon: Settings },
              { path: "/parts-pending-approval", label: "Parts Pending Approval", icon: ShieldCheck, badge: pendingApprovalCount > 0 ? pendingApprovalCount : undefined },
            ]
          },
        ];
      // Task #1886 — the bookkeeper's three surfaces. This case must exist:
      // falling through to the `default: []` below would render a blank app
      // for the role on this nav surface while the desktop sidebar looked fine.
      case "bookkeeper":
        return [
          { path: "/invoices", label: "Invoices", icon: Receipt },
          { path: "/customers", label: "Customers", icon: Users },
          { path: "/quickbooks", label: "QuickBooks", icon: Calculator },
        ];
      default:
        return [];
    }
  };

  const navItems = getNavItems();

  return (
    <>
      {/* Desktop Navigation - Top */}
      <nav className="hidden lg:block bg-white shadow-sm border-b border-transparent relative after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-gradient-to-r after:from-transparent after:via-primary/40 after:to-transparent">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-24">
            {/* Logo */}
            <div className="flex-shrink-0">
              <Link href="/">
                <div
                  className="inline-flex items-center justify-center px-3 py-2 rounded-xl cursor-pointer transition-all duration-200 hover:opacity-90"
                  style={{
                    background: "linear-gradient(135deg, hsl(var(--primary-dark)/0.08) 0%, hsl(var(--primary)/0.05) 100%)",
                    boxShadow: "0 0 0 1px hsl(var(--primary)/0.12), 0 2px 8px hsl(var(--primary)/0.10)",
                  }}
                >
                  <img
                    src={irrigoProLogo}
                    alt="IrrigoPro"
                    className="h-20 w-auto"
                    style={{ filter: "drop-shadow(0 2px 6px hsl(var(--primary)/0.22))" }}
                  />
                </div>
              </Link>
            </div>
            
            {/* Navigation Items */}
            <div className="flex items-center divide-x divide-gray-200/70">
              {(() => {
                // Reorder items for desktop - Dashboard first, then others
                const desktopNavItems = [...navItems];
                const dashboardIndex = desktopNavItems.findIndex(item => item.isCenter);
                
                if (dashboardIndex > -1) {
                  const dashboardItem = desktopNavItems.splice(dashboardIndex, 1)[0];
                  desktopNavItems.unshift(dashboardItem);
                }
                
                const activeTopClass = "bg-primary/10 text-primary font-semibold rounded-md shadow-sm ring-1 ring-primary/20 hover:bg-primary/15";
                const inactiveTopClass = "text-gray-600 hover:text-primary hover:bg-primary/5 rounded-md";

                return desktopNavItems.map((item) => {
                  const wrapperClass = "px-3 first:pl-0 last:pr-0";
                  if (item.isDropdown && item.dropdownItems) {
                    // Check if any dropdown item is active
                    const isDropdownActive = item.dropdownItems.some(dropdownItem => isActive(dropdownItem.path));
                    
                    return (
                      <div key={item.path} className={wrapperClass}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              className={`font-medium flex items-center space-x-1 transition-colors ${
                                isDropdownActive ? activeTopClass : inactiveTopClass
                              }`}
                            >
                              <span>{item.label}</span>
                              <ChevronDown className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {item.dropdownItems.map((dropdownItem: NavDropdownItem) => {
                              const childActive = isActive(dropdownItem.path);
                              return (
                                <Link key={dropdownItem.path} href={dropdownItem.path}>
                                  <DropdownMenuItem className={`flex items-center space-x-2 relative pl-4 ${
                                    childActive
                                      ? "bg-primary/10 text-primary font-semibold before:absolute before:left-0 before:top-1 before:bottom-1 before:w-1 before:rounded-r before:bg-primary focus:bg-primary/15"
                                      : "hover:bg-primary/5"
                                  }`}>
                                    <dropdownItem.icon className="w-4 h-4" />
                                    <span>{dropdownItem.label}</span>
                                    {dropdownItem.badge && (
                                      <Badge variant="destructive" className="ml-auto h-5 w-5 p-0 flex items-center justify-center text-xs">
                                        {dropdownItem.badge > 99 ? "99+" : dropdownItem.badge}
                                      </Badge>
                                    )}
                                  </DropdownMenuItem>
                                </Link>
                              );
                            })}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  }
                  
                  return (
                    <div key={item.path} className={wrapperClass}>
                      <Link href={item.path}>
                        <Button
                          variant="ghost"
                          className={`font-medium transition-colors ${
                            isActive(item.path) ? activeTopClass : inactiveTopClass
                          }`}
                        >
                          {item.label}
                        </Button>
                      </Link>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Desktop User Menu */}
            <div className="flex items-center space-x-2">
              <NotificationSystem userId={user.id} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="flex items-center space-x-2 p-2">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary text-white">
                        {user.name?.charAt(0) || 'U'}
                      </AvatarFallback>
                    </Avatar>
                    <span className="hidden sm:block text-sm font-medium">{user.name}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <div className="px-2 py-1.5">
                    <p className="text-sm font-medium">{user.name}</p>
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  </div>
                  <DropdownMenuSeparator />
                  <Link href="/user-profile">
                    <DropdownMenuItem>
                      <User className="mr-2 h-4 w-4" />
                      My Account
                    </DropdownMenuItem>
                  </Link>
                  <Link href="/switch-user">
                    <DropdownMenuItem>
                      <User className="mr-2 h-4 w-4" />
                      Switch User
                    </DropdownMenuItem>
                  </Link>
                  <DropdownMenuItem
                    onClick={clearSessionAndLogout}
                    className="text-red-600"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    Logout
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
        
        {/* Company Logo Banner - Below IrrigoPro Header */}
        {logoApiUrl && (
          <div className="border-b border-gray-200 bg-gray-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex justify-center items-center py-3">
                <img 
                  src={logoApiUrl} 
                  alt="Company Logo"
                  className="h-20 w-auto object-contain"
                />
              </div>
            </div>
          </div>
        )}
      </nav>

      {/* Mobile Navigation - Bottom */}
      <div className="lg:hidden m-0 p-0">
        {/* Top Bar with Logo and Notifications */}
        <div className="bg-white shadow-sm border-b border-gray-200 m-0 p-0">
          <div className="flex justify-between items-center h-14 px-4">
            {/* Logo */}
            <div className="flex items-center min-w-0 flex-1 mr-2">
              <div
                className="inline-flex items-center justify-center px-2 py-1 rounded-lg"
                style={{
                  background: "linear-gradient(135deg, hsl(var(--primary-dark)/0.08) 0%, hsl(var(--primary)/0.05) 100%)",
                  boxShadow: "0 0 0 1px hsl(var(--primary)/0.12), 0 1px 4px hsl(var(--primary)/0.10)",
                }}
              >
                <img
                  src={irrigoProLogo}
                  alt="IrrigoPro"
                  className="h-9 w-auto max-w-full object-contain"
                  style={{ filter: "drop-shadow(0 1px 4px hsl(var(--primary)/0.20))" }}
                />
              </div>
            </div>

            {/* User Menu and Notifications */}
            <div className="flex items-center space-x-2">
              <NotificationSystem userId={user.id} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="p-2">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary text-white">
                        {user.name?.charAt(0) || 'U'}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <div className="px-2 py-1.5">
                    <p className="text-sm font-medium">{user.name}</p>
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  </div>
                  <DropdownMenuSeparator />
                  <Link href="/user-profile">
                    <DropdownMenuItem>
                      <User className="mr-2 h-4 w-4" />
                      My Account
                    </DropdownMenuItem>
                  </Link>
                  <Link href="/switch-user">
                    <DropdownMenuItem>
                      <User className="mr-2 h-4 w-4" />
                      Switch User
                    </DropdownMenuItem>
                  </Link>
                  <DropdownMenuItem
                    onClick={clearSessionAndLogout}
                    className="text-red-600"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    Logout
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {/* Mobile Company Logo Banner */}
        {logoApiUrl && (
          <div className="border-b border-gray-200 bg-gray-50">
            <div className="flex justify-center items-center py-3 px-4">
              <img 
                src={logoApiUrl} 
                alt="Company Logo"
                className="h-16 w-auto object-contain"
              />
            </div>
          </div>
        )}

        {/* Bottom Navigation Bar */}
        <div className="fixed bottom-0 left-0 right-0 mobile-nav-gradient border-t border-gray-100/50 shadow-xl z-50 pb-safe">
          <div className="relative py-3 px-4 pb-4">
            {/* 5-Column Grid Layout with Dashboard in center */}
            <div className="grid grid-cols-5 gap-2 items-center max-w-sm mx-auto">
              {(() => {
                // Create 5 slots with dashboard always in position 3 (center)
                const slots = Array(5).fill(null);
                const centerIndex = 2; // Position 3 (0-indexed)
                
                // Find center item and place it in slot 3
                const centerItem = navItems.find(item => item.isCenter);
                if (centerItem) {
                  slots[centerIndex] = centerItem;
                }
                
                // Get non-center items and expand dropdown items for mobile
                let otherItems = navItems.filter(item => !item.isCenter);
                
                // For mobile, expand dropdown items with prioritization
                const expandedItems: any[] = [];
                
                // For company admin, prioritize essential functions for mobile
                if (userRole === 'company_admin') {
                  // Operations is now a dropdown — surface its Work Orders + Billing Sheets entries
                  const operationsDropdown = otherItems.find(item => item.label === 'Operations' && item.isDropdown);
                  if (operationsDropdown?.dropdownItems) {
                    const woLink = operationsDropdown.dropdownItems.find((d: NavDropdownItem) => d.label === 'Work Orders');
                    const bsLink = operationsDropdown.dropdownItems.find((d: NavDropdownItem) => d.label === 'Billing Sheets');
                    if (woLink) expandedItems.push(woLink);
                    if (bsLink) expandedItems.push(bsLink);
                  }
                  
                  // Add direct Customers link
                  const customersItem = otherItems.find(item => item.label === 'Customers' && item.isDropdown);
                  if (customersItem?.dropdownItems) {
                    const customersLink = customersItem.dropdownItems.find((dropdownItem: NavDropdownItem) => dropdownItem.label === 'Customers');
                    if (customersLink && expandedItems.length < 4) expandedItems.push(customersLink);
                  }
                  
                  // Fill remaining slots with the Billing Command Center for quick access
                  const billingDropdown = otherItems.find(item => item.label === 'Billing' && item.isDropdown);
                  if (billingDropdown?.dropdownItems) {
                    const ccLink = billingDropdown.dropdownItems.find((d: NavDropdownItem) => d.label === 'Command Center');
                    if (ccLink && expandedItems.length < 4) expandedItems.push(ccLink);
                  }
                } else if (userRole === 'irrigation_manager') {
                  // For irrigation managers, prioritize key operational areas for mobile
                  // Add non-dropdown items first (Work Orders, Billing, Estimates)
                  otherItems.filter(item => !item.isDropdown).forEach(item => {
                    expandedItems.push(item);
                  });
                  
                  // Add Customers (primary customer access) instead of Parts Catalog
                  const customersItem = otherItems.find(item => item.label === 'Customers' && item.isDropdown);
                  if (customersItem?.dropdownItems) {
                    const customersLink = customersItem.dropdownItems.find((dropdownItem: NavDropdownItem) => dropdownItem.label === 'Customers');
                    if (customersLink) {
                      expandedItems.push(customersLink);
                    }
                  }
                } else if (userRole === 'billing_manager') {
                  // For billing managers mobile: Work Orders, Billing Sheets, Billing Command Center, Invoices
                  const woItem = otherItems.find(item => item.label === 'Work Orders');
                  if (woItem) expandedItems.push(woItem);
                  const billingItem = otherItems.find(item => item.label === 'Billing' && item.isDropdown);
                  if (billingItem?.dropdownItems) {
                    const sheetsLink = billingItem.dropdownItems.find((d: NavDropdownItem) => d.label === 'Billing Sheets');
                    if (sheetsLink) expandedItems.push(sheetsLink);
                    const ccLink = billingItem.dropdownItems.find((d: NavDropdownItem) => d.label === 'Command Center');
                    if (ccLink) expandedItems.push(ccLink);
                  }
                  const invoicesItem = otherItems.find(item => item.label === 'Invoices');
                  if (invoicesItem) expandedItems.push(invoicesItem);
                } else {
                  // For other roles, use the standard expansion
                  otherItems.forEach(item => {
                    if (item.isDropdown && item.dropdownItems) {
                      expandedItems.push(...item.dropdownItems);
                    } else {
                      expandedItems.push(item);
                    }
                  });
                }
                
                otherItems = expandedItems;
                
                // For field techs, fill all 5 slots exactly
                if (userRole === 'field_tech') {
                  // Field techs have exactly 5 items, place them in order
                  const allItems = navItems;
                  allItems.forEach((item, index) => {
                    if (item.isCenter) {
                      slots[centerIndex] = item;
                    } else {
                      // Place other items in remaining slots
                      const otherSlots = [0, 1, 3, 4];
                      const otherItemIndex = allItems.filter(i => !i.isCenter).indexOf(item);
                      if (otherItemIndex < otherSlots.length) {
                        slots[otherSlots[otherItemIndex]] = item;
                      }
                    }
                  });
                } else {
                  // Fill slots around center (positions 0, 1, 3, 4) for other roles
                  let itemIndex = 0;
                  for (let i = 0; i < 5; i++) {
                    if (i !== centerIndex && itemIndex < otherItems.length) {
                      slots[i] = otherItems[itemIndex];
                      itemIndex++;
                    }
                  }
                }
                
                return slots.map((item, slotIndex) => {
                  if (!item) {
                    // Empty slot with minimal spacing
                    return <div key={`empty-${slotIndex}`} className="flex justify-center h-14"></div>;
                  }
                  
                  const Icon = item.icon;
                  const active = isActive(item.path);
                  const isCenter = item.isCenter;
                  
                  if (isCenter) {
                    return (
                      <div key={item.path} className="flex justify-center">
                        <Link href={item.path}>
                          <div className="relative">
                            {/* Enhanced Dashboard Button with Modern Design */}
                            <div className={`
                              flex flex-col items-center justify-center w-16 h-16 rounded-2xl -mt-6
                              bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 
                              text-white shadow-2xl border-3 border-white
                              transform transition-all duration-200 ease-out
                              hover:scale-110 active:scale-95 hover:shadow-2xl
                              ${active 
                                ? 'shadow-2xl scale-105 ring-4 ring-blue-100' 
                                : 'shadow-lg hover:shadow-blue-500/30'
                              }
                            `}>
                              <Icon className="h-6 w-6 mb-0.5" />
                              <span className="text-xs font-bold leading-none tracking-wide">Home</span>
                              {/* Subtle glow effect */}
                              <div className="absolute inset-0 bg-gradient-to-br from-blue-400/20 to-transparent rounded-2xl pointer-events-none"></div>
                            </div>
                          </div>
                        </Link>
                      </div>
                    );
                  }
                  
                  return (
                    <div key={item.path} className="flex justify-center">
                      <Link href={item.path}>
                        <div className={`
                          flex flex-col items-center justify-center w-14 h-14 rounded-xl 
                          transition-all duration-200 ease-out transform hover:scale-105
                          ${active
                            ? "text-blue-600 bg-gradient-to-br from-blue-50 to-blue-100 shadow-md scale-105 ring-2 ring-blue-200"
                            : "text-gray-600 hover:text-blue-600 hover:bg-gradient-to-br hover:from-gray-50 hover:to-gray-100 hover:shadow-md"
                          }
                        `}>
                          <Icon className={`h-4 w-4 transition-transform duration-200 ${active ? 'scale-110' : ''}`} />
                          {item.label === "Work Orders" ? (
                            <div className="text-xs font-semibold text-center leading-none mt-1">
                              <div>Work</div>
                              <div>Orders</div>
                            </div>
                          ) : item.label === "Billing Sheets" ? (
                            <div className="text-xs font-semibold text-center leading-none mt-1">
                              <div>Billing</div>
                              <div>Sheets</div>
                            </div>
                          ) : item.label === "Parts Catalog" ? (
                            <div className="text-xs font-semibold text-center leading-none mt-1">
                              <div>Parts</div>
                            </div>
                          ) : item.label === "Onsite" ? (
                            <span className="text-xs font-semibold text-center mt-1">Onsite</span>
                          ) : item.label === "Maps" ? (
                            <span className="text-xs font-semibold text-center mt-1">Maps</span>
                          ) : item.label === "Billing" ? (
                            <span className="text-xs font-semibold text-center mt-1">Billing</span>
                          ) : (
                            <span className="text-xs font-semibold text-center mt-1">{item.label}</span>
                          )}
                        </div>
                      </Link>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>


      </div>
    </>
  );
}