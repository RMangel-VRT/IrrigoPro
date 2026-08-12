import { pgTable, text, serial, integer, boolean, decimal, timestamp, uniqueIndex, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Companies table for multi-company support
export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  logo: text("logo"), // Logo URL or path
  subscription: text("subscription").notNull().default("basic"), // basic, pro, enterprise
  subscriptionExpiry: timestamp("subscription_expiry"),
  isActive: boolean("is_active").notNull().default(true),
  // Task #669 — per-company 5-digit estimate number sequence.
  // `startingEstimateNumber` is the seed value (configurable by
  // super_admin); `nextEstimateNumber` is the next value to be
  // allocated (atomically incremented inside the estimate-insert
  // transaction). Default 50000.
  startingEstimateNumber: integer("starting_estimate_number").notNull().default(50000),
  nextEstimateNumber: integer("next_estimate_number").notNull().default(50000),
  // Task #1887 — minimum days between two payment reminders for the same
  // invoice. Enforced on the server, not in the UI. Configurable per company
  // because a 7-day cadence is a policy, not a law; 7 is the default.
  invoiceReminderThrottleDays: integer("invoice_reminder_throttle_days").notNull().default(7),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Users table for authentication with company support
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  role: text("role").notNull().default("field_tech"), // super_admin, company_admin, irrigation_manager, field_tech, billing_manager, bookkeeper (Task #643 retired the legacy `manager` alias — `irrigation_manager` is canonical). Canonical set lives in the role registry (`ROLES` in @workspace/shared); keep this comment in step with it.
  companyId: integer("company_id").references(() => companies.id), // null for super_admin
  isActive: boolean("is_active").notNull().default(true),
  isDeleted: boolean("is_deleted").notNull().default(false), // Soft delete flag
  deletedAt: timestamp("deleted_at"), // When user was deleted
  // Email verification fields
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  emailVerificationExpires: timestamp("email_verification_expires"),
  // Password reset fields
  passwordResetToken: text("password_reset_token"),
  passwordResetExpires: timestamp("password_reset_expires"),
  // Multi-Factor Authentication fields
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  mfaSecret: text("mfa_secret"),
  mfaBackupCodes: text("mfa_backup_codes"), // JSON array of backup codes
  mfaLastUsed: timestamp("mfa_last_used"),
  // Task #687 — per-user hourly wage used for labor margin computations in
  // Slice 2 of the Financial Pulse feature. Nullable; never returned to
  // field_tech callers (stripped via PRICING_FIELDS_TO_STRIP).
  hourlyWage: decimal("hourly_wage", { precision: 10, scale: 2 }),
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  address: text("address"),
  // Structured address parts (Task #347). Optional/back-compat: legacy
  // customers may only have the single-line `address` above. New /
  // edited records populate these so geocoding and search can rely on
  // a consistent shape. `street` is the street line (e.g. "123 Main St,
  // Apt 4"); `country` defaults to "US" but stored only when provided.
  street: text("street"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  country: text("country"),
  // Irrigation system details
  totalControllers: integer("total_controllers").default(1), // Number of controllers (1-26)
  // Contract-based billing rates
  contractType: text("contract_type").default("standard"), // standard, premium, commercial, residential
  laborRate: decimal("labor_rate", { precision: 10, scale: 2 }).default("45.00"),
  emergencyLaborRate: decimal("emergency_labor_rate", { precision: 10, scale: 2 }).default("125.00"),
  discountPercent: decimal("discount_percent", { precision: 5, scale: 2 }).default("0.00"),
  // Contract details
  contractStartDate: timestamp("contract_start_date"),
  contractEndDate: timestamp("contract_end_date"),
  paymentTerms: text("payment_terms").default("net_30"), // net_30, net_15, due_on_receipt
  irrigoName: text("irrigo_name"), // IrrigoPro-facing display name (e.g. property name) — shown to all Irrigo users
  notes: text("notes"),
  propertyNotes: text("property_notes"), // Property-specific notes for technicians
  billingNotes: text("billing_notes"), // Private notes for billing manager use only
  quickbooksId: text("quickbooks_id"), // QuickBooks customer ID for integration
  hiddenFromBilling: boolean("hidden_from_billing").default(false),
  branches: text("branches").array(), // Optional list of branch names for customers with multiple locations
  // Property boundary (GIS) — uploaded KML/KMZ converted to GeoJSON
  propertyBoundary: text("property_boundary"), // GeoJSON Feature (Polygon | MultiPolygon) as string
  propertyBoundaryKml: text("property_boundary_kml"), // Original KML source text
  propertyBoundaryFileName: text("property_boundary_file_name"),
  propertyBoundaryCenterLat: decimal("property_boundary_center_lat", { precision: 10, scale: 7 }),
  propertyBoundaryCenterLng: decimal("property_boundary_center_lng", { precision: 10, scale: 7 }),
  propertyBoundaryZoom: integer("property_boundary_zoom").default(18),
  propertyBoundaryAreaAcres: decimal("property_boundary_area_acres", { precision: 12, scale: 4 }),
  propertyBoundaryUpdatedAt: timestamp("property_boundary_updated_at"),
  // Task #687 — Financial Pulse Slice 1. Per-customer monthly/annual budget
  // caps with soft/hard thresholds, alert routing, and an opt-in customer
  // notification toggle. All seven fields are nullable or defaulted so the
  // migration is a no-op against existing rows.
  monthlyBudgetCap: decimal("monthly_budget_cap", { precision: 12, scale: 2 }),
  annualBudgetCap: decimal("annual_budget_cap", { precision: 12, scale: 2 }),
  budgetSoftThresholdPercent: integer("budget_soft_threshold_percent").default(75),
  budgetHardThresholdPercent: integer("budget_hard_threshold_percent").default(100),
  budgetAlertRecipientUserIds: jsonb("budget_alert_recipient_user_ids").$type<number[]>().default(sql`'[]'::jsonb`),
  budgetAlertChannels: jsonb("budget_alert_channels").$type<{ inApp: boolean; push: boolean; email: boolean }>().default(sql`'{"inApp":true,"push":true,"email":false}'::jsonb`),
  budgetNotifyCustomerContact: boolean("budget_notify_customer_contact").default(false),
}, (table) => ({
  // Task #532 — index company-scoped lookups (the customers list endpoint
  // and almost every join coming off a customer is filtered by companyId).
  companyIdx: index("customers_company_idx").on(table.companyId),
}));

