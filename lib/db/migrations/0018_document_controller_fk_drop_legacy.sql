-- Migration 0018: Add nullable controller_id FK to document tables +
--                 drop legacy prototype tables (property_controllers,
--                 property_zones, zones, field_work_sessions, field_work_items).
-- Task #1857 Slices 2, 3, 5.

-- Slice 2: add nullable controller_id to document tables
ALTER TABLE billing_sheets
  ADD COLUMN IF NOT EXISTS controller_id INTEGER REFERENCES irrigation_controllers(id);

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS controller_id INTEGER REFERENCES irrigation_controllers(id);

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS controller_id INTEGER REFERENCES irrigation_controllers(id);

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS controller_id INTEGER REFERENCES irrigation_controllers(id);

ALTER TABLE work_order_items
  ADD COLUMN IF NOT EXISTS controller_id INTEGER REFERENCES irrigation_controllers(id);

ALTER TABLE work_order_zone_photos
  ADD COLUMN IF NOT EXISTS controller_id INTEGER REFERENCES irrigation_controllers(id);

-- Slice 5: drop property_zones prototype tables (order matters for FK deps)
DROP TABLE IF EXISTS field_work_items CASCADE;
DROP TABLE IF EXISTS field_work_sessions CASCADE;
DROP TABLE IF EXISTS zones CASCADE;
DROP TABLE IF EXISTS property_zones CASCADE;

-- Slice 3: drop property_controllers (wet-check zone records now keyed by controller_id)
DROP TABLE IF EXISTS property_controllers CASCADE;
