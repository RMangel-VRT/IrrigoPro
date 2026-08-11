// Task #1889 — server-side stripping of internal A/R note fields.
//
// The same shape as the pricing strip in routes.ts, and here for the same
// reason: some JSON keys must not reach some roles, and the only reliable way
// to guarantee that is to name the keys in one place (AR_NOTE_FIELDS_TO_STRIP,
// in lib/db/src/ar-note-fields.ts) and delete them on the way out.
//
// The role this exists for is `irrigation_manager`. They hold
// CAN_READ_INVOICES, so they reach the A/R list legitimately; they do not hold
// CAN_READ_AR_NOTES. A note count of 3 on one of their rows would tell them a
// payment dispute is in flight — precisely the disclosure the narrower
// capability exists to prevent. So the keys leave the payload entirely rather
// than being sent and hidden by the client.
//
// This lives in its own module, rather than beside applyPricingVisibility in
// routes.ts, so the leak-proof tests can exercise the real function instead of
// a copy of it that can quietly drift out of step with production.

import { AR_NOTE_FIELDS_TO_STRIP } from "@workspace/db";
import { hasCapability, CAN_READ_AR_NOTES } from "@workspace/shared";
import { headerUserRole } from "./role-guards";

export function sanitizeArNoteFieldsInPlace(data: any, seen?: WeakSet<object>): any {
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;

  // Defensive guard against the rare object cycle. The WeakSet is created
  // lazily so the common acyclic case pays nothing.
  if (seen && seen.has(data)) return data;
  const tracker = seen ?? new WeakSet<object>();
  tracker.add(data);

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      sanitizeArNoteFieldsInPlace(data[i], tracker);
    }
    return data;
  }

  for (const key of Object.keys(data)) {
    if (AR_NOTE_FIELDS_TO_STRIP.has(key)) {
      delete data[key];
      continue;
    }
    const value = data[key];
    if (value !== null && typeof value === "object") {
      sanitizeArNoteFieldsInPlace(value, tracker);
    }
  }
  return data;
}

/**
 * Fast path is the ALLOWED case here, the opposite of the pricing strip: most
 * callers of the A/R list are billing staff and there is nothing to do for
 * them. An unknown or missing role is not allowed — `hasCapability` is
 * safe-by-default — so a caller we cannot identify gets the stripped payload.
 */
export function applyArNoteVisibility(req: any, data: any): any {
  const role = req?.authenticatedUserRole || headerUserRole(req);
  if (hasCapability(role, CAN_READ_AR_NOTES)) return data;
  return sanitizeArNoteFieldsInPlace(data);
}
