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
import { customers as customersTable } from "@workspace/db/schema";
import { eq, isNotNull, or } from "drizzle-orm";
import { getRecentBudgetAlertEvents } from "../services/budget-alert-service";

export interface RegisterBudgetRoutesDeps {
  requireAuthentication: RequestHandler;
}

// Slice 1 spec: only super_admin / company_admin / billing_manager can
// see a customer's budget usage. irrigation_manager is intentionally
// NOT in this set — they get pricing data but not budget signals.
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

        // Use the shared computeCustomerSpend function so budget-routes,
        // budget-alert-service, and financial-pulse all agree on the number.
        // company scope: super_admin passes null (global), everyone else is
        // scoped to their own company.
        const spendCompanyId = role === "super_admin" ? null : (callerCompanyId ?? null);
        const [monthSpend, yearSpend] = await Promise.all([
          computeCustomerSpend(id, spendCompanyId, monthWin),
          computeCustomerSpend(id, spendCompanyId, yearWin),
        ]);

        const soft = customer.budgetSoftThresholdPercent ?? 75;
        const hard = customer.budgetHardThresholdPercent ?? 100;
        const monthly = computePeriodUsage(
          parseDecimal(customer.monthlyBudgetCap),
          monthSpend.total,
          soft,
          hard,
          monthKey,
        );
        const annual = computePeriodUsage(
          parseDecimal(customer.annualBudgetCap),
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
          monthlyCap: monthly.cap,
          monthlySpend: monthly.spend,
          monthlyInvoiced: monthSpend.invoiced,
          monthlyPendingNotBilled: monthSpend.pendingNotBilled,
          monthlyPercent: monthly.percent,
          monthlyStatus: monthly.status,
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
          const monthlyCap = parseDecimal(customer.monthlyBudgetCap);
          const annualCap = parseDecimal(customer.annualBudgetCap);
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
