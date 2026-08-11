// Task #1889 — internal A/R notes on an invoice.
//
//   GET  /api/invoices/:id/ar-notes  — the thread, newest first.
//   POST /api/invoices/:id/ar-notes  — append one.
//
// THAT IS THE COMPLETE ROUTE LIST, AND IT IS COMPLETE ON PURPOSE. There is no
// PUT, no PATCH and no DELETE here, and there must never be one — not a soft
// delete, not an admin override, not a "fix a typo" affordance. The thread is
// the record of how a collection was chased; a record that can be rewritten
// after the fact is not a record. Append-only is enforced by the absence of a
// mutation path, not by a flag someone can forget to check.
//
// Two other rules shape this module:
//
//   1. The invoice is resolved through the company-scoped fetch BEFORE any
//      note is read or written. A caller in company A asking about a company B
//      invoice gets a 404 and never touches a note row, in either direction.
//   2. Both endpoints are gated on CAN_READ_AR_NOTES, which is NARROWER than
//      invoice read. An irrigation_manager can read the invoice and is refused
//      here. See lib/shared/src/roles.ts for why that difference is deliberate.
//
// These notes are internal. Nothing in this module feeds the PDF pipeline, a
// mailer, or any customer-facing export, and nothing there may read them.

import type { Express, RequestHandler } from "express";
import { storage as storageModule } from "../storage";

/** Longer than any real follow-up note; short enough to stop a paste bomb. */
export const AR_NOTE_MAX_LENGTH = 4000;

/** How much of the most recent note the list indicator previews. */
export const AR_NOTE_PREVIEW_LENGTH = 160;

/**
 * The preview text the A/R list shows on hover.
 *
 * Shared with the list endpoint so the badge and the thread can never disagree
 * about which note is the latest one or how it is truncated.
 */
export function arNotePreview(text: string): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= AR_NOTE_PREVIEW_LENGTH) return flat;
  return `${flat.slice(0, AR_NOTE_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

// ── Wire shape ──────────────────────────────────────────────────────────────

export interface ArNoteRow {
  id: number;
  invoiceId: number;
  note: string;
  authorUserId: number | null;
  authorName: string | null;
  createdAt: string;
}

export function toArNoteRow(r: any): ArNoteRow {
  return {
    id: r.id,
    invoiceId: r.invoiceId,
    note: r.note,
    authorUserId: r.authorUserId ?? null,
    // Captured at write time, so the thread stays attributable after the
    // author is renamed or deactivated.
    authorName: r.authorName ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface RegisterInvoiceArNoteRoutesDeps {
  requireAuthentication: RequestHandler;
  /** CAN_READ_AR_NOTES — narrower than invoice read. Gates BOTH endpoints. */
  requireArNotesAccess: RequestHandler;
  /** Test seam. Production passes none of these. */
  _storageApi?: any;
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerInvoiceArNoteRoutes(
  app: Express,
  deps: RegisterInvoiceArNoteRoutesDeps,
): void {
  const storage = deps._storageApi ?? storageModule;

  /** Company scope for the fetch. super_admin sees every company. */
  function callerCompanyId(req: any): number | null {
    return req.authenticatedUserRole === "super_admin"
      ? null
      : (req.authenticatedUserCompanyId ?? null);
  }

  function parseId(req: any, res: any): number | null {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ message: "Invalid invoice ID" });
      return null;
    }
    return id;
  }

  // ── Read the thread ───────────────────────────────────────────────────────

  app.get(
    "/api/invoices/:id/ar-notes",
    deps.requireAuthentication,
    deps.requireArNotesAccess,
    async (req: any, res) => {
      try {
        const id = parseId(req, res);
        if (id == null) return;

        // Company-scoped resolution first. A cross-company id is a 404 and no
        // note row is ever selected for it.
        const invoice = await storage.getInvoiceById(id, callerCompanyId(req));
        if (!invoice) {
          res.status(404).json({ message: "Invoice not found" });
          return;
        }

        const rows = await storage.getInvoiceArNotes(id, callerCompanyId(req));
        res.json({
          notes: (rows ?? []).map(toArNoteRow),
          // Stated on the wire so the client never has to decide for itself
          // whether these are printed. They are not.
          internalOnly: true,
        });
      } catch (error) {
        console.error("Error loading invoice A/R notes:", error);
        res.status(500).json({ message: "Failed to load A/R notes" });
      }
    },
  );

  // ── Append to the thread ──────────────────────────────────────────────────

  app.post(
    "/api/invoices/:id/ar-notes",
    deps.requireAuthentication,
    deps.requireArNotesAccess,
    async (req: any, res) => {
      try {
        const id = parseId(req, res);
        if (id == null) return;

        const invoice = await storage.getInvoiceById(id, callerCompanyId(req));
        if (!invoice) {
          res.status(404).json({ message: "Invoice not found" });
          return;
        }

        const raw = (req.body ?? {}).note;
        const note = typeof raw === "string" ? raw.trim() : "";
        if (note === "") {
          res.status(400).json({ message: "A note cannot be empty." });
          return;
        }
        if (note.length > AR_NOTE_MAX_LENGTH) {
          res.status(400).json({
            message: `A note can be at most ${AR_NOTE_MAX_LENGTH} characters. This one is ${note.length}.`,
          });
          return;
        }

        // Who wrote it, captured by name as well as id — the thread has to stay
        // readable after a user is deactivated or renamed.
        const authorUserId: number | null =
          typeof req.authenticatedUserId === "number" ? req.authenticatedUserId : null;
        let authorName: string | null = null;
        if (authorUserId != null) {
          try {
            authorName = (await storage.getUser(authorUserId))?.name ?? null;
          } catch {
            authorName = null;
          }
        }

        // companyId comes off the resolved invoice, never off the request. A
        // note therefore lands in the company that owns the invoice, which is
        // the same company the reader is scoped to.
        const saved = await storage.createInvoiceArNote({
          companyId: invoice.companyId,
          invoiceId: id,
          authorUserId,
          authorName,
          note,
        });

        res.status(201).json({ note: toArNoteRow(saved) });
      } catch (error) {
        console.error("Error appending invoice A/R note:", error);
        res.status(500).json({ message: "Failed to add A/R note" });
      }
    },
  );
}