// Site maps and controller management
export const siteMaps = pgTable("site_maps", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  description: text("description"),
  kmlFile: text("kml_file"), // Path to uploaded KML file
  kmlData: text("kml_data"), // Parsed KML content as JSON
  centerLat: decimal("center_lat", { precision: 10, scale: 7 }),
  centerLng: decimal("center_lng", { precision: 10, scale: 7 }),
  zoomLevel: integer("zoom_level").default(15),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const controllers = pgTable("controllers", {
  id: serial("id").primaryKey(),
  siteMapId: integer("site_map_id").references(() => siteMaps.id),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  model: text("model"),
  serialNumber: text("serial_number"),
  latitude: decimal("latitude", { precision: 10, scale: 7 }).notNull(),
  longitude: decimal("longitude", { precision: 10, scale: 7 }).notNull(),
  stationCount: integer("station_count").default(8),
  installDate: timestamp("install_date"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const irrigationZones = pgTable("irrigation_zones", {
  id: serial("id").primaryKey(),
  controllerId: integer("controller_id").references(() => controllers.id),
  siteMapId: integer("site_map_id").references(() => siteMaps.id),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  stationNumber: integer("station_number").notNull(),
  zoneType: text("zone_type").default("sprinkler"), // sprinkler, drip, bubbler
  coverage: text("coverage"), // area description
  boundaries: text("boundaries"), // GeoJSON polygon data
  runtime: integer("runtime").default(15), // minutes
  flowRate: decimal("flow_rate", { precision: 8, scale: 2 }), // GPM
  pressure: decimal("pressure", { precision: 8, scale: 2 }), // PSI
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const utilityMarkers = pgTable("utility_markers", {
  id: serial("id").primaryKey(),
  siteMapId: integer("site_map_id").references(() => siteMaps.id),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  markerType: text("marker_type").default("utility"), // utility, splice, waste, etc.
  latitude: decimal("latitude", { precision: 10, scale: 8 }).notNull(),
  longitude: decimal("longitude", { precision: 11, scale: 8 }).notNull(),
  description: text("description"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Schema types for the new tables
export const insertSiteMapSchema = createInsertSchema(siteMaps);
export const insertControllerSchema = createInsertSchema(controllers);
export const insertIrrigationZoneSchema = createInsertSchema(irrigationZones);
export const insertUtilityMarkerSchema = createInsertSchema(utilityMarkers);

export type SiteMap = typeof siteMaps.$inferSelect;
export type Controller = typeof controllers.$inferSelect;
export type IrrigationZone = typeof irrigationZones.$inferSelect;
export type UtilityMarker = typeof utilityMarkers.$inferSelect;

export type InsertUtilityMarker = z.infer<typeof insertUtilityMarkerSchema>;

export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  cost: decimal("cost", { precision: 10, scale: 2 }),
  sku: text("sku").notNull(),
  // Enhanced categorization based on your irrigation parts structure
  category: text("category").notNull(), // Main category: Backflow, Bushing, Controller, etc.
  material: text("material"), // PVC, Copper, Brass, NETAFIM, etc.
  size: text("size"), // 1", 1.5", 2", etc.
  brand: text("brand"), // Hunter, Febco, Rainbird, LEIT, etc.
  fittingType: text("fitting_type"), // 90° Coupler, Tee, Union, Cap, etc.
  detail: text("detail"), // Additional specifications like "Pressure Vacuum Breaker"
  quickbooksId: text("quickbooks_id"), // QuickBooks item ID for integration
  isActive: boolean("is_active").notNull().default(true),
  approvalStatus: text("approval_status").notNull().default("approved"), // pending | approved
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdateFn(() => new Date()),
}, (table) => ({
  companyUpdatedIdx: index("parts_company_updated_idx").on(table.companyId, table.updatedAt),
}));

// Standalone billing sheets for work without work orders
export const billingSheets = pgTable("billing_sheets", {
  id: serial("id").primaryKey(),
  billingNumber: text("billing_number").notNull().unique(),
  customerId: integer("customer_id").references(() => customers.id),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerName: text("customer_name").notNull(),
  propertyAddress: text("property_address").notNull(),
  workLocationLat: decimal("work_location_lat", { precision: 10, scale: 7 }),
  workLocationLng: decimal("work_location_lng", { precision: 10, scale: 7 }),
  workLocationAddress: text("work_location_address"),
  controllerLetter: text("controller_letter"),
  zoneNumber: integer("zone_number"),
  // Task #1857 — nullable FK to irrigation_controllers. Populated going forward
  // when a billing sheet is created from a wet check. NULL on legacy sheets.
  controllerId: integer("controller_id").references(() => irrigationControllers.id),
  workDate: timestamp("work_date").notNull(),
  technicianName: text("technician_name").notNull(),
  technicianId: integer("technician_id").references(() => users.id),
  workDescription: text("work_description").notNull(),
  status: text("status").notNull().default("draft"), // draft, submitted, completed, pending_manager_review, approved_passed_to_billing, billed (see billingSheetStatusValues)
  totalHours: decimal("total_hours", { precision: 5, scale: 2 }).notNull(),
  laborRate: decimal("labor_rate", { precision: 10, scale: 2 }).notNull(),
  laborSubtotal: decimal("labor_subtotal", { precision: 10, scale: 2 }).notNull(),
  partsSubtotal: decimal("parts_subtotal", { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  // Task #396 — labor entry mode for the sheet. 'flat' means use the single
  // totalHours field for all labor; 'per_part' means sum per-line laborHours.
  // Default 'flat' for new sheets; existing sheets are backfilled to 'per_part'.
  // NOTE (WCB, Task #753): ignored for wet_check_billings-sourced billing sheets.
  // Those sheets derive their labor totals from
  // wc.totalLaborHours + Σ zone.repairLaborHours — not from this column.
  // Preserved here for non-wet-check billing paths.
  laborMode: text("labor_mode").notNull().default("flat"),
  // Snapshot of customer.laborRate at creation (mirrors work_orders).
  appliedLaborRate: decimal("applied_labor_rate", { precision: 10, scale: 2 }),
  // Task #1093 — Normal / Emergency rate toggle. 'normal' uses customer.laborRate,
  // 'emergency' uses customer.emergencyLaborRate. Toggling one recomputes labor totals.
  rateMode: text("rate_mode").notNull().default("normal"),
  // Invoice linkage - prevents double billing
  invoiceId: integer("invoice_id").references(() => invoices.id),
  billedAt: timestamp("billed_at"),
  photos: text("photos").array().default([]),
  notes: text("notes"),
  branchName: text("branch_name"), // Selected branch for multi-location customers
  // Task #488 (M3) — canonical link from a billing sheet back to the parent
  // work order it was converted from (when applicable). Populated by the
  // POST /api/work-orders/:id/billing-sheet conversion endpoint. Nullable
  // because billing sheets can also be created standalone with no WO.
  workOrderId: integer("work_order_id").references(() => workOrders.id),
  // AI-generated description fields
  aiInputs: text("ai_inputs"), // JSON blob of structured inputs used for AI generation
  aiShortDescription: text("ai_short_description"), // Final accepted short description (user-editable)
  aiDetailedDescription: text("ai_detailed_description"), // Final accepted detailed description (user-editable)
  // Manager approval stamp fields — populated when irrigation manager approves ticket
  approvedBy: text("approved_by"), // Name of the manager who approved
  approvedByUserId: integer("approved_by_user_id").references(() => users.id), // User ID of approver
  approvedAt: timestamp("approved_at"), // When approval was granted
  approvedTotal: decimal("approved_total", { precision: 10, scale: 2 }), // Total at time of approval
  approvedPartsSnapshot: text("approved_parts_snapshot"), // JSON snapshot of parts at approval
  approvedLaborSnapshot: text("approved_labor_snapshot"), // JSON snapshot of labor details at approval
  // Slice 2 — role of the actor who approved. NULL on legacy rows (treated as
  // "unknown", not flagged). Used by the manager queue to detect billing-side
  // approvals (billing_manager / company_admin) that bypassed irrigation_manager review.
  approvedByRole: text("approved_by_role"),
  // Task #197 — admin/manager-flagged "no photos needed" so legitimately
  // photo-less billing sheets can be cleared off the missing-photos report.
  noPhotosNeeded: boolean("no_photos_needed").notNull().default(false),
  noPhotosNeededBy: integer("no_photos_needed_by").references(() => users.id),
  noPhotosNeededAt: timestamp("no_photos_needed_at"),
  // Task #1238 — set by return-for-correction; cleared when tech resubmits
  // (status → submitted/pending_manager_review/completed). Drives the
  // "Waiting on tech" stage section in the merged Manager Workspace.
  returnedForCorrectionAt: timestamp("returned_for_correction_at"),
  // Task #1459 — billing-specific notes left by the irrigation manager during
  // the approval flow. Visible to billing managers as a highlighted callout
  // ("Notes from Irrigation Manager") so instructions aren't missed. Editable
  // by irrigation_manager / company_admin / super_admin while the sheet is
  // not yet billed. Never cleared by the billing manager's subsequent saves.
  managerBillingNotes: text("manager_billing_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Task #532 — billing sheets are filtered by these foreign keys on every
  // list / dashboard / report path. Without indexes we are doing seq scans
  // that show up at the top of pg_stat_statements once the table is more
  // than a few hundred rows.
  customerIdx: index("billing_sheets_customer_idx").on(table.customerId),
  companyIdx: index("billing_sheets_company_idx").on(table.companyId),
  technicianIdx: index("billing_sheets_technician_idx").on(table.technicianId),
  workOrderIdx: index("billing_sheets_work_order_idx").on(table.workOrderId),
  invoiceIdx: index("billing_sheets_invoice_idx").on(table.invoiceId),
  statusCreatedIdx: index("billing_sheets_status_created_idx").on(table.status, table.createdAt),
}));

// Per-prefix sequence counters for billing sheet numbers (e.g. "BS-2026-").
// The table is bootstrapped at runtime via raw SQL in
// `server/storage.ts` (`getNextBillingNumber`) using
// `CREATE TABLE IF NOT EXISTS`. It is declared here so Drizzle's
// migration generator does not propose dropping it as an orphan.
// Do not refactor the runtime bootstrap without coordinating a migration.
export const billingNumberCounters = pgTable("billing_number_counters", {
  prefix: text("prefix").primaryKey(),
  lastSeq: integer("last_seq").notNull().default(0),
});

// AI generation log - audit trail for all GPT description generation requests
export const aiGenerationLogs = pgTable("ai_generation_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  entityType: text("entity_type").notNull(), // "billing_sheet" or "work_order"
  entityId: integer("entity_id"), // ID of the related billing sheet or work order
  inputs: text("inputs").notNull(), // JSON snapshot of structured inputs sent to GPT
  rawOutput: text("raw_output").notNull(), // Raw GPT response text
  templateVersion: text("template_version").notNull().default("v1"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Items used in standalone billing sheets
export const billingSheetItems = pgTable("billing_sheet_items", {
  id: serial("id").primaryKey(),
  billingSheetId: integer("billing_sheet_id").references(() => billingSheets.id),
  partId: integer("part_id").references(() => parts.id),
  partName: text("part_name").notNull(),
  partDescription: text("part_description"),
  quantity: decimal("quantity", { precision: 10, scale: 2 }).notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull(),
  // Task #396 — per-line labor hours are 0 in flat mode (the sheet's
  // totalHours is authoritative). Default 0 so flat-mode payloads can omit it.
  laborHours: decimal("labor_hours", { precision: 5, scale: 2 }).notNull().default("0.00"),
  notes: text("notes"),
});

// Manual part reviews - for parts entered manually on billing sheets (no catalog match)
export const manualPartReviews = pgTable("manual_part_reviews", {
  id: serial("id").primaryKey(),
  billingSheetId: integer("billing_sheet_id").references(() => billingSheets.id).notNull(),
  billingSheetItemId: integer("billing_sheet_item_id").references(() => billingSheetItems.id),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  partName: text("part_name").notNull(),
  proposedPrice: decimal("proposed_price", { precision: 10, scale: 2 }).notNull(),
  reviewedPrice: decimal("reviewed_price", { precision: 10, scale: 2 }),
  approvalStatus: text("approval_status").notNull().default("pending"), // pending | approved
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One-shot tracking of "missing photos" outreach emails sent to technicians.
// Used to make the manager-triggered notify action idempotent and to surface
// a "last notified" timestamp on the report UI. One row per technician.
export const missingPhotosNotifications = pgTable("missing_photos_notifications", {
  id: serial("id").primaryKey(),
  technicianId: integer("technician_id").references(() => users.id).notNull().unique(),
  lastSentAt: timestamp("last_sent_at").defaultNow().notNull(),
  sheetCount: integer("sheet_count").notNull().default(0),
  sheetIds: integer("sheet_ids").array().default([]),
  sentByUserId: integer("sent_by_user_id").references(() => users.id),
  lastSentEmailAt: timestamp("last_sent_email_at"),
  lastSentSmsAt: timestamp("last_sent_sms_at"),
  lastEmailSheetCount: integer("last_email_sheet_count"),
  lastSmsSheetCount: integer("last_sms_sheet_count"),
  // Twilio delivery tracking for the most recent SMS sent on this row.
  // Updated by the Twilio status callback webhook as the message moves
  // through queued -> sent -> delivered -> failed/undelivered.
  lastSmsMessageSid: text("last_sms_message_sid"),
  lastSmsStatus: text("last_sms_status"),
  lastSmsStatusAt: timestamp("last_sms_status_at"),
  lastSmsErrorCode: text("last_sms_error_code"),
});

// Part assemblies - pre-configured bundles of parts for common repairs
export const assemblies = pgTable("assemblies", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"), // Same categories as parts for consistency
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull().default("0.00"),
  totalLaborHours: decimal("total_labor_hours", { precision: 5, scale: 2 }).notNull().default("0.00"),
  usageCount: integer("usage_count").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Junction table for parts within assemblies
export const assemblyParts = pgTable("assembly_parts", {
  id: serial("id").primaryKey(),
  assemblyId: integer("assembly_id").references(() => assemblies.id).notNull(),
  partId: integer("part_id").references(() => parts.id).notNull(),
  quantity: decimal("quantity", { precision: 10, scale: 2 }).notNull().default("1.00"),
  sortOrder: integer("sort_order").default(0),
});

// Part usage tracking for frequently used parts and assemblies
export const partUsage = pgTable("part_usage", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  partId: integer("part_id").references(() => parts.id),
  assemblyId: integer("assembly_id").references(() => assemblies.id),
  usageCount: integer("usage_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const estimates = pgTable("estimates", {
  id: serial("id").primaryKey(),
  // Task #669 — estimate numbers are scoped per-company (5-digit
  // sequence allocated from `companies.next_estimate_number`). The
  // global UNIQUE was relaxed to a composite UNIQUE on
  // (companyId, estimateNumber) — see `estimatesCompanyNumberIdx`
  // below.
  estimateNumber: text("estimate_number").notNull(),
  companyId: integer("company_id").references(() => companies.id).notNull(), // Company ownership
  customerId: integer("customer_id").references(() => customers.id),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone"),
  projectName: text("project_name").notNull(),
  projectAddress: text("project_address"),
  locationNotes: text("location_notes"), // Additional location details
  accessInstructions: text("access_instructions"), // How to access the property
  workDescription: text("work_description"), // Free-form scope of work captured in the estimate wizard
  createdBy: text("created_by").notNull().default("Irrigation Manager"), // Who created the estimate
  createdByUserId: integer("created_by_user_id").references(() => users.id), // User who created
  estimateDate: timestamp("estimate_date").defaultNow().notNull(), // Date of estimate creation
  status: text("status").notNull().default("pending"), // pending, approved, rejected, expired
  // Internal review track (separate from customer-facing `status`).
  // Allowed values: draft, pending_approval, approved_internal, sent_to_customer.
  // Reserved for future slices: needs_revision.
  internalStatus: text("internal_status").notNull().default("pending_approval"),
  // Task #642 — Single canonical lifecycle bucket persisted alongside the
  // legacy two-axis (status, internalStatus) pair. Allowed values:
  // draft | pending_review | sent | approved | rejected.
  // Note: `expired` is intentionally NOT a stored value — it's derived at
  // read time from (lifecycle='sent', estimateDate > 30 days) so a stored
  // row can roll back into 'sent' if `estimateDate` is reset (e.g. resend).
  // The legacy `status` / `internalStatus` columns continue to be written
  // by every write path until they're dropped in a follow-up task after
  // production verification.
  lifecycle: text("lifecycle").notNull().default("pending_review"),
  partsSubtotal: decimal("parts_subtotal", { precision: 10, scale: 2 }).notNull(),
  laborSubtotal: decimal("labor_subtotal", { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  laborRate: decimal("labor_rate", { precision: 10, scale: 2 }).notNull(),
  // Task #396 — labor entry mode. 'flat' uses totalLaborHours; 'per_part'
  // sums per-line laborHours. New estimates default to 'flat'; existing
  // estimates are backfilled to 'per_part' to preserve their per-row labor.
  laborMode: text("labor_mode").notNull().default("flat"),
  totalLaborHours: decimal("total_labor_hours", { precision: 6, scale: 2 }).notNull().default("0.00"),
  // Snapshot of customer.laborRate at creation (mirrors work_orders).
  appliedLaborRate: decimal("applied_labor_rate", { precision: 10, scale: 2 }),
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  approvalToken: text("approval_token"), // Secure token for email approval links
  tokenExpiresAt: timestamp("token_expires_at"), // When approval token expires
  approvalSource: text("approval_source"), // 'email_link', 'manual', etc.
  approvalSentAt: timestamp("approval_sent_at"), // When approval email was sent
  // Task #1574 — actual delivery address used when sending the approval email.
  // Differs from customerEmail when the send modal's "To" field is overridden.
  // Used by the reject-via-token POST handler for truthful audit attribution.
  sentToEmail: text("sent_to_email"),
  approvalRespondedAt: timestamp("approval_responded_at"), // When customer responded
  // Work order linkage - tracks conversion
  workOrderId: integer("work_order_id"), // References work order created from this estimate
  photos: text("photos").array().default([]), // JSON array of photo URLs
  attachments: text("attachments").array().default([]), // JSON array of attachment URLs (landscape plans, etc.)
  // Pinned work location captured via the estimate wizard map picker.
  // Optional — older estimates may have only an address.
  workLocationLat: decimal("work_location_lat", { precision: 10, scale: 7 }),
  workLocationLng: decimal("work_location_lng", { precision: 10, scale: 7 }),
  workLocationAddress: text("work_location_address"),
  // Optional irrigation context: which controller letter (A..Z) and zone
  // number from the customer's controller setup this estimate is for.
  controllerLetter: text("controller_letter"),
  zoneNumber: integer("zone_number"),
  // Task #1857 — nullable FK to irrigation_controllers. Populated going forward. NULL on legacy.
  controllerId: integer("controller_id").references(() => irrigationControllers.id),
  // Task #1499 — Customer signature captured at approval time.
  // All seven columns are nullable; they are populated only when the
  // customer completes the "Sign to approve" flow (POST approve-via-token).
  // approvalSignatureType: 'drawn' | 'typed'
  // approvalSignatureData: base64 PNG data URI (drawn) or typed name text
  // approvalSignerName:    printed name as entered by the customer
  // approvalSignedAt:      UTC timestamp when the signature was submitted
  // approvalSignerIp:      IP address recorded from the POST request
  // approvalConsentText:   verbatim consent blurb shown to the customer
  // approvalConsentAcceptedAt: UTC timestamp of consent acceptance
  approvalSignatureType: text("approval_signature_type"),
  approvalSignatureData: text("approval_signature_data"),
  approvalSignerName: text("approval_signer_name"),
  approvalSignedAt: timestamp("approval_signed_at"),
  approvalSignerIp: text("approval_signer_ip"),
  approvalConsentText: text("approval_consent_text"),
  approvalConsentAcceptedAt: timestamp("approval_consent_accepted_at"),
  // Task #634 — manager-facing soft delete for draft estimates. The
  // row stays in the database (auditable) but every read path filters
  // `deletedAt IS NULL` by default. Only super_admin can opt-in to
  // see deleted rows via `?includeDeleted=1`.
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by").references(() => users.id),
  // Slice 2 of WC Inspection Mode — stamped when this estimate was generated
  // from an Inspection wet check's findings. Nullable (most estimates have no
  // origin wet check). Used by the Needs Review membership rule and the review
  // surface to branch on mode === 'inspection'.
  originWetCheckId: integer("origin_wet_check_id").references(() => wetChecks.id),
  // Task #315 — selected branch for multi-location customers. NULL for
  // single-location customers or legacy rows. Carried from the originating
  // wet check when an estimate is generated from an Inspection wet check.
  branchName: text("branch_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Task #532 — estimates are filtered by company (almost every list),
  // by customer (customer profile, billing preview), and by status (the
  // pending-approval queue). Indexes keep these list endpoints O(log n).
  companyIdx: index("estimates_company_idx").on(table.companyId),
  customerIdx: index("estimates_customer_idx").on(table.customerId),
  statusIdx: index("estimates_status_idx").on(table.status),
  internalStatusIdx: index("estimates_internal_status_idx").on(table.internalStatus),
  // Task #634 — partial index keeps the active-row list endpoints O(log n)
  // even after deleted rows accumulate.
  activeCompanyStatusIdx: index("estimates_active_company_status_idx")
    .on(table.companyId, table.status)
    .where(sql`${table.deletedAt} IS NULL`),
  // Task #669 — estimate numbers are unique within a company (not
  // globally). Replaces the legacy global UNIQUE on `estimate_number`.
  companyNumberIdx: uniqueIndex("estimates_company_number_unique_idx")
    .on(table.companyId, table.estimateNumber),
}));

export const estimateItems = pgTable("estimate_items", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").references(() => estimates.id).notNull(),
  description: text("description").notNull().default(""),
  partId: integer("part_id").references(() => parts.id),
  partName: text("part_name").notNull(),
  partPrice: decimal("part_price", { precision: 10, scale: 2 }).notNull(),
  quantity: integer("quantity").notNull(),
  // Task #396 — per-line labor hours are 0 in flat mode. Default 0 so
  // flat-mode payloads can omit them.
  // Exception: inspection-origin estimate items carry the finding's real
  // laborHours so Slice 2 PDF can render a per-zone labor breakdown. The
  // financial math (totalLaborHours × laborRate) is still driven by the
  // estimate-level header aggregate — per-line hours here are display-only.
  laborHours: decimal("labor_hours", { precision: 5, scale: 2 }).notNull().default("0.00"),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  // Task #1385 — zone context for inspection-origin estimate items.
  // Null on all manually-created estimate items; populated only when the
  // item was generated from an inspection wet check finding.
  controllerLetter: text("controller_letter"),
  zoneNumber: integer("zone_number"),
  issueType: text("issue_type"),
  // Task #1857 — nullable FK to irrigation_controllers.
  controllerId: integer("controller_id").references(() => irrigationControllers.id),
});

// QuickBooks integration
export const quickbooksIntegration = pgTable("quickbooks_integration", {
  id: serial("id").primaryKey(),
  companyId: text("company_id").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  realmId: text("realm_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastRefreshAttempt: timestamp("last_refresh_attempt", { withTimezone: true }),
  lastRefreshSuccess: timestamp("last_refresh_success", { withTimezone: true }),
  lastRefreshFailure: timestamp("last_refresh_failure", { withTimezone: true }),
  connectionStatus: text("connection_status").notNull().default("connected"), // connected, disconnected, error, reconnect_required
  reconnectRequiredReason: text("reconnect_required_reason"),
  tokenEnvironment: text("token_environment").notNull().default("sandbox"), // sandbox, production
  lastReconnectEmailAt: timestamp("last_reconnect_email_at", { withTimezone: true }), // Task #743 — throttle guard for reconnect_required admin emails
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  realmIdUniqueIdx: uniqueIndex("quickbooks_integration_realm_id_unique").on(table.realmId),
}));

export const quickbooksSync = pgTable("quickbooks_sync", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").references(() => estimates.id, { onDelete: "cascade" }).notNull(),
  quickbooksEstimateId: text("quickbooks_estimate_id"),
  quickbooksCustomerId: text("quickbooks_customer_id"),
  syncStatus: text("sync_status").notNull().default("pending"), // pending, synced, failed
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Task #744 — QB Harden #2: durable OAuth state store (behind USE_DB_OAUTH_STATE flag).
// Survives api-server restarts mid-OAuth flow on autoscale deployments.
// consumeOauthState uses a single atomic DELETE...RETURNING to prevent replay attacks.
export const oauthState = pgTable("oauth_state", {
  state: text("state").primaryKey(),
  provider: text("provider").notNull(),
  companyId: text("company_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  expiresAtIdx: index("oauth_state_expires_at_idx").on(table.expiresAt),
}));

// =============================================================================
// CANONICAL STATUS LIFECYCLE — Work Orders & Billing Sheets
// =============================================================================
//
// WORK ORDER STATUS FLOW:
//   pending
//     └─► assigned          (manager assigns a technician)
//           └─► in_progress (field tech starts the work order)
//                 └─► pending_manager_review  (field tech submits completion)
//                           └─► approved_passed_to_billing  (manager approves)
//                                 └─► billed  (billing manager creates invoice)
//   Any state ──────────────────────────────────────────────────────► cancelled
//
// Notes:
//   - 'work_completed' is a LEGACY status. New completions go straight to
//     'pending_manager_review'. Any record stuck in 'work_completed' without
//     an invoiceId should be treated as 'pending_manager_review'.
//   - The PATCH /api/work-orders/:id route blocks direct writes of status
//     'work_completed' to prevent bypassing the completion flow; use the
//     dedicated POST /api/work-orders/complete or
//     POST /api/work-orders/:id/complete endpoints instead.
//   - All roles use the same completion endpoint, which always sets
//     'pending_manager_review'. A separate /approve step (irrigation_manager,
//     company_admin, or super_admin only) transitions to 'approved_passed_to_billing'.
//
// BILLING SHEET STATUS FLOW:
//   draft
//     └─► submitted            (field tech submits for review)
//           └─► pending_manager_review  (equivalent — some paths set this directly)
//                 └─► approved_passed_to_billing  (manager approves)
//                           └─► billed  (billing manager creates invoice)
//   Any state ─────────────────────────────────────────────────────► (deleted)
//
// Notes:
//   - 'completed' and 'approved' are LEGACY billing sheet statuses. Any record
//     stuck in 'completed' without an invoiceId should be treated as
//     'pending_manager_review'. 'approved' maps to 'approved_passed_to_billing'.
// =============================================================================

// Work Orders - created from approved estimates OR direct work orders
export const workOrders = pgTable("work_orders", {
  id: serial("id").primaryKey(),
  workOrderNumber: text("work_order_number").notNull().unique(),
  estimateId: integer("estimate_id").references(() => estimates.id), // Optional - null for direct work orders
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone"),
  projectName: text("project_name").notNull(),
  projectAddress: text("project_address"),
  locationNotes: text("location_notes"), // Additional location details
  accessInstructions: text("access_instructions"), // How to access the property
  workType: text("work_type").notNull().default("estimate_based"), // estimate_based, direct_billing, maintenance
  status: text("status").notNull().default("pending"), // pending, assigned, in_progress, work_completed, pending_manager_review, approved_passed_to_billing, cancelled, billed
  priority: text("priority").notNull().default("medium"), // low, medium, high, urgent
  scheduledDate: timestamp("scheduled_date"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  assignedTechnicianId: integer("assigned_technician_id"),
  assignedTechnicianName: text("assigned_technician_name"),
  description: text("description"), // For direct work orders without estimates
  specialInstructions: text("special_instructions"),
  notes: text("notes"),
  // Completion fields - who actually completed the work
  completedByUserId: integer("completed_by_user_id").references(() => users.id),
  completedByUserName: text("completed_by_user_name"),
  workSummary: text("work_summary"), // Summary of work completed
  customerNotes: text("customer_notes"), // Notes to share with customer
  totalHours: decimal("total_hours", { precision: 5, scale: 2 }), // Hours worked (flat-mode authoritative value)
  // Task #396 — labor entry mode for this work order. 'flat' uses totalHours;
  // 'per_part' sums per-line actualLaborHours. Default 'flat' for new work
  // orders; existing/converted work orders are backfilled to 'per_part'.
  laborMode: text("labor_mode").notNull().default("flat"),
  totalPartsCost: decimal("total_parts_cost", { precision: 10, scale: 2 }), // Cost of parts used
  // Financial snapshot fields - explicit pricing for billing
  laborRate: decimal("labor_rate", { precision: 10, scale: 2 }), // Rate used for this job (legacy alias for appliedLaborRate)
  laborSubtotal: decimal("labor_subtotal", { precision: 10, scale: 2 }), // totalHours * appliedLaborRate
  partsSubtotal: decimal("parts_subtotal", { precision: 10, scale: 2 }), // Sum of parts costs
  estimatedTotal: decimal("estimated_total", { precision: 10, scale: 2 }), // Original estimate total for comparison
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).default("0.00"),
  // Applied rate snapshot — locked at the time financial total is first calculated
  appliedLaborRate: decimal("applied_labor_rate", { precision: 10, scale: 2 }), // customer.laborRate at completion time
  // Task #1093 — Normal / Emergency rate toggle.
  rateMode: text("rate_mode").notNull().default("normal"),
  totalItems: integer("total_items").default(0),
  // Invoice linkage - prevents double billing
  invoiceId: integer("invoice_id").references(() => invoices.id),
  billedAt: timestamp("billed_at"),
  photos: text("photos").array().default([]), // JSON array of photo URLs
  attachments: text("attachments").array().default([]), // JSON array of attachment URLs (landscape plans, etc.)
  branchName: text("branch_name"), // Selected branch for multi-location customers
  // Pinned work location (carried forward from estimate when auto-converted,
  // or set directly on the work order form). Optional.
  workLocationLat: decimal("work_location_lat", { precision: 10, scale: 7 }),
  workLocationLng: decimal("work_location_lng", { precision: 10, scale: 7 }),
  workLocationAddress: text("work_location_address"),
  // Optional irrigation context — which controller letter / zone this work
  // is for, mirrored from the originating estimate when applicable.
  controllerLetter: text("controller_letter"),
  zoneNumber: integer("zone_number"),
  // Task #1857 — nullable FK to irrigation_controllers. Populated going forward. NULL on legacy.
  controllerId: integer("controller_id").references(() => irrigationControllers.id),
  // AI-generated description fields (populated during completion)
  aiInputs: text("ai_inputs"), // JSON blob of structured inputs used for AI generation
  aiShortDescription: text("ai_short_description"), // Final accepted short description
  aiDetailedDescription: text("ai_detailed_description"), // Final accepted detailed description
  // Manager approval stamp fields — populated when irrigation manager approves ticket
  approvedBy: text("approved_by"), // Name of the manager who approved
  approvedByUserId: integer("approved_by_user_id").references(() => users.id), // User ID of approver
  approvedAt: timestamp("approved_at"), // When approval was granted
  approvedTotal: decimal("approved_total", { precision: 10, scale: 2 }), // Total at time of approval
  approvedPartsSnapshot: text("approved_parts_snapshot"), // JSON snapshot of parts at approval
  approvedLaborSnapshot: text("approved_labor_snapshot"), // JSON snapshot of labor details at approval
  // Slice 2 — role of the actor who approved. NULL on legacy rows (treated as
  // "unknown", not flagged). Used by the manager queue to detect billing-side
  // approvals (billing_manager / company_admin) that bypassed irrigation_manager review.
  approvedByRole: text("approved_by_role"),
  // Task #185 — admin/manager-flagged "no photos needed" so legitimately
  // photo-less work orders can be cleared off the missing-photos report.
  noPhotosNeeded: boolean("no_photos_needed").notNull().default(false),
  noPhotosNeededBy: integer("no_photos_needed_by").references(() => users.id),
  noPhotosNeededAt: timestamp("no_photos_needed_at"),
  // Task #1238 — set by return-for-correction; cleared when tech resubmits
  // (status → pending_manager_review/work_completed). Drives the
  // "Waiting on tech" stage section in the merged Manager Workspace.
  returnedForCorrectionAt: timestamp("returned_for_correction_at"),
  // Slice 3 — lineage tag: the wet check inspection this work order
  // originated from (via estimate→WO conversion). Nullable; only set when
  // the WO was created from an estimate that itself has originWetCheckId.
  // No backfill on existing rows.
  originWetCheckId: integer("origin_wet_check_id").references(() => wetChecks.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Task #532 — work_orders is the single hottest list table. Every
  // role's home screen filters by some combination of these FKs. The
  // composite (status, scheduledDate) index covers the dispatch board
  // sort, while the assignedTechnicianId / customerId indexes speed up
  // the per-tech and per-customer views.
  customerIdx: index("work_orders_customer_idx").on(table.customerId),
  companyIdx: index("work_orders_company_idx").on(table.companyId),
  companyStatusScheduledIdx: index("work_orders_company_status_scheduled_idx").on(table.companyId, table.status, table.scheduledDate),
  assignedTechIdx: index("work_orders_assigned_tech_idx").on(table.assignedTechnicianId),
  invoiceIdx: index("work_orders_invoice_idx").on(table.invoiceId),
  // Seam 3 — enforces one work order per estimate at the DB level.
  // Partial (WHERE estimate_id IS NOT NULL) so direct WOs with no
  // estimate (null) remain unrestricted — multiple unlinked WOs
  // for the same customer are normal and must continue to work.
  estimateUniqueIdx: uniqueIndex("work_orders_estimate_unique_idx")
    .on(table.estimateId)
    .where(sql`estimate_id IS NOT NULL`),
  statusScheduledIdx: index("work_orders_status_scheduled_idx").on(table.status, table.scheduledDate),
}));

// Work Order Items - copied from estimate items
export const workOrderItems = pgTable("work_order_items", {
  id: serial("id").primaryKey(),
  workOrderId: integer("work_order_id").references(() => workOrders.id).notNull(),
  partId: integer("part_id").references(() => parts.id),
  partName: text("part_name").notNull(),
  partPrice: decimal("part_price", { precision: 10, scale: 2 }).notNull(),
  quantity: integer("quantity").notNull(),
  // Task #396 — per-line labor hours are 0 in flat mode. Default 0 so
  // flat-mode payloads can omit them.
  // IMPORTANT: on inspection-derived rows (findingId non-null) this column is a
  // LINE TOTAL accumulated by the merge in inspection-estimate-items.ts
  // (findings for the same part/zone are collapsed into one row and their hours
  // are summed). Do NOT multiply laborHours × quantity on these rows — doing so
  // double-counts.  Field-added rows (findingId null) store per-unit hours and
  // MUST be multiplied by quantity when computing a per_part labor sum.
  laborHours: decimal("labor_hours", { precision: 5, scale: 2 }).notNull().default("0.00"),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull(),
  actualQuantityUsed: integer("actual_quantity_used"),
  actualLaborHours: decimal("actual_labor_hours", { precision: 5, scale: 2 }),
  notes: text("notes"),
  // Task #1437 — zone detail carried through estimate→work-order conversion
  // so an inspection-origin work order's items group by controller/zone and
  // surface the originating issue type to the field tech. Nullable because
  // non-inspection work orders never populate them.
  controllerLetter: text("controller_letter"),
  zoneNumber: integer("zone_number"),
  issueType: text("issue_type"),
  // Task #1857 — nullable FK to irrigation_controllers.
  controllerId: integer("controller_id").references(() => irrigationControllers.id),
  // Per-item check-off state for the tech zone checklist. Null = not done.
  completedAt: timestamp("completed_at"),
  // Slice 3 lineage columns — finding_id links a WO item back to the wet-check
  // finding that produced it (null for non-inspection items such as field-added
  // parts). created_at records insert time so duplicate detection is trivial:
  // COUNT(*) > 1 per (work_order_id, finding_id). Both columns are nullable and
  // default-safe so the migration is a no-op against existing rows.
  findingId: integer("finding_id").references(() => wetCheckFindings.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// Invoices - created from completed work orders
// Monthly consolidated invoices that include all work for a customer
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  // invoice_number is stable across corrections — the same base number (#04723)
  // is kept when a correction is reissued.  revision bumps (1 → 2 → …) track
  // iterations.  Uniqueness is enforced on the (company_id, invoice_number,
  // revision) composite so the same base number can appear for Rev 1 and Rev 2.
  invoiceNumber: text("invoice_number").notNull(),
  revision: integer("revision").notNull().default(1),
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone"),
  // Monthly period this invoice covers
  invoiceMonth: integer("invoice_month").notNull(), // 1-12
  invoiceYear: integer("invoice_year").notNull(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  // Invoice details
  status: text("status").notNull().default("draft"), // draft, sent, paid, overdue, cancelled, superseded
  partsSubtotal: decimal("parts_subtotal", { precision: 10, scale: 2 }).notNull(),
  laborSubtotal: decimal("labor_subtotal", { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  // Payment info
  dueDate: timestamp("due_date"),
  sentAt: timestamp("sent_at"),
  paidAt: timestamp("paid_at"),
  quickbooksInvoiceId: text("quickbooks_invoice_id"),
  quickbooksSyncToken: text("quickbooks_sync_token"),
  // Task #1809 — billing type. 'monthly' is the historical default (consolidated
  // multi-ticket invoice). 'standalone' marks a single-ticket invoice created
  // via the "Bill Separately" action. Existing rows default to 'monthly'.
  billingType: text("billing_type").notNull().default("monthly"),
  // Invoice Correction: revision tracking. When an invoice is superseded by a
  // corrected reissue, `supersededByInvoiceId` links to the new invoice and
  // `status` flips to 'superseded'. The base invoiceNumber never changes;
  // `revision` increments (1 → 2 → …) to track correction iterations.
  supersededByInvoiceId: integer("superseded_by_invoice_id"),
  // Task #1756 — Invoice Merge: when an invoice is absorbed into a merge
  // survivor its status flips to 'merged' and this FK points at the survivor.
  // Distinct from 'cancelled' (genuine voids) and 'superseded' (corrections).
  // No .references() — self-referencing FKs on the same table cause TS7022
  // circular-inference errors (same pattern as supersededByInvoiceId above).
  mergedIntoInvoiceId: integer("merged_into_invoice_id"),
  // Task #1756 — freeform note explaining a pending QuickBooks manual action
  // (e.g. "Manually delete QB invoice INV-123 — this invoice was absorbed into
  // a merge"). Null on most rows; populated on merged/superseded invoices whose
  // QB records need manual cleanup.
  qbNote: text("qb_note"),
  // Task #1831 — QBO Payment-Status Sync.
  // `paymentStatus` is the 3-tier payment state read back from QBO Balance:
  //   unpaid (Balance == TotalAmt) | partially_paid (0 < Balance < TotalAmt) | paid (Balance == 0)
  // `balance` is the remaining amount owed (null = not yet synced / no QB link).
  // `paymentSyncedAt` is the last time we read Balance from QBO for this invoice.
  // Fully-paid invoices also set `status='paid'` and `paidAt` so all existing
  // paid-lock guards continue to fire without code changes.
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  balance: decimal("balance", { precision: 10, scale: 2 }),
  paymentSyncedAt: timestamp("payment_synced_at"),
  // Task #1848 — QBO void detection. Set when the sync loop detects that QBO
  // has voided this invoice (TotalAmt=0, PrivateNote contains "Voided"). NULL
  // means no void detected. Cleared when a later sync sees it is no longer voided.
  // Never auto-changes `status` or `paymentStatus`; only surfaces for human review.
  qbVoidDetectedAt: timestamp("qb_void_detected_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  companyIdx: index("invoices_company_idx").on(table.companyId),
  // Composite unique: same base number can appear for Rev 1, Rev 2, etc.
  // Replaces the old single-column unique on invoice_number.
  invoiceNumberRevisionUniq: uniqueIndex("invoices_invoice_number_revision_uniq").on(
    table.companyId,
    table.invoiceNumber,
    table.revision,
  ),
}));

// Line items for monthly invoices - can come from work orders OR billing sheets
export const invoiceItems = pgTable("invoice_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").references(() => invoices.id),
  // Source tracking - either from work order or billing sheet
  sourceType: text("source_type").notNull(), // "work_order" or "billing_sheet" or "wet_check_billing"
  sourceId: integer("source_id").notNull(), // ID of work order or billing sheet
  workOrderId: integer("work_order_id").references(() => workOrders.id), // Nullable for billing sheet items
  billingSheetId: integer("billing_sheet_id").references(() => billingSheets.id), // Nullable for work order items
  wetCheckBillingId: integer("wet_check_billing_id").references(() => wetCheckBillings.id), // Nullable; set when item originates from a wet_check_billing
  // Item details
  workDate: timestamp("work_date").notNull(),
  description: text("description").notNull(), // Work description or project name
  partId: integer("part_id").references(() => parts.id),
  partName: text("part_name"),
  partDescription: text("part_description"),
  quantity: decimal("quantity", { precision: 10, scale: 2 }).default("0"),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).default("0"),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).default("0"),
  laborHours: decimal("labor_hours", { precision: 5, scale: 2 }).default("0"),
  laborRate: decimal("labor_rate", { precision: 10, scale: 2 }).default("0"),
  laborTotal: decimal("labor_total", { precision: 10, scale: 2 }).default("0"),
});

// Invoice PDFs - auto-generated detailed breakdowns for customer sharing
export const invoicePdfs = pgTable("invoice_pdfs", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").references(() => invoices.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  pdfUrl: text("pdf_url").notNull(), // Google Cloud Storage URL
  filename: text("filename").notNull(), // Format: "Invoice_12345_Jan2025-Jan2025_Detail.pdf"
  status: text("status").notNull().default("generated"), // generated, sent, failed
  sentAt: timestamp("sent_at"), // When PDF was sent to customer
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Task #1887 — Invoice payment reminders.
//
// One row per reminder *attempt* against an invoice. A row is written only
// after the mailer has answered, never before, so nothing here describes an
// email that was merely intended.
//
// `deliveryStatus` separates the two outcomes:
//   'sent'   — the mailer accepted it. Consumes the next `sequenceNumber`.
//   'failed' — the mailer refused it. `sequenceNumber` stays NULL and
//              `deliveryError` carries the reason. A bounced email is not a
//              reminder the customer received, so a failure must not make the
//              next successful send read as "reminder #2".
//
// `balanceAtSend`, `daysOverdueAtSend` and `recipientEmail` are captured
// copies, not lookups. A reminder is history: it has to keep saying what the
// customer was told, at the address they were told it at, after the balance
// moves and after someone edits the customer's billing email. Never recompute
// these at read time.
export const invoiceReminders = pgTable("invoice_reminders", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  invoiceId: integer("invoice_id").references(() => invoices.id).notNull(),
  // Null only if the acting user is later deleted; every send records who.
  sentByUserId: integer("sent_by_user_id").references(() => users.id),
  sentByName: text("sent_by_name"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  // The address the mail actually went to, as used at send time.
  recipientEmail: text("recipient_email").notNull(),
  // 1, 2, 3 … per invoice, counting successful sends only. NULL on failures.
  sequenceNumber: integer("sequence_number"),
  templateKey: text("template_key").notNull(), // friendly | firm | final_notice
  balanceAtSend: decimal("balance_at_send", { precision: 10, scale: 2 }).notNull(),
  daysOverdueAtSend: integer("days_overdue_at_send").notNull(),
  deliveryStatus: text("delivery_status").notNull().default("sent"), // sent | failed
  deliveryError: text("delivery_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  companyIdx: index("invoice_reminders_company_idx").on(table.companyId),
  invoiceIdx: index("invoice_reminders_invoice_idx").on(table.invoiceId),
}));

// Task #1889 — Internal A/R notes on an invoice.
//
// ─────────────────────────────────────────────────────────────────────────────
// THESE NOTES ARE INTERNAL. THEY MUST NEVER APPEAR ON A CUSTOMER-FACING
// DOCUMENT OR EMAIL — not on the invoice PDF, not in the invoice or reminder
// mailers, not in the CSV export, not anywhere a customer can be handed a
// file. If you are here because you are adding a field to the PDF pipeline or
// to an email template, this table is not a source you may read from.
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the collections conversation — "left a voicemail", "AP says it's in
// the next check run", "disputing the second ticket" — and it is candid on
// purpose. It is distinct from BOTH of the note fields that already exist on
// an invoice: the printed notes the customer reads, and `invoices.qbNote`,
// which describes a pending QuickBooks cleanup action. Do not merge any of the
// three.
//
// Append-only. There is deliberately no `updatedAt`, no `deletedAt`, and no
// update/delete endpoint anywhere in the product — the thread is a record of
// what was said and when, not a scratchpad. `authorName` is captured at write
// time alongside the FK so the history stays readable after a user is renamed
// or deactivated, the same way reminder history captures `sentByName`.
//
// Reads are gated on CAN_READ_AR_NOTES (see lib/shared/src/roles.ts), which is
// narrower than invoice-read access.
export const invoiceArNotes = pgTable("invoice_ar_notes", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  invoiceId: integer("invoice_id").references(() => invoices.id).notNull(),
  // Null only if the author is later deleted; every note records who wrote it.
  authorUserId: integer("author_user_id").references(() => users.id),
  authorName: text("author_name"),
  note: text("note").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  companyIdx: index("invoice_ar_notes_company_idx").on(table.companyId),
  invoiceIdx: index("invoice_ar_notes_invoice_idx").on(table.invoiceId),
}));

// Notifications table for workflow notifications
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  type: text("type").notNull(), // "work_order_assigned", "work_order_completed", "estimate_pending_approval"
  title: text("title").notNull(),
  message: text("message").notNull(),
  relatedEntityType: text("related_entity_type"), // "work_order", "estimate", "billing_sheet"
  relatedEntityId: integer("related_entity_id"),
  isRead: boolean("is_read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Task #687 — Financial Pulse Slice 1. Idempotency table for per-period
// budget alerts. The (customer_id, period, threshold, period_key) unique
// index is what guarantees we only fire one warning + one exceeded per
// month/year per customer. `period` is 'monthly' | 'annual', `threshold`
// is 'soft' | 'hard', `period_key` is 'YYYY-MM' for monthly and 'YYYY'
// for annual.
export const customerBudgetAlertEvents = pgTable("customer_budget_alert_events", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  period: text("period").notNull(),
  threshold: text("threshold").notNull(),
  periodKey: text("period_key").notNull(),
  triggeringInvoiceId: integer("triggering_invoice_id").references(() => invoices.id),
  firedAt: timestamp("fired_at").defaultNow().notNull(),
}, (table) => ({
  uniq: uniqueIndex("customer_budget_alert_events_unique_idx").on(
    table.customerId,
    table.period,
    table.threshold,
    table.periodKey,
  ),
  customerIdx: index("customer_budget_alert_events_customer_idx").on(table.customerId),
}));

// Parts reference list tables - per-company, database-backed
export const partCategories = pgTable("part_categories", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(),
  markupPercent: decimal("markup_percent", { precision: 5, scale: 2 }).default("0.00"),
});

export const partBrands = pgTable("part_brands", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(),
});

export const partSizes = pgTable("part_sizes", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(),
});

export const partMaterials = pgTable("part_materials", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(),
});

export const partFittingTypes = pgTable("part_fitting_types", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(),
});

// External API Keys for CRM integrations
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  name: text("name").notNull(), // e.g., "Landscape CRM Integration"
  apiKey: text("api_key").notNull().unique(), // The actual API key (hashed or plain)
  keyPrefix: text("key_prefix").notNull(), // First 8 chars for display (e.g., "irpk_abc1...")
  isActive: boolean("is_active").notNull().default(true),
  lastUsedAt: timestamp("last_used_at"),
  createdBy: integer("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"), // Optional expiration
});

// Drizzle insert schemas
// Zod schemas for validation
export const insertCompanySchema = createInsertSchema(companies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCustomerSchema = createInsertSchema(customers).omit({ id: true });
export const insertPartSchema = createInsertSchema(parts).omit({ 
  id: true, 
  createdAt: true, 
  updatedAt: true 
}).extend({
  price: z.union([z.string(), z.number()]).transform(val => {
    const num = typeof val === 'string' ? parseFloat(val.replace(/[^0-9.-]/g, '')) : val;
    return isNaN(num) ? 0 : num;
  }),
  cost: z.union([z.string(), z.number(), z.null()]).transform(val => {
    if (val === null || val === undefined || val === '') return null;
    const num = typeof val === 'string' ? parseFloat(val.replace(/[^0-9.-]/g, '')) : val;
    return isNaN(num) ? null : num;
  }).optional(),
});
export const insertAssemblySchema = createInsertSchema(assemblies).omit({ 
  id: true, 
  totalPrice: true,
  totalLaborHours: true,
  usageCount: true,
  createdAt: true, 
  updatedAt: true 
});

export const insertAssemblyPartSchema = createInsertSchema(assemblyParts).omit({ 
  id: true 
}).extend({
  quantity: z.union([z.string(), z.number()]).transform(val => {
    const num = typeof val === 'string' ? parseFloat(val.replace(/[^0-9.-]/g, '')) : val;
    return isNaN(num) ? 1.0 : num;
  }),
});

// companyId is always stamped server-side; clients must never send it directly.
export const insertEstimateSchema = createInsertSchema(estimates).omit({ id: true, estimateNumber: true, createdAt: true, updatedAt: true, companyId: true });
export const insertEstimateItemSchema = createInsertSchema(estimateItems).omit({ id: true });
// insertPropertyZoneSchema, insertZoneSchema, insertFieldWorkSessionSchema, insertFieldWorkItemSchema
// removed by Task #1857 — prototype tables dropped.
export const insertQuickbooksIntegrationSchema = createInsertSchema(quickbooksIntegration).omit({ id: true });
export const insertQuickbooksSyncSchema = createInsertSchema(quickbooksSync).omit({ id: true });
export const workOrderStatusValues = ['pending', 'assigned', 'in_progress', 'work_completed', 'pending_manager_review', 'approved_passed_to_billing', 'cancelled', 'billed'] as const;
export type WorkOrderStatus = typeof workOrderStatusValues[number];

// Task #207 — billing sheet status values, locked to the modern set so the
// legacy 'approved' status (replaced by 'approved_passed_to_billing') can no
// longer enter the system via the API.
export const billingSheetStatusValues = ['draft', 'submitted', 'completed', 'pending_manager_review', 'approved_passed_to_billing', 'billed'] as const;
export type BillingSheetStatus = typeof billingSheetStatusValues[number];

export const insertWorkOrderSchema = createInsertSchema(workOrders)
  .omit({
    id: true,
    workOrderNumber: true,
    // companyId is always stamped server-side from the authenticated user's
    // company; clients must never send it directly.
    companyId: true,
    createdAt: true,
    updatedAt: true,
    // No-photos-needed audit fields are stamped only via the dedicated
    // POST /api/work-orders/:id/no-photos-needed endpoint, never via PATCH.
    noPhotosNeeded: true,
    noPhotosNeededBy: true,
    noPhotosNeededAt: true,
  })
  .extend({
    status: z.enum(workOrderStatusValues).optional(),
    scheduledDate: z.union([z.string(), z.date()]).transform(val => val instanceof Date ? val : val ? new Date(val) : undefined).optional().nullable(),
    startedAt: z.union([z.string(), z.date()]).transform(val => val instanceof Date ? val : val ? new Date(val) : undefined).optional().nullable(),
    completedAt: z.union([z.string(), z.date()]).transform(val => val instanceof Date ? val : val ? new Date(val) : undefined).optional().nullable(),
  });
export const insertWorkOrderItemSchema = createInsertSchema(workOrderItems).omit({ id: true });
export const insertInvoiceSchema = createInsertSchema(invoices).omit({ id: true, invoiceNumber: true, companyId: true, createdAt: true, updatedAt: true });
export const insertInvoiceItemSchema = createInsertSchema(invoiceItems).omit({ id: true });
export const insertInvoicePdfSchema = createInsertSchema(invoicePdfs).omit({ id: true, createdAt: true });
export const insertInvoiceReminderSchema = createInsertSchema(invoiceReminders).omit({ id: true, createdAt: true });
// Task #1889 — internal A/R notes. `createdAt` is omitted deliberately: the
// note's timestamp is the server's, never the client's.
export const insertInvoiceArNoteSchema = createInsertSchema(invoiceArNotes).omit({ id: true, createdAt: true });
export const insertBillingSheetSchema = createInsertSchema(billingSheets)
  .omit({
    id: true,
    billingNumber: true,
    // companyId is always stamped server-side; clients must never send it directly.
    companyId: true,
    createdAt: true,
    updatedAt: true,
    // Task #197 — no-photos-needed audit fields are stamped only via the
    // dedicated POST /api/billing-sheets/:id/no-photos-needed endpoint.
    noPhotosNeeded: true,
    noPhotosNeededBy: true,
    noPhotosNeededAt: true,
  })
  .extend({
    // Task #207 — reject the legacy 'approved' status at the API boundary.
    status: z.enum(billingSheetStatusValues).optional(),
  });
export const insertBillingSheetItemSchema = createInsertSchema(billingSheetItems).omit({ id: true });
export const insertManualPartReviewSchema = createInsertSchema(manualPartReviews).omit({ id: true, createdAt: true });
export const insertAiGenerationLogSchema = createInsertSchema(aiGenerationLogs).omit({ id: true, createdAt: true });
export const insertPartUsageSchema = createInsertSchema(partUsage).omit({ id: true, updatedAt: true });
export const insertNotificationSchema = createInsertSchema(notifications).omit({ id: true, createdAt: true });
export const insertApiKeySchema = createInsertSchema(apiKeys).omit({ id: true, createdAt: true });

// Parts reference list insert schemas
export const insertPartCategorySchema = createInsertSchema(partCategories).omit({ id: true });
export const insertPartBrandSchema = createInsertSchema(partBrands).omit({ id: true });
export const insertPartSizeSchema = createInsertSchema(partSizes).omit({ id: true });
export const insertPartMaterialSchema = createInsertSchema(partMaterials).omit({ id: true });
export const insertPartFittingTypeSchema = createInsertSchema(partFittingTypes).omit({ id: true });

export type PartCategory = typeof partCategories.$inferSelect;
export type PartBrand = typeof partBrands.$inferSelect;
export type PartSize = typeof partSizes.$inferSelect;
export type PartMaterial = typeof partMaterials.$inferSelect;
export type PartFittingType = typeof partFittingTypes.$inferSelect;

export type InsertPartCategory = z.infer<typeof insertPartCategorySchema>;
export type InsertPartBrand = z.infer<typeof insertPartBrandSchema>;
export type InsertPartSize = z.infer<typeof insertPartSizeSchema>;
export type InsertPartMaterial = z.infer<typeof insertPartMaterialSchema>;
export type InsertPartFittingType = z.infer<typeof insertPartFittingTypeSchema>;

export type Company = typeof companies.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type User = typeof users.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Part = typeof parts.$inferSelect;
export type Assembly = typeof assemblies.$inferSelect;
export type AssemblyPart = typeof assemblyParts.$inferSelect;
// `lifecycleStatus` is computed server-side and attached to Estimate rows
// before they leave the API. Keep it as a narrow string-literal union here so
// downstream consumers can `switch` on it exhaustively. Mirrors the canonical
// list in `artifacts/api-server/src/lifecycle.ts`.
export type LifecycleStatus =
  | "draft"
  | "pending_review"
  | "sent"
  | "approved"
  | "rejected"
  | "expired";
export type Estimate = typeof estimates.$inferSelect & { lifecycleStatus?: LifecycleStatus };
export type EstimateItem = typeof estimateItems.$inferSelect;
// PropertyZone, Zone, FieldWorkSession, FieldWorkItem removed by Task #1857.
export type QuickbooksIntegration = typeof quickbooksIntegration.$inferSelect;
export type QuickbooksSync = typeof quickbooksSync.$inferSelect;
export type WorkOrder = typeof workOrders.$inferSelect;
export type WorkOrderItem = typeof workOrderItems.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type InvoicePdf = typeof invoicePdfs.$inferSelect;
export type InvoiceReminder = typeof invoiceReminders.$inferSelect;
export type InsertInvoiceReminder = typeof invoiceReminders.$inferInsert;
export type InvoiceArNote = typeof invoiceArNotes.$inferSelect;
export type InsertInvoiceArNote = typeof invoiceArNotes.$inferInsert;
export type BillingSheet = typeof billingSheets.$inferSelect;
export type BillingNumberCounter = typeof billingNumberCounters.$inferSelect;
export type BillingSheetItem = typeof billingSheetItems.$inferSelect;
export type ManualPartReview = typeof manualPartReviews.$inferSelect;
export type AiGenerationLog = typeof aiGenerationLogs.$inferSelect;
export type PartUsage = typeof partUsage.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type CustomerBudgetAlertEvent = typeof customerBudgetAlertEvents.$inferSelect;
export type InsertCustomerBudgetAlertEvent = typeof customerBudgetAlertEvents.$inferInsert;
export type MissingPhotosNotification = typeof missingPhotosNotifications.$inferSelect;

export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type InsertPart = z.infer<typeof insertPartSchema>;
export type InsertAssembly = z.infer<typeof insertAssemblySchema>;
export type InsertAssemblyPart = z.infer<typeof insertAssemblyPartSchema>;
export type InsertEstimate = z.infer<typeof insertEstimateSchema>;
export type InsertEstimateItem = z.infer<typeof insertEstimateItemSchema>;
// InsertPropertyZone, InsertZone, InsertFieldWorkSession, InsertFieldWorkItem removed by Task #1857.
export type InsertQuickbooksIntegration = z.infer<typeof insertQuickbooksIntegrationSchema>;
export type InsertQuickbooksSync = z.infer<typeof insertQuickbooksSyncSchema>;
export type InsertWorkOrder = z.infer<typeof insertWorkOrderSchema>;
export type InsertWorkOrderItem = z.infer<typeof insertWorkOrderItemSchema>;
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type InsertInvoiceItem = z.infer<typeof insertInvoiceItemSchema>;
export type InsertInvoicePdf = z.infer<typeof insertInvoicePdfSchema>;
export type InsertBillingSheet = z.infer<typeof insertBillingSheetSchema>;
export type InsertBillingSheetItem = z.infer<typeof insertBillingSheetItemSchema>;
export type InsertManualPartReview = z.infer<typeof insertManualPartReviewSchema>;
export type InsertAiGenerationLog = z.infer<typeof insertAiGenerationLogSchema>;
export type InsertPartUsage = z.infer<typeof insertPartUsageSchema>;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type InsertSiteMap = z.infer<typeof insertSiteMapSchema>;
export type InsertController = z.infer<typeof insertControllerSchema>;
export type InsertIrrigationZone = z.infer<typeof insertIrrigationZoneSchema>;

export type EstimateWithItems = Estimate & {
  items: EstimateItem[];
};

// PropertyZoneWithZones and FieldWorkSessionWithItems removed by Task #1857.

export type WorkOrderWithItems = WorkOrder & {
  items: WorkOrderItem[];
};

export type InvoiceWithItems = Invoice & {
  items: InvoiceItem[];
};

export type BillingSheetWithItems = BillingSheet & {
  items: BillingSheetItem[];
};

export type AssemblyWithParts = Assembly & {
  parts: (AssemblyPart & { part: Part })[];
};

// Pricing audit events (Task #212) — one row per automatic reprice action
// performed by the catalog $0-price audit (Task #168) or the labor-rate
// mismatch audit (Task #200). Task #210 removed the audit text that used to
// be appended to billing_sheets.notes / work_orders.notes (because it was
// leaking into the customer-facing PDF). This structured table restores the
// in-app history for managers without touching customer-facing fields.
export const pricingAuditEvents = pgTable("pricing_audit_events", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id),
  source: text("source").notNull(), // 'billing_sheet' | 'work_order' | 'invoice'
  parentId: integer("parent_id").notNull(),
  parentNumber: text("parent_number"), // billing/work-order/invoice number snapshot
  kind: text("kind").notNull(), // 'catalog_reprice' | 'labor_rate_reprice'
  delta: decimal("delta", { precision: 14, scale: 2 }).notNull(), // signed change to total amount
  itemCount: integer("item_count").notNull().default(0),
  actorUserId: integer("actor_user_id").references(() => users.id),
  actorName: text("actor_name"), // snapshot of who performed the action
  details: jsonb("details"), // optional structured payload (per-item breakdown, rate changes, etc.)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  parentLookupIdx: index("pricing_audit_events_parent_idx").on(table.source, table.parentId),
}));

export const insertPricingAuditEventSchema = createInsertSchema(pricingAuditEvents).omit({
  id: true,
  createdAt: true,
});
export type PricingAuditEvent = typeof pricingAuditEvents.$inferSelect;
export type InsertPricingAuditEvent = z.infer<typeof insertPricingAuditEventSchema>;

// Task #195: audit trail for photos added to a ticket AFTER it has reached
// billing (status `billed` / `approved_passed_to_billing`, or has an
// `invoiceId`). Lets managers prove who added the late photo, when, and what
// state the ticket was in at the time.
export const photoLateAdditions = pgTable("photo_late_additions", {
  id: serial("id").primaryKey(),
  ticketType: text("ticket_type").notNull(), // 'work_order' | 'billing_sheet'
  ticketId: integer("ticket_id").notNull(),
  ticketNumber: text("ticket_number"), // work order / billing number snapshot
  ticketStatusAtAddition: text("ticket_status_at_addition"),
  invoiceIdAtAddition: integer("invoice_id_at_addition"),
  companyId: integer("company_id").references(() => companies.id),
  actorUserId: integer("actor_user_id").references(() => users.id),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  priorPhotos: text("prior_photos").array().notNull().default(sql`ARRAY[]::text[]`),
  newPhotos: text("new_photos").array().notNull().default(sql`ARRAY[]::text[]`),
  addedPhotos: text("added_photos").array().notNull().default(sql`ARRAY[]::text[]`),
  removedPhotos: text("removed_photos").array().notNull().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  ticketLookupIdx: index("photo_late_additions_ticket_idx").on(table.ticketType, table.ticketId),
}));

export const insertPhotoLateAdditionSchema = createInsertSchema(photoLateAdditions).omit({
  id: true,
  createdAt: true,
});
export type PhotoLateAddition = typeof photoLateAdditions.$inferSelect;
export type InsertPhotoLateAddition = z.infer<typeof insertPhotoLateAdditionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Wet Check System (Slice 2A)
// ─────────────────────────────────────────────────────────────────────────────

// property_controllers was retired by Task #1857 (One irrigation system per customer).
// The table is dropped by migration 0018; this declaration is removed from the schema.
// irrigation_controllers is now the single source of truth for controller/zone data.

// Issue type catalog — drives the field-UI preset grid and the per-issue
// labor defaults / part category filter for the part picker.
export const issueTypeConfigs = pgTable("issue_type_configs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  issueType: text("issue_type").notNull(),
  issueGroup: text("issue_group").notNull(), // quick_fix | advanced | zone_issue
  displayLabel: text("display_label").notNull(),
  defaultLaborHours: decimal("default_labor_hours", { precision: 5, scale: 2 }).notNull(),
  partCategoryFilter: text("part_category_filter"),
  // When true, no part is ever needed for this issue type (e.g. a pure labor
  // issue where the picker is hidden and noPartNeeded is auto-injected).
  laborOnly: boolean("labor_only").notNull().default(false),
  // When true, a part is optional but not required for this issue type
  // (e.g. head_adjustment — the tech may or may not swap a nozzle alongside
  // the adjustment). The part picker is shown; the convert guard skips the
  // missing-part block; noPartNeeded is auto-injected when no part is chosen.
  partOptional: boolean("part_optional").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  uniqIssueType: uniqueIndex("uniq_issue_type").on(table.companyId, table.issueType),
}));

export const wetChecks = pgTable("wet_checks", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  technicianId: integer("technician_id").references(() => users.id).notNull(),
  technicianName: text("technician_name").notNull(),
  customerName: text("customer_name").notNull(),
  propertyAddress: text("property_address"),
  numControllers: integer("num_controllers").notNull(),
  status: text("status").notNull().default("in_progress"),
  // in_progress | submitted | approved | partially_converted | converted
  weather: text("weather"),
  notes: text("notes"),
  // Task #396 — labor mode for findings on this wet check. 'flat' uses
  // totalLaborHours as the authoritative aggregate; 'per_part' sums per-finding
  // laborHours. Default 'flat' for new wet checks; existing are backfilled to
  // 'per_part'.
  // NOTE (WCB, Task #753): ignored for wet_check_billings rows. The authoritative
  // labor sources for WCB invoices are wc.totalLaborHours (inspection overhead:
  // travel, setup, etc.) and zone.repairLaborHours (per-zone repair labor).
  // This column is preserved for non-wet-check billing paths.
  laborMode: text("labor_mode").notNull().default("flat"),
  totalLaborHours: decimal("total_labor_hours", { precision: 6, scale: 2 }).notNull().default("0.00"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  submittedAt: timestamp("submitted_at"),
  approvedAt: timestamp("approved_at"),
  approvedBy: integer("approved_by").references(() => users.id),
  approvedByName: text("approved_by_name"),
  fullyConvertedAt: timestamp("fully_converted_at"),
  clientId: text("client_id"),
  mode: text("mode").notNull().default("service"),
  // 'service' (default) = active repair run; 'inspection' = assessment-only,
  // no repair/disposition controls shown in the field capture flow.
  // Task #315 — selected branch for multi-location customers. NULL for
  // single-location customers or legacy rows without branch selection.
  // Mirrors the convention used by work_orders and wet_check_billings.
  branchName: text("branch_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  clientIdUniq: uniqueIndex("uniq_wet_check_client_id")
    .on(table.clientId)
    .where(sql`${table.clientId} IS NOT NULL`),
  customerIdx: index("idx_wet_checks_customer").on(table.customerId),
  statusIdx: index("idx_wet_checks_status").on(table.companyId, table.status),
}));

export const wetCheckZoneRecords = pgTable("wet_check_zone_records", {
  id: serial("id").primaryKey(),
  wetCheckId: integer("wet_check_id").references(() => wetChecks.id, { onDelete: "cascade" }).notNull(),
  controllerLetter: text("controller_letter").notNull(),
  zoneNumber: integer("zone_number").notNull(),
  status: text("status").notNull().default("not_checked"),
  // not_checked | checked_ok | checked_with_issues | not_applicable
  ranSuccessfully: boolean("ran_successfully"),
  observedPressure: decimal("observed_pressure", { precision: 6, scale: 2 }),
  observedFlow: decimal("observed_flow", { precision: 6, scale: 2 }),
  notes: text("notes"),
  checkedAt: timestamp("checked_at"),
  checkedBy: integer("checked_by").references(() => users.id),
  // Task #458 — set when the tech taps "Mark Zone Complete" on a Needs Work
  // zone, so the controller grid can distinguish reviewed-and-confirmed
  // Needs Work zones from ones still mid-edit. Cleared automatically when
  // the zone status moves away from `checked_with_issues`.
  markedCompleteAt: timestamp("marked_complete_at"),
  // Task #753 — Slice 4: per-zone repair labor hours (Option B). Authoritative
  // labor total for billing — replaces per-finding sum in wet_check_billings math.
  // Multiples of 0.25 only; enforced by the API layer (repairLaborHoursSchema).
  repairLaborHours: decimal("repair_labor_hours", { precision: 5, scale: 2 }).notNull().default("0.00"),
  // Task #891 — when false (default) the server auto-computes repairLaborHours
  // from SUM(issueTypeConfigs.defaultLaborHours) for all findings on this zone.
  // When true an explicit edit has been made and the server leaves the value alone
  // on finding-set changes. Reset to false via the /reset endpoint.
  repairLaborManuallySet: boolean("repair_labor_manually_set").notNull().default(false),
  clientId: text("client_id"),
  // Task #1857 — nullable FK to irrigation_controllers row. Backfilled via migration 0016.
  // After the backfill and index swap (migration 0017), zone records are keyed by
  // controller row rather than letter string.
  controllerId: integer("controller_id").references(() => irrigationControllers.id),
}, (table) => ({
  // Task #1857 — new unique index on (wetCheckId, controllerId, zoneNumber), partial
  // WHERE controller_id IS NOT NULL. The old letter-based index was dropped by migration 0017.
  uniqZone: uniqueIndex("uniq_wet_check_zone").on(table.wetCheckId, table.controllerId, table.zoneNumber).where(sql`${table.controllerId} IS NOT NULL`),
  clientIdUniq: uniqueIndex("uniq_zone_record_client_id")
    .on(table.clientId)
    .where(sql`${table.clientId} IS NOT NULL`),
}));

export const wetCheckFindings = pgTable("wet_check_findings", {
  id: serial("id").primaryKey(),
  zoneRecordId: integer("zone_record_id").references(() => wetCheckZoneRecords.id, { onDelete: "cascade" }).notNull(),
  wetCheckId: integer("wet_check_id").references(() => wetChecks.id).notNull(),
  issueType: text("issue_type").notNull(),
  issueGroup: text("issue_group").notNull(),
  severity: text("severity"),
  partId: integer("part_id").references(() => parts.id),
  partName: text("part_name"),
  partPrice: decimal("part_price", { precision: 10, scale: 2 }),
  quantity: integer("quantity").notNull(),
  // Task #396 — per-finding labor hours; in flat mode the parent wet check's
  // totalLaborHours is authoritative and findings may default to 0.
  laborHours: decimal("labor_hours", { precision: 5, scale: 2 }).notNull().default("0.00"),
  notes: text("notes"),
  resolution: text("resolution").notNull().default("pending"),
  // pending | repaired_in_field | sent_to_estimate | deferred_to_work_order | documented_only
  // Task #464 — labor-only Mark Complete. When true on a repaired_in_field
  // finding with no partId, the auto-bill path writes a labor-only line
  // (qty 0 / part price 0) instead of throwing the missing-part guard.
  // Cleared automatically by the server whenever a partId is assigned, so
  // the two states can never both be true.
  noPartNeeded: boolean("no_part_needed").notNull().default(false),
  // Task #428 — tech intent, decoupled from `resolution` so manager rerouting
  // (e.g. → sent_to_estimate) does not erase what the field tech said about
  // the work. Values: needs_review | completed_in_field. Null on legacy rows
  // is treated as needs_review by the UI.
  techDisposition: text("tech_disposition"),
  resolutionDecidedAt: timestamp("resolution_decided_at"),
  resolutionDecidedBy: integer("resolution_decided_by").references(() => users.id),
  billingSheetId: integer("billing_sheet_id").references(() => billingSheets.id),
  wetCheckBillingId: integer("wet_check_billing_id").references(() => wetCheckBillings.id),
  estimateId: integer("estimate_id").references(() => estimates.id),
  workOrderId: integer("work_order_id").references(() => workOrders.id),
  convertedAt: timestamp("converted_at"),
  clientId: text("client_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  wetCheckIdx: index("idx_findings_wet_check").on(table.wetCheckId),
  zoneIdx: index("idx_findings_zone").on(table.zoneRecordId),
  clientIdUniq: uniqueIndex("uniq_finding_client_id")
    .on(table.clientId)
    .where(sql`${table.clientId} IS NOT NULL`),
  // At most one routing target may be set on a finding (billing | estimate | work order).
  singleTargetCheck: check(
    "wet_check_finding_single_target",
    sql`(
      (CASE WHEN ${table.billingSheetId} IS NULL THEN 0 ELSE 1 END)
      + (CASE WHEN ${table.estimateId}     IS NULL THEN 0 ELSE 1 END)
      + (CASE WHEN ${table.workOrderId}    IS NULL THEN 0 ELSE 1 END)
    ) <= 1`,
  ),
}));

// Wet-check billing records — dedicated billing table for work discovered
// during wet checks. Separated from billing_sheets (Slice 10 schema foundation).
// `wetCheckId` is NOT NULL (every WCB row must reference its source wet check).
// Later slices (11–16) rewire conversion, migrate data, expose HTTP endpoints.
export const wetCheckBillings = pgTable("wet_check_billings", {
  id: serial("id").primaryKey(),
  billingNumber: text("billing_number").notNull().unique(),
  customerId: integer("customer_id").references(() => customers.id),
  customerName: text("customer_name").notNull(),
  propertyAddress: text("property_address").notNull(),
  workDate: timestamp("work_date").notNull(),
  technicianName: text("technician_name").notNull(),
  technicianId: integer("technician_id").references(() => users.id),
  // Wet-check link — NOT NULL: every WCB row must trace back to its wet check.
  wetCheckId: integer("wet_check_id").references(() => wetChecks.id).notNull(),
  status: text("status").notNull().default("submitted"), // submitted | pending_manager_review | approved_passed_to_billing | billed
  totalHours: decimal("total_hours", { precision: 5, scale: 2 }).notNull(),
  laborRate: decimal("labor_rate", { precision: 10, scale: 2 }).notNull(),
  laborSubtotal: decimal("labor_subtotal", { precision: 10, scale: 2 }).notNull(),
  partsSubtotal: decimal("parts_subtotal", { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  // Snapshot of customer.laborRate at creation time.
  appliedLaborRate: decimal("applied_labor_rate", { precision: 10, scale: 2 }),
  // Task #1093 — Normal / Emergency rate toggle.
  rateMode: text("rate_mode").notNull().default("normal"),
  // Invoice linkage — prevents double billing.
  invoiceId: integer("invoice_id").references(() => invoices.id),
  billedAt: timestamp("billed_at"),
  photos: text("photos").array().default([]),
  notes: text("notes"),
  branchName: text("branch_name"),
  // Manager approval stamp fields.
  approvedBy: text("approved_by"),
  approvedByUserId: integer("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  approvedTotal: decimal("approved_total", { precision: 10, scale: 2 }),
  approvedPartsSnapshot: text("approved_parts_snapshot"), // JSON snapshot of parts at approval
  approvedLaborSnapshot: text("approved_labor_snapshot"), // JSON snapshot of labor details at approval
  // Slice 2 — role of the actor who approved. NULL on legacy rows (treated as
  // "unknown", not flagged). Used by the manager queue to detect billing-side
  // approvals (billing_manager / company_admin) that bypassed irrigation_manager review.
  approvedByRole: text("approved_by_role"),
  // "No photos needed" audit flag — mirrors billing_sheets.no_photos_needed.
  noPhotosNeeded: boolean("no_photos_needed").notNull().default(false),
  noPhotosNeededBy: integer("no_photos_needed_by").references(() => users.id),
  noPhotosNeededAt: timestamp("no_photos_needed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  customerIdx: index("wet_check_billings_customer_idx").on(table.customerId),
  technicianIdx: index("wet_check_billings_technician_idx").on(table.technicianId),
  wetCheckIdx: index("wet_check_billings_wet_check_idx").on(table.wetCheckId),
  invoiceIdx: index("wet_check_billings_invoice_idx").on(table.invoiceId),
  statusCreatedIdx: index("wet_check_billings_status_created_idx").on(table.status, table.createdAt),
}));

export const insertWetCheckBillingSchema = createInsertSchema(wetCheckBillings).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type WetCheckBilling = typeof wetCheckBillings.$inferSelect;
export type InsertWetCheckBilling = z.infer<typeof insertWetCheckBillingSchema>;

// Shared list-item type: WetCheckBilling extended with aggregate counts
// computed in getAllWetCheckBillingsWithCounts() and consumed by the billing
// list page. Defined here so both the API server and the frontend can import
// from @workspace/db without duplicating the shape.
export type WetCheckBillingListItem = WetCheckBilling & {
  issuesCount: number;
  zonesCount: number;
  wetCheckStatus: string | null;
  wetCheckMode: string | null;
  daysInQueue: number;
  findingsRepaired: number;
  findingsToEstimate: number;
  findingsDeferred: number;
  /** Count of findings on the parent wet check that are still genuinely unrouted
   *  (isNeedsReview=true, convertedAt null, all four routing FKs null).
   *  Zero means every finding is triaged — used by wcbIsEligible() for the
   *  invoice-construction billing gate. */
  unroutedFindingsCount: number;
};

export const wetCheckPhotos = pgTable("wet_check_photos", {
  id: serial("id").primaryKey(),
  wetCheckId: integer("wet_check_id").references(() => wetChecks.id, { onDelete: "cascade" }).notNull(),
  zoneRecordId: integer("zone_record_id").references(() => wetCheckZoneRecords.id, { onDelete: "set null" }),
  findingId: integer("finding_id").references(() => wetCheckFindings.id, { onDelete: "set null" }),
  url: text("url").notNull(),
  caption: text("caption"),
  takenAt: timestamp("taken_at").defaultNow().notNull(),
  takenBy: integer("taken_by").references(() => users.id).notNull(),
  clientId: text("client_id"),
}, (table) => ({
  wetCheckIdx: index("idx_photos_wet_check").on(table.wetCheckId),
  clientIdUniq: uniqueIndex("uniq_photo_client_id")
    .on(table.clientId)
    .where(sql`${table.clientId} IS NOT NULL`),
}));

// Task #1437 — structured, zone-linked completed-work photos for work
// orders. This is the canonical store for "what the tech fixed in this
// zone", deliberately separate from the flat work_orders.photos array.
// Mirrors wet_check_photos: optional FK to the work-order item the photo
// documents, plus a controller/zone tag so the checklist can group photos
// by zone even when no item FK is supplied. clientId provides offline
// idempotency exactly like the wet-check photo pipeline.
export const workOrderZonePhotos = pgTable("work_order_zone_photos", {
  id: serial("id").primaryKey(),
  workOrderId: integer("work_order_id").references(() => workOrders.id, { onDelete: "cascade" }).notNull(),
  workOrderItemId: integer("work_order_item_id").references(() => workOrderItems.id, { onDelete: "set null" }),
  controllerLetter: text("controller_letter"),
  zoneNumber: integer("zone_number"),
  // Task #1857 — nullable FK to irrigation_controllers.
  controllerId: integer("controller_id").references(() => irrigationControllers.id),
  url: text("url").notNull(),
  caption: text("caption"),
  takenAt: timestamp("taken_at").defaultNow().notNull(),
  takenBy: integer("taken_by").references(() => users.id).notNull(),
  clientId: text("client_id"),
}, (table) => ({
  workOrderIdx: index("idx_wo_zone_photos_work_order").on(table.workOrderId),
  workOrderItemIdx: index("idx_wo_zone_photos_item").on(table.workOrderItemId),
  clientIdUniq: uniqueIndex("uniq_wo_zone_photo_client_id")
    .on(table.clientId)
    .where(sql`${table.clientId} IS NOT NULL`),
}));

// insertPropertyControllerSchema removed by Task #1857.
export const insertIssueTypeConfigSchema = createInsertSchema(issueTypeConfigs).omit({
  id: true, createdAt: true, updatedAt: true,
});
export const insertWetCheckSchema = createInsertSchema(wetChecks).omit({
  id: true, createdAt: true, updatedAt: true,
});
export const insertWetCheckZoneRecordSchema = createInsertSchema(wetCheckZoneRecords).omit({ id: true });
export const insertWetCheckFindingSchema = createInsertSchema(wetCheckFindings).omit({
  id: true, createdAt: true, updatedAt: true,
});
export const insertWetCheckPhotoSchema = createInsertSchema(wetCheckPhotos).omit({ id: true });
export const insertWorkOrderZonePhotoSchema = createInsertSchema(workOrderZonePhotos).omit({ id: true });

// PropertyController removed by Task #1857 — table dropped.
export type IssueTypeConfig = typeof issueTypeConfigs.$inferSelect;
export type WetCheck = typeof wetChecks.$inferSelect;
export type WetCheckZoneRecord = typeof wetCheckZoneRecords.$inferSelect;
export type WetCheckFinding = typeof wetCheckFindings.$inferSelect;
export type WetCheckPhoto = typeof wetCheckPhotos.$inferSelect;
export type WorkOrderZonePhoto = typeof workOrderZonePhotos.$inferSelect;

// InsertPropertyController removed by Task #1857.
export type InsertIssueTypeConfig = z.infer<typeof insertIssueTypeConfigSchema>;
export type InsertWetCheck = z.infer<typeof insertWetCheckSchema>;
export type InsertWetCheckZoneRecord = z.infer<typeof insertWetCheckZoneRecordSchema>;
export type InsertWetCheckFinding = z.infer<typeof insertWetCheckFindingSchema>;
export type InsertWetCheckPhoto = z.infer<typeof insertWetCheckPhotoSchema>;
export type InsertWorkOrderZonePhoto = z.infer<typeof insertWorkOrderZonePhotoSchema>;

export type WetCheckFindingWithReason = WetCheckFinding & {
  pendingReason?: string | null;
};

export type WetCheckWithDetails = WetCheck & {
  zoneRecords: (WetCheckZoneRecord & { findings: WetCheckFindingWithReason[] })[];
  photos: WetCheckPhoto[];
  // Slice 3 — lineage surfacing: set when an estimate was created from
  // this inspection's findings (estimates.originWetCheckId = this.id).
  // originatedWorkOrderId is also set when that estimate has been converted.
  originatedEstimateId?: number | null;
  originatedWorkOrderId?: number | null;
  // Task #1856 — resolved controllers for this wet check (letter + name + zone count).
  // Used by the mobile app to display the controller name in the zone header.
  controllers?: Array<{ letter: string; name: string; zoneCount: number | null }>;
};

// Stable seed for issue_type_configs — applied per company on startup.
export const WET_CHECK_ISSUE_TYPE_SEED: ReadonlyArray<{
  issueType: string;
  issueGroup: "quick_fix" | "advanced" | "zone_issue";
  displayLabel: string;
  defaultLaborHours: string;
  partCategoryFilter: string | null;
  sortOrder: number;
  laborOnly?: boolean;
  partOptional?: boolean;
}> = [
  { issueType: "head_replacement",   issueGroup: "quick_fix", displayLabel: "Head Replace",     defaultLaborHours: "0.25", partCategoryFilter: "Head",       sortOrder: 10 },
  { issueType: "nozzle_replacement", issueGroup: "quick_fix", displayLabel: "Nozzle Replace",   defaultLaborHours: "0.25", partCategoryFilter: "Nozzle",     sortOrder: 20 },
  { issueType: "head_adjustment",    issueGroup: "quick_fix", displayLabel: "Adjust",           defaultLaborHours: "0.25", partCategoryFilter: null,         sortOrder: 30, laborOnly: false, partOptional: true },
  { issueType: "leak_repair",        issueGroup: "advanced",  displayLabel: "Leak",             defaultLaborHours: "1.00", partCategoryFilter: "Fitting",    sortOrder: 40 },
  { issueType: "pressure_issue",     issueGroup: "advanced",  displayLabel: "Pressure Issue",   defaultLaborHours: "0.50", partCategoryFilter: null,         sortOrder: 50 },
  { issueType: "coverage_issue",     issueGroup: "advanced",  displayLabel: "Coverage Issue",   defaultLaborHours: "0.50", partCategoryFilter: null,         sortOrder: 60 },
  { issueType: "valve_issue",        issueGroup: "zone_issue", displayLabel: "Valve",           defaultLaborHours: "1.50", partCategoryFilter: "Valve",      sortOrder: 70 },
  { issueType: "wiring_issue",       issueGroup: "zone_issue", displayLabel: "Wiring",          defaultLaborHours: "1.00", partCategoryFilter: "Wire",       sortOrder: 80 },
  { issueType: "controller_issue",   issueGroup: "zone_issue", displayLabel: "Controller",      defaultLaborHours: "1.00", partCategoryFilter: "Controller", sortOrder: 90 },
  { issueType: "other",              issueGroup: "advanced",  displayLabel: "Other",            defaultLaborHours: "0.50", partCategoryFilter: null,         sortOrder: 100 },
];

export function deriveIssueGroup(issueType: string): "quick_fix" | "advanced" | "zone_issue" {
  const seed = WET_CHECK_ISSUE_TYPE_SEED.find((s) => s.issueType === issueType);
  return (seed?.issueGroup ?? "advanced");
}

// Long-lived refresh tokens used by the mobile app (Task #521). Issued
// alongside a short-lived access token at login; presented to
// `/api/auth/mobile-refresh` to mint a fresh access token without making
// the field tech sign in again. Hashed (sha256) at rest. A single
// refresh token can have multiple access tokens minted from it over its
// lifetime; logout revokes the refresh token and the cascade-revokes
// every access token whose `refreshTokenId` points at it.
export const mobileRefreshTokens = pgTable("mobile_refresh_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  deviceName: text("device_name"),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  userIdx: index("mobile_refresh_tokens_user_id_idx").on(table.userId),
  tokenHashIdx: index("mobile_refresh_tokens_token_hash_idx").on(table.tokenHash),
}));

export const insertMobileRefreshTokenSchema = createInsertSchema(mobileRefreshTokens);
export type MobileRefreshToken = typeof mobileRefreshTokens.$inferSelect;
export type InsertMobileRefreshToken = z.infer<typeof insertMobileRefreshTokenSchema>;

// Short-lived bearer tokens used by the mobile app to authorize requests.
// Pre-Task #521 these were the only token type and were minted with a 90 day
// TTL; new logins now mint a 1 hour access token here plus a 90 day refresh
// token in `mobileRefreshTokens`. Legacy long-lived rows continue to
// authenticate until they expire naturally; their `refreshTokenId` is null.
export const mobileTokens = pgTable("mobile_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  deviceName: text("device_name"),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  // Nullable for legacy rows minted before Task #521.
  refreshTokenId: integer("refresh_token_id").references(() => mobileRefreshTokens.id),
}, (table) => ({
  userIdx: index("mobile_tokens_user_id_idx").on(table.userId),
  tokenHashIdx: index("mobile_tokens_token_hash_idx").on(table.tokenHash),
  refreshIdx: index("mobile_tokens_refresh_token_id_idx").on(table.refreshTokenId),
}));

export const insertMobileTokenSchema = createInsertSchema(mobileTokens);
export type MobileToken = typeof mobileTokens.$inferSelect;
export type InsertMobileToken = z.infer<typeof insertMobileTokenSchema>;

// ─── Irrigation System Profile ────────────────────────────────────────────────
// Four new tables for the irrigation profile feature (Build 1).
// Every table carries companyId NOT NULL so rows are directly company-scopable
// without always joining up through the controller FK chain — mirrors the
// `company-id-columns` pattern used throughout the rest of the schema.
//
// Task #1857 — `irrigation_controllers` is now the sole source of truth for a
// customer's irrigation system. `property_controllers` was retired and dropped.

export const irrigationControllers = pgTable("irrigation_controllers", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  // Multi-location parity with property_controllers. Empty string means
  // "no branch / customer-level". NOT NULL with default '' so uniqueness
  // can use plain typed columns without COALESCE.
  branchName: text("branch_name").notNull().default(""),
  name: text("name").notNull(),
  // Stored controller letter (A–Z). Auto-assigned on create, editable via
  // the PATCH /letter endpoint. Nullable during the migration window
  // (before the backfill + NOT NULL migration run). After Slice 1 of
  // Task #1856 hardens the column, every row is guaranteed to have a letter.
  letter: text("letter"),
  location: text("location"),
  brand: text("brand"),
  model: text("model"),
  totalZones: integer("total_zones"),
  notes: text("notes"),
  settingsPhotoUrl: text("settings_photo_url"),
  isActive: boolean("is_active").notNull().default(true),
  lastUpdatedByUserId: integer("last_updated_by_user_id").references(() => users.id),
  lastUpdatedByName: text("last_updated_by_name"),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Efficient list-by-customer queries (the most common read path).
  companyCustomerBranchIdx: index("irr_ctrl_company_customer_branch_idx")
    .on(table.companyId, table.customerId, table.branchName),
  // Controller name is unique within a customer+branch scope per company.
  uniqCtrlName: uniqueIndex("uniq_irr_ctrl_name")
    .on(table.companyId, table.customerId, table.branchName, table.name),
  // Unique letter within scope — added after backfill hardens every row.
  // NOTE: this index is created by the second migration (Task #1856 Slice 1
  // step 6) after the backfill confirms every row has a non-null letter.
  // The line below is intentionally commented out until that migration runs.
  // uniqCtrlLetter: uniqueIndex("uniq_irr_ctrl_letter")
  //   .on(table.companyId, table.customerId, table.branchName, table.letter),
}));

export const insertIrrigationControllerSchema = createInsertSchema(irrigationControllers);
export type IrrigationController = typeof irrigationControllers.$inferSelect;
export type InsertIrrigationController = typeof irrigationControllers.$inferInsert;

export const irrigationPrograms = pgTable("irrigation_programs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  controllerId: integer("controller_id")
    .references(() => irrigationControllers.id, { onDelete: "cascade" })
    .notNull(),
  // Program letter or name, e.g. "A", "B", "C".
  name: text("name").notNull(),
  // Days of week this program runs, e.g. ["Mon","Wed","Fri"].
  wateringDays: text("watering_days").array(),
  // One or more daily start times in "HH:MM" format, e.g. ["06:00","18:00"].
  startTimes: text("start_times").array(),
  // Seasonal adjustment percentage applied to every zone's run time (default 100 = no adjustment).
  seasonalAdjustPct: integer("seasonal_adjust_pct").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyControllerIdx: index("irr_prog_company_controller_idx")
    .on(table.companyId, table.controllerId),
}));

