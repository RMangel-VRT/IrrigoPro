-- Read-only audit for source records whose generated PDFs cannot show any
-- precise site/controller/zone metadata. Run against production read-only.
SELECT 'work_order' AS source_type, id, work_order_number AS source_number
FROM work_orders
WHERE COALESCE(
    NULLIF(BTRIM(work_location_address), ''),
    NULLIF(BTRIM(project_address), '')
  ) IS NULL
  AND NULLIF(BTRIM(COALESCE(controller_letter, '')), '') IS NULL
  AND zone_number IS NULL
UNION ALL
SELECT 'billing_sheet', id, billing_number
FROM billing_sheets
WHERE COALESCE(
    NULLIF(BTRIM(work_location_address), ''),
    NULLIF(BTRIM(property_address), '')
  ) IS NULL
  AND NULLIF(BTRIM(COALESCE(controller_letter, '')), '') IS NULL
  AND zone_number IS NULL
UNION ALL
SELECT 'estimate', id, estimate_number
FROM estimates
WHERE COALESCE(
    NULLIF(BTRIM(work_location_address), ''),
    NULLIF(BTRIM(project_address), '')
  ) IS NULL
  AND NULLIF(BTRIM(COALESCE(controller_letter, '')), '') IS NULL
  AND zone_number IS NULL
ORDER BY source_type, id;