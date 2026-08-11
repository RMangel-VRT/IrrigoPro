/**
 * nav-config.test.ts (Task #803 — Slice 7, extended in Task #1004 — Slice 5,
 * updated in Task #1321 — removed stale Wet Check Reviews / Billings entries)
 *
 * Asserts that the Wet Check group is present in billingManagerNav,
 * companyAdminNav, superAdminNav, and managerNav, and that wet-check leaf
 * paths have been removed from the Operations group in each config.
 *
 * Also asserts managerNav omits admin-only paths.
 */

import { describe, it, expect } from "vitest";
import { hasCapability, CAN_READ_INVOICES } from "@workspace/shared";
import {
  billingManagerNav,
  bookkeeperNav,
  companyAdminNav,
  superAdminNav,
  managerNav,
  type NavConfig,
  type NavGroup,
  type NavLeaf,
  type NavItem,
} from "./nav-config";

const WET_CHECK_PATHS = ["/wet-checks"];

function findGroup(config: NavConfig, label: string): NavGroup | undefined {
  return config.items.find(
    (item): item is NavGroup => item.type === "group" && item.label === label,
  );
}

function leafPaths(group: NavGroup): string[] {
  return group.items
    .filter((item): item is NavLeaf => item.type === "leaf")
    .map((item) => item.path);
}

function collectAllLeafPaths(items: NavItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.type === "leaf") {
      paths.push(item.path);
    } else {
      paths.push(...collectAllLeafPaths(item.items));
    }
  }
  return paths;
}

describe("nav-config Wet Check group (Task #803)", () => {
  for (const [name, config] of [
    ["billingManagerNav", billingManagerNav],
    ["companyAdminNav", companyAdminNav],
    ["superAdminNav", superAdminNav],
    ["managerNav", managerNav],
  ] as const) {
    describe(name, () => {
      it("has a top-level Wet Check group", () => {
        const group = findGroup(config, "Wet Check");
        expect(group).toBeDefined();
        expect(group!.type).toBe("group");
      });

      it("Wet Check group has exactly one leaf", () => {
        const group = findGroup(config, "Wet Check")!;
        const leaves = leafPaths(group);
        expect(leaves).toHaveLength(1);
      });

      it("Wet Check group contains /wet-checks only", () => {
        const group = findGroup(config, "Wet Check")!;
        const leaves = leafPaths(group);
        expect(leaves).toContain("/wet-checks");
        expect(leaves).not.toContain("/wet-checks/pending-review");
        expect(leaves).not.toContain("/wet-check-billings");
      });

      it("Operations group does not contain wet-check leaf paths", () => {
        const opsGroup = findGroup(config, "Operations");
        if (!opsGroup) return;
        const ops = leafPaths(opsGroup);
        for (const path of WET_CHECK_PATHS) {
          expect(ops).not.toContain(path);
        }
      });
    });
  }
});

describe("managerNav — omits admin-only paths (Task #1004)", () => {
  it("does not contain /admin/quickbooks", () => {
    const all = collectAllLeafPaths(managerNav.items);
    expect(all).not.toContain("/admin/quickbooks");
  });

  it("does not contain /admin/migrate-wet-check", () => {
    const all = collectAllLeafPaths(managerNav.items);
    expect(all).not.toContain("/admin/migrate-wet-check");
  });

  it("includes /wet-checks in wetCheckGroup", () => {
    const all = collectAllLeafPaths(managerNav.items);
    expect(all).toContain("/wet-checks");
  });

  it("does not include stale /wet-checks/pending-review or /wet-check-billings", () => {
    const all = collectAllLeafPaths(managerNav.items);
    expect(all).not.toContain("/wet-checks/pending-review");
    expect(all).not.toContain("/wet-check-billings");
  });

  it("includes Operations group with work orders and billing sheets", () => {
    const all = collectAllLeafPaths(managerNav.items);
    expect(all).toContain("/work-orders");
    expect(all).toContain("/billing-sheets");
  });

  it("includes Parts group", () => {
    const all = collectAllLeafPaths(managerNav.items);
    expect(all).toContain("/parts");
  });
});

// ── Task #1914 — bookkeeper grouping and the overdue-invoice badge ───────────
//
// The bookkeeper's sidebar was three bare leaves while every other role got
// grouped sections. The restructure is presentation only: the assertions below
// pair "she now has groups" with "she reaches exactly the same three routes",
// because the failure mode worth guarding against is a grouping commit that
// quietly opens or closes a page.

