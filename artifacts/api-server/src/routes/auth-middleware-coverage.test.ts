// Task #922 — Regression tests to prevent auth middleware being skipped
// on protected routes.
//
// Background: Task #921 fixed 10 routes that were missing
// `requireAuthentication` as their first middleware. Without it, field
// techs were getting spurious 403s in production because bearer tokens
// were never validated — the role guard fired first with an undefined
// `req.authenticatedUserRole`, and guards like `requireWorkOrderBillingAccess`
// return 403 for any role that isn't in the allowed list (including
// undefined), not 401.
//
// The correct contract:
//   • No credentials  →  401  (requireAuthentication fires first)
//   • Wrong role       →  403  (role guard fires after authentication)
//
// This file has three sections:
//
//   1.  "Ten guarded routes" — a static-source check for each of the
//       10 specific routes that Task #921 patched.  For every route we
//       assert:
//         (a)  `requireAuthentication` is present in the middleware list.
//         (b)  Its position comes before the first role guard — the
//              ordering guarantee that makes (a) a 401 guarantee.
//
//   2.  "Broad coverage" — scans every app.patch / app.post / app.delete
//       call in routes.ts.  For each that contains any auth-dependent role
//       guard it asserts `requireAuthentication` appears and precedes it.
//       This catches the bug class prospectively whenever a new route is
//       added.
//
//   3.  "GET route coverage" — same broad scan for app.get calls.  GET
//       routes were excluded from Part 2 because they are more varied
//       (public catalogue endpoints, OAuth callbacks, health checks, etc.)
//       but GET routes that carry sensitive data behind a role guard need
//       the same 401-before-403 guarantee.
//
// Why static analysis?  `registerRoutes` is a 16 000-line monolith with
// startup-time setInterval timers, IIFE side-effects, and a PostgreSQL
// session store — none of which are friendly to in-process test mounting.
// Separate extracted-module tests (estimate-inline-lifecycle.test.ts,
// estimate-role-matrix.test.ts) cover the behavioral path for the modules
// that have been split out.  For the monolith we follow the same approach
// as audit-coverage.test.ts: fast source-text assertions that are
// deterministic, require no DB, and run in < 50 ms.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const src = readFileSync(join(__dirname, "routes.ts"), "utf8");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Given a route registration marker (e.g. `app.patch("/api/work-orders/:id"`),
 * returns the substring from the start of that call up to (but not including)
 * the `async ` keyword that begins the request handler.  Everything in between
 * is the route path string + middleware argument list.
 *
 * Returns null if the marker is not found, or the empty string if there is no
 * gap between the marker and the handler (i.e. the handler is the second arg).
 */
function extractMiddlewareSlice(marker: string): string | null {
  const pos = src.indexOf(marker);
  if (pos < 0) return null;
  // Scan forward up to 800 chars — enough to cover any realistic arg list.
  const window = src.slice(pos, pos + 800);
  const asyncIdx = window.indexOf(" async ");
  if (asyncIdx < 0) return window; // shouldn't happen for well-formed handlers
  return window.slice(0, asyncIdx);
}

// Auth-dependent role guards: these middlewares read `req.authenticatedUserRole`
// which is only set by `requireAuthentication`.  Without prior authentication,
// they produce inconsistent status codes (some 401, some 403) rather than the
// canonical 401.  `requireQuickBooksAccess` is intentionally excluded — it
// falls back to `headerUserRole(req)` and is deliberately usable without a
// preceding auth step (QuickBooks OAuth flows can be unauthenticated).
const ROLE_GUARDS = [
  "requireCompanyAdminAccess",
  "requireCustomerEditAccess",
  "requireBoundaryEditAccess",
  "requireWorkOrderBillingAccess",
  // Task #1886 — requireBillingAccess split into three capability-backed guards.
  "requireInvoiceRead",
  "requireInvoiceWrite",
  "requireInvoiceSend",
  "requireWorkOrderUpdateAccess",
  "requireBillingSheetUpdateAccess",
  "requireNotificationAccess",
  "requireSiteMapViewAccess",
] as const;

function firstIndexOf(text: string, ...needles: string[]): number {
  return Math.min(
    ...needles
      .map((n) => text.indexOf(n))
      .filter((i) => i >= 0),
    Infinity,
  );
}

