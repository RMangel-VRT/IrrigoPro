// Task #1710 — Invoice Correction & Reissue (Guided Dispute Flow)
// Task #1739 Amendment — Stable invoice number + revision protocol
//
// Implements the full correction lifecycle:
//   POST   /api/invoice-corrections           — open a draft correction
//   PATCH  /api/invoice-corrections/:id       — update reason/evidence/reviewed state
//   POST   /api/invoice-corrections/:id/reissue  — create corrected invoice (same number, revision+1)
//   POST   /api/invoice-corrections/:id/qb-sync  — resync QB (stubbed, 501)
//   POST   /api/invoice-corrections/:id/cancel   — cancel a draft correction
//   GET    /api/invoice-corrections/:id           — fetch correction with lines
//   GET    /api/invoices/:invoiceId/correction-tickets — tickets on this invoice
//
// Core architectural invariant: edits always write to source tickets; the
// reissued invoice re-derives totals from live ticket data. No values are
// pushed backward from the invoice.
//
// Ticket unlock: an already-invoiced billing sheet can be edited (totals
// adjusted) while there is an open `draft` correction that references its
// invoice. The guard is enforced inline in the PATCH billing-sheet-items
// handler via storage.getOpenCorrectionForInvoice. Outside that context the
// existing billed-lock stands.

import type { Express, RequestHandler } from "express";
import { z } from "zod/v4";
import { db as dbModule } from "../db";
import { eq, and, isNull } from "drizzle-orm";
import {
  invoiceCorrections,
  invoiceCorrectionLines,
  invoices,
  invoiceItems,
  billingSheets,
  workOrders,
  wetCheckBillings,
} from "@workspace/db/schema";
import { storage as storageModule } from "../storage";
import { recordAuditEvent } from "./audit-log";
import { computeBillingSheetTotal } from "../billing-sheet-total";
import { InvoiceSyncError } from "./invoice-sync-quickbooks-route";

export interface RegisterInvoiceCorrectionRoutesDeps {
  requireAuthentication: RequestHandler;
  /** Task #1886: every endpoint in the guided-dispute flow is write-gated,
   *  including its two GETs — they exist only to drive the correction
   *  authoring UI, which is CAN_EDIT_INVOICES-only. */
  requireInvoiceWrite: RequestHandler;
  /** Optional — injected by routes.ts so the qb-sync endpoint can call
   *  updateQbInvoiceInPlace (or buildAndPostQbInvoice) without duplicating
   *  the QB credential/integration plumbing here. */
  syncInvoiceToQb?: (
    invoiceId: number,
    opts: { callerCompanyId: number | null },
  ) => Promise<{ quickbooksId?: string }>;
  /**
   * Test-only injection — uses the module-level `db` singleton in production.
   * Accepts any object that implements the Drizzle fluent builder interface.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _db?: any;
  /**
   * Test-only injection — uses the module-level `storage` singleton in production.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _storageApi?: any;
}

// ── Validation schemas ──────────────────────────────────────────────────────

const openCorrectionSchema = z.object({
  invoiceId: z.number().int().positive(),
});

const REASON_CATEGORIES = [
  "customer_dispute",
  "pricing_error",
  "duplicate_charge",
  "goodwill_credit",
  "scope_change",
  "tech_error",
  "other",
] as const;

const REQUEST_SOURCES = [
  "email",
  "phone",
  "in_person",
  "sms",
  "other",
] as const;

const CORRECTION_LINE_ACTIONS = ["zero_line", "adjust", "exclude"] as const;

const updateCorrectionSchema = z.object({
  status: z.enum(["draft", "reviewed"]).optional(),
  reasonCategory: z.enum(REASON_CATEGORIES).optional(),
  requestSource: z.enum(REQUEST_SOURCES).optional(),
  requestedBy: z.string().max(200).optional(),
  approvedByUserId: z.number().int().positive().optional().nullable(),
  reasonDetail: z.string().max(2000).optional(),
  evidenceUrl: z.string().url().optional().nullable(),
  evidenceNote: z.string().max(1000).optional(),
  lines: z
    .array(
      z.object({
        ticketType: z.enum(["billing_sheet", "work_order", "wcb"]),
        ticketId: z.number().int().positive(),
        beforeParts: z.string().optional(),
        beforeLabor: z.string().optional(),
        beforeTotal: z.string().optional(),
        afterParts: z.string().optional(),
        afterLabor: z.string().optional(),
        afterTotal: z.string().optional(),
        action: z.enum(CORRECTION_LINE_ACTIONS),
        lineNote: z.string().max(500).optional(),
      }),
    )
    .optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @deprecated Task #1739 Amendment — the reissue engine no longer appends a
 * `-R1` suffix.  Corrected invoices keep the same base `invoiceNumber` and
 * increment the `revision` column instead.  This function is retained only so
 * that legacy test fixtures do not need to be removed wholesale; it must not
 * be called from production paths.
 */
export function deriveRevisionNumber(invoiceNumber: string): string {
  const match = invoiceNumber.match(/^(.*)-R(\d+)$/);
  if (match) {
    return `${match[1]}-R${parseInt(match[2]) + 1}`;
  }
  return `${invoiceNumber}-R1`;
}

/** Return the next revision number for a corrected invoice. */
function nextRevision(original: { revision?: number | null }): number {
  return (original.revision ?? 1) + 1;
}

/** Sum ticket totals from live invoice items.
 *  Pass the transaction executor (`tx`) when calling from inside a transaction
 *  so the sum reflects any ticket mutations made earlier in the same tx. */
async function computeLiveTotalsFromTickets(
  invoiceId: number,
  excludedTickets: Array<{ ticketType: string; ticketId: number }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: any = dbModule,
): Promise<{ partsSubtotal: number; laborSubtotal: number; totalAmount: number }> {
  const items = await executor
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId));

  let parts = 0;
  let labor = 0;

  for (const item of items) {
    const isExcluded = excludedTickets.some(
      (e) =>
        (e.ticketType === "billing_sheet" && e.ticketId === item.billingSheetId) ||
        (e.ticketType === "work_order" && e.ticketId === item.workOrderId) ||
        (e.ticketType === "wcb" && e.ticketId === item.wetCheckBillingId),
    );
    if (isExcluded) continue;

    if (item.sourceType === "billing_sheet" && item.billingSheetId) {
      const bs = await executor
        .select({ partsSubtotal: billingSheets.partsSubtotal, laborSubtotal: billingSheets.laborSubtotal })
        .from(billingSheets)
        .where(eq(billingSheets.id, item.billingSheetId))
        .limit(1);
      if (bs[0]) {
        parts += parseFloat(bs[0].partsSubtotal ?? "0");
        labor += parseFloat(bs[0].laborSubtotal ?? "0");
      }
    } else if (item.sourceType === "work_order" && item.workOrderId) {
      const wo = await executor
        .select({ partsSubtotal: workOrders.partsSubtotal, laborSubtotal: workOrders.laborSubtotal })
        .from(workOrders)
        .where(eq(workOrders.id, item.workOrderId))
        .limit(1);
      if (wo[0]) {
        parts += parseFloat(String(wo[0].partsSubtotal ?? "0"));
        labor += parseFloat(String(wo[0].laborSubtotal ?? "0"));
      }
    } else if (item.sourceType === "wet_check_billing" && item.wetCheckBillingId) {
      const wcb = await executor
        .select({ partsSubtotal: wetCheckBillings.partsSubtotal, laborSubtotal: wetCheckBillings.laborSubtotal })
        .from(wetCheckBillings)
        .where(eq(wetCheckBillings.id, item.wetCheckBillingId))
        .limit(1);
      if (wcb[0]) {
        parts += parseFloat(String(wcb[0].partsSubtotal ?? "0"));
        labor += parseFloat(String(wcb[0].laborSubtotal ?? "0"));
      }
    }
  }

  return {
    partsSubtotal: parts,
    laborSubtotal: labor,
    totalAmount: parts + labor,
  };
}

