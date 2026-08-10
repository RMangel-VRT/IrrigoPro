// Task #1886 — capability-backed route guards.
//
// Extracted from the routes.ts monolith so they can be mounted on a bare
// Express app and asserted against real HTTP responses, instead of being
// re-implemented (and silently drifting) inside each test file. routes.ts
// imports these; there is no second copy.
//
// Every guard asks the shared role registry what a role *can do* rather than
// comparing role strings. See lib/shared/src/roles.ts for the membership and
// the reasoning behind each capability set.

import type { Request } from "express";

// Deliberately `(req: any, res: any, next: any)` rather than Express's
// `RequestHandler`. Typing these as RequestHandler changes which `app.get`
// overload TypeScript selects at every call site, which re-types `req.params`
// as `string | string[]` and breaks ~6 unrelated handlers. Same signature the
// guards had inline in routes.ts.
type Guard = (req: any, res: any, next: any) => void;
import {
  hasCapability,
  CAN_READ_INVOICES,
  CAN_EDIT_INVOICES,
  CAN_SEND_INVOICE_EMAIL,
  CAN_MANAGE_QUICKBOOKS,
} from "@workspace/shared";

// ── header auth (dev only) ───────────────────────────────────────────────────
//
// Header auth is a development affordance. In production the ONLY auth
// surfaces are bearer tokens and server-side sessions, and these helpers
// return undefined so a forged x-user-* header can never grant anything.

export function isHeaderAuthAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function headerUserRole(req: Request): string | undefined {
  if (!isHeaderAuthAllowed()) return undefined;
  const v = req.headers["x-user-role"];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

// ── invoice guards ───────────────────────────────────────────────────────────
//
// The former `requireBillingAccess` did double duty: it gated invoice reads
// (list, detail, PDF) and invoice mutations (create, edit, correct, void,
// merge) behind a single company_admin / billing_manager check. It is now
// split so a read-only role (bookkeeper) and a role that needs invoice history
// but no authoring power (irrigation_manager) can be admitted to reads without
// also gaining write authority.
//
// The response body and status code are deliberately identical across all
// three, and identical to the old guard, so existing behaviour and tests are
// undisturbed.
const DENIED = {
  message:
    "Access denied. Only company administrators and billing managers can access invoice PDFs.",
} as const;

/**
 * Read an invoice, its line items, its audit trail, or its PDF.
 * Backed by CAN_READ_INVOICES — admits irrigation_manager and bookkeeper in
 * addition to the old membership.
 */
export const requireInvoiceRead: Guard = (req, res, next) => {
  if (!hasCapability(req.authenticatedUserRole, CAN_READ_INVOICES)) {
    res.status(403).json(DENIED);
    return;
  }
  next();
};

/**
 * Create, edit, correct, void, merge, delete, or otherwise mutate an invoice.
 * Backed by CAN_EDIT_INVOICES — exactly the old requireBillingAccess
 * membership (super_admin / company_admin / billing_manager), unchanged.
 */
export const requireInvoiceWrite: Guard = (req, res, next) => {
  if (!hasCapability(req.authenticatedUserRole, CAN_EDIT_INVOICES)) {
    res.status(403).json(DENIED);
    return;
  }
  next();
};

/**
 * Send an invoice to the customer / mark it sent. Backed by
 * CAN_SEND_INVOICE_EMAIL — delivering an invoice is not authoring one, so the
 * bookkeeper is admitted here but refused by requireInvoiceWrite.
 */
export const requireInvoiceSend: Guard = (req, res, next) => {
  if (!hasCapability(req.authenticatedUserRole, CAN_SEND_INVOICE_EMAIL)) {
    res.status(403).json(DENIED);
    return;
  }
  next();
};

// ── QuickBooks guard ─────────────────────────────────────────────────────────
//
// This was a DENYLIST: it refused irrigation_manager and field_tech by name
// and called next() for everything else, so any role it did not happen to
// name — a new role, an unrecognised role string, or a missing role — passed
// by accident.
//
// Membership for the pre-existing roles is unchanged: CAN_MANAGE_QUICKBOOKS is
// exactly the set that passed the denylist, and irrigation_manager /
// field_tech are still refused — now by absence rather than by being named.
//
// The undefined-role case is the point of this change, not a regression.
// `headerUserRole` returns undefined whenever header auth is disallowed (i.e.
// in production), and one of the role assignments in requireAuthentication is
// a local that is not guaranteed to be populated. Under the denylist that
// undefined fell through to next(); under the allowlist hasCapability(undefined)
// is false and it is refused. Do NOT re-add a null/undefined special case — a
// caller that needs one is relying on an authorization bypass.
export const requireQuickBooksAccess: Guard = (req, res, next) => {
  const userRole = req.authenticatedUserRole || headerUserRole(req);

  if (!hasCapability(userRole, CAN_MANAGE_QUICKBOOKS)) {
    res.status(403).json({
      message: "Access denied. QuickBooks integration is not available for your role.",
    });
    return;
  }

  next();
};
