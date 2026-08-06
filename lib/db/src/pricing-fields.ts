// Pricing field inventory — single source of truth for which JSON keys
// the field_tech response sanitizer must strip. Organized by table so a
// new pricing column added anywhere can be appended here and will
// automatically flow through to `PRICING_FIELDS_TO_STRIP` (consumed by
// `applyPricingVisibility` in `artifacts/api-server/src/routes/routes.ts`).
//
// IMPORTANT: every pricing-bearing column on every table that can reach
// a field_tech response should appear in exactly one of the groups
// below. The legacy strip set was hand-maintained against this exact
// list of names — do not remove an entry without confirming the column
// itself has been renamed/dropped.

export const PRICING_FIELDS_BY_TABLE = {
  // customers.laborRate — the per-customer master rate. Budget caps and
  // thresholds added by Task #687 are also pricing-sensitive (they only
  // make sense alongside the invoiced totals they gate against) so they
  // are stripped on the same field_tech boundary.
  customers: [
    "laborRate",
    "monthlyBudgetCap",
    "annualBudgetCap",
    "budgetSoftThresholdPercent",
    "budgetHardThresholdPercent",
    "budgetAlertRecipientUserIds",
    "budgetAlertChannels",
    "budgetNotifyCustomerContact",
  ],
  // Task #687 — users.hourlyWage is wage data; never expose it to
  // field_tech responses.
  users: ["hourlyWage"],
  // billing_sheets — money-bearing columns on the sheet itself.
  billingSheets: ["laborRate", "laborSubtotal", "partsSubtotal", "totalAmount"],
  // billing_sheet_items — per-line money.
  billingSheetItems: ["unitPrice", "totalPrice"],
  // parts catalog.
  parts: ["price", "cost"],
  // estimates header.
  estimates: ["laborRate", "laborSubtotal", "partsSubtotal", "totalAmount"],
  // estimate_items per-line money.
  estimateItems: ["partPrice", "totalPrice"],
  // work_orders header.
  workOrders: [
    "laborRate",
    "laborSubtotal",
    "partsSubtotal",
    "totalAmount",
    "totalPartsCost",
    "estimatedTotal",
  ],
  // work_order_items per-line money.
  workOrderItems: ["partPrice", "totalPrice"],
  // invoices header.
  invoices: ["laborSubtotal", "partsSubtotal", "totalAmount"],
  // invoice_items per-line money.
  invoiceItems: ["unitPrice", "totalPrice", "laborRate", "laborTotal"],
  // Legacy / computed aliases that have appeared on response payloads
  // historically (dashboard rollups, older PDF view models, etc.). Kept
  // here so renames of any of them are still caught by the strip set.
  legacyAliases: [
    "laborAmount",
    "partsAmount",
    "totalCost",
    "laborCost",
    "partsCost",
    "totalUnbilledAmount",
  ],
} as const;

export const PRICING_FIELDS_TO_STRIP: ReadonlySet<string> = new Set(
  Object.values(PRICING_FIELDS_BY_TABLE).flat(),
);