// ── Route registration ────────────────────────────────────────────────────

export function registerInvoiceCorrectionRoutes(
  app: Express,
  deps: RegisterInvoiceCorrectionRoutesDeps,
): void {
  const { requireAuthentication, requireInvoiceWrite, syncInvoiceToQb } = deps;
  // Allow test injection; fall back to module-level singletons in production.
  // Local `db` and `storage` shadow the module-level imports inside this function.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = deps._db ?? dbModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storage: any = deps._storageApi ?? storageModule;
  // ── GET /api/invoices/:invoiceId/correction-tickets ─────────────────────
  // Returns the tickets (billing sheets, work orders, wet check billings)
  // associated with an invoice, formatted for the Dispute step selector.
  app.get(
    "/api/invoices/:invoiceId/correction-tickets",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const invoiceId = parseInt(String(req.params.invoiceId));
        if (isNaN(invoiceId) || invoiceId <= 0) {
          res.status(400).json({ message: "Invalid invoice ID" });
          return;
        }
        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);

        const invoice = await storage.getInvoiceById(invoiceId, callerCompanyId);
        if (!invoice) {
          res.status(404).json({ message: "Invoice not found" });
          return;
        }

        const items = await db
          .select()
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, invoiceId));

        const tickets: Array<{
          ticketType: "billing_sheet" | "work_order" | "wcb";
          ticketId: number;
          description: string;
          workDate: string | null;
          partsSubtotal: string;
          laborSubtotal: string;
          totalAmount: string;
          ticketNumber: string | null;
        }> = [];

        for (const item of items) {
          if (item.sourceType === "billing_sheet" && item.billingSheetId) {
            const bs = await storage.getBillingSheetById(item.billingSheetId, callerCompanyId);
            if (bs && !tickets.find((t) => t.ticketType === "billing_sheet" && t.ticketId === bs.id)) {
              tickets.push({
                ticketType: "billing_sheet",
                ticketId: bs.id,
                description: bs.workDescription ?? "",
                workDate: bs.workDate ? new Date(bs.workDate).toISOString() : null,
                partsSubtotal: bs.partsSubtotal ?? "0.00",
                laborSubtotal: bs.laborSubtotal ?? "0.00",
                totalAmount: bs.totalAmount ?? "0.00",
                ticketNumber: bs.billingNumber ?? null,
              });
            }
          } else if (item.sourceType === "work_order" && item.workOrderId) {
            const wo = await storage.getWorkOrder(item.workOrderId, callerCompanyId);
            if (wo && !tickets.find((t) => t.ticketType === "work_order" && t.ticketId === wo.id)) {
              tickets.push({
                ticketType: "work_order",
                ticketId: wo.id,
                description: wo.projectName ?? wo.description ?? "",
                workDate: wo.completedAt ? new Date(wo.completedAt).toISOString() : null,
                partsSubtotal: wo.partsSubtotal ?? "0.00",
                laborSubtotal: wo.laborSubtotal ?? "0.00",
                totalAmount: wo.totalAmount ?? "0.00",
                ticketNumber: wo.workOrderNumber ?? null,
              });
            }
          } else if (item.sourceType === "wet_check_billing" && item.wetCheckBillingId) {
            const wcb = await storage.getWetCheckBillingById(item.wetCheckBillingId, callerCompanyId);
            if (wcb && !tickets.find((t) => t.ticketType === "wcb" && t.ticketId === wcb.id)) {
              tickets.push({
                ticketType: "wcb",
                ticketId: wcb.id,
                description: wcb.propertyAddress ?? wcb.notes ?? "",
                workDate: wcb.workDate ? new Date(wcb.workDate).toISOString() : null,
                partsSubtotal: wcb.partsSubtotal ?? "0.00",
                laborSubtotal: wcb.laborSubtotal ?? "0.00",
                totalAmount: wcb.totalAmount ?? "0.00",
                ticketNumber: wcb.billingNumber ?? null,
              });
            }
          }
        }

        res.json({ invoiceId, tickets });
      } catch (err) {
        req.log?.error?.({ err }, "correction-tickets fetch failed");
        res.status(500).json({ message: "Failed to fetch invoice tickets" });
      }
    },
  );

  // ── GET /api/invoice-corrections/:id ────────────────────────────────────
  app.get(
    "/api/invoice-corrections/:id",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid correction ID" });
          return;
        }
        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);

        const [correction] = await db
          .select()
          .from(invoiceCorrections)
          .where(
            callerCompanyId != null
              ? and(eq(invoiceCorrections.id, id), eq(invoiceCorrections.companyId, callerCompanyId))
              : eq(invoiceCorrections.id, id),
          )
          .limit(1);

        if (!correction) {
          res.status(404).json({ message: "Correction not found" });
          return;
        }

        const lines = await db
          .select()
          .from(invoiceCorrectionLines)
          .where(eq(invoiceCorrectionLines.correctionId, id));

        res.json({ correction, lines });
      } catch (err) {
        req.log?.error?.({ err }, "correction fetch failed");
        res.status(500).json({ message: "Failed to fetch correction" });
      }
    },
  );

  // ── POST /api/invoice-corrections ───────────────────────────────────────
  // Open a draft correction for an issued invoice. Only one active (non-canceled)
  // correction per invoice at a time.
  app.post(
    "/api/invoice-corrections",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const parsed = openCorrectionSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
          return;
        }

        const { invoiceId } = parsed.data;
        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);

        const invoice = await storage.getInvoiceById(invoiceId, callerCompanyId);
        if (!invoice) {
          res.status(404).json({ message: "Invoice not found" });
          return;
        }

        // Only issued invoices (non-draft, non-cancelled, non-superseded) can
        // be corrected. Task #1847: "sent" is retired as a lifecycle value —
        // invoices that were previously status='sent' are now status='generated'
        // with sentAt populated, so they remain correctable via "generated".
        const correctable = ["paid", "overdue", "generated"];
        if (!correctable.includes(invoice.status)) {
          res.status(400).json({
            message: `Invoice status "${invoice.status}" is not eligible for correction. Only issued invoices can be corrected.`,
          });
          return;
        }

        // Partially-paid invoices have a QBO payment already applied against
        // them. Correcting in-place without first reconciling in QuickBooks
        // would create a mismatch between the recorded payment and the revised
        // invoice amount. The billing manager must void or delete the partial
        // payment in QBO before proceeding.
        if (invoice.paymentStatus === "partially_paid") {
          res.status(409).json({
            message:
              "This invoice has a partial payment recorded in QuickBooks. Reconcile or remove the payment in QBO first, then return here to correct the invoice.",
            code: "PARTIALLY_PAID_RECONCILE_IN_QBO",
          });
          return;
        }

        // Guard against double corrections on the same invoice.
        const existing = await db
          .select({ id: invoiceCorrections.id })
          .from(invoiceCorrections)
          .where(
            and(
              eq(invoiceCorrections.originalInvoiceId, invoiceId),
              eq(invoiceCorrections.status, "draft"),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          res.status(409).json({
            message: "There is already an open draft correction for this invoice.",
            correctionId: existing[0].id,
          });
          return;
        }

        const [correction] = await db
          .insert(invoiceCorrections)
          .values({
            companyId: invoice.companyId,
            customerId: invoice.customerId,
            originalInvoiceId: invoiceId,
            status: "draft",
            qbSyncStatus: "pending",
            createdByUserId: req.authenticatedUserId ?? null,
          })
          .returning();

        res.status(201).json({ correction, lines: [] });
      } catch (err) {
        req.log?.error?.({ err }, "open correction failed");
        res.status(500).json({ message: "Failed to open correction" });
      }
    },
  );

  // ── PATCH /api/invoice-corrections/:id ──────────────────────────────────
  // Update reason fields, evidence, and/or correction line snapshots.
  app.patch(
    "/api/invoice-corrections/:id",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid correction ID" });
          return;
        }

        const parsed = updateCorrectionSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
          return;
        }

        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);

        const [correction] = await db
          .select()
          .from(invoiceCorrections)
          .where(
            callerCompanyId != null
              ? and(eq(invoiceCorrections.id, id), eq(invoiceCorrections.companyId, callerCompanyId))
              : eq(invoiceCorrections.id, id),
          )
          .limit(1);

        if (!correction) {
          res.status(404).json({ message: "Correction not found" });
          return;
        }

        if (correction.status === "canceled" || correction.status === "reissued" || correction.status === "qb_synced") {
          res.status(400).json({ message: `Cannot edit a correction in "${correction.status}" status` });
          return;
        }

        const { lines, ...fields } = parsed.data;

        // Update correction header fields.
        const [updated] = await db
          .update(invoiceCorrections)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(invoiceCorrections.id, id))
          .returning();

        // Replace lines if provided.
        let updatedLines = await db
          .select()
          .from(invoiceCorrectionLines)
          .where(eq(invoiceCorrectionLines.correctionId, id));

        if (lines !== undefined) {
          // Delete existing lines and re-insert.
          await db
            .delete(invoiceCorrectionLines)
            .where(eq(invoiceCorrectionLines.correctionId, id));

          if (lines.length > 0) {
            const lineRows = lines.map((l) => ({
              companyId: correction.companyId,
              correctionId: id,
              ticketType: l.ticketType,
              ticketId: l.ticketId,
              beforeParts: l.beforeParts ?? null,
              beforeLabor: l.beforeLabor ?? null,
              beforeTotal: l.beforeTotal ?? null,
              afterParts: l.afterParts ?? null,
              afterLabor: l.afterLabor ?? null,
              afterTotal: l.afterTotal ?? null,
              action: l.action,
              lineNote: l.lineNote ?? null,
            }));
            updatedLines = await db
              .insert(invoiceCorrectionLines)
              .values(lineRows)
              .returning();
          } else {
            updatedLines = [];
          }
        }

        res.json({ correction: updated, lines: updatedLines });
      } catch (err) {
        req.log?.error?.({ err }, "update correction failed");
        res.status(500).json({ message: "Failed to update correction" });
      }
    },
  );

  // ── POST /api/invoice-corrections/:id/reissue ────────────────────────────
  // Create a corrected invoice that supersedes the original. The base
  // invoiceNumber is kept identical; the new invoice gets revision+1 so the
  // version chain reads #04723 Rev 1 → Rev 2, etc. The original invoice is
  // marked `superseded`. Paid invoices are blocked — use a credit note.
  // Ticket totals are re-derived from live DB state.
  app.post(
    "/api/invoice-corrections/:id/reissue",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid correction ID" });
          return;
        }

        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);

        const [correction] = await db
          .select()
          .from(invoiceCorrections)
          .where(
            callerCompanyId != null
              ? and(eq(invoiceCorrections.id, id), eq(invoiceCorrections.companyId, callerCompanyId))
              : eq(invoiceCorrections.id, id),
          )
          .limit(1);

        if (!correction) {
          res.status(404).json({ message: "Correction not found" });
          return;
        }

        if (correction.status !== "draft" && correction.status !== "reviewed") {
          res.status(400).json({
            message: `Correction is in "${correction.status}" status and cannot be reissued.`,
          });
          return;
        }

        const originalInvoice = await storage.getInvoiceById(correction.originalInvoiceId, callerCompanyId);
        if (!originalInvoice) {
          res.status(404).json({ message: "Original invoice not found" });
          return;
        }

        // Paid invoices cannot be corrected in-place; the customer has already
        // settled the balance. Surface a credit-note stub message so the caller
        // knows the right path forward.
        if (originalInvoice.status === "paid") {
          res.status(400).json({
            message:
              "This invoice has already been paid and cannot be corrected in-place. Issue a credit note to adjust the customer's balance.",
            code: "PAID_INVOICE_USE_CREDIT_NOTE",
          });
          return;
        }

        // Get correction lines to know which tickets to exclude / mutate.
        const lines = await db
          .select()
          .from(invoiceCorrectionLines)
          .where(eq(invoiceCorrectionLines.correctionId, id));

        // ── Source-ticket membership guard ─────────────────────────────────────
        // Validate that every correction line references a ticket that actually
        // belongs to the original invoice.  This prevents a crafted correction
        // on invoice A from mutating unrelated billed tickets in the same company.
        if (lines.length > 0) {
          const memberRows = await db
            .select({
              billingSheetId: invoiceItems.billingSheetId,
              workOrderId: invoiceItems.workOrderId,
              wetCheckBillingId: invoiceItems.wetCheckBillingId,
            })
            .from(invoiceItems)
            .where(eq(invoiceItems.invoiceId, correction.originalInvoiceId));

          const memberTickets = new Set<string>();
          for (const it of memberRows) {
            if (it.billingSheetId != null) memberTickets.add(`billing_sheet:${it.billingSheetId}`);
            if (it.workOrderId != null) memberTickets.add(`work_order:${it.workOrderId}`);
            if (it.wetCheckBillingId != null) memberTickets.add(`wcb:${it.wetCheckBillingId}`);
          }

          const invalidLines = lines.filter(
            (l: any) => !memberTickets.has(`${l.ticketType}:${l.ticketId}`),
          );
          if (invalidLines.length > 0) {
            res.status(400).json({
              message:
                "One or more correction lines reference tickets not belonging to the original invoice.",
              invalidLines: invalidLines.map((l: any) => ({
                ticketType: l.ticketType,
                ticketId: l.ticketId,
              })),
            });
            return;
          }
        }

        const excludedTickets = lines
          .filter((l: any) => l.action === "exclude")
          .map((l: any) => ({ ticketType: l.ticketType, ticketId: l.ticketId }));

        // All mutations (ticket corrections + invoice creation) run inside one
        // transaction so a failure anywhere rolls back every change atomically.
        const result = await db.transaction(async (tx: any) => {
          const txNow = new Date();

          // ── Step 1: Apply source-ticket mutations (zero_line / adjust) ────
          // Edits always write to source tickets; the reissued invoice
          // re-derives totals from live ticket state (architectural invariant).
          for (const line of lines) {
            if (line.action === "exclude") continue;

            if (line.action === "zero_line") {
              if (line.ticketType === "billing_sheet") {
                const [bs] = await tx.select().from(billingSheets)
                  .where(and(eq(billingSheets.id, line.ticketId), eq(billingSheets.companyId, correction.companyId))).limit(1);
                if (bs) {
                  const newTotal = computeBillingSheetTotal({ laborSubtotal: "0.00" }, bs);
                  await tx.update(billingSheets)
                    .set({ laborSubtotal: "0.00", totalAmount: newTotal, updatedAt: txNow })
                    .where(and(eq(billingSheets.id, line.ticketId), eq(billingSheets.companyId, correction.companyId)));
                  await recordAuditEvent(req, {
                    action: "billing_correction",
                    targetType: "billing_sheet",
                    targetId: String(line.ticketId),
                    actorUserId: (req as any).authenticatedUserId ?? null,
                    actorRole: (req as any).authenticatedUserRole ?? null,
                    actorCompanyId: correction.companyId,
                    summary: `Zero-lined labor on billing sheet ${line.ticketId} for correction ${id}${correction.reasonCategory ? ` [${correction.reasonCategory}]` : ""}`,
                    details: { correctionId: id, reasonCategory: correction.reasonCategory ?? null, requestedBy: correction.requestedBy ?? null, evidenceUrl: correction.evidenceUrl ?? null, lineNote: line.lineNote, before: { laborSubtotal: bs.laborSubtotal, totalAmount: bs.totalAmount }, after: { laborSubtotal: "0.00", totalAmount: newTotal } },
                  }, { tx, strict: true });
                }
              } else if (line.ticketType === "work_order") {
                const [wo] = await tx.select({ partsSubtotal: workOrders.partsSubtotal, laborSubtotal: workOrders.laborSubtotal, totalAmount: workOrders.totalAmount })
                  .from(workOrders).where(and(eq(workOrders.id, line.ticketId), eq(workOrders.companyId, correction.companyId))).limit(1);
                if (wo) {
                  const newTotal = (parseFloat(String(wo.partsSubtotal ?? "0")) || 0).toFixed(2);
                  await tx.update(workOrders)
                    .set({ laborSubtotal: "0.00", totalAmount: newTotal, updatedAt: txNow })
                    .where(and(eq(workOrders.id, line.ticketId), eq(workOrders.companyId, correction.companyId)));
                  await recordAuditEvent(req, {
                    action: "billing_correction",
                    targetType: "work_order",
                    targetId: String(line.ticketId),
                    actorUserId: (req as any).authenticatedUserId ?? null,
                    actorRole: (req as any).authenticatedUserRole ?? null,
                    actorCompanyId: correction.companyId,
                    summary: `Zero-lined labor on work order ${line.ticketId} for correction ${id}${correction.reasonCategory ? ` [${correction.reasonCategory}]` : ""}`,
                    details: { correctionId: id, reasonCategory: correction.reasonCategory ?? null, requestedBy: correction.requestedBy ?? null, evidenceUrl: correction.evidenceUrl ?? null, lineNote: line.lineNote, before: { laborSubtotal: wo.laborSubtotal, totalAmount: wo.totalAmount }, after: { laborSubtotal: "0.00", totalAmount: newTotal } },
                  }, { tx, strict: true });
                }
              } else if (line.ticketType === "wcb") {
                const [wcb] = await tx.select({ partsSubtotal: wetCheckBillings.partsSubtotal, laborSubtotal: wetCheckBillings.laborSubtotal, totalAmount: wetCheckBillings.totalAmount })
                  .from(wetCheckBillings).where(and(eq(wetCheckBillings.id, line.ticketId), eq(wetCheckBillings.invoiceId, correction.originalInvoiceId))).limit(1);
                if (wcb) {
                  const newTotal = (parseFloat(String(wcb.partsSubtotal ?? "0")) || 0).toFixed(2);
                  await tx.update(wetCheckBillings)
                    .set({ laborSubtotal: "0.00", totalAmount: newTotal, updatedAt: txNow })
                    .where(and(eq(wetCheckBillings.id, line.ticketId), eq(wetCheckBillings.invoiceId, correction.originalInvoiceId)));
                  await recordAuditEvent(req, {
                    action: "billing_correction",
                    targetType: "wet_check_billing",
                    targetId: String(line.ticketId),
                    actorUserId: (req as any).authenticatedUserId ?? null,
                    actorRole: (req as any).authenticatedUserRole ?? null,
                    actorCompanyId: correction.companyId,
                    summary: `Zero-lined labor on wet check billing ${line.ticketId} for correction ${id}${correction.reasonCategory ? ` [${correction.reasonCategory}]` : ""}`,
                    details: { correctionId: id, reasonCategory: correction.reasonCategory ?? null, requestedBy: correction.requestedBy ?? null, evidenceUrl: correction.evidenceUrl ?? null, lineNote: line.lineNote, before: { laborSubtotal: wcb.laborSubtotal, totalAmount: wcb.totalAmount }, after: { laborSubtotal: "0.00", totalAmount: newTotal } },
                  }, { tx, strict: true });
                }
              }
            } else if (line.action === "adjust") {
              if (line.ticketType === "billing_sheet") {
                const [bs] = await tx.select().from(billingSheets)
                  .where(and(eq(billingSheets.id, line.ticketId), eq(billingSheets.companyId, correction.companyId))).limit(1);
                if (bs) {
                  const patchParts = line.afterParts != null ? String(line.afterParts) : null;
                  const patchLabor = line.afterLabor != null ? String(line.afterLabor) : null;
                  const newTotal = computeBillingSheetTotal({ partsSubtotal: patchParts, laborSubtotal: patchLabor }, bs);
                  const updates: Record<string, unknown> = { totalAmount: newTotal, updatedAt: txNow };
                  if (patchParts != null) updates.partsSubtotal = patchParts;
                  if (patchLabor != null) updates.laborSubtotal = patchLabor;
                  await tx.update(billingSheets).set(updates as any).where(and(eq(billingSheets.id, line.ticketId), eq(billingSheets.companyId, correction.companyId)));
                  await recordAuditEvent(req, {
                    action: "billing_correction",
                    targetType: "billing_sheet",
                    targetId: String(line.ticketId),
                    actorUserId: (req as any).authenticatedUserId ?? null,
                    actorRole: (req as any).authenticatedUserRole ?? null,
                    actorCompanyId: correction.companyId,
                    summary: `Adjusted billing sheet ${line.ticketId} for correction ${id}${correction.reasonCategory ? ` [${correction.reasonCategory}]` : ""}`,
                    details: { correctionId: id, reasonCategory: correction.reasonCategory ?? null, requestedBy: correction.requestedBy ?? null, evidenceUrl: correction.evidenceUrl ?? null, lineNote: line.lineNote, before: { partsSubtotal: bs.partsSubtotal, laborSubtotal: bs.laborSubtotal, totalAmount: bs.totalAmount }, after: { partsSubtotal: patchParts, laborSubtotal: patchLabor, totalAmount: newTotal } },
                  }, { tx, strict: true });
                }
              } else if (line.ticketType === "work_order") {
                const [wo] = await tx.select({ partsSubtotal: workOrders.partsSubtotal, laborSubtotal: workOrders.laborSubtotal, totalAmount: workOrders.totalAmount })
                  .from(workOrders).where(and(eq(workOrders.id, line.ticketId), eq(workOrders.companyId, correction.companyId))).limit(1);
                if (wo) {
                  const patchParts = line.afterParts != null ? String(line.afterParts) : null;
                  const patchLabor = line.afterLabor != null ? String(line.afterLabor) : null;
                  const newParts = parseFloat(String(patchParts ?? wo.partsSubtotal ?? "0")) || 0;
                  const newLabor = parseFloat(String(patchLabor ?? wo.laborSubtotal ?? "0")) || 0;
                  const newTotal = (newParts + newLabor).toFixed(2);
                  const updates: Record<string, unknown> = { totalAmount: newTotal, updatedAt: txNow };
                  if (patchParts != null) updates.partsSubtotal = patchParts;
                  if (patchLabor != null) updates.laborSubtotal = patchLabor;
                  await tx.update(workOrders).set(updates as any).where(and(eq(workOrders.id, line.ticketId), eq(workOrders.companyId, correction.companyId)));
                  await recordAuditEvent(req, {
                    action: "billing_correction",
                    targetType: "work_order",
                    targetId: String(line.ticketId),
                    actorUserId: (req as any).authenticatedUserId ?? null,
                    actorRole: (req as any).authenticatedUserRole ?? null,
                    actorCompanyId: correction.companyId,
                    summary: `Adjusted work order ${line.ticketId} for correction ${id}${correction.reasonCategory ? ` [${correction.reasonCategory}]` : ""}`,
                    details: { correctionId: id, reasonCategory: correction.reasonCategory ?? null, requestedBy: correction.requestedBy ?? null, evidenceUrl: correction.evidenceUrl ?? null, lineNote: line.lineNote, before: { partsSubtotal: wo.partsSubtotal, laborSubtotal: wo.laborSubtotal, totalAmount: wo.totalAmount }, after: { partsSubtotal: patchParts, laborSubtotal: patchLabor, totalAmount: newTotal } },
                  }, { tx, strict: true });
                }
              } else if (line.ticketType === "wcb") {
                const [wcb] = await tx.select({ partsSubtotal: wetCheckBillings.partsSubtotal, laborSubtotal: wetCheckBillings.laborSubtotal, totalAmount: wetCheckBillings.totalAmount })
                  .from(wetCheckBillings).where(and(eq(wetCheckBillings.id, line.ticketId), eq(wetCheckBillings.invoiceId, correction.originalInvoiceId))).limit(1);
                if (wcb) {
                  const patchParts = line.afterParts != null ? String(line.afterParts) : null;
                  const patchLabor = line.afterLabor != null ? String(line.afterLabor) : null;
                  const newParts = parseFloat(String(patchParts ?? wcb.partsSubtotal ?? "0")) || 0;
                  const newLabor = parseFloat(String(patchLabor ?? wcb.laborSubtotal ?? "0")) || 0;
                  const newTotal = (newParts + newLabor).toFixed(2);
                  const updates: Record<string, unknown> = { totalAmount: newTotal, updatedAt: txNow };
                  if (patchParts != null) updates.partsSubtotal = patchParts;
                  if (patchLabor != null) updates.laborSubtotal = patchLabor;
                  await tx.update(wetCheckBillings).set(updates as any).where(and(eq(wetCheckBillings.id, line.ticketId), eq(wetCheckBillings.invoiceId, correction.originalInvoiceId)));
                  await recordAuditEvent(req, {
                    action: "billing_correction",
                    targetType: "wet_check_billing",
                    targetId: String(line.ticketId),
                    actorUserId: (req as any).authenticatedUserId ?? null,
                    actorRole: (req as any).authenticatedUserRole ?? null,
                    actorCompanyId: correction.companyId,
                    summary: `Adjusted wet check billing ${line.ticketId} for correction ${id}${correction.reasonCategory ? ` [${correction.reasonCategory}]` : ""}`,
                    details: { correctionId: id, reasonCategory: correction.reasonCategory ?? null, requestedBy: correction.requestedBy ?? null, evidenceUrl: correction.evidenceUrl ?? null, lineNote: line.lineNote, before: { partsSubtotal: wcb.partsSubtotal, laborSubtotal: wcb.laborSubtotal, totalAmount: wcb.totalAmount }, after: { partsSubtotal: patchParts, laborSubtotal: patchLabor, totalAmount: newTotal } },
                  }, { tx, strict: true });
                }
              }
            }
          }

          // ── Step 2: Re-derive live totals using the tx executor so the sum
          //    reflects ticket mutations made in Step 1 (tx reads own writes).
          const liveTotals = await computeLiveTotalsFromTickets(
            correction.originalInvoiceId,
            excludedTickets,
            tx,
          );

          // ── Step 3: Mark original as superseded.
          await tx
            .update(invoices)
            .set({ status: "superseded", updatedAt: txNow })
            .where(eq(invoices.id, correction.originalInvoiceId));

          // ── Step 4: Create the new invoice.
          // - status is "generated" (not "draft") so it's immediately billable.
          // - QB linkage carried forward: same quickbooksInvoiceId + SyncToken so
          //   the qb-sync endpoint can call updateQbInvoiceInPlace in-place rather
          //   than creating a duplicate QB invoice.
          const [newInvoice] = await tx
            .insert(invoices)
            .values({
              // Stable number protocol: same base number, revision bumped.
              invoiceNumber: originalInvoice.invoiceNumber,
              revision: nextRevision(originalInvoice),
              customerId: originalInvoice.customerId,
              companyId: originalInvoice.companyId,
              customerName: originalInvoice.customerName,
              customerEmail: originalInvoice.customerEmail,
              customerPhone: originalInvoice.customerPhone ?? null,
              invoiceMonth: originalInvoice.invoiceMonth,
              invoiceYear: originalInvoice.invoiceYear,
              periodStart: originalInvoice.periodStart,
              periodEnd: originalInvoice.periodEnd,
              status: "generated",
              partsSubtotal: liveTotals.partsSubtotal.toFixed(2),
              laborSubtotal: liveTotals.laborSubtotal.toFixed(2),
              totalAmount: liveTotals.totalAmount.toFixed(2),
              dueDate: originalInvoice.dueDate ?? null,
              quickbooksInvoiceId: (originalInvoice as any).quickbooksInvoiceId ?? null,
              quickbooksSyncToken: (originalInvoice as any).quickbooksSyncToken ?? null,
            })
            .returning();

          // Copy invoice items (excluding excluded tickets) to the new invoice.
          const originalItems = await tx
            .select()
            .from(invoiceItems)
            .where(eq(invoiceItems.invoiceId, correction.originalInvoiceId));

          for (const item of originalItems) {
            const isExcluded = excludedTickets.some(
              (e: any) =>
                (e.ticketType === "billing_sheet" && e.ticketId === item.billingSheetId) ||
                (e.ticketType === "work_order" && e.ticketId === item.workOrderId) ||
                (e.ticketType === "wcb" && e.ticketId === item.wetCheckBillingId),
            );
            if (isExcluded) continue;

            // Re-derive item total from live ticket.
            let itemTotal = parseFloat(String(item.totalPrice ?? "0"));
            if (item.sourceType === "billing_sheet" && item.billingSheetId) {
              const [bs] = await tx
                .select({ totalAmount: billingSheets.totalAmount })
                .from(billingSheets)
                .where(eq(billingSheets.id, item.billingSheetId))
                .limit(1);
              if (bs) itemTotal = parseFloat(String(bs.totalAmount ?? "0"));
            } else if (item.sourceType === "work_order" && item.workOrderId) {
              const [wo] = await tx
                .select({ totalAmount: workOrders.totalAmount })
                .from(workOrders)
                .where(eq(workOrders.id, item.workOrderId))
                .limit(1);
              if (wo) itemTotal = parseFloat(String(wo.totalAmount ?? "0"));
            } else if (item.sourceType === "wet_check_billing" && item.wetCheckBillingId) {
              const [wcb] = await tx
                .select({ totalAmount: wetCheckBillings.totalAmount })
                .from(wetCheckBillings)
                .where(eq(wetCheckBillings.id, item.wetCheckBillingId))
                .limit(1);
              if (wcb) itemTotal = parseFloat(String(wcb.totalAmount ?? "0"));
            }

            await tx.insert(invoiceItems).values({
              invoiceId: newInvoice.id,
              sourceType: item.sourceType,
              sourceId: item.sourceId,
              workOrderId: item.workOrderId ?? null,
              billingSheetId: item.billingSheetId ?? null,
              wetCheckBillingId: item.wetCheckBillingId ?? null,
              workDate: item.workDate,
              description: item.description,
              totalPrice: itemTotal.toFixed(2),
            });

            // Re-point the source ticket's invoiceId to the new invoice so
            // it's not double-billed on the next monthly run.
            if (item.sourceType === "billing_sheet" && item.billingSheetId) {
              await tx
                .update(billingSheets)
                .set({ invoiceId: newInvoice.id, updatedAt: new Date() })
                .where(eq(billingSheets.id, item.billingSheetId));
            } else if (item.sourceType === "work_order" && item.workOrderId) {
              await tx
                .update(workOrders)
                .set({ invoiceId: newInvoice.id, updatedAt: new Date() })
                .where(eq(workOrders.id, item.workOrderId));
            } else if (item.sourceType === "wet_check_billing" && item.wetCheckBillingId) {
              await tx
                .update(wetCheckBillings)
                .set({ invoiceId: newInvoice.id, updatedAt: new Date() })
                .where(eq(wetCheckBillings.id, item.wetCheckBillingId));
            }
          }

          // Stamp the original invoice with the superseded-by link so the
          // version chain is navigable without string-parsing invoice numbers.
          await tx
            .update(invoices)
            .set({ supersededByInvoiceId: newInvoice.id, updatedAt: txNow })
            .where(eq(invoices.id, correction.originalInvoiceId));

          // Finalize the correction record.
          const originalTotal = parseFloat(String(originalInvoice.totalAmount));
          const correctedTotal = liveTotals.totalAmount;
          const [updatedCorrection] = await tx
            .update(invoiceCorrections)
            .set({
              status: "reissued",
              reissuedInvoiceId: newInvoice.id,
              originalTotal: originalTotal.toFixed(2),
              correctedTotal: correctedTotal.toFixed(2),
              deltaAmount: (correctedTotal - originalTotal).toFixed(2),
              updatedAt: new Date(),
            })
            .where(eq(invoiceCorrections.id, id))
            .returning();

          return { correction: updatedCorrection, reissuedInvoice: newInvoice };
        });

        res.status(200).json({
          message: `Invoice #${result.reissuedInvoice?.invoiceNumber} Rev ${result.reissuedInvoice?.revision} created.`,
          correction: result.correction,
          reissuedInvoice: result.reissuedInvoice,
          originalInvoiceId: correction.originalInvoiceId,
        });
      } catch (err) {
        req.log?.error?.({ err }, "reissue correction failed");
        res.status(500).json({ message: "Failed to reissue correction" });
      }
    },
  );

  // ── POST /api/invoice-corrections/:id/qb-sync ────────────────────────────
  // Syncs the reissued invoice to QuickBooks in-place (never creates a duplicate).
  // The reissued invoice carries the original QB id + SyncToken so the shared
  // syncInvoiceToQb helper routes to updateQbInvoiceInPlace automatically.
  // If syncInvoiceToQb was not injected (e.g. tests), falls back to 501.
  app.post(
    "/api/invoice-corrections/:id/qb-sync",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid correction ID" });
          return;
        }

        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);

        const [correction] = await db
          .select()
          .from(invoiceCorrections)
          .where(
            callerCompanyId != null
              ? and(eq(invoiceCorrections.id, id), eq(invoiceCorrections.companyId, callerCompanyId))
              : eq(invoiceCorrections.id, id),
          )
          .limit(1);

        if (!correction) {
          res.status(404).json({ message: "Correction not found" });
          return;
        }

        if (correction.status !== "reissued") {
          res.status(400).json({
            message: "Only reissued corrections can be QB-synced. Complete the reissue step first.",
          });
          return;
        }

        if (!correction.reissuedInvoiceId) {
          res.status(400).json({ message: "No reissued invoice id on correction record." });
          return;
        }

        if (!syncInvoiceToQb) {
          // syncInvoiceToQb not injected (e.g. test environment). Mark skipped.
          await db
            .update(invoiceCorrections)
            .set({ qbSyncStatus: "skipped", qbNote: "QB sync not available in this environment.", updatedAt: new Date() })
            .where(eq(invoiceCorrections.id, id));
          res.status(501).json({
            message: "QuickBooks sync is not available in this environment.",
            qbSyncStatus: "skipped",
          });
          return;
        }

        // Delegate to the shared sync function. Because the reissued invoice
        // carries the original quickbooksInvoiceId, this routes to in-place
        // update (updateQbInvoiceInPlace) rather than creating a new QB record.
        const syncResult = await syncInvoiceToQb(correction.reissuedInvoiceId, { callerCompanyId });

        await db
          .update(invoiceCorrections)
          .set({
            qbSyncStatus: "synced",
            qbNote: null,
            updatedAt: new Date(),
          })
          .where(eq(invoiceCorrections.id, id));

        res.status(200).json({
          message: "QuickBooks invoice updated in-place.",
          qbSyncStatus: "synced",
          quickbooksId: syncResult.quickbooksId,
        });
      } catch (err: any) {
        req.log?.error?.({ err }, "qb-sync correction failed");
        // Mark the correction so operators know it needs a retry.
        await db
          .update(invoiceCorrections)
          .set({
            qbSyncStatus: "failed",
            qbNote: err?.message ?? "Unknown error during QB sync.",
            updatedAt: new Date(),
          })
          .where(eq(invoiceCorrections.id, parseInt(String(req.params.id))));
        const isAuthError = err instanceof InvoiceSyncError && err.httpStatus === 401;
        // Use 400 (not 401) for QB credential errors so the client's global
        // session-expired redirect does not fire for an integration failure.
        const httpStatus = isAuthError ? 400 : 502;
        res.status(httpStatus).json({
          message: err?.message ?? "QB sync failed. Retry the endpoint once the issue is resolved.",
          ...(isAuthError ? { code: "QB_AUTH_EXPIRED" } : {}),
        });
      }
    },
  );

  // ── POST /api/invoice-corrections/:id/cancel ─────────────────────────────
  // Cancel a draft correction. The original invoice is NOT modified;
  // tickets remain in their (possibly edited) state.
  app.post(
    "/api/invoice-corrections/:id/cancel",
    requireAuthentication,
    requireInvoiceWrite,
    async (req: any, res) => {
      try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id) || id <= 0) {
          res.status(400).json({ message: "Invalid correction ID" });
          return;
        }

        const callerCompanyId: number | null =
          req.authenticatedUserRole === "super_admin"
            ? null
            : (req.authenticatedUserCompanyId ?? null);

        const [correction] = await db
          .select()
          .from(invoiceCorrections)
          .where(
            callerCompanyId != null
              ? and(eq(invoiceCorrections.id, id), eq(invoiceCorrections.companyId, callerCompanyId))
              : eq(invoiceCorrections.id, id),
          )
          .limit(1);

        if (!correction) {
          res.status(404).json({ message: "Correction not found" });
          return;
        }

        if (correction.status === "reissued" || correction.status === "qb_synced") {
          res.status(400).json({
            message: `Cannot cancel a correction that has already been ${correction.status}.`,
          });
          return;
        }

        if (correction.status === "canceled") {
          res.status(400).json({ message: "Correction is already canceled." });
          return;
        }

        const [updated] = await db
          .update(invoiceCorrections)
          .set({ status: "canceled", updatedAt: new Date() })
          .where(eq(invoiceCorrections.id, id))
          .returning();

        res.json({ correction: updated, message: "Correction canceled." });
      } catch (err) {
        req.log?.error?.({ err }, "cancel correction failed");
        res.status(500).json({ message: "Failed to cancel correction" });
      }
    },
  );
}

// ── Exported helper: check if an invoiced ticket can be unlocked ──────────
// Used by billing-sheet item update routes to allow edits inside a correction.
export async function getOpenCorrectionForInvoice(
  invoiceId: number,
  companyId: number | null,
): Promise<{ id: number } | null> {
  const where =
    companyId != null
      ? and(
          eq(invoiceCorrections.originalInvoiceId, invoiceId),
          eq(invoiceCorrections.status, "draft"),
          eq(invoiceCorrections.companyId, companyId),
        )
      : and(
          eq(invoiceCorrections.originalInvoiceId, invoiceId),
          eq(invoiceCorrections.status, "draft"),
        );

  const rows = await dbModule
    .select({ id: invoiceCorrections.id })
    .from(invoiceCorrections)
    .where(where)
    .limit(1);

  return rows[0] ?? null;
}