export const insertIrrigationProgramSchema = createInsertSchema(irrigationPrograms);
export type IrrigationProgram = typeof irrigationPrograms.$inferSelect;
export type InsertIrrigationProgram = typeof irrigationPrograms.$inferInsert;

// Named `irrigationProfileZones` (table: irrigation_profile_zones) to avoid
// collision with the existing `irrigationZones` / `irrigation_zones` table
// used by the site-map subsystem.
export const irrigationProfileZones = pgTable("irrigation_profile_zones", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  controllerId: integer("controller_id")
    .references(() => irrigationControllers.id, { onDelete: "cascade" })
    .notNull(),
  // Nullable: a zone not yet assigned to any program.
  programId: integer("program_id")
    .references(() => irrigationPrograms.id, { onDelete: "set null" }),
  zoneNumber: integer("zone_number").notNull(),
  name: text("name").notNull(),
  // Enum values: pop_up_spray | rotor | drip | netafim | bubbler | other.
  zoneType: text("zone_type").notNull().default("other"),
  runTimeMinutes: integer("run_time_minutes").notNull().default(0),
  // Drive sequential schedule order within a program.
  zoneOrder: integer("zone_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  // Per-zone override: when set, this zone starts independently of the
  // program chain and its own days are used instead of the program's.
  overrideStartTime: text("override_start_time"),
  overrideDays: text("override_days").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyControllerIdx: index("irr_pzone_company_controller_idx")
    .on(table.companyId, table.controllerId),
  // Zone numbers are unique within a (company, controller) scope so two
  // companies can each have "Zone 1" without collision.
  uniqZoneNumber: uniqueIndex("uniq_irr_pzone_number")
    .on(table.companyId, table.controllerId, table.zoneNumber),
}));

