# Invoice page — capability audit (AR-first layout)

Every control rendered by `artifacts/irrigopro/src/pages/invoices.tsx` after the
AR-first redesign, the capability that decides whether it renders, and the
endpoint it calls. The rule being checked is one-directional: **a control's
gate must not be looser than the guard on the endpoint behind it.** A looser
gate is a button that 403s, which is the failure mode the invoice page has
already been burned by twice.

The mapping is also asserted in code — `invoices-ar-first-layout.test.tsx`,
`describe("role rendering matrix")` and
`describe("no rendered control reaches an endpoint its role cannot")` — so it
cannot drift silently. The table below is the human-readable copy plus the
reasoning that does not fit in an assertion.

## Header

| Control | Gate | Endpoint | Endpoint guard |
| --- | --- | --- | --- |
| Outstanding balance | none (invoice read) | `GET /api/invoices/aging-summary` | `requireInvoiceRead` |
| Open invoice count | none (invoice read) | `GET /api/invoices/aging-summary` | `requireInvoiceRead` |
| QuickBooks freshness pill | `CAN_MANAGE_QUICKBOOKS` | `GET /api/invoices/aging-summary` (`lastPaymentSyncAt`, company-wide) | `requireInvoiceRead` |
| Refresh QB Payments | `CAN_MANAGE_QUICKBOOKS` | `POST /api/invoices/sync-payment-status` | `requireQuickBooksAccess` |
| Export CSV (page) | none (invoice read) | — (client-side, from loaded rows) | n/a |

### The QuickBooks surface, and how it was brought onto one gate

The ticket asks for the pill *and* the sync button to be gated on
`CAN_MANAGE_QUICKBOOKS`. As shipped, `POST /api/invoices/sync-payment-status`
sat behind `requireInvoiceWrite` (`CAN_EDIT_INVOICES`, which excludes
`bookkeeper`), so gating the button on the wider capability would have rendered
a control the server refuses — a looser-gate-than-endpoint violation.

Rather than split the two, the route was re-gated to `requireQuickBooksAccess`
(`CAN_MANAGE_QUICKBOOKS`). The write it performs is not authoring an invoice:
it copies QuickBooks' own payment state back onto rows QuickBooks owns, and
the person answerable for that connection — including the bookkeeper, whose
page this is — is who should be able to refresh it. Membership only widens:
`CAN_EDIT_INVOICES` ⊂ `CAN_MANAGE_QUICKBOOKS`, so no caller who could sync
before lost the ability, and no role gains an invoice write.

The same reasoning applies to the per-invoice push, `POST
/api/invoices/:id/sync-quickbooks`, which was also re-gated to
`requireQuickBooksAccess`: it changes nothing about the IrrigoPro record, it
writes into QuickBooks, and it sits in the row beside the pill and the payment
sync. Leaving it on `requireInvoiceWrite` split one surface across two
capabilities and handed the bookkeeper a payment sync she could run beside a
resync she could not. Membership only widens here too.

The whole QuickBooks surface — connection, payment-status sync, freshness
pill, per-invoice push — is therefore on `CAN_MANAGE_QUICKBOOKS`, and a role
with neither sees none of it: no disabled controls, as specified.

## Aging strip

| Control | Gate | Endpoint | Endpoint guard |
| --- | --- | --- | --- |
| Bucket card (×4) | none (invoice read) | `GET /api/invoices/aging-summary` | `requireInvoiceRead` |

Clicking a card only writes `?aging=`; the filtered read is the same list
endpoint the page already uses.

## Filter bar

| Control | Gate | Endpoint | Endpoint guard |
| --- | --- | --- | --- |
| Search, Filters popover, every filter control, chips, Clear all | none (invoice read) | `GET /api/invoices` | `requireInvoiceRead` |

Filters are presentation over a read the role already holds. Every one of them
— including the search box and the billing month, which used to filter the
loaded rows in the browser — is written to the URL and applied by the server,
so the list, the aging aggregate and the select-all fetch all narrow the same
set. A browser-only filter beside a server-side aggregate makes the header
total and a multi-page select-all describe rows the user never saw. Note fields are
stripped from the response by `ar-note-visibility.ts` for roles without
`CAN_READ_AR_NOTES`, so the "has notes" surface is absent from the payload
rather than hidden in the client.

## Row