/** A compact, whole-config structural signature. Ordering is significant. */
function shape(items: NavItem[], depth = 0): string[] {
  const out: string[] = [];
  for (const item of items) {
    const pad = "  ".repeat(depth);
    if (item.type === "leaf") {
      out.push(`${pad}leaf ${item.path}${item.badgeKey ? ` [${item.badgeKey}]` : ""}`);
    } else {
      out.push(`${pad}group ${item.label}${item.defaultOpen ? " (open)" : ""}`);
      out.push(...shape(item.items, depth + 1));
    }
  }
  return out;
}

describe("bookkeeperNav — grouped sidebar (Task #1914)", () => {
  it("is grouped rather than a flat list of leaves", () => {
    expect(bookkeeperNav.items.some((i) => i.type === "group")).toBe(true);
    expect(bookkeeperNav.items.every((i) => i.type === "leaf")).toBe(false);
  });

  it("opens on an Invoices group holding the invoice list", () => {
    const group = findGroup(bookkeeperNav, "Invoices");
    expect(group).toBeDefined();
    expect(group!.defaultOpen).toBe(true);
    expect(leafPaths(group!)).toEqual(["/invoices"]);
  });

  it("keeps QuickBooks inside a Settings group, as the billing manager does", () => {
    const settings = findGroup(bookkeeperNav, "Settings");
    expect(settings).toBeDefined();
    expect(leafPaths(settings!)).toEqual(["/quickbooks"]);
    expect(leafPaths(findGroup(billingManagerNav, "Settings")!)).toContain("/quickbooks");
  });

  it("keeps Customers as a top-level entry", () => {
    const customers = bookkeeperNav.items.find(
      (i): i is NavLeaf => i.type === "leaf" && i.path === "/customers",
    );
    expect(customers).toBeDefined();
  });

  it("uses the same icon treatment as the other configs — every group and leaf has one", () => {
    const walk = (items: NavItem[]) => {
      for (const item of items) {
        expect(item.icon, `${item.label} has no icon`).toBeDefined();
        if (item.type === "group") walk(item.items);
      }
    };
    walk(bookkeeperNav.items);
  });

  it("reaches exactly the routes it reached before the restructure", () => {
    // Task #1886's route set, unchanged. Grouping is presentation, not access.
    expect(collectAllLeafPaths(bookkeeperNav.items).sort()).toEqual([
      "/customers",
      "/invoices",
      "/quickbooks",
    ]);
  });

  it("still opens nothing the role is not scoped for", () => {
    const paths = collectAllLeafPaths(bookkeeperNav.items);
    for (const forbidden of [
      "/",
      "/financial-pulse",
      "/manager-workspace",
      "/billing-sheets",
      "/billing/command-center",
      "/wet-checks",
      "/work-orders",
      "/estimates/pending-approval",
      "/parts",
      "/labor-rates",
      "/admin/issue-types",
    ]) {
      expect(paths).not.toContain(forbidden);
    }
  });

  it("has the structure the shell renders, exactly", () => {
    expect(shape(bookkeeperNav.items)).toEqual([
      "group Invoices (open)",
      "  leaf /invoices [overdueInvoices]",
      "leaf /customers",
      "group Settings",
      "  leaf /quickbooks",
    ]);
  });
});

describe("overdue-invoice badge placement (Task #1914)", () => {
  const invoiceLeaves = (config: NavConfig): NavLeaf[] => {
    const out: NavLeaf[] = [];
    const walk = (items: NavItem[]) => {
      for (const item of items) {
        if (item.type === "leaf") {
          if (item.path === "/invoices") out.push(item);
        } else walk(item.items);
      }
    };
    walk(config.items);
    return out;
  };

  it("is on the bookkeeper's Invoices leaf", () => {
    expect(invoiceLeaves(bookkeeperNav).map((l) => l.badgeKey)).toEqual([
      "overdueInvoices",
    ]);
  });

  // Step 4 decision: yes. Both roles hold CAN_READ_INVOICES, so the query the
  // badge rides on is already permitted for them and nothing in the code
  // argues against it.
  it("is on the billing manager's and company admin's Invoices leaves too", () => {
    expect(invoiceLeaves(billingManagerNav).map((l) => l.badgeKey)).toEqual([
      "overdueInvoices",
    ]);
    expect(invoiceLeaves(companyAdminNav).map((l) => l.badgeKey)).toEqual([
      "overdueInvoices",
    ]);
    expect(hasCapability("billing_manager", CAN_READ_INVOICES)).toBe(true);
    expect(hasCapability("company_admin", CAN_READ_INVOICES)).toBe(true);
    expect(hasCapability("bookkeeper", CAN_READ_INVOICES)).toBe(true);
  });

  it("never rides on a nav whose role cannot read invoices", () => {
    // Every nav config, paired with the role that is handed it in App.tsx /
    // company-admin-app.tsx. A future config for a role outside
    // CAN_READ_INVOICES must not carry this badge key.
    for (const [role, config] of [
      ["bookkeeper", bookkeeperNav],
      ["billing_manager", billingManagerNav],
      ["company_admin", companyAdminNav],
      ["irrigation_manager", managerNav],
      ["super_admin", superAdminNav],
    ] as const) {
      const carries = shape(config.items).some((line) =>
        line.includes("[overdueInvoices]"),
      );
      if (carries) {
        expect(hasCapability(role, CAN_READ_INVOICES), `${role} cannot read invoices`).toBe(
          true,
        );
      }
    }
  });
});