export const insertIrrigationProfileZoneSchema = createInsertSchema(irrigationProfileZones);
export type IrrigationProfileZone = typeof irrigationProfileZones.$inferSelect;
export type InsertIrrigationProfileZone = typeof irrigationProfileZones.$inferInsert;

// Append-only snapshot log. Every controller save appends one row with the
// full controller+programs+zones state so managers can review prior settings.
export const irrigationProfileHistory = pgTable("irrigation_profile_history", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  controllerId: integer("controller_id")
    .references(() => irrigationControllers.id, { onDelete: "cascade" })
    .notNull(),
  // Full state at save time: { controller, programs, zones }.
  snapshotJson: jsonb("snapshot_json").notNull(),
  changedByUserId: integer("changed_by_user_id").references(() => users.id),
  changedByName: text("changed_by_name"),
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  summary: text("summary"),
}, (table) => ({
  companyControllerIdx: index("irr_hist_company_controller_idx")
    .on(table.companyId, table.controllerId),
}));

export const insertIrrigationProfileHistorySchema = createInsertSchema(irrigationProfileHistory);
export type IrrigationProfileHistory = typeof irrigationProfileHistory.$inferSelect;
export type InsertIrrigationProfileHistory = typeof irrigationProfileHistory.$inferInsert;

// ─── Irrigation Backflow Preventers ──────────────────────────────────────────
// Tracks each backflow preventer device per customer, including device
// attributes and annual certification compliance. Tenancy mirrors
// `irrigation_controllers`: companyId NOT NULL, branchName NOT NULL default ''.

