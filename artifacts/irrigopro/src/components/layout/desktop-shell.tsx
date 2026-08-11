import { useState, useEffect, useMemo, useRef, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { clearSessionAndLogout } from "@/lib/queryClient";
import { getImpersonationToken } from "@/lib/impersonation";
import {
  hasCapability,
  CAN_READ_INVOICES,
  OVERDUE_AGING_FILTER,
} from "@workspace/shared";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ChevronRight,
  ChevronDown,
  ChevronsUpDown,
  LogOut,
  User as UserIcon,
  X,
} from "lucide-react";
import Navigation from "@/components/layout/navigation";
import PoweredByFooter from "@/components/layout/powered-by-footer";
import { NotificationSystem } from "@/components/notifications/notification-system";
import { safeGet, safeSet } from "@/utils/safeStorage";
import { useAuth } from "@/lib/auth-context";
import irrigoProLogo from "@assets/IrrigoPro_2026-03_1778193170303.png";
import irrigoProMark from "@assets/IrrigoPro_2026-05_1778193170303.png";
import { resolveRouteMeta } from "./route-meta";
import { ImpersonationBanner } from "@/components/app-health/impersonation-banner";
import type {
  NavConfig,
  NavItem,
  NavGroup,
  NavLeaf,
  NavBadgeMap,
} from "./nav-config";
import type { Part, ManualPartReview, Estimate } from "@workspace/db/schema";

const SIDEBAR_STORAGE_KEY = "irrigopro_desktop_sidebar_open";
const SHELL_HINT_SEEN_KEY = "irrigopro_desktop_shell_seen";

function pathMatches(itemPath: string, location: string): boolean {
  if (itemPath === "/") return location === "/";
  return location === itemPath || location.startsWith(itemPath + "/");
}

function collectLeaves(items: NavItem[]): NavLeaf[] {
  const out: NavLeaf[] = [];
  for (const it of items) {
    if (it.type === "leaf") out.push(it);
    else out.push(...collectLeaves(it.items));
  }
  return out;
}

function pickActiveLeafPath(
  config: NavConfig,
  location: string,
): string | null {
  const matches = collectLeaves(config.items).filter((l) =>
    pathMatches(l.path, location),
  );
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.path.length > a.path.length ? b : a)).path;
}

function groupHasActive(group: NavGroup, activePath: string | null): boolean {
  if (!activePath) return false;
  for (const it of group.items) {
    if (it.type === "leaf" && it.path === activePath) return true;
    if (it.type === "group" && groupHasActive(it, activePath)) return true;
  }
  return false;
}

// Task #1914 — the overdue-invoice badge reads its number from the invoice
// list endpoint's own overdue aging filter (OVERDUE_AGING_FILTER, shared with
// the endpoint that applies it), so the badge cannot disagree with the aging
// rules in lib/shared/src/invoice-aging.ts or with the list the bookkeeper
// lands on. `limit=1&offset=0` asks for the smallest possible page: the number
// we want is the POST-filter total the endpoint reports in X-Total-Count, and
// counting returned rows client-side would cap the badge at a page size.
export const OVERDUE_INVOICES_URL =
  `/api/invoices?aging=${OVERDUE_AGING_FILTER}&limit=1&offset=0`;