| Control | Gate | Endpoint | Endpoint guard |
| --- | --- | --- | --- |
| Selection checkbox | `CAN_EDIT_INVOICES ∪ CAN_SEND_INVOICE_EMAIL` (`canSelectRows`) | merge / batch reminders | `requireInvoiceWrite` / `requireInvoiceSend` |
| Primary action (Send / Remind / In N days) | `CAN_SEND_INVOICE_EMAIL` | `POST /api/invoices/:id/reminders`, `POST /api/invoices/:id/pdf/send` | `requireInvoiceSend` |
| Primary action *state* | — | `GET /api/invoices/reminder-eligibility` | `requireReminderHistoryRead ?? requireInvoiceSend` |
| View PDF (inline) | none (invoice read) | `GET /api/invoices/:id/pdf` | `requireInvoiceRead` |
| Resync to QuickBooks (inline) | `CAN_MANAGE_QUICKBOOKS` | `POST /api/invoices/:id/sync-quickbooks` | `requireQuickBooksAccess` |
| Note indicator | `CAN_READ_AR_NOTES` (enforced server-side by field stripping) | `GET /api/invoices/:id/ar-notes` | `requireArNoteRead` |
| Kebab → Mark sent | `CAN_SEND_INVOICE_EMAIL` | `POST /api/invoices/:id/mark-sent` | `requireInvoiceSend` |
| Kebab → Mark unsent | `CAN_EDIT_INVOICES` | `PATCH /api/invoices/:id` | `requireInvoiceWrite` |
| Kebab → Export CSV (single) | `CAN_VIEW_COSTS` | `GET /api/invoices/:id/audit` | cost/margin visibility |
| Kebab → Sync / Resync QuickBooks | `CAN_MANAGE_QUICKBOOKS` | `POST /api/invoices/:id/sync-quickbooks` | `requireQuickBooksAccess` |
| Kebab → Correct | `CAN_EDIT_INVOICES` | `POST /api/invoices/:id/correct` | `requireInvoiceWrite` |
| Kebab → Edit metadata | `CAN_EDIT_INVOICES` | `PATCH /api/invoices/:id` | `requireInvoiceWrite` |
| Kebab → Attach tickets | `CAN_EDIT_INVOICES` | draft ticket routes | `requireInvoiceWrite` |
| Kebab → Return to draft | `CAN_EDIT_INVOICES` | `POST /api/invoices/:id/return-to-draft` | `requireInvoiceWrite` |
| Kebab → Finalize | `CAN_EDIT_INVOICES` | `POST /api/invoices/:id/finalize` | `requireInvoiceWrite` |
| Kebab → Void | `CAN_EDIT_INVOICES` | `POST /api/invoices/:id/void` | `requireInvoiceWrite` |
| Kebab → Audit trail | `CAN_VIEW_COSTS` | `GET /api/invoices/:id/audit` | cost/margin visibility |

The single-invoice CSV was previously gated on a hard-coded role list
(`CSV_EXPORT_ROLES`). It is built from the audit endpoint's cost and margin
data, so it now resolves through `CAN_VIEW_COSTS` — the same set the endpoint's
own pricing visibility uses.

## Selection bar

| Control | Gate | Endpoint | Endpoint guard |
| --- | --- | --- | --- |
| Count + dollar total | `canSelectRows` | — | n/a |
| Send reminders | `CAN_SEND_INVOICE_EMAIL` | opens the #1888 preview/confirm flow | `requireInvoiceSend` |
| Merge invoices | `CAN_EDIT_INVOICES` | `POST /api/invoices/merge` | `requireInvoiceWrite` |
| Clear | `canSelectRows` | — | n/a |

## One scoping contract for the page

The list and the aggregate behind the header total and the aging strip resolve
their company scope through one helper (`resolveInvoiceScope`). A scoped
caller is pinned to her own company and a `?companyId=` she sends is ignored;
a `super_admin` may name a company and gets it in **both** endpoints, or names
none and gets the cross-company view in both. The page sends the session's
company on every request it makes — list, aggregate, and the select-all fetch
— so the total, the buckets, the rows and the selection all describe the same
population. Sending it to the aggregate alone printed one company's balance
over a `super_admin`'s cross-company table.

## Findings

1. **The QuickBooks surface was split across two capabilities** — the pill and
   the payment sync on one, the per-invoice push on another. Both routes were
   re-gated to `requireQuickBooksAccess` (see above) rather than gating a
   control more loosely than its endpoint. Widening only; no role gained an
   invoice write, and role/endpoint regression tests assert both gates.
2. **No other mismatch found.** Every remaining control's gate is the same
   capability set as the guard on the endpoint it calls.
3. **No role-string comparison remains in `invoices.tsx`** — asserted by a grep
   test, not by review.

## Appendix — migration 0006 port, SQL diff

The registry definition
(`artifacts/api-server/src/lib/migrations/invoice-sent-status-backfill.ts`)
moves the SQL out of the unwired standalone script
(`artifacts/api-server/src/migrations/0006-invoice-sent-status-backfill.ts`)
without changing it. Extracting every `sql\`…\`` block from both files and
normalising whitespace:

```
original 0006 statements: 6
ported definition statements: 6

in 0006 but not in the port: none
in the port but not in 0006: none

MATCH UPDATE invoices SET sent_at = COALESCE(sent_at, updated_at) WHERE status = 'sent' AND sent_at IS NULL
MATCH SELECT COUNT(*) AS cnt FROM invoices WHERE status = 'sent' AND sent_at IS NULL
MATCH UPDATE invoices i SET sent_at = p.sent_at FROM invoice_pdfs p WHERE p.invoice_id = i.id AND p.status = 'sent' AND p.sent_at IS NOT NULL AND i.sent_at IS NULL
MATCH SELECT COUNT(*) AS cnt FROM invoices i JOIN invoice_pdfs p ON p.invoice_id = i.id WHERE p.status = 'sent' AND p.sent_at IS NOT NULL AND i.sent_at IS NULL
MATCH UPDATE invoices SET status = 'generated' WHERE status = 'sent'
MATCH SELECT COUNT(*) AS cnt FROM invoices WHERE status = 'sent'
```

Six statements in, six out, all six identical: three live `UPDATE`s and the
three `--dry-run` `COUNT`s, same `WHERE` clauses, same order, same `COALESCE`.
The port is a move.