export const irrigationBackflows = pgTable("irrigation_backflows", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  branchName: text("branch_name").notNull().default(""),
  // Device attributes
  name: text("name").notNull(),
  brand: text("brand"),
  model: text("model"),
  size: text("size"),
  deviceType: text("device_type").notNull().default("other"),
  // Enum values: rpz | double_check | pvb | spill_resistant_pvb | other
  serialNumber: text("serial_number"),
  location: text("location"),
  installDate: text("install_date"),
  // date string YYYY-MM-DD
  photoUrl: text("photo_url"),
  notes: text("notes"),
  // Test / compliance
  lastTestedDate: text("last_tested_date"),
  nextTestDueDate: text("next_test_due_date"),
  lastTestResult: text("last_test_result"),
  // enum: pass | fail | null
  lastTestedBy: text("last_tested_by"),
  // Audit / meta
  isActive: boolean("is_active").notNull().default(true),
  vrtSyncId: text("vrt_sync_id"),
  lastUpdatedByUserId: integer("last_updated_by_user_id").references(() => users.id),
  lastUpdatedByName: text("last_updated_by_name"),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyCustomerBranchIdx: index("irr_backflow_company_customer_branch_idx")
    .on(table.companyId, table.customerId, table.branchName),
  uniqSerial: uniqueIndex("uniq_irr_backflow_serial")
    .on(table.companyId, table.serialNumber)
    .where(sql`${table.serialNumber} IS NOT NULL AND ${table.serialNumber} <> ''`),
}));

