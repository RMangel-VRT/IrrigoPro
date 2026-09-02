-- Field Location Capture foundation.
-- All new ticket fields are nullable so legacy records remain valid and
-- enforcement can be activated independently by the billing/work-order slice.
ALTER TABLE billing_sheets
  ADD COLUMN IF NOT EXISTS field_work_type text,
  ADD COLUMN IF NOT EXISTS field_work_type_details text,
  ADD COLUMN IF NOT EXISTS work_location_source text,
  ADD COLUMN IF NOT EXISTS work_location_accuracy_m numeric(6,1),
  ADD COLUMN IF NOT EXISTS work_location_gps_error text;

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS field_work_type text,
  ADD COLUMN IF NOT EXISTS field_work_type_details text,
  ADD COLUMN IF NOT EXISTS work_location_source text,
  ADD COLUMN IF NOT EXISTS work_location_accuracy_m numeric(6,1),
  ADD COLUMN IF NOT EXISTS work_location_gps_error text;

CREATE TABLE IF NOT EXISTS field_work_types (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  code text NOT NULL,
  label text NOT NULL,
  requires_controller boolean NOT NULL DEFAULT true,
  requires_zone boolean NOT NULL DEFAULT true,
  requires_details boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_field_work_type_company_code
  ON field_work_types(company_id, code);
CREATE INDEX IF NOT EXISTS idx_field_work_types_company
  ON field_work_types(company_id);