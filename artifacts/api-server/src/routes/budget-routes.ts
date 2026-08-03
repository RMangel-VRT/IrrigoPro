// Task #687 — Financial Pulse Slice 1.
// Task #1865 — Seasonal Budget Model: cap resolution now uses
// customerBudgetMonths for monthly allocations (retired flat cap columns
// are preserved in schema.ts for a future cleanup migration).
//
// GET /api/customers/:id/budget-usage — read-only visibility endpoint
// GET /api/budget/company-summary    — company roll-up for status page

import type { Express, RequestHandler } from "express";
import {
  classifyBudgetPercent,
  computePeriodUsage,
  getMonthWindow,
  getPeriodKeys,
  getYearWindow,
} from "../budget-status";
import { computeCustomerSpend } from "../budget-spend";
import { storage } from "../storage";
import { db } from "../db";
import {
  customers as customersTable,
  customerBudgetMonths,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getRecentBudgetAlertEvents } from "../services/budget-alert-service";

export interface RegisterBudgetRoutesDeps {
  requireAuthentication: RequestHandler;
}

// Task #1866 — Budget Status Page: irrigation_manager added to full
// visibility set. Previously excluded (Slice 1 spec), now has full
// budget figures to power the Budget Status page and card.
const VISIBILITY_ROLES = new Set([
  "super_admin",
  "company_admin",
  "billing_manager",
  "irrigation_manager",
]);

