// Task #1425 — Merge duplicate monthly invoices for the same customer.
//
// POST /api/invoices/merge — a billing-capable user selects two or more
// invoices for the SAME customer and SAME billing period (invoiceMonth +
// invoiceYear) and folds them into one surviving invoice. Local-only — no
// QuickBooks API calls are made from this module (it deliberately imports
// nothing QuickBooks-related, so the "no QB call" contract is trivially
// true and testable).
//
// Validation lives in ../invoice-merge (pure, DB-free, unit-tested). The
// route does an early read for clear 4xx messages, then delegates the
// atomic mutation to storage.mergeInvoices which re-validates inside its
// transaction.

import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { storage } from "../storage";
import {
  validateMerge,
  InvoiceMergeError,
  type MergeCandidate,
} from "../invoice-merge";

export interface RegisterInvoiceMergeRoutesDeps {
  requireAuthentication: RequestHandler;
  /** Task #1886: merging invoices is an invoice mutation → CAN_EDIT_INVOICES. */
  requireInvoiceWrite: RequestHandler;
}

export const mergeInvoicesSchema = z
  .object({
    survivingInvoiceId: z.number().int().positive(),
    mergedInvoiceIds: z.array(z.number().int().positive()).min(1),
  })
  .strict();

export function registerInvoiceMergeRoutes(
  app: Express,
  { requireAuthentication, requireInvoiceWrite }: RegisterInvoiceMergeRoutesDeps,
): void {
  app.post(
    "/api/invoices/merge",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      const parsed = mergeInvoicesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Invalid request body.",
          errors: parsed.error.flatten(),
        });
        return;
      }

      const { survivingInvoiceId, mergedInvoiceIds } = parsed.data;

      // requireInvoiceWrite only admits company_admin / billing_manager,
      // so the caller is always company-bound here.
      const callerCompanyId: number | null =
        req.authenticatedUserRole === "super_admin"
          ? null
          : (req.authenticatedUserCompanyId ?? null);

      try {
        // Early read for clear, no-mutation 4xx errors. Each invoice is
        // fetched under the caller's company scope so cross-tenant ids
        // simply don't resolve.
        const distinctIds = Array.from(
          new Set([survivingInvoiceId, ...mergedInvoiceIds]),
        );
        const fetched = await Promise.all(
          distinctIds.map((id) => storage.getInvoiceById(id, callerCompanyId)),
        );
        const candidates = fetched.filter(
          (inv): inv is NonNullable<typeof inv> => !!inv,
        ) as unknown as MergeCandidate[];

        // Throws InvoiceMergeError on any rule violation (no changes made).
        validateMerge(
          candidates,
          survivingInvoiceId,
          mergedInvoiceIds,
          callerCompanyId,
        );

        const actorLabel =
          req.authenticatedUserName ??
          req.authenticatedUserEmail ??
          (req.authenticatedUserId != null
            ? `user ${req.authenticatedUserId}`
            : null);

        const result = await storage.mergeInvoices({
          survivingId: survivingInvoiceId,
          mergedIds: mergedInvoiceIds,
          companyId: callerCompanyId,
          audit: {
            actorUserId: req.authenticatedUserId ?? null,
            actorLabel,
            actorRole: req.authenticatedUserRole ?? null,
            actorCompanyId: req.authenticatedUserCompanyId ?? null,
          },
        });

        res.status(200).json({
          message: `Merged ${result.cancelledNumbers.length} invoice(s) into ${result.survivingNumber}.`,
          survivingInvoice: result.survivingInvoice,
          survivingInvoiceNumber: result.survivingNumber,
          cancelledInvoiceIds: result.cancelledInvoiceIds,
          cancelledInvoiceNumbers: result.cancelledNumbers,
          // Task #1443 — the orphaned QuickBooks invoice ids from the merged
          // sources, so the billing manager knows which QB invoices to delete
          // by hand before re-syncing the survivor.
          mergedFromQuickbooksIds: result.mergedFromQuickbooksIds,
          totals: {
            partsSubtotal: result.partsSubtotal,
            laborSubtotal: result.laborSubtotal,
            totalAmount: result.totalAmount,
          },
        });
      } catch (err) {
        if (err instanceof InvoiceMergeError) {
          res
            .status(err.httpStatus)
            .json({ message: err.message, code: err.code });
          return;
        }
        req.log?.error?.({ err }, "invoice merge failed");
        res.status(500).json({ message: "Failed to merge invoices." });
      }
    },
  );
}
