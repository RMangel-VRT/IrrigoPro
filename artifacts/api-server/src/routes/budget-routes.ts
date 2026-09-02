// Task #687 — Financial Pulse Slice 1.
//
// GET /api/customers/:id/budget-usage — read-only visibility endpoint
// powering the "Budget & Alerts" card on the customer profile and the
// live preview in the customer-edit form. Out of scope here: firing the
// alerts themselves (Slice 2) and the /financial-pulse page (Slice 3).

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
  companies,
  customerBudgetMonths,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getRecentBudgetAlertEvents } from "../services/budget-alert-service";
import {
  applyMonthOverride,
  resolveEffectiveCurve,
  resetMonthOverride,
} from "../services/generate-budget-months";

export interface RegisterBudgetRoutesDeps {
  requireAuthentication: RequestHandler;
}

// Slice 1 spec: only super_admin / company_admin / billing_manager can
// see a customer's budget usage. irrigation_manager is intentionally
// NOT in this set — they get pricing data but not budget signals.
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const VISIBILITY_ROLES = new Set([
  "super_admin",
  "company_admin",
  "billing_manager",
]);

function parseDecimal(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

const FIRST_SEASON_MONTH = 4;
const LAST_SEASON_MONTH = 10;

export function registerBudgetRoutes(
  app: Express,
  { requireAuthentication }: RegisterBudgetRoutesDeps,
): void {
  app.get(
    "/api/companies/:id/budget-season-curve",
    requireAuthentication,
    async (req: any, res) => {
      const companyId = parseInt(String(req.params.id), 10);
      const role = req.authenticatedUserRole as string | undefined;
      const callerCompanyId = req.authenticatedUserCompanyId as number | null | undefined;
      if (!Number.isInteger(companyId) || companyId <= 0) {
        res.status(400).json({ message: "Invalid company id" });
        return;
      }
      if (!role || !VISIBILITY_ROLES.has(role)) {
        res.status(403).json({ message: "Forbidden" });
        return;
      }
      if (role !== "super_admin" && callerCompanyId !== companyId) {
        res.status(404).json({ message: "Company not found" });
        return;
      }
      const [company] = await db
        .select({ budgetSeasonCurve: companies.budgetSeasonCurve })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) {
        res.status(404).json({ message: "Company not found" });
        return;
      }
      res.json({ curve: resolveEffectiveCurve(null, company.budgetSeasonCurve) });
    },
  );

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
          res.status(404).json({ message: "Customer not found" });
          return;
        }

        const now = new Date();
        const { monthKey, yearKey } = getPeriodKeys(now);
        const monthWin = getMonthWindow(now);
        const yearWin = getYearWindow(now);
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const [monthRow] = await db
          .select({ amount: customerBudgetMonths.amount })
          .from(customerBudgetMonths)
          .where(and(
            eq(customerBudgetMonths.companyId, customer.companyId),
            eq(customerBudgetMonths.customerId, id),
            eq(customerBudgetMonths.year, currentYear),
            eq(customerBudgetMonths.month, currentMonth),
          ))
          .limit(1);
        const monthlyAllocation = monthRow ? parseDecimal(monthRow.amount) : null;
        const elapsedMonths = currentMonth < FIRST_SEASON_MONTH
          ? []
          : Array.from(
              { length: Math.min(currentMonth, LAST_SEASON_MONTH) - FIRST_SEASON_MONTH + 1 },
              (_, index) => FIRST_SEASON_MONTH + index,
            );
        const seasonRows = elapsedMonths.length === 0
          ? []
          : await db
              .select({ amount: customerBudgetMonths.amount })
              .from(customerBudgetMonths)
              .where(and(
                eq(customerBudgetMonths.companyId, customer.companyId),
                eq(customerBudgetMonths.customerId, id),
                eq(customerBudgetMonths.year, currentYear),
                inArray(customerBudgetMonths.month, elapsedMonths),
              ));
        const seasonToDateTarget = seasonRows.reduce(
          (sum, row) => sum + (parseDecimal(row.amount) ?? 0),
          0,
        );
        const [monthSpend, yearSpend, seasonSpend] = await Promise.all([
          computeCustomerSpend(id, customer.companyId, monthWin),
          computeCustomerSpend(id, customer.companyId, yearWin),
          computeCustomerSpend(id, customer.companyId, {
            start: new Date(currentYear, FIRST_SEASON_MONTH - 1, 1),
            end: new Date(currentYear, currentMonth, 1),
          }),
        ]);

        const soft = customer.budgetSoftThresholdPercent ?? 75;
        const hard = customer.budgetHardThresholdPercent ?? 100;
        const monthly = computePeriodUsage(
          monthlyAllocation,
          monthSpend.total,
          soft,
          hard,
          monthKey,
        );
        const annual = computePeriodUsage(
          parseDecimal(customer.annualBudgetGoal),
          yearSpend.total,
          soft,
          hard,
          yearKey,
        );

        // Flat response shape — slice 1 contract (unchanged field names):
        //   customerId, softThresholdPercent, hardThresholdPercent,
        //   currentMonthKey, currentYearKey,
        //   monthly{Cap,Spend,Percent,Status},
        //   annual{Cap,Spend,Percent,Status}
        // Task #1864 adds the invoiced/pendingNotBilled breakdown fields so
        // the Budget card can show uninvoiced work separately without a
        // breaking change (existing consumers only read the existing fields).
        res.json({
          customerId: id,
          softThresholdPercent: soft,
          hardThresholdPercent: hard,
          currentMonthKey: monthKey,
          currentYearKey: yearKey,
          monthlyAllocation,
          monthlyCap: monthly.cap,
          monthlySpend: monthly.spend,
          monthlyInvoiced: monthSpend.invoiced,
          monthlyPendingNotBilled: monthSpend.pendingNotBilled,
          monthlyPercent: monthly.percent,
          monthlyStatus: monthly.status,
          seasonToDateTarget,
          seasonToDateSpend: seasonSpend.total,
          annualGoal: annual.cap,
          annualCap: annual.cap,
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

  app.get(
    "/api/customers/:id/budget-months",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id), 10);
        const year = parseInt(String(req.query.year ?? new Date().getFullYear()), 10);
        if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(year)) {
          res.status(400).json({ message: "Invalid customer id or year" });
          return;
        }
        const role = req.authenticatedUserRole as string | undefined;
        if (!role || !VISIBILITY_ROLES.has(role)) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }
        const customer = await storage.getCustomer(id);
        const callerCompanyId = req.authenticatedUserCompanyId as number | null | undefined;
        if (!customer || (role !== "super_admin" && callerCompanyId !== customer.companyId)) {
          res.status(404).json({ message: "Customer not found" });
          return;
        }
        const rows = await db
          .select({
            month: customerBudgetMonths.month,
            amount: customerBudgetMonths.amount,
            isManualOverride: customerBudgetMonths.isManualOverride,
          })
          .from(customerBudgetMonths)
          .where(and(
            eq(customerBudgetMonths.companyId, customer.companyId),
            eq(customerBudgetMonths.customerId, id),
            eq(customerBudgetMonths.year, year),
          ));
        res.json({
          customerId: id,
          year,
          annualGoal: parseDecimal(customer.annualBudgetGoal),
          months: rows.map((row) => ({
            month: row.month,
            amount: parseDecimal(row.amount) ?? 0,
            isManualOverride: row.isManualOverride,
          })),
        });
      } catch (error) {
        console.error("Error loading budget months:", error);
        res.status(500).json({ message: "Failed to load budget months" });
      }
    },
  );

  app.put(
    "/api/customers/:id/budget-months/:year/:month",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id), 10);
        const year = parseInt(String(req.params.year), 10);
        const month = parseInt(String(req.params.month), 10);
        const amount = parseDecimal(req.body?.amount);
        if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(year) ||
            !Number.isInteger(month) || month < 1 || month > 12 ||
            amount == null || amount < 0) {
          res.status(400).json({ message: "Invalid budget override" });
          return;
        }
        const role = req.authenticatedUserRole as string | undefined;
        if (!role || !VISIBILITY_ROLES.has(role)) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }
        const customer = await storage.getCustomer(id);
        const callerCompanyId = req.authenticatedUserCompanyId as number | null | undefined;
        if (!customer || (role !== "super_admin" && callerCompanyId !== customer.companyId)) {
          res.status(404).json({ message: "Customer not found" });
          return;
        }
        await applyMonthOverride({ customerId: id, year, month, amount });
        res.json({ customerId: id, year, month, amount, isManualOverride: true });
      } catch (error) {
        console.error("Error applying budget override:", error);
        res.status(500).json({ message: "Failed to apply budget override" });
      }
    },
  );

  app.delete(
    "/api/customers/:id/budget-months/:year/:month/override",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id), 10);
        const year = parseInt(String(req.params.year), 10);
        const month = parseInt(String(req.params.month), 10);
        if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(year) ||
            !Number.isInteger(month) || month < 1 || month > 12) {
          res.status(400).json({ message: "Invalid budget override" });
          return;
        }
        const role = req.authenticatedUserRole as string | undefined;
        if (!role || !VISIBILITY_ROLES.has(role)) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }
        const customer = await storage.getCustomer(id);
        const callerCompanyId = req.authenticatedUserCompanyId as number | null | undefined;
        if (!customer || (role !== "super_admin" && callerCompanyId !== customer.companyId)) {
          res.status(404).json({ message: "Customer not found" });
          return;
        }
        await resetMonthOverride({ customerId: id, year, month });
        res.json({ customerId: id, year, month, isManualOverride: false });
      } catch (error) {
        console.error("Error resetting budget override:", error);
        res.status(500).json({ message: "Failed to reset budget override" });
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
          res.status(404).json({ message: "Customer not found" });
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
        const callerCompanyId = req.authenticatedUserCompanyId as number | null | undefined;
        let companyId = callerCompanyId ?? null;
        if (role === "super_admin") {
          companyId = req.query.companyId == null
            ? null
            : parseInt(String(req.query.companyId), 10);
        }
        if (role !== "super_admin" && companyId == null) {
          res.status(403).json({ message: "No company context" });
          return;
        }
        if (companyId != null && (!Number.isFinite(companyId) || companyId <= 0)) {
          res.status(400).json({ message: "Invalid companyId" });
          return;
        }
        const now = new Date();
        const year = parseInt(String(req.query.year ?? now.getFullYear()), 10);
        const month = parseInt(String(req.query.month ?? now.getMonth() + 1), 10);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          res.status(400).json({ message: "Invalid year or month" });
          return;
        }
        const allocationRows = companyId == null
          ? await db
              .select({
                customerId: customerBudgetMonths.customerId,
                amount: customerBudgetMonths.amount,
              })
              .from(customerBudgetMonths)
              .where(and(
                eq(customerBudgetMonths.year, year),
                eq(customerBudgetMonths.month, month),
              ))
          : await db
              .select({
                customerId: customerBudgetMonths.customerId,
                amount: customerBudgetMonths.amount,
              })
              .from(customerBudgetMonths)
              .where(and(
                eq(customerBudgetMonths.companyId, companyId),
                eq(customerBudgetMonths.year, year),
                eq(customerBudgetMonths.month, month),
              ));
        const scopedCustomers = companyId == null
          ? await db.select({ id: customersTable.id, companyId: customersTable.companyId }).from(customersTable)
          : await db
              .select({ id: customersTable.id, companyId: customersTable.companyId })
              .from(customersTable)
              .where(eq(customersTable.companyId, companyId));
        const window = {
          start: new Date(year, month - 1, 1),
          end: new Date(year, month, 1),
        };
        const spends = await Promise.all(
          scopedCustomers.map((customer) =>
            computeCustomerSpend(customer.id, customer.companyId, window)),
        );
        res.json({
          year,
          month,
          companyId,
          totalAllocation: allocationRows.reduce(
            (sum, row) => sum + (parseDecimal(row.amount) ?? 0),
            0,
          ),
          totalSpend: spends.reduce((sum, spend) => sum + spend.total, 0),
          customersWithAllocation: allocationRows.length,
        });
      } catch (error) {
        console.error("Error computing company budget summary:", error);
        res.status(500).json({ message: "Failed to compute company summary" });
      }
    },
  );

  // Task #1864 — Dry-run budget threshold preview (Super Admin only).
  //
  // Read-only diagnostic: lists every customer that would be in
  // "approaching" or "over" status under the new computeCustomerSpend
  // calculation. Run this before deploying the alert service change to
  // understand which customers would newly receive alerts on the first
  // post-deploy invoice finalization.
  //
  // GET /api/admin/budget-threshold-preview
  //   ?companyId=N  — optional; filter to a single company
  //
  // This route is intentionally NOT registered in the staging/prod
  // environment automatically — it must be reviewed and removed once
  // the deployment window has passed. The dedup index ensures each
  // alert fires only once per period, but a burst of first-time fires
  // should be reviewed before going live.
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

        // Load all customers that have at least one budget cap set.
        const allCustomers = filterCompanyId != null
          ? await db
              .select()
              .from(customersTable)
              .where(
                eq(customersTable.companyId, filterCompanyId),
              )
          : await db.select().from(customersTable);

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
          const [monthAllocation] = await db
            .select({ amount: customerBudgetMonths.amount })
            .from(customerBudgetMonths)
            .where(and(
              eq(customerBudgetMonths.companyId, customer.companyId),
              eq(customerBudgetMonths.customerId, customer.id),
              eq(customerBudgetMonths.year, now.getFullYear()),
              eq(customerBudgetMonths.month, now.getMonth() + 1),
            ))
            .limit(1);
          const monthlyCap = monthAllocation ? parseDecimal(monthAllocation.amount) : null;
          const annualCap = parseDecimal(customer.annualBudgetGoal);
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