async function fetchOverdueInvoiceCount(): Promise<number | null> {
  try {
    const headers: Record<string, string> = {};
    const impToken = getImpersonationToken();
    if (impToken) headers["x-impersonation-token"] = impToken;
    const res = await fetch(OVERDUE_INVOICES_URL, {
      credentials: "include",
      headers,
    });
    if (!res.ok) return null;
    const raw = res.headers.get("X-Total-Count");
    if (raw == null) return null;
    const total = Number(raw);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

/**
 * @param enabled          the four long-standing approval badges
 * @param overdueEnabled   the overdue-invoice badge, gated separately
 *
 * Task #1914 — the two gates are deliberately independent. `enabled` is a
 * hardcoded role list that predates the bookkeeper; folding the overdue query
 * into it would either leave her badge dead or start four roles polling
 * endpoints they have never polled. Neither flag may widen the other.
 */
function useNavBadges(enabled: boolean, overdueEnabled: boolean): NavBadgeMap {
  // Task #539 — see notification-system.tsx: the workspace queryFn
  // default returns `null` on 401 (so destructure defaults like
  // `data = []` DO NOT apply). Coerce each badge query through
  // `Array.isArray(...) ? ... : []` so a logged-out probe can never
  // resurface as a render-time `i.some` / `i.length` crash.
  const { data: pendingPartsRaw } = useQuery<Part[] | null>({
    queryKey: ["/api/parts/pending-approval"],
    enabled,
    refetchInterval: 60000,
  });
  const { data: pendingReviewsRaw } = useQuery<ManualPartReview[] | null>({
    queryKey: ["/api/manual-part-reviews"],
    enabled,
    refetchInterval: 60000,
  });
  const { data: wetCheckPendingRaw } = useQuery<unknown[] | null>({
    queryKey: ["/api/wet-checks/pending-review"],
    enabled,
    refetchInterval: 60000,
  });
  const { data: pendingEstimatesRaw } = useQuery<Estimate[] | null>({
    queryKey: ["/api/estimates/pending-approval"],
    enabled,
    refetchInterval: 60000,
  });
  const { data: needsApprovalCountRaw } = useQuery<{
    workOrderCount?: number;
    billingSheetCount?: number;
    total?: number;
  } | null>({
    queryKey: ["/api/manager-workspace/needs-approval/count"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/manager-workspace/needs-approval/count");
        if (!res.ok) return null;
        return (await res.json()) as {
          workOrderCount?: number;
          billingSheetCount?: number;
          total?: number;
        };
      } catch {
        return null;
      }
    },
    enabled,
    refetchInterval: 60000,
  });
  // Task #1914 — its own `enabled`, never the flag above.
  const { data: overdueInvoicesRaw } = useQuery<number | null>({
    queryKey: [OVERDUE_INVOICES_URL],
    queryFn: fetchOverdueInvoiceCount,
    enabled: overdueEnabled,
    refetchInterval: 60000,
  });
  const pendingParts = Array.isArray(pendingPartsRaw) ? pendingPartsRaw : [];
  const pendingReviews = Array.isArray(pendingReviewsRaw) ? pendingReviewsRaw : [];
  const wetCheckPending = Array.isArray(wetCheckPendingRaw) ? wetCheckPendingRaw : [];
  const pendingEstimates = Array.isArray(pendingEstimatesRaw) ? pendingEstimatesRaw : [];
  const awaitingApprovalCount =
    typeof needsApprovalCountRaw?.total === "number" ? needsApprovalCountRaw.total : 0;
  return {
    partsPendingApproval: pendingParts.length + pendingReviews.length,
    wetCheckReviews: wetCheckPending.length,
    estimatesPendingApproval: pendingEstimates.length,
    awaitingApproval: awaitingApprovalCount,
    // A failed or not-yet-resolved count is 0, which LeafItem renders as no
    // badge at all rather than a "0" the bookkeeper would have to interpret.
    overdueInvoices: typeof overdueInvoicesRaw === "number" ? overdueInvoicesRaw : 0,
  };
}

interface PageActionsContextValue {
  target: HTMLDivElement | null;
}

const PageActionsContext = createContext<PageActionsContextValue | null>(null);

export function PageActions({ children }: { children: React.ReactNode }) {
  const ctx = useContext(PageActionsContext);
  if (!ctx || !ctx.target) return null;
  return createPortal(children, ctx.target);
}

interface SessionUser {
  id?: number;
  name?: string;
  email?: string;
  role?: string;
}

interface DesktopShellProps {
  navConfig: NavConfig;
  children: React.ReactNode;
}

export function DesktopShell({ navConfig, children }: DesktopShellProps) {
  const [open, setOpenState] = useState<boolean>(() => {
    const stored = safeGet(SIDEBAR_STORAGE_KEY);
    if (stored === null) return true;
    return stored === "true";
  });
  const setOpen = (next: boolean) => {
    setOpenState(next);
    safeSet(SIDEBAR_STORAGE_KEY, next ? "true" : "false");
  };

  const { user: authUser } = useAuth();
  const user: SessionUser = useMemo<SessionUser>(
    () => ({
      id: authUser?.id,
      name: authUser?.name,
      email: authUser?.email,
      role: authUser?.role,
    }),
    [authUser],
  );
  const userRole = authUser?.role;
  const enableBadges =
    userRole === "company_admin" ||
    userRole === "billing_manager" ||
    userRole === "irrigation_manager";
  // Task #1914 — the overdue badge is gated on the capability that guards the
  // endpoint it reads (requireInvoiceRead), not on the role list above. A role
  // without CAN_READ_INVOICES — a field tech — issues no request for it at all,
  // rather than firing one that 403s in the background.
  const enableOverdueBadge = hasCapability(userRole, CAN_READ_INVOICES);
  const badges = useNavBadges(enableBadges, enableOverdueBadge);

  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const actionsContextValue = useMemo(
    () => ({ target: actionsTarget }),
    [actionsTarget],
  );

  return (
    <div data-testid="desktop-shell">
    <PageActionsContext.Provider value={actionsContextValue}>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <div className="hidden lg:contents">
          <DesktopSidebar
            navConfig={navConfig}
            badges={badges}
            user={user}
            userRole={userRole}
          />
        </div>
        <SidebarInset className="min-h-screen pb-20 lg:pb-0">
          <div className="lg:hidden">
            <Navigation />
          </div>
          <ImpersonationBanner />
          <TopStrip
            navConfig={navConfig}
            user={user}
            actionsRef={setActionsTarget}
            showShellHint={enableBadges}
          />
          <div className="flex-1 bg-gray-50">{children}</div>
          <PoweredByFooter />
        </SidebarInset>
      </SidebarProvider>
    </PageActionsContext.Provider>
    </div>
  );
}

function TopStrip({
  navConfig,
  user,
  actionsRef,
  showShellHint,
}: {
  navConfig: NavConfig;
  user: SessionUser;
  actionsRef: (el: HTMLDivElement | null) => void;
  showShellHint: boolean;
}) {
  const [location] = useLocation();
  const meta = useMemo(
    () => resolveRouteMeta(location, navConfig),
    [location, navConfig],
  );
  return (
    <header className="hidden lg:flex sticky top-0 z-30 h-14 items-center gap-3 border-b border-gray-200 bg-white px-4">
      <ShellHint enabled={showShellHint}>
        <SidebarTrigger />
      </ShellHint>
      <div className="h-6 w-px bg-gray-200" />
      <nav
        aria-label="Breadcrumb"
        className="flex items-center text-sm text-gray-600 min-w-0"
      >
        <ol className="flex items-center gap-1.5 min-w-0">
          {meta.breadcrumb.map((seg, i) => {
            const isLast = i === meta.breadcrumb.length - 1;
            return (
              <li
                key={`${i}-${seg.label}`}
                className="flex items-center gap-1.5 min-w-0"
              >
                {i > 0 && (
                  <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                )}
                {seg.path && !isLast ? (
                  <Link
                    href={seg.path}
                    className="hover:text-gray-900 truncate"
                  >
                    {seg.label}
                  </Link>
                ) : (
                  <span
                    className={`truncate ${
                      isLast ? "font-medium text-gray-900" : ""
                    }`}
                  >
                    {seg.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <div ref={actionsRef} className="flex items-center gap-2" />
        {typeof user.id === "number" && (
          <NotificationSystem userId={user.id} />
        )}
      </div>
    </header>
  );
}

function ShellHint({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const { open: sidebarOpen } = useSidebar();
  const [open, setOpen] = useState(false);
  const interactedRef = useRef(false);
  const initialOpenRef = useRef(sidebarOpen);
  useEffect(() => {
    if (!enabled) return;
    if (interactedRef.current) return;
    if (sidebarOpen === initialOpenRef.current) return;
    interactedRef.current = true;
    if (safeGet(SHELL_HINT_SEEN_KEY) === "true") return;
    setOpen(true);
  }, [enabled, sidebarOpen]);
  const dismiss = () => {
    safeSet(SHELL_HINT_SEEN_KEY, "true");
    setOpen(false);
  };
  if (!enabled) return <>{children}</>;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-64 p-3 text-sm"
      >
        <div className="flex items-start gap-2">
          <p className="flex-1 text-gray-700">
            Press Cmd+B (Ctrl+B on Windows) to collapse the rail.
          </p>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss hint"
            className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DesktopSidebar({
  navConfig,
  badges,
  user,
  userRole,
}: {
  navConfig: NavConfig;
  badges: NavBadgeMap;
  user: SessionUser;
  userRole?: string;
}) {
  const [location] = useLocation();
  const activePath = useMemo(
    () => pickActiveLeafPath(navConfig, location),
    [navConfig, location],
  );
  const brandThemed =
    userRole === "company_admin" ||
    userRole === "billing_manager" ||
    userRole === "irrigation_manager";
  return (
    <Sidebar
      collapsible="icon"
      className={brandThemed ? "sidebar-brand-blue" : undefined}
    >
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          {/* Dot-icon mark for collapsed (icon-only) sidebar */}
          <img
            src={irrigoProMark}
            alt="IrrigoPro"
            className="h-12 w-12 object-contain shrink-0 hidden group-data-[collapsible=icon]:block"
          />
          {/* Full horizontal lockup when sidebar is expanded */}
          <img
            src={irrigoProLogo}
            alt="IrrigoPro"
            className="h-12 w-auto object-contain shrink-0 group-data-[collapsible=icon]:hidden"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {navConfig.items.map((item, idx) => (
          <TopLevelEntry
            key={`${idx}-${item.label}`}
            item={item}
            activePath={activePath}
            badges={badges}
          />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarUserMenu user={user} brandThemed={brandThemed} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function TopLevelEntry({
  item,
  activePath,
  badges,
}: {
  item: NavItem;
  activePath: string | null;
  badges: NavBadgeMap;
}) {
  if (item.type === "leaf") {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <LeafItem
              leaf={item}
              activePath={activePath}
              badges={badges}
            />
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{item.label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {item.items.map((sub, idx) => {
            if (sub.type === "leaf") {
              return (
                <LeafItem
                  key={`${idx}-${sub.path}`}
                  leaf={sub}
                  activePath={activePath}
                  badges={badges}
                />
              );
            }
            return (
              <NestedGroupItem
                key={`${idx}-${sub.label}`}
                group={sub}
                activePath={activePath}
                badges={badges}
              />
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function LeafItem({
  leaf,
  activePath,
  badges,
}: {
  leaf: NavLeaf;
  activePath: string | null;
  badges: NavBadgeMap;
}) {
  const Icon = leaf.icon;
  const active = activePath === leaf.path;
  const badgeCount = leaf.badgeKey ? badges[leaf.badgeKey] : undefined;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={leaf.label}>
        <Link href={leaf.path}>
          <Icon />
          <span>{leaf.label}</span>
        </Link>
      </SidebarMenuButton>
      {typeof badgeCount === "number" && badgeCount > 0 && (
        <SidebarMenuBadge className="bg-destructive text-destructive-foreground">
          {badgeCount > 99 ? "99+" : badgeCount}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function NestedGroupItem({
  group,
  activePath,
  badges,
}: {
  group: NavGroup;
  activePath: string | null;
  badges: NavBadgeMap;
}) {
  const hasActive = groupHasActive(group, activePath);
  const [open, setOpen] = useState<boolean>(
    () => hasActive || !!group.defaultOpen,
  );
  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);
  const Icon = group.icon;
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={group.label}>
            {Icon && <Icon />}
            <span>{group.label}</span>
            <ChevronDown
              className={`ml-auto transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {group.items.map((sub, idx) => {
              if (sub.type !== "leaf") return null;
              const active = activePath === sub.path;
              const badgeCount = sub.badgeKey
                ? badges[sub.badgeKey]
                : undefined;
              return (
                <SidebarMenuSubItem key={`${idx}-${sub.path}`}>
                  <SidebarMenuSubButton asChild isActive={active}>
                    <Link href={sub.path}>
                      <span>{sub.label}</span>
                    </Link>
                  </SidebarMenuSubButton>
                  {typeof badgeCount === "number" && badgeCount > 0 && (
                    <SidebarMenuBadge className="bg-destructive text-destructive-foreground">
                      {badgeCount > 99 ? "99+" : badgeCount}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function SidebarUserMenu({
  user,
  brandThemed,
}: {
  user: SessionUser;
  brandThemed: boolean;
}) {
  const initials = user.name?.charAt(0) || "U";
  const roleLabel = (user.role || "").replace(/_/g, " ");
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" tooltip={user.name || "Account"}>
              <Avatar className="h-8 w-8 rounded-md">
                <AvatarFallback
                  className={`rounded-md ${
                    brandThemed
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "bg-primary text-white"
                  }`}
                >
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col text-left min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <span className="text-sm font-medium truncate">
                  {user.name}
                </span>
                <span
                  className={`text-xs capitalize truncate ${
                    brandThemed ? "text-sidebar-foreground/70" : "text-gray-500"
                  }`}
                >
                  {roleLabel}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto h-4 w-4 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <Link href="/user-profile">
              <DropdownMenuItem>
                <UserIcon className="mr-2 h-4 w-4" />
                My Account
              </DropdownMenuItem>
            </Link>
            <Link href="/switch-user">
              <DropdownMenuItem>
                <UserIcon className="mr-2 h-4 w-4" />
                Switch User
              </DropdownMenuItem>
            </Link>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={clearSessionAndLogout}
              className="text-red-600"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
