/**
 * bookkeeper-nav.test.tsx (Task #1886)
 *
 * There are TWO independent nav surfaces in this app — `nav-config.ts` drives
 * the desktop sidebar and `navigation.tsx` drives the nav rendered inside the
 * same shell. Adding a role to only one leaves it half-navigable, so both are
 * asserted here.
 *
 * Also covers the customer-profile Billing Details tab, which used to be
 * forced visible for every role by a `billing: isBillingRole || true` entry
 * and now tracks its own contents via CAN_READ_INVOICES.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasCapability,
  computeEffectiveDueDate,
  isInvoiceOverdue,
  CAN_READ_INVOICES,
  CAN_EDIT_INVOICES,
  CAN_SEND_INVOICE_EMAIL,
  CAN_VIEW_COSTS,
  OVERDUE_AGING_FILTER,
} from "@workspace/shared";

// Task #1914 — the signed-in role has to vary now: the overdue badge is gated
// on invoice-read capability, so a field tech's session must be renderable
// here to prove no request goes out for it. `vi.hoisted` is what lets the
// module mock below read a value the tests can change.
const session = vi.hoisted(() => ({
  role: "bookkeeper" as string,
}));

vi.mock("@/components/layout/navigation", () => ({
  default: () => <div data-testid="mock-navigation" />,
}));
vi.mock("@/components/layout/powered-by-footer", () => ({
  default: () => <div data-testid="mock-powered-by-footer" />,
}));
vi.mock("@/components/notifications/notification-system", () => ({
  NotificationSystem: () => <div data-testid="mock-notification-system" />,
}));
vi.mock("@/components/app-health/impersonation-banner", () => ({
  ImpersonationBanner: () => <div data-testid="mock-impersonation-banner" />,
}));
vi.mock("@/utils/safeStorage", () => ({
  safeGet: (key: string) =>
    key === "user"
      ? JSON.stringify({ id: 7, name: "Test Bookkeeper", role: session.role, companyId: 1 })
      : null,
  safeSet: vi.fn(),
  safeRemove: vi.fn(),
}));
vi.mock("@assets/IrrigoPro_2026-03_1778193170303.png", () => ({ default: "logo.png" }));
vi.mock("@assets/IrrigoPro_2026-05_1778193170303.png", () => ({ default: "mark.png" }));
vi.mock("@/components/layout/route-meta", () => ({
  resolveRouteMeta: () => ({ breadcrumb: [{ label: "Invoices" }] }),
}));
// DesktopShell reads the signed-in user from the auth context. Supplying it
// directly keeps this test to the nav surface instead of pulling in the whole
// provider. (Note: app-irrigation-manager-shell.test.tsx does NOT do this and
// is red on main for exactly that reason — see the task follow-ups.)
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: {
      id: 7,
      name: "Test Bookkeeper",
      email: "bk@example.com",
      role: session.role,
      companyId: 1,
    },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

import { DesktopShell } from "./desktop-shell";
import { bookkeeperNav, billingManagerNav, type NavConfig, type NavItem } from "./nav-config";

// jsdom has no matchMedia; DesktopShell's use-mobile hook calls it on mount.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, queryFn: async () => null },
    },
  });
}

function collectLeafPaths(items: NavItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.type === "leaf") paths.push(item.path);
    else paths.push(...collectLeafPaths(item.items));
  }
  return paths;
}

function allPaths(config: NavConfig): string[] {
  return collectLeafPaths(config.items);
}

const NAVIGATION_SRC = readFileSync(resolve(import.meta.dirname, "navigation.tsx"), "utf8");
const PROFILE_SRC = readFileSync(
  resolve(import.meta.dirname, "../../pages/customer-profile.tsx"),
  "utf8",
);
const INVOICES_SRC = readFileSync(
  resolve(import.meta.dirname, "../../pages/invoices.tsx"),
  "utf8",
);

// ── Surface 1: the desktop sidebar (nav-config.ts) ───────────────────────────

describe("bookkeeperNav — desktop sidebar", () => {
  it("is not empty (an unhandled role gets a blank app)", () => {
    expect(bookkeeperNav.items.length).toBeGreaterThan(0);
  });

  it("contains exactly Invoices, Customers, and QuickBooks", () => {
    expect(allPaths(bookkeeperNav).sort()).toEqual(["/customers", "/invoices", "/quickbooks"]);
  });

  it("omits everything the role is not scoped for", () => {
    const paths = allPaths(bookkeeperNav);
    for (const forbidden of [
      "/financial-pulse",
      "/manager-workspace",
      "/billing-sheets",
      "/wet-checks",
      "/work-orders",
      "/estimates-pending-approval",
      "/parts",
      "/labor-rates",
    ]) {
      expect(paths).not.toContain(forbidden);
    }
  });

  it("is NOT just a reference to billingManagerNav", () => {
    // Sharing the shell component is intended; sharing the nav config is the bug.
    expect(bookkeeperNav).not.toBe(billingManagerNav);
    expect(allPaths(bookkeeperNav).length).toBeLessThan(allPaths(billingManagerNav).length);
  });

  it("renders inside DesktopShell with its three entries visible", () => {
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <DesktopShell navConfig={bookkeeperNav}>
          <div>content</div>
        </DesktopShell>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("desktop-shell")).toBeTruthy();
    // getAllByText: the shell renders the sidebar in both a desktop and a
    // collapsed/mobile variant, so each label legitimately appears more than once.
    expect(screen.getAllByText("Invoices").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Customers").length).toBeGreaterThan(0);
    expect(screen.getAllByText("QuickBooks").length).toBeGreaterThan(0);
  });

  it("does not render out-of-scope entries in the shell", () => {
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <DesktopShell navConfig={bookkeeperNav}>
          <div>content</div>
        </DesktopShell>
      </QueryClientProvider>,
    );
    expect(screen.queryByText("Financial Pulse")).toBeNull();
    expect(screen.queryByText("Manager Workspace")).toBeNull();
    expect(screen.queryByText("Wet Checks")).toBeNull();
  });
});

// ── Surface 2: navigation.tsx role switch ────────────────────────────────────

describe("navigation.tsx — the other nav surface", () => {
  it("has an explicit bookkeeper case", () => {
    expect(NAVIGATION_SRC).toMatch(/case\s+"bookkeeper":/);
  });

  it("the bookkeeper case does not fall through to the empty-array default", () => {
    const start = NAVIGATION_SRC.indexOf('case "bookkeeper":');
    expect(start).toBeGreaterThan(-1);
    const body = NAVIGATION_SRC.slice(start, NAVIGATION_SRC.indexOf("default:", start));
    expect(body).toContain("return [");
    // The same three surfaces as the sidebar.
    expect(body).toContain('"/invoices"');
    expect(body).toContain('"/customers"');
    expect(body).toContain('"/quickbooks"');
  });
});

// ── Customer profile: Billing Details tab tracks its own contents ────────────

describe("customer-profile Billing Details tab visibility", () => {
  it("no longer forces the tab visible for every role", () => {
    expect(PROFILE_SRC).not.toContain("isBillingRole || true");
  });

  it("keys the tab on billing role OR invoice-read capability", () => {
    expect(PROFILE_SRC).toMatch(/billing:\s*isBillingRole\s*\|\|\s*canReadInvoices/);
    expect(PROFILE_SRC).toMatch(/canReadInvoices\s*=\s*hasCapability\(userRole,\s*CAN_READ_INVOICES\)/);
  });

  it("gates the Invoices section itself on the same capability", () => {
    expect(PROFILE_SRC).toContain("{canReadInvoices && (");
  });

  it("drops the stale comments that justified the old unconditional tab", () => {
    expect(PROFILE_SRC).not.toContain("Tab has content for ANY role");
    expect(PROFILE_SRC).not.toContain("always true; derived for auditability");
    expect(PROFILE_SRC).not.toContain(
      "InvoiceList — visible to all roles (same as original long-scroll page)",
    );
  });

  // The recurring defect in this area is a control whose capability gate is
  // looser than its endpoint's guard, so the role sees a button that 403s.
  // These assert the invariant rather than individual buttons.
  const guardBefore = (marker: string) => {
    const idx = INVOICES_SRC.indexOf(marker);
    expect(idx, `marker not found: ${marker}`).toBeGreaterThan(-1);
    const before = INVOICES_SRC.slice(0, idx);
    return before.slice(before.lastIndexOf("{can"));
  };

  it.each([
    ["button-sync-quickbooks-invoice", "canBillingEdit"],
    ["button-resync-quickbooks-invoice", "canBillingEdit"],
    ["button-void-invoice", "canBillingEdit"],
    ["button-finalize-invoice", "canBillingEdit"],
    ["button-return-to-draft-invoice", "canBillingEdit"],
    ["button-edit-invoice-metadata", "canBillingEdit"],
    ["button-manage-tickets-invoice", "canBillingEdit"],
    ["button-correct-invoice", "canCorrect"],
  ])("gates the %s control on %s", (marker, expected) => {
    expect(guardBefore(marker)).toContain(expected);
  });

  it("does not render or query Financial Pulse for a role denied it", () => {
    // Financial Pulse routes allow only super_admin, company_admin, and
    // billing_manager. Rendering the widget or firing its query for anyone
    // else produces a background 403 the user never sees but the server logs.
    expect(guardBefore('<FinancialPulseWidget variant="ar-aging" />')).toContain(
      "canViewCosts",
    );
    const summaryQuery = PROFILE_SRC.slice(
      PROFILE_SRC.indexOf("queryKey: [`/api/financial-pulse/customer/"),
    ).slice(0, 220);
    expect(summaryQuery).toMatch(/enabled:[^\n]*CAN_VIEW_COSTS/);

    // The capability the gates resolve through must match that allowlist.
    expect(hasCapability("bookkeeper", CAN_VIEW_COSTS)).toBe(false);
    expect(hasCapability("irrigation_manager", CAN_VIEW_COSTS)).toBe(false);
    expect(hasCapability("field_tech", CAN_VIEW_COSTS)).toBe(false);
    expect(hasCapability("billing_manager", CAN_VIEW_COSTS)).toBe(true);
    expect(hasCapability("company_admin", CAN_VIEW_COSTS)).toBe(true);
  });

  it("opens no invoice write dialog without the matching capability", () => {
    // Defence in depth: the triggers are gated, but the dialog itself must not
    // be openable by a role that cannot perform the write behind it.
    const writeDialogs = [
      "resyncInvoice != null",
      "draftEditorInvoice != null",
      "editMetadataInvoice != null",
      "voidConfirmInvoice != null",
      "correctionInvoice != null",
      "mergeConfirmOpen",
    ];
    for (const state of writeDialogs) {
      const open = INVOICES_SRC.match(
        new RegExp(`open=\\{[^}]*${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^}]*\\}`),
      );
      expect(open, `no open prop found for ${state}`).not.toBeNull();
      expect(open![0], `${state} dialog is not capability-gated`).toMatch(/can[A-Z]/);
    }
  });

  it("gates 'Mark unsent' on invoice write, not on the send capability", () => {
    // The endpoint is guarded by requireInvoiceWrite on the server. Gating the
    // menu item on the send capability would show a bookkeeper a control that
    // 403s, because she can mark an invoice sent but not reverse it.
    const unsent = INVOICES_SRC.slice(
      0,
      INVOICES_SRC.indexOf("button-mark-unsent-invoice"),
    );
    const guard = unsent.slice(unsent.lastIndexOf("{can"));
    expect(guard).toContain("canBillingEdit");
    expect(guard).not.toContain("canMarkSent");

    // The capability split that makes the distinction meaningful.
    expect(hasCapability("bookkeeper", CAN_SEND_INVOICE_EMAIL)).toBe(true);
    expect(hasCapability("bookkeeper", CAN_EDIT_INVOICES)).toBe(false);
    expect(hasCapability("billing_manager", CAN_EDIT_INVOICES)).toBe(true);
  });

  it("still gates 'Mark sent' on the send capability", () => {
    const sent = INVOICES_SRC.slice(
      0,
      INVOICES_SRC.indexOf("button-mark-sent-invoice"),
    );
    expect(sent.slice(sent.lastIndexOf("{can"))).toContain("canMarkSent");
  });

  it("does not offer a 'View Billing Details' button to a role without the tab", () => {
    // Both Financial Snapshot buttons call setTab("billing"); for a field tech
    // that tab no longer exists, so the control would navigate nowhere.
    const buttons = PROFILE_SRC.split('setTab("billing")').length - 1;
    const gated = PROFILE_SRC.split("{tabVisibility.billing && (").length - 1;
    expect(buttons).toBeGreaterThan(0);
    expect(gated).toBe(buttons);
  });

  it("resolves the role through the auth context, not a bespoke localStorage read", () => {
    expect(PROFILE_SRC).toContain("useAuth()");
    expect(PROFILE_SRC).not.toContain('safeGet("user")');
  });

  // The predicate the tab is keyed on, per role. This is the actual behaviour
  // contract: field_tech loses the tab entirely, irrigation_manager keeps it.
  it("field_tech has no invoice-read capability, so the tab disappears", () => {
    expect(hasCapability("field_tech", CAN_READ_INVOICES)).toBe(false);
  });

  it("irrigation_manager keeps invoice read, so the tab stays", () => {
    expect(hasCapability("irrigation_manager", CAN_READ_INVOICES)).toBe(true);
  });

  it("bookkeeper can read invoices", () => {
    expect(hasCapability("bookkeeper", CAN_READ_INVOICES)).toBe(true);
  });
});

// ── Task #1914: the overdue-invoice badge ────────────────────────────────────
//
// The badge does not decide what "overdue" means; it counts through the
// invoice list endpoint's overdue aging filter and renders the post-filter
// total the endpoint reports. So the fake endpoint below applies the SHARED
// definition (computeEffectiveDueDate + isInvoiceOverdue from
// lib/shared/src/invoice-aging.ts) to the fixtures, and every expectation is
// derived from that same helper rather than from a number typed in here. If
// the shell ever grew its own client-side notion of overdue, the count it
// rendered would stop agreeing with these fixtures.
//
// The endpoint's own agreement with the shared definition — that ?aging=
// overdue really selects the shared-overdue rows, and that X-Total-Count is
// the post-filter total — is proved against the real handler in
// artifacts/api-server/src/routes/invoice-list-routes.test.ts.

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

interface FixtureInvoice {
  id: number;
  dueDate: string;
  createdAt: string;
  paymentStatus: string;
}

function fixture(id: number, dueInDays: number, paymentStatus = "unpaid"): FixtureInvoice {
  return {
    id,
    dueDate: new Date(NOW.getTime() + dueInDays * DAY).toISOString(),
    createdAt: new Date(NOW.getTime() - 60 * DAY).toISOString(),
    paymentStatus,
  };
}

/** Six invoices: three genuinely overdue, one paid, two not yet due. */
const INVOICE_FIXTURES: FixtureInvoice[] = [
  fixture(1, -75),
  fixture(2, -40),
  fixture(3, -2),
  fixture(4, -90, "paid"),
  fixture(5, 3),
  fixture(6, 20),
];

