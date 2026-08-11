// Task #1889 — A/R note field inventory.
//
// The exact counterpart of `pricing-fields.ts`, and it exists for exactly the
// same reason: some JSON keys must not reach some roles, and the only reliable
// way to guarantee that is to name the keys in one place and strip them on the
// way out rather than to hope every call site remembers.
//
// The stripped surface here is the invoice list. A role without
// `CAN_READ_AR_NOTES` must not receive the note count or the preview text —
// not "receive them and have the client hide the badge". An irrigation manager
// can read invoices, so they reach the list endpoint legitimately; they must
// still not learn from a badge that a payment dispute is in flight.
//
// IMPORTANT: any new key that carries A/R note content or its existence onto a
// response payload must be added here.

export const AR_NOTE_FIELDS_BY_SHAPE = {
  // The annotated invoice row served by GET /api/invoices.
  invoiceListRow: [
    // How many internal notes the invoice has. A non-zero count is itself the
    // disclosure — "there is a conversation about this customer" — so the key
    // is absent, not zeroed, for a role without the capability.
    "arNoteCount",
    // ISO timestamp of the most recent note.
    "lastArNoteAt",
    // Truncated text of the most recent note, used for the hover preview.
    "lastArNotePreview",
  ],
} as const;

export const AR_NOTE_FIELDS_TO_STRIP: ReadonlySet<string> = new Set(
  Object.values(AR_NOTE_FIELDS_BY_SHAPE).flat(),
);
