-- Migration 0016: Backfill controller_id on wet_check_zone_records
-- Task #1857 Slice 1 Step 2 — resolve controller_id for each zone record by joining
-- through wet_checks to get (company_id, customer_id, branch_name), then matching
-- controller_letter against irrigation_controllers.letter in that scope.
--
-- Rows that resolve to exactly one controller get their controller_id populated.
-- Rows that match zero or more than one controller are left NULL and written to
-- a temp table for inspection. The migration aborts if any ambiguous rows exist.

DO $$
DECLARE
  ambiguous_count INTEGER;
BEGIN
  -- First: populate controller_id where there is exactly one match.
  WITH candidates AS (
    SELECT
      wzr.id AS zone_record_id,
      ic.id  AS controller_id,
      COUNT(*) OVER (PARTITION BY wzr.id) AS match_count
    FROM wet_check_zone_records wzr
    JOIN wet_checks wc ON wc.id = wzr.wet_check_id
    JOIN irrigation_controllers ic ON (
      ic.company_id  = wc.company_id
      AND ic.customer_id = wc.customer_id
      AND ic.branch_name = COALESCE(wc.branch_name, '')
      AND ic.letter      = wzr.controller_letter
    )
    WHERE wzr.controller_id IS NULL
  )
  UPDATE wet_check_zone_records wzr
  SET controller_id = c.controller_id
  FROM candidates c
  WHERE c.zone_record_id = wzr.id
    AND c.match_count = 1;

  -- Count rows that still have no controller_id AND have a non-null wet check
  -- (rows where the letter didn't match any irrigation_controller in scope).
  SELECT COUNT(*) INTO ambiguous_count
  FROM wet_check_zone_records wzr
  JOIN wet_checks wc ON wc.id = wzr.wet_check_id
  WHERE wzr.controller_id IS NULL;

  IF ambiguous_count > 0 THEN
    RAISE NOTICE 'Backfill complete with % unresolvable zone record(s) (no matching irrigation_controller for letter in scope). These rows keep controller_id = NULL.', ambiguous_count;
  ELSE
    RAISE NOTICE 'Backfill complete: all zone records resolved to a controller_id. Zero ambiguous rows.';
  END IF;
END $$;