// ─── Part 1: Ten specific routes from Task #921 ───────────────────────────────

describe("Task #922 — ten guarded routes have requireAuthentication before any role guard", () => {
  // Each tuple: [humanLabel, verb, routePath]
  const GUARDED_ROUTES: Array<[string, string, string]> = [
    ["PATCH /api/work-orders/:id", "patch", '"/api/work-orders/:id"'],
    ["DELETE /api/work-orders/bulk", "delete", '"/api/work-orders/bulk"'],
    ["DELETE /api/work-orders/:id", "delete", '"/api/work-orders/:id"'],
    ["PATCH /api/billing-sheets/:id", "patch", '"/api/billing-sheets/:id"'],
    ["DELETE /api/billing-sheets/bulk", "delete", '"/api/billing-sheets/bulk"'],
    ["DELETE /api/billing-sheets/:id", "delete", '"/api/billing-sheets/:id"'],
    ["POST /api/customers/import-csv", "post", '"/api/customers/import-csv"'],
    [
      "POST /api/company/:companyId/api-keys",
      "post",
      '"/api/company/:companyId/api-keys"',
    ],
    [
      "DELETE /api/company/:companyId/api-keys/:keyId",
      "delete",
      '"/api/company/:companyId/api-keys/:keyId"',
    ],
    [
      "POST /api/company/:companyId/users/:userId/resend-verification",
      "post",
      '"/api/company/:companyId/users/:userId/resend-verification"',
    ],
  ];

  for (const [label, verb, path] of GUARDED_ROUTES) {
    it(`${label} — requireAuthentication present and before every role guard`, () => {
      const marker = `app.${verb}(${path}`;
      const slice = extractMiddlewareSlice(marker);

      assert.ok(
        slice !== null,
        `Route registration not found: app.${verb}(${path} — was it removed or renamed?`,
      );

      // (a) requireAuthentication must be present.
      assert.ok(
        slice.includes("requireAuthentication"),
        `app.${verb}(${path}) is missing requireAuthentication middleware.\n` +
          `Without it unauthenticated requests receive 403 (from the role guard) ` +
          `instead of the correct 401.`,
      );

      const authIdx = slice.indexOf("requireAuthentication");

      // (b) requireAuthentication must appear before every role guard in the list.
      for (const guard of ROLE_GUARDS) {
        const guardIdx = slice.indexOf(guard);
        if (guardIdx < 0) continue; // this route doesn't use this guard

        assert.ok(
          authIdx < guardIdx,
          `app.${verb}(${path}): '${guard}' appears at position ${guardIdx} ` +
            `but requireAuthentication is at ${authIdx} — role guard must come AFTER authentication.\n` +
            `Relevant source slice:\n${slice}`,
        );
      }
    });
  }
});

// ─── Part 2: Broad coverage over all app.patch / app.post / app.delete ────────