function isOverduePerSharedModule(inv: FixtureInvoice): boolean {
  return isInvoiceOverdue(
    inv.paymentStatus,
    computeEffectiveDueDate(inv.dueDate, inv.createdAt, null),
    NOW,
  );
}

function sharedOverdueCount(rows: FixtureInvoice[]): number {
  return rows.filter(isOverduePerSharedModule).length;
}

let fetchCalls: string[] = [];

/**
 * Stands in for GET /api/invoices. Honours `?aging=overdue` using the shared
 * definition and reports the post-filter total in X-Total-Count, exactly as
 * the real handler does.
 */
function installFakeInvoiceApi(rows: FixtureInvoice[]) {
  const impl = vi.fn(async (input: unknown) => {
    const url = String(input);
    fetchCalls.push(url);
    const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const selected =
      params.get("aging") === OVERDUE_AGING_FILTER
        ? rows.filter(isOverduePerSharedModule)
        : rows;
    const limitRaw = params.get("limit");
    const limit = limitRaw ? Number(limitRaw) : selected.length;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "X-Total-Count": String(selected.length) }),
      json: async () => selected.slice(0, limit),
      text: async () => "",
    } as unknown as Response;
  });
  (globalThis as unknown as { fetch: unknown }).fetch = impl;
  return impl;
}

