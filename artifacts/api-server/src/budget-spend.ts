// Task #1864 — Single canonical "how much has this customer spent" helper.
//
// Previously three surfaces (budget-routes, budget-alert-service,
// financial-pulse customer summary) each had hand-rolled exclusion loops
// with diverging status sets, causing the same customer to show different
// totals on different screens.
//
// This module is the ONE source of truth for customer spend in a window.
// All callers must import `computeCustomerSpend` from here.
//
// Design decisions:
//   - Invoice leg: uses `storage.getInvoicesByCustomer` so the company-id
//     scope is enforced by the same tested method the rest of the API uses.
//   - WCB leg: queries wet_check_billings directly by customerId (which is
//     already validated against the company before the call). WCBs are
//     bucketed by `workDate` (the logical work date), NOT createdAt, because
//     that is the auditable date the wet check was performed.
//   - Excluded invoice statuses: the canonical set from `financial-pulse-math`
//     (draft, cancelled, superseded, merged, failed). Never re-declare.
//   - `merged` and `failed` invoices are excluded — their amounts already
//     live on the surviving invoice or are not revenue.

import { db } from "./db";
import { wetCheckBillings } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { INVOICE_EXCLUDED_STATUSES, toNum } from "./financial-pulse-math";
import { storage } from "./storage";

export interface CustomerSpendResult {
  /** Sum of non-excluded invoice totals with createdAt inside the window. */
  invoiced: number;
  /** Sum of uninvoiced wet-check billing totals with workDate inside the window. */
  pendingNotBilled: number;
  /** invoiced + pendingNotBilled */
  total: number;
}

/**
 * Compute how much a customer has spent in a given window.
 *
 * @param customerId  — customer to query
 * @param companyId   — company scope for the invoice lookup; pass the
 *                      customer's companyId for company-scoped users,
 *                      null ONLY for super_admin (global view).
 * @param window      — inclusive start, exclusive end (same semantics used
 *                      everywhere else in financial-pulse-math)
 */
export async function computeCustomerSpend(
  customerId: number,
  companyId: number | null,
  window: { start: Date; end: Date },
): Promise<CustomerSpendResult> {
  // ── Invoice leg ────────────────────────────────────────────────────────
  // storage.getInvoicesByCustomer enforces company scoping when companyId
  // is non-null. Passing null gives the super_admin cross-company view.
  const allInvoices = await storage.getInvoicesByCustomer(customerId, companyId);
  let invoiced = 0;
  for (const inv of allInvoices) {
    if (INVOICE_EXCLUDED_STATUSES.has(inv.status)) continue; // merged & failed excluded
    const d =
      inv.createdAt instanceof Date
        ? inv.createdAt
        : new Date(inv.createdAt as unknown as string);
    if (d >= window.start && d < window.end) {
      invoiced += toNum(inv.totalAmount);
    }
  }

  // ── Uninvoiced wet-check billing leg ───────────────────────────────────
  // Only rows with invoiceId IS NULL are counted — invoiced WCBs already
  // flow through the invoice totals above.
  const wcbRows = await db
    .select({
      invoiceId: wetCheckBillings.invoiceId,
      totalAmount: wetCheckBillings.totalAmount,
      workDate: wetCheckBillings.workDate,
    })
    .from(wetCheckBillings)
    .where(eq(wetCheckBillings.customerId, customerId));

  let pendingNotBilled = 0;
  for (const wcb of wcbRows) {
    if (wcb.invoiceId != null) continue; // already in invoice totals
    const d =
      wcb.workDate instanceof Date
        ? wcb.workDate
        : wcb.workDate
          ? new Date(wcb.workDate as unknown as string)
          : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    if (d >= window.start && d < window.end) {
      pendingNotBilled += toNum(wcb.totalAmount);
    }
  }

  return { invoiced, pendingNotBilled, total: invoiced + pendingNotBilled };
}