function parseDecimal(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

// Season months for the default irrigation curve (Apr–Oct). Used to compute
// season-to-date targets when no custom curve is configured.
const DEFAULT_SEASON_MONTH_RANGE = { first: 4, last: 10 };

export function registerBudgetRoutes(
  app: Express,
  { requireAuthentication }: RegisterBudgetRoutesDeps,
): void {
  app.get(
    "/api/customers/:id/budget-usage",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(id) || id <= 0) {
          res.status(400).json({ message: "Invalid customer id" });
          return;
        }

        const role = req.authenticatedUserRole as string | undefined;
        if (!role || !VISIBILITY_ROLES.has(role)) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }

        const customer = await storage.getCustomer(id);
        if (!customer) {
          res.status(404).json({ message: "Customer not found" });
          return;
        }

        // Multi-tenant guard — only super_admin can read across companies.
        const callerCompanyId = req.authenticatedUserCompanyId as
          | number
          | null
          | undefined;
        if (role !== "super_admin" && callerCompanyId !== customer.companyId) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }

        const now = new Date();
        const { monthKey, yearKey } = getPeriodKeys(now);
        const monthWin = getMonthWindow(now);
        const yearWin = getYearWindow(now);
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1; // 1-12

        const spendCompanyId =
          role === "super_admin" ? null : (callerCompanyId ?? null);

        // ── Task #1865: resolve monthly allocation from customerBudgetMonths ──
        // If no row exists (no goal set or month outside season), return null
        // — never treat absence as zero.
        const [monthRow] = await db
          .select({ amount: customerBudgetMonths.amount })
          .from(customerBudgetMonths)
          .where(
            and(
              eq(customerBudgetMonths.customerId, id),
              eq(customerBudgetMonths.year, currentYear),
              eq(customerBudgetMonths.month, currentMonth),
            ),
          );
        const monthlyAllocation = monthRow
          ? parseDecimal(monthRow.amount)
          : null;

        // ── Season-to-date target: sum allocations for elapsed season months ─
        const elapsedSeasonMonths: number[] = [];
        for (
          let m = DEFAULT_SEASON_MONTH_RANGE.first;
          m <= Math.min(currentMonth, DEFAULT_SEASON_MONTH_RANGE.last);
          m++
        ) {
          elapsedSeasonMonths.push(m);
        }
        let seasonToDateTarget = 0;
        if (elapsedSeasonMonths.length > 0) {
          const seasonRows = await db
            .select({ amount: customerBudgetMonths.amount })
            .from(customerBudgetMonths)
            .where(
              and(
                eq(customerBudgetMonths.customerId, id),
                eq(customerBudgetMonths.year, currentYear),
                inArray(customerBudgetMonths.month, elapsedSeasonMonths),
              ),
            );
          seasonToDateTarget = seasonRows.reduce(
            (s, r) => s + (parseDecimal(r.amount) ?? 0),
            0,
          );
        }

        // ── Spend computations ────────────────────────────────────────────────
        // Season-to-date spend: from April 1 through end of current month.
        const seasonStart = new Date(currentYear, 3, 1); // April 1
        const seasonTDEnd = new Date(currentYear, currentMonth, 1); // exclusive

        const [monthSpend, yearSpend, seasonTDSpendResult] = await Promise.all([
          computeCustomerSpend(id, spendCompanyId, monthWin),
          computeCustomerSpend(id, spendCompanyId, yearWin),
          computeCustomerSpend(id, spendCompanyId, {
            start: seasonStart,
            end: seasonTDEnd,
          }),
        ]);

        const seasonToDateSpend = seasonTDSpendResult.total;

        const soft = customer.budgetSoftThresholdPercent ?? 75;
        const hard = customer.budgetHardThresholdPercent ?? 100;

        // ── Monthly period: cap = this month's allocation (null = unset) ─────
        const monthly = computePeriodUsage(
          monthlyAllocation,
          monthSpend.total,
          soft,
          hard,
          monthKey,
        );

        // ── Annual period: cap = customer's annualBudgetGoal ─────────────────
        const annualGoal = parseDecimal((customer as any).annualBudgetGoal);
        const annual = computePeriodUsage(
          annualGoal,
          yearSpend.total,
          soft,
          hard,
          yearKey,
        );

        res.json({
          customerId: id,
          softThresholdPercent: soft,
          hardThresholdPercent: hard,
          currentMonthKey: monthKey,
          currentYearKey: yearKey,
          // Monthly allocation (null = unset; month outside season or no goal)
          monthlyAllocation,
          monthlyCap: monthlyAllocation, // kept for backward compat
          monthlySpend: monthly.spend,
          monthlyInvoiced: monthSpend.invoiced,
          monthlyPendingNotBilled: monthSpend.pendingNotBilled,
          monthlyPercent: monthly.percent,
          monthlyStatus: monthly.status,
          // Season-to-date
          seasonToDateTarget,
          seasonToDateSpend,
          // Annual
          annualGoal,
          annualCap: annualGoal, // kept for backward compat
          annualSpend: annual.spend,
          annualInvoiced: yearSpend.invoiced,
          annualPendingNotBilled: yearSpend.pendingNotBilled,
          annualPercent: annual.percent,
          annualStatus: annual.status,
        });
      } catch (error) {
        console.error("Error computing budget usage:", error);
        res.status(500).json({ message: "Failed to compute budget usage" });
      }
    },
  );

  // Task #693 — Financial Pulse Slice 4.
  // Recent budget alert events for the "Recent Budget Alerts" section
  // on the customer profile. Same visibility roles + multi-tenant
  // guard as /budget-usage above.
  app.get(
    "/api/customers/:id/budget-alert-events",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(id) || id <= 0) {
          res.status(400).json({ message: "Invalid customer id" });
          return;
        }

        const role = req.authenticatedUserRole as string | undefined;
        if (!role || !VISIBILITY_ROLES.has(role)) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }

        const customer = await storage.getCustomer(id);
        if (!customer) {
          res.status(404).json({ message: "Customer not found" });
          return;
        }

        const callerCompanyId = req.authenticatedUserCompanyId as
          | number
          | null
          | undefined;
        if (role !== "super_admin" && callerCompanyId !== customer.companyId) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }

        const rawLimit = parseInt(String(req.query.limit ?? "20"), 10);
        const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
        const events = await getRecentBudgetAlertEvents(id, limit);
        res.json({ customerId: id, events });
      } catch (error) {
        console.error("Error loading budget alert events:", error);
        res
          .status(500)
          .json({ message: "Failed to load budget alert events" });
      }
    },
  );

  // Task #1865 — Company budget roll-up for the budget status page header.
  // GET /api/budget/company-summary?year=YYYY&month=MM
  // Returns sum of all customers' allocations and spend for the given month,
  // scoped to the caller's company.
  app.get(
    "/api/budget/company-summary",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const role = req.authenticatedUserRole as string | undefined;
        if (!role || !VISIBILITY_ROLES.has(role)) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }

        const callerCompanyId = req.authenticatedUserCompanyId as
          | number
          | null
          | undefined;
        if (role !== "super_admin" && callerCompanyId == null) {
          res.status(403).json({ message: "No company context" });
          return;
        }

        const now = new Date();
        const rawYear = req.query.year as string | undefined;
        const rawMonth = req.query.month as string | undefined;
        const year = rawYear ? parseInt(rawYear, 10) : now.getFullYear();
        const month = rawMonth ? parseInt(rawMonth, 10) : now.getMonth() + 1;

        if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
          res.status(400).json({ message: "Invalid year or month" });
          return;
        }

        // Company scope: super_admin may pass ?companyId=N; others are locked
        // to their own company.
        let companyId: number | null = callerCompanyId ?? null;
        if (role === "super_admin" && req.query.companyId) {
          const n = parseInt(String(req.query.companyId), 10);
          if (!Number.isFinite(n) || n <= 0) {
            res.status(400).json({ message: "Invalid companyId" });
            return;
          }
          companyId = n;
        }

        // Sum all allocations for the month across all company customers.
        const allocationRows = companyId != null
          ? await db
              .select({ amount: customerBudgetMonths.amount })
              .from(customerBudgetMonths)
              .where(
                and(
                  eq(customerBudgetMonths.companyId, companyId),
                  eq(customerBudgetMonths.year, year),
                  eq(customerBudgetMonths.month, month),
                ),
              )
          : await db
              .select({ amount: customerBudgetMonths.amount })
              .from(customerBudgetMonths)
              .where(
                and(
                  eq(customerBudgetMonths.year, year),
                  eq(customerBudgetMonths.month, month),
                ),
              );

        const totalAllocation = allocationRows.reduce(
          (s, r) => s + (parseDecimal(r.amount) ?? 0),
          0,
        );

        // Compute total spend for the month across all scoped customers.
        const monthWin = {
          start: new Date(year, month - 1, 1),
          end: new Date(year, month, 1),
        };

        // Get customer IDs in scope for spend computation.
        const scopedCustomers = companyId != null
          ? await db
              .select({ id: customersTable.id })
              .from(customersTable)
              .where(eq(customersTable.companyId, companyId))
          : await db.select({ id: customersTable.id }).from(customersTable);

        let totalSpend = 0;
        for (const { id: custId } of scopedCustomers) {
          const spend = await computeCustomerSpend(
            custId,
            companyId,
            monthWin,
          );
          totalSpend += spend.total;
        }

        res.json({
          year,
          month,
          companyId,
          totalAllocation,
          totalSpend,
          customersWithAllocation: allocationRows.length,
        });
      } catch (error) {
        console.error("Error computing company budget summary:", error);
        res.status(500).json({ message: "Failed to compute company summary" });
      }
    },
  );

  // Task #1866 — Full-visibility budget status endpoint.
  // GET /api/budget/status?year=YYYY&month=MM
  // Returns per-customer budget status for the caller's company, sorted
  // worst-first. Accessible to VISIBILITY_ROLES (includes irrigation_manager).
  app.get(
    "/api/budget/status",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const role = req.authenticatedUserRole as string | undefined;
        if (!role || !VISIBILITY_ROLES.has(role)) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }

        const callerCompanyId = req.authenticatedUserCompanyId as
          | number
          | null
          | undefined;
        if (role !== "super_admin" && callerCompanyId == null) {
          res.status(403).json({ message: "No company context" });
          return;
        }

        const now = new Date();
        const rawYear = req.query.year as string | undefined;
        const rawMonth = req.query.month as string | undefined;
        const year = rawYear ? parseInt(rawYear, 10) : now.getFullYear();
        const month = rawMonth ? parseInt(rawMonth, 10) : now.getMonth() + 1;

        if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
          res.status(400).json({ message: "Invalid year or month" });
          return;
        }

        // Company scope.
        let companyId: number | null = callerCompanyId ?? null;
        if (role === "super_admin" && req.query.companyId) {
          const n = parseInt(String(req.query.companyId), 10);
          if (!Number.isFinite(n) || n <= 0) {
            res.status(400).json({ message: "Invalid companyId" });
            return;
          }
          companyId = n;
        }

        const monthWin = {
          start: new Date(year, month - 1, 1),
          end: new Date(year, month, 1),
        };

        // Season-to-date: April through end of `month` (or last season month).
        const SEASON_FIRST = 4;
        const SEASON_LAST = 10;
        const seasonEndMonth = Math.min(month, SEASON_LAST);
        const seasonStart = new Date(year, SEASON_FIRST - 1, 1);
        const seasonEnd = new Date(year, seasonEndMonth, 1);

        // Load all customers in scope.
        const allCustomers = companyId != null
          ? await db
              .select()
              .from(customersTable)
              .where(eq(customersTable.companyId, companyId))
          : await db.select().from(customersTable);

        const customerIds = allCustomers.map((c) => c.id);

        // Load monthly allocations for all customers in one query.
        const allocationMap = new Map<number, number>();
        if (customerIds.length > 0) {
          const allocRows = await db
            .select({
              customerId: customerBudgetMonths.customerId,
              amount: customerBudgetMonths.amount,
            })
            .from(customerBudgetMonths)
            .where(
              and(
                inArray(customerBudgetMonths.customerId, customerIds),
                eq(customerBudgetMonths.year, year),
                eq(customerBudgetMonths.month, month),
              ),
            );
          for (const r of allocRows) {
            const n = parseDecimal(r.amount);
            if (n != null) allocationMap.set(r.customerId, n);
          }
        }

        // Load season-to-date allocations (Apr..month) for all customers.
        const elapsedSeasonMonths: number[] = [];
        for (let m = SEASON_FIRST; m <= seasonEndMonth; m++) {
          elapsedSeasonMonths.push(m);
        }
        const seasonAllocMap = new Map<number, number>();
        if (customerIds.length > 0 && elapsedSeasonMonths.length > 0) {
          const sRows = await db
            .select({
              customerId: customerBudgetMonths.customerId,
              amount: customerBudgetMonths.amount,
            })
            .from(customerBudgetMonths)
            .where(
              and(
                inArray(customerBudgetMonths.customerId, customerIds),
                eq(customerBudgetMonths.year, year),
                inArray(customerBudgetMonths.month, elapsedSeasonMonths),
              ),
            );
          for (const r of sRows) {
            const n = parseDecimal(r.amount);
            if (n != null) {
              const prev = seasonAllocMap.get(r.customerId) ?? 0;
              seasonAllocMap.set(r.customerId, prev + n);
            }
          }
        }

        // Build per-customer rows.
        const rows: Array<{
          customerId: number;
          customerName: string;
          allocation: number | null;
          invoicedAmount: number;
          pendingAmount: number;
          totalSpend: number;
          fillPercent: number | null;
          status: "Go" | "Slow down" | "Stop" | "Unset";
          softThresholdPercent: number;
          hardThresholdPercent: number;
          seasonToDateTarget: number;
          seasonToDateSpend: number;
          seasonToDateInvoiced: number;
          seasonToDatePending: number;
          annualGoal: number | null;
        }> = [];

        // Compute spend for all customers (sequentially to avoid overwhelming DB).
        for (const customer of allCustomers) {
          const soft = customer.budgetSoftThresholdPercent ?? 75;
          const hard = customer.budgetHardThresholdPercent ?? 100;
          const allocation = allocationMap.get(customer.id) ?? null;
          const seasonTarget = seasonAllocMap.get(customer.id) ?? 0;

          const [monthSpend, seasonSpend] = await Promise.all([
            computeCustomerSpend(customer.id, companyId, monthWin),
            computeCustomerSpend(customer.id, companyId, { start: seasonStart, end: seasonEnd }),
          ]);

          let fillPercent: number | null = null;
          if (allocation !== null && allocation > 0) {
            fillPercent = (monthSpend.total / allocation) * 100;
          }

          // Map internal status to crew-friendly labels.
          let status: "Go" | "Slow down" | "Stop" | "Unset";
          if (fillPercent === null) {
            status = "Unset";
          } else if (fillPercent >= hard) {
            status = "Stop";
          } else if (fillPercent >= soft) {
            status = "Slow down";
          } else {
            status = "Go";
          }

          const annualGoal = parseDecimal((customer as any).annualBudgetGoal);

          rows.push({
            customerId: customer.id,
            customerName: customer.name ?? "(unnamed)",
            allocation,
            invoicedAmount: monthSpend.invoiced,
            pendingAmount: monthSpend.pendingNotBilled,
            totalSpend: monthSpend.total,
            fillPercent,
            status,
            softThresholdPercent: soft,
            hardThresholdPercent: hard,
            seasonToDateTarget: seasonTarget,
            seasonToDateSpend: seasonSpend.total,
            seasonToDateInvoiced: seasonSpend.invoiced,
            seasonToDatePending: seasonSpend.pendingNotBilled,
            annualGoal,
          });
        }

        // Sort worst-first by fillPercent descending (null/unset last).
        rows.sort((a, b) => {
          if (a.fillPercent === null && b.fillPercent === null) return 0;
          if (a.fillPercent === null) return 1;
          if (b.fillPercent === null) return -1;
          return b.fillPercent - a.fillPercent;
        });

        // Company roll-up.
        const totalAllocation = rows.reduce((s, r) => s + (r.allocation ?? 0), 0);
        const totalSpend = rows.reduce((s, r) => s + r.totalSpend, 0);
        const totalInvoiced = rows.reduce((s, r) => s + r.invoicedAmount, 0);
        const totalPending = rows.reduce((s, r) => s + r.pendingAmount, 0);
        const customersWithAllocation = rows.filter((r) => r.allocation !== null).length;
        const overCapCount = rows.filter((r) => r.status === "Stop").length;
        const approachingCount = rows.filter((r) => r.status === "Slow down").length;
        const seasonToDateTarget = rows.reduce((s, r) => s + r.seasonToDateTarget, 0);
        const seasonToDateSpend = rows.reduce((s, r) => s + r.seasonToDateSpend, 0);

        res.json({
          year,
          month,
          companyId,
          lastRefreshedAt: now.toISOString(),
          rollup: {
            totalAllocation,
            totalSpend,
            totalInvoiced,
            totalPending,
            customersWithAllocation,
            overCapCount,
            approachingCount,
            seasonToDateTarget,
            seasonToDateSpend,
          },
          rows,
        });
      } catch (error) {
        console.error("Error computing budget status:", error);
        res.status(500).json({ message: "Failed to compute budget status" });
      }
    },
  );

  // Task #1866 — Crew-only budget status endpoint.
  // GET /api/budget/crew-status?year=YYYY&month=MM
  // Returns per-customer status and fillPercent only. Gated to field_tech.
  // MUST NOT include cap, spend, remaining, percent, invoicedAmount,
  // pendingAmount, allocation, annualGoal, or any monetary value.
  app.get(
    "/api/budget/crew-status",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const role = req.authenticatedUserRole as string | undefined;
        if (role !== "field_tech") {
          res.status(403).json({ message: "Forbidden — crew endpoint only" });
          return;
        }

        const callerCompanyId = req.authenticatedUserCompanyId as
          | number
          | null
          | undefined;
        if (callerCompanyId == null) {
          res.status(403).json({ message: "No company context" });
          return;
        }

        const now = new Date();
        const rawYear = req.query.year as string | undefined;
        const rawMonth = req.query.month as string | undefined;
        const year = rawYear ? parseInt(rawYear, 10) : now.getFullYear();
        const month = rawMonth ? parseInt(rawMonth, 10) : now.getMonth() + 1;

        if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
          res.status(400).json({ message: "Invalid year or month" });
          return;
        }

        const monthWin = {
          start: new Date(year, month - 1, 1),
          end: new Date(year, month, 1),
        };

        // Load all customers for the company.
        const allCustomers = await db
          .select()
          .from(customersTable)
          .where(eq(customersTable.companyId, callerCompanyId));

        const customerIds = allCustomers.map((c) => c.id);

        // Load monthly allocations.
        const allocationMap = new Map<number, number>();
        if (customerIds.length > 0) {
          const allocRows = await db
            .select({
              customerId: customerBudgetMonths.customerId,
              amount: customerBudgetMonths.amount,
            })
            .from(customerBudgetMonths)
            .where(
              and(
                inArray(customerBudgetMonths.customerId, customerIds),
                eq(customerBudgetMonths.year, year),
                eq(customerBudgetMonths.month, month),
              ),
            );
          for (const r of allocRows) {
            const n = parseDecimal(r.amount);
            if (n != null) allocationMap.set(r.customerId, n);
          }
        }

        // Build crew rows — ONLY status and fillPercent exposed.
        const rows: Array<{
          customerId: number;
          customerName: string;
          status: "Go" | "Slow down" | "Stop" | "Unset";
          fillPercent: number | null;
        }> = [];

        for (const customer of allCustomers) {
          const soft = customer.budgetSoftThresholdPercent ?? 75;
          const hard = customer.budgetHardThresholdPercent ?? 100;
          const allocation = allocationMap.get(customer.id) ?? null;

          let fillPercent: number | null = null;
          let status: "Go" | "Slow down" | "Stop" | "Unset" = "Unset";

          if (allocation !== null && allocation > 0) {
            const monthSpend = await computeCustomerSpend(
              customer.id,
              callerCompanyId,
              monthWin,
            );
            fillPercent = (monthSpend.total / allocation) * 100;
            if (fillPercent >= hard) {
              status = "Stop";
            } else if (fillPercent >= soft) {
              status = "Slow down";
            } else {
              status = "Go";
            }
          }

          rows.push({
            customerId: customer.id,
            customerName: customer.name ?? "(unnamed)",
            status,
            fillPercent,
          });
        }

        // Sort worst-first.
        rows.sort((a, b) => {
          if (a.fillPercent === null && b.fillPercent === null) return 0;
          if (a.fillPercent === null) return 1;
          if (b.fillPercent === null) return -1;
          return b.fillPercent - a.fillPercent;
        });

        res.json({ year, month, rows });
      } catch (error) {
        console.error("Error computing crew budget status:", error);
        res.status(500).json({ message: "Failed to compute crew budget status" });
      }
    },
  );

  // Task #1864 — Dry-run budget threshold preview (Super Admin only).
  // Task #1865 — updated to use customerBudgetMonths for monthly cap and
  //              annualBudgetGoal for annual cap.
  app.get(
    "/api/admin/budget-threshold-preview",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const role = req.authenticatedUserRole as string | undefined;
        if (role !== "super_admin") {
          res.status(403).json({ message: "Forbidden — super_admin only" });
          return;
        }

        const rawCompanyId = req.query.companyId as string | undefined;
        let filterCompanyId: number | null = null;
        if (rawCompanyId != null && rawCompanyId !== "") {
          const n = parseInt(rawCompanyId, 10);
          if (!Number.isFinite(n) || n <= 0) {
            res.status(400).json({ message: "Invalid companyId" });
            return;
          }
          filterCompanyId = n;
        }

        const now = new Date();
        const { monthKey, yearKey } = getPeriodKeys(now);
        const monthWin = getMonthWindow(now);
        const yearWin = getYearWindow(now);
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;

        // Load all customers in scope.
        const allCustomers = filterCompanyId != null
          ? await db
              .select()
              .from(customersTable)
              .where(eq(customersTable.companyId, filterCompanyId))
          : await db.select().from(customersTable);

        // Load monthly allocations for all customers in one query.
        const customerIds = allCustomers.map((c) => c.id);
        const allocationMap = new Map<number, number>();
        if (customerIds.length > 0) {
          const allocRows = await db
            .select({
              customerId: customerBudgetMonths.customerId,
              amount: customerBudgetMonths.amount,
            })
            .from(customerBudgetMonths)
            .where(
              and(
                inArray(customerBudgetMonths.customerId, customerIds),
                eq(customerBudgetMonths.year, currentYear),
                eq(customerBudgetMonths.month, currentMonth),
              ),
            );
          for (const r of allocRows) {
            const n = parseDecimal(r.amount);
            if (n != null) allocationMap.set(r.customerId, n);
          }
        }

        const results: Array<{
          customerId: number;
          companyId: number;
          name: string;
          period: "monthly" | "annual";
          periodKey: string;
          cap: number;
          invoiced: number;
          pendingNotBilled: number;
          total: number;
          percent: number;
          status: "approaching" | "over";
        }> = [];

        for (const customer of allCustomers) {
          const monthlyCap = allocationMap.get(customer.id) ?? null;
          const annualCap = parseDecimal((customer as any).annualBudgetGoal);
          if (monthlyCap == null && annualCap == null) continue;

          const soft = customer.budgetSoftThresholdPercent ?? 75;
          const hard = customer.budgetHardThresholdPercent ?? 100;
          const companyId = customer.companyId;

          const [mSpend, ySpend] = await Promise.all([
            monthlyCap != null
              ? computeCustomerSpend(customer.id, companyId, monthWin)
              : Promise.resolve(null),
            annualCap != null
              ? computeCustomerSpend(customer.id, companyId, yearWin)
              : Promise.resolve(null),
          ]);

          if (monthlyCap != null && mSpend != null && monthlyCap > 0) {
            const percent = mSpend.total / monthlyCap;
            const status = classifyBudgetPercent(percent, soft, hard);
            if (status === "approaching" || status === "over") {
              results.push({
                customerId: customer.id,
                companyId,
                name: customer.name ?? "(unnamed)",
                period: "monthly",
                periodKey: monthKey,
                cap: monthlyCap,
                invoiced: mSpend.invoiced,
                pendingNotBilled: mSpend.pendingNotBilled,
                total: mSpend.total,
                percent: Math.round(percent * 100),
                status,
              });
            }
          }
          if (annualCap != null && ySpend != null && annualCap > 0) {
            const percent = ySpend.total / annualCap;
            const status = classifyBudgetPercent(percent, soft, hard);
            if (status === "approaching" || status === "over") {
              results.push({
                customerId: customer.id,
                companyId,
                name: customer.name ?? "(unnamed)",
                period: "annual",
                periodKey: yearKey,
                cap: annualCap,
                invoiced: ySpend.invoiced,
                pendingNotBilled: ySpend.pendingNotBilled,
                total: ySpend.total,
                percent: Math.round(percent * 100),
                status,
              });
            }
          }
        }

        results.sort((a, b) => b.percent - a.percent);
        res.json({
          generatedAt: now.toISOString(),
          totalCustomersScanned: allCustomers.length,
          customersAtOrNearThreshold: results.length,
          rows: results,
        });
      } catch (error) {
        console.error("Error generating budget threshold preview:", error);
        res.status(500).json({ message: "Failed to generate preview" });
      }
    },
  );
}