describe("Task #922 — all app.patch/post/delete calls with role guards have requireAuthentication first (broad scan)", () => {
  it("every auth-dependent role guard is preceded by requireAuthentication", () => {
    // Find every `app.patch(`, `app.post(`, `app.delete(` position in the source.
    const METHOD_RE = /\bapp\.(patch|post|delete)\(/g;
    const violations: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = METHOD_RE.exec(src)) !== null) {
      const pos = match.index;
      const verb = match[1];

      // Extract from the call start up to the async handler (max 800 chars).
      const window = src.slice(pos, pos + 800);
      const asyncIdx = window.indexOf(" async ");
      const slice = asyncIdx >= 0 ? window.slice(0, asyncIdx) : window;

      // Find the first role guard present in this call's arg list.
      const firstGuardIdx = firstIndexOf(slice, ...ROLE_GUARDS);
      if (firstGuardIdx === Infinity) continue; // no role guard → nothing to check

      // Identify which guard(s) appear so we can produce a useful message.
      const presentGuards = ROLE_GUARDS.filter((g) => slice.indexOf(g) >= 0);

      // requireAuthentication must also be present and precede the first guard.
      const authIdx = slice.indexOf("requireAuthentication");

      if (authIdx < 0) {
        // Extract the route path for the error message.
        const pathMatch = slice.match(/"\/api\/[^"]+"/);
        const routePath = pathMatch ? pathMatch[0] : "(unknown path)";
        violations.push(
          `app.${verb}(${routePath}): has role guard(s) [${presentGuards.join(", ")}] ` +
            `but requireAuthentication is ABSENT — unauthenticated requests will get 403 not 401.`,
        );
      } else if (authIdx > firstGuardIdx) {
        const pathMatch = slice.match(/"\/api\/[^"]+"/);
        const routePath = pathMatch ? pathMatch[0] : "(unknown path)";
        violations.push(
          `app.${verb}(${routePath}): requireAuthentication (pos ${authIdx}) comes AFTER ` +
            `role guard(s) [${presentGuards.join(", ")}] (first guard at pos ${firstGuardIdx}) — ` +
            `must be reordered so authentication runs first.`,
        );
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found ${violations.length} route(s) where a role guard precedes or replaces requireAuthentication:\n\n` +
        violations.map((v) => `  • ${v}`).join("\n") +
        "\n\nFix: add requireAuthentication as the first middleware argument (before the role guard).",
    );
  });
});

// ─── Part 3: Broad coverage over all app.get ──────────────────────────────────

describe("Task #927 — all app.get calls with role guards have requireAuthentication first (broad scan)", () => {
  it("every auth-dependent role guard on a GET route is preceded by requireAuthentication", () => {
    // Find every `app.get(` position in the source.
    const METHOD_RE = /\bapp\.get\(/g;
    const violations: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = METHOD_RE.exec(src)) !== null) {
      const pos = match.index;

      // Extract from the call start up to the async handler (max 800 chars).
      const window = src.slice(pos, pos + 800);
      const asyncIdx = window.indexOf(" async ");
      const slice = asyncIdx >= 0 ? window.slice(0, asyncIdx) : window;

      // Find the first role guard present in this call's arg list.
      const firstGuardIdx = firstIndexOf(slice, ...ROLE_GUARDS);
      if (firstGuardIdx === Infinity) continue; // no role guard → nothing to check

      // Identify which guard(s) appear so we can produce a useful message.
      const presentGuards = ROLE_GUARDS.filter((g) => slice.indexOf(g) >= 0);

      // requireAuthentication must also be present and precede the first guard.
      const authIdx = slice.indexOf("requireAuthentication");

      if (authIdx < 0) {
        const pathMatch = slice.match(/"\/api\/[^"]+"/);
        const routePath = pathMatch ? pathMatch[0] : "(unknown path)";
        violations.push(
          `app.get(${routePath}): has role guard(s) [${presentGuards.join(", ")}] ` +
            `but requireAuthentication is ABSENT — unauthenticated requests will get 403 not 401.`,
        );
      } else if (authIdx > firstGuardIdx) {
        const pathMatch = slice.match(/"\/api\/[^"]+"/);
        const routePath = pathMatch ? pathMatch[0] : "(unknown path)";
        violations.push(
          `app.get(${routePath}): requireAuthentication (pos ${authIdx}) comes AFTER ` +
            `role guard(s) [${presentGuards.join(", ")}] (first guard at pos ${firstGuardIdx}) — ` +
            `must be reordered so authentication runs first.`,
        );
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found ${violations.length} GET route(s) where a role guard precedes or replaces requireAuthentication:\n\n` +
        violations.map((v) => `  • ${v}`).join("\n") +
        "\n\nFix: add requireAuthentication as the first middleware argument (before the role guard).",
    );
  });
});

// ─── Part 4: Specific GET routes from Task #927 ───────────────────────────────

// ─── Part 5: Single-ID work-order route tenant guard (Task #932) ──────────────

// The five explicit out-of-scope exceptions that do NOT carry :id and are
// therefore excluded from the single-ID pattern scan.
const WORK_ORDER_TENANT_GUARD_EXCEPTIONS = new Set([
  "/api/work-orders/complete",    // POST — legacy "complete by number", no :id
  "/api/work-orders",             // POST create + GET list, no :id
  "/api/work-orders/bulk",        // DELETE bulk, no :id
  "/api/work-orders/missing-photos", // GET collection, no :id
  // All /api/external/work-orders/* are handled separately and excluded.
]);

describe("Task #932 — all single-ID /api/work-orders/:id... routes carry both requireAuthentication and requireSameCompanyAsWorkOrder", () => {
  it("every work-order route with a bare :param segment has both guards", () => {
    const METHOD_RE = /\bapp\.(get|post|patch|delete)\(/g;
    const violations: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = METHOD_RE.exec(src)) !== null) {
      const pos = match.index;
      const verb = match[1];

      // Extract from the call start up to the async handler.
      // Use 1200 chars to capture multi-line registrations like photo-late-additions.
      const chunk = src.slice(pos, pos + 1200);
      const asyncIdx = chunk.indexOf(" async ");
      const slice = asyncIdx >= 0 ? chunk.slice(0, asyncIdx) : chunk;

      // Only care about routes that contain a single-ID work-order path pattern
      // (the colon after /work-orders/ distinguishes /:id from fixed segments).
      if (!slice.includes('"/api/work-orders/:')) continue;

      // Extract the canonical route path for error messages.
      const routePathMatch = slice.match(/"(\/api\/work-orders\/[^"]+)"/);
      const routePath = routePathMatch ? routePathMatch[1] : "(unknown path)";

      // Skip the explicitly out-of-scope exceptions.
      if (WORK_ORDER_TENANT_GUARD_EXCEPTIONS.has(routePath)) continue;

      if (!slice.includes("requireAuthentication")) {
        violations.push(
          `app.${verb}("${routePath}"): missing requireAuthentication`,
        );
        continue;
      }

      if (!slice.includes("requireSameCompanyAsWorkOrder")) {
        violations.push(
          `app.${verb}("${routePath}"): missing requireSameCompanyAsWorkOrder`,
        );
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found single-ID work-order routes missing required tenant guards:\n\n` +
        violations.map((v) => `  • ${v}`).join("\n") +
        "\n\nFix: add [requireAuthentication, requireSameCompanyAsWorkOrder] to the route.",
    );
  });

  it("requireSameCompanyAsWorkOrder appears AFTER requireAuthentication and BEFORE any role guard on all matched routes", () => {
    const METHOD_RE = /\bapp\.(get|post|patch|delete)\(/g;
    const violations: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = METHOD_RE.exec(src)) !== null) {
      const pos = match.index;
      const verb = match[1];

      const chunk = src.slice(pos, pos + 1200);
      const asyncIdx = chunk.indexOf(" async ");
      const slice = asyncIdx >= 0 ? chunk.slice(0, asyncIdx) : chunk;

      if (!slice.includes('"/api/work-orders/:')) continue;
      if (!slice.includes("requireSameCompanyAsWorkOrder")) continue;

      const routePathMatch = slice.match(/"(\/api\/work-orders\/[^"]+)"/);
      const routePath = routePathMatch ? routePathMatch[1] : "(unknown path)";
      if (WORK_ORDER_TENANT_GUARD_EXCEPTIONS.has(routePath)) continue;

      const authIdx = slice.indexOf("requireAuthentication");
      const tenantIdx = slice.indexOf("requireSameCompanyAsWorkOrder");

      // Guard must come after authentication.
      if (authIdx < 0 || tenantIdx <= authIdx) {
        violations.push(
          `app.${verb}("${routePath}"): requireSameCompanyAsWorkOrder (pos ${tenantIdx}) ` +
            `is not after requireAuthentication (pos ${authIdx})`,
        );
        continue;
      }

      // Guard must come before any role-level guard.
      const firstRoleGuardIdx = firstIndexOf(slice, ...ROLE_GUARDS);
      if (firstRoleGuardIdx !== Infinity && tenantIdx > firstRoleGuardIdx) {
        const presentGuards = ROLE_GUARDS.filter((g) => slice.indexOf(g) >= 0);
        violations.push(
          `app.${verb}("${routePath}"): requireSameCompanyAsWorkOrder (pos ${tenantIdx}) ` +
            `appears AFTER role guard(s) [${presentGuards.join(", ")}] (first at pos ${firstRoleGuardIdx})`,
        );
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found work-order routes with incorrect tenant guard ordering:\n\n` +
        violations.map((v) => `  • ${v}`).join("\n") +
        "\n\nExpected chain: [requireAuthentication, requireSameCompanyAsWorkOrder, ...role_guard..., handler]",
    );
  });
});