export const insertIrrigationBackflowSchema = createInsertSchema(irrigationBackflows);
export type IrrigationBackflow = typeof irrigationBackflows.$inferSelect;
export type InsertIrrigationBackflow = typeof irrigationBackflows.$inferInsert;

// Internal migration-tracking table — must be declared here so drizzle-kit
// does not treat it as an unknown table and attempt to drop it during db:push.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Invoice Corrections (Task #1710) ────────────────────────────────────────
// Structured audit record for an invoice correction & reissue flow. One row
// per correction attempt (whether completed or canceled). Keeps the "why"
// permanently, and the before/after snapshot lives in invoice_correction_lines.
//
// Status lifecycle:  draft → reviewed → reissued → qb_synced
//                                   ↓
//                               canceled   (cancelable before reissue)
//
// Core invariant: edits always write to the SOURCE tickets. The corrected
// invoice is re-derived from live ticket totals — no values are pushed backward.

export const invoiceCorrections = pgTable("invoice_corrections", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  originalInvoiceId: integer("original_invoice_id").references(() => invoices.id).notNull(),
  // Populated after POST …/reissue succeeds.
  reissuedInvoiceId: integer("reissued_invoice_id").references(() => invoices.id),
  // Correction workflow state.
  status: text("status").notNull().default("draft"),
  // draft | reviewed | reissued | qb_synced | canceled
  // Why the correction was requested — structured category for analytics.
  reasonCategory: text("reason_category"),
  // customer_dispute | pricing_error | duplicate_charge | goodwill_credit |
  // scope_change | tech_error | other
  // How the request reached the company.
  requestSource: text("request_source"),
  // email | phone | in_person | sms | other
  // Who (customer or external party) requested the correction.
  requestedBy: text("requested_by"),
  // Internal user who approved the correction.
  approvedByUserId: integer("approved_by_user_id").references(() => users.id),
  // Free-form correction justification.
  reasonDetail: text("reason_detail"),
  // Optional evidence attachment URL (e.g. screenshot from Object Storage).
  evidenceUrl: text("evidence_url"),
  // Notes about the evidence.
  evidenceNote: text("evidence_note"),
  // Financial snapshots stamped at reissue time.
  originalTotal: decimal("original_total", { precision: 12, scale: 2 }),
  correctedTotal: decimal("corrected_total", { precision: 12, scale: 2 }),
  deltaAmount: decimal("delta_amount", { precision: 12, scale: 2 }),
  // QuickBooks resync status.
  qbSyncStatus: text("qb_sync_status").notNull().default("pending"),
  // pending | synced | failed | skipped
  qbSyncedAt: timestamp("qb_synced_at"),
  qbNote: text("qb_note"),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  companyIdx: index("invoice_corrections_company_idx").on(table.companyId),
  originalInvoiceIdx: index("invoice_corrections_original_invoice_idx").on(table.originalInvoiceId),
}));

