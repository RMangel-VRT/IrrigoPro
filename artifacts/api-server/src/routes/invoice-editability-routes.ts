// Task #1811 — Invoice Editability & Walk-Back
//
// Adds controlled editability + rollback lifecycle to invoices:
//   PATCH  /api/invoices/:id                    — Slice 1: metadata edit (generated|sent only)
//   POST   /api/invoices/:id/return-to-draft    — Slice 2: generated → draft walk-back
//   POST   /api/invoices/:id/tickets            — Slice 3: add a ticket to a draft invoice
//   DELETE /api/invoices/:id/tickets/:ticketRef — Slice 3: remove a ticket from a draft invoice
//   POST   /api/invoices/:id/finalize           — Slice 4: draft → generated + QB sync
//   POST   /api/invoices/:id/void               — Slice 5: void & release (any unpaid → cancelled)
//
// Lifecycle rules:
//   generated  → return-to-draft → draft
//   draft      → finalize        → generated
//   generated | sent | draft → void → cancelled
//   paid + terminal (cancelled, superseded, merged) are locked for all write paths
//
// Ticket membership edits are draft-only.
// All ticket additions enforce same-customer scope and strict unbilled precondition.
// Void requires explicit `qbAction: 'void'|'unlink'` when the invoice has a QB id.
// Finalize always triggers a QB create-or-update when the QB integration dep is available.
// Every membership and void-release action emits audit events for both invoice and ticket.

import type { Express, RequestHandler } from "express";
import { z } from "zod/v4";
import { db as dbModule } from "../db";
import { eq, and } from "drizzle-orm";
import {
  invoices,
  invoiceItems,
  billingSheets,
  workOrders,
  wetCheckBillings,
} from "@workspace/db/schema";
import { storage as storageModule } from "../storage";
import { recordAuditEvent } from "./audit-log";
import { enrichInvoiceItemsWithSource } from "./invoice-item-source";

