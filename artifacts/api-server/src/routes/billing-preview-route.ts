/**
 * billing-preview-route.ts
 *
 * The real handler for GET /api/customers/billing-preview, extracted from
 * routes.ts so its tenant scoping can be tested against a storage stub
 * without standing up the full registerRoutes() monolith (which needs a live
 * Postgres). routes.ts calls this — it is not a copy, so it cannot drift.
 *
 * Task #1898 — this endpoint used to iterate every visible customer issuing
 * four sequential storage calls each (>8,000 queries on the largest tenant),
 * which starved the connection pool for every other dashboard request. It now
 * issues three batched reads via getBillingPreviewSources. The partition math
 * is unchanged: buildBillingPreviewRows delegates to the same
 * computeUnbilledPartition selector the per-customer detail endpoint uses
 * (see customer-billing-parity.test.ts).
 */

import type { Express, RequestHandler } from "express";
import {
  buildBillingPreviewRows,
  type BillingPreviewCustomer,
  type BillingPreviewSources,
} from "../billing-preview-sources";

/** A customer row as read from storage, before the billing-visibility filter. */
export type BillingPreviewStorageCustomer = BillingPreviewCustomer & {
  hiddenFromBilling?: boolean | null;
};

export interface BillingPreviewStorage {
  getCustomers(companyId?: number): Promise<BillingPreviewStorageCustomer[]>;
  getBillingPreviewSources(
    customerIds: number[],
    companyId: number | null,
  ): Promise<BillingPreviewSources>;
}

export interface BillingPreviewDeps {
  storage: BillingPreviewStorage;
  /** Default billing month (YYYY-MM) when the client omits selectedMonth. */
  previousCalendarMonth(): string;
  /** "all" → null (no cutoff); YYYY-MM → end of that month, server-local. */
  resolveAsOfCutoff(selectedMonth: string): Date | null;
}

export function registerBillingPreviewRoute(
  app: Express,
  deps: BillingPreviewDeps,
  requireAuthentication: RequestHandler,
): void {
  const { storage, previousCalendarMonth, resolveAsOfCutoff } = deps;

  app.get(
    "/api/customers/billing-preview",
    requireAuthentication,
    async (req: any, res) => {
      try {
        // Scope the customer list to the caller's company, exactly as
        // GET /api/customers does. The row-level sources below are already
        // company-scoped, so an unscoped list here would leak other tenants'
        // customer names into the preview as zero-value rows.
        const callerRole = req.authenticatedUserRole;
        if (callerRole !== "super_admin" && !req.authenticatedUserCompanyId) {
          res
            .status(403)
            .json({ message: "Forbidden: user has no company association" });
          return;
        }
        const callerCid: number | undefined =
          callerRole === "super_admin"
            ? undefined
            : (req.authenticatedUserCompanyId ?? undefined);

        const allCustomers = await storage.getCustomers(callerCid);
        const customers = allCustomers.filter((c) => !c.hiddenFromBilling);

        // Resolve billing month — default to the previous calendar month when
        // the client omits selectedMonth (or sends an empty string).
        const rawSelectedMonth = req.query.selectedMonth as string | undefined;
        const selectedMonth =
          rawSelectedMonth && rawSelectedMonth.trim() !== ""
            ? rawSelectedMonth.trim()
            : previousCalendarMonth();
        const asOfCutoff = resolveAsOfCutoff(selectedMonth);

        const sources = await storage.getBillingPreviewSources(
          customers.map((c) => c.id),
          callerCid ?? null,
        );
        const customerPreviews = buildBillingPreviewRows(
          customers,
          sources,
          asOfCutoff,
        );

        res.json(customerPreviews);
      } catch (error) {
        console.error("Error fetching customer billing previews:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch customer billing previews" });
      }
    },
  );
}