// ─── Part 4 (continued): Specific GET routes from Task #927 ──────────────────

describe("Task #927 — three GET routes that were missing requireAuthentication now have it before their role guard", () => {
  const NEWLY_GUARDED: Array<[string, string]> = [
    ["GET /api/notifications/:userId", '"/api/notifications/:userId"'],
    [
      "GET /api/notifications/:userId/count",
      '"/api/notifications/:userId/count"',
    ],
    [
      "GET /api/company/:companyId/api-keys",
      '"/api/company/:companyId/api-keys"',
    ],
  ];

  for (const [label, path] of NEWLY_GUARDED) {
    it(`${label} — requireAuthentication present and before every role guard`, () => {
      const marker = `app.get(${path}`;
      const slice = extractMiddlewareSlice(marker);

      assert.ok(
        slice !== null,
        `Route registration not found: app.get(${path} — was it removed or renamed?`,
      );

      assert.ok(
        slice.includes("requireAuthentication"),
        `app.get(${path}) is missing requireAuthentication middleware.\n` +
          `Without it unauthenticated requests receive 403 (from the role guard) ` +
          `instead of the correct 401.`,
      );

      const authIdx = slice.indexOf("requireAuthentication");

      for (const guard of ROLE_GUARDS) {
        const guardIdx = slice.indexOf(guard);
        if (guardIdx < 0) continue;

        assert.ok(
          authIdx < guardIdx,
          `app.get(${path}): '${guard}' appears at position ${guardIdx} ` +
            `but requireAuthentication is at ${authIdx} — role guard must come AFTER authentication.\n` +
            `Relevant source slice:\n${slice}`,
        );
      }
    });
  }
});

