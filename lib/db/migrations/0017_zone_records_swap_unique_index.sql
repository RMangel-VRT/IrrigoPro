-- Migration 0017: Swap unique index on wet_check_zone_records
-- Task #1857 Slice 1 Step 3 — replace the letter-based unique index with a
-- controller-row-based one. The new index is partial (WHERE controller_id IS NOT NULL)
-- so historical rows without a resolved controller don't violate it.
-- Run AFTER the backfill (0016) confirms zero ambiguous rows.

-- Drop the old letter-based unique index.
DROP INDEX IF EXISTS uniq_wet_check_zone;

-- Create the new controller-row-based unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wet_check_zone
  ON wet_check_zone_records (wet_check_id, controller_id, zone_number)
  WHERE controller_id IS NOT NULL;