export interface RegisterInvoiceEditabilityRoutesDeps {
  requireAuthentication: RequestHandler;
  /** Task #1886: only GET /api/invoices/:id/items is read-classified here. */
  requireInvoiceRead: RequestHandler;
  /** Every mutation in this module — PATCH, return-to-draft, ticket
   *  attach/release, finalize, void. */
  requireInvoiceWrite: RequestHandler;
  /** Injected from routes.ts so finalize + metadata-QB-update can trigger a
   *  QB create-or-update without duplicating QB credential/integration plumbing. */
  syncInvoiceToQb?: (
    invoiceId: number,
    opts: { callerCompanyId: number | null },
  ) => Promise<{ quickbooksId?: string }>;
  /** Test-only injection. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _db?: any;
  /** Test-only injection. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _storageApi?: any;
}

// ── Validation schemas ───────────────────────────────────────────────────────

// .strict() rejects any unknown fields so the caller gets a 400 rather than
// having extra fields silently ignored.
const metadataPatchSchema = z.object({
  notes: z.string().max(2000).optional(),
  dueDate: z.string().nullable().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  invoiceMonth: z.number().int().min(1).max(12).optional(),
  invoiceYear: z.number().int().min(2000).max(2100).optional(),
}).strict();

const addTicketSchema = z.object({
  ticketType: z.enum(["billing_sheet", "work_order", "wet_check_billing"]),
  ticketId: z.number().int().positive(),
});

const finalizeSchema = z.object({
  // syncNow retained for back-compat; finalize always syncs when QB dep is available
  syncNow: z.boolean().optional(),
});

const voidSchema = z.object({
  qbAction: z.enum(["void", "unlink"]).optional(),
});

// ── Terminal statuses: immutable for all write paths ─────────────────────────

const TERMINAL_STATUSES = new Set(["cancelled", "superseded", "merged"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Re-derive invoice totals by summing live ticket data from invoice_items.
 *  Must be called with the same executor used for the enclosing transaction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function recomputeTotalsFromTickets(invoiceId: number, executor: any = dbModule): Promise<{
  partsSubtotal: string;
  laborSubtotal: string;
  totalAmount: string;
}> {
  const items = await executor
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId));

  let parts = 0;
  let labor = 0;

  for (const item of items) {
    if (item.sourceType === "billing_sheet" && item.billingSheetId != null) {
      const [bs] = await executor
        .select({
          partsSubtotal: billingSheets.partsSubtotal,
          laborSubtotal: billingSheets.laborSubtotal,
        })
        .from(billingSheets)
        .where(eq(billingSheets.id, item.billingSheetId))
        .limit(1);
      if (bs) {
        parts += parseFloat(bs.partsSubtotal ?? "0");
        labor += parseFloat(bs.laborSubtotal ?? "0");
      }
    } else if (item.sourceType === "work_order" && item.workOrderId != null) {
      const [wo] = await executor
        .select({
          partsSubtotal: workOrders.partsSubtotal,
          laborSubtotal: workOrders.laborSubtotal,
        })
        .from(workOrders)
        .where(eq(workOrders.id, item.workOrderId))
        .limit(1);
      if (wo) {
        parts += parseFloat(String(wo.partsSubtotal ?? "0"));
        labor += parseFloat(String(wo.laborSubtotal ?? "0"));
      }
    } else if (item.sourceType === "wet_check_billing" && item.wetCheckBillingId != null) {
      const [wcb] = await executor
        .select({
          partsSubtotal: wetCheckBillings.partsSubtotal,
          laborSubtotal: wetCheckBillings.laborSubtotal,
        })
        .from(wetCheckBillings)
        .where(eq(wetCheckBillings.id, item.wetCheckBillingId))
        .limit(1);
      if (wcb) {
        parts += parseFloat(String(wcb.partsSubtotal ?? "0"));
        labor += parseFloat(String(wcb.laborSubtotal ?? "0"));
      }
    }
  }

  return {
    partsSubtotal: parts.toFixed(2),
    laborSubtotal: labor.toFixed(2),
    totalAmount: (parts + labor).toFixed(2),
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerInvoiceEditabilityRoutes(
  app: Express,
  deps: RegisterInvoiceEditabilityRoutesDeps,
): void {
  const { requireAuthentication, requireInvoiceRead, requireInvoiceWrite, syncInvoiceToQb } = deps;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = deps._db ?? dbModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storage: any = deps._storageApi ?? storageModule;

  // ── PATCH /api/invoices/:id — Slice 1: metadata edit ─────────────────────
  //
  // Restricted to `generated` and `sent` invoices (the two "issued but unpaid"
  // states). Draft invoices are edited through the membership surface (Slice 3).
  // Terminal (cancelled, superseded, merged) and paid invoices are immutable.
  // If QB-synced and period/dueDate changed, triggers an in-place QB update.
  app.patch(
    "/api/invoices/:id",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid invoice ID" });
          return;
        }

        const parsed = metadataPatchSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
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

        // Metadata edits are allowed on any unpaid, non-terminal invoice:
        // draft, generated, or sent. Paid and terminal (cancelled/superseded/merged)
        // are immutable. Partially-paid invoices are also locked — a QBO payment
        // has been recorded against them and editing could cause a reconciliation mismatch.
        if (invoice.status === "paid" || (invoice as any).paymentStatus === "partially_paid") {
          res.status(409).json({
            message:
              invoice.status === "paid"
                ? "Paid invoices cannot be edited."
                : "This invoice has a partial payment recorded in QuickBooks and cannot be edited. Reconcile the payment in QuickBooks first.",
          });
          return;
        }
        if (TERMINAL_STATUSES.has(invoice.status)) {
          res.status(409).json({
            message: `Invoice is in a terminal state (${invoice.status}) and cannot be edited.`,
          });
          return;
        }

        const { notes, dueDate, periodStart, periodEnd, invoiceMonth, invoiceYear } = parsed.data;

        const updates: Record<string, unknown> = {};
        if (notes !== undefined) updates.notes = notes;
        if (dueDate !== undefined) updates.dueDate = dueDate ? new Date(dueDate) : null;
        if (periodStart !== undefined) updates.periodStart = new Date(periodStart);
        if (periodEnd !== undefined) updates.periodEnd = new Date(periodEnd);
        if (invoiceMonth !== undefined) updates.invoiceMonth = invoiceMonth;
        if (invoiceYear !== undefined) updates.invoiceYear = invoiceYear;

        if (Object.keys(updates).length === 0) {
          res.json({ invoice });
          return;
        }

        const updated = await storage.updateInvoice(id, updates);

        await recordAuditEvent(req, {
          action: "invoice.metadata.updated",
          targetType: "invoice",
          targetId: String(id),
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actorCompanyId: invoice.companyId,
          summary: `Metadata updated on invoice #${invoice.invoiceNumber}`,
          details: { fields: Object.keys(updates), invoiceId: id },
        });

        // If QB-synced and period/dueDate changed, push an in-place QB update.
        const qbRelevantChanged = periodStart !== undefined || periodEnd !== undefined || dueDate !== undefined;
        let qbError: string | null = null;
        if (qbRelevantChanged && !!invoice.quickbooksInvoiceId && syncInvoiceToQb) {
          try {
            await syncInvoiceToQb(id, { callerCompanyId });
          } catch (qbErr: any) {
            qbError = qbErr?.message ?? "QuickBooks update failed after metadata change";
            req.log?.warn?.({ err: qbErr, invoiceId: id }, "QB in-place update after metadata patch failed");
          }
        }

        res.json({ invoice: updated, qbError });
      } catch (err) {
        req.log?.error?.({ err }, "invoice metadata patch failed");
        res.status(500).json({ message: "Failed to update invoice" });
      }
    },
  );

  // ── GET /api/invoices/:id/items — the line items of one invoice ───────────
  //
  // Returns the invoice_items for the given invoice, scoped to the caller's
  // company. Read by the draft ticket editor and, since Task #1918, by the
  // expanded row on the invoices list.
  //
  // Each item is enriched with its source ticket's human-readable number and
  // the work date derived from that source. Raw internal ids are useless to
  // someone trying to look a ticket up, and `invoice_items.work_date` is a
  // snapshot that a later correction on the ticket leaves behind. The
  // derivation is the audit view's own rule, shared from
  // ./invoice-item-source rather than written a second time here.
  //
  // The company-scoped invoice resolution stays ahead of every source read: a
  // cross-company invoice id 404s before a single ticket is loaded.
  app.get(
    "/api/invoices/:id/items",
    requireAuthentication,
    requireInvoiceRead,
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

        const items = await enrichInvoiceItemsWithSource(invoice.items ?? [], {
          storage,
          callerCompanyId,
        });

        res.json({ items });
      } catch (err) {
        req.log?.error?.({ err }, "invoice items fetch failed");
        res.status(500).json({ message: "Failed to fetch invoice items" });
      }
    },
  );

  // ── POST /api/invoices/:id/return-to-draft — Slice 2 ────────────────────
  //
  // Walk a `generated` invoice back to `draft`. Tickets remain attached.
  // Clearing sentAt is intentional: the invoice has not been sent while in draft.
  app.post(
    "/api/invoices/:id/return-to-draft",
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

        if (invoice.status !== "generated") {
          res.status(400).json({
            message: `Only generated invoices can be returned to draft. Current status: "${invoice.status}".`,
          });
          return;
        }

        const updated = await storage.updateInvoice(id, {
          status: "draft",
          sentAt: null,
        });

        await recordAuditEvent(req, {
          action: "invoice.returned_to_draft",
          targetType: "invoice",
          targetId: String(id),
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actorCompanyId: invoice.companyId,
          summary: `Invoice #${invoice.invoiceNumber} returned to draft`,
          details: { invoiceId: id, previousStatus: "generated" },
        });

        res.json(updated);
      } catch (err) {
        req.log?.error?.({ err }, "invoice return-to-draft failed");
        res.status(500).json({ message: "Failed to return invoice to draft" });
      }
    },
  );

  // ── POST /api/invoices/:id/tickets — Slice 3: add a ticket ──────────────
  //
  // Only allowed while the invoice is `draft`.
  // Strict unbilled precondition: ticket.invoiceId MUST be null — even a link
  // to a cancelled invoice is rejected (use void to release first).
  // Same-customer enforcement for all ticket types.
  // No QB calls during draft edits — QB is only touched at Finalize.
  // Emits audit events on both the invoice and the attached ticket.
  app.post(
    "/api/invoices/:id/tickets",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid invoice ID" });
          return;
        }

        const parsed = addTicketSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
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

        if (invoice.status !== "draft") {
          res.status(400).json({
            message: `Ticket membership can only be edited on draft invoices. Current status: "${invoice.status}".`,
          });
          return;
        }

        const { ticketType, ticketId } = parsed.data;

        // ── Fetch and validate the ticket ────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let ticketRow: any = null;
        let sourceType: string;
        let description: string;
        let workDate: Date | null = null;
        let laborHours: string = "0";
        let laborRate: string = "0";
        let laborTotal: string = "0";
        let ticketTotal: string = "0";
        let existingInvoiceId: number | null | undefined = null;

        if (ticketType === "billing_sheet") {
          const [bs] = await db
            .select()
            .from(billingSheets)
            .where(
              callerCompanyId != null
                ? and(eq(billingSheets.id, ticketId), eq(billingSheets.companyId, callerCompanyId))
                : eq(billingSheets.id, ticketId),
            )
            .limit(1);
          if (!bs) {
            res.status(404).json({ message: "Billing sheet not found" });
            return;
          }
          if (bs.customerId !== invoice.customerId) {
            res.status(409).json({ message: "Billing sheet belongs to a different customer." });
            return;
          }
          ticketRow = bs;
          sourceType = "billing_sheet";
          description = `Billing Sheet ${bs.billingNumber} - ${bs.workDescription}`;
          workDate = bs.workDate ? new Date(bs.workDate) : null;
          laborHours = String(parseFloat(bs.totalHours || "0"));
          laborRate = String(parseFloat(bs.laborRate || "0"));
          laborTotal = String(parseFloat(bs.laborSubtotal || "0"));
          ticketTotal = String(parseFloat(bs.totalAmount || "0"));
          existingInvoiceId = bs.invoiceId;
        } else if (ticketType === "work_order") {
          const [wo] = await db
            .select()
            .from(workOrders)
            .where(
              callerCompanyId != null
                ? and(eq(workOrders.id, ticketId), eq(workOrders.companyId, callerCompanyId))
                : eq(workOrders.id, ticketId),
            )
            .limit(1);
          if (!wo) {
            res.status(404).json({ message: "Work order not found" });
            return;
          }
          if (wo.customerId !== invoice.customerId) {
            res.status(409).json({ message: "Work order belongs to a different customer." });
            return;
          }
          ticketRow = wo;
          sourceType = "work_order";
          description = `Work Order ${wo.workOrderNumber} - ${wo.projectName}`;
          workDate = wo.completedAt ? new Date(wo.completedAt) : null;
          laborHours = String(parseFloat(wo.totalHours || "0"));
          laborRate = String(parseFloat(wo.appliedLaborRate || wo.laborRate || "0"));
          laborTotal = String(parseFloat(wo.laborSubtotal || "0"));
          ticketTotal = String(parseFloat(wo.totalAmount || "0"));
          existingInvoiceId = wo.invoiceId;
        } else {
          // wet_check_billing — filter by customerId directly (prevents IDOR across customers/companies)
          const [wcb] = await db
            .select()
            .from(wetCheckBillings)
            .where(
              and(
                eq(wetCheckBillings.id, ticketId),
                eq(wetCheckBillings.customerId, invoice.customerId),
              ),
            )
            .limit(1);
          if (!wcb) {
            res.status(404).json({ message: "Wet check billing not found" });
            return;
          }
          ticketRow = wcb;
          sourceType = "wet_check_billing";
          description = `WC Billing ${wcb.billingNumber}`;
          workDate = wcb.workDate ? new Date(wcb.workDate) : null;
          laborHours = String(parseFloat(wcb.totalHours || "0"));
          laborRate = String(parseFloat(wcb.appliedLaborRate || wcb.laborRate || "0"));
          laborTotal = String(parseFloat(wcb.laborSubtotal || "0"));
          ticketTotal = String(parseFloat(wcb.totalAmount || "0"));
          existingInvoiceId = wcb.invoiceId;
        }

        void ticketRow; // fetched as guard — ensures row exists before proceeding

        // Strict unbilled precondition: invoiceId must be null.
        // Even a link to a cancelled invoice requires an explicit release first.
        if (existingInvoiceId != null) {
          if (existingInvoiceId === id) {
            res.status(409).json({ message: "This ticket is already on this invoice." });
          } else {
            res.status(409).json({
              message:
                `This ticket is already attached to invoice ${existingInvoiceId}. ` +
                `Void or unlink that invoice first to release the ticket.`,
            });
          }
          return;
        }

        // ── Attach the ticket atomically ─────────────────────────────────
        await db.transaction(async (tx: any) => {
          const now = new Date();

          const itemValues: Record<string, unknown> = {
            invoiceId: id,
            sourceType,
            sourceId: ticketId,
            description,
            workDate,
            laborHours,
            laborRate,
            laborTotal,
            quantity: "1",
            unitPrice: ticketTotal,
            totalPrice: ticketTotal,
          };
          if (ticketType === "billing_sheet") {
            itemValues.billingSheetId = ticketId;
          } else if (ticketType === "work_order") {
            itemValues.workOrderId = ticketId;
          } else {
            itemValues.wetCheckBillingId = ticketId;
          }
          await tx.insert(invoiceItems).values(itemValues);

          if (ticketType === "billing_sheet") {
            await tx
              .update(billingSheets)
              .set({ invoiceId: id, billedAt: now, status: "billed", updatedAt: now })
              .where(eq(billingSheets.id, ticketId));
          } else if (ticketType === "work_order") {
            await tx
              .update(workOrders)
              .set({ invoiceId: id, billedAt: now, status: "billed", updatedAt: now })
              .where(eq(workOrders.id, ticketId));
          } else {
            await tx
              .update(wetCheckBillings)
              .set({ invoiceId: id, billedAt: now, status: "billed", updatedAt: now })
              .where(eq(wetCheckBillings.id, ticketId));
          }

          const totals = await recomputeTotalsFromTickets(id, tx);
          await tx
            .update(invoices)
            .set({
              partsSubtotal: totals.partsSubtotal,
              laborSubtotal: totals.laborSubtotal,
              totalAmount: totals.totalAmount,
            })
            .where(eq(invoices.id, id));
        });

        // Audit: invoice and the attached ticket
        await recordAuditEvent(req, {
          action: "invoice.ticket.added",
          targetType: "invoice",
          targetId: String(id),
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actorCompanyId: invoice.companyId,
          summary: `Added ${ticketType} ${ticketId} to draft invoice #${invoice.invoiceNumber}`,
          details: { invoiceId: id, ticketType, ticketId },
        });
        await recordAuditEvent(req, {
          action: `${ticketType}.invoice.attached`,
          targetType: ticketType,
          targetId: String(ticketId),
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actorCompanyId: invoice.companyId,
          summary: `Attached to draft invoice #${invoice.invoiceNumber} (id: ${id})`,
          details: { invoiceId: id, ticketType, ticketId },
        });

        const refreshed = await storage.getInvoiceById(id, callerCompanyId);
        res.json(refreshed);
      } catch (err) {
        req.log?.error?.({ err }, "invoice add-ticket failed");
        res.status(500).json({ message: "Failed to add ticket to invoice" });
      }
    },
  );

  // ── DELETE /api/invoices/:id/tickets/:ticketRef — Slice 3: remove a ticket
  //
  // ticketRef format: `{type}:{id}` e.g. `billing_sheet:42`
  // Only allowed on draft invoices. Cannot remove the last ticket.
  // Emits audit events for both the invoice and the released ticket.
  app.delete(
    "/api/invoices/:id/tickets/:ticketRef",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid invoice ID" });
          return;
        }

        const refParts = String(req.params.ticketRef).split(":");
        if (refParts.length !== 2) {
          res.status(400).json({ message: "Invalid ticket ref format. Use {type}:{id}." });
          return;
        }
        const [ticketType, ticketIdStr] = refParts;
        const ticketId = parseInt(ticketIdStr);
        if (!["billing_sheet", "work_order", "wet_check_billing"].includes(ticketType) || isNaN(ticketId) || ticketId <= 0) {
          res.status(400).json({ message: "Invalid ticket ref. Type must be billing_sheet, work_order, or wet_check_billing." });
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

        if (invoice.status !== "draft") {
          res.status(400).json({
            message: `Ticket membership can only be edited on draft invoices. Current status: "${invoice.status}".`,
          });
          return;
        }

        const existingItems = await db
          .select()
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, id));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const matchingItem = existingItems.find((item: any) => {
          if (ticketType === "billing_sheet") return item.billingSheetId === ticketId;
          if (ticketType === "work_order") return item.workOrderId === ticketId;
          return item.wetCheckBillingId === ticketId;
        });

        if (!matchingItem) {
          res.status(404).json({ message: "Ticket not found on this invoice." });
          return;
        }

        if (existingItems.length === 1) {
          res.status(400).json({
            message: "Cannot remove the last ticket from an invoice. Void the invoice instead.",
          });
          return;
        }

        // ── Release the ticket atomically ────────────────────────────────
        await db.transaction(async (tx: any) => {
          const now = new Date();

          await tx
            .delete(invoiceItems)
            .where(eq(invoiceItems.id, matchingItem.id));

          if (ticketType === "billing_sheet") {
            await tx
              .update(billingSheets)
              .set({ invoiceId: null, billedAt: null, status: "approved_passed_to_billing", updatedAt: now })
              .where(and(eq(billingSheets.id, ticketId), eq(billingSheets.invoiceId, id)));
          } else if (ticketType === "work_order") {
            await tx
              .update(workOrders)
              .set({ invoiceId: null, billedAt: null, status: "approved_passed_to_billing", updatedAt: now })
              .where(and(eq(workOrders.id, ticketId), eq(workOrders.invoiceId, id)));
          } else {
            await tx
              .update(wetCheckBillings)
              .set({ invoiceId: null, billedAt: null, status: "approved_passed_to_billing", updatedAt: now })
              .where(and(eq(wetCheckBillings.id, ticketId), eq(wetCheckBillings.invoiceId, id)));
          }

          const totals = await recomputeTotalsFromTickets(id, tx);
          await tx
            .update(invoices)
            .set({
              partsSubtotal: totals.partsSubtotal,
              laborSubtotal: totals.laborSubtotal,
              totalAmount: totals.totalAmount,
            })
            .where(eq(invoices.id, id));
        });

        // Audit: invoice and the released ticket
        await recordAuditEvent(req, {
          action: "invoice.ticket.removed",
          targetType: "invoice",
          targetId: String(id),
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actorCompanyId: invoice.companyId,
          summary: `Removed ${ticketType} ${ticketId} from draft invoice #${invoice.invoiceNumber}`,
          details: { invoiceId: id, ticketType, ticketId },
        });
        await recordAuditEvent(req, {
          action: `${ticketType}.invoice.detached`,
          targetType: ticketType,
          targetId: String(ticketId),
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actorCompanyId: invoice.companyId,
          summary: `Released from draft invoice #${invoice.invoiceNumber} (id: ${id}) — returned to billing queue`,
          details: { invoiceId: id, ticketType, ticketId },
        });

        const refreshed = await storage.getInvoiceById(id, callerCompanyId);
        res.json(refreshed);
      } catch (err) {
        req.log?.error?.({ err }, "invoice remove-ticket failed");
        res.status(500).json({ message: "Failed to remove ticket from invoice" });
      }
    },
  );

  // ── POST /api/invoices/:id/finalize — Slice 4 ───────────────────────────
  //
  // Recompute totals from live ticket data, flip status draft → generated.
  // Always syncs to QuickBooks (create if new, update in place if existing)
  // when the QB integration dep is available. QB failure does not roll back
  // the finalize — qbError is returned alongside the updated invoice.
  app.post(
    "/api/invoices/:id/finalize",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid invoice ID" });
          return;
        }

        const parsed = finalizeSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
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

        if (invoice.status !== "draft") {
          res.status(400).json({
            message: `Only draft invoices can be finalized. Current status: "${invoice.status}".`,
          });
          return;
        }

        const items = await db
          .select({ id: invoiceItems.id })
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, id));
        if (items.length === 0) {
          res.status(400).json({ message: "Cannot finalize an empty invoice. Add at least one ticket first." });
          return;
        }

        const totals = await recomputeTotalsFromTickets(id, db);
        const updated = await storage.updateInvoice(id, {
          status: "generated",
          partsSubtotal: totals.partsSubtotal,
          laborSubtotal: totals.laborSubtotal,
          totalAmount: totals.totalAmount,
        });

        await recordAuditEvent(req, {
          action: "invoice.finalized",
          targetType: "invoice",
          targetId: String(id),
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actorCompanyId: invoice.companyId,
          summary: `Draft invoice #${invoice.invoiceNumber} finalized (total: ${totals.totalAmount})`,
          details: { invoiceId: id, totals },
        });

        // QB sync: always attempt when the dep is present.
        // Creates if not yet in QB; updates in place if previously synced.
        let qbResult: { quickbooksId?: string } | null = null;
        let qbError: string | null = null;
        if (syncInvoiceToQb) {
          try {
            qbResult = await syncInvoiceToQb(id, { callerCompanyId });
          } catch (qbErr: any) {
            qbError = qbErr?.message ?? "QuickBooks sync failed";
            req.log?.warn?.({ err: qbErr, invoiceId: id }, "QB sync after finalize failed");
          }
        }

        res.json({
          invoice: updated,
          qbSynced: qbResult != null,
          qbError,
        });
      } catch (err) {
        req.log?.error?.({ err }, "invoice finalize failed");
        res.status(500).json({ message: "Failed to finalize invoice" });
      }
    },
  );

  // ── POST /api/invoices/:id/void — Slice 5: void & release ────────────────
  //
  // Allowed on any UNPAID invoice (draft, generated, sent). Paid is the only
  // hard block. Terminal statuses (cancelled, superseded, merged) return 409.
  //
  // Atomically:
  //   1. Releases all attached tickets (clears invoiceId/billedAt, reverts status)
  //   2. Removes all invoice_items rows
  //   3. Sets invoice status → 'cancelled'
  //
  // QB handling is always explicit — never automatic:
  //   { qbAction: 'void' }   — persists qbNote documenting required manual QB void
  //   { qbAction: 'unlink' } — clears QB link + persists qbNote; leaves QBO untouched
  // Missing qbAction when QB-synced → 409 { requiresQbConfirm: true }
  //
  // Emits audit events for the invoice and every released ticket.
  app.post(
    "/api/invoices/:id/void",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid invoice ID" });
          return;
        }

        const parsed = voidSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
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

        if (invoice.status === "paid") {
          res.status(409).json({
            message: "Paid invoices cannot be voided. Use the correction/reissue engine for post-payment adjustments.",
          });
          return;
        }

        // Task #1831 — block void for partially-paid invoices (payment recorded in QBO)
        if ((invoice as any).paymentStatus === "partially_paid") {
          res.status(409).json({
            message:
              "This invoice has a partial payment recorded in QuickBooks and cannot be voided. " +
              "Use the correction/reissue engine for post-payment adjustments.",
          });
          return;
        }

        if (TERMINAL_STATUSES.has(invoice.status)) {
          res.status(409).json({
            message: `Invoice is already in a terminal state (${invoice.status}) and cannot be voided.`,
          });
          return;
        }

        // At this point status ∈ { draft, generated, sent }
        const { qbAction } = parsed.data;
        const hasQbLink = !!invoice.quickbooksInvoiceId;

        if (hasQbLink && !qbAction) {
          res.status(409).json({
            requiresQbConfirm: true,
            message:
              "This invoice is synced to QuickBooks. Confirm how to handle the QB invoice: " +
              "send `qbAction: 'void'` to document a manual QB void, or `qbAction: 'unlink'` to leave QB untouched.",
          });
          return;
        }

        // ── Void atomically ──────────────────────────────────────────────
        // Capture released tickets for post-transaction per-ticket auditing
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let releasedItems: any[] = [];

        await db.transaction(async (tx: any) => {
          const now = new Date();

          const items = await tx
            .select()
            .from(invoiceItems)
            .where(eq(invoiceItems.invoiceId, id));
          releasedItems = items;

          for (const item of items) {
            if (item.sourceType === "billing_sheet" && item.billingSheetId != null) {
              await tx
                .update(billingSheets)
                .set({ invoiceId: null, billedAt: null, status: "approved_passed_to_billing", updatedAt: now })
                .where(and(eq(billingSheets.id, item.billingSheetId), eq(billingSheets.invoiceId, id)));
            } else if (item.sourceType === "work_order" && item.workOrderId != null) {
              await tx
                .update(workOrders)
                .set({ invoiceId: null, billedAt: null, status: "approved_passed_to_billing", updatedAt: now })
                .where(and(eq(workOrders.id, item.workOrderId), eq(workOrders.invoiceId, id)));
            } else if (item.sourceType === "wet_check_billing" && item.wetCheckBillingId != null) {
              await tx
                .update(wetCheckBillings)
                .set({ invoiceId: null, billedAt: null, status: "approved_passed_to_billing", updatedAt: now })
                .where(and(eq(wetCheckBillings.id, item.wetCheckBillingId), eq(wetCheckBillings.invoiceId, id)));
            }
          }

          await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, id));

          const invoiceUpdates: Record<string, unknown> = { status: "cancelled" };
          if (hasQbLink) {
            if (qbAction === "unlink") {
              invoiceUpdates.quickbooksInvoiceId = null;
              invoiceUpdates.quickbooksSyncToken = null;
              invoiceUpdates.qbNote =
                `Voided in IrrigoPro (${now.toISOString()}). QB invoice ${invoice.quickbooksInvoiceId} ` +
                `was unlinked — the QBO invoice was NOT voided and remains in QuickBooks Online. ` +
                `Manually cancel it in QBO if needed.`;
            } else if (qbAction === "void") {
              invoiceUpdates.qbNote =
                `Voided in IrrigoPro (${now.toISOString()}). QB invoice ${invoice.quickbooksInvoiceId} ` +
                `must be manually voided in QuickBooks Online.`;
            }
          }
          await tx.update(invoices).set(invoiceUpdates).where(eq(invoices.id, id));
        });

        // Audit: invoice-level event
        await recordAuditEvent(req, {
          action: "invoice.voided",
          targetType: "invoice",
          targetId: String(id),
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actorCompanyId: invoice.companyId,
          severity: "warning",
          summary: `Invoice #${invoice.invoiceNumber} voided (${invoice.status} → cancelled), ${releasedItems.length} ticket(s) released`,
          details: {
            invoiceId: id,
            previousStatus: invoice.status,
            qbAction: qbAction ?? null,
            hadQbLink: hasQbLink,
            quickbooksInvoiceId: invoice.quickbooksInvoiceId ?? null,
            releasedTicketCount: releasedItems.length,
          },
        });

        // Audit: per-ticket release events
        for (const item of releasedItems) {
          const ticketType: string = item.sourceType;
          const ticketId: number | null =
            item.billingSheetId ?? item.workOrderId ?? item.wetCheckBillingId ?? null;
          if (ticketId == null) continue;
          await recordAuditEvent(req, {
            action: `${ticketType}.invoice.released_on_void`,
            targetType: ticketType,
            targetId: String(ticketId),
            actorUserId: req.authenticatedUserId ?? null,
            actorRole: req.authenticatedUserRole ?? null,
            actorCompanyId: invoice.companyId,
            summary: `Released from voided invoice #${invoice.invoiceNumber} — returned to billing queue`,
            details: { invoiceId: id, ticketType, ticketId },
          });
        }

        const refreshed = await storage.getInvoiceById(id, callerCompanyId);
        res.json({
          invoice: refreshed,
          ticketsReleased: releasedItems.length,
          qbAction: qbAction ?? null,
        });
      } catch (err) {
        req.log?.error?.({ err }, "invoice void failed");
        res.status(500).json({ message: "Failed to void invoice" });
      }
    },
  );
}
