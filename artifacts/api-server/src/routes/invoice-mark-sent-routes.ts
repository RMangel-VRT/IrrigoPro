// Task #1438 — Record manual delivery of an invoice.
// Task #1847 — Decouple sent-ness from lifecycle status.
//
// POST /api/invoices/:id/mark-sent   — stamp `sentAt = now()` without touching
//   `status`. Allowed when sentAt is null and status is not terminal
//   (cancelled / superseded / merged). Explicitly allows `paid` invoices so a
//   QB-paid invoice can still be recorded as delivered.
// POST /api/invoices/:id/mark-unsent — clear `sentAt` without touching
//   `status`. Allowed when sentAt is non-null and status is not terminal.
//
// Both are company-scoped (getInvoiceById under the caller's company) and
// role-guarded per-endpoint (Task #1886): mark-sent is CAN_SEND_INVOICE_EMAIL
// (a bookkeeper records delivery), mark-unsent is CAN_EDIT_INVOICES.
// Extracted into its own module so the handlers can be mounted against
// in-memory storage stubs in tests without standing up the whole
// routes.ts monolith.

import type { Express, RequestHandler } from "express";
import { storage } from "../storage";

export interface RegisterInvoiceMarkSentRoutesDeps {
  requireAuthentication: RequestHandler;
  /** Recording that an invoice went out → CAN_SEND_INVOICE_EMAIL. */
  requireInvoiceSend: RequestHandler;
  /** Task #1886: un-sending is not "mark an invoice sent", and the scope
   *  decision names only the forward direction. Ambiguous → defaulted to
   *  write, so a bookkeeper cannot walk delivery back. */
  requireInvoiceWrite: RequestHandler;
}

export function registerInvoiceMarkSentRoutes(
  app: Express,
  { requireAuthentication, requireInvoiceSend, requireInvoiceWrite }: RegisterInvoiceMarkSentRoutesDeps,
): void {
  app.post(
    "/api/invoices/:id/mark-sent",
    requireAuthentication,
    requireInvoiceSend,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid invoice ID" });
          return;
        }
        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);
        const invoice = await storage.getInvoiceById(id, callerCompanyId);
        if (!invoice) {
          res.status(404).json({ message: "Invoice not found" });
          return;
        }
        // Reject if already sent (sentAt is set) — idempotency guard.
        if (invoice.sentAt) {
          res.status(400).json({ message: "Invoice is already marked as sent." });
          return;
        }
        // Reject terminal statuses — cannot record delivery on a closed invoice.
        const TERMINAL = ["cancelled", "superseded", "merged"] as const;
        if (TERMINAL.includes(invoice.status as any)) {
          res.status(400).json({ message: "Cannot mark a terminal invoice as sent." });
          return;
        }
        // Explicitly allow `paid` (and `generated`, `draft`) — sentAt is
        // independent of lifecycle status after Task #1847.
        const updated = await storage.updateInvoice(id, {
          sentAt: new Date(),
        });
        res.json(updated);
      } catch (error) {
        console.error("Invoice mark-sent error:", error);
        res.status(500).json({ message: "Failed to mark invoice as sent" });
      }
    },
  );

  app.post(
    "/api/invoices/:id/mark-unsent",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid invoice ID" });
          return;
        }
        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);
        const invoice = await storage.getInvoiceById(id, callerCompanyId);
        if (!invoice) {
          res.status(404).json({ message: "Invoice not found" });
          return;
        }
        // Reject if not yet sent — nothing to undo.
        if (!invoice.sentAt) {
          res.status(400).json({ message: "Invoice has not been marked as sent." });
          return;
        }
        // Reject terminal statuses — cannot undo delivery on a closed invoice.
        const TERMINAL = ["cancelled", "superseded", "merged"] as const;
        if (TERMINAL.includes(invoice.status as any)) {
          res.status(400).json({ message: "Cannot mark a terminal invoice as unsent." });
          return;
        }
        const updated = await storage.updateInvoice(id, {
          sentAt: null,
        });
        res.json(updated);
      } catch (error) {
        console.error("Invoice mark-unsent error:", error);
        res.status(500).json({ message: "Failed to mark invoice as unsent" });
      }
    },
  );
}