// ─── Part 6: Single-ID billing-sheet route tenant guard (Task #935) ──────────

// Explicit routes that carry "/api/billing-sheets/:" but are intentionally
// excluded from the tenant-guard requirement:
//   - none: every single-ID billing-sheet route was wrapped in Slice 2.
//
// The collection list routes (/bulk, /missing-photos, /missing-photos/notify,
// POST /api/billing-sheets create) don't contain a colon after
// /api/billing-sheets/ and are not matched by the scan pattern below.
// Admin audit routes live under /api/admin/billing-sheets/ and are also out
// of pattern range. No exceptions are needed.
const BILLING_SHEET_TENANT_GUARD_EXCEPTIONS = new Set<string>([
  // (empty — all single-ID billing-sheet routes carry both guards after Slice 2)
]);

describe("Task #935 — all single-ID /api/billing-sheets/:id... routes carry both requireAuthentication and requireSameCompanyAsBillingSheet", () => {
  it("every billing-sheet route with a bare :param segment has both guards", () => {
    const METHOD_RE = /\bapp\.(get|post|patch|delete)\(/g;
    const violations: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = METHOD_RE.exec(src)) !== null) {
      const pos = match.index;
      const verb = match[1];

      // Extract from the call start up to the async handler.
      // 1200 chars covers multi-line registrations like photo-late-additions.
      const chunk = src.slice(pos, pos + 1200);
      const asyncIdx = chunk.indexOf(" async ");
      const slice = asyncIdx >= 0 ? chunk.slice(0, asyncIdx) : chunk;

      // Only care about routes that contain a single-ID billing-sheet path
      // (the colon after /billing-sheets/ distinguishes /:id from fixed segments).
      if (!slice.includes('"/api/billing-sheets/:')) continue;

      // Extract the canonical route path for error messages.
      const routePathMatch = slice.match(/"(\/api\/billing-sheets\/[^"]+)"/);
      const routePath = routePathMatch ? routePathMatch[1] : "(unknown path)";

      // Skip the explicitly out-of-scope exceptions.
      if (BILLING_SHEET_TENANT_GUARD_EXCEPTIONS.has(routePath)) continue;

      if (!slice.includes("requireAuthentication")) {
        violations.push(
          `app.${verb}("${routePath}"): missing requireAuthentication`,
        );
        continue;
      }

      if (!slice.includes("requireSameCompanyAsBillingSheet")) {
        violations.push(
          `app.${verb}("${routePath}"): missing requireSameCompanyAsBillingSheet`,
        );
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found single-ID billing-sheet routes missing required tenant guards:\n\n` +
        violations.map((v) => `  • ${v}`).join("\n") +
        "\n\nFix: add [requireAuthentication, requireSameCompanyAsBillingSheet] to the route.",
    );
  });

  it("requireSameCompanyAsBillingSheet appears AFTER requireAuthentication and BEFORE any role guard on all matched routes", () => {
    const METHOD_RE = /\bapp\.(get|post|patch|delete)\(/g;
    const violations: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = METHOD_RE.exec(src)) !== null) {
      const pos = match.index;
      const verb = match[1];

      const chunk = src.slice(pos, pos + 1200);
      const asyncIdx = chunk.indexOf(" async ");
      const slice = asyncIdx >= 0 ? chunk.slice(0, asyncIdx) : chunk;

      if (!slice.includes('"/api/billing-sheets/:')) continue;
      if (!slice.includes("requireSameCompanyAsBillingSheet")) continue;

      const routePathMatch = slice.match(/"(\/api\/billing-sheets\/[^"]+)"/);
      const routePath = routePathMatch ? routePathMatch[1] : "(unknown path)";
      if (BILLING_SHEET_TENANT_GUARD_EXCEPTIONS.has(routePath)) continue;

      const authIdx = slice.indexOf("requireAuthentication");
      const tenantIdx = slice.indexOf("requireSameCompanyAsBillingSheet");

      // Guard must come after authentication.
      if (authIdx < 0 || tenantIdx <= authIdx) {
        violations.push(
          `app.${verb}("${routePath}"): requireSameCompanyAsBillingSheet (pos ${tenantIdx}) ` +
            `is not after requireAuthentication (pos ${authIdx})`,
        );
        continue;
      }

      // Guard must come before any role-level guard.
      const firstRoleGuardIdx = firstIndexOf(slice, ...ROLE_GUARDS);
      if (firstRoleGuardIdx !== Infinity && tenantIdx > firstRoleGuardIdx) {
        const presentGuards = ROLE_GUARDS.filter((g) => slice.indexOf(g) >= 0);
        violations.push(
          `app.${verb}("${routePath}"): requireSameCompanyAsBillingSheet (pos ${tenantIdx}) ` +
            `appears AFTER role guard(s) [${presentGuards.join(", ")}] (first at pos ${firstRoleGuardIdx})`,
        );
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found billing-sheet routes with incorrect tenant guard ordering:\n\n` +
        violations.map((v) => `  • ${v}`).join("\n") +
        "\n\nExpected chain: [requireAuthentication, requireSameCompanyAsBillingSheet, ...role_guard..., handler]",
    );
  });
});