describe("no other role's nav structure moved (Task #1914)", () => {
  // Frozen signatures. The only intended change in this task outside
  // bookkeeperNav is the `[overdueInvoices]` marker on the two Invoices
  // leaves; anything else that shows up here is an accident.
  it("billingManagerNav", () => {
    expect(shape(billingManagerNav.items)).toEqual([
      "leaf /",
      "group Billing (open)",
      "  leaf /manager-workspace [awaitingApproval]",
      "  leaf /financial-pulse",
      "  leaf /billing/command-center",
      "  leaf /billing-sheets",
      "  leaf /invoices [overdueInvoices]",
      "  group Reports",
      "    leaf /work-orders/missing-photos",
      "    leaf /billing-sheets/missing-photos",
      "    leaf /billing-sheets/zero-price-audit",
      "    leaf /billing-sheets/labor-rate-audit",
      "group Operations",
      "  leaf /work-orders",
      "  leaf /estimates/pending-approval [estimatesPendingApproval]",
      "group Wet Check",
      "  leaf /wet-checks",
      "leaf /customers",
      "group Parts",
      "  leaf /parts",
      "  leaf /parts-pending-approval [partsPendingApproval]",
      "  leaf /parts-settings",
      "group Settings",
      "  leaf /quickbooks",
      "  leaf /admin/issue-types",
    ]);
  });

  it("companyAdminNav", () => {
    expect(shape(companyAdminNav.items)).toEqual([
      "leaf /",
      "group Operations (open)",
      "  leaf /work-orders",
      "  leaf /billing-sheets",
      "  leaf /estimates/command-center [estimatesPendingApproval]",
      "group Wet Check",
      "  leaf /wet-checks",
      "group Customers",
      "  leaf /customers",
      "  leaf /admin/customers",
      "  leaf /site-maps",
      "group Billing",
      "  leaf /manager-workspace [awaitingApproval]",
      "  leaf /financial-pulse",
      "  leaf /billing/command-center",
      "  leaf /invoices [overdueInvoices]",
      "  group Reports",
      "    leaf /work-orders/missing-photos",
      "    leaf /billing-sheets/missing-photos",
      "    leaf /billing-sheets/zero-price-audit",
      "    leaf /billing-sheets/labor-rate-audit",
      "    leaf /admin/wet-check-reconciliation",
      "group Parts",
      "  leaf /parts",
      "  leaf /parts-pending-approval [partsPendingApproval]",
      "  leaf /parts-settings",
      "group Settings",
      "  leaf /admin/controllers",
      "  leaf /users",
      "  leaf /company-profile",
      "  leaf /quickbooks",
      "  leaf /labor-rates",
      "  leaf /admin/issue-types",
    ]);
  });

  it("superAdminNav", () => {
    expect(shape(superAdminNav.items)).toEqual([
      "leaf /super-admin/app-health",
      "leaf /super-admin",
      "group Users (open)",
      "  leaf /system-users",
      "  leaf /user-manager",
      "  leaf /switch-user",
      "group Wet Check",
      "  leaf /wet-checks",
      "group System",
      "  leaf /admin/controllers",
      "  leaf /financial-pulse",
      "  leaf /admin/client-errors",
      "  leaf /quickbooks",
      "group Data migrations",
      "  leaf /admin/migrations",
      "  leaf /admin/wc-labor-backfill",
      "  leaf /admin/issue-types",
    ]);
  });

  it("managerNav", () => {
    expect(shape(managerNav.items)).toEqual([
      "leaf /manager-workspace",
      "group Wet Check",
      "  leaf /wet-checks",
      "group Operations (open)",
      "  leaf /work-orders",
      "  leaf /billing-sheets",
      "  leaf /estimates",
      "  leaf /customers",
      "  leaf /site-maps",
      "  leaf /financial-pulse",
      "group Parts",
      "  leaf /parts",
      "  leaf /parts-settings",
    ]);
  });
});