// Per-ticket snapshot row inside a correction. One row per ticket that was
// disputed. Captures before/after totals so the correction is fully auditable
// even after the source ticket is later modified again.
export const invoiceCorrectionLines = pgTable("invoice_correction_lines", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  correctionId: integer("correction_id").references(() => invoiceCorrections.id, { onDelete: "cascade" }).notNull(),
  // Which ticket type and its PK.
  ticketType: text("ticket_type").notNull(), // billing_sheet | work_order | wcb
  ticketId: integer("ticket_id").notNull(),
  // Financial snapshot BEFORE edit.
  beforeParts: decimal("before_parts", { precision: 12, scale: 2 }),
  beforeLabor: decimal("before_labor", { precision: 12, scale: 2 }),
  beforeTotal: decimal("before_total", { precision: 12, scale: 2 }),
  // Financial snapshot AFTER the correction edits.
  afterParts: decimal("after_parts", { precision: 12, scale: 2 }),
  afterLabor: decimal("after_labor", { precision: 12, scale: 2 }),
  afterTotal: decimal("after_total", { precision: 12, scale: 2 }),
  // What kind of correction was applied to this ticket.
  action: text("action").notNull(), // zero_line | adjust | exclude
  lineNote: text("line_note"),
}, (table) => ({
  correctionIdx: index("invoice_correction_lines_correction_idx").on(table.correctionId),
}));

