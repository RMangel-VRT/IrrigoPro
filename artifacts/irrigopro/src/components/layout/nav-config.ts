import { LayoutDashboard } from "lucide-react";
import {
  Home,
  Briefcase,
  Wrench,
  ClipboardList,
  ClipboardCheck,
  Droplets,
  ShieldCheck,
  Users,
  MapIcon,
  DollarSign,
  Receipt,
  BarChart3,
  Package,
  Settings,
  Calculator,
  Cpu,
  Building2,
  Activity,
  AlertTriangle,
  UserCog,
  Repeat,
  Database,
  type LucideIcon,
} from "lucide-react";

export type NavBadgeKey =
  | "partsPendingApproval"
  | "wetCheckReviews"
  | "estimatesPendingApproval"
  | "awaitingApproval";

export type NavBadgeMap = Partial<Record<NavBadgeKey, number>>;

export interface NavLeaf {
  type: "leaf";
  label: string;
  path: string;
  icon: LucideIcon;
  badgeKey?: NavBadgeKey;
}

export interface NavGroup {
  type: "group";
  label: string;
  icon?: LucideIcon;
  defaultOpen?: boolean;
  items: Array<NavLeaf | NavGroup>;
}

export type NavItem = NavLeaf | NavGroup;

export interface NavConfig {
  items: NavItem[];
}

const baseReportItems: NavItem[] = [
  {
    type: "leaf",
    label: "Missing Photos – Work Orders",
    path: "/work-orders/missing-photos",
    icon: ShieldCheck,
  },
  {
    type: "leaf",
    label: "Missing Photos – Billing",
    path: "/billing-sheets/missing-photos",
    icon: ShieldCheck,
  },
  {
    type: "leaf",
    label: "Zero Price Audit",
    path: "/billing-sheets/zero-price-audit",
    icon: ShieldCheck,
  },
  {
    type: "leaf",
    label: "Labor Rate Audit",
    path: "/billing-sheets/labor-rate-audit",
    icon: ShieldCheck,
  },
];

export const reportsGroup: NavGroup = {
  type: "group",
  label: "Reports",
  icon: BarChart3,
  items: [
    ...baseReportItems,
    {
      type: "leaf",
      label: "WC Reconciliation",
      path: "/admin/wet-check-reconciliation",
      icon: ShieldCheck,
    },
  ],
};

// Billing managers get the same reports except WC Reconciliation
// (that page is company_admin / super_admin only).
export const billingManagerReportsGroup: NavGroup = {
  type: "group",
  label: "Reports",
  icon: BarChart3,
  items: baseReportItems,
};

export const wetCheckGroup: NavGroup = {
  type: "group",
  label: "Wet Check",
  icon: Droplets,
  items: [
    { type: "leaf", label: "Wet Checks", path: "/wet-checks", icon: Droplets },
  ],
};

export const billingManagerNav: NavConfig = {
  items: [
    { type: "leaf", label: "Dashboard", path: "/", icon: Home },
    {
      type: "group",
      label: "Billing",
      icon: DollarSign,
      defaultOpen: true,
      items: [
        { type: "leaf", label: "Manager Workspace", path: "/manager-workspace", icon: LayoutDashboard, badgeKey: "awaitingApproval" },
        { type: "leaf", label: "Financial Pulse", path: "/financial-pulse", icon: Activity },
        { type: "leaf", label: "Command Center", path: "/billing/command-center", icon: ClipboardList },
        { type: "leaf", label: "Billing Sheets", path: "/billing-sheets", icon: ClipboardList },
        { type: "leaf", label: "Invoices", path: "/invoices", icon: Receipt },
        billingManagerReportsGroup,
      ],
    },
    {
      type: "group",
      label: "Operations",
      icon: Briefcase,
      items: [
        { type: "leaf", label: "Work Orders", path: "/work-orders", icon: Wrench },
        {
          type: "leaf",
          label: "Estimates Pending Approval",
          path: "/estimates/pending-approval",
          icon: ShieldCheck,
          badgeKey: "estimatesPendingApproval",
        },
      ],
    },
    wetCheckGroup,
    { type: "leaf", label: "Customers", path: "/customers", icon: Users },
    {
      type: "group",
      label: "Parts",
      icon: Package,
      items: [
        { type: "leaf", label: "Parts Catalog", path: "/parts", icon: Package },
        {
          type: "leaf",
          label: "Parts Pending Approval",
          path: "/parts-pending-approval",
          icon: ShieldCheck,
          badgeKey: "partsPendingApproval",
        },
        { type: "leaf", label: "Parts Settings", path: "/parts-settings", icon: Settings },
      ],
    },
    {
      type: "group",
      label: "Settings",
      icon: Settings,
      items: [
        { type: "leaf", label: "QuickBooks", path: "/quickbooks", icon: Calculator },
        { type: "leaf", label: "Wet Check Issue Types", path: "/admin/issue-types", icon: Droplets },
      ],
    },
  ],
};

