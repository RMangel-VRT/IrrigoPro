// Task #1443 / #1711 — Sync an app invoice to QuickBooks.
//
// POST /api/invoices/:id/sync-quickbooks — a billing-capable user pushes a
// single app invoice's current totals/line items into QuickBooks. Behavior
// is entirely driven by the injected `syncQuickBooksInvoice` function:
//   - invoice has no QB id  → CREATE a new QB invoice.
//   - invoice already has a QB id → UPDATE the existing QB invoice in-place.
//
// There is no longer a force/non-force distinction at the HTTP layer. The old
// 409 "already_synced" guard is removed — any sync call for an already-linked
// invoice now routes to an in-place update, never a duplicate create.
//
// The `force` field is accepted (but ignored) for backwards compatibility with
// existing clients that still send it.
//
// The actual QB create/update + persistence is injected as `syncQuickBooksInvoice`
// (it lives in routes.ts as a closure with access to the QuickBooks request
// helpers). This module owns the HTTP shape, role guard, and company scope so
// it can be unit-tested with storage spies + a stubbed sync function — no
// QuickBooks calls in the test path.

import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { storage } from "../storage";

// Thrown by the injected sync function for precondition / QuickBooks
// failures so the route can map them to a clear HTTP status + message.
export class InvoiceSyncError extends Error {
  httpStatus: number;
  constructor(message: string, httpStatus = 400) {
    super(message);
    this.name = "InvoiceSyncError";
    this.httpStatus = httpStatus;
  }
}

export const syncInvoiceQbSchema = z
  .object({ force: z.boolean().optional() })
  .strict();

export interface SyncInvoiceResult {
  quickbooksId?: string;
}

export interface RegisterInvoiceSyncQuickbooksRoutesDeps {
  requireAuthentication: RequestHandler;
  /** Task #1886: pushing an invoice to QBO writes the invoice's QB linkage
   *  and SyncToken → CAN_EDIT_INVOICES, not CAN_MANAGE_QUICKBOOKS. */
  requireInvoiceWrite: RequestHandler;
  // Syncs the app invoice to QuickBooks: creates if no QB id exists, updates
  // in-place if it does. Persists the new/updated QB id and SyncToken.
  // Throws InvoiceSyncError on a precondition (customer not synced, no
  // billable lines, QB not connected) or QuickBooks failure.
  createQuickBooksInvoice: (
    invoiceId: number,
    opts: { callerCompanyId: number | null },
  ) => Promise<SyncInvoiceResult>;
}

export function registerInvoiceSyncQuickbooksRoutes(
  app: Express,
  {
    requireAuthentication,
    requireInvoiceWrite,
    createQuickBooksInvoice,
  }: RegisterInvoiceSyncQuickbooksRoutesDeps,
): void {
  app.post(
    "/api/invoices/:id/sync-quickbooks",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ message: "Invalid invoice id." });
        return;
      }

      const parsed = syncInvoiceQbSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          message: "Invalid request body.",
          errors: parsed.error.flatten(),
        });
        return;
      }

      const callerCompanyId: number | null =
        req.authenticatedUserRole === "super_admin"
          ? null
          : (req.authenticatedUserCompanyId ?? null);

      try {
        const invoice = await storage.getInvoiceById(id, callerCompanyId);
        if (!invoice) {
          res.status(404).json({ message: "Invoice not found." });
          return;
        }

        const result = await createQuickBooksInvoice(id, { callerCompanyId });
        const action = invoice.quickbooksInvoiceId ? "updated" : "synced";
        res.json({
          success: true,
          quickbooksId: result.quickbooksId,
          message: `Invoice ${action} in QuickBooks successfully`,
        });
      } catch (err) {
        if (err instanceof InvoiceSyncError) {
          const isAuthError = err.httpStatus === 401;
          // Use 400 (not 401) for QB credential errors so the client's global
          // session-expired redirect does not fire for an integration failure.
          res.status(isAuthError ? 400 : err.httpStatus).json({
            message: err.message,
            ...(isAuthError ? { code: "QB_AUTH_EXPIRED" } : {}),
          });
          return;
        }
        req.log?.error?.({ err }, "invoice QuickBooks sync failed");
        res.status(500).json({ message: "Failed to sync invoice to QuickBooks." });
      }
    },
  );
}