export const insertInvoiceCorrectionSchema = createInsertSchema(invoiceCorrections).omit({
  id: true, createdAt: true, updatedAt: true,
});
export const insertInvoiceCorrectionLineSchema = createInsertSchema(invoiceCorrectionLines).omit({
  id: true,
});

export type InvoiceCorrection = typeof invoiceCorrections.$inferSelect;
export type InvoiceCorrectionLine = typeof invoiceCorrectionLines.$inferSelect;
export type InsertInvoiceCorrection = z.infer<typeof insertInvoiceCorrectionSchema>;
export type InsertInvoiceCorrectionLine = z.infer<typeof insertInvoiceCorrectionLineSchema>;

// ── Work-order de-dup correction audit (Task #1718) ──────────────────────────
// Records every human-confirmed correction applied through the WO Correction
// Review workflow. Audit trail for the de-dup-to-actuals process.
export const workOrderCorrections = pgTable("work_order_corrections", {
  id: serial("id").primaryKey(),
  woId: integer("wo_id").references(() => workOrders.id).notNull(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  beforeTotal: decimal("before_total", { precision: 12, scale: 2 }).notNull(),
  afterTotal: decimal("after_total", { precision: 12, scale: 2 }).notNull(),
  /** JSON: { [partKey: string]: finalQty } — one entry per part row in the corrected set. */
  perPartFinalQty: jsonb("per_part_final_qty").notNull(),
  reason: text("reason").notNull(),
  byUserId: integer("by_user_id").references(() => users.id),
  appliedAt: timestamp("applied_at").defaultNow().notNull(),
}, (table) => ({
  woIdx: index("work_order_corrections_wo_idx").on(table.woId),
  companyIdx: index("work_order_corrections_company_idx").on(table.companyId),
}));

export const insertWorkOrderCorrectionSchema = createInsertSchema(workOrderCorrections).omit({
  id: true, appliedAt: true,
});

export type WorkOrderCorrection = typeof workOrderCorrections.$inferSelect;
export type InsertWorkOrderCorrection = z.infer<typeof insertWorkOrderCorrectionSchema>;