export const managerNav: NavConfig = {
  items: [
    { type: "leaf", label: "Manager Workspace", path: "/manager-workspace", icon: ClipboardCheck },
    wetCheckGroup,
    {
      type: "group",
      label: "Operations",
      icon: Briefcase,
      defaultOpen: true,
      items: [
        { type: "leaf", label: "Work Orders", path: "/work-orders", icon: Wrench },
        { type: "leaf", label: "Billing Sheets", path: "/billing-sheets", icon: ClipboardList },
        { type: "leaf", label: "Estimates", path: "/estimates", icon: ClipboardList },
        { type: "leaf", label: "Customers", path: "/customers", icon: Users },
        { type: "leaf", label: "Site Maps", path: "/site-maps", icon: MapIcon },
        { type: "leaf", label: "Financial Pulse", path: "/financial-pulse", icon: Activity },
      ],
    },
    {
      type: "group",
      label: "Parts",
      icon: Package,
      items: [
        { type: "leaf", label: "Parts Catalog", path: "/parts", icon: Package },
        { type: "leaf", label: "Parts Settings", path: "/parts-settings", icon: Settings },
      ],
    },
  ],
};

export const superAdminNav: NavConfig = {
  items: [
    { type: "leaf", label: "App Health", path: "/super-admin/app-health", icon: Activity },
    { type: "leaf", label: "Companies", path: "/super-admin", icon: Building2 },
    {
      type: "group",
      label: "Users",
      icon: Users,
      defaultOpen: true,
      items: [
        { type: "leaf", label: "All Users", path: "/system-users", icon: Users },
        { type: "leaf", label: "User Manager", path: "/user-manager", icon: UserCog },
        { type: "leaf", label: "Switch User", path: "/switch-user", icon: Repeat },
      ],
    },
    wetCheckGroup,
    {
      type: "group",
      label: "System",
      icon: Settings,
      items: [
        { type: "leaf", label: "Controllers & Zones", path: "/admin/controllers", icon: Cpu },
        { type: "leaf", label: "Financial Pulse", path: "/financial-pulse", icon: Activity },
        { type: "leaf", label: "Client Errors", path: "/admin/client-errors", icon: AlertTriangle },
        { type: "leaf", label: "QuickBooks", path: "/quickbooks", icon: Calculator },
      ],
    },
    {
      type: "group",
      label: "Data migrations",
      icon: Database,
      items: [
        { type: "leaf", label: "DB Migrations", path: "/admin/migrations", icon: Database },
        { type: "leaf", label: "WC Labor Backfill", path: "/admin/wc-labor-backfill", icon: Droplets },
        { type: "leaf", label: "Wet Check Issue Types", path: "/admin/issue-types", icon: Droplets },
      ],
    },
  ],
};

export const companyAdminNav: NavConfig = {
  items: [
    { type: "leaf", label: "Dashboard", path: "/", icon: Home },
    {
      type: "group",
      label: "Operations",
      icon: Briefcase,
      defaultOpen: true,
      items: [
        { type: "leaf", label: "Work Orders", path: "/work-orders", icon: Wrench },
        { type: "leaf", label: "Billing Sheets", path: "/billing-sheets", icon: ClipboardList },
        {
          type: "leaf",
          label: "Estimates",
          path: "/estimates/command-center",
          icon: LayoutDashboard,
          badgeKey: "estimatesPendingApproval",
        },
      ],
    },
    wetCheckGroup,
    {
      type: "group",
      label: "Customers",
      icon: Users,
      items: [
        { type: "leaf", label: "Customers", path: "/customers", icon: Users },
        { type: "leaf", label: "All Customers", path: "/admin/customers", icon: Users },
        { type: "leaf", label: "Maps", path: "/site-maps", icon: MapIcon },
      ],
    },
    {
      type: "group",
      label: "Billing",
      icon: DollarSign,
      items: [
        { type: "leaf", label: "Manager Workspace", path: "/manager-workspace", icon: LayoutDashboard, badgeKey: "awaitingApproval" },
        { type: "leaf", label: "Financial Pulse", path: "/financial-pulse", icon: Activity },
        { type: "leaf", label: "Command Center", path: "/billing/command-center", icon: ClipboardList },
        { type: "leaf", label: "Invoices", path: "/invoices", icon: Receipt },
        reportsGroup,
      ],
    },
    {
      type: "group",
      label: "Parts",
      icon: Package,
      items: [
        { type: "leaf", label: "Parts Catalog", path: "/parts", icon: Package },
        {
          type: "leaf",
          label: "Parts Pending Approval",
          path: "/parts-pending-approval",
          icon: ShieldCheck,
          badgeKey: "partsPendingApproval",
        },
        { type: "leaf", label: "Parts Settings", path: "/parts-settings", icon: Settings },
      ],
    },
    {
      type: "group",
      label: "Settings",
      icon: Settings,
      items: [
        { type: "leaf", label: "Controllers & Zones", path: "/admin/controllers", icon: Cpu },
        { type: "leaf", label: "Team", path: "/users", icon: Users },
        { type: "leaf", label: "Company Profile", path: "/company-profile", icon: Building2 },
        { type: "leaf", label: "QuickBooks", path: "/quickbooks", icon: Calculator },
        { type: "leaf", label: "Labor Rates", path: "/labor-rates", icon: DollarSign },
        { type: "leaf", label: "Wet Check Issue Types", path: "/admin/issue-types", icon: Droplets },
      ],
    },
  ],
};
