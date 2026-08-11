import { 
  companies,
  users,
  customers, 
  parts, 
  assemblies,
  assemblyParts,
  estimates, 
  estimateItems,
  // propertyZones, zones, fieldWorkSessions, fieldWorkItems removed by Task #1857.
  workOrders,
  workOrderItems,
  invoices,
  invoiceItems,
  invoicePdfs,
  invoiceReminders,
  invoiceArNotes,
  billingSheets,
  billingSheetItems,
  manualPartReviews,
  mobileTokens,
  type MobileToken,
  type InsertMobileToken,
  mobileRefreshTokens,
  type MobileRefreshToken,
  type InsertMobileRefreshToken,
  missingPhotosNotifications,
  aiGenerationLogs,
  notifications,
  quickbooksIntegration,
  oauthState,
  siteMaps,
  controllers,
  irrigationZones,
  partUsage,
  apiKeys,
  partCategories,
  partBrands,
  partSizes,
  partMaterials,
  partFittingTypes,
  pricingAuditEvents,
  type PricingAuditEvent,
  photoLateAdditions,
  type PhotoLateAddition,
  type InsertPhotoLateAddition,
  irrigationControllers,
  irrigationPrograms,
  irrigationProfileZones,
  irrigationProfileHistory,
  irrigationBackflows,
  type IrrigationController,
  type InsertIrrigationController,
  type IrrigationProgram,
  type InsertIrrigationProgram,
  type IrrigationProfileZone,
  type InsertIrrigationProfileZone,
  type IrrigationProfileHistory,
  type InsertIrrigationProfileHistory,
  type IrrigationBackflow,
  type InsertIrrigationBackflow,
  type Company,
  type User,
  type Customer, 
  type Part,
  type Assembly,
  type AssemblyPart, 
  type Estimate, 
  type EstimateItem,
  // PropertyZone, Zone, FieldWorkSession, FieldWorkItem removed by Task #1857.
  type WorkOrder,
  type WorkOrderItem,
  type Invoice,
  type InvoiceItem,
  type InvoicePdf,
  type InvoiceReminder,
  type InsertInvoiceReminder,
  type InvoiceArNote,
  type InsertInvoiceArNote,
  type BillingSheet,
  type BillingSheetItem,
  type ManualPartReview,
  type MissingPhotosNotification,
  type AiGenerationLog,
  type Notification,
  type SiteMap,
  type Controller,
  type IrrigationZone,
  type PartUsage,
  type ApiKey,
  type PartCategory,
  type PartBrand,
  type PartSize,
  type PartMaterial,
  type PartFittingType,
  type InsertCompany,
  type InsertUser,
  type InsertCustomer, 
  type InsertPart,
  type InsertAssembly,
  type InsertAssemblyPart, 
  type InsertEstimate, 
  type InsertEstimateItem,
  // InsertPropertyZone, InsertZone, InsertFieldWorkSession, InsertFieldWorkItem removed by Task #1857.
  type InsertWorkOrder,
  type InsertWorkOrderItem,
  type InsertInvoice,
  type InsertInvoiceItem,
  type InsertInvoicePdf,
  type InsertBillingSheet,
  type InsertBillingSheetItem,
  type InsertManualPartReview,
  type InsertAiGenerationLog,
  type InsertNotification,
  type InsertSiteMap,
  type InsertController,
  type InsertIrrigationZone,
  type InsertPartUsage,
  type InsertApiKey,
  type InsertPartCategory,
  type InsertPartBrand,
  type InsertPartSize,
  type InsertPartMaterial,
  type InsertPartFittingType,
  type EstimateWithItems,
  // PropertyZoneWithZones, FieldWorkSessionWithItems removed by Task #1857.
  type InvoiceWithItems,
  type BillingSheetWithItems,
  type AssemblyWithParts,
  // propertyControllers removed by Task #1857 — table dropped, migration 0018.
  issueTypeConfigs,
  wetChecks,
  wetCheckZoneRecords,
  wetCheckFindings,
  wetCheckPhotos,
  workOrderZonePhotos,
  wetCheckBillings,
  // PropertyController, InsertPropertyController removed by Task #1857.
  type IssueTypeConfig,
  type InsertIssueTypeConfig,
  type WetCheck,
  type InsertWetCheck,
  type WetCheckZoneRecord,
  type InsertWetCheckZoneRecord,
  type WetCheckFinding,
  type InsertWetCheckFinding,
  type WetCheckPhoto,
  type InsertWetCheckPhoto,
  type WorkOrderZonePhoto,
  type InsertWorkOrderZonePhoto,
  type WetCheckBilling,
  type InsertWetCheckBilling,
  type WetCheckWithDetails,
  deriveIssueGroup,
  WET_CHECK_ISSUE_TYPE_SEED,
} from "@workspace/db";
import { db, pool } from "./db";
import { sql, eq, like, ilike, desc, and, gte, lte, or, isNull, isNotNull, inArray, gt } from "drizzle-orm";
import { logger } from "./lib/logger";
import bcrypt from "bcrypt";
import { processEstimatePayload, type EstimatePayloadInput } from "./estimate-payload";
import { computeBillingSheetTotal } from "./billing-sheet-total";
import { applyNoPartNeededInvariant } from "./storage/wet-check-finding-invariants";
import { humanizeIssueType } from "./inspection-issue-labels";
import { buildInspectionEstimateItems } from "./inspection-estimate-items";
import {
  computeLifecycleStatus,
  deriveLifecycleForWrite,
  ESTIMATE_EXPIRATION_DAYS,
  type LifecycleStatus,
} from "@workspace/shared";
import { computeEstimateSummary } from "./estimate-summary";
import type { EstimateSummary, WetCheckBillingListItem } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { money } from "./lib/money";
import { resolveIssueTypeKey, seedIssueTypeConfigsForCompany } from "./seeds/issue-type-configs";
import {
  validateMerge,
  computeMergedTotals,
  type MergeCandidate,
} from "./invoice-merge";
import { recordAuditEvent } from "./routes/audit-log";


// Set of issue types that never require a part (labor-only). Built once from
// the canonical seed so the convert guard stays in sync with the schema.
// Exported so the reconcile-finding-disposition migration can reuse it
// without duplicating the filter logic.
export const LABOR_ONLY_ISSUE_TYPES: ReadonlySet<string> = new Set(
  WET_CHECK_ISSUE_TYPE_SEED.filter(s => s.laborOnly).map(s => s.issueType),
);

// WetCheckBillingListItem is defined in @workspace/db (schema.ts) so both the
// API server and the frontend can import it from the same source. Re-exported
// here for callers that import from storage.ts directly.
export type { WetCheckBillingListItem };

// Executor accepted by storage helpers that may run inside a caller's
// transaction. Both `db` and a Drizzle PgTransaction satisfy this
// (insert/update/delete/select are interface-compatible); typing it as the
// transaction parameter type keeps callers honest while still accepting
// the top-level db handle.
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Thrown by deleteWetCheck when one or more findings have already been
// routed to a billing sheet, estimate or work order. Surface mapped to
// HTTP 409 by the route layer.
export class WetCheckAlreadyRoutedError extends Error {
  routedFindingIds: number[];
  constructor(routedFindingIds: number[]) {
    super(`Wet check has ${routedFindingIds.length} routed finding(s); delete is not allowed`);
    this.name = "WetCheckAlreadyRoutedError";
    this.routedFindingIds = routedFindingIds;
  }
}

// Thrown by deleteWetCheck when one or more downstream records produced
// from the wet check's findings (billing sheets, estimates, work orders,
// or work orders chained off a routed estimate) are already attached to
// an invoice. The route layer maps this to HTTP 409 with a structured
// `blockers` list so the UI can render an actionable message instead of
// silently swallowing the conflict.
export type WetCheckInvoiceBlocker = {
  kind: "billing_sheet" | "estimate" | "work_order" | "wet_check_billing";
  id: number;
  displayNumber: string | null;
  invoiceId: number | null;
  invoiceNumber: string | null;
};
export class WetCheckHasInvoicedRecordsError extends Error {
  blockers: WetCheckInvoiceBlocker[];
  constructor(wetCheckId: number, blockers: WetCheckInvoiceBlocker[]) {
    const parts = blockers.map((b) => {
      const kindLabel =
        b.kind === "billing_sheet" ? "billing sheet"
        : b.kind === "estimate" ? "estimate"
        : b.kind === "wet_check_billing" ? "wet check billing"
        : "work order";
      const recordLabel = b.displayNumber ?? `#${b.id}`;
      const invoiceLabel = b.invoiceNumber ?? (b.invoiceId != null ? `#${b.invoiceId}` : "an invoice");
      return `${kindLabel} ${recordLabel} is on invoice ${invoiceLabel}`;
    });
    const summary = parts.length > 0 ? parts.join("; ") : "downstream record is on an invoice";
    super(`Cannot delete wet check #${wetCheckId}: ${summary}. Remove it from the invoice first.`);
    this.name = "WetCheckHasInvoicedRecordsError";
    this.blockers = blockers;
  }
}

// Thrown by deleteWetCheck when one or more of the wet check's findings has
// billingSheetId IS NOT NULL but the billing sheet is not yet on an invoice.
// The invoiced-records error above takes priority; this fires only when there
// are no invoiced blockers. Surface mapped to HTTP 409 by the route layer.
export class WetCheckHasBillingSheetError extends Error {
  readonly code = "WET_CHECK_HAS_BILLING_SHEET";
  billingNumbers: (string | null)[];
  constructor(wetCheckId: number, blockers: Array<{ id: number; billingNumber: string | null }>) {
    const parts = blockers.map(b => `billing sheet ${b.billingNumber ?? `#${b.id}`}`);
    super(`Cannot delete wet check #${wetCheckId}: linked to ${parts.join("; ")}. Remove it from the billing sheet first.`);
    this.name = "WetCheckHasBillingSheetError";
    this.billingNumbers = blockers.map(b => b.billingNumber);
  }
}

// Thrown by deleteWetCheck when one or more of the wet check's findings has
// wetCheckBillingId IS NOT NULL but the WCB is not yet on an invoice.
// Invoiced WCBs fold into WetCheckHasInvoicedRecordsError (first priority);
// this fires only when there are no invoiced blockers and no uninvoiced BS.
// Surface mapped to HTTP 409 by the route layer.
export class WetCheckHasWetCheckBillingError extends Error {
  readonly code = "WET_CHECK_HAS_WET_CHECK_BILLING";
  billingNumbers: (string | null)[];
  constructor(wetCheckId: number, blockers: Array<{ id: number; billingNumber: string | null }>) {
    const parts = blockers.map(b => `wet check billing ${b.billingNumber ?? `#${b.id}`}`);
    super(`Cannot delete wet check #${wetCheckId}: linked to ${parts.join("; ")}. Remove it from the billing record first.`);
    this.name = "WetCheckHasWetCheckBillingError";
    this.billingNumbers = blockers.map(b => b.billingNumber);
  }
}

// Thrown by deleteBillingSheet when the sheet has already been pushed onto
// an invoice (either via billing_sheets.invoiceId or via invoice_items rows
// pointing at it). Surface mapped to HTTP 409 by the route layer so the UI
// can show a friendly "already on invoice #..." message instead of a 500.
export class BillingSheetInvoicedError extends Error {
  invoiceNumber: string | null;
  invoiceId: number | null;
  constructor(invoiceId: number | null, invoiceNumber: string | null) {
    super(
      invoiceNumber
        ? `Billing sheet is already on invoice #${invoiceNumber}`
        : `Billing sheet is already on an invoice`,
    );
    this.name = "BillingSheetInvoicedError";
    this.invoiceId = invoiceId;
    this.invoiceNumber = invoiceNumber;
  }
}

// Task #518 — Thrown by deleteWetCheckFinding so the route layer can map
// each refusal to a specific 404/409 with a tech-friendly message instead
// of silently returning HTTP 200 + `{ ok: false }`.
export class WetCheckFindingNotFoundError extends Error {
  findingId: number;
  constructor(findingId: number) {
    super(`Wet check finding #${findingId} not found`);
    this.name = "WetCheckFindingNotFoundError";
    this.findingId = findingId;
  }
}
// The wet check the finding belongs to has been submitted/approved/etc —
// no more tech edits are allowed. Lets the route 409 with the actual
// reason instead of the bare `assertWetCheckEditableByTech` thrown
// `Error("Cannot edit wet check in status submitted")`.
export class WetCheckFindingNotEditableError extends Error {
  findingId: number;
  status: string;
  constructor(findingId: number, status: string) {
    super(
      `Cannot delete finding — wet check is ${status} and no longer editable in the field`,
    );
    this.name = "WetCheckFindingNotEditableError";
    this.findingId = findingId;
    this.status = status;
  }
}
// The finding has already been routed downstream (billing sheet / estimate
// / work order). Deleting would orphan the downstream record, so we 409.
export class WetCheckFindingAlreadyConvertedError extends Error {
  findingId: number;
  target: "billing_sheet" | "estimate" | "work_order" | "unknown";
  targetId: number | null;
  constructor(
    findingId: number,
    target: "billing_sheet" | "estimate" | "work_order" | "unknown",
    targetId: number | null,
  ) {
    const label =
      target === "billing_sheet" ? "billing sheet"
      : target === "estimate" ? "estimate"
      : target === "work_order" ? "work order"
      : "downstream record";
    super(
      targetId != null
        ? `Cannot delete finding — already routed to ${label} #${targetId}. Remove it from the ${label} first.`
        : `Cannot delete finding — already converted to a ${label}. Remove it from the ${label} first.`,
    );
    this.name = "WetCheckFindingAlreadyConvertedError";
    this.findingId = findingId;
    this.target = target;
    this.targetId = targetId;
  }
}

// Thrown by setCustomerControllerCount when the requested count would remove
// one or more controllers that still have zoneCount > 0 and the caller did not
// pass `confirmDeleteWithZones: true`. Surface mapped to HTTP 409 by routes.
export class ControllerHasZonesError extends Error {
  letters: string[];
  constructor(letters: string[]) {
    super(`Removing controllers ${letters.join(", ")} would discard zones; confirmation required`);
    this.name = "ControllerHasZonesError";
    this.letters = letters;
  }
}

// Thrown by unapproveEstimate when the preconditions for reverting an
// approved estimate back to 'sent' are not met. The `code` field
// identifies the reason so the route layer can map to the right HTTP
// status and message without inspecting raw error strings.
export class UnapproveEstimateConflictError extends Error {
  readonly code: "not_approved" | "wo_progressed";
  readonly details: {
    workOrderId?: number;
    workOrderNumber?: string | null;
    workOrderStatus?: string;
    lifecycle?: string;
  };
  constructor(
    code: "not_approved" | "wo_progressed",
    details: {
      workOrderId?: number;
      workOrderNumber?: string | null;
      workOrderStatus?: string;
      lifecycle?: string;
    } = {},
  ) {
    const message =
      code === "not_approved"
        ? "Only approved estimates can be reverted to sent."
        : `The linked work order (${details.workOrderNumber ?? `#${details.workOrderId}`}) is in "${details.workOrderStatus}" status and must be cancelled before the estimate can be reverted.`;
    super(message);
    this.name = "UnapproveEstimateConflictError";
    this.code = code;
    this.details = details;
  }
}

type DrizzlePartInsert = typeof parts.$inferInsert;
type DrizzleWorkOrderInsert = typeof workOrders.$inferInsert;
type DrizzleInvoiceInsert = typeof invoices.$inferInsert;
type DrizzleCustomerInsert = typeof customers.$inferInsert;
type DrizzleBillingSheetInsert = typeof billingSheets.$inferInsert;

function toDrizzleInsert<TDrizzle>(zodParsed: object): TDrizzle {
  return zodParsed as TDrizzle;
}

export interface IStorage {
  // Companies
  getCompanies(): Promise<Company[]>;
  getCompany(id: number): Promise<Company | undefined>;
  createCompany(company: InsertCompany): Promise<Company>;
  updateCompany(id: number, company: Partial<InsertCompany>): Promise<Company | undefined>;
  deleteCompany(id: number): Promise<boolean>;
  
  // Users
  getUsers(companyId?: number, options?: { limit?: number; offset?: number }): Promise<User[]>;
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByPasswordResetToken(token: string): Promise<User | undefined>;
  getUserByEmailVerificationToken(token: string): Promise<User | undefined>;
  getUserByRole(role: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, user: Partial<InsertUser>): Promise<User | undefined>;
  deleteUser(id: number): Promise<boolean>;
  softDeleteUser(id: number): Promise<boolean>;
  getUserDataDependencies(userId: number): Promise<{
    hasWorkOrders: boolean;
    hasBillingSheets: boolean;
    hasNotifications: boolean;
    workOrderCount: number;
    billingSheetCount: number;
    notificationCount: number;
  }>;
  hardDeleteUserWithCascade(userId: number): Promise<boolean>;

  // Mobile bearer-token auth (M1 + Task #521 refresh tokens)
  createMobileToken(token: InsertMobileToken): Promise<MobileToken>;
  getActiveMobileTokenByHash(tokenHash: string): Promise<MobileToken | undefined>;
  revokeMobileToken(tokenHash: string): Promise<boolean>;
  revokeAllMobileTokensForUser(userId: number): Promise<number>;
  createMobileRefreshToken(token: InsertMobileRefreshToken): Promise<MobileRefreshToken>;
  getActiveMobileRefreshTokenByHash(tokenHash: string): Promise<MobileRefreshToken | undefined>;
  revokeMobileRefreshToken(tokenHash: string): Promise<boolean>;
  revokeMobileRefreshTokenById(id: number): Promise<boolean>;

  // Customers
  getCustomers(companyId?: number): Promise<Customer[]>;
  getCustomer(id: number): Promise<Customer | undefined>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  updateCustomer(id: number, customer: Partial<InsertCustomer>): Promise<Customer | undefined>;
  deleteCustomer(id: number): Promise<boolean>;
  
  // Customer-related data
  getEstimatesByCustomer(customerId: number): Promise<Estimate[]>;
  getBillingSheetsByCustomer(customerId: number, companyId: number | null): Promise<BillingSheetWithItems[]>;
  getBillingSheetsByTechnician(technicianId: number, companyId?: number | null): Promise<BillingSheetWithItems[]>;
  
  // Notifications
  getNotifications(userId: number): Promise<Notification[]>;
  getUnreadNotificationCount(userId: number): Promise<number>;
  createNotification(notification: InsertNotification): Promise<Notification>;
  markNotificationAsRead(id: number): Promise<boolean>;
  markAllNotificationsAsRead(userId: number): Promise<boolean>;

  // API Keys for External Integrations
  getApiKeys(companyId: number): Promise<ApiKey[]>;
  getApiKeyByKey(apiKey: string): Promise<ApiKey | undefined>;
  createApiKey(apiKey: InsertApiKey): Promise<ApiKey>;
  deleteApiKey(id: number): Promise<boolean>;
  updateApiKeyLastUsed(id: number): Promise<void>;
  getIrrigationManagerForCompany(companyId: number): Promise<User | undefined>;

  // Customer Integrations
  syncCustomersFromGoogleSheets(sheetsUrl: string): Promise<{ customersAdded: number }>;
  getGoogleSheetsCustomerStatus(): Promise<{ isConnected: boolean; lastSync?: string; sheetUrl?: string; customerCount?: number }>;

  // Parts Assemblies
  getAssemblies(companyId: number): Promise<AssemblyWithParts[]>;
  getAssembly(id: number): Promise<AssemblyWithParts | undefined>;
  createAssembly(assembly: InsertAssembly, parts: InsertAssemblyPart[]): Promise<AssemblyWithParts>;
  updateAssembly(id: number, assembly: Partial<InsertAssembly>, parts?: InsertAssemblyPart[]): Promise<AssemblyWithParts | undefined>;
  deleteAssembly(id: number): Promise<boolean>;
  trackAssemblyUsage(companyId: number, assemblyId: number): Promise<void>;
  getQuickBooksCustomerStatus(): Promise<{ isConnected: boolean; companyName?: string; lastSync?: string; customerCount?: number; connectionStatus?: string; reconnectRequiredReason?: string | null; companyId?: string | null; realmId?: string | null }>;
  getQuickBooksAllIntegrations(): Promise<(typeof quickbooksIntegration.$inferSelect)[]>;
  connectGoogleSheetsCustomers(sheetUrl: string): Promise<void>;
  disconnectGoogleSheetsCustomers(): Promise<void>;
  markQuickBooksReconnectRequired(realmId: string, reason: string): Promise<void>;
  getAllActiveQuickBooksIntegrations(): Promise<(typeof quickbooksIntegration.$inferSelect)[]>;

  // OAuth state (Task #744 — QB Harden #2, behind USE_DB_OAUTH_STATE flag)
  saveOauthState(state: string, provider: string, companyId: string | null, expiresAt: Date): Promise<void>;
  consumeOauthState(state: string): Promise<{ provider: string; companyId: string | null } | undefined>;
  pruneExpiredOauthStates(): Promise<void>;

  // Parts Reference Lists (per-company: categories, brands, sizes, materials, fitting types)
  getPartCategories(companyId: number): Promise<PartCategory[]>;
  createPartCategory(category: InsertPartCategory): Promise<PartCategory>;
  updatePartCategory(id: number, companyId: number, data: Partial<InsertPartCategory>): Promise<PartCategory | undefined>;
  deletePartCategory(id: number, companyId: number): Promise<boolean>;

  getPartBrands(companyId: number): Promise<PartBrand[]>;
  createPartBrand(brand: InsertPartBrand): Promise<PartBrand>;
  updatePartBrand(id: number, companyId: number, data: Partial<InsertPartBrand>): Promise<PartBrand | undefined>;
  deletePartBrand(id: number, companyId: number): Promise<boolean>;

  getPartSizes(companyId: number): Promise<PartSize[]>;
  createPartSize(size: InsertPartSize): Promise<PartSize>;
  updatePartSize(id: number, companyId: number, data: Partial<InsertPartSize>): Promise<PartSize | undefined>;
  deletePartSize(id: number, companyId: number): Promise<boolean>;

  getPartMaterials(companyId: number): Promise<PartMaterial[]>;
  createPartMaterial(material: InsertPartMaterial): Promise<PartMaterial>;
  updatePartMaterial(id: number, companyId: number, data: Partial<InsertPartMaterial>): Promise<PartMaterial | undefined>;
  deletePartMaterial(id: number, companyId: number): Promise<boolean>;

  getPartFittingTypes(companyId: number): Promise<PartFittingType[]>;
  createPartFittingType(fittingType: InsertPartFittingType): Promise<PartFittingType>;
  updatePartFittingType(id: number, companyId: number, data: Partial<InsertPartFittingType>): Promise<PartFittingType | undefined>;
  deletePartFittingType(id: number, companyId: number): Promise<boolean>;

  // Parts
  getParts(companyId?: number | null): Promise<Part[]>;
  getPart(id: number): Promise<Part | undefined>;
  searchParts(query: string): Promise<Part[]>;
  createPart(part: InsertPart): Promise<Part>;
  updatePart(id: number, part: Partial<InsertPart>): Promise<Part | undefined>;
  syncPartsFromGoogleDocs(docUrl: string): Promise<void>;

  // Estimates
  getEstimates(opts?: { includeDeleted?: boolean }): Promise<Estimate[]>;
  getEstimatesPendingApproval(companyId: number | null): Promise<Estimate[]>;
  // Task #683 — aggregate summary for the Estimate Command Center.
  // Same company scoping as getEstimatesPendingApproval; `null` for
  // super_admin global access.
  getEstimateSummary(companyId: number | null): Promise<EstimateSummary>;
  getEstimate(id: number, opts?: { includeDeleted?: boolean }): Promise<EstimateWithItems | undefined>;
  createEstimate(estimate: InsertEstimate, items: InsertEstimateItem[]): Promise<EstimateWithItems>;
  updateEstimate(id: number, estimate: Partial<InsertEstimate>): Promise<Estimate | undefined>;
  // Task #611 — conditional lifecycle transitions. Each one pins the
  // current status / internalStatus in the WHERE clause so concurrent
  // requests can't both succeed. Return undefined when the
  // precondition is not met (or the row is missing).
  rejectEstimateIfPending(id: number): Promise<Estimate | undefined>;
  internallyApproveEstimateIfPending(id: number): Promise<Estimate | undefined>;
  markEstimateSentToCustomer(
    id: number,
    args: {
      approvalToken: string;
      tokenExpiresAt: Date;
      approvalSentAt: Date;
      newEstimateDate: Date | null;
      isResend: boolean;
      // Task #1574 — actual delivery address; persisted so the
      // reject-via-token audit log records the right recipient.
      sentToEmail?: string;
    },
  ): Promise<Estimate | undefined>;
  updateEstimateWithItems(id: number, estimate: InsertEstimate, items: InsertEstimateItem[]): Promise<EstimateWithItems>;
  deleteEstimate(id: number): Promise<boolean>;
  // Task #634 — manager-facing soft delete for draft estimates.
  // Returns true if a draft row was successfully marked deleted.
  softDeleteEstimate(id: number, deletedByUserId: number): Promise<boolean>;

  // Estimate Items
  getEstimateItems(estimateId: number): Promise<EstimateItem[]>;
  
  // Dashboard Stats
  getDashboardStats(): Promise<{
    pendingEstimates: number;
    approvedThisMonth: number;
    totalRevenue: number;
    partsCount: number;
    recentEstimates: Estimate[];
    topParts: (Part & { usageCount: number })[];
    workOrderStats: {
      pending: number;
      inProgress: number;
      completed: number;
      assigned: number;
      pendingManagerReview: number;
      total: number;
    };
    billingSheetStats: {
      pendingManagerReview: number;
    };
    wetCheckBillingStats: {
      pendingManagerReview: number;
    };
    recentWorkOrders: WorkOrder[];
  }>;

  // Property Zones / Field Work Sessions interface methods removed by Task #1857 (Slice 5).

  // Work Orders - Enhanced
  getWorkOrders(companyId: number | null): Promise<WorkOrder[]>;
  getWorkOrdersByTechnician(technicianId: number, companyId: number | null): Promise<WorkOrder[]>;
  getWorkOrdersByCustomer(customerId: number, companyId: number | null): Promise<WorkOrder[]>;
  getWorkOrdersByStatus(status: string, companyId: number | null): Promise<WorkOrder[]>;
  getWorkOrdersByEstimate(estimateId: number, companyId: number | null): Promise<WorkOrder[]>;
  getWorkOrder(id: number, companyId: number | null): Promise<WorkOrder | undefined>;
  createWorkOrder(workOrder: InsertWorkOrder, estimateItems?: EstimateItem[]): Promise<WorkOrder>;
  createWorkOrderFromEstimate(estimateId: number, companyId?: number | null): Promise<WorkOrder>;
  // Task #611 — atomic "approve estimate" lifecycle action. Flips the
  // estimate to `approved`, auto-creates the work order (with items),
  // auto-assigns to the company's irrigation manager, and writes the
  // assignment notification — all in a single DB transaction so the
  // estimate cannot end up approved-without-a-work-order if any
  // downstream step fails.
  approveEstimateAndCreateWorkOrder(estimateId: number): Promise<{
    estimate: Estimate;
    workOrder: WorkOrder | null;
    assignedTechnician: User | null;
  }>;
  // Reverts a customer-approved estimate back to `sent`. Atomically
  // deletes the linked work order if it is still `pending`. Throws
  // `UnapproveEstimateConflictError` on precondition failure:
  //   code='not_approved'  — estimate lifecycle is not 'approved'
  //   code='wo_progressed' — linked WO has advanced past 'pending'
  unapproveEstimate(id: number): Promise<{
    estimate: Estimate;
    deletedWorkOrderId: number | null;
  }>;
  // Reverts a rejected estimate back to `sent` state. Returns the updated
  // estimate on success, or `undefined` if the row was not in `rejected`
  // lifecycle (precondition miss — caller should treat as 409).
  unrejectedEstimate(id: number): Promise<Estimate | undefined>;
  updateWorkOrder(id: number, workOrder: Partial<InsertWorkOrder>): Promise<WorkOrder | undefined>;
  deleteWorkOrder(id: number): Promise<boolean>;
  hasInvoiceItems(workOrderId: number): Promise<boolean>;
  assignWorkOrder(workOrderId: number, technicianId: number, technicianName: string): Promise<boolean>;
  // Task #185 — flag a work order as not requiring photos so it disappears
  // from the missing-photos report. Stamps the acting user and timestamp.
  markWorkOrderNoPhotosNeeded(workOrderId: number, userId: number): Promise<WorkOrder | undefined>;
  // Task #187 — undo the "no photos needed" flag, clearing the three audit
  // fields so the work order can reappear on the missing-photos report.
  clearWorkOrderNoPhotosNeeded(workOrderId: number): Promise<WorkOrder | undefined>;
  
  // Work Order Items
  getWorkOrderItems(workOrderId: number): Promise<WorkOrderItem[]>;
  addWorkOrderItem(item: InsertWorkOrderItem): Promise<WorkOrderItem>;
  updateWorkOrderItem(id: number, item: Partial<InsertWorkOrderItem>): Promise<WorkOrderItem | undefined>;
  deleteWorkOrderItem(id: number): Promise<boolean>;
  deleteWorkOrderItems(workOrderId: number): Promise<boolean>;
  replaceWorkOrderItemsInTransaction(workOrderId: number, items: InsertWorkOrderItem[]): Promise<WorkOrderItem[]>;
  // Task #1437 — tech zone checklist: per-item check-off + zone-linked photos
  setWorkOrderItemCompletion(workOrderId: number, itemId: number, completed: boolean): Promise<WorkOrderItem | undefined>;
  getWorkOrderZonePhotos(workOrderId: number): Promise<WorkOrderZonePhoto[]>;
  attachWorkOrderZonePhoto(workOrderId: number, insert: Omit<InsertWorkOrderZonePhoto, "workOrderId">): Promise<WorkOrderZonePhoto>;
  deleteWorkOrderZonePhoto(id: number, workOrderId: number): Promise<boolean>;
  
  // Billing Sheets - for work done without work orders
  getAllBillingSheets(companyId: number | null): Promise<BillingSheetWithItems[]>;
  getBillingSheetById(id: number, companyId: number | null): Promise<BillingSheetWithItems | undefined>;
  getBillingSheetsByWorkOrderId(workOrderId: number, companyId: number | null): Promise<BillingSheetWithItems[]>;
  getNextBillingNumber(): Promise<string>;
  createBillingSheet(billingSheet: InsertBillingSheet & { items?: InsertBillingSheetItem[] }): Promise<BillingSheet>;
  updateBillingSheet(id: number, billingSheet: Partial<InsertBillingSheet>): Promise<BillingSheet | undefined>;
  deleteBillingSheet(id: number): Promise<boolean>;
  addBillingSheetItem(billingSheetId: number, item: InsertBillingSheetItem): Promise<BillingSheetItem>;
  deleteBillingSheetItems(billingSheetId: number): Promise<boolean>;
  updateBillingSheetItem(itemId: number, item: Partial<InsertBillingSheetItem>): Promise<BillingSheetItem | undefined>;
  deleteBillingSheetItem(itemId: number): Promise<boolean>;
  replaceBillingSheetItemsInTransaction(billingSheetId: number, items: InsertBillingSheetItem[]): Promise<BillingSheetItem[]>;
  replaceBillingSheetItemsAndResync(billingSheetId: number, items: InsertBillingSheetItem[]): Promise<{ items: BillingSheetItem[]; partsSubtotal: string; totalAmount: string }>;
  // Task #197 — flag a billing sheet as not requiring photos so it disappears
  // from the missing-photos report. Stamps the acting user and timestamp.
  markBillingSheetNoPhotosNeeded(sheetId: number, userId: number): Promise<BillingSheet | undefined>;
  // Task #752 (WC Billing Slice 3) — zone-grouped view for billing sheets
  // that originated from a wet check. Returns null for non-WC sheets (no
  // findings point at this billingSheetId). companyId is used to load the
  // correct issueTypeConfigs; pass null for super_admin callers (the method
  // derives it from the wet check row).
  getBillingSheetWetCheckView(billingSheetId: number, companyId: number | null): Promise<import("./wet-check-billing-view").WetCheckBillingView | null>;
  // Task #787 (WC Separate System Slice 2) — zone-grouped view assembled from
  // a `wet_check_billings` row (the new dedicated table). Mirrors
  // getBillingSheetWetCheckView but sources the billing header from
  // `wet_check_billings` and filters findings by `wetCheckBillingId`.
  // Returns null when the WCB row is missing, has no findings, or the wet
  // check / customer cannot be loaded. Sets `wetCheckBillingId` on the
  // returned view; does NOT set `billingSheetId`.
  getWetCheckBillingViewById(wcbId: number, companyId: number | null): Promise<import("./wet-check-billing-view").WetCheckBillingView | null>;

  // Missing-photos outreach tracking — one row per technician
  getMissingPhotosNotifications(): Promise<MissingPhotosNotification[]>;
  upsertMissingPhotosNotification(technicianId: number, sheetIds: number[], sentByUserId: number | null, channel?: 'email' | 'sms', smsMessageSid?: string | null): Promise<MissingPhotosNotification>;
  updateMissingPhotosSmsStatus(messageSid: string, status: string, errorCode?: string | null): Promise<MissingPhotosNotification | undefined>;

  // Invoices - monthly consolidated billing
  getInvoices(companyId: number | null): Promise<Invoice[]>;
  getInvoicesByStatus(status: string, companyId: number | null): Promise<Invoice[]>;
  // Task #662 — company-scoped "This Month Billed" rollup. Joins
  // invoices to customers so the result honors customers.companyId
  // (the invoices table itself has no companyId column). Excludes
  // draft and cancelled invoices. Pass `null` for the global view
  // (super_admin). `now` is injectable so tests can pin the month.
  getThisMonthBilledForCompany(
    companyId: number | null,
    now?: Date,
  ): Promise<{ amount: number; invoiceCount: number; month: string }>;
  getInvoiceById(id: number, companyId: number | null): Promise<InvoiceWithItems | undefined>;
  createInvoice(invoice: InsertInvoice & { invoiceNumber?: string }): Promise<Invoice>;
  updateInvoice(id: number, invoice: Partial<InsertInvoice> & { invoiceNumber?: string }): Promise<Invoice | undefined>;
  deleteInvoice(id: number): Promise<boolean>;
  deleteInvoiceItemsByInvoiceId(invoiceId: number): Promise<boolean>;
  createInvoiceItem(item: InsertInvoiceItem): Promise<InvoiceItem>;
  getCustomerById(id: number): Promise<Customer | undefined>;
  
  // Invoice PDFs - detailed breakdowns
  createInvoicePdf(pdf: InsertInvoicePdf): Promise<InvoicePdf>;
  getInvoicePdfByInvoiceId(invoiceId: number): Promise<InvoicePdf | undefined>;
  updateInvoicePdf(id: number, pdf: Partial<InsertInvoicePdf>): Promise<InvoicePdf | undefined>;

  // Task #1887 — invoice payment reminders.
  createInvoiceReminder(row: InsertInvoiceReminder): Promise<InvoiceReminder>;
  /** Full history for one invoice, newest first. Company-scoped. */
  getInvoiceReminders(invoiceId: number, companyId: number | null): Promise<InvoiceReminder[]>;
  /** The most recent *delivered* reminder, which is what the throttle reads. */
  getLastDeliveredInvoiceReminder(invoiceId: number): Promise<InvoiceReminder | undefined>;
  /** Delivered-reminder count + last sent-at, per invoice, for the A/R list. */
  getInvoiceReminderSummaries(
    companyId: number | null,
  ): Promise<Map<number, { reminderCount: number; lastReminderAt: Date }>>;

  // Task #1889 — internal A/R notes. Append and read ONLY. There is no
  // updateInvoiceArNote and no deleteInvoiceArNote, and there must not be one:
  // the thread is append-only, and the absence of a mutation path is what
  // enforces that rather than a check someone can forget.
  createInvoiceArNote(row: InsertInvoiceArNote): Promise<InvoiceArNote>;
  /** Full thread for one invoice, newest first. Company-scoped. */
  getInvoiceArNotes(invoiceId: number, companyId: number | null): Promise<InvoiceArNote[]>;
  /** Note count + most recent note, per invoice, for the A/R list indicator. */
  getInvoiceArNoteSummaries(
    companyId: number | null,
  ): Promise<Map<number, { noteCount: number; lastNoteAt: Date; lastNoteText: string }>>;

  mergeInvoices(params: {
    survivingId: number;
    mergedIds: number[];
    companyId: number | null;
    audit?: {
      actorUserId?: number | null;
      actorLabel?: string | null;
      actorRole?: string | null;
      actorCompanyId?: number | null;
    };
  }): Promise<{
    survivingInvoice: Invoice;
    survivingNumber: string;
    cancelledInvoiceIds: number[];
    cancelledNumbers: string[];
    partsSubtotal: string;
    laborSubtotal: string;
    totalAmount: string;
  }>;


  // Site Maps for customers
  getSiteMap(id: number): Promise<SiteMap | undefined>;
  getCustomerSiteMaps(customerId: number): Promise<SiteMap[]>;
  getSiteMapControllers(siteMapId: number): Promise<Controller[]>;
  getSiteMapZones(siteMapId: number): Promise<IrrigationZone[]>;
  createSiteMap(siteMap: InsertSiteMap): Promise<SiteMap>;
  deleteSiteMap(siteMapId: number): Promise<boolean>;
  saveControllers(siteMapId: number, controllers: InsertController[], companyId?: number): Promise<Controller[]>;
  saveZones(siteMapId: number, zones: InsertIrrigationZone[], companyId?: number): Promise<IrrigationZone[]>;

  // Catalog $0-price audit / backfill (Tasks #160 + #161) — covers billing sheets,
  // work orders, AND invoice line items.
  getZeroPriceCatalogItems(companyId: number | null): Promise<Array<{
    source: 'billing_sheet' | 'work_order' | 'invoice';
    itemId: number;
    parentId: number;          // billingSheetId / workOrderId / invoiceId
    parentNumber: string;      // billingNumber / workOrderNumber / invoiceNumber
    customerId: number | null;
    customerName: string;
    workDate: Date | null;
    technicianName: string;
    status: string;
    invoiceId: number | null;
    quickbooksInvoiceId: string | null;
    partId: number;
    partName: string;
    quantity: string;
    storedUnitPrice: string;
    storedTotalPrice: string;
    catalogUnitPrice: string;
    expectedTotalPrice: string;
    difference: string;
  }>>;
  repriceBillingSheetItems(
    selection: Array<{ source: 'billing_sheet' | 'work_order' | 'invoice'; itemId: number }>,
    companyId: number | null,
    options: { dryRun: boolean; performedByUserId: number | null; performedByName: string | null }
  ): Promise<{
    dryRun: boolean;
    parentCount: number;
    itemCount: number;
    totalDifference: string;
    parents: Array<{
      source: 'billing_sheet' | 'work_order' | 'invoice';
      parentId: number;
      parentNumber: string;
      oldPartsSubtotal: string;
      newPartsSubtotal: string;
      oldTotalAmount: string;
      newTotalAmount: string;
      updatedItems: Array<{
        itemId: number;
        partName: string;
        oldUnitPrice: string;
        newUnitPrice: string;
        oldTotalPrice: string;
        newTotalPrice: string;
      }>;
    }>;
  }>;

  // Labor rate mismatch audit (Task #200) — un-invoiced WO + BS whose
  // stored labor rate no longer matches the customer's current standard
  // OR emergency rate. The "inferred classification" is whichever current
  // rate the stored rate is numerically closer to.
  getLaborRateMismatchTickets(companyId: number | null): Promise<Array<{
    source: 'work_order' | 'billing_sheet';
    parentId: number;
    parentNumber: string;
    customerId: number | null;
    customerName: string;
    workDate: Date | null;
    technicianName: string;
    status: string;
    totalHours: string;
    storedLaborRate: string;
    storedLaborSubtotal: string;
    storedPartsSubtotal: string;
    storedTotalAmount: string;
    customerStandardRate: string;
    customerEmergencyRate: string;
    inferredClassification: 'standard' | 'emergency';
    expectedLaborRate: string;
    expectedLaborSubtotal: string;
    expectedTotalAmount: string;
  }>>;
  repriceLaborRateMismatches(
    selection: Array<{ source: 'work_order' | 'billing_sheet'; parentId: number; classification: 'standard' | 'emergency' }>,
    companyId: number | null,
    options: { dryRun: boolean; performedByUserId: number | null; performedByName: string | null }
  ): Promise<{
    dryRun: boolean;
    parentCount: number;
    totalDifference: string;
    parents: Array<{
      source: 'work_order' | 'billing_sheet';
      parentId: number;
      parentNumber: string;
      classification: 'standard' | 'emergency';
      oldLaborRate: string;
      newLaborRate: string;
      oldLaborSubtotal: string;
      newLaborSubtotal: string;
      oldTotalAmount: string;
      newTotalAmount: string;
    }>;
    skipped: Array<{
      source: 'work_order' | 'billing_sheet';
      parentId: number;
      reason: string;
    }>;
  }>;

  // Pricing audit events (Task #212) — read-only history of automatic
  // reprice actions, scoped per parent (billing sheet, work order, invoice).
  // When `companyId` is provided, results are additionally filtered to that
  // company so a manager from one company cannot read another company's events
  // even if the route-level scoping is bypassed.
  getPricingAuditEvents(
    source: 'billing_sheet' | 'work_order' | 'invoice',
    parentId: number,
    companyId?: number | null,
  ): Promise<PricingAuditEvent[]>;

  // Photo late-addition audit (Task #195) — records each photos-only PATCH
  // applied to a ticket that has already reached billing, so managers can
  // audit who added the late photo, when, and what state the ticket was in.
  recordPhotoLateAddition(input: InsertPhotoLateAddition): Promise<PhotoLateAddition>;
  getPhotoLateAdditions(
    ticketType: 'work_order' | 'billing_sheet',
    ticketId: number,
    companyId?: number | null,
  ): Promise<PhotoLateAddition[]>;

  // Manual Part Reviews
  getManualPartReviews(companyId: number): Promise<ManualPartReview[]>;
  getManualPartReview(id: number): Promise<ManualPartReview | undefined>;
  createManualPartReview(review: InsertManualPartReview): Promise<ManualPartReview>;
  approveManualPartReview(id: number, reviewedPrice: string): Promise<ManualPartReview | undefined>;

  // Parts Pending Approval
  getPendingParts(companyId: number): Promise<Part[]>;
  approvePart(id: number, price: string, cost?: string, companyId?: number): Promise<Part | undefined>;

  // AI Generation Logs
  createAiGenerationLog(log: InsertAiGenerationLog): Promise<AiGenerationLog>;

  // Company Profile Management
  getCompanyProfile(companyId: number): Promise<Company | undefined>;
  updateCompanyProfile(companyId: number, updates: Partial<InsertCompany>): Promise<Company>;

  // ── Wet Check System (Slice 2A) ───────────────────────────────────────────
  listIssueTypeConfigs(companyId: number): Promise<IssueTypeConfig[]>;
  listAllIssueTypeConfigs(companyId: number): Promise<IssueTypeConfig[]>;
  createIssueTypeConfig(companyId: number, data: Omit<InsertIssueTypeConfig, "companyId">): Promise<IssueTypeConfig>;
  updateIssueTypeConfig(companyId: number, id: number, patch: Partial<Omit<InsertIssueTypeConfig, "companyId">>): Promise<IssueTypeConfig | undefined>;
  reorderIssueTypeConfigs(companyId: number, orderedIds: number[]): Promise<IssueTypeConfig[]>;
  getPartsByIssueType(companyId: number, issueType: string, customerId?: number | null): Promise<{ parts: Part[]; recentPartIds: number[] }>;
  // listPropertyControllers, ensurePropertyControllers, updatePropertyController,
  // upsertPropertyController removed by Task #1857 (property_controllers table dropped).

  // Seed irrigation_controllers + irrigation_profile_zones placeholders for
  // the given (companyId, customerId, branchName) tuple. For each config entry
  // that does not already have a matching "Controller {letter}" row, inserts a
  // new row with totalZones = config.zoneCount (null if the count is unknown).
  // Uses ON CONFLICT DO NOTHING — race-safe and idempotent.
  // Returns the full controller list for the tuple.
  ensureIrrigationControllers(
    companyId: number,
    customerId: number,
    configs: Array<{ name: string; zoneCount: number | null }>,
    branchName?: string | null,
  ): Promise<IrrigationController[]>;
  // Admin: company-wide overview of active customers and their controllers,
  // grouped per branch. The customer-level bucket (NULL branch) appears as
  // `branchName: null`. Excludes customers hidden from billing.
  // Task #1857: now returns IrrigationController[] instead of PropertyController[].
  listCustomerControllersOverview(companyId: number): Promise<Array<{
    customer: Customer;
    branches: Array<{ branchName: string | null; controllers: IrrigationController[] }>;
  }>>;
  // Admin: reconcile irrigation_controllers rows so they match `count` (1-26).
  // When shrinking, refuses to delete controllers whose totalZones > 0 unless
  // `confirmDeleteWithZones` is true. Scoped to the given branch. Returns the
  // updated controller list for that branch and the customer record.
  setCustomerControllerCount(
    companyId: number,
    customerId: number,
    count: number,
    opts?: { confirmDeleteWithZones?: boolean; branchName?: string | null },
  ): Promise<{ customer: Customer; controllers: IrrigationController[]; removedLetters: string[] }>;

  listWetChecks(companyId: number, opts?: { status?: string; technicianId?: number; customerId?: number; branchName?: string }): Promise<Array<WetCheck & { zoneCount: number; processedCount: number; failedCount: number; workOrderIds: number[] }>>;
  // Admin-only company-wide list with per-row aggregate counts (zone
  // records, findings, photos). Used by the company-admin Wet Checks
  // management page.
  listWetChecksForAdmin(companyId: number, opts?: { status?: string | string[] }): Promise<Array<WetCheck & {
    zoneRecordCount: number;
    findingCount: number;
    photoCount: number;
  }>>;
  // Hard-deletes a wet check and all of its child rows (zone records,
  // findings, photos), plus any downstream records produced from its
  // findings (billing sheets, estimates, work orders, and their items).
  // Refuses with WetCheckHasInvoicedRecordsError if any of those
  // downstream records is already attached to an invoice.
  deleteWetCheck(id: number, companyId: number): Promise<boolean>;

  listWetChecksPendingReview(companyId: number): Promise<Array<WetCheck & {
    findingCounts: { quick_fix: number; advanced: number; zone_issue: number; total: number };
    totalBillable: string;
    customerLaborRate: string;
    autoBilledCount: number;
    autoBilledTotal: string;
    pendingCount: number;
    pendingTotal: string;
    // Task #428 — tech intent rollup, independent of routing/billing.
    dispositionCounts: { completed_in_field: number; needs_review: number };
  }>>;
  // Cheap status lookup used by the route layer to choose role policy
  // for a finding edit (tech vs manager) without a full join.
  // Returns both `status` (for role gating) and `mode` (service | inspection)
  // so callers can skip complete-or-flag guards on inspection wet checks.
  getWetCheckStatusForFinding(findingId: number, companyId: number): Promise<{ status: string; mode: string } | null>;
  // Cheap mode lookup for zone-record-scoped POST /findings. Used to skip
  // the complete-or-flag server guard on inspection wet checks.
  getWetCheckModeForZoneRecord(zoneRecordId: number, companyId: number): Promise<string | null>;
  // Minimal finding snapshot used by the PATCH route for merge-state billability
  // validation. Returns only the fields needed to compute the resulting state
  // (issueType, resolution, partId, noPartNeeded) without a full finding load.
  getWetCheckFindingSnapshot(findingId: number, companyId: number): Promise<{
    issueType: string;
    resolution: string;
    partId: number | null;
    noPartNeeded: boolean;
  } | null>;
  // Canonical estimate-creation service shared by POST /api/estimates
  // and the wet-check conversion engine.
  createEstimateFromPayload(
    payload: EstimatePayloadInput,
    executor?: DbExecutor,
    explicitEstimateNumber?: string,
  ): Promise<EstimateWithItems>;
  getWetCheck(id: number, companyId: number): Promise<WetCheckWithDetails | undefined>;
  findActiveWetCheck(companyId: number, customerId: number, technicianId: number, branchName?: string | null): Promise<WetCheck | undefined>;
  createWetCheck(insert: InsertWetCheck): Promise<WetCheck>;
  updateWetCheck(id: number, companyId: number, patch: Partial<InsertWetCheck>): Promise<WetCheck | undefined>;
  submitWetCheck(id: number, companyId: number): Promise<{
    wetCheck: WetCheck;
    billingSheetId: number | null;
    autoBilledCount: number;
    pendingCount: number;
  } | undefined>;
  // Dry-run pricing preview for the submit-confirm modal. Computes the
  // exact same totals the auto-bill path would persist, without writes.
  // `autoBillEnabled` reflects WET_CHECK_AUTO_BILL so the UI can gate.
  previewWetCheckSubmit(id: number, companyId: number): Promise<{
    autoBillEnabled: boolean;
    autoBilledCount: number;
    autoBilledPartsTotal: string;
    autoBilledLaborTotal: string;
    autoBilledGrandTotal: string;
    pendingCount: number;
    pendingByGroup: { quick_fix: number; advanced: number; zone_issue: number };
  } | undefined>;

  upsertWetCheckZoneRecord(
    wetCheckId: number,
    companyId: number,
    insert: InsertWetCheckZoneRecord,
  ): Promise<WetCheckZoneRecord>;
  updateWetCheckZoneRecord(
    id: number,
    companyId: number,
    patch: Partial<InsertWetCheckZoneRecord>,
  ): Promise<WetCheckZoneRecord | undefined>;
  /**
   * Task #753 (Slice 4) — set the authoritative per-zone repair labor hours.
   * Company-scoped existence check. Idempotent (safe to call multiple times
   * with the same value). Returns the updated record or undefined when not found.
   */
  setZoneRepairLabor(
    zoneRecordId: number,
    companyId: number,
    repairLaborHours: string,
  ): Promise<WetCheckZoneRecord | undefined>;
  /**
   * Task #891 — reset a zone's repair labor to the auto-computed default.
   * Clears the manually-set flag and reruns the defaultLaborHours sum.
   * Tech tier: only works on in-progress wet checks.
   */
  resetZoneRepairLabor(
    zoneRecordId: number,
    companyId: number,
  ): Promise<WetCheckZoneRecord | undefined>;
  /**
   * Task #891 — manager-tier reset: clears the manual flag and recomputes.
   * Uses assertFindingPriceEditable (in_progress + submitted + partially_converted).
   */
  resetZoneRepairLaborManagerTier(
    zoneRecordId: number,
    companyId: number,
  ): Promise<WetCheckZoneRecord | undefined>;
  /**
   * Task #891 — manager-tier zone repair labor edit. Same as setZoneRepairLabor
   * but uses the finding-price edit window (allows submitted + partially_converted
   * wet checks) instead of the tech-only in_progress guard.
   */
  setZoneRepairLaborManagerTier(
    zoneRecordId: number,
    companyId: number,
    repairLaborHours: string,
  ): Promise<WetCheckZoneRecord | undefined>;
  /**
   * Task #891 — billing-manager-tier zone repair labor edit on a finalised WCB.
   * Updates the zone record's repairLaborHours, marks it manually set, then
   * recomputes the WCB totalHours / laborSubtotal / totalAmount in-place.
   * Returns undefined when the WCB or zone record are not found.
   * Throws when the WCB is already in a terminal state (invoiced).
   */
  setWcbZoneRepairLabor(
    wcbId: number,
    zoneRecordId: number,
    repairLaborHours: string,
    companyId: number,
  ): Promise<{ before: { zoneRecord: WetCheckZoneRecord; wcb: WetCheckBilling }; updated: { zoneRecord: WetCheckZoneRecord; wcb: WetCheckBilling } } | undefined>;

  /** Task #1027 — billing-manager-tier reset of zone repair labor on a finalised WCB. */
  resetWcbZoneRepairLabor(
    wcbId: number,
    zoneRecordId: number,
    companyId: number,
  ): Promise<{ zoneRecord: WetCheckZoneRecord; wcb: WetCheckBilling } | undefined>;

  createWetCheckFinding(
    zoneRecordId: number,
    companyId: number,
    insert: Omit<InsertWetCheckFinding, "zoneRecordId" | "wetCheckId" | "issueGroup">,
  ): Promise<WetCheckFinding>;
  updateWetCheckFinding(
    id: number,
    companyId: number,
    patch: Partial<InsertWetCheckFinding>,
  ): Promise<WetCheckFinding | undefined>;
  deleteWetCheckFinding(id: number, companyId: number): Promise<boolean>;

  routeWetCheckFinding(
    id: number,
    companyId: number,
    resolution: "pending" | "repaired_in_field" | "sent_to_estimate" | "deferred_to_work_order" | "documented_only",
    manager: { id: number; name: string },
  ): Promise<WetCheckFinding | undefined>;
  convertWetCheckToWetCheckBilling(
    id: number,
    companyId: number,
    manager: { id: number; name: string },
    scheduledDates?: Record<number, string | null>,
  ): Promise<{
    wetCheck: WetCheck;
    billingSheetId: number | null;
    estimateId: number | null;
    workOrderId: number | null;
  }>;

  // WC Inspection Mode — Slice 2
  // Build (or return the existing) estimate from an Inspection wet check's
  // findings. Idempotent: if an estimate with originWetCheckId = wcId already
  // exists it is returned without creating a duplicate.
  buildEstimateFromInspectionWetCheck(
    wcId: number,
    companyId: number,
    manager: { id: number; name: string },
  ): Promise<EstimateWithItems>;

  // Internal sign-off for an Inspection wet check. Stamps
  // estimate.internalStatus='approved_internal' (does NOT customer-approve) and
  // flips the wet check to `converted`. Seam 2 self-heal: if the estimate is
  // already customer-approved/sent, skips the estimate write but still converts
  // the WC. Idempotent when the WC is already `converted`.
  passInspectionToEstimates(
    wcId: number,
    companyId: number,
  ): Promise<{ estimate: EstimateWithItems; wetCheck: WetCheck }>;

  attachWetCheckPhoto(
    wetCheckId: number,
    companyId: number,
    insert: Omit<InsertWetCheckPhoto, "wetCheckId">,
  ): Promise<WetCheckPhoto>;
  deleteWetCheckPhoto(id: number, companyId: number): Promise<boolean>;
  linkWetCheckPhotoToFinding(
    photoId: number,
    findingId: number,
    companyId: number,
  ): Promise<WetCheckPhoto | undefined>;

  /**
   * Batch-fetch wet check photo URLs grouped by wetCheckId.
   * Returns a Map<wetCheckId, url[]> — missing ids map to [].
   * Used by the invoice PDF service to merge new-system photos into
   * the WCB ticket pages without N+1 queries.
   */
  getWetCheckPhotoUrlsByIds(wetCheckIds: number[]): Promise<Map<number, string[]>>;

  // ── Wet Check Billings (Slice 10) ────────────────────────────────────────
  // Allocates the next WC-YYYY-NNNN number from billing_number_counters.
  // Seeds the prefix row with last_seq=999 on first call so the first
  // emitted number is WC-YYYY-1000. Never resets an existing counter.
  getNextWetCheckBillingNumber(): Promise<string>;
  // Creates a wet check billing record. billingNumber must be pre-generated
  // by the caller via getNextWetCheckBillingNumber() (mirrors createBillingSheet).
  // billingNumber is a required field on InsertWetCheckBilling (NOT NULL in schema).
  createWetCheckBilling(data: InsertWetCheckBilling): Promise<WetCheckBilling>;
  routeFindingsToWetCheckBillingBulk(
    findingIds: number[],
    companyId: number | null,
    userId: number | null,
  ): Promise<{ routed: number[]; errors: { findingId: number; message: string }[] }>;
  getAllWetCheckBillings(): Promise<WetCheckBilling[]>;
  getAllWetCheckBillingsWithCounts(companyId?: number | null): Promise<WetCheckBillingListItem[]>;
  getWetCheckBillingById(id: number, companyId: number | null): Promise<WetCheckBilling | undefined>;
  getWetCheckBillingsByCustomer(customerId: number): Promise<WetCheckBillingListItem[]>;
  getWetCheckBillingsByTechnician(technicianId: number): Promise<WetCheckBilling[]>;
  getWetCheckBillingsByWetCheckId(wetCheckId: number): Promise<WetCheckBilling[]>;
  updateWetCheckBilling(id: number, data: Partial<InsertWetCheckBilling>): Promise<WetCheckBilling>;
  /**
   * Task #977 — billing-manager-tier labor-rate override on an unbilled WCB.
   * Recomputes laborSubtotal (= totalHours × newRate) and totalAmount
   * (= laborSubtotal + partsSubtotal) in one atomic db.update call.
   * Throws with code "WCB_LOCKED" for billed or invoiced WCBs.
   * Throws with code "WCB_CROSS_COMPANY" on cross-tenant access.
   * Throws with code "WCB_NOT_FOUND" when the row is missing.
   * Passes companyId=null to bypass tenant-scope (super_admin).
   */
  recomputeWcbTotalsForLaborRate(id: number, newRate: number, companyId: number | null): Promise<{ before: WetCheckBilling; updated: WetCheckBilling }>;
  /** Task #1093 — flip rateMode on a billing sheet and recompute labor totals. */
  recomputeBillingSheetTotalsForRateMode(id: number, mode: string, companyId: number | null): Promise<BillingSheetWithItems>;
  /** Task #1093 — flip rateMode on a work order and recompute labor totals. */
  recomputeWorkOrderTotalsForRateMode(id: number, mode: string, companyId: number | null): Promise<WorkOrder>;
  /** Task #1093 — flip rateMode on a WCB and recompute labor totals. */
  recomputeWcbTotalsForRateMode(id: number, mode: string, companyId: number | null): Promise<{ before: WetCheckBilling; updated: WetCheckBilling }>;
  /** Task #1093 — inline item replace for billing sheets (atomic with total resync). */
  replaceBillingSheetItemsWithResync(id: number, items: InsertBillingSheetItem[], companyId: number | null): Promise<BillingSheetWithItems>;
  /** Task #1093 — inline item replace for work orders (atomic with total resync). */
  replaceWorkOrderItemsWithResync(id: number, items: InsertWorkOrderItem[], companyId: number | null): Promise<WorkOrder & { items: WorkOrderItem[] }>;
  /** Task #1315 — flat labor hours editor for billing sheets (recomputes labor totals). */
  updateBillingSheetLaborHours(id: number, totalHours: number, companyId: number | null): Promise<BillingSheetWithItems>;
  /** Task #1395 — flat labor hours editor for work orders (recomputes labor totals). */
  updateWorkOrderLaborHours(id: number, totalHours: number, companyId: number | null): Promise<WorkOrder & { items: WorkOrderItem[] }>;
  /** Task #1415 — direct labor rate override for work orders (sets appliedLaborRate, recomputes totals). */
  updateWorkOrderLaborRate(id: number, laborRate: number, companyId: number | null): Promise<WorkOrder & { items: WorkOrderItem[] }>;
  deleteWetCheckBilling(id: number): Promise<void>;
  /** Returns the URL strings of all photos attached to a wet check (both zone-level and finding-level). */
  getWetCheckPhotoUrls(wetCheckId: number): Promise<string[]>;
  /** Returns photo records with zone/finding linkage metadata for grouped PDF rendering (Task #843). */
  getWetCheckPhotosGrouped(wetCheckId: number): Promise<Array<{url: string; zoneRecordId: number | null; findingId: number | null}>>;

  // ── Irrigation System Profile ─────────────────────────────────────────────
  // All methods filter by companyId. Pass null only for super_admin callers
  // (cross-tenant). Mutating methods stamp lastUpdatedBy* on the controller
  // and append a snapshot to irrigation_profile_history atomically.

  listIrrigationControllers(
    companyId: number | null,
    customerId: number,
    branchName?: string,
  ): Promise<IrrigationController[]>;

  /**
   * Task #1856 — Returns the lowest unused letter (A–Z) for a new controller
   * in the given (company, customer, branch) scope.
   */
  nextControllerLetter(
    companyId: number,
    customerId: number,
    branchName?: string,
  ): Promise<string>;

  getIrrigationController(
    companyId: number | null,
    id: number,
  ): Promise<(IrrigationController & { programs: IrrigationProgram[]; zones: IrrigationProfileZone[] }) | null>;

  createIrrigationController(
    data: InsertIrrigationController,
  ): Promise<IrrigationController>;

  updateIrrigationController(
    companyId: number | null,
    id: number,
    patch: Partial<Omit<InsertIrrigationController, "companyId" | "customerId">>,
    actor?: { id: number; name: string },
  ): Promise<IrrigationController | null>;

  deleteIrrigationController(
    companyId: number | null,
    id: number,
  ): Promise<boolean>;

  createIrrigationProgram(
    companyId: number | null,
    controllerId: number,
    data: Omit<InsertIrrigationProgram, "companyId" | "controllerId">,
    actor?: { id: number; name: string },
  ): Promise<IrrigationProgram | null>;

  updateIrrigationProgram(
    companyId: number | null,
    id: number,
    patch: Partial<Omit<InsertIrrigationProgram, "companyId" | "controllerId">>,
    actor?: { id: number; name: string },
  ): Promise<IrrigationProgram | null>;

  deleteIrrigationProgram(
    companyId: number | null,
    id: number,
    actor?: { id: number; name: string },
  ): Promise<boolean>;

  createIrrigationZone(
    companyId: number | null,
    controllerId: number,
    data: Omit<InsertIrrigationProfileZone, "companyId" | "controllerId">,
    actor?: { id: number; name: string },
  ): Promise<IrrigationProfileZone | null>;

  updateIrrigationZone(
    companyId: number | null,
    id: number,
    patch: Partial<Omit<InsertIrrigationProfileZone, "companyId" | "controllerId">>,
    actor?: { id: number; name: string },
  ): Promise<IrrigationProfileZone | null>;

  deleteIrrigationZone(
    companyId: number | null,
    id: number,
    actor?: { id: number; name: string },
  ): Promise<boolean>;

  getIrrigationHistory(
    companyId: number | null,
    controllerId: number,
  ): Promise<IrrigationProfileHistory[]>;

  importIrrigationProfile(
    companyId: number,
    customerId: number,
    branchName: string,
    rows: IrrigationImportRow[],
    mode: "preview" | "commit",
    actor?: { id: number; name: string },
    replaceControllers?: string[],
  ): Promise<IrrigationImportResult>;

  // ── Backflow Preventers ────────────────────────────────────────────────────
  listBackflows(
    companyId: number | null,
    customerId: number,
    branchName?: string,
  ): Promise<IrrigationBackflow[]>;

  getBackflow(
    companyId: number | null,
    id: number,
  ): Promise<IrrigationBackflow | null>;

  createBackflow(
    data: InsertIrrigationBackflow,
  ): Promise<IrrigationBackflow>;

  updateBackflow(
    companyId: number | null,
    id: number,
    patch: Partial<Omit<InsertIrrigationBackflow, "companyId" | "customerId">>,
    actor?: { id: number; name: string },
  ): Promise<IrrigationBackflow | null>;

  deleteBackflow(
    companyId: number | null,
    id: number,
  ): Promise<boolean>;

  logBackflowTest(
    companyId: number | null,
    id: number,
    data: {
      lastTestedDate: string;
      lastTestResult: "pass" | "fail";
      lastTestedBy?: string | null;
      nextTestDueDate?: string | null;
    },
    actor?: { id: number; name: string },
  ): Promise<IrrigationBackflow | null>;
}

// ── Irrigation CSV import types (shared between route and storage) ─────────────

export type IrrigationZoneTypeEnum =
  | "pop_up_spray"
  | "rotor"
  | "drip"
  | "netafim"
  | "bubbler"
  | "other";

export interface IrrigationImportRow {
  controllerName: string;
  location: string | null;
  brand: string | null;
  model: string | null;
  programName: string | null;
  wateringDays: string[] | null;
  startTimes: string[] | null;
  seasonalAdjustPct: number;
  zoneNumber: number;
  zoneName: string | null;
  zoneType: IrrigationZoneTypeEnum;
  runTimeMinutes: number;
}

/**
 * Resolve the final zone name for a CSV import row.
 * - If the CSV supplied a non-blank name, use it.
 * - Otherwise, keep the existing saved name (never clobber it).
 * - If there is no existing name (new zone), fall back to `Zone {zoneNumber}`.
 *
 * This is the single shared source of truth: called from both the preview-diff
 * path and the commit-write path so what the manager approves is exactly what
 * gets saved.
 */
export function resolveZoneName(
  rowName: string | null,
  existingName: string | undefined,
  zoneNumber: number,
): string {
  if (rowName) return rowName;
  if (existingName) return existingName;
  return `Zone ${zoneNumber}`;
}

export interface IrrigationImportRowError {
  row: number;
  field: string;
  message: string;
}

export interface IrrigationImportZoneDiff {
  action: "create" | "update" | "no_change";
  zoneNumber: number;
  zoneName: string;
  zoneType: IrrigationZoneTypeEnum;
  runTimeMinutes: number;
  changes: Array<{ field: string; from: string | number | null; to: string | number | null }>;
}

export interface IrrigationImportProgramDiff {
  programName: string;
  action: "create" | "update" | "no_change";
  changes: Array<{ field: string; from: string | number | null | string[]; to: string | number | null | string[] }>;
}

export interface IrrigationImportRemovedZone {
  id: number;
  zoneNumber: number;
  name: string;
  notes: string | null;
  overrideStartTime: string | null;
  overrideDays: string[] | null;
}

export interface IrrigationImportRemovedProgram {
  id: number;
  name: string;
}

export interface IrrigationImportControllerDiff {
  controllerName: string;
  action: "create" | "update";
  location: string | null;
  brand: string | null;
  model: string | null;
  programs: IrrigationImportProgramDiff[];
  zones: IrrigationImportZoneDiff[];
  zonesToRemove?: IrrigationImportRemovedZone[];
  programsToRemove?: IrrigationImportRemovedProgram[];
}

export interface IrrigationImportResult {
  mode: "preview" | "commit";
  controllers: IrrigationImportControllerDiff[];
  summary: {
    controllersCreated: number;
    controllersUpdated: number;
    zonesAdded: number;
    zonesUpdated: number;
    programsCreated: number;
    programsUpdated: number;
    zonesRemoved: number;
    programsRemoved: number;
  };
}

// Explicit column list for the zone-records read in `getWetCheck`. It has to
// be a partial select (not `select()`) because the query left-joins
// irrigation_controllers purely to order by the controller's stored letter —
// a bare `select()` with a join returns a nested `{ table: row }` shape.
//
// Every value here MUST be a real column on `wetCheckZoneRecords`. A typo or a
// column that does not exist resolves to `undefined`, and Drizzle's
// `orderSelectedFields` then calls `Object.entries(undefined)` while preparing
// the query — a `TypeError: Cannot convert undefined or null to object` thrown
// before any SQL is sent, which turns every read into a 500. Exported so
// `wet-check-select-shape.test.ts` can assert the shape without a database.
export const WET_CHECK_ZONE_RECORD_SELECTION = {
  id: wetCheckZoneRecords.id,
  wetCheckId: wetCheckZoneRecords.wetCheckId,
  controllerLetter: wetCheckZoneRecords.controllerLetter,
  zoneNumber: wetCheckZoneRecords.zoneNumber,
  status: wetCheckZoneRecords.status,
  ranSuccessfully: wetCheckZoneRecords.ranSuccessfully,
  notes: wetCheckZoneRecords.notes,
  checkedAt: wetCheckZoneRecords.checkedAt,
  checkedBy: wetCheckZoneRecords.checkedBy,
  markedCompleteAt: wetCheckZoneRecords.markedCompleteAt,
  repairLaborHours: wetCheckZoneRecords.repairLaborHours,
  repairLaborManuallySet: wetCheckZoneRecords.repairLaborManuallySet,
  clientId: wetCheckZoneRecords.clientId,
  controllerId: wetCheckZoneRecords.controllerId,
  observedPressure: wetCheckZoneRecords.observedPressure,
  observedFlow: wetCheckZoneRecords.observedFlow,
} as const;

export class DatabaseStorage implements IStorage {
  private _billingCounterTableReady = false;
  private _billingCounterPrefixSeeded = new Set<string>();
  private _wetCheckCounterPrefixSeeded = new Set<string>();

  constructor() {
    // Database initialization - schema is managed by Drizzle
    this.initializeUsers();
    this.repairDivergedBillingSheets();
    this.applyCompanyIdColumns();
    // NOTE: backfillControllerLetters is intentionally NOT called here.
    // It is called via initialize() in app.ts BEFORE the server starts listening,
    // so the NOT NULL + unique index constraints are in place before any
    // controller-create request is processed.
  }

  // Called and awaited in app.ts before registerRoutes() so the NOT NULL +
  // unique index on irrigation_controllers.letter are in place before the
  // server accepts requests. Failures throw and crash startup.
  async initialize(): Promise<void> {
    await this.backfillControllerLetters();
  }

  // Startup migration (BS-2026-0023): repair uninvoiced billing sheets where partsSubtotal
  // does not match the sum of their billing_sheet_items.totalPrice rows.
  // Uses app_settings as a one-time-run marker so it only performs a full scan once.
  // After initial repair the migration logs a completion marker; subsequent boots skip it.
  private async repairDivergedBillingSheets(): Promise<void> {
    const MIGRATION_KEY = 'repair-diverged-billing-sheets-v1';
    try {
      // Ensure app_settings exists before querying it (it may not yet exist if storage
      // is instantiated before server/index.ts runs its own CREATE TABLE IF NOT EXISTS)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Check if this migration has already run successfully
      const existingMarker = await db.execute(
        sql`SELECT value FROM app_settings WHERE key = ${MIGRATION_KEY}`
      );
      if (existingMarker.rows.length > 0 && existingMarker.rows[0].value === 'completed') {
        console.log(`[MIGRATION] '${MIGRATION_KEY}': already completed, skipping`);
        return;
      }

      // Fetch all uninvoiced billing sheets (invoiceId is null and status != 'billed')
      const uninvoicedSheets = await db
        .select()
        .from(billingSheets)
        .where(and(isNull(billingSheets.invoiceId), sql`${billingSheets.status} != 'billed'`));

      let repairedCount = 0;
      for (const sheet of uninvoicedSheets) {
        const items = await db
          .select()
          .from(billingSheetItems)
          .where(eq(billingSheetItems.billingSheetId, sheet.id));

        // Sum the stored totalPrice column (not recomputing from qty * price) as required by spec
        const truePartsTotal = items.reduce(
          (sum, item) => sum + parseFloat(String(item.totalPrice || 0)),
          0
        );
        const recordedPartsTotal = parseFloat(String(sheet.partsSubtotal || 0));

        if (Math.abs(truePartsTotal - recordedPartsTotal) > 0.01) {
          const laborSubtotal = parseFloat(String(sheet.laborSubtotal || 0));
          const newTotalAmount = laborSubtotal + truePartsTotal;
          await db
            .update(billingSheets)
            .set({
              partsSubtotal: truePartsTotal.toFixed(2),
              totalAmount: newTotalAmount.toFixed(2),
            })
            .where(eq(billingSheets.id, sheet.id));

          console.log(
            `[MIGRATION] repaired billing sheet ${sheet.billingNumber} (id=${sheet.id}): ` +
            `partsSubtotal ${recordedPartsTotal.toFixed(2)} → ${truePartsTotal.toFixed(2)}, ` +
            `totalAmount ${parseFloat(String(sheet.totalAmount || 0)).toFixed(2)} → ${newTotalAmount.toFixed(2)}`
          );
          repairedCount++;
        }
      }

      if (repairedCount > 0) {
        console.log(`[MIGRATION] '${MIGRATION_KEY}': repaired ${repairedCount} billing sheet(s).`);
      } else {
        console.log(`[MIGRATION] '${MIGRATION_KEY}': no diverged billing sheets found.`);
      }

      // Mark this migration as completed so it is skipped on future boots
      await db.execute(
        sql`INSERT INTO app_settings (key, value) VALUES (${MIGRATION_KEY}, 'completed')
            ON CONFLICT (key) DO UPDATE SET value = 'completed'`
      );
    } catch (err) {
      console.error(`[MIGRATION] '${MIGRATION_KEY}' failed:`, err);
    }
  }

  // Startup DDL migration: add company_id columns to work_orders, billing_sheets, invoices.
  // Idempotent — uses app_settings as a one-time-run marker.
  // Runs fire-and-forget on every server start; no-ops in < 1ms after first completion.
  private async applyCompanyIdColumns(): Promise<void> {
    const MIGRATION_KEY = 'company-id-columns-v1';
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const existingMarker = await db.execute(
        sql`SELECT value FROM app_settings WHERE key = ${MIGRATION_KEY}`
      );
      if (existingMarker.rows.length > 0 && existingMarker.rows[0].value === 'completed') {
        console.log(`[MIGRATION] '${MIGRATION_KEY}': already completed, skipping`);
        return;
      }

      // (a) Add nullable columns — IF NOT EXISTS makes this safe to re-run
      await db.execute(sql`ALTER TABLE "work_orders"    ADD COLUMN IF NOT EXISTS "company_id" integer REFERENCES "companies"("id")`);
      await db.execute(sql`ALTER TABLE "billing_sheets" ADD COLUMN IF NOT EXISTS "company_id" integer REFERENCES "companies"("id")`);
      await db.execute(sql`ALTER TABLE "invoices"       ADD COLUMN IF NOT EXISTS "company_id" integer REFERENCES "companies"("id")`);
      await db.execute(sql`ALTER TABLE "estimates"      ADD COLUMN IF NOT EXISTS "company_id" integer REFERENCES "companies"("id")`);
      console.log(`[MIGRATION] '${MIGRATION_KEY}': columns added`);

      // (b) Backfill from customer's company_id
      await db.execute(sql`
        UPDATE "work_orders" wo
          SET "company_id" = c."company_id"
          FROM "customers" c
          WHERE wo."customer_id" = c."id" AND wo."company_id" IS NULL
      `);
      await db.execute(sql`
        UPDATE "billing_sheets" bs
          SET "company_id" = c."company_id"
          FROM "customers" c
          WHERE bs."customer_id" = c."id" AND bs."company_id" IS NULL
      `);
      await db.execute(sql`
        UPDATE "invoices" inv
          SET "company_id" = c."company_id"
          FROM "customers" c
          WHERE inv."customer_id" = c."id" AND inv."company_id" IS NULL
      `);
      await db.execute(sql`
        UPDATE "estimates" est
          SET "company_id" = c."company_id"
          FROM "customers" c
          WHERE est."customer_id" = c."id" AND est."company_id" IS NULL
      `);
      console.log(`[MIGRATION] '${MIGRATION_KEY}': backfill complete`);

      // (c) Enforce NOT NULL — wrapped separately so a single orphaned row doesn't
      //     block the column from being usable for new INSERTs
      try {
        await db.execute(sql`ALTER TABLE "work_orders"    ALTER COLUMN "company_id" SET NOT NULL`);
        await db.execute(sql`ALTER TABLE "billing_sheets" ALTER COLUMN "company_id" SET NOT NULL`);
        await db.execute(sql`ALTER TABLE "invoices"       ALTER COLUMN "company_id" SET NOT NULL`);
        await db.execute(sql`ALTER TABLE "estimates"      ALTER COLUMN "company_id" SET NOT NULL`);
        console.log(`[MIGRATION] '${MIGRATION_KEY}': NOT NULL constraints applied`);
      } catch (notNullErr) {
        console.error(`[MIGRATION] '${MIGRATION_KEY}': NOT NULL step failed (orphaned rows?), continuing:`, notNullErr);
      }

      // (d) Indexes
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "work_orders_company_idx"                  ON "work_orders"    ("company_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "work_orders_company_status_scheduled_idx" ON "work_orders"    ("company_id", "status", "scheduled_date")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "billing_sheets_company_idx"               ON "billing_sheets" ("company_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "invoices_company_idx"                     ON "invoices"       ("company_id")`);

      await db.execute(
        sql`INSERT INTO app_settings (key, value) VALUES (${MIGRATION_KEY}, 'completed')
            ON CONFLICT (key) DO UPDATE SET value = 'completed'`
      );
      console.log(`[MIGRATION] '${MIGRATION_KEY}': completed`);
    } catch (err) {
      console.error(`[MIGRATION] '${MIGRATION_KEY}' failed:`, err);
    }
  }

  // Startup migration (Task #1856): backfill NULL letters on irrigation_controllers,
  // then harden the column with NOT NULL + unique index.
  //
  // Called and awaited via initialize() BEFORE the server starts listening, so
  // all DDL is in place before any controller-create request is processed.
  // Failures throw and crash startup — same philosophy as a failed schema migration.
  //
  // Race safety: ALL operations run on a SINGLE pg.PoolClient, pinning the entire
  // sequence to one PostgreSQL session. pg_advisory_lock is session-scoped, so the
  // lock is guaranteed to span every step. A second concurrent instance blocks on
  // pg_advisory_lock, then sees the verified-complete state and returns immediately.
  //
  // Design rule: the fast path on a "completed" marker MUST verify the DDL invariants
  // (NOT NULL + unique index) are actually present before returning. If app_settings
  // is restored from a snapshot that predates the DDL, the invariants must be applied
  // before the server serves requests — the marker alone is not sufficient.
  private async backfillControllerLetters(): Promise<void> {
    const MIGRATION_KEY = 'controller-letter-backfill-v1';
    const ADVISORY_LOCK_ID = 1856001; // unique integer for this migration
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    // Ensure app_settings table exists (safe without the advisory lock — CREATE IF NOT
    // EXISTS is internally serialised by Postgres).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Acquire a dedicated connection — all subsequent operations use `client` ─
    // Required so pg_advisory_lock (session-scoped) is held across every step.
    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_ID]);

      // Check the completion marker AND verify both DDL invariants are actually in
      // place. A restored snapshot may have the marker but lack the DDL, so we
      // cannot return on the marker alone.
      const markerRow = await client.query<{ value: string }>(
        `SELECT value FROM app_settings WHERE key = $1`, [MIGRATION_KEY]
      );
      const markerDone = markerRow.rows.length > 0 && markerRow.rows[0].value === 'completed';

      const colInfo = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name='irrigation_controllers' AND column_name='letter'`
      );
      const notNullOk = colInfo.rows.length > 0 && colInfo.rows[0].is_nullable === 'NO';

      const idxExists = await client.query(
        `SELECT 1 FROM pg_indexes WHERE tablename='irrigation_controllers' AND indexname='uniq_irr_ctrl_letter'`
      );
      const indexOk = idxExists.rows.length > 0;

      if (markerDone && notNullOk && indexOk) {
        console.log(`[MIGRATION] '${MIGRATION_KEY}': already completed (DDL verified), skipping`);
        return;
      }

      // ── Step 1: Ensure the letter column exists ─────────────────────────────
      await client.query(`ALTER TABLE irrigation_controllers ADD COLUMN IF NOT EXISTS letter text`);

      // ── Step 2: Backfill NULL letters (skipped when marker is set, meaning the
      //    data was already backfilled; we only re-apply missing DDL in that case) ─
      if (!markerDone) {
        const nullRows = await client.query<{
          id: string; company_id: string; customer_id: string;
          branch_name: string; name: string;
        }>(
          `SELECT id, company_id, customer_id, COALESCE(branch_name,'') AS branch_name, name
           FROM irrigation_controllers WHERE letter IS NULL
           ORDER BY company_id, customer_id, branch_name, id`
        );

        if (nullRows.rows.length > 0) {
          // Task #1857: property_controllers was dropped. If the table still exists
          // (environment that hasn't run migration 0018 yet), use it as a hint source.
          // If already dropped, fall back to positional letter assignment only.
          const pcRows: { rows: Array<{ company_id: string; customer_id: string; branch_name: string; controller_letter: string }> } = { rows: [] };
          try {
            const r = await client.query<{ company_id: string; customer_id: string; branch_name: string; controller_letter: string }>(
              `SELECT company_id, customer_id, COALESCE(branch_name,'') AS branch_name, controller_letter
               FROM property_controllers
               ORDER BY company_id, customer_id, branch_name, controller_letter`
            );
            pcRows.rows = r.rows;
          } catch {
            // Table doesn't exist — migration 0018 already applied. Skip hints.
          }
          const pcHints = new Map<string, Set<string>>();
          for (const pc of pcRows.rows) {
            const key = `${pc.company_id}:${pc.customer_id}:${pc.branch_name}`;
            const s = pcHints.get(key) ?? new Set<string>();
            s.add(pc.controller_letter);
            pcHints.set(key, s);
          }

          const assignedRows = await client.query<{
            company_id: string; customer_id: string; branch_name: string; letter: string;
          }>(
            `SELECT company_id, customer_id, COALESCE(branch_name,'') AS branch_name, letter
             FROM irrigation_controllers WHERE letter IS NOT NULL`
          );
          const assignedLetters = new Map<string, Set<string>>();
          for (const r of assignedRows.rows) {
            const key = `${r.company_id}:${r.customer_id}:${r.branch_name}`;
            const s = assignedLetters.get(key) ?? new Set<string>();
            s.add(r.letter);
            assignedLetters.set(key, s);
          }

          for (const row of nullRows.rows) {
            const scopeKey = `${row.company_id}:${row.customer_id}:${row.branch_name}`;
            const used = assignedLetters.get(scopeKey) ?? new Set<string>();
            const hints = pcHints.get(scopeKey) ?? new Set<string>();

            let chosen: string | undefined;
            for (const hint of hints) {
              if (!used.has(hint)) { chosen = hint; break; }
            }
            if (!chosen) {
              for (const candidate of ALPHABET) {
                if (!used.has(candidate)) { chosen = candidate; break; }
              }
            }
            if (!chosen) {
              throw new Error(`[MIGRATION] '${MIGRATION_KEY}': id=${row.id} "${row.name}" — all 26 letters in use`);
            }
            used.add(chosen);
            assignedLetters.set(scopeKey, used);
            await client.query(`UPDATE irrigation_controllers SET letter = $1 WHERE id = $2`, [chosen, row.id]);
            console.log(`[MIGRATION] '${MIGRATION_KEY}': id=${row.id} name="${row.name}" → ${chosen}`);
          }
        }

        // Assert 0 NULLs remain before hardening
        const nullCheck = await client.query<{ cnt: string }>(
          `SELECT COUNT(*)::int AS cnt FROM irrigation_controllers WHERE letter IS NULL`
        );
        const nullCount = Number(nullCheck.rows[0].cnt);
        if (nullCount > 0) {
          throw new Error(`[MIGRATION] '${MIGRATION_KEY}': ${nullCount} NULL letter(s) remain after backfill`);
        }
      }

      // ── Step 3: SET NOT NULL (idempotent — also applied when marker exists
      //    but DDL was missing, e.g. snapshot restore) ──────────────────────────
      if (!notNullOk) {
        await client.query(`ALTER TABLE irrigation_controllers ALTER COLUMN letter SET NOT NULL`);
        console.log(`[MIGRATION] '${MIGRATION_KEY}': SET NOT NULL applied`);
      }

      // ── Step 4: Create unique index if missing ──────────────────────────────
      if (!indexOk) {
        await client.query(
          `CREATE UNIQUE INDEX uniq_irr_ctrl_letter ON irrigation_controllers (company_id, customer_id, branch_name, letter)`
        );
        console.log(`[MIGRATION] '${MIGRATION_KEY}': unique index created`);
      }

      // ── Step 5: Mark done ───────────────────────────────────────────────────
      if (!markerDone) {
        await client.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, 'completed')
           ON CONFLICT (key) DO UPDATE SET value='completed', updated_at=NOW()`,
          [MIGRATION_KEY]
        );
        console.log(`[MIGRATION] '${MIGRATION_KEY}': completed`);
      } else if (!notNullOk || !indexOk) {
        console.log(`[MIGRATION] '${MIGRATION_KEY}': DDL invariants re-applied after snapshot restore`);
      }

      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
    } catch (err) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]).catch(() => {});
      throw err; // propagate — crashes startup as intended
    } finally {
      client.release();
    }
  }

  // Company methods
  async getCompanies(): Promise<Company[]> {
    return await db.select().from(companies).orderBy(companies.name);
  }

  async getCompany(id: number): Promise<Company | undefined> {
    const result = await db.select().from(companies).where(eq(companies.id, id));
    return result[0];
  }

  async createCompany(company: InsertCompany): Promise<Company> {
    // Task #669 — keep the counter in lock-step with the configured
    // seed at create time. If the super-admin provided a custom
    // `startingEstimateNumber` and didn't also specify
    // `nextEstimateNumber`, mirror starting → next so the very first
    // allocation lands at the configured seed (never the schema
    // default of 50000).
    const start = (company as { startingEstimateNumber?: number | null }).startingEstimateNumber;
    const nextProvided = (company as { nextEstimateNumber?: number | null }).nextEstimateNumber;
    const payload: InsertCompany =
      typeof start === "number" && nextProvided == null
        ? ({ ...company, nextEstimateNumber: start } as InsertCompany)
        : company;
    const result = await db.insert(companies).values(payload).returning();
    const newCompany = result[0];
    // Auto-seed issue_type_configs for the new company so wet check labor
    // recompute works immediately without requiring an admin trigger.
    // Fire-and-forget: a seed failure must never block company creation.
    void seedIssueTypeConfigsForCompany(newCompany.id).catch((err) => {
      console.warn(`[seedIssueTypeConfigs] failed for company ${newCompany.id}:`, err);
    });
    return newCompany;
  }

  async updateCompany(id: number, company: Partial<InsertCompany>): Promise<Company | undefined> {
    // Task #669 — when the super-admin raises `startingEstimateNumber`
    // we also bump `nextEstimateNumber` to keep the configured seed
    // and the live allocator in sync. Policy: `nextEstimateNumber`
    // is monotonically non-decreasing (we never reissue a number
    // already handed out), so we pin it to MAX(currentNext, newStart).
    // If the caller passed an explicit `nextEstimateNumber` we honor
    // it verbatim and skip the auto-sync — that's the explicit override
    // path super-admin uses on the edit form.
    const patch: Partial<InsertCompany> = { ...company };
    const newStart = patch.startingEstimateNumber;
    const explicitNext = patch.nextEstimateNumber;
    if (typeof newStart === "number" && explicitNext == null) {
      const [existing] = await db
        .select({ next: companies.nextEstimateNumber })
        .from(companies)
        .where(eq(companies.id, id));
      const currentNext = existing?.next ?? newStart;
      patch.nextEstimateNumber = Math.max(currentNext, newStart);
    }
    const result = await db.update(companies).set(patch).where(eq(companies.id, id)).returning();
    return result[0];
  }

  async deleteCompany(id: number): Promise<boolean> {
    await db.delete(companies).where(eq(companies.id, id));
    return true;
  }

  // Company Profile Management for authenticated company admins
  async getCompanyProfile(companyId: number): Promise<Company | undefined> {
    const result = await db.select().from(companies).where(eq(companies.id, companyId));
    return result[0];
  }

  async updateCompanyProfile(companyId: number, updates: Partial<InsertCompany>): Promise<Company> {
    const result = await db
      .update(companies)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(companies.id, companyId))
      .returning();
    return result[0];
  }

  async createCompanyProfile(companyData: InsertCompany): Promise<Company> {
    const result = await db
      .insert(companies)
      .values(companyData)
      .returning();
    return result[0];
  }

  async checkCompanyProfileExists(companyId: number): Promise<boolean> {
    const result = await db.select().from(companies).where(eq(companies.id, companyId));
    if (result.length === 0) {
      return false;
    }
    
    const company = result[0];
    // Check if company has proper setup (not just auto-generated placeholder)
    const hasSetupRequiredInName = company.name.includes("(Setup Required)");
    const hasValidName = company.name.trim() !== "";
    const hasValidAddress = Boolean(company.address && company.address.trim() !== "");
    const hasValidEmail = Boolean(company.email && company.email.trim() !== "");
    
    const isSetupComplete = !hasSetupRequiredInName && hasValidName && hasValidAddress && hasValidEmail;
    return isSetupComplete;
  }

  // Initialize fresh system with minimal data for onboarding demo
  private async initializeUsers() {
    try {
      // Check if users already exist
      const existingUsers = await db.select().from(users);
      if (existingUsers.length === 0) {
        // Create a placeholder company first for the demo user
        const demoCompany = await db.insert(companies).values({
          id: 99,
          name: "Demo Company (Setup Required)",
          subscription: "basic",
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).returning();

        // Create only essential users for fresh onboarding experience
        await db.insert(users).values([
          {
            username: "superadmin",
            password: "superadmin123", // In production, this should be hashed
            name: "Super Admin",
            email: "super@system.com",
            role: "super_admin",
            companyId: null, // System level user
            isActive: true,
          },
          {
            username: "randymangel",
            password: "admin123",
            name: "Randy Mangel",
            email: "randy@greenvalley.com",
            role: "company_admin",
            companyId: 99, // Demo company that needs setup
            isActive: true,
          },
        ]);
      }
    } catch (error) {
      console.error("Error initializing users and companies:", error);
    }
  }

  // Users - with optional pagination (backward compatible)
  async getUsers(companyId?: number, options?: { limit?: number; offset?: number }): Promise<User[]> {
    const conditions = [];
    if (companyId !== undefined && companyId !== null) {
      conditions.push(eq(users.companyId, companyId));
    }

    let query = conditions.length > 0
      ? db.select().from(users).where(and(...conditions))
      : db.select().from(users);

    if (options?.limit) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset) {
      query = query.offset(options.offset) as typeof query;
    }
    
    return await query;
  }

  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(
      sql`lower(${users.username}) = lower(${username})`
    );
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async getUserByPasswordResetToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.passwordResetToken, token));
    return user || undefined;
  }

  async getUserByEmailVerificationToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.emailVerificationToken, token));
    return user || undefined;
  }

  async getUserByRole(role: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.role, role));
    return user || undefined;
  }

  async createUser(user: InsertUser): Promise<User> {
    // Hash the password before storing
    const hashedPassword = await bcrypt.hash(user.password, 10);
    
    // Generate email verification token if user has email and isn't already verified
    let emailVerificationToken: string | undefined;
    let emailVerificationExpires: Date | undefined;
    
    if (user.email && !user.emailVerified) {
      const crypto = await import('crypto');
      emailVerificationToken = crypto.randomBytes(32).toString('hex');
      emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    }
    
    const [newUser] = await db.insert(users).values({
      ...user,
      password: hashedPassword,
      emailVerificationToken,
      emailVerificationExpires
    }).returning();
    
    // Send verification email if user has email and token was generated
    if (newUser.email && emailVerificationToken && !newUser.emailVerified) {
      try {
        const { EmailService } = await import('./email-service');
        await EmailService.sendEmailVerification(newUser.email, emailVerificationToken, newUser.name);
        console.log(`Verification email sent to ${newUser.email} for new user`);
      } catch (emailError) {
        console.error('Failed to send verification email for new user:', emailError);
        // Don't fail user creation if email fails, just log it
      }
    }
    
    return newUser;
  }

  async updateUser(id: number, user: Partial<InsertUser>): Promise<User | undefined> {
    const updateData = { ...user, updatedAt: new Date() };
    const [updatedUser] = await db.update(users).set(updateData).where(eq(users.id, id)).returning();
    return updatedUser || undefined;
  }

  async updateUserPassword(username: string, hashedPassword: string): Promise<User | undefined> {
    const [updatedUser] = await db.update(users)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(users.username, username))
      .returning();
    return updatedUser || undefined;
  }

  async deleteUser(id: number): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id));
    return (result.rowCount || 0) > 0;
  }

  // Soft delete user - marks as deleted but preserves data integrity
  async softDeleteUser(id: number): Promise<boolean> {
    try {
      const result = await db
        .update(users)
        .set({ 
          isDeleted: true, 
          deletedAt: new Date(),
          isActive: false, // Also deactivate
          updatedAt: new Date()
        })
        .where(eq(users.id, id))
        .returning();
      return result.length > 0;
    } catch (error) {
      console.error('Error soft deleting user:', error);
      return false;
    }
  }

  // Check user's data dependencies before deletion
  async getUserDataDependencies(userId: number): Promise<{
    hasWorkOrders: boolean;
    hasBillingSheets: boolean;
    hasNotifications: boolean;
    workOrderCount: number;
    billingSheetCount: number;
    notificationCount: number;
  }> {
    try {
      // Check work orders (assigned or completed by user)
      const workOrdersAssigned = await db
        .select({ count: sql<number>`count(*)` })
        .from(workOrders)
        .where(eq(workOrders.assignedTechnicianId, userId));
      
      const workOrdersCompleted = await db
        .select({ count: sql<number>`count(*)` })
        .from(workOrders)
        .where(eq(workOrders.completedByUserId, userId));

      // Check billing sheets
      const billingSheetsResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(billingSheets)
        .where(eq(billingSheets.technicianId, userId));

      // Check notifications
      const notificationsResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(notifications)
        .where(eq(notifications.userId, userId));

      const totalWorkOrders = (workOrdersAssigned[0]?.count || 0) + (workOrdersCompleted[0]?.count || 0);
      const totalBillingSheets = billingSheetsResult[0]?.count || 0;
      const totalNotifications = notificationsResult[0]?.count || 0;

      return {
        hasWorkOrders: totalWorkOrders > 0,
        hasBillingSheets: totalBillingSheets > 0,
        hasNotifications: totalNotifications > 0,
        workOrderCount: totalWorkOrders,
        billingSheetCount: totalBillingSheets,
        notificationCount: totalNotifications
      };
    } catch (error) {
      console.error('Error checking user dependencies:', error);
      return {
        hasWorkOrders: false,
        hasBillingSheets: false,
        hasNotifications: false,
        workOrderCount: 0,
        billingSheetCount: 0,
        notificationCount: 0
      };
    }
  }

  // Hard delete user with cascade handling (use with caution)
  async hardDeleteUserWithCascade(userId: number): Promise<boolean> {
    const transaction = db.transaction(async (tx) => {
      try {
        // Delete notifications
        await tx.delete(notifications).where(eq(notifications.userId, userId));
        
        // Update work orders to remove user references (preserve historical data)
        await tx
          .update(workOrders)
          .set({ 
            assignedTechnicianId: null,
            assignedTechnicianName: `[Deleted User: ${userId}]`
          })
          .where(eq(workOrders.assignedTechnicianId, userId));

        await tx
          .update(workOrders)
          .set({ 
            completedByUserId: null,
            completedByUserName: `[Deleted User: ${userId}]`
          })
          .where(eq(workOrders.completedByUserId, userId));

        // Update billing sheets to preserve historical data
        await tx
          .update(billingSheets)
          .set({ 
            technicianId: null,
            technicianName: `[Deleted User: ${userId}]`
          })
          .where(eq(billingSheets.technicianId, userId));

        // Finally delete the user
        const result = await tx.delete(users).where(eq(users.id, userId));
        
        return (result.rowCount || 0) > 0;
      } catch (error) {
        console.error('Error in hard delete transaction:', error);
        throw error;
      }
    });

    try {
      return await transaction;
    } catch (error) {
      console.error('Transaction failed:', error);
      return false;
    }
  }

  // ── Mobile bearer-token auth (M1) ─────────────────────────────────────────
  // Tokens are stored hashed (sha256). The raw token is only returned to the
  // client at login time. `getActiveMobileTokenByHash` performs the lookup
  // and the `lastUsedAt` bump in a single transaction so a revoked or
  // expired token cannot slip through under contention.
  async createMobileToken(token: InsertMobileToken): Promise<MobileToken> {
    const [row] = await db.insert(mobileTokens).values(token).returning();
    return row;
  }

  async getActiveMobileTokenByHash(tokenHash: string): Promise<MobileToken | undefined> {
    // Atomic lookup + lastUsedAt bump. The active-row predicate
    // (revokedAt IS NULL AND expiresAt > now) is evaluated by the same
    // UPDATE statement that performs the bump, so a concurrent
    // revokeMobileToken cannot slip a revoked token through between a
    // separate SELECT and UPDATE. Belt-and-suspenders re-check on the
    // returned row guards against any future driver/RETURNING quirks.
    const now = new Date();
    const [bumped] = await db
      .update(mobileTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(mobileTokens.tokenHash, tokenHash),
          isNull(mobileTokens.revokedAt),
          gt(mobileTokens.expiresAt, now),
        ),
      )
      .returning();
    if (!bumped) return undefined;
    if (bumped.revokedAt != null || bumped.expiresAt <= now) return undefined;
    return bumped;
  }

  // Revokes the access token whose sha256 hash matches `tokenHash` AND any
  // refresh token paired with it (Task #521). Logout funnels through here
  // so the field tech tearing down a session kills the whole pair, not
  // just the access half.
  async revokeMobileToken(tokenHash: string): Promise<boolean> {
    const now = new Date();
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: mobileTokens.id, refreshTokenId: mobileTokens.refreshTokenId, revokedAt: mobileTokens.revokedAt })
        .from(mobileTokens)
        .where(eq(mobileTokens.tokenHash, tokenHash));
      if (!row) return false;
      let revoked = false;
      if (row.revokedAt == null) {
        const upd = await tx
          .update(mobileTokens)
          .set({ revokedAt: now })
          .where(and(eq(mobileTokens.id, row.id), isNull(mobileTokens.revokedAt)));
        revoked = (upd.rowCount ?? 0) > 0;
      }
      if (row.refreshTokenId != null) {
        await tx
          .update(mobileRefreshTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(mobileRefreshTokens.id, row.refreshTokenId),
              isNull(mobileRefreshTokens.revokedAt),
            ),
          );
        // Cascade-revoke any sibling access tokens minted off the same
        // refresh token so refreshing again from a stale access token
        // can't slip back in.
        await tx
          .update(mobileTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(mobileTokens.refreshTokenId, row.refreshTokenId),
              isNull(mobileTokens.revokedAt),
            ),
          );
      }
      return revoked;
    });
  }

  async revokeAllMobileTokensForUser(userId: number): Promise<number> {
    const now = new Date();
    return await db.transaction(async (tx) => {
      const accessRes = await tx
        .update(mobileTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(mobileTokens.userId, userId),
            isNull(mobileTokens.revokedAt),
          ),
        );
      await tx
        .update(mobileRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(mobileRefreshTokens.userId, userId),
            isNull(mobileRefreshTokens.revokedAt),
          ),
        );
      return accessRes.rowCount ?? 0;
    });
  }

  // ── Mobile refresh tokens (Task #521) ───────────────────────────────────
  async createMobileRefreshToken(
    token: InsertMobileRefreshToken,
  ): Promise<MobileRefreshToken> {
    const [row] = await db.insert(mobileRefreshTokens).values(token).returning();
    return row;
  }

  async getActiveMobileRefreshTokenByHash(
    tokenHash: string,
  ): Promise<MobileRefreshToken | undefined> {
    // Mirrors getActiveMobileTokenByHash: bump lastUsedAt atomically
    // with the active-row predicate so a concurrent revoke can't slip
    // through between a SELECT and UPDATE.
    const now = new Date();
    const [bumped] = await db
      .update(mobileRefreshTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(mobileRefreshTokens.tokenHash, tokenHash),
          isNull(mobileRefreshTokens.revokedAt),
          gt(mobileRefreshTokens.expiresAt, now),
        ),
      )
      .returning();
    if (!bumped) return undefined;
    if (bumped.revokedAt != null || bumped.expiresAt <= now) return undefined;
    return bumped;
  }

  async revokeMobileRefreshToken(tokenHash: string): Promise<boolean> {
    const now = new Date();
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: mobileRefreshTokens.id, revokedAt: mobileRefreshTokens.revokedAt })
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.tokenHash, tokenHash));
      if (!row) return false;
      if (row.revokedAt != null) return false;
      const upd = await tx
        .update(mobileRefreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(mobileRefreshTokens.id, row.id), isNull(mobileRefreshTokens.revokedAt)));
      // Cascade-revoke linked access tokens.
      await tx
        .update(mobileTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(mobileTokens.refreshTokenId, row.id),
            isNull(mobileTokens.revokedAt),
          ),
        );
      return (upd.rowCount ?? 0) > 0;
    });
  }

  async revokeMobileRefreshTokenById(id: number): Promise<boolean> {
    const now = new Date();
    return await db.transaction(async (tx) => {
      const upd = await tx
        .update(mobileRefreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(mobileRefreshTokens.id, id), isNull(mobileRefreshTokens.revokedAt)));
      await tx
        .update(mobileTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(mobileTokens.refreshTokenId, id),
            isNull(mobileTokens.revokedAt),
          ),
        );
      return (upd.rowCount ?? 0) > 0;
    });
  }

  // Customers
  async getCustomers(companyId?: number): Promise<Customer[]> {
    const query = db.select().from(customers);
    if (companyId !== undefined && companyId !== null) {
      return await query.where(eq(customers.companyId, companyId));
    }
    return await query;
  }

  async getCustomer(id: number): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(eq(customers.id, id));
    return customer || undefined;
  }

  async getCustomerById(id: number): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(eq(customers.id, id));
    return customer || undefined;
  }

  async getCustomerByQuickBooksId(quickbooksId: string): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(eq(customers.quickbooksId, quickbooksId));
    return customer || undefined;
  }

  async createCustomer(customer: InsertCustomer): Promise<Customer> {
    const [newCustomer] = await db.insert(customers).values(customer).returning();
    return newCustomer;
  }

  async updateCustomer(id: number, customer: Partial<InsertCustomer>): Promise<Customer | undefined> {
    const [updatedCustomer] = await db.update(customers).set(customer).where(eq(customers.id, id)).returning();
    return updatedCustomer || undefined;
  }

  async deleteCustomer(id: number): Promise<boolean> {
    const result = await db.delete(customers).where(eq(customers.id, id));
    return (result.rowCount || 0) > 0;
  }

  // Parts
  async getParts(companyId?: number | null): Promise<Part[]> {
    if (companyId != null) {
      return await db.select().from(parts).where(eq(parts.companyId, companyId));
    }
    return await db.select().from(parts);
  }

  async getPart(id: number): Promise<Part | undefined> {
    const [part] = await db.select().from(parts).where(eq(parts.id, id));
    return part || undefined;
  }

  async searchParts(query: string): Promise<Part[]> {
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return await db.select().from(parts);
    }
    const conditions = words.map(word =>
      or(
        ilike(parts.name, `%${word}%`),
        ilike(parts.description, `%${word}%`),
        ilike(parts.sku, `%${word}%`)
      )
    );
    return await db.select().from(parts).where(and(...conditions));
  }

  async createPart(part: InsertPart): Promise<Part> {
    const serialized: DrizzlePartInsert = {
      ...toDrizzleInsert<DrizzlePartInsert>(part),
      price: Number(part.price).toFixed(2),
      cost: part.cost != null ? Number(part.cost).toFixed(2) : null,
    };
    const [newPart] = await db.insert(parts).values(serialized).returning();
    return newPart;
  }

  async updatePart(id: number, part: Partial<InsertPart>): Promise<Part | undefined> {
    try {
      const payload = { ...toDrizzleInsert<Partial<DrizzlePartInsert>>(part), updatedAt: new Date() };
      const [updatedPart] = await db.update(parts).set(payload).where(eq(parts.id, id)).returning();
      return updatedPart || undefined;
    } catch (error) {
      console.error(`Database error in updatePart for ID ${id}:`, error);
      console.error(`Data being updated:`, part);
      throw error; // Re-throw to let calling code handle it
    }
  }

  // Assembly methods
  async getAssemblies(companyId: number): Promise<AssemblyWithParts[]> {
    const assemblyResults = await db
      .select()
      .from(assemblies)
      .where(and(eq(assemblies.companyId, companyId), eq(assemblies.isActive, true)))
      .orderBy(assemblies.name);

    const assembliesWithParts: AssemblyWithParts[] = [];
    
    for (const assembly of assemblyResults) {
      const partsResults = await db
        .select({
          id: assemblyParts.id,
          assemblyId: assemblyParts.assemblyId,
          partId: assemblyParts.partId,
          quantity: assemblyParts.quantity,
          sortOrder: assemblyParts.sortOrder,
          part: parts
        })
        .from(assemblyParts)
        .innerJoin(parts, eq(assemblyParts.partId, parts.id))
        .where(eq(assemblyParts.assemblyId, assembly.id))
        .orderBy(assemblyParts.sortOrder);

      assembliesWithParts.push({
        ...assembly,
        parts: partsResults
      });
    }

    return assembliesWithParts;
  }

  async getAssembly(id: number): Promise<AssemblyWithParts | undefined> {
    const [assembly] = await db.select().from(assemblies).where(eq(assemblies.id, id));
    if (!assembly) return undefined;

    const partsResults = await db
      .select({
        id: assemblyParts.id,
        assemblyId: assemblyParts.assemblyId,
        partId: assemblyParts.partId,
        quantity: assemblyParts.quantity,
        sortOrder: assemblyParts.sortOrder,
        part: parts
      })
      .from(assemblyParts)
      .innerJoin(parts, eq(assemblyParts.partId, parts.id))
      .where(eq(assemblyParts.assemblyId, assembly.id))
      .orderBy(assemblyParts.sortOrder);

    return {
      ...assembly,
      parts: partsResults
    };
  }

  async createAssembly(assembly: InsertAssembly, partsList: InsertAssemblyPart[]): Promise<AssemblyWithParts> {
    // Calculate totals from parts
    let totalPrice = 0;
    let totalLaborHours = 0;

    for (const assemblyPart of partsList) {
      const [part] = await db.select().from(parts).where(eq(parts.id, assemblyPart.partId));
      if (part) {
        const quantity = parseFloat(assemblyPart.quantity.toString());
        const partPrice = parseFloat(part.price.toString());
        
        totalPrice += partPrice * quantity;
      }
    }

    const [newAssembly] = await db
      .insert(assemblies)
      .values({
        ...assembly,
        totalPrice: totalPrice.toFixed(2),
        totalLaborHours: totalLaborHours.toFixed(2)
      })
      .returning();

    // Add parts to assembly
    const assemblyPartsWithId = partsList.map((part, index) => ({
      ...part,
      assemblyId: newAssembly.id,
      quantity: part.quantity.toString(),
      sortOrder: index
    }));

    await db.insert(assemblyParts).values(assemblyPartsWithId);

    // Return the complete assembly with parts
    return this.getAssembly(newAssembly.id) as Promise<AssemblyWithParts>;
  }

  async updateAssembly(id: number, assembly: Partial<InsertAssembly>, partsList?: InsertAssemblyPart[]): Promise<AssemblyWithParts | undefined> {
    const existing = await this.getAssembly(id);
    if (!existing) return undefined;

    // If parts list is provided, recalculate totals
    if (partsList) {
      let totalPrice = 0;
      let totalLaborHours = 0;

      for (const assemblyPart of partsList) {
        const [part] = await db.select().from(parts).where(eq(parts.id, assemblyPart.partId));
        if (part) {
          const quantity = parseFloat(assemblyPart.quantity.toString());
          const partPrice = parseFloat(part.price.toString());
          
          totalPrice += partPrice * quantity;
        }
      }

      Object.assign(assembly, {
        totalPrice: totalPrice.toFixed(2),
        totalLaborHours: totalLaborHours.toFixed(2)
      });

      // Remove existing parts
      await db.delete(assemblyParts).where(eq(assemblyParts.assemblyId, id));

      // Add new parts
      const assemblyPartsWithId = partsList.map((part, index) => ({
        ...part,
        assemblyId: id,
        quantity: part.quantity.toString(),
        sortOrder: index
      }));

      await db.insert(assemblyParts).values(assemblyPartsWithId);
    }

    // Update assembly
    const [updatedAssembly] = await db
      .update(assemblies)
      .set({ ...assembly, updatedAt: new Date() })
      .where(eq(assemblies.id, id))
      .returning();

    return this.getAssembly(updatedAssembly.id) as Promise<AssemblyWithParts>;
  }

  async deleteAssembly(id: number): Promise<boolean> {
    // Delete assembly parts first (foreign key constraint)
    await db.delete(assemblyParts).where(eq(assemblyParts.assemblyId, id));
    
    // Then delete assembly
    const result = await db.delete(assemblies).where(eq(assemblies.id, id));
    return (result.rowCount || 0) > 0;
  }

  async trackAssemblyUsage(companyId: number, assemblyId: number): Promise<void> {
    // Update assembly usage count
    await db
      .update(assemblies)
      .set({ 
        usageCount: sql`${assemblies.usageCount} + 1`,
        updatedAt: new Date()
      })
      .where(eq(assemblies.id, assemblyId));

    // Track in part usage table
    const existingUsage = await db
      .select()
      .from(partUsage)
      .where(and(
        eq(partUsage.companyId, companyId),
        eq(partUsage.assemblyId, assemblyId)
      ));

    if (existingUsage.length > 0) {
      await db
        .update(partUsage)
        .set({
          usageCount: sql`${partUsage.usageCount} + 1`,
          lastUsedAt: new Date(),
          updatedAt: new Date()
        })
        .where(and(
          eq(partUsage.companyId, companyId),
          eq(partUsage.assemblyId, assemblyId)
        ));
    } else {
      await db.insert(partUsage).values({
        companyId,
        assemblyId,
        usageCount: 1,
        lastUsedAt: new Date(),
        updatedAt: new Date()
      });
    }
  }

  async getPartByQuickBooksId(quickbooksId: string): Promise<Part | undefined> {
    try {
      const partsList = await db.select().from(parts).where(eq(parts.quickbooksId, quickbooksId));
      return partsList.length > 0 ? partsList[0] : undefined;
    } catch (error) {
      console.error('Error in getPartByQuickBooksId:', error);
      return undefined;
    }
  }

  async syncPartsFromGoogleDocs(docUrl: string): Promise<void> {
    // Implementation for Google Docs sync would go here
    console.log(`Syncing parts from Google Docs URL: ${docUrl}`);
  }

  // Estimates
  async getEstimates(opts?: { includeDeleted?: boolean }): Promise<Estimate[]> {
    // Task #634 — exclude soft-deleted rows unless the caller (super_admin
    // with `?includeDeleted=1`) explicitly opts in.
    const baseQuery = db.select().from(estimates);
    const filtered = opts?.includeDeleted
      ? baseQuery
      : baseQuery.where(isNull(estimates.deletedAt));
    const estimatesList = await filtered.orderBy(desc(estimates.createdAt));
    
    // Recalculate totals for each estimate to ensure accuracy
    const estimatesWithCalculatedTotals = await Promise.all(
      estimatesList.map(async (estimate) => {
        const items = await db.select().from(estimateItems).where(eq(estimateItems.estimateId, estimate.id));
        
        let partsSubtotal = 0;
        let perPartLaborHours = 0;

        items.forEach(item => {
          partsSubtotal += money(item.totalPrice);
          perPartLaborHours += money(item.laborHours);
        });

        // Prefer the SNAPSHOT appliedLaborRate (locked at creation /
        // conversion) over the mutable customer/estimate laborRate so
        // downstream reads never reprice an estimate if rates change later.
        const laborRate = money(estimate.appliedLaborRate ?? estimate.laborRate);
        // Task #396 — flat mode uses the persisted totalLaborHours; per_part
        // mode keeps the legacy sum-of-line-hours behavior.
        const totalLaborHours = estimate.laborMode === 'flat'
          ? parseFloat(String(estimate.totalLaborHours ?? 0)) || 0
          : perPartLaborHours;
        const laborSubtotal = totalLaborHours * laborRate;
        const totalAmount = partsSubtotal + laborSubtotal;

        return {
          ...estimate,
          partsSubtotal: partsSubtotal.toFixed(2),
          laborSubtotal: laborSubtotal.toFixed(2),
          totalAmount: totalAmount.toFixed(2),
          lifecycleStatus: computeLifecycleStatus(estimate),
        };
      })
    );
    
    return estimatesWithCalculatedTotals;
  }

  // Manager review queue. Mirrors getEstimates per-row recompute, but
  // filters to estimates whose internal review track is awaiting admin
  // action — either still `pending_approval` OR `approved_internal`
  // (admin has internally approved but has not yet sent to the
  // customer). Both bucket into the manager's "Pending review"
  // lifecycle bucket on the client, so the admin Pending Approval list
  // must include the same set for the two views to agree (Task #606).
  // When `companyId` is non-null (the normal case for billing_manager /
  // company_admin), restricts to that company. `null` is reserved for
  // super_admin global access.
  async getEstimatesPendingApproval(companyId: number | null): Promise<Estimate[]> {
    const statusClause = or(
      eq(estimates.internalStatus, "pending_approval"),
      eq(estimates.internalStatus, "approved_internal"),
    );
    // Task #634 — exclude soft-deleted drafts from the review queue.
    const notDeleted = isNull(estimates.deletedAt);
    const whereClause = companyId === null
      ? and(statusClause, notDeleted)
      : and(statusClause, notDeleted, eq(estimates.companyId, companyId));
    const estimatesList = await db
      .select()
      .from(estimates)
      .where(whereClause as any)
      .orderBy(desc(estimates.createdAt));

    const estimatesWithCalculatedTotals = await Promise.all(
      estimatesList.map(async (estimate) => {
        const items = await db.select().from(estimateItems).where(eq(estimateItems.estimateId, estimate.id));

        let partsSubtotal = 0;
        let perPartLaborHours = 0;
        items.forEach(item => {
          partsSubtotal += money(item.totalPrice);
          perPartLaborHours += money(item.laborHours);
        });

        const laborRate = money(estimate.appliedLaborRate ?? estimate.laborRate);
        // Task #396 — honor flat mode using persisted totalLaborHours.
        const totalLaborHours = estimate.laborMode === 'flat'
          ? money(estimate.totalLaborHours ?? 0)
          : perPartLaborHours;
        const laborSubtotal = totalLaborHours * laborRate;
        const totalAmount = partsSubtotal + laborSubtotal;

        return {
          ...estimate,
          partsSubtotal: partsSubtotal.toFixed(2),
          laborSubtotal: laborSubtotal.toFixed(2),
          totalAmount: totalAmount.toFixed(2),
          lifecycleStatus: computeLifecycleStatus(estimate),
        };
      })
    );

    return estimatesWithCalculatedTotals;
  }

  // Task #683 — aggregate summary for the Estimate Command Center.
  // Runs ONE company-scoped query, then delegates to the pure
  // computeEstimateSummary helper so the windows/attention math can
  // be unit-tested without a database.
  async getEstimateSummary(companyId: number | null): Promise<EstimateSummary> {
    // Scope at the SQL layer (matches `getEstimatesPendingApproval`
    // scoping semantics — no unscoped fetch-then-filter), then
    // recompute per-row totals (parts/labor + flat-mode labor)
    // exactly the way `getEstimates()` does so the aggregated
    // numbers match what the kanban / table / detail views show.
    const notDeleted = isNull(estimates.deletedAt);
    const whereClause =
      companyId === null
        ? notDeleted
        : and(notDeleted, eq(estimates.companyId, companyId));
    const estimatesList = await db
      .select()
      .from(estimates)
      .where(whereClause)
      .orderBy(desc(estimates.createdAt));

    const recomputed = await Promise.all(
      estimatesList.map(async (estimate) => {
        const items = await db
          .select()
          .from(estimateItems)
          .where(eq(estimateItems.estimateId, estimate.id));
        let partsSubtotal = 0;
        let perPartLaborHours = 0;
        for (const item of items) {
          partsSubtotal += parseFloat(String(item.totalPrice)) || 0;
          perPartLaborHours += parseFloat(String(item.laborHours)) || 0;
        }
        const laborRate =
          parseFloat(String(estimate.appliedLaborRate ?? estimate.laborRate)) || 0;
        const totalLaborHours =
          estimate.laborMode === "flat"
            ? parseFloat(String(estimate.totalLaborHours ?? 0)) || 0
            : perPartLaborHours;
        const laborSubtotal = totalLaborHours * laborRate;
        const totalAmount = partsSubtotal + laborSubtotal;
        return { ...estimate, totalAmount: totalAmount.toFixed(2) };
      }),
    );

    return computeEstimateSummary(recomputed, new Date());
  }

  async getEstimate(id: number, opts?: { includeDeleted?: boolean }): Promise<EstimateWithItems | undefined> {
    const [rawEstimate] = await db.select().from(estimates).where(eq(estimates.id, id));
    if (!rawEstimate) return undefined;
    // Task #634 — soft-deleted rows are hidden unless explicitly requested
    // (super_admin "Show deleted" toggle).
    if (rawEstimate.deletedAt && !opts?.includeDeleted) return undefined;

    // Task #634 (bug #1) — legacy "prospect" estimates were persisted with
    // a NULL `companyId` so the ownership guard at the call site returns
    // false and the user sees a 404 from the PDF endpoint. Backfill the
    // owning company from the linked customer (if any), otherwise from
    // the creating user, then persist the fix so the next request is a
    // straight equality check. This is a one-way stamp; we never clear
    // a non-null companyId.
    let estimate = rawEstimate;
    if (estimate.companyId == null) {
      let derived: number | null = null;
      if (estimate.customerId != null) {
        const [cust] = await db.select({ companyId: customers.companyId })
          .from(customers).where(eq(customers.id, estimate.customerId));
        if (cust?.companyId != null) derived = cust.companyId;
      }
      if (derived == null && estimate.createdByUserId != null) {
        const [u] = await db.select({ companyId: users.companyId })
          .from(users).where(eq(users.id, estimate.createdByUserId));
        if (u?.companyId != null) derived = u.companyId;
      }
      if (derived != null) {
        const [stamped] = await db.update(estimates)
          .set({ companyId: derived })
          .where(and(eq(estimates.id, id), isNull(estimates.companyId)))
          .returning();
        if (stamped) estimate = stamped;
      }
    }

    const items = await db.select().from(estimateItems).where(eq(estimateItems.estimateId, id)).orderBy(estimateItems.sortOrder);

    // Recalculate totals to ensure accuracy
    let partsSubtotal = 0;
    let perPartLaborHours = 0;

    items.forEach(item => {
      partsSubtotal += money(item.totalPrice);
      perPartLaborHours += money(item.laborHours);
    });

    // Prefer SNAPSHOT appliedLaborRate so a converted estimate cannot be
    // repriced after customer/estimate laborRate changes downstream.
    const laborRate = money(estimate.appliedLaborRate ?? estimate.laborRate);
    // Task #396 — honor flat mode using persisted totalLaborHours.
    const totalLaborHours = estimate.laborMode === 'flat'
      ? money(estimate.totalLaborHours ?? 0)
      : perPartLaborHours;
    const laborSubtotal = totalLaborHours * laborRate;
    const totalAmount = partsSubtotal + laborSubtotal;

    return {
      ...estimate,
      partsSubtotal: partsSubtotal.toFixed(2),
      laborSubtotal: laborSubtotal.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      lifecycleStatus: computeLifecycleStatus(estimate),
      items,
    };
  }

  // Task #669 — atomically allocate the next 5-digit estimate number
  // for a given company. Uses an UPDATE … RETURNING so concurrent
  // estimate inserts never collide. Must be called inside the same
  // executor (tx) that inserts the estimate row so the counter bump
  // rolls back with the estimate on error. If `companyId` is null
  // (legacy / test paths without a company context), falls back to
  // the timestamp-based scheme so we never block an insert.
  async allocateNextEstimateNumber(
    executor: DbExecutor,
    companyId: number | null | undefined,
  ): Promise<string> {
    if (companyId == null) {
      logger.warn(
        { companyId },
        "[allocateNextEstimateNumber] companyId is null — falling back to timestamp-based estimate number. A regression has occurred: all real create paths should supply a companyId.",
      );
      return `EST-${Date.now()}`;
    }
    type ExecResult =
      | { allocated: string }[]
      | { rows: { allocated: string }[] };
    const execute = (executor as { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }).execute;
    const result = (await execute.call(
      executor,
      sql`UPDATE companies
          SET next_estimate_number = next_estimate_number + 1,
              updated_at = NOW()
          WHERE id = ${companyId}
          RETURNING (next_estimate_number - 1)::text AS allocated`,
    )) as ExecResult;
    // pg / drizzle execute may return either an array or { rows: [...] }
    // depending on driver path; both shapes are normalized here.
    const rows: { allocated: string }[] = Array.isArray(result)
      ? result
      : (result.rows ?? []);
    const allocated = rows[0]?.allocated;
    if (!allocated) {
      throw new Error(
        `Failed to allocate estimate number for company ${companyId}`,
      );
    }
    return String(allocated);
  }

  // Single sanctioned write path for an estimate + its items. Both the
  // public createEstimate (with its own tx) and the wet-check conversion
  // engine (which runs inside its own tx) call this so they share insert
  // ordering, snapshot semantics, and any future side effects.
  async _writeEstimateWithItems(
    executor: DbExecutor,
    estimate: InsertEstimate & { companyId?: number | null },
    items: InsertEstimateItem[],
    explicitEstimateNumber?: string,
  ): Promise<EstimateWithItems> {
    // Task #669 — every new estimate gets a 5-digit per-company
    // number from the `companies.next_estimate_number` counter,
    // allocated atomically inside this transaction. An explicit
    // value (only ever passed by internal callers like the wet-check
    // conversion engine, where the number has already been allocated
    // from the same sequence) still wins. **A client-supplied value
    // on the payload is deliberately ignored on create** — the
    // sequence is the only sanctioned source for new estimate
    // numbers; renames go through the admin-gated PUT path.
    const clientSuppliedNumber = (estimate as { estimateNumber?: string }).estimateNumber;
    if (clientSuppliedNumber) {
      delete (estimate as { estimateNumber?: string }).estimateNumber;
    }
    const estimateNumber =
      explicitEstimateNumber
      ?? (await this.allocateNextEstimateNumber(
          executor,
          (estimate as { companyId?: number | null }).companyId ?? null,
        ));
    // Task #642 — dual-write the canonical lifecycle column alongside
    // the legacy (status, internalStatus) pair. Derived from whatever
    // the caller passed; defaults to `pending_review` if neither axis
    // is specified.
    const lifecycle = deriveLifecycleForWrite({
      status: (estimate as { status?: string | null }).status,
      internalStatus: (estimate as { internalStatus?: string | null }).internalStatus,
    });
    // companyId is guaranteed to be a non-null number here — the route
    // stamps it from req.authenticatedUserCompanyId before calling storage.
    const [newEstimate] = await executor
      .insert(estimates)
      .values([{ ...estimate, estimateNumber, lifecycle } as typeof estimates.$inferInsert])
      .returning();
    const createdItems: EstimateItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const [createdItem] = await executor.insert(estimateItems).values({
        ...item,
        estimateId: newEstimate.id,
        sortOrder: item.sortOrder ?? i,
      }).returning();
      createdItems.push(createdItem);
    }
    return { ...newEstimate, lifecycleStatus: computeLifecycleStatus(newEstimate), items: createdItems };
  }

  async createEstimate(estimate: InsertEstimate & { companyId?: number | null }, items: InsertEstimateItem[]): Promise<EstimateWithItems> {
    return await db.transaction(async (tx) => this._writeEstimateWithItems(tx, estimate, items));
  }

  // Canonical estimate-creation service. Identical to what POST
  // /api/estimates does (parse → processEstimatePayload → write items),
  // exposed as a single entry point so callers — the route handler AND
  // the wet-check conversion engine — go through the same code path.
  // When `executor` is provided, the writes happen inside the caller's
  // transaction (used by convertWetCheck to keep BS+est+WO atomic);
  // otherwise the helper opens its own tx via createEstimate.
  async createEstimateFromPayload(
    payload: EstimatePayloadInput,
    executor?: DbExecutor,
    explicitEstimateNumber?: string,
  ): Promise<EstimateWithItems> {
    const { estimate, items } = processEstimatePayload(payload);
    if (executor) {
      return this._writeEstimateWithItems(executor, estimate, items, explicitEstimateNumber);
    }
    if (explicitEstimateNumber) {
      return await db.transaction(async (tx) =>
        this._writeEstimateWithItems(tx, estimate, items, explicitEstimateNumber));
    }
    return this.createEstimate(estimate, items);
  }

  async updateEstimate(id: number, estimate: Partial<InsertEstimate>): Promise<Estimate | undefined> {
    // Task #642 — when the caller patches `status` or `internalStatus`,
    // mirror the change into the canonical `lifecycle` column so the
    // two stay in sync. We read the existing row to merge unspecified
    // axes (e.g. a status-only patch keeps the existing internalStatus
    // for derivation). The `status='expired'` write is special-cased:
    // we leave `lifecycle` alone so it stays at its pre-expiry value
    // (`sent`), which makes the read-time expiry view and the resend
    // flow work without a second write.
    const patch: Partial<InsertEstimate> = { ...estimate };
    const touchesAxis =
      Object.prototype.hasOwnProperty.call(patch, "status") ||
      Object.prototype.hasOwnProperty.call(patch, "internalStatus");
    if (touchesAxis && !Object.prototype.hasOwnProperty.call(patch, "lifecycle")) {
      const [existing] = await db.select().from(estimates).where(eq(estimates.id, id));
      if (existing) {
        const finalStatus = (patch.status ?? existing.status) as string | null | undefined;
        const finalInternal = (patch.internalStatus ?? existing.internalStatus) as string | null | undefined;
        if (finalStatus !== "expired") {
          (patch as { lifecycle?: string }).lifecycle = deriveLifecycleForWrite({
            status: finalStatus,
            internalStatus: finalInternal,
          });
        }
      }
    }
    const [updatedEstimate] = await db.update(estimates).set(patch).where(eq(estimates.id, id)).returning();
    if (!updatedEstimate) return undefined;
    return { ...updatedEstimate, lifecycleStatus: computeLifecycleStatus(updatedEstimate) } as Estimate;
  }

  // Task #611 — conditional reject. The WHERE clause pins
  // `status='pending'` so two concurrent reject (or approve+reject)
  // requests can't both succeed: the second writer's UPDATE matches
  // zero rows and returns undefined, which the route turns into a 400.
  async rejectEstimateIfPending(id: number): Promise<Estimate | undefined> {
    const [updated] = await db.update(estimates)
      // Task #642 — dual-write lifecycle alongside the legacy status.
      .set({ status: "rejected", rejectedAt: new Date(), lifecycle: "rejected" })
      .where(and(eq(estimates.id, id), eq(estimates.status, "pending")))
      .returning();
    if (!updated) return undefined;
    return { ...updated, lifecycleStatus: computeLifecycleStatus(updated) } as Estimate;
  }

  // Task #611 — conditional internal-approve. Same idea as
  // rejectEstimateIfPending but on the internal-review track.
  async internallyApproveEstimateIfPending(id: number): Promise<Estimate | undefined> {
    // Task #642 — internalStatus `approved_internal` still derives to
    // the `pending_review` lifecycle bucket (the customer-facing
    // `status` is still `pending`), so we explicitly stamp it. This
    // is a no-op for the column value but documents the dual-write
    // contract and keeps the column truthful even if a row's
    // lifecycle drifted (e.g. on a pre-backfill record).
    const [updated] = await db.update(estimates)
      .set({ internalStatus: "approved_internal", lifecycle: "pending_review" })
      .where(and(eq(estimates.id, id), eq(estimates.internalStatus, "pending_approval")))
      .returning();
    if (!updated) return undefined;
    return { ...updated, lifecycleStatus: computeLifecycleStatus(updated) } as Estimate;
  }

  // Task #611 — CAS-style "mark estimate sent to customer". A single
  // conditional UPDATE: only flips the row if it's still in one of
  // the two valid pre-send states (or, for the `resend` flow, if the
  // estimate's `status='expired'`). Two concurrent send requests
  // therefore can't both stamp tokens — the loser sees zero rows
  // updated and the caller surfaces a 409. Returns undefined on
  // conflict.
  async markEstimateSentToCustomer(
    id: number,
    args: {
      approvalToken: string;
      tokenExpiresAt: Date;
      approvalSentAt: Date;
      newEstimateDate: Date | null;
      isResend: boolean;
      // Task #365 — re-delivery of a non-expired sent estimate. The
      // estimate is already `sent_to_customer` / lifecycle=`sent` and
      // the customer hasn't responded yet. We re-stamp the token and
      // re-send the email without resetting estimateDate.
      isSentRedelivery?: boolean;
      // Task #1574 — actual delivery address; persisted so the
      // reject-via-token POST handler records truthful audit attribution.
      sentToEmail?: string;
    },
  ): Promise<Estimate | undefined> {
    const setClause: Partial<InsertEstimate> = {
      approvalToken: args.approvalToken,
      tokenExpiresAt: args.tokenExpiresAt,
      approvalSentAt: args.approvalSentAt,
      internalStatus: "sent_to_customer",
      ...(args.sentToEmail ? { sentToEmail: args.sentToEmail } : {}),
      // Task #642 — dual-write the lifecycle column. The resend flow
      // also flips lifecycle back from `expired` (read-time view of
      // `sent` + stale estimateDate) to `sent` since the new
      // estimateDate clears the expiry condition.
      lifecycle: "sent",
    };
    if (args.newEstimateDate) {
      (setClause as { estimateDate?: Date }).estimateDate = args.newEstimateDate;
    }
    // Three CAS branches:
    //   isResend         — expired estimate; gate on status='expired'
    //   isSentRedelivery — already sent but not expired; gate on
    //                      internalStatus='sent_to_customer' AND lifecycle='sent'
    //   normal first send — gate on pre-send internalStatus values
    const whereClause = args.isResend
      ? and(eq(estimates.id, id), eq(estimates.status, "expired"))
      : args.isSentRedelivery
        ? and(
            eq(estimates.id, id),
            eq(estimates.internalStatus, "sent_to_customer"),
            eq(estimates.lifecycle as any, "sent"),
          )
        : and(
          eq(estimates.id, id),
          or(
            eq(estimates.internalStatus, "pending_approval"),
            eq(estimates.internalStatus, "approved_internal"),
          ),
        );
    const [updated] = await db.update(estimates)
      .set(setClause)
      .where(whereClause)
      .returning();
    if (!updated) return undefined;
    return { ...updated, lifecycleStatus: computeLifecycleStatus(updated) } as Estimate;
  }

  async updateEstimateWithItems(id: number, estimate: InsertEstimate, items: InsertEstimateItem[]): Promise<EstimateWithItems> {
    return await db.transaction(async (tx) => {
      // Task #642 — dual-write the canonical lifecycle column. We
      // already have the full intended (status, internalStatus) here
      // (the route layer rebuilds the row), so no extra read needed.
      const merged: InsertEstimate = {
        ...estimate,
        lifecycle: deriveLifecycleForWrite({
          status: (estimate as { status?: string | null }).status,
          internalStatus: (estimate as { internalStatus?: string | null }).internalStatus,
        }),
      } as InsertEstimate;
      const [updatedEstimate] = await tx.update(estimates).set(merged).where(eq(estimates.id, id)).returning();
      if (!updatedEstimate) {
        throw new Error(`Estimate ${id} not found`);
      }
      await tx.delete(estimateItems).where(eq(estimateItems.estimateId, id));
      const createdItems: EstimateItem[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const [createdItem] = await tx.insert(estimateItems).values({
          ...item,
          estimateId: id,
          sortOrder: item.sortOrder ?? i,
        }).returning();
        createdItems.push(createdItem);
      }
      return { ...updatedEstimate, lifecycleStatus: computeLifecycleStatus(updatedEstimate), items: createdItems };
    });
  }

  async deleteEstimate(id: number): Promise<boolean> {
    const result = await db.delete(estimates).where(eq(estimates.id, id));
    return (result.rowCount || 0) > 0;
  }

  // Task #634 / #658 — manager-facing soft delete. Allows the three
  // pre-sent internal statuses (`draft`, `pending_approval`,
  // `approved_internal`); anything past that has customer-facing
  // artifacts and must stay auditable. The route layer is responsible
  // for the role / ownership checks. The WHERE clause also pins
  // `deletedAt IS NULL` so a concurrent send-to-customer can't lose
  // the race AND a double click can't double-stamp the deletedAt.
  async softDeleteEstimate(id: number, deletedByUserId: number): Promise<boolean> {
    const result = await db.update(estimates)
      .set({ deletedAt: new Date(), deletedBy: deletedByUserId })
      .where(and(
        eq(estimates.id, id),
        inArray(estimates.internalStatus, [
          "draft",
          "pending_approval",
          "approved_internal",
        ]),
        isNull(estimates.deletedAt),
      ));
    return (result.rowCount || 0) > 0;
  }

  async getEstimateItems(estimateId: number): Promise<EstimateItem[]> {
    return await db.select().from(estimateItems).where(eq(estimateItems.estimateId, estimateId)).orderBy(estimateItems.sortOrder);
  }

  // Property Zones / Field Work Sessions implementations removed by Task #1857 (Slice 5).
  // Tables dropped: property_zones, zones, field_work_sessions, field_work_items.

  // Dashboard Stats
  async getDashboardStats(): Promise<{
    pendingEstimates: number;
    approvedThisMonth: number;
    totalRevenue: number;
    partsCount: number;
    recentEstimates: Estimate[];
    topParts: (Part & { usageCount: number })[];
    workOrderStats: {
      pending: number;
      inProgress: number;
      completed: number;
      assigned: number;
      pendingManagerReview: number;
      total: number;
    };
    billingSheetStats: {
      pendingManagerReview: number;
    };
    wetCheckBillingStats: {
      pendingManagerReview: number;
    };
    recentWorkOrders: WorkOrder[];
  }> {
    // Task #634 — dashboards never surface soft-deleted estimates.
    const allEstimates = await db
      .select()
      .from(estimates)
      .where(isNull(estimates.deletedAt));
    const allParts = await db.select().from(parts);
    const allEstimateItems = await db.select().from(estimateItems);
    const allWorkOrders = await db.select().from(workOrders);
    const allBillingSheets = await db.select().from(billingSheets);

    const pendingEstimates = allEstimates.filter(e => e.status === "pending").length;
    
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const approvedThisMonth = allEstimates.filter(e => 
      e.status === "approved" && 
      e.createdAt.getMonth() === currentMonth && 
      e.createdAt.getFullYear() === currentYear
    ).length;

    const totalRevenue = allEstimates
      .filter(e => e.status === "approved")
      .reduce((sum, e) => sum + parseFloat(e.totalAmount), 0);

    const partsCount = allParts.length;

    const recentEstimates = allEstimates
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5);

    const recentWorkOrders = allWorkOrders
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      .slice(0, 5);

    // Work order stats
    const workOrderStats = {
      pending: allWorkOrders.filter(wo => wo.status === "pending").length,
      inProgress: allWorkOrders.filter(wo => wo.status === "in_progress").length,
      completed: allWorkOrders.filter(wo => wo.status === "work_completed").length,
      assigned: allWorkOrders.filter(wo => wo.status === "assigned").length,
      pendingManagerReview: allWorkOrders.filter(wo => wo.status === "pending_manager_review" || wo.status === "work_completed").length,
      total: allWorkOrders.length
    };

    // Billing sheet stats
    const billingSheetStats = {
      pendingManagerReview: allBillingSheets.filter(bs =>
        bs.status === "pending_manager_review" || bs.status === "submitted" || bs.status === "completed"
      ).length,
    };

    // Wet check billing stats
    const allWetCheckBillingsForStats = await db.select().from(wetCheckBillings);
    const wetCheckBillingStats = {
      pendingManagerReview: allWetCheckBillingsForStats.filter(wcb =>
        wcb.status === "submitted" || wcb.status === "pending_manager_review"
      ).length,
    };

    // Calculate top parts usage (skip items with no catalog part — inspection
    // findings without a part assignment have partId = null).
    const partUsage = new Map<number, number>();
    allEstimateItems.forEach(item => {
      if (item.partId == null) return;
      const current = partUsage.get(item.partId) || 0;
      partUsage.set(item.partId, current + item.quantity);
    });

    const topParts = allParts
      .map(part => ({
        ...part,
        usageCount: partUsage.get(part.id) || 0
      }))
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 5);

    return {
      pendingEstimates,
      approvedThisMonth,
      totalRevenue,
      partsCount,
      recentEstimates,
      topParts,
      workOrderStats,
      billingSheetStats,
      wetCheckBillingStats,
      recentWorkOrders
    };
  }

  // Customer Integration Methods
  async syncCustomersFromGoogleSheets(sheetsUrl: string): Promise<{ customersAdded: number }> {
    // Mock implementation - in real app, would use Google Sheets API
    console.log(`Syncing customers from Google Sheets: ${sheetsUrl}`);
    
    // Simulate adding customers from Google Sheets
    const mockCustomers = [
      { name: "John Smith", email: "john@example.com", phone: "555-0101", address: "123 Main St, Anytown, USA" },
      { name: "Jane Doe", email: "jane@example.com", phone: "555-0102", address: "456 Oak Ave, Somewhere, USA" }
    ];

    let customersAdded = 0;
    for (const customerData of mockCustomers) {
      try {
        const existing = await db.select().from(customers).where(eq(customers.email, customerData.email));
        if (existing.length === 0) {
          await db.insert(customers).values({ ...customerData, companyId: 1 });
          customersAdded++;
        }
      } catch (error) {
        console.error(`Failed to add customer ${customerData.name}:`, error);
      }
    }

    return { customersAdded };
  }

  async getGoogleSheetsCustomerStatus(): Promise<{ isConnected: boolean; lastSync?: string; sheetUrl?: string; customerCount?: number }> {
    // Mock implementation - in real app, would store connection status in database
    const allCustomers = await db.select().from(customers);
    return {
      isConnected: false, // Mock: not connected by default
      lastSync: undefined,
      sheetUrl: undefined,
      customerCount: allCustomers.length
    };
  }

  async saveQuickBooksIntegration(data: {
    companyId: string;
    accessToken: string;
    refreshToken: string;
    realmId: string;
    expiresAt: Date;
    lastRefreshAttempt?: Date | null;
    lastRefreshSuccess?: Date | null;
    lastRefreshFailure?: Date | null;
    connectionStatus?: string;
    reconnectRequiredReason?: string | null;
    tokenEnvironment?: string;
  }): Promise<void> {
    try {
      const tokenEnvironment = data.tokenEnvironment ?? (process.env.NODE_ENV === 'production' ? 'production' : 'sandbox');
      await db.insert(quickbooksIntegration).values({
        companyId: data.companyId,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        realmId: data.realmId,
        expiresAt: data.expiresAt,
        lastRefreshAttempt: data.lastRefreshAttempt ?? null,
        lastRefreshSuccess: data.lastRefreshSuccess ?? null,
        lastRefreshFailure: data.lastRefreshFailure ?? null,
        connectionStatus: data.connectionStatus ?? 'connected',
        reconnectRequiredReason: data.reconnectRequiredReason ?? null,
        tokenEnvironment,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: quickbooksIntegration.realmId,
        set: {
          companyId: data.companyId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: data.expiresAt,
          lastRefreshAttempt: data.lastRefreshAttempt ?? null,
          lastRefreshSuccess: data.lastRefreshSuccess ?? null,
          lastRefreshFailure: data.lastRefreshFailure ?? null,
          connectionStatus: data.connectionStatus ?? 'connected',
          reconnectRequiredReason: data.reconnectRequiredReason ?? null,
          tokenEnvironment,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('Error saving QuickBooks integration:', error);
      throw error;
    }
  }

  // Task #744 — QB Harden #2: durable OAuth state (behind USE_DB_OAUTH_STATE flag)
  async saveOauthState(state: string, provider: string, companyId: string | null, expiresAt: Date): Promise<void> {
    await db.insert(oauthState).values({ state, provider, companyId, expiresAt });
  }

  async consumeOauthState(state: string): Promise<{ provider: string; companyId: string | null } | undefined> {
    const rows = await db.delete(oauthState)
      .where(and(eq(oauthState.state, state), gt(oauthState.expiresAt, new Date())))
      .returning({ provider: oauthState.provider, companyId: oauthState.companyId });
    return rows[0];
  }

  async pruneExpiredOauthStates(): Promise<void> {
    await db.delete(oauthState).where(lte(oauthState.expiresAt, new Date()));
  }

  async getQuickBooksIntegration(realmId: string): Promise<(typeof quickbooksIntegration.$inferSelect) | null> {
    try {
      const result = await db.select().from(quickbooksIntegration)
        .where(eq(quickbooksIntegration.realmId, realmId))
        .limit(1);
      return result.length > 0 ? result[0] : null;
    } catch (error) {
      console.error('Error getting QuickBooks integration:', error);
      return null;
    }
  }

  async getQuickBooksIntegrationByCompanyId(companyId: string): Promise<(typeof quickbooksIntegration.$inferSelect) | null> {
    try {
      const result = await db.select().from(quickbooksIntegration)
        .where(eq(quickbooksIntegration.companyId, companyId))
        .limit(1);
      return result.length > 0 ? result[0] : null;
    } catch (error) {
      console.error('Error getting QuickBooks integration by companyId:', error);
      return null;
    }
  }

  async markQuickBooksReconnectRequired(realmId: string, reason: string): Promise<void> {
    // Task #743 — email admins on reconnect_required, 24h throttle,
    // feature-flagged by DISABLE_QB_RECONNECT_EMAILS.
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const emailsEnabled = !process.env.DISABLE_QB_RECONNECT_EMAILS;

    // Single transaction: update connection status AND atomically claim the
    // 24h email send slot. Using a conditional UPDATE (WHERE on
    // lastReconnectEmailAt) means only one concurrent caller can stamp the
    // timestamp; callers that lose the race get 0 RETURNING rows and skip
    // the send. This eliminates the TOCTOU window of a separate read → write.
    let emailCompanyId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        // Always update the connection status regardless of email eligibility.
        await tx.update(quickbooksIntegration)
          .set({
            connectionStatus: 'reconnect_required',
            reconnectRequiredReason: reason,
            lastRefreshFailure: now,
            updatedAt: now,
          })
          .where(eq(quickbooksIntegration.realmId, realmId));

        if (emailsEnabled) {
          // Atomically stamp lastReconnectEmailAt only when 24h has elapsed.
          // RETURNING companyId lets us know (a) we won the race, and
          // (b) which company to look up recipients for — without a
          // separate SELECT round-trip.
          const stamped = await tx.update(quickbooksIntegration)
            .set({ lastReconnectEmailAt: now })
            .where(
              and(
                eq(quickbooksIntegration.realmId, realmId),
                or(
                  isNull(quickbooksIntegration.lastReconnectEmailAt),
                  lte(quickbooksIntegration.lastReconnectEmailAt, twentyFourHoursAgo),
                ),
              ),
            )
            .returning({ companyId: quickbooksIntegration.companyId });
          if (stamped.length > 0) {
            emailCompanyId = stamped[0].companyId;
          }
        }
      });
    } catch (error) {
      console.error('Error marking QuickBooks reconnect required:', error);
      throw error;
    }

    // Send emails AFTER the transaction commits. Failures here must not
    // roll back the status update, so the entire block is try/catch isolated.
    if (emailCompanyId !== null) {
      try {
        const companyIdInt = parseInt(emailCompanyId, 10);
        if (isNaN(companyIdInt)) return;

        const [companyResult, adminUsers] = await Promise.all([
          db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyIdInt)).limit(1),
          db.select({ email: users.email }).from(users).where(
            and(
              eq(users.companyId, companyIdInt),
              eq(users.isActive, true),
              or(
                eq(users.role, 'company_admin'),
                eq(users.role, 'billing_manager'),
              ),
            ),
          ),
        ]);

        const companyName = companyResult[0]?.name ?? `Company ${emailCompanyId}`;
        const { EmailService } = await import('./email-service.js');
        const { getIntegrationMeta } = await import('./lib/integration-catalog.js');
        const qbMeta = getIntegrationMeta('qb');
        const dashboardUrl = `${process.env.APP_BASE_URL ?? 'https://irrigopro.com'}/quickbooks`;

        for (const user of adminUsers) {
          if (!user.email) continue;
          try {
            await EmailService.sendQuickBooksReconnectRequiredEmail({
              to: user.email,
              companyName,
              reason,
              dashboardUrl,
              runbookUrl: qbMeta.runbookUrl,
            });
          } catch {
            // Per-recipient failure — log suppressed, continue with next recipient
          }
        }
      } catch {
        // Outer catch — email pipeline error must never surface to the caller
      }
    }
  }

  async getQuickBooksAllIntegrations(): Promise<(typeof quickbooksIntegration.$inferSelect)[]> {
    try {
      return await db.select().from(quickbooksIntegration).orderBy(quickbooksIntegration.realmId);
    } catch (error) {
      console.error('Error getting all QuickBooks integrations:', error);
      return [];
    }
  }

  async getAllActiveQuickBooksIntegrations(): Promise<(typeof quickbooksIntegration.$inferSelect)[]> {
    try {
      return await db.select().from(quickbooksIntegration)
        .where(eq(quickbooksIntegration.connectionStatus, 'connected'));
    } catch (error) {
      console.error('Error fetching all active QuickBooks integrations:', error);
      return [];
    }
  }

  async getQuickBooksCustomerStatus(companyId?: string | null): Promise<{ isConnected: boolean; companyName?: string; lastSync?: string; customerCount?: number; connectionStatus?: string; reconnectRequiredReason?: string | null; companyId?: string | null; realmId?: string | null }> {
    // Check if QuickBooks integration exists for this company
    let integration: (typeof quickbooksIntegration.$inferSelect)[];
    if (companyId) {
      integration = await db.select().from(quickbooksIntegration).where(eq(quickbooksIntegration.companyId, companyId)).limit(1);
    } else {
      integration = [];
    }
    
    const allCustomers = await db.select().from(customers);
    
    if (integration.length === 0) {
      return {
        isConnected: false,
        companyName: undefined,
        lastSync: undefined,
        customerCount: allCustomers.length,
        connectionStatus: 'disconnected',
        reconnectRequiredReason: null,
        companyId: null,
        realmId: null
      };
    }
    
    const qbIntegration = integration[0];
    const isTokenValid = qbIntegration.expiresAt > new Date();
    const isReconnectRequired = qbIntegration.connectionStatus === 'reconnect_required';
    
    return {
      isConnected: isTokenValid && !isReconnectRequired,
      companyName: qbIntegration.companyId,
      lastSync: qbIntegration.updatedAt?.toISOString() || new Date().toISOString(),
      customerCount: allCustomers.length,
      connectionStatus: qbIntegration.connectionStatus,
      reconnectRequiredReason: qbIntegration.reconnectRequiredReason,
      companyId: qbIntegration.companyId,
      realmId: qbIntegration.realmId
    };
  }

  async disconnectQuickBooks(companyId: string): Promise<void> {
    await db.delete(quickbooksIntegration).where(eq(quickbooksIntegration.companyId, companyId));
  }

  async connectGoogleSheetsCustomers(sheetUrl: string): Promise<void> {
    // Mock implementation - in real app, would validate and store connection
    console.log(`Connecting to Google Sheets: ${sheetUrl}`);
    // Would store connection info in database
  }

  async disconnectGoogleSheetsCustomers(): Promise<void> {
    // Mock implementation - in real app, would remove connection info
    console.log("Disconnecting Google Sheets");
  }

  // Work Orders - Enhanced
  // Returns a direct column-equality fragment that scopes rows to a company.
  // Replaced the previous customer-subquery approach (Slice 4) with a direct
  // eq() on the dedicated companyId column for a single-index seek.
  // When companyId is null (super_admin), returns undefined (no extra filter).
  private _companyScope(companyId: number | null) {
    if (companyId === null) return undefined;
    return eq(workOrders.companyId, companyId);
  }

  private _companyScopeForBS(companyId: number | null) {
    if (companyId === null) return undefined;
    return eq(billingSheets.companyId, companyId);
  }

  private _companyScopeForInvoice(companyId: number | null) {
    if (companyId === null) return undefined;
    return eq(invoices.companyId, companyId);
  }

  async getWorkOrders(companyId: number | null): Promise<WorkOrder[]> {
    try {
      const scope = this._companyScope(companyId);
      return await db.select().from(workOrders)
        .where(scope ?? undefined)
        .orderBy(desc(workOrders.createdAt));
    } catch (error) {
      console.error("Error fetching work orders:", error);
      return [];
    }
  }

  async getWorkOrdersByTechnician(technicianId: number, companyId: number | null): Promise<WorkOrder[]> {
    try {
      const scope = this._companyScope(companyId);
      const cond = scope ? and(eq(workOrders.assignedTechnicianId, technicianId), scope) : eq(workOrders.assignedTechnicianId, technicianId);
      return await db.select().from(workOrders)
        .where(cond)
        .orderBy(desc(workOrders.createdAt));
    } catch (error) {
      console.error("Error fetching work orders by technician:", error);
      return [];
    }
  }

  async getWorkOrdersByCustomer(customerId: number, companyId: number | null): Promise<WorkOrder[]> {
    try {
      const scope = this._companyScope(companyId);
      const cond = scope ? and(eq(workOrders.customerId, customerId), scope) : eq(workOrders.customerId, customerId);
      return await db.select().from(workOrders)
        .where(cond)
        .orderBy(desc(workOrders.createdAt));
    } catch (error) {
      console.error("Error fetching work orders by customer:", error);
      return [];
    }
  }

  async getWorkOrdersByStatus(status: string, companyId: number | null): Promise<WorkOrder[]> {
    try {
      const scope = this._companyScope(companyId);
      const cond = scope ? and(eq(workOrders.status, status), scope) : eq(workOrders.status, status);
      return await db.select().from(workOrders)
        .where(cond)
        .orderBy(desc(workOrders.createdAt));
    } catch (error) {
      console.error("Error fetching work orders by status:", error);
      return [];
    }
  }

  async getWorkOrdersByEstimate(estimateId: number, companyId: number | null): Promise<WorkOrder[]> {
    try {
      const scope = this._companyScope(companyId);
      const cond = scope ? and(eq(workOrders.estimateId, estimateId), scope) : eq(workOrders.estimateId, estimateId);
      return await db.select().from(workOrders)
        .where(cond)
        .orderBy(desc(workOrders.createdAt));
    } catch (error) {
      console.error("Error fetching work orders by estimate:", error);
      return [];
    }
  }

  async getWorkOrder(id: number, companyId: number | null): Promise<WorkOrder | undefined> {
    const scope = this._companyScope(companyId);
    const cond = scope ? and(eq(workOrders.id, id), scope) : eq(workOrders.id, id);
    const [workOrder] = await db.select().from(workOrders).where(cond);
    return workOrder || undefined;
  }

  // Shared writer for createWorkOrder and convertWetCheck's deferred path.
  // Accepts an executor so callers can run inside a tx.
  async _writeWorkOrderWithItems(
    executor: DbExecutor,
    workOrder: typeof workOrders.$inferInsert,
    items: Array<{
      partId?: number | null;
      partName: string;
      partPrice: string;
      quantity: number;
      laborHours: string;
      totalPrice: string;
    }>,
  ): Promise<WorkOrder> {
    const [newWorkOrder] = await executor.insert(workOrders).values([workOrder]).returning();
    for (const item of items) {
      await executor.insert(workOrderItems).values([{
        workOrderId: newWorkOrder.id,
        partId: item.partId ?? null,
        partName: item.partName,
        partPrice: item.partPrice,
        quantity: item.quantity,
        laborHours: item.laborHours,
        totalPrice: money(item.totalPrice).toFixed(2),
      }]);
    }
    return newWorkOrder;
  }

  async createWorkOrder(workOrder: InsertWorkOrder & { companyId: number }, estimateItemsList?: EstimateItem[]): Promise<WorkOrder> {
    const workOrderNumber = `WO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    return this._writeWorkOrderWithItems(
      db,
      { ...workOrder, workOrderNumber } as typeof workOrders.$inferInsert,
      (estimateItemsList ?? []).map(item => ({
        partId: item.partId,
        partName: item.partName,
        partPrice: item.partPrice,
        quantity: item.quantity,
        laborHours: item.laborHours,
        totalPrice: money(item.totalPrice).toFixed(2),
      })),
    );
  }

  async createWorkOrderFromEstimate(estimateId: number, companyId?: number | null): Promise<WorkOrder> {
    // Seam 3 — Entire conversion is wrapped in a single transaction with a
    // SELECT ... FOR UPDATE row lock on the estimate so two concurrent calls
    // serialize here rather than racing past the idempotency check and both
    // inserting a work order. If the unique partial index fires anyway (e.g.
    // two callers lock on different DB replicas), we catch the 23505 code,
    // read back the winner's WO, and return it idempotently.
    try {
      return await db.transaction(async (tx) => {
        // ── Row-lock the estimate ─────────────────────────────────────────
        const scope = companyId != null
          ? and(eq(estimates.id, estimateId), eq(estimates.companyId, companyId))
          : eq(estimates.id, estimateId);
        const [estimate] = await tx.select().from(estimates).where(scope).for("update");
        if (!estimate) {
          throw new Error(`Estimate ${estimateId} not found`);
        }

        // ── Idempotency re-check inside the transaction ───────────────────
        // A second caller that wins the row lock after the first commits will
        // see the WO already in place and return it immediately.
        const [priorWo] = await tx.select().from(workOrders)
          .where(eq(workOrders.estimateId, estimateId))
          .limit(1);
        if (priorWo) {
          // Emit the same audit event as the 23505 catch path so both
          // idempotency paths (lock re-check and unique-index collision)
          // are observable in the audit log. Fire-and-forget — the WO
          // was already committed by the first caller so this TX can
          // commit cleanly even if the audit write races.
          recordAuditEvent(null, {
            action: 'work_order.duplicate_create_blocked',
            severity: 'warning',
            targetType: 'estimate',
            targetId: String(estimateId),
            summary: `Duplicate WO create blocked for estimate ${estimateId} — lock re-check found prior WO ${(priorWo as unknown as { id: number }).id}`,
            details: { estimateId, companyId: companyId ?? null, priorWorkOrderId: (priorWo as unknown as { id: number }).id },
          }).catch(() => {});
          return priorWo as unknown as WorkOrder;
        }

        if (estimate.status !== 'approved') {
          throw new Error(`Estimate ${estimateId} must be approved before creating work order`);
        }

        // ── Load items inside the transaction ─────────────────────────────
        const items = await tx.select().from(estimateItems)
          .where(eq(estimateItems.estimateId, estimateId))
          .orderBy(estimateItems.sortOrder);

        const workOrderNumber = `WO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const workOrderData: InsertWorkOrder & { workOrderNumber: string; companyId: number } = {
          workOrderNumber,
          estimateId: estimateId,
          customerId: estimate.customerId!,
          companyId: estimate.companyId!,
          customerName: estimate.customerName,
          customerEmail: estimate.customerEmail,
          customerPhone: estimate.customerPhone,
          projectName: estimate.projectName,
          projectAddress: estimate.projectAddress,
          locationNotes: estimate.locationNotes,
          accessInstructions: estimate.accessInstructions,
          // Task #445 — carry the estimate's free-form work description into
          // the work order's scope field so the field tech sees the same
          // scope context the estimator wrote, without manual re-entry.
          // No-op when the source estimate has no work description.
          ...(estimate.workDescription
            ? { description: estimate.workDescription }
            : {}),
          // Carry the pinned map location and irrigation context forward so
          // the field tech sees the same pin / controller / zone the estimate
          // was scoped to.
          workLocationLat: estimate.workLocationLat,
          workLocationLng: estimate.workLocationLng,
          workLocationAddress: estimate.workLocationAddress,
          controllerLetter: estimate.controllerLetter,
          zoneNumber: estimate.zoneNumber,
          workType: 'estimate_based',
          status: 'pending',
          priority: 'medium',
          // Pricing snapshot from estimate — guard against NaN stored in the
          // estimate's decimal columns (a null partPrice on any line item can
          // poison the sum). Recompute from items so the snapshot is always
          // a finite number.
          laborRate: estimate.laborRate,
          laborSubtotal: (() => {
            const laborRate2 = money((estimate as unknown as { appliedLaborRate?: string }).appliedLaborRate ?? estimate.laborRate);
            const totalLaborHours2 =
              (estimate as unknown as { laborMode?: string }).laborMode === 'flat'
                ? money((estimate as unknown as { totalLaborHours?: string }).totalLaborHours ?? 0)
                : items.reduce((s, i) => s + money(i.laborHours), 0);
            return (totalLaborHours2 * laborRate2).toFixed(2);
          })(),
          partsSubtotal: items.reduce((s, i) => s + money(i.totalPrice), 0).toFixed(2),
          estimatedTotal: (() => {
            const laborRate2 = money((estimate as unknown as { appliedLaborRate?: string }).appliedLaborRate ?? estimate.laborRate);
            const totalLaborHours2 =
              (estimate as unknown as { laborMode?: string }).laborMode === 'flat'
                ? money((estimate as unknown as { totalLaborHours?: string }).totalLaborHours ?? 0)
                : items.reduce((s, i) => s + money(i.laborHours), 0);
            const parts2 = items.reduce((s, i) => s + money(i.totalPrice), 0);
            return (parts2 + totalLaborHours2 * laborRate2).toFixed(2);
          })(),
          totalAmount: (() => {
            const laborRate2 = money((estimate as unknown as { appliedLaborRate?: string }).appliedLaborRate ?? estimate.laborRate);
            const totalLaborHours2 =
              (estimate as unknown as { laborMode?: string }).laborMode === 'flat'
                ? money((estimate as unknown as { totalLaborHours?: string }).totalLaborHours ?? 0)
                : items.reduce((s, i) => s + money(i.laborHours), 0);
            const parts2 = items.reduce((s, i) => s + money(i.totalPrice), 0);
            return (parts2 + totalLaborHours2 * laborRate2).toFixed(2);
          })(),
          totalItems: items.length,
          // Task #396 — preserve labor mode + aggregate hours across the
          // estimate→work-order conversion so the field tech sees the same
          // labor breakdown the customer approved.
          laborMode: (estimate as unknown as { laborMode?: string }).laborMode ?? 'flat',
          totalHours: (estimate as unknown as { totalLaborHours?: string }).totalLaborHours ?? null,
          // Slice 3 — carry lineage tag from the source estimate so the WO
          // detail view can surface a "From Wet Check #X" banner.
          originWetCheckId: (estimate as unknown as { originWetCheckId?: number | null }).originWetCheckId ?? null,
          // Task #315 — carry branchName from the estimate (which got it from
          // the originating wet check) so the work order lands on the right branch.
          branchName: (estimate as unknown as { branchName?: string | null }).branchName ?? null,
        };

        const [newWorkOrder] = await tx.insert(workOrders)
          .values(toDrizzleInsert<DrizzleWorkOrderInsert>(workOrderData))
          .returning();

        for (const item of items) {
          await tx.insert(workOrderItems).values({
            workOrderId: newWorkOrder.id,
            partId: item.partId,
            partName: item.partName,
            partPrice: item.partPrice,
            quantity: item.quantity,
            laborHours: item.laborHours,
            totalPrice: money(item.totalPrice).toFixed(2),
            // Task #1437 — carry zone detail forward so the field tech's
            // checklist can group items by controller/zone and show the
            // originating issue. Null on non-inspection estimates.
            controllerLetter: (item as { controllerLetter?: string | null }).controllerLetter ?? null,
            zoneNumber: (item as { zoneNumber?: number | null }).zoneNumber ?? null,
            issueType: (item as { issueType?: string | null }).issueType ?? null,
          });
        }

        // Update estimate with work order reference and stamp the converted status
        // so isConvertedToWorkOrder() returns true and the button hides.
        await tx.update(estimates)
          .set({
            status: 'converted_to_work_order',
            workOrderId: newWorkOrder.id,
            // Task #642 — dual-write the canonical lifecycle column.
            // converted_to_work_order maps to the 'approved' bucket.
            lifecycle: 'approved',
          })
          .where(eq(estimates.id, estimateId));

        return newWorkOrder as unknown as WorkOrder;
      });
    } catch (err: unknown) {
      // ── Unique-index collision (23505) ────────────────────────────────────
      // If two callers race past the row-lock (e.g. the first TX committed
      // between the lock acquisition and the insert), the unique partial index
      // on work_orders(estimate_id) fires. We catch it here, read back the
      // winner's WO, emit an audit event, and return it idempotently so the
      // caller gets a valid work order regardless of whether it won the race.
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '23505') {
        recordAuditEvent(null, {
          action: 'work_order.duplicate_create_blocked',
          severity: 'warning',
          targetType: 'estimate',
          targetId: String(estimateId),
          summary: `Duplicate WO create blocked for estimate ${estimateId} — unique index enforced`,
          details: { estimateId, companyId: companyId ?? null },
        }).catch(() => {});
        const [existing] = await db.select().from(workOrders)
          .where(eq(workOrders.estimateId, estimateId))
          .limit(1);
        if (existing) return existing as unknown as WorkOrder;
      }
      throw err;
    }
  }

  // Task #611 — atomic estimate-approval lifecycle. Wraps the four
  // sequential writes the route used to do (set status=approved → insert
  // work order → insert work-order items → update estimate.workOrderId
  // → assign work order to the irrigation manager → write the
  // assignment notification) in a single `db.transaction` so a failure
  // anywhere along the chain rolls the whole thing back. Previously the
  // PATCH /api/estimates/:id/approve route ran these as separate
  // top-level `db.` calls and explicitly tolerated a partial
  // application (the estimate could go approved with no work order if
  // `createWorkOrderFromEstimate` threw). That left a half-applied
  // state behind the single "Approve" button — exactly the pattern
  // Task #611 sweeps out.
  async approveEstimateAndCreateWorkOrder(estimateId: number): Promise<{
    estimate: Estimate;
    workOrder: WorkOrder | null;
    assignedTechnician: User | null;
  }> {
    return await db.transaction(async (tx) => {
      // Re-read the estimate inside the transaction *with a row lock*
      // (`SELECT ... FOR UPDATE`) so two concurrent approve requests
      // serialize on this row instead of both passing the
      // `status === 'pending'` precheck and racing into two work-order
      // inserts. The second waiter sees `status === 'approved'` once
      // the first commits and is rejected by the precondition below.
      const [existing] = await tx.select().from(estimates)
        .where(eq(estimates.id, estimateId))
        .for("update");
      if (!existing) {
        throw new Error(`Estimate ${estimateId} not found`);
      }
      if (existing.status !== "pending") {
        throw new Error("Only pending estimates can be approved");
      }

      // Reject if a work order already exists — mirrors the guard in
      // `createWorkOrderFromEstimate` but checked atomically here.
      const priorWorkOrders = await tx.select({ id: workOrders.id })
        .from(workOrders)
        .where(eq(workOrders.estimateId, estimateId));
      if (priorWorkOrders.length > 0) {
        throw new Error(`Work order already exists for estimate ${estimateId}`);
      }

      // 1. Flip the estimate to approved. The `status='pending'` guard
      // in the WHERE clause is belt-and-braces: combined with the row
      // lock above it makes the transition idempotent under
      // concurrency — the second writer's UPDATE matches zero rows
      // and we abort.
      const [approvedEstimate] = await tx.update(estimates)
        .set({
          status: "approved",
          approvalSource: "manual",
          approvedAt: new Date(),
          // Task #642 — dual-write the canonical lifecycle column.
          lifecycle: "approved",
        })
        .where(and(eq(estimates.id, estimateId), eq(estimates.status, "pending")))
        .returning();
      if (!approvedEstimate) {
        throw new Error("Only pending estimates can be approved");
      }

      // Load full estimate (with items) for the work-order snapshot.
      const items = await tx.select().from(estimateItems)
        .where(eq(estimateItems.estimateId, estimateId))
        .orderBy(estimateItems.sortOrder);

      // 2. Insert the work order, snapshotting the estimate's pricing
      // and location context exactly like createWorkOrderFromEstimate
      // does (the two paths must stay equivalent).
      const workOrderNumber = `WO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const workOrderData: InsertWorkOrder & { workOrderNumber: string; companyId: number } = {
        workOrderNumber,
        estimateId,
        customerId: approvedEstimate.customerId!,
        companyId: approvedEstimate.companyId!,
        customerName: approvedEstimate.customerName,
        customerEmail: approvedEstimate.customerEmail,
        customerPhone: approvedEstimate.customerPhone,
        projectName: approvedEstimate.projectName,
        projectAddress: approvedEstimate.projectAddress,
        locationNotes: approvedEstimate.locationNotes,
        accessInstructions: approvedEstimate.accessInstructions,
        ...(approvedEstimate.workDescription
          ? { description: approvedEstimate.workDescription }
          : {}),
        workLocationLat: approvedEstimate.workLocationLat,
        workLocationLng: approvedEstimate.workLocationLng,
        workLocationAddress: approvedEstimate.workLocationAddress,
        controllerLetter: approvedEstimate.controllerLetter,
        zoneNumber: approvedEstimate.zoneNumber,
        workType: "estimate_based",
        status: "pending",
        priority: "medium",
        laborRate: approvedEstimate.laborRate,
        // Guard against NaN stored in the estimate's decimal columns.
        // Recompute from items (already loaded at this point) so the
        // snapshotted work-order totals are always finite numbers.
        laborSubtotal: (() => {
          const laborRate2 = money(approvedEstimate.appliedLaborRate ?? approvedEstimate.laborRate);
          const totalLaborHours2 =
            (approvedEstimate as unknown as { laborMode?: string }).laborMode === 'flat'
              ? money((approvedEstimate as unknown as { totalLaborHours?: string }).totalLaborHours ?? 0)
              : items.reduce((s, i) => s + money(i.laborHours), 0);
          return (totalLaborHours2 * laborRate2).toFixed(2);
        })(),
        partsSubtotal: items.reduce((s, i) => s + money(i.totalPrice), 0).toFixed(2),
        estimatedTotal: (() => {
          const laborRate2 = money(approvedEstimate.appliedLaborRate ?? approvedEstimate.laborRate);
          const totalLaborHours2 =
            (approvedEstimate as unknown as { laborMode?: string }).laborMode === 'flat'
              ? money((approvedEstimate as unknown as { totalLaborHours?: string }).totalLaborHours ?? 0)
              : items.reduce((s, i) => s + money(i.laborHours), 0);
          const parts2 = items.reduce((s, i) => s + money(i.totalPrice), 0);
          return (parts2 + totalLaborHours2 * laborRate2).toFixed(2);
        })(),
        totalAmount: (() => {
          const laborRate2 = money(approvedEstimate.appliedLaborRate ?? approvedEstimate.laborRate);
          const totalLaborHours2 =
            (approvedEstimate as unknown as { laborMode?: string }).laborMode === 'flat'
              ? money((approvedEstimate as unknown as { totalLaborHours?: string }).totalLaborHours ?? 0)
              : items.reduce((s, i) => s + money(i.laborHours), 0);
          const parts2 = items.reduce((s, i) => s + money(i.totalPrice), 0);
          return (parts2 + totalLaborHours2 * laborRate2).toFixed(2);
        })(),
        totalItems: items.length,
        laborMode: (approvedEstimate as unknown as { laborMode?: string }).laborMode ?? "flat",
        totalHours: (approvedEstimate as unknown as { totalLaborHours?: string }).totalLaborHours ?? null,
        // Slice 3 — carry lineage tag from the source estimate.
        originWetCheckId: (approvedEstimate as unknown as { originWetCheckId?: number | null }).originWetCheckId ?? null,
        // Task #315 — carry branchName so the work order lands on the correct
        // branch for billing and reconciliation views. Must stay in sync with
        // the same field in createWorkOrderFromEstimate (the two paths are
        // equivalent and both must propagate branchName).
        branchName: (approvedEstimate as unknown as { branchName?: string | null }).branchName ?? null,
      };

      const [newWorkOrder] = await tx.insert(workOrders)
        .values(toDrizzleInsert<DrizzleWorkOrderInsert>(workOrderData))
        .returning();

      // 3. Insert work-order items.
      for (const item of items) {
        await tx.insert(workOrderItems).values({
          workOrderId: newWorkOrder.id,
          partId: item.partId,
          partName: item.partName,
          partPrice: item.partPrice,
          quantity: item.quantity,
          laborHours: item.laborHours,
          totalPrice: money(item.totalPrice).toFixed(2),
          // Task #1437 — carry zone detail forward (see
          // createWorkOrderFromEstimate; the two paths must stay equivalent).
          controllerLetter: item.controllerLetter ?? null,
          zoneNumber: item.zoneNumber ?? null,
          issueType: item.issueType ?? null,
        });
      }

      // 4. Back-link the estimate to the work order and stamp the
      // converted status so isConvertedToWorkOrder() returns true.
      const [linkedEstimate] = await tx.update(estimates)
        .set({ workOrderId: newWorkOrder.id, status: 'converted_to_work_order' })
        .where(eq(estimates.id, estimateId))
        .returning();

      // 5. Auto-assign to the company's irrigation manager (if any) and
      // notify them. Skipped silently if no irrigation manager is on
      // the company — same as the previous route behavior.
      let assignedTechnician: User | null = null;
      let assignedWorkOrder: WorkOrder = newWorkOrder;
      if (linkedEstimate.companyId != null) {
        const [manager] = await tx.select().from(users)
          .where(and(
            eq(users.companyId, linkedEstimate.companyId),
            eq(users.role, "irrigation_manager"),
            eq(users.isActive, true),
          ))
          .limit(1);
        if (manager) {
          assignedTechnician = manager;
          const [reassigned] = await tx.update(workOrders)
            .set({
              assignedTechnicianId: manager.id,
              assignedTechnicianName: manager.name,
              status: "assigned",
            })
            .where(eq(workOrders.id, newWorkOrder.id))
            .returning();
          if (reassigned) assignedWorkOrder = reassigned;
          await tx.insert(notifications).values({
            userId: manager.id,
            type: "work_order_assigned",
            title: "New Work Order Assigned",
            message: `Work order ${newWorkOrder.workOrderNumber} for ${linkedEstimate.customerName} has been auto-assigned to you from approved estimate.`,
            isRead: false,
          });
        }
      }

      const estimateOut: Estimate = {
        ...linkedEstimate,
        lifecycleStatus: computeLifecycleStatus(linkedEstimate),
      } as Estimate;
      return { estimate: estimateOut, workOrder: assignedWorkOrder, assignedTechnician };
    });
  }

  async unapproveEstimate(id: number): Promise<{
    estimate: Estimate;
    deletedWorkOrderId: number | null;
  }> {
    return await db.transaction(async (tx) => {
      // Row-lock the estimate so concurrent approve/unapprove requests
      // serialize rather than racing into conflicting state.
      const [lockedEstimate] = await tx
        .select()
        .from(estimates)
        .where(eq(estimates.id, id))
        .for("update");
      if (!lockedEstimate || lockedEstimate.lifecycle !== "approved") {
        throw new UnapproveEstimateConflictError("not_approved", {
          lifecycle: lockedEstimate?.lifecycle ?? "unknown",
        });
      }

      // Row-lock the linked work order (if any) inside the same
      // transaction so its status cannot change between our check and
      // the delete.
      const [linkedWo] = await tx
        .select()
        .from(workOrders)
        .where(eq(workOrders.estimateId, id))
        .for("update")
        .limit(1);

      let deletedWorkOrderId: number | null = null;
      if (linkedWo) {
        if (linkedWo.status !== "pending") {
          throw new UnapproveEstimateConflictError("wo_progressed", {
            workOrderId: linkedWo.id,
            workOrderNumber: linkedWo.workOrderNumber,
            workOrderStatus: linkedWo.status,
          });
        }
        await tx.delete(workOrders).where(eq(workOrders.id, linkedWo.id));
        deletedWorkOrderId = linkedWo.id;
      }

      // Flip the estimate back to sent state. The AND on lifecycle in
      // the WHERE clause is belt-and-suspenders in addition to the
      // row lock above.
      const [updated] = await tx
        .update(estimates)
        .set({
          status: "pending",
          internalStatus: "sent_to_customer",
          lifecycle: "sent",
          approvedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(estimates.id, id), eq(estimates.lifecycle, "approved")))
        .returning();
      if (!updated) {
        throw new UnapproveEstimateConflictError("not_approved", {
          lifecycle: "unknown",
        });
      }

      return { estimate: updated, deletedWorkOrderId };
    });
  }

  async unrejectedEstimate(id: number): Promise<Estimate | undefined> {
    const [updated] = await db
      .update(estimates)
      .set({
        status: "pending",
        internalStatus: "sent_to_customer",
        lifecycle: "sent",
        updatedAt: new Date(),
      })
      .where(and(eq(estimates.id, id), eq(estimates.lifecycle, "rejected")))
      .returning();
    return updated;
  }

  async updateWorkOrder(id: number, workOrder: Partial<InsertWorkOrder>): Promise<WorkOrder | undefined> {
    // Task #1238 — auto-clear returnedForCorrectionAt when the tech resubmits
    // (status transitions to pending_manager_review or work_completed).
    const clearTimestamp =
      workOrder.status === "pending_manager_review" ||
      workOrder.status === "work_completed";
    const payload = clearTimestamp
      ? { ...workOrder, returnedForCorrectionAt: null }
      : workOrder;
    const [updatedWorkOrder] = await db.update(workOrders).set(payload).where(eq(workOrders.id, id)).returning();
    return updatedWorkOrder || undefined;
  }

  async deleteWorkOrder(id: number): Promise<boolean> {
    const result = await db.delete(workOrders).where(eq(workOrders.id, id));
    return (result.rowCount || 0) > 0;
  }

  async hasInvoiceItems(workOrderId: number): Promise<boolean> {
    const rows = await db.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.workOrderId, workOrderId)).limit(1);
    return rows.length > 0;
  }

  async assignWorkOrder(workOrderId: number, technicianId: number, technicianName: string): Promise<boolean> {
    try {
      const [updatedWorkOrder] = await db.update(workOrders)
        .set({
          assignedTechnicianId: technicianId,
          assignedTechnicianName: technicianName,
          status: 'assigned',
        })
        .where(eq(workOrders.id, workOrderId))
        .returning();
      
      return !!updatedWorkOrder;
    } catch (error) {
      console.error("Error assigning work order:", error);
      return false;
    }
  }

  async markWorkOrderNoPhotosNeeded(workOrderId: number, userId: number): Promise<WorkOrder | undefined> {
    const [updated] = await db.update(workOrders)
      .set({
        noPhotosNeeded: true,
        noPhotosNeededBy: userId,
        noPhotosNeededAt: new Date(),
      })
      .where(eq(workOrders.id, workOrderId))
      .returning();
    return updated || undefined;
  }

  async clearWorkOrderNoPhotosNeeded(workOrderId: number): Promise<WorkOrder | undefined> {
    const [updated] = await db.update(workOrders)
      .set({
        noPhotosNeeded: false,
        noPhotosNeededBy: null,
        noPhotosNeededAt: null,
      })
      .where(eq(workOrders.id, workOrderId))
      .returning();
    return updated || undefined;
  }

  // Work Order Items
  async getWorkOrderItems(workOrderId: number): Promise<WorkOrderItem[]> {
    return await db.select().from(workOrderItems).where(eq(workOrderItems.workOrderId, workOrderId));
  }

  async addWorkOrderItem(item: InsertWorkOrderItem): Promise<WorkOrderItem> {
    const [newItem] = await db.insert(workOrderItems).values(item).returning();
    return newItem;
  }

  async updateWorkOrderItem(id: number, item: Partial<InsertWorkOrderItem>): Promise<WorkOrderItem | undefined> {
    const [updatedItem] = await db.update(workOrderItems).set(item).where(eq(workOrderItems.id, id)).returning();
    return updatedItem || undefined;
  }

  async deleteWorkOrderItem(id: number): Promise<boolean> {
    const result = await db.delete(workOrderItems).where(eq(workOrderItems.id, id));
    return (result.rowCount || 0) > 0;
  }

  async deleteWorkOrderItems(workOrderId: number): Promise<boolean> {
    await db.delete(workOrderItems).where(eq(workOrderItems.workOrderId, workOrderId));
    return true;
  }

  async replaceWorkOrderItemsInTransaction(workOrderId: number, items: InsertWorkOrderItem[]): Promise<WorkOrderItem[]> {
    return await db.transaction(async (tx) => {
      await tx.delete(workOrderItems).where(eq(workOrderItems.workOrderId, workOrderId));
      if (items.length === 0) return [];
      const inserted = await tx.insert(workOrderItems).values(items).returning();
      return inserted;
    });
  }

  // Task #1437 — tech zone checklist check-off. Toggles a single item's
  // completedAt. Scoped to the work order so a tech can't flip an item that
  // belongs to a different ticket. Returns undefined when no row matched.
  async setWorkOrderItemCompletion(
    workOrderId: number,
    itemId: number,
    completed: boolean,
  ): Promise<WorkOrderItem | undefined> {
    const [updated] = await db
      .update(workOrderItems)
      .set({ completedAt: completed ? new Date() : null })
      .where(and(eq(workOrderItems.id, itemId), eq(workOrderItems.workOrderId, workOrderId)))
      .returning();
    return updated || undefined;
  }

  // Task #1437 — zone-linked completed-work photos for a work order. This is
  // the structured store (work_order_zone_photos), NOT the flat
  // work_orders.photos array.
  async getWorkOrderZonePhotos(workOrderId: number): Promise<WorkOrderZonePhoto[]> {
    return await db
      .select()
      .from(workOrderZonePhotos)
      .where(eq(workOrderZonePhotos.workOrderId, workOrderId))
      .orderBy(workOrderZonePhotos.takenAt);
  }

  async attachWorkOrderZonePhoto(
    workOrderId: number,
    insert: Omit<InsertWorkOrderZonePhoto, "workOrderId">,
  ): Promise<WorkOrderZonePhoto> {
    // Cross-record linkage validation: a photo's optional workOrderItemId
    // must belong to the SAME work order (the work order itself is verified
    // to belong to the caller's company by the route's tenant guard).
    if (insert.workOrderItemId != null) {
      const [woi] = await db
        .select()
        .from(workOrderItems)
        .where(eq(workOrderItems.id, insert.workOrderItemId));
      if (!woi || woi.workOrderId !== workOrderId) {
        throw new Error(
          `Work order item ${insert.workOrderItemId} does not belong to work order ${workOrderId}`,
        );
      }
    }
    // Idempotent dedupe on clientId (matches the partial unique index
    // uniq_wo_zone_photo_client_id) so an offline retry of the same metadata
    // POST returns the already-written row instead of dying on the constraint.
    if (insert.clientId) {
      const [existing] = await db
        .select()
        .from(workOrderZonePhotos)
        .where(eq(workOrderZonePhotos.clientId, insert.clientId));
      if (existing) {
        if (existing.workOrderId !== workOrderId) {
          const err = new Error(
            "Photo client id already used on another work order",
          ) as Error & { code?: string };
          err.code = "WORK_ORDER_ZONE_PHOTO_CLIENT_ID_COLLISION";
          throw err;
        }
        return existing;
      }
    }
    try {
      const [created] = await db
        .insert(workOrderZonePhotos)
        .values({ ...insert, workOrderId })
        .returning();
      return created;
    } catch (e: any) {
      // Belt-and-suspenders: a concurrent retry (same clientId) that raced
      // past the SELECT above fails on the partial unique index; re-read and
      // return the winner so the attach stays idempotent.
      const pgCode = e?.cause?.code ?? e?.code;
      if (insert.clientId && pgCode === "23505") {
        const [winner] = await db
          .select()
          .from(workOrderZonePhotos)
          .where(eq(workOrderZonePhotos.clientId, insert.clientId));
        if (winner) {
          if (winner.workOrderId === workOrderId) return winner;
          const err = new Error(
            "Photo client id already used on another work order",
          ) as Error & { code?: string };
          err.code = "WORK_ORDER_ZONE_PHOTO_CLIENT_ID_COLLISION";
          throw err;
        }
      }
      throw e;
    }
  }

  async deleteWorkOrderZonePhoto(id: number, workOrderId: number): Promise<boolean> {
    const result = await db
      .delete(workOrderZonePhotos)
      .where(and(eq(workOrderZonePhotos.id, id), eq(workOrderZonePhotos.workOrderId, workOrderId)));
    return (result.rowCount || 0) > 0;
  }

  // Standalone Billing Sheets - for work done without work orders
  async getAllBillingSheets(companyId: number | null): Promise<BillingSheetWithItems[]> {
    const scope = this._companyScopeForBS(companyId);
    const sheets = await db.select().from(billingSheets)
      .where(scope ?? undefined)
      .orderBy(desc(billingSheets.createdAt));
    
    const sheetsWithItems = await Promise.all(sheets.map(async (sheet) => {
      const items = await db.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, sheet.id));
      return { ...sheet, items };
    }));
    
    return sheetsWithItems;
  }

  async getBillingSheetById(id: number, companyId: number | null): Promise<BillingSheetWithItems | undefined> {
    const scope = this._companyScopeForBS(companyId);
    const cond = scope ? and(eq(billingSheets.id, id), scope) : eq(billingSheets.id, id);
    const [sheet] = await db.select().from(billingSheets).where(cond);
    if (!sheet) return undefined;
    
    const items = await db.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, id));
    return { ...sheet, items };
  }

  async getBillingSheetsByWorkOrderId(workOrderId: number, companyId: number | null): Promise<BillingSheetWithItems[]> {
    const scope = this._companyScopeForBS(companyId);
    const cond = scope ? and(eq(billingSheets.workOrderId, workOrderId), scope) : eq(billingSheets.workOrderId, workOrderId);
    const sheets = await db.select().from(billingSheets)
      .where(cond)
      .orderBy(desc(billingSheets.createdAt));
    const sheetsWithItems = await Promise.all(sheets.map(async (sheet) => {
      const items = await db.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, sheet.id));
      return { ...sheet, items };
    }));
    return sheetsWithItems;
  }

  async getNextBillingNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `BS-${year}-`;

    if (!this._billingCounterTableReady) {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS billing_number_counters (
          prefix TEXT PRIMARY KEY,
          last_seq INTEGER NOT NULL DEFAULT 0
        )
      `);
      this._billingCounterTableReady = true;
    }

    if (!this._billingCounterPrefixSeeded.has(prefix)) {
      const likePattern = `${prefix}%`;
      await db.execute(sql`
        INSERT INTO billing_number_counters (prefix, last_seq)
        VALUES (${prefix}, COALESCE(
          (SELECT MAX(CAST(SUBSTRING(billing_number FROM '[0-9]+$') AS INTEGER))
            FROM billing_sheets WHERE billing_number LIKE ${likePattern}), 0))
        ON CONFLICT (prefix) DO NOTHING
      `);
      this._billingCounterPrefixSeeded.add(prefix);
    }

    const result = await db.execute(sql`
      UPDATE billing_number_counters
      SET last_seq = last_seq + 1
      WHERE prefix = ${prefix}
      RETURNING last_seq
    `);
    const seq = Number(result.rows[0].last_seq);
    return `${prefix}${seq.toString().padStart(4, '0')}`;
  }

  // ── Wet Check Billings (Slice 10) ────────────────────────────────────────

  async getNextWetCheckBillingNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `WC-${year}-`;

    if (!this._billingCounterTableReady) {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS billing_number_counters (
          prefix TEXT PRIMARY KEY,
          last_seq INTEGER NOT NULL DEFAULT 0
        )
      `);
      this._billingCounterTableReady = true;
    }

    if (!this._wetCheckCounterPrefixSeeded.has(prefix)) {
      await db.execute(sql`
        INSERT INTO billing_number_counters (prefix, last_seq)
        VALUES (${prefix}, 999)
        ON CONFLICT (prefix) DO NOTHING
      `);
      this._wetCheckCounterPrefixSeeded.add(prefix);
    }

    const result = await db.execute(sql`
      UPDATE billing_number_counters
      SET last_seq = last_seq + 1
      WHERE prefix = ${prefix}
      RETURNING last_seq
    `);
    const seq = Number(result.rows[0].last_seq);
    return `${prefix}${seq.toString().padStart(4, '0')}`;
  }

  async createWetCheckBilling(data: InsertWetCheckBilling): Promise<WetCheckBilling> {
    const { createdAt, updatedAt, ...insertData } = data as Record<string, unknown>;
    const [row] = await db.insert(wetCheckBillings).values(insertData as typeof wetCheckBillings.$inferInsert).returning();
    return row;
  }

  async getAllWetCheckBillings(): Promise<WetCheckBilling[]> {
    return db.select().from(wetCheckBillings).orderBy(desc(wetCheckBillings.createdAt));
  }

  async getAllWetCheckBillingsWithCounts(companyId?: number | null): Promise<WetCheckBillingListItem[]> {
    const baseQuery = db
      .select({
        wcb: wetCheckBillings,
        issuesCount: sql<number>`cast(count(${wetCheckFindings.id}) as int)`,
        zonesCount: sql<number>`cast(count(distinct ${wetCheckFindings.zoneRecordId}) as int)`,
        wetCheckStatus: wetChecks.status,
        wetCheckMode: wetChecks.mode,
        daysInQueue: sql<number>`cast(extract(epoch from (now() - ${wetCheckBillings.createdAt})) / 86400 as int)`,
        findingsRepaired: sql<number>`cast(count(case when ${wetCheckFindings.resolution} = 'repaired_in_field' then 1 end) as int)`,
        findingsToEstimate: sql<number>`cast(count(case when ${wetCheckFindings.resolution} = 'sent_to_estimate' then 1 end) as int)`,
        findingsDeferred: sql<number>`cast(count(case when ${wetCheckFindings.resolution} = 'deferred_to_work_order' then 1 end) as int)`,
        unroutedFindingsCount: sql<number>`cast((
          select count(*) from wet_check_findings wf2
          where wf2.wet_check_id = wet_check_billings.wet_check_id
            and (wf2.resolution is null or wf2.resolution = 'pending')
            and (wf2.issue_type = 'custom_review' or wf2.tech_disposition is distinct from 'completed_in_field')
            and wf2.converted_at is null
            and wf2.billing_sheet_id is null
            and wf2.estimate_id is null
            and wf2.work_order_id is null
            and wf2.wet_check_billing_id is null
        ) as int)`,
      })
      .from(wetCheckBillings)
      .leftJoin(wetCheckFindings, eq(wetCheckFindings.wetCheckBillingId, wetCheckBillings.id))
      .leftJoin(wetChecks, eq(wetChecks.id, wetCheckBillings.wetCheckId));
    const rows = await (companyId != null
      ? baseQuery
          .innerJoin(customers, eq(customers.id, wetCheckBillings.customerId))
          .where(eq(customers.companyId, companyId))
          .groupBy(wetCheckBillings.id, wetChecks.status, wetChecks.mode)
          .orderBy(desc(wetCheckBillings.workDate), desc(wetCheckBillings.id))
      : baseQuery
          .groupBy(wetCheckBillings.id, wetChecks.status, wetChecks.mode)
          .orderBy(desc(wetCheckBillings.workDate), desc(wetCheckBillings.id)));
    return rows.map((r) => ({
      ...r.wcb,
      issuesCount: r.issuesCount ?? 0,
      zonesCount: r.zonesCount ?? 0,
      wetCheckStatus: r.wetCheckStatus ?? null,
      wetCheckMode: r.wetCheckMode ?? null,
      daysInQueue: r.daysInQueue ?? 0,
      findingsRepaired: r.findingsRepaired ?? 0,
      findingsToEstimate: r.findingsToEstimate ?? 0,
      findingsDeferred: r.findingsDeferred ?? 0,
      unroutedFindingsCount: r.unroutedFindingsCount ?? 0,
    }));
  }

  async getWetCheckBillingById(id: number, companyId: number | null): Promise<WetCheckBilling | undefined> {
    // Mirror the BS/WO pattern: scope to caller's company via customers join.
    // companyId=null means super_admin (any tenant).
    if (companyId != null) {
      const [row] = await db
        .select({ wcb: wetCheckBillings })
        .from(wetCheckBillings)
        .innerJoin(customers, eq(wetCheckBillings.customerId, customers.id))
        .where(and(eq(wetCheckBillings.id, id), eq(customers.companyId, companyId)));
      return row?.wcb;
    }
    const [row] = await db.select().from(wetCheckBillings).where(eq(wetCheckBillings.id, id));
    return row;
  }

  async getWetCheckBillingsByCustomer(customerId: number): Promise<WetCheckBillingListItem[]> {
    const rows = await db
      .select({
        wcb: wetCheckBillings,
        wetCheckStatus: wetChecks.status,
        wetCheckMode: wetChecks.mode,
        issuesCount: sql<number>`cast(count(${wetCheckFindings.id}) as int)`,
        zonesCount: sql<number>`cast(count(distinct ${wetCheckFindings.zoneRecordId}) as int)`,
        daysInQueue: sql<number>`cast(extract(epoch from (now() - ${wetCheckBillings.createdAt})) / 86400 as int)`,
        findingsRepaired: sql<number>`cast(count(case when ${wetCheckFindings.resolution} = 'repaired_in_field' then 1 end) as int)`,
        findingsToEstimate: sql<number>`cast(count(case when ${wetCheckFindings.resolution} = 'sent_to_estimate' then 1 end) as int)`,
        findingsDeferred: sql<number>`cast(count(case when ${wetCheckFindings.resolution} = 'deferred_to_work_order' then 1 end) as int)`,
        // Correlated sub-query: count findings on the PARENT WET CHECK that are
        // genuinely unrouted (same predicate as isUnroutedFinding in finding-predicates.ts).
        // Used by wcbIsEligible() to decide whether the WCB is ready to invoice.
        // resolution IS NULL is treated as 'pending' to match the JS null-coalesce.
        // 'completed_in_field' tech_disposition is excluded because those findings
        // are auto-billed and never need manager routing.
        unroutedFindingsCount: sql<number>`cast((
          select count(*) from wet_check_findings wf2
          where wf2.wet_check_id = wet_check_billings.wet_check_id
            and (wf2.resolution is null or wf2.resolution = 'pending')
            and (wf2.issue_type = 'custom_review' or wf2.tech_disposition is distinct from 'completed_in_field')
            and wf2.converted_at is null
            and wf2.billing_sheet_id is null
            and wf2.estimate_id is null
            and wf2.work_order_id is null
            and wf2.wet_check_billing_id is null
        ) as int)`,
      })
      .from(wetCheckBillings)
      .leftJoin(wetCheckFindings, eq(wetCheckFindings.wetCheckBillingId, wetCheckBillings.id))
      .leftJoin(wetChecks, eq(wetChecks.id, wetCheckBillings.wetCheckId))
      .where(eq(wetCheckBillings.customerId, customerId))
      .groupBy(wetCheckBillings.id, wetChecks.status, wetChecks.mode)
      .orderBy(desc(wetCheckBillings.createdAt));
    return rows.map((r) => ({
      ...r.wcb,
      issuesCount: r.issuesCount ?? 0,
      zonesCount: r.zonesCount ?? 0,
      wetCheckStatus: r.wetCheckStatus ?? null,
      wetCheckMode: r.wetCheckMode ?? null,
      daysInQueue: r.daysInQueue ?? 0,
      findingsRepaired: r.findingsRepaired ?? 0,
      findingsToEstimate: r.findingsToEstimate ?? 0,
      findingsDeferred: r.findingsDeferred ?? 0,
      unroutedFindingsCount: r.unroutedFindingsCount ?? 0,
    }));
  }

  async getWetCheckBillingsByTechnician(technicianId: number): Promise<WetCheckBilling[]> {
    return db.select().from(wetCheckBillings)
      .where(eq(wetCheckBillings.technicianId, technicianId))
      .orderBy(desc(wetCheckBillings.createdAt));
  }

  async getWetCheckBillingsByWetCheckId(wetCheckId: number): Promise<WetCheckBilling[]> {
    return db.select().from(wetCheckBillings)
      .where(eq(wetCheckBillings.wetCheckId, wetCheckId))
      .orderBy(desc(wetCheckBillings.createdAt));
  }

  async updateWetCheckBilling(id: number, data: Partial<InsertWetCheckBilling>): Promise<WetCheckBilling> {
    const [row] = await db.update(wetCheckBillings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(wetCheckBillings.id, id))
      .returning();
    if (!row) throw new Error(`WetCheckBilling id=${id} not found`);
    return row;
  }

  // Bulk-route findings to a WetCheckBilling.  Groups the requested finding IDs
  // by wetCheckId and, for each group, creates or appends to the WCB for that
  // wet check (same financial math as the submit-time auto-bill path).
  // Stamps resolution='repaired_in_field' on findings that didn't have it yet.
  // Company-scoped: findings whose parent wet check doesn't belong to companyId
  // are silently ignored (companyId=null means super_admin — no restriction).
  async routeFindingsToWetCheckBillingBulk(
    findingIds: number[],
    companyId: number | null,
    userId: number | null,
  ): Promise<{ routed: number[]; errors: { findingId: number; message: string }[] }> {
    if (findingIds.length === 0) return { routed: [], errors: [] };

    const findingRows = await db
      .select({
        f: wetCheckFindings,
        wcCompanyId: wetChecks.companyId,
      })
      .from(wetCheckFindings)
      .innerJoin(wetChecks, eq(wetCheckFindings.wetCheckId, wetChecks.id))
      .where(
        and(
          inArray(wetCheckFindings.id, findingIds),
          companyId != null ? eq(wetChecks.companyId, companyId) : undefined,
        ),
      );

    // Group by wetCheckId.
    const groups = new Map<number, (typeof findingRows[0])[]>();
    for (const row of findingRows) {
      const key = row.f.wetCheckId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const routed: number[] = [];
    const errors: { findingId: number; message: string }[] = [];

    for (const [wetCheckId, groupRows] of groups) {
      try {
        await db.transaction(async (tx) => {
          const [wc] = await tx.select().from(wetChecks).where(eq(wetChecks.id, wetCheckId));
          if (!wc) throw new Error(`Wet check ${wetCheckId} not found`);

          const [cust] = await tx.select({ laborRate: customers.laborRate })
            .from(customers)
            .where(eq(customers.id, wc.customerId));
          const laborRate = parseFloat(String(cust?.laborRate ?? "45.00")) || 45;

          // Find the existing WCB for this wet check (if any).
          const [priorWcb] = await tx
            .select({ id: wetCheckBillings.id })
            .from(wetCheckBillings)
            .where(eq(wetCheckBillings.wetCheckId, wetCheckId));

          // Filter to findings that are genuinely unrouted.
          const unrouted = groupRows
            .map((r) => r.f)
            .filter(
              (f) =>
                f.billingSheetId == null &&
                f.estimateId == null &&
                f.workOrderId == null &&
                f.wetCheckBillingId == null &&
                f.convertedAt == null,
            );

          if (unrouted.length === 0) return;

          const now = new Date();
          await this._writeRepairedInFieldBilling(
            tx, wc, laborRate, unrouted, priorWcb?.id ?? null, now,
          );

          // Stamp resolution for findings that didn't have it set yet.
          const needsResolution = unrouted.filter((f) => f.resolution !== "repaired_in_field").map((f) => f.id);
          if (needsResolution.length > 0) {
            await tx.update(wetCheckFindings)
              .set({
                resolution: "repaired_in_field",
                resolutionDecidedAt: now,
                ...(userId != null ? { resolutionDecidedBy: userId } : {}),
              })
              .where(inArray(wetCheckFindings.id, needsResolution));
          }

          for (const f of unrouted) routed.push(f.id);
        });
      } catch (err: any) {
        for (const { f } of groupRows) {
          errors.push({ findingId: f.id, message: String(err?.message ?? err) });
        }
      }
    }

    return { routed, errors };
  }

  // Task #977 — billing-manager-tier labor-rate override on an unbilled WCB.
  // Reads the existing WCB, enforces lock/tenant guards, then recomputes
  // laborSubtotal (= totalHours × newRate) and totalAmount (= laborSubtotal +
  // partsSubtotal) in one atomic UPDATE … RETURNING call.
  async recomputeWcbTotalsForLaborRate(id: number, newRate: number, companyId: number | null): Promise<{ before: WetCheckBilling; updated: WetCheckBilling }> {
    return db.transaction(async (tx) => {
      const [wcb] = await tx.select().from(wetCheckBillings).where(eq(wetCheckBillings.id, id));
      if (!wcb) {
        throw Object.assign(new Error(`Wet check billing ${id} not found`), { code: "WCB_NOT_FOUND" });
      }
      // Tenant-scope: verify the WCB's wet check belongs to this company.
      // companyId=null means super_admin bypass.
      if (companyId != null) {
        const [wc] = await tx.select({ companyId: wetChecks.companyId }).from(wetChecks).where(eq(wetChecks.id, wcb.wetCheckId));
        if (!wc || wc.companyId !== companyId) {
          throw Object.assign(new Error("Access denied"), { code: "WCB_CROSS_COMPANY" });
        }
      }
      // Block billed or invoiced WCBs.
      if (wcb.status === "billed" || wcb.invoiceId != null) {
        throw Object.assign(
          new Error(`Wet check billing ${id} is locked (status=${wcb.status}) and cannot have its labor rate changed`),
          { code: "WCB_LOCKED" },
        );
      }
      const totalHours = parseFloat(String(wcb.totalHours ?? "0")) || 0;
      const laborSubtotal = totalHours * newRate;
      const partsSubtotal = parseFloat(String(wcb.partsSubtotal ?? "0")) || 0;
      const totalAmount = laborSubtotal + partsSubtotal;
      const [updated] = await tx.update(wetCheckBillings).set({
        laborRate: newRate.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(wetCheckBillings.id, id)).returning();
      if (!updated) throw new Error(`WetCheckBilling id=${id} update failed`);
      return { before: wcb, updated };
    });
  }

  // ── Task #1093 — rate-mode recompute methods ────────────────────────────────

  async recomputeBillingSheetTotalsForRateMode(
    id: number,
    mode: string,
    companyId: number | null,
  ): Promise<BillingSheetWithItems> {
    return db.transaction(async (tx) => {
      const scope = this._companyScopeForBS(companyId);
      const cond = scope ? and(eq(billingSheets.id, id), scope) : eq(billingSheets.id, id);
      const [bs] = await tx.select().from(billingSheets).where(cond);
      if (!bs) throw Object.assign(new Error(`Billing sheet ${id} not found`), { code: "BS_NOT_FOUND" });
      if (bs.status === "billed" || bs.invoiceId != null) {
        throw Object.assign(new Error(`Billing sheet ${id} is locked`), { code: "BS_LOCKED" });
      }
      if (!bs.customerId) {
        throw Object.assign(new Error("Billing sheet has no customer — cannot derive rate"), { code: "NO_CUSTOMER" });
      }
      const [customer] = await tx.select({
        laborRate: customers.laborRate,
        emergencyLaborRate: customers.emergencyLaborRate,
      }).from(customers).where(eq(customers.id, bs.customerId));
      if (!customer) throw Object.assign(new Error("Customer not found"), { code: "NO_CUSTOMER" });
      const newRate = mode === "emergency"
        ? parseFloat(String(customer.emergencyLaborRate ?? "0")) || 0
        : parseFloat(String(customer.laborRate ?? "0")) || 0;
      const totalHours = parseFloat(String(bs.totalHours ?? "0")) || 0;
      const laborSubtotal = totalHours * newRate;
      // Task #1669 — use the shared helper to guarantee totalAmount === parts + labor.
      // Pass the computed laborSubtotal as the patched value; parts come from the
      // stored record so a rate-mode flip never zeroes stored parts.
      const totalAmount = computeBillingSheetTotal(
        { laborSubtotal: laborSubtotal.toFixed(2) },
        { partsSubtotal: bs.partsSubtotal },
      );
      const [updated] = await tx.update(billingSheets).set({
        rateMode: mode,
        laborRate: newRate.toFixed(2),
        appliedLaborRate: newRate.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount,
        updatedAt: new Date(),
      }).where(eq(billingSheets.id, id)).returning();
      if (!updated) throw new Error(`Billing sheet ${id} update failed`);
      const items = await tx.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, id));
      return { ...updated, items };
    });
  }

  async recomputeWorkOrderTotalsForRateMode(
    id: number,
    mode: string,
    companyId: number | null,
  ): Promise<WorkOrder> {
    return db.transaction(async (tx) => {
      const scope = this._companyScope(companyId);
      const cond = scope ? and(eq(workOrders.id, id), scope) : eq(workOrders.id, id);
      const [wo] = await tx.select().from(workOrders).where(cond);
      if (!wo) throw Object.assign(new Error(`Work order ${id} not found`), { code: "WO_NOT_FOUND" });
      if (wo.status === "billed" || wo.invoiceId != null) {
        throw Object.assign(new Error(`Work order ${id} is locked`), { code: "WO_LOCKED" });
      }
      const [customer] = await tx.select({
        laborRate: customers.laborRate,
        emergencyLaborRate: customers.emergencyLaborRate,
      }).from(customers).where(eq(customers.id, wo.customerId));
      if (!customer) throw Object.assign(new Error("Customer not found"), { code: "NO_CUSTOMER" });
      const newRate = mode === "emergency"
        ? parseFloat(String(customer.emergencyLaborRate ?? "0")) || 0
        : parseFloat(String(customer.laborRate ?? "0")) || 0;
      const totalHours = parseFloat(String(wo.totalHours ?? "0")) || 0;
      const laborSubtotal = totalHours * newRate;
      const partsSubtotal = parseFloat(String(wo.partsSubtotal ?? "0")) || 0;
      const totalAmount = laborSubtotal + partsSubtotal;
      const [updated] = await tx.update(workOrders).set({
        rateMode: mode,
        laborRate: newRate.toFixed(2),
        appliedLaborRate: newRate.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(workOrders.id, id)).returning();
      if (!updated) throw new Error(`Work order ${id} update failed`);
      return updated;
    });
  }

  async recomputeWcbTotalsForRateMode(
    id: number,
    mode: string,
    companyId: number | null,
  ): Promise<{ before: WetCheckBilling; updated: WetCheckBilling }> {
    return db.transaction(async (tx) => {
      const [wcb] = await tx.select().from(wetCheckBillings).where(eq(wetCheckBillings.id, id));
      if (!wcb) throw Object.assign(new Error(`Wet check billing ${id} not found`), { code: "WCB_NOT_FOUND" });
      if (companyId != null) {
        const [wc] = await tx.select({ companyId: wetChecks.companyId }).from(wetChecks).where(eq(wetChecks.id, wcb.wetCheckId));
        if (!wc || wc.companyId !== companyId) throw Object.assign(new Error("Access denied"), { code: "WCB_CROSS_COMPANY" });
      }
      if (wcb.status === "billed" || wcb.invoiceId != null) {
        throw Object.assign(new Error(`Wet check billing ${id} is locked`), { code: "WCB_LOCKED" });
      }
      if (!wcb.customerId) {
        throw Object.assign(new Error("WCB has no customer — cannot derive rate"), { code: "NO_CUSTOMER" });
      }
      const [customer] = await tx.select({
        laborRate: customers.laborRate,
        emergencyLaborRate: customers.emergencyLaborRate,
      }).from(customers).where(eq(customers.id, wcb.customerId));
      if (!customer) throw Object.assign(new Error("Customer not found"), { code: "NO_CUSTOMER" });
      const newRate = mode === "emergency"
        ? parseFloat(String(customer.emergencyLaborRate ?? "0")) || 0
        : parseFloat(String(customer.laborRate ?? "0")) || 0;
      const totalHours = parseFloat(String(wcb.totalHours ?? "0")) || 0;
      const laborSubtotal = totalHours * newRate;
      const partsSubtotal = parseFloat(String(wcb.partsSubtotal ?? "0")) || 0;
      const totalAmount = laborSubtotal + partsSubtotal;
      const [updated] = await tx.update(wetCheckBillings).set({
        rateMode: mode,
        laborRate: newRate.toFixed(2),
        appliedLaborRate: newRate.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(wetCheckBillings.id, id)).returning();
      if (!updated) throw new Error(`WetCheckBilling ${id} update failed`);
      return { before: wcb, updated };
    });
  }

  async replaceBillingSheetItemsWithResync(
    id: number,
    items: InsertBillingSheetItem[],
    companyId: number | null,
  ): Promise<BillingSheetWithItems> {
    return db.transaction(async (tx) => {
      const scope = this._companyScopeForBS(companyId);
      const cond = scope ? and(eq(billingSheets.id, id), scope) : eq(billingSheets.id, id);
      const [bs] = await tx.select().from(billingSheets).where(cond);
      if (!bs) throw Object.assign(new Error(`Billing sheet ${id} not found`), { code: "BS_NOT_FOUND" });
      if (bs.status === "billed" || bs.invoiceId != null) {
        throw Object.assign(new Error(`Billing sheet ${id} is locked`), { code: "BS_LOCKED" });
      }

      // Atomically delete and re-insert items
      await tx.delete(billingSheetItems).where(eq(billingSheetItems.billingSheetId, id));
      let inserted: typeof billingSheetItems.$inferSelect[] = [];
      if (items.length > 0) {
        const values = items.map((item) => ({
          ...item,
          billingSheetId: id,
          totalPrice: (money(item.quantity) * money(item.unitPrice)).toFixed(2),
        }));
        inserted = await tx.insert(billingSheetItems).values(values).returning();
      }

      // Recompute partsSubtotal from new items
      const truePartsSubtotal = inserted.reduce(
        (sum, row) => sum + parseFloat(String(row.totalPrice || 0)), 0
      );

      // Recompute laborSubtotal from labor config + new items
      const laborRate = parseFloat(String(bs.laborRate ?? bs.appliedLaborRate ?? "0")) || 0;
      let laborSubtotal: number;
      let newTotalHours: number | undefined;
      if (bs.laborMode === "per_part") {
        newTotalHours = inserted.reduce((s, r) => s + parseFloat(String(r.laborHours || 0)), 0);
        laborSubtotal = newTotalHours * laborRate;
      } else {
        // flat mode: totalHours × laborRate
        const totalHours = parseFloat(String(bs.totalHours ?? "0")) || 0;
        laborSubtotal = totalHours * laborRate;
      }
      const totalAmount = laborSubtotal + truePartsSubtotal;

      const [updated] = await tx.update(billingSheets).set({
        partsSubtotal: truePartsSubtotal.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        ...(newTotalHours !== undefined ? { totalHours: newTotalHours.toFixed(2) } : {}),
        updatedAt: new Date(),
      }).where(eq(billingSheets.id, id)).returning();

      if (!updated) throw new Error(`Billing sheet ${id} update failed`);
      return { ...updated, items: inserted };
    });
  }

  async replaceWorkOrderItemsWithResync(
    id: number,
    items: InsertWorkOrderItem[],
    companyId: number | null,
  ): Promise<WorkOrder & { items: WorkOrderItem[] }> {
    return db.transaction(async (tx) => {
      const scope = this._companyScope(companyId);
      const cond = scope ? and(eq(workOrders.id, id), scope) : eq(workOrders.id, id);
      const [wo] = await tx.select().from(workOrders).where(cond);
      if (!wo) throw Object.assign(new Error(`Work order ${id} not found`), { code: "WO_NOT_FOUND" });
      if (wo.status === "billed" || wo.invoiceId != null) {
        throw Object.assign(new Error(`Work order ${id} is locked`), { code: "WO_LOCKED" });
      }
      await tx.delete(workOrderItems).where(eq(workOrderItems.workOrderId, id));
      let inserted: WorkOrderItem[] = [];
      if (items.length > 0) {
        const values = items.map((item) => ({
          ...item,
          workOrderId: id,
          totalPrice: (money(item.quantity) * money(item.partPrice)).toFixed(2),
        }));
        inserted = await tx.insert(workOrderItems).values(values).returning();
      }
      const truePartsSubtotal = inserted.reduce((s, r) => s + money(r.totalPrice), 0);
      const laborRate = parseFloat(String(wo.laborRate ?? wo.appliedLaborRate ?? "0")) || 0;
      let laborSubtotal: number;
      let newTotalHours: number | undefined;
      if (wo.laborMode === "per_part") {
        newTotalHours = inserted.reduce((s, r) => s + parseFloat(String(r.laborHours || 0)), 0);
        laborSubtotal = newTotalHours * laborRate;
      } else {
        const totalHours = parseFloat(String(wo.totalHours ?? "0")) || 0;
        laborSubtotal = totalHours * laborRate;
      }
      const totalAmount = laborSubtotal + truePartsSubtotal;
      const [updated] = await tx.update(workOrders).set({
        partsSubtotal: truePartsSubtotal.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        totalItems: inserted.length,
        ...(newTotalHours !== undefined ? { totalHours: newTotalHours.toFixed(2) } : {}),
        updatedAt: new Date(),
      }).where(eq(workOrders.id, id)).returning();
      if (!updated) throw new Error(`Work order ${id} update failed`);
      return { ...updated, items: inserted };
    });
  }


  async updateBillingSheetLaborHours(
    id: number,
    totalHours: number,
    companyId: number | null,
  ): Promise<BillingSheetWithItems> {
    return db.transaction(async (tx) => {
      const scope = this._companyScopeForBS(companyId);
      const cond = scope ? and(eq(billingSheets.id, id), scope) : eq(billingSheets.id, id);
      const [bs] = await tx.select().from(billingSheets).where(cond);
      if (!bs) throw Object.assign(new Error(`Billing sheet ${id} not found`), { code: "BS_NOT_FOUND" });
      if (bs.status === "billed" || bs.invoiceId != null) {
        throw Object.assign(new Error(`Billing sheet ${id} is locked`), { code: "BS_LOCKED" });
      }
      const laborRate = parseFloat(String(bs.appliedLaborRate ?? bs.laborRate ?? "0")) || 0;
      const laborSubtotal = totalHours * laborRate;
      // Task #1669 — use the shared helper to guarantee totalAmount === parts + labor.
      // Pass the computed laborSubtotal as the patched value; parts come from the
      // stored record so a labor-hours edit never zeroes stored parts.
      const totalAmount = computeBillingSheetTotal(
        { laborSubtotal: laborSubtotal.toFixed(2) },
        { partsSubtotal: bs.partsSubtotal },
      );
      const [updated] = await tx.update(billingSheets).set({
        totalHours: totalHours.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount,
        updatedAt: new Date(),
      }).where(eq(billingSheets.id, id)).returning();
      if (!updated) throw new Error(`Billing sheet ${id} update failed`);
      const items = await tx.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, id));
      return { ...updated, items };
    });
  }

  async updateWorkOrderLaborHours(
    id: number,
    totalHours: number,
    companyId: number | null,
  ): Promise<WorkOrder & { items: WorkOrderItem[] }> {
    return db.transaction(async (tx) => {
      const scope = this._companyScope(companyId);
      const cond = scope ? and(eq(workOrders.id, id), scope) : eq(workOrders.id, id);
      const [wo] = await tx.select().from(workOrders).where(cond);
      if (!wo) throw Object.assign(new Error(`Work order ${id} not found`), { code: "WO_NOT_FOUND" });
      if (wo.status === "billed" || wo.invoiceId != null) {
        throw Object.assign(new Error(`Work order ${id} is locked`), { code: "WO_LOCKED" });
      }
      const laborRate = parseFloat(String(wo.appliedLaborRate ?? wo.laborRate ?? "0")) || 0;
      const laborSubtotal = totalHours * laborRate;
      const partsSubtotal = parseFloat(String(wo.partsSubtotal ?? "0")) || 0;
      const totalAmount = laborSubtotal + partsSubtotal;
      const [updated] = await tx.update(workOrders).set({
        totalHours: totalHours.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(workOrders.id, id)).returning();
      if (!updated) throw new Error(`Work order ${id} update failed`);
      const items = await tx.select().from(workOrderItems).where(eq(workOrderItems.workOrderId, id));
      return { ...updated, items };
    });
  }

  async updateWorkOrderLaborRate(
    id: number,
    laborRate: number,
    companyId: number | null,
  ): Promise<WorkOrder & { items: WorkOrderItem[] }> {
    return db.transaction(async (tx) => {
      const scope = this._companyScope(companyId);
      const cond = scope ? and(eq(workOrders.id, id), scope) : eq(workOrders.id, id);
      const [wo] = await tx.select().from(workOrders).where(cond);
      if (!wo) throw Object.assign(new Error(`Work order ${id} not found`), { code: "WO_NOT_FOUND" });
      if (wo.status === "billed" || wo.invoiceId != null) {
        throw Object.assign(new Error(`Work order ${id} is locked`), { code: "WO_LOCKED" });
      }
      const totalHours = parseFloat(String(wo.totalHours ?? "0")) || 0;
      const laborSubtotal = totalHours * laborRate;
      const partsSubtotal = parseFloat(String(wo.partsSubtotal ?? "0")) || 0;
      const totalAmount = laborSubtotal + partsSubtotal;
      const [updated] = await tx.update(workOrders).set({
        appliedLaborRate: laborRate.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(workOrders.id, id)).returning();
      if (!updated) throw new Error(`Work order ${id} update failed`);
      const items = await tx.select().from(workOrderItems).where(eq(workOrderItems.workOrderId, id));
      return { ...updated, items };
    });
  }

  async deleteWetCheckBilling(id: number): Promise<void> {
    await db.transaction(async (tx) => {
      // Clear finding links before removing the WCB row (FK constraint order).
      await tx
        .update(wetCheckFindings)
        .set({ wetCheckBillingId: null, convertedAt: null, resolution: "pending" })
        .where(eq(wetCheckFindings.wetCheckBillingId, id));
      await tx.delete(wetCheckBillings).where(eq(wetCheckBillings.id, id));
    });
  }

  async createBillingSheet(billingSheetData: InsertBillingSheet & { items?: InsertBillingSheetItem[]; companyId: number }): Promise<BillingSheet> {
    // Extract items from the data
    const { items, ...sheetData } = billingSheetData;
    
    // Calculate totals if they're missing
    let laborSubtotal = Number(sheetData.laborSubtotal || 0);
    let partsSubtotal = Number(sheetData.partsSubtotal || 0);
    let totalAmount = Number(sheetData.totalAmount || 0);

    // If we have items, calculate the totals
    if (items && Array.isArray(items)) {
      partsSubtotal = items.reduce((sum, item) => sum + (money(item.quantity) * money(item.unitPrice)), 0);
      laborSubtotal = Number(sheetData.totalHours || 0) * Number(sheetData.laborRate || 0);
      totalAmount = laborSubtotal + partsSubtotal;
    }

    const finalSheetData = {
      ...sheetData,
      laborSubtotal: laborSubtotal.toString(),
      partsSubtotal: partsSubtotal.toString(),
      totalAmount: totalAmount.toString(),
      workDate: sheetData.workDate ? (sheetData.workDate instanceof Date ? sheetData.workDate : new Date(sheetData.workDate)) : new Date()
    };

    console.log('Creating billing sheet with data:', finalSheetData);

    const MAX_RETRIES = 3;
    let newSheet: BillingSheet | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const billingNumber = await this.getNextBillingNumber();

      const finalSheetDataWithNumber = {
        ...finalSheetData,
        billingNumber
      };

      const { createdAt, updatedAt, ...insertData } = finalSheetDataWithNumber as Record<string, unknown>;

      try {
        const [inserted] = await db.insert(billingSheets).values([toDrizzleInsert<DrizzleBillingSheetInsert>(insertData)]).returning();
        newSheet = inserted;
        break;
      } catch (err: unknown) {
        const errObj = err as Record<string, unknown> | null | undefined;
        const code = typeof errObj?.code === 'string' ? errObj.code : '';
        const message = typeof errObj?.message === 'string' ? errObj.message : '';
        const isUniqueViolation = code === '23505' || message.includes('unique');
        if (isUniqueViolation && attempt < MAX_RETRIES) {
          console.warn(`[billing] Billing number collision on attempt ${attempt} (${billingNumber}), retrying...`);
          continue;
        }
        throw err;
      }
    }

    if (!newSheet) {
      throw new Error('Failed to create billing sheet after max retries');
    }
    
    // If items are provided, insert them and then re-derive partsSubtotal from the persisted rows
    if (items && Array.isArray(items)) {
      let insertedItems: typeof billingSheetItems.$inferSelect[] = [];
      if (items.length > 0) {
        const values = items.map(item => ({
          ...item,
          billingSheetId: newSheet.id,
          totalPrice: (money(item.quantity) * money(item.unitPrice)).toFixed(2),
        }));
        insertedItems = await db.insert(billingSheetItems).values(values).returning();
      }

      // Derive partsSubtotal from what was actually written — not from request data
      const truePartsSubtotal = insertedItems.reduce(
        (sum, row) => sum + parseFloat(String(row.totalPrice || 0)),
        0
      );
      const trueLaborSubtotal = parseFloat(String(newSheet.laborSubtotal || 0));
      const trueTotalAmount = trueLaborSubtotal + truePartsSubtotal;

      const [correctedSheet] = await db
        .update(billingSheets)
        .set({
          partsSubtotal: truePartsSubtotal.toFixed(2),
          totalAmount: trueTotalAmount.toFixed(2),
        })
        .where(eq(billingSheets.id, newSheet.id))
        .returning();

      console.log(
        `[AUDIT] billing_sheet_created_partsSubtotal_verified billingSheetId=${newSheet.id} ` +
        `partsSubtotal=${truePartsSubtotal.toFixed(2)} totalAmount=${trueTotalAmount.toFixed(2)}`
      );
      return correctedSheet;
    }
    
    return newSheet;
  }

  async updateBillingSheet(id: number, billingSheetData: Partial<InsertBillingSheet>): Promise<BillingSheet | undefined> {
    // Task #1238 — auto-clear returnedForCorrectionAt when the tech resubmits
    // (status transitions to pending_manager_review, submitted, or completed).
    const clearTimestamp =
      billingSheetData.status === "pending_manager_review" ||
      billingSheetData.status === "submitted" ||
      billingSheetData.status === "completed";
    const payload = clearTimestamp
      ? { ...billingSheetData, returnedForCorrectionAt: null }
      : billingSheetData;
    const [updatedSheet] = await db.update(billingSheets).set(payload).where(eq(billingSheets.id, id)).returning();
    return updatedSheet || undefined;
  }

  async markBillingSheetNoPhotosNeeded(sheetId: number, userId: number): Promise<BillingSheet | undefined> {
    const [updated] = await db.update(billingSheets)
      .set({
        noPhotosNeeded: true,
        noPhotosNeededBy: userId,
        noPhotosNeededAt: new Date(),
      })
      .where(eq(billingSheets.id, sheetId))
      .returning();
    return updated || undefined;
  }

  // Task #752 (WC Billing Slice 3) — zone-grouped view assembler
  async getBillingSheetWetCheckView(
    billingSheetId: number,
    _companyId: number | null,
  ): Promise<import("./wet-check-billing-view").WetCheckBillingView | null> {
    const { buildWetCheckBillingView } = await import("./wet-check-billing-view");

    // 1. Load findings that are routed to this billing sheet
    const findings = await db
      .select()
      .from(wetCheckFindings)
      .where(eq(wetCheckFindings.billingSheetId, billingSheetId));

    if (findings.length === 0) {
      // No wet-check findings → this is not a WC billing sheet
      return null;
    }

    // 2. Load the billing sheet itself
    const [bs] = await db
      .select()
      .from(billingSheets)
      .where(eq(billingSheets.id, billingSheetId));
    if (!bs) return null;

    // 3. Load the wet check (all findings share the same wetCheckId)
    const wetCheckId = findings[0].wetCheckId;
    const [wc] = await db
      .select()
      .from(wetChecks)
      .where(eq(wetChecks.id, wetCheckId));
    if (!wc) return null;

    // 4. Load zone records for every zoneRecordId referenced by findings
    const zoneRecordIds = [...new Set(findings.map((f) => f.zoneRecordId))];
    const zoneRecords = await db
      .select()
      .from(wetCheckZoneRecords)
      .where(inArray(wetCheckZoneRecords.id, zoneRecordIds));

    // ── Observability: detect forgotten backfill rows ─────────────────────
    // If a zone has repair_labor_hours=0 but its findings carry a non-zero
    // per-finding laborHours sum, the Slice 4 backfill script was likely not
    // run against this record. The billing total will be under-counted.
    // This warn is a canary for ops to spot rows that slipped past the
    // one-time backfill.
    for (const zr of zoneRecords) {
      const zoneFindings = findings.filter((f) => f.zoneRecordId === zr.id);
      const findingLaborSum = zoneFindings.reduce(
        (s, f) => s + parseFloat(String(f.laborHours ?? "0")),
        0,
      );
      const repairLaborHoursNum = parseFloat(String(zr.repairLaborHours ?? "0"));
      if (repairLaborHoursNum === 0 && findingLaborSum > 0) {
        console.warn(
          JSON.stringify({
            event: "wcv.backfill_gap",
            billingSheetId,
            wetCheckId: wc.id,
            zoneRecordId: zr.id,
            controllerLetter: zr.controllerLetter,
            zoneNumber: zr.zoneNumber,
            findingLaborHoursSum: findingLaborSum,
            message:
              "zone.repair_labor_hours is 0 but findings have non-zero laborHours — run the wet_check_billings migration tool",
          }),
        );
      }
    }

    // 5. Load issueTypeConfigs for the company (from the wet check)
    const configs = await db
      .select()
      .from(issueTypeConfigs)
      .where(eq(issueTypeConfigs.companyId, wc.companyId))
      .orderBy(issueTypeConfigs.sortOrder);

    // 6. Load customer
    if (!bs.customerId) return null;
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, bs.customerId));
    if (!customer) return null;

    // 6b. Load photos for in-app grouped display
    const photos = await this.getWetCheckPhotosGrouped(wc.id);

    // Slice 4c — legacy BS-WC path has no WCB row; pass wcb: undefined so
    // buildWetCheckBillingView falls back to the live-derive totals path.
    const view = buildWetCheckBillingView({
      billingSheet: bs,
      customer,
      findings,
      zoneRecords,
      wetCheck: wc,
      photos,
      issueTypeConfigs: configs,
      wcb: undefined,
    });

    // If the findings carry a wetCheckBillingId (findings routed through the
    // WCB flow), surface it so the frontend can target the correct rate-mode
    // endpoint (`/api/wet-check-billings/:id/rate-mode`) rather than the
    // billing-sheet one.
    const wcbIdFromFindings = findings[0]?.wetCheckBillingId ?? null;
    if (wcbIdFromFindings != null) {
      return { ...view, wetCheckBillingId: wcbIdFromFindings };
    }
    return view;
  }

  // Task #787 (WC Separate System Slice 2) — zone-grouped view assembler for
  // the wet_check_billings table path. Mirrors getBillingSheetWetCheckView but
  // sources the billing header from `wet_check_billings` and filters findings
  // by `wetCheckBillingId`. Returns null when the WCB row is missing, has no
  // findings, or the parent wet check / customer cannot be resolved.
  async getWetCheckBillingViewById(
    wcbId: number,
    _companyId: number | null,
  ): Promise<import("./wet-check-billing-view").WetCheckBillingView | null> {
    const { buildWetCheckBillingView } = await import("./wet-check-billing-view");

    // 1. Load the wet_check_billing row
    const [wcb] = await db
      .select()
      .from(wetCheckBillings)
      .where(eq(wetCheckBillings.id, wcbId));
    if (!wcb) return null;

    // 2. Load findings filtered by wetCheckBillingId (not billingSheetId)
    const findings = await db
      .select()
      .from(wetCheckFindings)
      .where(eq(wetCheckFindings.wetCheckBillingId, wcbId));

    if (findings.length === 0) {
      return null;
    }

    // 3. Load the wet check via wcb.wetCheckId
    const [wc] = await db
      .select()
      .from(wetChecks)
      .where(eq(wetChecks.id, wcb.wetCheckId));
    if (!wc) return null;

    // 4. Load zone records for every zoneRecordId referenced by findings
    const zoneRecordIds = [...new Set(findings.map((f) => f.zoneRecordId))];
    const zoneRecords = await db
      .select()
      .from(wetCheckZoneRecords)
      .where(inArray(wetCheckZoneRecords.id, zoneRecordIds));

    // ── Observability: detect forgotten backfill rows ─────────────────────
    for (const zr of zoneRecords) {
      const zoneFindings = findings.filter((f) => f.zoneRecordId === zr.id);
      const findingLaborSum = zoneFindings.reduce(
        (s, f) => s + parseFloat(String(f.laborHours ?? "0")),
        0,
      );
      const repairLaborHoursNum = parseFloat(String(zr.repairLaborHours ?? "0"));
      if (repairLaborHoursNum === 0 && findingLaborSum > 0) {
        console.warn(
          JSON.stringify({
            event: "wcv.backfill_gap",
            wetCheckBillingId: wcbId,
            wetCheckId: wc.id,
            zoneRecordId: zr.id,
            controllerLetter: zr.controllerLetter,
            zoneNumber: zr.zoneNumber,
            findingLaborHoursSum: findingLaborSum,
            message:
              "zone.repair_labor_hours is 0 but findings have non-zero laborHours — run the WCB backfill script",
          }),
        );
      }
    }

    // 5. Load issueTypeConfigs for the company (from the wet check)
    const configs = await db
      .select()
      .from(issueTypeConfigs)
      .where(eq(issueTypeConfigs.companyId, wc.companyId))
      .orderBy(issueTypeConfigs.sortOrder);

    // 6. Load customer
    if (!wcb.customerId) return null;
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, wcb.customerId));
    if (!customer) return null;

    // 6b. Load photos for the wet check (zone/finding linkage for in-app grouped display)
    const photos = await this.getWetCheckPhotosGrouped(wc.id);

    // 7. Build the view using wcb cast to the shape buildWetCheckBillingView
    //    needs. Only `id`, `billingNumber`, `workDate`, `appliedLaborRate`, and
    //    `laborRate` are read from the billingSheet parameter — WetCheckBilling
    //    carries all of those fields.
    // Slice 4c — pass wcb snapshot so buildWetCheckBillingView uses
    // snapshot-first totals instead of re-deriving from zone records.
    const viewRaw = buildWetCheckBillingView({
      billingSheet: wcb as unknown as import("@workspace/db").BillingSheet,
      customer,
      findings,
      zoneRecords,
      wetCheck: wc,
      issueTypeConfigs: configs,
      photos,
      wcb: {
        partsSubtotal: wcb.partsSubtotal,
        laborSubtotal: wcb.laborSubtotal,
        totalAmount: wcb.totalAmount,
      },
    });

    // Replace billingSheetId (set to wcb.id by buildWetCheckBillingView) with
    // wetCheckBillingId; leave billingSheetId undefined on the WCB path.
    const { billingSheetId: _ignored, ...viewRest } = viewRaw;
    return { ...viewRest, wetCheckBillingId: wcb.id };
  }

  async deleteBillingSheet(id: number): Promise<boolean> {
    // Refuse to delete a sheet that has already been pushed onto an
    // invoice. Two ways a sheet can be "on an invoice":
    //   1. billing_sheets.invoiceId is set (legacy single-invoice link), or
    //   2. one or more invoice_items rows reference it (the current model).
    // Either case would either orphan the invoice line items or strand
    // the customer's invoice without a source-of-truth, so we surface a
    // typed error that the route layer maps to a 409 with a friendly
    // message instead of letting Postgres throw a FK violation.
    const [sheet] = await db.select().from(billingSheets).where(eq(billingSheets.id, id));
    if (!sheet) return false;
    if (sheet.invoiceId != null) {
      const [inv] = await db.select({ invoiceNumber: invoices.invoiceNumber })
        .from(invoices)
        .where(eq(invoices.id, sheet.invoiceId));
      throw new BillingSheetInvoicedError(sheet.invoiceId, inv?.invoiceNumber ?? null);
    }
    const linkedItems = await db.select({
      id: invoiceItems.id,
      invoiceId: invoiceItems.invoiceId,
    }).from(invoiceItems).where(eq(invoiceItems.billingSheetId, id)).limit(1);
    if (linkedItems.length > 0) {
      const linkedInvoiceId = linkedItems[0].invoiceId ?? null;
      let invoiceNumber: string | null = null;
      if (linkedInvoiceId != null) {
        const [inv] = await db.select({ invoiceNumber: invoices.invoiceNumber })
          .from(invoices)
          .where(eq(invoices.id, linkedInvoiceId));
        invoiceNumber = inv?.invoiceNumber ?? null;
      }
      throw new BillingSheetInvoicedError(linkedInvoiceId, invoiceNumber);
    }

    // Single transaction so a partial delete can't leave orphan rows
    // pointing at a billing_sheets row that no longer exists. Order:
    //   1. Null out wet_check_findings.billingSheetId (audit history is
    //      preserved on the finding; only the routing pointer is cleared).
    //   2. Delete manual_part_reviews (notNull FK; the review is per-sheet
    //      so it has no meaning once the sheet is gone, mirroring how
    //      billing_sheet_items get hard-deleted alongside the sheet).
    //   3. Delete billing_sheet_items (existing behavior).
    //   4. Delete the billing_sheets row.
    // pricing_audit_events references sheets by (source, parentId) without
    // a real FK, so it intentionally retains the audit trail after delete
    // — same as deleteWorkOrder leaves it untouched.
    return await db.transaction(async (tx) => {
      await tx.update(wetCheckFindings)
        .set({ billingSheetId: null })
        .where(eq(wetCheckFindings.billingSheetId, id));
      await tx.delete(manualPartReviews).where(eq(manualPartReviews.billingSheetId, id));
      await tx.delete(billingSheetItems).where(eq(billingSheetItems.billingSheetId, id));
      const result = await tx.delete(billingSheets).where(eq(billingSheets.id, id));
      return (result.rowCount || 0) > 0;
    });
  }

  // Task #1422 — single invoice-propagation seam. When a billing sheet that
  // is already attached to an invoice has its line items changed, fold the
  // parts/total delta into the parent invoice so the sheet and its invoice can
  // never silently drift — that drift is what trips the PDF reconciliation
  // guard. Mirrors the reprice propagation pattern (repriceBillingSheetItems,
  // invoice branch).
  private async _propagateBillingSheetDeltaToInvoiceTx(
    tx: DbExecutor,
    invoiceId: number,
    partsDelta: number,
    totalDelta: number,
  ): Promise<void> {
    if (Math.abs(partsDelta) < 0.005 && Math.abs(totalDelta) < 0.005) return;
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!inv) return;
    const newParts = (parseFloat(String(inv.partsSubtotal ?? 0)) || 0) + partsDelta;
    const newTotal = (parseFloat(String(inv.totalAmount ?? 0)) || 0) + totalDelta;
    await tx.update(invoices).set({
      partsSubtotal: newParts.toFixed(2),
      totalAmount: newTotal.toFixed(2),
      updatedAt: new Date(),
    }).where(eq(invoices.id, invoiceId));
    console.log(
      `[AUDIT] invoice_total_propagated invoiceId=${invoiceId} ` +
      `partsDelta=${partsDelta.toFixed(2)} totalDelta=${totalDelta.toFixed(2)} ` +
      `newPartsSubtotal=${newParts.toFixed(2)} newTotalAmount=${newTotal.toFixed(2)}`,
    );
  }

  // Task #1422 — recompute a billing sheet's parts/labor/total from its
  // persisted line items inside an existing transaction, persist the sheet,
  // and propagate the delta to the parent invoice when the sheet is invoiced.
  // The raw item mutators all route through here so an edit can never leave
  // the sheet (or its invoice) out of sync.
  private async _resyncBillingSheetTotalsTx(
    tx: DbExecutor,
    billingSheetId: number,
  ): Promise<{ partsSubtotal: string; laborSubtotal: string; totalAmount: string }> {
    const [bs] = await tx.select().from(billingSheets).where(eq(billingSheets.id, billingSheetId));
    if (!bs) {
      throw Object.assign(new Error(`Billing sheet ${billingSheetId} not found`), { code: "BS_NOT_FOUND" });
    }
    const rows = await tx.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, billingSheetId));
    const newParts = rows.reduce((s, r) => s + parseFloat(String(r.totalPrice || 0)), 0);

    const laborRate = parseFloat(String(bs.appliedLaborRate ?? bs.laborRate ?? "0")) || 0;
    let newLabor: number;
    let newTotalHours: number | undefined;
    if (bs.laborMode === "per_part") {
      newTotalHours = rows.reduce((s, r) => s + parseFloat(String(r.laborHours || 0)), 0);
      newLabor = newTotalHours * laborRate;
    } else {
      const totalHours = parseFloat(String(bs.totalHours ?? "0")) || 0;
      newLabor = totalHours * laborRate;
    }
    const newTotal = newParts + newLabor;

    const oldParts = parseFloat(String(bs.partsSubtotal ?? 0)) || 0;
    const oldTotal = parseFloat(String(bs.totalAmount ?? 0)) || 0;

    await tx.update(billingSheets).set({
      partsSubtotal: newParts.toFixed(2),
      laborSubtotal: newLabor.toFixed(2),
      totalAmount: newTotal.toFixed(2),
      ...(newTotalHours !== undefined ? { totalHours: newTotalHours.toFixed(2) } : {}),
      updatedAt: new Date(),
    }).where(eq(billingSheets.id, billingSheetId));

    if (bs.invoiceId != null) {
      await this._propagateBillingSheetDeltaToInvoiceTx(tx, bs.invoiceId, newParts - oldParts, newTotal - oldTotal);
    }

    return {
      partsSubtotal: newParts.toFixed(2),
      laborSubtotal: newLabor.toFixed(2),
      totalAmount: newTotal.toFixed(2),
    };
  }

  async addBillingSheetItem(billingSheetId: number, item: InsertBillingSheetItem): Promise<BillingSheetItem> {
    return db.transaction(async (tx) => {
      const [newItem] = await tx.insert(billingSheetItems).values({
        ...item,
        billingSheetId,
        totalPrice: (money(item.quantity) * money(item.unitPrice)).toFixed(2)
      }).returning();
      await this._resyncBillingSheetTotalsTx(tx, billingSheetId);
      return newItem;
    });
  }

  async updateBillingSheetItem(itemId: number, item: Partial<InsertBillingSheetItem>): Promise<BillingSheetItem | undefined> {
    return db.transaction(async (tx) => {
      const updateData = { ...item };
      if (item.quantity && item.unitPrice) {
        updateData.totalPrice = (money(item.quantity) * money(item.unitPrice)).toFixed(2);
      }

      const [updatedItem] = await tx.update(billingSheetItems).set(updateData).where(eq(billingSheetItems.id, itemId)).returning();
      if (!updatedItem) return undefined;
      if (updatedItem.billingSheetId != null) {
        await this._resyncBillingSheetTotalsTx(tx, updatedItem.billingSheetId);
      }
      return updatedItem;
    });
  }

  async deleteBillingSheetItem(itemId: number): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(billingSheetItems).where(eq(billingSheetItems.id, itemId));
      if (!existing) return false;
      const result = await tx.delete(billingSheetItems).where(eq(billingSheetItems.id, itemId));
      if (existing.billingSheetId != null) {
        await this._resyncBillingSheetTotalsTx(tx, existing.billingSheetId);
      }
      return (result.rowCount || 0) > 0;
    });
  }

  async deleteBillingSheetItems(billingSheetId: number): Promise<boolean> {
    return db.transaction(async (tx) => {
      const result = await tx.delete(billingSheetItems).where(eq(billingSheetItems.billingSheetId, billingSheetId));
      await this._resyncBillingSheetTotalsTx(tx, billingSheetId);
      return result.rowCount !== null;
    });
  }

  async replaceBillingSheetItemsInTransaction(billingSheetId: number, items: InsertBillingSheetItem[]): Promise<BillingSheetItem[]> {
    return await db.transaction(async (tx) => {
      await tx.delete(billingSheetItems).where(eq(billingSheetItems.billingSheetId, billingSheetId));
      let inserted: typeof billingSheetItems.$inferSelect[] = [];
      if (items.length > 0) {
        const values = items.map(item => ({
          ...item,
          billingSheetId,
          totalPrice: (money(item.quantity) * money(item.unitPrice)).toFixed(2),
        }));
        inserted = await tx.insert(billingSheetItems).values(values).returning();
      }
      await this._resyncBillingSheetTotalsTx(tx, billingSheetId);
      return inserted;
    });
  }

  // Atomically replaces billing sheet items AND resyncs partsSubtotal/totalAmount on the sheet record
  // within a single DB transaction — preventing any window where items and subtotals are out of sync.
  async replaceBillingSheetItemsAndResync(
    billingSheetId: number,
    items: InsertBillingSheetItem[]
  ): Promise<{ items: BillingSheetItem[]; partsSubtotal: string; totalAmount: string }> {
    return await db.transaction(async (tx) => {
      await tx.delete(billingSheetItems).where(eq(billingSheetItems.billingSheetId, billingSheetId));

      let inserted: typeof billingSheetItems.$inferSelect[] = [];
      if (items.length > 0) {
        const values = items.map(item => ({
          ...item,
          billingSheetId,
          totalPrice: (money(item.quantity) * money(item.unitPrice)).toFixed(2),
        }));
        inserted = await tx.insert(billingSheetItems).values(values).returning();
      }

      // Derive partsSubtotal from the rows that were just persisted
      const truePartsSubtotal = inserted.reduce(
        (sum, row) => sum + parseFloat(String(row.totalPrice || 0)),
        0
      );

      // Read the current sheet inside the same transaction. laborSubtotal is
      // preserved (the surrounding PATCH stamps it before items are replaced);
      // the old parts/total + invoiceId drive Task #1422 invoice propagation.
      const [currentSheet] = await tx
        .select({
          laborSubtotal: billingSheets.laborSubtotal,
          partsSubtotal: billingSheets.partsSubtotal,
          totalAmount: billingSheets.totalAmount,
          invoiceId: billingSheets.invoiceId,
        })
        .from(billingSheets)
        .where(eq(billingSheets.id, billingSheetId));
      const laborSubtotal = parseFloat(String(currentSheet?.laborSubtotal || 0));
      const oldParts = parseFloat(String(currentSheet?.partsSubtotal || 0));
      const oldTotal = parseFloat(String(currentSheet?.totalAmount || 0));
      const trueTotalAmount = laborSubtotal + truePartsSubtotal;

      await tx
        .update(billingSheets)
        .set({
          partsSubtotal: truePartsSubtotal.toFixed(2),
          totalAmount: trueTotalAmount.toFixed(2),
        })
        .where(eq(billingSheets.id, billingSheetId));

      // Task #1422 — keep an attached invoice in lockstep with the sheet so a
      // line-item edit on an invoiced sheet can't silently desync the invoice.
      if (currentSheet?.invoiceId != null) {
        await this._propagateBillingSheetDeltaToInvoiceTx(
          tx,
          currentSheet.invoiceId,
          truePartsSubtotal - oldParts,
          trueTotalAmount - oldTotal,
        );
      }

      return {
        items: inserted,
        partsSubtotal: truePartsSubtotal.toFixed(2),
        totalAmount: trueTotalAmount.toFixed(2),
      };
    });
  }

  async getBillingSheetItems(billingSheetId: number): Promise<BillingSheetItem[]> {
    return await db.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, billingSheetId));
  }

  // ─── Catalog $0-price audit / backfill (Tasks #160 + #161) ─────────────────
  // Covers billing_sheet_items, work_order_items, AND invoice_items. A "bad"
  // row is any line item with a non-null partId whose stored unit price is 0
  // while the catalog row reports a price > 0. Scoping is by parts.company_id
  // (the catalog is the authoritative source of truth).
  async getZeroPriceCatalogItems(companyId: number | null) {
    const billingRows = await db.execute(sql`
      SELECT
        'billing_sheet'::text AS source,
        bsi.id              AS item_id,
        bsi.billing_sheet_id AS parent_id,
        bs.billing_number   AS parent_number,
        bs.customer_id      AS customer_id,
        bs.customer_name    AS customer_name,
        bs.work_date        AS work_date,
        bs.technician_name  AS technician_name,
        bs.status           AS status,
        bs.invoice_id       AS invoice_id,
        bsi.part_id         AS part_id,
        bsi.part_name       AS part_name,
        bsi.quantity        AS quantity,
        bsi.unit_price      AS stored_unit_price,
        bsi.total_price     AS stored_total_price,
        p.price             AS catalog_unit_price
      FROM billing_sheet_items bsi
      INNER JOIN parts p           ON p.id = bsi.part_id
      INNER JOIN billing_sheets bs ON bs.id = bsi.billing_sheet_id
      WHERE bsi.part_id IS NOT NULL
        AND CAST(bsi.unit_price AS DOUBLE PRECISION) = 0
        AND CAST(p.price AS DOUBLE PRECISION) > 0
        AND (${companyId}::int IS NULL OR p.company_id = ${companyId}::int)
    `);

    const workOrderRows = await db.execute(sql`
      SELECT
        'work_order'::text   AS source,
        woi.id               AS item_id,
        woi.work_order_id    AS parent_id,
        wo.work_order_number AS parent_number,
        wo.customer_id       AS customer_id,
        wo.customer_name     AS customer_name,
        wo.scheduled_date    AS work_date,
        wo.assigned_technician_name AS technician_name,
        wo.status            AS status,
        wo.invoice_id        AS invoice_id,
        woi.part_id          AS part_id,
        woi.part_name        AS part_name,
        woi.quantity         AS quantity,
        woi.part_price       AS stored_unit_price,
        woi.total_price      AS stored_total_price,
        p.price              AS catalog_unit_price
      FROM work_order_items woi
      INNER JOIN parts p        ON p.id = woi.part_id
      INNER JOIN work_orders wo ON wo.id = woi.work_order_id
      WHERE woi.part_id IS NOT NULL
        AND CAST(woi.part_price AS DOUBLE PRECISION) = 0
        AND CAST(p.price AS DOUBLE PRECISION) > 0
        AND (${companyId}::int IS NULL OR p.company_id = ${companyId}::int)
    `);

    const invoiceRows = await db.execute(sql`
      SELECT
        'invoice'::text       AS source,
        ii.id                 AS item_id,
        ii.invoice_id         AS parent_id,
        inv.invoice_number    AS parent_number,
        inv.customer_id       AS customer_id,
        inv.customer_name     AS customer_name,
        ii.work_date          AS work_date,
        ''::text              AS technician_name,
        inv.status            AS status,
        ii.invoice_id         AS invoice_id,
        inv.quickbooks_invoice_id AS quickbooks_invoice_id,
        ii.part_id            AS part_id,
        ii.part_name          AS part_name,
        ii.quantity           AS quantity,
        ii.unit_price         AS stored_unit_price,
        ii.total_price        AS stored_total_price,
        p.price               AS catalog_unit_price
      FROM invoice_items ii
      INNER JOIN parts p        ON p.id = ii.part_id
      INNER JOIN invoices inv   ON inv.id = ii.invoice_id
      WHERE ii.part_id IS NOT NULL
        AND CAST(ii.unit_price AS DOUBLE PRECISION) = 0
        AND CAST(p.price AS DOUBLE PRECISION) > 0
        AND (${companyId}::int IS NULL OR p.company_id = ${companyId}::int)
    `);

    const merged = [...billingRows.rows, ...workOrderRows.rows, ...invoiceRows.rows] as Array<Record<string, unknown>>;
    return merged
      .map((r) => {
        const quantity = parseFloat(String(r.quantity ?? 0));
        const catalogPrice = parseFloat(String(r.catalog_unit_price ?? 0));
        const storedTotal = parseFloat(String(r.stored_total_price ?? 0));
        const expectedTotal = quantity * catalogPrice;
        const workDate = r.work_date
          ? (r.work_date instanceof Date ? r.work_date : new Date(String(r.work_date)))
          : null;
        return {
          source: r.source as 'billing_sheet' | 'work_order' | 'invoice',
          itemId: Number(r.item_id),
          parentId: Number(r.parent_id),
          parentNumber: String(r.parent_number ?? ''),
          customerId: r.customer_id == null ? null : Number(r.customer_id),
          customerName: String(r.customer_name ?? ''),
          workDate,
          technicianName: String(r.technician_name ?? ''),
          status: String(r.status ?? ''),
          invoiceId: r.invoice_id == null ? null : Number(r.invoice_id),
          quickbooksInvoiceId: r.quickbooks_invoice_id == null ? null : String(r.quickbooks_invoice_id),
          partId: Number(r.part_id),
          partName: String(r.part_name ?? ''),
          quantity: String(r.quantity ?? '0'),
          storedUnitPrice: String(r.stored_unit_price ?? '0'),
          storedTotalPrice: String(r.stored_total_price ?? '0'),
          catalogUnitPrice: String(r.catalog_unit_price ?? '0'),
          expectedTotalPrice: expectedTotal.toFixed(2),
          difference: (expectedTotal - storedTotal).toFixed(2),
        };
      })
      .sort((a, b) => {
        // Most recent first; rows without a work date go to the bottom.
        const ta = a.workDate ? a.workDate.getTime() : 0;
        const tb = b.workDate ? b.workDate.getTime() : 0;
        if (tb !== ta) return tb - ta;
        return b.parentId - a.parentId;
      });
  }

  async repriceBillingSheetItems(
    selection: Array<{ source: 'billing_sheet' | 'work_order' | 'invoice'; itemId: number }>,
    companyId: number | null,
    options: { dryRun: boolean; performedByUserId: number | null; performedByName: string | null }
  ) {
    const allBad = await this.getZeroPriceCatalogItems(companyId);
    const selectionKey = (s: 'billing_sheet' | 'work_order' | 'invoice', id: number) => `${s}:${id}`;
    const wantSet = new Set(selection.map((s) => selectionKey(s.source, s.itemId)));
    const targets = selection.length === 0
      ? allBad
      : allBad.filter((row) => wantSet.has(selectionKey(row.source, row.itemId)));

    // Group by parent (sheet, work order, or invoice) so subtotals are recomputed once each.
    const byParent = new Map<string, typeof targets>();
    for (const row of targets) {
      const k = `${row.source}:${row.parentId}`;
      const arr = byParent.get(k) ?? [];
      arr.push(row);
      byParent.set(k, arr);
    }

    type ParentSummary = {
      source: 'billing_sheet' | 'work_order' | 'invoice';
      parentId: number;
      parentNumber: string;
      oldPartsSubtotal: string;
      newPartsSubtotal: string;
      oldTotalAmount: string;
      newTotalAmount: string;
      // Task #173: surface a heads-up when an invoice repair touches an
      // already-paid invoice or one that has been pushed to QuickBooks so
      // the operator knows to also fix the customer-facing copy in QBO.
      invoicePaid?: boolean;
      sentToQuickBooks?: boolean;
      updatedItems: Array<{
        itemId: number;
        partName: string;
        oldUnitPrice: string;
        newUnitPrice: string;
        oldTotalPrice: string;
        newTotalPrice: string;
      }>;
    };
    const parentSummaries: ParentSummary[] = [];
    let grandDifference = 0;
    let totalItemCount = 0;

    // Task #210: removed `stamp` (was used to prefix audit text written into
    // `notes`). Audit lines now live only in `[AUDIT]` console logs.
    const actor = options.performedByName ?? (options.performedByUserId ? `user#${options.performedByUserId}` : 'admin');

    // Task #212: resolve actor user once. If the id doesn't reference a real
    // user (test fixtures, deleted accounts), null it out so the FK insert
    // into pricing_audit_events doesn't blow up the whole repair transaction.
    let effectiveActorUserId: number | null = options.performedByUserId ?? null;
    if (effectiveActorUserId != null) {
      const u = await this.getUser(effectiveActorUserId).catch(() => null);
      if (!u) effectiveActorUserId = null;
    }

    type ZeroPriceRow = typeof allBad[number];
    for (const rows of Array.from(byParent.values()) as ZeroPriceRow[][]) {
      const sample = rows[0];
      if (!sample) continue;
      const updatedItems = rows.map((r: ZeroPriceRow) => ({
        itemId: r.itemId,
        partName: r.partName,
        oldUnitPrice: parseFloat(r.storedUnitPrice).toFixed(2),
        newUnitPrice: parseFloat(r.catalogUnitPrice).toFixed(2),
        oldTotalPrice: parseFloat(r.storedTotalPrice).toFixed(2),
        newTotalPrice: parseFloat(r.expectedTotalPrice).toFixed(2),
      }));
      const parentDifference = rows.reduce(
        (sum: number, r: ZeroPriceRow) => sum + parseFloat(r.difference),
        0,
      );

      if (sample.source === 'billing_sheet') {
        const sheetId = sample.parentId;
        const [sheet] = await db.select().from(billingSheets).where(eq(billingSheets.id, sheetId));
        if (!sheet) continue;
        const oldPartsSubtotal = parseFloat(String(sheet.partsSubtotal ?? 0));
        const oldTotalAmount = parseFloat(String(sheet.totalAmount ?? 0));
        const oldLaborSubtotal = parseFloat(String(sheet.laborSubtotal ?? 0));
        const newPartsSubtotal = oldPartsSubtotal + parentDifference;
        const newTotalAmount = oldLaborSubtotal + newPartsSubtotal;

        parentSummaries.push({
          source: 'billing_sheet',
          parentId: sheetId,
          parentNumber: sheet.billingNumber,
          oldPartsSubtotal: oldPartsSubtotal.toFixed(2),
          newPartsSubtotal: newPartsSubtotal.toFixed(2),
          oldTotalAmount: oldTotalAmount.toFixed(2),
          newTotalAmount: newTotalAmount.toFixed(2),
          updatedItems,
        });
        grandDifference += parentDifference;
        totalItemCount += rows.length;

        if (!options.dryRun) {
          await db.transaction(async (tx) => {
            for (const r of rows) {
              await tx.update(billingSheetItems)
                .set({
                  unitPrice: parseFloat(r.catalogUnitPrice).toFixed(2),
                  totalPrice: parseFloat(r.expectedTotalPrice).toFixed(2),
                })
                .where(eq(billingSheetItems.id, r.itemId));
            }
            const refreshedItems = await tx.select().from(billingSheetItems)
              .where(eq(billingSheetItems.billingSheetId, sheetId));
            const truePartsSubtotal = refreshedItems.reduce(
              (sum, item) => sum + parseFloat(String(item.totalPrice ?? 0)),
              0,
            );
            const trueTotal = oldLaborSubtotal + truePartsSubtotal;
            // Task #210: do NOT write the audit note into billing_sheets.notes.
            // That column is shown to managers in the UI and previously leaked
            // into the customer-facing PDF "WORK PERFORMED" section. The audit
            // trail still lives in the [AUDIT] log line below.
            await tx.update(billingSheets)
              .set({
                partsSubtotal: truePartsSubtotal.toFixed(2),
                totalAmount: trueTotal.toFixed(2),
              })
              .where(eq(billingSheets.id, sheetId));
            // Task #212: structured audit event so managers can see this in
            // the History panel on the billing-sheet detail view.
            await tx.insert(pricingAuditEvents).values({
              companyId: companyId ?? null,
              source: 'billing_sheet',
              parentId: sheetId,
              parentNumber: sheet.billingNumber,
              kind: 'catalog_reprice',
              delta: parentDifference.toFixed(2),
              itemCount: rows.length,
              actorUserId: effectiveActorUserId,
              actorName: options.performedByName ?? null,
              details: {
                oldPartsSubtotal: oldPartsSubtotal.toFixed(2),
                newPartsSubtotal: truePartsSubtotal.toFixed(2),
                oldTotalAmount: oldTotalAmount.toFixed(2),
                newTotalAmount: trueTotal.toFixed(2),
                items: updatedItems,
              },
            });
            console.log(
              `[AUDIT] billing_sheet_repriced billingSheetId=${sheetId} billingNumber=${sheet.billingNumber} ` +
              `itemCount=${rows.length} delta=${parentDifference.toFixed(2)} ` +
              `newPartsSubtotal=${truePartsSubtotal.toFixed(2)} newTotalAmount=${trueTotal.toFixed(2)} actor=${actor}`
            );
          });
        }
      } else if (sample.source === 'work_order') {
        const workOrderId = sample.parentId;
        const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, workOrderId));
        if (!wo) continue;
        const oldPartsSubtotal = parseFloat(String(wo.partsSubtotal ?? wo.totalPartsCost ?? 0));
        const oldTotalAmount = parseFloat(String(wo.totalAmount ?? 0));

        parentSummaries.push({
          source: 'work_order',
          parentId: workOrderId,
          parentNumber: wo.workOrderNumber,
          oldPartsSubtotal: oldPartsSubtotal.toFixed(2),
          // We will report the recomputed totals after the transaction; for the
          // dry-run case we approximate them by adding the delta.
          newPartsSubtotal: (oldPartsSubtotal + parentDifference).toFixed(2),
          oldTotalAmount: oldTotalAmount.toFixed(2),
          newTotalAmount: (oldTotalAmount + parentDifference).toFixed(2),
          updatedItems,
        });
        grandDifference += parentDifference;
        totalItemCount += rows.length;

        if (!options.dryRun) {
          await db.transaction(async (tx) => {
            for (const r of rows) {
              await tx.update(workOrderItems)
                .set({
                  partPrice: parseFloat(r.catalogUnitPrice).toFixed(2),
                  totalPrice: parseFloat(r.expectedTotalPrice).toFixed(2),
                })
                .where(eq(workOrderItems.id, r.itemId));
            }
            const refreshedItems = await tx.select().from(workOrderItems)
              .where(eq(workOrderItems.workOrderId, workOrderId));
            const truePartsCost = refreshedItems.reduce(
              (sum, item) => sum + parseFloat(String(item.totalPrice ?? 0)),
              0,
            );

            // Recompute the work-order financial breakdown using its snapshotted
            // applied rates (matches the live PATCH behaviour). If the snapshot
            // is missing applied rates (legacy record), only update totalPartsCost
            // and append the audit note.
            const updates: Record<string, string> = {
              totalPartsCost: truePartsCost.toFixed(2),
            };
            const snappedLabor = parseFloat(String(wo.appliedLaborRate ?? ''));
            if (Number.isFinite(snappedLabor)) {
              const hrs = parseFloat(String(wo.totalHours ?? '0'));
              const laborSub = hrs * snappedLabor;
              const total = laborSub + truePartsCost;
              updates.laborSubtotal = laborSub.toFixed(2);
              updates.partsSubtotal = truePartsCost.toFixed(2);
              updates.totalAmount = total.toFixed(2);
            }

            // Task #210: do NOT write the audit note into work_orders.notes.
            // The [AUDIT] log line below preserves the audit trail in server logs.
            await tx.update(workOrders).set(updates).where(eq(workOrders.id, workOrderId));
            // Task #212: structured audit event for the History panel.
            await tx.insert(pricingAuditEvents).values({
              companyId: companyId ?? null,
              source: 'work_order',
              parentId: workOrderId,
              parentNumber: wo.workOrderNumber,
              kind: 'catalog_reprice',
              delta: parentDifference.toFixed(2),
              itemCount: rows.length,
              actorUserId: effectiveActorUserId,
              actorName: options.performedByName ?? null,
              details: {
                oldPartsSubtotal: oldPartsSubtotal.toFixed(2),
                newTotalPartsCost: truePartsCost.toFixed(2),
                oldTotalAmount: oldTotalAmount.toFixed(2),
                items: updatedItems,
              },
            });
            console.log(
              `[AUDIT] work_order_repriced workOrderId=${workOrderId} workOrderNumber=${wo.workOrderNumber} ` +
              `itemCount=${rows.length} delta=${parentDifference.toFixed(2)} ` +
              `newTotalPartsCost=${truePartsCost.toFixed(2)} actor=${actor}`
            );
          });
        }
      } else {
        // invoice
        const invoiceId = sample.parentId;
        const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
        if (!inv) continue;
        const oldPartsSubtotal = parseFloat(String(inv.partsSubtotal ?? 0));
        const oldTotalAmount = parseFloat(String(inv.totalAmount ?? 0));

        parentSummaries.push({
          source: 'invoice',
          parentId: invoiceId,
          parentNumber: inv.invoiceNumber,
          oldPartsSubtotal: oldPartsSubtotal.toFixed(2),
          // Dry-run approximation: the delta flows straight through to the
          // parts subtotal and the invoice grand total (labor is
          // not recomputed here because Tasks #160/#161 leave applied-rate
          // recompute to the live invoice generation flow).
          newPartsSubtotal: (oldPartsSubtotal + parentDifference).toFixed(2),
          oldTotalAmount: oldTotalAmount.toFixed(2),
          newTotalAmount: (oldTotalAmount + parentDifference).toFixed(2),
          // Task #173: heads-up flags for the dry-run preview UI.
          invoicePaid: String(inv.status ?? '').toLowerCase() === 'paid',
          sentToQuickBooks: inv.quickbooksInvoiceId != null && String(inv.quickbooksInvoiceId).length > 0,
          updatedItems,
        });
        grandDifference += parentDifference;
        totalItemCount += rows.length;

        if (!options.dryRun) {
          await db.transaction(async (tx) => {
            for (const r of rows) {
              await tx.update(invoiceItems)
                .set({
                  unitPrice: parseFloat(r.catalogUnitPrice).toFixed(2),
                  totalPrice: parseFloat(r.expectedTotalPrice).toFixed(2),
                })
                .where(eq(invoiceItems.id, r.itemId));
            }
            const newPartsSubtotal = oldPartsSubtotal + parentDifference;
            const newTotalAmount = oldTotalAmount + parentDifference;
            await tx.update(invoices)
              .set({
                partsSubtotal: newPartsSubtotal.toFixed(2),
                totalAmount: newTotalAmount.toFixed(2),
                updatedAt: new Date(),
              })
              .where(eq(invoices.id, invoiceId));
            console.log(
              `[AUDIT] invoice_repriced invoiceId=${invoiceId} invoiceNumber=${inv.invoiceNumber} ` +
              `itemCount=${rows.length} delta=${parentDifference.toFixed(2)} ` +
              `newPartsSubtotal=${newPartsSubtotal.toFixed(2)} newTotalAmount=${newTotalAmount.toFixed(2)} actor=${actor}`
            );
          });
        }
      }
    }

    return {
      dryRun: options.dryRun,
      parentCount: parentSummaries.length,
      itemCount: totalItemCount,
      totalDifference: grandDifference.toFixed(2),
      parents: parentSummaries,
    };
  }
  // ─── /Catalog $0-price audit / backfill ─────────────────────────────────────

  // ─── Labor Rate Mismatch audit (Task #200) ──────────────────────────────────
  // Lists every un-invoiced Work Order and Billing Sheet whose stored
  // labor_rate does not match BOTH the customer's current standard rate AND
  // the customer's current emergency rate. The "inferred classification" is
  // whichever current rate the stored rate is numerically closest to —
  // admins can override this in the UI before applying the repair.
  async getLaborRateMismatchTickets(companyId: number | null) {
    const billingRows = await db.execute(sql`
      SELECT
        'billing_sheet'::text     AS source,
        bs.id                     AS parent_id,
        bs.billing_number         AS parent_number,
        bs.customer_id            AS customer_id,
        bs.customer_name          AS customer_name,
        bs.work_date              AS work_date,
        bs.technician_name        AS technician_name,
        bs.status                 AS status,
        bs.total_hours            AS total_hours,
        bs.labor_rate             AS stored_labor_rate,
        bs.labor_subtotal         AS stored_labor_subtotal,
        bs.parts_subtotal         AS stored_parts_subtotal,
        bs.total_amount           AS stored_total_amount,
        c.labor_rate              AS customer_standard_rate,
        c.emergency_labor_rate    AS customer_emergency_rate
      FROM billing_sheets bs
      INNER JOIN customers c ON c.id = bs.customer_id
      WHERE bs.invoice_id IS NULL
        AND bs.customer_id IS NOT NULL
        AND bs.labor_rate IS NOT NULL
        AND c.labor_rate IS NOT NULL
        AND c.emergency_labor_rate IS NOT NULL
        AND ABS(CAST(bs.labor_rate AS DOUBLE PRECISION) - CAST(c.labor_rate AS DOUBLE PRECISION)) > 0.005
        AND ABS(CAST(bs.labor_rate AS DOUBLE PRECISION) - CAST(c.emergency_labor_rate AS DOUBLE PRECISION)) > 0.005
        AND (${companyId}::int IS NULL OR c.company_id = ${companyId}::int)
    `);

    const workOrderRows = await db.execute(sql`
      SELECT
        'work_order'::text          AS source,
        wo.id                       AS parent_id,
        wo.work_order_number        AS parent_number,
        wo.customer_id              AS customer_id,
        wo.customer_name            AS customer_name,
        wo.scheduled_date           AS work_date,
        wo.assigned_technician_name AS technician_name,
        wo.status                   AS status,
        wo.total_hours              AS total_hours,
        COALESCE(wo.applied_labor_rate, wo.labor_rate) AS stored_labor_rate,
        wo.labor_subtotal           AS stored_labor_subtotal,
        wo.parts_subtotal           AS stored_parts_subtotal,
        wo.total_amount             AS stored_total_amount,
        c.labor_rate                AS customer_standard_rate,
        c.emergency_labor_rate      AS customer_emergency_rate
      FROM work_orders wo
      INNER JOIN customers c ON c.id = wo.customer_id
      WHERE wo.invoice_id IS NULL
        AND COALESCE(wo.applied_labor_rate, wo.labor_rate) IS NOT NULL
        AND c.labor_rate IS NOT NULL
        AND c.emergency_labor_rate IS NOT NULL
        AND ABS(CAST(COALESCE(wo.applied_labor_rate, wo.labor_rate) AS DOUBLE PRECISION) - CAST(c.labor_rate AS DOUBLE PRECISION)) > 0.005
        AND ABS(CAST(COALESCE(wo.applied_labor_rate, wo.labor_rate) AS DOUBLE PRECISION) - CAST(c.emergency_labor_rate AS DOUBLE PRECISION)) > 0.005
        AND (${companyId}::int IS NULL OR c.company_id = ${companyId}::int)
    `);

    const merged = [...billingRows.rows, ...workOrderRows.rows] as Array<Record<string, unknown>>;
    return merged
      .map((r) => {
        const totalHours = parseFloat(String(r.total_hours ?? 0));
        const storedRate = parseFloat(String(r.stored_labor_rate ?? 0));
        const storedPartsSubtotal = parseFloat(String(r.stored_parts_subtotal ?? 0));
        const storedTotalAmount = parseFloat(String(r.stored_total_amount ?? 0));
        const standardRate = parseFloat(String(r.customer_standard_rate ?? 0));
        const emergencyRate = parseFloat(String(r.customer_emergency_rate ?? 0));
        const distStandard = Math.abs(storedRate - standardRate);
        const distEmergency = Math.abs(storedRate - emergencyRate);
        const inferredClassification: 'standard' | 'emergency' =
          distEmergency < distStandard ? 'emergency' : 'standard';
        const expectedRate = inferredClassification === 'emergency' ? emergencyRate : standardRate;
        const expectedLaborSubtotal = totalHours * expectedRate;
        const expectedTotalAmount = expectedLaborSubtotal + storedPartsSubtotal;
        const workDate = r.work_date
          ? (r.work_date instanceof Date ? r.work_date : new Date(String(r.work_date)))
          : null;
        return {
          source: r.source as 'work_order' | 'billing_sheet',
          parentId: Number(r.parent_id),
          parentNumber: String(r.parent_number ?? ''),
          customerId: r.customer_id == null ? null : Number(r.customer_id),
          customerName: String(r.customer_name ?? ''),
          workDate,
          technicianName: String(r.technician_name ?? ''),
          status: String(r.status ?? ''),
          totalHours: totalHours.toFixed(2),
          storedLaborRate: storedRate.toFixed(2),
          storedLaborSubtotal: (parseFloat(String(r.stored_labor_subtotal ?? 0))).toFixed(2),
          storedPartsSubtotal: storedPartsSubtotal.toFixed(2),
          storedTotalAmount: storedTotalAmount.toFixed(2),
          customerStandardRate: standardRate.toFixed(2),
          customerEmergencyRate: emergencyRate.toFixed(2),
          inferredClassification,
          expectedLaborRate: expectedRate.toFixed(2),
          expectedLaborSubtotal: expectedLaborSubtotal.toFixed(2),
          expectedTotalAmount: expectedTotalAmount.toFixed(2),
        };
      })
      .sort((a, b) => {
        const ta = a.workDate ? a.workDate.getTime() : 0;
        const tb = b.workDate ? b.workDate.getTime() : 0;
        if (tb !== ta) return tb - ta;
        return b.parentId - a.parentId;
      });
  }

  async repriceLaborRateMismatches(
    selection: Array<{ source: 'work_order' | 'billing_sheet'; parentId: number; classification: 'standard' | 'emergency' }>,
    companyId: number | null,
    options: { dryRun: boolean; performedByUserId: number | null; performedByName: string | null }
  ) {
    type ParentSummary = {
      source: 'work_order' | 'billing_sheet';
      parentId: number;
      parentNumber: string;
      classification: 'standard' | 'emergency';
      oldLaborRate: string;
      newLaborRate: string;
      oldLaborSubtotal: string;
      newLaborSubtotal: string;
      oldTotalAmount: string;
      newTotalAmount: string;
    };
    const parents: ParentSummary[] = [];
    const skipped: Array<{ source: 'work_order' | 'billing_sheet'; parentId: number; reason: string }> = [];
    let grandDifference = 0;

    // Task #210: removed `stamp` (was used to prefix audit text written into
    // `notes`). Audit lines now live only in `[AUDIT]` console logs.
    const actor = options.performedByName ?? (options.performedByUserId ? `user#${options.performedByUserId}` : 'admin');

    // Task #212: resolve actor user once (see repriceBillingSheetItems).
    let effectiveActorUserId: number | null = options.performedByUserId ?? null;
    if (effectiveActorUserId != null) {
      const u = await this.getUser(effectiveActorUserId).catch(() => null);
      if (!u) effectiveActorUserId = null;
    }

    // De-duplicate: last classification wins for a given (source, parentId)
    const wantMap = new Map<string, 'standard' | 'emergency'>();
    for (const s of selection) {
      wantMap.set(`${s.source}:${s.parentId}`, s.classification);
    }

    for (const [key, classification] of Array.from(wantMap.entries())) {
      const [src, idStr] = key.split(':');
      const source = src as 'work_order' | 'billing_sheet';
      const parentId = parseInt(idStr);
      if (!Number.isFinite(parentId)) continue;

      if (source === 'billing_sheet') {
        const [sheet] = await db.select().from(billingSheets).where(eq(billingSheets.id, parentId));
        if (!sheet) {
          skipped.push({ source, parentId, reason: 'Billing sheet not found' });
          continue;
        }
        // Re-validate that the sheet is still un-invoiced at write time
        if (sheet.invoiceId != null) {
          skipped.push({ source, parentId, reason: 'Already invoiced' });
          continue;
        }
        if (!sheet.customerId) {
          skipped.push({ source, parentId, reason: 'Billing sheet has no customer' });
          continue;
        }
        if (companyId != null) {
          const [cust] = await db.select().from(customers).where(eq(customers.id, sheet.customerId));
          if (!cust || cust.companyId !== companyId) {
            skipped.push({ source, parentId, reason: 'Outside scope' });
            continue;
          }
        }
        const [customer] = await db.select().from(customers).where(eq(customers.id, sheet.customerId));
        if (!customer) {
          skipped.push({ source, parentId, reason: 'Customer not found' });
          continue;
        }
        const newRateStr = classification === 'emergency'
          ? customer.emergencyLaborRate
          : customer.laborRate;
        const newRate = newRateStr != null ? parseFloat(String(newRateStr)) : NaN;
        if (!Number.isFinite(newRate) || newRate <= 0) {
          skipped.push({
            source,
            parentId,
            reason: `Customer is missing a valid ${classification} labor rate; configure it on the customer profile before re-pricing.`,
          });
          continue;
        }
        const totalHours = parseFloat(String(sheet.totalHours ?? 0));
        const partsSubtotal = parseFloat(String(sheet.partsSubtotal ?? 0));
        const oldRate = parseFloat(String(sheet.laborRate ?? 0));
        const oldLaborSubtotal = parseFloat(String(sheet.laborSubtotal ?? 0));
        const oldTotalAmount = parseFloat(String(sheet.totalAmount ?? 0));
        if (Math.abs(oldRate - newRate) < 0.005) {
          skipped.push({
            source,
            parentId,
            reason: `Already in sync at $${newRate.toFixed(2)} (${classification}).`,
          });
          continue;
        }
        const newLaborSubtotal = totalHours * newRate;
        const newTotalAmount = newLaborSubtotal + partsSubtotal;
        const delta = newTotalAmount - oldTotalAmount;

        parents.push({
          source: 'billing_sheet',
          parentId,
          parentNumber: sheet.billingNumber,
          classification,
          oldLaborRate: oldRate.toFixed(2),
          newLaborRate: newRate.toFixed(2),
          oldLaborSubtotal: oldLaborSubtotal.toFixed(2),
          newLaborSubtotal: newLaborSubtotal.toFixed(2),
          oldTotalAmount: oldTotalAmount.toFixed(2),
          newTotalAmount: newTotalAmount.toFixed(2),
        });
        grandDifference += delta;

        if (!options.dryRun) {
          // Task #210: do NOT write the audit note into billing_sheets.notes.
          // The [AUDIT] log line below preserves the audit trail in server logs.
          // Task #212: write the structured audit event in the same transaction
          // as the rate update so the History panel can never disagree with
          // what was applied.
          await db.transaction(async (tx) => {
            await tx.update(billingSheets)
              .set({
                laborRate: newRate.toFixed(2),
                laborSubtotal: newLaborSubtotal.toFixed(2),
                totalAmount: newTotalAmount.toFixed(2),
              })
              .where(eq(billingSheets.id, parentId));
            await tx.insert(pricingAuditEvents).values({
              companyId: companyId ?? null,
              source: 'billing_sheet',
              parentId,
              parentNumber: sheet.billingNumber,
              kind: 'labor_rate_reprice',
              delta: delta.toFixed(2),
              itemCount: 0,
              actorUserId: effectiveActorUserId,
              actorName: options.performedByName ?? null,
              details: {
                classification,
                oldLaborRate: oldRate.toFixed(2),
                newLaborRate: newRate.toFixed(2),
                oldLaborSubtotal: oldLaborSubtotal.toFixed(2),
                newLaborSubtotal: newLaborSubtotal.toFixed(2),
                oldTotalAmount: oldTotalAmount.toFixed(2),
                newTotalAmount: newTotalAmount.toFixed(2),
                totalHours: totalHours.toFixed(2),
              },
            });
          });
          console.log(
            `[AUDIT] billing_sheet_labor_repriced billingSheetId=${parentId} billingNumber=${sheet.billingNumber} ` +
            `classification=${classification} oldRate=${oldRate.toFixed(2)} newRate=${newRate.toFixed(2)} ` +
            `delta=${delta.toFixed(2)} actor=${actor}`
          );
        }
      } else {
        // work_order
        const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, parentId));
        if (!wo) {
          skipped.push({ source, parentId, reason: 'Work order not found' });
          continue;
        }
        if (wo.invoiceId != null) {
          skipped.push({ source, parentId, reason: 'Already invoiced' });
          continue;
        }
        if (!wo.customerId) {
          skipped.push({ source, parentId, reason: 'Work order has no customer' });
          continue;
        }
        if (companyId != null) {
          const [cust] = await db.select().from(customers).where(eq(customers.id, wo.customerId));
          if (!cust || cust.companyId !== companyId) {
            skipped.push({ source, parentId, reason: 'Outside scope' });
            continue;
          }
        }
        const [customer] = await db.select().from(customers).where(eq(customers.id, wo.customerId));
        if (!customer) {
          skipped.push({ source, parentId, reason: 'Customer not found' });
          continue;
        }
        const newRateStr = classification === 'emergency'
          ? customer.emergencyLaborRate
          : customer.laborRate;
        const newRate = newRateStr != null ? parseFloat(String(newRateStr)) : NaN;
        if (!Number.isFinite(newRate) || newRate <= 0) {
          skipped.push({
            source,
            parentId,
            reason: `Customer is missing a valid ${classification} labor rate; configure it on the customer profile before re-pricing.`,
          });
          continue;
        }
        const totalHours = parseFloat(String(wo.totalHours ?? 0));
        const partsSubtotal = parseFloat(String(wo.partsSubtotal ?? wo.totalPartsCost ?? 0));
        const oldRate = parseFloat(String(wo.appliedLaborRate ?? wo.laborRate ?? 0));
        const oldLaborSubtotal = parseFloat(String(wo.laborSubtotal ?? 0));
        const oldTotalAmount = parseFloat(String(wo.totalAmount ?? 0));
        if (Math.abs(oldRate - newRate) < 0.005) {
          skipped.push({
            source,
            parentId,
            reason: `Already in sync at $${newRate.toFixed(2)} (${classification}).`,
          });
          continue;
        }
        const newLaborSubtotal = totalHours * newRate;
        const newTotalAmount = newLaborSubtotal + partsSubtotal;
        const delta = newTotalAmount - oldTotalAmount;

        parents.push({
          source: 'work_order',
          parentId,
          parentNumber: wo.workOrderNumber,
          classification,
          oldLaborRate: oldRate.toFixed(2),
          newLaborRate: newRate.toFixed(2),
          oldLaborSubtotal: oldLaborSubtotal.toFixed(2),
          newLaborSubtotal: newLaborSubtotal.toFixed(2),
          oldTotalAmount: oldTotalAmount.toFixed(2),
          newTotalAmount: newTotalAmount.toFixed(2),
        });
        grandDifference += delta;

        if (!options.dryRun) {
          // Task #210: do NOT write the audit note into work_orders.notes.
          // The [AUDIT] log line below preserves the audit trail in server logs.
          // Task #212: write the structured audit event in the same transaction.
          await db.transaction(async (tx) => {
            await tx.update(workOrders)
              .set({
                laborRate: newRate.toFixed(2),
                appliedLaborRate: newRate.toFixed(2),
                laborSubtotal: newLaborSubtotal.toFixed(2),
                totalAmount: newTotalAmount.toFixed(2),
              })
              .where(eq(workOrders.id, parentId));
            await tx.insert(pricingAuditEvents).values({
              companyId: companyId ?? null,
              source: 'work_order',
              parentId,
              parentNumber: wo.workOrderNumber,
              kind: 'labor_rate_reprice',
              delta: delta.toFixed(2),
              itemCount: 0,
              actorUserId: effectiveActorUserId,
              actorName: options.performedByName ?? null,
              details: {
                classification,
                oldLaborRate: oldRate.toFixed(2),
                newLaborRate: newRate.toFixed(2),
                oldLaborSubtotal: oldLaborSubtotal.toFixed(2),
                newLaborSubtotal: newLaborSubtotal.toFixed(2),
                oldTotalAmount: oldTotalAmount.toFixed(2),
                newTotalAmount: newTotalAmount.toFixed(2),
                totalHours: totalHours.toFixed(2),
              },
            });
          });
          console.log(
            `[AUDIT] work_order_labor_repriced workOrderId=${parentId} workOrderNumber=${wo.workOrderNumber} ` +
            `classification=${classification} oldRate=${oldRate.toFixed(2)} newRate=${newRate.toFixed(2)} ` +
            `delta=${delta.toFixed(2)} actor=${actor}`
          );
        }
      }
    }

    return {
      dryRun: options.dryRun,
      parentCount: parents.length,
      totalDifference: grandDifference.toFixed(2),
      parents,
      skipped,
    };
  }
  // ─── /Labor Rate Mismatch audit ─────────────────────────────────────────────

  // ─── Pricing audit events (Task #212) ──────────────────────────────────────
  async getPricingAuditEvents(
    source: 'billing_sheet' | 'work_order' | 'invoice',
    parentId: number,
    companyId?: number | null,
  ): Promise<PricingAuditEvent[]> {
    const conditions = [
      eq(pricingAuditEvents.source, source),
      eq(pricingAuditEvents.parentId, parentId),
    ];
    // Hard company scoping: when companyId is provided, only return rows that
    // belong to that company. Rows with NULL companyId are NOT exposed under a
    // scoped read — that prevents legacy/unscoped events from leaking across
    // company boundaries.
    if (companyId != null) {
      conditions.push(eq(pricingAuditEvents.companyId, companyId));
    }
    return await db.select()
      .from(pricingAuditEvents)
      .where(and(...conditions))
      .orderBy(desc(pricingAuditEvents.createdAt));
  }
  // ─── /Pricing audit events ─────────────────────────────────────────────────

  // ─── Photo late-addition audit (Task #195) ─────────────────────────────────
  async recordPhotoLateAddition(input: InsertPhotoLateAddition): Promise<PhotoLateAddition> {
    const [row] = await db.insert(photoLateAdditions).values(input).returning();
    return row;
  }

  async getPhotoLateAdditions(
    ticketType: 'work_order' | 'billing_sheet',
    ticketId: number,
    companyId?: number | null,
  ): Promise<PhotoLateAddition[]> {
    const conditions = [
      eq(photoLateAdditions.ticketType, ticketType),
      eq(photoLateAdditions.ticketId, ticketId),
    ];
    if (companyId != null) {
      conditions.push(eq(photoLateAdditions.companyId, companyId));
    }
    return await db.select()
      .from(photoLateAdditions)
      .where(and(...conditions))
      .orderBy(desc(photoLateAdditions.createdAt));
  }
  // ─── /Photo late-addition audit ────────────────────────────────────────────

  // Customer-related data methods
  async getEstimatesByCustomer(customerId: number): Promise<Estimate[]> {
    // Task #634 — exclude soft-deleted rows from the customer profile list.
    const rows = await db.select().from(estimates)
      .where(and(eq(estimates.customerId, customerId), isNull(estimates.deletedAt)))
      .orderBy(desc(estimates.createdAt));
    return rows.map((e) => ({ ...e, lifecycleStatus: computeLifecycleStatus(e) }) as Estimate);
  }

  async getBillingSheetsByCustomer(customerId: number, companyId: number | null): Promise<BillingSheetWithItems[]> {
    const scope = this._companyScopeForBS(companyId);
    const cond = scope ? and(eq(billingSheets.customerId, customerId), scope) : eq(billingSheets.customerId, customerId);
    const sheets = await db.select().from(billingSheets).where(cond).orderBy(desc(billingSheets.createdAt));
    
    const sheetsWithItems = await Promise.all(sheets.map(async (sheet) => {
      const items = await db.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, sheet.id));
      return { ...sheet, items };
    }));
    
    return sheetsWithItems;
  }

  async getBillingSheetsByTechnician(technicianId: number, companyId?: number | null): Promise<BillingSheetWithItems[]> {
    const techFilter = eq(billingSheets.technicianId, technicianId);
    let sheets: (typeof billingSheets.$inferSelect)[];
    if (companyId != null) {
      // Scope to caller's company via the technician's companyId (users.companyId).
      const tech = await db.select({ companyId: users.companyId }).from(users).where(eq(users.id, technicianId)).limit(1);
      if (!tech.length || tech[0].companyId !== companyId) return [];
      sheets = await db.select().from(billingSheets).where(techFilter).orderBy(desc(billingSheets.createdAt));
    } else {
      sheets = await db.select().from(billingSheets).where(techFilter).orderBy(desc(billingSheets.createdAt));
    }
    
    // Get items for each billing sheet
    const sheetsWithItems = await Promise.all(sheets.map(async (sheet) => {
      const items = await db.select().from(billingSheetItems).where(eq(billingSheetItems.billingSheetId, sheet.id));
      return { ...sheet, items };
    }));
    
    return sheetsWithItems;
  }

  async getMissingPhotosNotifications(): Promise<MissingPhotosNotification[]> {
    return await db.select().from(missingPhotosNotifications);
  }

  async upsertMissingPhotosNotification(
    technicianId: number,
    sheetIds: number[],
    sentByUserId: number | null,
    channel: 'email' | 'sms' = 'email',
    smsMessageSid: string | null = null,
  ): Promise<MissingPhotosNotification> {
    const now = new Date();
    let channelFields: Partial<typeof missingPhotosNotifications.$inferInsert>;
    if (channel === 'email') {
      channelFields = { lastSentEmailAt: now, lastEmailSheetCount: sheetIds.length };
    } else {
      // For SMS, also (re)seed the delivery tracking fields. We mark the
      // initial status as 'queued' since Twilio has just accepted the
      // message; the status callback webhook will update it as the message
      // moves through sent / delivered / failed / undelivered.
      channelFields = {
        lastSentSmsAt: now,
        lastSmsSheetCount: sheetIds.length,
        lastSmsMessageSid: smsMessageSid,
        lastSmsStatus: smsMessageSid ? 'queued' : null,
        lastSmsStatusAt: smsMessageSid ? now : null,
        lastSmsErrorCode: null,
      };
    }

    const insertValues: typeof missingPhotosNotifications.$inferInsert = {
      technicianId,
      sheetIds,
      sheetCount: sheetIds.length,
      lastSentAt: now,
      sentByUserId,
      ...channelFields,
    };
    const updateValues: Partial<typeof missingPhotosNotifications.$inferInsert> = {
      sheetIds,
      sheetCount: sheetIds.length,
      lastSentAt: now,
      sentByUserId,
      ...channelFields,
    };

    const [row] = await db
      .insert(missingPhotosNotifications)
      .values(insertValues)
      .onConflictDoUpdate({
        target: missingPhotosNotifications.technicianId,
        set: updateValues,
      })
      .returning();
    return row;
  }

  async updateMissingPhotosSmsStatus(
    messageSid: string,
    status: string,
    errorCode: string | null = null,
  ): Promise<MissingPhotosNotification | undefined> {
    // Monotonic status guard: Twilio status callbacks can arrive out of
    // order (e.g. a delayed 'sent' after a 'delivered'/'failed' callback).
    // Don't let an earlier-stage status overwrite a terminal one. Rank
    // each status; only persist when the incoming rank is >= the stored
    // rank.
    const rank = (s: string | null | undefined): number => {
      switch ((s ?? '').toLowerCase()) {
        case 'queued':
        case 'accepted':
        case 'scheduled':
          return 1;
        case 'sending':
          return 2;
        case 'sent':
          return 3;
        // Terminal states — equal rank so the most recent terminal callback
        // (e.g. 'delivered' superseded by a later 'failed') still updates.
        case 'delivered':
        case 'received':
        case 'failed':
        case 'undelivered':
          return 4;
        default:
          return 0;
      }
    };

    const [existing] = await db
      .select()
      .from(missingPhotosNotifications)
      .where(eq(missingPhotosNotifications.lastSmsMessageSid, messageSid));
    if (!existing) return undefined;

    if (rank(status) < rank(existing.lastSmsStatus)) {
      // Drop out-of-order earlier-stage callback; preserve terminal state.
      return existing;
    }

    const [row] = await db
      .update(missingPhotosNotifications)
      .set({
        lastSmsStatus: status,
        lastSmsStatusAt: new Date(),
        lastSmsErrorCode: errorCode,
      })
      .where(eq(missingPhotosNotifications.lastSmsMessageSid, messageSid))
      .returning();
    return row;
  }

  async getInvoiceCount(): Promise<number> {
    const result = await db.select({ count: invoices.id }).from(invoices);
    return result.length;
  }

  async getAllInvoices(): Promise<Invoice[]> {
    return await db.select().from(invoices).orderBy(desc(invoices.createdAt));
  }

  async getInvoiceById(id: number, companyId: number | null): Promise<InvoiceWithItems | undefined> {
    const scope = this._companyScopeForInvoice(companyId);
    const cond = scope ? and(eq(invoices.id, id), scope) : eq(invoices.id, id);
    const [invoice] = await db.select().from(invoices).where(cond);
    if (!invoice) return undefined;
    
    const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id));
    return { ...invoice, items };
  }

  async getInvoicesByCustomer(customerId: number, companyId: number | null): Promise<Invoice[]> {
    try {
      const scope = this._companyScopeForInvoice(companyId);
      const cond = scope ? and(eq(invoices.customerId, customerId), scope) : eq(invoices.customerId, customerId);
      return await db.select().from(invoices)
        .where(cond)
        .orderBy(desc(invoices.createdAt));
    } catch (error) {
      console.warn(`Error querying invoices for customer ${customerId}:`, error);
      return [];
    }
  }

  async getInvoices(companyId: number | null): Promise<Invoice[]> {
    const scope = this._companyScopeForInvoice(companyId);
    return await db.select().from(invoices)
      .where(scope ?? undefined)
      .orderBy(desc(invoices.createdAt));
  }

  async getInvoicesByStatus(status: string, companyId: number | null): Promise<Invoice[]> {
    const scope = this._companyScopeForInvoice(companyId);
    const cond = scope ? and(eq(invoices.status, status), scope) : eq(invoices.status, status);
    return await db.select().from(invoices)
      .where(cond)
      .orderBy(desc(invoices.createdAt));
  }

  // Task #662 — company-scoped "This Month Billed" rollup. Sums
  // invoices.total_amount for invoices created in the current
  // calendar month, joining customers so we can filter on
  // customers.company_id (invoices itself has no company_id column).
  // Excludes draft and cancelled invoices. Pass `null` to get the
  // global view (super_admin).
  async getThisMonthBilledForCompany(
    companyId: number | null,
    now: Date = new Date(),
  ): Promise<{ amount: number; invoiceCount: number; month: string }> {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const conditions = [
      gte(invoices.createdAt, monthStart),
      sql`${invoices.createdAt} < ${nextMonthStart}`,
      sql`${invoices.status} NOT IN ('draft','cancelled','superseded','merged','failed')`,
    ];
    if (companyId !== null) {
      conditions.push(eq(customers.companyId, companyId));
    }

    const rows = await db
      .select({
        total: sql<string>`COALESCE(SUM(${invoices.totalAmount}), 0)`,
        count: sql<string>`COUNT(${invoices.id})`,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(...conditions));

    const row = rows[0];
    const amountRaw = row?.total ?? "0";
    const countRaw = row?.count ?? "0";
    const amount = Number.parseFloat(String(amountRaw));
    const invoiceCount = Number.parseInt(String(countRaw), 10);
    return {
      amount: Number.isFinite(amount) ? amount : 0,
      invoiceCount: Number.isFinite(invoiceCount) ? invoiceCount : 0,
      month: monthLabel,
    };
  }

  async createInvoice(invoice: InsertInvoice & { invoiceNumber?: string; companyId: number }): Promise<Invoice> {
    const [newInvoice] = await db.insert(invoices).values(toDrizzleInsert<DrizzleInvoiceInsert>(invoice)).returning();
    return newInvoice;
  }

  async updateInvoice(id: number, invoice: Partial<InsertInvoice> & { invoiceNumber?: string }): Promise<Invoice | undefined> {
    const [updatedInvoice] = await db.update(invoices).set(invoice).where(eq(invoices.id, id)).returning();
    return updatedInvoice || undefined;
  }

  async deleteInvoice(id: number): Promise<boolean> {
    const result = await db.delete(invoices).where(eq(invoices.id, id));
    return (result.rowCount || 0) > 0;
  }

  async deleteInvoiceItemsByInvoiceId(invoiceId: number): Promise<boolean> {
    const result = await db.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    return (result.rowCount || 0) > 0;
  }

  // Task #161 safeguard: when an invoice line item references a catalog part
  // (partId), the catalog price is the authoritative source of truth. If the
  // catalog price is > 0 we override any client-supplied unitPrice/totalPrice
  // (mirrors Task #160 work-order/billing-sheet behaviour). If the partId
  // points to a missing/deleted part, we throw — silently dropping the row
  // would mask data quality issues.
  private async authoritativeInvoiceItemPrice(item: InsertInvoiceItem): Promise<InsertInvoiceItem> {
    if (item.partId == null) return item;
    const part = await this.getPart(item.partId);
    if (!part) {
      throw new Error(
        `Catalog part with ID ${item.partId} (line item "${item.partName ?? '?'}") was not found. Cannot save invoice line item.`,
      );
    }
    const catalogPrice = parseFloat(String(part.price ?? 0));
    if (!(catalogPrice > 0)) return item;
    const qty = parseFloat(String(item.quantity ?? 0));
    return {
      ...item,
      partName: item.partName || part.name,
      partDescription: item.partDescription ?? part.description ?? null,
      unitPrice: catalogPrice.toFixed(2),
      totalPrice: (qty * catalogPrice).toFixed(2),
    };
  }

  async createInvoiceItem(item: InsertInvoiceItem): Promise<InvoiceItem> {
    const corrected = await this.authoritativeInvoiceItemPrice(item);
    const [newItem] = await db.insert(invoiceItems).values(corrected).returning();
    return newItem;
  }

  async getInvoiceItems(invoiceId: number): Promise<InvoiceItem[]> {
    return await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
  }

  // Invoice PDF methods
  async createInvoicePdf(pdf: InsertInvoicePdf): Promise<InvoicePdf> {
    const [newPdf] = await db.insert(invoicePdfs).values(pdf).returning();
    return newPdf;
  }

  async getInvoicePdfByInvoiceId(invoiceId: number): Promise<InvoicePdf | undefined> {
    const [pdf] = await db.select().from(invoicePdfs).where(eq(invoicePdfs.invoiceId, invoiceId));
    return pdf;
  }

  async updateInvoicePdf(id: number, pdf: Partial<InsertInvoicePdf>): Promise<InvoicePdf | undefined> {
    const [updated] = await db.update(invoicePdfs)
      .set(pdf)
      .where(eq(invoicePdfs.id, id))
      .returning();
    return updated;
  }

  // ── Task #1887 — invoice payment reminders ────────────────────────────────
  //
  // Reads here never recompute a reminder's balance or days-overdue: those are
  // captured columns, and the whole point of capturing them is that history
  // keeps saying what the customer was actually told.

  async createInvoiceReminder(row: InsertInvoiceReminder): Promise<InvoiceReminder> {
    const [created] = await db.insert(invoiceReminders).values(row).returning();
    return created;
  }

  async getInvoiceReminders(
    invoiceId: number,
    companyId: number | null,
  ): Promise<InvoiceReminder[]> {
    const where = companyId == null
      ? eq(invoiceReminders.invoiceId, invoiceId)
      : and(eq(invoiceReminders.invoiceId, invoiceId), eq(invoiceReminders.companyId, companyId));
    return await db
      .select()
      .from(invoiceReminders)
      .where(where)
      .orderBy(desc(invoiceReminders.sentAt), desc(invoiceReminders.id));
  }

  async getLastDeliveredInvoiceReminder(invoiceId: number): Promise<InvoiceReminder | undefined> {
    const [row] = await db
      .select()
      .from(invoiceReminders)
      .where(
        and(
          eq(invoiceReminders.invoiceId, invoiceId),
          eq(invoiceReminders.deliveryStatus, 'sent'),
        ),
      )
      .orderBy(desc(invoiceReminders.sentAt), desc(invoiceReminders.id))
      .limit(1);
    return row;
  }

  async getInvoiceReminderSummaries(
    companyId: number | null,
  ): Promise<Map<number, { reminderCount: number; lastReminderAt: Date }>> {
    // Delivered reminders only. A failed send is recorded for the audit trail
    // but it is not a reminder the customer received, so it must not appear in
    // the count, in "last reminder", or in the reminder filter.
    const conditions = [eq(invoiceReminders.deliveryStatus, 'sent')];
    if (companyId != null) conditions.push(eq(invoiceReminders.companyId, companyId));
    const rows = await db
      .select({
        invoiceId: invoiceReminders.invoiceId,
        reminderCount: sql<number>`count(*)::int`,
        lastReminderAt: sql<Date>`max(${invoiceReminders.sentAt})`,
      })
      .from(invoiceReminders)
      .where(and(...conditions))
      .groupBy(invoiceReminders.invoiceId);

    const map = new Map<number, { reminderCount: number; lastReminderAt: Date }>();
    for (const r of rows) {
      map.set(r.invoiceId, {
        reminderCount: Number(r.reminderCount) || 0,
        lastReminderAt: new Date(r.lastReminderAt as unknown as string),
      });
    }
    return map;
  }

  // ── Task #1889 — internal A/R notes ───────────────────────────────────────
  //
  // Append and read. There is deliberately NO update and NO delete method on
  // this table anywhere in the storage layer: the thread is append-only, and
  // the way that is guaranteed is that no code path exists to change a row.
  // Do not add one — not a soft delete, not an admin override.
  //
  // These rows are internal. Nothing in the PDF pipeline, the mailers, or any
  // customer-facing export may call these methods.

  async createInvoiceArNote(row: InsertInvoiceArNote): Promise<InvoiceArNote> {
    const [created] = await db.insert(invoiceArNotes).values(row).returning();
    return created;
  }

  async getInvoiceArNotes(
    invoiceId: number,
    companyId: number | null,
  ): Promise<InvoiceArNote[]> {
    const where = companyId == null
      ? eq(invoiceArNotes.invoiceId, invoiceId)
      : and(eq(invoiceArNotes.invoiceId, invoiceId), eq(invoiceArNotes.companyId, companyId));
    return await db
      .select()
      .from(invoiceArNotes)
      .where(where)
      .orderBy(desc(invoiceArNotes.createdAt), desc(invoiceArNotes.id));
  }

  async getInvoiceArNoteSummaries(
    companyId: number | null,
  ): Promise<Map<number, { noteCount: number; lastNoteAt: Date; lastNoteText: string }>> {
    // One rollup for the whole company-scoped set, so the list indicator costs
    // a single query rather than a request per row.
    const conditions = companyId != null ? [eq(invoiceArNotes.companyId, companyId)] : [];
    const rows = await db
      .select({
        invoiceId: invoiceArNotes.invoiceId,
        noteCount: sql<number>`count(*)::int`,
        lastNoteAt: sql<Date>`max(${invoiceArNotes.createdAt})`,
        // The note attached to that latest timestamp. DISTINCT ON would be the
        // other way to write this; the ordered aggregate keeps it to one pass.
        lastNoteText: sql<string>`(array_agg(${invoiceArNotes.note} ORDER BY ${invoiceArNotes.createdAt} DESC, ${invoiceArNotes.id} DESC))[1]`,
      })
      .from(invoiceArNotes)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(invoiceArNotes.invoiceId);

    const map = new Map<number, { noteCount: number; lastNoteAt: Date; lastNoteText: string }>();
    for (const r of rows) {
      map.set(r.invoiceId, {
        noteCount: Number(r.noteCount) || 0,
        lastNoteAt: new Date(r.lastNoteAt as unknown as string),
        lastNoteText: String(r.lastNoteText ?? ""),
      });
    }
    return map;
  }

  // Task #1425 — atomically merge duplicate monthly invoices for the same
  // customer + billing period into one surviving invoice. Local-only: no
  // QuickBooks calls. Re-points line items + source records (work orders,
  // billing sheets, wet check billings) onto the survivor, sums totals,
  // marks the merged invoices `cancelled` (kept for audit), and drops the
  // survivor's stale cached PDF row so it regenerates. All in one
  // transaction; validation is re-checked inside the txn so a concurrent
  // change can't slip a bad merge through.
  async mergeInvoices(params: {
    survivingId: number;
    mergedIds: number[];
    companyId: number | null;
    audit?: {
      actorUserId?: number | null;
      actorLabel?: string | null;
      actorRole?: string | null;
      actorCompanyId?: number | null;
    };
  }): Promise<{
    survivingInvoice: Invoice;
    survivingNumber: string;
    cancelledInvoiceIds: number[];
    cancelledNumbers: string[];
    partsSubtotal: string;
    laborSubtotal: string;
    totalAmount: string;
    // Task #1443 — the source invoices' (now-orphaned) QuickBooks invoice
    // ids, so the UI can tell the billing manager exactly which QB invoices
    // to delete by hand before re-syncing the survivor.
    mergedFromQuickbooksIds: string[];
  }> {
    const { survivingId, mergedIds, companyId, audit } = params;
    const distinctIds = Array.from(new Set([survivingId, ...mergedIds]));

    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(invoices)
        .where(inArray(invoices.id, distinctIds))
        .for("update");

      const { surviving, merged, mergedIds: mergedOnlyIds } = validateMerge(
        rows as unknown as MergeCandidate[],
        survivingId,
        mergedIds,
        companyId,
      );

      // Task #1443 — collect the merged (non-survivor) invoices' QuickBooks
      // ids before we cancel them. These QB invoices stay in QuickBooks and
      // must be deleted manually (kept manual by design).
      const mergedFromQuickbooksIds = rows
        .filter((r) => mergedOnlyIds.includes(r.id) && r.quickbooksInvoiceId)
        .map((r) => r.quickbooksInvoiceId as string);

      // Re-point line items + every source record that referenced a merged
      // invoice onto the survivor.
      await tx
        .update(invoiceItems)
        .set({ invoiceId: survivingId })
        .where(inArray(invoiceItems.invoiceId, mergedOnlyIds));
      await tx
        .update(workOrders)
        .set({ invoiceId: survivingId })
        .where(inArray(workOrders.invoiceId, mergedOnlyIds));
      await tx
        .update(billingSheets)
        .set({ invoiceId: survivingId })
        .where(inArray(billingSheets.invoiceId, mergedOnlyIds));
      await tx
        .update(wetCheckBillings)
        .set({ invoiceId: survivingId })
        .where(inArray(wetCheckBillings.invoiceId, mergedOnlyIds));

      const totals = computeMergedTotals([surviving, ...merged]);

      const [survivingInvoice] = await tx
        .update(invoices)
        .set({
          partsSubtotal: totals.partsSubtotal,
          laborSubtotal: totals.laborSubtotal,
          totalAmount: totals.totalAmount,
          // Task #1443 — clear the survivor's QuickBooks link. This is a DB
          // field change only (no QB API call) so the merge's "no QB call"
          // contract holds. The merged totals no longer match whatever QB
          // invoice this id used to point at, so the row must show "Not
          // synced" and be re-syncable as a clean create.
          quickbooksInvoiceId: null,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, survivingId))
        .returning();

      // Task #1756 — set merged status and link to survivor (not "cancelled",
      // so genuine cancels remain distinguishable). Stored totals are left
      // intact; nothing is zeroed on the absorbed invoice rows.
      await tx
        .update(invoices)
        .set({ status: "merged", mergedIntoInvoiceId: survivingId, updatedAt: new Date() } as any)
        .where(inArray(invoices.id, mergedOnlyIds));

      // Drop the survivor's stale cached PDF metadata so the next view
      // regenerates against the merged line items.
      await tx.delete(invoicePdfs).where(eq(invoicePdfs.invoiceId, survivingId));

      // Task #1756 — clear the QB ids from absorbed invoices and stamp a
      // qbNote so billing managers know what to clean up manually. The "never-
      // auto-void" convention is preserved — no QB API call is made here.
      // Use `rows` (full Drizzle result) not `merged` (MergeCandidate subset)
      // because MergeCandidate intentionally omits QB fields.
      const absorbedRowsWithQb = rows.filter(
        (r) => mergedOnlyIds.includes(r.id) && r.quickbooksInvoiceId,
      );
      if (absorbedRowsWithQb.length > 0) {
        for (const absorbedRow of absorbedRowsWithQb) {
          await tx
            .update(invoices)
            .set({
              quickbooksInvoiceId: null,
              quickbooksSyncToken: null,
              qbNote: `Manually delete QB invoice ${absorbedRow.quickbooksInvoiceId} — this invoice was absorbed into merge survivor #${surviving.invoiceNumber}.` as any,
              updatedAt: new Date(),
            } as any)
            .where(eq(invoices.id, absorbedRow.id));
        }
      }

      // Task #1756 — audit event on the survivor (`invoice_merge_in`): records
      // which invoices were absorbed and the resulting combined totals. This is
      // the NEW canonical action name; the legacy `invoice.merged` name is only
      // used by the backfill migration to find historical events.
      await recordAuditEvent(
        null,
        {
          actionType: "invoice",
          action: "invoice_merge_in",
          severity: "info",
          actorUserId: audit?.actorUserId ?? null,
          actorLabel: audit?.actorLabel ?? null,
          actorRole: audit?.actorRole ?? null,
          actorCompanyId: audit?.actorCompanyId ?? null,
          targetType: "invoice",
          targetId: String(survivingId),
          summary: `Merged invoice(s) ${merged
            .map((m) => m.invoiceNumber)
            .join(", ")} into ${surviving.invoiceNumber}`,
          details: {
            survivingInvoiceId: survivingId,
            survivingInvoiceNumber: surviving.invoiceNumber,
            cancelledInvoiceIds: mergedOnlyIds,
            cancelledInvoiceNumbers: merged.map((m) => m.invoiceNumber),
            customerId: surviving.customerId,
            invoiceMonth: surviving.invoiceMonth,
            invoiceYear: surviving.invoiceYear,
            partsSubtotal: totals.partsSubtotal,
            laborSubtotal: totals.laborSubtotal,
            totalAmount: totals.totalAmount,
          },
        },
        { tx, strict: true },
      );

      // Task #1756 — one audit event per absorbed invoice so its Activity tab
      // also shows the merge event (targetId points at the absorbed invoice).
      for (const absorbedInv of merged) {
        await recordAuditEvent(
          null,
          {
            actionType: "invoice",
            action: "invoice_merged",
            severity: "info",
            actorUserId: audit?.actorUserId ?? null,
            actorLabel: audit?.actorLabel ?? null,
            actorRole: audit?.actorRole ?? null,
            actorCompanyId: audit?.actorCompanyId ?? null,
            targetType: "invoice",
            targetId: String(absorbedInv.id),
            summary: `Merged into #${surviving.invoiceNumber}`,
            details: {
              survivorId: survivingId,
              survivorNumber: surviving.invoiceNumber,
              absorbedId: absorbedInv.id,
              absorbedNumber: absorbedInv.invoiceNumber,
              customerId: surviving.customerId,
              partsSubtotal: String(absorbedInv.partsSubtotal),
              laborSubtotal: String(absorbedInv.laborSubtotal),
              totalAmount: String(absorbedInv.totalAmount),
            },
          },
          { tx, strict: false },
        );
      }

      return {
        survivingInvoice,
        survivingNumber: surviving.invoiceNumber,
        cancelledInvoiceIds: mergedOnlyIds,
        cancelledNumbers: merged.map((m) => m.invoiceNumber),
        mergedFromQuickbooksIds,
        ...totals,
      };
    });
  }

  // Notification methods
  async getNotifications(userId: number): Promise<Notification[]> {
    try {
      console.log(`Storage: getNotifications called for userId ${userId}`);
      const results = await db.select().from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt));
      console.log(`Storage: getNotifications returned ${results.length} notifications`);
      return results;
    } catch (error) {
      console.error(`Storage: getNotifications failed for userId ${userId}:`, error);
      throw error;
    }
  }

  async getUnreadNotificationCount(userId: number): Promise<number> {
    try {
      console.log(`Storage: getUnreadNotificationCount called for userId ${userId}`);
      const results = await db.select().from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
      console.log(`Storage: getUnreadNotificationCount returned ${results.length} unread notifications`);
      return results.length;
    } catch (error) {
      console.error(`Storage: getUnreadNotificationCount failed for userId ${userId}:`, error);
      throw error;
    }
  }

  async createNotification(notification: InsertNotification): Promise<Notification> {
    const [newNotification] = await db.insert(notifications).values(notification).returning();
    return newNotification;
  }

  async markNotificationAsRead(id: number): Promise<boolean> {
    const result = await db.update(notifications)
      .set({ isRead: true })
      .where(eq(notifications.id, id));
    return (result.rowCount || 0) > 0;
  }

  async markAllNotificationsAsRead(userId: number): Promise<boolean> {
    const result = await db.update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
    return (result.rowCount || 0) > 0;
  }

  // API Keys methods
  async getApiKeys(companyId: number): Promise<ApiKey[]> {
    return await db.select().from(apiKeys)
      .where(eq(apiKeys.companyId, companyId))
      .orderBy(desc(apiKeys.createdAt));
  }

  async getApiKeyByKey(apiKey: string): Promise<ApiKey | undefined> {
    const results = await db.select().from(apiKeys)
      .where(and(eq(apiKeys.apiKey, apiKey), eq(apiKeys.isActive, true)));
    return results[0];
  }

  async createApiKey(apiKey: InsertApiKey): Promise<ApiKey> {
    const result = await db.insert(apiKeys).values(apiKey).returning();
    return result[0];
  }

  async deleteApiKey(id: number): Promise<boolean> {
    const result = await db.delete(apiKeys).where(eq(apiKeys.id, id));
    return (result.rowCount || 0) > 0;
  }

  async updateApiKeyLastUsed(id: number): Promise<void> {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
  }

  async getIrrigationManagerForCompany(companyId: number): Promise<User | undefined> {
    const results = await db.select().from(users)
      .where(and(
        eq(users.companyId, companyId),
        eq(users.role, 'irrigation_manager'),
        eq(users.isActive, true)
      ))
      .limit(1);
    return results[0];
  }

  // Site Maps methods
  async getSiteMap(id: number): Promise<SiteMap | undefined> {
    const [row] = await db.select().from(siteMaps).where(eq(siteMaps.id, id)).limit(1);
    return row ?? undefined;
  }

  async getAllSiteMaps(): Promise<SiteMap[]> {
    return await db.select().from(siteMaps)
      .where(eq(siteMaps.isActive, true))
      .orderBy(desc(siteMaps.updatedAt));
  }

  async getCustomerSiteMaps(customerId: number): Promise<SiteMap[]> {
    return await db.select().from(siteMaps)
      .where(eq(siteMaps.customerId, customerId))
      .orderBy(desc(siteMaps.updatedAt));
  }

  async getSiteMapControllers(siteMapId: number): Promise<Controller[]> {
    return await db.select().from(controllers)
      .where(eq(controllers.siteMapId, siteMapId))
      .orderBy(controllers.name);
  }

  async getSiteMapZones(siteMapId: number): Promise<IrrigationZone[]> {
    return await db.select().from(irrigationZones)
      .where(eq(irrigationZones.siteMapId, siteMapId))
      .orderBy(irrigationZones.name);
  }

  async createSiteMap(siteMap: InsertSiteMap): Promise<SiteMap> {
    const result = await db.insert(siteMaps).values(siteMap).returning();
    return result[0];
  }

  async updateSiteMap(siteMapId: number, siteMap: Partial<InsertSiteMap>): Promise<SiteMap | undefined> {
    const [updatedSiteMap] = await db.update(siteMaps)
      .set({ ...siteMap, updatedAt: new Date() })
      .where(eq(siteMaps.id, siteMapId))
      .returning();
    return updatedSiteMap || undefined;
  }

  async deleteSiteMap(siteMapId: number): Promise<boolean> {
    const result = await db.delete(siteMaps).where(eq(siteMaps.id, siteMapId));
    return (result.rowCount || 0) > 0;
  }

  async saveControllers(siteMapId: number, controllersData: InsertController[], companyId: number): Promise<Controller[]> {
    // First, delete existing controllers for this site map
    await db.delete(controllers).where(eq(controllers.siteMapId, siteMapId));
    
    // Insert new controllers with proper company ID
    const controllersWithSiteMapId = controllersData.map(controller => ({
      ...controller,
      siteMapId,
      companyId // Use provided company ID
    }));
    
    const result = await db.insert(controllers).values(controllersWithSiteMapId).returning();
    return result;
  }

  async saveZones(siteMapId: number, zonesData: InsertIrrigationZone[], companyId: number): Promise<IrrigationZone[]> {
    if (zonesData.length === 0) return [];
    
    // Get the controller ID from the first zone (they should all be for the same controller)
    const controllerId = zonesData[0].controllerId;
    
    if (controllerId) {
      // Delete existing zones for this specific controller only
      await db.delete(irrigationZones)
        .where(and(
          eq(irrigationZones.siteMapId, siteMapId),
          eq(irrigationZones.controllerId, controllerId)
        ));
    } else {
      // If no controller ID, delete all zones for this site map (fallback)
      await db.delete(irrigationZones).where(eq(irrigationZones.siteMapId, siteMapId));
    }
    
    // Insert new zones with proper company ID
    const zonesWithSiteMapId = zonesData.map(zone => ({
      ...zone,
      siteMapId,
      companyId // Use provided company ID
    }));
    
    const result = await db.insert(irrigationZones).values(zonesWithSiteMapId).returning();
    return result;
  }

  // Part usage tracking methods
  async trackPartUsage(companyId: number, partId: number): Promise<void> {
    const existingUsage = await db.select()
      .from(partUsage)
      .where(and(eq(partUsage.companyId, companyId), eq(partUsage.partId, partId)))
      .limit(1);

    if (existingUsage.length > 0) {
      // Update existing usage
      await db.update(partUsage)
        .set({
          usageCount: existingUsage[0].usageCount + 1,
          lastUsedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(partUsage.id, existingUsage[0].id));
    } else {
      // Create new usage record
      await db.insert(partUsage).values({
        companyId,
        partId,
        usageCount: 1,
        lastUsedAt: new Date()
      });
    }
  }

  async getPopularParts(companyId: number, limit: number = 10): Promise<{ id: number; companyId: number; name: string; description: string | null; sku: string; category: string; price: string; usageCount: number }[]> {
    const results = await db.select({
      id: parts.id,
      companyId: parts.companyId,
      name: parts.name,
      description: parts.description,
      sku: parts.sku,
      category: parts.category,
      price: parts.price,
      usageCount: partUsage.usageCount
    })
    .from(parts)
    .innerJoin(partUsage, eq(parts.id, partUsage.partId))
    .where(eq(partUsage.companyId, companyId))
    .orderBy(desc(partUsage.usageCount), desc(partUsage.lastUsedAt))
    .limit(limit);

    return results;
  }

  // Default seed values for parts reference lists
  private readonly DEFAULT_CATEGORIES = [
    "Backflow", "Bushing", "Controller", "Decoder", "Filter", "Fitting",
    "Head", "Irrigation Box", "Labor", "Misc", "Module", "Nipple",
    "Nozzle", "Pipe", "Rental", "Service", "Valve", "Wire"
  ];
  private readonly DEFAULT_BRANDS = [
    "Hunter", "Rainbird", "Febco", "LEIT", "EBON", "Wilkins", "Mcdonald", "Leemco", "Ranier"
  ];
  private readonly DEFAULT_SIZES = [
    "0.125\"", "0.25\"", "0.375\"", "0.5\"", "0.75\"", "1\"", "1.25\"", "1.5\"",
    "2\"", "2.5\"", "3\"", "4\"", "6\"", "8\"", "10\"", "12\""
  ];
  private readonly DEFAULT_MATERIALS = [
    "PVC", "Copper", "Brass", "NETAFIM", "POLY", "BACKFLOW", "Insert"
  ];
  private readonly DEFAULT_FITTING_TYPES = [
    "90° Coupler", "45° Coupler", "Tee", "Union", "Cap", "Coupler", "Male Adapter",
    "Female Adapter", "Plug", "Slip-Fix", "Cross", "Manifold", "Ball Valve"
  ];

  async getPartCategories(companyId: number): Promise<PartCategory[]> {
    const existing = await db.select().from(partCategories).where(eq(partCategories.companyId, companyId));
    if (existing.length === 0) {
      const toInsert = this.DEFAULT_CATEGORIES.map(name => ({ companyId, name, markupPercent: "0.00" }));
      const seeded = await db.insert(partCategories).values(toInsert).returning();
      return seeded;
    }
    return existing;
  }

  async createPartCategory(category: InsertPartCategory): Promise<PartCategory> {
    const [result] = await db.insert(partCategories).values(category).returning();
    return result;
  }

  async updatePartCategory(id: number, companyId: number, data: Partial<InsertPartCategory>): Promise<PartCategory | undefined> {
    const [result] = await db.update(partCategories).set(data).where(and(eq(partCategories.id, id), eq(partCategories.companyId, companyId))).returning();
    return result;
  }

  async deletePartCategory(id: number, companyId: number): Promise<boolean> {
    const result = await db.delete(partCategories).where(and(eq(partCategories.id, id), eq(partCategories.companyId, companyId))).returning();
    return result.length > 0;
  }

  async getPartBrands(companyId: number): Promise<PartBrand[]> {
    const existing = await db.select().from(partBrands).where(eq(partBrands.companyId, companyId));
    if (existing.length === 0) {
      const toInsert = this.DEFAULT_BRANDS.map(name => ({ companyId, name }));
      const seeded = await db.insert(partBrands).values(toInsert).returning();
      return seeded;
    }
    return existing;
  }

  async createPartBrand(brand: InsertPartBrand): Promise<PartBrand> {
    const [result] = await db.insert(partBrands).values(brand).returning();
    return result;
  }

  async updatePartBrand(id: number, companyId: number, data: Partial<InsertPartBrand>): Promise<PartBrand | undefined> {
    const [result] = await db.update(partBrands).set(data).where(and(eq(partBrands.id, id), eq(partBrands.companyId, companyId))).returning();
    return result;
  }

  async deletePartBrand(id: number, companyId: number): Promise<boolean> {
    const result = await db.delete(partBrands).where(and(eq(partBrands.id, id), eq(partBrands.companyId, companyId))).returning();
    return result.length > 0;
  }

  async getPartSizes(companyId: number): Promise<PartSize[]> {
    const existing = await db.select().from(partSizes).where(eq(partSizes.companyId, companyId));
    if (existing.length === 0) {
      const toInsert = this.DEFAULT_SIZES.map(name => ({ companyId, name }));
      const seeded = await db.insert(partSizes).values(toInsert).returning();
      return seeded;
    }
    return existing;
  }

  async createPartSize(size: InsertPartSize): Promise<PartSize> {
    const [result] = await db.insert(partSizes).values(size).returning();
    return result;
  }

  async updatePartSize(id: number, companyId: number, data: Partial<InsertPartSize>): Promise<PartSize | undefined> {
    const [result] = await db.update(partSizes).set(data).where(and(eq(partSizes.id, id), eq(partSizes.companyId, companyId))).returning();
    return result;
  }

  async deletePartSize(id: number, companyId: number): Promise<boolean> {
    const result = await db.delete(partSizes).where(and(eq(partSizes.id, id), eq(partSizes.companyId, companyId))).returning();
    return result.length > 0;
  }

  async getPartMaterials(companyId: number): Promise<PartMaterial[]> {
    const existing = await db.select().from(partMaterials).where(eq(partMaterials.companyId, companyId));
    if (existing.length === 0) {
      const toInsert = this.DEFAULT_MATERIALS.map(name => ({ companyId, name }));
      const seeded = await db.insert(partMaterials).values(toInsert).returning();
      return seeded;
    }
    return existing;
  }

  async createPartMaterial(material: InsertPartMaterial): Promise<PartMaterial> {
    const [result] = await db.insert(partMaterials).values(material).returning();
    return result;
  }

  async updatePartMaterial(id: number, companyId: number, data: Partial<InsertPartMaterial>): Promise<PartMaterial | undefined> {
    const [result] = await db.update(partMaterials).set(data).where(and(eq(partMaterials.id, id), eq(partMaterials.companyId, companyId))).returning();
    return result;
  }

  async deletePartMaterial(id: number, companyId: number): Promise<boolean> {
    const result = await db.delete(partMaterials).where(and(eq(partMaterials.id, id), eq(partMaterials.companyId, companyId))).returning();
    return result.length > 0;
  }

  async getPartFittingTypes(companyId: number): Promise<PartFittingType[]> {
    const existing = await db.select().from(partFittingTypes).where(eq(partFittingTypes.companyId, companyId));
    if (existing.length === 0) {
      const toInsert = this.DEFAULT_FITTING_TYPES.map(name => ({ companyId, name }));
      const seeded = await db.insert(partFittingTypes).values(toInsert).returning();
      return seeded;
    }
    return existing;
  }

  async createPartFittingType(fittingType: InsertPartFittingType): Promise<PartFittingType> {
    const [result] = await db.insert(partFittingTypes).values(fittingType).returning();
    return result;
  }

  async updatePartFittingType(id: number, companyId: number, data: Partial<InsertPartFittingType>): Promise<PartFittingType | undefined> {
    const [result] = await db.update(partFittingTypes).set(data).where(and(eq(partFittingTypes.id, id), eq(partFittingTypes.companyId, companyId))).returning();
    return result;
  }

  async deletePartFittingType(id: number, companyId: number): Promise<boolean> {
    const result = await db.delete(partFittingTypes).where(and(eq(partFittingTypes.id, id), eq(partFittingTypes.companyId, companyId))).returning();
    return result.length > 0;
  }

  async createAiGenerationLog(log: InsertAiGenerationLog): Promise<AiGenerationLog> {
    const [result] = await db.insert(aiGenerationLogs).values(log).returning();
    return result;
  }

  // Manual Part Reviews
  async getManualPartReviews(companyId: number): Promise<ManualPartReview[]> {
    return await db.select().from(manualPartReviews)
      .where(and(eq(manualPartReviews.companyId, companyId), eq(manualPartReviews.approvalStatus, 'pending')))
      .orderBy(desc(manualPartReviews.createdAt));
  }

  async getManualPartReview(id: number): Promise<ManualPartReview | undefined> {
    const [result] = await db.select().from(manualPartReviews).where(eq(manualPartReviews.id, id));
    return result;
  }

  async createManualPartReview(review: InsertManualPartReview): Promise<ManualPartReview> {
    const [result] = await db.insert(manualPartReviews).values(review).returning();
    return result;
  }

  async approveManualPartReview(id: number, reviewedPrice: string): Promise<ManualPartReview | undefined> {
    const review = await this.getManualPartReview(id);
    if (!review) return undefined;

    // Update the review record
    const [updatedReview] = await db.update(manualPartReviews)
      .set({ approvalStatus: 'approved', reviewedPrice, approvedAt: new Date() })
      .where(eq(manualPartReviews.id, id))
      .returning();

    // If linked to a billing sheet item, update its unit price and recalculate total price
    if (review.billingSheetItemId) {
      const [linkedItem] = await db.select().from(billingSheetItems).where(eq(billingSheetItems.id, review.billingSheetItemId));
      const qty = linkedItem ? parseFloat(linkedItem.quantity ?? '1') : 1;
      const newTotal = (qty * parseFloat(reviewedPrice)).toFixed(2);
      await db.update(billingSheetItems)
        .set({ unitPrice: reviewedPrice, totalPrice: newTotal })
        .where(eq(billingSheetItems.id, review.billingSheetItemId));
    }

    return updatedReview;
  }

  // Parts Pending Approval
  async getPendingParts(companyId: number): Promise<Part[]> {
    return await db.select().from(parts)
      .where(and(eq(parts.companyId, companyId), eq(parts.approvalStatus, 'pending')))
      .orderBy(desc(parts.createdAt));
  }

  async approvePart(id: number, price: string, cost?: string, companyId?: number): Promise<Part | undefined> {
    // Update the part itself
    const updateFields: Partial<typeof parts.$inferInsert> = {
      approvalStatus: 'approved',
      approvedAt: new Date(),
      price,
      updatedAt: new Date(),
    };
    if (cost !== undefined) updateFields.cost = cost;

    const [updatedPart] = await db.update(parts)
      .set(updateFields)
      .where(eq(parts.id, id))
      .returning();

    if (!updatedPart) return undefined;

    // Propagate the new price to all uninvoiced billing_sheet_items referencing this part.
    // Parts are inherently company-scoped (each part belongs to one company), so filtering by
    // partId alone prevents cross-tenant contamination without needing a companyId join.
    const uninvoicedBillingSheets = await db.select({ id: billingSheets.id })
      .from(billingSheets)
      .where(isNull(billingSheets.invoiceId));

    if (uninvoicedBillingSheets.length > 0) {
      for (const bs of uninvoicedBillingSheets) {
        // Fetch the affected items so we can recalculate total_price per-item (quantity varies)
        const affectedItems = await db.select()
          .from(billingSheetItems)
          .where(and(eq(billingSheetItems.partId, id), eq(billingSheetItems.billingSheetId, bs.id)));
        for (const item of affectedItems) {
          const qty = parseFloat(item.quantity ?? '1');
          const newTotal = (qty * parseFloat(price)).toFixed(2);
          await db.update(billingSheetItems)
            .set({ unitPrice: price, totalPrice: newTotal })
            .where(eq(billingSheetItems.id, item.id));
        }
      }
    }

    // Propagate the new price to all uninvoiced work_order_items referencing this part.
    const uninvoicedWorkOrders = await db.select({ id: workOrders.id })
      .from(workOrders)
      .where(isNull(workOrders.invoiceId));

    if (uninvoicedWorkOrders.length > 0) {
      for (const wo of uninvoicedWorkOrders) {
        await db.update(workOrderItems)
          .set({ partPrice: price })
          .where(and(eq(workOrderItems.partId, id), eq(workOrderItems.workOrderId, wo.id)));
      }
    }

    return updatedPart;
  }

  // ── Wet Check System (Slice 2A) ───────────────────────────────────────────
  async listIssueTypeConfigs(companyId: number): Promise<IssueTypeConfig[]> {
    return await db.select().from(issueTypeConfigs)
      .where(and(eq(issueTypeConfigs.companyId, companyId), eq(issueTypeConfigs.isActive, true)))
      .orderBy(issueTypeConfigs.sortOrder);
  }

  async listAllIssueTypeConfigs(companyId: number): Promise<IssueTypeConfig[]> {
    return await db.select().from(issueTypeConfigs)
      .where(eq(issueTypeConfigs.companyId, companyId))
      .orderBy(issueTypeConfigs.sortOrder);
  }

  async createIssueTypeConfig(
    companyId: number,
    data: Omit<InsertIssueTypeConfig, "companyId">,
  ): Promise<IssueTypeConfig> {
    const [row] = await db.insert(issueTypeConfigs).values({
      ...data,
      companyId,
    }).returning();
    return row;
  }

  async updateIssueTypeConfig(
    companyId: number,
    id: number,
    patch: Partial<Omit<InsertIssueTypeConfig, "companyId">>,
  ): Promise<IssueTypeConfig | undefined> {
    const [row] = await db.update(issueTypeConfigs)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(issueTypeConfigs.id, id), eq(issueTypeConfigs.companyId, companyId)))
      .returning();
    return row;
  }

  async reorderIssueTypeConfigs(companyId: number, orderedIds: number[]): Promise<IssueTypeConfig[]> {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.update(issueTypeConfigs)
        .set({ sortOrder: (i + 1) * 10, updatedAt: new Date() })
        .where(and(
          eq(issueTypeConfigs.id, orderedIds[i]),
          eq(issueTypeConfigs.companyId, companyId),
        ));
    }
    return await this.listAllIssueTypeConfigs(companyId);
  }

  async getPartsByIssueType(companyId: number, issueType: string, customerId?: number | null): Promise<{ parts: Part[]; recentPartIds: number[] }> {
    const [cfg] = await db.select().from(issueTypeConfigs)
      .where(and(eq(issueTypeConfigs.companyId, companyId), eq(issueTypeConfigs.issueType, issueType)));
    const filter = cfg?.partCategoryFilter?.trim() ?? null;
    const conds = [eq(parts.companyId, companyId), eq(parts.approvalStatus, "approved")];
    if (filter) conds.push(ilike(parts.category, `%${filter}%`));
    const list = await db.select().from(parts).where(and(...conds)).orderBy(parts.name).limit(200);

    // Identify parts recently used at this property (last ~90 days of
    // billing-sheet items) so the field UI can show a "Recent at this
    // property" header above the rest of the list.
    let recentIds = new Set<number>();
    if (customerId) {
      const recent = await db.select({ partId: billingSheetItems.partId })
        .from(billingSheetItems)
        .innerJoin(billingSheets, eq(billingSheetItems.billingSheetId, billingSheets.id))
        .where(and(
          eq(billingSheets.customerId, customerId),
          sql`${billingSheets.workDate} >= NOW() - INTERVAL '90 days'`,
        ))
        .limit(200);
      recentIds = new Set<number>(recent.map(r => r.partId).filter((x): x is number => !!x));
      if (recentIds.size > 0) {
        list.sort((a, b) => {
          const ar = recentIds.has(a.id) ? 0 : 1;
          const br = recentIds.has(b.id) ? 0 : 1;
          if (ar !== br) return ar - br;
          return a.name.localeCompare(b.name);
        });
      }
    }
    return { parts: list, recentPartIds: Array.from(recentIds) };
  }

  // Task #1857: listPropertyControllers, branchKey, branchEq, ensurePropertyControllers,
  // upsertPropertyController, updatePropertyController removed — property_controllers dropped.
  // irrigation_controllers is now the single source of truth.

  async listCustomerControllersOverview(companyId: number): Promise<Array<{
    customer: Customer;
    branches: Array<{ branchName: string | null; controllers: IrrigationController[] }>;
  }>> {
    const custs = await db.select().from(customers)
      .where(and(
        eq(customers.companyId, companyId),
        sql`coalesce(${customers.hiddenFromBilling}, false) = false`,
      ))
      .orderBy(customers.name);
    if (custs.length === 0) return [];

    const ctrls = await db.select().from(irrigationControllers)
      .where(and(
        eq(irrigationControllers.companyId, companyId),
        inArray(irrigationControllers.customerId, custs.map(c => c.id)),
      ))
      .orderBy(irrigationControllers.letter, irrigationControllers.name);

    // Group: customerId -> (branchKey -> rows).
    const byCust = new Map<number, Map<string, IrrigationController[]>>();
    for (const c of ctrls) {
      const branchKey = c.branchName ?? "";
      let perBranch = byCust.get(c.customerId);
      if (!perBranch) { perBranch = new Map(); byCust.set(c.customerId, perBranch); }
      const arr = perBranch.get(branchKey) ?? [];
      arr.push(c);
      perBranch.set(branchKey, arr);
    }

    return custs.map(customer => {
      const perBranch = byCust.get(customer.id) ?? new Map<string, IrrigationController[]>();
      const declaredBranches = (customer.branches ?? []).filter((b): b is string => typeof b === "string" && b.length > 0);
      const orderedBranches: Array<{ branchName: string | null; controllers: IrrigationController[] }> = [];
      const customerLevelRows = perBranch.get("") ?? [];
      if (customerLevelRows.length > 0 || declaredBranches.length === 0) {
        orderedBranches.push({ branchName: null, controllers: customerLevelRows });
      }
      for (const b of declaredBranches) {
        orderedBranches.push({ branchName: b, controllers: perBranch.get(b) ?? [] });
      }
      return { customer, branches: orderedBranches };
    });
  }

  async setCustomerControllerCount(
    companyId: number,
    customerId: number,
    count: number,
    opts?: { confirmDeleteWithZones?: boolean; branchName?: string | null },
  ): Promise<{ customer: Customer; controllers: IrrigationController[]; removedLetters: string[] }> {
    if (!Number.isInteger(count) || count < 1 || count > 26) {
      throw new Error("Controller count must be between 1 and 26");
    }
    const branch = typeof opts?.branchName === "string" ? opts.branchName.trim() : "";
    const [customer] = await db.select().from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
    if (!customer) throw new Error("Customer not found");

    const existing = await db.select().from(irrigationControllers)
      .where(and(
        eq(irrigationControllers.companyId, companyId),
        eq(irrigationControllers.customerId, customerId),
        eq(irrigationControllers.branchName, branch),
      ))
      .orderBy(irrigationControllers.letter, irrigationControllers.name);

    // Determine which letters belong to the new size.
    const keepLetters = new Set<string>();
    for (let i = 0; i < count; i++) {
      keepLetters.add(String.fromCharCode("A".charCodeAt(0) + i));
    }

    // Only shrink controllers that have a stored letter.
    const toRemove = existing.filter(c => c.letter != null && !keepLetters.has(c.letter));
    const removedLetters = toRemove.map(c => c.letter as string).sort();

    if (toRemove.length > 0) {
      const withZones = toRemove.filter(c => (c.totalZones ?? 0) > 0).map(c => c.letter as string);
      if (withZones.length > 0 && !opts?.confirmDeleteWithZones) {
        throw new ControllerHasZonesError(withZones.sort());
      }
      // Mark zone records on in-progress wet checks as not_applicable,
      // resolved by controller_id (Task #1857 Slice 1).
      const toRemoveIds = toRemove.map(c => c.id);
      const inProgressIds = await db.select({ id: wetChecks.id }).from(wetChecks)
        .where(and(
          eq(wetChecks.companyId, companyId),
          eq(wetChecks.customerId, customerId),
          eq(wetChecks.status, "in_progress"),
        ));
      const wcIds = inProgressIds.map(r => r.id);
      if (wcIds.length > 0 && toRemoveIds.length > 0) {
        await db.update(wetCheckZoneRecords)
          .set({ status: "not_applicable" })
          .where(and(
            inArray(wetCheckZoneRecords.wetCheckId, wcIds),
            inArray(wetCheckZoneRecords.controllerId, toRemoveIds),
          ));
      }
      await db.delete(irrigationControllers).where(
        inArray(irrigationControllers.id, toRemoveIds),
      );
    }

    // Add any missing letters up to the new count.
    const existingLetters = new Set(
      existing.filter(c => c.letter != null).map(c => c.letter as string),
    );
    const toAdd: string[] = [];
    for (let i = 0; i < count; i++) {
      const letter = String.fromCharCode("A".charCodeAt(0) + i);
      if (!existingLetters.has(letter)) toAdd.push(letter);
    }
    if (toAdd.length > 0) {
      await db.insert(irrigationControllers)
        .values(toAdd.map(letter => ({
          companyId,
          customerId,
          branchName: branch,
          name: `Controller ${letter}`,
          letter,
          isActive: true,
          lastUpdatedAt: new Date(),
        })))
        .onConflictDoNothing();
    }

    const refreshed = await db.select().from(irrigationControllers)
      .where(and(
        eq(irrigationControllers.companyId, companyId),
        eq(irrigationControllers.customerId, customerId),
        eq(irrigationControllers.branchName, branch),
      ))
      .orderBy(irrigationControllers.letter, irrigationControllers.name);
    return { customer, controllers: refreshed, removedLetters };
  }

  async listWetChecks(companyId: number, opts?: { status?: string; technicianId?: number; customerId?: number; branchName?: string }): Promise<Array<WetCheck & { zoneCount: number; processedCount: number; failedCount: number; workOrderIds: number[] }>> {
    const conds = [eq(wetChecks.companyId, companyId)];
    if (opts?.status) conds.push(eq(wetChecks.status, opts.status));
    if (opts?.technicianId) conds.push(eq(wetChecks.technicianId, opts.technicianId));
    if (opts?.customerId) conds.push(eq(wetChecks.customerId, opts.customerId));
    if (opts?.branchName != null) conds.push(eq(wetChecks.branchName, opts.branchName));
    // When scoped to a single customer the route applies paginate() for
    // offset-based loading; don't cap here so the helper sees the full
    // result set and can set an accurate X-Total-Count. For the generic
    // (company-wide) list keep the existing 200-row safety cap.
    const baseQ = db.select().from(wetChecks).where(and(...conds)).orderBy(desc(wetChecks.startedAt));
    const wcs = await (opts?.customerId ? baseQ : baseQ.limit(200));
    if (wcs.length === 0) return [];
    const ids = wcs.map(w => w.id);

    // Per-row zone count + processed/failed breakdown + linked work order ids
    // so the mobile/list UIs can show stats without N+1 fetches.
    // processed = ranSuccessfully IS TRUE, failed = ranSuccessfully IS FALSE
    // (NULL means the zone record exists but hasn't been evaluated yet).
    const zoneRows = await db.select({
      wetCheckId: wetCheckZoneRecords.wetCheckId,
      n: sql<number>`count(*)::int`,
      processed: sql<number>`count(*) filter (where ${wetCheckZoneRecords.ranSuccessfully} = true)::int`,
      failed: sql<number>`count(*) filter (where ${wetCheckZoneRecords.ranSuccessfully} = false)::int`,
    }).from(wetCheckZoneRecords)
      .where(inArray(wetCheckZoneRecords.wetCheckId, ids))
      .groupBy(wetCheckZoneRecords.wetCheckId);
    const woRows = await db.selectDistinct({
      wetCheckId: wetCheckFindings.wetCheckId,
      workOrderId: wetCheckFindings.workOrderId,
    }).from(wetCheckFindings)
      .where(and(
        inArray(wetCheckFindings.wetCheckId, ids),
        sql`${wetCheckFindings.workOrderId} IS NOT NULL`,
      ));

    const zoneMap = new Map(zoneRows.map(r => [r.wetCheckId, { n: Number(r.n), processed: Number(r.processed), failed: Number(r.failed) }]));
    const woMap = new Map<number, number[]>();
    for (const r of woRows) {
      if (r.workOrderId == null) continue;
      const list = woMap.get(r.wetCheckId) ?? [];
      list.push(r.workOrderId);
      woMap.set(r.wetCheckId, list);
    }
    for (const list of woMap.values()) list.sort((a, b) => a - b);

    return wcs.map(wc => {
      const z = zoneMap.get(wc.id);
      return {
        ...wc,
        zoneCount: z?.n ?? 0,
        processedCount: z?.processed ?? 0,
        failedCount: z?.failed ?? 0,
        workOrderIds: woMap.get(wc.id) ?? [],
      };
    });
  }

  async listWetChecksForAdmin(
    companyId: number,
    opts?: { status?: string | string[] },
  ): Promise<Array<WetCheck & { zoneRecordCount: number; findingCount: number; photoCount: number }>> {
    const conds = [eq(wetChecks.companyId, companyId)];
    if (opts?.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      if (statuses.length === 1) {
        conds.push(eq(wetChecks.status, statuses[0]));
      } else if (statuses.length > 1) {
        conds.push(inArray(wetChecks.status, statuses));
      }
    }
    // Admin list is the canonical "show every wet check" surface for
    // company admins (used to find and delete records). Returning the
    // full set avoids silently hiding older rows; callers narrow the
    // result with the status filter and the client-side search box.
    const wcs = await db.select().from(wetChecks)
      .where(and(...conds))
      .orderBy(desc(wetChecks.startedAt));
    if (wcs.length === 0) return [];
    const ids = wcs.map(w => w.id);

    // Per-wet-check counts via three small grouped queries; cheaper than
    // joining and de-duplicating in app code.
    const zoneRows = await db.select({
      wetCheckId: wetCheckZoneRecords.wetCheckId,
      n: sql<number>`count(*)::int`,
    }).from(wetCheckZoneRecords)
      .where(inArray(wetCheckZoneRecords.wetCheckId, ids))
      .groupBy(wetCheckZoneRecords.wetCheckId);
    const findingRows = await db.select({
      wetCheckId: wetCheckFindings.wetCheckId,
      n: sql<number>`count(*)::int`,
    }).from(wetCheckFindings)
      .where(inArray(wetCheckFindings.wetCheckId, ids))
      .groupBy(wetCheckFindings.wetCheckId);
    const photoRows = await db.select({
      wetCheckId: wetCheckPhotos.wetCheckId,
      n: sql<number>`count(*)::int`,
    }).from(wetCheckPhotos)
      .where(inArray(wetCheckPhotos.wetCheckId, ids))
      .groupBy(wetCheckPhotos.wetCheckId);

    const zoneMap = new Map(zoneRows.map(r => [r.wetCheckId, Number(r.n)]));
    const findingMap = new Map(findingRows.map(r => [r.wetCheckId, Number(r.n)]));
    const photoMap = new Map(photoRows.map(r => [r.wetCheckId, Number(r.n)]));

    return wcs.map(wc => ({
      ...wc,
      zoneRecordCount: zoneMap.get(wc.id) ?? 0,
      findingCount: findingMap.get(wc.id) ?? 0,
      photoCount: photoMap.get(wc.id) ?? 0,
    }));
  }

  async deleteWetCheck(id: number, companyId: number): Promise<boolean> {
    // Scope-check first so a cross-company id leaks no information.
    await this.assertWetCheckBelongsToCompany(id, companyId);

    // Gather every downstream record produced from this wet check's
    // findings. A finding may route to one of {billing sheet, estimate,
    // work order}. A routed estimate may further have been converted
    // into its own work order (estimates.workOrderId), which is also
    // part of the wet check's downstream chain — we must consider it
    // for both the invoice block and the cascade delete.
    const findings = await db.select({
      billingSheetId: wetCheckFindings.billingSheetId,
      wetCheckBillingId: wetCheckFindings.wetCheckBillingId,
      estimateId: wetCheckFindings.estimateId,
      workOrderId: wetCheckFindings.workOrderId,
    }).from(wetCheckFindings).where(eq(wetCheckFindings.wetCheckId, id));
    const billingSheetIds = Array.from(new Set(
      findings.map(f => f.billingSheetId).filter((v): v is number => v != null)));
    const wcbIds = Array.from(new Set(
      findings.map(f => f.wetCheckBillingId).filter((v): v is number => v != null)));
    const directEstimateIds = Array.from(new Set(
      findings.map(f => f.estimateId).filter((v): v is number => v != null)));
    const directWorkOrderIds = new Set<number>(
      findings.map(f => f.workOrderId).filter((v): v is number => v != null));

    // Pull estimate rows so we can a) know each estimate's display number
    // for blocker messages and b) discover any work order chained off a
    // routed estimate.
    const estimateRows = directEstimateIds.length > 0
      ? await db.select({
          id: estimates.id,
          estimateNumber: estimates.estimateNumber,
          workOrderId: estimates.workOrderId,
        }).from(estimates).where(inArray(estimates.id, directEstimateIds))
      : [];
    for (const e of estimateRows) {
      if (e.workOrderId != null) directWorkOrderIds.add(e.workOrderId);
    }
    const workOrderIds = Array.from(directWorkOrderIds);

    // Resolve invoice linkage for each downstream record. Mirrors the
    // checks deleteBillingSheet runs (billing_sheets.invoiceId or any
    // invoice_items.billingSheetId), with the equivalent for work
    // orders (work_orders.invoiceId or invoice_items.workOrderId).
    //
    // NOTE on `kind: "estimate"` blockers: estimates have no invoiceId
    // column and `invoice_items` has no estimateId column (see shared/
    // schema.ts). The only path an estimate row can reach an invoice is
    // via the work order it was converted into (estimates.workOrderId).
    // That work order is already promoted into `workOrderIds` above and
    // covered by the work-order block below, so we never emit a
    // `kind: "estimate"` blocker. The route + UI accept "estimate" in the
    // contract for forward-compat (e.g. if a direct estimate→invoice link
    // is ever added), but today this branch is intentionally empty.
    const blockers: WetCheckInvoiceBlocker[] = [];

    // Billing sheet blockers
    const bsRows = billingSheetIds.length > 0
      ? await db.select({
          id: billingSheets.id,
          billingNumber: billingSheets.billingNumber,
          invoiceId: billingSheets.invoiceId,
        }).from(billingSheets).where(inArray(billingSheets.id, billingSheetIds))
      : [];
    const bsItemRows = billingSheetIds.length > 0
      ? await db.select({
          billingSheetId: invoiceItems.billingSheetId,
          invoiceId: invoiceItems.invoiceId,
        }).from(invoiceItems).where(inArray(invoiceItems.billingSheetId, billingSheetIds))
      : [];
    const bsItemInvoiceByBs = new Map<number, number | null>();
    for (const r of bsItemRows) {
      if (r.billingSheetId == null) continue;
      if (!bsItemInvoiceByBs.has(r.billingSheetId)) {
        bsItemInvoiceByBs.set(r.billingSheetId, r.invoiceId ?? null);
      }
    }
    for (const bs of bsRows) {
      const linkedInvoiceId = bs.invoiceId ?? bsItemInvoiceByBs.get(bs.id) ?? null;
      if (linkedInvoiceId == null && !bsItemInvoiceByBs.has(bs.id)) continue;
      // Either invoiceId set, or there is at least one matching invoice_item
      let invoiceNumber: string | null = null;
      if (linkedInvoiceId != null) {
        const [inv] = await db.select({ invoiceNumber: invoices.invoiceNumber })
          .from(invoices).where(eq(invoices.id, linkedInvoiceId));
        invoiceNumber = inv?.invoiceNumber ?? null;
      }
      blockers.push({
        kind: "billing_sheet",
        id: bs.id,
        displayNumber: bs.billingNumber ?? null,
        invoiceId: linkedInvoiceId,
        invoiceNumber,
      });
    }

    // Work order blockers (covers both directly-routed work orders and
    // work orders chained off a routed estimate).
    const woRows = workOrderIds.length > 0
      ? await db.select({
          id: workOrders.id,
          workOrderNumber: workOrders.workOrderNumber,
          invoiceId: workOrders.invoiceId,
        }).from(workOrders).where(inArray(workOrders.id, workOrderIds))
      : [];
    const woItemRows = workOrderIds.length > 0
      ? await db.select({
          workOrderId: invoiceItems.workOrderId,
          invoiceId: invoiceItems.invoiceId,
        }).from(invoiceItems).where(inArray(invoiceItems.workOrderId, workOrderIds))
      : [];
    const woItemInvoiceByWo = new Map<number, number | null>();
    for (const r of woItemRows) {
      if (r.workOrderId == null) continue;
      if (!woItemInvoiceByWo.has(r.workOrderId)) {
        woItemInvoiceByWo.set(r.workOrderId, r.invoiceId ?? null);
      }
    }
    for (const wo of woRows) {
      const linkedInvoiceId = wo.invoiceId ?? woItemInvoiceByWo.get(wo.id) ?? null;
      if (linkedInvoiceId == null && !woItemInvoiceByWo.has(wo.id)) continue;
      let invoiceNumber: string | null = null;
      if (linkedInvoiceId != null) {
        const [inv] = await db.select({ invoiceNumber: invoices.invoiceNumber })
          .from(invoices).where(eq(invoices.id, linkedInvoiceId));
        invoiceNumber = inv?.invoiceNumber ?? null;
      }
      blockers.push({
        kind: "work_order",
        id: wo.id,
        displayNumber: wo.workOrderNumber ?? null,
        invoiceId: linkedInvoiceId,
        invoiceNumber,
      });
    }

    // Second pass: any billing sheet linked by a finding but NOT yet on an
    // invoice is also a blocker. The zone-grouped billing renderer depends
    // on those zone records remaining intact, so we close this back door
    // before the invoiced-records check (which takes priority when both fire).
    const invoicedBsIds = new Set(
      blockers.filter(b => b.kind === "billing_sheet").map(b => b.id)
    );
    const uninvoicedBsBlockers: Array<{ id: number; billingNumber: string | null }> = [];
    for (const bs of bsRows) {
      if (!invoicedBsIds.has(bs.id)) {
        uninvoicedBsBlockers.push({ id: bs.id, billingNumber: bs.billingNumber ?? null });
      }
    }

    // Third pass: WCB blocker check. Invoiced WCBs fold into WetCheckHasInvoicedRecordsError
    // (same priority tier as invoiced BS/WO). Uninvoiced WCBs form a new error tier below
    // uninvoiced BS but above unconditional cascade (priority: invoiced → uninvoiced BS → uninvoiced WCB).
    const uninvoicedWcbBlockers: Array<{ id: number; billingNumber: string | null }> = [];
    if (wcbIds.length > 0) {
      const wcbRows = await db.select({
        id: wetCheckBillings.id,
        billingNumber: wetCheckBillings.billingNumber,
        invoiceId: wetCheckBillings.invoiceId,
      }).from(wetCheckBillings).where(inArray(wetCheckBillings.id, wcbIds));
      for (const wcb of wcbRows) {
        if (wcb.invoiceId != null) {
          let invoiceNumber: string | null = null;
          const [inv] = await db.select({ invoiceNumber: invoices.invoiceNumber })
            .from(invoices).where(eq(invoices.id, wcb.invoiceId));
          invoiceNumber = inv?.invoiceNumber ?? null;
          blockers.push({
            kind: "wet_check_billing",
            id: wcb.id,
            displayNumber: wcb.billingNumber ?? null,
            invoiceId: wcb.invoiceId,
            invoiceNumber,
          });
        } else {
          uninvoicedWcbBlockers.push({ id: wcb.id, billingNumber: wcb.billingNumber ?? null });
        }
      }
    }

    if (blockers.length > 0) {
      // Sort for stable, predictable message ordering (kind then id).
      blockers.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
      throw new WetCheckHasInvoicedRecordsError(id, blockers);
    }

    if (uninvoicedBsBlockers.length > 0) {
      uninvoicedBsBlockers.sort((a, b) => a.id - b.id);
      throw new WetCheckHasBillingSheetError(id, uninvoicedBsBlockers);
    }

    if (uninvoicedWcbBlockers.length > 0) {
      uninvoicedWcbBlockers.sort((a, b) => a.id - b.id);
      throw new WetCheckHasWetCheckBillingError(id, uninvoicedWcbBlockers);
    }

    // Snapshot every photo URL across the wet check AND every downstream
    // record we are about to delete, so the object-storage cleanup pass
    // below has a stable list even after the rows are gone. Done before
    // the transaction so a transient storage failure can't roll back the
    // DB.
    const wcPhotoRows = await db.select({ url: wetCheckPhotos.url })
      .from(wetCheckPhotos).where(eq(wetCheckPhotos.wetCheckId, id));
    const downstreamPhotoUrls: string[] = [];
    if (billingSheetIds.length > 0) {
      const rows = await db.select({ photos: billingSheets.photos })
        .from(billingSheets).where(inArray(billingSheets.id, billingSheetIds));
      for (const r of rows) for (const u of (r.photos ?? [])) if (u) downstreamPhotoUrls.push(u);
    }
    if (estimateRows.length > 0) {
      const rows = await db.select({ photos: estimates.photos, attachments: estimates.attachments })
        .from(estimates).where(inArray(estimates.id, estimateRows.map(e => e.id)));
      for (const r of rows) {
        for (const u of (r.photos ?? [])) if (u) downstreamPhotoUrls.push(u);
        for (const u of (r.attachments ?? [])) if (u) downstreamPhotoUrls.push(u);
      }
    }
    if (workOrderIds.length > 0) {
      const rows = await db.select({ photos: workOrders.photos, attachments: workOrders.attachments })
        .from(workOrders).where(inArray(workOrders.id, workOrderIds));
      for (const r of rows) {
        for (const u of (r.photos ?? [])) if (u) downstreamPhotoUrls.push(u);
        for (const u of (r.attachments ?? [])) if (u) downstreamPhotoUrls.push(u);
      }
    }

    // Single transaction so a partial cascade can't strand orphan rows.
    // Order matters because of FKs:
    //   1. Wet-check children whose FKs point AT the downstream records
    //      (wet_check_photos.findingId, wet_check_findings.{billingSheetId,
    //      estimateId, workOrderId}, wet_check_zone_records). We delete
    //      these first so removing the downstream rows below can't trip
    //      a wet-check-side FK.
    //   2. Work-order children → work orders. Done before estimates because
    //      work_orders.estimateId references estimates.
    //   3. Estimate children → estimates.
    //   4. Billing-sheet children → billing sheets.
    //   5. Wet check row itself.
    const ok = await db.transaction(async (tx) => {
      await tx.delete(wetCheckPhotos).where(eq(wetCheckPhotos.wetCheckId, id));
      await tx.delete(wetCheckFindings).where(eq(wetCheckFindings.wetCheckId, id));
      await tx.delete(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.wetCheckId, id));

      // Delete WCBs only after findings are removed (findings FK → WCBs).
      // By the time we reach this transaction, all WCB blockers have been
      // cleared by the throw checks above, so wcbIds will be empty for any
      // wet check that had live WCBs. The delete is still present as a safe
      // catch-all for edge cases (e.g. broken FK state after a migration).
      if (wcbIds.length > 0) {
        await tx.delete(wetCheckBillings).where(inArray(wetCheckBillings.id, wcbIds));
      }

      if (workOrderIds.length > 0) {
        await tx.delete(workOrderItems).where(inArray(workOrderItems.workOrderId, workOrderIds));
        await tx.delete(workOrders).where(inArray(workOrders.id, workOrderIds));
      }
      if (estimateRows.length > 0) {
        const estIds = estimateRows.map(e => e.id);
        await tx.delete(estimateItems).where(inArray(estimateItems.estimateId, estIds));
        // quickbooks_sync.estimateId is ON DELETE CASCADE, so no explicit
        // delete needed here — it falls away with the estimate row.
        await tx.delete(estimates).where(inArray(estimates.id, estIds));
      }
      if (billingSheetIds.length > 0) {
        await tx.delete(manualPartReviews)
          .where(inArray(manualPartReviews.billingSheetId, billingSheetIds));
        await tx.delete(billingSheetItems)
          .where(inArray(billingSheetItems.billingSheetId, billingSheetIds));
        await tx.delete(billingSheets).where(inArray(billingSheets.id, billingSheetIds));
      }

      const result = await tx.delete(wetChecks)
        .where(and(eq(wetChecks.id, id), eq(wetChecks.companyId, companyId)));
      return (result.rowCount ?? 0) > 0;
    });

    if (ok) {
      // Best-effort blob cleanup (thumb / medium / original / heic-cache /
      // base) for every photo attached to the deleted wet check AND every
      // photo on the deleted downstream records. Failures are logged
      // inside deletePhotoBlobs and never bubble up — the DB is already
      // consistent at this point.
      const allUrls = [...wcPhotoRows.map(p => p.url), ...downstreamPhotoUrls].filter(Boolean);
      if (allUrls.length > 0) {
        const objectStorage = new ObjectStorageService();
        await Promise.all(allUrls.map(u => objectStorage.deletePhotoBlobs(u)));
      }
    }
    return ok;
  }

  // Inbox aggregate for the manager review surface. Returns every
  // 'submitted' wet check together with its findings-by-issueGroup count
  // and a server-computed total estimated billable amount (using the
  // customer's laborRate snapshot at read time). The UI uses this to
  // render the per-row summary chips without doing N+1 fetches.
  async listWetChecksPendingReview(companyId: number): Promise<Array<WetCheck & {
    findingCounts: { quick_fix: number; advanced: number; zone_issue: number; total: number };
    totalBillable: string;
    customerLaborRate: string;
    autoBilledCount: number;
    autoBilledTotal: string;
    pendingCount: number;
    pendingTotal: string;
    dispositionCounts: { completed_in_field: number; needs_review: number };
  }>> {
    // Queue is status-based by default (Slice 2 behavior). With Slice 3's
    // WET_CHECK_AUTO_BILL flag ON we additionally narrow the result to
    // wet checks that have at least one finding still needing manager
    // attention (resolution=pending OR a non-pending finding without a
    // convertedAt stamp), so all-auto-billed wet checks correctly drop
    // out of the queue. With the flag OFF we restore the original
    // status-only filter so flag-off behavior is identical to Slice 2.
    const autoBillEnabled = process.env.WET_CHECK_AUTO_BILL !== "false";
    const wcs = await db.select().from(wetChecks).where(and(
      eq(wetChecks.companyId, companyId),
      inArray(wetChecks.status, ["submitted", "partially_converted"]),
    )).orderBy(desc(wetChecks.submittedAt)).limit(200);
    if (wcs.length === 0) return [];
    const ids = wcs.map(w => w.id);
    const findings = await db.select().from(wetCheckFindings)
      .where(inArray(wetCheckFindings.wetCheckId, ids));
    let filteredWcs = wcs;
    if (autoBillEnabled) {
      const needsAttention = (f: WetCheckFinding) =>
        f.resolution === "pending" || f.convertedAt == null;
      const needsAttentionByWc = new Map<number, boolean>();
      for (const f of findings) {
        if (needsAttention(f)) needsAttentionByWc.set(f.wetCheckId, true);
      }
      // Spec wording: queue membership requires "at least one finding
      // where (resolution=pending OR convertedAt IS NULL)". Zero-finding
      // wet checks therefore drop off the queue; with no findings to
      // route, there's nothing for the manager to act on.
      filteredWcs = wcs.filter(w => needsAttentionByWc.get(w.id) === true);
      if (filteredWcs.length === 0) return [];
    }
    // Reuse the already-fetched findings; just narrow the customer
    // resolution to the surviving wet checks.
    const customerIds = Array.from(new Set(filteredWcs.map(w => w.customerId)));
    const custs = await db.select().from(customers).where(inArray(customers.id, customerIds));
    const rateByCustomer = new Map<number, number>();
    for (const c of custs) rateByCustomer.set(c.id, parseFloat(String(c.laborRate ?? "45")));

    const findingsByWc = new Map<number, WetCheckFinding[]>();
    for (const f of findings) {
      const arr = findingsByWc.get(f.wetCheckId) ?? [];
      arr.push(f);
      findingsByWc.set(f.wetCheckId, arr);
    }

    return filteredWcs.map(wc => {
      const fs = findingsByWc.get(wc.id) ?? [];
      const counts = { quick_fix: 0, advanced: 0, zone_issue: 0, total: fs.length };
      const rate = rateByCustomer.get(wc.customerId) ?? 45;
      let billable = 0;
      // Per-resolution breakdown for the manager inbox card pills:
      //   - autoBilled = findings already auto-routed to a billing sheet
      //     (repaired_in_field, the only resolution that creates billable
      //     work without further manager input).
      //   - pending = findings still awaiting a routing decision.
      let autoBilledCount = 0;
      let autoBilledTotal = 0;
      let pendingCount = 0;
      let pendingTotal = 0;
      const dispositionCounts = { completed_in_field: 0, needs_review: 0 };
      for (const f of fs) {
        const g = (f.issueGroup as keyof typeof counts) ?? "advanced";
        if (g === "quick_fix" || g === "advanced" || g === "zone_issue") counts[g]++;
        if (f.techDisposition === "completed_in_field") dispositionCounts.completed_in_field++;
        else dispositionCounts.needs_review++;
        const partPrice = parseFloat(String(f.partPrice ?? 0));
        const qty = Number(f.quantity ?? 0);
        const laborHours = parseFloat(String(f.laborHours ?? 0));
        const lineTotal = partPrice * qty + laborHours * rate;
        // Total estimated billable spans the two monetised buckets:
        // repaired_in_field (→ billing sheet) and sent_to_estimate.
        // 'pending' findings are included so the manager can see the
        // upper-bound shape of the visit before deciding routing.
        const isMonetised =
          f.resolution === "repaired_in_field" ||
          f.resolution === "sent_to_estimate" ||
          f.resolution === "pending";
        if (isMonetised) billable += lineTotal;
        if (f.resolution === "repaired_in_field") {
          autoBilledCount++;
          autoBilledTotal += lineTotal;
        } else if (!f.resolution || f.resolution === "pending") {
          pendingCount++;
          pendingTotal += lineTotal;
        }
      }
      return {
        ...wc,
        findingCounts: counts,
        totalBillable: billable.toFixed(2),
        customerLaborRate: rate.toFixed(2),
        autoBilledCount,
        autoBilledTotal: autoBilledTotal.toFixed(2),
        pendingCount,
        pendingTotal: pendingTotal.toFixed(2),
        dispositionCounts,
      };
    });
  }

  async getWetCheckStatusForFinding(findingId: number, companyId: number): Promise<{ status: string; mode: string } | null> {
    const [row] = await db.select({ status: wetChecks.status, mode: wetChecks.mode })
      .from(wetCheckFindings)
      .innerJoin(wetChecks, eq(wetChecks.id, wetCheckFindings.wetCheckId))
      .where(and(
        eq(wetCheckFindings.id, findingId),
        eq(wetChecks.companyId, companyId),
      ));
    return row ?? null;
  }

  async getWetCheckModeForZoneRecord(zoneRecordId: number, companyId: number): Promise<string | null> {
    const [row] = await db.select({ mode: wetChecks.mode })
      .from(wetCheckZoneRecords)
      .innerJoin(wetChecks, eq(wetChecks.id, wetCheckZoneRecords.wetCheckId))
      .where(and(
        eq(wetCheckZoneRecords.id, zoneRecordId),
        eq(wetChecks.companyId, companyId),
      ));
    return row?.mode ?? null;
  }

  async getWetCheckFindingSnapshot(findingId: number, companyId: number): Promise<{
    issueType: string;
    resolution: string;
    partId: number | null;
    noPartNeeded: boolean;
  } | null> {
    const [row] = await db
      .select({
        issueType: wetCheckFindings.issueType,
        resolution: wetCheckFindings.resolution,
        partId: wetCheckFindings.partId,
        noPartNeeded: wetCheckFindings.noPartNeeded,
      })
      .from(wetCheckFindings)
      .innerJoin(wetChecks, eq(wetChecks.id, wetCheckFindings.wetCheckId))
      .where(and(
        eq(wetCheckFindings.id, findingId),
        eq(wetChecks.companyId, companyId),
      ));
    return row ?? null;
  }

  async getWetCheck(id: number, companyId: number): Promise<WetCheckWithDetails | undefined> {
    const [wc] = await db.select().from(wetChecks)
      .where(and(eq(wetChecks.id, id), eq(wetChecks.companyId, companyId)));
    if (!wc) return undefined;
    // Task #1857: order by the controller's stored letter via a join so that
    // if a controller is re-lettered the ordering reflects the new letter.
    // Falls back to controllerLetter (denormalized copy) for historical records
    // without a resolved controllerId.
    const zoneRecords = await db.select(WET_CHECK_ZONE_RECORD_SELECTION).from(wetCheckZoneRecords)
      .leftJoin(irrigationControllers, eq(wetCheckZoneRecords.controllerId, irrigationControllers.id))
      .where(eq(wetCheckZoneRecords.wetCheckId, id))
      .orderBy(
        sql`coalesce(${irrigationControllers.letter}, ${wetCheckZoneRecords.controllerLetter})`,
        wetCheckZoneRecords.zoneNumber,
      );
    const findings = await db.select().from(wetCheckFindings)
      .where(eq(wetCheckFindings.wetCheckId, id));
    const photos = await db.select().from(wetCheckPhotos)
      .where(eq(wetCheckPhotos.wetCheckId, id))
      .orderBy(desc(wetCheckPhotos.takenAt));
    const findingsByZone = new Map<number, (WetCheckFinding & { pendingReason?: string | null })[]>();
    for (const f of findings) {
      const list = findingsByZone.get(f.zoneRecordId) ?? [];
      list.push({ ...f, pendingReason: computeFindingPendingReason(f, wc.submittedAt) });
      findingsByZone.set(f.zoneRecordId, list);
    }
    // Slice 3 — look up the estimate (if any) that originated from this
    // wet check so the manager UI can surface a "This inspection's estimate"
    // lineage link without a separate client-side request.
    const [originatedEstimate] = await db.select({
      id: estimates.id,
      workOrderId: estimates.workOrderId,
    }).from(estimates)
      .where(eq(estimates.originWetCheckId, id))
      .limit(1);

    // Task #1856: include resolved controllers so mobile/web can display
    // letter + name without a separate API call.
    const irrigCtrls = await db
      .select({
        letter: irrigationControllers.letter,
        name: irrigationControllers.name,
        totalZones: irrigationControllers.totalZones,
      })
      .from(irrigationControllers)
      .where(and(
        eq(irrigationControllers.companyId, companyId),
        eq(irrigationControllers.customerId, wc.customerId),
        eq(irrigationControllers.branchName, wc.branchName ?? ""),
        isNotNull(irrigationControllers.letter),
      ))
      .orderBy(irrigationControllers.letter, irrigationControllers.id);

    return {
      ...wc,
      zoneRecords: zoneRecords.map(zr => ({ ...zr, findings: findingsByZone.get(zr.id) ?? [] })),
      photos,
      originatedEstimateId: originatedEstimate?.id ?? null,
      originatedWorkOrderId: originatedEstimate?.workOrderId ?? null,
      controllers: irrigCtrls
        .filter(c => c.letter != null)
        .map(c => ({ letter: c.letter as string, name: c.name, zoneCount: c.totalZones ?? null })),
    };
  }

  async findActiveWetCheck(companyId: number, customerId: number, technicianId: number, branchName?: string | null): Promise<WetCheck | undefined> {
    // When branchName is provided (non-null/undefined), scope the resume
    // search to that branch so a tech can have one in-progress check per
    // branch at the same customer. When absent, fall back to the legacy
    // branch-agnostic search (single-location customers).
    const conditions = [
      eq(wetChecks.companyId, companyId),
      eq(wetChecks.customerId, customerId),
      eq(wetChecks.technicianId, technicianId),
      eq(wetChecks.status, "in_progress"),
    ];
    if (branchName != null && branchName !== "") {
      conditions.push(eq(wetChecks.branchName, branchName));
    } else if (branchName === null) {
      conditions.push(isNull(wetChecks.branchName));
    }
    const [wc] = await db.select().from(wetChecks).where(and(...conditions))
      .orderBy(desc(wetChecks.startedAt)).limit(1);
    return wc;
  }

  async createWetCheck(insert: InsertWetCheck): Promise<WetCheck> {
    if (insert.clientId) {
      // Scope dedupe to the same company to prevent any chance of a colliding
      // clientId returning another tenant's wet check.
      const [existing] = await db.select().from(wetChecks).where(and(
        eq(wetChecks.clientId, insert.clientId),
        eq(wetChecks.companyId, insert.companyId),
      ));
      if (existing) return existing;
    }
    const [created] = await db.insert(wetChecks).values(insert).returning();
    return created;
  }

  async updateWetCheck(id: number, companyId: number, patch: Partial<InsertWetCheck>): Promise<WetCheck | undefined> {
    // Internal callers (submitWetCheck → set status=submitted, approve, convert)
    // also funnel through here, so we must NOT enforce the editable-by-tech
    // guard when the patch is a system-managed status transition. Only block
    // user-driven edits (e.g. notes/weather/numControllers) once the wet
    // check has left in_progress.
    const isStatusTransition =
      patch.status !== undefined ||
      patch.submittedAt !== undefined ||
      patch.approvedAt !== undefined ||
      patch.fullyConvertedAt !== undefined;
    if (!isStatusTransition) {
      await this.assertWetCheckEditableByTech(id, companyId);
    }
    const [updated] = await db.update(wetChecks)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(wetChecks.id, id), eq(wetChecks.companyId, companyId)))
      .returning();
    return updated;
  }

  async submitWetCheck(id: number, companyId: number): Promise<{
    wetCheck: WetCheck;
    billingSheetId: number | null;
    autoBilledCount: number;
    pendingCount: number;
  } | undefined> {
    const wc0 = await this.assertWetCheckBelongsToCompany(id, companyId);

    // Idempotency: re-submitting a wet check that's already been processed
    // is a no-op. POST /submit accepts an optional clientId for offline
    // retries; status-based dedupe covers all post-submit states because
    // a wet check can only legitimately leave in_progress once via submit.
    if (wc0.status !== "in_progress") {
      const fs = await db.select().from(wetCheckFindings)
        .where(eq(wetCheckFindings.wetCheckId, id));
      // Slice 6: prefer wetCheckBillingId. Only fall back to billingSheetId for
      // the return value (route display) — NOT as an ID into wet_check_billings.
      const priorWcbId = fs.find(f => f.wetCheckBillingId != null)?.wetCheckBillingId ?? null;
      const priorLegacyBsId = fs.find(f => f.billingSheetId != null)?.billingSheetId ?? null;
      const pendingCount = fs.filter(f => f.resolution === "pending").length;
      return { wetCheck: wc0, billingSheetId: priorWcbId ?? priorLegacyBsId, autoBilledCount: 0, pendingCount };
    }

    return await db.transaction(async (tx) => {
      const [wc] = await tx.select().from(wetChecks)
        .where(and(eq(wetChecks.id, id), eq(wetChecks.companyId, companyId)));
      if (!wc) throw new Error(`Wet check ${id} not found for company ${companyId}`);

      // Submit guard: at least one zone must have been actively checked
      // (YES or NO). N/A and not_checked alone do not count.
      const [{ activeCount }] = await tx.select({
        activeCount: sql<number>`COUNT(*)::int`,
      }).from(wetCheckZoneRecords).where(and(
        eq(wetCheckZoneRecords.wetCheckId, id),
        inArray(wetCheckZoneRecords.status, ["checked_ok", "checked_with_issues"]),
      ));
      if (Number(activeCount ?? 0) === 0) {
        throw new Error("Cannot submit a wet check with zero zones checked");
      }

      // Auto-mark any existing 'not_checked' zone records as not_applicable.
      await tx.update(wetCheckZoneRecords)
        .set({ status: "not_applicable" })
        .where(and(eq(wetCheckZoneRecords.wetCheckId, id), eq(wetCheckZoneRecords.status, "not_checked")));

      // Implicit N/A: for every (controller letter × zoneNumber 1..zoneCount)
      // pair that has NO zone record on this wet check, insert one as N/A so
      // the manager review sees an explicit row for every zone in scope.
      //
      // Task #1856: read from irrigation_controllers (branch-correct, stored letter)
      // rather than property_controllers (unfiltered, positional letters).
      // Fall back to property_controllers only when no irrigation profile exists.
      const branchKey = wc.branchName ?? "";
      const irrigCtrls = await tx.select({
        letter: irrigationControllers.letter,
        totalZones: irrigationControllers.totalZones,
      }).from(irrigationControllers).where(and(
        eq(irrigationControllers.companyId, companyId),
        eq(irrigationControllers.customerId, wc.customerId),
        eq(irrigationControllers.branchName, branchKey),
        isNotNull(irrigationControllers.letter),
      ));

      // Task #1857: irrigation_controllers is the sole source of truth.
      // No property_controllers fallback.
      type CtrlEntry = { id: number; letter: string; zoneCount: number };
      const ctrlEntries: CtrlEntry[] = irrigCtrls
        .filter(c => c.letter != null && c.id != null)
        .map(c => ({ id: c.id as number, letter: c.letter as string, zoneCount: c.totalZones ?? 0 }));

      const existing = await tx.select({
        letter: wetCheckZoneRecords.controllerLetter,
        zone: wetCheckZoneRecords.zoneNumber,
      }).from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.wetCheckId, id));
      const seen = new Set(existing.map(r => `${r.letter}#${r.zone}`));
      const toInsert: InsertWetCheckZoneRecord[] = [];
      for (const ctrl of ctrlEntries) {
        for (let z = 1; z <= ctrl.zoneCount; z++) {
          if (!seen.has(`${ctrl.letter}#${z}`)) {
            toInsert.push({
              wetCheckId: id,
              controllerLetter: ctrl.letter,
              controllerId: ctrl.id,
              zoneNumber: z,
              status: "not_applicable",
            } as InsertWetCheckZoneRecord);
          }
        }
      }
      if (toInsert.length > 0) {
        await tx.insert(wetCheckZoneRecords).values(toInsert).onConflictDoNothing();
      }

      // Slice 3 — Tech-driven auto-billing on submit (gated by
      // WET_CHECK_AUTO_BILL feature flag, default ON). Findings the tech
      // marked "Mark Complete" (resolution=repaired_in_field) auto-flow
      // into a billing sheet inside this same submit transaction. Wet
      // checks with no remaining pending findings skip the manager queue
      // entirely (status=converted). Mixed wet checks land in the queue
      // with the auto-billed slice already locked and only the pending
      // findings actionable.
      const autoBillEnabled = process.env.WET_CHECK_AUTO_BILL !== "false";

      const allFindings = await tx.select().from(wetCheckFindings)
        .where(eq(wetCheckFindings.wetCheckId, id));
      const repaired = allFindings.filter(f =>
        f.resolution === "repaired_in_field" &&
        f.convertedAt == null &&
        f.wetCheckBillingId == null &&
        f.billingSheetId == null,
      );
      const pendingCount = allFindings.filter(f => f.resolution === "pending").length;

      const now = new Date();
      let wetCheckBillingId: number | null = null;
      let autoBilledCount = 0;

      // Task #1535 — harden submit: findings that are marked "complete" but
      // cannot auto-bill (missing part, no noPartNeeded, not a labor-only type)
      // must be gracefully re-routed to needs_review instead of throwing.
      // This eliminates the "Cannot auto-bill finding" submission blocker for
      // legacy data and for any future split-brain case.
      const canAutoBill = (f: WetCheckFinding) =>
        f.partId != null ||
        Boolean(f.noPartNeeded) ||
        LABOR_ONLY_ISSUE_TYPES.has(f.issueType ?? "");

      const repairedBillable   = repaired.filter(f =>  canAutoBill(f));
      const repairedUnbillable = repaired.filter(f => !canAutoBill(f));
      if (repairedUnbillable.length > 0) {
        await tx.update(wetCheckFindings)
          .set({ resolution: "pending", techDisposition: "needs_review" })
          .where(inArray(wetCheckFindings.id, repairedUnbillable.map(f => f.id)));
        // Task #1735 — audit each rerouted finding so the manager can see why
        // it landed in needs_review instead of auto-billed.
        await Promise.all(repairedUnbillable.map(f =>
          recordAuditEvent(null, {
            action: "wet_check.finding_rerouted_unbillable",
            targetType: "wet_check_finding",
            targetId: String(f.id),
            details: {
              findingId: f.id,
              issueType: f.issueType,
              reason: "repaired_unbillable_at_submit",
            },
          }).catch(() => { /* fire-and-forget; submit must not fail over audit */ }),
        ));
      }
      // Count the re-routed findings as pending for the return value.
      const effectivePendingCount = pendingCount + repairedUnbillable.length;

      if (autoBillEnabled && repairedBillable.length > 0) {
        const [cust] = await tx.select().from(customers).where(eq(customers.id, wc.customerId));
        if (!cust) throw new Error(`Customer ${wc.customerId} not found`);
        const laborRate = parseFloat(String(cust.laborRate ?? "45.00"));
        wetCheckBillingId = await this._writeRepairedInFieldBilling(
          tx, wc, laborRate, repairedBillable, /* priorWcbId */ null, now,
        );
        autoBilledCount = repairedBillable.length;
      }

      // Auto-route: any findings where the tech indicated completion
      // (techDisposition='completed_in_field') but resolution wasn't already set
      // to 'repaired_in_field' (e.g., submissions before auto-bill was enabled,
      // or findings that slipped through).  Route them into the same WCB just
      // created (or create one if the auto-bill block didn't fire).
      // Apply the same billable guard so un-routable rows go to needs_review.
      const completedInFieldUnrouted = allFindings.filter(
        (f) =>
          f.techDisposition === "completed_in_field" &&
          f.convertedAt == null &&
          f.wetCheckBillingId == null &&
          f.billingSheetId == null &&
          f.estimateId == null &&
          f.workOrderId == null &&
          f.resolution !== "repaired_in_field",
      );
      const completedBillable   = completedInFieldUnrouted.filter(f =>  canAutoBill(f));
      const completedUnbillable = completedInFieldUnrouted.filter(f => !canAutoBill(f));
      if (completedUnbillable.length > 0) {
        await tx.update(wetCheckFindings)
          .set({ resolution: "pending", techDisposition: "needs_review" })
          .where(inArray(wetCheckFindings.id, completedUnbillable.map(f => f.id)));
        // Task #1735 — audit each rerouted finding.
        await Promise.all(completedUnbillable.map(f =>
          recordAuditEvent(null, {
            action: "wet_check.finding_rerouted_unbillable",
            targetType: "wet_check_finding",
            targetId: String(f.id),
            details: {
              findingId: f.id,
              issueType: f.issueType,
              reason: "completed_unbillable_at_submit",
            },
          }).catch(() => { /* fire-and-forget */ }),
        ));
      }
      if (completedBillable.length > 0) {
        const [custForRoute] = await tx.select().from(customers)
          .where(eq(customers.id, wc.customerId));
        const routeLaborRate = parseFloat(String(custForRoute?.laborRate ?? "45.00")) || 45;
        const newWcbId = await this._writeRepairedInFieldBilling(
          tx, wc, routeLaborRate, completedBillable, wetCheckBillingId, now,
        );
        if (wetCheckBillingId == null) wetCheckBillingId = newWcbId;
        // _writeRepairedInFieldBilling stamps wetCheckBillingId + convertedAt but
        // not resolution.  Stamp it here so these rows leave the routing queue.
        await tx.update(wetCheckFindings)
          .set({ resolution: "repaired_in_field", resolutionDecidedAt: now })
          .where(inArray(wetCheckFindings.id, completedBillable.map((f) => f.id)));
        autoBilledCount += completedBillable.length;
      }

      // Determine final status. With WET_CHECK_AUTO_BILL OFF, mirror
      // Slice 2 exactly: every submit lands in 'submitted' regardless of
      // findings shape (no skip-the-queue, no auto-conversion, even when
      // there are zero findings). With the flag ON, status is driven by
      // the post-write convertedAt stamps (auto-bill counts the
      // repaired_in_field findings as converted), so all-converted →
      // 'converted', partial → 'partially_converted', none → 'submitted'.
      let newStatus: "submitted" | "partially_converted" | "converted";
      if (!autoBillEnabled) {
        newStatus = "submitted";
      } else {
        const finalFindings = await tx.select().from(wetCheckFindings)
          .where(eq(wetCheckFindings.wetCheckId, id));
        const totalFindings = finalFindings.length;
        const convertedFindings = finalFindings.filter(f => f.convertedAt != null).length;
        const remainingFindings = totalFindings - convertedFindings;
        if (totalFindings === 0 || remainingFindings === 0) {
          newStatus = "converted";
        } else if (convertedFindings > 0) {
          newStatus = "partially_converted";
        } else {
          newStatus = "submitted";
        }
      }

      const [updated] = await tx.update(wetChecks).set({
        status: newStatus,
        submittedAt: now,
        fullyConvertedAt: newStatus === "converted" ? now : null,
        updatedAt: now,
      }).where(and(eq(wetChecks.id, id), eq(wetChecks.companyId, companyId))).returning();

      return { wetCheck: updated, billingSheetId: wetCheckBillingId, autoBilledCount, pendingCount: effectivePendingCount };
    });
  }

  async previewWetCheckSubmit(id: number, companyId: number): Promise<{
    autoBillEnabled: boolean;
    autoBilledCount: number;
    autoBilledPartsTotal: string;
    autoBilledLaborTotal: string;
    autoBilledGrandTotal: string;
    pendingCount: number;
    pendingByGroup: { quick_fix: number; advanced: number; zone_issue: number };
  } | undefined> {
    const wc = await this.assertWetCheckBelongsToCompany(id, companyId);
    const autoBillEnabled = process.env.WET_CHECK_AUTO_BILL !== "false";
    const [cust] = await db.select().from(customers).where(eq(customers.id, wc.customerId));
    const laborRate = parseFloat(String(cust?.laborRate ?? "45.00"));
    const findings = await db.select().from(wetCheckFindings)
      .where(eq(wetCheckFindings.wetCheckId, id));

    const repaired = findings.filter(f =>
      f.resolution === "repaired_in_field" &&
      f.convertedAt == null &&
      f.wetCheckBillingId == null &&
      f.billingSheetId == null,
    );
    // Task #464 — preview must mirror the submit guard exactly so the
    // tech-facing modal totals match what _writeRepairedInFieldBilling
    // will actually persist:
    //   - With a part assigned → bill parts (qty × partPrice) + labor.
    //   - With no part but `noPartNeeded` true → labor-only line
    //     (qty 0 / partPrice 0); only labor counts.
    //   - With no part AND no `noPartNeeded` → submit will throw, so we
    //     exclude these from the totals (they're surfaced inline on the
    //     submit CTA and block the button instead).
    const billable = repaired.filter(f => f.partId != null || f.noPartNeeded);
    let partsTotal = 0;
    let laborTotal = 0;
    if (autoBillEnabled) {
      for (const f of billable) {
        const isLaborOnly = f.partId == null && f.noPartNeeded;
        const qty = isLaborOnly ? 0 : Number(f.quantity ?? 0);
        const partPrice = isLaborOnly ? 0 : parseFloat(String(f.partPrice ?? "0"));
        const laborHours = parseFloat(String(f.laborHours ?? "0"));
        partsTotal += partPrice * qty;
        laborTotal += laborHours * laborRate;
      }
    }
    const pendingByGroup = { quick_fix: 0, advanced: 0, zone_issue: 0 };
    let pendingCount = 0;
    for (const f of findings) {
      if (f.resolution !== "pending") continue;
      pendingCount++;
      const g = (f.issueGroup as keyof typeof pendingByGroup) ?? "advanced";
      if (g === "quick_fix" || g === "advanced" || g === "zone_issue") {
        pendingByGroup[g]++;
      }
    }
    return {
      autoBillEnabled,
      autoBilledCount: autoBillEnabled ? billable.length : 0,
      autoBilledPartsTotal: partsTotal.toFixed(2),
      autoBilledLaborTotal: laborTotal.toFixed(2),
      autoBilledGrandTotal: (partsTotal + laborTotal).toFixed(2),
      pendingCount,
      pendingByGroup,
    };
  }

  // Writes the "repaired in field" billing sheet for a wet check inside an
  // existing transaction. Shared by submitWetCheck (Slice 3 auto-bill) and
  // convertWetCheck (manager-driven conversion). Honours the prior-sheet
  // snapshot rate so previously billed lines are never repriced when the
  // customer's labor rate changes between partial-conversion runs. Stamps
  // findings with billingSheetId + convertedAt and returns the sheet id.
  //
  // ── BS-WC v2 totals math (Task #753, Slice 4 Option B) ───────────────────
  //
  //   total_labor_hours = wc.totalLaborHours             // inspection overhead
  //                     + Σ zone.repairLaborHours         // per-zone repair
  //                         (for each unique zone that has at least one
  //                          billed finding; each zone counted exactly once
  //                          regardless of how many findings it contributed)
  //
  //   total_parts      = Σ (finding.quantity × finding.partPrice)
  //
  //   labor_subtotal   = total_labor_hours × appliedLaborRate
  //   total_amount     = total_parts + labor_subtotal
  //
  // When appending to a prior sheet (partial-conversion), the prior sheet's
  // appliedLaborRate snapshot is used — never the live customer rate — so
  // previously billed lines are never repriced. Zone IDs already stamped on
  // the prior sheet are unioned with the new batch before summing repair hours
  // so each zone is still counted only once across all conversion passes.
  private async _writeRepairedInFieldBilling(
    tx: DbExecutor,
    wc: WetCheck,
    customerLaborRate: number,
    repaired: WetCheckFinding[],
    priorWcbId: number | null,
    now: Date,
  ): Promise<number> {
    // Slice 3 — guard required billing inputs BEFORE writing anything.
    // Any "Mark Complete" finding missing the bits needed to produce a
    // valid billing line must abort the whole submit so the surrounding
    // transaction rolls back. Spec calls out the missing-part case
    // explicitly; we extend the same guard to non-positive quantity
    // (qty * price would zero the line) and negative labor hours.
    for (const f of repaired) {
      // Task #464 — labor-only Mark Complete. A finding marked complete
      // with no part is valid when the tech ticked "No part needed"; the
      // line is written below with qty 0 / unit price 0.
      // Also skip the check for issue types that are inherently labor-only
      // (e.g. head_adjustment) — the wizard auto-injects noPartNeeded=true
      // for those, but we guard here too so pre-existing rows are safe.
      if (f.partId == null && !f.noPartNeeded && !LABOR_ONLY_ISSUE_TYPES.has(f.issueType)) {
        throw new Error(
          `Cannot auto-bill finding ${f.id}: marked complete but has no part assigned. ` +
          `Add a part before submitting, tick "No part needed" for a labor-only fix, ` +
          `or leave Mark Complete unchecked to route to the manager.`,
        );
      }
      const qty = Number(f.quantity);
      // Labor-only lines legitimately have qty 0; only validate qty when a
      // part is actually being billed.
      if (f.partId != null) {
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`Cannot auto-bill finding ${f.id}: quantity must be > 0 (got ${f.quantity}).`);
        }
      }
      const laborHours = parseFloat(String(f.laborHours ?? "0"));
      if (!Number.isFinite(laborHours) || laborHours < 0) {
        throw new Error(`Cannot auto-bill finding ${f.id}: laborHours must be >= 0 (got ${f.laborHours}).`);
      }
    }
    const lines = repaired.map(f => {
      // Labor-only lines: qty 0, unit price 0, total parts 0. Labor still
      // flows from the per-finding laborHours × customer rate as normal.
      if (f.partId == null && f.noPartNeeded) {
        const laborHours = parseFloat(String(f.laborHours ?? "0"));
        return { qty: 0, partPrice: 0, laborHours, partsTotal: 0 };
      }
      const qty = Number(f.quantity);
      const partPrice = parseFloat(String(f.partPrice ?? "0"));
      const laborHours = parseFloat(String(f.laborHours ?? "0"));
      const partsTotal = partPrice * qty;
      return { qty, partPrice, laborHours, partsTotal };
    });
    const newPartsSubtotal = lines.reduce((s, l) => s + l.partsTotal, 0);

    // Task #753 (Slice 4 Option B) — zone-level repairLaborHours is the
    // authoritative labor source for WCB billing totals.
    //
    // Total labor formula (per task spec):
    //   totalLabor = wc.totalLaborHours + Σ(zoneRecords.repairLaborHours
    //                                       WHERE zone has any billed finding)
    //
    // wc.totalLaborHours captures wet-check-level overhead (travel, inspection)
    // that is separate from the per-zone repair component. Each zone is counted
    // once regardless of how many findings it contributed (no per-finding sum).
    const wcBaseLaborHours = parseFloat(String(wc.totalLaborHours ?? "0")) || 0;

    // Slice 4c — Make sure zone repair labor is current before reading it.
    // Defensive: Task #891's hook is supposed to keep zone records fresh
    // on every finding create/update, but legacy wet checks (and any
    // future code path that inserts findings without going through
    // createWetCheckFinding / updateWetCheckFinding) can leave zones
    // stale. Recompute every affected zone here so the WCB snapshot is
    // guaranteed to include real per-zone labor.
    const newZoneIds = Array.from(new Set(repaired.map(f => f.zoneRecordId)));
    for (const zoneId of newZoneIds) {
      await this._recomputeZoneRepairLaborIfAuto(tx, zoneId, wc.companyId);
    }

    const newZoneRows = newZoneIds.length > 0
      ? await tx.select({ id: wetCheckZoneRecords.id, repairLaborHours: wetCheckZoneRecords.repairLaborHours })
          .from(wetCheckZoneRecords)
          .where(inArray(wetCheckZoneRecords.id, newZoneIds))
      : [];
    const newZoneRepairHours = newZoneRows.reduce(
      (s, zr) => s + parseFloat(String(zr.repairLaborHours ?? "0")), 0,
    );
    // For the new-WCB branch: total = wc base + new zone repair hours.
    const newLaborHours = wcBaseLaborHours + newZoneRepairHours;

    let wcbId: number;
    if (priorWcbId != null) {
      // Append to existing wet-check billing record and recompute totals from
      // scratch (not incrementally). The labor rate used here is the SNAPSHOT
      // (`appliedLaborRate`) stored on the existing WCB, NOT the live
      // customer rate — previously converted findings must never be repriced.
      //
      // For labor hours: union zone IDs from existing billed findings with the
      // new batch, look up their repairLaborHours, and add wc.totalLaborHours
      // once. Each zone is counted once (partial-conversion guard).
      const [priorWcb] = await tx.select().from(wetCheckBillings)
        .where(eq(wetCheckBillings.id, priorWcbId));
      const snapshotRate = parseFloat(String(priorWcb?.appliedLaborRate ?? priorWcb?.laborRate ?? customerLaborRate));
      // Read existing parts subtotal from wetCheckFindings (no items table).
      const existingFindingRows = await tx.select({
        partId: wetCheckFindings.partId,
        partPrice: wetCheckFindings.partPrice,
        quantity: wetCheckFindings.quantity,
        noPartNeeded: wetCheckFindings.noPartNeeded,
        zoneRecordId: wetCheckFindings.zoneRecordId,
      }).from(wetCheckFindings)
        .where(eq(wetCheckFindings.wetCheckBillingId, priorWcbId));
      const existingPartsSubtotal = existingFindingRows.reduce((s, f) => {
        if (f.partId == null && f.noPartNeeded) return s;
        return s + parseFloat(String(f.partPrice ?? "0")) * Number(f.quantity ?? 0);
      }, 0);
      // Collect zone IDs already in this WCB (via findings stamped in prior run).
      const allZoneIds = Array.from(new Set([
        ...existingFindingRows.map(f => f.zoneRecordId),
        ...newZoneIds,
      ]));
      const allZoneRows = allZoneIds.length > 0
        ? await tx.select({ repairLaborHours: wetCheckZoneRecords.repairLaborHours })
            .from(wetCheckZoneRecords)
            .where(inArray(wetCheckZoneRecords.id, allZoneIds))
        : [];
      const allZoneRepairHours = allZoneRows.reduce(
        (s, zr) => s + parseFloat(String(zr.repairLaborHours ?? "0")), 0,
      );
      // wc.totalLaborHours is counted once regardless of how many partial runs.
      const totalLaborHours = wcBaseLaborHours + allZoneRepairHours;
      const partsSubtotal = existingPartsSubtotal + newPartsSubtotal;
      const laborSubtotal = totalLaborHours * snapshotRate;
      const total = partsSubtotal + laborSubtotal;
      // Slice 7 — refresh snapshot columns alongside totals so the forensic
      // record always reflects the latest computed amounts. approvedAt is
      // intentionally NOT overwritten (preserves the original approval timestamp).
      await tx.update(wetCheckBillings).set({
        totalHours: totalLaborHours.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        partsSubtotal: partsSubtotal.toFixed(2),
        totalAmount: total.toFixed(2),
        approvedTotal: total.toFixed(2),
        approvedLaborSnapshot: JSON.stringify({
          laborSubtotal: laborSubtotal.toFixed(2),
          totalHours: totalLaborHours.toFixed(2),
          appliedLaborRate: snapshotRate.toFixed(2),
        }),
        approvedPartsSnapshot: JSON.stringify({
          partsSubtotal: partsSubtotal.toFixed(2),
          totalAmount: total.toFixed(2),
        }),
      }).where(eq(wetCheckBillings.id, priorWcbId));
      wcbId = priorWcbId;
    } else {
      const laborSubtotal = newLaborHours * customerLaborRate;
      const total = newPartsSubtotal + laborSubtotal;
      // Slice 6 — allocate a WC-YYYY-NNNN number from the wet-check billing
      // counter. Called outside the inner transaction because it uses the
      // top-level db handle; the counter is atomically incremented so
      // concurrent submissions never collide.
      const billingNumber = await this.getNextWetCheckBillingNumber();
      // Slice 7 — auto-bill WCBs are immediately approved (the manager
      // explicitly routed each finding to "repaired_in_field" before
      // triggering the conversion, so the billing is pre-sanctioned).
      // Write snapshot fields alongside approvedAt/approvedTotal so the
      // financial-pulse audit endpoint can surface them without a
      // separate approval step.
      const [wcb] = await tx.insert(wetCheckBillings).values({
        billingNumber,
        customerId: wc.customerId,
        customerName: wc.customerName,
        propertyAddress: wc.propertyAddress ?? "",
        workDate: wc.submittedAt ?? now,
        technicianName: wc.technicianName,
        technicianId: wc.technicianId,
        wetCheckId: wc.id,
        // Task #315 — carry branchName from the originating wet check so
        // the WCB lands on the correct branch for reconciliation views.
        branchName: wc.branchName ?? null,
        status: "approved_passed_to_billing",
        totalHours: newLaborHours.toFixed(2),
        laborRate: customerLaborRate.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        partsSubtotal: newPartsSubtotal.toFixed(2),
        totalAmount: total.toFixed(2),
        appliedLaborRate: customerLaborRate.toFixed(2),
        approvedAt: now,
        approvedTotal: total.toFixed(2),
        approvedLaborSnapshot: JSON.stringify({
          laborSubtotal: laborSubtotal.toFixed(2),
          totalHours: newLaborHours.toFixed(2),
          appliedLaborRate: customerLaborRate.toFixed(2),
        }),
        approvedPartsSnapshot: JSON.stringify({
          partsSubtotal: newPartsSubtotal.toFixed(2),
          totalAmount: total.toFixed(2),
        }),
      } as typeof wetCheckBillings.$inferInsert).returning();
      wcbId = wcb.id;
    }

    // Stamp findings with wetCheckBillingId + convertedAt; clear billingSheetId.
    // No billing_sheet_items rows are created — the WCB totals are derived
    // directly from finding-level fields at read time.
    for (const f of repaired) {
      await tx.update(wetCheckFindings).set({
        wetCheckBillingId: wcbId,
        billingSheetId: null,
        convertedAt: now,
        updatedAt: now,
      }).where(eq(wetCheckFindings.id, f.id));
    }
    return wcbId;
  }

  private async assertWetCheckBelongsToCompany(wetCheckId: number, companyId: number): Promise<WetCheck> {
    const [wc] = await db.select().from(wetChecks)
      .where(and(eq(wetChecks.id, wetCheckId), eq(wetChecks.companyId, companyId)));
    if (!wc) throw new Error(`Wet check ${wetCheckId} not found for company ${companyId}`);
    return wc;
  }

  // Approve-lock: tech-side edits are only permitted while the wet check is
  // still in_progress. Once it is submitted (or beyond), only the manager
  // routing/convert endpoints may mutate it. The single exception is
  // updateWetCheckFinding, which uses assertFindingPriceEditable below to
  // additionally allow manager pricing edits while the wet check is
  // 'submitted' but not yet 'approved'.
  private async assertWetCheckEditableByTech(wetCheckId: number, companyId: number): Promise<WetCheck> {
    const wc = await this.assertWetCheckBelongsToCompany(wetCheckId, companyId);
    if (wc.status !== "in_progress") {
      throw new Error(`Wet check ${wetCheckId} is ${wc.status}; only in-progress wet checks can be edited`);
    }
    return wc;
  }

  // Wet-check-level edit window. Per-finding immutability for already-
  // converted rows is enforced via the convertedAt/FK check below.
  private async assertFindingPriceEditable(wetCheckId: number, companyId: number): Promise<WetCheck> {
    const wc = await this.assertWetCheckBelongsToCompany(wetCheckId, companyId);
    if (wc.status !== "in_progress" && wc.status !== "submitted" && wc.status !== "partially_converted") {
      throw new Error(`Wet check ${wetCheckId} is ${wc.status}; finding pricing is locked`);
    }
    return wc;
  }

  async upsertWetCheckZoneRecord(
    wetCheckId: number,
    companyId: number,
    insert: InsertWetCheckZoneRecord,
  ): Promise<WetCheckZoneRecord> {
    await this.assertWetCheckEditableByTech(wetCheckId, companyId);
    if (insert.clientId) {
      // Scope dedupe to this wet check (already verified to belong to this
      // company) so a colliding clientId from another tenant cannot return
      // a foreign zone record.
      const [byClient] = await db.select().from(wetCheckZoneRecords).where(and(
        eq(wetCheckZoneRecords.clientId, insert.clientId),
        eq(wetCheckZoneRecords.wetCheckId, wetCheckId),
      ));
      if (byClient) return byClient;
    }
    // Task #1857: prefer controllerId as the natural key when available;
    // fall back to controllerLetter for historical records without a resolved FK.
    const naturalKeyWhere = insert.controllerId != null
      ? and(
          eq(wetCheckZoneRecords.wetCheckId, wetCheckId),
          eq(wetCheckZoneRecords.controllerId, insert.controllerId),
          eq(wetCheckZoneRecords.zoneNumber, insert.zoneNumber),
        )
      : and(
          eq(wetCheckZoneRecords.wetCheckId, wetCheckId),
          eq(wetCheckZoneRecords.controllerLetter, insert.controllerLetter),
          eq(wetCheckZoneRecords.zoneNumber, insert.zoneNumber),
        );
    const [byNatural] = await db.select().from(wetCheckZoneRecords).where(naturalKeyWhere);
    if (byNatural) {
      const [updated] = await db.update(wetCheckZoneRecords)
        .set({ ...insert, wetCheckId })
        .where(eq(wetCheckZoneRecords.id, byNatural.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(wetCheckZoneRecords).values({ ...insert, wetCheckId }).returning();
    return created;
  }

  async updateWetCheckZoneRecord(
    id: number,
    companyId: number,
    patch: Partial<InsertWetCheckZoneRecord>,
  ): Promise<WetCheckZoneRecord | undefined> {
    const [zr] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, id));
    if (!zr) return undefined;
    await this.assertWetCheckEditableByTech(zr.wetCheckId, companyId);
    const [updated] = await db.update(wetCheckZoneRecords).set(patch).where(eq(wetCheckZoneRecords.id, id)).returning();
    return updated;
  }

  // Task #891 — auto-recompute zone repairLaborHours from the sum of
  // defaultLaborHours for all findings' issueTypes in the company config.
  // Only runs when repairLaborManuallySet is false; skips immediately when true.
  // Writes 0.00 when the zone has no findings. Accepts a DbExecutor so callers
  // inside a transaction pass the transaction handle.
  private async _recomputeZoneRepairLaborIfAuto(
    tx: DbExecutor,
    zoneRecordId: number,
    companyId: number,
  ): Promise<void> {
    const [zr] = await tx.select({
      id: wetCheckZoneRecords.id,
      repairLaborManuallySet: wetCheckZoneRecords.repairLaborManuallySet,
    }).from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
    if (!zr) return;
    if (zr.repairLaborManuallySet) return; // human override — leave it alone

    // Fetch all findings for this zone — also select quantity so we can
    // multiply the per-unit labor hours by the finding count (B2c fix).
    const findings = await tx
      .select({ issueType: wetCheckFindings.issueType, quantity: wetCheckFindings.quantity })
      .from(wetCheckFindings)
      .where(eq(wetCheckFindings.zoneRecordId, zoneRecordId));

    let totalHours = 0;
    if (findings.length > 0) {
      // Load the company's issue type configs once.
      const configs = await tx.select({
        issueType: issueTypeConfigs.issueType,
        defaultLaborHours: issueTypeConfigs.defaultLaborHours,
      }).from(issueTypeConfigs).where(eq(issueTypeConfigs.companyId, companyId));

      // B2b fix — normalize every catalog key so mixed-case or
      // space/dash variants in the DB (legacy data) still resolve.
      const configMap = new Map(
        configs.map((c) => [resolveIssueTypeKey(c.issueType), c.defaultLaborHours]),
      );

      for (const f of findings) {
        // B2b fix — resolve the finding's issueType before lookup.
        const raw = configMap.get(resolveIssueTypeKey(f.issueType));
        if (raw) {
          const perUnit = parseFloat(String(raw)) || 0;
          // B2c fix — multiply by quantity (was previously missing).
          const qty = typeof f.quantity === "number" ? f.quantity : parseInt(String(f.quantity ?? "1"), 10);
          totalHours += perUnit * (isNaN(qty) || qty < 1 ? 1 : qty);
        }
      }
    }

    await tx.update(wetCheckZoneRecords)
      .set({ repairLaborHours: totalHours.toFixed(2) })
      .where(eq(wetCheckZoneRecords.id, zoneRecordId));
  }

  // Task #753 (Slice 4) — set the authoritative per-zone repair labor hours.
  // Only updates the repairLaborHours column; all other fields are unchanged.
  // Company-scoped + edit-window: delegates to assertWetCheckEditableByTech so
  // only in-progress wet checks can have their repair labor adjusted (same guard
  // as the general zone PATCH path). Idempotent: safe to call with same value.
  // Task #891 — also marks repairLaborManuallySet = true.
  async setZoneRepairLabor(
    zoneRecordId: number,
    companyId: number,
    repairLaborHours: string,
  ): Promise<WetCheckZoneRecord | undefined> {
    const [zr] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
    if (!zr) return undefined;
    // assertWetCheckEditableByTech throws when the wet check is not found for
    // companyId OR when it is no longer in-progress (submitted/converted/etc.).
    // Callers see a 404 for wrong company and a 400 for the lock-window error.
    await this.assertWetCheckEditableByTech(zr.wetCheckId, companyId);
    const [updated] = await db
      .update(wetCheckZoneRecords)
      .set({ repairLaborHours, repairLaborManuallySet: true })
      .where(eq(wetCheckZoneRecords.id, zoneRecordId))
      .returning();
    return updated;
  }

  // Task #891 — reset a zone's repair labor to the auto-computed default.
  // Sets repairLaborManuallySet = false and immediately reruns the recompute.
  // Tech tier: only works on in-progress wet checks (assertWetCheckEditableByTech).
  async resetZoneRepairLabor(
    zoneRecordId: number,
    companyId: number,
  ): Promise<WetCheckZoneRecord | undefined> {
    const [zr] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
    if (!zr) return undefined;
    await this.assertWetCheckEditableByTech(zr.wetCheckId, companyId);
    // Clear the manual flag first, then recompute
    await db.update(wetCheckZoneRecords)
      .set({ repairLaborManuallySet: false })
      .where(eq(wetCheckZoneRecords.id, zoneRecordId));
    await this._recomputeZoneRepairLaborIfAuto(db, zoneRecordId, companyId);
    const [updated] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
    return updated;
  }

  // Task #891 — manager-tier reset: clears the manual flag and recomputes.
  // Uses assertFindingPriceEditable (allows in_progress + submitted +
  // partially_converted) — the same window as setZoneRepairLaborManagerTier.
  async resetZoneRepairLaborManagerTier(
    zoneRecordId: number,
    companyId: number,
  ): Promise<WetCheckZoneRecord | undefined> {
    const [zr] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
    if (!zr) return undefined;
    await this.assertFindingPriceEditable(zr.wetCheckId, companyId);
    await db.update(wetCheckZoneRecords)
      .set({ repairLaborManuallySet: false })
      .where(eq(wetCheckZoneRecords.id, zoneRecordId));
    await this._recomputeZoneRepairLaborIfAuto(db, zoneRecordId, companyId);
    const [updated] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
    return updated;
  }

  // Task #891 — manager-tier zone repair labor edit.
  // Uses assertFindingPriceEditable which allows in_progress + submitted +
  // partially_converted wet checks (manager review window).
  async setZoneRepairLaborManagerTier(
    zoneRecordId: number,
    companyId: number,
    repairLaborHours: string,
  ): Promise<WetCheckZoneRecord | undefined> {
    const [zr] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
    if (!zr) return undefined;
    await this.assertFindingPriceEditable(zr.wetCheckId, companyId);
    const [updated] = await db
      .update(wetCheckZoneRecords)
      .set({ repairLaborHours, repairLaborManuallySet: true })
      .where(eq(wetCheckZoneRecords.id, zoneRecordId))
      .returning();
    return updated;
  }

  // Task #891 — billing-manager-tier zone repair labor edit on a finalised WCB.
  // Updates zone repairLaborHours, stamps repairLaborManuallySet=true, then
  // recomputes the WCB's totalHours / laborSubtotal / totalAmount to reflect the
  // change. All zone IDs already tied to this WCB are re-summed so no zone is
  // double-counted across partial-conversion runs.
  async setWcbZoneRepairLabor(
    wcbId: number,
    zoneRecordId: number,
    repairLaborHours: string,
    companyId: number,
  ): Promise<{ before: { zoneRecord: WetCheckZoneRecord; wcb: WetCheckBilling }; updated: { zoneRecord: WetCheckZoneRecord; wcb: WetCheckBilling } } | undefined> {
    return db.transaction(async (tx) => {
      const [wcb] = await tx.select().from(wetCheckBillings).where(eq(wetCheckBillings.id, wcbId));
      if (!wcb) return undefined;
      // Tenant-scope: verify the WCB's wet check belongs to this company.
      const [wc] = await tx.select().from(wetChecks).where(eq(wetChecks.id, wcb.wetCheckId));
      if (!wc || wc.companyId !== companyId) return undefined;
      // Block invoiced or billed WCBs — both are terminal states for labor edits.
      // approved_passed_to_billing is intentionally allowed: billing managers
      // may still correct zone repair hours before invoicing (Task #977).
      if (wcb.invoiceId != null) {
        throw new Error(`Wet check billing ${wcbId} is already invoiced and cannot be edited`);
      }
      if (wcb.status === "billed") {
        throw new Error(`Wet check billing ${wcbId} is billed and cannot be edited`);
      }
      // Verify the zone record is actually part of this WCB's findings.
      // This is a tighter scope than "same wet check" — a zone that exists on
      // the same wet check but was not included in this WCB must not be editable
      // via this endpoint.
      const [wcbFindingForZone] = await tx
        .select({ zoneRecordId: wetCheckFindings.zoneRecordId })
        .from(wetCheckFindings)
        .where(
          and(
            eq(wetCheckFindings.wetCheckBillingId, wcbId),
            eq(wetCheckFindings.zoneRecordId, zoneRecordId),
          ),
        )
        .limit(1);
      if (!wcbFindingForZone) {
        // Zone is not part of this WCB's billed findings.
        return undefined;
      }
      // Capture the zone record before the update for audit before/after.
      const [beforeZoneRow] = await tx
        .select()
        .from(wetCheckZoneRecords)
        .where(eq(wetCheckZoneRecords.id, zoneRecordId));
      if (!beforeZoneRow) return undefined;
      // Update the zone record's repair labor and stamp as manually set.
      const [zoneRow] = await tx
        .update(wetCheckZoneRecords)
        .set({ repairLaborHours, repairLaborManuallySet: true })
        .where(eq(wetCheckZoneRecords.id, zoneRecordId))
        .returning();
      if (!zoneRow) return undefined;
      // Recompute WCB totals: collect all zone IDs with findings tied to this WCB.
      const findingRows = await tx.select({ zoneRecordId: wetCheckFindings.zoneRecordId })
        .from(wetCheckFindings)
        .where(eq(wetCheckFindings.wetCheckBillingId, wcbId));
      const allZoneIds = Array.from(new Set(findingRows.map((f) => f.zoneRecordId)));
      const allZoneRows = allZoneIds.length > 0
        ? await tx.select({ repairLaborHours: wetCheckZoneRecords.repairLaborHours })
            .from(wetCheckZoneRecords)
            .where(inArray(wetCheckZoneRecords.id, allZoneIds))
        : [];
      const allZoneRepairHours = allZoneRows.reduce(
        (s, zr) => s + parseFloat(String(zr.repairLaborHours ?? "0")), 0,
      );
      const wcBaseLaborHours = parseFloat(String(wc.totalLaborHours ?? "0")) || 0;
      const totalLaborHours = wcBaseLaborHours + allZoneRepairHours;
      // Use the snapshot rate on the WCB to avoid repricing.
      const snapshotRate = parseFloat(String(wcb.appliedLaborRate ?? wcb.laborRate ?? "45"));
      const laborSubtotal = totalLaborHours * snapshotRate;
      const partsSubtotal = parseFloat(String(wcb.partsSubtotal ?? "0")) || 0;
      const total = laborSubtotal + partsSubtotal;
      const [updatedWcb] = await tx.update(wetCheckBillings).set({
        totalHours: totalLaborHours.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: total.toFixed(2),
      }).where(eq(wetCheckBillings.id, wcbId)).returning();
      return {
        before: { zoneRecord: beforeZoneRow, wcb },
        updated: { zoneRecord: zoneRow, wcb: updatedWcb },
      };
    });
  }

  // Task #1027 — billing-manager-tier reset of zone repair labor on a finalised WCB.
  // Clears repairLaborManuallySet, re-runs auto-compute, then recomputes the WCB's
  // laborSubtotal / totalAmount — same pattern as setWcbZoneRepairLabor.
  async resetWcbZoneRepairLabor(
    wcbId: number,
    zoneRecordId: number,
    companyId: number,
  ): Promise<{ zoneRecord: WetCheckZoneRecord; wcb: WetCheckBilling } | undefined> {
    return db.transaction(async (tx) => {
      const [wcb] = await tx.select().from(wetCheckBillings).where(eq(wetCheckBillings.id, wcbId));
      if (!wcb) return undefined;
      const [wc] = await tx.select().from(wetChecks).where(eq(wetChecks.id, wcb.wetCheckId));
      if (!wc || wc.companyId !== companyId) return undefined;
      if (wcb.invoiceId != null) {
        throw new Error(`Wet check billing ${wcbId} is already invoiced and cannot be edited`);
      }
      if (wcb.status === "billed") {
        throw new Error(`Wet check billing ${wcbId} is billed and cannot be edited`);
      }
      // Verify the zone record is part of this WCB's findings.
      const [wcbFindingForZone] = await tx
        .select({ zoneRecordId: wetCheckFindings.zoneRecordId })
        .from(wetCheckFindings)
        .where(
          and(
            eq(wetCheckFindings.wetCheckBillingId, wcbId),
            eq(wetCheckFindings.zoneRecordId, zoneRecordId),
          ),
        )
        .limit(1);
      if (!wcbFindingForZone) return undefined;
      // Clear the manual flag so auto-compute will run.
      await tx.update(wetCheckZoneRecords)
        .set({ repairLaborManuallySet: false })
        .where(eq(wetCheckZoneRecords.id, zoneRecordId));
      // Re-run auto-compute (repairLaborManuallySet is now false so it won't short-circuit).
      await this._recomputeZoneRepairLaborIfAuto(tx, zoneRecordId, companyId);
      const [zoneRow] = await tx.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
      if (!zoneRow) return undefined;
      // Recompute WCB totals: collect all zone IDs with findings tied to this WCB.
      const findingRows = await tx.select({ zoneRecordId: wetCheckFindings.zoneRecordId })
        .from(wetCheckFindings)
        .where(eq(wetCheckFindings.wetCheckBillingId, wcbId));
      const allZoneIds = Array.from(new Set(findingRows.map((f) => f.zoneRecordId)));
      const allZoneRows = allZoneIds.length > 0
        ? await tx.select({ repairLaborHours: wetCheckZoneRecords.repairLaborHours })
            .from(wetCheckZoneRecords)
            .where(inArray(wetCheckZoneRecords.id, allZoneIds))
        : [];
      const allZoneRepairHours = allZoneRows.reduce(
        (s, zr) => s + parseFloat(String(zr.repairLaborHours ?? "0")), 0,
      );
      const wcBaseLaborHours = parseFloat(String(wc.totalLaborHours ?? "0")) || 0;
      const totalLaborHours = wcBaseLaborHours + allZoneRepairHours;
      const snapshotRate = parseFloat(String(wcb.appliedLaborRate ?? wcb.laborRate ?? "45"));
      const laborSubtotal = totalLaborHours * snapshotRate;
      const partsSubtotal = parseFloat(String(wcb.partsSubtotal ?? "0")) || 0;
      const total = laborSubtotal + partsSubtotal;
      const [updatedWcb] = await tx.update(wetCheckBillings).set({
        totalHours: totalLaborHours.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: total.toFixed(2),
      }).where(eq(wetCheckBillings.id, wcbId)).returning();
      return { zoneRecord: zoneRow, wcb: updatedWcb };
    });
  }

  async createWetCheckFinding(
    zoneRecordId: number,
    companyId: number,
    insert: Omit<InsertWetCheckFinding, "zoneRecordId" | "wetCheckId" | "issueGroup">,
  ): Promise<WetCheckFinding> {
    const [zr] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, zoneRecordId));
    if (!zr) throw new Error(`Zone record ${zoneRecordId} not found`);
    await this.assertWetCheckEditableByTech(zr.wetCheckId, companyId);

    if (insert.clientId) {
      // Scope dedupe to this zone record's wet check (already verified above
      // to belong to this company) so a foreign tenant cannot collide.
      const [existing] = await db.select().from(wetCheckFindings).where(and(
        eq(wetCheckFindings.clientId, insert.clientId),
        eq(wetCheckFindings.wetCheckId, zr.wetCheckId),
      ));
      if (existing) return existing;
    }

    // Snapshot part name + price at finding-creation time. The parts lookup
    // is scoped to this company so a client cannot reference (or snapshot) a
    // part belonging to another tenant. When a partId is provided, server-
    // authoritative snapshot ALWAYS overrides any client-supplied partName /
    // partPrice — clients cannot smuggle a manipulated price into the
    // finding row.
    let partName = insert.partName ?? null;
    let partPrice = insert.partPrice ?? null;
    if (insert.partId) {
      const [p] = await db.select().from(parts).where(and(
        eq(parts.id, insert.partId),
        eq(parts.companyId, companyId),
      ));
      if (!p) throw new Error(`Part ${insert.partId} not found in this company`);
      partName = p.name;
      partPrice = p.price;
    }

    const issueGroup = deriveIssueGroup(insert.issueType);
    const [created] = await db.insert(wetCheckFindings).values({
      ...insert,
      zoneRecordId,
      wetCheckId: zr.wetCheckId,
      issueGroup,
      partName,
      partPrice,
    } as InsertWetCheckFinding).returning();

    // Bump zone status when a finding lands on a zone marked checked_ok.
    if (zr.status === "checked_ok" || zr.status === "not_checked") {
      await db.update(wetCheckZoneRecords)
        .set({ status: "checked_with_issues" })
        .where(eq(wetCheckZoneRecords.id, zoneRecordId));
    }
    // Task #891 — auto-compute zone repair labor from issueType defaults.
    await this._recomputeZoneRepairLaborIfAuto(db, zoneRecordId, companyId);
    return created;
  }

  async updateWetCheckFinding(
    id: number,
    companyId: number,
    patch: Partial<InsertWetCheckFinding>,
  ): Promise<WetCheckFinding | undefined> {
    const [f] = await db.select().from(wetCheckFindings).where(eq(wetCheckFindings.id, id));
    if (!f) return undefined;
    // Editable while wet check is in_progress (tech) OR submitted (manager
    // pricing/part swap during review). Beyond that — approved, partially
    // or fully converted — pricing rows are frozen.
    await this.assertFindingPriceEditable(f.wetCheckId, companyId);
    const isConverted =
      f.convertedAt != null ||
      f.billingSheetId != null ||
      f.estimateId != null ||
      f.workOrderId != null;
    if (isConverted) {
      // Once converted, the entire finding row is sealed (not just pricing).
      // Routing changes go through the separate /route endpoint which
      // enforces its own immutability check.
      throw new Error(`Finding ${id} is already converted; the row is immutable`);
    }
    // If a new partId is being set on the finding, verify it belongs to this
    // company AND server-authoritatively overwrite the snapshot fields so a
    // client cannot smuggle a manipulated partName / partPrice during edit.
    const next: Partial<InsertWetCheckFinding> = { ...patch, updatedAt: new Date() } as Partial<InsertWetCheckFinding>;
    if (patch.partId != null) {
      const [p] = await db.select().from(parts).where(and(
        eq(parts.id, patch.partId as number),
        eq(parts.companyId, companyId),
      ));
      if (!p) throw new Error(`Part ${patch.partId} not found in this company`);
      next.partName = p.name;
      next.partPrice = p.price;
    }
    // Task #464 / #612 — enforce the two-state invariant via the
    // extracted pure helper. The helper is covered by
    // wet-check-finding-invariants.test.ts so future refactors of this
    // storage method can't silently regress the invariant.
    applyNoPartNeededInvariant(patch, next);
    if (patch.issueType) next.issueGroup = deriveIssueGroup(patch.issueType);
    const [updated] = await db.update(wetCheckFindings).set(next).where(eq(wetCheckFindings.id, id)).returning();
    // Task #891 — when issueType changes the zone labor default may have changed.
    // Call unconditionally (the helper skips immediately when manually set).
    if (updated?.zoneRecordId != null) {
      await this._recomputeZoneRepairLaborIfAuto(db, updated.zoneRecordId, companyId);
    }
    return updated;
  }

  async deleteWetCheckFinding(id: number, companyId: number): Promise<boolean> {
    const [f] = await db.select().from(wetCheckFindings).where(eq(wetCheckFindings.id, id));
    // Task #518 — surface refusals as typed errors so the route layer can
    // emit 404/409 with reason codes. Returning `false` previously caused
    // the route to respond 200 `{ ok: false }`, which the FindingSheet's
    // delete button silently ignored.
    if (!f) throw new WetCheckFindingNotFoundError(id);
    // Tenant scoping: still verify the finding belongs to the caller's
    // company before peeking at any other fields.
    const wc = await this.assertWetCheckBelongsToCompany(f.wetCheckId, companyId);
    // Already routed downstream — deleting would orphan the billing
    // sheet / estimate / work order line. The conversion fields outlive
    // the wet check's `in_progress` window, so check them up front.
    if (f.billingSheetId != null) {
      throw new WetCheckFindingAlreadyConvertedError(id, "billing_sheet", f.billingSheetId);
    }
    if (f.estimateId != null) {
      throw new WetCheckFindingAlreadyConvertedError(id, "estimate", f.estimateId);
    }
    if (f.workOrderId != null) {
      throw new WetCheckFindingAlreadyConvertedError(id, "work_order", f.workOrderId);
    }
    // Belt-and-suspenders: `convertedAt` is normally set together with
    // one of the FK columns above, but if drifted data exists with
    // only `convertedAt` populated we still refuse the delete instead
    // of orphaning whatever downstream record it pointed at.
    if (f.convertedAt != null) {
      throw new WetCheckFindingAlreadyConvertedError(id, "unknown", null);
    }
    // Field-tech editability gate: only `in_progress` wet checks accept
    // tech edits. Once submitted/approved/etc the manager owns the row.
    // We check this AFTER the converted-finding gate so a converted row
    // returns the more actionable "already on billing sheet" message
    // instead of a generic "wet check not editable" 409.
    if (wc.status !== "in_progress") {
      throw new WetCheckFindingNotEditableError(id, wc.status);
    }
    // Allow tech to delete ANY non-converted finding on an in_progress
    // wet check, including ones already marked repaired_in_field /
    // completed_in_field — the previous `f.resolution !== "pending"`
    // guard was too strict and caused the trash button to silently
    // fail on completed-in-field findings.
    const zoneRecordId = f.zoneRecordId;
    const result = await db.delete(wetCheckFindings).where(eq(wetCheckFindings.id, id));
    // Task #891 — recompute zone labor after a finding is removed.
    if (zoneRecordId != null) {
      await this._recomputeZoneRepairLaborIfAuto(db, zoneRecordId, companyId);
    }
    return (result.rowCount ?? 0) > 0;
  }

  async attachWetCheckPhoto(
    wetCheckId: number,
    companyId: number,
    insert: Omit<InsertWetCheckPhoto, "wetCheckId">,
  ): Promise<WetCheckPhoto> {
    await this.assertWetCheckEditableByTech(wetCheckId, companyId);
    // Cross-record linkage validation: a photo's optional zoneRecordId /
    // findingId must belong to the SAME wet check, otherwise a client could
    // attach a photo to a record from a different visit (and tenant
    // ownership of those records is implicitly enforced because the wet
    // check itself was just verified to belong to this company).
    if (insert.zoneRecordId != null) {
      const [zr] = await db.select().from(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.id, insert.zoneRecordId));
      if (!zr || zr.wetCheckId !== wetCheckId) {
        throw new Error(`Zone record ${insert.zoneRecordId} does not belong to wet check ${wetCheckId}`);
      }
    }
    if (insert.findingId != null) {
      const [fd] = await db.select().from(wetCheckFindings).where(eq(wetCheckFindings.id, insert.findingId));
      if (!fd || fd.wetCheckId !== wetCheckId) {
        throw new Error(`Finding ${insert.findingId} does not belong to wet check ${wetCheckId}`);
      }
    }
    if (insert.clientId) {
      // Dedupe must match the partial unique index `uniq_photo_client_id`
      // (on `client_id` alone, WHERE client_id IS NOT NULL). Looking up
      // by clientId only ensures a retry of the same metadata POST — even
      // when the previous attempt's response was lost on the wire — finds
      // the row we already wrote and returns it idempotently, instead of
      // missing it and falling through to an INSERT that then dies on the
      // unique constraint with a raw "duplicate key" error. Multi-tenant
      // safety: clientIds are UUIDv4 (collisions are practically nil) and
      // the wet check itself was already verified to belong to this
      // company. If we ever did see a UUID collision across wet checks,
      // we surface it as a clear error rather than silently returning a
      // foreign row.
      const [existing] = await db.select().from(wetCheckPhotos).where(
        eq(wetCheckPhotos.clientId, insert.clientId),
      );
      if (existing) {
        if (existing.wetCheckId !== wetCheckId) {
          const err = new Error(
            "Photo client id already used on another wet check",
          ) as Error & { code?: string };
          err.code = "WET_CHECK_PHOTO_CLIENT_ID_COLLISION";
          throw err;
        }
        return existing;
      }
    }
    try {
      const [created] = await db.insert(wetCheckPhotos).values({ ...insert, wetCheckId }).returning();
      return created;
    } catch (e: any) {
      // Belt-and-suspenders: if a concurrent retry (same clientId) raced
      // past the SELECT above, the INSERT will fail with the partial
      // unique index. Re-read by clientId and return the winner so the
      // caller still sees a successful, idempotent attach.
      const pgCode = e?.cause?.code ?? e?.code;
      if (insert.clientId && pgCode === "23505") {
        const [winner] = await db.select().from(wetCheckPhotos).where(
          eq(wetCheckPhotos.clientId, insert.clientId),
        );
        if (winner) {
          if (winner.wetCheckId === wetCheckId) return winner;
          // The 23505 winner belongs to a different wet check — same
          // collision case as the pre-INSERT SELECT path above. Surface
          // a clean tagged error so the route handler maps it to a 409
          // with a user-safe message instead of rethrowing the raw
          // Drizzle "Failed query: insert into wet_check_photos..."
          // string.
          const err = new Error(
            "Photo client id already used on another wet check",
          ) as Error & { code?: string };
          err.code = "WET_CHECK_PHOTO_CLIENT_ID_COLLISION";
          throw err;
        }
      }
      throw e;
    }
  }

  async deleteWetCheckPhoto(id: number, companyId: number): Promise<boolean> {
    const [p] = await db.select().from(wetCheckPhotos).where(eq(wetCheckPhotos.id, id));
    if (!p) return false;
    await this.assertWetCheckEditableByTech(p.wetCheckId, companyId);
    const result = await db.delete(wetCheckPhotos).where(eq(wetCheckPhotos.id, id));
    const ok = (result.rowCount ?? 0) > 0;
    if (ok) {
      // Best-effort blob cleanup (thumb / medium / original / heic-cache /
      // base) so deleting a single photo doesn't leak its files in object
      // storage. Mirrors the bulk cleanup in deleteWetCheck.
      const objectStorage = new ObjectStorageService();
      await objectStorage.deletePhotoBlobs(p.url);
    }
    return ok;
  }

  // Manager-only escape hatch: delete a loose (unattached) photo on a
  // submitted wet check. Attached photos (findingId or zoneRecordId set)
  // remain fully locked — only loose photos may be removed.  No
  // editability guard: managers are allowed to clean up loose photos
  // regardless of wet check status.  Company-scoped ownership is still
  // enforced via assertWetCheckBelongsToCompany.
  async deleteLooseWetCheckPhotoAsManager(id: number, companyId: number): Promise<boolean> {
    const [p] = await db.select().from(wetCheckPhotos).where(eq(wetCheckPhotos.id, id));
    if (!p) return false;
    // Ensure the wet check belongs to the caller's company (no edit-state guard).
    await this.assertWetCheckBelongsToCompany(p.wetCheckId, companyId);
    // Reject the request if the photo is attached to a finding — only loose
    // photos (findingId == null) may be removed via this path.  Zone-level
    // photos (zoneRecordId set, findingId null) count as loose because the UI
    // defines "loose" as findingId == null, not zoneRecordId == null.
    if (p.findingId != null) {
      const err = new Error(
        "Only unattached photos can be removed after a wet check is submitted",
      ) as Error & { code?: string };
      err.code = "WET_CHECK_PHOTO_NOT_LOOSE";
      throw err;
    }
    const result = await db.delete(wetCheckPhotos).where(eq(wetCheckPhotos.id, id));
    const ok = (result.rowCount ?? 0) > 0;
    if (ok) {
      const objectStorage = new ObjectStorageService();
      await objectStorage.deletePhotoBlobs(p.url);
    }
    return ok;
  }

  // Bulk-delete all loose (findingId IS NULL) photos on a wet check.
  // companyId=null skips the ownership check (super_admin path).
  // Returns the count of deleted photos.
  async deleteAllLooseWetCheckPhotos(wetCheckId: number, companyId: number | null): Promise<number> {
    if (companyId !== null) {
      await this.assertWetCheckBelongsToCompany(wetCheckId, companyId);
    }
    const rows = await db
      .select()
      .from(wetCheckPhotos)
      .where(and(eq(wetCheckPhotos.wetCheckId, wetCheckId), isNull(wetCheckPhotos.findingId)));
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    await db.delete(wetCheckPhotos).where(inArray(wetCheckPhotos.id, ids));
    const objectStorage = new ObjectStorageService();
    await Promise.all(rows.map((r) => objectStorage.deletePhotoBlobs(r.url).catch(() => {})));
    return rows.length;
  }

  async getWetCheckPhotoUrls(wetCheckId: number): Promise<string[]> {
    const rows = await db
      .select({ url: wetCheckPhotos.url })
      .from(wetCheckPhotos)
      .where(eq(wetCheckPhotos.wetCheckId, wetCheckId));
    return rows.map((r) => r.url).filter(Boolean);
  }

  async getWetCheckPhotosGrouped(wetCheckId: number): Promise<Array<{url: string; zoneRecordId: number | null; findingId: number | null}>> {
    const rows = await db
      .select({
        url: wetCheckPhotos.url,
        zoneRecordId: wetCheckPhotos.zoneRecordId,
        findingId: wetCheckPhotos.findingId,
      })
      .from(wetCheckPhotos)
      .where(eq(wetCheckPhotos.wetCheckId, wetCheckId));
    return rows.filter((r) => r.url);
  }

  async linkWetCheckPhotoToFinding(
    photoId: number,
    findingId: number,
    companyId: number,
  ): Promise<WetCheckPhoto | undefined> {
    const [p] = await db.select().from(wetCheckPhotos).where(eq(wetCheckPhotos.id, photoId));
    if (!p) return undefined;
    await this.assertWetCheckEditableByTech(p.wetCheckId, companyId);
    const [f] = await db.select().from(wetCheckFindings).where(eq(wetCheckFindings.id, findingId));
    if (!f || f.wetCheckId !== p.wetCheckId) {
      throw new Error(`Finding ${findingId} does not belong to wet check ${p.wetCheckId}`);
    }
    const [updated] = await db
      .update(wetCheckPhotos)
      .set({ findingId, zoneRecordId: f.zoneRecordId })
      .where(eq(wetCheckPhotos.id, photoId))
      .returning();
    return updated;
  }

  async getWetCheckPhotoUrlsByIds(wetCheckIds: number[]): Promise<Map<number, string[]>> {
    if (wetCheckIds.length === 0) return new Map();
    const rows = await db
      .select({ wetCheckId: wetCheckPhotos.wetCheckId, url: wetCheckPhotos.url })
      .from(wetCheckPhotos)
      .where(inArray(wetCheckPhotos.wetCheckId, wetCheckIds))
      .orderBy(wetCheckPhotos.wetCheckId, desc(wetCheckPhotos.takenAt));
    const result = new Map<number, string[]>();
    for (const row of rows) {
      const list = result.get(row.wetCheckId) ?? [];
      list.push(row.url);
      result.set(row.wetCheckId, list);
    }
    return result;
  }

  async routeWetCheckFinding(
    id: number,
    companyId: number,
    resolution: "pending" | "repaired_in_field" | "sent_to_estimate" | "deferred_to_work_order" | "documented_only",
    manager: { id: number; name: string },
  ): Promise<WetCheckFinding | undefined> {
    const [f] = await db.select().from(wetCheckFindings).where(eq(wetCheckFindings.id, id));
    if (!f) return undefined;
    const wc = await this.assertWetCheckBelongsToCompany(f.wetCheckId, companyId);
    // Manager routing only makes sense once the field tech has handed off
    // (submitted / partially_converted). Block in_progress so a race during
    // tech edit cannot flip routing, and block converted so a fully-routed
    // wet check stays sealed.
    if (wc.status !== "submitted" && wc.status !== "partially_converted") {
      throw new Error(`Wet check ${f.wetCheckId} is ${wc.status}; routing is locked`);
    }
    // documented_only findings have convertedAt but no FK, so check both.
    const isConverted =
      f.convertedAt != null ||
      f.billingSheetId != null ||
      f.estimateId != null ||
      f.workOrderId != null;
    if (isConverted) {
      throw new Error(`Finding ${id} is already converted; routing is immutable`);
    }
    const [updated] = await db.update(wetCheckFindings).set({
      resolution,
      resolutionDecidedAt: resolution === "pending" ? null : new Date(),
      resolutionDecidedBy: resolution === "pending" ? null : manager.id,
      updatedAt: new Date(),
    }).where(eq(wetCheckFindings.id, id)).returning();
    return updated;
  }

  async convertWetCheckToWetCheckBilling(
    id: number,
    companyId: number,
    manager: { id: number; name: string },
    scheduledDates: Record<number, string | null> = {},
  ): Promise<{
    wetCheck: WetCheck;
    billingSheetId: number | null;
    estimateId: number | null;
    workOrderId: number | null;
  }> {
    return await db.transaction(async (tx) => {
      // Serialize concurrent conversions of THIS wet check (mirrors
      // approveEstimateAndCreateWorkOrder's estimate row lock ~3845). The second
      // waiter blocks here, re-reads the row AFTER the first commits — findings are
      // stamped (workOrderId/convertedAt) and excluded by `eligible`, so it inserts
      // nothing. Closes the race without touching the incremental-append design.
      const [wc] = await tx.select().from(wetChecks)
        .where(and(eq(wetChecks.id, id), eq(wetChecks.companyId, companyId)))
        .for("update");
      if (!wc) throw new Error(`Wet check ${id} not found for company ${companyId}`);
      if (wc.status !== "submitted" && wc.status !== "partially_converted") {
        throw new Error(`Cannot convert wet check in status ${wc.status}`);
      }
      const [cust] = await tx.select().from(customers).where(eq(customers.id, wc.customerId));
      if (!cust) throw new Error(`Customer ${wc.customerId} not found`);
      const laborRate = parseFloat(String(cust.laborRate ?? "45.00"));

      const allFindings = await tx.select().from(wetCheckFindings)
        .where(eq(wetCheckFindings.wetCheckId, id));

      const now = new Date();

      // Rescue: completed-in-field findings at resolution='pending' with no
      // billing route. Mirrors the submit path auto-route block so the convert
      // path reaches parity — these findings are stamped repaired_in_field and
      // flow into the WCB snapshot below without requiring manual manager routing.
      const completedInFieldRescue = allFindings.filter(
        f =>
          f.techDisposition === "completed_in_field" &&
          f.convertedAt == null &&
          f.wetCheckBillingId == null &&
          f.billingSheetId == null &&
          f.estimateId == null &&
          f.workOrderId == null &&
          f.resolution !== "repaired_in_field",
      );
      if (completedInFieldRescue.length > 0) {
        await tx.update(wetCheckFindings)
          .set({ resolution: "repaired_in_field", resolutionDecidedAt: now, updatedAt: now })
          .where(inArray(wetCheckFindings.id, completedInFieldRescue.map(f => f.id)));
        // Update in-memory so the eligible filter below sees the stamped resolution.
        for (const f of allFindings) {
          if (completedInFieldRescue.some(r => r.id === f.id)) {
            (f as any).resolution = "repaired_in_field";
          }
        }
      }

      // Eligible = routed AND not already converted. documented_only rows
      // have no FK so we must also gate on convertedAt or repeated converts
      // would re-stamp/re-process them (idempotency bug).
      const eligible = allFindings.filter(f =>
        f.resolution !== "pending" &&
        f.convertedAt == null &&
        f.billingSheetId == null && f.estimateId == null && f.workOrderId == null,
      );
      const repaired = eligible.filter(f => f.resolution === "repaired_in_field");
      const sentEst = eligible.filter(f => f.resolution === "sent_to_estimate");
      const deferred = eligible.filter(f => f.resolution === "deferred_to_work_order");
      const documented = eligible.filter(f => f.resolution === "documented_only");

      const calc = (f: typeof allFindings[number]) => {
        const qty = money(f.quantity);
        const partPrice = money(f.partPrice ?? "0");
        const laborHours = money(f.laborHours ?? "0");
        const partsTotal = partPrice * qty;
        const laborTotal = laborHours * laborRate;
        return { qty, partPrice, laborHours, partsTotal, laborTotal, lineTotal: partsTotal + laborTotal };
      };
      // Reuse destinations created on a prior partial conversion of THIS
      // wet check so we satisfy the "at most one BS / one estimate / one WO
      // per wet check lifecycle" invariant. Subsequent runs append items
      // to the existing record and recompute its totals instead of
      // creating a duplicate.
      // Slice 6: priorWcbId MUST be a real wet_check_billings.id — never a
      // billing_sheet id — because _writeRepairedInFieldBilling queries
      // wet_check_billings by this value. Legacy partial-conversion wet checks
      // (only billingSheetId set, no wetCheckBillingId) pass null so a new WCB
      // is created rather than silently targeting a non-existent WCB row.
      // The return value uses legacyPriorBsId as a fallback so callers that
      // display the id (route layer) still see a non-null value for legacy rows.
      const priorWcbId = allFindings.find(f => f.wetCheckBillingId != null)?.wetCheckBillingId ?? null;
      const legacyPriorBsId = allFindings.find(f => f.billingSheetId != null)?.billingSheetId ?? null;
      const priorEstId = allFindings.find(f => f.estimateId != null)?.estimateId ?? null;
      const priorWoId = allFindings.find(f => f.workOrderId != null)?.workOrderId ?? null;
      let billingSheetId: number | null = priorWcbId ?? legacyPriorBsId;
      let estimateId: number | null = priorEstId;
      let workOrderId: number | null = priorWoId;

      // 1) Repaired-in-field → at most one WCB per wet check (Slice 6).
      // Shared helper with submitWetCheck (Slice 3 auto-bill) keeps both
      // paths writing identical WCB shapes.
      if (repaired.length > 0) {
        billingSheetId = await this._writeRepairedInFieldBilling(
          tx, wc, laborRate, repaired, priorWcbId, now,
        );
      }

      // 2) Sent-to-estimate → at most one estimate per wet check
      if (sentEst.length > 0) {
        for (const f of sentEst) {
          if (!f.partId) {
            throw new Error(`Finding ${f.id} cannot be sent to estimate without a part`);
          }
        }
        let estId: number;
        if (priorEstId != null) {
          // Append items to the existing wet-check estimate, then recompute
          // totals from (existing items + new items). Use the SNAPSHOT
          // appliedLaborRate from the existing estimate so prior items
          // are not repriced. estimate-item `totalPrice` is parts-only
          // (partPrice * qty) per processEstimatePayload convention.
          const [priorEst] = await tx.select().from(estimates)
            .where(eq(estimates.id, priorEstId));
          const snapshotRate = parseFloat(String(priorEst?.appliedLaborRate ?? priorEst?.laborRate ?? laborRate));
          const existingItems = await tx.select().from(estimateItems)
            .where(eq(estimateItems.estimateId, priorEstId));
          let nextSort = existingItems.reduce((m, it) => Math.max(m, it.sortOrder ?? 0), -1) + 1;
          // Task #657 — append path is flat-only. Sum the labor from the
          // new findings, add it to the persisted estimate-level
          // `totalLaborHours` (or fall back to the sum of existing
          // per-row totals for legacy per_part rows that haven't been
          // backfilled yet), and write the combined total back to
          // `estimates.totalLaborHours`. Per-row `laborHours` on new
          // inserts is set to "0.00" so flat is the only source of
          // truth going forward.
          const newFindingsLaborHours = sentEst.reduce(
            (s, f) => s + calc(f).laborHours,
            0,
          );
          for (const f of sentEst) {
            const c = calc(f);
            await tx.insert(estimateItems).values({
              estimateId: priorEstId,
              description: f.notes ?? f.issueType,
              partId: f.partId as number,
              partName: f.partName ?? f.issueType,
              partPrice: c.partPrice.toFixed(2),
              laborHours: "0.00",
              quantity: c.qty,
              totalPrice: c.partsTotal.toFixed(2),
              sortOrder: nextSort++,
            } as typeof estimateItems.$inferInsert);
          }
          const allItems = await tx.select().from(estimateItems)
            .where(eq(estimateItems.estimateId, priorEstId));
          const partsSubtotal = allItems.reduce(
            (s, it) => s + money(it.totalPrice), 0);
          const priorEstAny = priorEst as { totalLaborHours?: string | null; laborMode?: string | null } | undefined;
          const persistedFlatHours = parseFloat(String(priorEstAny?.totalLaborHours ?? "0")) || 0;
          const legacyPerPartHours = existingItems.reduce(
            (s, it) => s + (parseFloat(String(it.laborHours ?? "0")) || 0),
            0,
          );
          const priorTotalLaborHours =
            priorEstAny?.laborMode === "per_part" && legacyPerPartHours > 0
              ? legacyPerPartHours
              : persistedFlatHours;
          const totalLaborHours = priorTotalLaborHours + newFindingsLaborHours;
          const laborSubtotal = totalLaborHours * snapshotRate;
          const total = partsSubtotal + laborSubtotal;
          await tx.update(estimates).set({
            partsSubtotal: partsSubtotal.toFixed(2),
            laborSubtotal: laborSubtotal.toFixed(2),
            totalAmount: total.toFixed(2),
            // Task #657 — collapse to flat on append so the row's storage
            // matches the new write contract; per-line legacy labor has
            // been folded into totalLaborHours above.
            laborMode: "flat",
            totalLaborHours: totalLaborHours.toFixed(2),
            updatedAt: now,
          }).where(eq(estimates.id, priorEstId));
          // Zero any pre-existing per-row labor on legacy per_part rows so
          // the flat total is the only source of truth from now on.
          if (legacyPerPartHours > 0) {
            await tx.update(estimateItems)
              .set({ laborHours: "0.00" })
              .where(eq(estimateItems.estimateId, priorEstId));
          }
          estId = priorEstId;
        } else {
          // First-time creation goes through the SAME service POST
          // /api/estimates uses, keeping any side effects in lock-step.
          // Task #669 — wet-check conversions allocate a number from
          // the same per-company sequence as regular estimates instead
          // of the legacy `EST-WC-…` ad-hoc string.
          const estimateNumber = await this.allocateNextEstimateNumber(
            tx,
            companyId,
          );
          // Task #657 — `processEstimatePayload` is flat-only and ignores
          // per-item laborHours when computing the labor subtotal; the
          // single source of truth is `estimate.totalLaborHours`. Pre-sum
          // each finding's line-level labor so wet-check conversion still
          // captures the originally calculated labor.
          const totalLaborHours = sentEst.reduce(
            (s, f) => s + calc(f).laborHours,
            0,
          );
          const est = await this.createEstimateFromPayload({
            estimate: {
              companyId,
              customerId: wc.customerId,
              customerName: cust.name,
              customerEmail: cust.email,
              customerPhone: cust.phone ?? null,
              projectName: `Wet check follow-up (#${id})`,
              projectAddress: wc.propertyAddress ?? null,
              createdBy: manager.name,
              createdByUserId: manager.id,
              estimateDate: now,
              status: "pending",
              laborRate: laborRate.toFixed(2),
              appliedLaborRate: laborRate.toFixed(2),
              laborMode: "flat",
              totalLaborHours: totalLaborHours.toFixed(2),
            } as EstimatePayloadInput["estimate"],
            items: sentEst.map((f, idx) => {
              const c = calc(f);
              return {
                description: f.notes ?? f.issueType,
                partId: f.partId as number,
                partName: f.partName ?? f.issueType,
                partPrice: c.partPrice.toFixed(2),
                // Per-row labor is ignored at the boundary (flat-only) but
                // we still emit it so any pre-flat reader sees the same
                // value the finding calc produced.
                laborHours: c.laborHours.toFixed(2),
                quantity: c.qty,
                sortOrder: idx,
              };
            }),
          }, tx, estimateNumber);
          estId = est.id;
        }
        estimateId = estId;
        for (const f of sentEst) {
          await tx.update(wetCheckFindings).set({
            estimateId: estId,
            convertedAt: now,
            updatedAt: now,
          }).where(eq(wetCheckFindings.id, f.id));
        }
      }

      // 3) Deferred-to-work-order → at most one work order per wet check
      if (deferred.length > 0) {
        const lines = deferred.map(calc);
        const newPartsSubtotal = lines.reduce((s, l) => s + l.partsTotal, 0);
        const newLaborHours = lines.reduce((s, l) => s + l.laborHours, 0);
        // Earliest manager-supplied scheduled date wins for the WO header.
        let scheduled: Date | null = null;
        for (const f of deferred) {
          const raw = scheduledDates[f.id];
          if (raw) {
            const d = new Date(raw);
            if (!isNaN(d.getTime()) && (!scheduled || d < scheduled)) scheduled = d;
          }
        }

        let woId: number;
        if (priorWoId != null) {
          // Append items to the existing wet-check WO and recompute totals
          // from the SNAPSHOT appliedLaborRate stored on that WO so prior
          // items are not repriced. WO-item totalPrice mirrors estimate-
          // item convention: parts-only (partPrice * qty).
          const [priorWo] = await tx.select().from(workOrders)
            .where(eq(workOrders.id, priorWoId));
          const snapshotRate = parseFloat(String(priorWo?.appliedLaborRate ?? priorWo?.laborRate ?? laborRate));
          const existingItems = await tx.select().from(workOrderItems)
            .where(eq(workOrderItems.workOrderId, priorWoId));
          for (let i = 0; i < deferred.length; i++) {
            const f = deferred[i];
            const l = lines[i];
            await tx.insert(workOrderItems).values({
              workOrderId: priorWoId,
              partId: f.partId,
              partName: f.partName ?? f.issueType,
              partPrice: l.partPrice.toFixed(2),
              quantity: l.qty,
              laborHours: l.laborHours.toFixed(2),
              totalPrice: l.partsTotal.toFixed(2),
              // Slice 3 — stamp lineage so duplicates are detectable by
              // COUNT(*) > 1 per (workOrderId, findingId).
              findingId: f.id,
            });
          }
          const existingParts = existingItems.reduce(
            (s, it) => s + parseFloat(String(it.totalPrice ?? "0")), 0);
          const existingLaborHours = existingItems.reduce(
            (s, it) => s + parseFloat(String(it.laborHours ?? "0")), 0);
          const partsSubtotal = existingParts + newPartsSubtotal;
          const totalLaborHours = existingLaborHours + newLaborHours;
          const laborSubtotal = totalLaborHours * snapshotRate;
          const total = partsSubtotal + laborSubtotal;
          await tx.update(workOrders).set({
            totalHours: totalLaborHours.toFixed(2),
            laborSubtotal: laborSubtotal.toFixed(2),
            partsSubtotal: partsSubtotal.toFixed(2),
            totalAmount: total.toFixed(2),
            totalItems: existingItems.length + deferred.length,
            // Only move scheduledDate earlier — never push it later — so a
            // follow-up conversion cannot delay work the manager already
            // committed to. Pass-through if no prior date existed.
            ...(scheduled && (!priorWo?.scheduledDate || scheduled < priorWo.scheduledDate)
              ? { scheduledDate: scheduled }
              : {}),
          }).where(eq(workOrders.id, priorWoId));
          woId = priorWoId;
        } else {
          const laborSubtotal = newLaborHours * laborRate;
          const total = newPartsSubtotal + laborSubtotal;
          const woNumber = `WO-WC-${id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          const wo = await this._writeWorkOrderWithItems(
            tx,
            {
              workOrderNumber: woNumber,
              customerId: wc.customerId,
              companyId: companyId,
              customerName: cust.name,
              customerEmail: cust.email,
              customerPhone: cust.phone ?? null,
              projectName: `Wet check deferred work (#${id})`,
              projectAddress: wc.propertyAddress ?? null,
              workType: "maintenance",
              status: "pending",
              priority: "medium",
              scheduledDate: scheduled,
              description: `Deferred from wet check #${id}`,
              totalHours: newLaborHours.toFixed(2),
              laborRate: laborRate.toFixed(2),
              laborSubtotal: laborSubtotal.toFixed(2),
              partsSubtotal: newPartsSubtotal.toFixed(2),
              totalAmount: total.toFixed(2),
              appliedLaborRate: laborRate.toFixed(2),
              totalItems: deferred.length,
            } as typeof workOrders.$inferInsert,
            deferred.map((f, i) => {
              const l = lines[i];
              return {
                partId: f.partId,
                partName: f.partName ?? f.issueType,
                partPrice: l.partPrice.toFixed(2),
                quantity: l.qty,
                laborHours: l.laborHours.toFixed(2),
                // Parts-only line total per estimate/WO item convention
                // (labor is captured at header from laborHours * applied rate).
                totalPrice: l.partsTotal.toFixed(2),
                // Slice 3 — stamp lineage for duplicate detection.
                findingId: f.id,
              };
            }),
          );
          woId = wo.id;
        }
        workOrderId = woId;

        for (const f of deferred) {
          await tx.update(wetCheckFindings).set({
            workOrderId: woId,
            convertedAt: now,
            updatedAt: now,
          }).where(eq(wetCheckFindings.id, f.id));
        }
      }

      // 4) Documented-only → stamp convertedAt only (no FK)
      for (const f of documented) {
        await tx.update(wetCheckFindings).set({
          convertedAt: now,
          updatedAt: now,
        }).where(eq(wetCheckFindings.id, f.id));
      }

      // 5) Wet check status: partially_converted if any pending remain.
      const stillPending = await tx.select({ id: wetCheckFindings.id })
        .from(wetCheckFindings)
        .where(and(
          eq(wetCheckFindings.wetCheckId, id),
          eq(wetCheckFindings.resolution, "pending"),
        ));
      const newStatus = stillPending.length > 0 ? "partially_converted" : "converted";
      const [updated] = await tx.update(wetChecks).set({
        status: newStatus,
        fullyConvertedAt: stillPending.length > 0 ? null : now,
        updatedAt: now,
      }).where(eq(wetChecks.id, id)).returning();

      return { wetCheck: updated, billingSheetId, estimateId, workOrderId };
    });
  }

  // ─── WC Inspection Mode — Slice 2 ───────────────────────────────────────────
  //
  // buildEstimateFromInspectionWetCheck
  // ------------------------------------
  // Idempotent: if an estimate with originWetCheckId = wcId already exists it
  // is returned without creating a duplicate. Otherwise builds one from the wet
  // check's findings (all findings contribute — Inspection wet checks have no
  // per-finding resolution triage). Each contributing finding gets its
  // `estimateId` FK stamped. Runs inside a single transaction.
  async buildEstimateFromInspectionWetCheck(
    wcId: number,
    companyId: number,
    manager: { id: number; name: string },
  ): Promise<EstimateWithItems> {
    return db.transaction(async (tx) => {
      // 1. Load and validate wet check.
      const [wc] = await tx.select().from(wetChecks)
        .where(and(eq(wetChecks.id, wcId), eq(wetChecks.companyId, companyId)));
      if (!wc) throw new Error(`Wet check #${wcId} not found`);
      if (wc.mode !== "inspection") {
        throw new Error(`Wet check #${wcId} is not an inspection wet check (mode=${wc.mode})`);
      }

      // 2. Duplicate guard: return existing estimate if one is already linked.
      const [existing] = await tx.select().from(estimates)
        .where(eq(estimates.originWetCheckId, wcId));
      if (existing) {
        const items = await tx.select().from(estimateItems)
          .where(eq(estimateItems.estimateId, existing.id));
        return { ...existing, lifecycleStatus: computeLifecycleStatus(existing), items } as EstimateWithItems;
      }

      // 3. Load customer for pricing context.
      const [cust] = await tx.select().from(customers).where(eq(customers.id, wc.customerId));
      if (!cust) throw new Error(`Customer ${wc.customerId} not found for wet check #${wcId}`);
      const laborRate = parseFloat(String(cust.laborRate ?? "45.00")) || 45;

      // 4. Load findings with zone context.
      const allFindings = await tx.select().from(wetCheckFindings)
        .where(eq(wetCheckFindings.wetCheckId, wcId));

      // Load the zone records so each finding can be stamped with
      // controllerLetter / zoneNumber (findings reference zone records via FK).
      const zoneRecordIds = [...new Set(allFindings.map((f) => f.zoneRecordId))];
      const zoneRecords = zoneRecordIds.length > 0
        ? await tx.select().from(wetCheckZoneRecords)
          .where(inArray(wetCheckZoneRecords.id, zoneRecordIds))
        : [];
      const zoneByRecordId = new Map(zoneRecords.map((z) => [z.id, z]));

      // 5. Build merged estimate line items from ALL findings.
      // Delegates to the shared buildInspectionEstimateItems helper so the
      // backfill script uses identical merge / sort logic.
      const now = new Date();
      const { items: drafts, totalLaborHours } = buildInspectionEstimateItems(
        allFindings.map((f) => ({
          zoneRecordId: f.zoneRecordId,
          partId: f.partId ?? null,
          partName: f.partName ?? null,
          partPrice: f.partPrice ?? null,
          quantity: f.quantity,
          laborHours: String(f.laborHours ?? "0"),
          issueType: f.issueType,
          notes: f.notes ?? null,
        })),
        zoneByRecordId,
      );
      const lineItems: (typeof estimateItems.$inferInsert)[] =
        drafts as (typeof estimateItems.$inferInsert)[];

      const partsSubtotal = lineItems.reduce(
        (s, it) => s + parseFloat(String(it.totalPrice ?? "0")), 0,
      );
      const laborSubtotal = totalLaborHours * laborRate;
      const totalAmount = partsSubtotal + laborSubtotal;

      // 6. Create the estimate with originWetCheckId stamped.
      const estimatePayload: InsertEstimate & { companyId: number; originWetCheckId: number } = {
        companyId,
        customerId: wc.customerId,
        customerName: cust.name,
        customerEmail: cust.email ?? "",
        customerPhone: cust.phone ?? null,
        projectName: `Inspection report (#${wcId})`,
        projectAddress: wc.propertyAddress ?? null,
        createdBy: manager.name,
        createdByUserId: manager.id,
        estimateDate: now,
        status: "pending",
        internalStatus: "pending_approval",
        lifecycle: "pending_review",
        laborRate: laborRate.toFixed(2),
        appliedLaborRate: laborRate.toFixed(2),
        laborMode: "flat",
        totalLaborHours: totalLaborHours.toFixed(2),
        partsSubtotal: partsSubtotal.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        originWetCheckId: wcId,
        // Task #315 — carry branchName from the originating wet check so
        // the estimate and any resulting work order land on the correct branch.
        branchName: wc.branchName ?? null,
      };

      const est = await this._writeEstimateWithItems(
        tx,
        estimatePayload,
        lineItems as InsertEstimateItem[],
      );

      // 7. Stamp estimateId on each contributing finding.
      if (allFindings.length > 0) {
        await tx.update(wetCheckFindings)
          .set({ estimateId: est.id, updatedAt: now })
          .where(inArray(wetCheckFindings.id, allFindings.map(f => f.id)));
      }

      return est;
    });
  }

  // passInspectionToEstimates
  // -------------------------
  // Manager internal sign-off for an Inspection wet check. Stamps
  // estimate.internalStatus='approved_internal' (does NOT set lifecycle='approved'
  // or approvedAt — customer approval rides the normal estimate flow unchanged).
  // Flips the wet check to `converted` with fullyConvertedAt=now.
  //
  // Seam 2 self-heal: if the estimate is already customer-approved/sent (lifecycle
  // in 'sent'/'approved'/'rejected' OR internalStatus='sent_to_customer'), the
  // estimate write is skipped but the WC is still converted.
  //
  // Idempotency: if the WC is already `converted`, returns current state with no
  // writes.
  async passInspectionToEstimates(
    wcId: number,
    companyId: number,
  ): Promise<{ estimate: EstimateWithItems; wetCheck: WetCheck }> {
    return db.transaction(async (tx) => {
      // 1. Load and validate the wet check.
      const [wc] = await tx.select().from(wetChecks)
        .where(and(eq(wetChecks.id, wcId), eq(wetChecks.companyId, companyId)));
      if (!wc) throw new Error(`Wet check #${wcId} not found`);
      if (wc.mode !== "inspection") {
        throw new Error(`Wet check #${wcId} is not an inspection wet check`);
      }

      // 2. Idempotency: WC already converted — return stable result without writes.
      if (wc.status === "converted") {
        const [existingEstIdem] = await tx.select().from(estimates)
          .where(eq(estimates.originWetCheckId, wcId));
        if (existingEstIdem) {
          const itemsIdem = await tx.select().from(estimateItems)
            .where(eq(estimateItems.estimateId, existingEstIdem.id));
          return {
            estimate: { ...existingEstIdem, lifecycleStatus: computeLifecycleStatus(existingEstIdem), items: itemsIdem } as EstimateWithItems,
            wetCheck: wc,
          };
        }
      }

      // 3. Find the linked estimate.
      const [existingEst] = await tx.select().from(estimates)
        .where(eq(estimates.originWetCheckId, wcId));
      if (!existingEst) {
        throw new Error(`No estimate found for inspection wet check #${wcId}. Build the estimate first.`);
      }

      // 4. Acquire a row-lock on the estimate (CAS-style pattern).
      const [lockedEst] = await tx.select().from(estimates)
        .where(eq(estimates.id, existingEst.id))
        .for("update");
      if (!lockedEst) throw new Error(`Estimate for wet check #${wcId} not found`);

      const now = new Date();

      // 5. Seam 2 self-heal: if the customer has already acted on the estimate
      //    (lifecycle in sent/approved/rejected or internalStatus=sent_to_customer),
      //    skip the estimate write — the auto-WO has already been created by the
      //    token-approve flow. Still convert the WC below.
      const CUSTOMER_ACTED_LIFECYCLES = new Set(["sent", "approved", "rejected"]);
      const estimateCustomerActed =
        CUSTOMER_ACTED_LIFECYCLES.has(lockedEst.lifecycle ?? "") ||
        lockedEst.internalStatus === "sent_to_customer";

      let finalEst = lockedEst;

      if (!estimateCustomerActed) {
        // 6. Normal path: internal sign-off only. Guard: only advance from
        //    pending_approval → approved_internal. Two concurrent callers
        //    serialize via the FOR UPDATE lock; the second sees zero rows
        //    returned by the CAS guard and hits idempotency via the WC check
        //    at step 2 on its next attempt.
        const [updatedEst] = await tx.update(estimates)
          .set({
            internalStatus: "approved_internal",
            updatedAt: now,
          } as Partial<typeof estimates.$inferInsert>)
          .where(and(
            eq(estimates.id, lockedEst.id),
            eq(estimates.internalStatus, "pending_approval"),
          ))
          .returning();
        if (!updatedEst) {
          throw new Error(`Estimate for wet check #${wcId} is not in pending_approval state and cannot be passed to estimates`);
        }
        finalEst = updatedEst;
      }

      const items = await tx.select().from(estimateItems)
        .where(eq(estimateItems.estimateId, finalEst.id));

      // 7. Transition the wet check to `converted`.
      const [updatedWc] = await tx.update(wetChecks)
        .set({
          status: "converted",
          fullyConvertedAt: now,
          updatedAt: now,
        })
        .where(eq(wetChecks.id, wcId))
        .returning();

      return {
        estimate: { ...finalEst, lifecycleStatus: computeLifecycleStatus(finalEst), items } as EstimateWithItems,
        wetCheck: updatedWc,
      };
    });
  }

  // unapproveInspectionEstimate
  // ----------------------------
  // Reverts a pass-to-estimates hand-off. Steps both rows back:
  //   - estimate: internalStatus='pending_approval' (status/lifecycle untouched —
  //     they were never changed by passInspectionToEstimates)
  //   - wet check: status='submitted', fullyConvertedAt=null
  //
  // Blocked if:
  //   - Any wet_check_billings row for this wet check is already invoiced.
  //   - The estimate has moved beyond approved_internal (sent/approved/rejected or
  //     internalStatus='sent_to_customer') — the hand-off cannot be undone once the
  //     estimate has left the building.
  async unapproveInspectionEstimate(
    wcId: number,
    companyId: number,
  ): Promise<{ estimate: EstimateWithItems; wetCheck: WetCheck }> {
    return db.transaction(async (tx) => {
      // 1. Load and row-lock the wet check.
      const [wc] = await tx.select().from(wetChecks)
        .where(and(eq(wetChecks.id, wcId), eq(wetChecks.companyId, companyId)))
        .for("update");
      if (!wc) throw new Error(`Wet check #${wcId} not found`);
      if (wc.mode !== "inspection") {
        throw new Error(`Wet check #${wcId} is not an inspection wet check`);
      }
      if (wc.status !== "converted") {
        throw new Error(`Wet check #${wcId} is not in a converted state and cannot be reverted`);
      }

      // 2. Block if any WCB row for this wet check has already been invoiced.
      const [invoicedWcb] = await tx.select({ id: wetCheckBillings.id, invoiceId: wetCheckBillings.invoiceId })
        .from(wetCheckBillings)
        .where(and(eq(wetCheckBillings.wetCheckId, wcId), isNotNull(wetCheckBillings.invoiceId)));
      if (invoicedWcb) {
        throw new Error(
          `Cannot revert: the wet check billing has already been included in invoice #${invoicedWcb.invoiceId}. Void the invoice first.`,
        );
      }

      // 3. Find and row-lock the linked estimate.
      const [existingEst] = await tx.select().from(estimates)
        .where(eq(estimates.originWetCheckId, wcId));
      if (!existingEst) {
        throw new Error(`No estimate found for inspection wet check #${wcId}`);
      }
      const [lockedEst] = await tx.select().from(estimates)
        .where(eq(estimates.id, existingEst.id))
        .for("update");
      if (!lockedEst) throw new Error(`Estimate for wet check #${wcId} not found`);

      // 4. New guard: block revert if estimate has already left the building.
      //    Once sent, approved, or rejected the hand-off cannot be undone.
      const BLOCKING_LIFECYCLES = new Set(["sent", "approved", "rejected"]);
      if (
        BLOCKING_LIFECYCLES.has(lockedEst.lifecycle ?? "") ||
        lockedEst.internalStatus === "sent_to_customer"
      ) {
        throw new Error(
          `Cannot revert: estimate for wet check #${wcId} has already been sent to the customer or acted upon. The hand-off cannot be undone at this stage.`,
        );
      }

      if (lockedEst.internalStatus !== "approved_internal") {
        throw new Error(`Estimate for wet check #${wcId} is not in approved_internal state and cannot be reverted`);
      }

      const now = new Date();

      // 5. Revert the estimate's internal sign-off using an internalStatus-gated CAS.
      //    status/lifecycle are untouched — they were never changed by passInspectionToEstimates.
      const [revertedEst] = await tx.update(estimates)
        .set({
          internalStatus: "pending_approval",
          updatedAt: now,
        } as Partial<typeof estimates.$inferInsert>)
        .where(and(eq(estimates.id, lockedEst.id), eq(estimates.internalStatus, "approved_internal")))
        .returning();
      if (!revertedEst) {
        throw new Error(`Estimate for wet check #${wcId} could not be reverted — concurrent modification detected`);
      }

      const items = await tx.select().from(estimateItems)
        .where(eq(estimateItems.estimateId, revertedEst.id));

      // 6. Revert the wet check to submitted.
      const [updatedWc] = await tx.update(wetChecks)
        .set({
          status: "submitted",
          fullyConvertedAt: null,
          updatedAt: now,
        })
        .where(eq(wetChecks.id, wcId))
        .returning();

      return {
        estimate: { ...revertedEst, lifecycleStatus: computeLifecycleStatus(revertedEst), items } as EstimateWithItems,
        wetCheck: updatedWc,
      };
    });
  }

  // ── Irrigation System Profile implementation ─────────────────────────────────

  // Build a company-guard condition. When companyId is null (super_admin), no
  // restriction is applied — the caller must already be super_admin.
  private _irrigationCompanyWhere(
    table: { companyId: any },
    companyId: number | null,
  ) {
    return companyId !== null ? eq(table.companyId, companyId) : undefined;
  }

  // Snapshot the full controller+programs+zones state into irrigation_profile_history.
  // Called inside a transaction after any mutating save.
  private async _appendIrrigationSnapshot(
    tx: DbExecutor,
    ctrl: IrrigationController,
    actor: { id: number; name: string } | undefined,
    summary: string,
  ): Promise<void> {
    const programs = await (tx as typeof db)
      .select()
      .from(irrigationPrograms)
      .where(eq(irrigationPrograms.controllerId, ctrl.id))
      .orderBy(irrigationPrograms.sortOrder, irrigationPrograms.id);

    const zones = await (tx as typeof db)
      .select()
      .from(irrigationProfileZones)
      .where(eq(irrigationProfileZones.controllerId, ctrl.id))
      .orderBy(irrigationProfileZones.zoneOrder, irrigationProfileZones.zoneNumber);

    await (tx as typeof db).insert(irrigationProfileHistory).values({
      companyId: ctrl.companyId,
      controllerId: ctrl.id,
      snapshotJson: { controller: ctrl, programs, zones } as any,
      changedByUserId: actor?.id ?? null,
      changedByName: actor?.name ?? null,
      summary,
    });
  }

  // Stamp lastUpdatedBy* on a controller row (inside a transaction).
  private async _stampControllerUpdated(
    tx: DbExecutor,
    controllerId: number,
    actor: { id: number; name: string } | undefined,
  ): Promise<IrrigationController | null> {
    const now = new Date();
    const [updated] = await (tx as typeof db)
      .update(irrigationControllers)
      .set({
        lastUpdatedByUserId: actor?.id ?? null,
        lastUpdatedByName: actor?.name ?? null,
        lastUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(irrigationControllers.id, controllerId))
      .returning();
    return updated ?? null;
  }

  async listIrrigationControllers(
    companyId: number | null,
    customerId: number,
    branchName?: string,
  ): Promise<IrrigationController[]> {
    const conditions = [eq(irrigationControllers.customerId, customerId)];
    if (companyId !== null) conditions.push(eq(irrigationControllers.companyId, companyId));
    if (branchName !== undefined) conditions.push(eq(irrigationControllers.branchName, branchName));
    return db
      .select()
      .from(irrigationControllers)
      .where(and(...conditions))
      // Task #1856: order by stored letter (A–Z) instead of name so the
      // list is stable regardless of how descriptive the controller names are.
      // NULLs sort last (pre-backfill rows) — they won't appear after the
      // NOT NULL migration hardens the column.
      .orderBy(irrigationControllers.letter, irrigationControllers.id);
  }

  /**
   * Task #1856 — Return the lowest unused letter (A–Z) for a controller in the
   * given (company, customer, branch) scope. Letters are read from the stored
   * `letter` column only (not derived from names). Throws if all 26 are taken.
   */
  async nextControllerLetter(
    companyId: number,
    customerId: number,
    branchName?: string,
  ): Promise<string> {
    const branch = typeof branchName === "string" ? branchName.trim() : "";
    const rows = await db
      .select({ letter: irrigationControllers.letter })
      .from(irrigationControllers)
      .where(and(
        eq(irrigationControllers.companyId, companyId),
        eq(irrigationControllers.customerId, customerId),
        eq(irrigationControllers.branchName, branch),
        isNotNull(irrigationControllers.letter),
      ));
    const usedLetters = new Set<string>(
      rows.map(r => r.letter).filter((l): l is string => l != null),
    );
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const candidate of ALPHABET) {
      if (!usedLetters.has(candidate)) return candidate;
    }
    throw new Error(
      `All 26 controller letters are in use for scope (company ${companyId}, customer ${customerId}, branch "${branch}")`,
    );
  }

  async ensureIrrigationControllers(
    companyId: number,
    customerId: number,
    configs: Array<{ name: string; zoneCount: number | null; letter?: string }>,
    branchName?: string | null,
  ): Promise<IrrigationController[]> {
    const branch = typeof branchName === "string" ? branchName.trim() : "";

    const existing = await db
      .select()
      .from(irrigationControllers)
      .where(
        and(
          eq(irrigationControllers.companyId, companyId),
          eq(irrigationControllers.customerId, customerId),
          eq(irrigationControllers.branchName, branch),
        ),
      );

    const haveNames = new Set(existing.map((c) => c.name));
    // Track assigned letters so gap-reuse within this batch works correctly.
    const usedLetters = new Set<string>(
      existing.map(c => c.letter).filter((l): l is string => l != null),
    );

    for (const config of configs) {
      if (haveNames.has(config.name)) continue;

      // Assign the next available letter for this scope.
      let letter = config.letter;
      if (!letter || usedLetters.has(letter)) {
        // Prefer the requested letter if free; otherwise pick the next gap.
        const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        for (const candidate of ALPHABET) {
          if (!usedLetters.has(candidate)) {
            letter = candidate;
            break;
          }
        }
      }
      if (!letter) {
        // All 26 letters are in use — hard limit matches MAX_CONTROLLERS = 26.
        throw new Error(
          `ensureIrrigationControllers: cannot create controller "${config.name}" — all 26 letters (A–Z) are already in use for this property.`,
        );
      }
      usedLetters.add(letter);

      const [inserted] = await db
        .insert(irrigationControllers)
        .values({
          companyId,
          customerId,
          branchName: branch,
          name: config.name,
          letter,
          totalZones: config.zoneCount ?? null,
          isActive: true,
          lastUpdatedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      // Seed placeholder zones 1..zoneCount for the newly created controller.
      // Only seed when we have a real count — null means "not yet configured".
      if (inserted && config.zoneCount != null) {
        for (let z = 1; z <= config.zoneCount; z++) {
          await db
            .insert(irrigationProfileZones)
            .values({
              companyId,
              controllerId: inserted.id,
              zoneNumber: z,
              name: `Zone ${z}`,
              zoneType: "other",
              runTimeMinutes: 0,
              zoneOrder: z,
              isActive: true,
            })
            .onConflictDoNothing();
        }
      }
    }

    return db
      .select()
      .from(irrigationControllers)
      .where(
        and(
          eq(irrigationControllers.companyId, companyId),
          eq(irrigationControllers.customerId, customerId),
          eq(irrigationControllers.branchName, branch),
        ),
      )
      // Task #1856: order by stored letter so controllers are stable.
      .orderBy(irrigationControllers.letter, irrigationControllers.id);
  }

  async getIrrigationController(
    companyId: number | null,
    id: number,
  ): Promise<(IrrigationController & { programs: IrrigationProgram[]; zones: IrrigationProfileZone[] }) | null> {
    const conditions = [eq(irrigationControllers.id, id)];
    if (companyId !== null) conditions.push(eq(irrigationControllers.companyId, companyId));

    const [ctrl] = await db
      .select()
      .from(irrigationControllers)
      .where(and(...conditions));
    if (!ctrl) return null;

    const [programs, zones] = await Promise.all([
      db
        .select()
        .from(irrigationPrograms)
        .where(eq(irrigationPrograms.controllerId, id))
        .orderBy(irrigationPrograms.sortOrder, irrigationPrograms.id),
      db
        .select()
        .from(irrigationProfileZones)
        .where(eq(irrigationProfileZones.controllerId, id))
        .orderBy(irrigationProfileZones.zoneOrder, irrigationProfileZones.zoneNumber),
    ]);

    return { ...ctrl, programs, zones };
  }

  async createIrrigationController(
    data: InsertIrrigationController,
  ): Promise<IrrigationController> {
    // Task #1856: auto-assign a letter if one was not provided by the caller.
    // Retry up to 3 times on unique-index violation (23505) — rare concurrent
    // creation race where two requests both see the same free letter and try
    // to insert simultaneously. The unique index on (company, customer, branch,
    // letter) will reject the second; we retry with the next free gap.
    const branch = typeof data.branchName === "string" ? data.branchName.trim() : "";
    let letter = data.letter;
    const MAX_RETRIES = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (!letter) {
        letter = await this.nextControllerLetter(data.companyId, data.customerId, branch);
      }
      try {
        const [ctrl] = await db
          .insert(irrigationControllers)
          .values({
            ...data,
            branchName: branch,
            letter,
            lastUpdatedAt: data.lastUpdatedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .returning();
        return ctrl;
      } catch (err: any) {
        // Unique index violation on letter within scope — retry with next free letter
        const isUniqueViolation =
          err?.code === "23505" ||
          (typeof err?.message === "string" && err.message.includes("uniq_irr_ctrl_letter"));
        if (isUniqueViolation && attempt < MAX_RETRIES) {
          letter = undefined; // force re-pick on next iteration
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("createIrrigationController: failed after retries");
  }

  async updateIrrigationController(
    companyId: number | null,
    id: number,
    patch: Partial<Omit<InsertIrrigationController, "companyId" | "customerId">>,
    actor?: { id: number; name: string },
  ): Promise<IrrigationController | null> {
    return db.transaction(async (tx) => {
      const conditions = [eq(irrigationControllers.id, id)];
      if (companyId !== null) conditions.push(eq(irrigationControllers.companyId, companyId));

      // Load the current controller before updating so we can compare totalZones.
      const [before] = await tx
        .select()
        .from(irrigationControllers)
        .where(and(...conditions));
      if (!before) return null;

      const now = new Date();
      const [updated] = await tx
        .update(irrigationControllers)
        .set({
          ...patch,
          lastUpdatedByUserId: actor?.id ?? patch.lastUpdatedByUserId ?? null,
          lastUpdatedByName: actor?.name ?? patch.lastUpdatedByName ?? null,
          lastUpdatedAt: now,
          updatedAt: now,
        })
        .where(and(...conditions))
        .returning();
      if (!updated) return null;

      // Non-destructive zone trim: when totalZones decreases, remove trailing
      // irrigation_profile_zones rows ONLY if they carry no data.
      // A zone is "safe to delete" when: no programId, runTimeMinutes is 0
      // or null, and notes is null or empty. Zones with any data are preserved
      // even if their zoneNumber exceeds the new totalZones cap.
      const newTotalZones = updated.totalZones;
      const oldTotalZones = before.totalZones;
      if (
        typeof newTotalZones === "number" &&
        typeof oldTotalZones === "number" &&
        newTotalZones < oldTotalZones
      ) {
        const candidateZones = await tx
          .select()
          .from(irrigationProfileZones)
          .where(
            and(
              eq(irrigationProfileZones.controllerId, id),
              sql`${irrigationProfileZones.zoneNumber} > ${newTotalZones}`,
            ),
          );

        for (const zone of candidateZones) {
          const isEmptyZone =
            zone.programId === null &&
            (zone.runTimeMinutes === 0 || zone.runTimeMinutes === null) &&
            (!zone.notes || zone.notes.trim() === "");
          if (isEmptyZone) {
            await tx.delete(irrigationProfileZones).where(eq(irrigationProfileZones.id, zone.id));
          }
        }
      } else if (
        typeof newTotalZones === "number" &&
        typeof oldTotalZones === "number" &&
        newTotalZones > oldTotalZones
      ) {
        // Seed placeholder rows for newly added zones.
        // onConflictDoNothing ensures safety on any race or partial-seeded state.
        const newZones = [];
        for (let z = oldTotalZones + 1; z <= newTotalZones; z++) {
          newZones.push({
            companyId: updated.companyId,
            controllerId: updated.id,
            zoneNumber: z,
            name: `Zone ${z}`,
            zoneType: "other" as const,
            runTimeMinutes: 0,
            zoneOrder: z,
            isActive: true,
          });
        }
        if (newZones.length > 0) {
          await tx.insert(irrigationProfileZones).values(newZones).onConflictDoNothing();
        }
      }

      await this._appendIrrigationSnapshot(tx, updated, actor, `Controller "${updated.name}" updated`);
      return updated;
    });
  }

  async deleteIrrigationController(
    companyId: number | null,
    id: number,
  ): Promise<boolean> {
    const conditions = [eq(irrigationControllers.id, id)];
    if (companyId !== null) conditions.push(eq(irrigationControllers.companyId, companyId));

    const result = await db
      .delete(irrigationControllers)
      .where(and(...conditions))
      .returning({ id: irrigationControllers.id });
    return result.length > 0;
  }

  async createIrrigationProgram(
    companyId: number | null,
    controllerId: number,
    data: Omit<InsertIrrigationProgram, "companyId" | "controllerId">,
    actor?: { id: number; name: string },
  ): Promise<IrrigationProgram | null> {
    return db.transaction(async (tx) => {
      // Verify controller exists and belongs to the caller's company.
      const ctrlConds = [eq(irrigationControllers.id, controllerId)];
      if (companyId !== null) ctrlConds.push(eq(irrigationControllers.companyId, companyId));
      const [ctrl] = await tx.select().from(irrigationControllers).where(and(...ctrlConds));
      if (!ctrl) return null;

      const [program] = await tx
        .insert(irrigationPrograms)
        .values({ ...data, companyId: ctrl.companyId, controllerId })
        .returning();

      const stampedCtrl = await this._stampControllerUpdated(tx, controllerId, actor);
      await this._appendIrrigationSnapshot(
        tx,
        stampedCtrl ?? ctrl,
        actor,
        `Program "${program.name}" added to controller "${ctrl.name}"`,
      );
      return program;
    });
  }

  async updateIrrigationProgram(
    companyId: number | null,
    id: number,
    patch: Partial<Omit<InsertIrrigationProgram, "companyId" | "controllerId">>,
    actor?: { id: number; name: string },
  ): Promise<IrrigationProgram | null> {
    return db.transaction(async (tx) => {
      // Load the program and verify company scope.
      const progConds = [eq(irrigationPrograms.id, id)];
      if (companyId !== null) progConds.push(eq(irrigationPrograms.companyId, companyId));
      const [existing] = await tx.select().from(irrigationPrograms).where(and(...progConds));
      if (!existing) return null;

      const [updated] = await tx
        .update(irrigationPrograms)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(irrigationPrograms.id, id))
        .returning();

      const [ctrl] = await tx
        .select()
        .from(irrigationControllers)
        .where(eq(irrigationControllers.id, existing.controllerId));
      if (ctrl) {
        const stampedCtrl = await this._stampControllerUpdated(tx, ctrl.id, actor);
        await this._appendIrrigationSnapshot(
          tx,
          stampedCtrl ?? ctrl,
          actor,
          `Program "${updated.name}" updated`,
        );
      }
      return updated;
    });
  }

  async deleteIrrigationProgram(
    companyId: number | null,
    id: number,
    actor?: { id: number; name: string },
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const progConds = [eq(irrigationPrograms.id, id)];
      if (companyId !== null) progConds.push(eq(irrigationPrograms.companyId, companyId));
      const [existing] = await tx.select().from(irrigationPrograms).where(and(...progConds));
      if (!existing) return false;

      await tx.delete(irrigationPrograms).where(eq(irrigationPrograms.id, id));

      const [ctrl] = await tx
        .select()
        .from(irrigationControllers)
        .where(eq(irrigationControllers.id, existing.controllerId));
      if (ctrl) {
        const stampedCtrl = await this._stampControllerUpdated(tx, ctrl.id, actor);
        await this._appendIrrigationSnapshot(
          tx,
          stampedCtrl ?? ctrl,
          actor,
          `Program "${existing.name}" deleted from controller "${ctrl.name}"`,
        );
      }
      return true;
    });
  }

  async createIrrigationZone(
    companyId: number | null,
    controllerId: number,
    data: Omit<InsertIrrigationProfileZone, "companyId" | "controllerId">,
    actor?: { id: number; name: string },
  ): Promise<IrrigationProfileZone | null> {
    return db.transaction(async (tx) => {
      const ctrlConds = [eq(irrigationControllers.id, controllerId)];
      if (companyId !== null) ctrlConds.push(eq(irrigationControllers.companyId, companyId));
      const [ctrl] = await tx.select().from(irrigationControllers).where(and(...ctrlConds));
      if (!ctrl) return null;

      const [zone] = await tx
        .insert(irrigationProfileZones)
        .values({ ...data, companyId: ctrl.companyId, controllerId })
        .returning();

      const stampedCtrl = await this._stampControllerUpdated(tx, controllerId, actor);
      await this._appendIrrigationSnapshot(
        tx,
        stampedCtrl ?? ctrl,
        actor,
        `Zone ${zone.zoneNumber} "${zone.name}" added to controller "${ctrl.name}"`,
      );
      return zone;
    });
  }

  async updateIrrigationZone(
    companyId: number | null,
    id: number,
    patch: Partial<Omit<InsertIrrigationProfileZone, "companyId" | "controllerId">>,
    actor?: { id: number; name: string },
  ): Promise<IrrigationProfileZone | null> {
    return db.transaction(async (tx) => {
      const zoneConds = [eq(irrigationProfileZones.id, id)];
      if (companyId !== null) zoneConds.push(eq(irrigationProfileZones.companyId, companyId));
      const [existing] = await tx.select().from(irrigationProfileZones).where(and(...zoneConds));
      if (!existing) return null;

      const [updated] = await tx
        .update(irrigationProfileZones)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(irrigationProfileZones.id, id))
        .returning();

      const [ctrl] = await tx
        .select()
        .from(irrigationControllers)
        .where(eq(irrigationControllers.id, existing.controllerId));
      if (ctrl) {
        const stampedCtrl = await this._stampControllerUpdated(tx, ctrl.id, actor);
        await this._appendIrrigationSnapshot(
          tx,
          stampedCtrl ?? ctrl,
          actor,
          `Zone ${updated.zoneNumber} "${updated.name}" updated`,
        );
      }
      return updated;
    });
  }

  async deleteIrrigationZone(
    companyId: number | null,
    id: number,
    actor?: { id: number; name: string },
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const zoneConds = [eq(irrigationProfileZones.id, id)];
      if (companyId !== null) zoneConds.push(eq(irrigationProfileZones.companyId, companyId));
      const [existing] = await tx.select().from(irrigationProfileZones).where(and(...zoneConds));
      if (!existing) return false;

      await tx.delete(irrigationProfileZones).where(eq(irrigationProfileZones.id, id));

      const [ctrl] = await tx
        .select()
        .from(irrigationControllers)
        .where(eq(irrigationControllers.id, existing.controllerId));
      if (ctrl) {
        const stampedCtrl = await this._stampControllerUpdated(tx, ctrl.id, actor);
        await this._appendIrrigationSnapshot(
          tx,
          stampedCtrl ?? ctrl,
          actor,
          `Zone ${existing.zoneNumber} "${existing.name}" deleted from controller "${ctrl.name}"`,
        );
      }
      return true;
    });
  }

  async getIrrigationHistory(
    companyId: number | null,
    controllerId: number,
  ): Promise<IrrigationProfileHistory[]> {
    const conditions = [eq(irrigationProfileHistory.controllerId, controllerId)];
    if (companyId !== null) conditions.push(eq(irrigationProfileHistory.companyId, companyId));
    return db
      .select()
      .from(irrigationProfileHistory)
      .where(and(...conditions))
      .orderBy(desc(irrigationProfileHistory.changedAt));
  }

  async importIrrigationProfile(
    companyId: number,
    customerId: number,
    branchName: string,
    rows: IrrigationImportRow[],
    mode: "preview" | "commit",
    actor?: { id: number; name: string },
    replaceControllers: string[] = [],
  ): Promise<IrrigationImportResult> {
    // ── Group CSV rows by controller name ────────────────────────────────────
    // Build a map: controllerName → { meta, programs: Map<progName,…>, zones: Map<zoneNum,row> }
    type ProgMeta = { wateringDays: string[] | null; startTimes: string[] | null; seasonalAdjustPct: number };
    type CtrlGroup = {
      location: string | null;
      brand: string | null;
      model: string | null;
      programs: Map<string, ProgMeta>;
      zones: Map<number, IrrigationImportRow>;
    };
    const ctrlGroups = new Map<string, CtrlGroup>();
    for (const row of rows) {
      let group = ctrlGroups.get(row.controllerName);
      if (!group) {
        group = {
          location: row.location,
          brand: row.brand,
          model: row.model,
          programs: new Map(),
          zones: new Map(),
        };
        ctrlGroups.set(row.controllerName, group);
      }
      // Later rows override controller-level metadata for the same controller
      if (row.location != null) group.location = row.location;
      if (row.brand != null) group.brand = row.brand;
      if (row.model != null) group.model = row.model;
      // Program: key by name (use "default" when blank)
      const progKey = row.programName?.trim() || "default";
      if (row.programName) {
        group.programs.set(progKey, {
          wateringDays: row.wateringDays,
          startTimes: row.startTimes,
          seasonalAdjustPct: row.seasonalAdjustPct,
        });
      }
      // Zone: key by number (last row wins for duplicates)
      group.zones.set(row.zoneNumber, row);
    }

    // ── Load existing controllers for this (company, customer, branch) ────────
    const existingCtrlList = await db
      .select()
      .from(irrigationControllers)
      .where(
        and(
          eq(irrigationControllers.companyId, companyId),
          eq(irrigationControllers.customerId, customerId),
          eq(irrigationControllers.branchName, branchName),
        ),
      );

    // Build lookup maps for existing data
    const existingCtrlByName = new Map(existingCtrlList.map((c) => [c.name, c]));

    // Task #1856: track which letters are already in use so we can assign
    // the next free letter to each newly-created controller in commit mode.
    // This Set is mutated during the commit-mode loop below.
    const csvUsedLetters = new Set<string>(
      existingCtrlList.map(c => c.letter).filter((l): l is string => l != null),
    );

    // ── Build the diff ────────────────────────────────────────────────────────
    const controllerDiffs: IrrigationImportControllerDiff[] = [];

    for (const [ctrlName, group] of ctrlGroups) {
      const existingCtrl = existingCtrlByName.get(ctrlName);
      const ctrlAction: "create" | "update" = existingCtrl ? "update" : "create";

      // Load existing programs and zones for this controller (if it exists)
      let existingPrograms: IrrigationProgram[] = [];
      let existingZones: IrrigationProfileZone[] = [];
      if (existingCtrl) {
        [existingPrograms, existingZones] = await Promise.all([
          db
            .select()
            .from(irrigationPrograms)
            .where(eq(irrigationPrograms.controllerId, existingCtrl.id))
            .orderBy(irrigationPrograms.sortOrder, irrigationPrograms.id),
          db
            .select()
            .from(irrigationProfileZones)
            .where(eq(irrigationProfileZones.controllerId, existingCtrl.id))
            .orderBy(irrigationProfileZones.zoneNumber),
        ]);
      }

      const existingProgByName = new Map(existingPrograms.map((p) => [p.name, p]));
      const existingZoneByNumber = new Map(existingZones.map((z) => [z.zoneNumber, z]));

      // Diff programs
      const programDiffs: IrrigationImportProgramDiff[] = [];
      for (const [progName, progMeta] of group.programs) {
        const existingProg = existingProgByName.get(progName);
        if (!existingProg) {
          programDiffs.push({ programName: progName, action: "create", changes: [] });
        } else {
          const changes: IrrigationImportProgramDiff["changes"] = [];
          if (progMeta.wateringDays !== null &&
              JSON.stringify(existingProg.wateringDays ?? []) !== JSON.stringify(progMeta.wateringDays)) {
            changes.push({ field: "wateringDays", from: existingProg.wateringDays ?? null, to: progMeta.wateringDays });
          }
          if (progMeta.startTimes !== null &&
              JSON.stringify(existingProg.startTimes ?? []) !== JSON.stringify(progMeta.startTimes)) {
            changes.push({ field: "startTimes", from: existingProg.startTimes ?? null, to: progMeta.startTimes });
          }
          if (existingProg.seasonalAdjustPct !== progMeta.seasonalAdjustPct) {
            changes.push({ field: "seasonalAdjustPct", from: existingProg.seasonalAdjustPct, to: progMeta.seasonalAdjustPct });
          }
          programDiffs.push({
            programName: progName,
            action: changes.length > 0 ? "update" : "no_change",
            changes,
          });
        }
      }

      // Diff zones
      const zoneDiffs: IrrigationImportZoneDiff[] = [];
      for (const [zoneNum, row] of group.zones) {
        const existingZone = existingZoneByNumber.get(zoneNum);
        if (!existingZone) {
          const resolvedName = resolveZoneName(row.zoneName, undefined, zoneNum);
          zoneDiffs.push({
            action: "create",
            zoneNumber: zoneNum,
            zoneName: resolvedName,
            zoneType: row.zoneType,
            runTimeMinutes: row.runTimeMinutes,
            changes: [],
          });
        } else {
          const resolvedName = resolveZoneName(row.zoneName, existingZone.name, zoneNum);
          const changes: IrrigationImportZoneDiff["changes"] = [];
          if (existingZone.name !== resolvedName) {
            changes.push({ field: "zoneName", from: existingZone.name, to: resolvedName });
          }
          if (existingZone.zoneType !== row.zoneType) {
            changes.push({ field: "zoneType", from: existingZone.zoneType, to: row.zoneType });
          }
          if (existingZone.runTimeMinutes !== row.runTimeMinutes) {
            changes.push({ field: "runTimeMinutes", from: existingZone.runTimeMinutes, to: row.runTimeMinutes });
          }
          zoneDiffs.push({
            action: changes.length > 0 ? "update" : "no_change",
            zoneNumber: zoneNum,
            zoneName: resolvedName,
            zoneType: row.zoneType,
            runTimeMinutes: row.runTimeMinutes,
            changes,
          });
        }
      }

      // ── Replace mode: compute removals (update-mode controllers only) ────────
      let zonesToRemove: import("./storage").IrrigationImportRemovedZone[] = [];
      let programsToRemove: import("./storage").IrrigationImportRemovedProgram[] = [];
      if (ctrlAction === "update" && replaceControllers.includes(ctrlName)) {
        const csvZoneNumbers = new Set(group.zones.keys());
        zonesToRemove = existingZones
          .filter((z) => !csvZoneNumbers.has(z.zoneNumber))
          .map((z) => ({
            id: z.id,
            zoneNumber: z.zoneNumber,
            name: z.name,
            notes: z.notes ?? null,
            overrideStartTime: z.overrideStartTime ?? null,
            overrideDays: (z.overrideDays ?? null) as string[] | null,
          }));
        const csvProgramNames = new Set(group.programs.keys());
        programsToRemove = existingPrograms
          .filter((p) => !csvProgramNames.has(p.name))
          .map((p) => ({ id: p.id, name: p.name }));
      }

      controllerDiffs.push({
        controllerName: ctrlName,
        action: ctrlAction,
        location: group.location,
        brand: group.brand,
        model: group.model,
        programs: programDiffs,
        zones: zoneDiffs,
        ...(zonesToRemove.length > 0 || programsToRemove.length > 0 || replaceControllers.includes(ctrlName)
          ? { zonesToRemove, programsToRemove }
          : {}),
      });
    }

    const summary = {
      controllersCreated: controllerDiffs.filter((c) => c.action === "create").length,
      controllersUpdated: controllerDiffs.filter((c) => c.action === "update").length,
      zonesAdded: controllerDiffs.reduce((n, c) => n + c.zones.filter((z) => z.action === "create").length, 0),
      zonesUpdated: controllerDiffs.reduce((n, c) => n + c.zones.filter((z) => z.action === "update").length, 0),
      programsCreated: controllerDiffs.reduce((n, c) => n + c.programs.filter((p) => p.action === "create").length, 0),
      programsUpdated: controllerDiffs.reduce((n, c) => n + c.programs.filter((p) => p.action === "update").length, 0),
      zonesRemoved: controllerDiffs.reduce((n, c) => n + (c.zonesToRemove?.length ?? 0), 0),
      programsRemoved: controllerDiffs.reduce((n, c) => n + (c.programsToRemove?.length ?? 0), 0),
    };

    if (mode === "preview") {
      return { mode: "preview", controllers: controllerDiffs, summary };
    }

    // ── Commit mode: apply the merge in a single transaction ─────────────────
    // We drive writes using the pre-computed controllerDiffs so that re-importing
    // an identical CSV is a true no-op (no DB writes, no history snapshots).
    await db.transaction(async (tx) => {
      const q = tx as unknown as typeof db;

      for (const ctrlDiff of controllerDiffs) {
        const ctrlName = ctrlDiff.controllerName;
        const group = ctrlGroups.get(ctrlName)!;
        const existingCtrl = existingCtrlByName.get(ctrlName);

        const hasProgramChanges = ctrlDiff.programs.some((p) => p.action !== "no_change");
        const hasZoneChanges = ctrlDiff.zones.some((z) => z.action !== "no_change");
        const isReplaceMode = replaceControllers.includes(ctrlName);
        const hasRemovals =
          (ctrlDiff.zonesToRemove?.length ?? 0) > 0 ||
          (ctrlDiff.programsToRemove?.length ?? 0) > 0;

        // No-op: existing controller with nothing to create, update, or remove — skip entirely.
        if (ctrlDiff.action === "update" && !hasProgramChanges && !hasZoneChanges && !hasRemovals) {
          continue;
        }

        let ctrlId: number;

        if (ctrlDiff.action === "create") {
          // ── Create new controller ────────────────────────────────────────
          // Task #1856: assign the next free letter before inserting so the
          // NOT NULL + unique constraint on (company, customer, branch, letter)
          // is satisfied. csvUsedLetters tracks both existing and newly-created
          // controllers within this import run.
          const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
          let ctrlLetter: string | undefined;
          for (const candidate of ALPHABET) {
            if (!csvUsedLetters.has(candidate)) { ctrlLetter = candidate; break; }
          }
          if (!ctrlLetter) {
            throw new Error(
              `CSV import: cannot create controller "${ctrlName}" — all 26 letters (A–Z) are already in use for this property. Remove an existing controller first.`,
            );
          }
          csvUsedLetters.add(ctrlLetter);

          const [newCtrl] = await q
            .insert(irrigationControllers)
            .values({
              companyId,
              customerId,
              branchName,
              name: ctrlName,
              letter: ctrlLetter,
              location: group.location,
              brand: group.brand,
              model: group.model,
              totalZones: group.zones.size > 0 ? Math.max(...group.zones.keys()) : null,
              isActive: true,
              lastUpdatedByUserId: actor?.id ?? null,
              lastUpdatedByName: actor?.name ?? null,
              lastUpdatedAt: new Date(),
            })
            .returning();
          ctrlId = newCtrl.id;
        } else {
          // ── Update existing controller (only fields that actually changed) ─
          ctrlId = existingCtrl!.id;
          // In Replace mode, totalZones is the exact post-delete zone count
          // (only the CSV zones survive, so group.zones.size is definitive).
          // In add/update mode it is the high-water mark of max zone number seen
          // (grows monotonically, never shrinks).
          const maxInputZone = group.zones.size > 0 ? Math.max(...group.zones.keys()) : 0;
          const newTotalZones = isReplaceMode
            ? (group.zones.size > 0 ? group.zones.size : null)
            : (maxInputZone > (existingCtrl!.totalZones ?? 0) ? maxInputZone : existingCtrl!.totalZones);

          const ctrlPatch: Record<string, unknown> = {};
          if (group.location !== null && group.location !== existingCtrl!.location)
            ctrlPatch.location = group.location;
          if (group.brand !== null && group.brand !== existingCtrl!.brand)
            ctrlPatch.brand = group.brand;
          if (group.model !== null && group.model !== existingCtrl!.model)
            ctrlPatch.model = group.model;
          if (newTotalZones !== existingCtrl!.totalZones) ctrlPatch.totalZones = newTotalZones;

          // Stamp lastUpdated only when there is actual work to do
          if (Object.keys(ctrlPatch).length > 0 || hasProgramChanges || hasZoneChanges || hasRemovals) {
            ctrlPatch.lastUpdatedByUserId = actor?.id ?? null;
            ctrlPatch.lastUpdatedByName = actor?.name ?? null;
            ctrlPatch.lastUpdatedAt = new Date();
            ctrlPatch.updatedAt = new Date();
            await q
              .update(irrigationControllers)
              .set(ctrlPatch)
              .where(eq(irrigationControllers.id, ctrlId));
          }
        }

        // ── Test seam ─────────────────────────────────────────────────────────
        // In production this global is never set, so the branch is a single
        // no-cost typeof check. Integration tests may set
        // globalThis.__importIrrigationProfileMidTxHook to a function that
        // throws, proving the transaction is atomic across controller + zone
        // writes. Always clear the hook in the test's finally block.
        {
          const _midTxHook = (globalThis as any).__importIrrigationProfileMidTxHook;
          if (typeof _midTxHook === "function") {
            await _midTxHook(ctrlId);
          }
        }

        // ── Programs: only create/update those that the diff marks as changed ─
        const progDiffByName = new Map(ctrlDiff.programs.map((p) => [p.programName, p]));
        const existingProgByName = new Map(
          (
            await q
              .select()
              .from(irrigationPrograms)
              .where(eq(irrigationPrograms.controllerId, ctrlId))
          ).map((p) => [p.name, p]),
        );
        const progNameToId = new Map<string, number>();
        let sortIdx = existingProgByName.size;

        for (const [progName, progMeta] of group.programs) {
          const existingProg = existingProgByName.get(progName);
          const pd = progDiffByName.get(progName);

          if (!existingProg || pd?.action === "create") {
            // Create
            const [newProg] = await q
              .insert(irrigationPrograms)
              .values({
                companyId,
                controllerId: ctrlId,
                name: progName,
                wateringDays: progMeta.wateringDays,
                startTimes: progMeta.startTimes,
                seasonalAdjustPct: progMeta.seasonalAdjustPct,
                isActive: true,
                sortOrder: sortIdx++,
              })
              .returning();
            progNameToId.set(progName, newProg.id);
          } else if (pd?.action === "update") {
            // Update only changed fields
            const patch: Record<string, unknown> = { updatedAt: new Date() };
            if (progMeta.wateringDays !== null) patch.wateringDays = progMeta.wateringDays;
            if (progMeta.startTimes !== null) patch.startTimes = progMeta.startTimes;
            patch.seasonalAdjustPct = progMeta.seasonalAdjustPct;
            await q
              .update(irrigationPrograms)
              .set(patch)
              .where(eq(irrigationPrograms.id, existingProg.id));
            progNameToId.set(progName, existingProg.id);
          } else {
            // no_change — collect id for zone→program FK only
            if (existingProg) progNameToId.set(progName, existingProg.id);
          }
        }

        // ── Zones: only create/update those that the diff marks as changed ────
        const zoneDiffByNumber = new Map(ctrlDiff.zones.map((z) => [z.zoneNumber, z]));
        const existingZoneByNumber = new Map(
          (
            await q
              .select()
              .from(irrigationProfileZones)
              .where(eq(irrigationProfileZones.controllerId, ctrlId))
          ).map((z) => [z.zoneNumber, z]),
        );

        for (const [zoneNum, row] of group.zones) {
          const programId = row.programName ? (progNameToId.get(row.programName) ?? null) : null;
          const existingZone = existingZoneByNumber.get(zoneNum);
          const zd = zoneDiffByNumber.get(zoneNum);

          if (!existingZone || zd?.action === "create") {
            const resolvedName = resolveZoneName(row.zoneName, undefined, zoneNum);
            await q
              .insert(irrigationProfileZones)
              .values({
                companyId,
                controllerId: ctrlId,
                programId,
                zoneNumber: zoneNum,
                name: resolvedName,
                zoneType: row.zoneType,
                runTimeMinutes: row.runTimeMinutes,
                zoneOrder: zoneNum,
                isActive: true,
              })
              .onConflictDoNothing();
          } else if (zd?.action === "update") {
            const resolvedName = resolveZoneName(row.zoneName, existingZone.name, zoneNum);
            await q
              .update(irrigationProfileZones)
              .set({
                name: resolvedName,
                zoneType: row.zoneType,
                runTimeMinutes: row.runTimeMinutes,
                programId,
                updatedAt: new Date(),
              })
              .where(eq(irrigationProfileZones.id, existingZone.id));
          }
          // no_change: skip write entirely
        }

        // ── Replace mode: capture pre-delete snapshot then hard-delete ────────
        // Zones are deleted before programs to avoid relying on the
        // `onDelete: "set null"` FK cascade from zones → programs.
        let removedSnapshot: {
          controller: typeof existingCtrl;
          zones: IrrigationProfileZone[];
          programs: IrrigationProgram[];
        } | undefined;
        if (isReplaceMode && hasRemovals) {
          const zoneIdsToRemove = (ctrlDiff.zonesToRemove ?? []).map((z) => z.id);
          const programIdsToRemove = (ctrlDiff.programsToRemove ?? []).map((p) => p.id);

          // Capture pre-delete state for the `removed` history key.
          // controller is the pre-delete controller row (existingCtrl is already
          // in scope from the diff phase and has not been mutated yet).
          const [removedZones, removedPrograms] = await Promise.all([
            zoneIdsToRemove.length > 0
              ? q.select().from(irrigationProfileZones).where(inArray(irrigationProfileZones.id, zoneIdsToRemove))
              : Promise.resolve([] as any[]),
            programIdsToRemove.length > 0
              ? q.select().from(irrigationPrograms).where(inArray(irrigationPrograms.id, programIdsToRemove))
              : Promise.resolve([] as any[]),
          ]);
          removedSnapshot = { controller: existingCtrl, zones: removedZones, programs: removedPrograms };

          // Delete zones first (they reference programs via programId FK)
          if (zoneIdsToRemove.length > 0) {
            await q
              .delete(irrigationProfileZones)
              .where(inArray(irrigationProfileZones.id, zoneIdsToRemove));
          }
          // Delete programs after zones are cleared
          if (programIdsToRemove.length > 0) {
            await q
              .delete(irrigationPrograms)
              .where(inArray(irrigationPrograms.id, programIdsToRemove));
          }
        }

        // ── History snapshot: only when actual work was done ─────────────────
        const [updatedCtrl] = await q
          .select()
          .from(irrigationControllers)
          .where(eq(irrigationControllers.id, ctrlId));
        const programs = await q
          .select()
          .from(irrigationPrograms)
          .where(eq(irrigationPrograms.controllerId, ctrlId))
          .orderBy(irrigationPrograms.sortOrder, irrigationPrograms.id);
        const zones = await q
          .select()
          .from(irrigationProfileZones)
          .where(eq(irrigationProfileZones.controllerId, ctrlId))
          .orderBy(irrigationProfileZones.zoneOrder, irrigationProfileZones.zoneNumber);

        if (updatedCtrl) {
          const snapshotJson: Record<string, unknown> = { controller: updatedCtrl, programs, zones };
          if (removedSnapshot) {
            snapshotJson.removed = removedSnapshot;
          }
          await q.insert(irrigationProfileHistory).values({
            companyId,
            controllerId: ctrlId,
            snapshotJson: snapshotJson as any,
            changedByUserId: actor?.id ?? null,
            changedByName: actor?.name ?? null,
            summary: `CSV import: ${ctrlName}`,
          });
        }
      }
    });

    return { mode: "commit", controllers: controllerDiffs, summary };
  }

  // ── Backflow Preventers ────────────────────────────────────────────────────

  async listBackflows(
    companyId: number | null,
    customerId: number,
    branchName?: string,
  ): Promise<IrrigationBackflow[]> {
    const conditions = [eq(irrigationBackflows.customerId, customerId)];
    if (companyId !== null) conditions.push(eq(irrigationBackflows.companyId, companyId));
    if (branchName !== undefined) conditions.push(eq(irrigationBackflows.branchName, branchName));
    return db
      .select()
      .from(irrigationBackflows)
      .where(and(...conditions))
      .orderBy(irrigationBackflows.name, irrigationBackflows.id);
  }

  async getBackflow(
    companyId: number | null,
    id: number,
  ): Promise<IrrigationBackflow | null> {
    const conditions = [eq(irrigationBackflows.id, id)];
    if (companyId !== null) conditions.push(eq(irrigationBackflows.companyId, companyId));
    const [row] = await db
      .select()
      .from(irrigationBackflows)
      .where(and(...conditions));
    return row ?? null;
  }

  async createBackflow(
    data: InsertIrrigationBackflow,
  ): Promise<IrrigationBackflow> {
    const [row] = await db
      .insert(irrigationBackflows)
      .values({
        ...data,
        lastUpdatedAt: data.lastUpdatedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .returning();
    return row;
  }

  async updateBackflow(
    companyId: number | null,
    id: number,
    patch: Partial<Omit<InsertIrrigationBackflow, "companyId" | "customerId">>,
    actor?: { id: number; name: string },
  ): Promise<IrrigationBackflow | null> {
    const conditions = [eq(irrigationBackflows.id, id)];
    if (companyId !== null) conditions.push(eq(irrigationBackflows.companyId, companyId));
    const now = new Date();
    const [updated] = await db
      .update(irrigationBackflows)
      .set({
        ...patch,
        lastUpdatedByUserId: actor?.id ?? patch.lastUpdatedByUserId ?? null,
        lastUpdatedByName: actor?.name ?? patch.lastUpdatedByName ?? null,
        lastUpdatedAt: now,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning();
    return updated ?? null;
  }

  async deleteBackflow(
    companyId: number | null,
    id: number,
  ): Promise<boolean> {
    const conditions = [eq(irrigationBackflows.id, id)];
    if (companyId !== null) conditions.push(eq(irrigationBackflows.companyId, companyId));
    const result = await db
      .delete(irrigationBackflows)
      .where(and(...conditions))
      .returning({ id: irrigationBackflows.id });
    return result.length > 0;
  }

  async logBackflowTest(
    companyId: number | null,
    id: number,
    data: {
      lastTestedDate: string;
      lastTestResult: "pass" | "fail";
      lastTestedBy?: string | null;
      nextTestDueDate?: string | null;
    },
    actor?: { id: number; name: string },
  ): Promise<IrrigationBackflow | null> {
    const conditions = [eq(irrigationBackflows.id, id)];
    if (companyId !== null) conditions.push(eq(irrigationBackflows.companyId, companyId));

    // Default nextTestDueDate = lastTestedDate + 1 year
    let nextDue = data.nextTestDueDate ?? null;
    if (!nextDue && data.lastTestedDate) {
      try {
        const d = new Date(data.lastTestedDate);
        d.setFullYear(d.getFullYear() + 1);
        nextDue = d.toISOString().slice(0, 10);
      } catch {
        // leave null if date parsing fails
      }
    }

    const now = new Date();
    const [updated] = await db
      .update(irrigationBackflows)
      .set({
        lastTestedDate: data.lastTestedDate,
        lastTestResult: data.lastTestResult,
        lastTestedBy: data.lastTestedBy ?? null,
        nextTestDueDate: nextDue,
        lastUpdatedByUserId: actor?.id ?? null,
        lastUpdatedByName: actor?.name ?? null,
        lastUpdatedAt: now,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning();
    return updated ?? null;
  }
}

// ─── Per-finding pending reason (manager review explainer) ────────────────────
// Computed server-side in getWetCheck so the manager UI can render a
// plain-language explanation without any client-side logic.
export function computeFindingPendingReason(
  f: WetCheckFinding,
  submittedAt: Date | string | null | undefined,
): string {
  if (f.convertedAt != null) {
    return "Auto-billed when tech submitted";
  }
  if (f.techDisposition === "completed_in_field") {
    if (submittedAt != null && new Date(f.createdAt) > new Date(submittedAt)) {
      return "Tech completed in field, but finding was added after submission";
    }
    if (f.partId == null && !f.noPartNeeded) {
      return "Tech completed in field, but no part was assigned at submission";
    }
  }
  // Task #1535 — custom_review findings are always manager-only
  if (f.issueType === "custom_review") {
    return "Tech flagged this for manager attention";
  }
  if (f.techDisposition === "needs_review") {
    return "Tech marked this for manager review";
  }
  return "Not yet reviewed by field tech";
}

export const storage = new DatabaseStorage();