function renderShell() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <DesktopShell navConfig={bookkeeperNav}>
        <div>content</div>
      </DesktopShell>
    </QueryClientProvider>,
  );
}

function badgeTexts(): string[] {
  return Array.from(document.querySelectorAll('[data-sidebar="menu-badge"]')).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

describe("bookkeeper sidebar — overdue invoice badge (Task #1914)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    session.role = "bookkeeper";
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("asks the invoice list for the overdue slice, one row deep", async () => {
    installFakeInvoiceApi(INVOICE_FIXTURES);
    renderShell();
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.startsWith("/api/invoices"))).toBe(true);
    });
    const call = fetchCalls.find((u) => u.startsWith("/api/invoices"))!;
    const params = new URLSearchParams(call.slice(call.indexOf("?") + 1));
    expect(params.get("aging")).toBe(OVERDUE_AGING_FILTER);
    // A minimal page: the number comes from the header, not from counting rows.
    expect(params.get("limit")).toBe("1");
    expect(params.get("offset")).toBe("0");
  });

  it("renders the post-filter total, and it agrees with the shared overdue rule", async () => {
    const expected = sharedOverdueCount(INVOICE_FIXTURES);
    expect(expected).toBe(3); // sanity: the fixtures do exercise the rule
    expect(expected).toBeLessThan(INVOICE_FIXTURES.length); // …and it filters
    installFakeInvoiceApi(INVOICE_FIXTURES);
    renderShell();
    await waitFor(() => {
      expect(badgeTexts()).toContain(String(expected));
    });
    // Not the unfiltered list length, and not a paid-but-past-due row's worth.
    expect(badgeTexts()).not.toContain(String(INVOICE_FIXTURES.length));
  });

  it("renders no badge at all — not a 0 — when nothing is overdue", async () => {
    const allCurrent = [fixture(1, 5), fixture(2, 30), fixture(3, -1, "paid")];
    expect(sharedOverdueCount(allCurrent)).toBe(0);
    installFakeInvoiceApi(allCurrent);
    renderShell();
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.startsWith("/api/invoices"))).toBe(true);
    });
    await waitFor(() => {
      expect(badgeTexts()).toEqual([]);
    });
    expect(screen.queryByText("0")).toBeNull();
  });

  it("issues no overdue request at all for a role without invoice-read capability", async () => {
    expect(hasCapability("field_tech", CAN_READ_INVOICES)).toBe(false);
    session.role = "field_tech";
    installFakeInvoiceApi(INVOICE_FIXTURES);
    renderShell();
    // Give React Query every chance to fire it.
    await waitFor(() => {
      expect(screen.getByTestId("desktop-shell")).toBeTruthy();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchCalls.filter((u) => u.startsWith("/api/invoices"))).toEqual([]);
    expect(badgeTexts()).toEqual([]);
  });

  it("does not turn on the four approval badge queries for the bookkeeper", async () => {
    // The overdue gate is independent: enabling it must not start her polling
    // parts, manual part reviews, wet-check reviews, estimates or the
    // needs-approval count.
    installFakeInvoiceApi(INVOICE_FIXTURES);
    renderShell();
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.startsWith("/api/invoices"))).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 50));
    for (const endpoint of [
      "/api/parts/pending-approval",
      "/api/manual-part-reviews",
      "/api/wet-checks/pending-review",
      "/api/estimates/pending-approval",
      "/api/manager-workspace/needs-approval/count",
    ]) {
      expect(fetchCalls.some((u) => u.startsWith(endpoint)), endpoint).toBe(false);
    }
  });
});
