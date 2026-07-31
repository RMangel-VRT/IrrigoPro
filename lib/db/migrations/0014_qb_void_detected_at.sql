-- Migration 0014: Add qb_void_detected_at to invoices
-- Task #1848 — QBO void misread as paid: surface QBO-voided invoices for
-- human review without auto-stamping them as paid.
--
-- The column is nullable (no default). NULL means no void has been detected
-- for this invoice. When the payment-sync loop detects that QBO has voided
-- the invoice (TotalAmt=0 and PrivateNote contains "Voided"), it stamps this
-- column with the timestamp of first detection. Cleared on re-sync when the
-- void is no longer present.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS qb_void_detected_at TIMESTAMP;
