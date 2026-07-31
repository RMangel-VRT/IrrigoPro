-- Migration 0015: Add nullable controller_id FK to wet_check_zone_records
-- Task #1857 Slice 1 Step 1 — zone records key on the controller row.
-- Adds a nullable foreign key; the old letter-based unique index is NOT yet dropped
-- so existing reads continue working during the backfill phase (Step 2).

ALTER TABLE wet_check_zone_records
  ADD COLUMN IF NOT EXISTS controller_id INTEGER REFERENCES irrigation_controllers(id);
