-- Migration 0019: Seasonal Budget Model
-- Task #1865 — Move from flat cap numbers to a season-curve-based monthly
-- allocation model. Old monthlyBudgetCap / annualBudgetCap columns are
-- deliberately preserved here (will be dropped in a later cleanup migration).

-- Add per-company season curve (JSON array of {month, percent}) with the
-- standard Apr–Oct 0/10/20/20/20/20/10 default curve.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS budget_season_curve jsonb
    DEFAULT '[{"month":4,"percent":0},{"month":5,"percent":10},{"month":6,"percent":20},{"month":7,"percent":20},{"month":8,"percent":20},{"month":9,"percent":20},{"month":10,"percent":10}]'::jsonb;

-- Add annual budget goal and optional per-customer curve override to customers.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS annual_budget_goal decimal(12,2),
  ADD COLUMN IF NOT EXISTS budget_season_curve_override jsonb;

-- Monthly allocation table: one row per customer per year/month.
-- The unique constraint on (company_id, customer_id, year, month) is the
-- upsert key used by generateBudgetMonths.
CREATE TABLE IF NOT EXISTS customer_budget_months (
  id              serial PRIMARY KEY,
  company_id      integer NOT NULL REFERENCES companies(id),
  customer_id     integer NOT NULL REFERENCES customers(id),
  year            integer NOT NULL,
  month           integer NOT NULL CHECK (month >= 1 AND month <= 12),
  amount          decimal(12,2) NOT NULL,
  is_manual_override boolean NOT NULL DEFAULT false,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT customer_budget_months_unique
    UNIQUE (company_id, customer_id, year, month)
);

CREATE INDEX IF NOT EXISTS customer_budget_months_customer_year_idx
  ON customer_budget_months (customer_id, year, month);

CREATE INDEX IF NOT EXISTS customer_budget_months_company_year_idx
  ON customer_budget_months (company_id, year, month);
