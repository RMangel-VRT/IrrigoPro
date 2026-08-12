-- Task #1935 — follow-up work order for deferred estimate items.
-- Adds the parent_work_order_id column (nullable self-reference) to work_orders
-- and a partial unique index enforcing one follow-up per parent.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS parent_work_order_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS work_orders_follow_up_unique_idx
  ON work_orders(parent_work_order_id)
  WHERE parent_work_order_id IS NOT NULL;