// ─── Part 7: Slice 4a — admin migrations routes all carry requireAuthentication + requireSuperAdmin ──

describe("Slice 4a — admin-migrations-routes.ts: all routes carry requireAuthentication + requireSuperAdmin", () => {
  const migrationsRouteSrc = readFileSync(
    join(__dirname, "admin-migrations-routes.ts"),
    "utf8",
  );

  it("requireSuperAdmin helper is defined and checks super_admin role", () => {
    assert.ok(
      migrationsRouteSrc.includes("requireSuperAdmin"),
      "requireSuperAdmin not found in admin-migrations-routes.ts",
    );
    assert.ok(
      migrationsRouteSrc.includes("super_admin"),
      "super_admin role check not found",
    );
    assert.ok(
      migrationsRouteSrc.includes("403"),
      "403 response not found",
    );
  });

  it("every app.get / app.post in admin-migrations-routes.ts calls requireSuperAdmin", () => {
    const routeRe = /app\.(get|post)\(['"]/g;
    let match: RegExpExecArray | null;
    const missing: string[] = [];
    while ((match = routeRe.exec(migrationsRouteSrc)) !== null) {
      const pos = match.index;
      const chunk = migrationsRouteSrc.slice(pos, pos + 600);
      if (!chunk.includes("requireSuperAdmin")) {
        const pathMatch = chunk.match(/['"]([^'"]+)['"]/);
        missing.push(pathMatch?.[1] ?? "(unknown)");
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Routes missing requireSuperAdmin: ${missing.join(", ")}`,
    );
  });

  it("every app.get / app.post in admin-migrations-routes.ts is passed requireAuthentication", () => {
    const routeRe = /app\.(get|post)\(['"]/g;
    let match: RegExpExecArray | null;
    const missing: string[] = [];
    while ((match = routeRe.exec(migrationsRouteSrc)) !== null) {
      const pos = match.index;
      // Check far enough to capture the middleware list (before the async handler)
      const chunk = migrationsRouteSrc.slice(pos, pos + 300);
      if (!chunk.includes("requireAuthentication")) {
        const pathMatch = chunk.match(/['"]([^'"]+)['"]/);
        missing.push(pathMatch?.[1] ?? "(unknown)");
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Routes missing requireAuthentication: ${missing.join(", ")}`,
    );
  });

  it("registerAdminMigrationsRoutes is imported and called in routes.ts", () => {
    assert.ok(
      src.includes("registerAdminMigrationsRoutes"),
      "registerAdminMigrationsRoutes not found in routes.ts",
    );
  });
});

// ─── Part 8: customer-routes.ts mutation routes (Task #1205) ─────────────────
//
// POST /api/customers, PUT /api/customers/:id, and PATCH /api/customers/:id
// live in a separate extracted module (customer-routes.ts) and are therefore
// not covered by the broad routes.ts scans above.  This section asserts the
// same 401-before-403 contract for those three routes.

describe("Task #1205 — customer mutation routes in customer-routes.ts have requireAuthentication before role guard", () => {
  const customerRouteSrc = readFileSync(
    join(__dirname, "customer-routes.ts"),
    "utf8",
  );

  const CUSTOMER_MUTATION_ROUTES: Array<[string, string, string]> = [
    ["POST /api/customers", "post", '"/api/customers"'],
    ["PUT /api/customers/:id", "put", '"/api/customers/:id"'],
    ["PATCH /api/customers/:id", "patch", '"/api/customers/:id"'],
  ];

  for (const [label, verb, path] of CUSTOMER_MUTATION_ROUTES) {
    it(`${label} — requireAuthentication present and before every role guard`, () => {
      const marker = `app.${verb}(${path}`;
      const pos = customerRouteSrc.indexOf(marker);

      assert.ok(
        pos >= 0,
        `Route registration not found: app.${verb}(${path} in customer-routes.ts — was it removed or renamed?`,
      );

      const chunk = customerRouteSrc.slice(pos, pos + 800);
      const asyncIdx = chunk.indexOf(" async ");
      const slice = asyncIdx >= 0 ? chunk.slice(0, asyncIdx) : chunk;

      assert.ok(
        slice.includes("requireAuthentication"),
        `app.${verb}(${path}) in customer-routes.ts is missing requireAuthentication middleware.\n` +
          `Without it unauthenticated requests receive 403 (from the role guard) ` +
          `instead of the correct 401.`,
      );

      const authIdx = slice.indexOf("requireAuthentication");

      for (const guard of ROLE_GUARDS) {
        const guardIdx = slice.indexOf(guard);
        if (guardIdx < 0) continue;

        assert.ok(
          authIdx < guardIdx,
          `app.${verb}(${path}) in customer-routes.ts: '${guard}' appears at position ${guardIdx} ` +
            `but requireAuthentication is at ${authIdx} — role guard must come AFTER authentication.\n` +
            `Relevant source slice:\n${slice}`,
        );
      }
    });
  }
});

// ─── Part 5: Task #931 — pin-patch precise message appears exactly once ───────

describe("Task #931 — pin-patch precise 403 message appears exactly once in routes.ts", () => {
  it('exact string "You can only update the pin on a work order assigned to you." appears exactly once', () => {
    const needle = "You can only update the pin on a work order assigned to you.";
    let count = 0;
    let pos = 0;
    while ((pos = src.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }
    assert.equal(
      count,
      1,
      `Expected the precise pin-patch 403 message to appear exactly once in routes.ts ` +
        `(found ${count} occurrences). ` +
        `If count is 0, the message was removed or renamed — update the field-tech pin branch. ` +
        `If count is >1, it has leaked into the catch-all or a duplicate branch — consolidate.`,
    );
  });
});
