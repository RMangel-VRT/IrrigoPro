import express, { type Express } from "express";
import type { Request, Response } from "express";
import { createServer, type Server } from "http";
import {
  storage,
  WetCheckHasInvoicedRecordsError,
  WetCheckHasBillingSheetError,
  WetCheckHasWetCheckBillingError,
  ControllerHasZonesError,
  BillingSheetInvoicedError,
  WetCheckFindingNotFoundError,
  WetCheckFindingNotEditableError,
  WetCheckFindingAlreadyConvertedError,
  LABOR_ONLY_ISSUE_TYPES,
} from "../storage";
import { classifyAndLog as _classifyAndLog } from "./route-error-helpers";
import { registerWetCheckPhotoAttachRoutes } from "./wet-check-photo-attach-route";
import { wetCheckCreateBody, normalizeBranchName, checkBranchGate } from "./wet-check-create-gate";
import { registerWorkOrderZoneRoutes } from "./work-order-zone-route";
import type { InsertInvoice, InsertCustomer } from "@workspace/db";
import { PRICING_FIELDS_TO_STRIP } from "@workspace/db";
import {
  hasCapability,
  CAN_READ_INVOICES,
  CAN_EDIT_INVOICES,
  CAN_SEND_INVOICE_EMAIL,
  CAN_MANAGE_QUICKBOOKS,
} from "@workspace/shared";
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { EmailService } from "../email-service";
import { SmsService } from "../sms-service";
import twilio from "twilio";
import { ObjectStorageService } from "../objectStorage";
import { InvoicePdfService } from "../invoice-pdf-service";
import { buildWorkDescriptionPrompt, buildExpandDescriptionPrompt, TEMPLATE_VERSION, CRITICAL_FIELDS, type WorkDescriptionInputs } from "../ai-prompt-templates";
import { makeRequireSameCompanyAsWorkOrder } from "./work-order-tenant-guard";
import { makeRequireSameCompanyAsBillingSheet } from "./billing-sheet-tenant-guard";
import {
  computeUnbilledPartition,
  resolveAsOfCutoff,
  previousCalendarMonth,
} from "../billing-unbilled-selectors";
// Task #1898 — batched billing-preview assembly (replaces the per-customer fan-out).
import { registerBillingPreviewRoute } from "./billing-preview-route";
/**
 * Phase 5b — QB Harden #5: thrown when the detected credential environment
 * does not match the server environment and STRICT_QB_ENV_CHECK is set.
 */
class QbCredentialMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QbCredentialMismatchError";
  }
}

import {
  classifyQbRefreshError,
  withQbRefreshLock,
  QB_PROACTIVE_REFRESH_BUFFER_MS,
  QB_IDLE_THRESHOLD_DAYS,
  UNRECOVERABLE_CATEGORIES,
  buildReconnectReason,
  QbRefreshError,
  runProactiveRefreshForRealm,
  startQbTokenHealthJob,
  type QbRefreshFailureCategory,
  type QbStorageAdapter,
  type QbRefreshFn,
} from "../qb-token-utils";
import { isUnroutedFinding, wcbIsEligible } from "../lib/finding-predicates";
import { computeBillingSheetTotal } from "../billing-sheet-total";
import type {
  QbTokenResponse,
  QbTokenResponseValidated,
  QbItemQueryResponse,
  QbCustomerQueryResponse,
  QbCompanyInfoQueryResponse,
  QbInvoiceCreateResponse,
} from "../types/quickbooks";

/// <reference path="./types/express.d.ts" />

// ── Legacy header-auth gating (M1) ─────────────────────────────────────────
// Production must not trust unsigned `x-user-*` identity headers/query
// params. Routes and middleware that historically read those values
// directly must go through these helpers so the gating is applied
// uniformly. In production the ONLY auth surfaces are bearer tokens and
// server-side sessions. Header-auth is dev-only and cannot be re-enabled
// via an env flag in production.
function headerUserId(req: Request): string | undefined {
  if (!isHeaderAuthAllowed()) return undefined;
  const v = req.headers['x-user-id'];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
}
function headerUserCompanyId(req: Request): string | undefined {
  if (!isHeaderAuthAllowed()) return undefined;
  const v = req.headers['x-user-company-id'];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
}
function resolveCompanyId(req: Request): string | null {
  const authed = (req as any).authenticatedUserCompanyId;
  if (authed != null) return String(authed);
  const hdr = headerUserCompanyId(req);
  return hdr ? String(hdr) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// FIELD TECH PRICING VISIBILITY - Critical Security Feature
// Field technicians must NEVER see pricing/money values anywhere in the app
// ────────────────────────────────────────────────────────────────────────────

// Fields to strip from responses for field technicians. The set is
// imported from `@workspace/db` (`PRICING_FIELDS_TO_STRIP`, derived
// from the per-table `PRICING_FIELDS_BY_TABLE` inventory) so a new
// pricing column added to the schema only needs to be appended to
// that inventory — it then automatically flows through this strip.
// See `lib/db/src/pricing-fields.ts` for the canonical list.

// Task #532 — in-place strip of pricing fields. The previous version
// rebuilt every object via `Object.entries` + spread, which doubled the
// memory footprint and CPU time for billing-sheet / work-order list
// payloads (often a few thousand objects deep across all the line items).
// The in-place walk keeps the JSON serializer's existing object identity
// and runs ~3-4x faster on the work-orders list response. Safe because
// the sanitized payload is only used as the response body — callers do
// not retain references to it beyond `res.json(...)`.
function sanitizePricingFieldsInPlace(data: any, seen?: WeakSet<object>): any {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;

  // Defensive guard against the rare object cycle (e.g. a row that
  // accidentally references its parent). WeakSet is created lazily so
  // the common acyclic case pays nothing.
  if (seen && seen.has(data)) return data;
  const tracker = seen ?? new WeakSet<object>();
  tracker.add(data);

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      sanitizePricingFieldsInPlace(data[i], tracker);
    }
    return data;
  }

  for (const key of Object.keys(data)) {
    if (PRICING_FIELDS_TO_STRIP.has(key)) {
      delete data[key];
      continue;
    }
    const value = data[key];
    if (value !== null && typeof value === 'object') {
      sanitizePricingFieldsInPlace(value, tracker);
    }
  }
  return data;
}


// Helper to check if user is field tech and strip pricing if needed.
// Task #532 — short-circuits for any non-tech role so we don't even pay
// the cost of a `headerUserRole(req)` lookup or a no-op object walk on
// the hot list endpoints (work-orders, billing-sheets, etc.).
function applyPricingVisibility(req: Request, data: any): any {
  const role = req.authenticatedUserRole;
  // Fast path: authenticated as a non-tech — nothing to strip.
  if (role && role !== 'field_tech') return data;
  // Fall back to the legacy header lookup only when we have to.
  const effectiveRole = role || headerUserRole(req);
  if (effectiveRole !== 'field_tech') return data;
  return sanitizePricingFieldsInPlace(data);
}

// Task #1889 — the A/R note strip lives in ./ar-note-visibility so the
// leak-proof tests exercise the real function rather than a copy of it.
// Imported below, alongside the invoice route modules.

// ─── Authoritative server-side pricing for billing sheet line items (Task #160) ─
// Catalog parts (items with a `partId`) must always be persisted with the
// catalog unit price — never with whatever the client sent. Manual line items
// (no `partId`) are still allowed at any price (including $0) since they go
// through the manual-part review flow.
//
// Returns either { items } with rewritten line items (unitPrice + totalPrice
// recomputed from the catalog) and `auditedZeros` describing any client-side
// price drift we detected, or { error } with a 4xx-shaped message when a
// `partId` does not resolve to a real catalog row in the user's company.
type RawBillingItem = {
  partId?: number | null;
  partName?: string;
  partDescription?: string | null;
  quantity?: number | string;
  unitPrice?: number | string;
  laborHours?: number | string;
  notes?: string | null;
  [key: string]: unknown;
};

async function resolveAuthoritativePartPricing(
  rawItems: RawBillingItem[] | undefined,
  companyId: number | null | undefined,
): Promise<{
  items?: RawBillingItem[];
  error?: { status: number; message: string };
  auditedZeros: Array<{ index: number; partId: number; partName: string; clientUnitPrice: number; catalogUnitPrice: number }>;
}> {
  const auditedZeros: Array<{ index: number; partId: number; partName: string; clientUnitPrice: number; catalogUnitPrice: number }> = [];
  if (!Array.isArray(rawItems)) {
    return { items: rawItems, auditedZeros };
  }

  const out: RawBillingItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i] ?? {};
    const partIdRaw = item.partId as unknown;
    const partId =
      partIdRaw == null || partIdRaw === '' ? null : Number(partIdRaw);

    if (!partId || !Number.isFinite(partId)) {
      // Manual / non-catalog line item — leave the client-supplied price alone.
      out.push(item);
      continue;
    }

    const part = await storage.getPart(partId);
    const lineLabel = String(item.partName ?? `line ${i + 1}`);

    if (!part) {
      return {
        error: {
          status: 400,
          message: `Catalog part with ID ${partId} (line item "${lineLabel}") was not found. Cannot save a $0 line item for an unknown catalog part.`,
        },
        auditedZeros,
      };
    }
    if (companyId != null && part.companyId !== companyId) {
      return {
        error: {
          status: 400,
          message: `Catalog part "${part.name}" (ID ${partId}, line item "${lineLabel}") does not belong to your company. Cannot save the line item.`,
        },
        auditedZeros,
      };
    }

    const catalogUnitPrice = parseFloat(String(part.price ?? 0));
    const clientUnitPrice = parseFloat(String(item.unitPrice ?? 0));
    if (catalogUnitPrice > 0 && Math.abs(clientUnitPrice - catalogUnitPrice) > 0.005) {
      auditedZeros.push({
        index: i,
        partId,
        partName: part.name,
        clientUnitPrice,
        catalogUnitPrice,
      });
    }

    const qty = parseFloat(String(item.quantity ?? 0));
    out.push({
      ...item,
      partId,
      partName: item.partName || part.name,
      partDescription: item.partDescription ?? part.description ?? null,
      unitPrice: catalogUnitPrice,
      totalPrice: (qty * catalogUnitPrice).toFixed(2),
    } as RawBillingItem);
  }

  return { items: out, auditedZeros };
}

// Logs (and is the seam for future metrics/audit-row writes) any catalog line
// item that ended up with a final unitPrice of 0 while the catalog row reports
// a non-zero price. The authoritative-pricing helper above should make this
// impossible — this guard makes a future regression visible instead of silent.
async function regressionGuardZeroCatalogPrices(
  context: 'create' | 'update' | 'work_order_conversion',
  billingSheetId: number | null,
  items: RawBillingItem[] | undefined,
): Promise<void> {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const partIdRaw = item.partId as unknown;
    const partId =
      partIdRaw == null || partIdRaw === '' ? null : Number(partIdRaw);
    if (!partId || !Number.isFinite(partId)) continue;
    const finalPrice = parseFloat(String(item.unitPrice ?? 0));
    if (finalPrice > 0) continue;
    try {
      const part = await storage.getPart(partId);
      const catalogPrice = part ? parseFloat(String(part.price ?? 0)) : 0;
      if (catalogPrice > 0) {
        console.warn(
          `[AUDIT-ZERO-PRICE-DRIFT] context=${context} billingSheetId=${billingSheetId ?? 'pending'} ` +
          `partId=${partId} partName="${part?.name ?? item.partName ?? '?'}" ` +
          `finalUnitPrice=0 catalogUnitPrice=${catalogPrice.toFixed(2)} — catalog price was lost despite authoritative-pricing helper`
        );
      }
    } catch (err) {
      // Swallow guard errors — they must never block a save.
      console.warn(`[AUDIT-ZERO-PRICE-DRIFT] guard lookup failed for partId=${partId}:`, err);
    }
  }
}
// ─── /Authoritative server-side pricing ─────────────────────────────────────────

// Roles allowed to read billing notes
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const BILLING_NOTES_READ_ROLES = new Set(['billing_manager', 'company_admin', 'super_admin']);

// Strip billingNotes from customer data for roles that should not see it
function stripBillingNotes(data: any): any {
  if (Array.isArray(data)) {
    return data.map(stripBillingNotes);
  }
  if (data && typeof data === 'object' && 'billingNotes' in data) {
    const { billingNotes, ...rest } = data;
    return rest;
  }
  return data;
}

function applyBillingNotesVisibility(req: Request, data: any): any {
  // Use only authenticated role (set by requireAuthentication middleware).
  // Raw headers are untrusted and intentionally not used here.
  const userRole = req.authenticatedUserRole;
  if (!userRole || !BILLING_NOTES_READ_ROLES.has(userRole)) {
    return stripBillingNotes(data);
  }
  return data;
}
import type { UploadedFile } from "express-fileupload";
import { 
  insertUserSchema,
  insertCustomerSchema, 
  insertPartSchema, 
  insertEstimateSchema, 
  insertEstimateItemSchema,
  // insertPropertyZoneSchema, insertZoneSchema, insertFieldWorkSessionSchema, insertFieldWorkItemSchema removed by Task #1857.
  insertWorkOrderSchema,
  insertWorkOrderItemSchema,
  insertNotificationSchema,
  insertSiteMapSchema,
  insertCompanySchema,
  insertAssemblySchema,
  insertAssemblyPartSchema,
  type InsertEstimate,
  type InsertEstimateItem,
  type BillingSheetItem,
  type InsertBillingSheet,
  type BillingSheetStatus,
  billingSheetStatusValues,
  type InsertWetCheckFinding,
  type InsertWetCheckZoneRecord,
  insertIssueTypeConfigSchema,
} from "@workspace/db";
import { clientErrors, appEventGroups, auditLog, incidents } from "@workspace/db/schema";
import { startIncidentRunner } from "../lib/rules/runner";
import {
  loadPagingConfig,
  savePagingConfig,
  toPublicConfig,
  notifyIncidentAcked,
  sendTestPage,
  type PagingConfig,
} from "../lib/rules/paging";
import { ALL_RULES as ALL_INCIDENT_RULES } from "../lib/rules";
import { z } from "zod/v4";
import { registerEstimateRoutes, estimateOwnershipMatches } from "./estimate-routes";
import { registerApproveRoutes } from "./approve-routes";
import { registerLegacyEstimateGoneRoutes } from "./legacy-estimate-gone";
import { recordAuditEvent } from "./audit-log";
import { paginate } from "./pagination";
import { registerSiteMapRoutes } from "./site-map-routes";
import { registerPartRoutes } from "./parts-routes";
import { requireApiKey } from "./external-auth";
import { registerExternalPartsRoute } from "./external-parts-route";
import { registerBillingWorkspaceRoutes, ACTIVE_WCB, PENDING_REVIEW_WCB } from "./billing-workspace-routes";
import { registerBillingWorkspaceBulkApproveRoutes } from "./billing-workspace-bulk-approve";
import { registerManagerWorkspaceRoutes, ACTIVE_WC, APPROVED_WC } from "./manager-workspace-routes";
import { registerAssemblyRoutes } from "./assembly-routes";
import { registerCustomerRoutes } from "./customer-routes";
import { registerBudgetRoutes } from "./budget-routes";
import { registerFinancialPulseRoutes } from "./financial-pulse";
import { registerInvoiceMergeRoutes } from "./invoice-merge-routes";
import {
  registerInvoiceSyncQuickbooksRoutes,
  InvoiceSyncError,
} from "./invoice-sync-quickbooks-route";
import {
  buildAndPostQbInvoice as _buildAndPostQbInvoice,
  updateQbInvoiceInPlace as _updateQbInvoiceInPlace,
  fetchQbSyncToken as _fetchQbSyncToken,
  lookupQbInvoiceByDocNumber as _lookupQbInvoiceByDocNumber,
} from "./qb-invoice-ops";
import { registerInvoiceMarkSentRoutes } from "./invoice-mark-sent-routes";
import { registerInvoiceListRoutes } from "./invoice-list-routes";
import {
  createReminderCore,
  registerInvoiceReminderRoutes,
} from "./invoice-reminder-routes";
import { registerInvoiceReminderBatchRoutes } from "./invoice-reminder-batch-routes";
import { registerInvoiceArNoteRoutes } from "./invoice-ar-note-routes";
import { applyArNoteVisibility } from "./ar-note-visibility";
import { registerInvoiceCorrectionRoutes } from "./invoice-correction-routes";
import { registerInvoiceEditabilityRoutes } from "./invoice-editability-routes";
// Task #1890 — computeEffectiveDueDate / isInvoiceOverdue were imported here
// for the inline invoice list handler. That handler now lives in
// ./invoice-list-routes and imports them from @workspace/shared directly.
import { registerQbPaymentSyncRoutes } from "./qb-payment-sync";
import { registerAdminMigrationsRoutes } from "./admin-migrations-routes";
import { registerWcLaborBackfillRoutes } from "./admin-wc-labor-backfill-routes";
import { registerInspectionZoneBackfillRoutes } from "./admin-inspection-zone-backfill-routes";
import { registerCleanupInvoice71256Routes } from "./cleanup-invoice-71256";
import { registerWetCheckReconciliationRoutes } from "./wet-check-reconciliation-routes";
import { registerIrrigationProfileRoutes } from "./irrigation-profile-routes";
import { findingPatchBody, buildFindingPatchFromBody } from "./wet-check-finding-patch";
import { buildWetCheckGrid } from "../wet-check-grid";
import { scrubEvent, setScrubCustomerNames } from "../lib/scrubEvent";
import { setTelemetrySink, withTelemetry, type TelemetryEvent } from "../lib/withTelemetry";
import { assertCompanyId } from "../lib/migrations/assert-company-id";
import {
  companyThrottleMiddleware,
  loadCompanyThrottles,
  setCompanyThrottle,
  clearCompanyThrottle,
  listActiveThrottles,
  checkAuthenticatedThrottle,
} from "../lib/company-throttle";
import {
  mintImpersonationToken,
  verifyImpersonationToken,
  revokeImpersonationToken,
} from "../lib/impersonation-token";
import {
  INTEGRATION_CATALOG,
  INTEGRATION_CATALOG_BY_SERVICE,
  getIntegrationMeta,
} from "../lib/integration-catalog";
import { logger } from "../lib/logger";
import { money } from "../lib/money";
import { coerceLatLngStrings } from "../lib/coerce-lat-lng";
import { buildWoLineDescription, buildBsLineDescription, buildWcbLineDescription } from "../lib/qb-line-description";
import { seedIssueTypeConfigsForActiveCompanies } from "../seed-issue-type-configs";

// Production-ready middleware to check if user has company admin permissions for site map operations
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const requireCompanyAdminAccess = (req: any, res: any, next: any) => {
  const userRole = req.authenticatedUserRole;

  if (!userRole) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  if (userRole !== 'company_admin') {
    res.status(403).json({
      message: "Access denied. Only company administrators can perform this action.",
    });
    return;
  }

  next();
};

// Middleware to allow company admins AND billing managers to edit customer records
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const requireCustomerEditAccess = (req: any, res: any, next: any) => {
  const userRole = req.authenticatedUserRole;

  if (!userRole) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  if (userRole !== 'company_admin' && userRole !== 'super_admin' && userRole !== 'billing_manager') {
    res.status(403).json({ message: "Access denied. Customer editing is restricted to administrators and billing managers." });
    return;
  }

  next();
};

// Middleware to check if user can edit a customer's property boundary (GIS).
//
// Authorization policy (intentional divergence from `requireCustomerEditAccess`):
//   - allowed: company_admin, super_admin, irrigation_manager
//   - NOT allowed: billing_manager (boundary management is a field/operations
//     responsibility, not a billing one — billing managers can still view
//     boundaries via the standard customer-read paths)
// The client-side allowlist in
// `artifacts/irrigopro/src/components/customers/property-boundary.tsx`
// (`EDIT_ROLES`) MUST stay in sync with this set.
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const requireBoundaryEditAccess = (req: any, res: any, next: any) => {
  const userRole = req.authenticatedUserRole;

  if (!userRole) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  const allowed = new Set([
    'company_admin',
    'super_admin',
    'irrigation_manager',
  ]);
  if (!allowed.has(userRole)) {
    res.status(403).json({
      message: "Access denied. Property boundary editing is restricted to administrators and irrigation managers.",
    });
    return;
  }

  next();
};

// Middleware to check if user can edit/delete work orders and billing sheets
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const requireWorkOrderBillingAccess = (req: any, res: any, next: any) => {
  const userRole = req.authenticatedUserRole;

  if (userRole !== 'company_admin' && userRole !== 'billing_manager' && userRole !== 'irrigation_manager') {
    res.status(403).json({ 
      message: "Access denied. Only company administrators, billing managers, and irrigation managers can edit or delete work orders and billing sheets." 
    });
    return;
  }
  
  next();
};

// More granular middleware for work order updates that allows field techs to start their own work orders
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const requireWorkOrderUpdateAccess = async (req: any, res: any, next: any) => {
  const userRole = req.authenticatedUserRole;
  const userId = req.authenticatedUserId;
  const workOrderId = parseInt(req.params.id);
  const updateData = req.body;
  
  // Company admins, super admins, billing managers, and irrigation managers have full access
  if (userRole === 'company_admin' || userRole === 'super_admin' || userRole === 'billing_manager' || userRole === 'irrigation_manager') {
    return next();
  }
  
  // Field techs can only start work orders assigned to them
  if (userRole === 'field_tech') {
    // Validate that we have user ID
    if (!userId) {
      res.status(401).json({ 
        message: "Authentication required - user ID not found." 
      });
      return;
    }
    const fieldTechCompanyId: number | null = (req as any).authenticatedUserCompanyId ?? null;

    // Check if this is just starting a work order (changing status to in_progress)
    if (updateData.status === 'in_progress' && Object.keys(updateData).length <= 2) {
      try {
        // Check if the work order is assigned to this field tech
        const workOrder = await storage.getWorkOrder(workOrderId, fieldTechCompanyId);
        const userIdNum = parseInt(userId as string);
        
        if (workOrder && workOrder.assignedTechnicianId === userIdNum) {
          return next();
        }
        
      } catch (error) {
        console.error('Error checking work order assignment:', error);
      }
    }

    // Field techs may also patch ONLY the photos array on a work order assigned to them.
    // Task #191: photos may be added even after the ticket has been moved to billing
    // (status === 'approved_passed_to_billing', 'billed', or invoiceId is set) so techs
    // can backfill missing photos after the fact. Cancelled tickets remain locked.
    const updateKeys = updateData && typeof updateData === 'object' ? Object.keys(updateData) : [];
    const isPhotosOnlyEdit = updateKeys.length === 1 && updateKeys[0] === 'photos' && Array.isArray(updateData.photos);
    if (isPhotosOnlyEdit) {
      try {
        const workOrder = await storage.getWorkOrder(workOrderId, fieldTechCompanyId);
        const userIdNum = parseInt(userId as string);
        if (workOrder && workOrder.assignedTechnicianId === userIdNum && workOrder.status !== 'cancelled') {
          return next();
        }
      } catch (error) {
        console.error('Error checking work order photo edit access:', error);
      }
    }

    // Field techs may also patch ONLY the work-location pin fields on a work order
    // assigned to them ("I'm here" on the completion screen). Cancelled tickets remain locked.
    const PIN_KEYS = new Set(['workLocationLat', 'workLocationLng', 'workLocationAddress']);
    const isPinOnlyEdit = updateKeys.length > 0 && updateKeys.every(k => PIN_KEYS.has(k));
    if (isPinOnlyEdit) {
      try {
        const workOrder = await storage.getWorkOrder(workOrderId, fieldTechCompanyId);
        const userIdNum = parseInt(userId as string);
        if (!workOrder || workOrder.assignedTechnicianId !== userIdNum || workOrder.status === 'cancelled') {
          res.status(403).json({
            message: "You can only update the pin on a work order assigned to you.",
          });
          return;
        }
        return next();
      } catch (error) {
        console.error('Error checking work order pin edit access:', error);
      }
    }
  }
  
  res.status(403).json({ 
    message: "Field technicians can only start a work order, update its photos, or move its pin on tickets assigned to them." 
  });
  return;
};

// Tenant guard for single-ID work-order routes — extracted to its own module
// so behavioral tests can import and exercise the real implementation without
// pulling in the full registerRoutes monolith. See work-order-tenant-guard.ts.
const requireSameCompanyAsWorkOrder = makeRequireSameCompanyAsWorkOrder(storage);

// Tenant guard for single-ID billing-sheet routes — same pattern as the
// work-order guard above. Until Slice 4 adds billing_sheets.companyId, the
// row's tenant is derived via customerId → customers.companyId.
// See billing-sheet-tenant-guard.ts.
const requireSameCompanyAsBillingSheet = makeRequireSameCompanyAsBillingSheet(storage);

// More granular middleware for billing sheet updates that allows field techs to submit for approval
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const requireBillingSheetUpdateAccess = async (req: any, res: any, next: any) => {
  const userRole = req.authenticatedUserRole;
  const userId = req.authenticatedUserId;
  const updateData = req.body;

  // Managers and super_admin have full access
  if (userRole === 'company_admin' || userRole === 'super_admin' || userRole === 'billing_manager' || userRole === 'irrigation_manager') {
    return next();
  }

  // Field techs can only submit their own billing sheet for manager review,
  // OR add/remove photos on their own billing sheet (photos-only PATCH).
  if (userRole === 'field_tech') {
    const keys = updateData && typeof updateData === 'object' ? Object.keys(updateData) : [];
    const isSubmit = keys.length === 1 && (updateData.status === 'submitted' || updateData.status === 'pending_manager_review');
    const isPhotosOnlyEdit = keys.length === 1 && keys[0] === 'photos' && Array.isArray(updateData.photos);

    if (!isSubmit && !isPhotosOnlyEdit) {
      res.status(403).json({
        message: "Access denied. Field technicians can only submit billing sheets for approval or update photos on their own sheets."
      });
      return;
    }

    if (!userId) {
      res.status(401).json({ message: "Authentication required - user ID not found." });
      return;
    }

    try {
      const billingSheetId = parseInt(req.params.id);
      const bsTechCompanyId: number | null = (req as any).authenticatedUserCompanyId ?? null;
      const billingSheet = await storage.getBillingSheetById(billingSheetId, bsTechCompanyId);
      const userIdNum = parseInt(userId as string);

      if (billingSheet && billingSheet.technicianId === userIdNum) {
        // Task #191: photos-only edits are allowed even when the billing sheet
        // has been moved to billing (status === 'billed' or invoiceId is set),
        // so techs can backfill missing photos. Other photos-only restrictions
        // (ownership above) and the non-photo lock paths stay in place.
        return next();
      }
    } catch (error) {
      console.error('Error checking billing sheet ownership:', error);
    }

    res.status(403).json({
      message: "Access denied. Field technicians can only act on their own billing sheets."
    });
    return;
  }

  res.status(403).json({
    message: "Access denied. Only company administrators, billing managers, and irrigation managers can edit billing sheets."
  });
  return;
};

// Authentication middleware for notifications - ensures users can only access their own notifications
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const requireNotificationAccess = async (req: any, res: any, next: any) => {
  try {
    // Get authenticated user ID - prefer session-based auth
    let authenticatedUserId = req.authenticatedUserId || headerUserId(req);
    
    // If headers not available, try to get from session (production approach)
    if (!authenticatedUserId && req.session && req.session.userId) {
      authenticatedUserId = req.session.userId;
    }
    
    // Get requested user ID from URL params
    const requestedUserId = req.params.userId;
    
    // Validate that we have authentication data
    if (!authenticatedUserId) {
      console.log(`Authentication failed for notification access - no user ID found for request to user ${requestedUserId}`);
      res.status(401).json({ 
        message: "Authentication required" 
      });
      return;
    }
    
    // Parse user IDs safely
    const authUserId = parseInt(authenticatedUserId);
    const reqUserId = parseInt(requestedUserId);
    
    // Validate that both IDs are valid numbers
    if (isNaN(authUserId) || isNaN(reqUserId)) {
      console.log(`Invalid user ID format - auth: ${authenticatedUserId}, requested: ${requestedUserId}`);
      res.status(400).json({ 
        message: "Invalid user ID format" 
      });
      return;
    }
    
    // Validate that the authenticated user matches the requested user
    if (authUserId !== reqUserId) {
      console.log(`Access denied - user ${authUserId} tried to access notifications for user ${reqUserId}`);
      res.status(403).json({ 
        message: "Access denied. You can only access your own notifications." 
      });
      return;
    }
    
    // Store authenticated user ID for use in route handler
    req.authenticatedUserId = authUserId;
    next();
  } catch (error) {
    console.error('Notification authentication error:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      requestedUserId: req.params.userId,
      hasSession: !!req.session,
      sessionUserId: req.session?.userId,
      headers: {
        'x-user-id': headerUserId(req),
        'x-user-role': headerUserRole(req)
      }
    });
    res.status(500).json({ 
      message: "Authentication error" 
    });
    return;
  }
};

// General authentication middleware that validates user identity and role
const requireAuthentication = async (req: any, res: any, next: any) => {
  try {
    let userId: any;
    let userRole: any;
    let userCompanyId: any;

    // Task #554 — server-bound impersonation. The frontend obtains a
    // signed token from `/impersonate/start` and sends it via the
    // `x-impersonation-token` header. We verify the HMAC, then swap the
    // effective identity to the target user while remembering the
    // super-admin actor on the request so audit emitters can record
    // the bracket.
    const impHeader = req.headers['x-impersonation-token'];
    const impToken = typeof impHeader === 'string' ? impHeader : Array.isArray(impHeader) ? impHeader[0] : undefined;
    if (impToken) {
      const claims = verifyImpersonationToken(impToken);
      if (!claims) {
        res.status(401).json({ message: "Impersonation session expired — please return to super admin and start over." });
        return;
      }
      const actor = await storage.getUser(claims.actorUserId);
      if (!actor || actor.role !== 'super_admin' || !actor.isActive) {
        res.status(401).json({ message: "Impersonation actor no longer authorized." });
        return;
      }
      const target = await storage.getUser(claims.targetUserId);
      if (!target || !target.isActive || target.role === 'super_admin') {
        res.status(401).json({ message: "Impersonation target unavailable." });
        return;
      }
      req.authenticatedUserId = target.id;
      req.authenticatedUserRole = target.role;
      req.authenticatedUserCompanyId = target.companyId ?? null;
      req.impersonatorUserId = actor.id;
      req.impersonationToken = impToken;
      // Throttle still applies to impersonated traffic so a stuck
      // automation can't bypass the cap by impersonating.
      if (!checkAuthenticatedThrottle(req, res)) return;
      next();
      return;
    }

    // Step 1 — bearer-token path (mobile clients). Checked FIRST so an
    // attacker cannot strip the bearer header and fall through to the
    // legacy header bypass. If a bearer header IS present but invalid
    // or expired, fail closed with 401 instead of falling through.
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      const rawToken = authHeader.slice(7).trim();
      if (!rawToken) {
        res.status(401).json({ message: "Invalid bearer token" });
        return;
      }
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const tokenRow = await storage.getActiveMobileTokenByHash(tokenHash);
      // Belt-and-suspenders: even if the storage layer somehow returned a
      // revoked or expired row, refuse it here.
      if (!tokenRow || tokenRow.revokedAt != null || tokenRow.expiresAt.getTime() <= Date.now()) {
        res.status(401).json({ message: "Invalid or expired token" });
        return;
      }
      const user = await storage.getUser(tokenRow.userId);
      if (!user || !user.isActive) {
        res.status(401).json({ message: "Invalid or expired token" });
        return;
      }
      req.authenticatedUserId = user.id;
      req.authenticatedUserRole = user.role;
      req.authenticatedUserCompanyId = user.companyId ?? null;
      if (!checkAuthenticatedThrottle(req, res)) return;
      next();
      return;
    }

    // Production session-based authentication
    if (req.session && req.session.userId) {
      try {
        const user = await storage.getUser(parseInt(String(req.session.userId)));
        if (user) {
          userId = req.session.userId;
          userRole = user.role;
          userCompanyId = user.companyId;
        }
      } catch (dbError) {
        // Continue to fallback on database error
      }
    }

    // Legacy header-based auth path (unsigned x-user-* headers). Dev-only.
    // In production the only auth surfaces are bearer tokens and server-side
    // sessions; this block is entirely bypassed so unsigned headers can never
    // be used to forge an identity in production regardless of env flags.
    const headerAuthAllowed = process.env.NODE_ENV !== 'production';
    if (!userId && headerAuthAllowed) {
      userId = headerUserId(req);
      userRole = headerUserRole(req);
      userCompanyId = headerUserCompanyId(req);
    }

    // Query parameter fallback (for PDF viewing in new tabs, dev only).
    // Unsigned identity in the URL is exactly as dangerous as in a header;
    // disabled in production unconditionally.
    if (!userId && headerAuthAllowed && req.query['x-user-id']) {
      userId = req.query['x-user-id'];
      userRole = req.query['x-user-role'];
      userCompanyId = req.query['x-user-company-id'];
    }
    
    // Authentication required
    if (!userId) {
      res.status(401).json({ 
        message: "Authentication required" 
      });
      return;
    }
    
    if (!userId || !userRole) {
      console.log(`Authentication failed - missing data:`, {
        hasUserId: !!userId,
        hasUserRole: !!userRole,
        hasSession: !!req.session,
        sessionUserId: req.session?.userId
      });
      res.status(401).json({ 
        message: "Authentication required" 
      });
      return;
    }
    
    // Validate user ID is a number
    const parsedUserId = parseInt(String(userId));
    if (isNaN(parsedUserId)) {
      console.log(`Invalid user ID format: ${userId}`);
      res.status(400).json({ 
        message: "Invalid user ID format" 
      });
      return;
    }
    
    // Store authenticated user data for use in route handlers
    req.authenticatedUserId = parsedUserId;
    req.authenticatedUserRole = userRole;
    req.authenticatedUserCompanyId = userCompanyId ? parseInt(userCompanyId.toString()) : null;

    if (!checkAuthenticatedThrottle(req, res)) return;
    next();
  } catch (error) {
    console.error('Authentication error:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      hasSession: !!req.session,
      sessionUserId: req.session?.userId,
      headers: {
        'x-user-id': headerUserId(req),
        'x-user-role': headerUserRole(req)
      }
    });
    res.status(500).json({ 
      message: "Authentication error" 
    });
    return;
  }
};

// Middleware to check if user has permission to view site maps (company admin and irrigation manager)
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const requireSiteMapViewAccess = (req: any, res: any, next: any) => {
  const userRole = req.authenticatedUserRole;

  if (!userRole) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  if (userRole !== 'company_admin' && userRole !== 'irrigation_manager' && userRole !== 'field_tech') {
    res.status(403).json({
      message: "Access denied. Site map viewing is restricted to company administrators, irrigation managers, and field technicians only.",
    });
    return;
  }

  next();
};

// In-memory OAuth state store (replaces session-based storage — app uses localStorage auth, not server sessions)
// Maps state token -> { expiry timestamp, companyId } (10 min TTL)
// Task #744: USE_DB_OAUTH_STATE=1 routes new flows through Postgres instead; the Map stays for the in-memory path.
const oauthStateStore = new Map<string, { expiry: number; companyId: string | null }>();
setInterval(() => {
  // Prune in-memory entries (both paths — harmless when the Map is idle)
  const now = Date.now();
  for (const [state, entry] of Array.from(oauthStateStore.entries())) {
    if (now > entry.expiry) oauthStateStore.delete(state);
  }
  // Prune Postgres entries unconditionally — cheap and correct regardless of active flag
  void storage.pruneExpiredOauthStates().catch(() => {/* non-critical sweep */});
}, 60_000);


// Task #1886 — capability-backed guards live in role-guards.ts so tests can
// mount the real middleware instead of re-implementing it.
import {
  isHeaderAuthAllowed,
  headerUserRole,
  requireInvoiceRead,
  requireInvoiceWrite,
  requireInvoiceSend,
  requireArNotesAccess,
  requireQuickBooksAccess,
} from "./role-guards";
import { db } from "../db";
import { 
  customers, estimates, workOrders, estimateItems, parts, billingSheets, billingSheetItems, 
  users, invoices, invoiceItems, notifications,
  companies, siteMaps, controllers, irrigationZones, partUsage, utilityMarkers, invoicePdfs,
  wetCheckPhotos, wetChecks, wetCheckFindings, wetCheckBillings,
  workOrderZonePhotos,
  irrigationControllers,
} from "@workspace/db";
import { eq, desc, and, or, gte, lte, like, isNull, asc, sql, inArray, type SQL } from "drizzle-orm";

export async function registerRoutes(app: Express): Promise<Server> {

  // Task #554 — the per-tenant emergency throttle is now enforced from
  // inside `requireAuthentication` so the company id is the
  // server-verified `req.authenticatedUserCompanyId` (bearer / session /
  // opt-in header path), never the raw `x-user-company-id` header. The
  // legacy global mount is intentionally a no-op shim — see
  // `companyThrottleMiddleware` in `lib/company-throttle.ts`.
  void companyThrottleMiddleware;

  // Task #552 — capture http.5xx and http.slow as app_events. Mounted
  // first so it wraps every /api/* route registered below; the
  // `insertAppEvent` reference is hoisted within the enclosing
  // function scope and resolves at res.finish time.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    if (req.path.startsWith("/api/admin/app-health")) return next();
    if (req.path === "/api/health") return next();
    if (req.path === "/api/client-errors") return next();
    const start = Date.now();
    res.on("finish", () => {
      try {
        const dur = Date.now() - start;
        const status = res.statusCode;
        const isError = status >= 500;
        const isSlow = !isError && dur > 2000;
        if (!isError && !isSlow) return;
        const cleanPath = req.path.replace(/\/\d+(?=\/|$)/g, "/:id");
        const name = isError ? `http.${status}` : `http.slow`;
        void insertAppEvent({
          name,
          message: `${req.method} ${cleanPath} → ${status} in ${dur}ms`,
          source: "api",
          type: "metric",
          severity: isError ? (status >= 500 ? "error" : "warning") : "warning",
          component: cleanPath,
          context: {
            method: req.method,
            path: cleanPath,
            status_code: status,
            duration_ms: dur,
          },
        });
      } catch { /* never block */ }
    });
    next();
  });

  // ── Task #550 (Phase 2) — App Health access-log ring buffer ───────────
  // Lightweight in-memory ring of API request samples used to compute
  // p95 latency, request counts, and error rates for the App Health
  // hero / Overview tab. We don't have a separate access-log table yet,
  // and we don't want to add row-per-request DB writes just for the
  // health page, so a process-local ring is the right granularity here.
  // Server restarts reset the buffer — that's acceptable; the page
  // backfills the long-window error counts from `client_errors`.
  type AccessLogEntry = { ts: number; durMs: number; status: number; path: string };
  const ACCESS_LOG_SIZE = 5000;
  const accessLog: AccessLogEntry[] = new Array(ACCESS_LOG_SIZE);
  let accessLogHead = 0;
  let accessLogCount = 0;
  function recordAccessLogEntry(e: AccessLogEntry): void {
    accessLog[accessLogHead] = e;
    accessLogHead = (accessLogHead + 1) % ACCESS_LOG_SIZE;
    if (accessLogCount < ACCESS_LOG_SIZE) accessLogCount++;
  }
  function snapshotAccessLog(): AccessLogEntry[] {
    const out: AccessLogEntry[] = [];
    for (let i = 0; i < accessLogCount; i++) {
      const idx = (accessLogHead - 1 - i + ACCESS_LOG_SIZE) % ACCESS_LOG_SIZE;
      const e = accessLog[idx];
      if (e) out.push(e);
    }
    return out;
  }
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    // Don't record the App Health endpoints themselves — they'd skew the
    // numbers because they run on the same 15s polling cadence and would
    // dominate the request volume for low-traffic tenants.
    if (req.path.startsWith("/api/admin/app-health")) return next();
    if (req.path === "/api/health") return next();
    const start = Date.now();
    res.on("finish", () => {
      try {
        recordAccessLogEntry({
          ts: start,
          durMs: Date.now() - start,
          status: res.statusCode,
          path: req.path,
        });
      } catch { /* never block */ }
    });
    next();
  });

  // Tiny heartbeat used by the offline service worker / sync engine to
  // distinguish "no signal" from "online but slow". Intentionally
  // unauthenticated and dependency-free so a service worker fetch from
  // a freshly-launched offline-then-online tab can confirm connectivity
  // without paying session/DB cost. Slice 4A — task #297.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // ── Task #550 (Phase 2) — Audit log ingestion helper ──────────────────
  // Best-effort: never throw out of the helper; an audit-log write
  // failure must not fail the originating request.

  // Task #641 — lifecycle transition audit helper. Thin wrapper over
  // `recordAuditEvent` that standardizes the actor extraction, the
  // `details.before` / `details.after` payload, and the synthetic
  // "customer" actor used for customer-token transitions on estimates.
  // Best-effort: never throws and never fails the originating request.
  type LifecycleAuditOpts = {
    resource: "estimate" | "wet_check" | "work_order" | "wet_check_billing" | "billing_sheet";
    action: string;
    targetId: number | string;
    before?: unknown;
    after?: unknown;
    summary?: string | null;
    note?: string | null;
    companyId?: number | null;
    // When set, the audit row is attributed to the synthetic "customer"
    // actor (no user id / role) — used by /approve-via-token and
    // /reject-via-token paths.
    customer?: { email?: string | null; name?: string | null; token?: string | null } | null;
    extra?: Record<string, unknown>;
  };
  async function recordLifecycleAudit(
    req: any,
    opts: LifecycleAuditOpts,
    txOpts: { tx?: any; strict?: boolean } = {},
  ): Promise<void> {
    const targetType = opts.resource;
    const isCustomer = !!opts.customer;
    const actorUserId = isCustomer
      ? null
      : ((req?.authenticatedUserId as number | undefined) ?? null);
    const actorRole = isCustomer
      ? "customer"
      : ((req?.authenticatedUserRole as string | undefined) ?? null);
    const actorCompanyId = opts.companyId
      ?? (isCustomer
        ? null
        : ((req?.authenticatedUserCompanyId as number | undefined) ?? null));
    // Resolve a human-readable actor label so the Activity tab shows
    // "Jane Smith" instead of "User #42". Looked up once per emission;
    // failures are non-fatal and fall back to the user id.
    let actorLabel: string | null = null;
    if (isCustomer) {
      actorLabel = opts.customer?.email
        ? `customer:${opts.customer.email}`
        : (opts.customer?.name ? `customer:${opts.customer.name}` : "customer");
    } else if (actorUserId != null) {
      try {
        const u = await storage.getUser(actorUserId);
        if (u?.name) actorLabel = u.name;
        else if (u?.email) actorLabel = u.email;
        else actorLabel = `user:${actorUserId}`;
      } catch {
        actorLabel = `user:${actorUserId}`;
      }
    }
    const details: Record<string, unknown> = {
      ...(opts.extra ?? {}),
    };
    if (opts.before !== undefined) details.before = opts.before;
    if (opts.after !== undefined) details.after = opts.after;
    if (opts.note != null && String(opts.note).trim() !== "")
      details.note = String(opts.note);
    if (isCustomer && opts.customer?.token)
      details.customerToken = opts.customer.token;
    await recordAuditEvent(req ?? null, {
      actorUserId,
      actorLabel,
      actorRole,
      actorCompanyId,
      actionType: "data",
      action: opts.action,
      severity: "info",
      targetType,
      targetId: String(opts.targetId),
      summary: opts.summary ?? null,
      details,
    }, txOpts);
  }

  // Task #641 — per-resource activity feed. Returns the audit_log rows
  // we've written for a single estimate / wet check / work order so the
  // detail modals can render an "Activity" tab. Company-scoped: the
  // resource is loaded with the normal ownership guard, and then the
  // rows are filtered by `actor_company_id = <resource company>` (plus
  // rows with a null actor_company_id, which is how customer-token
  // transitions are attributed). super_admin sees everything.
  async function fetchActivityForTarget(
    targetType: "estimate" | "wet_check" | "work_order" | "wet_check_billing" | "billing_sheet",
    targetId: number,
    companyId: number | null,
    isSuperAdmin: boolean,
  ) {
    const filters: SQL[] = [
      sql`target_type = ${targetType}`,
      sql`target_id = ${String(targetId)}`,
    ];
    if (!isSuperAdmin && companyId != null) {
      filters.push(sql`(actor_company_id = ${companyId} OR actor_company_id IS NULL)`);
    }
    const where = filters.reduce<SQL>(
      (acc, frag, i) => (i === 0 ? frag : sql`${acc} AND ${frag}`),
      sql``,
    );
    const result = await db.execute<{
      id: number;
      occurredAt: string;
      actorUserId: number | null;
      actorLabel: string | null;
      actorRole: string | null;
      action: string;
      summary: string | null;
      details: unknown;
    }>(sql`
      SELECT id, occurred_at AS "occurredAt", actor_user_id AS "actorUserId",
             actor_label AS "actorLabel", actor_role AS "actorRole",
             action, summary, details
      FROM audit_log
      WHERE ${where}
      ORDER BY occurred_at DESC
      LIMIT 200
    `);
    return result.rows ?? [];
  }

  app.get("/api/estimates/:id/activity", requireAuthentication, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ message: "Invalid estimate ID" });
        return;
      }
      const existing = await storage.getEstimate(id);
      if (!existing) { res.status(404).json({ message: "Estimate not found" }); return; }
      if (!estimateOwnershipMatches(req, existing.companyId)) {
        res.status(404).json({ message: "Estimate not found" });
        return;
      }
      const isSuper = req.authenticatedUserRole === "super_admin";
      const rows = await fetchActivityForTarget("estimate", id, existing.companyId ?? null, isSuper);
      res.json({ events: rows });
    } catch (error) {
      console.error("[activity] estimate", error);
      res.status(500).json({ message: "Failed to load activity" });
    }
  });

  app.get("/api/wet-checks/:id/activity", requireAuthentication, async (req: any, res) => {
    try {
      const cid = requireCompanyId(req, res); if (!cid) return;
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ message: "Invalid wet check ID" });
        return;
      }
      const wc = await storage.getWetCheck(id, cid);
      if (!wc) { res.status(404).json({ message: "Not found" }); return; }
      const isSuper = req.authenticatedUserRole === "super_admin";
      const rows = await fetchActivityForTarget("wet_check", id, cid, isSuper);
      res.json({ events: rows });
    } catch (error) {
      console.error("[activity] wet_check", error);
      res.status(500).json({ message: "Failed to load activity" });
    }
  });

  app.get("/api/work-orders/:id/activity", requireAuthentication, requireSameCompanyAsWorkOrder, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }
      const callerCompanyIdActivity = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const wo = await storage.getWorkOrder(id, callerCompanyIdActivity);
      if (!wo) { res.status(404).json({ message: "Work order not found" }); return; }
      // Resolve the work order's company via its customer record so we can
      // apply the same per-company isolation as the estimate / wet check
      // activity endpoints.
      let woCompanyId: number | null = null;
      if (wo.customerId) {
        const customer = await storage.getCustomer(wo.customerId);
        woCompanyId = customer?.companyId ?? null;
      }
      const role = req.authenticatedUserRole as string | undefined;
      const isSuper = role === "super_admin";
      if (!isSuper) {
        const userCid = req.authenticatedUserCompanyId as number | undefined;
        if (!userCid || !woCompanyId || Number(userCid) !== Number(woCompanyId)) {
          res.status(404).json({ message: "Work order not found" });
          return;
        }
      }
      const rows = await fetchActivityForTarget("work_order", id, woCompanyId, isSuper);
      res.json({ events: rows });
    } catch (error) {
      console.error("[activity] work_order", error);
      res.status(500).json({ message: "Failed to load activity" });
    }
  });

  // Task #1097 — WCB activity feed. Returns audit_log rows for a single
  // WCB so the Command Center drawer and WCB view modal can display a
  // who/when/before/after history.
  // Tenant-guard: WCB is loaded with the same companyId isolation as the
  // other activity endpoints; super_admin sees all (callerCid = null).
  app.get("/api/wet-check-billings/:id/activity", requireAuthentication, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ message: "Invalid WCB ID" });
        return;
      }
      const isSuper = req.authenticatedUserRole === "super_admin";
      const callerCid: number | null = isSuper ? null : (req.authenticatedUserCompanyId ?? null);
      // Non-super users must have a company context — reject otherwise so we
      // never accidentally serve cross-company data to an unscoped caller.
      if (!isSuper && callerCid == null) {
        res.status(403).json({ message: "Company context required" });
        return;
      }
      const wcb = await storage.getWetCheckBillingById(id, callerCid);
      if (!wcb) { res.status(404).json({ message: "Not found" }); return; }
      // Resolve the WCB's tenant company via its wet check for the
      // activity filter (actor_company_id = wc.companyId).
      const wcResult = await db.execute<{ companyId: number | null }>(
        sql`SELECT company_id AS "companyId" FROM wet_checks WHERE id = ${wcb.wetCheckId} LIMIT 1`,
      );
      const wcCompanyId: number | null = wcResult.rows[0]?.companyId ?? null;
      if (!isSuper && wcCompanyId !== callerCid) {
        res.status(404).json({ message: "Not found" });
        return;
      }
      const rows = await fetchActivityForTarget("wet_check_billing", id, wcCompanyId, isSuper);
      res.json({ events: rows });
    } catch (error) {
      console.error("[activity] wet_check_billing", error);
      res.status(500).json({ message: "Failed to load activity" });
    }
  });

  // Slice 4A feature flag exposure. The offline service worker is gated
  // by the build-time VITE_OFFLINE_SERVICE_WORKER env var on the client,
  // but a server-side reflection is provided so future slices (4B mutation
  // queue) can read the same flag without a rebuild. Defaults to enabled.
  app.get("/api/config/offline-service-worker", (_req, res) => {
    const raw = process.env.OFFLINE_SERVICE_WORKER;
    const enabled = raw === undefined ? true : raw !== "false" && raw !== "0";
    res.json({ enabled });
  });

  // Task #544 — fire-and-forget client-side error trail. AppErrorBoundary
  // POSTs whatever it caught (name, message, stack, componentStack, url,
  // userAgent, buildHash, userId, role) so the next "white screen" report
  // doesn't depend on a tech screenshotting the console.
  // Task #545 — also persist to `client_errors` so the admin/super-admin
  // report page can group recent crashes by buildHash + name without
  // grepping log files. Cleanup of rows older than 30 days happens here
  // on a 1-in-50 sample so we don't pay the cost on every request.
  // Always returns 204 so a logging or DB failure never surfaces as a
  // follow-on error in the boundary.
  app.post("/api/client-errors", express.json({ limit: "64kb" }), async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const pick = (k: string, max = 4000): string => {
        const v = body[k];
        return typeof v === "string" ? v.slice(0, max) : "";
      };
      // Trusted user attribution — Task #552 spec compliance.
      // The client-supplied body.userId / body.companyId are NOT
      // trusted (a malicious or buggy client could spoof them and
      // poison per-user metrics, status derivation, and the top-user
      // breakdown). Order of trust:
      //   1. req.session.userId (server-side session — fully trusted),
      //      with a single users-row lookup to derive companyId.
      //   2. headerUserId / headerUserCompanyId (only when
      //      ALLOW_HEADER_AUTH=1 / non-prod — gated by isHeaderAuthAllowed).
      //   3. body.userId / body.companyId (only when nothing else is
      //      available — typically a logged-out crash from the login
      //      page; treated as a hint, not authoritative).
      let userIdNum: number | null = null;
      let companyIdNum: number | null = null;
      const sessionUserId = req.session?.userId;
      if (sessionUserId != null) {
        const n = Number(sessionUserId);
        if (Number.isInteger(n) && n > 0) {
          userIdNum = n;
          try {
            const r = await db.execute<{ companyId: number | null }>(sql`
              SELECT company_id AS "companyId" FROM users WHERE id = ${n} LIMIT 1
            `);
            const cid = r.rows?.[0]?.companyId;
            if (typeof cid === "number" && cid > 0) companyIdNum = cid;
          } catch { /* swallow — best-effort */ }
        }
      }
      if (userIdNum == null) {
        const hUid = headerUserId(req);
        const hCid = headerUserCompanyId(req);
        const nu = hUid != null ? Number(hUid) : NaN;
        const nc = hCid != null ? Number(hCid) : NaN;
        if (Number.isInteger(nu) && nu > 0) userIdNum = nu;
        if (Number.isInteger(nc) && nc > 0) companyIdNum = nc;
      }
      if (userIdNum == null) {
        const bu = body.userId;
        if (typeof bu === "number" && Number.isInteger(bu) && bu > 0) userIdNum = bu;
      }
      if (companyIdNum == null) {
        const bc = body.companyId;
        if (typeof bc === "number" && Number.isInteger(bc) && bc > 0) companyIdNum = bc;
      }
      const SEVERITY_VALUES = new Set(["info", "warning", "error", "fatal"]);
      const TYPE_VALUES = new Set(["error", "unhandled_rejection", "log", "metric"]);
      const SOURCE_VALUES = new Set(["web", "mobile", "api", "worker", "sw", "integration"]);
      const sevRaw = pick("severity", 32);
      const typeRaw = pick("type", 32);
      const sourceRaw = pick("source", 32);
      const severity = SEVERITY_VALUES.has(sevRaw) ? sevRaw : "error";
      // Default unknown types to "log" rather than "error" so a stray
      // payload can't pollute the Crashes view (which filters by
      // type IN (error, unhandled_rejection)).
      const type = TYPE_VALUES.has(typeRaw) ? typeRaw : "log";
      const source = SOURCE_VALUES.has(sourceRaw) ? sourceRaw : "web";
      const buildHash = pick("buildHash");
      const appVersion = pick("appVersion") || buildHash || null;
      const component = pick("component", 256) || null;
      const sessionId = pick("sessionId", 128) || null;
      const stack = pick("stack") || null;
      const name = pick("name") || "Error";
      // Task #550 — derive a stable fingerprint from name + first non-noise
      // stack frame + component. Hash with sha1; truncated to keep the
      // index narrow. Keep deterministic so the same JS stack from a
      // different user collapses into the same group.
      const topFrame = stack
        ? stack
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l && !l.startsWith(name) && !l.includes(pick("message")))
            ?.replace(/:\d+:\d+\)?$/, "")
            ?.replace(/https?:\/\/[^/]+/g, "")
            ?.slice(0, 400) ?? ""
        : "";
      const fingerprintInput = `${name}|${topFrame}|${component ?? ""}`;
      const fingerprint = crypto.createHash("sha1").update(fingerprintInput).digest("hex").slice(0, 40);
      // Task #552 — scrub PII (emails, phones, addresses, SSNs) and
      // restrict the free-form `context` object to a small allowlist
      // before the event is persisted. Best-effort: a scrubber failure
      // must never block the report.
      const scrubbed = scrubEvent({
        message: pick("message"),
        stack,
        componentStack: pick("componentStack") || null,
        url: pick("url") || null,
        breadcrumbs: body.breadcrumbs,
        context: body.context,
      });

      const payload: typeof clientErrors.$inferInsert = {
        name,
        message: scrubbed.message ?? "",
        stack: scrubbed.stack ?? null,
        componentStack: scrubbed.componentStack ?? null,
        url: scrubbed.url ?? null,
        userAgent: pick("userAgent") || (typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"]!.slice(0, 4000) : null),
        buildHash,
        userId: userIdNum,
        role: pick("role") || null,
        companyId: companyIdNum,
        sessionId,
        type,
        severity,
        source,
        component,
        appVersion,
        fingerprint,
        breadcrumbs: (scrubbed.breadcrumbs as unknown[] | null) ?? null,
        context: (scrubbed.context as Record<string, unknown> | null) ?? null,
      };
      req.log.error({ clientError: payload }, "client error boundary report");
      try {
        await db.insert(clientErrors).values(payload);
      } catch (dbErr) {
        try { req.log.warn({ err: dbErr }, "client error persist failed"); } catch { /* ignore */ }
      }

      // Task #550 — group rollup. Insert-or-update the group row keyed
      // by fingerprint. On conflict we bump event_count, refresh
      // last_seen_at, recompute user_count / company_count via subquery,
      // and flip a previously-resolved group back to open with
      // is_regression=true.
      try {
        await db.execute(sql`
          INSERT INTO app_event_groups (
            fingerprint, name, sample_message, severity, type, source, component, app_version,
            first_seen_at, last_seen_at, event_count, user_count, company_count, status
          ) VALUES (
            ${fingerprint}, ${name}, ${payload.message || null}, ${severity}, ${type}, ${source},
            ${component}, ${appVersion}, now(), now(), 1,
            ${userIdNum ? 1 : 0}, ${companyIdNum ? 1 : 0}, 'open'
          )
          ON CONFLICT (fingerprint) DO UPDATE SET
            event_count = app_event_groups.event_count + 1,
            last_seen_at = now(),
            sample_message = EXCLUDED.sample_message,
            severity = EXCLUDED.severity,
            app_version = EXCLUDED.app_version,
            user_count = (
              SELECT COUNT(DISTINCT user_id)::int FROM client_errors
              WHERE fingerprint = ${fingerprint} AND user_id IS NOT NULL
            ),
            company_count = (
              SELECT COUNT(DISTINCT company_id)::int FROM client_errors
              WHERE fingerprint = ${fingerprint} AND company_id IS NOT NULL
            ),
            status = CASE WHEN app_event_groups.status = 'resolved' THEN 'open' ELSE app_event_groups.status END,
            is_regression = CASE WHEN app_event_groups.status = 'resolved' THEN true ELSE app_event_groups.is_regression END,
            resolved_at = CASE WHEN app_event_groups.status = 'resolved' THEN NULL ELSE app_event_groups.resolved_at END,
            resolved_by = CASE WHEN app_event_groups.status = 'resolved' THEN NULL ELSE app_event_groups.resolved_by END,
            updated_at = now()
        `);
      } catch (groupErr) {
        try { req.log.warn({ err: groupErr }, "client error group rollup failed"); } catch { /* ignore */ }
      }

      // Emit a regression event into the audit log so the App Health
      // "recent critical events" feed surfaces flips back from
      // resolved → open as a first-class incident signal.
      try {
        const reg = await db.execute<{ isRegression: boolean; severity: string; name: string }>(sql`
          SELECT is_regression AS "isRegression", severity, name
          FROM app_event_groups WHERE fingerprint = ${fingerprint}
        `);
        const row = reg.rows?.[0];
        if (row?.isRegression) {
          await recordAuditEvent(req, {
            actionType: "system",
            action: "crash.regression",
            severity: row.severity === "fatal" ? "critical" : "error",
            targetType: "crash_group",
            targetId: fingerprint,
            summary: `Regression detected: ${row.name}`,
          });
        }
      } catch { /* best-effort */ }

      // Best-effort retention sweep: keep ~30 days. Sampled to avoid
      // hammering the table on every report.
      if (Math.random() < 0.02) {
        try {
          await db
            .delete(clientErrors)
            .where(sql`${clientErrors.createdAt} < now() - interval '30 days'`);
        } catch (cleanupErr) {
          try { req.log.warn({ err: cleanupErr }, "client error cleanup failed"); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      try { req.log.warn({ err }, "client error logging failed"); } catch { /* ignore */ }
    }
    res.status(204).end();
  });

  // Task #545 — admin/super-admin report. Returns aggregate counts grouped
  // by (buildHash, name) over the last 30 days plus a sample row, so we
  // can spot regressions tied to a specific deployed bundle. Limited to
  // company_admin and super_admin roles — gates on the trusted
  // `req.authenticatedUserRole` set by `requireAuthentication`, never
  // raw request headers.
  type ClientErrorGroupRow = {
    buildHash: string;
    name: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    sampleMessage: string | null;
    sampleStack: string | null;
    sampleUrl: string | null;
    sampleComponentStack: string | null;
  };
  app.get("/api/admin/client-errors", requireAuthentication, async (req, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "super_admin" && role !== "company_admin") {
      res.status(403).json({ message: "Admin access required" });
      return;
    }
    try {
      const groupsResult = await db.execute<ClientErrorGroupRow>(sql`
        SELECT
          build_hash AS "buildHash",
          name,
          COUNT(*)::int AS "count",
          MIN(created_at) AS "firstSeen",
          MAX(created_at) AS "lastSeen",
          (ARRAY_AGG(message ORDER BY created_at DESC))[1] AS "sampleMessage",
          (ARRAY_AGG(stack ORDER BY created_at DESC))[1] AS "sampleStack",
          (ARRAY_AGG(url ORDER BY created_at DESC))[1] AS "sampleUrl",
          (ARRAY_AGG(component_stack ORDER BY created_at DESC))[1] AS "sampleComponentStack"
        FROM client_errors
        WHERE created_at >= now() - interval '30 days'
        GROUP BY build_hash, name
        ORDER BY "count" DESC, "lastSeen" DESC
        LIMIT 200
      `);
      const totalResult = await db.execute<{ total: number }>(sql`
        SELECT COUNT(*)::int AS "total"
        FROM client_errors
        WHERE created_at >= now() - interval '30 days'
      `);
      const groups: ClientErrorGroupRow[] = groupsResult.rows ?? [];
      const totalRow = totalResult.rows?.[0];
      res.json({
        windowDays: 30,
        total: totalRow?.total ?? 0,
        groups,
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "listClientErrors",
        ctx: {},
        fallbackMessage: "Couldn't load crash reports — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Task #550 — Super Admin App Health: Crashes tab ─────────────────────
  // All routes guarded to super_admin only. Backed by `app_event_groups`
  // joined with the latest `client_errors` (app_events) row for preview /
  // drawer.
  type AppHealthCrashGroupRow = {
    id: number;
    fingerprint: string;
    name: string;
    sampleMessage: string | null;
    severity: string;
    type: string;
    source: string;
    component: string | null;
    appVersion: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    eventCount: number;
    userCount: number;
    companyCount: number;
    status: string;
    isRegression: boolean;
    assigneeId: number | null;
    snoozedUntil: string | null;
    resolvedAt: string | null;
    resolvedBy: number | null;
    latestUrl?: string | null;
  };
  type AppHealthEventRow = {
    id: number;
    name: string;
    message: string;
    stack: string | null;
    componentStack: string | null;
    url: string | null;
    userAgent: string | null;
    buildHash: string | null;
    appVersion: string | null;
    userId: number | null;
    role: string | null;
    companyId: number | null;
    sessionId: string | null;
    severity: string;
    type: string;
    source: string;
    component: string | null;
    breadcrumbs: unknown;
    context: unknown;
    occurredAt: string;
    createdAt: string;
  };
  const requireSuperAdminGuard = (req: Request, res: Response): boolean => {
    if (req.authenticatedUserRole !== "super_admin") {
      res.status(403).json({ message: "Super admin access required" });
      return false;
    }
    return true;
  };

  const VALID_GROUP_STATUSES = new Set(["open", "muted", "resolved", "snoozed"]);
  const VALID_SEVERITIES = new Set(["info", "warning", "error", "fatal"]);
  const APP_HEALTH_WINDOWS: Record<string, string> = {
    "24h": "24 hours",
    "7d": "7 days",
    "30d": "30 days",
    "90d": "90 days",
  };

  // List crash groups with filters and pagination. Sets X-Total-Count.
  app.get("/api/admin/app-health/crashes", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const status = typeof req.query.status === "string" && VALID_GROUP_STATUSES.has(req.query.status)
        ? (req.query.status as string)
        : "open";
      const severity = typeof req.query.severity === "string" && VALID_SEVERITIES.has(req.query.severity)
        ? (req.query.severity as string)
        : null;
      const companyIdRaw = typeof req.query.company_id === "string" ? Number(req.query.company_id) : NaN;
      const companyId = Number.isInteger(companyIdRaw) && companyIdRaw > 0 ? companyIdRaw : null;
      const version = typeof req.query.version === "string" && req.query.version ? (req.query.version as string).slice(0, 200) : null;
      const q = typeof req.query.q === "string" && req.query.q ? (req.query.q as string).slice(0, 200) : null;
      const windowKey = typeof req.query.window === "string" && APP_HEALTH_WINDOWS[req.query.window] ? (req.query.window as string) : "30d";
      const windowInterval = APP_HEALTH_WINDOWS[windowKey];
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
      const offsetRaw = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;

      const filters: SQL[] = [
        sql`g.status = ${status}`,
        sql`g.last_seen_at >= now() - (${windowInterval})::interval`,
      ];
      if (severity) filters.push(sql`g.severity = ${severity}`);
      if (version) filters.push(sql`g.app_version = ${version}`);
      if (companyId) {
        filters.push(sql`EXISTS (SELECT 1 FROM client_errors ce WHERE ce.fingerprint = g.fingerprint AND ce.company_id = ${companyId})`);
      }
      if (q) {
        const qLike = `%${q}%`;
        filters.push(sql`(g.name ILIKE ${qLike} OR g.sample_message ILIKE ${qLike} OR g.component ILIKE ${qLike})`);
      }
      const where = filters.reduce<SQL>((acc, frag, i) => (i === 0 ? frag : sql`${acc} AND ${frag}`), sql``);

      const rowsResult = await db.execute<AppHealthCrashGroupRow>(sql`
        SELECT
          g.id,
          g.fingerprint,
          g.name,
          g.sample_message AS "sampleMessage",
          g.severity,
          g.type,
          g.source,
          g.component,
          g.app_version AS "appVersion",
          g.first_seen_at AS "firstSeenAt",
          g.last_seen_at AS "lastSeenAt",
          g.event_count AS "eventCount",
          g.user_count AS "userCount",
          g.company_count AS "companyCount",
          g.status,
          g.is_regression AS "isRegression",
          g.assignee_id AS "assigneeId",
          g.snoozed_until AS "snoozedUntil",
          g.resolved_at AS "resolvedAt",
          (SELECT url FROM client_errors ce WHERE ce.fingerprint = g.fingerprint ORDER BY ce.created_at DESC LIMIT 1) AS "latestUrl"
        FROM app_event_groups g
        WHERE ${where}
        ORDER BY g.last_seen_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const totalResult = await db.execute<{ total: number }>(sql`
        SELECT COUNT(*)::int AS "total" FROM app_event_groups g WHERE ${where}
      `);
      const total = totalResult.rows?.[0]?.total ?? 0;
      res.setHeader("X-Total-Count", String(total));
      res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
      const groupsOut: AppHealthCrashGroupRow[] = rowsResult.rows ?? [];
      res.json({ groups: groupsOut, total, window: windowKey });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthListCrashes",
        ctx: {},
        fallbackMessage: "Couldn't load crashes — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Group detail: latest 50 events plus breadcrumbs from the most recent.
  app.get("/api/admin/app-health/crashes/:fingerprint", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const fingerprint = String(req.params.fingerprint).slice(0, 64);
      const groupResult = await db.execute<AppHealthCrashGroupRow>(sql`
        SELECT
          id, fingerprint, name, sample_message AS "sampleMessage", severity, type, source,
          component, app_version AS "appVersion",
          first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt",
          event_count AS "eventCount", user_count AS "userCount", company_count AS "companyCount",
          status, is_regression AS "isRegression", assignee_id AS "assigneeId",
          snoozed_until AS "snoozedUntil", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"
        FROM app_event_groups WHERE fingerprint = ${fingerprint} LIMIT 1
      `);
      const group = groupResult.rows?.[0] ?? null;
      if (!group) {
        res.status(404).json({ message: "Crash group not found" });
        return;
      }
      const eventsResult = await db.execute<AppHealthEventRow>(sql`
        SELECT
          id, name, message, stack, component_stack AS "componentStack", url, user_agent AS "userAgent",
          build_hash AS "buildHash", app_version AS "appVersion", user_id AS "userId", role,
          company_id AS "companyId", session_id AS "sessionId", severity, type, source, component,
          breadcrumbs, context, occurred_at AS "occurredAt", created_at AS "createdAt"
        FROM client_errors
        WHERE fingerprint = ${fingerprint}
        ORDER BY created_at DESC
        LIMIT 50
      `);
      const events: AppHealthEventRow[] = eventsResult.rows ?? [];
      const latest = events[0] ?? null;
      res.json({
        group,
        events,
        breadcrumbs: latest?.breadcrumbs ?? null,
        latestEvent: latest,
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthCrashDetail",
        ctx: {},
        fallbackMessage: "Couldn't load crash detail — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Update a single group's status (open/muted/resolved/snoozed).
  app.post("/api/admin/app-health/crashes/:fingerprint/status", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const fingerprint = String(req.params.fingerprint).slice(0, 64);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = typeof body.status === "string" && VALID_GROUP_STATUSES.has(body.status) ? body.status : null;
      if (!status) {
        res.status(400).json({ message: "Invalid status" });
        return;
      }
      const assigneeIdRaw = body.assignee_id ?? body.assigneeId;
      const assigneeId = typeof assigneeIdRaw === "number" && Number.isInteger(assigneeIdRaw) && assigneeIdRaw > 0 ? assigneeIdRaw : null;
      const userId = req.authenticatedUserId ?? null;
      const result = await db.execute<{ fingerprint: string; status: string }>(sql`
        UPDATE app_event_groups SET
          status = ${status},
          assignee_id = COALESCE(${assigneeId}, assignee_id),
          resolved_at = CASE WHEN ${status} = 'resolved' THEN now() ELSE NULL END,
          resolved_by = CASE WHEN ${status} = 'resolved' THEN ${userId} ELSE NULL END,
          is_regression = CASE WHEN ${status} = 'resolved' THEN false ELSE is_regression END,
          updated_at = now()
        WHERE fingerprint = ${fingerprint}
        RETURNING fingerprint, status
      `);
      const updated = result.rows?.[0] ?? null;
      if (!updated) {
        res.status(404).json({ message: "Crash group not found" });
        return;
      }
      res.json({ ok: true, fingerprint: updated.fingerprint, status: updated.status });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthSetCrashStatus",
        ctx: {},
        fallbackMessage: "Couldn't update crash status — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Bulk status change for the table multi-select action.
  app.post("/api/admin/app-health/crashes/bulk-status", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = typeof body.status === "string" && VALID_GROUP_STATUSES.has(body.status) ? body.status : null;
      const fpsRaw = body.fingerprints;
      const fingerprints = Array.isArray(fpsRaw)
        ? fpsRaw.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 500).map((v) => v.slice(0, 64))
        : [];
      if (!status || fingerprints.length === 0) {
        res.status(400).json({ message: "Missing status or fingerprints" });
        return;
      }
      const userId = req.authenticatedUserId ?? null;
      const isResolved = status === "resolved";
      // Fully parameterized — drizzle binds `fingerprints` as a single
      // text[] parameter via `inArray`, so request input never reaches
      // the SQL string itself.
      const updated = await db
        .update(appEventGroups)
        .set({
          status,
          resolvedAt: isResolved ? new Date() : null,
          resolvedBy: isResolved ? userId : null,
          isRegression: isResolved ? false : undefined,
          updatedAt: new Date(),
        })
        .where(inArray(appEventGroups.fingerprint, fingerprints))
        .returning({ fingerprint: appEventGroups.fingerprint });
      res.json({ ok: true, updated: updated.map((r) => r.fingerprint) });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthBulkSetCrashStatus",
        ctx: {},
        fallbackMessage: "Couldn't update crashes — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Task #550 (Phase 2) — App Health summary / hero / overview ────────
  // Window helpers — re-used by every Phase 2 endpoint.
  const APP_HEALTH_WINDOW_MS: Record<string, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "90d": 90 * 24 * 60 * 60 * 1000,
  };
  function resolveWindow(req: Request, fallback: keyof typeof APP_HEALTH_WINDOW_MS = "24h") {
    const raw = typeof req.query.window === "string" ? req.query.window : "";
    const key = APP_HEALTH_WINDOW_MS[raw] ? raw : fallback;
    return { key, ms: APP_HEALTH_WINDOW_MS[key], interval: APP_HEALTH_WINDOWS[key] ?? "24 hours" };
  }
  function percentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0;
    const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(sortedAsc.length * p) - 1));
    return sortedAsc[idx];
  }
  function pctChange(current: number, previous: number): number | null {
    if (previous === 0) return current === 0 ? 0 : null;
    return Math.round(((current - previous) / previous) * 1000) / 10;
  }

  // Active sessions — counted from non-revoked, non-expired mobile tokens
  // touched in the last 30 minutes. Web sessions are header-auth so we
  // don't have a clean "last seen" surface for them yet; this still gives
  // an honest pulse number for field techs (the bulk of active users).
  async function getActiveUsersNow(): Promise<{ web: number; mobile: number; total: number }> {
    try {
      const r = await db.execute<{ mobile: number }>(sql`
        SELECT COUNT(DISTINCT user_id)::int AS mobile
        FROM mobile_tokens
        WHERE revoked_at IS NULL
          AND expires_at > now()
          AND COALESCE(last_used_at, created_at) >= now() - interval '30 minutes'
      `);
      const mobile = r.rows?.[0]?.mobile ?? 0;
      return { web: 0, mobile, total: mobile };
    } catch {
      return { web: 0, mobile: 0, total: 0 };
    }
  }

  function summarizeAccessLog(
    sinceMs: number,
    untilMs: number = Number.POSITIVE_INFINITY,
  ): { requests: number; errors: number; p95: number } {
    const snap = snapshotAccessLog();
    const durs: number[] = [];
    let requests = 0;
    let errors = 0;
    for (const e of snap) {
      if (e.ts < sinceMs || e.ts >= untilMs) continue;
      requests++;
      if (e.status >= 500) errors++;
      durs.push(e.durMs);
    }
    durs.sort((a, b) => a - b);
    return { requests, errors, p95: percentile(durs, 0.95) };
  }

  async function getEventCount(sinceMs: number, severity?: "warning" | "error" | "fatal"): Promise<number> {
    return getEventCountBetween(sinceMs, Date.now(), severity);
  }

  async function getEventCountBetween(
    sinceMs: number,
    untilMs: number,
    severity?: "warning" | "error" | "fatal" | Array<"warning" | "error" | "fatal">,
  ): Promise<number> {
    try {
      const sinceDate = new Date(sinceMs);
      const untilDate = new Date(untilMs);
      let row;
      if (severity) {
        const sevs = Array.isArray(severity) ? severity : [severity];
        const r = await db.execute<{ c: number }>(sql`
          SELECT COUNT(*)::int AS c FROM client_errors
          WHERE occurred_at >= ${sinceDate} AND occurred_at < ${untilDate}
            AND severity = ANY(${sevs})
        `);
        row = r.rows?.[0];
      } else {
        const r = await db.execute<{ c: number }>(sql`
          SELECT COUNT(*)::int AS c FROM client_errors
          WHERE occurred_at >= ${sinceDate} AND occurred_at < ${untilDate}
        `);
        row = r.rows?.[0];
      }
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  async function getActiveUsersAt(atMs: number): Promise<number> {
    // Active users in the 30-minute window ending at `atMs`. Used to
    // compute a true previous-window comparison for the hero tile.
    try {
      const start = new Date(atMs - 30 * 60 * 1000);
      const end = new Date(atMs);
      const r = await db.execute<{ c: number }>(sql`
        SELECT COUNT(DISTINCT mt.user_id)::int AS c
        FROM mobile_tokens mt
        WHERE mt.revoked_at IS NULL
          AND COALESCE(mt.last_used_at, mt.created_at) >= ${start}
          AND COALESCE(mt.last_used_at, mt.created_at) < ${end}
      `);
      return r.rows?.[0]?.c ?? 0;
    } catch { return 0; }
  }

  // Sync queue depth proxy: we don't yet have a server-side persisted
  // queue, so use field_work_sessions stuck in "in_progress" as a
  // best-effort signal — these are the records most likely to be in the
  // field_work_sessions table removed by Task #1857. Sync queue depth
  // always reports 0; the field portal feature is fully retired.
  async function getSyncQueueDepth(): Promise<{ depth: number; stuck: number }> {
    return { depth: 0, stuck: 0 };
  }

  async function getSyncQueueDepthForCompany(_cid: number): Promise<{ depth: number; stuck: number }> {
    // field_work_sessions table dropped; no per-company sync queue data.
    return { depth: 0, stuck: 0 };
  }

  // Rolling snapshots for delta computation on metrics that don't have
  // a natural "previous window" query (active users right now, current
  // sync queue depth). Keyed by window so 24h ≠ 7d.
  const summarySnapshots = new Map<string, { ts: number; activeUsers: number; syncQueue: number }>();

  app.get("/api/admin/app-health/summary", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const { key: windowKey, ms: windowMs } = resolveWindow(req, "24h");
      const now = Date.now();
      const sinceCurrent = now - windowMs;
      const sincePrev = now - 2 * windowMs;

      const [active, current, previousOnly, errorsCurrent, errorsPrev, activeUsersPrev, sync, openIncidents] = await Promise.all([
        getActiveUsersNow(),
        Promise.resolve(summarizeAccessLog(sinceCurrent, now)),
        Promise.resolve(summarizeAccessLog(sincePrev, sinceCurrent)),
        // Spec: "Errors" KPI counts both error and fatal severities
        // (warnings remain on the chart but are not part of the hero KPI).
        getEventCountBetween(sinceCurrent, now, ["error", "fatal"]),
        getEventCountBetween(sincePrev, sinceCurrent, ["error", "fatal"]),
        getActiveUsersAt(sinceCurrent),
        getSyncQueueDepth(),
        // Task #553 — open incidents drive the hero status pulse. We
        // return both the raw count (for the existing UI tile) and the
        // worst severity so the pulse can roll up P1→crit, P2→warn.
        (async () => {
          try {
            const r = await db.execute<{ c: number; worst: string | null }>(sql`
              SELECT COUNT(*)::int AS c,
                     MIN(severity) AS worst
              FROM incidents
              WHERE status = 'open'
            `);
            return {
              count: r.rows?.[0]?.c ?? 0,
              worstSeverity: r.rows?.[0]?.worst ?? null,
            };
          } catch { return { count: 0, worstSeverity: null as string | null }; }
        })(),
      ]);

      // True prior-window slices: `summarizeAccessLog` is now bracket-
      // queried [since,until) so we don't double-count the current
      // window in `previousOnly` anymore. Same for `getEventCountBetween`.
      const errRate = current.requests > 0 ? current.errors / current.requests : 0;
      const uptime = current.requests > 0 ? Math.max(0, 1 - errRate) : 1;
      const errRatePrev = previousOnly.requests > 0 ? previousOnly.errors / previousOnly.requests : 0;
      const uptimePrev = previousOnly.requests > 0 ? Math.max(0, 1 - errRatePrev) : 1;
      const uptimePctNum = uptime * 100;
      const uptimePctPrev = uptimePrev * 100;
      // Active users delta: compare the live "now" count to the live
      // count as of the previous window boundary. If neither query has
      // any data we still keep the snapshot fallback for parity.
      const snap = summarySnapshots.get(windowKey);
      const activeUsersDelta = activeUsersPrev > 0
        ? pctChange(active.total, activeUsersPrev)
        : (snap ? pctChange(active.total, snap.activeUsers) : null);
      // Sync queue depth is a "right now" gauge — we only have a true
      // previous-window comparison via the rolling snapshot map.
      const syncQueueDelta = snap ? pctChange(sync.depth, snap.syncQueue) : null;
      summarySnapshots.set(windowKey, {
        ts: now,
        activeUsers: active.total,
        syncQueue: sync.depth,
      });
      // Status pulse — Task #553 spec: hero pulse is driven solely by
      // the worst *open* incident severity. P1 → crit, P2 → warn,
      // anything else (including P3/P4 open incidents and noisy raw
      // telemetry) leaves the hero green. The legacy error-rate /
      // sync-queue thresholds now feed Overview KPIs only.
      const incidentCount = openIncidents.count;
      const worstSev = openIncidents.worstSeverity;
      const status: "ok" | "warn" | "crit" =
        worstSev === "P1" ? "crit" : worstSev === "P2" ? "warn" : "ok";

      res.setHeader("Cache-Control", "no-store");
      res.json({
        window: windowKey,
        status,
        uptimePct: Math.round(uptime * 10000) / 100,
        uptimeSloPct: 99.9,
        activeUsers: active.total,
        activeUsersBreakdown: active,
        errors: errorsCurrent,
        errorsPrev,
        apiP95Ms: current.p95,
        apiP95Prev: previousOnly.p95,
        syncQueueDepth: sync.depth,
        syncQueueStuck: sync.stuck,
        incidentsOpen: incidentCount,
        incidentsWorstSeverity: worstSev,
        kpisDelta: {
          activeUsers: activeUsersDelta,
          errors: pctChange(errorsCurrent, errorsPrev),
          apiP95: pctChange(current.p95, previousOnly.p95),
          syncQueue: syncQueueDelta,
          uptime: pctChange(uptimePctNum, uptimePctPrev),
        },
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthSummary",
        ctx: {},
        fallbackMessage: "Couldn't load App Health summary — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Hourly time-series for the Overview chart.
  app.get("/api/admin/app-health/timeseries", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const { key: windowKey, ms: windowMs, interval } = resolveWindow(req, "24h");
      // Reject unknown metric values so the contract stays explicit.
      // The endpoint always returns the full bundle (requests + per-severity
      // event counts); `metric` is reserved for forward-compat with Phase 3
      // when we slice to a single series server-side.
      const ALLOWED_METRICS = new Set(["all", "requests", "errors", "warnings", "fatal"]);
      const metricParam = typeof req.query.metric === "string" ? req.query.metric : "all";
      if (!ALLOWED_METRICS.has(metricParam)) {
        res.status(400).json({ message: `Unknown metric: ${metricParam}` });
        return;
      }
      const ALLOWED_BUCKETS = new Set(["1h", "1d"]);
      const bucketParam = typeof req.query.bucket === "string" ? req.query.bucket : "";
      if (bucketParam && !ALLOWED_BUCKETS.has(bucketParam)) {
        res.status(400).json({ message: `Unknown bucket: ${bucketParam}` });
        return;
      }
      // Default bucket: 1h for 24h/7d windows, 1d for 30d/90d. An
      // explicit `bucket=1h` is honored even on 30d/90d.
      const defaultBucket = windowKey === "30d" || windowKey === "90d" ? "1d" : "1h";
      const effectiveBucket = bucketParam || defaultBucket;
      let bucketMs: number;
      let pgInterval: string;
      let bucketTrunc: string;
      if (effectiveBucket === "1d") {
        bucketMs = 24 * 60 * 60 * 1000;
        pgInterval = "1 day";
        bucketTrunc = "day";
      } else {
        bucketMs = 60 * 60 * 1000;
        pgInterval = "1 hour";
        bucketTrunc = "hour";
      }
      const sinceMs = Date.now() - windowMs;
      const sinceDate = new Date(sinceMs);

      // Errors / warnings from app_events.
      const eventsResult = await db.execute<{ ts: string; severity: string; c: number }>(sql`
        SELECT date_trunc(${bucketTrunc}, occurred_at) AS ts, severity, COUNT(*)::int AS c
        FROM client_errors
        WHERE occurred_at >= ${sinceDate}
        GROUP BY ts, severity
        ORDER BY ts
      `);

      // Requests from access-log buffer (process-local).
      const reqByBucket: Record<number, number> = {};
      for (const e of snapshotAccessLog()) {
        if (e.ts < sinceMs) continue;
        const b = Math.floor(e.ts / bucketMs) * bucketMs;
        reqByBucket[b] = (reqByBucket[b] ?? 0) + 1;
      }

      const eventsByBucket: Record<number, { errors: number; warnings: number; fatal: number }> = {};
      for (const row of eventsResult.rows ?? []) {
        const b = Math.floor(new Date(row.ts).getTime() / bucketMs) * bucketMs;
        const cell = eventsByBucket[b] ?? { errors: 0, warnings: 0, fatal: 0 };
        if (row.severity === "warning") cell.warnings += row.c;
        else if (row.severity === "fatal") cell.fatal += row.c;
        else if (row.severity === "error") cell.errors += row.c;
        eventsByBucket[b] = cell;
      }

      const buckets: Array<{ ts: string; requests: number; errors: number; warnings: number; fatal: number }> = [];
      const startBucket = Math.floor(sinceMs / bucketMs) * bucketMs;
      const endBucket = Math.floor(Date.now() / bucketMs) * bucketMs;
      for (let b = startBucket; b <= endBucket; b += bucketMs) {
        const ev = eventsByBucket[b] ?? { errors: 0, warnings: 0, fatal: 0 };
        buckets.push({
          ts: new Date(b).toISOString(),
          requests: reqByBucket[b] ?? 0,
          errors: ev.errors,
          warnings: ev.warnings,
          fatal: ev.fatal,
        });
      }

      res.setHeader("Cache-Control", "no-store");
      res.json({ window: windowKey, bucket: pgInterval, buckets });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthTimeseries",
        ctx: {},
        fallbackMessage: "Couldn't load App Health time-series — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Companies tab: list + drawer detail with derived health score ─────
  type CompanyHealthRow = {
    id: number;
    name: string;
    plan: string | null;
    activeNow: number;
    totalUsers: number;
    errors24h: number;
    syncQueue: number | null;
    photoUploadPct: number | null;
    storageBytes: number | null;
    appVersion: string | null;
    lastActivityAt: string | null;
    healthScore: number;
    healthBucket: "ok" | "warn" | "bad" | "crit";
  };
  let companiesCache: { ts: number; rows: CompanyHealthRow[] } | null = null;

  function bucketFromScore(score: number): "ok" | "warn" | "bad" | "crit" {
    if (score >= 90) return "ok";
    if (score >= 75) return "warn";
    if (score >= 50) return "bad";
    return "crit";
  }

  function computeHealthScore(opts: {
    errors24h: number;
    activeNow: number;
    totalUsers: number;
    syncQueue: number | null;
    photoUploadPct: number | null;
  }): number {
    // Heuristic per spec section 4: start at 100 and subtract for each
    // signal of trouble. Capped at 0..100.
    let score = 100;
    // Errors per active user — heavy penalty above 1, lighter below.
    const denom = Math.max(1, opts.activeNow || 1);
    const errPerUser = opts.errors24h / denom;
    score -= Math.min(40, errPerUser * 8);
    // Sync queue: 1pt per stuck request, capped at 30. Skip when null
    // (per-company breakout not yet available — don't penalize).
    if (opts.syncQueue != null) score -= Math.min(30, opts.syncQueue * 1);
    // Photo upload success: linear penalty below 95%.
    if (opts.photoUploadPct != null && opts.photoUploadPct < 95) {
      score -= Math.min(20, (95 - opts.photoUploadPct) * 0.8);
    }
    // Tiny tenant inactivity penalty if zero active users and any errors.
    if (opts.activeNow === 0 && opts.errors24h > 0) score -= 5;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  async function loadCompaniesHealth(force = false): Promise<CompanyHealthRow[]> {
    const now = Date.now();
    if (!force && companiesCache && now - companiesCache.ts < 60_000) return companiesCache.rows;

    const companiesResult = await db.execute<{
      id: number;
      name: string;
      plan: string | null;
      totalUsers: number;
      activeNow: number;
      errors24h: number;
      syncQueue: number | null;
      photoTotal: number;
      photoStuck: number;
      lastActivityAt: string | null;
      latestVersion: string | null;
    }>(sql`
      WITH base AS (
        SELECT c.id, c.name, c.subscription AS plan,
               (SELECT COUNT(*)::int FROM users u WHERE u.company_id = c.id AND u.is_active = true AND u.is_deleted = false) AS "totalUsers",
               (SELECT COUNT(DISTINCT mt.user_id)::int FROM mobile_tokens mt
                  JOIN users u ON u.id = mt.user_id
                  WHERE u.company_id = c.id
                    AND mt.revoked_at IS NULL AND mt.expires_at > now()
                    AND COALESCE(mt.last_used_at, mt.created_at) >= now() - interval '30 minutes'
               ) AS "activeNow",
               (SELECT COUNT(*)::int FROM client_errors ce
                  WHERE ce.company_id = c.id
                    AND ce.severity IN ('error','fatal')
                    AND ce.occurred_at >= now() - interval '24 hours'
               ) AS "errors24h",
               -- field_work_sessions has no company_id (and no clean
               -- join through users.clock_number either), so we can't
               -- break the global sync queue depth out per-company yet.
               -- Reported as NULL until a per-company queue source
               -- lands in Phase 3, so the UI shows an honest "—".
               NULL::int AS "syncQueue",
               (SELECT COUNT(*)::int FROM wet_check_photos wp
                  JOIN wet_checks wc ON wc.id = wp.wet_check_id
                  WHERE wc.company_id = c.id AND wp.taken_at >= now() - interval '24 hours'
               ) AS "photoTotal",
               (SELECT COUNT(*)::int FROM wet_check_photos wp
                  JOIN wet_checks wc ON wc.id = wp.wet_check_id
                  WHERE wc.company_id = c.id AND wp.taken_at >= now() - interval '24 hours' AND wp.url = ''
               ) AS "photoStuck",
               (SELECT MAX(occurred_at)::text FROM client_errors WHERE company_id = c.id) AS "lastActivityAt",
               (SELECT app_version FROM client_errors
                  WHERE company_id = c.id AND app_version IS NOT NULL
                    AND occurred_at >= now() - interval '7 days'
                  GROUP BY app_version
                  ORDER BY COUNT(*) DESC, MAX(occurred_at) DESC
                  LIMIT 1) AS "latestVersion"
        FROM companies c
        WHERE c.is_active = true
        ORDER BY c.name
      )
      SELECT * FROM base
    `);

    const rows: CompanyHealthRow[] = (companiesResult.rows ?? []).map((r) => {
      const photoUploadPct = r.photoTotal > 0
        ? Math.round(((r.photoTotal - r.photoStuck) / r.photoTotal) * 1000) / 10
        : null;
      const score = computeHealthScore({
        errors24h: r.errors24h,
        activeNow: r.activeNow,
        totalUsers: r.totalUsers,
        syncQueue: r.syncQueue,
        photoUploadPct,
      });
      return {
        id: r.id,
        name: r.name,
        plan: r.plan,
        activeNow: r.activeNow,
        totalUsers: r.totalUsers,
        errors24h: r.errors24h,
        syncQueue: r.syncQueue,
        photoUploadPct,
        storageBytes: null,
        appVersion: r.latestVersion,
        lastActivityAt: r.lastActivityAt,
        healthScore: score,
        healthBucket: bucketFromScore(score),
      };
    });
    companiesCache = { ts: now, rows };
    return rows;
  }

  app.get("/api/admin/app-health/companies", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const rows = await loadCompaniesHealth(req.query.refresh === "1");
      const sorted = [...rows].sort((a, b) => a.healthScore - b.healthScore);
      res.setHeader("Cache-Control", "no-store");
      res.json({ companies: sorted });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthCompanies",
        ctx: {},
        fallbackMessage: "Couldn't load companies — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // GET /api/admin/wet-checks/loose-photos
  // Super-admin audit endpoint: lists wet checks that have at least one photo
  // not linked to any finding (finding_id IS NULL), with counts. Supports
  // ?companyId= filter and standard limit/offset pagination with X-Total-Count.
  app.get("/api/admin/wet-checks/loose-photos", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const companyIdRaw = typeof req.query.companyId === "string" ? Number(req.query.companyId) : NaN;
      const companyId = Number.isInteger(companyIdRaw) && companyIdRaw > 0 ? companyIdRaw : null;
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
      const offsetRaw = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;

      const companyFilter = companyId ? sql`AND wc.company_id = ${companyId}` : sql``;

      const rowsResult = await db.execute<{
        wetCheckId: number;
        customerId: number;
        customerName: string;
        propertyAddress: string | null;
        status: string;
        loosePhotoCount: number;
      }>(sql`
        SELECT
          wc.id AS "wetCheckId",
          wc.customer_id AS "customerId",
          wc.customer_name AS "customerName",
          wc.property_address AS "propertyAddress",
          wc.status,
          COUNT(p.id)::int AS "loosePhotoCount"
        FROM wet_check_photos p
        JOIN wet_checks wc ON wc.id = p.wet_check_id
        WHERE p.finding_id IS NULL
        ${companyFilter}
        GROUP BY wc.id, wc.customer_id, wc.customer_name, wc.property_address, wc.status
        ORDER BY wc.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const totalResult = await db.execute<{ total: number }>(sql`
        SELECT COUNT(DISTINCT p.wet_check_id)::int AS "total"
        FROM wet_check_photos p
        JOIN wet_checks wc ON wc.id = p.wet_check_id
        WHERE p.finding_id IS NULL
        ${companyFilter}
      `);

      const total = totalResult.rows?.[0]?.total ?? 0;
      res.setHeader("X-Total-Count", String(total));
      res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
      res.json({ rows: rowsResult.rows ?? [], total });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "adminLoosePhotos",
        ctx: {},
        fallbackMessage: "Couldn't load loose photos — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.get("/api/admin/app-health/companies/:id", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ message: "Invalid company id" });
        return;
      }
      const rows = await loadCompaniesHealth(req.query.refresh === "1");
      const company = rows.find((c) => c.id === id);
      if (!company) {
        res.status(404).json({ message: "Company not found" });
        return;
      }

      const [usersRes, topIssuesRes] = await Promise.all([
        db.execute<{
          id: number; name: string; username: string; role: string; lastSeenAt: string | null; isActive: boolean;
        }>(sql`
          SELECT u.id, u.name, u.username, u.role,
            (SELECT MAX(COALESCE(mt.last_used_at, mt.created_at))::text FROM mobile_tokens mt WHERE mt.user_id = u.id) AS "lastSeenAt",
            u.is_active AS "isActive"
          FROM users u
          WHERE u.company_id = ${id} AND u.is_deleted = false
          ORDER BY u.is_active DESC, u.name
          LIMIT 100
        `),
        db.execute<{ fingerprint: string; name: string; sampleMessage: string | null; severity: string; eventCount: number; lastSeenAt: string }>(sql`
          SELECT g.fingerprint, g.name, g.sample_message AS "sampleMessage", g.severity,
                 COUNT(ce.id)::int AS "eventCount",
                 MAX(ce.occurred_at)::text AS "lastSeenAt"
          FROM app_event_groups g
          JOIN client_errors ce ON ce.fingerprint = g.fingerprint
          WHERE ce.company_id = ${id}
            AND ce.occurred_at >= now() - interval '7 days'
          GROUP BY g.fingerprint, g.name, g.sample_message, g.severity
          ORDER BY "eventCount" DESC
          LIMIT 8
        `),
      ]);

      // Fetch estimate-number sequence settings so the drawer can display
      // and edit them without an extra round-trip to /api/companies.
      const settingsRes = await db.execute<{
        startingEstimateNumber: number;
        nextEstimateNumber: number;
      }>(sql`
        SELECT starting_estimate_number AS "startingEstimateNumber",
               next_estimate_number    AS "nextEstimateNumber"
        FROM companies
        WHERE id = ${id}
        LIMIT 1
      `);
      const companySettings = settingsRes.rows[0] ?? null;

      res.setHeader("Cache-Control", "no-store");
      res.json({
        company,
        users: usersRes.rows ?? [],
        topIssues: topIssuesRes.rows ?? [],
        resources: {
          storageBytes: null,
          monthlyApiCalls: null,
          syncQueueDepth: company.syncQueue,
          photoUploadPct: company.photoUploadPct,
        },
        companySettings,
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthCompanyDetail",
        ctx: { id: req.params.id },
        fallbackMessage: "Couldn't load company detail — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Audit Log tab ────────────────────────────────────────────────────
  app.get("/api/admin/app-health/audit", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
      const actor = typeof req.query.actor === "string" ? req.query.actor.slice(0, 200) : "";
      const action = typeof req.query.action === "string" ? req.query.action.slice(0, 100) : "";
      // Allow-list action_type and severity so the contract stays explicit
      // and a stray ?severity=foo doesn't silently match nothing.
      const ALLOWED_ACTION_TYPES = new Set([
        "auth", "user", "company", "data", "config", "billing", "export", "system",
        "admin", "deploy", "integration", "impersonation", "role_change", "other", "",
      ]);
      const ALLOWED_SEVERITIES = new Set(["info", "warning", "error", "critical"]);
      const actionTypeRaw = typeof req.query.action_type === "string" ? req.query.action_type.slice(0, 50) : "";
      if (actionTypeRaw && !ALLOWED_ACTION_TYPES.has(actionTypeRaw)) {
        res.status(400).json({ message: `Unknown action_type: ${actionTypeRaw}` });
        return;
      }
      const actionType = actionTypeRaw;
      const severityRaw = typeof req.query.severity === "string" ? req.query.severity.slice(0, 64) : "";
      if (severityRaw) {
        const tokens = severityRaw.split(",").map((s) => s.trim()).filter(Boolean);
        for (const t of tokens) {
          if (!ALLOWED_SEVERITIES.has(t)) {
            res.status(400).json({ message: `Unknown severity: ${t}` });
            return;
          }
        }
      }
      const severity = severityRaw;
      const fromRaw = typeof req.query.from === "string" ? Date.parse(req.query.from) : NaN;
      const toRaw = typeof req.query.to === "string" ? Date.parse(req.query.to) : NaN;
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      const offset = Math.max(0, Number(req.query.offset) || 0);

      const filters: SQL[] = [];
      if (q) {
        const like = `%${q}%`;
        filters.push(sql`(action ILIKE ${like} OR summary ILIKE ${like} OR actor_label ILIKE ${like})`);
      }
      if (actor) {
        // Drill-throughs from the Users tab pass a numeric user id;
        // free-text searches pass a label. Match on actor_user_id when
        // the value parses as a positive integer, else fall back to
        // the label ILIKE search.
        const asInt = /^\d+$/.test(actor.trim()) ? Number(actor.trim()) : NaN;
        if (Number.isInteger(asInt) && asInt > 0) {
          filters.push(sql`actor_user_id = ${asInt}`);
        } else {
          filters.push(sql`actor_label ILIKE ${`%${actor}%`}`);
        }
      }
      if (action) {
        // Accept comma-separated actions (e.g.
        // ?action=deploy.production,auth.lockout) so the Overview feed
        // can pull operationally-meaningful audit rows in one call
        // regardless of severity.
        const acts = action.split(",").map((s) => s.trim()).filter(Boolean);
        if (acts.length === 1) filters.push(sql`action = ${acts[0]}`);
        else if (acts.length > 1) filters.push(sql`action = ANY(${acts})`);
      }
      if (actionType) filters.push(sql`action_type = ${actionType}`);
      if (severity) {
        // Accept comma-separated severities (e.g. ?severity=warning,error,critical).
        const sevs = severity.split(",").map((s) => s.trim()).filter(Boolean);
        if (sevs.length === 1) filters.push(sql`severity = ${sevs[0]}`);
        else if (sevs.length > 1) filters.push(sql`severity = ANY(${sevs})`);
      }
      if (Number.isFinite(fromRaw)) filters.push(sql`occurred_at >= ${new Date(fromRaw)}`);
      if (Number.isFinite(toRaw)) filters.push(sql`occurred_at <= ${new Date(toRaw)}`);
      const where = filters.length === 0
        ? sql`TRUE`
        : filters.reduce<SQL>((acc, frag, i) => (i === 0 ? frag : sql`${acc} AND ${frag}`), sql``);

      const rowsResult = await db.execute<{
        id: number; occurredAt: string; actorUserId: number | null; actorLabel: string | null;
        actorRole: string | null; actorCompanyId: number | null; actionType: string; action: string;
        severity: string; targetType: string | null; targetId: string | null; summary: string | null;
        details: unknown; ip: string | null;
      }>(sql`
        SELECT id, occurred_at AS "occurredAt", actor_user_id AS "actorUserId",
               actor_label AS "actorLabel", actor_role AS "actorRole",
               actor_company_id AS "actorCompanyId", action_type AS "actionType", action,
               severity, target_type AS "targetType", target_id AS "targetId",
               summary, details, ip
        FROM audit_log
        WHERE ${where}
        ORDER BY occurred_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const totalResult = await db.execute<{ total: number }>(sql`
        SELECT COUNT(*)::int AS total FROM audit_log WHERE ${where}
      `);
      const total = totalResult.rows?.[0]?.total ?? 0;
      res.setHeader("X-Total-Count", String(total));
      res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
      res.json({ events: rowsResult.rows ?? [], total });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthAudit",
        ctx: {},
        fallbackMessage: "Couldn't load audit log — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Task #553 (Phase 4) — Incidents detection engine ────────────────
  // The 60s rule-runner writes rows to `incidents`; these endpoints let
  // the App Health page render the active-incident banner, drill into
  // details, and bulk-acknowledge. All gated by `requireSuperAdmin`.

  type IncidentApiRow = {
    id: number;
    ruleId: string;
    severity: string;
    status: string;
    trigger: string;
    summary: string;
    runbookUrl: string | null;
    ownerUserId: number | null;
    ownerLabel: string | null;
    startedAt: string;
    lastFiringAt: string;
    cleanSinceAt: string | null;
    mitigatedAt: string | null;
    resolvedAt: string | null;
    ackedAt: string | null;
    affectedCompanies: unknown;
    affectedUsers: unknown;
    details: unknown;
    fireCount: number;
  };

  app.get("/api/admin/app-health/incidents", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const statusRaw = typeof req.query.status === "string" ? req.query.status : "open,mitigated";
      const ALLOWED = new Set(["open", "mitigated", "resolved"]);
      const statuses = statusRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => ALLOWED.has(s));
      if (statuses.length === 0) {
        res.status(400).json({ message: "status must be open, mitigated, or resolved" });
        return;
      }
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
      const rowsResult = await db.execute<IncidentApiRow>(sql`
        SELECT id, rule_id AS "ruleId", severity, status, trigger, summary,
               runbook_url AS "runbookUrl", owner_user_id AS "ownerUserId",
               owner_label AS "ownerLabel",
               started_at::text AS "startedAt",
               last_firing_at::text AS "lastFiringAt",
               clean_since_at::text AS "cleanSinceAt",
               mitigated_at::text AS "mitigatedAt",
               resolved_at::text AS "resolvedAt",
               acked_at::text AS "ackedAt",
               affected_companies AS "affectedCompanies",
               affected_users AS "affectedUsers",
               details, fire_count AS "fireCount"
        FROM incidents
        WHERE status = ANY(${statuses})
        ORDER BY
          CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
          started_at DESC
        LIMIT ${limit}
      `);
      res.setHeader("Cache-Control", "no-store");
      res.json({ incidents: rowsResult.rows ?? [] });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthIncidents",
        ctx: {},
        fallbackMessage: "Couldn't load incidents — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Acknowledge a single incident: assigns the current super admin as
  // owner and flips the row to `mitigated`. Re-acking a mitigated /
  // resolved row updates the owner only.
  async function ackOne(req: Request, id: number): Promise<IncidentApiRow | null> {
    const ownerUserId = (req as any).authenticatedUserId ?? null;
    const ownerLabel =
      typeof req.headers["x-user-name"] === "string"
        ? (req.headers["x-user-name"] as string).slice(0, 200)
        : ownerUserId != null
          ? `super_admin#${ownerUserId}`
          : "super_admin";
    const now = new Date();
    const updated = await db.execute<IncidentApiRow>(sql`
      UPDATE incidents
      SET owner_user_id = ${ownerUserId},
          owner_label = ${ownerLabel},
          acked_at = ${now},
          status = CASE WHEN status = 'open' THEN 'mitigated' ELSE status END,
          mitigated_at = CASE
            WHEN status = 'open' AND mitigated_at IS NULL THEN ${now}
            ELSE mitigated_at
          END
      WHERE id = ${id}
      RETURNING id, rule_id AS "ruleId", severity, status, trigger, summary,
                runbook_url AS "runbookUrl", owner_user_id AS "ownerUserId",
                owner_label AS "ownerLabel",
                started_at::text AS "startedAt",
                last_firing_at::text AS "lastFiringAt",
                clean_since_at::text AS "cleanSinceAt",
                mitigated_at::text AS "mitigatedAt",
                resolved_at::text AS "resolvedAt",
                acked_at::text AS "ackedAt",
                affected_companies AS "affectedCompanies",
                affected_users AS "affectedUsers",
                details, fire_count AS "fireCount"
    `);
    const row = updated.rows?.[0] ?? null;
    if (row) {
      await recordAuditEvent(req, {
        actionType: "system",
        action: "incident.acked",
        severity: "info",
        targetType: "incident",
        targetId: String(row.id),
        summary: `acked: ${row.summary}`,
        actorUserId: ownerUserId,
        actorLabel: ownerLabel,
        details: { ruleId: row.ruleId, severity: row.severity },
      });
      // Task #569 — resolve the page in PagerDuty / Slack as soon as
      // a human acknowledges. The matching Rule definition (for the
      // runbook URL) comes from the in-memory ALL_RULES list; if the
      // rule has been removed in code we still send a resolve with a
      // best-effort runbook fallback so the alert closes cleanly.
      const rule = ALL_INCIDENT_RULES.find((r) => r.id === row.ruleId);
      const ruleForPaging = rule ?? {
        id: row.ruleId,
        runbookUrl: row.runbookUrl ?? "",
      };
      try {
        // Cast through `unknown` because the SQL projection narrows
        // jsonb fields to `unknown`; the paging module only reads
        // them as opaque values.
        await notifyIncidentAcked(
          row as unknown as import("@workspace/db/schema").IncidentRow,
          ruleForPaging,
          ownerLabel,
        );
      } catch (err) {
        try { req.log?.warn({ err, incidentId: row.id }, "paging on ack failed"); }
        catch { /* ignore */ }
      }
    }
    return row;
  }

  app.post("/api/admin/app-health/incidents/:id/ack", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ message: "Invalid incident id" });
        return;
      }
      const row = await ackOne(req, id);
      if (!row) {
        res.status(404).json({ message: "Incident not found" });
        return;
      }
      res.json({ incident: row });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthIncidentAck",
        ctx: { id: req.params.id },
        fallbackMessage: "Couldn't acknowledge incident — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.post("/api/admin/app-health/incidents/bulk-ack", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
      let ids: number[] = [];
      if (body.all === true) {
        const r = await db.execute<{ id: number }>(sql`
          SELECT id FROM incidents WHERE status = 'open' ORDER BY id ASC
        `);
        ids = (r.rows ?? []).map((x) => x.id);
      } else if (Array.isArray(body.ids)) {
        ids = body.ids
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0);
      }
      if (ids.length === 0) {
        res.json({ acked: 0, incidents: [] });
        return;
      }
      const acked: IncidentApiRow[] = [];
      for (const id of ids) {
        const row = await ackOne(req, id);
        if (row) acked.push(row);
      }
      res.json({ acked: acked.length, incidents: acked });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthIncidentBulkAck",
        ctx: {},
        fallbackMessage: "Couldn't acknowledge incidents — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Task #569 — On-call paging integrations (PagerDuty / Slack) ───────
  // Lets a super admin store the PagerDuty Events API v2 routing key
  // and/or a Slack incoming-webhook URL. The rule runner picks these
  // up via `loadPagingConfig()` on every transition; there's no
  // process restart required.

  app.post("/api/admin/app-health/integrations", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const current = await loadPagingConfig();

      // PagerDuty routing key — `null` clears, missing means "keep
      // current", any string overwrites. Trim whitespace because the
      // PagerDuty UI sometimes copies a trailing newline.
      let pdKey = current.pagerDutyRoutingKey;
      if (body.pagerDutyRoutingKey === null) {
        pdKey = "";
      } else if (typeof body.pagerDutyRoutingKey === "string") {
        const v = body.pagerDutyRoutingKey.trim();
        // Don't overwrite a real key with the masked form returned
        // by GET — clients that re-submit the existing config keep it.
        if (v && !v.startsWith("*****")) pdKey = v.slice(0, 200);
      }

      let slackUrl = current.slackWebhookUrl;
      if (body.slackWebhookUrl === null) {
        slackUrl = "";
      } else if (typeof body.slackWebhookUrl === "string") {
        const v = body.slackWebhookUrl.trim();
        if (v) {
          if (!/^https:\/\/hooks\.slack\.com\//i.test(v)) {
            res.status(400).json({ message: "Slack webhook URL must start with https://hooks.slack.com/" });
            return;
          }
          slackUrl = v.slice(0, 500);
        }
      }

      const pdEnabled =
        typeof body.pagerDutyEnabled === "boolean"
          ? body.pagerDutyEnabled
          : current.pagerDutyEnabled;
      const slackEnabled =
        typeof body.slackEnabled === "boolean"
          ? body.slackEnabled
          : current.slackEnabled;

      let pageSeverities = current.pageSeverities;
      if (Array.isArray(body.pageSeverities)) {
        const allowed = new Set(["P1", "P2", "P3", "P4"]);
        const filtered = (body.pageSeverities as unknown[])
          .filter((s): s is string => typeof s === "string" && allowed.has(s))
          .map((s) => s as PagingConfig["pageSeverities"][number]);
        if (filtered.length > 0) pageSeverities = filtered;
      }

      // Refuse to enable an integration that has no credential — keeps
      // the dashboard from advertising "we'll page you" when it can't.
      if (pdEnabled && !pdKey) {
        res.status(400).json({ message: "PagerDuty routing key is required to enable PagerDuty paging" });
        return;
      }
      if (slackEnabled && !slackUrl) {
        res.status(400).json({ message: "Slack webhook URL is required to enable Slack paging" });
        return;
      }

      const next: PagingConfig = {
        pagerDutyEnabled: pdEnabled,
        pagerDutyRoutingKey: pdKey,
        slackEnabled,
        slackWebhookUrl: slackUrl,
        pageSeverities,
      };

      const actorUserId = req.authenticatedUserId ?? null;
      const actorLabel =
        typeof req.headers["x-user-name"] === "string"
          ? (req.headers["x-user-name"] as string).slice(0, 200)
          : actorUserId != null
            ? `super_admin#${actorUserId}`
            : "super_admin";
      await savePagingConfig(next, actorLabel);
      await recordAuditEvent(req, {
        actionType: "system",
        action: "integrations.paging.updated",
        severity: "info",
        targetType: "app_settings",
        targetId: "oncallPaging",
        summary: `Updated on-call paging config (PD=${pdEnabled}, Slack=${slackEnabled}, sev=${pageSeverities.join(",")})`,
        actorUserId,
        actorLabel,
        details: {
          pagerDutyEnabled: pdEnabled,
          pagerDutyKeyConfigured: pdKey.length > 0,
          slackEnabled,
          slackConfigured: slackUrl.length > 0,
          pageSeverities,
        },
      });
      const fresh = await loadPagingConfig();
      res.json({ config: toPublicConfig(fresh) });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthIntegrationsSave",
        ctx: {},
        fallbackMessage: "Couldn't save integrations — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Test-fire: send a synthetic page through whichever channels are
  // currently enabled so the operator can confirm the routing key /
  // webhook URL before they trust it. Doesn't write anything to the
  // `incidents` table.
  app.post("/api/admin/app-health/integrations/test", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const sentTo = await sendTestPage();
      res.json({ ok: true, sentTo });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthIntegrationsTest",
        ctx: {},
        fallbackMessage: "Couldn't send test page — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Task #552 (Phase 3) — Internal app-event sink + telemetry ─────────
  // `client_errors` is the underlying app_events firehose for everything
  // the UI shows on App Health. Phase 3 adds two new producers in
  // addition to the client-side error boundary:
  //
  //  - The Express request pipeline emits a `metric` row for every 5xx
  //    response and a `metric` row tagged `slow` for any successful
  //    response that took > 2 s. These are the signal behind the API
  //    p95 / 5xx rate columns on the Sync & Uploads tab.
  //  - Backend operations (photo finalize, integration calls, PDF
  //    renders) wrapped in `withTelemetry()` emit a `metric` row with
  //    duration + outcome.
  //
  // Both producers funnel through `insertAppEvent()`; events land in
  // `client_errors` with `source` ∈ {api, integration, worker} and
  // `type` = "metric" so the existing Crashes view filters them out
  // (it filters by type=error/unhandled_rejection in the UI).
  function fingerprintFor(input: string): string {
    return crypto.createHash("sha1").update(input).digest("hex").slice(0, 40);
  }
  type InternalEventInput = {
    name: string;
    message?: string | null;
    source: "web" | "mobile" | "api" | "worker" | "sw" | "integration";
    type: "error" | "unhandled_rejection" | "log" | "metric";
    severity: "info" | "warning" | "error" | "fatal";
    component?: string | null;
    appVersion?: string | null;
    userId?: number | null;
    companyId?: number | null;
    sessionId?: string | null;
    stack?: string | null;
    url?: string | null;
    context?: Record<string, unknown> | null;
  };
  async function insertAppEvent(evt: InternalEventInput): Promise<void> {
    try {
      const fingerprint = fingerprintFor(`${evt.name}|${evt.component ?? ""}|${evt.source}|${evt.type}`);
      const scrubbed = scrubEvent({
        message: evt.message ?? "",
        stack: evt.stack ?? null,
        componentStack: null,
        url: evt.url ?? null,
        breadcrumbs: null,
        context: evt.context ?? null,
      });
      const row: typeof clientErrors.$inferInsert = {
        name: evt.name,
        message: scrubbed.message ?? "",
        stack: scrubbed.stack ?? null,
        componentStack: null,
        url: scrubbed.url ?? null,
        userAgent: null,
        buildHash: evt.appVersion ?? "",
        userId: evt.userId ?? null,
        role: null,
        companyId: evt.companyId ?? null,
        sessionId: evt.sessionId ?? null,
        type: evt.type,
        severity: evt.severity,
        source: evt.source,
        component: evt.component ?? null,
        appVersion: evt.appVersion ?? null,
        fingerprint,
        breadcrumbs: null,
        context: (scrubbed.context as Record<string, unknown> | null) ?? null,
      };
      await db.insert(clientErrors).values(row);
      // Upsert into the rollup table so the Crashes view's group
      // counters stay accurate for non-error metric events too. We
      // keep it cheap by skipping the per-event distinct subqueries
      // — the periodic 60 s rollup re-derives those from scratch.
      await db.execute(sql`
        INSERT INTO app_event_groups (
          fingerprint, name, sample_message, severity, type, source, component, app_version,
          first_seen_at, last_seen_at, event_count, user_count, company_count, status
        ) VALUES (
          ${fingerprint}, ${evt.name}, ${row.message || null}, ${evt.severity}, ${evt.type}, ${evt.source},
          ${evt.component ?? null}, ${evt.appVersion ?? null}, now(), now(), 1,
          ${evt.userId ? 1 : 0}, ${evt.companyId ? 1 : 0}, 'open'
        )
        ON CONFLICT (fingerprint) DO UPDATE SET
          event_count = app_event_groups.event_count + 1,
          last_seen_at = now(),
          severity = EXCLUDED.severity,
          updated_at = now()
      `);
    } catch (err) {
      try { logger.warn({ err }, "insertAppEvent failed"); } catch { /* swallow */ }
    }
  }

  // Bridge `withTelemetry()` callers (anywhere in the codebase that
  // imports the helper) into the same sink.
  setTelemetrySink((evt: TelemetryEvent) => {
    void insertAppEvent({
      name: evt.ok ? `${evt.component}.ok` : (evt.errorName ?? `${evt.component}.error`),
      message: evt.errorMessage ?? null,
      source: evt.source,
      type: evt.type,
      severity: evt.severity,
      component: evt.component,
      context: {
        duration_ms: evt.durationMs,
        ok: evt.ok,
        ...(evt.statusCode != null ? { status_code: evt.statusCode } : {}),
        ...(evt.context ?? {}),
      },
    });
  });

  // (http.5xx / http.slow telemetry middleware mounted earlier — see
  //  the top of registerRoutes — so it wraps every route handler.)

  // 60 s background rollup — recomputes user_count / company_count for
  // the most-recently-active groups so the Crashes table converges on
  // accurate distinct counts even when many concurrent inserts race
  // through the per-event upsert. We constrain the work to groups
  // updated in the last hour so the job stays cheap regardless of
  // table size.
  //
  // Leader election: we wrap the body in `pg_try_advisory_lock` keyed
  // off a stable 64-bit constant (the sha1 prefix of the literal
  // "app_event_groups_rollup"). Only the replica that grabs the lock
  // executes the UPDATE; the others no-op until it's released. The
  // lock is released at the end of the same query block via
  // `pg_advisory_unlock`. This makes the timer safe to run in cluster
  // / pm2 / multi-replica deployments.
  const ROLLUP_LOCK_KEY = 0x4170705f456d4831n; // "App_EmH1" — arbitrary stable bigint
  const rollupTimer = setInterval(() => {
    void (async () => {
      try {
        const got = await db.execute<{ ok: boolean }>(sql`
          SELECT pg_try_advisory_lock(${ROLLUP_LOCK_KEY}) AS ok
        `);
        if (!got.rows?.[0]?.ok) return; // another replica is the leader
        try {
          await db.execute(sql`
            UPDATE app_event_groups g SET
            user_count = COALESCE(sub.uc, 0),
            company_count = COALESCE(sub.cc, 0),
            event_count = COALESCE(sub.ec, g.event_count),
            updated_at = now()
          FROM (
            SELECT fingerprint,
                   COUNT(*)::int AS ec,
                   COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS uc,
                   COUNT(DISTINCT company_id) FILTER (WHERE company_id IS NOT NULL)::int AS cc
            FROM client_errors
            WHERE fingerprint IS NOT NULL
              AND occurred_at >= now() - interval '24 hours'
            GROUP BY fingerprint
            ) sub
            WHERE g.fingerprint = sub.fingerprint
              AND g.last_seen_at >= now() - interval '1 hour'
          `);
        } finally {
          try {
            await db.execute(sql`SELECT pg_advisory_unlock(${ROLLUP_LOCK_KEY})`);
          } catch { /* lock auto-releases on session close */ }
        }
      } catch (err) {
        try { logger.warn({ err }, "app_event_groups rollup job failed"); } catch { /* ignore */ }
      }
    })();
  }, 60_000);
  // Don't keep the process alive for the rollup timer alone.
  if (typeof rollupTimer.unref === "function") rollupTimer.unref();

  // Task #553 — kick off the incident rule-runner. Internally guarded
  // by a pg_try_advisory_lock so only one replica drives the loop.
  startIncidentRunner();

  // Task #554 — prime the per-company throttle cache. The middleware
  // itself was mounted at the top of the file (before route handlers)
  // so it gates every /api/* request once auth has populated
  // req.authenticatedUserCompanyId.
  void loadCompanyThrottles();

  // Customer-name scrubber refresh — Task #552 PII spec. Loads the
  // current set of customer names from the DB into an in-memory regex
  // used by `scrubString()` so any event payload that quotes a real
  // customer name is rewritten to "[customer]" before insert. Refreshed
  // every 5 minutes; first run kicks off immediately.
  async function refreshCustomerNamesScrubber(): Promise<void> {
    try {
      const r = await db.execute<{ name: string | null }>(sql`
        SELECT DISTINCT name FROM customers
        WHERE name IS NOT NULL AND length(name) >= 4
        LIMIT 5000
      `);
      setScrubCustomerNames((r.rows ?? []).map((row) => row.name ?? ""));
    } catch (err) {
      try { logger.warn({ err }, "refreshCustomerNamesScrubber failed"); } catch { /* ignore */ }
    }
  }
  void refreshCustomerNamesScrubber();
  const customerScrubTimer = setInterval(() => {
    void refreshCustomerNamesScrubber();
  }, 5 * 60_000);
  if (typeof customerScrubTimer.unref === "function") customerScrubTimer.unref();

  // ── Task #552 (Phase 3) — Sync & Uploads tab endpoints ────────────────
  // Sync queue depth + hourly buckets. Backed by `field_work_sessions`
  // (the longest-lived offline-queue proxy we have on the server) plus
  // the new `sync.stuck` events the offline engine posts to
  // `/api/client-errors` when a queued mutation crosses the
  // attempt > 3 / age > 1h threshold.
  app.get("/api/admin/app-health/sync/queue", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const { ms, key } = resolveWindow(req, "24h");
      const since = new Date(Date.now() - ms);
      // Optional company_id filter — Task #552 spec. When supplied,
      // every metric in the response is scoped to users / sessions /
      // events whose company is `cid`. Field-work-sessions don't
      // carry company_id directly so we resolve through users.
      const cidRaw = req.query.company_id ?? req.query.companyId;
      const cid = typeof cidRaw === "string" && /^\d+$/.test(cidRaw) ? Number(cidRaw) : null;
      const eventCompanyFilter = cid
        ? sql`AND ce.user_id IN (SELECT id FROM users WHERE company_id = ${cid})`
        : sql``;
      const sessionCompanyFilter = cid
        ? sql`AND s.clock_number IN (
            SELECT username FROM users WHERE company_id = ${cid}
            UNION ALL
            SELECT CAST(id AS text) FROM users WHERE company_id = ${cid}
          )`
        : sql``;
      const depth = cid ? await getSyncQueueDepthForCompany(cid) : await getSyncQueueDepth();
      const stuckEventsRes = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM client_errors ce
        WHERE ce.name = 'sync.stuck' AND ce.occurred_at >= ${since}
        ${eventCompanyFilter}
      `);
      const stuckEvents = stuckEventsRes.rows?.[0]?.c ?? 0;
      // Hourly buckets of stuck-sync events for the trend sparkline.
      const bucketWidth = ms <= 24 * 60 * 60 * 1000 ? "1 hour" : "1 day";
      const bucketsRes = await db.execute<{ ts: string; c: number }>(sql`
        SELECT date_trunc(${bucketWidth}, ce.occurred_at)::text AS ts, COUNT(*)::int AS c
        FROM client_errors ce
        WHERE ce.name = 'sync.stuck' AND ce.occurred_at >= ${since}
        ${eventCompanyFilter}
        GROUP BY 1 ORDER BY 1 ASC
      `);
      // Top stuck users — joined to users for label.
      const topUsersRes = await db.execute<{
        userId: number; name: string | null; companyId: number | null; companyName: string | null; events: number;
      }>(sql`
        SELECT ce.user_id AS "userId", u.name AS name,
               u.company_id AS "companyId", c.name AS "companyName",
               COUNT(*)::int AS events
        FROM client_errors ce
        LEFT JOIN users u ON u.id = ce.user_id
        LEFT JOIN companies c ON c.id = u.company_id
        WHERE ce.name = 'sync.stuck'
          AND ce.occurred_at >= ${since}
          AND ce.user_id IS NOT NULL
          ${eventCompanyFilter}
        GROUP BY ce.user_id, u.name, u.company_id, c.name
        ORDER BY events DESC
        LIMIT 20
      `);
      // Conflict count — engine emits sync.conflict telemetry whenever a
      // mutation comes back 409. Counted from app_events in the same
      // window as the rest of the card.
      const conflictsRes = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM client_errors ce
        WHERE ce.name = 'sync.conflict' AND ce.occurred_at >= ${since}
        ${eventCompanyFilter}
      `);
      const conflicts = conflictsRes.rows?.[0]?.c ?? 0;
      // Average queue-age (minutes) — derived from in-progress
      // field_work_sessions; skipped silently on error.
      let avgAgeMinutes: number | null = null;
      // field_work_sessions removed by Task #1857; session avg age is always null.
      avgAgeMinutes = null;
      // Stuck-item table — in-progress sessions older than 1h, joined to
      // user / company. The session's clockNumber maps to a tech.
      // field_work_sessions table removed by Task #1857. Return empty stuck-items list.
      const stuckItems: Array<{ kind: string; userId: number | null; userName: string | null; companyName: string | null; ageMinutes: number; status: string }> = [];
      res.json({
        window: key,
        queueDepth: depth.depth,
        queueStuck: depth.stuck,
        conflicts,
        avgAgeMinutes,
        stuckEvents,
        stuckItems,
        buckets: bucketsRes.rows ?? [],
        topUsers: topUsersRes.rows ?? [],
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthSyncQueue",
        ctx: {},
        fallbackMessage: "Couldn't load sync queue — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Photo upload pipeline summary — derived from photo.upload.<step>.*
  // events emitted by the offline engine on the client. The pipeline
  // steps are sign (DB), put (S3), finalize (CDN), metadata (DB write).
  app.get("/api/admin/app-health/uploads/photos", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      // Spec: photo pipeline rates are always reported over the last
      // hour, regardless of the global window selector. Anything older
      // is too coarse to act on for a live ops view.
      const ms = 60 * 60 * 1000;
      const key = "1h";
      const since = new Date(Date.now() - ms);
      const stepNames = [
        "photo.upload.sign.ok", "photo.upload.sign.failed",
        "photo.upload.put.ok", "photo.upload.put.failed",
        "photo.upload.finalize.ok", "photo.upload.finalize.failed",
        "photo.upload.metadata.ok", "photo.upload.metadata.failed",
        // Legacy single-event names for back-compat with installed clients
        // that have not picked up the per-step engine yet.
        "photo.upload.ok", "photo.upload.failed",
      ];
      const totals = await db.execute<{ name: string; c: number }>(sql`
        SELECT name, COUNT(*)::int AS c FROM client_errors
        WHERE name = ANY(${stepNames}::text[])
          AND occurred_at >= ${since}
        GROUP BY name
      `);
      const get = (n: string) => totals.rows?.find((r) => r.name === n)?.c ?? 0;
      const stepRate = (ok: number, failed: number) => {
        const total = ok + failed;
        return {
          ok, failed, total,
          successRate: total > 0 ? Math.round((ok / total) * 1000) / 10 : null,
        };
      };
      const sign = stepRate(get("photo.upload.sign.ok"), get("photo.upload.sign.failed"));
      const put = stepRate(get("photo.upload.put.ok"), get("photo.upload.put.failed"));
      const finalize = stepRate(get("photo.upload.finalize.ok"), get("photo.upload.finalize.failed"));
      const metadata = stepRate(get("photo.upload.metadata.ok"), get("photo.upload.metadata.failed"));
      // The engine emits BOTH per-step events and a rolled-up
      // photo.upload.{ok,failed} for each upload, so summing them
      // double-counts. Prefer step events when present in the window;
      // only count the legacy rollup when there are no step signals
      // at all (older clients without the per-step pipeline).
      const stepSignal = sign.total + put.total + finalize.total + metadata.total;
      const legacyOk = stepSignal > 0 ? 0 : get("photo.upload.ok");
      const legacyFailed = stepSignal > 0 ? 0 : get("photo.upload.failed");
      const overallOk = stepSignal > 0 ? metadata.ok : legacyOk;
      const overallFailed = stepSignal > 0
        ? sign.failed + put.failed + finalize.failed + metadata.failed
        : legacyFailed;
      const overallTotal = overallOk + overallFailed;
      const successRate = overallTotal > 0
        ? Math.round((overallOk / overallTotal) * 1000) / 10 : null;
      // S3 degraded heuristic: <90% PUT success across at least 20 attempts
      // in the window. Surfaces inline in the UI as a notice.
      const s3Degraded = put.total >= 20 && (put.successRate ?? 100) < 90;
      // Top failure reasons across all step `failed` events for the
      // failures panel — useful for triage at a glance.
      const reasons = await db.execute<{ message: string; c: number }>(sql`
        SELECT COALESCE(NULLIF(message, ''), 'unknown')::text AS message,
               COUNT(*)::int AS c
        FROM client_errors
        WHERE name LIKE 'photo.upload.%.failed'
          AND occurred_at >= ${since}
        GROUP BY 1 ORDER BY c DESC LIMIT 10
      `);
      res.json({
        window: key,
        totalAttempts: overallTotal,
        ok: overallOk,
        failed: overallFailed,
        successRate,
        steps: { sign, put, finalize, metadata },
        s3Degraded,
        topFailures: reasons.rows ?? [],
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthUploadsPhotos",
        ctx: {},
        fallbackMessage: "Couldn't load photo upload telemetry — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Operational tile values for the Overview tab strip.
  app.get("/api/admin/app-health/ops", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const { ms } = resolveWindow(req, "24h");
      const since = new Date(Date.now() - ms);
      const counts = await db.execute<{ name: string; c: number }>(sql`
        SELECT name, COUNT(*)::int AS c FROM client_errors
        WHERE occurred_at >= ${since}
          AND name IN (
            'photo.upload.ok','photo.upload.failed',
            'wet_check.sync.ok','wet_check.sync.failed',
            'sync.stuck'
          )
        GROUP BY name
      `);
      const get = (n: string) => counts.rows?.find((r) => r.name === n)?.c ?? 0;
      const photoOk = get("photo.upload.ok");
      const photoFail = get("photo.upload.failed");
      const photoTotal = photoOk + photoFail;
      const wcOk = get("wet_check.sync.ok");
      const wcFail = get("wet_check.sync.failed");
      const wcTotal = wcOk + wcFail;
      const stuck = get("sync.stuck");
      // Offline session count — distinct sessionId firing sync.stuck
      // events in the window. A session is the tech's tab/app session.
      const offlineSessionsRes = await db.execute<{ c: number }>(sql`
        SELECT COUNT(DISTINCT session_id)::int AS c FROM client_errors
        WHERE occurred_at >= ${since}
          AND session_id IS NOT NULL
          AND name = 'sync.stuck'
      `);
      const offlineSessions = offlineSessionsRes.rows?.[0]?.c ?? 0;
      // Operational tiles wired to real backend metrics (Task #552):
      //  - PDF p95 render: percentile over http.slow events whose
      //    request path mentions a PDF endpoint.
      //  - Invoice failures: 5xx events on invoice / quickbooks paths.
      //  - Map tile errors: explicit `map.tile.failed` events posted
      //    by the leaflet viewer when a tile fetch errors out.
      let pdfRenderP95Ms: number | null = null;
      try {
        const r = await db.execute<{ p95: number | null }>(sql`
          SELECT percentile_disc(0.95) WITHIN GROUP (
            ORDER BY (context->>'duration_ms')::int
          )::int AS p95
          FROM client_errors
          WHERE name = 'http.slow'
            AND occurred_at >= ${since}
            AND (context->>'path' ILIKE '%pdf%' OR component ILIKE '%pdf%')
            AND (context->>'duration_ms') ~ '^\\d+$'
        `);
        pdfRenderP95Ms = r.rows?.[0]?.p95 ?? null;
      } catch { pdfRenderP95Ms = null; }
      let invoiceFailures: number | null = null;
      try {
        const r = await db.execute<{ c: number }>(sql`
          SELECT COUNT(*)::int AS c FROM client_errors
          WHERE occurred_at >= ${since}
            AND name LIKE 'http.5%'
            AND (
              context->>'path' ILIKE '%invoice%'
              OR context->>'path' ILIKE '%quickbooks%'
              OR component ILIKE '%invoice%'
              OR component ILIKE '%quickbooks%'
            )
        `);
        invoiceFailures = r.rows?.[0]?.c ?? 0;
      } catch { invoiceFailures = null; }
      let mapTileErrors: number | null = null;
      try {
        const r = await db.execute<{ c: number }>(sql`
          SELECT COUNT(*)::int AS c FROM client_errors
          WHERE occurred_at >= ${since}
            AND name = 'map.tile.failed'
        `);
        mapTileErrors = r.rows?.[0]?.c ?? 0;
      } catch { mapTileErrors = null; }
      res.json({
        photoUpload: {
          successPct: photoTotal > 0 ? Math.round((photoOk / photoTotal) * 1000) / 10 : null,
          attempts: photoTotal,
          ok: photoOk,
          failed: photoFail,
        },
        wetCheckSync: {
          successPct: wcTotal > 0 ? Math.round((wcOk / wcTotal) * 1000) / 10 : null,
          attempts: wcTotal,
        },
        stuckEvents: stuck,
        offlineSessions,
        pdfRenderP95Ms,
        invoiceFailures,
        mapTileErrors,
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthOps",
        ctx: {},
        fallbackMessage: "Couldn't load operational health — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Task #552 (Phase 3) — Users tab ───────────────────────────────────
  // Cross-tenant user list with derived status. "Active" = a session
  // touched in the last 30 min; "Stuck syncing" = sync.stuck event in
  // the last hour; "Errored" = error event in the last 30 min;
  // otherwise "Idle".
  app.get("/api/admin/app-health/users", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
      const q = (typeof req.query.q === "string" ? req.query.q : "").trim().slice(0, 100);
      const companyIdRaw = typeof req.query.company_id === "string" ? req.query.company_id : "";
      const companyId = /^\d+$/.test(companyIdRaw) ? parseInt(companyIdRaw, 10) : null;
      const statusFilter = typeof req.query.status === "string" ? req.query.status : "";
      // Phase 3 spec: status enum is active|offline|stuck|locked|syncing.
      const validStatuses = new Set(["active", "offline", "stuck", "locked", "syncing", "all"]);
      const status = validStatuses.has(statusFilter) ? statusFilter : "all";
      const roleFilter = typeof req.query.role === "string" ? req.query.role : "";
      const validRoles = new Set([
        "super_admin", "company_admin", "irrigation_manager", "field_tech", "billing_manager",
      ]);
      const role = validRoles.has(roleFilter) ? roleFilter : null;
      // Modal app version across the last 24h — the version most
      // installed users are actually running. We compare each user's
      // own modal version to this so a one-off event from an outlier
      // build doesn't drag the "behind" flag along with it.
      const latestVerRes = await db.execute<{ v: string | null }>(sql`
        SELECT app_version AS v FROM client_errors
        WHERE app_version IS NOT NULL
          AND occurred_at >= now() - interval '24 hours'
        GROUP BY app_version
        ORDER BY COUNT(*) DESC, MAX(occurred_at) DESC
        LIMIT 1
      `);
      const latestVersion = latestVerRes.rows?.[0]?.v ?? null;

      const filters: SQL[] = [eq(users.isDeleted, false)];
      if (companyId != null) filters.push(eq(users.companyId, companyId));
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
        filters.push(sql`(${users.name} ILIKE ${like} OR ${users.username} ILIKE ${like} OR ${users.email} ILIKE ${like})`);
      }

      // Status derivation pushed into SQL so filter + pagination + total
      // are consistent. Priority: locked > stuck > syncing > active >
      // offline. Spec adds device/os, conflicts24h, failedUploads24h,
      // errors24h columns.
      const baseFilters = sql`
        u.is_deleted = false
        ${companyId != null ? sql`AND u.company_id = ${companyId}` : sql``}
        ${role != null ? sql`AND u.role = ${role}` : sql``}
        ${q ? sql`AND (u.name ILIKE ${'%' + q + '%'} OR u.username ILIKE ${'%' + q + '%'} OR COALESCE(u.email,'') ILIKE ${'%' + q + '%'})` : sql``}
      `;
      // Status priority: locked > stuck > syncing > active > offline.
      //   active   — field_work_session activity in last 5 min
      //   syncing  — in-progress field_work_session (queue depth > 0)
      //   stuck    — in-progress field_work_session > 1h old
      //   locked   — audit_log auth.lockout / login.lockout in last 24h
      //              (real lockout signal); admin-disabled accounts
      //              (is_active=false) are NOT considered locked.
      //   offline  — no session activity in last 30 min
      // field_work_sessions has no user_id FK; resolve via
      //   clock_number = users.username OR clock_number = text(id).
      const baseSelect = sql`
        SELECT u.id, u.name, u.username, u.email, u.role,
               u.company_id AS "companyId",
               c.name AS "companyName",
               u.is_active AS "isActive",
               sess.last_activity_at::text AS "lastSeenMobile",
               COALESCE(sess.active_5m, 0)::int AS "activeMobile",
               COALESCE(err30.c, 0)::int AS "errorsLast30m",
               COALESCE(err24.c, 0)::int AS "errors24h",
               COALESCE(sess.stuck_1h, 0)::int AS "stuckLastHour",
               COALESCE(sess.in_progress, 0)::int AS "syncingLast5m",
               COALESCE(conflicts.c, 0)::int AS "conflicts24h",
               COALESCE(uploads.c, 0)::int AS "failedUploads24h",
               dev.device_name AS "deviceName",
               dev.os AS "os",
               ver.v AS "appVersion",
               CASE
                 WHEN COALESCE(lockout.c, 0) > 0 THEN 'locked'
                 WHEN COALESCE(sess.stuck_1h, 0) > 0 THEN 'stuck'
                 WHEN COALESCE(sess.in_progress, 0) > 0 THEN 'syncing'
                 WHEN COALESCE(sess.active_5m, 0) > 0 THEN 'active'
                 -- Spec: offline = no session activity in the last 30m
                 -- (also covers users with no session activity ever).
                 WHEN sess.last_activity_at IS NULL
                   OR sess.last_activity_at < now() - interval '30 minutes'
                   THEN 'offline'
                 -- 5–30m band: not actively syncing, but recently
                 -- present. The status enum has no "idle" bucket, so
                 -- bucket as offline per spec precedence.
                 ELSE 'offline'
               END AS "status"
        FROM users u
        LEFT JOIN companies c ON c.id = u.company_id
        -- field_work_sessions removed by Task #1857; session stats are unavailable.
        LEFT JOIN LATERAL (
          SELECT
            NULL::timestamptz AS last_activity_at,
            0::bigint AS active_5m,
            0::bigint AS in_progress,
            0::bigint AS stuck_1h
        ) sess ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS c FROM client_errors ce
          WHERE ce.user_id = u.id
            AND ce.occurred_at >= now() - interval '30 minutes'
            AND ce.type IN ('error', 'unhandled_rejection')
            AND ce.severity IN ('error', 'fatal')
        ) err30 ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS c FROM client_errors ce
          WHERE ce.user_id = u.id
            AND ce.occurred_at >= now() - interval '24 hours'
            AND ce.type IN ('error', 'unhandled_rejection')
            AND ce.severity IN ('error', 'fatal')
        ) err24 ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS c FROM client_errors ce
          WHERE ce.user_id = u.id
            AND ce.name = 'sync.conflict'
            AND ce.occurred_at >= now() - interval '24 hours'
        ) conflicts ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS c FROM client_errors ce
          WHERE ce.user_id = u.id
            AND ce.name LIKE 'photo.upload.%.failed'
            AND ce.occurred_at >= now() - interval '24 hours'
        ) uploads ON TRUE
        LEFT JOIN LATERAL (
          SELECT mt.device_name,
                 -- mobile_tokens has no explicit OS column; sniff it
                 -- from device_name strings like "iPhone 14 Pro" /
                 -- "Pixel 7 (Android 14)" so the Users table has
                 -- something to show until a dedicated column lands.
                 CASE
                   WHEN mt.device_name ILIKE '%iphone%' OR mt.device_name ILIKE '%ipad%' OR mt.device_name ILIKE '%ios%' THEN 'iOS'
                   WHEN mt.device_name ILIKE '%android%' OR mt.device_name ILIKE '%pixel%' OR mt.device_name ILIKE '%galaxy%' THEN 'Android'
                   WHEN mt.device_name ILIKE '%mac%' THEN 'macOS'
                   WHEN mt.device_name ILIKE '%windows%' THEN 'Windows'
                   ELSE NULL
                 END AS os
          FROM mobile_tokens mt
          WHERE mt.user_id = u.id AND mt.revoked_at IS NULL
          ORDER BY COALESCE(mt.last_used_at, mt.created_at) DESC NULLS LAST
          LIMIT 1
        ) dev ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS c FROM audit_log al
          WHERE al.actor_user_id = u.id
            AND al.action IN ('auth.lockout', 'login.lockout', 'account.locked')
            AND al.occurred_at >= now() - interval '24 hours'
        ) lockout ON TRUE
        LEFT JOIN LATERAL (
          -- The user's own modal version in the window — robust against
          -- a stray event from a different build on a shared machine.
          SELECT app_version AS v FROM client_errors ce
          WHERE ce.user_id = u.id AND ce.app_version IS NOT NULL
            AND ce.occurred_at >= now() - interval '24 hours'
          GROUP BY app_version
          ORDER BY COUNT(*) DESC, MAX(ce.occurred_at) DESC
          LIMIT 1
        ) ver ON TRUE
        WHERE ${baseFilters}
      `;

      const statusFilterSql = status === "all"
        ? sql``
        : sql`WHERE "status" = ${status}`;

      const rowsRes = await db.execute<{
        id: number; name: string; username: string; email: string | null; role: string;
        companyId: number | null; companyName: string | null; isActive: boolean;
        lastSeenMobile: string | null; activeMobile: number;
        errorsLast30m: number; errors24h: number;
        stuckLastHour: number; syncingLast5m: number;
        conflicts24h: number; failedUploads24h: number;
        deviceName: string | null; os: string | null;
        appVersion: string | null; status: string;
      }>(sql`
        WITH base AS (${baseSelect})
        SELECT * FROM base
        ${statusFilterSql}
        ORDER BY
          (status = 'stuck') DESC,
          (status = 'locked') DESC,
          ("errorsLast30m" > 0) DESC,
          "lastSeenMobile" DESC NULLS LAST,
          id ASC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const totalRes = await db.execute<{ total: number }>(sql`
        WITH base AS (${baseSelect})
        SELECT COUNT(*)::int AS total FROM base
        ${statusFilterSql}
      `);
      const total = totalRes.rows?.[0]?.total ?? 0;

      const usersList = (rowsRes.rows ?? []).map((u) => ({
        ...u,
        status: u.status as "active" | "offline" | "stuck" | "locked" | "syncing",
        versionLag: !!(latestVersion && u.appVersion && u.appVersion !== latestVersion),
      }));

      res.setHeader("X-Total-Count", String(total));
      res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
      res.json({ users: usersList, total });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthUsers",
        ctx: {},
        fallbackMessage: "Couldn't load users — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Per-user drawer payload — sessions, devices, recent errors.
  app.get("/api/admin/app-health/users/:id", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ message: "Invalid user id" });
        return;
      }
      const userRes = await db.execute<{
        id: number; name: string; username: string; email: string | null; role: string;
        companyId: number | null; companyName: string | null; isActive: boolean; createdAt: string;
      }>(sql`
        SELECT u.id, u.name, u.username, u.email, u.role,
               u.company_id AS "companyId",
               c.name AS "companyName",
               u.is_active AS "isActive",
               u.created_at::text AS "createdAt"
        FROM users u
        LEFT JOIN companies c ON c.id = u.company_id
        WHERE u.id = ${id} AND u.is_deleted = false
      `);
      const user = userRes.rows?.[0];
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      const devicesRes = await db.execute<{
        id: number; deviceName: string | null; lastUsedAt: string | null; createdAt: string;
        revokedAt: string | null; expiresAt: string | null;
      }>(sql`
        SELECT id, device_name AS "deviceName",
               last_used_at::text AS "lastUsedAt",
               created_at::text AS "createdAt",
               revoked_at::text AS "revokedAt",
               expires_at::text AS "expiresAt"
        FROM mobile_tokens
        WHERE user_id = ${id}
        ORDER BY COALESCE(last_used_at, created_at) DESC
        LIMIT 50
      `);
      const recentErrorsRes = await db.execute<{
        id: number; name: string; message: string; severity: string; type: string;
        component: string | null; occurredAt: string; fingerprint: string | null;
      }>(sql`
        SELECT id, name, message, severity, type, component,
               occurred_at::text AS "occurredAt", fingerprint
        FROM client_errors
        WHERE user_id = ${id}
          AND occurred_at >= now() - interval '7 days'
        ORDER BY occurred_at DESC
        LIMIT 50
      `);
      // Approximate session list — derived from distinct session_id
      // values seen in client_errors over the last 7 days.
      const sessionsRes = await db.execute<{
        sessionId: string; firstSeen: string; lastSeen: string; events: number;
      }>(sql`
        SELECT session_id AS "sessionId",
               MIN(occurred_at)::text AS "firstSeen",
               MAX(occurred_at)::text AS "lastSeen",
               COUNT(*)::int AS events
        FROM client_errors
        WHERE user_id = ${id}
          AND session_id IS NOT NULL
          AND occurred_at >= now() - interval '7 days'
        GROUP BY session_id
        ORDER BY MAX(occurred_at) DESC
        LIMIT 25
      `);
      // Recent actions — Task #552 spec. Pulled from the audit_log
      // stream so the drawer surfaces what this user *did* (logins,
      // exports, role changes, …) alongside what crashed for them.
      const recentActionsRes = await db.execute<{
        id: number; occurredAt: string; action: string; actionType: string;
        severity: string; summary: string | null; targetType: string | null; targetId: string | null;
      }>(sql`
        SELECT id,
               occurred_at::text AS "occurredAt",
               action, action_type AS "actionType", severity, summary,
               target_type AS "targetType", target_id AS "targetId"
        FROM audit_log
        WHERE actor_user_id = ${id}
          AND occurred_at >= now() - interval '30 days'
        ORDER BY occurred_at DESC
        LIMIT 50
      `);
      res.json({
        user,
        devices: devicesRes.rows ?? [],
        sessions: sessionsRes.rows ?? [],
        recentErrors: recentErrorsRes.rows ?? [],
        recentActions: recentActionsRes.rows ?? [],
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthUserDetail",
        ctx: {},
        fallbackMessage: "Couldn't load user detail — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Task #554 (Phase 5) — Integrations tab, impersonation, throttle,
  // force-upgrade, user drawer actions. ─────────────────────────────────

  // Catalog of monitored external integrations. Single source of
  // truth lives in `lib/integration-catalog.ts` so the
  // `integrationDownRule` (per-incident runbook URL) and this tab
  // stay in lock-step.
  const CATALOG_BY_SERVICE = INTEGRATION_CATALOG_BY_SERVICE;

  // Status logic mirrors `integrationDownRule` (>5 failures of any
  // single event name in the last 10 minutes ⇒ down). The rule groups
  // by full event `name` (e.g. `qb.token.failed`); we replicate that
  // by tracking `maxNameFail10m` per service. If any single name
  // breaches the rule's threshold the service is marked down here too,
  // so the tab and the active-incidents banner can never disagree.
  const INTEGRATION_FAIL_THRESHOLD = 5;
  const INTEGRATION_WINDOW_MIN = 10;
  function deriveIntegrationStatus(maxNameFail10m: number, fail10m: number, fail1h: number): "healthy" | "degraded" | "down" {
    if (maxNameFail10m > INTEGRATION_FAIL_THRESHOLD) return "down";
    if (fail10m >= 1 || fail1h >= 5) return "degraded";
    return "healthy";
  }

  app.get("/api/admin/app-health/integrations", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      // Aggregate per service over 10m / 1h / 24h windows. Failure
      // criteria mirror `integrationDownRule` exactly: severity error/
      // fatal OR a `*.failed` event name. p95 latency comes from
      // `context->>'duration_ms'`.
      const r = await db.execute<{
        service: string;
        ok10m: number; fail10m: number;
        ok1h: number; fail1h: number;
        ok24h: number; fail24h: number;
        lastEventAt: string | null;
        lastFailureAt: string | null;
        lastFailureMessage: string | null;
        p95Ms: number | null;
      }>(sql`
        SELECT
          split_part(component, '.', 1) AS service,
          COUNT(*) FILTER (
            WHERE occurred_at >= now() - interval '10 minutes'
              AND NOT (severity IN ('error','fatal') OR name LIKE '%.failed')
          )::int AS "ok10m",
          COUNT(*) FILTER (
            WHERE occurred_at >= now() - interval '10 minutes'
              AND (severity IN ('error','fatal') OR name LIKE '%.failed')
          )::int AS "fail10m",
          COUNT(*) FILTER (
            WHERE occurred_at >= now() - interval '1 hour'
              AND NOT (severity IN ('error','fatal') OR name LIKE '%.failed')
          )::int AS "ok1h",
          COUNT(*) FILTER (
            WHERE occurred_at >= now() - interval '1 hour'
              AND (severity IN ('error','fatal') OR name LIKE '%.failed')
          )::int AS "fail1h",
          COUNT(*) FILTER (
            WHERE occurred_at >= now() - interval '24 hours'
              AND NOT (severity IN ('error','fatal') OR name LIKE '%.failed')
          )::int AS "ok24h",
          COUNT(*) FILTER (
            WHERE occurred_at >= now() - interval '24 hours'
              AND (severity IN ('error','fatal') OR name LIKE '%.failed')
          )::int AS "fail24h",
          MAX(occurred_at)::text AS "lastEventAt",
          MAX(occurred_at) FILTER (
            WHERE severity IN ('error','fatal') OR name LIKE '%.failed'
          )::text AS "lastFailureAt",
          (
            SELECT message FROM client_errors c2
            WHERE c2.source = 'integration'
              AND split_part(c2.component, '.', 1) = split_part(client_errors.component, '.', 1)
              AND (c2.severity IN ('error','fatal') OR c2.name LIKE '%.failed')
              AND c2.occurred_at >= now() - interval '24 hours'
            ORDER BY c2.occurred_at DESC
            LIMIT 1
          ) AS "lastFailureMessage",
          (
            percentile_cont(0.95) WITHIN GROUP (
              ORDER BY ((context->>'duration_ms')::int)
            ) FILTER (
              WHERE occurred_at >= now() - interval '1 hour'
                AND context ? 'duration_ms'
            )
          )::int AS "p95Ms"
        FROM client_errors
        WHERE source = 'integration'
          AND component IS NOT NULL
          AND occurred_at >= now() - interval '24 hours'
        GROUP BY split_part(component, '.', 1)
      `);
      const byService = new Map<string, typeof r.rows[number]>();
      for (const row of r.rows ?? []) {
        if (row.service) byService.set(row.service, row);
      }

      // Per-service: maximum failure count across any single event
      // `name` over the last 10 minutes — this is the exact quantity
      // `integrationDownRule` thresholds against, so reusing it here
      // guarantees rule/tab parity.
      const maxNameRows = await db.execute<{ service: string; maxC: number }>(sql`
        SELECT split_part(component, '.', 1) AS service,
               MAX(c)::int AS "maxC"
        FROM (
          SELECT component, name, COUNT(*)::int AS c
          FROM client_errors
          WHERE source = 'integration'
            AND component IS NOT NULL
            AND occurred_at >= now() - interval '${sql.raw(String(INTEGRATION_WINDOW_MIN))} minutes'
            AND (severity IN ('error','fatal') OR name LIKE '%.failed')
          GROUP BY component, name
        ) sub
        GROUP BY split_part(component, '.', 1)
      `);
      const maxByService = new Map<string, number>();
      for (const row of maxNameRows.rows ?? []) {
        if (row.service) maxByService.set(row.service, row.maxC ?? 0);
      }

      type IntegrationOut = {
        service: string;
        label: string;
        purpose: string;
        runbookUrl: string;
        status: "healthy" | "degraded" | "down";
        ok10m: number; fail10m: number;
        ok1h: number; fail1h: number;
        ok24h: number; fail24h: number;
        successRate24h: number | null;
        p95Ms: number | null;
        lastEventAt: string | null;
        lastFailureAt: string | null;
        lastFailureMessage: string | null;
      };

      function build(svc: string, meta: { label: string; purpose: string; runbookUrl: string }): IntegrationOut {
        const row = byService.get(svc);
        const fail10m = row?.fail10m ?? 0;
        const fail1h = row?.fail1h ?? 0;
        const ok24h = row?.ok24h ?? 0;
        const fail24h = row?.fail24h ?? 0;
        const total24h = ok24h + fail24h;
        const maxNameFail10m = maxByService.get(svc) ?? 0;
        return {
          service: svc,
          label: meta.label,
          purpose: meta.purpose,
          runbookUrl: meta.runbookUrl,
          status: deriveIntegrationStatus(maxNameFail10m, fail10m, fail1h),
          ok10m: row?.ok10m ?? 0,
          fail10m,
          ok1h: row?.ok1h ?? 0,
          fail1h,
          ok24h,
          fail24h,
          successRate24h: total24h === 0 ? null : Math.round((ok24h / total24h) * 1000) / 10,
          p95Ms: row?.p95Ms ?? null,
          lastEventAt: row?.lastEventAt ?? null,
          lastFailureAt: row?.lastFailureAt ?? null,
          lastFailureMessage: row?.lastFailureMessage ?? null,
        };
      }

      const services: IntegrationOut[] = INTEGRATION_CATALOG.map((c) => build(c.service, c));
      // Surface unknown services we've never enumerated above so the
      // tab stays useful as new integrations come online.
      for (const [svc] of byService) {
        if (CATALOG_BY_SERVICE.has(svc)) continue;
        services.push(build(svc, getIntegrationMeta(svc)));
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        services,
        statusRule: {
          ruleId: "integration_down",
          windowMin: INTEGRATION_WINDOW_MIN,
          failThreshold: INTEGRATION_FAIL_THRESHOLD,
          summary: `>${INTEGRATION_FAIL_THRESHOLD} failures of any single integration event name in ${INTEGRATION_WINDOW_MIN}m`,
        },
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthIntegrations",
        ctx: {},
        fallbackMessage: "Couldn't load integrations — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.get("/api/admin/app-health/integrations/:service/recent-failures", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const svc = String(req.params.service).slice(0, 64).replace(/[^a-z0-9_-]/gi, "");
      if (!svc) { res.status(400).json({ message: "Invalid service" }); return; }
      const r = await db.execute<{
        id: number; name: string; message: string; component: string | null;
        statusCode: number | null; durationMs: number | null; occurredAt: string;
      }>(sql`
        SELECT id, name, message, component,
               (context->>'status_code')::int AS "statusCode",
               (context->>'duration_ms')::int AS "durationMs",
               occurred_at::text AS "occurredAt"
        FROM client_errors
        WHERE source = 'integration'
          AND (severity IN ('error','fatal') OR name LIKE '%.failed')
          AND split_part(component, '.', 1) = ${svc}
          AND occurred_at >= now() - interval '24 hours'
        ORDER BY occurred_at DESC
        LIMIT 50
      `);
      const meta = getIntegrationMeta(svc);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        service: svc,
        label: meta.label,
        purpose: meta.purpose,
        runbookUrl: meta.runbookUrl,
        failures: r.rows ?? [],
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthIntegrationFailures",
        ctx: { service: req.params.service },
        fallbackMessage: "Couldn't load recent failures — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Throttle a tenant's API rate (per company, time-bound) ────────────
  app.post("/api/admin/app-health/companies/:id/throttle", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ message: "Invalid company id" }); return;
      }
      const body = (req.body ?? {}) as { rateLimit?: unknown; durationMinutes?: unknown; clear?: unknown };
      if (body.clear === true) {
        await clearCompanyThrottle(id);
        await recordAuditEvent(req, {
          actorUserId: req.authenticatedUserId ?? null,
          actorRole: req.authenticatedUserRole ?? null,
          actionType: "admin",
          action: "tenant.throttle.clear",
          severity: "warning",
          targetType: "company",
          targetId: String(id),
          summary: `Cleared API throttle for company ${id}`,
        });
        res.json({ ok: true, throttle: null });
        return;
      }
      const rateLimit = Number(body.rateLimit);
      const durationMinutes = Number(body.durationMinutes);
      if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000) {
        res.status(400).json({ message: "rateLimit must be 1-100000 requests/minute" }); return;
      }
      if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 24 * 60) {
        res.status(400).json({ message: "durationMinutes must be 1-1440" }); return;
      }
      const cfg = await setCompanyThrottle(id, rateLimit, Math.floor(durationMinutes), req.authenticatedUserId ?? null);
      await recordAuditEvent(req, {
        actorUserId: req.authenticatedUserId ?? null,
        actorRole: req.authenticatedUserRole ?? null,
        actionType: "admin",
        action: "tenant.throttle.set",
        severity: "warning",
        targetType: "company",
        targetId: String(id),
        summary: `Throttled company ${id} to ${rateLimit} req/min for ${Math.floor(durationMinutes)}m`,
        details: { rateLimit, durationMinutes: Math.floor(durationMinutes), expiresAt: new Date(cfg.expiresAt).toISOString() },
      });
      res.json({ ok: true, throttle: { ...cfg, expiresAt: new Date(cfg.expiresAt).toISOString() } });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthSetThrottle",
        ctx: { id: req.params.id },
        fallbackMessage: "Couldn't update throttle — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.get("/api/admin/app-health/throttles", requireAuthentication, (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    const items = listActiveThrottles().map((t) => ({
      ...t,
      expiresAt: new Date(t.expiresAt).toISOString(),
      setAt: new Date(t.setAt).toISOString(),
    }));
    res.setHeader("Cache-Control", "no-store");
    res.json({ throttles: items });
  });

  // ── Force minimum app version (frontend hard-reloads to drop stale clients)
  //
  // Two routes intentionally mount the same handler so the API
  // contract is unambiguous:
  //   POST /api/admin/app-health/companies/:id/force-upgrade  → company scope
  //   POST /api/admin/app-health/force-upgrade                → global scope
  // The body's `scope` field is still respected for back-compat, but
  // callers (and tests) should prefer the matching URL.
  const forceUpgradeHandler = async (req: any, res: any) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const isGlobalRoute = !req.params.id;
      const id = isGlobalRoute ? 0 : Number(req.params.id);
      if (!isGlobalRoute && (!Number.isInteger(id) || id <= 0)) {
        res.status(400).json({ message: "Invalid company id" }); return;
      }
      const body = (req.body ?? {}) as { minAppVersion?: unknown; scope?: unknown };
      const minAppVersion = typeof body.minAppVersion === "string" ? body.minAppVersion.slice(0, 200) : "";
      // The route URL is authoritative — `/companies/:id/force-upgrade`
      // is always company scope, the dedicated `/force-upgrade` route
      // is always global. Body `scope` is honored only as a legacy
      // back-compat (matching the previous "scope: 'global'" shape).
      const scope = isGlobalRoute || body.scope === "global" ? "global" : "company";
      if (!minAppVersion) { res.status(400).json({ message: "minAppVersion required" }); return; }
      const setAt = new Date().toISOString();
      const value = JSON.stringify({ minAppVersion, scope, companyId: scope === "company" ? id : null, setAt, setBy: req.authenticatedUserId ?? null });
      const key = scope === "global" ? "minAppVersion:global" : `minAppVersion:company:${id}`;
      await db.execute(sql`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (${key}, ${value}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `);
      await recordAuditEvent(req, {
        actorUserId: req.authenticatedUserId ?? null,
        actorRole: req.authenticatedUserRole ?? null,
        actionType: "deploy",
        action: "deploy.force_upgrade",
        severity: "warning",
        targetType: scope === "company" ? "company" : "global",
        targetId: scope === "company" ? String(id) : null,
        summary: `Forced upgrade to ${minAppVersion.slice(0, 12)} (${scope})`,
        details: { minAppVersion, scope, companyId: scope === "company" ? id : null },
      });
      res.json({ ok: true, minAppVersion, scope, setAt });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthForceUpgrade",
        ctx: { id: req.params.id ?? "global" },
        fallbackMessage: "Couldn't force upgrade — please retry",
      });
      res.status(status).json({ message });
    }
  };
  app.post("/api/admin/app-health/companies/:id/force-upgrade", requireAuthentication, forceUpgradeHandler);
  app.post("/api/admin/app-health/force-upgrade", requireAuthentication, forceUpgradeHandler);

  // Public, unauthenticated — every browser session polls this every 5
  // minutes (see main.tsx) to learn the current minimum. Returns the
  // global pin or, when the caller passes ?company_id=N, the more
  // specific company pin if one exists.
  app.get("/api/config/min-app-version", async (req, res) => {
    try {
      const cidRaw = typeof req.query.company_id === "string" ? Number(req.query.company_id) : NaN;
      const keys: string[] = ["minAppVersion:global"];
      if (Number.isInteger(cidRaw) && cidRaw > 0) keys.unshift(`minAppVersion:company:${cidRaw}`);
      const r = await db.execute<{ key: string; value: string }>(sql`
        SELECT key, value FROM app_settings WHERE key = ANY(${keys})
      `);
      let chosen: { minAppVersion: string; scope: string; setAt: string } | null = null;
      // Prefer the company-specific pin when present, then global.
      const ordered = [...(r.rows ?? [])].sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
      for (const row of ordered) {
        try {
          const parsed = JSON.parse(row.value) as { minAppVersion?: string; scope?: string; setAt?: string };
          if (parsed?.minAppVersion) {
            chosen = {
              minAppVersion: parsed.minAppVersion,
              scope: parsed.scope ?? "global",
              setAt: parsed.setAt ?? new Date().toISOString(),
            };
            break;
          }
        } catch { /* ignore */ }
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(chosen ?? { minAppVersion: null, scope: null, setAt: null });
    } catch {
      res.json({ minAppVersion: null, scope: null, setAt: null });
    }
  });

  // ── Impersonation lifecycle. The frontend swaps `localStorage.user`
  // to the target on start and restores the original on end; the server
  // contributes the audit trail and the lookup. The impersonation
  // banner reads this same payload to decorate every screen.
  app.post("/api/admin/app-health/impersonate/start", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const body = (req.body ?? {}) as { userId?: unknown; reason?: unknown };
      const userId = Number(body.userId);
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
      if (!Number.isInteger(userId) || userId <= 0) {
        res.status(400).json({ message: "Invalid userId" }); return;
      }
      const r = await db.execute<{
        id: number; name: string; username: string; email: string | null; role: string;
        companyId: number | null; companyName: string | null; isActive: boolean;
      }>(sql`
        SELECT u.id, u.name, u.username, u.email, u.role,
               u.company_id AS "companyId",
               c.name AS "companyName",
               u.is_active AS "isActive"
        FROM users u
        LEFT JOIN companies c ON c.id = u.company_id
        WHERE u.id = ${userId} AND u.is_deleted = false
      `);
      const target = r.rows?.[0];
      if (!target) { res.status(404).json({ message: "User not found" }); return; }
      if (target.role === "super_admin") {
        res.status(403).json({ message: "Cannot impersonate another super admin" }); return;
      }
      // Mint a server-signed impersonation token bound to the
      // super-admin actor + chosen target. The frontend stores it and
      // sends it via `x-impersonation-token`; `requireAuthentication`
      // verifies the signature on every request and swaps the
      // effective identity to the target while remembering the actor.
      const { token, claims } = mintImpersonationToken(req.authenticatedUserId ?? 0, target.id);
      await recordAuditEvent(req, {
        actorUserId: req.authenticatedUserId ?? null,
        actorRole: req.authenticatedUserRole ?? null,
        actionType: "impersonation",
        action: "auth.impersonation.start",
        severity: "warning",
        targetType: "user",
        targetId: String(target.id),
        summary: `Started impersonating ${target.username} (${target.role})`,
        details: {
          targetUserId: target.id,
          targetUsername: target.username,
          targetCompanyId: target.companyId,
          reason: reason || null,
          jti: claims.jti,
          tokenExpiresAt: new Date(claims.exp).toISOString(),
        },
      });
      res.json({
        ok: true,
        target,
        impersonationToken: token,
        expiresAt: new Date(claims.exp).toISOString(),
      });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthImpersonateStart",
        ctx: {},
        fallbackMessage: "Couldn't start impersonation — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Called after the client has dropped the impersonation token locally
  // and restored the super-admin headers. Body carries the previously
  // impersonated user id and the token to revoke for the audit trail.
  app.post("/api/admin/app-health/impersonate/end", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const body = (req.body ?? {}) as { previousUserId?: unknown; impersonationToken?: unknown };
      const prev = Number(body.previousUserId);
      const tok = typeof body.impersonationToken === "string" ? body.impersonationToken : null;
      if (tok) {
        try { revokeImpersonationToken(tok); } catch { /* best-effort */ }
      }
      await recordAuditEvent(req, {
        actorUserId: req.authenticatedUserId ?? null,
        actorRole: req.authenticatedUserRole ?? null,
        actionType: "impersonation",
        action: "auth.impersonation.end",
        severity: "info",
        targetType: Number.isInteger(prev) && prev > 0 ? "user" : null,
        targetId: Number.isInteger(prev) && prev > 0 ? String(prev) : null,
        summary: Number.isInteger(prev) && prev > 0 ? `Ended impersonation of user ${prev}` : "Ended impersonation",
      });
      res.json({ ok: true });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthImpersonateEnd",
        ctx: {},
        fallbackMessage: "Couldn't end impersonation — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── Resolve a company's primary admin (for "Open as company admin"
  //    impersonation flow) and the admin email list (for "Email admin").
  app.get("/api/admin/app-health/companies/:id/admins", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ message: "Invalid company id" }); return;
      }
      const r = await db.execute<{
        id: number; name: string; username: string; email: string | null;
        role: string; lastSeenAt: string | null;
      }>(sql`
        SELECT u.id, u.name, u.username, u.email, u.role,
               NULL::text AS "lastSeenAt"
        FROM users u
        WHERE u.company_id = ${id}
          AND u.is_deleted = false
          AND u.is_active = true
          AND u.role IN ('company_admin', 'irrigation_manager')
        ORDER BY (u.role = 'company_admin') DESC
        LIMIT 20
      `);
      const admins = r.rows ?? [];
      // Primary = first company_admin, else first manager.
      const primary = admins[0] ?? null;
      res.setHeader("Cache-Control", "no-store");
      res.json({ admins, primary });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthCompanyAdmins",
        ctx: { id: req.params.id },
        fallbackMessage: "Couldn't load company admins — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Audit emit for the Email-admin click — the actual mailto: opens
  // client-side, but we record the intent here so the audit trail
  // shows the super-admin reached out.
  app.post("/api/admin/app-health/companies/:id/email-admin", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ message: "Invalid company id" }); return;
      }
      const body = (req.body ?? {}) as { recipientUserId?: unknown; subject?: unknown };
      const recipientUserId = Number(body.recipientUserId);
      const subject = typeof body.subject === "string" ? body.subject.slice(0, 200) : "";
      await recordAuditEvent(req, {
        actorUserId: req.authenticatedUserId ?? null,
        actorRole: req.authenticatedUserRole ?? null,
        actionType: "admin",
        action: "tenant.email_admin",
        severity: "info",
        targetType: "company",
        targetId: String(id),
        summary: `Opened email composer to company ${id}` + (subject ? ` re: ${subject}` : ""),
        details: { recipientUserId: Number.isInteger(recipientUserId) ? recipientUserId : null, subject: subject || null },
      });
      res.json({ ok: true });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthEmailAdmin",
        ctx: { id: req.params.id },
        fallbackMessage: "Couldn't record email-admin event — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ── User-drawer actions: Reset MFA, Unlock account ────────────────────
  app.post("/api/admin/app-health/users/:id/reset-mfa", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ message: "Invalid user id" }); return; }
      const r = await db.execute<{ id: number; username: string; mfaEnabled: boolean }>(sql`
        UPDATE users SET
          mfa_enabled = false,
          mfa_secret = NULL,
          mfa_backup_codes = NULL,
          mfa_last_used = NULL,
          updated_at = now()
        WHERE id = ${id} AND is_deleted = false
        RETURNING id, username, mfa_enabled AS "mfaEnabled"
      `);
      const u = r.rows?.[0];
      if (!u) { res.status(404).json({ message: "User not found" }); return; }
      await recordAuditEvent(req, {
        actorUserId: req.authenticatedUserId ?? null,
        actorRole: req.authenticatedUserRole ?? null,
        actionType: "user",
        action: "user.mfa.reset",
        severity: "warning",
        targetType: "user",
        targetId: String(id),
        summary: `Reset MFA for ${u.username}`,
      });
      res.json({ ok: true, user: u });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthResetMfa",
        ctx: { id: req.params.id },
        fallbackMessage: "Couldn't reset MFA — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.post("/api/admin/app-health/users/:id/unlock", requireAuthentication, async (req, res) => {
    if (!requireSuperAdminGuard(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ message: "Invalid user id" }); return; }
      const r = await db.execute<{ id: number; username: string; isActive: boolean }>(sql`
        UPDATE users SET is_active = true, updated_at = now()
        WHERE id = ${id} AND is_deleted = false
        RETURNING id, username, is_active AS "isActive"
      `);
      const u = r.rows?.[0];
      if (!u) { res.status(404).json({ message: "User not found" }); return; }
      await recordAuditEvent(req, {
        actorUserId: req.authenticatedUserId ?? null,
        actorRole: req.authenticatedUserRole ?? null,
        actionType: "user",
        action: "user.unlock",
        severity: "info",
        targetType: "user",
        targetId: String(id),
        summary: `Unlocked / reactivated ${u.username}`,
      });
      res.json({ ok: true, user: u });
    } catch (e) {
      const { status, message } = classifyAndLog(req, e, {
        op: "appHealthUnlockUser",
        ctx: { id: req.params.id },
        fallbackMessage: "Couldn't unlock user — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Serve company logo images directly (binary response)
  app.get("/api/company-logo/:logoId", async (req, res) => {
    const logoId = req.params.logoId;
    console.log(`[LOGO-SERVE] Serving logo directly: ${logoId}`);
    
    try {
      const objectStorageService = new ObjectStorageService();
      
      // Search for the file
      const file = await objectStorageService.searchPublicObject(`company-logos/${logoId}`);
      
      if (!file) {
        console.log(`[LOGO-SERVE] Logo file not found: ${logoId}`);
        res.status(404).json({ error: "Logo not found" });
        return;
      }
      
      console.log(`[LOGO-SERVE] Logo file found, downloading...`);
      
      // Serve the image directly.
      // Use a 1-hour public cache with a 24-hour stale-while-revalidate window
      // so the browser skips the network round-trip on repeated navigations
      // (important on slow field-LTE connections). The logoId in the URL is the
      // object-storage filename, so a new upload always produces a new URL —
      // no cache-busting query string is needed.
      objectStorageService.downloadObject(file, res, 3600, {
        cacheControlOverride: "public, max-age=3600, stale-while-revalidate=86400",
      });
      
    } catch (error) {
      console.error(`[LOGO-SERVE] Error serving logo ${logoId}:`, error);
      res.status(500).json({ error: "Failed to serve logo" });
      return;
    }
  });

  // Company routes
  app.get("/api/companies", requireAuthentication, async (req, res) => {
    try {
      const companies = await storage.getCompanies();
      res.json(companies);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch companies" });
    }
  });

  app.post("/api/companies", requireAuthentication, async (req, res) => {
    try {
      const userRole = req.authenticatedUserRole;
      if (userRole !== 'super_admin') {
        res.status(403).json({ message: "Access denied. Super admin only." });
        return;
      }
      const company = await storage.createCompany(req.body);
      res.status(201).json(company);
    } catch (error) {
      console.error("Error creating company:", error instanceof Error ? error.message : error);
      res.status(500).json({ message: "Failed to create company" });
    }
  });

  // Super admin routes for companies
  app.put("/api/companies/:id", requireAuthentication, async (req, res) => {
    try {
      const userRole = req.authenticatedUserRole;
      if (userRole !== 'super_admin' && userRole !== 'company_admin') {
        res.status(403).json({ message: "Access denied." });
        return;
      }
      const companyId = parseInt(req.params.id);
      const updatedCompany = await storage.updateCompany(companyId, req.body);
      if (!updatedCompany) {
        res.status(404).json({ message: "Company not found" });
        return;
      }
      res.json(updatedCompany);
    } catch (error) {
      console.error("Error updating company:", error instanceof Error ? error.message : error);
      res.status(500).json({ message: "Failed to update company" });
    }
  });

  app.delete("/api/companies/:id", requireAuthentication, async (req, res) => {
    try {
      const userRole = req.authenticatedUserRole;
      if (userRole !== 'super_admin') {
        res.status(403).json({ message: "Access denied. Super admin only." });
        return;
      }
      const companyId = parseInt(req.params.id);
      const success = await storage.deleteCompany(companyId);
      if (!success) {
        res.status(404).json({ message: "Company not found" });
        return;
      }
      res.json({ message: "Company deleted successfully" });
    } catch (error) {
      console.error("Error deleting company:", error instanceof Error ? error.message : error);
      res.status(500).json({ message: "Failed to delete company" });
    }
  });

  // Company Profile Management (Company Admin only)
  app.get("/api/company/:companyId/profile", requireAuthentication, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const userRole = req.authenticatedUserRole;
      const userCompanyId = req.authenticatedUserCompanyId;

      // Allow company admins and irrigation managers to view their own company profile
      const allowedRoles = ['company_admin', 'irrigation_manager'];
      if (!allowedRoles.includes(userRole as string) || userCompanyId !== companyId) {
        res.status(403).json({ message: "Access denied. You can only view your own company profile." });
        return;
      }

      const company = await storage.getCompanyProfile(companyId);
      if (!company) {
        res.status(404).json({ message: "Company profile not found", requiresSetup: true });
        return;
      }
      res.json(company);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch company profile" });
    }
  });

  // Create company profile (for first-time setup)
  app.post("/api/company/:companyId/profile", requireAuthentication, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const userRole = req.authenticatedUserRole;
      const userCompanyId = req.authenticatedUserCompanyId;

      // Only company admins can create their own company profile
      if (userRole !== 'company_admin' || userCompanyId !== companyId) {
        res.status(403).json({ message: "Access denied. Company admins can only manage their own company profile." });
        return;
      }

      // Check if company profile already exists
      const existingCompany = await storage.getCompanyProfile(companyId);
      if (existingCompany) {
        res.status(409).json({ message: "Company profile already exists" });
        return;
      }

      const companyData = insertCompanySchema.parse({ ...req.body, id: companyId });
      const company = await storage.createCompanyProfile(companyData);
      res.status(201).json(company);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid company data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to create company profile" });
    }
  });

  // Check if company profile setup is required
  app.get("/api/company/:companyId/setup-status", requireAuthentication, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const userRole = req.authenticatedUserRole;
      const userCompanyId = req.authenticatedUserCompanyId;

      // Only company admins can check their own company setup status
      if (userRole !== 'company_admin' || userCompanyId !== companyId) {
        res.status(403).json({ message: "Access denied" });
        return;
      }

      const exists = await storage.checkCompanyProfileExists(companyId);
      res.json({ requiresSetup: !exists, companyId });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to check setup status" });
    }
  });

  app.put("/api/company/:companyId/profile", requireAuthentication, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const userRole = req.authenticatedUserRole;
      const userCompanyId = req.authenticatedUserCompanyId;

      // Only company admins can update their own company profile
      if (userRole !== 'company_admin' || userCompanyId !== companyId) {
        res.status(403).json({ message: "Access denied. Company admins can only manage their own company profile." });
        return;
      }

      const updates = insertCompanySchema.partial().parse(req.body);
      
      // Server-side guard: a missing or blank logo in a profile update must
      // never clobber the stored logo. Only PUT /api/company/:id/logo and
      // PUT /api/company/:id/logo-reset are the authorised paths for logo
      // changes. Strip it here so a stale form value can't blank the logo.
      if (!updates.logo) {
        delete updates.logo;
      } else {
        // Normalise the path when a non-empty value is present (shouldn't
        // normally arrive via the profile form, but guard it anyway).
        const objectStorageService = new ObjectStorageService();
        updates.logo = objectStorageService.normalizeLogoPath(updates.logo);
      }
      
      const updatedCompany = await storage.updateCompanyProfile(companyId, updates);
      res.json(updatedCompany);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid company data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to update company profile" });
    }
  });

  // Company logo upload endpoint
  app.post("/api/company/logo/upload", requireAuthentication, async (req, res) => {
    try {
      const userRole = req.authenticatedUserRole;
      
      // Only company admins and super admins can upload logos
      if (userRole !== 'company_admin' && userRole !== 'super_admin') {
        res.status(403).json({ message: "Access denied. Only company admins can upload logos." });
        return;
      }

      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getCompanyLogoUploadURL();
      
      res.json({ 
        method: 'PUT' as const,
        url: uploadURL 
      });
    } catch (error) {
      console.error(error);
      // Production error logging would go to monitoring service
      res.status(500).json({ message: "Failed to generate upload URL" });
    }
  });

  // Reset/clear company logo
  app.put("/api/company/:companyId/logo-reset", requireAuthentication, async (req, res) => {
    try {
      const userRole = req.authenticatedUserRole;
      const companyId = parseInt(req.params.companyId);
      
      if (userRole !== 'company_admin' && userRole !== 'super_admin') {
        res.status(403).json({ message: "Access denied. Only company admins can reset logos." });
        return;
      }

      // Direct database update to ensure logo is cleared
      const result = await db
        .update(companies)
        .set({ logo: null, updatedAt: new Date() })
        .where(eq(companies.id, companyId))
        .returning();

      if (!result || result.length === 0) {
        res.status(404).json({ message: "Company not found" });
        return;
      }

      res.json({ 
        message: "Logo cleared successfully",
        company: result[0]
      });
    } catch (error) {
      console.error('Logo reset error:', error);
      res.status(500).json({ message: "Failed to clear company logo" });
    }
  });

  // Update company logo after upload
  app.put("/api/company/:companyId/logo", requireAuthentication, async (req, res) => {
    try {
      const userRole = req.authenticatedUserRole;
      const companyId = parseInt(req.params.companyId);
      const { logoUrl } = req.body;
      
      // Production-ready logo update processing
      
      // Only company admins and super admins can update logos
      if (userRole !== 'company_admin' && userRole !== 'super_admin') {
        res.status(403).json({ message: "Access denied. Only company admins can update logos." });
        return;
      }

      if (!logoUrl) {
        res.status(400).json({ message: "Logo URL is required" });
        return;
      }

      // Normalize the signed GCS URL to the stable company-logos/<uuid> path.
      // Display components (CompanyLogoBanner, Navigation) build the public
      // /api/company-logo/<id> URL at render time from this stored path, so we
      // store the path — not the public URL — to keep the DB value stable.
      const objectStorageService = new ObjectStorageService();
      const logoPath = objectStorageService.normalizeLogoPath(logoUrl);

      // Update company with the normalized path
      const updatedCompany = await storage.updateCompany(companyId, { 
        logo: logoPath 
      });

      if (!updatedCompany) {
        res.status(404).json({ message: "Company not found" });
        return;
      }

      // Build the public URL for the response so the client can display it
      // immediately without an extra profile refetch.
      const publicUrl = objectStorageService.getCompanyLogoPublicURL(logoPath);

      res.json({ 
        message: "Logo updated successfully", 
        logoUrl: publicUrl 
      });
    } catch (error) {
      console.error(error);
      // Production error logging would go to monitoring service
      res.status(500).json({ message: "Failed to update company logo" });
    }
  });

  // Removed - moved to top of registerRoutes function

  // Middleware to check if company profile setup is complete
  const requireCompanySetup = async (req: any, res: any, next: any) => {
    try {
      let userRole = req.authenticatedUserRole || headerUserRole(req);
      let userCompanyId = req.authenticatedUserCompanyId || (headerUserCompanyId(req) ? parseInt(headerUserCompanyId(req) as string) : null);

      // Production session-based fallback
      if (!userRole && req.session && req.session.userId) {
        try {
          const user = await storage.getUser(parseInt(String(req.session.userId)));
          if (user) {
            userRole = user.role;
            userCompanyId = user.companyId;
          }
        } catch (dbError) {
          // Continue
        }
      }

      if (userRole === 'company_admin' && userCompanyId) {
        const companyExists = await storage.checkCompanyProfileExists(userCompanyId);
        if (!companyExists) {
          res.status(423).json({ 
            message: "Company profile setup required", 
            requiresSetup: true,
            companyId: userCompanyId 
          });
          return;
        }
      }
      next();
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to check company setup status" });
    }
  };

  // Super Admin: Create company admin (placeholder company + admin user)
  app.post("/api/super-admin/create-company-admin", requireAuthentication, async (req, res) => {
    try {
      const userRole = req.authenticatedUserRole;
      
      if (userRole !== 'super_admin') {
        res.status(403).json({ message: "Access denied. Super admin only." });
        return;
      }

      const { adminEmail, adminPassword, startingEstimateNumber } = req.body;

      // Check if user already exists
      const existingUser = await storage.getUserByUsername(adminEmail);
      if (existingUser) {
        res.status(400).json({ message: "A user with this email already exists" });
        return;
      }

      // Task #669 — super-admin can configure the starting estimate
      // number at onboarding time. `storage.createCompany` mirrors the
      // value into `nextEstimateNumber` so the very first allocation
      // for this company lands at the configured seed.
      const startNum =
        typeof startingEstimateNumber === "number" && Number.isFinite(startingEstimateNumber)
          ? Math.trunc(startingEstimateNumber)
          : undefined;
      if (startNum !== undefined && startNum < 10000) {
        res.status(400).json({ message: "Starting estimate number must be at least 5 digits" });
        return;
      }

      // Create placeholder company first (admin will complete setup)
      const companyData = {
        name: `Company for ${adminEmail} (Setup Required)`,
        address: '',
        phone: '',
        email: '',
        website: '',
        subscription: 'basic',
        ...(startNum !== undefined ? { startingEstimateNumber: startNum } : {}),
      };

      const company = await storage.createCompany(companyData);

      // Create admin user with minimal info
      const userData = {
        username: adminEmail,
        password: adminPassword,
        name: 'Company Admin', // Placeholder - they'll update on first login
        email: adminEmail,
        role: 'company_admin' as const,
        companyId: company.id,
        isActive: true,
        emailVerified: false // They'll need to verify on first login
      };

      const user = await storage.createUser(userData);

      res.status(201).json({ company, user });
    } catch (error) {
      console.error('Error creating company admin:', error);
      res.status(500).json({ message: "Failed to create company admin" });
    }
  });

  app.get("/api/admin/system-stats", requireAuthentication, async (req, res) => {
    try {
      if (req.authenticatedUserRole !== 'super_admin') {
        res.status(403).json({ message: "Forbidden: super_admin only" });
        return;
      }
      const users = await storage.getUsers();
      res.json({
        totalUsers: users.length,
        activeUsers: users.filter(u => u.isActive).length,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch system stats" });
    }
  });

  // User routes
  // Role rank for ceiling checks (higher = more privileged).
  // Every role in the registry needs an entry — an unlisted role falls back to
  // rank 0, which makes it unassignable by anyone below super_admin.
  const ROLE_RANK: Record<string, number> = {
    super_admin: 4,
    company_admin: 3,
    billing_manager: 2,
    irrigation_manager: 2,
    bookkeeper: 2, // Task #1886 — same rank as the other non-admin company roles.
    field_tech: 1,
  };

  app.get("/api/users", requireAuthentication, async (req, res) => {
    try {
      const users = await storage.getUsers();
      // Remove passwords for security
      const usersWithoutPasswords = users.map(({ password, ...user }) => user);
      res.json(usersWithoutPasswords);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Get field technicians and irrigation managers (for work order assignments)
  app.get("/api/users/field-techs", requireAuthentication, async (req, res) => {
    try {
      const users = await storage.getUsers();
      const assignableUsers = users
        .filter(user => (user.role === 'field_tech' || user.role === 'irrigation_manager') && user.isActive)
        .map(({ password, ...user }) => user);
      res.json(assignableUsers);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch assignable users" });
    }
  });

  // User management routes for system admin
  app.post("/api/users", requireAuthentication, async (req, res) => {
    try {
      if (req.authenticatedUserRole !== 'super_admin') {
        res.status(403).json({ message: "Forbidden: super_admin only" });
        return;
      }
      const userData = insertUserSchema.parse(req.body);
      const user = await storage.createUser(userData);
      // Remove password from response
      const { password: _, ...userWithoutPassword } = user;
      res.status(201).json(userWithoutPassword);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid user data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  // Super admin routes for users
  app.put("/api/users/:id", requireAuthentication, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const callerRole = req.authenticatedUserRole;
      const callerCompanyId = req.authenticatedUserCompanyId ?? null;
      const userData = insertUserSchema.partial().parse(req.body);
      const before = await storage.getUser(userId);
      // Cross-company guard: non-super_admin callers can only edit users in their own company.
      if (callerRole !== 'super_admin' && before && before.companyId !== callerCompanyId) {
        res.status(403).json({ message: "Forbidden: cannot edit users from another company" });
        return;
      }
      // Role-ceiling guard: only fires when the role is actually changing (so
      // echoing the existing role in a self-edit is never blocked).
      if (userData.role && userData.role !== before?.role && callerRole !== 'super_admin') {
        const callerRank = ROLE_RANK[callerRole ?? ''] ?? 0;
        const targetRank = ROLE_RANK[userData.role] ?? 0;
        if (targetRank >= callerRank) {
          res.status(403).json({ message: "Forbidden: cannot assign a role at or above your own" });
          return;
        }
      }
      const user = await storage.updateUser(userId, userData);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      // Task #551 (Phase 2) — surface role/active flips to the audit log.
      if (before) {
        const actor = req.authenticatedUserId ?? (headerUserId(req) ? Number(headerUserId(req)) || null : null);
        const actorRole = req.authenticatedUserRole ?? headerUserRole(req) ?? null;
        if (userData.role && userData.role !== before.role) {
          void recordAuditEvent(req, {
            actorUserId: actor,
            actorRole,
            actionType: "role_change",
            action: "user.role_changed",
            severity: "warning",
            targetType: "user",
            targetId: String(user.id),
            summary: `${before.username}: ${before.role} → ${userData.role}`,
            details: { from: before.role, to: userData.role },
          });
        }
        if (userData.isActive != null && userData.isActive !== before.isActive) {
          void recordAuditEvent(req, {
            actorUserId: actor,
            actorRole,
            actionType: "admin",
            action: userData.isActive ? "user.reactivated" : "user.deactivated",
            severity: "warning",
            targetType: "user",
            targetId: String(user.id),
            summary: `${before.username} ${userData.isActive ? "reactivated" : "deactivated"}`,
          });
        }
      }
      // Remove password from response
      const { password: _, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid user data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  // Check user's data dependencies before deletion
  app.get("/api/users/:id/dependencies", requireAuthentication, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const dependencies = await storage.getUserDataDependencies(userId);
      res.json(dependencies);
    } catch (error) {
      console.error('Failed to check user dependencies:', error);
      res.status(500).json({ message: "Failed to check user dependencies" });
    }
  });

  // Soft delete user (recommended for users with completed work)
  app.post("/api/users/:id/soft-delete", requireAuthentication, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const user = await storage.getUser(userId);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      
      const success = await storage.softDeleteUser(userId);
      if (!success) {
        res.status(500).json({ message: "Failed to delete user" });
        return;
      }
      
      res.json({ 
        message: "User deleted successfully (soft delete - data preserved)",
        deletedUser: { id: user.id, name: user.name }
      });
    } catch (error) {
      console.error('Failed to soft delete user:', error);
      res.status(500).json({ message: "Failed to delete user" });
    }
  });

  // Hard delete user with cascade (use with caution)
  app.delete("/api/users/:id/hard-delete", requireAuthentication, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const user = await storage.getUser(userId);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      
      const success = await storage.hardDeleteUserWithCascade(userId);
      if (!success) {
        res.status(500).json({ message: "Failed to delete user" });
        return;
      }
      
      res.json({ 
        message: "User permanently deleted with data cleanup",
        deletedUser: { id: user.id, name: user.name }
      });
    } catch (error) {
      console.error('Failed to hard delete user:', error);
      res.status(500).json({ message: "Failed to delete user" });
    }
  });

  // Original delete endpoint (kept for compatibility but updated to use soft delete by default)
  app.delete("/api/users/:id", requireAuthentication, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const user = await storage.getUser(userId);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      // Check if user has dependencies
      const dependencies = await storage.getUserDataDependencies(userId);
      const hasData = dependencies.hasWorkOrders || dependencies.hasBillingSheets;

      if (hasData) {
        // Use soft delete for users with data
        const success = await storage.softDeleteUser(userId);
        if (!success) {
          res.status(500).json({ message: "Failed to delete user" });
          return;
        }
        res.json({ 
          message: "User deleted successfully (soft delete - data preserved)",
          type: "soft_delete",
          preservedData: {
            workOrders: dependencies.workOrderCount,
            billingSheets: dependencies.billingSheetCount
          }
        });
      } else {
        // Use hard delete for users without dependencies
        const success = await storage.deleteUser(userId);
        if (!success) {
          res.status(500).json({ message: "Failed to delete user" });
          return;
        }
        res.json({ 
          message: "User deleted successfully (permanent deletion)",
          type: "hard_delete"
        });
      }
    } catch (error) {
      console.error('Failed to delete user:', error);
      res.status(500).json({ message: "Failed to delete user" });
    }
  });

  app.patch("/api/users/:id", requireAuthentication, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const callerRolePatch = req.authenticatedUserRole;
      const callerCompanyIdPatch = req.authenticatedUserCompanyId ?? null;
      const userData = insertUserSchema.partial().parse(req.body);
      const before = await storage.getUser(id);
      // Cross-company guard.
      if (callerRolePatch !== 'super_admin' && before && before.companyId !== callerCompanyIdPatch) {
        res.status(403).json({ message: "Forbidden: cannot edit users from another company" });
        return;
      }
      // Role-ceiling guard (only fires when the role is actually changing).
      if (userData.role && userData.role !== before?.role && callerRolePatch !== 'super_admin') {
        const callerRankPatch = ROLE_RANK[callerRolePatch ?? ''] ?? 0;
        const targetRankPatch = ROLE_RANK[userData.role] ?? 0;
        if (targetRankPatch >= callerRankPatch) {
          res.status(403).json({ message: "Forbidden: cannot assign a role at or above your own" });
          return;
        }
      }
      const user = await storage.updateUser(id, userData);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      // Remove password from response
      const { password: _, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid user data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to update user" });
    }
  });


  // Dashboard statistics endpoint
  app.get("/api/dashboard/stats", requireAuthentication, async (req, res) => {
    try {
      const userRole = req.authenticatedUserRole;
      const userCompanyId = req.authenticatedUserCompanyId;
      
      let stats;
      
      if (userRole === 'super_admin') {
        // Super admin sees system-wide stats
        const allUsers = await storage.getUsers();
        const activeUsers = allUsers.filter(user => user.isActive).length;
        
        const allWorkOrders = await storage.getWorkOrders(null);
        const openWorkOrders = allWorkOrders.filter(wo => wo.status === "assigned").length;
        
        const allCustomers = await storage.getCustomers();
        const activeCustomers = allCustomers.length;
        
        stats = { activeUsers, openWorkOrders, activeCustomers };
      } else if (userRole === 'company_admin' && userCompanyId) {
        // Company admin sees only their company's stats
        const allUsers = await storage.getUsers();
        const companyUsers = allUsers.filter(user => user.companyId === userCompanyId);
        const activeUsers = companyUsers.filter(user => user.isActive).length;
        
        const allCustomers = await storage.getCustomers();
        
        const allWorkOrders = await storage.getWorkOrders(userCompanyId);
        const companyWorkOrders = allWorkOrders.filter(wo => wo.customerId && allCustomers.find(c => c.id === wo.customerId)?.companyId === userCompanyId);
        const openWorkOrders = companyWorkOrders.filter(wo => wo.status === "assigned" || wo.status === "in_progress").length;
        
        // Include customers for this company OR customers with companyId 99 (QuickBooks sync default)
        // This handles cases where QuickBooks sync used a default company ID
        const companyCustomers = allCustomers.filter(customer => 
          customer.companyId === userCompanyId || 
          customer.companyId === 99 || // QuickBooks sync default
          customer.companyId === null || 
          customer.companyId === undefined
        );
        const activeCustomers = companyCustomers.length;
        
        stats = { activeUsers, openWorkOrders, activeCustomers };
        console.log(`Company ${userCompanyId} stats:`, stats);
      } else {
        // Other roles get limited or no stats
        stats = { activeUsers: 0, openWorkOrders: 0, activeCustomers: 0 };
      }
      
      console.log("Final stats:", stats);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      res.status(500).json({ message: "Failed to fetch dashboard statistics" });
    }
  });

  // Company-scoped user management routes (for company admins)
  app.get("/api/company/:companyId/users", requireAuthentication, requireCompanySetup, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const users = await storage.getUsers(companyId);
      // Remove passwords from response
      const usersWithoutPasswords = users.map(({ password, ...user }) => user);
      res.json(usersWithoutPasswords);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch company users" });
    }
  });

  app.post("/api/company/:companyId/users", requireAuthentication, requireCompanySetup, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const callerRolePost = req.authenticatedUserRole;
      const callerCompanyIdPost = req.authenticatedUserCompanyId ?? null;
      // Admin-only gate: only super_admin or company_admin may manage company users.
      if (callerRolePost !== 'super_admin' && callerRolePost !== 'company_admin') {
        res.status(403).json({ message: "Forbidden: only company admins can manage users" });
        return;
      }
      // Company-match guard: non-super_admin callers can only create users in their own company.
      if (callerRolePost !== 'super_admin' && callerCompanyIdPost !== companyId) {
        res.status(403).json({ message: "Forbidden: cannot create users in another company" });
        return;
      }
      // Role-ceiling guard: callers can only assign roles strictly below their own rank.
      const newRole: string = typeof req.body.role === 'string' ? req.body.role : '';
      if (newRole && callerRolePost !== 'super_admin') {
        const callerRankPost = ROLE_RANK[callerRolePost ?? ''] ?? 0;
        const targetRankPost = ROLE_RANK[newRole] ?? 0;
        if (targetRankPost >= callerRankPost) {
          res.status(403).json({ message: "Forbidden: cannot assign a role at or above your own" });
          return;
        }
      }

      // Phone is required for new users — it becomes the username
      const { phone, email, name, password, role } = req.body;
      if (!phone || !phone.trim()) {
        res.status(400).json({ message: "Phone number is required" });
        return;
      }

      const userData = insertUserSchema.parse({
        ...req.body,
        username: phone.trim(), // phone number is the login username
        companyId
      });

      // Generate email verification token if email is provided
      let emailVerificationToken = null;
      let emailVerificationExpires = null;

      if (userData.email) {
        emailVerificationToken = crypto.randomBytes(32).toString('hex');
        emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      }

      const user = await storage.createUser({
        ...userData,
        // If no email, mark as verified so login is not blocked
        emailVerified: userData.email ? false : true,
        emailVerificationToken,
        emailVerificationExpires
      });

      // Send verification email if email is provided
      if (userData.email && emailVerificationToken) {
        try {
          await EmailService.sendEmailVerification(userData.email, emailVerificationToken, userData.name);
        } catch (emailError) {
          console.error('Failed to send verification email:', emailError);
          // Don't fail user creation if email fails
        }
      }

      // Remove password from response
      const { password: _, ...userWithoutPassword } = user;
      res.status(201).json(userWithoutPassword);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid user data", errors: error.issues });
        return;
      }
      console.error('Full error details for user creation:', error);
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  app.put("/api/company/:companyId/users/:userId", requireAuthentication, requireCompanySetup, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const userId = parseInt(req.params.userId);
      const callerRolePut = req.authenticatedUserRole;
      const callerCompanyIdPut = req.authenticatedUserCompanyId ?? null;
      // Admin-only gate: only super_admin or company_admin may manage company users.
      if (callerRolePut !== 'super_admin' && callerRolePut !== 'company_admin') {
        res.status(403).json({ message: "Forbidden: only company admins can manage users" });
        return;
      }
      // Company-match guard: non-super_admin callers can only edit users in their own company.
      if (callerRolePut !== 'super_admin' && callerCompanyIdPut !== companyId) {
        res.status(403).json({ message: "Forbidden: cannot edit users in another company" });
        return;
      }
      
      // Verify user belongs to company
      const existingUser = await storage.getUser(userId);
      if (!existingUser || existingUser.companyId !== companyId) {
        res.status(403).json({ message: "Not authorized to modify this user" });
        return;
      }

      const userData = insertUserSchema.partial().parse(req.body);
      // Role-ceiling guard: only fires when the role is actually changing.
      if (userData.role && userData.role !== existingUser?.role && callerRolePut !== 'super_admin') {
        const callerRankPut = ROLE_RANK[callerRolePut ?? ''] ?? 0;
        const targetRankPut = ROLE_RANK[userData.role] ?? 0;
        if (targetRankPut >= callerRankPut) {
          res.status(403).json({ message: "Forbidden: cannot assign a role at or above your own" });
          return;
        }
      }

      // If phone is being updated, also update username to match (phone = username for new-style accounts)
      const updatePayload: any = { ...userData };
      if (req.body.phone && req.body.phone.trim() && req.body.phone.trim() !== existingUser.username) {
        updatePayload.username = req.body.phone.trim();
      }

      // If email is being cleared, ensure emailVerified is set to true so login isn't blocked
      if (updatePayload.email === '' || updatePayload.email === null) {
        updatePayload.email = null;
        updatePayload.emailVerified = true;
      }

      const user = await storage.updateUser(userId, updatePayload);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      // Remove password from response
      const { password: _, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid user data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  app.post("/api/company/:companyId/users/:userId/deactivate", requireAuthentication, requireCompanySetup, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const userId = parseInt(req.params.userId);
      
      // Verify user belongs to company
      const existingUser = await storage.getUser(userId);
      if (!existingUser || existingUser.companyId !== companyId) {
        res.status(403).json({ message: "Not authorized to modify this user" });
        return;
      }

      const user = await storage.updateUser(userId, { isActive: false });
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      res.json({ message: "User deactivated successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to deactivate user" });
    }
  });

  // Company admin password change endpoint
  app.post("/api/company/:companyId/users/:userId/change-password", requireAuthentication, requireCompanySetup, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const userId = parseInt(req.params.userId);
      const { newPassword } = req.body;
      
      if (!newPassword || newPassword.length < 6) {
        res.status(400).json({ message: "Password must be at least 6 characters long" });
        return;
      }
      
      // Verify user belongs to company
      const existingUser = await storage.getUser(userId);
      if (!existingUser || existingUser.companyId !== companyId) {
        res.status(403).json({ message: "Not authorized to modify this user" });
        return;
      }

      // Hash the new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      
      // Update the user's password
      const user = await storage.updateUser(userId, { 
        password: hashedPassword
      });
      
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      
      res.json({ message: "Password changed successfully" });
    } catch (error) {
      console.error('Password change error:', error);
      res.status(500).json({ message: "Failed to change password" });
    }
  });

  // Authentication routes
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = await storage.getUserByUsername(username);

      if (!user || !user.isActive) {
        // Task #550 (Phase 2) — surface failed logins to the Audit Log tab.
        void recordAuditEvent(req, {
          actorUserId: user?.id ?? null,
          actorLabel: typeof username === "string" ? String(username).slice(0, 200) : null,
          actorRole: user?.role ?? null,
          actorCompanyId: user?.companyId ?? null,
          actionType: "auth",
          action: "auth.login_failed",
          severity: "warning",
          summary: user ? "Login refused — account inactive" : "Login refused — unknown user",
        });
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }

      // Use bcrypt to compare password with hash
      const passwordValid = await bcrypt.compare(password, user.password);
      if (!passwordValid) {
        void recordAuditEvent(req, {
          actorUserId: user.id,
          actorLabel: user.username,
          actorRole: user.role,
          actorCompanyId: user.companyId ?? null,
          actionType: "auth",
          action: "auth.login_failed",
          severity: "warning",
          summary: "Login refused — bad password",
        });
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }

      // Check if email is verified (optional enforcement)
      if (user.email && !user.emailVerified) {
        res.status(403).json({
          message: "Email verification required",
          requiresVerification: true,
          email: user.email
        });
        return;
      }

      void recordAuditEvent(req, {
        actorUserId: user.id,
        actorLabel: user.username,
        actorRole: user.role,
        actorCompanyId: user.companyId ?? null,
        actionType: "auth",
        action: "auth.login",
        severity: "info",
        summary: `${user.role} signed in`,
        details: { surface: "web" },
      });

      // Write the server-side session so subsequent requests authenticate
      // via the httpOnly cookie rather than the legacy unsigned-header path.
      const { password: _, ...userWithoutPassword } = user;
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err?: Error) => { if (err) reject(err); else resolve(); });
      });
      req.session.userId = user.id;
      await new Promise<void>((resolve, reject) => {
        req.session.save((err?: Error) => { if (err) reject(err); else resolve(); });
      });
      res.json(userWithoutPassword);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  // POST /api/auth/logout — destroys the server-side session and clears the
  // session cookie. The frontend should also clear its localStorage user blob.
  app.post("/api/auth/logout", async (req: any, res) => {
    try {
      await new Promise<void>((resolve) => {
        req.session.destroy((err?: Error) => {
          if (err) {
            logger.warn({ err }, "Session destroy error on logout");
          }
          resolve();
        });
      });
      res.clearCookie("irrigopro.sid");
      res.json({ ok: true });
    } catch (error) {
      logger.error({ error }, "Logout error");
      res.status(500).json({ message: "Logout failed" });
    }
  });

  // ── Mobile bearer-token auth (M1 + Task #521 refresh tokens) ────────────
  // POST /api/auth/mobile-login — issues a short-lived access token plus a
  // long-lived refresh token for field techs and irrigation managers signing
  // in from the mobile app. Mirrors the web /api/auth/login checks (bcrypt,
  // isActive, email verification) and additionally restricts by role.
  //
  // Pre-Task #521 the access token *was* the only token and lasted 90 days;
  // we now mint a 1 hour access token here plus a 90 day refresh token via
  // POST /api/auth/mobile-refresh. Existing pre-#521 long-lived access
  // tokens already in the wild keep authenticating until natural expiry.
  const MOBILE_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
  const MOBILE_REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
  const MOBILE_LOGIN_ALLOWED_ROLES = new Set(['field_tech', 'irrigation_manager']);

  function mintMobileAccessToken(): { rawToken: string; tokenHash: string } {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    return { rawToken, tokenHash };
  }

  function safeUserShape(user: any) {
    const {
      password: _pw,
      mfaSecret: _mfaSecret,
      mfaBackupCodes: _mfaBackup,
      passwordResetToken: _prt,
      passwordResetExpires: _pre,
      emailVerificationToken: _evt,
      emailVerificationExpires: _eve,
      ...safe
    } = user ?? {};
    return safe;
  }

  app.post("/api/auth/mobile-login", async (req, res) => {
    try {
      const { username, password, deviceName } = req.body ?? {};
      if (!username || !password) {
        res.status(400).json({ message: "Username and password are required" });
        return;
      }

      const user = await storage.getUserByUsername(String(username));
      if (!user || !user.isActive) {
        void recordAuditEvent(req, {
          actorUserId: user?.id ?? null,
          actorLabel: typeof username === "string" ? String(username).slice(0, 200) : null,
          actorRole: user?.role ?? null,
          actorCompanyId: user?.companyId ?? null,
          actionType: "auth",
          action: "auth.login_failed",
          severity: "warning",
          summary: user ? "Mobile login refused — inactive" : "Mobile login refused — unknown user",
          details: { surface: "mobile" },
        });
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }

      const passwordValid = await bcrypt.compare(String(password), user.password);
      if (!passwordValid) {
        void recordAuditEvent(req, {
          actorUserId: user.id,
          actorLabel: user.username,
          actorRole: user.role,
          actorCompanyId: user.companyId ?? null,
          actionType: "auth",
          action: "auth.login_failed",
          severity: "warning",
          summary: "Mobile login refused — bad password",
          details: { surface: "mobile" },
        });
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }

      if (user.email && !user.emailVerified) {
        res.status(403).json({
          message: "Email verification required",
          requiresVerification: true,
          email: user.email,
        });
        return;
      }

      if (!MOBILE_LOGIN_ALLOWED_ROLES.has(user.role)) {
        res.status(403).json({
          message: "Mobile sign-in is restricted to field technicians and irrigation managers",
        });
        return;
      }
      void recordAuditEvent(req, {
        actorUserId: user.id,
        actorLabel: user.username,
        actorRole: user.role,
        actorCompanyId: user.companyId ?? null,
        actionType: "auth",
        action: "auth.login",
        severity: "info",
        summary: `${user.role} signed in (mobile)`,
        details: { surface: "mobile" },
      });

      const deviceLabel =
        typeof deviceName === 'string' && deviceName.length > 0 ? deviceName : null;
      const now = Date.now();
      const accessExpiresAt = new Date(now + MOBILE_ACCESS_TOKEN_TTL_MS);
      const refreshExpiresAt = new Date(now + MOBILE_REFRESH_TOKEN_TTL_MS);

      // Mint refresh token first so the access row can link to it.
      const rawRefreshToken = crypto.randomBytes(32).toString('hex');
      const refreshTokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
      const refreshRow = await storage.createMobileRefreshToken({
        userId: user.id,
        tokenHash: refreshTokenHash,
        deviceName: deviceLabel,
        expiresAt: refreshExpiresAt,
      });

      const { rawToken: rawAccessToken, tokenHash: accessTokenHash } = mintMobileAccessToken();
      await storage.createMobileToken({
        userId: user.id,
        tokenHash: accessTokenHash,
        deviceName: deviceLabel,
        expiresAt: accessExpiresAt,
        refreshTokenId: refreshRow.id,
      });

      res.json({
        // `token` is preserved for one release so older app builds (which
        // only know about a single `token` field) keep authenticating.
        token: rawAccessToken,
        accessToken: rawAccessToken,
        accessTokenExpiresAt: accessExpiresAt.toISOString(),
        refreshToken: rawRefreshToken,
        refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
        // `expiresAt` retained for backward compatibility; matches accessTokenExpiresAt.
        expiresAt: accessExpiresAt.toISOString(),
        user: safeUserShape(user),
      });
    } catch (error) {
      console.error('Mobile login error:', error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  // POST /api/auth/mobile-refresh — exchanges a valid refresh token for a
  // fresh access token. Returns the same shape as login (without re-issuing
  // the refresh token; single-long-lived-refresh policy for this pass).
  app.post("/api/auth/mobile-refresh", async (req, res) => {
    try {
      const { refreshToken, deviceName } = req.body ?? {};
      if (!refreshToken || typeof refreshToken !== 'string') {
        res.status(400).json({ message: "Refresh token is required" });
        return;
      }
      const refreshTokenHash = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');
      const refreshRow = await storage.getActiveMobileRefreshTokenByHash(refreshTokenHash);
      if (!refreshRow) {
        res.status(401).json({ message: "Invalid or expired refresh token" });
        return;
      }
      const user = await storage.getUser(refreshRow.userId);
      if (!user || !user.isActive) {
        // Belt-and-suspenders: revoke the refresh token so a deactivated
        // user can't keep minting access tokens.
        await storage.revokeMobileRefreshTokenById(refreshRow.id).catch(() => undefined);
        res.status(401).json({ message: "Invalid or expired refresh token" });
        return;
      }

      const deviceLabel =
        typeof deviceName === 'string' && deviceName.length > 0
          ? deviceName
          : refreshRow.deviceName ?? null;
      const accessExpiresAt = new Date(Date.now() + MOBILE_ACCESS_TOKEN_TTL_MS);
      const { rawToken: rawAccessToken, tokenHash: accessTokenHash } = mintMobileAccessToken();
      await storage.createMobileToken({
        userId: user.id,
        tokenHash: accessTokenHash,
        deviceName: deviceLabel,
        expiresAt: accessExpiresAt,
        refreshTokenId: refreshRow.id,
      });

      res.json({
        token: rawAccessToken,
        accessToken: rawAccessToken,
        accessTokenExpiresAt: accessExpiresAt.toISOString(),
        // Refresh token is unchanged; echoed so clients that lost the
        // expiry locally can re-cache it.
        refreshTokenExpiresAt: refreshRow.expiresAt.toISOString(),
        expiresAt: accessExpiresAt.toISOString(),
        user: safeUserShape(user),
      });
    } catch (error) {
      console.error('Mobile refresh error:', error);
      res.status(500).json({ message: "Refresh failed" });
    }
  });

  // POST /api/auth/mobile-logout — idempotent; always returns { ok: true }.
  // Revokes both the access token presented as the bearer (which cascade-
  // revokes its paired refresh token + any sibling access tokens) and the
  // refresh token if explicitly supplied in the body.
  app.post("/api/auth/mobile-logout", async (req, res) => {
    try {
      const authHeader = req.headers['authorization'];
      if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
        const rawToken = authHeader.slice(7).trim();
        if (rawToken) {
          const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          await storage.revokeMobileToken(tokenHash);
        }
      }
      const bodyRefresh = (req.body ?? {}).refreshToken;
      if (typeof bodyRefresh === 'string' && bodyRefresh.length > 0) {
        const refreshHash = crypto.createHash('sha256').update(bodyRefresh).digest('hex');
        await storage.revokeMobileRefreshToken(refreshHash);
      }
      void recordAuditEvent(req, {
        actionType: "auth",
        action: "auth.logout",
        severity: "info",
        summary: "Mobile signed out",
        details: { surface: "mobile" },
      });
      res.json({ ok: true });
    } catch (error) {
      console.error('Mobile logout error:', error);
      res.json({ ok: true });
    }
  });

  // Password reset request
  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        // Don't reveal if email exists or not for security
        res.json({ message: "If this email exists, you will receive a password reset link." });
        return;
      }
      
      // Generate reset token
      const crypto = await import('crypto');
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
      
      // Update user with reset token
      await storage.updateUser(user.id, {
        passwordResetToken: resetToken,
        passwordResetExpires: resetExpires
      });
      
      // Send reset email
      await EmailService.sendPasswordReset(user.email!, resetToken, user.name);
      
      res.json({ message: "If this email exists, you will receive a password reset link." });
    } catch (error) {
      console.error('Password reset error:', error);
      res.status(500).json({ message: "Password reset request failed" });
    }
  });

  // Reset password with token
  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      
      if (!token || !newPassword) {
        res.status(400).json({ message: "Token and new password are required" });
        return;
      }
      
      if (newPassword.length < 6) {
        res.status(400).json({ message: "Password must be at least 6 characters long" });
        return;
      }
      
      const user = await storage.getUserByPasswordResetToken(token);
      
      if (!user || !user.passwordResetExpires || user.passwordResetExpires < new Date()) {
        res.status(400).json({ message: "Invalid or expired reset token" });
        return;
      }
      
      // Hash the new password before storing
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      
      // Update password and clear reset token
      await storage.updateUser(user.id, {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetExpires: null,
      });

      void recordAuditEvent(req, {
        actorUserId: user.id,
        actorLabel: user.username,
        actorRole: user.role,
        actorCompanyId: user.companyId ?? null,
        actionType: "auth",
        action: "auth.password_reset",
        severity: "warning",
        summary: "Password reset via email link",
      });

      res.json({ message: "Password reset successfully" });
    } catch (error) {
      console.error('Password reset error:', error);
      res.status(500).json({ message: "Password reset failed" });
    }
  });

  // Resend email verification
  app.post("/api/auth/resend-verification", async (req, res) => {
    try {
      const { email } = req.body;
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      
      if (user.emailVerified) {
        res.status(400).json({ message: "Email already verified" });
        return;
      }
      
      // Generate new verification token
      const emailVerificationToken = crypto.randomBytes(32).toString('hex');
      const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      
      // Update user with new token
      await storage.updateUser(user.id, {
        emailVerificationToken,
        emailVerificationExpires,
      });
      
      // Send verification email
      try {
        await EmailService.sendEmailVerification(email, emailVerificationToken, user.name);
        console.log(`Verification email resent to ${email}`);
        res.json({ message: "Verification email sent" });
      } catch (emailError) {
        console.error('Failed to send verification email:', emailError);
        res.status(500).json({ message: "Failed to send verification email" });
      }
    } catch (error) {
      console.error('Error resending verification:', error);
      res.status(500).json({ message: "Failed to resend verification email" });
    }
  });

  // Admin endpoint to resend verification for company users
  app.post("/api/company/:companyId/users/:userId/resend-verification", requireAuthentication, requireWorkOrderBillingAccess, async (req, res) => {
    try {
      const { companyId, userId } = req.params;
      const user = await storage.getUser(parseInt(String(userId)));
      
      if (!user || user.companyId !== parseInt(companyId)) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      
      if (user.emailVerified) {
        res.status(400).json({ message: "Email already verified" });
        return;
      }
      
      if (!user.email) {
        res.status(400).json({ message: "User has no email address" });
        return;
      }
      
      // Generate new verification token
      const emailVerificationToken = crypto.randomBytes(32).toString('hex');
      const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      
      // Update user with new token
      await storage.updateUser(user.id, {
        emailVerificationToken,
        emailVerificationExpires,
      });
      
      // Send verification email
      try {
        await EmailService.sendEmailVerification(user.email, emailVerificationToken, user.name);
        console.log(`Admin resent verification email to ${user.email}`);
        res.json({ message: "Verification email sent" });
      } catch (emailError) {
        console.error('Failed to send verification email:', emailError);
        res.status(500).json({ message: "Failed to send verification email" });
      }
    } catch (error) {
      console.error('Error resending verification:', error);
      res.status(500).json({ message: "Failed to resend verification email" });
    }
  });

  // Get current authenticated user.
  // Accepts both session cookie (web) and bearer token (mobile) via the
  // shared requireAuthentication middleware, which sets
  // req.authenticatedUserId on success.
  app.get("/api/auth/user", requireAuthentication, async (req: any, res) => {
    try {
      const userId = req.authenticatedUserId;
      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const user = await storage.getUser(parseInt(String(userId)));
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      // Return user data (excluding sensitive fields)
      const {
        password,
        passwordResetToken,
        passwordResetExpires,
        emailVerificationToken,
        emailVerificationExpires,
        mfaSecret,
        mfaBackupCodes,
        ...safeUserData
      } = user;

      res.json(safeUserData);
    } catch (error) {
      console.error('Auth user endpoint error:', error);
      res.status(500).json({
        message: "Failed to get user session"
      });
    }
  });

  // Email verification endpoint
  app.get("/api/auth/verify-email/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const user = await storage.getUserByEmailVerificationToken(token);
      
      if (!user || !user.emailVerificationExpires || user.emailVerificationExpires < new Date()) {
        res.status(400).send(`
          <html><body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: #ef4444;">Verification Failed</h1>
            <p>This verification link is invalid or has expired.</p>
            <p>Please request a new verification email.</p>
          </body></html>
        `);
        return;
      }
      
      // Mark email as verified and clear verification token
      await storage.updateUser(user.id, {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpires: null,
      });
      
      res.send(`
        <html><body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: #10b981;">Email Verified Successfully!</h1>
          <p>Your email address has been verified. You can now close this window and return to the application.</p>
          <script>setTimeout(() => { window.close(); }, 3000);</script>
        </body></html>
      `);
    } catch (error) {
      console.error('Email verification error:', error);
      res.status(500).send(`
        <html><body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: #ef4444;">Verification Error</h1>
          <p>An error occurred during email verification. Please try again.</p>
        </body></html>
      `);
    }
  });


  // Dashboard stats
  // NOTE: The second /api/dashboard/stats registration below was removed.
  // The authenticated canonical version at line ~5201 takes precedence.
  // (Removed duplicate unguarded registration — security hardening)

  // Admin-specific stats endpoint — super_admin only
  app.get("/api/admin/stats", requireAuthentication, async (req, res) => {
    try {
      if (req.authenticatedUserRole !== 'super_admin') {
        res.status(403).json({ message: "Forbidden: super_admin only" });
        return;
      }
      const users = await storage.getUsers();
      const estimates = await storage.getEstimates();
      const workOrders = await storage.getWorkOrders(null);
      
      const stats = {
        totalUsers: users.length,
        activeUsers: users.filter(u => u.isActive).length,
        totalEstimates: estimates.length,
        totalWorkOrders: workOrders.length,
        totalInvoices: 0,
        systemHealth: "good" as const
      };
      
      res.json(stats);
    } catch (error) {
      console.error("Error fetching admin stats:", error);
      res.status(500).json({ message: "Failed to fetch admin stats" });
    }
  });

  // Customer routes
  app.get("/api/customers", requireAuthentication, async (req, res) => {
    try {
      const billingVisible = req.query.billingVisible === "true";
      const activeOnly = req.query.active === "true";
      const callerRoleCustomers = req.authenticatedUserRole;
      if (callerRoleCustomers !== 'super_admin' && !req.authenticatedUserCompanyId) {
        res.status(403).json({ message: "Forbidden: user has no company association" });
        return;
      }
      const callerCidCustomers: number | undefined = callerRoleCustomers === 'super_admin'
        ? undefined
        : (req.authenticatedUserCompanyId ?? undefined);
      let customers = await storage.getCustomers(callerCidCustomers);
      if (billingVisible) {
        customers = customers.filter(c => !c.hiddenFromBilling);
      }
      // TODO: `c.isActive` does not exist on the customers schema — this filter
      // is always a no-op and never excludes any customer. The wet-check picker
      // previously sent `?active=true` hitting this branch; it now sends
      // `?billingVisible=true` (the working filter above). This dead branch is
      // left for backwards compatibility but can be removed once any remaining
      // callers are confirmed to have migrated.
      if (activeOnly) {
        customers = customers.filter(c => (c as any).isActive !== false);
      }
      // Task #532 — opt-in pagination via ?limit=&offset=. When omitted
      // the response is unchanged (full list) for backwards compatibility.
      const page = paginate(req, res, customers, { limit: 200, max: 1000 });
      res.json(applyBillingNotesVisibility(req, page));
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch customers" });
    }
  });

  // Customer billing preview data - includes estimates, work orders, and billing sheets
  // This must come BEFORE the :id route to avoid parameter conflicts
  // Task #1898 — the handler lives in billing-preview-route.ts so its tenant
  // scoping is testable against a storage stub. This is the real handler, not
  // a mirror, so the test and production cannot drift apart.
  registerBillingPreviewRoute(
    app,
    { storage, previousCalendarMonth, resolveAsOfCutoff },
    requireAuthentication,
  );

  // Get individual customer by ID
  app.get("/api/customers/:id", requireAuthentication, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id);
      
      // Validate customer ID is a valid number
      if (isNaN(customerId) || customerId <= 0) {
        res.status(400).json({ message: "Invalid customer ID" });
        return;
      }
      
      const customer = await storage.getCustomerById(customerId);
      
      if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }
      
      res.json(applyBillingNotesVisibility(req, customer));
    } catch (error) {
      console.error("Error fetching customer:", error);
      res.status(500).json({ message: "Failed to fetch customer" });
    }
  });

  // Get customer billing data - all work orders, billing sheets, and estimates for a customer
  app.get("/api/customers/:id/billing", requireAuthentication, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id);
      
      // Validate customer ID is a valid number
      if (isNaN(customerId) || customerId <= 0) {
        res.status(400).json({ message: "Invalid customer ID" });
        return;
      }

      // Resolve billing month — same logic as billing-preview so the two
      // headline numbers agree for the same selectedMonth.
      const rawSelectedMonthDetail = req.query.selectedMonth as string | undefined;
      const selectedMonthDetail = rawSelectedMonthDetail && rawSelectedMonthDetail.trim() !== ''
        ? rawSelectedMonthDetail.trim()
        : previousCalendarMonth();
      const asOfCutoffDetail = resolveAsOfCutoff(selectedMonthDetail);
      
      // Get customer details
      const customer = await storage.getCustomerById(customerId);
      if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }

      // Get all work orders for the customer
      const callerCompanyId6320 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const allWorkOrders = await storage.getWorkOrders(callerCompanyId6320);
      const rawWorkOrders = allWorkOrders.filter(wo => wo.customerId === customerId);

      // Get all billing sheets for the customer
      const allBillingSheets = await storage.getAllBillingSheets(callerCompanyId6320);
      const rawBillingSheets = allBillingSheets.filter(bs => bs.customerId === customerId);

      // Get all estimates for the customer
      const allEstimates = await storage.getEstimates();
      const rawEstimates = allEstimates.filter(est => est.customerId === customerId);

      // Get wet check billings for the customer
      const rawWetCheckBillings = await storage.getWetCheckBillingsByCustomer(customerId);

      // Transform work orders to match frontend expectations.
      // Use the stored financial snapshot as the source of truth.
      // Historical backfill guardrail: if laborSubtotal is null (pre-fix record),
      // fall back to totalAmount for the total but do not fabricate breakdown detail.
      // money() guards against Postgres NaN decimal values ("NaN" string is truthy
      // so the legacy `|| '0'` pattern passes "NaN" straight through to parseFloat).
      const workOrders = rawWorkOrders.map(wo => {
        const hasBreakdown = wo.laborSubtotal != null;
        const laborCost = hasBreakdown ? money(wo.laborSubtotal) : null;
        const partsCost = hasBreakdown ? money(wo.partsSubtotal) : null;
        const storedTotal = money(wo.totalAmount);
        
        return {
          ...wo,
          // For pre-fix records without a stored breakdown, set component fields to 0.
          // UI guards on hasFinancialBreakdown and uses totalAmount as authoritative total.
          laborCost: laborCost !== null ? laborCost : 0,
          partsCost: partsCost !== null ? partsCost : 0,
          totalAmount: storedTotal.toString(),
          hasFinancialBreakdown: hasBreakdown,
          assignedTo: wo.assignedTechnicianName || 'Unassigned',
          description: wo.description || wo.workSummary || '',
          billedDate: null,
          completedDate: wo.completedAt
        };
      });

      // Transform billing sheets to match frontend expectations
      const billingSheets = rawBillingSheets.map(bs => {
        const laborAmount = money(bs.laborSubtotal);
        const partsAmount = money(bs.partsSubtotal);
        const storedTotal = money(bs.totalAmount) || (laborAmount + partsAmount);
        
        return {
          ...bs,
          laborCost: laborAmount,
          partsCost: partsAmount,
          totalAmount: storedTotal.toString(),
          description: bs.workDescription || '',
          billedDate: null,
          completedDate: bs.workDate
        };
      });

      // Transform estimates to match frontend expectations
      const estimates = rawEstimates.map(est => ({
        ...est,
        laborCost: 0, // Calculate if needed
        partsCost: 0, // Calculate if needed  
        description: est.projectName || '',
        billedDate: null,
        completedDate: est.updatedAt
      }));

      // Transform wet check billings to a parallel shape matching billing sheets
      const wetCheckBillings = rawWetCheckBillings.map(wcb => {
        const laborCost = money(wcb.laborSubtotal);
        const partsCost = money(wcb.partsSubtotal);
        const totalAmount = money(wcb.totalAmount) || (laborCost + partsCost);
        return {
          ...wcb,
          laborCost,
          partsCost,
          totalAmount: totalAmount.toString(),
          description: `Wet Check — ${wcb.propertyAddress || wcb.customerName}`,
          billedDate: wcb.billedAt ?? null,
          completedDate: wcb.workDate
        };
      });

      // Partition unbilled work via canonical selector — same logic as
      // billing-preview so the two headline numbers agree for the same
      // selectedMonth. Cutoff is upper-bound only (open start). Null
      // work-date records are always included and flagged undated:true.
      // Visibility note: the billing-eligible gate belongs only on invoice-construction
      // paths; the partition here includes all approved WCBs regardless of parent status.
      const detailPartition = computeUnbilledPartition(
        workOrders,
        billingSheets,
        wetCheckBillings,
        asOfCutoffDetail,
      );

      // approvedWorkOrders / approvedBillingSheets / approvedWetCheckBillings
      // are the items the billing manager can include in an invoice (they
      // map 1:1 to the old unbilledWorkOrders / unbilledBillingSheets /
      // unbilledWetCheckBillings field names preserved for backward compat).
      const unbilledWorkOrders = detailPartition.approvedWorkOrders;
      const unbilledBillingSheets = detailPartition.approvedBillingSheets;
      const unbilledWetCheckBillings = detailPartition.approvedWetCheckBillings;

      // totalUnbilledAmount = cutoff-scoped approved + pending total so
      // it agrees with the left-list "Total" card for the same billing month.
      const totalUnbilledAmount = detailPartition.total;

      const billingData = {
        customer: applyBillingNotesVisibility(req, customer),
        workOrders,
        billingSheets,
        estimates,
        unbilledWorkOrders,
        unbilledBillingSheets,
        totalUnbilledAmount,
        wetCheckBillings,
        unbilledWetCheckBillings,
        pendingApprovalWorkOrders: detailPartition.pendingWorkOrders,
        pendingApprovalBillingSheets: detailPartition.pendingBillingSheets,
        pendingApprovalWetCheckBillings: detailPartition.pendingWetCheckBillings,
        approvedTotal: detailPartition.approvedTotal,
        unapprovedTotal: detailPartition.unapprovedTotal,
        allOpenTotal: detailPartition.allOpenTotal,
        selectedMonth: selectedMonthDetail,
      };

      res.json(billingData);
    } catch (error) {
      console.error("Error fetching customer billing data:", error);
      res.status(500).json({ message: "Failed to fetch customer billing data" });
    }
  });

  // Customer site maps routes — extracted to ./site-map-routes.ts
  registerSiteMapRoutes(app, { requireAuthentication, requireSiteMapViewAccess, requireCompanyAdminAccess });

  // Invoice preview (no creation, just calculation)
  // Task #1886 — WRITE. This assembles the contents of an invoice that does
  // not exist yet (work orders, billing sheets, eligible wet-check billings)
  // and is step one of the create flow in the billing Command Center, whose
  // only callers are company_admin and billing_manager. It was previously
  // authenticated-only, which let any role read a customer's billable work.
  app.post("/api/invoices/preview", requireAuthentication, requireInvoiceWrite, async (req, res) => {
    try {
      const { customerId, workOrderIds = [], billingSheetIds = [], wetCheckBillingIds = [] } = req.body;
      
      // Get customer details
      const customer = await storage.getCustomerById(customerId);
      if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }

      // Get all work orders for the customer
      const callerCompanyId6457 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const allWorkOrders = await storage.getWorkOrders(callerCompanyId6457);
      const workOrders = allWorkOrders.filter(wo => wo.customerId === customerId);

      // Get all billing sheets for the customer
      const allBillingSheets = await storage.getAllBillingSheets(callerCompanyId6457);
      const billingSheets = allBillingSheets.filter(bs => bs.customerId === customerId);

      // Query eligible wet check billings for this customer (Slice 2+)
      const allWcbsForPreview = await storage.getWetCheckBillingsByCustomer(customerId);
      // INVOICE-CONSTRUCTION gate: a WCB is eligible when it is approved,
      // not yet on an invoice, and the parent wet check has zero unrouted findings
      // (i.e. every finding is triaged — no outstanding manager decisions).
      const eligibleWcbs = allWcbsForPreview.filter(wcb => wcbIsEligible(wcb));

      // Filter to only include selected items
      let selectedWorkOrders: (typeof allWorkOrders)[number][] = [];
      let selectedBillingSheets: (typeof allBillingSheets)[number][] = [];
      let selectedWcbsPreview: typeof eligibleWcbs = [];

      if (workOrderIds.length > 0) {
        selectedWorkOrders = workOrders.filter(wo => 
          workOrderIds.includes(wo.id) && 
          (wo.status === 'approved_passed_to_billing') && 
          !wo.invoiceId
        );
      }

      if (billingSheetIds.length > 0) {
        selectedBillingSheets = billingSheets.filter(bs => 
          billingSheetIds.includes(bs.id) && 
          (bs.status === 'approved_passed_to_billing') && 
          !bs.invoiceId
        );
      }

      if (wetCheckBillingIds.length > 0) {
        selectedWcbsPreview = eligibleWcbs.filter(wcb =>
          wetCheckBillingIds.includes(wcb.id),
        );
      }

      // If no specific items selected, fall back to all approved unbilled items.
      // WCBs intentionally do NOT auto-expand in the fallback: the caller must
      // pass selectedWetCheckBillingIds explicitly (Slice 5+ will wire the UI).
      if (workOrderIds.length === 0 && billingSheetIds.length === 0 && wetCheckBillingIds.length === 0) {
        selectedWorkOrders = workOrders.filter(wo => 
          (wo.status === 'approved_passed_to_billing') && !wo.invoiceId
        );
        selectedBillingSheets = billingSheets.filter(bs => 
          (bs.status === 'approved_passed_to_billing') && !bs.invoiceId
        );
      }

      if (selectedWorkOrders.length === 0 && selectedBillingSheets.length === 0 && selectedWcbsPreview.length === 0) {
        res.status(400).json({ message: "No valid items selected for invoicing" });
        return;
      }

      // Create preview invoice data using stored financial snapshots
      const currentDate = new Date();
      const invoiceNumber = `PREVIEW-${currentDate.getFullYear()}${(currentDate.getMonth() + 1).toString().padStart(2, '0')}${currentDate.getDate().toString().padStart(2, '0')}-${customerId.toString().padStart(4, '0')}`;
      
      // Use stored totals from each work order as the source of truth.
      // Historical backfill guardrail: if laborSubtotal is null (pre-fix record),
      // use totalAmount for the total but show no breakdown detail.
      const laborSubtotal = 
        selectedWorkOrders.reduce((sum, wo) => sum + parseFloat(wo.laborSubtotal || '0'), 0) +
        selectedBillingSheets.reduce((sum, bs) => sum + parseFloat(bs.laborSubtotal || '0'), 0) +
        selectedWcbsPreview.reduce((sum, wcb) => sum + parseFloat(wcb.laborSubtotal || '0'), 0);
      
      const partsSubtotal = 
        selectedWorkOrders.reduce((sum, wo) => sum + parseFloat(wo.partsSubtotal || '0'), 0) +
        selectedBillingSheets.reduce((sum, bs) => sum + parseFloat(bs.partsSubtotal || '0'), 0) +
        selectedWcbsPreview.reduce((sum, wcb) => sum + parseFloat(wcb.partsSubtotal || '0'), 0);

      // Total is the sum of stored totalAmount per work order + stored totalAmount per billing sheet + WCBs
      const totalAmount = 
        selectedWorkOrders.reduce((sum, wo) => sum + parseFloat(wo.totalAmount || '0'), 0) +
        selectedBillingSheets.reduce((sum, bs) => sum + parseFloat(bs.totalAmount || '0'), 0) +
        selectedWcbsPreview.reduce((sum, wcb) => sum + parseFloat(wcb.totalAmount || '0'), 0);

      // Create preview items
      const previewItems = [];

      // Add work order items — use stored financial breakdown
      for (const workOrder of selectedWorkOrders) {
        const woLaborAmount = parseFloat(workOrder.laborSubtotal || '0');
        const woPartsAmount = parseFloat(workOrder.partsSubtotal || '0');
        const woTotal = parseFloat(workOrder.totalAmount || '0');
        const appliedLaborRate = parseFloat(workOrder.appliedLaborRate || workOrder.laborRate || '0');
        previewItems.push({
          sourceType: 'work_order',
          sourceId: workOrder.id,
          description: `Work Order ${workOrder.workOrderNumber} - ${workOrder.projectName}`,
          workDate: workOrder.completedAt || workOrder.createdAt,
          technicianName: workOrder.assignedTechnicianName || 'Unknown',
          laborHours: parseFloat(workOrder.totalHours || '0'),
          laborRate: appliedLaborRate,
          laborAmount: woLaborAmount,
          partsAmount: woPartsAmount,
          totalAmount: woTotal,
          hasBreakdown: workOrder.laborSubtotal != null
        });
      }

      // Add billing sheet items
      for (const billingSheet of selectedBillingSheets) {
        previewItems.push({
          sourceType: 'billing_sheet',
          sourceId: billingSheet.id,
          description: `Billing Sheet ${billingSheet.billingNumber} - ${billingSheet.workDescription}`,
          workDate: billingSheet.workDate,
          technicianName: billingSheet.technicianName,
          laborHours: parseFloat(billingSheet.totalHours || '0'),
          laborRate: parseFloat(billingSheet.laborRate || '0'),
          laborAmount: parseFloat(billingSheet.laborSubtotal || '0'),
          partsAmount: parseFloat(billingSheet.partsSubtotal || '0'),
          totalAmount: parseFloat(billingSheet.laborSubtotal || '0') + parseFloat(billingSheet.partsSubtotal || '0')
        });
      }

      // Add wet check billing items (Slice 2+)
      for (const wcb of selectedWcbsPreview) {
        previewItems.push({
          sourceType: 'wet_check_billing',
          sourceId: wcb.id,
          description: `WC Billing ${wcb.billingNumber}`,
          workDate: wcb.workDate,
          technicianName: wcb.technicianName,
          laborHours: parseFloat(wcb.totalHours || '0'),
          laborRate: parseFloat(wcb.appliedLaborRate || wcb.laborRate || '0'),
          laborAmount: parseFloat(wcb.laborSubtotal || '0'),
          partsAmount: parseFloat(wcb.partsSubtotal || '0'),
          totalAmount: parseFloat(wcb.totalAmount || '0'),
        });
      }

      // Return preview data
      const previewData = {
        invoiceNumber,
        customerId,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone || null,
        periodStart: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1),
        periodEnd: new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0),
        partsSubtotal: partsSubtotal.toFixed(2),
        laborSubtotal: laborSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        items: previewItems,
        wetCheckBillings: eligibleWcbs,
        itemCount: selectedWorkOrders.length + selectedBillingSheets.length + selectedWcbsPreview.length,
      };

      res.json(previewData);
    } catch (error) {
      console.error("Error creating invoice preview:", error);
      res.status(500).json({ message: "Failed to create invoice preview" });
    }
  });

  // Create monthly invoice for customer - consolidates selected or all unbilled work
  app.post("/api/invoices/monthly", requireAuthentication, requireInvoiceWrite, async (req, res) => {
    try {
      const { customerId, workOrderIds = [], billingSheetIds = [], selectedWetCheckBillingIds = [], periodStart: periodStartInput, periodEnd: periodEndInput } = req.body;

      // Pre-flight: verify QuickBooks connection before doing anything
      // req.authenticatedUserCompanyId is set by requireAuthentication middleware from the x-user-company-id header
      const userCompanyId = req.authenticatedUserCompanyId ? req.authenticatedUserCompanyId.toString() : null;
      const qbLookup = userCompanyId ? await storage.getQuickBooksIntegrationByCompanyId(userCompanyId) : null;
      const integration = qbLookup?.realmId ? await storage.getQuickBooksIntegration(qbLookup.realmId) : null;
      if (!integration || !integration.accessToken) {
        res.status(400).json({
          message: "QuickBooks is not connected. Please connect QuickBooks before creating invoices.",
          quickbooksError: "QuickBooks integration is not configured or the access token is missing. Go to the QuickBooks section to connect your account."
        });
        return;
      }

      // Abort early if connection is already marked as reconnect_required — do not attempt any refresh
      if (integration.connectionStatus === 'reconnect_required') {
        res.status(400).json({
          message: "QuickBooks reauthorization is required. Please reconnect QuickBooks.",
          quickbooksError: integration.reconnectRequiredReason || "QuickBooks connection requires reauthorization.",
          reconnectRequired: true
        });
        return;
      }

      // Proactively refresh if token is expired or within 5-minute buffer
      if (integration.expiresAt && new Date(integration.expiresAt) <= new Date(Date.now() + 5 * 60 * 1000)) {
        const tokenActuallyExpired = new Date(integration.expiresAt) <= new Date();
        console.log(`QuickBooks access token ${tokenActuallyExpired ? 'expired' : 'expiring soon'}, attempting proactive refresh...`);
        if (!integration.refreshToken) {
          if (tokenActuallyExpired) {
            res.status(400).json({
              message: "QuickBooks session has expired and cannot be refreshed. Please reconnect QuickBooks.",
              quickbooksError: "Your QuickBooks session has expired. Go to the QuickBooks section to reconnect your account."
            });
            return;
          }
          console.warn('QuickBooks refresh token missing during buffer window; proceeding with existing token');
        } else {
          const proactiveRealmId = integration.realmId || 'default';
          try {
            const newAccessToken = await withQbRefreshLock(proactiveRealmId, async (signal) => {
              // Re-read from storage by realmId so we get the latest rotated token
              // (another concurrent caller that held the lock may have already refreshed it)
              const fresh = await storage.getQuickBooksIntegration(proactiveRealmId);
              if (!fresh) {
                throw new Error(`[QB proactive refresh] Integration for realmId=${proactiveRealmId} not found; cannot refresh`);
              }
              // Bail out if another caller marked this as reconnect_required while we waited for the lock
              if (fresh.connectionStatus === 'reconnect_required') {
                throw new QbRefreshError(
                  `Connection already marked as reconnect_required for realmId=${proactiveRealmId}`,
                  'reconnect_required'
                );
              }
              const refreshTokenToUse = fresh.refreshToken;

              const newTokenData = await refreshQuickBooksToken(refreshTokenToUse, signal, { realmId: proactiveRealmId, calledFrom: 'monthlyInvoice/proactive' });
              const expiresInSeconds = newTokenData.expires_in && newTokenData.expires_in > 0 ? newTokenData.expires_in : 3600;
              const refreshSuccessAt = new Date();

              // Persist before releasing lock so waiters always see the rotated token
              await storage.saveQuickBooksIntegration({
                companyId: integration.companyId,
                accessToken: newTokenData.access_token,
                refreshToken: newTokenData.refresh_token,
                realmId: proactiveRealmId,
                expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
                lastRefreshAttempt: refreshSuccessAt,
                lastRefreshSuccess: refreshSuccessAt,
              });

              return newTokenData.access_token;
            });

            // Re-read the fully persisted integration by realmId so downstream code sees the rotated token
            const refreshed = await storage.getQuickBooksIntegration(proactiveRealmId);
            if (refreshed) {
              integration.accessToken = refreshed.accessToken;
              integration.refreshToken = refreshed.refreshToken;
              integration.expiresAt = refreshed.expiresAt;
            } else {
              integration.accessToken = newAccessToken;
            }
            console.log('Proactive QuickBooks token refresh succeeded');
          } catch (refreshErr) {
            console.error('Proactive QuickBooks token refresh failed:', refreshErr);
            // Classify and persist reconnect_required for unrecoverable failures
            if (refreshErr instanceof QbRefreshError) {
              const unrecoverable = refreshErr.category === 'stale_refresh_token'
                || refreshErr.category === 'revoked'
                || refreshErr.category === 'reconnect_required';
              if (unrecoverable) {
                const reason = buildReconnectReason(refreshErr.category);
                await storage.markQuickBooksReconnectRequired(proactiveRealmId, reason).catch((e) => {
                  console.error('Failed to persist reconnect_required state:', e);
                });
                console.warn(`[QB] Marked realmId=${proactiveRealmId} as reconnect_required (${refreshErr.category})`);
                res.status(400).json({
                  message: "QuickBooks authorization has expired. Please reconnect QuickBooks to continue.",
                  quickbooksError: reason,
                  reconnectRequired: true
                });
                return;
              }
            }
            if (tokenActuallyExpired) {
              res.status(400).json({
                message: "QuickBooks session has expired and could not be refreshed. Please reconnect QuickBooks.",
                quickbooksError: "Your QuickBooks session has expired. Go to the QuickBooks section to reconnect your account."
              });
              return;
            }
            console.warn('Proactive refresh failed within buffer window; proceeding with existing token — makeQuickBooksRequest will retry on 401');
          }
        }
      }

      // Get customer details
      const customer = await storage.getCustomerById(customerId);
      if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }

      // Get all work orders for the customer
      const callerCompanyId6746 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const allWorkOrders = await storage.getWorkOrders(callerCompanyId6746);
      const workOrders = allWorkOrders.filter(wo => wo.customerId === customerId);

      // Get all billing sheets for the customer
      const allBillingSheets = await storage.getAllBillingSheets(callerCompanyId6746);
      const billingSheets = allBillingSheets.filter(bs => bs.customerId === customerId);

      // Query eligible wet check billings for this customer (Slice 2+)
      const allWcbsForMonthly = await storage.getWetCheckBillingsByCustomer(customerId);
      // INVOICE-CONSTRUCTION gate: a WCB is eligible when it is approved,
      // not yet on an invoice, and the parent wet check has zero unrouted findings
      // (i.e. every finding is triaged — no outstanding manager decisions).
      const eligibleWcbsMonthly = allWcbsForMonthly.filter(wcb => wcbIsEligible(wcb));

      // Filter to only include selected items
      let selectedWorkOrders: (typeof allWorkOrders)[number][] = [];
      let selectedBillingSheets: (typeof allBillingSheets)[number][] = [];
      let selectedWcbs: typeof eligibleWcbsMonthly = [];

      if (workOrderIds.length > 0) {
        selectedWorkOrders = workOrders.filter(wo => 
          workOrderIds.includes(wo.id) && 
          (wo.status === 'approved_passed_to_billing') && 
          !wo.invoiceId
        );
      }

      if (billingSheetIds.length > 0) {
        selectedBillingSheets = billingSheets.filter(bs => 
          billingSheetIds.includes(bs.id) && 
          (bs.status === 'approved_passed_to_billing') && 
          !bs.invoiceId
        );
      }

      if (selectedWetCheckBillingIds.length > 0) {
        selectedWcbs = eligibleWcbsMonthly.filter(wcb =>
          selectedWetCheckBillingIds.includes(wcb.id),
        );
      }

      // If no specific items selected, fall back to all approved unbilled items.
      // WCBs intentionally do NOT auto-expand in the fallback: the caller must
      // pass selectedWetCheckBillingIds explicitly (Slice 5+ will wire the UI).
      if (workOrderIds.length === 0 && billingSheetIds.length === 0 && selectedWetCheckBillingIds.length === 0) {
        selectedWorkOrders = workOrders.filter(wo => 
          (wo.status === 'approved_passed_to_billing') && !wo.invoiceId
        );
        selectedBillingSheets = billingSheets.filter(bs => 
          (bs.status === 'approved_passed_to_billing') && !bs.invoiceId
        );
      }

      if (selectedWorkOrders.length === 0 && selectedBillingSheets.length === 0 && selectedWcbs.length === 0) {
        res.status(400).json({ message: "No valid items selected for invoicing" });
        return;
      }

      // Create the consolidated monthly invoice
      const currentDate = new Date();
      const invoiceNumber = `${Date.now().toString().slice(-5)}`;

      // Resolve billing period — use caller-supplied dates or fall back to current calendar month
      let periodStart: Date;
      let periodEnd: Date;
      if (periodStartInput && periodEndInput) {
        const parseLocalDate = (dateStr: string): Date => {
          const parts = dateStr.split("-");
          if (parts.length !== 3) return new Date(NaN);
          const year = parseInt(parts[0], 10);
          const month = parseInt(parts[1], 10);
          const day = parseInt(parts[2], 10);
          return new Date(year, month - 1, day);
        };
        const parsedStart = parseLocalDate(periodStartInput);
        const parsedEnd = parseLocalDate(periodEndInput);
        if (isNaN(parsedStart.getTime()) || isNaN(parsedEnd.getTime())) {
          res.status(400).json({ message: "Invalid periodStart or periodEnd date value." });
          return;
        }
        if (parsedStart > parsedEnd) {
          res.status(400).json({ message: "periodStart must not be after periodEnd." });
          return;
        }
        periodStart = parsedStart;
        periodEnd = new Date(parsedEnd.getFullYear(), parsedEnd.getMonth(), parsedEnd.getDate(), 23, 59, 59);
      } else {
        periodStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        periodEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);
      }
      
      // Slice 2 — Heal-at-invoice-generation: fix any latent ticket-total drift
      // before aggregating totals so the PDF validator can never be tripped by
      // a stale totalAmount inherited from legacy write bugs.
      //
      // Add-parts-only semantics: only heal when canonical (parts+labor) EXCEEDS
      // the stored total (missing parts scenario). Never lower a stored total.
      //
      // Fail-safe guarantee: the in-memory record is updated to the canonical
      // value BEFORE attempting the DB persist. Even if the DB update fails,
      // the invoice is built with the correct total and the PDF validator passes.
      // The failed persist is logged so operators can run the repair migration
      // to fix the stored value durably.
      const HEAL_TOLERANCE = 0.01;
      for (const wo of selectedWorkOrders) {
        const parts = money(wo.partsSubtotal);
        const labor = money(wo.laborSubtotal);
        const stored = money(wo.totalAmount);
        const healed = parts + labor;
        if (healed > stored + HEAL_TOLERANCE) {
          // Update in-memory first — invoice aggregation always uses canonical total.
          (wo as any).totalAmount = healed.toFixed(2);
          try {
            await db.execute(sql`UPDATE work_orders SET total_amount = ${healed.toFixed(2)} WHERE id = ${wo.id}`);
            await recordAuditEvent(req, {
              action: 'total_drift_repair',
              actionType: 'data_repair',
              targetType: 'work_order',
              targetId: String(wo.id),
              summary: `Drift healed at invoice generation: $${stored.toFixed(2)} → $${healed.toFixed(2)}`,
              details: { before: stored, after: healed, source: 'invoice_generation_heal' },
              severity: 'info',
            });
          } catch (healErr) {
            logger.warn({ err: healErr, woId: wo.id }, '[invoice-heal] work_order DB persist failed — invoice uses canonical in-memory total; run repair migration to fix stored value');
          }
        }
      }
      for (const bs of selectedBillingSheets) {
        const parts = money(bs.partsSubtotal);
        const labor = money(bs.laborSubtotal);
        const stored = money(bs.totalAmount);
        const healed = parts + labor;
        if (healed > stored + HEAL_TOLERANCE) {
          // Update in-memory first — invoice aggregation always uses canonical total.
          (bs as any).totalAmount = healed.toFixed(2);
          try {
            await db.execute(sql`UPDATE billing_sheets SET total_amount = ${healed.toFixed(2)} WHERE id = ${bs.id}`);
            await recordAuditEvent(req, {
              action: 'total_drift_repair',
              actionType: 'data_repair',
              targetType: 'billing_sheet',
              targetId: String(bs.id),
              summary: `Drift healed at invoice generation: $${stored.toFixed(2)} → $${healed.toFixed(2)}`,
              details: { before: stored, after: healed, source: 'invoice_generation_heal' },
              severity: 'info',
            });
          } catch (healErr) {
            logger.warn({ err: healErr, bsId: bs.id }, '[invoice-heal] billing_sheet DB persist failed — invoice uses canonical in-memory total; run repair migration to fix stored value');
          }
        }
      }
      for (const wcb of selectedWcbs) {
        const parts = money(wcb.partsSubtotal);
        const labor = money(wcb.laborSubtotal);
        const stored = money(wcb.totalAmount);
        const healed = parts + labor;
        if (healed > stored + HEAL_TOLERANCE) {
          // Update in-memory first — invoice aggregation always uses canonical total.
          (wcb as any).totalAmount = healed.toFixed(2);
          try {
            await db.execute(sql`UPDATE wet_check_billings SET total_amount = ${healed.toFixed(2)} WHERE id = ${wcb.id}`);
            await recordAuditEvent(req, {
              action: 'total_drift_repair',
              actionType: 'data_repair',
              targetType: 'wet_check_billing',
              targetId: String(wcb.id),
              summary: `Drift healed at invoice generation: $${stored.toFixed(2)} → $${healed.toFixed(2)}`,
              details: { before: stored, after: healed, source: 'invoice_generation_heal' },
              severity: 'info',
            });
          } catch (healErr) {
            logger.warn({ err: healErr, wcbId: wcb.id }, '[invoice-heal] wet_check_billing DB persist failed — invoice uses canonical in-memory total; run repair migration to fix stored value');
          }
        }
      }

      // Use stored financial snapshots as the source of truth.
      // Historical backfill guardrail: if laborSubtotal is null (pre-fix record),
      // laborSubtotal/partsSubtotal will aggregate as 0 but totalAmount is authoritative.
      const laborSubtotal = 
        selectedWorkOrders.reduce((sum, wo) => sum + parseFloat(wo.laborSubtotal || '0'), 0) +
        selectedBillingSheets.reduce((sum, bs) => sum + parseFloat(bs.laborSubtotal || '0'), 0) +
        selectedWcbs.reduce((sum, wcb) => sum + parseFloat(wcb.laborSubtotal || '0'), 0);
      
      const partsSubtotal = 
        selectedWorkOrders.reduce((sum, wo) => sum + parseFloat(wo.partsSubtotal || '0'), 0) +
        selectedBillingSheets.reduce((sum, bs) => sum + parseFloat(bs.partsSubtotal || '0'), 0) +
        selectedWcbs.reduce((sum, wcb) => sum + parseFloat(wcb.partsSubtotal || '0'), 0);
      
      const totalAmount = 
        selectedWorkOrders.reduce((sum, wo) => sum + parseFloat(wo.totalAmount || '0'), 0) +
        selectedBillingSheets.reduce((sum, bs) => sum + parseFloat(bs.totalAmount || '0'), 0) +
        selectedWcbs.reduce((sum, wcb) => sum + parseFloat(wcb.totalAmount || '0'), 0);

      // Create the invoice record (not yet marking items as billed)
      let invoice = await storage.createInvoice({
        invoiceNumber,
        customerId,
        companyId: customer.companyId!,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone || null,
        invoiceMonth: periodStart.getMonth() + 1,
        invoiceYear: periodStart.getFullYear(),
        periodStart,
        periodEnd,
        laborSubtotal: laborSubtotal.toFixed(2),
        partsSubtotal: partsSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        status: 'generated',
      });

      if (!invoice) {
        throw new Error("Failed to create invoice");
      }

      // Create invoice items for work orders (without marking as billed yet)
      for (const workOrder of selectedWorkOrders) {
        const woLaborAmount = parseFloat(workOrder.laborSubtotal || '0');
        const woPartsAmount = parseFloat(workOrder.partsSubtotal || '0');
        const woTotalAmount = parseFloat(workOrder.totalAmount || '0');
        const woAppliedLaborRate = parseFloat(workOrder.appliedLaborRate || workOrder.laborRate || '0');
        
        await storage.createInvoiceItem({
          invoiceId: invoice.id,
          sourceType: 'work_order',
          sourceId: workOrder.id,
          workOrderId: workOrder.id,
          description: `Work Order ${workOrder.workOrderNumber} - ${workOrder.projectName}`,
          workDate: workOrder.completedAt || workOrder.createdAt,
          laborHours: (parseFloat(workOrder.totalHours || '0')).toString(),
          laborRate: woAppliedLaborRate.toFixed(2),
          laborTotal: woLaborAmount.toString(),
          quantity: '1',
          unitPrice: woTotalAmount.toString(),
          totalPrice: woTotalAmount.toString()
        });
      }

      // Create invoice items for billing sheets (without marking as billed yet)
      for (const billingSheet of selectedBillingSheets) {
        await storage.createInvoiceItem({
          invoiceId: invoice.id,
          sourceType: 'billing_sheet',
          sourceId: billingSheet.id,
          billingSheetId: billingSheet.id,
          description: `Billing Sheet ${billingSheet.billingNumber} - ${billingSheet.workDescription}`,
          workDate: billingSheet.workDate,
          laborHours: (parseFloat(billingSheet.totalHours || '0')).toString(),
          laborRate: (parseFloat(billingSheet.laborRate || '0')).toString(),
          laborTotal: (parseFloat(billingSheet.laborSubtotal || '0')).toString(),
          quantity: '1',
          unitPrice: (parseFloat(billingSheet.laborSubtotal || '0') + parseFloat(billingSheet.partsSubtotal || '0')).toString(),
          totalPrice: (parseFloat(billingSheet.laborSubtotal || '0') + parseFloat(billingSheet.partsSubtotal || '0')).toString()
        });
      }

      // Create invoice items for wet check billings (Slice 2+)
      for (const wcb of selectedWcbs) {
        await storage.createInvoiceItem({
          invoiceId: invoice.id,
          sourceType: 'wet_check_billing',
          sourceId: wcb.id,
          wetCheckBillingId: wcb.id,
          description: `WC Billing ${wcb.billingNumber}`,
          workDate: wcb.workDate,
          laborHours: (parseFloat(wcb.totalHours || '0')).toString(),
          laborRate: (parseFloat(wcb.appliedLaborRate || wcb.laborRate || '0')).toString(),
          laborTotal: (parseFloat(wcb.laborSubtotal || '0')).toString(),
          quantity: '1',
          unitPrice: (parseFloat(wcb.totalAmount || '0')).toString(),
          totalPrice: (parseFloat(wcb.totalAmount || '0')).toString(),
        });
      }

      // Send invoice to QuickBooks
      let quickbooksId = null;
      let quickbooksError = null;

      try {
        console.log("Creating invoice in QuickBooks...");

        // Task #1443 — build the generic { amount, description } lines, then
        // hand off to the shared buildAndPostQbInvoice core (same core the
        // per-invoice resync path uses). Line-description builders stay here
        // because they're specific to the monthly source-document mix.
        const qbLines: { amount: number; description: string }[] = [];

        for (const workOrder of selectedWorkOrders) {
          // Use the stored totalAmount as the authoritative QB line amount
          const totalLineAmount = parseFloat(workOrder.totalAmount || '0');
          const appliedLaborRate = parseFloat(workOrder.appliedLaborRate || workOrder.laborRate || '0');
          const partsAmount = parseFloat(workOrder.partsSubtotal || workOrder.totalPartsCost || '0');

          if (totalLineAmount > 0) {
            qbLines.push({
              amount: totalLineAmount,
              description: buildWoLineDescription({ workOrderNumber: workOrder.workOrderNumber, projectName: workOrder.projectName, totalHours: workOrder.totalHours, appliedLaborRate, partsAmount }),
            });
          }
        }

        for (const billingSheet of selectedBillingSheets) {
          const lineTotal = parseFloat(billingSheet.laborSubtotal || '0') + parseFloat(billingSheet.partsSubtotal || '0');
          if (lineTotal > 0) {
            qbLines.push({
              amount: lineTotal,
              description: buildBsLineDescription({ billingNumber: billingSheet.billingNumber, totalHours: billingSheet.totalHours, laborRate: billingSheet.laborRate, partsSubtotal: billingSheet.partsSubtotal }),
            });
          }
        }

        for (const wcb of selectedWcbs) {
          const lineTotal = parseFloat(wcb.totalAmount || '0');
          if (lineTotal > 0) {
            qbLines.push({
              amount: lineTotal,
              description: buildWcbLineDescription({ billingNumber: wcb.billingNumber, totalHours: wcb.totalHours, appliedLaborRate: wcb.appliedLaborRate, laborRate: wcb.laborRate, partsSubtotal: wcb.partsSubtotal }),
            });
          }
        }

        const qbResult = await buildAndPostQbInvoice({
          integration,
          customer,
          docNumber: invoiceNumber,
          qbLines,
          operation: 'Monthly Invoice Creation',
        });

        if (qbResult.quickbooksError) {
          quickbooksError = qbResult.quickbooksError;
        } else {
          quickbooksId = qbResult.quickbooksId ?? null;
          console.log("Successfully created invoice in QuickBooks with ID:", quickbooksId);

          const qbDocNumber = qbResult.qbDocNumber;
          const qbUpdateFields: Partial<InsertInvoice> & { invoiceNumber?: string } = {};
          if (quickbooksId) qbUpdateFields.quickbooksInvoiceId = quickbooksId.toString();
          if (qbResult.quickbooksSyncToken) qbUpdateFields.quickbooksSyncToken = qbResult.quickbooksSyncToken;
          if (qbDocNumber) {
            qbUpdateFields.invoiceNumber = qbDocNumber;
            console.log(`[QB] Syncing invoice number from QB DocNumber: ${qbDocNumber}`);
          }
          if (Object.keys(qbUpdateFields).length > 0) {
            const updated = await storage.updateInvoice(invoice.id, qbUpdateFields);
            if (updated) {
              invoice = updated;
            }
          }
        }
      } catch (qbError: any) {
        console.error('Error connecting to QuickBooks:', qbError);
        quickbooksError = `QuickBooks connection error: ${qbError.message}`;
      }

      // If QuickBooks failed, roll back the local invoice and items
      if (quickbooksError) {
        console.log(`Rolling back local invoice ${invoice.id} due to QuickBooks failure`);
        try {
          await storage.deleteInvoiceItemsByInvoiceId(invoice.id);
          await storage.deleteInvoice(invoice.id);
        } catch (rollbackError) {
          console.error('Error during invoice rollback:', rollbackError);
        }
        res.status(502).json({
          message: "Failed to create invoice in QuickBooks. No items were billed. Please try again.",
          quickbooksError
        });
        return;
      }

      // QuickBooks succeeded — now mark items as billed
      for (const workOrder of selectedWorkOrders) {
        await storage.updateWorkOrder(workOrder.id, { 
          invoiceId: invoice.id,
          billedAt: currentDate,
          status: 'billed'
        });
        void recordLifecycleAudit(req, {
          resource: "work_order",
          action: "work_order.billed",
          targetId: workOrder.id,
          before: { status: workOrder.status },
          after: { status: 'billed' },
          extra: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
          summary: `Work order ${workOrder.workOrderNumber} billed on invoice ${invoice.invoiceNumber}`,
        });
      }

      for (const billingSheet of selectedBillingSheets) {
        await storage.updateBillingSheet(billingSheet.id, { 
          invoiceId: invoice.id,
          billedAt: currentDate,
          status: 'billed'
        });
        void recordLifecycleAudit(req, {
          resource: "billing_sheet",
          action: "billing_sheet.billed",
          targetId: billingSheet.id,
          before: { status: billingSheet.status },
          after: { status: 'billed' },
          extra: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
          summary: `Billing sheet ${billingSheet.id} billed on invoice ${invoice.invoiceNumber}`,
        });
      }

      // Mark wet check billings as billed (Slice 2+)
      for (const wcb of selectedWcbs) {
        await storage.updateWetCheckBilling(wcb.id, {
          invoiceId: invoice.id,
          billedAt: currentDate,
          status: 'billed',
        });
        void recordLifecycleAudit(req, {
          resource: "wet_check_billing",
          action: "wet_check_billing.billed",
          targetId: wcb.id,
          before: { status: wcb.status },
          after: { status: 'billed' },
          extra: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
          summary: `Wet check billing ${wcb.id} billed on invoice ${invoice.invoiceNumber}`,
        });
      }

      // Reconciliation: ensure any billing sheet OR wet check billing that is
      // an invoice line item but was missed by the primary stamping loops above
      // is also marked as billed. The primary loops are the correctness
      // mechanism; this block is a purely defensive safety net.
      try {
        const invoiceItemsForReconciliation = await storage.getInvoiceItems(invoice.id);
        for (const item of invoiceItemsForReconciliation) {
          if (item.sourceType === 'billing_sheet' && item.sourceId) {
            const bs = await storage.getBillingSheetById(item.sourceId, callerCompanyId6746);
            if (bs && !bs.invoiceId) {
              await storage.updateBillingSheet(bs.id, {
                invoiceId: invoice.id,
                billedAt: currentDate,
                status: 'billed'
              });
              console.log(`Reconciliation: marked billing sheet ${bs.id} as billed for invoice ${invoice.id}`);
            }
          } else if (item.sourceType === 'wet_check_billing' && item.sourceId) {
            const wcb = await storage.getWetCheckBillingById(item.sourceId, null);
            if (wcb && !wcb.invoiceId) {
              await storage.updateWetCheckBilling(wcb.id, {
                invoiceId: invoice.id,
                billedAt: currentDate,
                status: 'billed',
              });
              console.log(`Reconciliation: marked wet check billing ${wcb.id} as billed for invoice ${invoice.id}`);
            }
          }
        }
      } catch (reconcileError) {
        console.error('Error during billing sheet / wet check billing reconciliation:', reconcileError);
      }

      // Task #693 — Financial Pulse Slice 4. Fire budget threshold
      // alerts (in-app + push + email) idempotently. Fire-and-forget:
      // invoice finalization MUST NOT fail if the alert pipeline
      // throws (the service has its own top-level catch-all too).
      void (async () => {
        try {
          const { checkBudgetThresholds } = await import("../services/budget-alert-service");
          await checkBudgetThresholds(invoice);
        } catch (alertError) {
          console.error(`Budget alerts failed for invoice ${invoice.id}:`, alertError);
        }
      })();

      // Generate invoice detail PDF automatically in background
      const pdfService = new InvoicePdfService(storage);
      pdfService.generateAndSaveInvoicePdf(invoice.id).then(result => {
        if (result.success) {
          console.log(`Invoice PDF generated successfully for invoice ${invoice.id}`);
        } else {
          console.error(`Failed to generate PDF for invoice ${invoice.id}:`, result.error);
        }
      }).catch(error => {
        console.error(`Error generating PDF for invoice ${invoice.id}:`, error);
      });

      res.json({
        message: "Monthly invoice created successfully and synced to QuickBooks",
        invoice,
        invoiceNumber: invoice.invoiceNumber,
        totalAmount: totalAmount.toFixed(2),
        itemCount: selectedWorkOrders.length + selectedBillingSheets.length + selectedWcbs.length,
        quickbooksId,
        quickbooksSuccess: true,
        quickbooksError: null
      });
    } catch (error) {
      console.error("Error creating monthly invoice:", error);
      res.status(500).json({ message: "Failed to create monthly invoice" });
    }
  });


  // Task #1809 — "Bill Separately": create a standalone invoice for a single ticket.
  // Guard: requireAuthentication + requireInvoiceWrite (same as monthly endpoint).
  // Body: { ticketType: 'work_order' | 'billing_sheet' | 'wet_check_billing', ticketId: number }
  // Returns: the created invoice record.
  app.post("/api/invoices/bill-separately", requireAuthentication, requireInvoiceWrite, async (req, res) => {
    try {
      const bodySchema = z.object({
        ticketType: z.enum(['work_order', 'billing_sheet', 'wet_check_billing']),
        ticketId: z.number().int().positive(),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid request body", issues: parsed.error.issues });
        return;
      }
      const { ticketType, ticketId } = parsed.data;

      const callerRole = req.authenticatedUserRole;
      const callerCompanyId = req.authenticatedUserCompanyId ?? null;
      const isSuperAdmin = callerRole === 'super_admin';
      const currentDate = new Date();

      // ── Resolve ticket and verify ownership ──────────────────────────────
      let workDate: Date;
      let laborSubtotal: number;
      let partsSubtotal: number;
      let totalAmount: number;
      let description: string;
      let customerId: number;
      let ticketInvoiceId: number | null | undefined;

      if (ticketType === 'work_order') {
        const wo = await storage.getWorkOrder(ticketId, isSuperAdmin ? null : callerCompanyId);
        if (!wo) { res.status(404).json({ message: "Work order not found" }); return; }
        if (wo.status !== 'approved_passed_to_billing') {
          res.status(409).json({ message: "Work order is not approved and ready to bill" }); return;
        }
        ticketInvoiceId = wo.invoiceId;
        workDate = wo.completedAt ? new Date(wo.completedAt) : currentDate;
        laborSubtotal = parseFloat(wo.laborSubtotal || '0');
        partsSubtotal = parseFloat(wo.totalPartsCost || '0');
        totalAmount = parseFloat(wo.totalAmount || '0');
        description = `Work Order ${wo.workOrderNumber}`;
        customerId = wo.customerId!;
      } else if (ticketType === 'billing_sheet') {
        // getBillingSheetById already scopes to callerCompanyId — no secondary check needed.
        const bs = await storage.getBillingSheetById(ticketId, isSuperAdmin ? null : callerCompanyId);
        if (!bs) { res.status(404).json({ message: "Billing sheet not found" }); return; }
        if (bs.status !== 'approved_passed_to_billing') {
          res.status(409).json({ message: "Billing sheet is not approved and ready to bill" }); return;
        }
        ticketInvoiceId = bs.invoiceId;
        workDate = new Date(bs.workDate);
        laborSubtotal = parseFloat(bs.laborSubtotal || '0');
        partsSubtotal = parseFloat(bs.partsSubtotal || '0');
        totalAmount = parseFloat(bs.totalAmount || '0');
        description = `Billing Sheet ${bs.billingNumber}`;
        customerId = bs.customerId!;
      } else {
        // wet_check_billing — getWetCheckBillingById already scopes to callerCompanyId.
        const wcb = await storage.getWetCheckBillingById(ticketId, isSuperAdmin ? null : callerCompanyId);
        if (!wcb) { res.status(404).json({ message: "Wet check billing not found" }); return; }
        // Inline eligibility: status must be approved_passed_to_billing and not yet invoiced.
        if (wcb.status !== 'approved_passed_to_billing' || wcb.invoiceId != null) {
          res.status(409).json({ message: "Wet check billing is not eligible for invoicing" }); return;
        }
        ticketInvoiceId = wcb.invoiceId;
        workDate = new Date(wcb.workDate);
        laborSubtotal = parseFloat(wcb.laborSubtotal || '0');
        partsSubtotal = parseFloat(wcb.partsSubtotal || '0');
        totalAmount = parseFloat(wcb.totalAmount || '0');
        description = `WC Billing ${wcb.billingNumber}`;
        customerId = wcb.customerId!;
      }

      // ── Double-billing guard ─────────────────────────────────────────────
      if (ticketInvoiceId) {
        res.status(409).json({ message: "This item is already on an invoice" });
        return;
      }

      // ── Customer lookup ──────────────────────────────────────────────────
      const customer = await storage.getCustomerById(customerId);
      if (!customer) { res.status(404).json({ message: "Customer not found" }); return; }

      // ── Create the standalone invoice ────────────────────────────────────
      const invoiceNumber = `${Date.now().toString().slice(-5)}`;
      // Period = the ticket's work date (start of day → end of day)
      const periodStart = new Date(workDate.getFullYear(), workDate.getMonth(), workDate.getDate());
      const periodEnd = new Date(workDate.getFullYear(), workDate.getMonth(), workDate.getDate(), 23, 59, 59);

      let invoice = await storage.createInvoice({
        invoiceNumber,
        customerId,
        companyId: customer.companyId!,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone ?? null,
        invoiceMonth: periodStart.getMonth() + 1,
        invoiceYear: periodStart.getFullYear(),
        periodStart,
        periodEnd,
        laborSubtotal: laborSubtotal.toFixed(2),
        partsSubtotal: partsSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        status: 'generated',
        billingType: 'standalone',
      } as any);

      if (!invoice) { throw new Error("Failed to create standalone invoice"); }

      // ── Create invoice item ──────────────────────────────────────────────
      if (ticketType === 'work_order') {
        const wo = await storage.getWorkOrder(ticketId, isSuperAdmin ? null : callerCompanyId);
        await storage.createInvoiceItem({
          invoiceId: invoice.id,
          sourceType: 'work_order',
          sourceId: ticketId,
          workOrderId: ticketId,
          description: `${description} - ${wo?.projectName ?? ''}`,
          workDate: periodStart,
          laborHours: String(parseFloat(wo?.totalHours || '0')),
          laborRate: String(parseFloat(wo?.appliedLaborRate || wo?.laborRate || '0')),
          laborTotal: String(laborSubtotal),
          quantity: '1',
          unitPrice: String(totalAmount),
          totalPrice: String(totalAmount),
        });
      } else if (ticketType === 'billing_sheet') {
        const bs = await storage.getBillingSheetById(ticketId, isSuperAdmin ? null : callerCompanyId);
        await storage.createInvoiceItem({
          invoiceId: invoice.id,
          sourceType: 'billing_sheet',
          sourceId: ticketId,
          billingSheetId: ticketId,
          description: `${description} - ${bs?.workDescription ?? ''}`,
          workDate: periodStart,
          laborHours: String(parseFloat(bs?.totalHours || '0')),
          laborRate: String(parseFloat(bs?.laborRate || '0')),
          laborTotal: String(laborSubtotal),
          quantity: '1',
          unitPrice: String(totalAmount),
          totalPrice: String(totalAmount),
        });
      } else {
        const wcb = await storage.getWetCheckBillingById(ticketId, isSuperAdmin ? null : callerCompanyId);
        await storage.createInvoiceItem({
          invoiceId: invoice.id,
          sourceType: 'wet_check_billing',
          sourceId: ticketId,
          wetCheckBillingId: ticketId,
          description,
          workDate: periodStart,
          laborHours: String(parseFloat(wcb?.totalHours || '0')),
          laborRate: String(parseFloat(wcb?.appliedLaborRate || wcb?.laborRate || '0')),
          laborTotal: String(laborSubtotal),
          quantity: '1',
          unitPrice: String(totalAmount),
          totalPrice: String(totalAmount),
        });
      }

      // ── QuickBooks sync (non-blocking — follows same pattern as monthly) ──
      let quickbooksId: string | null = null;
      let quickbooksError: string | null = null;
      try {
        const userCompanyIdStr = callerCompanyId ? String(callerCompanyId) : null;
        const qbLookup = userCompanyIdStr ? await storage.getQuickBooksIntegrationByCompanyId(userCompanyIdStr) : null;
        const integration = qbLookup?.realmId ? await storage.getQuickBooksIntegration(qbLookup.realmId) : null;
        if (integration && integration.accessToken && integration.connectionStatus !== 'reconnect_required') {
          const qbLines: { amount: number; description: string }[] = [];
          if (totalAmount > 0) {
            qbLines.push({ amount: totalAmount, description });
          }
          const qbResult = await buildAndPostQbInvoice({
            integration,
            customer,
            docNumber: invoiceNumber,
            qbLines,
            operation: 'Standalone Invoice Creation',
          });
          if (qbResult.quickbooksError) {
            quickbooksError = qbResult.quickbooksError;
          } else {
            quickbooksId = qbResult.quickbooksId ?? null;
            const qbUpdateFields: Record<string, any> = {};
            if (quickbooksId) qbUpdateFields.quickbooksInvoiceId = quickbooksId;
            if (qbResult.quickbooksSyncToken) qbUpdateFields.quickbooksSyncToken = qbResult.quickbooksSyncToken;
            if (qbResult.qbDocNumber) qbUpdateFields.invoiceNumber = qbResult.qbDocNumber;
            if (Object.keys(qbUpdateFields).length > 0) {
              const updated = await storage.updateInvoice(invoice.id, qbUpdateFields);
              if (updated) invoice = updated;
            }
          }
        }
      } catch (qbErr: any) {
        quickbooksError = `QuickBooks sync error: ${qbErr.message}`;
      }

      // If QB sync hard-failed, roll back invoice
      if (quickbooksError && quickbooksId === null) {
        try {
          await storage.deleteInvoiceItemsByInvoiceId(invoice.id);
          await storage.deleteInvoice(invoice.id);
        } catch { /* ignore rollback errors */ }
        res.status(502).json({ message: "Failed to sync to QuickBooks. No items were billed.", quickbooksError });
        return;
      }

      // ── Stamp the ticket as billed ───────────────────────────────────────
      if (ticketType === 'work_order') {
        await storage.updateWorkOrder(ticketId, { invoiceId: invoice.id, billedAt: currentDate, status: 'billed' });
        void recordLifecycleAudit(req, {
          resource: "work_order", action: "work_order.billed", targetId: ticketId,
          before: { status: 'approved_passed_to_billing' }, after: { status: 'billed' },
          extra: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, billingType: 'standalone' },
          summary: `Work order ${ticketId} billed standalone on invoice ${invoice.invoiceNumber}`,
        });
      } else if (ticketType === 'billing_sheet') {
        await storage.updateBillingSheet(ticketId, { invoiceId: invoice.id, billedAt: currentDate, status: 'billed' });
        void recordLifecycleAudit(req, {
          resource: "billing_sheet", action: "billing_sheet.billed", targetId: ticketId,
          before: { status: 'approved_passed_to_billing' }, after: { status: 'billed' },
          extra: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, billingType: 'standalone' },
          summary: `Billing sheet ${ticketId} billed standalone on invoice ${invoice.invoiceNumber}`,
        });
      } else {
        await storage.updateWetCheckBilling(ticketId, { invoiceId: invoice.id, billedAt: currentDate, status: 'billed' });
        void recordLifecycleAudit(req, {
          resource: "wet_check_billing", action: "wet_check_billing.billed", targetId: ticketId,
          before: { status: 'approved_passed_to_billing' }, after: { status: 'billed' },
          extra: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, billingType: 'standalone' },
          summary: `Wet check billing ${ticketId} billed standalone on invoice ${invoice.invoiceNumber}`,
        });
      }

      // ── Budget alerts (fire-and-forget) ──────────────────────────────────
      void (async () => {
        try {
          const { checkBudgetThresholds } = await import("../services/budget-alert-service");
          await checkBudgetThresholds(invoice);
        } catch (alertErr) {
          logger.warn({ err: alertErr, invoiceId: invoice.id }, "Budget alerts failed for standalone invoice");
        }
      })();

      // ── PDF generation (background) ──────────────────────────────────────
      const pdfService = new InvoicePdfService(storage);
      pdfService.generateAndSaveInvoicePdf(invoice.id).catch(err =>
        logger.error({ err, invoiceId: invoice.id }, "Standalone invoice PDF generation failed")
      );

      res.json({
        message: "Standalone invoice created successfully",
        invoice,
        invoiceNumber: invoice.invoiceNumber,
        totalAmount: totalAmount.toFixed(2),
        quickbooksId,
        quickbooksSuccess: !!quickbooksId,
        quickbooksError,
      });
    } catch (error) {
      logger.error({ err: error }, "Error creating standalone invoice");
      res.status(500).json({ message: "Failed to create standalone invoice" });
    }
  });

  // Customer CRUD — extracted to ./customer-routes.ts
  registerCustomerRoutes(app, {
    requireAuthentication,
    requireCompanyAdminAccess,
    requireCustomerEditAccess,
    applyBillingNotesVisibility,
  });
  // Task #687 — Financial Pulse Slice 1: per-customer budget usage.
  registerBudgetRoutes(app, { requireAuthentication });
  registerFinancialPulseRoutes(app, { requireAuthentication });
  // Task #1425 — merge duplicate monthly invoices for the same customer.
  registerInvoiceMergeRoutes(app, { requireAuthentication, requireInvoiceWrite });
  // Task #1443 — per-invoice QuickBooks sync/resync (post-merge).
  registerInvoiceSyncQuickbooksRoutes(app, {
    requireAuthentication,
    requireInvoiceWrite,
    createQuickBooksInvoice: createQuickBooksInvoiceForInvoice,
  });
  // Task #1438 — mark an invoice sent / unsent (records delivery, no email).
  registerInvoiceMarkSentRoutes(app, { requireAuthentication, requireInvoiceSend, requireInvoiceWrite });
  // Task #1887 — payment reminders. Same CAN_SEND_INVOICE_EMAIL capability as
  // the invoice PDF send route; nothing here runs on a schedule.
  // One core, shared by the single send and the batch, so there is literally
  // one send path in the process — the batch cannot drift from the refusals,
  // the throttle or the recording the single send enforces.
  const reminderCore = createReminderCore();
  registerInvoiceReminderRoutes(app, {
    requireAuthentication,
    requireInvoiceSend,
    _core: reminderCore,
  });
  // `/api/invoices/reminders/{preview,batch}` cannot be swallowed by
  // `/api/invoices/:id/reminders`: that pattern requires a literal final
  // "reminders" segment, and neither of these has one.
  registerInvoiceReminderBatchRoutes(app, {
    requireAuthentication,
    requireInvoiceSend,
    _core: reminderCore,
  });
  // Task #1889 — internal A/R notes. GET + POST only; there is deliberately no
  // update or delete route in that module and there must never be one.
  // Gated on requireArNotesAccess (CAN_READ_AR_NOTES), which is NARROWER than
  // requireInvoiceRead: irrigation_manager reads invoices and is refused here.
  registerInvoiceArNoteRoutes(app, { requireAuthentication, requireArNotesAccess });
  // Task #1710 — Invoice Correction & Reissue (Guided Dispute Flow).
  // syncInvoiceToQb: inject the local closure so the qb-sync endpoint can
  // call updateQbInvoiceInPlace without duplicating QB plumbing here.
  registerInvoiceCorrectionRoutes(app, {
    requireAuthentication,
    requireInvoiceWrite,
    syncInvoiceToQb: createQuickBooksInvoiceForInvoice,
  });
  // Task #1811 — Invoice Editability & Walk-Back (metadata PATCH, return-to-draft,
  // membership edit, finalize, void & release).
  registerInvoiceEditabilityRoutes(app, {
    requireAuthentication,
    requireInvoiceRead,
    requireInvoiceWrite,
    syncInvoiceToQb: createQuickBooksInvoiceForInvoice,
  });
  // Task #1831 — QBO Payment-Status Sync.
  // Reads Balance from QBO for active QBO-linked invoices; stamps payment_status / balance.
  registerQbPaymentSyncRoutes(app, {
    requireAuthentication,
    requireInvoiceWrite,
    makeRequest: makeQuickBooksRequest,
    apiBase:
      process.env.NODE_ENV === "production"
        ? "https://quickbooks.api.intuit.com"
        : "https://sandbox-quickbooks.api.intuit.com",
    getQbIntegration: async (companyId: string) => {
      const lookup = await storage.getQuickBooksIntegrationByCompanyId(companyId);
      if (!lookup?.realmId) return null;
      return storage.getQuickBooksIntegration(lookup.realmId);
    },
  });
  // Slice 4a — Super-admin DB migration management page.
  registerAdminMigrationsRoutes(app, requireAuthentication);

  // WC Labor Slice 2 — bulk seeder endpoint (super_admin only).
  // Triggers seedIssueTypeConfigsForActiveCompanies() on demand so companies
  // that were created before the auto-seed was wired in can be backfilled
  // without a server restart.
  app.post("/api/admin/seed-issue-type-configs", requireAuthentication, async (req: any, res: Response) => {
    if (req.authenticatedUserRole !== "super_admin") {
      res.status(403).json({ message: "Super admin access required" });
      return;
    }
    try {
      const companiesSeeded = await seedIssueTypeConfigsForActiveCompanies();
      res.json({ ok: true, companiesSeeded });
    } catch (err) {
      logger.error({ err }, "POST /api/admin/seed-issue-type-configs failed");
      res.status(500).json({ message: "Seed failed", error: String(err) });
    }
  });
  // WC Labor — one-shot backfill: re-compute repairLaborHours for every
  // non-manually-set zone then re-derive totals on uninvoiced WCBs.
  // Safe to re-run (idempotent). Only touches rows where
  //   repair_labor_manually_set = false  AND  invoice_id IS NULL on the WCB.
  app.post("/api/admin/backfill/wcb-zone-labor", requireAuthentication, async (req: any, res: Response) => {
    if (req.authenticatedUserRole !== "super_admin") {
      res.status(403).json({ message: "Super admin access required" });
      return;
    }
    try {
      function resolveKey(raw: string): string {
        return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
      }

      // ── Step 1: recompute zone repair labor ─────────────────────────────
      const configRows = await db.execute<{ company_id: number; issue_type: string; default_labor_hours: string }>(
        sql`SELECT company_id, issue_type, default_labor_hours FROM issue_type_configs`
      );
      const catalog = new Map<number, Map<string, number>>();
      for (const row of configRows.rows) {
        if (!catalog.has(row.company_id)) catalog.set(row.company_id, new Map());
        catalog.get(row.company_id)!.set(resolveKey(row.issue_type), parseFloat(String(row.default_labor_hours)) || 0);
      }

      const zoneRows = await db.execute<{ id: number; wet_check_id: number; repair_labor_hours: string }>(
        sql`SELECT id, wet_check_id, repair_labor_hours FROM wet_check_zone_records WHERE repair_labor_manually_set = false`
      );

      const wcIds = [...new Set(zoneRows.rows.map((z) => z.wet_check_id))];
      const wcRows = wcIds.length > 0
        ? await db.execute<{ id: number; company_id: number; total_labor_hours: string }>(
            sql`SELECT id, company_id, total_labor_hours FROM wet_checks WHERE id = ANY(${sql.param(wcIds)}::int[])`
          )
        : { rows: [] };
      const wcMap = new Map<number, { companyId: number; baseLaborHours: number }>();
      for (const w of wcRows.rows) {
        wcMap.set(w.id, { companyId: w.company_id, baseLaborHours: parseFloat(String(w.total_labor_hours ?? "0")) || 0 });
      }

      const findingRows = await db.execute<{ zone_record_id: number; issue_type: string; quantity: number }>(
        sql`SELECT zone_record_id, issue_type, quantity FROM wet_check_findings`
      );
      const findingsByZone = new Map<number, Array<{ issueType: string; quantity: number }>>();
      for (const f of findingRows.rows) {
        if (!findingsByZone.has(f.zone_record_id)) findingsByZone.set(f.zone_record_id, []);
        findingsByZone.get(f.zone_record_id)!.push({ issueType: f.issue_type, quantity: f.quantity });
      }

      let zonesUpdated = 0;
      const changedZoneIds = new Set<number>();

      for (const zone of zoneRows.rows) {
        const wc = wcMap.get(zone.wet_check_id);
        if (!wc) continue;
        const companyCatalog = catalog.get(wc.companyId) ?? new Map();
        const findings = findingsByZone.get(zone.id) ?? [];
        let totalHours = 0;
        for (const f of findings) {
          const perUnit = companyCatalog.get(resolveKey(f.issueType)) ?? 0;
          const qty = isNaN(f.quantity) || f.quantity < 1 ? 1 : f.quantity;
          totalHours += perUnit * qty;
        }
        const newVal = totalHours.toFixed(2);
        const oldVal = parseFloat(String(zone.repair_labor_hours)).toFixed(2);
        if (newVal === oldVal) continue;
        await db.execute(
          sql`UPDATE wet_check_zone_records SET repair_labor_hours = ${newVal} WHERE id = ${zone.id}`
        );
        zonesUpdated++;
        changedZoneIds.add(zone.id);
      }

      // ── Step 2: recompute WCB totals for uninvoiced WCBs ────────────────
      let wcbsUpdated = 0;
      if (changedZoneIds.size > 0) {
        const affectedWcbs = await db.execute<{
          wcb_id: number; wet_check_id: number; parts_subtotal: string;
          labor_rate: string; applied_labor_rate: string | null;
        }>(
          sql`
            SELECT DISTINCT wcb.id AS wcb_id, wcb.wet_check_id, wcb.parts_subtotal,
                            wcb.labor_rate, wcb.applied_labor_rate
            FROM wet_check_billings wcb
            JOIN wet_check_findings wf ON wf.wet_check_billing_id = wcb.id
            WHERE wcb.invoice_id IS NULL
              AND wf.zone_record_id = ANY(${sql.param([...changedZoneIds])}::int[])
          `
        );

        const wcIds2 = [...new Set(affectedWcbs.rows.map((r) => r.wet_check_id))];
        const wcRows2 = wcIds2.length > 0
          ? await db.execute<{ id: number; total_labor_hours: string }>(
              sql`SELECT id, total_labor_hours FROM wet_checks WHERE id = ANY(${sql.param(wcIds2)}::int[])`
            )
          : { rows: [] };
        const wcBaseLaborMap = new Map<number, number>();
        for (const w of wcRows2.rows) wcBaseLaborMap.set(w.id, parseFloat(String(w.total_labor_hours ?? "0")) || 0);

        for (const wcb of affectedWcbs.rows) {
          const zoneResult = await db.execute<{ zone_record_id: number }>(
            sql`SELECT DISTINCT zone_record_id FROM wet_check_findings WHERE wet_check_billing_id = ${wcb.wcb_id} AND zone_record_id IS NOT NULL`
          );
          const zoneIds = zoneResult.rows.map((r) => r.zone_record_id);
          let zoneRepairHours = 0;
          if (zoneIds.length > 0) {
            const zoneHrsResult = await db.execute<{ repair_labor_hours: string }>(
              sql`SELECT repair_labor_hours FROM wet_check_zone_records WHERE id = ANY(${sql.param(zoneIds)}::int[])`
            );
            for (const z of zoneHrsResult.rows) zoneRepairHours += parseFloat(String(z.repair_labor_hours ?? "0")) || 0;
          }
          const baseLaborHours = wcBaseLaborMap.get(wcb.wet_check_id) ?? 0;
          const totalHours = baseLaborHours + zoneRepairHours;
          const rate = parseFloat(String(wcb.applied_labor_rate ?? wcb.labor_rate)) || 0;
          const partsSubtotal = parseFloat(String(wcb.parts_subtotal ?? "0")) || 0;
          const laborSubtotal = totalHours * rate;
          const totalAmount = partsSubtotal + laborSubtotal;
          await db.execute(
            sql`UPDATE wet_check_billings SET total_hours = ${totalHours.toFixed(2)}, labor_subtotal = ${laborSubtotal.toFixed(2)}, total_amount = ${totalAmount.toFixed(2)}, updated_at = NOW() WHERE id = ${wcb.wcb_id}`
          );
          wcbsUpdated++;
        }
      }

      logger.info({ zonesUpdated, wcbsUpdated }, "POST /api/admin/backfill/wcb-zone-labor complete");
      res.json({ ok: true, zonesUpdated, wcbsUpdated });
    } catch (err) {
      logger.error({ err }, "POST /api/admin/backfill/wcb-zone-labor failed");
      res.status(500).json({ message: "Backfill failed", error: String(err) });
    }
  });

  // WC Labor Slice 3 — WC labor backfill (start / status / cancel / reset).
  registerWcLaborBackfillRoutes(app, requireAuthentication);
  registerInspectionZoneBackfillRoutes(app, requireAuthentication);
  // Task #760 — Temporary one-time cleanup: delete test invoice #71256.
  // Remove this registration (and cleanup-invoice-71256.ts) after successful run.
  registerCleanupInvoice71256Routes(app, { requireAuthentication });
  // ── Property Boundary (GIS) ────────────────────────────────────────────────
  // NOTE: Express 5 / path-to-regexp v8 — do NOT use inline regex param syntax
  // like `:id(\\d+)`. Validate manually below.
  // Coerce a `string | number | null | undefined` payload value into a finite
  // number, or return `null` if absent. Throws a ZodError-shaped error if the
  // value is present but cannot be parsed as a finite number, so the route
  // returns a 400 instead of a 500 on malformed input like `"abc"`.
  const finiteNumber = (label: string) =>
    z
      .union([z.string(), z.number()])
      .optional()
      .nullable()
      .transform((v, ctx) => {
        if (v == null || v === "") return null;
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} must be a finite number`,
          });
          return z.NEVER;
        }
        return n;
      });

  const propertyBoundarySchema = z.object({
    propertyBoundary: z.string().refine((s) => {
      try {
        const obj = JSON.parse(s);
        if (!obj || typeof obj !== "object") return false;
        const t = obj.type;
        if (t === "Polygon" || t === "MultiPolygon") return true;
        if (t === "Feature" && obj.geometry &&
          (obj.geometry.type === "Polygon" || obj.geometry.type === "MultiPolygon")) {
          return true;
        }
        if (t === "FeatureCollection" && Array.isArray(obj.features) && obj.features.length > 0) {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }, { message: "propertyBoundary must be GeoJSON Polygon | MultiPolygon | Feature | non-empty FeatureCollection" }),
    propertyBoundaryKml: z.string().optional().nullable(),
    propertyBoundaryFileName: z.string().optional().nullable(),
    propertyBoundaryCenterLat: finiteNumber("propertyBoundaryCenterLat").refine(
      (v) => v == null || (v >= -90 && v <= 90),
      { message: "propertyBoundaryCenterLat must be between -90 and 90" },
    ),
    propertyBoundaryCenterLng: finiteNumber("propertyBoundaryCenterLng").refine(
      (v) => v == null || (v >= -180 && v <= 180),
      { message: "propertyBoundaryCenterLng must be between -180 and 180" },
    ),
    propertyBoundaryZoom: finiteNumber("propertyBoundaryZoom").refine(
      (v) => v == null || (v >= 0 && v <= 24),
      { message: "propertyBoundaryZoom must be between 0 and 24" },
    ),
    propertyBoundaryAreaAcres: finiteNumber("propertyBoundaryAreaAcres").refine(
      (v) => v == null || v >= 0,
      { message: "propertyBoundaryAreaAcres must be non-negative" },
    ),
  });

  // Multi-tenant guard for property-boundary routes: a customer record belongs
  // to a company, and only super_admins can cross company boundaries. Returns
  // the customer (or sends a 403/404 and returns null) so callers can branch.
  const loadCustomerWithTenantCheck = async (req: any, res: any, id: number) => {
    const customer = await storage.getCustomer(id);
    if (!customer) {
      res.status(404).json({ message: "Customer not found" });
      return null;
    }
    const role = (req as any).authenticatedUserRole || headerUserRole(req);
    if (role !== 'super_admin') {
      const userCompanyId = (req as any).authenticatedUserCompanyId
        ?? (headerUserCompanyId(req)
          ? parseInt(String(headerUserCompanyId(req)))
          : null);
      if (!userCompanyId || Number(userCompanyId) !== Number(customer.companyId)) {
        res.status(403).json({ message: "Access denied for this customer" });
        return null;
      }
    }
    return customer;
  };

  app.get("/api/customers/:id/property-boundary", requireAuthentication, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid customer id" }); return; }
      const customer = await loadCustomerWithTenantCheck(req, res, id);
      if (!customer) return;
      res.json({
        propertyBoundary: customer.propertyBoundary ?? null,
        propertyBoundaryKml: customer.propertyBoundaryKml ?? null,
        propertyBoundaryFileName: customer.propertyBoundaryFileName ?? null,
        propertyBoundaryCenterLat: customer.propertyBoundaryCenterLat ?? null,
        propertyBoundaryCenterLng: customer.propertyBoundaryCenterLng ?? null,
        propertyBoundaryZoom: customer.propertyBoundaryZoom ?? null,
        propertyBoundaryAreaAcres: customer.propertyBoundaryAreaAcres ?? null,
        propertyBoundaryUpdatedAt: customer.propertyBoundaryUpdatedAt ?? null,
      });
      return;
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch property boundary" });
      return;
    }
  });

  app.put(
    "/api/customers/:id/property-boundary",
    requireAuthentication,
    requireBoundaryEditAccess,
    async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid customer id" }); return; }
        const guard = await loadCustomerWithTenantCheck(req, res, id);
        if (!guard) return;
        const parsed = propertyBoundarySchema.parse(req.body);
        const updateData: Partial<InsertCustomer> = {
          propertyBoundary: parsed.propertyBoundary,
          propertyBoundaryKml: parsed.propertyBoundaryKml ?? null,
          propertyBoundaryFileName: parsed.propertyBoundaryFileName ?? null,
          propertyBoundaryCenterLat:
            parsed.propertyBoundaryCenterLat == null ? null : String(parsed.propertyBoundaryCenterLat),
          propertyBoundaryCenterLng:
            parsed.propertyBoundaryCenterLng == null ? null : String(parsed.propertyBoundaryCenterLng),
          propertyBoundaryZoom:
            parsed.propertyBoundaryZoom == null
              ? null
              : typeof parsed.propertyBoundaryZoom === "number"
                ? parsed.propertyBoundaryZoom
                : parseInt(parsed.propertyBoundaryZoom, 10),
          propertyBoundaryAreaAcres:
            parsed.propertyBoundaryAreaAcres == null ? null : String(parsed.propertyBoundaryAreaAcres),
          propertyBoundaryUpdatedAt: new Date(),
        };
        const customer = await storage.updateCustomer(id, updateData);
        if (!customer) { res.status(404).json({ message: "Customer not found" }); return; }
        res.json(applyBillingNotesVisibility(req, customer));
        return;
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(400).json({ message: "Invalid boundary data", errors: error.issues });
          return;
        }
        console.error(error);
        res.status(500).json({ message: "Failed to save property boundary" });
        return;
      }
    },
  );

  app.delete(
    "/api/customers/:id/property-boundary",
    requireAuthentication,
    requireBoundaryEditAccess,
    async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid customer id" }); return; }
        const guard = await loadCustomerWithTenantCheck(req, res, id);
        if (!guard) return;
        const clearData: Partial<InsertCustomer> = {
          propertyBoundary: null,
          propertyBoundaryKml: null,
          propertyBoundaryFileName: null,
          propertyBoundaryCenterLat: null,
          propertyBoundaryCenterLng: null,
          propertyBoundaryZoom: null,
          propertyBoundaryAreaAcres: null,
          propertyBoundaryUpdatedAt: null,
        };
        const customer = await storage.updateCustomer(id, clearData);
        if (!customer) { res.status(404).json({ message: "Customer not found" }); return; }
        res.json(applyBillingNotesVisibility(req, customer));
        return;
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to remove property boundary" });
        return;
      }
    },
  );

  // Customer-related data endpoints
  app.get("/api/customers/:id/estimates", requireAuthentication, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id);
      const estimates = await storage.getEstimatesByCustomer(customerId);
      // Task #643 — strip pricing for field_tech.
      res.json(applyPricingVisibility(req, estimates));
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch customer estimates" });
    }
  });

  app.get("/api/customers/:id/work-orders", requireAuthentication, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id);
      const callerCompanyId7414 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const workOrders = await storage.getWorkOrdersByCustomer(customerId, callerCompanyId7414);
      res.json(workOrders);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch customer work orders" });
    }
  });

  app.get("/api/customers/:id/billing-sheets", requireAuthentication, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id);
      const callerCompanyId7425 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const billingSheets = await storage.getBillingSheetsByCustomer(customerId, callerCompanyId7425);
      res.json(billingSheets);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch customer billing sheets" });
    }
  });

  app.post("/api/customers/import-csv", requireAuthentication, requireCompanyAdminAccess, async (req, res) => {
    try {
      const file = req.files?.file;
      if (!file) {
        res.status(400).json({ message: "No file uploaded" });
        return;
      }

      const csvData = (Array.isArray(file) ? file[0] : file).data.toString();
      const lines = csvData.split('\n').filter((line: string) => line.trim());
      
      if (lines.length < 2) {
        res.status(400).json({ message: "CSV file must contain at least a header and one data row" });
        return;
      }

      const headers = lines[0].split(',').map((h: string) => h.trim().replace(/"/g, ''));
      const rows = lines.slice(1);

      let imported = 0;
      let duplicates = 0;
      const errors: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        try {
          const values = rows[i].split(',').map((v: string) => v.trim().replace(/"/g, ''));
          const customerData: any = {};

          // Map CSV columns to customer fields
          headers.forEach((header: string, index: number) => {
            if (values[index]) {
              switch (header.toLowerCase()) {
                case 'name':
                  customerData.name = values[index];
                  break;
                case 'email':
                  customerData.email = values[index];
                  break;
                case 'phone':
                  customerData.phone = values[index];
                  break;
                case 'address':
                  customerData.address = values[index];
                  break;
                case 'contracttype':
                  customerData.contractType = values[index];
                  break;
                case 'laborrate':
                  customerData.laborRate = values[index];
                  break;
                case 'discountpercent':
                  customerData.discountPercent = values[index];
                  break;
                case 'paymentterms':
                  customerData.paymentTerms = values[index];
                  break;
                case 'notes':
                  customerData.notes = values[index];
                  break;
              }
            }
          });

          // Validate required fields
          if (!customerData.name || !customerData.email) {
            errors.push(`Row ${i + 2}: Missing required fields (name, email)`);
            continue;
          }

          // Check for duplicate email
          const existingCustomer = await storage.getCustomers();
          const duplicate = existingCustomer.find(c => c.email === customerData.email);
          if (duplicate) {
            duplicates++;
            continue;
          }

          // Validate and create customer
          const validatedData = insertCustomerSchema.parse(customerData);
          await storage.createCustomer(validatedData);
          imported++;

        } catch (error) {
          console.error(error);
          errors.push(`Row ${i + 2}: ${error instanceof Error ? error.message : 'Invalid data'}`);
        }
      }

      res.json({
        success: errors.length === 0,
        imported,
        duplicates,
        errors
      });

    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to import CSV" });
    }
  });

  // Parts + Part Settings + Manual Part Reviews — extracted to ./parts-routes.ts
  registerPartRoutes(app, { requireAuthentication, applyPricingVisibility });

  // Task #709 — Billing Workspace endpoints.
  registerBillingWorkspaceRoutes(app, { requireAuthentication });
  // Task #1083 — Bulk-approve endpoint.
  registerBillingWorkspaceBulkApproveRoutes(app, { requireAuthentication });

  // Task #1005 — Manager Workspace endpoints.
  registerManagerWorkspaceRoutes(app, { requireAuthentication });

  // Assembly routes — extracted to ./assembly-routes.ts
  registerAssemblyRoutes(app, { requireAuthentication });

  app.post("/api/parts/import/google-sheets", requireAuthentication, async (req, res) => {
    try {
      const { sheetsUrl } = req.body;
      if (!sheetsUrl) {
        res.status(400).json({ message: "Google Sheets URL is required" });
        return;
      }

      // Convert Google Sheets URL to CSV export URL
      const sheetId = sheetsUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
      if (!sheetId) {
        res.status(400).json({ message: "Invalid Google Sheets URL format" });
        return;
      }

      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
      
      // Fetch CSV data
      const response = await fetch(csvUrl);
      if (!response.ok) {
        res.status(400).json({ 
          message: "Failed to access Google Sheets. Make sure the sheet is publicly viewable (Anyone with the link can view)" 
        });
        return;
      }

      const csvData = await response.text();
      const lines = csvData.split('\n').filter(line => line.trim());
      
      if (lines.length < 2) {
        res.status(400).json({ message: "Sheet appears to be empty or missing data" });
        return;
      }

      // Parse CSV headers
      const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
      
      // Create header mapping - more flexible approach
      const headerMap: Record<string, string> = {};
      headers.forEach((header, index) => {
        headerMap[header] = headers[index];
      });

      // Find the actual header names in the sheet
      const nameField = headers.find(h => h.includes('name') || h.includes('product') || h.includes('item'));
      const priceField = headers.find(h => h.includes('price') || h.includes('cost') || h.includes('amount'));
      const skuField = headers.find(h => h.includes('sku') || h.includes('code') || h.includes('part'));
      const laborField = headers.find(h => h.includes('labor') || h.includes('hour') || h.includes('time'));
      const descField = headers.find(h => h.includes('desc') || h.includes('detail'));
      const categoryField = headers.find(h => h.includes('category') || h.includes('type') || h.includes('group'));

      console.log('Available headers:', headers);
      console.log('Mapped fields:', { nameField, priceField, skuField, laborField });

      if (!nameField || !priceField) {
        res.status(400).json({ 
          message: `Could not find required columns in sheet. Available headers: ${headers.join(', ')}. Need at least: name/product and price/cost` 
        });
        return;
      }

      // Parse and import parts
      let partsAdded = 0;
      const errors = [];

      for (let i = 1; i < lines.length; i++) {
        try {
          const values = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
          const rowData: any = {};
          
          headers.forEach((header, index) => {
            rowData[header] = values[index] || '';
          });

          // Use flexible field mapping
          const name = (nameField ? rowData[nameField] : rowData.name) || '';
          const price = (priceField ? rowData[priceField] : rowData.price) || '';
          const sku = (skuField ? rowData[skuField] : rowData.sku) || `AUTO-${Date.now()}-${i}`;
          const description = (descField ? rowData[descField] : rowData.description) || '';
          const category = (categoryField ? rowData[categoryField] : rowData.category) || 'General';

          // Validate required fields
          if (!name || !price) {
            errors.push(`Row ${i + 1}: Missing required fields (name: "${name}", price: "${price}")`);
            continue;
          }

          // Create part object
          const partData = {
            name: name.trim(),
            description: description.trim(),
            price: price.toString(),
            sku: sku.trim(),
            category: category.trim(),
            companyId: req.authenticatedUserCompanyId || 1,
          };

          await storage.createPart(partData);
          partsAdded++;
        } catch (error) {
          console.error(error);
          errors.push(`Row ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      res.json({ 
        partsAdded, 
        errors: errors.length > 0 ? errors : undefined,
        message: `Successfully imported ${partsAdded} parts` + (errors.length > 0 ? ` with ${errors.length} errors` : '')
      });
    } catch (error) {
      console.error("Error importing from Google Sheets:", error);
      res.status(500).json({ message: "Failed to import parts from Google Sheets" });
    }
  });

  // Google Docs sync
  app.post("/api/parts/sync-google-docs", requireAuthentication, async (req, res) => {
    try {
      const { docUrl } = req.body;
      if (!docUrl) {
        res.status(400).json({ message: "Google Docs URL is required" });
        return;
      }
      await storage.syncPartsFromGoogleDocs(docUrl);
      res.json({ message: "Parts synced from Google Docs successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to sync parts from Google Docs" });
    }
  });

  // Duplicate assembly routes removed - consolidated above in Assembly routes section


  // All /api/estimates* routes (CRUD, lifecycle, PDF, email, public
  // approval/rejection tokens, convert-to-work-order) live in
  // ./estimate-routes.ts — Task #640. registerRoutes contributes no
  // estimate routes of its own; it wires in the cross-cutting deps
  // (pricing-visibility strip from Task #643 and the lifecycle audit
  // emitter from Task #641) so the moved routes keep the same
  // behaviour they had inline.
  registerEstimateRoutes(app, storage, requireAuthentication, {
    applyPricingVisibility,
    recordLifecycleAudit,
  });

  // Property Zones and Field Work Sessions routes removed by Task #1857 (Slice 5).
  // GET /api/property-zones now returns 404 (route intentionally absent).

  // Field Tech Parts route (without pricing)
  app.get("/api/parts/field-tech", requireAuthentication, async (req, res) => {
    try {
      const callerRoleParts = req.authenticatedUserRole;
      if (callerRoleParts !== 'super_admin' && !req.authenticatedUserCompanyId) {
        res.status(403).json({ message: "Forbidden: user has no company association" });
        return;
      }
      const callerCidParts: number | null = callerRoleParts === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? null);
      const parts = await storage.getParts(callerCidParts);
      // Remove pricing information for field techs
      const fieldTechParts = parts.map(part => ({
        id: part.id,
        name: part.name,
        description: part.description,
        sku: part.sku,
        category: part.category
        // price is intentionally excluded
      }));
      res.json(fieldTechParts);
    } catch (error) {
      console.error("Error in /api/parts/field-tech:", error);
      res.status(500).json({ message: "Failed to fetch parts" });
    }
  });

  // Serve the QuickBooks debug script
  // Function to refresh QuickBooks token
  async function refreshQuickBooksToken(refreshToken: string, signal?: AbortSignal, context?: { realmId?: string; calledFrom?: string }): Promise<{ access_token: string; refresh_token: string; expires_in?: number; [key: string]: unknown }> {
    const tokenEndpoint = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
    const authHeader = Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
    const startedAt = Date.now();
    const realmId = context?.realmId ?? 'unknown';
    const calledFrom = context?.calledFrom ?? 'unknown';

    console.log(`[QB token-refresh] START realmId=${realmId} calledFrom=${calledFrom} startedAt=${new Date(startedAt).toISOString()}`);
    
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });

    let response: globalThis.Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: body.toString(),
        signal
      });
    } catch (fetchErr: any) {
      const durationMs = Date.now() - startedAt;
      console.error(`[QB token-refresh] FAILURE realmId=${realmId} calledFrom=${calledFrom} durationMs=${durationMs} failureCode=FETCH_ERROR failureMessage=${fetchErr?.message}`);
      throw fetchErr;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const durationMs = Date.now() - startedAt;
      const category = classifyQbRefreshError(errorText, response.status);
      console.error(`[QB token-refresh] FAILURE realmId=${realmId} calledFrom=${calledFrom} durationMs=${durationMs} failureCode=${response.status} category=${category} failureMessage=${errorText}`);
      throw new QbRefreshError(`Token refresh failed: ${response.status} ${errorText}`, category);
    }

    const tokenData = (await response.json()) as QbTokenResponse;
    if (!tokenData.access_token) {
      const durationMs = Date.now() - startedAt;
      console.error(`[QB token-refresh] FAILURE realmId=${realmId} calledFrom=${calledFrom} durationMs=${durationMs} failureCode=MISSING_ACCESS_TOKEN failureMessage=Token refresh response missing access_token`);
      throw new QbRefreshError('Token refresh response missing access_token', 'reconnect_required');
    }
    if (!tokenData.refresh_token) {
      const durationMs = Date.now() - startedAt;
      console.error(`[QB token-refresh] FAILURE realmId=${realmId} calledFrom=${calledFrom} durationMs=${durationMs} failureCode=MISSING_REFRESH_TOKEN failureMessage=Token refresh response missing refresh_token`);
      throw new QbRefreshError('Token refresh response missing refresh_token — cannot commit partial token state', 'reconnect_required');
    }

    const durationMs = Date.now() - startedAt;
    const tokenRotated = true;
    const expiresInSeconds = tokenData.expires_in && tokenData.expires_in > 0 ? tokenData.expires_in : 3600;
    console.log(`[QB token-refresh] SUCCESS realmId=${realmId} calledFrom=${calledFrom} durationMs=${durationMs} tokenRotated=${tokenRotated} newExpiresInSeconds=${expiresInSeconds}`);
    return tokenData as QbTokenResponseValidated;
  }

  // Shared helper: persist reconnect_required for unrecoverable QbRefreshError
  async function handleUnrecoverableRefreshError(err: unknown, realmId: string): Promise<boolean> {
    if (!(err instanceof QbRefreshError)) return false;
    const unrecoverable = UNRECOVERABLE_CATEGORIES.has(err.category);
    if (!unrecoverable) return false;
    const reason = buildReconnectReason(err.category);
    await storage.markQuickBooksReconnectRequired(realmId, reason).catch((e) => {
      console.error('[QB] Failed to persist reconnect_required state:', e);
    });
    console.warn(`[QB] Marked realmId=${realmId} as reconnect_required (${err.category})`);
    return true;
  }

  // Helper function to make QuickBooks API requests with intuit_tid capture and automatic token refresh
  async function makeQuickBooksRequest(url: string, options: RequestInit = {}, operation: string = '', realmId?: string): Promise<globalThis.Response> {
    // Proactive refresh: if the token is within the buffer window of expiry, refresh before sending
    if (realmId) {
      try {
        const integration = await storage.getQuickBooksIntegration(realmId);
        // Skip proactive refresh entirely if connection is already marked as reconnect_required
        if (integration?.connectionStatus === 'reconnect_required') {
          console.warn(`[QB] Skipping proactive refresh for realmId=${realmId}: connection is marked as reconnect_required`);
        } else if (integration && integration.expiresAt && integration.refreshToken) {
          const msUntilExpiry = new Date(integration.expiresAt).getTime() - Date.now();
          if (msUntilExpiry <= QB_PROACTIVE_REFRESH_BUFFER_MS) {
            console.log(`[QB proactive refresh] Token for realmId=${realmId} expires in ${Math.round(msUntilExpiry / 1000)}s — refreshing before request`);
            try {
              const newAccessToken = await withQbRefreshLock(realmId, async (signal) => {
                // Re-read from storage in case another concurrent caller already refreshed
                const fresh = await storage.getQuickBooksIntegration(realmId);
                if (!fresh) {
                  throw new Error(`[QB proactive refresh] Integration for realmId=${realmId} not found`);
                }
                // Bail out if another caller marked this as reconnect_required while we waited for the lock
                if (fresh.connectionStatus === 'reconnect_required') {
                  throw new QbRefreshError(
                    `Connection already marked as reconnect_required for realmId=${realmId}`,
                    'reconnect_required'
                  );
                }
                const newTokenData = await refreshQuickBooksToken(fresh.refreshToken, signal, { realmId, calledFrom: 'makeQuickBooksRequest/proactive' });
                const expiresInSeconds = newTokenData.expires_in && newTokenData.expires_in > 0 ? newTokenData.expires_in : 3600;
                if (!newTokenData.refresh_token) {
                  console.warn('[QB proactive refresh] Intuit did not return a new refresh_token; keeping the existing one');
                }
                const nowTs = new Date();
                await storage.saveQuickBooksIntegration({
                  companyId: integration.companyId,
                  accessToken: newTokenData.access_token,
                  refreshToken: newTokenData.refresh_token || fresh.refreshToken,
                  realmId,
                  expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
                  lastRefreshAttempt: nowTs,
                  lastRefreshSuccess: nowTs,
                });
                return newTokenData.access_token;
              });

              // Swap the Authorization header so the actual request uses the fresh token
              if (options.headers) {
                (options.headers as Record<string, string>)['Authorization'] = `Bearer ${newAccessToken}`;
              }
              console.log(`[QB proactive refresh] Token refreshed successfully for realmId=${realmId}`);
            } catch (proactiveErr) {
              // Classify error: persist reconnect_required for unrecoverable failures
              await handleUnrecoverableRefreshError(proactiveErr, realmId);
              // Non-fatal for transient errors: log and continue — 401 fallback below will handle it
              console.warn(`[QB proactive refresh] Failed for realmId=${realmId}; proceeding with existing token:`, proactiveErr);
            }
          }
        }
      } catch (lookupErr) {
        // Non-fatal: if we can't look up the integration, just proceed and let the 401 fallback handle it
        console.warn(`[QB proactive refresh] Integration lookup failed for realmId=${realmId}:`, lookupErr);
      }
    }

    let response = await fetch(url, options);
    
    // Always capture intuit_tid from response headers
    const intuitTid = response.headers.get('intuit_tid');
    if (intuitTid) {
      console.log(`QuickBooks API Transaction ID (${operation || 'Request'}):`, intuitTid);
      // Enhanced logging: also log to our centralized logger if available
      console.log(`[QUICKBOOKS_TID] ${operation}: ${intuitTid}`);
    }
    
    // If we get a 401 (token expired), try to refresh the token and retry
    if (response.status === 401) {
      console.log('QuickBooks token expired, attempting to refresh...');
      try {
        const integration = realmId ? await storage.getQuickBooksIntegration(realmId) : null;
        // Do not attempt refresh if connection is already marked as reconnect_required
        if (integration?.connectionStatus === 'reconnect_required') {
          console.warn(`[QB] Skipping token refresh for realmId=${realmId}: connection is marked as reconnect_required`);
          return response;
        }
        if (integration && integration.refreshToken) {
          const realmIdForLock = integration.realmId || realmId || 'default';

          const newAccessToken = await withQbRefreshLock(realmIdForLock, async (signal) => {
            // Re-read from storage by realmId so we get the latest rotated token
            // (another concurrent caller that held the lock may have already refreshed it)
            const fresh = await storage.getQuickBooksIntegration(realmIdForLock);
            if (!fresh) {
              throw new Error(`[QB refresh] Integration for realmId=${realmIdForLock} not found; cannot refresh`);
            }
            // Bail out if another caller marked this as reconnect_required while we waited for the lock
            if (fresh.connectionStatus === 'reconnect_required') {
              throw new QbRefreshError(
                `Connection already marked as reconnect_required for realmId=${realmIdForLock}`,
                'reconnect_required'
              );
            }
            const refreshTokenToUse = fresh.refreshToken;

            const newTokenData = await refreshQuickBooksToken(refreshTokenToUse, signal, { realmId: realmIdForLock, calledFrom: 'makeQuickBooksRequest/401-retry' });

            // Guard against NaN when expires_in is missing or zero
            const expiresInSeconds = newTokenData.expires_in && newTokenData.expires_in > 0
              ? newTokenData.expires_in
              : 3600;
            if (!newTokenData.expires_in || newTokenData.expires_in <= 0) {
              console.warn('QuickBooks token refresh: expires_in missing or zero, defaulting to 3600 seconds');
            }

            // Persist new tokens atomically before releasing the lock so all waiters see the updated token
            const nowTs = new Date();
            await storage.saveQuickBooksIntegration({
              companyId: integration.companyId,
              accessToken: newTokenData.access_token,
              refreshToken: newTokenData.refresh_token,
              realmId: realmIdForLock,
              expiresAt: new Date(Date.now() + (expiresInSeconds * 1000)),
              lastRefreshAttempt: nowTs,
              lastRefreshSuccess: nowTs,
            });

            return newTokenData.access_token;
          });

          // Retry the original request with the new token
          const updatedOptions = { ...options };
          if (updatedOptions.headers) {
            (updatedOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${newAccessToken}`;
          }

          console.log('Retrying request with refreshed token...');
          response = await fetch(url, updatedOptions);

          // Update intuit_tid from retry
          const retryIntuitTid = response.headers.get('intuit_tid');
          if (retryIntuitTid) {
            console.log(`QuickBooks API Transaction ID (${operation} - Retry):`, retryIntuitTid);
            console.log(`[QUICKBOOKS_TID] ${operation} - Retry: ${retryIntuitTid}`);
          }
        }
      } catch (refreshError: any) {
        const failureReason = refreshError?.message ?? String(refreshError);
        console.error(`[QB token-refresh] CATCH realmId=${realmId ?? 'unknown'} failureMessage=${failureReason}`);
        if (realmId) {
          // Persist reconnect_required for unrecoverable failures (stale/revoked token)
          const marked = await handleUnrecoverableRefreshError(refreshError, realmId);
          if (!marked) {
            // Transient failure — still persist lastRefreshFailure for observability
            try {
              const integ = await storage.getQuickBooksIntegration(realmId);
              if (integ) {
                await storage.saveQuickBooksIntegration({
                  companyId: integ.companyId,
                  accessToken: integ.accessToken,
                  refreshToken: integ.refreshToken,
                  realmId: integ.realmId,
                  expiresAt: integ.expiresAt,
                  lastRefreshAttempt: new Date(),
                  lastRefreshFailure: new Date(),
                  connectionStatus: integ.connectionStatus,
                  reconnectRequiredReason: failureReason,
                });
              }
            } catch (persistErr) {
              console.warn('[QB token-refresh] Failed to persist lastRefreshFailure:', persistErr);
            }
          }
        }
        // Return the original 401 response if refresh fails
      }
    }
    
    // Enhanced error logging with transaction ID
    if (!response.ok) {
      const errorMessage = `QuickBooks API Error (${operation}): ${response.status} ${response.statusText}`;
      if (intuitTid) {
        console.error(`${errorMessage} [TID: ${intuitTid}]`);
      } else {
        console.error(errorMessage);
      }
    }
    
    return response;
  }

  const QB_SERVICE_ITEM_NAME = 'Irrigation Services - IrrigoPro';

  // Shared helper: look up the "Irrigation Services - IrrigoPro" item in a QB account.
  // Returns { id, name } on success, or null if the lookup fails.
  async function lookupQBServiceItem(
    apiBase: string,
    realmId: string,
    accessToken: string
  ): Promise<{ id: string; name: string } | null> {
    try {
      const itemQuery = encodeURIComponent(
        `SELECT * FROM Item WHERE Name = '${QB_SERVICE_ITEM_NAME}' AND Active = true MAXRESULTS 1`
      );
      const res = await makeQuickBooksRequest(
        `${apiBase}/v3/company/${realmId}/query?query=${itemQuery}`,
        { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
        'QB Service Item Lookup',
        realmId
      );
      if (res.ok) {
        const data = (await res.json()) as QbItemQueryResponse;
        const items = data?.QueryResponse?.Item;
        if (items && items.length > 0) {
          return { id: String(items[0].Id), name: items[0].Name || QB_SERVICE_ITEM_NAME };
        }
      } else {
        const txt = await res.text();
        console.warn('[QB] Service item lookup failed:', res.status, txt);
      }
    } catch (err: any) {
      console.warn('[QB] Service item lookup threw:', err.message);
    }
    return null;
  }

  // Task #1443 / #1711 — shared QB-invoice CREATE core. Delegates to the
  // extracted qb-invoice-ops module so the logic can be unit-tested with
  // stubbed QB requests. This wrapper binds the closure-level helpers
  // (makeQuickBooksRequest, lookupQBServiceItem, QB_SERVICE_ITEM_NAME) and
  // resolves the apiBase, keeping all call sites unchanged.
  async function buildAndPostQbInvoice(params: {
    integration: any;
    customer: any;
    docNumber: string;
    qbLines: { amount: number; description: string }[];
    operation: string;
    txnDate?: Date | string;
    dueDate?: Date | string | null;
  }): Promise<{ quickbooksId?: string; qbDocNumber?: string; quickbooksSyncToken?: string; quickbooksError?: string }> {
    const apiBase = process.env.NODE_ENV === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
    return _buildAndPostQbInvoice(makeQuickBooksRequest, lookupQBServiceItem, {
      apiBase,
      integration: params.integration,
      customer: params.customer,
      docNumber: params.docNumber,
      qbLines: params.qbLines,
      operation: params.operation,
      serviceItemName: QB_SERVICE_ITEM_NAME,
      txnDate: params.txnDate,
      dueDate: params.dueDate,
    });
  }

  // Task #1711 — fetch the current SyncToken for an existing QB invoice.
  // Used before an in-place update when no token is stored locally (legacy rows).
  async function fetchQbSyncToken(
    integration: any,
    invoiceId: string,
  ): Promise<string | null> {
    const apiBase = process.env.NODE_ENV === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
    return _fetchQbSyncToken(makeQuickBooksRequest, apiBase, integration, invoiceId);
  }

  // Task #1764 — look up a QB invoice by DocNumber (query API).
  // Returns { id, syncToken } when found, null when not found, "auth_error" on 401.
  async function lookupQbInvoiceByDocNumber(
    integration: any,
    docNumber: string,
  ) {
    const apiBase = process.env.NODE_ENV === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
    return _lookupQbInvoiceByDocNumber(makeQuickBooksRequest, apiBase, integration, docNumber);
  }

  // Task #1711 — update an existing QB invoice in-place (sparse update).
  // Prefers the stored SyncToken; fetches it from QB when missing (legacy rows).
  // Self-heals on fault 5010 (stale token). Never falls back to a duplicate create.
  async function updateQbInvoiceInPlace(params: {
    integration: any;
    customer: any;
    docNumber: string;
    qbLines: { amount: number; description: string }[];
    operation: string;
    quickbooksInvoiceId: string;
    quickbooksSyncToken: string | null | undefined;
  }): Promise<{ quickbooksId?: string; quickbooksSyncToken?: string; quickbooksError?: string }> {
    const apiBase = process.env.NODE_ENV === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
    return _updateQbInvoiceInPlace(makeQuickBooksRequest, lookupQBServiceItem, {
      apiBase,
      integration: params.integration,
      customer: params.customer,
      docNumber: params.docNumber,
      qbLines: params.qbLines,
      operation: params.operation,
      serviceItemName: QB_SERVICE_ITEM_NAME,
      quickbooksInvoiceId: params.quickbooksInvoiceId,
      quickbooksSyncToken: params.quickbooksSyncToken,
    });
  }

  // Task #1443 / #1711 — sync a single app invoice to QuickBooks.
  // Routes to in-place UPDATE when the invoice already carries a QB id
  // (preserves DocNumber, avoids duplicate records), and to CREATE for
  // genuinely unlinked invoices. SyncToken is persisted on every success so
  // future updates don't need a pre-flight GET. Throws InvoiceSyncError so
  // the route maps it to a clear HTTP status.
  async function createQuickBooksInvoiceForInvoice(
    invoiceId: number,
    opts: { callerCompanyId: number | null },
  ): Promise<{ quickbooksId?: string }> {
    const invoice = await storage.getInvoiceById(invoiceId, opts.callerCompanyId);
    if (!invoice) {
      throw new InvoiceSyncError("Invoice not found.", 404);
    }

    const customer = await storage.getCustomerById(invoice.customerId);
    if (!customer) {
      throw new InvoiceSyncError("Customer not found.", 404);
    }

    const companyId = invoice.companyId ?? customer.companyId ?? null;
    const qbLookup = companyId
      ? await storage.getQuickBooksIntegrationByCompanyId(companyId.toString())
      : null;
    const integration = qbLookup?.realmId
      ? await storage.getQuickBooksIntegration(qbLookup.realmId)
      : null;
    if (!integration || !integration.accessToken) {
      throw new InvoiceSyncError(
        "QuickBooks is not connected. Please connect QuickBooks before syncing invoices.",
        400,
      );
    }

    const items = await storage.getInvoiceItems(invoiceId);
    const qbLines = items
      .filter((it) => parseFloat(it.totalPrice || '0') > 0)
      .map((it) => ({
        amount: parseFloat(it.totalPrice || '0'),
        description: it.description || `Invoice ${invoice.invoiceNumber}`,
      }));
    if (qbLines.length === 0) {
      throw new InvoiceSyncError(
        "This invoice has no billable line items to sync to QuickBooks.",
        400,
      );
    }

    // Task #1764 — DocNumber-first lookup: find the QB invoice by number so we
    // self-heal a stale or deleted stored id (e.g. QB #48408 deleted manually).
    // If the lookup returns auth_error the QB token is expired — surface a clear
    // "reconnect" message and do NOT fall through to create a duplicate.
    const docLookup = await lookupQbInvoiceByDocNumber(integration, invoice.invoiceNumber);

    if (docLookup === "auth_error") {
      throw new InvoiceSyncError(
        "QuickBooks session expired. Please reconnect QuickBooks and retry the sync.",
        401,
      );
    }

    if (docLookup) {
      // QB has an invoice with this DocNumber → update in place using the live
      // id + SyncToken (self-heals if the stored id differed).
      let updateResult: { quickbooksId?: string; quickbooksSyncToken?: string; quickbooksError?: string };
      try {
        updateResult = await updateQbInvoiceInPlace({
          integration,
          customer,
          docNumber: invoice.invoiceNumber,
          qbLines,
          operation: 'Invoice In-Place Update (DocNumber-first)',
          quickbooksInvoiceId: docLookup.id,
          quickbooksSyncToken: docLookup.syncToken,
        });
      } catch (err: any) {
        throw new InvoiceSyncError(err?.message || "Failed to update invoice in QuickBooks.", 400);
      }
      if (updateResult.quickbooksError) {
        throw new InvoiceSyncError(updateResult.quickbooksError, 502);
      }
      const qbUpdateFields: Partial<InsertInvoice> = {};
      if (updateResult.quickbooksId) qbUpdateFields.quickbooksInvoiceId = updateResult.quickbooksId;
      if (updateResult.quickbooksSyncToken) qbUpdateFields.quickbooksSyncToken = updateResult.quickbooksSyncToken;
      if (Object.keys(qbUpdateFields).length > 0) {
        await storage.updateInvoice(invoiceId, qbUpdateFields);
      }
      return { quickbooksId: updateResult.quickbooksId ?? docLookup.id };
    }

    // DocNumber not found in QB → create a fresh QB invoice.
    // Resolve the stable invoice date: the earliest revision's createdAt for this
    // (companyId, invoiceNumber) pair.  A corrected reissue (Rev 2) must reproduce
    // the original QB TxnDate (Rev 1's createdAt) rather than stamping today.
    // Fall back to the current invoice's own createdAt when it is the first revision.
    let txnDate: Date = invoice.createdAt;
    if (companyId) {
      const [earliestRow] = await db
        .select({ createdAt: invoices.createdAt })
        .from(invoices)
        .where(and(eq(invoices.companyId, companyId), eq(invoices.invoiceNumber, invoice.invoiceNumber)))
        .orderBy(asc(invoices.revision))
        .limit(1);
      if (earliestRow?.createdAt) {
        txnDate = earliestRow.createdAt;
      }
    }

    // DueDate: use the stored due date when present; otherwise net-30 off the resolved txnDate.
    const dueDate: Date | null = invoice.dueDate
      ? new Date(invoice.dueDate)
      : null;

    let result: { quickbooksId?: string; qbDocNumber?: string; quickbooksSyncToken?: string; quickbooksError?: string };
    try {
      result = await buildAndPostQbInvoice({
        integration,
        customer,
        docNumber: invoice.invoiceNumber,
        qbLines,
        operation: 'Invoice Sync Creation',
        txnDate,
        dueDate,
      });
    } catch (err: any) {
      // Precondition / connection errors thrown by the create core (missing
      // service item, customer not synced). Surface the clear message as a
      // 400 so the billing manager knows the corrective action.
      throw new InvoiceSyncError(err?.message || "Failed to create invoice in QuickBooks.", 400);
    }

    if (result.quickbooksError) {
      throw new InvoiceSyncError(result.quickbooksError, 502);
    }

    const qbUpdateFields: Partial<InsertInvoice> & { invoiceNumber?: string } = {};
    if (result.quickbooksId) qbUpdateFields.quickbooksInvoiceId = result.quickbooksId;
    if (result.qbDocNumber) qbUpdateFields.invoiceNumber = result.qbDocNumber;
    if (result.quickbooksSyncToken) qbUpdateFields.quickbooksSyncToken = result.quickbooksSyncToken;
    if (Object.keys(qbUpdateFields).length > 0) {
      await storage.updateInvoice(invoiceId, qbUpdateFields);
    }

    return { quickbooksId: result.quickbooksId };
  }

  // Function to exchange authorization code for access tokens
  async function exchangeCodeForTokens(code: string, realmId: string, req: any): Promise<QbTokenResponseValidated & { expires_in: number }> {
    const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI;
    if (!redirectUri) {
      throw new Error('QUICKBOOKS_REDIRECT_URI environment variable is not set');
    }
    
    const tokenEndpoint = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
    const authHeader = Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
    
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri
    });

    // Use a plain fetch (not the auto-refresh wrapper) to avoid cascading refresh errors
    // during the initial handshake when there is no stored token yet.
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      const intuitTid = response.headers.get('intuit_tid');
      console.error('Token exchange failed:', response.status, errorText);
      throw new Error(`Token exchange failed: ${response.status} ${errorText}${intuitTid ? ` [TID: ${intuitTid}]` : ''}`);
    }

    const tokenData = (await response.json()) as QbTokenResponseValidated & { expires_in: number; detectedTokenEnvironment?: string };
    console.log('Successfully exchanged code for tokens');

    // Phase 5b — QB Harden #5: probe both Intuit API hosts to detect which
    // environment the credentials actually belong to, rather than assuming
    // the host based on NODE_ENV.
    const INTUIT_HOSTS = {
      production: 'https://quickbooks.api.intuit.com',
      sandbox: 'https://sandbox-quickbooks.api.intuit.com',
    } as const;

    let detectedTokenEnvironment: 'production' | 'sandbox' | null = null;

    for (const [env, apiBase] of Object.entries(INTUIT_HOSTS) as [keyof typeof INTUIT_HOSTS, string][]) {
      try {
        const companyInfoResponse = await makeQuickBooksRequest(
          `${apiBase}/v3/company/${realmId}/companyinfo/${realmId}`,
          {
            headers: {
              'Authorization': `Bearer ${tokenData.access_token}`,
              'Accept': 'application/json'
            }
          },
          'Company Info',
          realmId
        );

        if (companyInfoResponse.ok) {
          const companyData = (await companyInfoResponse.json()) as QbCompanyInfoQueryResponse;
          tokenData.companyName = companyData?.QueryResponse?.CompanyInfo?.[0]?.CompanyName || `Company ${realmId}`;
          detectedTokenEnvironment = env;
          break;
        }
      } catch {
        // try the other host
      }
    }

    if (!detectedTokenEnvironment) {
      // Both hosts failed — fall back to NODE_ENV derivation and log a warning.
      detectedTokenEnvironment = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
      console.warn('[QB] Could not detect token environment from either Intuit host — defaulting to NODE_ENV derivation', { realmId });
      tokenData.companyName = tokenData.companyName ?? `Company ${realmId}`;
    }

    const serverEnv = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
    if (detectedTokenEnvironment !== serverEnv) {
      const mismatchMsg = `Credentials are ${detectedTokenEnvironment} but server is ${serverEnv}`;
      if (process.env.STRICT_QB_ENV_CHECK) {
        throw new QbCredentialMismatchError(mismatchMsg);
      } else {
        console.warn(`[QB] ${mismatchMsg} — STRICT_QB_ENV_CHECK is off, saving with detected environment`, { realmId, detectedTokenEnvironment, serverEnv });
      }
    }

    tokenData.detectedTokenEnvironment = detectedTokenEnvironment;
    return tokenData;
  }

  // QuickBooks integration routes
  app.get("/api/quickbooks/auth", requireAuthentication, requireQuickBooksAccess, async (req, res) => {
    try {
      // Check if QuickBooks credentials are available
      if (!process.env.QUICKBOOKS_CLIENT_ID || !process.env.QUICKBOOKS_CLIENT_SECRET) {
        res.status(400).json({ 
          message: "QuickBooks integration is not configured. Please contact your administrator to set up the QuickBooks credentials." 
        });
        return;
      }

      const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI;
      if (!redirectUri) {
        console.warn('WARNING: QUICKBOOKS_REDIRECT_URI environment variable is not set');
        res.status(400).json({
          message: "QuickBooks redirect URI is not configured. Please set the QUICKBOOKS_REDIRECT_URI environment variable."
        });
        return;
      }

      const state = crypto.randomBytes(16).toString('hex');
      // Store state + company ID for CSRF verification in the callback (10 min TTL).
      // USE_DB_OAUTH_STATE=1 → durable Postgres store (survives server restarts);
      // unset (default) → existing in-memory Map.
      const authCompanyId = resolveCompanyId(req);
      if (!authCompanyId) {
        res.status(400).json({ message: "Company context is required to initiate QuickBooks connection" });
        return;
      }
      if (process.env.USE_DB_OAUTH_STATE) {
        await storage.saveOauthState(state, 'quickbooks', authCompanyId, new Date(Date.now() + 10 * 60 * 1000));
      } else {
        oauthStateStore.set(state, { expiry: Date.now() + 10 * 60 * 1000, companyId: authCompanyId });
      }
      
      // QuickBooks OAuth URL
      const authUrl = `https://appcenter.intuit.com/app/connect/oauth2?` +
        `client_id=${process.env.QUICKBOOKS_CLIENT_ID}&` +
        `scope=com.intuit.quickbooks.accounting&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `response_type=code&` +
        `access_type=offline&` +
        `state=${state}`;
      
      res.json({ authUrl, state });
    } catch (error) {
      console.error("QuickBooks auth error:", error);
      res.status(500).json({ message: "Failed to generate QuickBooks auth URL" });
    }
  });

  app.get("/api/quickbooks/callback", async (req, res) => {
    try {
      const { code, state, realmId } = req.query;
      
      if (!code || !realmId) {
        res.status(400).send(`
          <html>
            <body>
              <h2>QuickBooks Connection Failed</h2>
              <p>Missing authorization code or company ID.</p>
              <script>window.close();</script>
            </body>
          </html>
        `);
        return;
      }

      // Verify CSRF state parameter (atomic consume — prevents replay attacks).
      // USE_DB_OAUTH_STATE=1 → durable Postgres store; unset → in-memory Map.
      let oauthCompanyId: string | null = null;
      if (process.env.USE_DB_OAUTH_STATE) {
        const dbEntry = state ? await storage.consumeOauthState(state as string) : undefined;
        if (!state || !dbEntry) {
          console.error('QuickBooks OAuth state mismatch or expired (db path). Possible CSRF attack.', { received: state });
          res.status(400).send(`
            <html>
              <head><title>Connection Failed</title></head>
              <body>
                <h2>QuickBooks Connection Failed</h2>
                <p>Security verification failed. Please try connecting again.</p>
                <button onclick="window.location.href='/billing'">Return to IrrigoPro</button>
              </body>
            </html>
          `);
          return;
        }
        oauthCompanyId = dbEntry.companyId;
      } else {
        const stateEntry = state ? oauthStateStore.get(state as string) : undefined;
        if (!state || !stateEntry || Date.now() > stateEntry.expiry) {
          console.error('QuickBooks OAuth state mismatch or expired. Possible CSRF attack.', { received: state });
          res.status(400).send(`
            <html>
              <head><title>Connection Failed</title></head>
              <body>
                <h2>QuickBooks Connection Failed</h2>
                <p>Security verification failed. Please try connecting again.</p>
                <button onclick="window.location.href='/billing'">Return to IrrigoPro</button>
              </body>
            </html>
          `);
          return;
        }
        oauthCompanyId = stateEntry.companyId;
        oauthStateStore.delete(state as string);
      }

      // Exchange the authorization code for access tokens
      console.log("QuickBooks OAuth callback received:", { code, state, realmId });
      
      try {
        // Exchange authorization code for real access tokens
        const tokenResponse = await exchangeCodeForTokens(code as string, realmId as string, req);
        
        const qbData = {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
          companyId: realmId as string,
          companyName: tokenResponse.companyName || `QuickBooks Company ${realmId}`,
          expiresAt: new Date(Date.now() + (tokenResponse.expires_in * 1000)),
          lastSync: new Date()
        };

        // Save to database — use the company ID that was stored when OAuth flow began.
        // If oauthCompanyId is null the state lookup succeeded but carried no company ID,
        // which would silently bind this QB realm to the wrong tenant. Abort instead.
        if (!oauthCompanyId) {
          console.error('[QB] OAuth callback completed but oauthCompanyId is null — cannot determine which IrrigoPro company initiated this auth. Aborting to prevent bad data.', { realmId, state });
          res.status(400).send(`
            <html>
              <head><title>Connection Failed</title></head>
              <body>
                <h2>QuickBooks Connection Failed</h2>
                <p>Unable to identify the IrrigoPro company that started this connection. Please return to IrrigoPro and try connecting again.</p>
                <button onclick="window.location.href='/billing'">Return to IrrigoPro</button>
              </body>
            </html>
          `);
          return;
        }

        console.log("Saving QuickBooks integration with realmId:", realmId, "companyId:", oauthCompanyId);
        
        await storage.saveQuickBooksIntegration({
          companyId: oauthCompanyId,
          accessToken: qbData.accessToken,
          refreshToken: qbData.refreshToken,
          realmId: realmId as string, // Keep QB realm ID for API calls
          expiresAt: qbData.expiresAt,
          connectionStatus: 'connected',        // Explicitly clear any previous reconnect_required state
          reconnectRequiredReason: null,
          // Phase 5b — QB Harden #5: store the environment detected by probing
          // both Intuit hosts, rather than deriving it from NODE_ENV.
          tokenEnvironment: tokenResponse.detectedTokenEnvironment as string | undefined,
        });

        console.log(`QuickBooks connection established for company: ${realmId}`);
        
        res.send(`
          <html>
            <head>
              <title>QuickBooks Connected Successfully</title>
              <style>
                body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  margin: 0; padding: 0; min-height: 100vh;
                  display: flex; align-items: center; justify-content: center;
                }
                .container { 
                  background: white; padding: 40px; border-radius: 12px; 
                  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
                  max-width: 500px; text-align: center;
                }
                .success { color: #059669; font-size: 24px; margin-bottom: 20px; }
                .info { color: #6b7280; margin: 20px 0; line-height: 1.6; }
                .company-id { 
                  background: #f3f4f6; padding: 15px; border-radius: 8px; 
                  font-family: 'Monaco', 'Menlo', monospace; font-size: 14px;
                  border-left: 4px solid #059669;
                }
                .redirect-info { 
                  background: #eff6ff; color: #0E3B6B; padding: 15px; 
                  border-radius: 8px; margin-top: 20px; font-size: 14px;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="success">✅ QuickBooks Connected Successfully!</div>
                <p class="info">Your IrrigoPro account is now integrated with QuickBooks Online.</p>
                <div class="company-id">Company ID: <strong>${realmId}</strong></div>
                <div class="redirect-info">
                  Redirecting you back to IrrigoPro in <span id="countdown">3</span> seconds...
                </div>
              </div>
              <script>
                let count = 3;
                const countdown = document.getElementById('countdown');
                const timer = setInterval(() => {
                  count--;
                  countdown.textContent = count;
                  if (count <= 0) {
                    clearInterval(timer);
                    window.location.href = '${req.protocol}://${req.get('host')}/billing';
                  }
                }, 1000);
              </script>
            </body>
          </html>
        `);
      } catch (error) {
        // Phase 5b — QB Harden #5: credential/env mismatch with STRICT_QB_ENV_CHECK on.
        // Redirect back to /billing with the error message in the query string so the
        // frontend can surface it as a toast (no row is persisted).
        if (error instanceof QbCredentialMismatchError) {
          const errParam = encodeURIComponent(error.message);
          res.redirect(`${req.protocol}://${req.get('host')}/billing?qb_connect_error=${errParam}`);
          return;
        }
        console.error("QuickBooks callback error:", error);
        res.status(500).send(`
          <html>
            <head>
              <title>Connection Failed</title>
              <style>
                body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  background: #fee2e2; margin: 0; padding: 50px; text-align: center;
                }
                .container { 
                  background: white; padding: 40px; border-radius: 8px; 
                  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); max-width: 500px; margin: 0 auto;
                }
                .error { color: #dc2626; font-size: 20px; margin-bottom: 15px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="error">❌ Connection Failed</div>
                <p>There was an error connecting to QuickBooks.</p>
                <p>Please try again or contact support if the problem persists.</p>
                <button onclick="window.location.href='${req.protocol}://${req.get('host')}/billing'">
                  Return to IrrigoPro
                </button>
              </div>
            </body>
          </html>
        `);
      }
    } catch (error) {
      console.error("QuickBooks callback error:", error);
      res.status(500).send(`
        <html>
          <body>
            <h2>QuickBooks Connection Error</h2>
            <p>An error occurred while connecting to QuickBooks.</p>
            <script>window.close();</script>
          </body>
        </html>
      `);
    }
  });

  // Clear QuickBooks connection (for reconnecting)
  app.post("/api/quickbooks/disconnect", requireAuthentication, requireQuickBooksAccess, async (req, res) => {
    try {
      const userCompanyId = resolveCompanyId(req);
      if (!userCompanyId) {
        res.status(400).json({ success: false, message: "Company context is required to disconnect QuickBooks." });
        return;
      }
      
      // Remove QuickBooks integration for this company only
      await storage.disconnectQuickBooks(userCompanyId);
      
      res.json({ 
        success: true, 
        message: "QuickBooks connection cleared successfully. You can now reconnect." 
      });
    } catch (error) {
      console.error("Error clearing QuickBooks connection:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to clear QuickBooks connection" 
      });
    }
  });

  app.get("/api/quickbooks/connection", requireAuthentication, requireQuickBooksAccess, async (req, res) => {
    try {
      // In a real implementation, you would check stored tokens and validate them
      // For now, check if we have the required environment variables
      const hasCredentials = process.env.QUICKBOOKS_CLIENT_ID && process.env.QUICKBOOKS_CLIENT_SECRET;
      
      if (!hasCredentials) {
        res.json({ 
          companyId: null,
          companyName: null,
          isConnected: false,
          lastSync: null,
          connectionStatus: 'disconnected',
          reconnectRequiredReason: null,
          error: "QuickBooks credentials not configured"
        });
        return;
      }
      
      const userCompanyId = resolveCompanyId(req);
      
      // Get from database for this user's company
      const qbStatus = await storage.getQuickBooksCustomerStatus(userCompanyId);
      
      res.json(qbStatus);
    } catch (error) {
      console.error("Error getting QuickBooks connection status:", error);
      res.status(500).json({ 
        companyId: null,
        companyName: null,
        isConnected: false,
        lastSync: null,
        connectionStatus: 'error',
        reconnectRequiredReason: null,
        error: "Failed to check QuickBooks connection status"
      });
    }
  });

  // GET /api/quickbooks/connection/stale
  // Returns { stale: boolean, count: number } — true when this company has a QB
  // integration row where company_id = realm_id (fingerprint of the
  // OAuth-state-lost mis-store). Read-only; safe to call on every page mount.
  // Allowed: CAN_MANAGE_QUICKBOOKS (Task #1886 — replaced an inline
  // company_admin / billing_manager allowlist that refused the bookkeeper,
  // even though the QuickBooks page she lands on queries this on mount).
  app.get("/api/quickbooks/connection/stale", requireAuthentication, requireQuickBooksAccess, async (req: any, res: Response) => {
    try {
      const sessionCompanyId = String(req.authenticatedUserCompanyId ?? "");
      if (!sessionCompanyId) {
        res.json({ stale: false, count: 0 });
        return;
      }
      const staleRows = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM quickbooks_integration WHERE company_id = realm_id AND company_id = ${sessionCompanyId}`
      );
      const count = parseInt(staleRows.rows[0]?.count ?? "0", 10);
      res.json({ stale: count > 0, count });
    } catch (err) {
      logger.error({ err }, "GET /api/quickbooks/connection/stale failed");
      res.status(500).json({ message: "Detection failed", error: String(err) });
    }
  });


  // Task #1886 — this route had NO role gate: any authenticated user could
  // read connection status and token expiry. Now on CAN_MANAGE_QUICKBOOKS,
  // the same capability as the rest of the QuickBooks surface.
  app.get("/api/quickbooks/health", requireAuthentication, requireQuickBooksAccess, async (req, res) => {
    try {
      const companyId = resolveCompanyId(req);
      if (!companyId) {
        res.json({ connections: [], count: 0, checkedAt: new Date().toISOString() });
        return;
      }
      const integ = await storage.getQuickBooksIntegrationByCompanyId(companyId);
      if (!integ) {
        res.json({ connections: [], count: 0, checkedAt: new Date().toISOString() });
        return;
      }
      const now = new Date();
      const isTokenValid = integ.expiresAt ? new Date(integ.expiresAt) > now : false;
      const tokenAgeMs = integ.expiresAt
        ? new Date(integ.expiresAt).getTime() - now.getTime()
        : null;
      const connectionEntry = {
        realmId: integ.realmId,
        companyId: integ.companyId,
        connectionStatus: integ.connectionStatus,
        isTokenValid,
        tokenExpiresAt: integ.expiresAt,
        tokenExpiresInMs: tokenAgeMs,
        lastRefreshAttempt: integ.lastRefreshAttempt,
        lastRefreshSuccess: integ.lastRefreshSuccess,
        lastRefreshFailure: integ.lastRefreshFailure,
        lastFailureReason: integ.reconnectRequiredReason ?? null,
        reconnectRequired: integ.connectionStatus === 'reconnect_required',
        tokenEnvironment: integ.tokenEnvironment,
        updatedAt: integ.updatedAt,
      };
      res.json({
        connections: [connectionEntry],
        count: 1,
        checkedAt: now.toISOString(),
      });
    } catch (error) {
      console.error("[QB health] Error fetching health data:", error);
      res.status(500).json({ message: "Failed to fetch QuickBooks connection health" });
    }
  });

  app.post("/api/quickbooks/sync-customers", requireAuthentication, requireQuickBooksAccess, async (req, res) => {
    try {
      
      const userCompanyId = resolveCompanyId(req);
      if (!userCompanyId) {
        res.status(400).json({ success: false, message: "Company context is required." });
        return;
      }
      
      // Get actual QuickBooks integration data - resolve realmId from companyId then fetch canonically
      const qbLookup = await storage.getQuickBooksIntegrationByCompanyId(userCompanyId);
      const integration = qbLookup?.realmId ? await storage.getQuickBooksIntegration(qbLookup.realmId) : null;
      console.log("QuickBooks integration data available:", !!integration);
      
      if (!integration || !integration.accessToken) {
        console.log("Missing integration or access token");
        res.status(400).json({ 
          success: false, 
          message: "QuickBooks not connected. Please connect to QuickBooks first." 
        });
        return;
      }

      // Use production QuickBooks API for deployment, sandbox for development
      const apiBase = process.env.NODE_ENV === 'production' 
        ? 'https://quickbooks.api.intuit.com' 
        : 'https://sandbox-quickbooks.api.intuit.com';
      
      const qbCustomers: Record<string, unknown>[] = [];
      let startPosition = 1;
      const maxResults = 1000;
      let fetchMore = true;

      while (fetchMore) {
        const query = `SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
        const customersResponse = await makeQuickBooksRequest(`${apiBase}/v3/company/${integration.realmId}/query?query=${encodeURIComponent(query)}`, {
          headers: {
            'Authorization': `Bearer ${integration.accessToken}`,
            'Accept': 'application/json'
          }
        }, 'Customers Query', integration.realmId);

        if (!customersResponse.ok) {
          const errorText = await customersResponse.text();
          const customersTid = customersResponse.headers.get('intuit_tid');
          console.error('Failed to fetch customers from QuickBooks:', customersResponse.status, errorText);
          
          if (customersResponse.status === 403) {
            res.status(403).json({ 
              success: false, 
              message: "QuickBooks authorization expired or invalid. Please reconnect to QuickBooks.",
              errorCode: "AUTHORIZATION_FAILED",
              needsReconnection: true
            });
            return;
          }
          
          res.status(500).json({ 
            success: false, 
            message: `Failed to fetch customers from QuickBooks: ${customersResponse.status}${customersTid ? ` [TID: ${customersTid}]` : ''}` 
          });
          return;
        }

        const qbData = (await customersResponse.json()) as QbCustomerQueryResponse;
        const page = (qbData?.QueryResponse?.Customer ?? []) as Record<string, unknown>[];
        qbCustomers.push(...page);

        console.log(`Fetched page starting at ${startPosition}: ${page.length} customers (total so far: ${qbCustomers.length})`);

        if (page.length < maxResults) {
          fetchMore = false;
        } else {
          startPosition += maxResults;
        }
      }

      console.log(`Found ${qbCustomers.length} active customers in QuickBooks`);
      
      const quickBooksCustomers = (qbCustomers as Record<string, unknown>[]).map((customer: Record<string, unknown>) => {
        const billAddr = customer.BillAddr as Record<string, string> | undefined;
        const line1 = billAddr?.Line1 || '';
        const line2 = billAddr?.Line2 || '';
        const line3 = billAddr?.Line3 || '';
        const streetParts = [line1, line2, line3].filter(Boolean);
        const street = streetParts.join(', ');
        const city = billAddr?.City || '';
        const state = billAddr?.CountrySubDivisionCode || '';
        const zip = billAddr?.PostalCode || '';
        const country = billAddr?.Country || '';
        const addressParts = [street, city, state, zip].filter(Boolean);
        return {
          qb_id: customer.Id as string,
          name: (String(customer.DisplayName || '').trim() || String(customer.CompanyName || '').trim() || String(customer.Name || '').trim()),
          email: ((customer.PrimaryEmailAddr as Record<string, string> | undefined)?.Address || ''),
          phone: ((customer.PrimaryPhone as Record<string, string> | undefined)?.FreeFormNumber || ''),
          address: addressParts.join(' ').trim(),
          street,
          city,
          state,
          zip,
          country,
        };
      });

      // Returns only the subset of fields that QB actually has a non-empty value for.
      // email is NOT NULL in the schema so it is only included when non-empty.
      function qbFields(qb: typeof quickBooksCustomers[number]): Record<string, string> {
        const patch: Record<string, string> = {};
        if (qb.name) patch.name = qb.name;
        if (qb.email) patch.email = qb.email;
        if (qb.phone) patch.phone = qb.phone;
        if (qb.address) patch.address = qb.address;
        if (qb.street) patch.street = qb.street;
        if (qb.city) patch.city = qb.city;
        if (qb.state) patch.state = qb.state;
        if (qb.zip) patch.zip = qb.zip;
        if (qb.country) patch.country = qb.country;
        return patch;
      }
      
      console.log(`After mapping: ${quickBooksCustomers.length} customers to process`);
      
      const validCustomers = quickBooksCustomers.filter(customer => customer.name && customer.name.trim() !== '');

      let customersAdded = 0;
      let customersUpdated = 0;
      let customersUnchanged = 0;
      const results = [];

      console.log(`Processing ${validCustomers.length} valid customers`);
      
      for (const qbCustomer of validCustomers) {
        try {
          // Check if customer already exists
          const existingCustomer = await storage.getCustomerByQuickBooksId(qbCustomer.qb_id);
          
          if (!existingCustomer) {
            // Use company ID from header (set earlier in this route)
            const companyId = parseInt(userCompanyId || '1') || 1;
            
            // Create new customer from QuickBooks data with QuickBooks ID mapping
            const newCustomer = await storage.createCustomer({
              name: qbCustomer.name,
              email: qbCustomer.email,
              phone: qbCustomer.phone || '',
              address: qbCustomer.address || '',
              street: qbCustomer.street || null,
              city: qbCustomer.city || null,
              state: qbCustomer.state || null,
              zip: qbCustomer.zip || null,
              country: qbCustomer.country || null,
              quickbooksId: qbCustomer.qb_id,
              companyId: companyId
            });
            
            customersAdded++;
            results.push({ action: 'created', customer: newCustomer });
          } else {
            // Cross-company safety: skip if the matched QB ID belongs to a different company
            if (String(existingCustomer.companyId) !== String(userCompanyId)) {
              results.push({ action: 'skipped_other_company', customer: { qb_id: qbCustomer.qb_id, name: qbCustomer.name } });
              continue;
            }

            // Non-destructive update: only write fields QB actually provides
            const patch = qbFields(qbCustomer);

            // Change detection: skip the DB write if nothing actually changed
            const existingAny = existingCustomer as Record<string, unknown>;
            const changed = Object.keys(patch).some(
              k => patch[k] !== (existingAny[k] ?? '')
            );

            if (!changed) {
              customersUnchanged++;
              results.push({ action: 'unchanged', customer: existingCustomer });
            } else {
              const updatedCustomer = await storage.updateCustomer(existingCustomer.id, patch);
              customersUpdated++;
              results.push({ action: 'updated', customer: updatedCustomer ?? existingCustomer });
            }
          }
        } catch (error) {
          console.error(`Error syncing customer ${qbCustomer.name}:`, error);
          results.push({ action: 'error', customer: qbCustomer, error: error instanceof Error ? error.message : String(error) });
        }
      }

      res.json({
        success: true,
        customersAdded,
        customersUpdated,
        customersUnchanged,
        totalCustomers: quickBooksCustomers.length,
        results,
        message: `${customersAdded} added, ${customersUpdated} updated, ${customersUnchanged} unchanged`
      });

    } catch (error) {
      console.error("QuickBooks customer sync error:", error);
      res.status(500).json({ message: "Failed to sync customers from QuickBooks" });
    }
  });

  app.post("/api/quickbooks/sync-estimate/:id", requireAuthentication, requireQuickBooksAccess, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      // Validate estimate ID is a valid number
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ message: "Invalid estimate ID" });
        return;
      }
      const estimate = await storage.getEstimate(id);
      if (!estimate) {
        res.status(404).json({ message: "Estimate not found" });
        return;
      }
      
      // Get QuickBooks integration data - resolve realmId from companyId then fetch canonically
      const userCompanyId = resolveCompanyId(req);
      if (!userCompanyId) {
        res.status(400).json({ success: false, message: "Company context is required." });
        return;
      }
      const qbLookup = await storage.getQuickBooksIntegrationByCompanyId(userCompanyId);
      const integration = qbLookup?.realmId ? await storage.getQuickBooksIntegration(qbLookup.realmId) : null;
      if (!integration || !integration.accessToken) {
        res.status(400).json({ 
          success: false, 
          message: "QuickBooks not connected. Please connect to QuickBooks first." 
        });
        return;
      }

      // Create invoice in QuickBooks using actual API
      const apiBase = process.env.NODE_ENV === 'production'
        ? 'https://quickbooks.api.intuit.com'
        : 'https://sandbox-quickbooks.api.intuit.com';

      // Look up the real QB customer ID from the estimate's linked customer
      let qbCustomerId: string | null = null;
      if (estimate.customerId) {
        const customer = await storage.getCustomer(estimate.customerId);
        if (!customer || !customer.quickbooksId) {
          res.status(400).json({
            success: false,
            message: "Sync this customer to QuickBooks first before creating an invoice."
          });
          return;
        }
        qbCustomerId = customer.quickbooksId;
      }

      if (!qbCustomerId) {
        res.status(400).json({
          success: false,
          message: "This estimate has no linked customer. Please assign a customer and sync them to QuickBooks first."
        });
        return;
      }

      // Look up service item dynamically (shared helper — no hardcoded IDs)
      const qbServiceItem = await lookupQBServiceItem(apiBase, integration.realmId, integration.accessToken);
      if (!qbServiceItem) {
        res.status(502).json({
          success: false,
          message: `Could not find the QuickBooks item "${QB_SERVICE_ITEM_NAME}". Please create an active Service-type item with that exact name in QuickBooks and try again.`
        });
        return;
      }

      const lineAmount = parseFloat(estimate.totalAmount);

      // Prepare invoice data for QuickBooks
      const invoiceData = {
        Line: [{
          Amount: lineAmount,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            ItemRef: {
              value: qbServiceItem.id,
              name: qbServiceItem.name
            },
            UnitPrice: lineAmount,
            Qty: 1
          },
          Description: (estimate as { title?: string }).title || 'Estimate'
        }],
        CustomerRef: {
          value: qbCustomerId
        }
      };

      console.log('[QB] Sending estimate invoice:', JSON.stringify(invoiceData, null, 2));

      const invoiceResponse = await makeQuickBooksRequest(`${apiBase}/v3/company/${integration.realmId}/invoice`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${integration.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(invoiceData)
      }, 'Estimate Invoice Creation', integration.realmId);

      if (invoiceResponse.ok) {
        const invoiceResult = (await invoiceResponse.json()) as QbInvoiceCreateResponse;
        const qbInvoiceId = invoiceResult?.Invoice?.Id;
        if (!qbInvoiceId) {
          console.error('[QB] Invoice created but no ID returned:', invoiceResult);
        }
        res.json({ 
          success: true,
          quickbooksId: qbInvoiceId,
          message: "Estimate synced to QuickBooks successfully" 
        });
      } else {
        const errorText = await invoiceResponse.text();
        const intuitTid = invoiceResponse.headers.get('intuit_tid');
        console.error('[QB] Estimate invoice creation failed:', invoiceResponse.status, invoiceResponse.statusText);
        console.error('[QB] Full error body:', errorText);
        if (intuitTid) console.error('[QB] TID:', intuitTid);
        res.status(502).json({ 
          success: false,
          message: `Failed to create QuickBooks invoice: ${invoiceResponse.status}${intuitTid ? ` [TID: ${intuitTid}]` : ''}`
        });
      }
    } catch (error) {
      console.error('Error syncing estimate to QuickBooks:', error);
      res.status(500).json({ message: "Failed to sync estimate to QuickBooks" });
    }
  });

  // Task #639 — legacy POST /approve, POST /reject, and the
  // multi-purpose POST /transition all return 410 with a redirect
  // message. See the helper module for the contract and tests.
  // The canonical replacements (PATCH approve/reject,
  // /submit-for-review, /send-approval-email, /resend) all live in
  // ./estimate-routes.ts as of Task #640.
  registerLegacyEstimateGoneRoutes(app);

  // Approve estimate via token (customer clicks link)

  // Customer Integration API Routes
  
  // Google Sheets Customer Integration
  app.get("/api/integrations/google-sheets/customers/status", requireAuthentication, async (req, res) => {
    try {
      const status = await storage.getGoogleSheetsCustomerStatus();
      res.json(status);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to get Google Sheets status" });
    }
  });

  app.post("/api/integrations/google-sheets/customers/connect", requireAuthentication, async (req, res) => {
    try {
      const { sheetUrl } = req.body;
      if (!sheetUrl) {
        res.status(400).json({ message: "Sheet URL is required" });
        return;
      }
      await storage.connectGoogleSheetsCustomers(sheetUrl);
      res.json({ message: "Connected to Google Sheets successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to connect to Google Sheets" });
    }
  });

  app.post("/api/integrations/google-sheets/customers/sync", requireAuthentication, async (req, res) => {
    try {
      const result = await storage.syncCustomersFromGoogleSheets("placeholder-url");
      res.json(result);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to sync customers from Google Sheets" });
    }
  });

  app.post("/api/integrations/google-sheets/customers/disconnect", requireAuthentication, async (req, res) => {
    try {
      await storage.disconnectGoogleSheetsCustomers();
      res.json({ message: "Disconnected from Google Sheets successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to disconnect from Google Sheets" });
    }
  });

  // Work order completion route
  app.post("/api/work-orders/complete", requireAuthentication, async (req, res) => {
    try {
      const {
        workOrderId,
        workSummary,
        customerNotes,
        completedAt,
        totalHours,
        usedParts,
        photos,
        totalPartsCost,
        branchName: incomingBranchName,
        aiInputs: reqAiInputs,
        aiShortDescription,
        aiDetailedDescription,
        // Task #396 — labor mode at completion. Defaults to flat (single
        // totalHours value); per_part is accepted but the completion form
        // does not currently surface a per-line labor input.
        laborMode: incomingLaborMode,
      } = req.body;

      const callerCompanyIdComplete0 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);

      // Billing lock: prevent completing an already-billed work order
      const existingWoForComplete = await storage.getWorkOrder(workOrderId, callerCompanyIdComplete0);
      if (existingWoForComplete && (existingWoForComplete.invoiceId || existingWoForComplete.status === 'billed')) {
        res.status(409).json({ message: "This record has been billed and cannot be edited." });
        return;
      }

      const completedByUserId = req.authenticatedUserId;
      const completedByUser = completedByUserId ? await storage.getUser(completedByUserId) : undefined;
      const completedByUserName = completedByUser?.name || req.headers['x-user-name'];

      // Merge creation photos with completion photos (don't overwrite)
      const existingWorkOrder = await storage.getWorkOrder(workOrderId, callerCompanyIdComplete0);

      // Branch enforcement: if the customer has branches configured, branchName must be present
      if (existingWorkOrder?.customerId) {
        const customer = await storage.getCustomer(existingWorkOrder.customerId);
        if (customer && Array.isArray(customer.branches) && customer.branches.length > 0) {
          const effectiveBranch = incomingBranchName || existingWorkOrder.branchName;
          if (!effectiveBranch || String(effectiveBranch).trim() === '') {
            res.status(400).json({ message: "Branch is required for this customer. Please select a branch before completing the work order." });
            return;
          }
        }
      }

      // Load customer to snapshot their labor rate
      const customerForRates = existingWorkOrder?.customerId
        ? await storage.getCustomerById(existingWorkOrder.customerId)
        : undefined;

      // Snapshot the customer's configured labor rate at the time of completion.
      // money() coerces NaN/null/undefined → 0 so appliedLaborRate.toFixed(2) never stores "NaN".
      const appliedLaborRate = money(customerForRates?.laborRate);

      // Task #396 — authoritative labor calculation by mode.
      //   flat     → use the client-supplied totalHours.
      //   per_part → recompute Σ(laborHours × quantity) across the work
      //              order's persisted items so the saved labor snapshot
      //              never drifts from the per-line breakdown carried on
      //              the WO (e.g. inherited from the originating estimate).
      const priorLaborModeForCalc: 'flat' | 'per_part' =
        existingWorkOrder?.laborMode === 'per_part' ? 'per_part' : 'flat';
      const completionLaborModeForCalc: 'flat' | 'per_part' =
        incomingLaborMode === 'per_part' || incomingLaborMode === 'flat'
          ? incomingLaborMode
          : priorLaborModeForCalc;
      let laborHours: number;
      if (completionLaborModeForCalc === 'per_part') {
        const persistedItems = await storage.getWorkOrderItems(workOrderId);
        const sumFromPersisted = persistedItems.reduce(
          (s, it) =>
            s +
            (parseFloat(String(it.laborHours ?? '0')) || 0) *
              (parseFloat(String(it.quantity ?? '0')) || 0),
          0,
        );
        const sumFromIncoming = Array.isArray(usedParts)
          ? usedParts.reduce(
              (s: number, p: { laborHours?: string | number; quantity?: string | number }) =>
                s +
                (parseFloat(String(p.laborHours ?? '0')) || 0) *
                  (parseFloat(String(p.quantity ?? '0')) || 0),
              0,
            )
          : 0;
        laborHours = sumFromPersisted > 0 ? sumFromPersisted : sumFromIncoming;
      } else {
        laborHours = money(totalHours);
      }

      // Fetch prior items NOW (before computing partsCost) so we can correctly
      // handle the empty-usedParts guard further below.  When usedParts is empty
      // but the WO already has items we must NOT overwrite the header totals with
      // the client-supplied 0; instead we derive partsCost from the persisted items.
      const incomingParts: typeof usedParts = usedParts || [];
      const priorItemsForGuard = await storage.getWorkOrderItems(workOrderId);
      const skipReplace = incomingParts.length === 0 && priorItemsForGuard.length > 0;

      // partsCost: authoritative value depends on whether we will skip the replace.
      //   • Normal path (usedParts non-empty, or WO is genuinely empty): use
      //     client-supplied totalPartsCost (tech-confirmed on the completion form).
      //   • Skip path (usedParts empty but WO has items): derive from persisted
      //     item totalPrices so the header stays consistent with the item rows.
      const partsCost = skipReplace
        ? priorItemsForGuard.reduce((s, it) => s + money(it.totalPrice), 0)
        : money(totalPartsCost);
      const rate = money(appliedLaborRate);

      const laborSubtotal = laborHours * rate;
      const partsSubtotal = partsCost;
      const totalAmount = laborSubtotal + partsSubtotal;

      const creationPhotos: string[] = existingWorkOrder?.photos || [];
      const completionPhotos: string[] = photos || [];
      const mergedPhotos = [...creationPhotos, ...completionPhotos];

      // Update work order with completion details and calculated totals
      // Field completion routes into pending_manager_review for manager approval
      // Task #396 — labor mode resolved above (completionLaborModeForCalc).
      const completionLaborMode = completionLaborModeForCalc;
      if (
        existingWorkOrder &&
        existingWorkOrder.laborMode &&
        existingWorkOrder.laborMode !== completionLaborMode
      ) {
        console.log(
          `[AUDIT] work_order_labor_mode_changed workOrderId=${workOrderId} ` +
          `from=${existingWorkOrder.laborMode} to=${completionLaborMode} reason=completion`
        );
      }
      const workOrder = await storage.updateWorkOrder(workOrderId, {
        status: 'pending_manager_review',
        completedAt: new Date(completedAt),
        completedByUserId: completedByUserId || undefined,
        completedByUserName: completedByUserName as string,
        workSummary,
        customerNotes,
        laborMode: completionLaborMode,
        totalHours: laborHours.toString(),
        photos: mergedPhotos,
        totalPartsCost: partsCost.toString(),
        laborSubtotal: laborSubtotal.toFixed(2),
        partsSubtotal: partsSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        laborRate: appliedLaborRate.toFixed(2),
        appliedLaborRate: appliedLaborRate.toFixed(2),
        ...(incomingBranchName ? { branchName: incomingBranchName } : {}),
        ...(reqAiInputs ? { aiInputs: reqAiInputs } : {}),
        ...(aiShortDescription ? { aiShortDescription } : {}),
        ...(aiDetailedDescription ? { aiDetailedDescription } : {}),
      });

      if (!workOrder) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }

      // Replace work-order items with the final tech-confirmed set (Slice 1B).
      // incomingParts / priorItemsForGuard / skipReplace are all computed earlier
      // (before updateWorkOrder) so the header totals already reflect the correct
      // partsCost for both the normal and skip paths.
      if (!skipReplace) {
        // Build the final item list from all confirmed usedParts.
        // Pricing strategy:
        //   • Estimate-origin (prefilled) items already have a snapshotted price in the
        //     WO items table. Re-fetching from the catalog could silently reprice historical
        //     work if the catalog changed since the estimate was created. So we use the
        //     existing WO item's partPrice whenever a matching partId already exists.
        //   • Field-added items (partId not in priorItems) are genuinely new additions —
        //     use the current catalog price for them.
        //   • findingId lineage: carry the prior item's findingId so the wetCheck→WO
        //     traceability is preserved after replacement. Field-added parts get null.
        // Build a stack-map so that multiple WO items with the same partId
        // (e.g. same part in two zones from two distinct findings) each get
        // their own prior row rather than collapsing to whichever was inserted
        // last in a simple Map.  Each incoming part shifts() the first queued
        // prior off the stack; once exhausted, remaining incoming entries are
        // treated as field-added (catalog-price lookup path).
        // Slice 2 (server) — id-keyed lookup for sourceItemId matching.
        // When the client stamps sourceItemId on prefill rows we can match by
        // the exact prior id instead of the stacking-by-partId heuristic.
        // This is the primary fix for the cross-wire bug (same part, two zones).
        const priorsById = new Map<number, (typeof priorItemsForGuard)[number]>();
        for (const it of priorItemsForGuard) {
          priorsById.set(it.id, it);
        }

        const priorsByPartId = new Map<number | null, (typeof priorItemsForGuard)>();
        for (const it of priorItemsForGuard) {
          const list = priorsByPartId.get(it.partId) ?? [];
          list.push(it);
          priorsByPartId.set(it.partId, list);
        }

        // Track prior row IDs that have already been claimed by a sourceItemId
        // match so the partId stack-map fallback path never double-consumes them.
        const consumedPriorIds = new Set<number>();

        const finalItems: Parameters<typeof storage.replaceWorkOrderItemsWithResync>[1] = [];
        for (const part of incomingParts) {
          let prior: (typeof priorItemsForGuard)[number] | undefined;

          // Slice 2 (server) — try exact-id match first when sourceItemId is present.
          const rawSourceItemId = (part as any).sourceItemId;
          if (rawSourceItemId != null) {
            const sid = Number(rawSourceItemId);
            if (Number.isFinite(sid)) {
              const candidate = priorsById.get(sid);
              if (candidate && !consumedPriorIds.has(candidate.id)) {
                prior = candidate;
                consumedPriorIds.add(candidate.id);
                // Remove from partId stack so it is not double-consumed.
                const list = priorsByPartId.get(candidate.partId) ?? [];
                const idx = list.indexOf(candidate);
                if (idx >= 0) list.splice(idx, 1);
              }
              // Miss (stale id after replace, foreign id): fall through to stack-map.
            }
          }

          // Fallback: partId stack-map (legacy / offline payloads without sourceItemId).
          if (!prior) {
            const priorList = part.partId != null ? priorsByPartId.get(part.partId) : undefined;
            // Skip any row already claimed by a sourceItemId match above.
            while (priorList && priorList.length > 0 && consumedPriorIds.has(priorList[0].id)) {
              priorList.shift();
            }
            const candidate = priorList?.shift();
            if (candidate) {
              prior = candidate;
              consumedPriorIds.add(candidate.id);
            }
          }

          if (prior) {
            // Preserve snapshotted price + lineage from the existing WO item.
            // Slice 1: also carry zone columns (controllerLetter, zoneNumber,
            // issueType) and the prior check-off state (completedAt) so an
            // inspection WO round-trip keeps its zone grouping and check-off state.
            const unitPrice = money(prior.partPrice);
            finalItems.push({
              workOrderId,
              partId: part.partId,
              partName: prior.partName,
              partPrice: prior.partPrice,
              quantity: part.quantity,
              totalPrice: (money(part.quantity) * unitPrice).toFixed(2),
              laborHours: prior.laborHours ?? "0",
              findingId: (prior as any).findingId ?? null,
              controllerLetter: (prior as any).controllerLetter ?? null,
              zoneNumber: (prior as any).zoneNumber ?? null,
              issueType: (prior as any).issueType ?? null,
              completedAt: (prior as any).completedAt ?? null,
            });
          } else {
            // Field-added part: use payload snapshot values as primary source so
            // no data is silently dropped if the catalog row is missing or stale.
            // Catalog lookup is only used as a fallback when partName/partPrice are absent.
            const payloadName: string | undefined = (part as any).partName;
            const payloadPrice: string | number | undefined = (part as any).partPrice;
            const payloadLaborHours: string | number | undefined = (part as any).laborHours;
            let resolvedName: string;
            let resolvedPrice: string | number;
            if (payloadName && payloadPrice != null) {
              resolvedName = payloadName;
              resolvedPrice = payloadPrice;
            } else {
              const partDetails = await storage.getPart(part.partId);
              resolvedName = payloadName ?? partDetails?.name ?? '';
              resolvedPrice = payloadPrice ?? partDetails?.price ?? '0';
            }
            const unitPrice = money(resolvedPrice);
            finalItems.push({
              workOrderId,
              partId: part.partId,
              partName: resolvedName,
              partPrice: String(resolvedPrice),
              quantity: part.quantity,
              totalPrice: (money(part.quantity) * unitPrice).toFixed(2),
              laborHours: payloadLaborHours != null ? String(payloadLaborHours) : "0",
              findingId: null,
            });
          }
        }
        if (finalItems.length > 0) {
          await storage.replaceWorkOrderItemsWithResync(workOrderId, finalItems, callerCompanyIdComplete0);
        } else if (incomingParts.length > 0) {
          // All part catalog lookups resolved to nothing (e.g. every partId unknown).
          // Do NOT zero-out the existing items — preserve prior rows to avoid data
          // loss and log an error so ops can investigate.
          logger.error(
            { workOrderId, incomingPartsCount: incomingParts.length },
            'completion/replace-items: all usedParts failed catalog resolution — preserving prior items to avoid zeroing real data',
          );
        }
      } else {
        logger.warn(
          { workOrderId, priorItemCount: priorItemsForGuard.length },
          'completion/replace-items: usedParts is empty but WO has prior items — skipping replace, header totals derived from persisted items',
        );
      }

      // Log AI generation data if provided
      if (reqAiInputs) {
        try {
          await storage.createAiGenerationLog({
            userId: completedByUserId || null,
            entityType: "work_order",
            entityId: workOrderId,
            inputs: reqAiInputs,
            rawOutput: JSON.stringify({ aiShortDescription, aiDetailedDescription }),
            templateVersion: "v1",
          });
        } catch (logErr) {
          console.error("[AI] Failed to write audit log for work order completion:", logErr);
        }
      }

      // Notify managers about work order completion
      const managers = await storage.getUsers();
      const managerUsers = managers.filter(u => u.role === "irrigation_manager" || u.role === "admin");
      
      for (const manager of managerUsers) {
        await storage.createNotification({
          userId: manager.id,
          type: "work_order_completed",
          title: "Work Order Completed",
          message: `Work order ${workOrder.workOrderNumber} has been completed by ${completedByUserName || workOrder.assignedTechnicianName}.`,
          relatedEntityType: "work_order",
          relatedEntityId: workOrderId
        });
      }

      await recordLifecycleAudit(req, {
        resource: "work_order",
        action: "work_order.completed",
        targetId: workOrderId,
        before: { status: existingWorkOrder?.status },
        after: { status: workOrder.status },
        summary: `Work order ${workOrder.workOrderNumber} completed`,
      });

      res.json({ message: "Work order completed successfully", workOrder });
    } catch (error) {
      const { status, message } = classifyAndLog(req, error, {
        op: "completeWorkOrder",
        ctx: { workOrderId: req.body?.workOrderId },
        fallbackMessage: "Failed to complete work order",
      });
      res.status(status).json({ message });
    }
  });

  app.post("/api/work-orders/:id/complete", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      const completedByUserId = req.authenticatedUserId;
      const completedByUser = completedByUserId ? await storage.getUser(completedByUserId) : undefined;
      const completedByUserName = completedByUser?.name || req.headers['x-user-name'];

      // Read existing work order to snapshot rates from customer
      const callerCompanyIdComplete1 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const existingWorkOrder = await storage.getWorkOrder(id, callerCompanyIdComplete1);
      if (!existingWorkOrder) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }

      // Snapshot the customer's configured labor rate at the time of completion.
      // Phase 1B: use money() so NaN/Infinity inputs coerce to 0 — prevents
      // NaN from propagating into stored totals via laborSubtotal/totalAmount.
      const customerForRates = existingWorkOrder.customerId
        ? await storage.getCustomerById(existingWorkOrder.customerId)
        : undefined;
      const appliedLaborRate = money(customerForRates?.laborRate);

      // Calculate totals — all inputs through money() so NaN/Infinity → 0.
      const laborHours = money(existingWorkOrder.totalHours);
      const partsCost = money(existingWorkOrder.totalPartsCost);
      const laborSubtotal = laborHours * appliedLaborRate;
      const partsSubtotal = partsCost;
      const totalAmount = laborSubtotal + partsSubtotal;

      // Field completion routes into pending_manager_review for manager approval
      const workOrder = await storage.updateWorkOrder(id, {
        status: "pending_manager_review",
        completedAt: new Date(),
        completedByUserId: completedByUserId || undefined,
        completedByUserName: completedByUserName as string,
        laborSubtotal: laborSubtotal.toFixed(2),
        partsSubtotal: partsSubtotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        laborRate: appliedLaborRate.toFixed(2),
        appliedLaborRate: appliedLaborRate.toFixed(2),
      });
      if (!workOrder) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }

      // Notify managers about work order completion / pending review
      const managers = await storage.getUsers();
      const managerUsers = managers.filter(u => u.role === "irrigation_manager" || u.role === "admin");
      
      for (const manager of managerUsers) {
        await storage.createNotification({
          userId: manager.id,
          type: "work_order_completed",
          title: "Work Order Pending Review",
          message: `Work order ${workOrder.workOrderNumber} has been completed and is awaiting your review.`,
          relatedEntityType: "work_order",
          relatedEntityId: id
        });
      }

      await recordLifecycleAudit(req, {
        resource: "work_order",
        action: "work_order.completed",
        targetId: id,
        before: { status: existingWorkOrder.status },
        after: { status: workOrder.status },
        summary: `Work order ${workOrder.workOrderNumber} completed and pending review`,
      });

      res.json(workOrder);
    } catch (error) {
      console.error("Error completing work order:", error);
      res.status(500).json({ message: "Failed to complete work order" });
    }
  });

  // Manager approval gate endpoints (Task #767 / #768)
  // Extracted to ./approve-routes.ts so they can be unit-tested without a
  // live DB. registerApproveRoutes mounts all four handlers:
  //   POST /api/billing-sheets/:id/approve
  //   POST /api/billing-sheets/:id/return-for-correction
  //   POST /api/work-orders/:id/approve
  //   POST /api/work-orders/:id/return-for-correction
  registerApproveRoutes(app, storage, requireAuthentication, {
    recordLifecycleAudit,
  });

  // Task #662 — company-scoped "This Month Billed" rollup for the
  // Company Admin dashboard's Financial Exposure tile. The legacy
  // GET /api/invoices is intentionally unscoped (it's only safe for
  // customer-bounded callers); using it for a dashboard rollup
  // leaked totals across tenants. This endpoint is the canonical
  // source for the tile.
  // @deprecated Task #708 — superseded by GET /api/financial-pulse/kpis
  // (`billedMtd.value`), which is now the single source of truth for the
  // Admin Dashboard "Billed MTD" tile via <FinancialPulseWidget
  // variant="admin-dashboard" />. Kept for back-compat with any external
  // consumers; the in-app frontend no longer reads it. Slated for removal
  // in a follow-up task after a production cycle confirms no stragglers.
  app.get("/api/dashboard/this-month-billed", requireAuthentication, async (req: any, res) => {
    try {
      const role = req.authenticatedUserRole as string | undefined;
      const callerCompanyId = (req.authenticatedUserCompanyId as number | null | undefined) ?? null;

      // Monetary rollup — field techs (and any unrecognized role) are
      // denied. Pricing visibility is suppressed for field_tech across
      // the rest of the app; this endpoint must match.
      const ROLLUP_ROLES = new Set([
        "super_admin",
        "company_admin",
        "billing_manager",
        "irrigation_manager",
      ]);
      if (!role || !ROLLUP_ROLES.has(role)) {
        res.status(403).json({ message: "Forbidden" });
        return;
      }

      // super_admin: global by default, or `?companyId=N` to scope.
      // Everyone else: forced to their own company id; query param is
      // ignored (do not let a non-super-admin pick someone else's totals).
      let scopeCompanyId: number | null;
      if (role === "super_admin") {
        const q = req.query.companyId;
        if (q != null && q !== "") {
          const parsed = parseInt(String(q), 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            res.status(400).json({ message: "Invalid companyId" });
            return;
          }
          scopeCompanyId = parsed;
        } else {
          scopeCompanyId = null;
        }
      } else {
        if (callerCompanyId == null) {
          res.status(403).json({ message: "User is not associated with a company" });
          return;
        }
        scopeCompanyId = callerCompanyId;
      }

      const rollup = await storage.getThisMonthBilledForCompany(scopeCompanyId);
      res.json(rollup);
    } catch (error) {
      console.error("Error fetching this-month-billed rollup:", error);
      res.status(500).json({ message: "Failed to fetch this-month-billed rollup" });
    }
  });

  // Invoice routes (placeholder endpoints)
  // Task #1886 — this endpoint previously had NO role gate: any authenticated
  // user could list every invoice in their company. It is now gated on
  // CAN_READ_INVOICES (field_tech is refused; irrigation_manager keeps the
  // access it had, now by declaration rather than by omission). The existing
  // company scoping and the super_admin → null convention below are unchanged.
  // Task #1890 — GET /api/invoices now lives in ./invoice-list-routes so the
  // A/R annotate → filter → sort → paginate pipeline can be tested against a
  // storage spy. Registered here, alongside the other invoice route modules,
  // to keep route ordering identical to when it was inline.
  registerInvoiceListRoutes(app, {
    requireAuthentication,
    requireInvoiceRead,
    applyPricingVisibility,
    // Task #1889 — A/R note count + preview leave the payload entirely for a
    // role without CAN_READ_AR_NOTES.
    applyArNoteVisibility,
  });

  app.post("/api/work-orders/:id/create-invoice", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      // This would need to be implemented in storage
      res.json({ message: "Invoice creation endpoint ready for implementation" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to create invoice from work order" });
    }
  });

  app.post("/api/work-orders/:id/sync-quickbooks", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      // This would need to be implemented for QuickBooks sync
      res.json({ message: "QuickBooks sync endpoint ready for implementation" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to sync to QuickBooks" });
    }
  });

  // ── Wet Check Billings (Slice 4) ─────────────────────────────────────────
  // List all wet check billings with aggregate issuesCount / zonesCount.
  // Sorted workDate DESC by the storage layer; pricing stripped for field_tech.
  app.get("/api/wet-check-billings", requireAuthentication, async (req, res) => {
    try {
      const callerRoleWcb = req.authenticatedUserRole;
      if (callerRoleWcb !== 'super_admin' && !req.authenticatedUserCompanyId) {
        res.status(403).json({ message: "Forbidden: user has no company association" });
        return;
      }
      const callerCidWcb: number | null = callerRoleWcb === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? null);
      const billings = await storage.getAllWetCheckBillingsWithCounts(callerCidWcb);
      res.json(applyPricingVisibility(req, billings));
    } catch (error) {
      logger.error({ err: error }, "GET /api/wet-check-billings failed");
      res.status(500).json({ message: "Failed to fetch wet check billings" });
    }
  });

  // Detail: { wetCheckBilling, view } — 404 on missing, 400 on non-numeric id.
  app.get("/api/wet-check-billings/:id", requireAuthentication, async (req, res) => {
    try {
      const rawId = req.params.id;
      const id = parseInt(rawId, 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ message: "Invalid wet check billing id" });
        return;
      }
      const wcbCallerRole = req.authenticatedUserRole;
      if (wcbCallerRole !== 'super_admin' && !req.authenticatedUserCompanyId) {
        res.status(403).json({ message: "Forbidden: user has no company association" });
        return;
      }
      const wcbCallerCompanyId: number | null = wcbCallerRole === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? null);
      const wetCheckBilling = await storage.getWetCheckBillingById(id, wcbCallerCompanyId);
      if (!wetCheckBilling) {
        res.status(404).json({ message: "Wet check billing not found" });
        return;
      }
      const companyId: number | null = req.authenticatedUserCompanyId ?? null;
      const view = await storage.getWetCheckBillingViewById(id, companyId);
      // Task #1093 — embed customer rates for inline edit.
      let customerRatesWcb: { laborRate: string | null; emergencyLaborRate: string | null } | null = null;
      if (wetCheckBilling.customerId) {
        const cust = await storage.getCustomer(wetCheckBilling.customerId);
        if (cust) customerRatesWcb = { laborRate: cust.laborRate, emergencyLaborRate: cust.emergencyLaborRate };
      }
      res.json(applyPricingVisibility(req, { wetCheckBilling, customer: customerRatesWcb, view }));
    } catch (error) {
      logger.error({ err: error }, "GET /api/wet-check-billings/:id failed");
      res.status(500).json({ message: "Failed to fetch wet check billing" });
    }
  });

  // Delete an unbilled WCB — billing_manager | company_admin only.
  // Guards: company-scope (404 if not owned), invoiced WCB returns 409.
  // Cascades: clears wetCheckBillingId / convertedAt / resolution on findings.
  app.delete("/api/wet-check-billings/:id", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const rawId = req.params.id;
    const id = parseInt(rawId, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ message: "Invalid wet check billing id" }); return;
    }
    try {
      const wcb = await storage.getWetCheckBillingById(id, cid);
      if (!wcb) {
        res.status(404).json({ message: "Wet check billing not found" }); return;
      }
      if (wcb.invoiceId != null) {
        res.status(409).json({
          message: `WC Snapshot ${wcb.billingNumber} is already on invoice #${wcb.invoiceId} and cannot be deleted. Remove it from the invoice first.`,
          code: "WCB_ALREADY_INVOICED",
          invoiceId: wcb.invoiceId,
        }); return;
      }
      await storage.deleteWetCheckBilling(id);
      res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "DELETE /api/wet-check-billings/:id failed");
      res.status(500).json({ message: "Failed to delete WC Snapshot — please retry" });
    }
  });

  // Task #891 — billing-manager-tier zone repair labor edit on a finalised WCB.
  // Body: { zoneRecordId: number, repairLaborHours: string }
  // Updates the zone record and recomputes the WCB totals in a transaction.
  const wcbZoneLaborBody = z.object({
    zoneRecordId: z.coerce.number().int().positive(),
    repairLaborHours: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, "Must be a non-negative decimal with up to 2 places")
      .refine((v) => parseFloat(v) >= 0, "Must be non-negative"),
  });
  app.patch("/api/wet-check-billings/:id/zone-labor", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = wcbZoneLaborBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const wcbId = parseInt(req.params.id, 10);
    if (!Number.isFinite(wcbId)) { res.status(400).json({ message: "Invalid id" }); return; }
    try {
      const result = await storage.setWcbZoneRepairLabor(
        wcbId,
        parsed.data.zoneRecordId,
        parsed.data.repairLaborHours,
        cid,
      );
      if (!result) { res.status(404).json({ message: "Not found" }); return; }
      // Audit write — non-fatal; a write failure must not fail the PATCH.
      try {
        const wcAuditResult = await db.execute<{ companyId: number | null }>(
          sql`SELECT company_id AS "companyId" FROM wet_checks WHERE id = ${result.updated.wcb.wetCheckId} LIMIT 1`,
        );
        const wcCompanyIdForAudit: number | null = wcAuditResult.rows[0]?.companyId ?? null;
        await recordLifecycleAudit(req, {
          resource: "wet_check_billing",
          action: "wet_check_billing.zone_labor_edited",
          targetId: wcbId,
          before: {
            controllerLetter: result.before.zoneRecord.controllerLetter,
            zoneNumber: result.before.zoneRecord.zoneNumber,
            repairLaborHours: result.before.zoneRecord.repairLaborHours,
          },
          after: {
            controllerLetter: result.updated.zoneRecord.controllerLetter,
            zoneNumber: result.updated.zoneRecord.zoneNumber,
            repairLaborHours: result.updated.zoneRecord.repairLaborHours,
          },
          summary: `Zone ${result.updated.zoneRecord.controllerLetter}${result.updated.zoneRecord.zoneNumber} labor → ${parsed.data.repairLaborHours}h`,
          companyId: wcCompanyIdForAudit,
          extra: { wetCheckId: result.updated.wcb.wetCheckId, zoneRecordId: parsed.data.zoneRecordId },
        });
      } catch (auditErr) {
        console.error("[audit] wet_check_billing.zone_labor_edited", auditErr);
      }
      res.json(result.updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "setWcbZoneRepairLabor",
        ctx: { cid, wcbId, zoneRecordId: parsed.data.zoneRecordId },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't save zone labor",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1027 — billing-manager-tier reset of zone repair labor on a WCB.
  // Body: { zoneRecordId: number }
  // Clears repairLaborManuallySet, re-runs auto-compute, recomputes WCB totals.
  const wcbZoneLaborResetBody = z.object({
    zoneRecordId: z.coerce.number().int().positive(),
  });
  app.post("/api/wet-check-billings/:id/zone-labor/reset", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = wcbZoneLaborResetBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const wcbId = parseInt(req.params.id, 10);
    if (!Number.isFinite(wcbId)) { res.status(400).json({ message: "Invalid id" }); return; }
    try {
      const result = await storage.resetWcbZoneRepairLabor(wcbId, parsed.data.zoneRecordId, cid);
      if (!result) { res.status(404).json({ message: "Not found" }); return; }
      res.json(result);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "resetWcbZoneRepairLabor",
        ctx: { cid, wcbId, zoneRecordId: parsed.data.zoneRecordId },
        fallbackStatus: 500,
        fallbackMessage: "Couldn't reset zone labor",
      });
      res.status(status).json({ message });
    }
  });

  // Task #977 — billing-manager-tier labor-rate override on an unbilled WCB.
  // Body: { newRate: number } — finite, ≥0, ≤1000.
  // Returns 409 for billed or invoiced WCBs; 403 for field_tech or cross-company.
  const wcbLaborRateBody = z.object({
    newRate: z.coerce.number().finite("newRate must be a finite number").min(0, "newRate must be ≥ 0").max(1000, "newRate must be ≤ 1000"),
  });
  app.patch("/api/wet-check-billings/:id/labor-rate", requireAuthentication, async (req, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "irrigation_manager" && role !== "company_admin" && role !== "super_admin") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = wcbLaborRateBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const wcbId = parseInt(req.params.id, 10);
    if (!Number.isFinite(wcbId)) { res.status(400).json({ message: "Invalid id" }); return; }
    // super_admin bypasses tenant-scope (companyId null = no tenant filter).
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const result = await storage.recomputeWcbTotalsForLaborRate(wcbId, parsed.data.newRate, companyId);
      // Audit write — non-fatal; a write failure must not fail the PATCH.
      try {
        const wcAuditResult = await db.execute<{ companyId: number | null }>(
          sql`SELECT company_id AS "companyId" FROM wet_checks WHERE id = ${result.updated.wetCheckId} LIMIT 1`,
        );
        const wcCompanyIdForAudit: number | null = wcAuditResult.rows[0]?.companyId ?? null;
        await recordLifecycleAudit(req, {
          resource: "wet_check_billing",
          action: "wet_check_billing.labor_rate_overridden",
          targetId: wcbId,
          before: { laborRate: result.before.laborRate, totalAmount: result.before.totalAmount },
          after: { laborRate: result.updated.laborRate, totalAmount: result.updated.totalAmount },
          summary: `WCB ${result.updated.billingNumber} labor rate → $${parsed.data.newRate}/hr`,
          companyId: wcCompanyIdForAudit,
        });
      } catch (auditErr) {
        console.error("[audit] wet_check_billing.labor_rate_overridden", auditErr);
      }
      res.json(result.updated);
    } catch (e: any) {
      if (e?.code === "WCB_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "WCB_CROSS_COMPANY") { res.status(403).json({ message: "Access denied" }); return; }
      if (e?.code === "WCB_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "recomputeWcbTotalsForLaborRate",
        ctx: { wcbId, newRate: parsed.data.newRate },
        fallbackStatus: 500,
        fallbackMessage: "Couldn't update labor rate",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1093 — rate-mode toggle for WCBs.
  // Body: { mode: "normal" | "emergency" }
  const rateModeBody = z.object({
    mode: z.enum(["normal", "emergency"]),
  });
  app.patch("/api/wet-check-billings/:id/rate-mode", requireAuthentication, async (req, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = rateModeBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const wcbId = parseInt(req.params.id, 10);
    if (!Number.isFinite(wcbId)) { res.status(400).json({ message: "Invalid id" }); return; }
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const result = await storage.recomputeWcbTotalsForRateMode(wcbId, parsed.data.mode, companyId);
      // Audit write — non-fatal; a write failure must not fail the PATCH.
      try {
        const wcAuditResult = await db.execute<{ companyId: number | null }>(
          sql`SELECT company_id AS "companyId" FROM wet_checks WHERE id = ${result.updated.wetCheckId} LIMIT 1`,
        );
        const wcCompanyIdForAudit: number | null = wcAuditResult.rows[0]?.companyId ?? null;
        await recordLifecycleAudit(req, {
          resource: "wet_check_billing",
          action: "wet_check_billing.rate_mode_changed",
          targetId: wcbId,
          before: { rateMode: result.before.rateMode, laborRate: result.before.laborRate, totalAmount: result.before.totalAmount },
          after: { rateMode: result.updated.rateMode, laborRate: result.updated.laborRate, totalAmount: result.updated.totalAmount },
          summary: `WCB ${result.updated.billingNumber} rate mode → ${parsed.data.mode}`,
          companyId: wcCompanyIdForAudit,
        });
      } catch (auditErr) {
        console.error("[audit] wet_check_billing.rate_mode_changed", auditErr);
      }
      res.json(result.updated);
    } catch (e: any) {
      if (e?.code === "WCB_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "WCB_CROSS_COMPANY") { res.status(403).json({ message: "Access denied" }); return; }
      if (e?.code === "WCB_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      if (e?.code === "NO_CUSTOMER") { res.status(422).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "recomputeWcbTotalsForRateMode",
        ctx: { wcbId, mode: parsed.data.mode },
        fallbackStatus: 500,
        fallbackMessage: "Couldn't update rate mode",
      });
      res.status(status).json({ message });
    }
  });

  // Billing Sheets API - for work done without work orders
  // Note: Pricing fields are stripped for field_tech role via applyPricingVisibility
  app.get("/api/billing-sheets", requireAuthentication, async (req, res) => {
    try {
      const { technician } = req.query;

      const _bsCallerRole = (req as any).authenticatedUserRole as string | undefined;
      if (_bsCallerRole !== 'super_admin' && !(req as any).authenticatedUserCompanyId) {
        res.status(403).json({ message: "Forbidden: user has no company association" });
        return;
      }
      const callerCompanyId9680 = _bsCallerRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      let billingSheets;
      if (technician) {
        billingSheets = await storage.getBillingSheetsByTechnician(parseInt(technician as string), callerCompanyId9680);
      } else {
        billingSheets = await storage.getAllBillingSheets(callerCompanyId9680);
      }
      
      // Strip pricing fields for field technicians
      res.json(applyPricingVisibility(req, billingSheets));
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch billing sheets" });
    }
  });

  // Report: billing sheets created before the photo-save fix (Task #143) that
  // currently have zero photos. Used by managers to chase up techs to re-attach
  // photos via the post-creation "Add Photos" UI.
  // Cutoff = commit time of the fix (2026-04-22 14:22:39 UTC).
  const PHOTO_FIX_CUTOFF = new Date("2026-04-22T14:22:39Z");
  app.get("/api/billing-sheets/missing-photos", requireAuthentication, async (req: any, res) => {
    try {
      const role = req.authenticatedUserRole;
      if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
        res.status(403).json({ message: "Access denied." });
        return;
      }

      // Tenant scoping: non-super_admin requesters only see techs/sheets within
      // their own company. We resolve company ownership through the assigned
      // technician's companyId since billing_sheets has no direct companyId column.
      const requesterCompanyId: number | null = req.authenticatedUserCompanyId ?? null;
      const isSuperAdmin = role === 'super_admin';

      const all = await storage.getAllBillingSheets(isSuperAdmin ? null : requesterCompanyId);
      const techCompanyCache = new Map<number, number | null>();
      const techCompanyId = async (techId: number | null | undefined): Promise<number | null> => {
        if (!techId) return null;
        if (techCompanyCache.has(techId)) return techCompanyCache.get(techId) ?? null;
        const u = await storage.getUser(techId);
        const cid = u?.companyId ?? null;
        techCompanyCache.set(techId, cid);
        return cid;
      };

      const candidates = all.filter(s => {
        const created = s.createdAt ? new Date(s.createdAt) : null;
        if (!created || created >= PHOTO_FIX_CUTOFF) return false;
        // Task #197 — admins/managers can mark a billing sheet as not
        // needing photos; once flagged it should disappear from the report
        // (JSON and CSV) and stay off the list permanently.
        if (s.noPhotosNeeded) return false;
        // Task #192 — once a billing sheet has been billed, chasing photos
        // for it is pointless. Hide anything that's been billed (status,
        // invoice link, or billed timestamp).
        if (s.status === 'billed' || s.invoiceId != null || s.billedAt != null) return false;
        const photos = Array.isArray(s.photos) ? s.photos : [];
        return photos.length === 0;
      });

      const missing = [] as typeof candidates;
      for (const s of candidates) {
        if (isSuperAdmin) {
          missing.push(s);
          continue;
        }
        if (requesterCompanyId == null) continue;
        const cid = await techCompanyId(s.technicianId);
        if (cid === requesterCompanyId) missing.push(s);
      }

      // Sort newest first
      missing.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const format = (req.query.format as string | undefined)?.toLowerCase();
      if (format === 'csv') {
        const escape = (v: any) => {
          const s = v == null ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = ['Billing Number','Technician','Customer','Branch','Property Address','Work Date','Created At','Status','Work Description'];
        const rows = missing.map(s => [
          s.billingNumber,
          s.technicianName,
          s.customerName,
          s.branchName ?? '',
          s.propertyAddress ?? '',
          s.workDate ? new Date(s.workDate).toISOString().slice(0,10) : '',
          new Date(s.createdAt).toISOString(),
          s.status,
          (s.workDescription ?? '').replace(/\s+/g, ' ').trim(),
        ].map(escape).join(','));
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="missing-photos-${new Date().toISOString().slice(0,10)}.csv"`);
        res.send(csv);
        return;
      }

      // Tenant-scoped notifications: only expose rows for technicians visible
      // to this requester (i.e. those who appear in the already-scoped `missing`
      // dataset). This prevents cross-company metadata leakage.
      const visibleTechIds = new Set<number>();
      for (const s of missing) {
        if (s.technicianId != null) visibleTechIds.add(s.technicianId);
      }
      const notifyRows = await storage.getMissingPhotosNotifications();
      const notifications: Record<string, {
        lastSentAt: string;
        sheetCount: number;
        lastEmailAt: string | null;
        lastSmsAt: string | null;
        emailSheetCount: number | null;
        smsSheetCount: number | null;
        lastSmsStatus: string | null;
        lastSmsStatusAt: string | null;
        lastSmsErrorCode: string | null;
      }> = {};
      for (const n of notifyRows) {
        if (n.technicianId != null && visibleTechIds.has(n.technicianId)) {
          notifications[String(n.technicianId)] = {
            lastSentAt: new Date(n.lastSentAt).toISOString(),
            sheetCount: n.sheetCount,
            lastEmailAt: n.lastSentEmailAt ? new Date(n.lastSentEmailAt).toISOString() : null,
            lastSmsAt: n.lastSentSmsAt ? new Date(n.lastSentSmsAt).toISOString() : null,
            emailSheetCount: n.lastEmailSheetCount ?? null,
            smsSheetCount: n.lastSmsSheetCount ?? null,
            lastSmsStatus: n.lastSmsStatus ?? null,
            lastSmsStatusAt: n.lastSmsStatusAt ? new Date(n.lastSmsStatusAt).toISOString() : null,
            lastSmsErrorCode: n.lastSmsErrorCode ?? null,
          };
        }
      }

      res.json({
        cutoff: PHOTO_FIX_CUTOFF.toISOString(),
        count: missing.length,
        sheets: applyPricingVisibility(req, missing),
        notifications,
      });
    } catch (error) {
      console.error('Error fetching missing-photos report:', error);
      res.status(500).json({ message: "Failed to fetch missing-photos report" });
    }
  });

  // One-shot manager-triggered outreach: emails each technician a list of
  // their own billing sheets that are missing photos, with deep links to the
  // sheet view (which exposes the Add Photos affordance).
  // Idempotency: a technician is notified at most once. Subsequent calls skip
  // technicians who already have a recorded notification, unless `force: true`
  // is passed in the body (intended for explicit manager re-send).
  app.post("/api/billing-sheets/missing-photos/notify", requireAuthentication, async (req: any, res) => {
    try {
      const role = req.authenticatedUserRole;
      if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
        res.status(403).json({ message: "Access denied." });
        return;
      }

      const force = req.body?.force === true;
      const channelInput = (req.body?.channel as string | undefined)?.toLowerCase();
      const channelChoice: 'email' | 'sms' | 'both' =
        channelInput === 'sms' || channelInput === 'both' ? channelInput : 'email';
      const channels: Array<'email' | 'sms'> =
        channelChoice === 'both' ? ['email', 'sms'] : [channelChoice];
      const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

      // Tenant scoping: non-super_admin requesters may only notify technicians
      // belonging to their own company. Without this guard, a manager from one
      // company could trigger emails to technicians in another company.
      const requesterCompanyId: number | null = req.authenticatedUserCompanyId ?? null;
      const isSuperAdmin = role === 'super_admin';
      if (!isSuperAdmin && requesterCompanyId == null) {
        res.status(403).json({ message: "Access denied: no company context." });
        return;
      }

      const all = await storage.getAllBillingSheets(isSuperAdmin ? null : requesterCompanyId);
      const candidates = all.filter(s => {
        const created = s.createdAt ? new Date(s.createdAt) : null;
        if (!created || created >= PHOTO_FIX_CUTOFF) return false;
        // Task #197 — billing sheets explicitly flagged as not needing
        // photos must be excluded from technician outreach.
        if (s.noPhotosNeeded) return false;
        const photos = Array.isArray(s.photos) ? s.photos : [];
        return photos.length === 0;
      });

      // Tenant scope BEFORE grouping/processing: out-of-company technicians
      // and their sheets must never enter the result set or be exposed in the
      // response. We resolve company ownership through the assigned technician.
      type MissingSheet = (typeof candidates)[number];
      const techCompanyCache = new Map<number, number | null>();
      const techCompanyId = async (techId: number): Promise<number | null> => {
        if (techCompanyCache.has(techId)) return techCompanyCache.get(techId) ?? null;
        const u = await storage.getUser(techId);
        const cid = u?.companyId ?? null;
        techCompanyCache.set(techId, cid);
        return cid;
      };

      const missing: MissingSheet[] = [];
      for (const s of candidates) {
        if (!s.technicianId) continue;
        if (isSuperAdmin) {
          missing.push(s);
          continue;
        }
        const cid = await techCompanyId(s.technicianId);
        if (cid === requesterCompanyId) missing.push(s);
      }

      // Group by technicianId (already tenant-scoped)
      const byTech = new Map<number, MissingSheet[]>();
      for (const s of missing) {
        if (!s.technicianId) continue;
        const arr = byTech.get(s.technicianId) ?? [];
        arr.push(s);
        byTech.set(s.technicianId, arr);
      }

      const existingRows = await storage.getMissingPhotosNotifications();
      const lastByTech = new Map<number, { email: Date | null; sms: Date | null }>();
      for (const n of existingRows) {
        if (n.technicianId != null) {
          lastByTech.set(n.technicianId, {
            email: n.lastSentEmailAt ? new Date(n.lastSentEmailAt) : null,
            sms: n.lastSentSmsAt ? new Date(n.lastSentSmsAt) : null,
          });
        }
      }

      type ChannelOutcome =
        | { channel: 'email' | 'sms'; status: 'sent'; lastSentAt: string }
        | { channel: 'email' | 'sms'; status: 'skipped_already_notified'; lastSentAt: string }
        | { channel: 'email'; status: 'skipped_no_email' }
        | { channel: 'sms'; status: 'skipped_no_phone' }
        | { channel: 'email' | 'sms'; status: 'failed'; error?: string };

      const results: Array<{
        technicianId: number;
        technicianName: string;
        sheetCount: number;
        skippedNoUser?: boolean;
        channels: ChannelOutcome[];
      }> = [];

      const now = Date.now();

      for (const [techId, sheets] of Array.from(byTech.entries())) {
        const technicianName = sheets[0].technicianName || `User #${techId}`;
        const tech = await storage.getUser(techId);
        if (!tech) {
          results.push({ technicianId: techId, technicianName, sheetCount: sheets.length, skippedNoUser: true, channels: [] });
          continue;
        }

        let companyName: string | undefined;
        if (tech.companyId) {
          try {
            const company = await storage.getCompanyProfile(tech.companyId);
            companyName = company?.name || undefined;
          } catch {}
        }

        const channelOutcomes: ChannelOutcome[] = [];
        const last = lastByTech.get(techId) ?? { email: null, sms: null };

        for (const channel of channels) {
          const lastForChannel = channel === 'email' ? last.email : last.sms;
          if (!force && lastForChannel && now - lastForChannel.getTime() < RECENT_WINDOW_MS) {
            channelOutcomes.push({
              channel,
              status: 'skipped_already_notified',
              lastSentAt: lastForChannel.toISOString(),
            });
            continue;
          }

          if (channel === 'email') {
            if (!tech.email) {
              channelOutcomes.push({ channel: 'email', status: 'skipped_no_email' });
              continue;
            }
            const sendResult = await EmailService.sendMissingPhotosTechnicianEmail({
              to: tech.email,
              technicianName: tech.name || technicianName,
              companyName,
              sheets: sheets.map((s: MissingSheet) => ({
                id: s.id,
                billingNumber: s.billingNumber,
                customerName: s.customerName,
                branchName: s.branchName,
                propertyAddress: s.propertyAddress,
                workDate: s.workDate,
              })),
            });
            if (!sendResult.success) {
              channelOutcomes.push({ channel, status: 'failed', error: sendResult.error });
              continue;
            }
            const saved = await storage.upsertMissingPhotosNotification(
              techId,
              sheets.map((s: MissingSheet) => s.id),
              req.authenticatedUserId ?? null,
              'email',
            );
            channelOutcomes.push({
              channel,
              status: 'sent',
              lastSentAt: new Date(saved.lastSentEmailAt ?? saved.lastSentAt).toISOString(),
            });
          } else {
            if (!tech.phone) {
              channelOutcomes.push({ channel: 'sms', status: 'skipped_no_phone' });
              continue;
            }
            const sendResult = await SmsService.sendMissingPhotosTechnicianSms({
              to: tech.phone,
              technicianName: tech.name || technicianName,
              companyName,
              sheets: sheets.map((s: MissingSheet) => ({ id: s.id, billingNumber: s.billingNumber })),
            });
            if (!sendResult.success) {
              channelOutcomes.push({ channel, status: 'failed', error: sendResult.error });
              continue;
            }
            const saved = await storage.upsertMissingPhotosNotification(
              techId,
              sheets.map((s: MissingSheet) => s.id),
              req.authenticatedUserId ?? null,
              'sms',
              sendResult.messageSid ?? null,
            );
            channelOutcomes.push({
              channel,
              status: 'sent',
              lastSentAt: new Date(saved.lastSentSmsAt ?? saved.lastSentAt).toISOString(),
            });
          }
        }

        results.push({
          technicianId: techId,
          technicianName: tech.name || technicianName,
          sheetCount: sheets.length,
          channels: channelOutcomes,
        });
      }

      const flatOutcomes = results.flatMap(r => r.channels);
      const summary = {
        sent: flatOutcomes.filter(c => c.status === 'sent').length,
        skippedAlreadyNotified: flatOutcomes.filter(c => c.status === 'skipped_already_notified').length,
        skippedNoEmail: flatOutcomes.filter(c => c.status === 'skipped_no_email').length,
        skippedNoPhone: flatOutcomes.filter(c => c.status === 'skipped_no_phone').length,
        skippedNoUser: results.filter(r => r.skippedNoUser).length,
        failed: flatOutcomes.filter(c => c.status === 'failed').length,
      };

      res.json({ summary, results, channel: channelChoice });
    } catch (error) {
      console.error('Error sending missing-photos notifications:', error);
      res.status(500).json({ message: "Failed to send notifications" });
    }
  });

  // Task #197 — flag a billing sheet as not requiring photos so it disappears
  // from the missing-photos report. Restricted to the same four roles that
  // can view the report. Captures the acting user + timestamp on the row.
  // Tenant-scoped: non-super-admin users may only mark sheets whose
  // technician belongs to their own company.
  app.post("/api/billing-sheets/:id/no-photos-needed", requireAuthentication, requireSameCompanyAsBillingSheet, async (req: any, res) => {
    try {
      const role = req.authenticatedUserRole;
      if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
        res.status(403).json({ message: "Access denied." });
        return;
      }

      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ message: "Invalid billing sheet ID" });
        return;
      }

      const callerCompanyId10063 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const existing = await storage.getBillingSheetById(id, callerCompanyId10063);
      if (!existing) {
        res.status(404).json({ message: "Billing sheet not found" });
        return;
      }

      // Tenant scoping: non-super_admin users can only mark sheets whose
      // assigned technician belongs to the same company. Without this guard,
      // a manager from one company could clear another company's sheets.
      const isSuperAdmin = role === 'super_admin';
      if (!isSuperAdmin) {
        const requesterCompanyId: number | null = req.authenticatedUserCompanyId ?? null;
        if (requesterCompanyId == null) {
          res.status(403).json({ message: "Access denied: no company context." });
          return;
        }
        const tech = existing.technicianId ? await storage.getUser(existing.technicianId) : null;
        if (!tech || tech.companyId !== requesterCompanyId) {
          res.status(403).json({ message: "Access denied." });
          return;
        }
      }

      const userId = req.authenticatedUserId;
      if (!userId) {
        res.status(401).json({ message: "Authentication required - user ID not found." });
        return;
      }

      const updated = await storage.markBillingSheetNoPhotosNeeded(id, userId);
      if (!updated) {
        res.status(404).json({ message: "Billing sheet not found" });
        return;
      }
      res.json(updated);
    } catch (error) {
      console.error('Error marking billing sheet as no-photos-needed:', error);
      res.status(500).json({ message: "Failed to mark billing sheet" });
    }
  });

  // Task #765 — Admin correction: reassign the technician on a billing sheet.
  // Guard: company_admin or super_admin only. Accepts { technicianId: number }.
  // Blocks on billed / invoiced sheets (returns 409). Validates the new
  // technician belongs to the same company as the billing sheet's customer.
  // Emits an audit log row with before/after technician info.
  app.patch("/api/billing-sheets/:id/reassign-technician", requireAuthentication, requireSameCompanyAsBillingSheet, async (req: any, res) => {
    try {
      const role = req.authenticatedUserRole;
      if (role !== 'company_admin' && role !== 'super_admin') {
        res.status(403).json({ message: "Only company admins and super admins can reassign the technician on a billing sheet." });
        return;
      }

      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ message: "Invalid billing sheet ID" });
        return;
      }

      const { technicianId: rawTechId } = req.body ?? {};
      const newTechId = rawTechId == null ? NaN : parseInt(String(rawTechId));
      if (isNaN(newTechId) || newTechId <= 0) {
        res.status(400).json({ message: "technicianId is required and must be a positive integer" });
        return;
      }

      const callerCompanyId10130 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const existing = await storage.getBillingSheetById(id, callerCompanyId10130);
      if (!existing) {
        res.status(404).json({ message: "Billing sheet not found" });
        return;
      }

      // Block reassignment on invoiced or billed sheets — would cause accounting issues.
      if (existing.invoiceId || existing.status === 'billed') {
        res.status(409).json({ message: "Cannot reassign the technician on a billing sheet that has already been invoiced or billed." });
        return;
      }

      // Determine which company this billing sheet belongs to via its customer.
      const isSuperAdmin = role === 'super_admin';
      let sheetCompanyId: number | null = null;
      if (existing.customerId) {
        const customer = await storage.getCustomer(existing.customerId);
        sheetCompanyId = customer?.companyId ?? null;
      }

      // Tenant guard: company_admin may only touch sheets that belong to their company.
      if (!isSuperAdmin) {
        const requesterCompanyId: number | null = req.authenticatedUserCompanyId ?? null;
        if (requesterCompanyId == null) {
          res.status(403).json({ message: "Access denied: no company context." });
          return;
        }
        if (sheetCompanyId !== requesterCompanyId) {
          res.status(403).json({ message: "Access denied." });
          return;
        }
      }

      // Validate the new technician: must exist and belong to the same company.
      const newTech = await storage.getUser(newTechId);
      if (!newTech) {
        res.status(400).json({ message: "Technician not found" });
        return;
      }
      if (sheetCompanyId != null && newTech.companyId !== sheetCompanyId) {
        res.status(400).json({ message: "The selected technician does not belong to the same company as this billing sheet." });
        return;
      }

      const prevTechName = existing.technicianName;
      const prevTechId = existing.technicianId;

      // If the technician is already the same, short-circuit gracefully.
      if (prevTechId === newTechId) {
        res.json(existing);
        return;
      }

      const updated = await storage.updateBillingSheet(id, {
        technicianId: newTechId,
        technicianName: newTech.name,
      } as any);

      if (!updated) {
        res.status(500).json({ message: "Failed to update billing sheet" });
        return;
      }

      // Capture who triggered the reassignment for the audit note.
      const actorId = req.authenticatedUserId ?? 0;
      let actorName = `user ${actorId}`;
      try {
        if (!isNaN(actorId)) {
          const actor = await storage.getUser(actorId);
          if (actor) actorName = actor.name;
        }
      } catch { /* best-effort */ }

      await recordAuditEvent(req, {
        actionType: "data",
        action: "billing_sheet.technician_reassigned",
        severity: "info",
        targetType: "billing_sheet",
        targetId: String(id),
        actorUserId: isNaN(actorId) ? null : actorId,
        actorLabel: actorName,
        actorRole: role,
        actorCompanyId: sheetCompanyId,
        summary: `Technician reassigned from ${prevTechName ?? "unknown"} to ${newTech.name} by ${actorName}`,
        details: {
          billingNumber: existing.billingNumber,
          previousTechnicianId: prevTechId ?? null,
          previousTechnicianName: prevTechName ?? null,
          newTechnicianId: newTechId,
          newTechnicianName: newTech.name,
        },
      });

      res.json(updated);
    } catch (error) {
      logger.error({ err: error }, "Error reassigning technician on billing sheet");
      res.status(500).json({ message: "Failed to reassign technician" });
    }
  });

  // Twilio status callback webhook for SMS delivery tracking.
  // Twilio POSTs application/x-www-form-urlencoded with fields including
  // MessageSid, MessageStatus (queued|sent|delivered|failed|undelivered),
  // ErrorCode (when failed/undelivered). We update the missing-photos
  // notification row whose lastSmsMessageSid matches so managers can see
  // real delivery outcomes instead of just "sent".
  //
  // The endpoint must be unauthenticated (Twilio cannot present a session
  // cookie), so we authenticate the request via Twilio's request signature.
  app.post("/api/twilio/sms-status", async (req: any, res) => {
    try {
      const params = (req.body ?? {}) as Record<string, string>;
      const messageSid = params.MessageSid;
      const status = params.MessageStatus || params.SmsStatus;
      const errorCode = params.ErrorCode || null;

      if (!messageSid || !status) {
        res.status(400).send('Missing MessageSid or MessageStatus');
        return;
      }

      // Signature validation:
      //  - Production: ALWAYS validate. If TWILIO_AUTH_TOKEN is missing the
      //    webhook refuses every request (secure-by-default).
      //  - Dev/test: validate when a token is configured; otherwise accept
      //    so the endpoint can be exercised without external Twilio creds.
      const token = SmsService.authToken;
      const isProd = process.env.NODE_ENV === 'production';
      if (isProd && !token) {
        console.warn('Twilio status callback rejected: no TWILIO_AUTH_TOKEN configured in production');
        res.status(403).send('Webhook not configured');
        return;
      }
      if (token) {
        const signature = req.header('X-Twilio-Signature') || '';
        // Reconstruct the full URL Twilio used to sign the request. Twilio
        // signs against the public URL, so prefer the configured baseUrl
        // over req.protocol/host (which may be the internal Replit address).
        const url = `${SmsService.baseUrl}/api/twilio/sms-status`;
        const valid = twilio.validateRequest(token, signature, url, params);
        if (!valid) {
          console.warn('Twilio status callback: invalid signature', { messageSid, url });
          res.status(403).send('Invalid signature');
          return;
        }
      }

      const updated = await storage.updateMissingPhotosSmsStatus(messageSid, status, errorCode);
      if (!updated) {
        // Not all SMS messages are tracked here (e.g. future SMS senders).
        // Acknowledge so Twilio doesn't retry, but log for visibility.
        console.log(`Twilio status callback: no matching SMS row for sid=${messageSid} status=${status}`);
      }
      // Twilio expects a 2xx with empty body (or TwiML). Empty 204 works.
      res.status(204).end();
      return;
    } catch (error) {
      console.error('Twilio status callback error:', error);
      // Return 200 anyway so Twilio doesn't retry indefinitely on our bug.
      res.status(200).send('OK');
      return;
    }
  });

  app.get("/api/billing-sheets/:id", requireAuthentication, requireSameCompanyAsBillingSheet, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const callerCompanyId10307 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const billingSheet = await storage.getBillingSheetById(id, callerCompanyId10307);
      if (!billingSheet) {
        res.status(404).json({ message: "Billing sheet not found" });
        return;
      }
      // Embed customer rates for inline edit (Task #1093).
      let customerRates: { laborRate: string | null; emergencyLaborRate: string | null } | null = null;
      if (billingSheet.customerId) {
        const cust = await storage.getCustomer(billingSheet.customerId);
        if (cust) customerRates = { laborRate: cust.laborRate, emergencyLaborRate: cust.emergencyLaborRate };
      }
      // Strip pricing fields for field technicians
      res.json(applyPricingVisibility(req, { ...billingSheet, customer: customerRates }));
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch billing sheet" });
    }
  });

  // Task #1093 — rate-mode toggle for billing sheets.
  app.patch("/api/billing-sheets/:id/rate-mode", requireAuthentication, requireSameCompanyAsBillingSheet, async (req: any, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = rateModeBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid id" }); return; }
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const result = await storage.recomputeBillingSheetTotalsForRateMode(id, parsed.data.mode, companyId);
      void recordAuditEvent(req, {
        actionType: "data", action: "billing_sheet.rate_mode_changed",
        targetType: "billing_sheet", targetId: String(id),
        summary: `Rate mode set to ${parsed.data.mode}`,
      });
      res.json(result);
    } catch (e: any) {
      if (e?.code === "BS_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "BS_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      if (e?.code === "NO_CUSTOMER") { res.status(422).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "recomputeBillingSheetTotalsForRateMode",
        ctx: { id, mode: parsed.data.mode },
        fallbackStatus: 500, fallbackMessage: "Couldn't update rate mode",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1315 — flat labor hours editor for billing sheets and work orders.
  const laborHoursBody = z.object({ totalHours: z.number().min(0) });

  app.patch("/api/billing-sheets/:id/labor-hours", requireAuthentication, requireSameCompanyAsBillingSheet, async (req: any, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = laborHoursBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid id" }); return; }
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const result = await storage.updateBillingSheetLaborHours(id, parsed.data.totalHours, companyId);
      void recordAuditEvent(req, {
        actionType: "data", action: "billing_sheet.labor_hours_updated",
        targetType: "billing_sheet", targetId: String(id),
        summary: `Total labor hours set to ${parsed.data.totalHours}`,
      });
      res.json(result);
    } catch (e: any) {
      if (e?.code === "BS_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "BS_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "updateBillingSheetLaborHours",
        ctx: { id, totalHours: parsed.data.totalHours },
        fallbackStatus: 500, fallbackMessage: "Couldn't update labor hours",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1093 — item replacement for billing sheets.
  const itemsBody = z.object({
    items: z.array(z.object({
      partId: z.number().int().positive().optional().nullable(),
      partName: z.string().min(1),
      quantity: z.number().min(0),
      unitPrice: z.coerce.number().min(0),
      laborHours: z.coerce.number().min(0).optional().default(0),
      notes: z.string().optional().nullable(),
    })),
  });
  app.patch("/api/billing-sheets/:id/items", requireAuthentication, requireSameCompanyAsBillingSheet, async (req: any, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = itemsBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid id" }); return; }
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const insertItems = parsed.data.items.map((i) => ({
        billingSheetId: id,
        partId: i.partId ?? null,
        partName: i.partName,
        quantity: String(i.quantity),
        unitPrice: String(i.unitPrice),
        laborHours: String(i.laborHours ?? 0),
        notes: i.notes ?? null,
        totalPrice: (money(i.quantity) * money(i.unitPrice)).toFixed(2),
      }));
      const result = await storage.replaceBillingSheetItemsWithResync(id, insertItems, companyId);
      void recordAuditEvent(req, {
        actionType: "data", action: "billing_sheet.items_replaced",
        targetType: "billing_sheet", targetId: String(id),
        summary: `Inline item edit: ${insertItems.length} item(s)`,
      });
      res.json(result);
    } catch (e: any) {
      if (e?.code === "BS_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "BS_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "replaceBillingSheetItemsWithResync",
        ctx: { id }, fallbackStatus: 500, fallbackMessage: "Couldn't save items",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1093 — billing sheet activity log (mirrors work-orders/:id/activity).
  app.get("/api/billing-sheets/:id/activity", requireAuthentication, requireSameCompanyAsBillingSheet, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid id" }); return; }
      const isSuper = req.authenticatedUserRole === "super_admin";
      const callerCid: number | null = isSuper ? null : (req.authenticatedUserCompanyId ?? null);
      const bs = await storage.getBillingSheetById(id, callerCid);
      if (!bs) { res.status(404).json({ message: "Billing sheet not found" }); return; }
      const rows = await db.execute<{
        id: number; occurredAt: string; actorUserId: number | null; actorLabel: string | null;
        actorRole: string | null; action: string; summary: string | null; details: unknown;
      }>(sql`
        SELECT id, occurred_at AS "occurredAt", actor_user_id AS "actorUserId",
               actor_label AS "actorLabel", actor_role AS "actorRole",
               action, summary, details
        FROM audit_log
        WHERE target_type = 'billing_sheet' AND target_id = ${String(id)}
        ORDER BY occurred_at DESC LIMIT 200
      `);
      res.json({ events: rows.rows ?? [] });
    } catch (error) {
      console.error("[activity] billing_sheet", error);
      res.status(500).json({ message: "Failed to load activity" });
    }
  });

  app.post("/api/billing-sheets", requireAuthentication, async (req, res) => {
    try {
      console.log('Received billing sheet data:', req.body);
      const billingSheetData = req.body;

      // Stamp the caller's companyId onto the new row for any non-super-admin.
      // Silently ignored until Slice 4 adds the billing_sheets.companyId column.
      if (req.authenticatedUserRole !== 'super_admin') {
        billingSheetData.companyId = req.authenticatedUserCompanyId;
      }

      // Branch enforcement: if the customer has branches configured, branchName is required
      if (billingSheetData.customerId) {
        const customer = await storage.getCustomer(Number(billingSheetData.customerId));
        if (customer && Array.isArray(customer.branches) && customer.branches.length > 0) {
          if (!billingSheetData.branchName || String(billingSheetData.branchName).trim() === '') {
            res.status(400).json({ message: "Branch is required for this customer. Please select a branch before submitting." });
            return;
          }
        }
      }
      
      // Determine the correct status based on creator's role.
      // Manager-class roles (irrigation_manager, billing_manager, company_admin,
      // super_admin) self-approve at creation time and route directly to
      // 'approved_passed_to_billing' so the sheet immediately surfaces in the
      // customer's Ready-to-Invoice list (Task #206 fixed the previous
      // dead-end 'approved' status; Task #207 removed it from the schema).
      // field_tech => 'submitted' (goes to manager for review).
      const creatorRole = req.authenticatedUserRole || headerUserRole(req);
      let resolvedStatus: BillingSheetStatus;
      if (
        creatorRole === 'irrigation_manager' ||
        creatorRole === 'billing_manager' ||
        creatorRole === 'company_admin' ||
        creatorRole === 'super_admin'
      ) {
        resolvedStatus = 'approved_passed_to_billing';
      } else if (creatorRole === 'field_tech') {
        resolvedStatus = 'submitted';
      } else {
        // Task #207 — runtime-validate the fallback so the legacy 'approved'
        // (or any other unknown value) cannot sneak in via an unexpected role.
        const parsed = z.enum(billingSheetStatusValues).safeParse(billingSheetData.status);
        resolvedStatus = parsed.success ? parsed.data : 'draft';
      }

      // Always look up the customer's authoritative labor rate — ignore any client-supplied value.
      // Fail fast if the customer does not exist or has no labor rate configured.
      if (!billingSheetData.customerId) {
        res.status(400).json({ message: "Customer ID is required to determine the correct labor rate." });
        return;
      }
      const customerForRate = await storage.getCustomer(Number(billingSheetData.customerId));
      if (!customerForRate) {
        res.status(400).json({ message: "Customer not found. Cannot determine labor rate." });
        return;
      }
      if (!customerForRate.laborRate || parseFloat(customerForRate.laborRate) <= 0) {
        res.status(400).json({ message: `Customer "${customerForRate.name}" does not have a labor rate configured. Please set a labor rate on the customer record before creating a billing sheet.` });
        return;
      }
      const bsAuthorizedLaborRate = parseFloat(customerForRate.laborRate);

      // Task #396 — Labor mode normalization. 'flat' uses sheet.totalHours
      // exclusively; 'per_part' sums per-line laborHours and rewrites the
      // sheet's totalHours so the snapshot stays consistent.
      const bsLaborMode: 'flat' | 'per_part' =
        billingSheetData.laborMode === 'per_part' ? 'per_part' : 'flat';
      const rawClientItemsForLabor: Array<{ laborHours?: string | number; quantity?: string | number }> =
        Array.isArray(billingSheetData.items) ? billingSheetData.items : [];
      // Task #396 — canonical per_part labor formula is
      // Σ(item.laborHours × item.quantity). Per-row laborHours are
      // per-unit, so they must be scaled by quantity.
      const perPartHoursSum = rawClientItemsForLabor.reduce(
        (sum, it) =>
          sum +
          (parseFloat(String(it.laborHours ?? 0)) || 0) *
            (parseFloat(String(it.quantity ?? 0)) || 0),
        0
      );
      const bsTotalHours = bsLaborMode === 'flat'
        ? (parseFloat(billingSheetData.totalHours || '0') || 0)
        : perPartHoursSum;
      const bsLaborSubtotal = bsTotalHours * bsAuthorizedLaborRate;
      // Persist totalHours back so it is the authoritative aggregate in either mode.
      billingSheetData.totalHours = bsTotalHours.toFixed(2);
      billingSheetData.laborMode = bsLaborMode;

      // Server-side authoritative pricing (Task #160): for every catalog line item
      // (those with a `partId`), overwrite the client-supplied `unitPrice` with the
      // current catalog price. Manual line items (no `partId`) are left alone — they
      // continue through the manual-part review flow.
      const rawClientItems: RawBillingItem[] = Array.isArray(billingSheetData.items)
        ? billingSheetData.items
        : [];
      const postCompanyId = req.authenticatedUserCompanyId
        ?? (headerUserCompanyId(req)
          ? parseInt(headerUserCompanyId(req) as string)
          : (customerForRate.companyId ?? null));
      const pricingResult = await resolveAuthoritativePartPricing(rawClientItems, postCompanyId);
      if (pricingResult.error) {
        res.status(pricingResult.error.status).json({ message: pricingResult.error.message });
        return;
      }
      const resolvedClientItems = (pricingResult.items as RawBillingItem[]) ?? [];
      if (pricingResult.auditedZeros.length > 0) {
        for (const drift of pricingResult.auditedZeros) {
          console.log(
            `[AUDIT] billing_sheet_create_price_corrected partId=${drift.partId} ` +
            `partName="${drift.partName}" clientUnitPrice=${drift.clientUnitPrice.toFixed(2)} ` +
            `catalogUnitPrice=${drift.catalogUnitPrice.toFixed(2)}`
          );
        }
      }
      // Always derive partsSubtotal from the items the server will write — discard any client-supplied value
      const bsPartsSubtotal = resolvedClientItems.reduce(
        (sum, item) => sum + parseFloat(String(item.quantity || 0)) * parseFloat(String(item.unitPrice || 0)),
        0
      );
      const bsTotalAmount = bsLaborSubtotal + bsPartsSubtotal;

      // Clean the data - remove any fields that might interfere with timestamps
      // Ensure every item we hand to storage matches the createBillingSheet
      // shape (string-typed numerics, totalPrice always present) using the
      // (possibly server-corrected) quantity * unitPrice.
      type BillingSheetItemInput = {
        partName: string;
        quantity: string;
        unitPrice: string;
        totalPrice: string;
        laborHours: string;
        notes?: string | null;
        billingSheetId?: number | null;
        partId?: number | null;
        partDescription?: string | null;
      };
      const itemsForStorage: BillingSheetItemInput[] = resolvedClientItems.map((it) => {
        const qty = parseFloat(String(it.quantity ?? 0));
        const unit = parseFloat(String(it.unitPrice ?? 0));
        const computedTotal = (qty * unit).toFixed(2);
        const rawTotal = (it as { totalPrice?: number | string }).totalPrice;
        // Task #396 — In flat mode, per-line labor hours are zeroed out so
        // they cannot accidentally be re-summed downstream.
        const lineLaborHours = bsLaborMode === 'flat'
          ? '0.00'
          : String(it.laborHours ?? '0');
        return {
          partId: it.partId ?? null,
          partName: String(it.partName ?? ''),
          partDescription: it.partDescription ?? null,
          quantity: String(it.quantity ?? '0'),
          unitPrice: String(it.unitPrice ?? '0'),
          totalPrice: rawTotal != null ? String(rawTotal) : computedTotal,
          laborHours: lineLaborHours,
          notes: it.notes ?? null,
        };
      });

      const cleanData = {
        customerId: billingSheetData.customerId,
        companyId: (req.authenticatedUserCompanyId as number | null | undefined)
          ?? (billingSheetData.customerId ? (await storage.getCustomer(billingSheetData.customerId))?.companyId ?? 0 : 0),
        customerName: billingSheetData.customerName,
        customerEmail: billingSheetData.customerEmail,
        propertyAddress: billingSheetData.propertyAddress || '',
        workLocationLat:
          billingSheetData.workLocationLat != null
            ? String(billingSheetData.workLocationLat)
            : null,
        workLocationLng:
          billingSheetData.workLocationLng != null
            ? String(billingSheetData.workLocationLng)
            : null,
        workLocationAddress: billingSheetData.workLocationAddress ?? null,
        controllerLetter: billingSheetData.controllerLetter ?? null,
        zoneNumber:
          billingSheetData.zoneNumber != null && billingSheetData.zoneNumber !== ''
            ? Number(billingSheetData.zoneNumber)
            : null,
        workDate: billingSheetData.workDate, // Let storage handle the conversion
        technicianName: billingSheetData.technicianName,
        technicianId: billingSheetData.technicianId || null,
        workDescription: billingSheetData.workDescription,
        status: resolvedStatus,
        laborMode: bsLaborMode,
        totalHours: billingSheetData.totalHours || '0',
        laborRate: bsAuthorizedLaborRate.toFixed(2),
        laborSubtotal: bsLaborSubtotal.toFixed(2),
        partsSubtotal: bsPartsSubtotal.toFixed(2),
        totalAmount: bsTotalAmount.toFixed(2),
        photos: billingSheetData.photos || [],
        notes: billingSheetData.notes || '',
        branchName: billingSheetData.branchName || null,
        items: itemsForStorage.length > 0 ? itemsForStorage : undefined,
      };
      
      const billingSheet = await storage.createBillingSheet({
        ...cleanData,
      });

      // Task #206 — when a manager-class user creates a billing sheet, it's
      // self-approved at creation time (status='approved_passed_to_billing').
      // Stamp the same approval audit fields the manual /approve endpoint uses
      // so the record is fully traceable in Ready-to-Invoice listings.
      if (resolvedStatus === 'approved_passed_to_billing') {
        const approverUser = req.authenticatedUserId
          ? await storage.getUser(req.authenticatedUserId)
          : undefined;
        const approverName = approverUser?.name || 'Manager';
        const partsSnapshot = JSON.stringify({ partsSubtotal: billingSheet.partsSubtotal });
        const laborSnapshot = JSON.stringify({
          totalHours: billingSheet.totalHours,
          laborRate: billingSheet.laborRate,
          laborSubtotal: billingSheet.laborSubtotal,
        });
        const approvalPatch: Partial<InsertBillingSheet> = {
          approvedBy: approverName,
          approvedByUserId: req.authenticatedUserId || undefined,
          approvedAt: new Date(),
          approvedTotal: billingSheet.totalAmount,
          approvedPartsSnapshot: partsSnapshot,
          approvedLaborSnapshot: laborSnapshot,
        };
        await storage.updateBillingSheet(billingSheet.id, approvalPatch);
      }

      const createdItemCount = Array.isArray(cleanData.items) ? cleanData.items.length : 0;
      console.log(`[AUDIT] billing_sheet_created billingSheetId=${billingSheet.id} billingNumber=${billingSheet.billingNumber} itemCount=${createdItemCount} status=${resolvedStatus}`);

      // Regression guard: surface any catalog line item that ended up at $0 despite the
      // authoritative-pricing helper above. Should never trigger; logged loudly if it does.
      await regressionGuardZeroCatalogPrices('create', billingSheet.id, cleanData.items);

      // Notify irrigation managers and admins that a billing sheet was submitted
      try {
        const allUsers = await storage.getUsers();
        const notifyUsers = allUsers.filter(u =>
          u.role === "company_admin" || u.role === "irrigation_manager"
        );
        for (const user of notifyUsers) {
          await storage.createNotification({
            userId: user.id,
            type: "billing_sheet_submitted",
            title: "Billing Sheet Submitted",
            message: `Billing sheet ${billingSheet.billingNumber} for ${cleanData.customerName || 'a customer'} has been submitted${cleanData.technicianName ? ` by ${cleanData.technicianName}` : ''}.`,
            relatedEntityType: "billing_sheet",
            relatedEntityId: billingSheet.id,
            isRead: false,
          });
        }
      } catch (notifError) {
        console.error('Failed to send billing sheet notifications:', notifError);
      }

      // If the billing sheet was submitted (by a field tech), check for manual parts (no partId)
      // and create manualPartReview records + notify billing managers
      if (resolvedStatus === 'submitted' && Array.isArray(cleanData.items)) {
        try {
          const companyId = req.authenticatedUserCompanyId;
          // Collect only items without a catalog partId (manually typed by tech)
          const manualItemIndices: number[] = [];
          (cleanData.items as Array<{ partId?: number | null }>).forEach((item, idx) => {
            if (!item.partId) manualItemIndices.push(idx);
          });
          if (manualItemIndices.length > 0 && companyId) {
            // Fetch the saved items to get their IDs; match by insertion order (same order as cleanData.items)
            const savedSheet = await storage.getBillingSheetById(billingSheet.id, companyId ?? null);
            const savedItems: BillingSheetItem[] = savedSheet?.items || [];
            // Build an index of saved manual items (no partId) in order
            const savedManualItems = savedItems.filter(si => !si.partId);

            for (let i = 0; i < manualItemIndices.length; i++) {
              const manualItem = cleanData.items[manualItemIndices[i]] as { partName?: string; unitPrice?: string | number };
              const savedItem = savedManualItems[i]; // Positional match — same order as submitted
              await storage.createManualPartReview({
                billingSheetId: billingSheet.id,
                billingSheetItemId: savedItem?.id ?? null,
                companyId,
                partName: manualItem.partName || 'Unknown Part',
                proposedPrice: String(manualItem.unitPrice || '0'),
                approvalStatus: 'pending',
              });

              // Notify billing managers only (company-scoped)
              const allUsers = await storage.getUsers(companyId);
              const billingManagers = allUsers.filter(u => u.role === 'billing_manager');
              for (const bm of billingManagers) {
                await storage.createNotification({
                  userId: bm.id,
                  type: "manual_part_pending_review",
                  title: "Manual Part Needs Pricing Review",
                  message: `A manually entered part "${manualItem.partName}" on billing sheet ${billingSheet.billingNumber} needs your price review.`,
                  relatedEntityType: "billing_sheet",
                  relatedEntityId: billingSheet.id,
                  isRead: false,
                });
              }
            }
          }
        } catch (manualPartError) {
          console.error('Failed to create manual part reviews:', manualPartError);
        }
      }

      res.json(billingSheet);
    } catch (error) {
      console.error('Error creating billing sheet:', error);
      res.status(500).json({ message: "Failed to create billing sheet" });
    }
  });

  // computeBillingSheetTotal is imported from ../billing-sheet-total.ts —
  // a shared utility used by the PATCH handler, /labor-hours, and /rate-mode
  // paths to enforce the totalAmount === partsSubtotal + laborSubtotal invariant
  // with stored-record fallback for any subtotal absent from the mutation.

  app.patch("/api/billing-sheets/:id", requireAuthentication, requireSameCompanyAsBillingSheet, requireBillingSheetUpdateAccess, async (req, res) => {
    try {
      const id = parseInt(req.params.id);

      // Task #191: photos-only patches (single key 'photos' with an array value)
      // bypass the billed and approved-passed-to-billing locks below so that
      // techs (and admins) can backfill photos onto already-billed sheets.
      // Every other field on a billed/approved sheet stays locked.
      const bsPatchKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
      const isBsPhotosOnlyPatch =
        bsPatchKeys.length === 1 && bsPatchKeys[0] === 'photos' && Array.isArray(req.body.photos);

      // Billing lock: reject updates to billing sheets that have been invoiced or approved for billing
      const callerCompanyId10641 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const existingBsForLockCheck = await storage.getBillingSheetById(id, callerCompanyId10641);
      if (!isBsPhotosOnlyPatch && existingBsForLockCheck && (existingBsForLockCheck.invoiceId || existingBsForLockCheck.status === 'billed')) {
        res.status(409).json({ message: "This record has been billed and cannot be edited." });
        return;
      }
      // Lock after manager approval — only admins and billing managers can proceed
      const patchUserRole = req.authenticatedUserRole || headerUserRole(req);
      if (!isBsPhotosOnlyPatch && existingBsForLockCheck?.status === 'approved_passed_to_billing' &&
          patchUserRole !== 'company_admin' && patchUserRole !== 'super_admin' && patchUserRole !== 'billing_manager') {
        res.status(409).json({ message: "This record has been approved and passed to billing — it cannot be edited." });
        return;
      }

      const { items, companyId, ...billingSheetData } = req.body;
      // Task #764 — technician is locked to the person who created the sheet.
      // Strip these fields unconditionally so no client payload can overwrite them.
      delete billingSheetData.technicianId;
      delete billingSheetData.technicianName;
      // Normalize the optional pin / controller fields so they round-trip
      // through the decimal/integer columns regardless of whether the client
      // sent numbers, strings, or omitted them entirely.
      if (billingSheetData.workLocationLat !== undefined) {
        billingSheetData.workLocationLat =
          billingSheetData.workLocationLat == null || billingSheetData.workLocationLat === ''
            ? null
            : String(billingSheetData.workLocationLat);
      }
      if (billingSheetData.workLocationLng !== undefined) {
        billingSheetData.workLocationLng =
          billingSheetData.workLocationLng == null || billingSheetData.workLocationLng === ''
            ? null
            : String(billingSheetData.workLocationLng);
      }
      if (billingSheetData.workLocationAddress !== undefined) {
        billingSheetData.workLocationAddress = billingSheetData.workLocationAddress ?? null;
      }
      if (billingSheetData.controllerLetter !== undefined) {
        billingSheetData.controllerLetter = billingSheetData.controllerLetter || null;
      }
      if (billingSheetData.zoneNumber !== undefined) {
        billingSheetData.zoneNumber =
          billingSheetData.zoneNumber == null || billingSheetData.zoneNumber === ''
            ? null
            : Number(billingSheetData.zoneNumber);
      }

      // Task #207: enforce billing-sheet status enum on PATCH so the legacy
      // 'approved' value (and any other unknown status) cannot be persisted
      // by the API. The DB column is plain text with no check constraint, so
      // this is the authoritative validation point.
      if (billingSheetData.status !== undefined) {
        const patchStatusParse = z.enum(billingSheetStatusValues).safeParse(billingSheetData.status);
        if (!patchStatusParse.success) {
          res.status(400).json({
            message: `Invalid billing sheet status '${billingSheetData.status}'. Allowed values: ${billingSheetStatusValues.join(', ')}.`,
          });
          return;
        }
        billingSheetData.status = patchStatusParse.data;
      }

      console.log('Updating billing sheet:', id, 'with data:', billingSheetData);
      
      // Convert date string to Date object if present
      if (billingSheetData.workDate && typeof billingSheetData.workDate === 'string') {
        billingSheetData.workDate = new Date(billingSheetData.workDate + 'T00:00:00.000Z');
      }

      // Task #396 — Labor mode normalization on PATCH. If laborMode changes
      // (or is supplied alongside hours/items), recompute totalHours and
      // laborSubtotal authoritatively so a mode flip can never be silently
      // out of sync with the persisted snapshot. Audit any switch.
      if (
        billingSheetData.laborMode !== undefined ||
        billingSheetData.totalHours !== undefined ||
        (Array.isArray(items) && items.length >= 0)
      ) {
        const priorLaborMode = existingBsForLockCheck?.laborMode ?? 'per_part';
        const newLaborMode: 'flat' | 'per_part' =
          billingSheetData.laborMode === 'per_part' || billingSheetData.laborMode === 'flat'
            ? billingSheetData.laborMode
            : (priorLaborMode === 'per_part' ? 'per_part' : 'flat');
        const itemsForLabor: Array<{ laborHours?: string | number; quantity?: string | number }> =
          Array.isArray(items) ? items : [];
        // Task #396 — see POST: per_part labor must scale by quantity.
        const perPartSum = itemsForLabor.reduce(
          (sum, it) =>
            sum +
            (parseFloat(String(it.laborHours ?? 0)) || 0) *
              (parseFloat(String(it.quantity ?? 0)) || 0),
          0
        );
        let nextTotalHours: number;
        if (newLaborMode === 'flat') {
          nextTotalHours = parseFloat(
            String(billingSheetData.totalHours ?? existingBsForLockCheck?.totalHours ?? '0')
          ) || 0;
        } else {
          // per_part: prefer summing supplied items; fall back to existing total.
          nextTotalHours = Array.isArray(items)
            ? perPartSum
            : (parseFloat(String(existingBsForLockCheck?.totalHours ?? '0')) || 0);
        }
        const patchRate = parseFloat(
          String(billingSheetData.laborRate ?? existingBsForLockCheck?.laborRate ?? '0')
        ) || 0;
        billingSheetData.laborMode = newLaborMode;
        billingSheetData.totalHours = nextTotalHours.toFixed(2);
        billingSheetData.laborSubtotal = (nextTotalHours * patchRate).toFixed(2);
        if (priorLaborMode !== newLaborMode) {
          console.log(
            `[AUDIT] billing_sheet_labor_mode_changed billingSheetId=${id} ` +
            `from=${priorLaborMode} to=${newLaborMode} totalHours=${nextTotalHours.toFixed(2)}`
          );
        }
      }

      // Task #1669 — Recalculate totalAmount whenever subtotals are provided.
      // Fall back to the stored record for any subtotal absent from the patch
      // body so a totalHours-only PATCH never zeroes stored parts, and a
      // partsSubtotal-only PATCH never zeroes stored labor.
      if (billingSheetData.laborSubtotal !== undefined || billingSheetData.partsSubtotal !== undefined) {
        billingSheetData.totalAmount = computeBillingSheetTotal(billingSheetData, existingBsForLockCheck);
      }
      
      // Update the billing sheet
      const billingSheet = await storage.updateBillingSheet(id, billingSheetData);
      if (!billingSheet) {
        res.status(404).json({ message: "Billing sheet not found" });
        return;
      }

      // Task #224 — when photos change on a billing sheet that's already linked
      // to an invoice, invalidate the cached invoice_pdfs row so the next view,
      // download, or send regenerates a fresh PDF that includes the new photos.
      if (
        billingSheetData.photos !== undefined &&
        existingBsForLockCheck?.invoiceId
      ) {
        const cachedInvoicePdf = await storage.getInvoicePdfByInvoiceId(existingBsForLockCheck.invoiceId);
        if (cachedInvoicePdf) {
          await db.delete(invoicePdfs).where(eq(invoicePdfs.id, cachedInvoicePdf.id));
          console.log(
            `[AUDIT] invoice_pdf_invalidated reason=billing_sheet_photos_patch ` +
            `billingSheetId=${id} invoiceId=${existingBsForLockCheck.invoiceId} cachedPdfId=${cachedInvoicePdf.id}`
          );
        }
      }

      // Task #195: photo-after-billing audit. If this was a photos-only PATCH
      // applied to a sheet that had already reached billing (status `billed`
      // or `approved_passed_to_billing`, or has an `invoiceId`), record who
      // added the late photo, when, and the prior + new photos arrays.
      if (isBsPhotosOnlyPatch && existingBsForLockCheck) {
        const wasAfterBilling =
          existingBsForLockCheck.status === 'billed' ||
          existingBsForLockCheck.status === 'approved_passed_to_billing' ||
          existingBsForLockCheck.invoiceId != null;
        if (wasAfterBilling) {
          const priorPhotos: string[] = Array.isArray(existingBsForLockCheck.photos)
            ? (existingBsForLockCheck.photos as string[])
            : [];
          const newPhotos: string[] = Array.isArray(req.body.photos) ? req.body.photos : [];
          const priorSet = new Set(priorPhotos);
          const newSet = new Set(newPhotos);
          const addedPhotos = newPhotos.filter((p) => !priorSet.has(p));
          const removedPhotos = priorPhotos.filter((p) => !newSet.has(p));
          // Only record when there was an actual addition — pure removals or
          // no-op writes are not "late additions".
          if (addedPhotos.length > 0) {
            const actor = await resolvePhotoAuditActor(req);
            try {
              await storage.recordPhotoLateAddition({
                ticketType: 'billing_sheet',
                ticketId: id,
                ticketNumber: existingBsForLockCheck.billingNumber ?? null,
                ticketStatusAtAddition: existingBsForLockCheck.status ?? null,
                invoiceIdAtAddition: existingBsForLockCheck.invoiceId ?? null,
                companyId: actor.companyId ?? null,
                actorUserId: actor.userId ?? null,
                actorName: actor.name ?? null,
                actorRole: actor.role ?? null,
                priorPhotos,
                newPhotos,
                addedPhotos,
                removedPhotos,
              });
            } catch (auditErr) {
              console.error('[AUDIT] photo_added_after_billing record failed for billing sheet', id, auditErr);
            }
            console.log(
              `[AUDIT] photo_added_after_billing ticketType=billing_sheet ticketId=${id} ` +
              `ticketNumber=${existingBsForLockCheck.billingNumber ?? '?'} ` +
              `status=${existingBsForLockCheck.status ?? '?'} ` +
              `invoiceId=${existingBsForLockCheck.invoiceId ?? 'null'} ` +
              `actor=${actor.userId ?? '?'} role=${actor.role ?? '?'} ` +
              `priorCount=${priorPhotos.length} newCount=${newPhotos.length} ` +
              `added=${addedPhotos.length} removed=${removedPhotos.length}`
            );
          }
        }
      }

      // Handle items if provided — atomically replace items AND resync partsSubtotal/totalAmount in one transaction
      if (items && Array.isArray(items)) {
        const bsPatchCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
        const countBefore = (await storage.getBillingSheetById(id, bsPatchCompanyId))?.items?.length ?? 0;

        // Server-side authoritative pricing (Task #160): rewrite catalog line items
        // with the catalog price before persisting. Manual line items pass through.
        const patchCompanyIdForPricing = req.authenticatedUserCompanyId
          ?? (headerUserCompanyId(req)
            ? parseInt(headerUserCompanyId(req) as string)
            : null);
        const patchPricingResult = await resolveAuthoritativePartPricing(items as RawBillingItem[], patchCompanyIdForPricing);
        if (patchPricingResult.error) {
          res.status(patchPricingResult.error.status).json({ message: patchPricingResult.error.message });
          return;
        }
        const resolvedPatchItems = (patchPricingResult.items as RawBillingItem[]) ?? [];
        if (patchPricingResult.auditedZeros.length > 0) {
          for (const drift of patchPricingResult.auditedZeros) {
            console.log(
              `[AUDIT] billing_sheet_update_price_corrected billingSheetId=${id} partId=${drift.partId} ` +
              `partName="${drift.partName}" clientUnitPrice=${drift.clientUnitPrice.toFixed(2)} ` +
              `catalogUnitPrice=${drift.catalogUnitPrice.toFixed(2)}`
            );
          }
        }

        // Task #396 — Honor the (now-normalized) laborMode when persisting
        // line items: flat-mode lines always store 0 labor hours.
        const persistedLaborMode = billingSheetData.laborMode === 'per_part' ? 'per_part' : 'flat';
        const itemsToInsert = resolvedPatchItems.map((item: any) => ({
          billingSheetId: id,
          partId: item.partId || null,
          partName: item.partName,
          partDescription: item.partDescription || "",
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          laborHours: persistedLaborMode === 'flat' ? '0.00' : (item.laborHours ?? 0).toString(),
          totalPrice: (money(item.quantity) * money(item.unitPrice)).toFixed(2),
          notes: item.notes || "",
        }));
        const resyncResult = await storage.replaceBillingSheetItemsAndResync(id, itemsToInsert);
        billingSheetData.partsSubtotal = resyncResult.partsSubtotal;
        billingSheetData.totalAmount = resyncResult.totalAmount;
        // Overwrite billingSheet reference so res.json() returns post-resync values
        Object.assign(billingSheet, { partsSubtotal: resyncResult.partsSubtotal, totalAmount: resyncResult.totalAmount });
        console.log(`[AUDIT] billing_sheet_items_replaced billingSheetId=${id} countBefore=${countBefore} countAfter=${resolvedPatchItems.length}`);
        console.log(`[AUDIT] billing_sheet_partsSubtotal_recomputed billingSheetId=${id} partsSubtotal=${resyncResult.partsSubtotal} totalAmount=${resyncResult.totalAmount}`);

        // Regression guard: surface any catalog $0 leak that slipped through.
        await regressionGuardZeroCatalogPrices('update', id, resolvedPatchItems);
      }

      // Submission guard: if status transitions to submitted, check items vs partsSubtotal
      if (billingSheetData.status === 'submitted') {
        const partsSubtotal = parseFloat(String(billingSheetData.partsSubtotal ?? billingSheet.partsSubtotal ?? '0'));
        const bsSubmitCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
        const currentSheet = await storage.getBillingSheetById(id, bsSubmitCompanyId);
        const currentItems = currentSheet?.items ?? [];
        if (partsSubtotal > 0 && currentItems.length === 0) {
          res.status(400).json({ message: "Parts were recorded but no line items were saved — submission blocked to prevent billing data loss" });
          return;
        }
        // Inverse check: items have prices summing to > 0 but partsSubtotal is 0 (or diverged by >1%)
        const itemsTotal = currentItems.reduce(
          (sum: number, item: { totalPrice?: string | null }) => sum + parseFloat(String(item.totalPrice || 0)),
          0
        );
        if (itemsTotal > 0 && partsSubtotal === 0) {
          res.status(400).json({ message: "Parts line item total does not match partsSubtotal — resubmit after saving to sync" });
          return;
        }
        if (itemsTotal > 0 && partsSubtotal > 0) {
          const divergencePct = Math.abs(itemsTotal - partsSubtotal) / itemsTotal;
          if (divergencePct > 0.01) {
            res.status(400).json({ message: "Parts line item total does not match partsSubtotal — resubmit after saving to sync" });
            return;
          }
        }
        console.log(`[AUDIT] billing_sheet_status_change billingSheetId=${id} status=${billingSheetData.status} itemCount=${currentItems.length}`);

        // When status transitions to submitted, create manualPartReview records for manual items
        if (billingSheetData.status === 'submitted') {
          try {
            const patchCompanyId = req.authenticatedUserCompanyId;
            const manualItems = currentItems.filter((item: { partId?: number | null }) => !item.partId);
            if (manualItems.length > 0 && patchCompanyId) {
              const billingNumber = currentSheet?.billingNumber || `#${id}`;
              for (const manualItem of manualItems as Array<{ id?: number; partId?: number | null; partName?: string; unitPrice?: string }>) {
                // Only create review if one doesn't already exist for this item
                const existingReviews = await storage.getManualPartReviews(patchCompanyId);
                const alreadyExists = existingReviews.some(r => r.billingSheetItemId === (manualItem.id ?? null) && r.billingSheetId === id);
                if (!alreadyExists) {
                  await storage.createManualPartReview({
                    billingSheetId: id,
                    billingSheetItemId: manualItem.id ?? null,
                    companyId: patchCompanyId,
                    partName: manualItem.partName || 'Unknown Part',
                    proposedPrice: String(manualItem.unitPrice || '0'),
                    approvalStatus: 'pending',
                  });
                  const companyUsers = await storage.getUsers(patchCompanyId);
                  const billingManagers = companyUsers.filter(u => u.role === 'billing_manager');
                  for (const bm of billingManagers) {
                    await storage.createNotification({
                      userId: bm.id,
                      type: "manual_part_pending_review",
                      title: "Manual Part Needs Pricing Review",
                      message: `A manually entered part "${manualItem.partName || 'Unknown Part'}" on billing sheet ${billingNumber} needs your price review.`,
                      relatedEntityType: "billing_sheet",
                      relatedEntityId: id,
                      isRead: false,
                    });
                  }
                }
              }
            }
          } catch (manualPartError) {
            console.error('Failed to create manual part reviews from PATCH:', manualPartError);
          }
        }
      }

      res.json(billingSheet);
    } catch (error) {
      console.error('Error updating billing sheet:', error);
      res.status(500).json({ message: "Failed to update billing sheet" });
    }
  });

  app.delete("/api/billing-sheets/bulk", requireAuthentication, requireWorkOrderBillingAccess, async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ message: "ids must be a non-empty array of numbers" });
        return;
      }
      const validIds = ids.filter((id: any) => typeof id === 'number' && id > 0);
      if (validIds.length === 0) {
        res.status(400).json({ message: "No valid IDs provided" });
        return;
      }
      // Mirror the wet-checks bulk-delete shape so the UI can summarize
      // "X deleted, Y blocked by an existing invoice".
      type Outcome = {
        id: number;
        status: 'deleted' | 'invoiced' | 'not_found' | 'error';
        message?: string;
        invoiceNumber?: string | null;
        invoiceId?: number | null;
      };
      const results: Outcome[] = [];
      for (const id of validIds) {
        try {
          const ok = await storage.deleteBillingSheet(id);
          results.push({ id, status: ok ? 'deleted' : 'not_found' });
        } catch (e: any) {
          if (e instanceof BillingSheetInvoicedError) {
            results.push({
              id,
              status: 'invoiced',
              message: e.invoiceNumber
                ? `Can't delete: this billing sheet is already on invoice #${e.invoiceNumber}.`
                : `Can't delete: this billing sheet is already on an invoice.`,
              invoiceNumber: e.invoiceNumber,
              invoiceId: e.invoiceId,
            });
          } else {
            // SQL-leak guard (Task #502): never echo Drizzle's
            // "Failed query: ..." string in the per-row outcome.
            // classifyAndLog logs full pg/cause context server-side
            // and returns a curated tech-friendly fallback message.
            const cls = classifyAndLog(req, e, {
              op: 'bulkDeleteBillingSheet',
              ctx: { id },
              fallbackMessage: "Couldn't delete — please retry",
            });
            results.push({ id, status: 'error', message: cls.message });
          }
        }
      }
      const summary = {
        requested: validIds.length,
        deleted: results.filter(r => r.status === 'deleted').length,
        invoiced: results.filter(r => r.status === 'invoiced').length,
        notFound: results.filter(r => r.status === 'not_found').length,
        failed: results.filter(r => r.status === 'error').length,
      };
      res.json({ results, summary, deleted: summary.deleted });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to bulk delete billing sheets" });
    }
  });

  app.delete("/api/billing-sheets/:id", requireAuthentication, requireSameCompanyAsBillingSheet, requireWorkOrderBillingAccess, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const ok = await storage.deleteBillingSheet(id);
      if (!ok) { res.status(404).json({ message: "Billing sheet not found" }); return; }
      res.json({ message: "Billing sheet deleted successfully" });
    } catch (error: any) {
      if (error instanceof BillingSheetInvoicedError) {
        res.status(409).json({
          message: error.invoiceNumber
            ? `Can't delete: this billing sheet is already on invoice #${error.invoiceNumber}.`
            : `Can't delete: this billing sheet is already on an invoice.`,
          invoiceNumber: error.invoiceNumber,
          invoiceId: error.invoiceId,
        });
        return;
      }
      console.error(error);
      res.status(500).json({ message: "Failed to delete billing sheet" });
    }
  });

  app.get("/api/invoices/:invoiceId/audit", requireAuthentication, requireInvoiceRead, async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.invoiceId);
      const callerCompanyId11065 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const invoice = await storage.getInvoiceById(invoiceId, callerCompanyId11065);
      if (!invoice) {
        res.status(404).json({ message: "Invoice not found" });
        return;
      }

      // Enforce tenant scoping: verify the invoice belongs to the authenticated user's company.
      // Super admins (companyId === null) are allowed to access any invoice.
      const userCompanyId = req.authenticatedUserCompanyId;
      if (userCompanyId !== null && userCompanyId !== undefined) {
        const invoiceCustomer = await storage.getCustomerById(invoice.customerId);
        if (!invoiceCustomer || invoiceCustomer.companyId !== userCompanyId) {
          res.status(403).json({ message: "Access denied. You do not have permission to audit this invoice." });
          return;
        }
      }

      // Deduplicate by (sourceType, sourceId) — one audit card per ticket regardless of
      // how many invoice item rows exist for that ticket (legacy invoice paths may vary).
      const seenTickets = new Map<string, boolean>();
      const uniqueItems = invoice.items.filter((item) => {
        const key = `${item.sourceType}:${item.sourceId}`;
        if (seenTickets.has(key)) return false;
        seenTickets.set(key, true);
        return true;
      });

      const enrichedItems = await Promise.all(
        uniqueItems.map(async (item) => {
          let status = "billed";
          let description = item.description;
          let workDate = item.workDate;

          // Derive financial amounts from source entities (authoritative totals)
          // invoiceItem.totalPrice = full ticket total (labor + parts)
          // invoiceItem.laborTotal = labor portion only
          // so partsTotal = totalPrice - laborTotal (avoids double-counting)
          let ticketTotal = parseFloat(item.totalPrice || "0");
          let laborTotal = parseFloat(item.laborTotal || "0");
          let partsTotal = ticketTotal - laborTotal;
          if (partsTotal < 0) partsTotal = 0;

          let createdAt: string | null = null;
          let approvedAt: string | null = null;
          let billedAt: string | null = null;
          let approvedLaborSnapshot: number | null = null;
          let approvedPartsSnapshot: number | null = null;

          if (item.sourceType === "work_order" && item.workOrderId) {
            const wo = await storage.getWorkOrder(item.workOrderId, userCompanyId ?? null);
            if (wo) {
              status = wo.status || "billed";
              description = wo.projectName || item.description;
              workDate = wo.completedAt || wo.updatedAt || item.workDate;
              createdAt = wo.createdAt ? wo.createdAt.toISOString() : null;
              approvedAt = wo.approvedAt ? wo.approvedAt.toISOString() : null;
              billedAt = wo.billedAt ? wo.billedAt.toISOString() : null;
              // Parse approval snapshots
              if (wo.approvedLaborSnapshot) {
                try {
                  const snap = JSON.parse(wo.approvedLaborSnapshot);
                  const parsed = typeof snap === "number" ? snap : parseFloat(snap?.laborSubtotal ?? snap?.total ?? "");
                  approvedLaborSnapshot = isNaN(parsed) ? null : parsed;
                } catch { approvedLaborSnapshot = null; }
              }
              if (wo.approvedPartsSnapshot) {
                try {
                  const snap = JSON.parse(wo.approvedPartsSnapshot);
                  const parsed = typeof snap === "number" ? snap : parseFloat(snap?.partsSubtotal ?? snap?.total ?? "");
                  approvedPartsSnapshot = isNaN(parsed) ? null : parsed;
                } catch { approvedPartsSnapshot = null; }
              }
              // Use authoritative source totals when available
              const woTotal = parseFloat(wo.totalAmount || "0");
              const woLabor = parseFloat(wo.laborSubtotal || "0");
              if (woTotal > 0) {
                ticketTotal = woTotal;
                laborTotal = woLabor;
                partsTotal = Math.max(0, woTotal - woLabor);
              }
            }
          } else if (item.sourceType === "billing_sheet" && item.billingSheetId) {
            const bs = await storage.getBillingSheetById(item.billingSheetId, userCompanyId ?? null);
            if (bs) {
              status = bs.status || "billed";
              description = bs.workDescription || item.description;
              workDate = bs.workDate || item.workDate;
              createdAt = bs.createdAt ? bs.createdAt.toISOString() : null;
              approvedAt = bs.approvedAt ? bs.approvedAt.toISOString() : null;
              billedAt = bs.billedAt ? bs.billedAt.toISOString() : null;
              // Parse approval snapshots
              if (bs.approvedLaborSnapshot) {
                try {
                  const snap = JSON.parse(bs.approvedLaborSnapshot);
                  const parsed = typeof snap === "number" ? snap : parseFloat(snap?.laborSubtotal ?? snap?.total ?? "");
                  approvedLaborSnapshot = isNaN(parsed) ? null : parsed;
                } catch { approvedLaborSnapshot = null; }
              }
              if (bs.approvedPartsSnapshot) {
                try {
                  const snap = JSON.parse(bs.approvedPartsSnapshot);
                  const parsed = typeof snap === "number" ? snap : parseFloat(snap?.partsSubtotal ?? snap?.total ?? "");
                  approvedPartsSnapshot = isNaN(parsed) ? null : parsed;
                } catch { approvedPartsSnapshot = null; }
              }
              // Use authoritative source totals when available
              const bsLabor = parseFloat(bs.laborSubtotal || "0");
              const bsParts = parseFloat(bs.partsSubtotal || "0");
              const bsTotal = parseFloat(bs.totalAmount || "0");
              if (bsTotal > 0) {
                ticketTotal = bsTotal;
                laborTotal = bsLabor;
                partsTotal = bsParts;
              }
            }
          } else if (item.sourceType === "wet_check_billing" && item.wetCheckBillingId) {
            const wcb = await storage.getWetCheckBillingById(item.wetCheckBillingId, null);
            if (wcb) {
              status = wcb.status || "billed";
              description = wcb.billingNumber || item.description;
              workDate = wcb.workDate || item.workDate;
              createdAt = wcb.createdAt ? wcb.createdAt.toISOString() : null;
              billedAt = wcb.billedAt ? wcb.billedAt.toISOString() : null;
              if (wcb.approvedLaborSnapshot) {
                try {
                  const snap = JSON.parse(wcb.approvedLaborSnapshot);
                  const parsed = typeof snap === "number" ? snap : parseFloat(snap?.laborSubtotal ?? snap?.total ?? "");
                  approvedLaborSnapshot = isNaN(parsed) ? null : parsed;
                } catch { approvedLaborSnapshot = null; }
              }
              if (wcb.approvedPartsSnapshot) {
                try {
                  const snap = JSON.parse(wcb.approvedPartsSnapshot);
                  const parsed = typeof snap === "number" ? snap : parseFloat(snap?.partsSubtotal ?? snap?.total ?? "");
                  approvedPartsSnapshot = isNaN(parsed) ? null : parsed;
                } catch { approvedPartsSnapshot = null; }
              }
              // Use authoritative source totals when available
              const wcbLabor = parseFloat(wcb.laborSubtotal || "0");
              const wcbParts = parseFloat(wcb.partsSubtotal || "0");
              const wcbTotal = parseFloat(wcb.totalAmount || "0");
              if (wcbTotal > 0) {
                ticketTotal = wcbTotal;
                laborTotal = wcbLabor;
                partsTotal = wcbParts;
              }
            }
          }

          return {
            id: item.id,
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            workOrderId: item.workOrderId,
            billingSheetId: item.billingSheetId,
            wetCheckBillingId: item.wetCheckBillingId,
            description,
            status,
            laborTotal,
            partsTotal,
            ticketTotal,
            workDate,
            createdAt,
            approvedAt,
            billedAt,
            approvedLaborSnapshot,
            approvedPartsSnapshot,
          };
        })
      );

      res.json({ invoiceId, items: enrichedItems });
    } catch (error) {
      console.error("Error fetching invoice audit data:", error);
      res.status(500).json({ message: "Failed to fetch invoice audit data" });
    }
  });

  // Task #1443 — real per-invoice QuickBooks sync/resync lives in
  // ./invoice-sync-quickbooks-route.ts, wired up at the merge-route register
  // site below with createQuickBooksInvoiceForInvoice injected.

  app.get("/api/invoices/:invoiceId/pdf", requireAuthentication, requireInvoiceRead, async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.invoiceId);
      const callerCompanyId11217 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const invoice = await storage.getInvoiceById(invoiceId, callerCompanyId11217);
      if (!invoice) {
        res.status(404).json({ message: "Invoice not found" });
        return;
      }

      const customer = await storage.getCustomerById(invoice.customerId);
      const periodStart = new Date(invoice.periodStart);
      const periodEnd = new Date(invoice.periodEnd);
      const fmtDateShort = (d: Date) => `${d.getMonth()+1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
      const propertyName = customer?.irrigoName ?? customer?.name ?? 'Unknown';
      const newFilename = `${propertyName} - Irrigation Billing Detail - (${fmtDateShort(periodStart)}_${fmtDateShort(periodEnd)}).pdf`;

      let pdf = await storage.getInvoicePdfByInvoiceId(invoiceId);
      if (!pdf) {
        const companyId = customer?.companyId ?? 1;

        const pdfService = new InvoicePdfService(storage);
        const result = await pdfService.generatePdfBuffer(invoiceId);

        if (!result.success) {
          if (result.validationFailure) {
            res.status(422).json({
              message: result.error || "Invoice totals validation failed",
              validationFailure: result.validationFailure,
            });
            return;
          }
          res.status(500).json({ message: "PDF generation failed", error: result.error });
          return;
        }

        pdf = await storage.createInvoicePdf({
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          companyId,
          pdfUrl: 'generated-on-demand',
          filename: newFilename,
          status: 'generated',
        });
      }
      
      res.json({ ...pdf, filename: newFilename });
    } catch (error) {
      console.error('Error fetching invoice PDF:', error);
      res.status(500).json({ message: "Failed to fetch invoice PDF" });
    }
  });

  app.get("/api/invoices/:invoiceId/pdf/download", requireAuthentication, requireInvoiceRead, async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.invoiceId);

      const pdfService = new InvoicePdfService(storage);
      const result = await pdfService.generatePdfBuffer(invoiceId);

      if (!result.success || !result.pdfBuffer) {
        if (result.validationFailure) {
          res.status(422).json({
            message: result.error || "Invoice totals validation failed",
            validationFailure: result.validationFailure,
          });
          return;
        }
        res.status(500).json({ message: result.error || "Failed to generate PDF" });
        return;
      }

      const callerCompanyId11278 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const invoice = await storage.getInvoiceById(invoiceId, callerCompanyId11278);
      const customer = invoice ? await storage.getCustomerById(invoice.customerId) : null;
      const periodStart = invoice ? new Date(invoice.periodStart) : new Date();
      const periodEnd = invoice ? new Date(invoice.periodEnd) : new Date();
      const fmtDateShort = (d: Date) => `${d.getMonth()+1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
      const propertyName = customer?.irrigoName ?? customer?.name ?? 'Unknown';
      const filename = invoice
        ? `${propertyName} - Irrigation Billing Detail - (${fmtDateShort(periodStart)}_${fmtDateShort(periodEnd)}).pdf`
        : `Irrigation Billing Detail - ${invoiceId}.pdf`;

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length': result.pdfBuffer.length.toString(),
      });

      res.end(result.pdfBuffer);
    } catch (error) {
      console.error('Error downloading invoice PDF:', error);
      res.status(500).json({ message: "Failed to download invoice PDF" });
    }
  });

  app.post("/api/invoices/:invoiceId/pdf/send", requireAuthentication, requireInvoiceSend, async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.invoiceId);
      const callerCompanyId11304 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const invoice = await storage.getInvoiceById(invoiceId, callerCompanyId11304);
      
      if (!invoice) {
        res.status(404).json({ message: "Invoice not found" });
        return;
      }

      const pdfService = new InvoicePdfService(storage);
      const validationResult = await pdfService.generatePdfBuffer(invoiceId);
      if (!validationResult.success) {
        if (validationResult.validationFailure) {
          res.status(422).json({
            message: validationResult.error || "Invoice totals validation failed",
            validationFailure: validationResult.validationFailure,
          });
          return;
        }
        res.status(500).json({ message: validationResult.error || "Failed to validate invoice PDF" });
        return;
      }

      const pdf = await storage.getInvoicePdfByInvoiceId(invoiceId);
      if (!pdf) {
        res.status(404).json({ message: "PDF not found for this invoice" });
        return;
      }

      // Send email to customer with PDF attachment
      const emailResult = await EmailService.sendInvoiceDetailPdf(
        invoice.customerEmail,
        invoice.customerName,
        invoice.invoiceNumber,
        pdf.pdfUrl
      );

      if (emailResult.success) {
        const now = new Date();
        // Update PDF status to mark it as sent
        await storage.updateInvoicePdf(pdf.id, {
          status: 'sent',
          sentAt: now,
        });
        // Task #1847 — sentAt on the invoice row is the single source of
        // delivery truth. Stamp it when a PDF is emailed so the Sent badge
        // appears without requiring a separate manual mark-sent action.
        // Preserve an existing sentAt (e.g. a prior manual mark-sent) — only
        // fill in when it is currently null.
        if (!invoice.sentAt) {
          await storage.updateInvoice(invoiceId, { sentAt: now });
        }
        
        res.json({ 
          message: "PDF sent successfully to customer",
          email: invoice.customerEmail 
        });
      } else {
        res.status(500).json({ 
          message: "Failed to send PDF",
          error: emailResult.error 
        });
      }
    } catch (error) {
      console.error('Error sending invoice PDF:', error);
      res.status(500).json({ message: "Failed to send invoice PDF" });
    }
  });

  app.post("/api/invoices/:invoiceId/pdf/regenerate", requireAuthentication, requireInvoiceWrite, async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.invoiceId);
      const callerCompanyId11380 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const invoice = await storage.getInvoiceById(invoiceId, callerCompanyId11380);
      
      if (!invoice) {
        res.status(404).json({ message: "Invoice not found" });
        return;
      }

      const existingPdf = await storage.getInvoicePdfByInvoiceId(invoiceId);
      if (existingPdf) {
        await db.delete(invoicePdfs).where(eq(invoicePdfs.id, existingPdf.id));
      }

      const pdfService = new InvoicePdfService(storage);
      const result = await pdfService.generateAndSaveInvoicePdf(invoiceId);

      if (result.success) {
        res.json({ message: "PDF regenerated successfully" });
      } else {
        res.status(500).json({ 
          message: "Failed to regenerate PDF",
          error: result.error 
        });
      }
    } catch (error) {
      console.error('Error regenerating invoice PDF:', error);
      res.status(500).json({ message: "Failed to regenerate invoice PDF" });
    }
  });


  // Work Order routes - Enhanced
  // Note: Pricing fields are stripped for field_tech role via applyPricingVisibility
  app.get("/api/work-orders", requireAuthentication, async (req: any, res) => {
    try {
      const { technician, customer, status } = req.query;
      const userRole = req.authenticatedUserRole as string | undefined;
      const userId = req.authenticatedUserId as number | undefined;

      // Field techs can only ever see their own assignments. Any
      // `technician` query param they pass is ignored — the authoritative
      // filter is the authenticated user id. Other parametric filters
      // (customer, status) are also disallowed for techs to avoid
      // cross-tenant or cross-user enumeration.
      if (userRole === 'field_tech') {
        if (!userId) {
          res.status(401).json({ message: "Authentication required" });
          return;
        }
        const callerCompanyIdTech = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
        const own = await storage.getWorkOrdersByTechnician(userId, callerCompanyIdTech);
        // Task #532 — field techs are the most bandwidth-constrained
        // users, so the per-tech list also honors ?limit/?offset and
        // emits X-Total-Count for incremental loading.
        const ownPage = paginate(req, res, own, { limit: 100, max: 500 });
        res.json(applyPricingVisibility(req, ownPage));
        return;
      }

      const callerCompanyIdWoList = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      let workOrders;
      if (technician) {
        workOrders = await storage.getWorkOrdersByTechnician(parseInt(technician as string), callerCompanyIdWoList);
      } else if (customer) {
        workOrders = await storage.getWorkOrdersByCustomer(parseInt(customer as string), callerCompanyIdWoList);
      } else if (status) {
        workOrders = await storage.getWorkOrdersByStatus(status as string, callerCompanyIdWoList);
      } else {
        workOrders = await storage.getWorkOrders(callerCompanyIdWoList);
      }

      // Task #532 — opt-in pagination so the work orders list page can
      // switch to useInfiniteQuery without a server contract change.
      const page = paginate(req, res, workOrders, { limit: 100, max: 500 });

      // Strip pricing fields for field technicians
      res.json(applyPricingVisibility(req, page));
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch work orders" });
    }
  });

  // Report: work orders created before the photo-save fix (Task #143) that
  // currently have zero photos. Mirrors /api/billing-sheets/missing-photos —
  // same cutoff, same role gate, same CSV option.
  app.get("/api/work-orders/missing-photos", requireAuthentication, async (req: any, res) => {
    try {
      const role = req.authenticatedUserRole;
      if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
        res.status(403).json({ message: "Access denied." });
        return;
      }

      const callerCompanyIdMissingWo = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const all = await storage.getWorkOrders(callerCompanyIdMissingWo);
      const missing = all.filter(wo => {
        const created = wo.createdAt ? new Date(wo.createdAt) : null;
        if (!created || created >= PHOTO_FIX_CUTOFF) return false;
        // Task #185 — admins can mark a ticket as not needing photos; once
        // flagged it should no longer appear on this report (JSON or CSV).
        if (wo.noPhotosNeeded) return false;
        // Task #192 — once a work order has been billed, chasing photos for
        // it is pointless. Hide anything that's been billed (status, invoice
        // link, or billed timestamp).
        if (wo.status === 'billed' || wo.invoiceId != null || wo.billedAt != null) return false;
        const photos = Array.isArray(wo.photos) ? wo.photos : [];
        return photos.length === 0;
      });

      // Sort newest first
      missing.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const format = (req.query.format as string | undefined)?.toLowerCase();
      if (format === 'csv') {
        const escape = (v: any) => {
          const s = v == null ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = ['Work Order Number','Technician','Customer','Branch','Project Address','Scheduled Date','Created At','Status','Project Name'];
        const rows = missing.map(wo => [
          wo.workOrderNumber,
          wo.assignedTechnicianName ?? '',
          wo.customerName,
          wo.branchName ?? '',
          wo.projectAddress ?? '',
          wo.scheduledDate ? new Date(wo.scheduledDate).toISOString().slice(0,10) : '',
          new Date(wo.createdAt).toISOString(),
          wo.status,
          (wo.projectName ?? '').replace(/\s+/g, ' ').trim(),
        ].map(escape).join(','));
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="work-orders-missing-photos-${new Date().toISOString().slice(0,10)}.csv"`);
        res.send(csv);
        return;
      }

      res.json({
        cutoff: PHOTO_FIX_CUTOFF.toISOString(),
        count: missing.length,
        workOrders: applyPricingVisibility(req, missing),
      });
    } catch (error) {
      console.error('Error fetching work-orders missing-photos report:', error);
      res.status(500).json({ message: "Failed to fetch missing-photos report" });
    }
  });

  // Task #185 — flag a work order as not requiring photos so it disappears
  // from the missing-photos report. Restricted to the same four roles that
  // can view the report. Captures the acting user + timestamp on the row.
  app.post("/api/work-orders/:id/no-photos-needed", requireAuthentication, requireSameCompanyAsWorkOrder, async (req: any, res) => {
    try {
      const role = req.authenticatedUserRole;
      if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
        res.status(403).json({ message: "Access denied." });
        return;
      }

      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }

      const callerCompanyIdWoNoPhotos = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const existing = await storage.getWorkOrder(id, callerCompanyIdWoNoPhotos);
      if (!existing) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }

      const userId = req.authenticatedUserId;
      if (!userId) {
        res.status(401).json({ message: "Authentication required - user ID not found." });
        return;
      }

      const updated = await storage.markWorkOrderNoPhotosNeeded(id, userId);
      if (!updated) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }
      res.json(updated);
    } catch (error) {
      console.error('Error marking work order as no-photos-needed:', error);
      res.status(500).json({ message: "Failed to mark work order" });
    }
  });

  // Task #187 — undo the "no photos needed" flag. Same role gate as the
  // mark endpoint. Resets noPhotosNeeded + audit fields so the work order
  // re-appears on the missing-photos report.
  app.post("/api/work-orders/:id/no-photos-needed/clear", requireAuthentication, requireSameCompanyAsWorkOrder, async (req: any, res) => {
    try {
      const role = req.authenticatedUserRole;
      if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
        res.status(403).json({ message: "Access denied." });
        return;
      }

      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }

      const callerCompanyIdWoClear = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const existing = await storage.getWorkOrder(id, callerCompanyIdWoClear);
      if (!existing) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }

      const updated = await storage.clearWorkOrderNoPhotosNeeded(id);
      if (!updated) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }
      res.json(updated);
    } catch (error) {
      console.error('Error clearing no-photos-needed flag:', error);
      res.status(500).json({ message: "Failed to clear flag" });
    }
  });

  app.get("/api/work-orders/:id", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const callerCompanyIdWoGet = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const workOrder = req.tenantScopedWorkOrder ?? await storage.getWorkOrder(id, callerCompanyIdWoGet);
      if (!workOrder) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }
      // Task #1093 — embed customer rates for inline edit.
      let customerRatesWo: { laborRate: string | null; emergencyLaborRate: string | null } | null = null;
      const cust = workOrder.customerId != null ? await storage.getCustomer(workOrder.customerId as number) : null;
      if (cust) customerRatesWo = { laborRate: cust.laborRate, emergencyLaborRate: cust.emergencyLaborRate };
      // Task #1395 — embed items so LineItemsEditor and TotalHoursEditor work
      // for work orders in the command center inline pane. Map partPrice →
      // unitPrice to match the InlineItem shape the frontend expects.
      const woItemRows = await storage.getWorkOrderItems(id);
      const woItems = woItemRows.map((item) => ({
        id: item.id,
        partId: item.partId,
        partName: item.partName,
        quantity: item.quantity,
        unitPrice: item.partPrice,
        laborHours: item.laborHours,
        notes: item.notes ?? null,
        totalPrice: item.totalPrice,
      }));
      // Task #1500 — read-through the seven approval-signature fields from
      // the originating estimate when the WO was created from one. The
      // signature lives on the estimate (no new WO columns); we merge the
      // fields here so both the tech-facing and manager-facing detail views
      // can render the "Customer Approved — Signature on File" block without
      // a separate client fetch.
      let estimateSignatureFields: Record<string, unknown> = {};
      if (workOrder.estimateId) {
        try {
          const origEstimate = await storage.getEstimate(workOrder.estimateId as number);
          if (origEstimate) {
            // Task #1514 — resolve a stored object-storage key (`signatures/<uuid>`)
            // to a short-lived signed URL so the WO detail response never contains
            // a raw base64 data URI. Typed names and legacy inline URIs pass through.
            const oss = new ObjectStorageService();
            const origAny = origEstimate as Record<string, unknown>;
            const resolvedSigData = await oss.resolveSignatureData(
              origAny.approvalSignatureType as string | null,
              origAny.approvalSignatureData as string | null,
            );
            estimateSignatureFields = {
              approvalSignatureType: origEstimate.approvalSignatureType ?? null,
              approvalSignatureData: resolvedSigData,
              approvalSignerName: origEstimate.approvalSignerName ?? null,
              approvalSignedAt: origEstimate.approvalSignedAt ?? null,
              approvalSignerIp: origEstimate.approvalSignerIp ?? null,
              approvalConsentText: origEstimate.approvalConsentText ?? null,
              approvalConsentAcceptedAt: origEstimate.approvalConsentAcceptedAt ?? null,
            };
          }
        } catch {
          // Non-fatal — WO detail still works without the signature fields.
        }
      }
      // Strip pricing fields for field technicians
      res.json(applyPricingVisibility(req, { ...workOrder, customer: customerRatesWo, items: woItems, ...estimateSignatureFields }));
    } catch (error) {
      req.log ? req.log.error(error) : console.error(error);
      res.status(500).json({ message: "Failed to fetch work order" });
    }
  });

  // Task #1093 — rate-mode toggle for work orders.
  app.patch("/api/work-orders/:id/rate-mode", requireAuthentication, requireSameCompanyAsWorkOrder, async (req: any, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = rateModeBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid id" }); return; }
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const result = await storage.recomputeWorkOrderTotalsForRateMode(id, parsed.data.mode, companyId);
      void recordAuditEvent(req, {
        actionType: "data", action: "work_order.rate_mode_changed",
        targetType: "work_order", targetId: String(id),
        summary: `Rate mode set to ${parsed.data.mode}`,
      });
      res.json(result);
    } catch (e: any) {
      if (e?.code === "WO_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "WO_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      if (e?.code === "NO_CUSTOMER") { res.status(422).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "recomputeWorkOrderTotalsForRateMode",
        ctx: { id, mode: parsed.data.mode },
        fallbackStatus: 500, fallbackMessage: "Couldn't update rate mode",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1315 — flat labor hours editor for work orders.
  app.patch("/api/work-orders/:id/labor-hours", requireAuthentication, requireSameCompanyAsWorkOrder, async (req: any, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = laborHoursBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid id" }); return; }
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const result = await storage.updateWorkOrderLaborHours(id, parsed.data.totalHours, companyId);
      void recordAuditEvent(req, {
        actionType: "data", action: "work_order.labor_hours_updated",
        targetType: "work_order", targetId: String(id),
        summary: `Total labor hours set to ${parsed.data.totalHours}`,
      });
      res.json(result);
    } catch (e: any) {
      if (e?.code === "WO_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "WO_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "updateWorkOrderLaborHours",
        ctx: { id, totalHours: parsed.data.totalHours },
        fallbackStatus: 500, fallbackMessage: "Couldn't update labor hours",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1415 — direct labor rate override for work orders.
  const laborRateBody = z.object({ laborRate: z.number().min(0) });
  app.patch("/api/work-orders/:id/labor-rate", requireAuthentication, requireSameCompanyAsWorkOrder, async (req: any, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = laborRateBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid id" }); return; }
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const result = await storage.updateWorkOrderLaborRate(id, parsed.data.laborRate, companyId);
      void recordAuditEvent(req, {
        actionType: "data", action: "work_order.labor_rate_updated",
        targetType: "work_order", targetId: String(id),
        summary: `Labor rate set to ${parsed.data.laborRate}`,
      });
      res.json(result);
    } catch (e: any) {
      if (e?.code === "WO_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "WO_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "updateWorkOrderLaborRate",
        ctx: { id, laborRate: parsed.data.laborRate },
        fallbackStatus: 500, fallbackMessage: "Couldn't update labor rate",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1093 — item replacement for work orders.
  app.patch("/api/work-orders/:id/items", requireAuthentication, requireSameCompanyAsWorkOrder, async (req: any, res) => {
    const role = req.authenticatedUserRole;
    if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
      res.status(403).json({ message: "Forbidden" }); return;
    }
    const parsed = itemsBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ message: "Invalid id" }); return; }
    const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
    try {
      const insertItems = parsed.data.items.map((i) => ({
        workOrderId: id,
        partId: i.partId ?? null,
        partName: i.partName,
        partPrice: String(i.unitPrice),
        quantity: i.quantity,
        laborHours: String(i.laborHours ?? 0),
        totalPrice: (money(i.quantity) * money(i.unitPrice)).toFixed(2),
        notes: i.notes ?? null,
      }));
      const result = await storage.replaceWorkOrderItemsWithResync(id, insertItems, companyId);
      void recordAuditEvent(req, {
        actionType: "data", action: "work_order.items_replaced",
        targetType: "work_order", targetId: String(id),
        summary: `Inline item edit: ${insertItems.length} item(s)`,
      });
      res.json(result);
    } catch (e: any) {
      if (e?.code === "WO_LOCKED") { res.status(409).json({ message: e.message }); return; }
      if (e?.code === "WO_NOT_FOUND") { res.status(404).json({ message: e.message }); return; }
      const { status, message } = classifyAndLog(req, e, {
        op: "replaceWorkOrderItemsWithResync",
        ctx: { id }, fallbackStatus: 500, fallbackMessage: "Couldn't save items",
      });
      res.status(status).json({ message });
    }
  });

  app.post("/api/work-orders", requireAuthentication, async (req, res) => {
    try {
      const { items, ...workOrderBody } = req.body;

      // Lifecycle guard: force new work orders to the canonical start state.
      // Callers cannot create a work order already in a downstream status.
      const downstreamStatuses = [
        'in_progress', 'work_completed', 'pending_manager_review',
        'approved_passed_to_billing', 'billed', 'cancelled'
      ];
      if (workOrderBody.status && downstreamStatuses.includes(workOrderBody.status)) {
        workOrderBody.status = 'pending';
      }

      // Task #596 — defensively coerce numeric workLocationLat/Lng to strings
      // before drizzle-zod validation so older / mobile clients that send raw
      // JS numbers don't 400 against the decimal-typed columns.
      coerceLatLngStrings(workOrderBody);
      const workOrderData = insertWorkOrderSchema.parse(workOrderBody);

      // Force-tenant: non-super-admin callers can only create work orders for
      // their own company's customers. Fail closed — if company context is
      // missing the request is rejected rather than silently unchecked.
      const createRole = req.authenticatedUserRole as string | undefined;
      const createCompanyId = req.authenticatedUserCompanyId as number | null | undefined;
      if (createRole !== 'super_admin') {
        if (!createCompanyId) {
          res.status(403).json({ message: "Company context required to create a work order" });
          return;
        }
        if (workOrderData.customerId) {
          const createCustomer = await storage.getCustomer(workOrderData.customerId);
          if (!createCustomer || Number(createCustomer.companyId) !== Number(createCompanyId)) {
            res.status(404).json({ message: "Customer not found" });
            return;
          }
        }
      }

      // Branch enforcement: if the customer has branches configured, branchName is required
      if (workOrderData.customerId) {
        const customer = await storage.getCustomer(workOrderData.customerId);
        if (customer && Array.isArray(customer.branches) && customer.branches.length > 0) {
          if (!workOrderData.branchName || workOrderData.branchName.trim() === '') {
            res.status(400).json({ message: "Branch is required for this customer. Please select a branch before submitting." });
            return;
          }
        }
      }

      // Server-side authoritative pricing (Task #160): rewrite catalog line items
      // with the catalog price BEFORE we create the work order, so that if a
      // partId is invalid we 4xx-reject without leaving an orphan work order.
      let resolvedWoCreateItems: RawBillingItem[] = [];
      let auditedZerosForLog: Array<{ partId: number; partName: string; clientUnitPrice: number; catalogUnitPrice: number }> = [];
      if (items !== undefined && Array.isArray(items) && items.length > 0) {
        const woCreateCompanyId = req.authenticatedUserCompanyId
          ?? (headerUserCompanyId(req)
            ? parseInt(headerUserCompanyId(req) as string)
            : null);
        const woCreatePricing = await resolveAuthoritativePartPricing(items as RawBillingItem[], woCreateCompanyId);
        if (woCreatePricing.error) {
          res.status(woCreatePricing.error.status).json({ message: woCreatePricing.error.message });
          return;
        }
        resolvedWoCreateItems = (woCreatePricing.items as RawBillingItem[]) ?? [];
        auditedZerosForLog = woCreatePricing.auditedZeros.map((d) => ({
          partId: d.partId,
          partName: d.partName,
          clientUnitPrice: d.clientUnitPrice,
          catalogUnitPrice: d.catalogUnitPrice,
        }));
      }

      // Inject companyId — super_admin derives it from the customer; non-super_admin
      // is already validated to match their own company above.
      let woCreateCompanyId_final: number | undefined;
      if (createRole === 'super_admin' && workOrderData.customerId) {
        const custForCo = await storage.getCustomer(workOrderData.customerId);
        woCreateCompanyId_final = custForCo?.companyId ?? undefined;
      } else {
        woCreateCompanyId_final = createCompanyId ?? undefined;
      }
      if (!woCreateCompanyId_final) {
        res.status(400).json({ message: "Could not determine company for this work order" });
        return;
      }
      const workOrder = await storage.createWorkOrder({ ...workOrderData, companyId: woCreateCompanyId_final });

      // Save items if provided at creation time (now that the work order exists).
      if (resolvedWoCreateItems.length > 0) {
        for (const drift of auditedZerosForLog) {
          console.log(
            `[AUDIT] work_order_create_price_corrected workOrderId=${workOrder.id} partId=${drift.partId} ` +
            `partName="${drift.partName}" clientUnitPrice=${drift.clientUnitPrice.toFixed(2)} ` +
            `catalogUnitPrice=${drift.catalogUnitPrice.toFixed(2)}`
          );
        }

        type WoCreateLine = RawBillingItem & { partPrice?: number | string };
        // Task #396 — Honor work order's laborMode when persisting line items.
        const woCreateLaborMode = workOrder.laborMode === 'per_part' ? 'per_part' : 'flat';
        let computedPartsCost = 0;
        for (const raw of resolvedWoCreateItems as WoCreateLine[]) {
          const qty = Number(raw.quantity) || 0;
          const price = Number(raw.unitPrice) || Number(raw.partPrice) || 0;
          const lineTotal = qty * price;
          computedPartsCost += lineTotal;
          await storage.addWorkOrderItem({
            workOrderId: workOrder.id,
            partId: raw.partId || null,
            partName: raw.partName ?? "",
            partPrice: price.toString(),
            quantity: qty,
            laborHours: woCreateLaborMode === 'flat'
              ? '0.00'
              : (Number(raw.laborHours) || 0).toString(),
            totalPrice: lineTotal.toString(),
            notes: raw.notes || null,
          });
        }
        await storage.updateWorkOrder(workOrder.id, { totalPartsCost: computedPartsCost.toFixed(2) });

        await regressionGuardZeroCatalogPrices('work_order_conversion', workOrder.id, resolvedWoCreateItems);
      }

      const woItemCount = (await storage.getWorkOrderItems(workOrder.id)).length;
      console.log(`[AUDIT] work_order_created workOrderId=${workOrder.id} workOrderNumber=${workOrder.workOrderNumber} itemCount=${woItemCount}`);


      // Send notification if technician is assigned during creation
      if (workOrder.assignedTechnicianId) {
        await storage.createNotification({
          userId: workOrder.assignedTechnicianId,
          type: "work_order_assigned",
          title: "New Work Order Assigned",
          message: `You have been assigned work order ${workOrder.workOrderNumber} for ${workOrder.projectName || 'irrigation project'}.`,
          relatedEntityType: "work_order",
          relatedEntityId: workOrder.id
        });
      }
      
      res.status(201).json(workOrder);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid work order data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to create work order" });
    }
  });

  app.patch("/api/work-orders/:id", requireAuthentication, requireSameCompanyAsWorkOrder, requireWorkOrderUpdateAccess, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      // Validate work order ID is a valid number
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }

      // Task #191: photos-only patches (single key 'photos' with an array value)
      // bypass the billed and approved-passed-to-billing locks below so that
      // techs (and admins) can backfill photos onto already-billed tickets.
      // Every other field on a billed/approved ticket stays locked.
      const woPatchKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
      const isWoPhotosOnlyPatch =
        woPatchKeys.length === 1 && woPatchKeys[0] === 'photos' && Array.isArray(req.body.photos);

      // Billing lock: reject updates to work orders that have been invoiced
      const callerCompanyIdWoPatch = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const existingForLockCheck = await storage.getWorkOrder(id, callerCompanyIdWoPatch);
      if (!isWoPhotosOnlyPatch && existingForLockCheck && (existingForLockCheck.invoiceId || existingForLockCheck.status === 'billed')) {
        res.status(409).json({ message: "This record has been billed and cannot be edited." });
        return;
      }
      // Lock after manager approval — only admins and billing managers can proceed
      const woUpdateUserRole = req.authenticatedUserRole || headerUserRole(req);
      if (!isWoPhotosOnlyPatch && existingForLockCheck?.status === 'approved_passed_to_billing' &&
          woUpdateUserRole !== 'company_admin' && woUpdateUserRole !== 'super_admin' && woUpdateUserRole !== 'billing_manager') {
        res.status(409).json({ message: "This record has been approved and passed to billing — it cannot be edited." });
        return;
      }

      const { items, ...workOrderBody } = req.body;

      // Canonical status transition guard.
      // Defines the only valid next-states from each status; enforces lifecycle order
      // and prevents skipping steps or bypassing dedicated endpoints.
      if (workOrderBody.status !== undefined) {
        const requestedStatus = workOrderBody.status as string;
        const currentStatus = existingForLockCheck?.status ?? 'pending';

        // 'work_completed' is a legacy terminal state — use /complete endpoint.
        if (requestedStatus === 'work_completed') {
          res.status(400).json({
            message: "Cannot set status to 'work_completed' directly. Use POST /api/work-orders/complete or POST /api/work-orders/:id/complete."
          });
          return;
        }

        // Only the /approve endpoint may transition to approved_passed_to_billing.
        if (requestedStatus === 'approved_passed_to_billing') {
          res.status(400).json({
            message: "Cannot approve a work order via PATCH. Use the POST /api/work-orders/:id/approve endpoint."
          });
          return;
        }

        // Only the invoicing flow may mark a work order as billed.
        if (requestedStatus === 'billed') {
          res.status(400).json({
            message: "Cannot set status to 'billed' directly. Billing status is set automatically when an invoice is created."
          });
          return;
        }

        // Allowed next-state map for all lifecycle-transition writes via PATCH
        const allowedTransitions: Record<string, string[]> = {
          pending: ['assigned', 'in_progress', 'cancelled'],
          assigned: ['pending', 'in_progress', 'cancelled'],
          in_progress: ['assigned', 'pending', 'cancelled'],
          pending_manager_review: ['in_progress', 'cancelled'], // manager can send back for rework
          // Terminal / post-approval states cannot be changed via PATCH
          work_completed: [],
          approved_passed_to_billing: [],
          billed: [],
          cancelled: [],
        };

        const validNextStates = allowedTransitions[currentStatus] ?? [];
        if (!validNextStates.includes(requestedStatus)) {
          res.status(400).json({
            message: `Invalid status transition from '${currentStatus}' to '${requestedStatus}'. Valid transitions: [${validNextStates.join(', ') || 'none'}].`
          });
          return;
        }
      }

      // Strip immutable financial snapshot fields so manager edits cannot alter
      // the rates/breakdown that were locked in at completion time.
      const {
        appliedLaborRate: _aLR,
        laborSubtotal: _lS,
        partsSubtotal: _pS,
        totalAmount: _totA,
        ...mutableWorkOrderBody
      } = workOrderBody;
      // Task #396 — audit any laborMode change on a work order PATCH so the
      // mode flip is traceable downstream alongside the totals it implies.
      if (
        mutableWorkOrderBody.laborMode !== undefined &&
        existingForLockCheck &&
        mutableWorkOrderBody.laborMode !== existingForLockCheck.laborMode
      ) {
        console.log(
          `[AUDIT] work_order_labor_mode_changed workOrderId=${id} ` +
          `from=${existingForLockCheck.laborMode ?? 'per_part'} to=${mutableWorkOrderBody.laborMode}`
        );
      }
      // Task #596 — same numeric->string coercion on the PATCH path.
      coerceLatLngStrings(mutableWorkOrderBody);
      const workOrderData = insertWorkOrderSchema.partial().parse(mutableWorkOrderBody);
      let workOrder;
      if (Object.keys(workOrderData).length > 0) {
        workOrder = await storage.updateWorkOrder(id, workOrderData);
        if (!workOrder) {
          res.status(404).json({ message: "Work order not found" });
          return;
        }
      } else {
        workOrder = await storage.getWorkOrder(id, callerCompanyIdWoPatch);
        if (!workOrder) {
          res.status(404).json({ message: "Work order not found" });
          return;
        }
      }

      // Task #224 — when photos change on a work order that's already linked
      // to an invoice, invalidate the cached invoice_pdfs row so the next view,
      // download, or send regenerates a fresh PDF that includes the new photos.
      if (
        workOrderData.photos !== undefined &&
        existingForLockCheck?.invoiceId
      ) {
        const cachedInvoicePdf = await storage.getInvoicePdfByInvoiceId(existingForLockCheck.invoiceId);
        if (cachedInvoicePdf) {
          await db.delete(invoicePdfs).where(eq(invoicePdfs.id, cachedInvoicePdf.id));
          console.log(
            `[AUDIT] invoice_pdf_invalidated reason=work_order_photos_patch ` +
            `workOrderId=${id} invoiceId=${existingForLockCheck.invoiceId} cachedPdfId=${cachedInvoicePdf.id}`
          );
        }
      }

      // Task #195: photo-after-billing audit. If this was a photos-only PATCH
      // applied to a work order that had already reached billing (status
      // `billed` / `approved_passed_to_billing`, or has an `invoiceId`),
      // record who added the late photo, when, and the prior + new arrays.
      if (isWoPhotosOnlyPatch && existingForLockCheck) {
        const wasAfterBilling =
          existingForLockCheck.status === 'billed' ||
          existingForLockCheck.status === 'approved_passed_to_billing' ||
          existingForLockCheck.invoiceId != null;
        if (wasAfterBilling) {
          const priorPhotos: string[] = Array.isArray(existingForLockCheck.photos)
            ? (existingForLockCheck.photos as string[])
            : [];
          const newPhotos: string[] = Array.isArray(req.body.photos) ? req.body.photos : [];
          const priorSet = new Set(priorPhotos);
          const newSet = new Set(newPhotos);
          const addedPhotos = newPhotos.filter((p) => !priorSet.has(p));
          const removedPhotos = priorPhotos.filter((p) => !newSet.has(p));
          if (addedPhotos.length > 0) {
            const actor = await resolvePhotoAuditActor(req);
            try {
              await storage.recordPhotoLateAddition({
                ticketType: 'work_order',
                ticketId: id,
                ticketNumber: existingForLockCheck.workOrderNumber ?? null,
                ticketStatusAtAddition: existingForLockCheck.status ?? null,
                invoiceIdAtAddition: existingForLockCheck.invoiceId ?? null,
                companyId: actor.companyId ?? null,
                actorUserId: actor.userId ?? null,
                actorName: actor.name ?? null,
                actorRole: actor.role ?? null,
                priorPhotos,
                newPhotos,
                addedPhotos,
                removedPhotos,
              });
            } catch (auditErr) {
              console.error('[AUDIT] photo_added_after_billing record failed for work order', id, auditErr);
            }
            console.log(
              `[AUDIT] photo_added_after_billing ticketType=work_order ticketId=${id} ` +
              `ticketNumber=${existingForLockCheck.workOrderNumber ?? '?'} ` +
              `status=${existingForLockCheck.status ?? '?'} ` +
              `invoiceId=${existingForLockCheck.invoiceId ?? 'null'} ` +
              `actor=${actor.userId ?? '?'} role=${actor.role ?? '?'} ` +
              `priorCount=${priorPhotos.length} newCount=${newPhotos.length} ` +
              `added=${addedPhotos.length} removed=${removedPhotos.length}`
            );
          }
        }
      }

      // Handle items if provided (delete-and-recreate pattern wrapped in a transaction)
      if (items !== undefined && Array.isArray(items)) {
        const countBefore = (await storage.getWorkOrderItems(id)).length;

        // Server-side authoritative pricing (Task #160): rewrite catalog line items
        // with the catalog price. Reject 4xx if a partId points at no part / wrong company.
        const woUpdateCompanyId = req.authenticatedUserCompanyId
          ?? (headerUserCompanyId(req)
            ? parseInt(headerUserCompanyId(req) as string)
            : null);
        const woUpdatePricing = await resolveAuthoritativePartPricing(items as RawBillingItem[], woUpdateCompanyId);
        if (woUpdatePricing.error) {
          res.status(woUpdatePricing.error.status).json({ message: woUpdatePricing.error.message });
          return;
        }
        const resolvedWoUpdateItems = (woUpdatePricing.items as RawBillingItem[]) ?? [];
        if (woUpdatePricing.auditedZeros.length > 0) {
          for (const drift of woUpdatePricing.auditedZeros) {
            console.log(
              `[AUDIT] work_order_update_price_corrected workOrderId=${id} partId=${drift.partId} ` +
              `partName="${drift.partName}" clientUnitPrice=${drift.clientUnitPrice.toFixed(2)} ` +
              `catalogUnitPrice=${drift.catalogUnitPrice.toFixed(2)}`
            );
          }
        }

        const itemsToInsert = resolvedWoUpdateItems.map((item: any) => {
          const qty = Number(item.quantity) || 0;
          const price = Number(item.unitPrice) || 0;
          const lineTotal = qty * price;
          return {
            workOrderId: id,
            partId: item.partId || null,
            partName: item.partName,
            partPrice: price.toString(),
            quantity: qty,
            laborHours: (Number(item.laborHours) || 0).toString(),
            totalPrice: lineTotal.toString(),
            notes: item.notes || null,
          };
        });
        await storage.replaceWorkOrderItemsInTransaction(id, itemsToInsert);
        const computedPartsCost = itemsToInsert.reduce((sum: number, i: any) => sum + Number(i.totalPrice), 0);
        await storage.updateWorkOrder(id, { totalPartsCost: computedPartsCost.toFixed(2) });
        console.log(`[AUDIT] work_order_items_replaced workOrderId=${id} countBefore=${countBefore} countAfter=${resolvedWoUpdateItems.length}`);

        await regressionGuardZeroCatalogPrices('work_order_conversion', id, resolvedWoUpdateItems);
      }

      // Recompute financial totals if financial inputs were touched (totalHours, totalPartsCost, items)
      const financialFieldsTouched = 'totalHours' in workOrderData || 'totalPartsCost' in workOrderData || (items !== undefined && Array.isArray(items));
      if (financialFieldsTouched) {
        const freshWo = await storage.getWorkOrder(id, callerCompanyIdWoPatch);
        if (freshWo && freshWo.appliedLaborRate) {
          // Use the work order's own snapshotted labor rate — never the live customer record.
          const snappedLaborRate = parseFloat(freshWo.appliedLaborRate);
          const hrs = parseFloat(freshWo.totalHours || '0');
          const parts = parseFloat(freshWo.totalPartsCost || '0');
          const recomputedLaborSubtotal = hrs * snappedLaborRate;
          const recomputedPartsSubtotal = parts;
          const recomputedTotal = recomputedLaborSubtotal + recomputedPartsSubtotal;
          workOrder = await storage.updateWorkOrder(id, {
            laborSubtotal: recomputedLaborSubtotal.toFixed(2),
            partsSubtotal: recomputedPartsSubtotal.toFixed(2),
            totalAmount: recomputedTotal.toFixed(2),
          }) || workOrder;
        }
      }

      // Task #207 — removed dead submission guard that checked for legacy
      // 'submitted'/'approved' work-order statuses. Neither value is valid
      // under workOrderStatusValues, so the branch was unreachable.

      // Task #641 — audit any status change applied via PATCH so the
      // Activity tab shows the full lifecycle, not just the dedicated
      // transition endpoints. Only emits when status actually changed.
      if (
        workOrderData.status !== undefined &&
        existingForLockCheck &&
        workOrder &&
        existingForLockCheck.status !== workOrder.status
      ) {
        await recordLifecycleAudit(req, {
          resource: "work_order",
          action: "work_order.status_changed",
          targetId: id,
          before: { status: existingForLockCheck.status },
          after: { status: workOrder.status },
          summary: `Work order ${workOrder.workOrderNumber} status ${existingForLockCheck.status} → ${workOrder.status}`,
        });
      }

      res.json(workOrder);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid work order data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to update work order" });
    }
  });

  app.delete("/api/work-orders/bulk", requireAuthentication, requireWorkOrderBillingAccess, async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ message: "ids must be a non-empty array of numbers" });
        return;
      }
      const validIds = ids.filter((id: any) => typeof id === 'number' && id > 0);
      if (validIds.length === 0) {
        res.status(400).json({ message: "No valid IDs provided" });
        return;
      }
      let deleted = 0;
      const skipped: number[] = [];
      for (const id of validIds) {
        const invoiced = await storage.hasInvoiceItems(id);
        if (invoiced) {
          skipped.push(id);
          continue;
        }
        const bulkDelCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
        const woBefore = await storage.getWorkOrder(id, bulkDelCompanyId);
        await storage.deleteWorkOrderItems(id);
        const success = await storage.deleteWorkOrder(id);
        if (success) {
          deleted++;
          await recordLifecycleAudit(req, {
            resource: "work_order",
            action: "work_order.deleted",
            targetId: id,
            before: { status: woBefore?.status, workOrderNumber: woBefore?.workOrderNumber },
            after: { deleted: true },
            summary: `Work order ${woBefore?.workOrderNumber ?? id} deleted (bulk)`,
          });
        }
      }
      if (skipped.length > 0 && deleted === 0) {
        res.status(409).json({ message: "These work orders are linked to invoices and cannot be deleted. Remove them from their invoices first." });
        return;
      }
      const skipMessage = skipped.length > 0
        ? `${skipped.length} work order(s) could not be deleted because they are linked to invoices. Remove them from their invoices first.`
        : undefined;
      res.json({ deleted, skipped, skipMessage });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to bulk delete work orders" });
    }
  });

  app.delete("/api/work-orders/:id", requireAuthentication, requireSameCompanyAsWorkOrder, requireWorkOrderBillingAccess, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      // Validate work order ID is a valid number
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }
      const invoiced = await storage.hasInvoiceItems(id);
      if (invoiced) {
        res.status(409).json({ message: "This work order is linked to an invoice and cannot be deleted. Remove it from the invoice first." });
        return;
      }
      const singleDelCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const woBefore = await storage.getWorkOrder(id, singleDelCompanyId);
      await storage.deleteWorkOrderItems(id);
      const success = await storage.deleteWorkOrder(id);
      if (!success) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }
      await recordLifecycleAudit(req, {
        resource: "work_order",
        action: "work_order.deleted",
        targetId: id,
        before: { status: woBefore?.status, workOrderNumber: woBefore?.workOrderNumber },
        after: { deleted: true },
        summary: `Work order ${woBefore?.workOrderNumber ?? id} deleted`,
      });
      res.json({ message: "Work order deleted successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to delete work order" });
    }
  });

  // Work Order Items routes
  // Note: Pricing fields are stripped for field_tech role via applyPricingVisibility
  app.get("/api/work-orders/:id/items", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const workOrderId = parseInt(req.params.id);
      
      // Validate work order ID is a valid number
      if (isNaN(workOrderId) || workOrderId <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }
      const items = await storage.getWorkOrderItems(workOrderId);
      // Strip pricing fields for field technicians
      res.json(applyPricingVisibility(req, items));
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch work order items" });
    }
  });

  app.post("/api/work-orders/:id/items", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const workOrderId = parseInt(req.params.id);
      
      // Validate work order ID is a valid number
      if (isNaN(workOrderId) || workOrderId <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }

      // Server-side authoritative pricing (Task #160): if the body references a
      // catalog partId, overwrite partPrice from the catalog (and 4xx if invalid).
      const woItemCompanyId = req.authenticatedUserCompanyId
        ?? (headerUserCompanyId(req)
          ? parseInt(headerUserCompanyId(req) as string)
          : null);
      // The work-order-item shape uses `partPrice` not `unitPrice`; map both ways.
      const probeItem: RawBillingItem = {
        partId: req.body.partId ?? null,
        partName: req.body.partName,
        quantity: req.body.quantity,
        unitPrice: req.body.unitPrice ?? req.body.partPrice ?? 0,
      };
      const itemPricing = await resolveAuthoritativePartPricing([probeItem], woItemCompanyId);
      if (itemPricing.error) {
        res.status(itemPricing.error.status).json({ message: itemPricing.error.message });
        return;
      }
      const resolvedSingle = (itemPricing.items as RawBillingItem[] | undefined)?.[0] ?? probeItem;
      if (itemPricing.auditedZeros.length > 0) {
        const drift = itemPricing.auditedZeros[0];
        console.log(
          `[AUDIT] work_order_item_add_price_corrected workOrderId=${workOrderId} partId=${drift.partId} ` +
          `partName="${drift.partName}" clientUnitPrice=${drift.clientUnitPrice.toFixed(2)} ` +
          `catalogUnitPrice=${drift.catalogUnitPrice.toFixed(2)}`
        );
      }
      // Apply the resolved pricing back into the request body before parsing.
      const resolvedPrice = Number(resolvedSingle.unitPrice ?? 0);
      const resolvedBody = {
        ...req.body,
        partPrice: resolvedPrice.toString(),
        totalPrice: ((Number(req.body.quantity) || 0) * resolvedPrice).toString(),
      };

      const itemData = insertWorkOrderItemSchema.parse({
        ...resolvedBody,
        workOrderId
      });
      const item = await storage.addWorkOrderItem(itemData);
      await regressionGuardZeroCatalogPrices('work_order_conversion', workOrderId, [resolvedSingle]);

      // Recompute financial totals using stored applied rates (if available).
      // This ensures parts additions after completion keep the snapshot consistent.
      const wo = await storage.getWorkOrder(workOrderId, woItemCompanyId);
      if (wo && wo.appliedLaborRate) {
        const snappedLaborRate = parseFloat(wo.appliedLaborRate);
        // Recompute totalPartsCost from all items, then derive full breakdown
        const allItems = await storage.getWorkOrderItems(workOrderId);
        const newPartsCost = allItems.reduce(
          (sum, i) => sum + (Number(i.quantity) || 0) * (Number(i.partPrice) || 0),
          0,
        );
        const hrs = parseFloat(wo.totalHours || '0');
        const recomputedLaborSubtotal = hrs * snappedLaborRate;
        const recomputedPartsSubtotal = newPartsCost;
        const recomputedTotal = recomputedLaborSubtotal + recomputedPartsSubtotal;
        await storage.updateWorkOrder(workOrderId, {
          totalPartsCost: newPartsCost.toFixed(2),
          laborSubtotal: recomputedLaborSubtotal.toFixed(2),
          partsSubtotal: recomputedPartsSubtotal.toFixed(2),
          totalAmount: recomputedTotal.toFixed(2),
        });
      }

      res.status(201).json(item);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid work order item data", errors: error.issues });
        return;
      }
      res.status(500).json({ message: "Failed to add work order item" });
    }
  });

  // Work Order Assignment with Notification
  app.post("/api/work-orders/:id/assign", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const workOrderId = parseInt(req.params.id);
      
      // Validate work order ID is a valid number
      if (isNaN(workOrderId) || workOrderId <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }
      const { technicianId, technicianName } = req.body;
      
      const assignCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const woBeforeAssign = await storage.getWorkOrder(workOrderId, assignCompanyId);
      const success = await storage.assignWorkOrder(workOrderId, technicianId, technicianName);
      if (!success) {
        res.status(404).json({ message: "Work order not found or assignment failed" });
        return;
      }

      // Get work order details for notification
      const workOrder = await storage.getWorkOrder(workOrderId, assignCompanyId);

      await recordLifecycleAudit(req, {
        resource: "work_order",
        action: "work_order.assigned",
        targetId: workOrderId,
        before: {
          assignedTechnicianId: woBeforeAssign?.assignedTechnicianId ?? null,
          assignedTechnicianName: woBeforeAssign?.assignedTechnicianName ?? null,
        },
        after: { assignedTechnicianId: technicianId ?? null, assignedTechnicianName: technicianName ?? null },
        summary: `Work order ${workOrder?.workOrderNumber ?? workOrderId} assigned to ${technicianName ?? technicianId}`,
      });
      if (workOrder && technicianId) {
        // Notify field technician about work order assignment
        await storage.createNotification({
          userId: technicianId,
          type: "work_order_assigned",
          title: "New Work Order Assigned",
          message: `You have been assigned work order ${workOrder.workOrderNumber} for ${workOrder.projectName || 'irrigation project'}.`,
          relatedEntityType: "work_order",
          relatedEntityId: workOrderId
        });
      }
      
      res.json({ message: "Work order assigned successfully" });
    } catch (error) {
      console.error("Error assigning work order:", error);
      res.status(500).json({ message: "Failed to assign work order" });
    }
  });

  // Get billing sheet items
  app.get("/api/billing-sheets/:id/items", requireAuthentication, requireSameCompanyAsBillingSheet, async (req, res) => {
    try {
      const billingSheetId = parseInt(req.params.id);
      
      // Validate billing sheet ID is a valid number
      if (isNaN(billingSheetId) || billingSheetId <= 0) {
        res.status(400).json({ message: "Invalid billing sheet ID" });
        return;
      }
      const items = await storage.getBillingSheetItems(billingSheetId);
      res.json(items);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch billing sheet items" });
    }
  });

  // Task #752 (WC Billing Slice 3) — zone-grouped wet-check billing view
  // Returns the WetCheckBillingView for billing sheets backed by a wet check.
  // 404 — billing sheet not found
  // 422 — billing sheet exists but has no wet-check findings (not a WC sheet)
  // 200 — the zone-grouped view payload
  app.get("/api/billing-sheets/:id/wet-check-view", requireAuthentication, requireSameCompanyAsBillingSheet, async (req, res) => {
    try {
      const billingSheetId = parseInt(req.params.id);
      if (isNaN(billingSheetId) || billingSheetId <= 0) {
        res.status(400).json({ message: "Invalid billing sheet ID" });
        return;
      }

      // Verify the sheet exists before delegating to storage
      const callerCompanyId12330 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const bs = await storage.getBillingSheetById(billingSheetId, callerCompanyId12330);
      if (!bs) {
        res.status(404).json({ message: "Billing sheet not found" });
        return;
      }

      const companyId: number | null =
        typeof (req as any).authenticatedUserCompanyId === "number"
          ? (req as any).authenticatedUserCompanyId
          : null;

      const view = await storage.getBillingSheetWetCheckView(billingSheetId, companyId);
      if (view === null) {
        res.status(422).json({ message: "This billing sheet is not linked to a wet check inspection" });
        return;
      }

      // Strip pricing fields for field technicians (matches the same visibility
      // contract as GET /api/billing-sheets/:id — field_tech callers cannot see
      // labor rate, parts/labor subtotals, or grand total).
      res.json(applyPricingVisibility(req, view));
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch wet-check billing view" });
    }
  });

  // ─── Catalog $0-price audit / backfill (Task #160) ────────────────────────
  // Authorization: only company_admin / billing_manager / super_admin can
  // see or repair these rows. We trust ONLY the fields populated by the
  // `requireAuthentication` middleware — never raw `x-user-*` headers — so a
  // caller cannot spoof admin access by setting headers themselves.
  async function getAuditActor(req: any): Promise<{ userId: number | null; role: string | null; companyId: number | null; name: string | null }> {
    const userId: number | null = typeof req.authenticatedUserId === 'number' ? req.authenticatedUserId : null;
    const role: string | null = (req.authenticatedUserRole as string) ?? null;
    const companyId: number | null = typeof req.authenticatedUserCompanyId === 'number' ? req.authenticatedUserCompanyId : null;
    let name: string | null = null;
    if (userId != null) {
      try {
        const u = await storage.getUser(userId);
        name = u?.name ?? u?.username ?? null;
      } catch {
        name = null;
      }
    }
    return { userId, role, companyId, name };
  }
  function isAuditAdmin(role: string | null): boolean {
    return role === 'company_admin' || role === 'billing_manager' || role === 'super_admin';
  }

  // Photos-only PATCH paths use `requireWorkOrderUpdateAccess` /
  // `requireBillingSheetUpdateAccess`, which intentionally do not run the full
  // `requireAuthentication` chain — so `req.authenticatedUserId/Role/CompanyId`
  // can be undefined even on legitimate requests. Fall back to the same
  // x-user-* headers the photos-only access middlewares already trust so the
  // late-addition audit row is correctly attributed instead of NULL.
  async function resolvePhotoAuditActor(req: any): Promise<{ userId: number | null; role: string | null; companyId: number | null; name: string | null }> {
    const fromAuth = await getAuditActor(req);
    let userId = fromAuth.userId;
    let role = fromAuth.role;
    let companyId = fromAuth.companyId;
    if (userId == null) {
      const raw = headerUserId(req);
      const parsed = raw != null ? Number(raw) : NaN;
      if (Number.isFinite(parsed)) userId = parsed;
    }
    if (!role) {
      const raw = headerUserRole(req);
      if (typeof raw === 'string' && raw.length > 0) role = raw;
    }
    if (companyId == null) {
      const raw = headerUserCompanyId(req);
      const parsed = raw != null ? Number(raw) : NaN;
      if (Number.isFinite(parsed)) companyId = parsed;
    }
    let name: string | null = fromAuth.name;
    if (!name && userId != null) {
      try {
        const u = await storage.getUser(userId);
        name = u?.name ?? u?.username ?? null;
        if (companyId == null && typeof u?.companyId === 'number') companyId = u.companyId;
      } catch {
        // best-effort; leave name null
      }
    }
    return { userId, role, companyId, name };
  }

  app.get("/api/admin/billing-sheets/zero-price-audit", requireAuthentication, async (req: any, res) => {
    try {
      const actor = await getAuditActor(req);
      if (!isAuditAdmin(actor.role)) {
        res.status(403).json({ message: "Access denied. Admin or billing manager role required." });
        return;
      }
      // super_admin can scope to a specific company via ?companyId=, or pass companyId=all to see everything
      let scopeCompanyId: number | null = actor.companyId;
      if (actor.role === 'super_admin') {
        const q = req.query.companyId;
        if (q === 'all') {
          scopeCompanyId = null;
        } else if (q) {
          scopeCompanyId = parseInt(q as string);
        }
      }
      const rows = await storage.getZeroPriceCatalogItems(scopeCompanyId);
      res.json({ companyId: scopeCompanyId, count: rows.length, rows });
    } catch (error) {
      console.error("[zero-price-audit] failed:", error);
      res.status(500).json({ message: "Failed to load zero-price audit" });
    }
  });

  app.post("/api/admin/billing-sheets/zero-price-audit/repair", requireAuthentication, async (req: any, res) => {
    try {
      const actor = await getAuditActor(req);
      if (!isAuditAdmin(actor.role)) {
        res.status(403).json({ message: "Access denied. Admin or billing manager role required." });
        return;
      }
      const body = req.body || {};
      // Accept either:
      //   - body.selection: [{ source: 'billing_sheet'|'work_order'|'invoice', itemId: number }, ...]
      //   - body.itemIds: [number, ...] (legacy shape, treated as billing_sheet)
      // An empty selection means "repair every bad row in scope" — dry-run defaults
      // to true for safety.
      let selection: Array<{ source: 'billing_sheet' | 'work_order' | 'invoice'; itemId: number }> = [];
      if (Array.isArray(body.selection)) {
        selection = body.selection
          .map((s: any) => {
            const raw = s?.source;
            const source: 'billing_sheet' | 'work_order' | 'invoice' =
              raw === 'work_order' ? 'work_order'
              : raw === 'invoice' ? 'invoice'
              : 'billing_sheet';
            return { source, itemId: Number(s?.itemId) };
          })
          .filter((s: { source: string; itemId: number }) => Number.isFinite(s.itemId));
      } else if (Array.isArray(body.itemIds)) {
        selection = body.itemIds
          .map((n: unknown) => ({ source: 'billing_sheet' as const, itemId: Number(n) }))
          .filter((s: { itemId: number }) => Number.isFinite(s.itemId));
      }
      const dryRun = body.dryRun !== false; // default to dry-run for safety

      // super_admin may target a specific company (or "all")
      let scopeCompanyId: number | null = actor.companyId;
      if (actor.role === 'super_admin' && body.companyId !== undefined) {
        scopeCompanyId = body.companyId === 'all' ? null : Number(body.companyId);
      }

      const result = await storage.repriceBillingSheetItems(selection, scopeCompanyId, {
        dryRun,
        performedByUserId: actor.userId,
        performedByName: actor.name,
      });

      console.log(
        `[AUDIT] zero_price_audit_repair_invoked actor=${actor.userId ?? '?'} role=${actor.role} ` +
        `companyId=${scopeCompanyId ?? 'all'} dryRun=${dryRun} parentCount=${result.parentCount} ` +
        `itemCount=${result.itemCount} totalDifference=${result.totalDifference}`
      );

      if (!dryRun) {
        void recordAuditEvent(req, {
          actorUserId: actor.userId,
          actorLabel: actor.name,
          actorRole: actor.role,
          actorCompanyId: scopeCompanyId,
          actionType: 'data',
          action: 'zero_price_audit_repair',
          severity: 'warning',
          targetType: 'billing_sheet',
          targetId: null,
          summary: `Repaired ${result.itemCount} zero-price items across ${result.parentCount} records`,
          details: {
            companyId: scopeCompanyId,
            parentCount: result.parentCount,
            itemCount: result.itemCount,
            totalDifference: result.totalDifference,
          },
        });
      }

      res.json(result);
    } catch (error) {
      console.error("[zero-price-audit/repair] failed:", error);
      res.status(500).json({ message: "Failed to repair zero-price items" });
    }
  });
  // ─── /Catalog $0-price audit / backfill ───────────────────────────────────

  // ─── Labor Rate Mismatch audit (Task #200) ────────────────────────────────
  // Lists every un-invoiced WO + BS whose stored labor rate no longer
  // matches the customer's current standard or emergency rate, and lets an
  // admin re-price selected tickets in place. Mirrors the auth, scoping and
  // request/response conventions of the catalog $0-price audit above.
  app.get("/api/admin/labor-rate-audit", requireAuthentication, async (req: any, res) => {
    try {
      const actor = await getAuditActor(req);
      if (!isAuditAdmin(actor.role)) {
        res.status(403).json({ message: "Access denied. Admin or billing manager role required." });
        return;
      }
      let scopeCompanyId: number | null = actor.companyId;
      if (actor.role === 'super_admin') {
        const q = req.query.companyId;
        if (q === 'all') {
          scopeCompanyId = null;
        } else if (q) {
          scopeCompanyId = parseInt(q as string);
        }
      }
      const rows = await storage.getLaborRateMismatchTickets(scopeCompanyId);
      res.json({ companyId: scopeCompanyId, count: rows.length, rows });
    } catch (error) {
      console.error("[labor-rate-audit] failed:", error);
      res.status(500).json({ message: "Failed to load labor rate audit" });
    }
  });

  app.post("/api/admin/labor-rate-audit/repair", requireAuthentication, async (req: any, res) => {
    try {
      const actor = await getAuditActor(req);
      if (!isAuditAdmin(actor.role)) {
        res.status(403).json({ message: "Access denied. Admin or billing manager role required." });
        return;
      }
      const body = req.body || {};
      let selection: Array<{ source: 'work_order' | 'billing_sheet'; parentId: number; classification: 'standard' | 'emergency' }> = [];
      if (Array.isArray(body.selection)) {
        selection = body.selection
          .map((s: any) => {
            const rawSource = s?.source;
            const source: 'work_order' | 'billing_sheet' =
              rawSource === 'work_order' ? 'work_order' : 'billing_sheet';
            const rawClass = s?.classification;
            const classification: 'standard' | 'emergency' =
              rawClass === 'emergency' ? 'emergency' : 'standard';
            return { source, parentId: Number(s?.parentId), classification };
          })
          .filter((s: { parentId: number }) => Number.isFinite(s.parentId));
      }
      const dryRun = body.dryRun !== false; // default to dry-run for safety

      let scopeCompanyId: number | null = actor.companyId;
      if (actor.role === 'super_admin' && body.companyId !== undefined) {
        scopeCompanyId = body.companyId === 'all' ? null : Number(body.companyId);
      }

      const result = await storage.repriceLaborRateMismatches(selection, scopeCompanyId, {
        dryRun,
        performedByUserId: actor.userId,
        performedByName: actor.name,
      });

      console.log(
        `[AUDIT] labor_rate_audit_repair_invoked actor=${actor.userId ?? '?'} role=${actor.role} ` +
        `companyId=${scopeCompanyId ?? 'all'} dryRun=${dryRun} parentCount=${result.parentCount} ` +
        `totalDifference=${result.totalDifference} skipped=${result.skipped.length}`
      );

      res.json(result);
    } catch (error) {
      console.error("[labor-rate-audit/repair] failed:", error);
      res.status(500).json({ message: "Failed to repair labor rate mismatches" });
    }
  });
  // ─── /Labor Rate Mismatch audit ───────────────────────────────────────────

  // ─── Pricing audit event history (Task #212) ─────────────────────────────
  // Read-only endpoint that returns the structured history of automatic
  // reprice events for a given billing sheet or work order. Visible to
  // managers and admins only — field techs cannot see pricing data anywhere
  // in the app and so are explicitly blocked here too. Mirrors the auth
  // shape used by the /admin/* audit endpoints above.
  function isPricingHistoryViewer(role: string | null): boolean {
    return role === 'company_admin'
      || role === 'super_admin'
      || role === 'billing_manager'
      || role === 'irrigation_manager';
  }

  async function pricingHistoryHandler(
    req: any,
    res: any,
    source: 'billing_sheet' | 'work_order',
  ) {
    try {
      const role: string | null = (req.authenticatedUserRole as string) ?? null;
      if (!isPricingHistoryViewer(role)) {
        res.status(403).json({
          message: "Access denied. Manager or admin role required to view pricing history.",
        });
        return;
      }
      const parentId = parseInt(req.params.id);
      if (!Number.isFinite(parentId)) {
        res.status(400).json({ message: "Invalid id" });
        return;
      }

      // Scope the lookup to the user's company so a manager from company A
      // cannot read events for a parent owned by company B.
      const scopeCompanyId: number | null = typeof req.authenticatedUserCompanyId === 'number'
        ? req.authenticatedUserCompanyId
        : null;
      if (role !== 'super_admin') {
        // Non-super-admin callers MUST have a company on their session.
        if (scopeCompanyId == null) {
          res.status(403).json({ message: "Access denied" });
          return;
        }
        if (source === 'billing_sheet') {
          const sheet = await storage.getBillingSheetById(parentId, role === 'super_admin' ? null : scopeCompanyId);
          if (!sheet) { res.status(404).json({ message: "Billing sheet not found" }); return; }
          // If the sheet has no customer linkage, ownership cannot be proven —
          // deny rather than fall through to an unscoped read.
          if (!sheet.customerId) {
            res.status(403).json({ message: "Access denied" });
            return;
          }
          const cust = await storage.getCustomer(sheet.customerId);
          if (!cust || cust.companyId !== scopeCompanyId) {
            res.status(403).json({ message: "Access denied" });
            return;
          }
        } else {
          const wo = await storage.getWorkOrder(parentId, role === 'super_admin' ? null : scopeCompanyId);
          if (!wo) { res.status(404).json({ message: "Work order not found" }); return; }
          if (!wo.customerId) {
            res.status(403).json({ message: "Access denied" });
            return;
          }
          const cust = await storage.getCustomer(wo.customerId);
          if (!cust || cust.companyId !== scopeCompanyId) {
            res.status(403).json({ message: "Access denied" });
            return;
          }
        }
      }

      // Defense-in-depth: also pass the company filter into the data layer so
      // a missed route guard can never leak cross-company events.
      const events = await storage.getPricingAuditEvents(
        source,
        parentId,
        role === 'super_admin' ? null : scopeCompanyId,
      );
      res.json({ source, parentId, count: events.length, events });
    } catch (error) {
      console.error(`[pricing-audit-history:${source}] failed:`, error);
      res.status(500).json({ message: "Failed to load pricing audit history" });
    }
  }

  app.get(
    "/api/billing-sheets/:id/pricing-audit-events",
    requireAuthentication,
    requireSameCompanyAsBillingSheet,
    async (req: any, res) => pricingHistoryHandler(req, res, 'billing_sheet'),
  );
  app.get(
    "/api/work-orders/:id/pricing-audit-events",
    requireAuthentication,
    requireSameCompanyAsWorkOrder,
    async (req: any, res) => pricingHistoryHandler(req, res, 'work_order'),
  );
  // ─── /Pricing audit event history ────────────────────────────────────────

  // ─── Photo late-addition audit history (Task #195) ───────────────────────
  // Read-only endpoint that returns the audit trail of photos added to a
  // ticket AFTER it reached billing. Visible to managers and admins only.
  function isPhotoLateAdditionViewer(role: string | null): boolean {
    return role === 'company_admin'
      || role === 'super_admin'
      || role === 'billing_manager'
      || role === 'irrigation_manager';
  }

  async function photoLateAdditionsHandler(
    req: any,
    res: any,
    ticketType: 'work_order' | 'billing_sheet',
  ) {
    try {
      const role: string | null = (req.authenticatedUserRole as string) ?? null;
      if (!isPhotoLateAdditionViewer(role)) {
        res.status(403).json({
          message: "Access denied. Manager or admin role required to view the photo audit trail.",
        });
        return;
      }
      const ticketId = parseInt(req.params.id);
      if (!Number.isFinite(ticketId)) {
        res.status(400).json({ message: "Invalid id" });
        return;
      }

      // Cross-company guard mirroring the pricing-audit history endpoint.
      const scopeCompanyId: number | null = typeof req.authenticatedUserCompanyId === 'number'
        ? req.authenticatedUserCompanyId
        : null;
      if (role !== 'super_admin') {
        if (scopeCompanyId == null) {
          res.status(403).json({ message: "Access denied" });
          return;
        }
        if (ticketType === 'billing_sheet') {
          const sheet = await storage.getBillingSheetById(ticketId, role === 'super_admin' ? null : scopeCompanyId);
          if (!sheet) { res.status(404).json({ message: "Billing sheet not found" }); return; }
          if (!sheet.customerId) {
            res.status(403).json({ message: "Access denied" });
            return;
          }
          const cust = await storage.getCustomer(sheet.customerId);
          if (!cust || cust.companyId !== scopeCompanyId) {
            res.status(403).json({ message: "Access denied" });
            return;
          }
        } else {
          const wo = await storage.getWorkOrder(ticketId, role === 'super_admin' ? null : scopeCompanyId);
          if (!wo) { res.status(404).json({ message: "Work order not found" }); return; }
          if (!wo.customerId) {
            res.status(403).json({ message: "Access denied" });
            return;
          }
          const cust = await storage.getCustomer(wo.customerId);
          if (!cust || cust.companyId !== scopeCompanyId) {
            res.status(403).json({ message: "Access denied" });
            return;
          }
        }
      }

      const events = await storage.getPhotoLateAdditions(
        ticketType,
        ticketId,
        role === 'super_admin' ? null : scopeCompanyId,
      );
      res.json({ ticketType, ticketId, count: events.length, events });
    } catch (error) {
      console.error(`[photo-late-additions:${ticketType}] failed:`, error);
      res.status(500).json({ message: "Failed to load photo audit trail" });
    }
  }

  app.get(
    "/api/billing-sheets/:id/photo-late-additions",
    requireAuthentication,
    requireSameCompanyAsBillingSheet,
    async (req: any, res) => photoLateAdditionsHandler(req, res, 'billing_sheet'),
  );
  app.get(
    "/api/work-orders/:id/photo-late-additions",
    requireAuthentication,
    requireSameCompanyAsWorkOrder,
    async (req: any, res) => photoLateAdditionsHandler(req, res, 'work_order'),
  );
  // ─── /Photo late-addition audit history ──────────────────────────────────

  // Billing Sheet routes
  app.post("/api/work-orders/:id/billing-sheet", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const workOrderId = parseInt(req.params.id);
      
      // Validate work order ID is a valid number
      if (isNaN(workOrderId) || workOrderId <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }

      // Fetch the work order to enrich billing sheet with required fields
      const bsCreateCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const workOrder = await storage.getWorkOrder(workOrderId, bsCreateCompanyId);
      if (!workOrder) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }

      // Branch enforcement: the work order must have a branchName if its customer has branches
      if (workOrder.customerId) {
        const customer = await storage.getCustomer(workOrder.customerId);
        if (customer && Array.isArray(customer.branches) && customer.branches.length > 0) {
          // Accept branchName from the request body (tech may be selecting it now) or already set on the work order
          const effectiveBranch = req.body.branchName || workOrder.branchName;
          if (!effectiveBranch || String(effectiveBranch).trim() === '') {
            res.status(400).json({ message: "Branch is required for this customer. Please select a branch before submitting." });
            return;
          }
        }
      }

      const { techName, workPerformed, additionalNotes, totalPartsCost, arrivalPhoto, finishedPhoto, actualStartTime, actualEndTime, materialItems, laborItems, additionalCharges, technicianNotes, laborRate: formLaborRate, aiInputs: reqAiInputs, aiShortDescription, aiDetailedDescription, ...rest } = req.body;

      // Manager-class roles (irrigation_manager, billing_manager, company_admin,
      // super_admin) self-approve at conversion time and route directly to
      // 'approved_passed_to_billing' so the resulting billing sheet immediately
      // surfaces in the customer's Ready-to-Invoice list (Task #206).
      const creatorRole = req.authenticatedUserRole || headerUserRole(req);
      let resolvedStatus: BillingSheetStatus;
      if (
        creatorRole === 'irrigation_manager' ||
        creatorRole === 'billing_manager' ||
        creatorRole === 'company_admin' ||
        creatorRole === 'super_admin'
      ) {
        resolvedStatus = 'approved_passed_to_billing';
      } else if (creatorRole === 'field_tech') {
        resolvedStatus = 'submitted';
      } else {
        resolvedStatus = 'draft';
      }

      const totalHoursVal = workOrder.totalHours ?? "0";
      // Always look up the customer's authoritative labor rate — fail fast if unavailable.
      if (!workOrder.customerId) {
        res.status(400).json({ message: "Work order has no associated customer. Cannot determine labor rate." });
        return;
      }
      const woCustomerForRate = await storage.getCustomer(workOrder.customerId);
      if (!woCustomerForRate) {
        res.status(400).json({ message: "Customer not found. Cannot determine labor rate." });
        return;
      }
      if (!woCustomerForRate.laborRate || parseFloat(woCustomerForRate.laborRate) <= 0) {
        res.status(400).json({ message: `Customer "${woCustomerForRate.name}" does not have a labor rate configured. Please set a labor rate on the customer record before converting to a billing sheet.` });
        return;
      }
      const laborRateVal = parseFloat(woCustomerForRate.laborRate).toFixed(2);
      const laborSubtotalVal = (parseFloat(String(totalHoursVal)) * parseFloat(String(laborRateVal))).toFixed(2);
      const partsSubtotalVal = parseFloat(String(totalPartsCost || "0")).toFixed(2);
      const totalAmount = (parseFloat(laborSubtotalVal) + parseFloat(partsSubtotalVal)).toFixed(2);

      type RawLineItem = {
        partId?: number | null;
        partName?: string;
        partDescription?: string | null;
        description?: string;
        quantity?: number | string;
        unitPrice?: number | string;
        partPrice?: number | string;
        laborHours?: number | string;
        notes?: string | null;
      };

      type ResolvedBillingItem = {
        partId?: number | null;
        partName: string;
        partDescription?: string | null;
        quantity: string;
        unitPrice: string;
        totalPrice: string;
        laborHours: string;
        notes?: string | null;
      };

      const mapRawLineItem = (item: RawLineItem): ResolvedBillingItem => {
        const qty = Number(item.quantity) || 0;
        const price = Number(item.unitPrice) || Number(item.partPrice) || 0;
        return {
          partId: item.partId ?? null,
          partName: item.partName || item.description || "Part",
          partDescription: item.partDescription || item.description || null,
          quantity: qty.toString(),
          unitPrice: price.toString(),
          totalPrice: (qty * price).toFixed(2),
          laborHours: (Number(item.laborHours) || 0).toString(),
          notes: item.notes ?? null,
        };
      };

      // Build billing sheet items from materialItems and laborItems in the request body.
      // Fall back to work_order_items if no items were provided in this request.
      let resolvedItems: ResolvedBillingItem[] = [];

      const rawMaterialItems: RawLineItem[] = Array.isArray(materialItems) ? materialItems : [];
      const rawLaborItems: RawLineItem[] = Array.isArray(laborItems) ? laborItems : [];
      const rawRequestItems = [...rawMaterialItems, ...rawLaborItems];

      // Server-side authoritative pricing (Task #160): rewrite catalog line item
      // unit prices from the catalog before persisting. 4xx-reject if a partId
      // points at no part / wrong company.
      const woCompanyIdForPricing = req.authenticatedUserCompanyId
        ?? (headerUserCompanyId(req)
          ? parseInt(headerUserCompanyId(req) as string)
          : (woCustomerForRate.companyId ?? null));
      const woPricingResult = await resolveAuthoritativePartPricing(rawRequestItems as RawBillingItem[], woCompanyIdForPricing);
      if (woPricingResult.error) {
        res.status(woPricingResult.error.status).json({ message: woPricingResult.error.message });
        return;
      }
      const resolvedRequestItems = (woPricingResult.items as RawLineItem[] | undefined) ?? rawRequestItems;
      if (woPricingResult.auditedZeros.length > 0) {
        for (const drift of woPricingResult.auditedZeros) {
          console.log(
            `[AUDIT] work_order_conversion_price_corrected workOrderId=${workOrderId} partId=${drift.partId} ` +
            `partName="${drift.partName}" clientUnitPrice=${drift.clientUnitPrice.toFixed(2)} ` +
            `catalogUnitPrice=${drift.catalogUnitPrice.toFixed(2)}`
          );
        }
      }

      if (resolvedRequestItems.length > 0) {
        resolvedItems = resolvedRequestItems.map(mapRawLineItem);
      } else {
        // Fall back to items already saved on the work order
        const workOrderItemsList = await storage.getWorkOrderItems(workOrderId);
        if (workOrderItemsList.length > 0) {
          resolvedItems = await Promise.all(workOrderItemsList.map(async (item) => {
            let unitPrice = parseFloat(item.partPrice ?? '0');
            // If the work order item has a $0 price but a valid partId, look up the current catalog price
            if (unitPrice === 0 && item.partId) {
              const catalogPart = await storage.getPart(item.partId);
              if (catalogPart && parseFloat(catalogPart.price) > 0) {
                unitPrice = parseFloat(catalogPart.price);
              }
            }
            const qty = parseFloat(String(item.quantity) ?? '0');
            return {
              partId: item.partId || null,
              partName: item.partName,
              partDescription: null,
              quantity: String(item.quantity),
              unitPrice: unitPrice.toString(),
              totalPrice: (money(qty) * money(unitPrice)).toFixed(2),
              laborHours: item.laborHours,
              notes: item.notes || null,
            };
          }));
        }
      }

      const workOrderSourceItemCount = (await storage.getWorkOrderItems(workOrderId)).length;
      // Use branchName from request body (tech may have selected it) or fall back to the work order's stored branch
      const effectiveBranchName = req.body.branchName || workOrder.branchName || null;
      // Slice 4a: companyId is transitionally nullable in schema.ts; assert it is
      // populated (the migration admin page ensures this at the DB level).
      assertCompanyId(workOrder, `work order ${workOrderId} → create billing sheet`);
      const newBillingSheet = await storage.createBillingSheet({
        technicianName: techName || workOrder.assignedTechnicianName || "",
        workDescription: workPerformed || "",
        customerName: workOrder.customerName,
        propertyAddress: workOrder.projectAddress || "",
        customerId: workOrder.customerId,
        companyId: workOrder.companyId,
        // Task #488 (M3) — canonical link back to the parent WO so the
        // mobile detail screen can list attached billing sheets.
        workOrderId,
        totalHours: totalHoursVal,
        laborRate: laborRateVal,
        laborSubtotal: laborSubtotalVal,
        partsSubtotal: partsSubtotalVal,
        totalAmount,
        status: resolvedStatus,
        notes: additionalNotes || technicianNotes || "",
        photos: [arrivalPhoto, finishedPhoto].filter((p): p is string => typeof p === 'string' && p.trim().length > 0),
        workDate: new Date(),
        aiInputs: reqAiInputs || null,
        aiShortDescription: aiShortDescription || null,
        aiDetailedDescription: aiDetailedDescription || null,
        branchName: effectiveBranchName,
        // Carry the parent work order's pin / pinned address / controller /
        // zone forward to the new billing sheet so the resulting row has the
        // same site context as the WO it converted from.
        workLocationLat:
          workOrder.workLocationLat != null ? String(workOrder.workLocationLat) : null,
        workLocationLng:
          workOrder.workLocationLng != null ? String(workOrder.workLocationLng) : null,
        workLocationAddress: workOrder.workLocationAddress ?? null,
        controllerLetter: workOrder.controllerLetter ?? null,
        zoneNumber: workOrder.zoneNumber ?? null,
        items: resolvedItems.length > 0 ? resolvedItems : undefined,
      });
      console.log(`[AUDIT] work_order_converted_to_billing_sheet workOrderId=${workOrderId} billingSheetId=${newBillingSheet.id} sourceItemCount=${workOrderSourceItemCount} billingSheetItemsWritten=${resolvedItems.length}`);

      // Task #206 — manager-class self-approval: stamp the same approval audit
      // fields the manual /approve endpoint uses so the resulting billing
      // sheet is fully traceable in Ready-to-Invoice listings.
      if (resolvedStatus === 'approved_passed_to_billing') {
        const approverUser = req.authenticatedUserId
          ? await storage.getUser(req.authenticatedUserId)
          : undefined;
        const approverName = approverUser?.name || 'Manager';
        const partsSnapshot = JSON.stringify({ partsSubtotal: newBillingSheet.partsSubtotal });
        const laborSnapshot = JSON.stringify({
          totalHours: newBillingSheet.totalHours,
          laborRate: newBillingSheet.laborRate,
          laborSubtotal: newBillingSheet.laborSubtotal,
        });
        const approvalPatch: Partial<InsertBillingSheet> = {
          approvedBy: approverName,
          approvedByUserId: req.authenticatedUserId || undefined,
          approvedAt: new Date(),
          approvedTotal: newBillingSheet.totalAmount,
          approvedPartsSnapshot: partsSnapshot,
          approvedLaborSnapshot: laborSnapshot,
        };
        await storage.updateBillingSheet(newBillingSheet.id, approvalPatch);
      }
      // Regression guard: surface any catalog $0 leak that slipped through.
      await regressionGuardZeroCatalogPrices('work_order_conversion', newBillingSheet.id, resolvedItems as RawBillingItem[]);
      await recordLifecycleAudit(req, {
        resource: "work_order",
        action: "work_order.billing_sheet_created",
        targetId: workOrderId,
        before: { status: workOrder.status },
        after: { billingSheetId: newBillingSheet.id, billingSheetStatus: resolvedStatus },
        summary: `Billing sheet ${newBillingSheet.id} created from work order ${workOrder.workOrderNumber}`,
        extra: { billingSheetId: newBillingSheet.id, billingSheetStatus: resolvedStatus },
      });
      res.json({ message: "Billing sheet saved successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to save billing sheet" });
    }
  });

  app.get("/api/work-orders/:id/billing-sheet", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const workOrderId = parseInt(req.params.id);
      
      // Validate work order ID is a valid number
      if (isNaN(workOrderId) || workOrderId <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }
      const bsGetCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
      const billingSheet = await storage.getBillingSheetById(workOrderId, bsGetCompanyId);
      if (!billingSheet) {
        res.status(404).json({ message: "Billing sheet not found" });
        return;
      }
      res.json(billingSheet);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch billing sheet" });
    }
  });

  // Mobile detail screens (Task #488 / M3): list billing sheets created
  // from a work order via the canonical billing_sheets.work_order_id
  // link populated by the conversion endpoint above. Scoped to the
  // caller's company via the parent work order's customer.
  app.get("/api/work-orders/:id/billing-sheets", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const cid = requireCompanyId(req, res); if (!cid) return;
      const workOrderId = parseInt(req.params.id);
      if (isNaN(workOrderId) || workOrderId <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }
      const wo = await storage.getWorkOrder(workOrderId, cid);
      if (!wo) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }
      if (wo.customerId) {
        const owner = await storage.getCustomer(wo.customerId);
        if (!owner || owner.companyId !== cid) {
          res.status(404).json({ message: "Work order not found" });
          return;
        }
      }
      const rows = await db
        .select({
          id: billingSheets.id,
          billingNumber: billingSheets.billingNumber,
          status: billingSheets.status,
          workDate: billingSheets.workDate,
        })
        .from(billingSheets)
        .where(eq(billingSheets.workOrderId, workOrderId))
        .orderBy(desc(billingSheets.workDate));
      res.json(rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch billing sheets" });
    }
  });

  // Mobile detail screens (Task #488 / M3): list wet checks attached to
  // a work order via wet_check_findings.work_order_id (the canonical
  // schema link between wet checks and work orders). Scoped to the
  // caller's company by joining the parent work order's customer.
  app.get("/api/work-orders/:id/wet-checks", requireAuthentication, requireSameCompanyAsWorkOrder, async (req, res) => {
    try {
      const cid = requireCompanyId(req, res); if (!cid) return;
      const workOrderId = parseInt(req.params.id);
      if (isNaN(workOrderId) || workOrderId <= 0) {
        res.status(400).json({ message: "Invalid work order ID" });
        return;
      }
      // Verify the work order belongs to the caller's company via its customer.
      const wo = await storage.getWorkOrder(workOrderId, cid);
      if (!wo) {
        res.status(404).json({ message: "Work order not found" });
        return;
      }
      if (wo.customerId) {
        const owner = await storage.getCustomer(wo.customerId);
        if (!owner || owner.companyId !== cid) {
          res.status(404).json({ message: "Work order not found" });
          return;
        }
      }
      const rows = await db
        .selectDistinct({
          id: wetChecks.id,
          customerId: wetChecks.customerId,
          customerName: wetChecks.customerName,
          status: wetChecks.status,
          startedAt: wetChecks.startedAt,
          submittedAt: wetChecks.submittedAt,
        })
        .from(wetChecks)
        .innerJoin(wetCheckFindings, eq(wetCheckFindings.wetCheckId, wetChecks.id))
        .where(eq(wetCheckFindings.workOrderId, workOrderId))
        .orderBy(desc(wetChecks.startedAt));
      res.json(rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch wet checks" });
    }
  });

  // ── Photo pipeline ────────────────────────────────────────────────────
  // Variants: thumb (~400px), medium (~1200px), original (preserved).
  // Stored DB photoId is the canonical baseId (e.g. "photos/<uuid>").

  // Returns a signed GCS PUT URL and canonical photo path; client PUTs directly to GCS.
  app.post("/api/upload/photo", requireAuthentication, async (req, res) => {
    try {
      const originalName = (req.query.originalName as string) || "photo";
      const ext = originalName.split('.').pop()?.toLowerCase() || '';
      const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif'];
      if (ext && !allowedExtensions.includes(ext)) {
        res.status(400).json({ message: "Only image files are allowed for photo uploads" });
        return;
      }

      const photoService = new ObjectStorageService();
      const { signedUrl, photoId } = await photoService.getPhotoUploadURL();
      res.json({
        signedUrl,
        url: photoId,
        fileName: photoId,
        originalName,
      });
    } catch (error) {
      console.error("Photo upload URL generation error:", error);
      res.status(500).json({ message: "Failed to generate photo upload URL" });
    }
  });

  // Called by the client after a successful PUT to GCS. Generates display
  // variants (thumb + medium) from the uploaded display copy. New uploads
  // intentionally have no preserved original under `originals/<uuid>` —
  // legacy photos that already have one continue to serve via
  // `?variant=original`. Returns a non-2xx (502) when variant generation
  // fails so the client can surface it to the user instead of optimistically
  // attaching a DB row that points at unrenderable bytes.
  app.post("/api/upload/photo/finalize", requireAuthentication, async (req, res) => {
    try {
      const photoId = (req.body?.photoId as string)?.trim();
      if (!photoId || !photoId.startsWith("photos/")) {
        res.status(400).json({ message: "Invalid photoId" });
        return;
      }
      const photoService = new ObjectStorageService();
      // Await variant generation so the client learns about failures
      // instead of optimistically writing a DB row that points at an
      // object whose display variants never materialized.
      try {
        const result = await photoService.ensurePhotoVariants(photoId);
        if (result.error) {
          console.warn(`[PHOTO-FINALIZE] ${photoId} partial:`, result);
          res.status(502).json({ ok: false, message: result.error, result });
          return;
        }
        res.json({ ok: true, result });
        return;
      } catch (e) {
        console.error(`[PHOTO-FINALIZE] ${photoId} failed:`, e);
        res.status(500).json({ ok: false, message: "Variant generation failed" });
        return;
      }
    } catch (error) {
      console.error("Photo finalize error:", error);
      res.status(500).json({ message: "Failed to finalize photo" });
    }
  });

  // Batch signed-URL endpoint. Accepts { photoIds: string[], variant?: "thumb"|"medium"|"original" }
  // Returns a parallel array { results: [{ photoId, url }] } so a gallery
  // with N photos costs one round-trip instead of N.
  app.post("/api/photos/signed-urls", requireAuthentication, async (req, res) => {
    try {
      const { photoIds, variant } = req.body || {};
      if (!Array.isArray(photoIds)) {
        res.status(400).json({ message: "photoIds must be an array" });
        return;
      }
      if (photoIds.length > 200) {
        res.status(400).json({ message: "Too many photoIds (max 200)" });
        return;
      }
      const requested = (variant === "thumb" || variant === "medium" || variant === "original")
        ? variant : "medium";
      const photoService = new ObjectStorageService();

      const results = await Promise.all(photoIds.map(async (raw: string) => {
        const photoId = String(raw || "");
        if (!photoId) return { photoId, url: null };

        // Ownership check — unauthorized ids return { photoId, url: null } silently
        // so the caller can distinguish "missing" from "forbidden" without leaking
        // which photo ids exist in other tenants.
        const allowed = await canViewPhoto(req, photoId);
        if (!allowed) return { photoId, url: null };

        // Legacy /uploads paths: try object-storage first (post-backfill
        // they live there), then fall through to the proxy which still has
        // the on-disk fallback for un-backfilled installs. We KEEP the
        // `uploads/` prefix on the proxy URL so a future cleanup of the
        // disk fallback does not break historical photo URLs.
        if (photoId.startsWith("uploads/") || photoId.startsWith("/uploads/")) {
          const normalized = photoId.replace(/^\//, "");
          const signed = await photoService.getPhotoDownloadURL(normalized, 900, requested);
          if (signed) return { photoId, url: signed };
          return { photoId, url: `/api/photos/${normalized}?variant=${requested}` };
        }

        const signed = await photoService.getPhotoDownloadURL(photoId, 900, requested);
        if (signed) return { photoId, url: signed };
        return { photoId, url: `/api/photos/${photoId}?variant=${requested}` };
      }));

      res.json({ variant: requested, results });
    } catch (error) {
      console.error("[PHOTO-BATCH-SIGN] error:", error);
      res.status(500).json({ message: "Failed to batch sign URLs" });
    }
  });

  // Single signed-URL endpoint (kept for compatibility). `?variant=` selects
  // a specific variant; defaults to medium.
  // Server-side authorization for the photo serve / signed-url routes.
  //
  // `requireAuthentication` is intentionally lenient about *how* identity
  // arrives (cookies/headers/query params — the latter so an `<img>` tag
  // and `window.open` can carry credentials at all). For raw photo bytes
  // we want a stricter, *authoritative* check: re-read the user from the
  // database (so a forged x-user-* tuple is caught the moment we look it
  // up) and confirm the photo belongs to a record this user's company
  // owns. Super admins keep cross-tenant access.

  // Shared boolean check — performs all six table checks and returns
  // true/false without writing to res. Used by assertCanViewPhoto
  // (single-photo endpoint) and the batch signed-URL handler.
  async function canViewPhoto(req: any, photoId: string): Promise<boolean> {
    const userId = req.authenticatedUserId as number | undefined;
    if (!userId) return false;

    const user = await storage.getUser(userId);
    if (!user) return false;

    // super_admin can view any photo across tenants.
    if (user.role === "super_admin") return true;

    if (!user.companyId) return false;

    // Normalize the requested key so we can match it against stored values
    // (DB rows store the canonical `photos/<uuid>` key, but a caller may
    // request a variant suffix or a leading slash).
    const stripped = photoId.replace(/^\/+/, "").replace(/__(thumb|medium)\.jpg$/i, "");
    // Task #600 — collapse a legacy double `photos/photos/<uuid>` prefix to
    // the canonical `photos/<uuid>` so the lookup actually matches the stored
    // row instead of bubbling a DB error up as a 500.
    const deDoubled = stripped.replace(/^photos\/photos\//, "photos/");
    const candidates = Array.from(new Set([photoId, stripped, deDoubled]));

    // 1) wet_check_photos rows owned by this company (joined via wet_checks).
    const wcRows = await db
      .select({ id: wetCheckPhotos.id })
      .from(wetCheckPhotos)
      .innerJoin(wetChecks, eq(wetChecks.id, wetCheckPhotos.wetCheckId))
      .where(and(
        eq(wetChecks.companyId, user.companyId),
        sql`${wetCheckPhotos.url} = ANY(${sql.param(candidates)}::text[])`,
      ))
      .limit(1);
    if (wcRows.length > 0) return true;

    // 2) text[] photo arrays on work_orders / billing_sheets / estimates
    //    scoped to this company.
    const overlaps = (col: any) => sql`${col} && ${sql.param(candidates)}::text[]`;
    const woRows = await db.select({ id: workOrders.id }).from(workOrders)
      .innerJoin(customers, eq(customers.id, workOrders.customerId))
      .where(and(eq(customers.companyId, user.companyId), overlaps(workOrders.photos))).limit(1);
    if (woRows.length > 0) return true;
    const bsRows = await db.select({ id: billingSheets.id }).from(billingSheets)
      .innerJoin(customers, eq(customers.id, billingSheets.customerId))
      .where(and(eq(customers.companyId, user.companyId), overlaps(billingSheets.photos))).limit(1);
    if (bsRows.length > 0) return true;
    const esRows = await db.select({ id: estimates.id }).from(estimates)
      .where(and(eq(estimates.companyId, user.companyId), overlaps(estimates.photos))).limit(1);
    if (esRows.length > 0) return true;

    // 5) work_order_zone_photos rows owned by this company (joined via
    //    work_orders → customers). These are the structured per-zone
    //    inspection photos and are NOT covered by the work_orders.photos[]
    //    array check above.
    const wzpRows = await db
      .select({ id: workOrderZonePhotos.id })
      .from(workOrderZonePhotos)
      .innerJoin(workOrders, eq(workOrders.id, workOrderZonePhotos.workOrderId))
      .innerJoin(customers, eq(customers.id, workOrders.customerId))
      .where(and(
        eq(customers.companyId, user.companyId),
        sql`${workOrderZonePhotos.url} = ANY(${sql.param(candidates)}::text[])`,
      ))
      .limit(1);
    if (wzpRows.length > 0) return true;

    // 6) irrigation_controllers.settings_photo_url — a single text column per
    //    controller, scoped to this company directly via companyId.
    const icRows = await db
      .select({ id: irrigationControllers.id })
      .from(irrigationControllers)
      .where(and(
        eq(irrigationControllers.companyId, user.companyId),
        sql`${irrigationControllers.settingsPhotoUrl} = ANY(${sql.param(candidates)}::text[])`,
      ))
      .limit(1);
    if (icRows.length > 0) return true;

    // 7) irrigation_backflows.photo_url — single text column per device,
    //    scoped to this company directly via companyId.
    const { irrigationBackflows } = await import("@workspace/db/schema");
    const bfRows = await db
      .select({ id: irrigationBackflows.id })
      .from(irrigationBackflows)
      .where(and(
        eq(irrigationBackflows.companyId, user.companyId),
        sql`${irrigationBackflows.photoUrl} = ANY(${sql.param(candidates)}::text[])`,
      ))
      .limit(1);
    if (bfRows.length > 0) return true;

    return false;
  }

  // Thin wrapper: surfaces 401 for unauthenticated callers, 403 for
  // authenticated callers who fail the ownership check.
  async function assertCanViewPhoto(req: any, res: any, photoId: string): Promise<boolean> {
    const userId = req.authenticatedUserId as number | undefined;
    if (!userId) { res.status(401).json({ error: "Authentication required" }); return false; }
    const user = await storage.getUser(userId);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return false; }
    const allowed = await canViewPhoto(req, photoId);
    if (!allowed) { res.status(403).json({ error: "Forbidden" }); return false; }
    return true;
  }

  app.get("/api/photos/{*photoId}/signed-url", requireAuthentication, async (req, res) => {
    const photoIdParam = req.params.photoId;
    const photoId = Array.isArray(photoIdParam) ? photoIdParam.join("/") : (photoIdParam ?? "");
    const variantQ = String(req.query.variant || "medium");
    const variant = (variantQ === "thumb" || variantQ === "medium" || variantQ === "original")
      ? variantQ : "medium";
    if (!(await assertCanViewPhoto(req, res, photoId))) return;
    try {
      const photoService = new ObjectStorageService();
      const normalized = photoId.startsWith("/") ? photoId.slice(1) : photoId;
      const signedUrl = await photoService.getPhotoDownloadURL(normalized, 900, variant);
      if (signedUrl) { res.json({ url: signedUrl }); return; }

      res.json({ url: `/api/photos/${normalized}?variant=${variant}` });
      return;
    } catch (error) {
      console.error(`[PHOTO-SIGNED-URL] Error generating signed URL for ${photoId}:`, error);
      res.status(500).json({ error: "Failed to generate signed URL" });
      return;
    }
  });

  // Authenticated photo-serving route — supports `?variant=` for display
  // variants. Display variants get long-lived public cache headers
  // (content-addressed by an unguessable UUID, so safe to cache).
  app.get("/api/photos/{*photoId}", requireAuthentication, async (req, res) => {
    const photoIdParam = req.params.photoId;
    const photoId = Array.isArray(photoIdParam) ? photoIdParam.join("/") : (photoIdParam ?? "");
    const variantQ = String(req.query.variant || "");
    const variant = (variantQ === "thumb" || variantQ === "medium" || variantQ === "original")
      ? variantQ : null;
    if (!(await assertCanViewPhoto(req, res, photoId))) return;
    try {
      const photoService = new ObjectStorageService();

      const file = variant
        ? await photoService.findVariant(photoId, variant)
        : await photoService.searchPhotoObject(photoId);

      if (file) {
        const isDisplay = variant === "thumb" || variant === "medium";
        return photoService.downloadObject(file, res, 3600, { displayVariant: isDisplay });
      }

      // Legacy fallback: serve from local ./uploads directory
      const path = await import("path");
      const fs = await import("fs");
      const safeName = path.basename(photoId.replace(/^\/uploads\//, ""));
      const localPath = path.join("./uploads", safeName);
      if (fs.existsSync(localPath)) {
        res.sendFile(path.resolve(localPath));
        return;
      }

      res.status(404).json({ error: "Photo not found" });
      return;
    } catch (error) {
      console.error(`[PHOTO-SERVE] Error serving photo ${photoId}:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to serve photo" });
        return;
      }
    }
  });

  app.post("/api/upload/attachment", requireAuthentication, async (req, res) => {
    try {
      if (!req.files || !req.files.attachment) {
        res.status(400).json({ message: "No attachment file provided" });
        return;
      }

      const attachment = Array.isArray(req.files.attachment) ? req.files.attachment[0] : req.files.attachment;
      const fileName = `attachment_${Date.now()}_${attachment.name.replace(/\s+/g, '_')}`;
      const uploadPath = `./uploads/${fileName}`;

      await attachment.mv(uploadPath);
      res.json({ url: `/api/attachments/${fileName}`, fileName, originalName: attachment.name });
    } catch (error) {
      console.error("Attachment upload error:", error);
      res.status(500).json({ message: "Failed to upload attachment" });
    }
  });

  // Authenticated attachment serving route — serves attachments from local disk
  // Also handles legacy /uploads/ URLs stored in DB before migration
  app.get("/api/attachments/{*fileName}", requireAuthentication, async (req, res) => {
    try {
      const pathMod = await import("path");
      const fs = await import("fs");
      const fileNameParam = (req.params as { fileName?: string | string[] }).fileName;
      const fileNameStr = Array.isArray(fileNameParam) ? fileNameParam.join("/") : (fileNameParam ?? "");
      const safeName = pathMod.basename(fileNameStr);
      const localPath = pathMod.join("./uploads", safeName);
      if (fs.existsSync(localPath)) {
        res.sendFile(pathMod.resolve(localPath));
        return;
      }
      res.status(404).json({ error: "Attachment not found" });
      return;
    } catch (error) {
      console.error(`[ATTACHMENT-SERVE] Error serving attachment ${req.params.fileName}:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to serve attachment" });
        return;
      }
    }
  });

  const httpServer = createServer(app);
  // Notification routes
  app.get("/api/notifications/:userId", requireAuthentication, requireNotificationAccess, async (req, res) => {
    try {
      const userId = req.authenticatedUserId!;
      
      const notifications = await storage.getNotifications(userId);
      res.json(notifications);
    } catch (error) {
      console.error("Error fetching notifications:", {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        userId: req.authenticatedUserId,
        timestamp: new Date().toISOString()
      });
      res.status(500).json({ message: "Failed to fetch notifications" });
    }
  });

  app.get("/api/notifications/:userId/count", requireAuthentication, requireNotificationAccess, async (req, res) => {
    try {
      const userId = req.authenticatedUserId!;
      
      const count = await storage.getUnreadNotificationCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Error fetching notification count:", {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        userId: req.authenticatedUserId,
        timestamp: new Date().toISOString()
      });
      res.status(500).json({ message: "Failed to fetch notification count" });
    }
  });

  app.post("/api/notifications", requireAuthentication, async (req, res) => {
    try {
      const validatedData = insertNotificationSchema.parse(req.body);
      const notification = await storage.createNotification(validatedData);
      res.status(201).json(notification);
    } catch (error) {
      console.error("Error creating notification:", error);
      res.status(500).json({ message: "Failed to create notification" });
    }
  });

  app.put("/api/notifications/:id/read", requireAuthentication, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const success = await storage.markNotificationAsRead(id);
      if (success) {
        res.json({ message: "Notification marked as read" });
      } else {
        res.status(404).json({ message: "Notification not found" });
      }
    } catch (error) {
      console.error("Error marking notification as read:", error);
      res.status(500).json({ message: "Failed to mark notification as read" });
    }
  });

  app.put("/api/notifications/:userId/read-all", requireAuthentication, async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      const success = await storage.markAllNotificationsAsRead(userId);
      res.json({ message: "All notifications marked as read" });
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
      res.status(500).json({ message: "Failed to mark all notifications as read" });
    }
  });


  // PDF Generation Route for Sample Invoice
  app.get("/api/sample-invoice-pdf", requireAuthentication, async (req, res) => {
    try {
      const { PDFGenerator } = await import('../pdf-generator');
      const invoiceUrl = `http://localhost:5000/invoice-preview.html`;
      
      const pdfBuffer = await PDFGenerator.generateInvoicePDFFromUrl(invoiceUrl);
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="Sample-Invoice-INV-202508-0014.pdf"');
      res.send(pdfBuffer);
    } catch (error) {
      console.error('PDF generation error:', error);
      res.status(500).json({ message: "Failed to generate PDF" });
    }
  });

  // QuickBooks Developer Portal Required URLs
  
  // Multi-Factor Authentication API endpoints
  app.post("/api/mfa/setup", requireAuthentication, async (req, res) => {
    try {
      const userId = req.user?.id;
      const userEmail = req.user?.email;
      
      if (!userId || !userEmail) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const { mfaManager } = await import('../mfa');
      const mfaSecret = await mfaManager.setupMFA(userId, userEmail);
      
      // Don't store in database yet - wait for verification
      res.json({
        qrCodeUrl: mfaSecret.qrCodeUrl,
        backupCodes: mfaSecret.backupCodes,
        secret: mfaSecret.secret, // Temporary - remove after setup
        message: "Scan QR code with authenticator app and verify to complete setup"
      });
    } catch (error) {
      console.error("Error setting up MFA:", error);
      res.status(500).json({ message: "Failed to setup multi-factor authentication" });
    }
  });

  app.post("/api/mfa/verify-setup", requireAuthentication, async (req, res) => {
    try {
      const userId = req.user?.id;
      const { secret, code, backupCodes } = req.body;
      
      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const { mfaManager } = await import('../mfa');
      const isValid = await mfaManager.verifyTOTP(secret, code, userId);
      
      if (isValid) {
        // Save MFA settings to database
        await storage.updateUser(userId, {
          mfaEnabled: true,
          mfaSecret: secret,
          mfaBackupCodes: JSON.stringify(backupCodes),
          mfaLastUsed: new Date()
        });
        
        res.json({ 
          success: true, 
          message: "Multi-factor authentication enabled successfully" 
        });
      } else {
        res.status(400).json({ 
          success: false, 
          message: "Invalid verification code" 
        });
      }
    } catch (error) {
      console.error("Error verifying MFA setup:", error);
      res.status(500).json({ message: "Failed to verify MFA setup" });
    }
  });

  app.post("/api/mfa/verify", async (req, res) => {
    try {
      const userId = req.user?.id;
      const { code } = req.body;
      
      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const user = await storage.getUser(userId);
      if (!user || !user.mfaEnabled || !user.mfaSecret) {
        res.status(400).json({ message: "MFA not enabled for this user" });
        return;
      }

      const { mfaManager } = await import('../mfa');
      const backupCodes = user.mfaBackupCodes ? JSON.parse(user.mfaBackupCodes) : [];
      const verification = await mfaManager.verifyMFA(user.mfaSecret, backupCodes, code, userId);
      
      if (verification.isValid) {
        // Update last used timestamp
        await storage.updateUser(userId, { mfaLastUsed: new Date() });
        
        // If backup code was used, update the codes
        if (verification.usedBackupCode) {
          const updatedCodes = backupCodes.filter((c: string) => c !== verification.usedBackupCode);
          await storage.updateUser(userId, { 
            mfaBackupCodes: JSON.stringify(updatedCodes) 
          });
        }
        
        res.json({ 
          success: true, 
          message: "MFA verification successful",
          usedBackupCode: !!verification.usedBackupCode
        });
      } else {
        res.status(400).json({ 
          success: false, 
          message: "Invalid verification code" 
        });
      }
    } catch (error) {
      console.error("Error verifying MFA:", error);
      res.status(500).json({ message: "Failed to verify MFA" });
    }
  });

  app.post("/api/mfa/disable", requireAuthentication, async (req, res) => {
    try {
      const userId = req.user?.id;
      const { password } = req.body;
      
      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      // Verify password before disabling MFA
      const user = await storage.getUser(userId);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      const bcrypt = await import('bcrypt');
      const passwordValid = await bcrypt.compare(password, user.password);
      if (!passwordValid) {
        res.status(400).json({ message: "Invalid password" });
        return;
      }

      const { mfaManager } = await import('../mfa');
      await mfaManager.disableMFA(userId);
      
      // Remove MFA from database
      await storage.updateUser(userId, {
        mfaEnabled: false,
        mfaSecret: null,
        mfaBackupCodes: null,
        mfaLastUsed: null
      });
      
      res.json({ 
        success: true, 
        message: "Multi-factor authentication disabled" 
      });
    } catch (error) {
      console.error("Error disabling MFA:", error);
      res.status(500).json({ message: "Failed to disable MFA" });
    }
  });

  app.post("/api/mfa/backup-codes/regenerate", requireAuthentication, async (req, res) => {
    try {
      const userId = req.user?.id;
      
      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const user = await storage.getUser(userId);
      if (!user || !user.mfaEnabled) {
        res.status(400).json({ message: "MFA not enabled for this user" });
        return;
      }

      const { mfaManager } = await import('../mfa');
      const newBackupCodes = await mfaManager.regenerateBackupCodes(userId);
      
      // Update database with new backup codes
      await storage.updateUser(userId, {
        mfaBackupCodes: JSON.stringify(newBackupCodes)
      });
      
      res.json({ 
        success: true, 
        backupCodes: newBackupCodes,
        message: "New backup codes generated" 
      });
    } catch (error) {
      console.error("Error regenerating backup codes:", error);
      res.status(500).json({ message: "Failed to regenerate backup codes" });
    }
  });

  app.get("/api/mfa/status", requireAuthentication, async (req, res) => {
    try {
      const userId = req.user?.id;
      
      if (!userId) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const user = await storage.getUser(userId);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      const backupCodes = user.mfaBackupCodes ? JSON.parse(user.mfaBackupCodes) : [];
      
      res.json({
        mfaEnabled: user.mfaEnabled || false,
        lastUsed: user.mfaLastUsed,
        backupCodesRemaining: backupCodes.length
      });
    } catch (error) {
      console.error("Error getting MFA status:", error);
      res.status(500).json({ message: "Failed to get MFA status" });
    }
  });

  // Security Assessment API endpoints
  app.get("/api/security/assessment", requireAuthentication, async (req, res) => {
    try {
      if (req.authenticatedUserRole !== 'super_admin') {
        res.status(403).json({ message: "Forbidden: super_admin only" });
        return;
      }
      const { securityManager } = await import('../security');
      const assessment = await securityManager.performSecurityAssessment();
      res.json(assessment);
    } catch (error) {
      console.error("Error performing security assessment:", error);
      res.status(500).json({ message: "Failed to perform security assessment" });
    }
  });

  app.get("/api/security/status", requireAuthentication, async (req, res) => {
    try {
      const { securityManager } = await import('../security');
      const status = securityManager.getSecurityStatus();
      res.json(status);
    } catch (error) {
      console.error("Error getting security status:", error);
      res.status(500).json({ message: "Failed to get security status" });
    }
  });

  app.post("/api/security/incident", requireAuthentication, async (req, res) => {
    try {
      const { securityManager } = await import('../security');
      const { type, severity, description, affectedSystems, userId } = req.body;
      
      securityManager.reportSecurityIncident({
        type,
        severity,
        description,
        affectedSystems,
        userId
      });
      
      res.json({ message: "Security incident reported successfully" });
    } catch (error) {
      console.error("Error reporting security incident:", error);
      res.status(500).json({ message: "Failed to report security incident" });
    }
  });

  // Logging and troubleshooting API endpoints
  app.get("/api/logs", requireAuthentication, async (req, res) => {
    try {
      const { level, context, userId, since, limit } = req.query;
      
      const filters: any = {};
      if (level) filters.level = level as string;
      if (context) filters.context = context as string;
      if (userId) filters.userId = parseInt(userId as string);
      if (since) filters.since = new Date(since as string);
      if (limit) filters.limit = parseInt(limit as string) || 100;

      // For now, return empty logs as the logger integration is being set up
      const logs: any[] = [];
      res.json({ logs, total: logs.length, message: "Enhanced logging system available" });
    } catch (error) {
      console.error("Error fetching logs:", error);
      res.status(500).json({ message: "Failed to fetch logs" });
    }
  });

  app.get("/api/logs/export", requireAuthentication, async (req, res) => {
    try {
      const exportData = {
        exportedAt: new Date().toISOString(),
        logs: [],
        message: "Enhanced logging system ready for troubleshooting"
      };
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="irrigopro-logs-${new Date().toISOString().split('T')[0]}.json"`);
      res.send(JSON.stringify(exportData, null, 2));

      void recordAuditEvent(req, {
        actorUserId: null,
        actorLabel: null,
        actorRole: null,
        actorCompanyId: null,
        actionType: 'data',
        action: 'logs_exported',
        severity: 'info',
        targetType: 'logs',
        targetId: null,
        summary: 'Exported application logs',
      });
    } catch (error) {
      console.error("Error exporting logs:", error);
      res.status(500).json({ message: "Failed to export logs" });
    }
  });

  app.get("/api/logs/summary", async (req, res) => {
    try {
      const summary = {
        totalErrors: 0,
        quickbooksErrors: 0,
        recentErrors: [],
        errorsByContext: {},
        loggingSystemStatus: "Enhanced logging system operational"
      };
      
      res.json(summary);
    } catch (error) {
      console.error("Error getting log summary:", error);
      res.status(500).json({ message: "Failed to get log summary" });
    }
  });

  // ────────────────────────────────────────────
  // External API Key Management Routes
  // ────────────────────────────────────────────
  
  // Get all API keys for the company (admin only)
  app.get("/api/company/:companyId/api-keys", requireAuthentication, requireCompanyAdminAccess, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const apiKeys = await storage.getApiKeys(companyId);
      
      // Return keys without the actual key value (only prefix for identification)
      const safeKeys = apiKeys.map(key => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        isActive: key.isActive,
        lastUsedAt: key.lastUsedAt,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt
      }));
      
      res.json(safeKeys);
    } catch (error) {
      console.error("Error fetching API keys:", error);
      res.status(500).json({ message: "Failed to fetch API keys" });
    }
  });

  // Create a new API key (admin only)
  app.post("/api/company/:companyId/api-keys", requireAuthentication, requireCompanyAdminAccess, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId);
      const userId = req.authenticatedUserId ?? 0;
      const { name, expiresAt } = req.body;

      if (!name || name.trim().length === 0) {
        res.status(400).json({ message: "API key name is required" });
        return;
      }

      // Generate a secure API key
      const rawKey = `irpk_${crypto.randomBytes(32).toString('hex')}`;
      const keyPrefix = rawKey.substring(0, 12); // Store first 12 chars for identification

      const apiKey = await storage.createApiKey({
        companyId,
        name: name.trim(),
        apiKey: rawKey,
        keyPrefix,
        createdBy: userId,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isActive: true,
        lastUsedAt: null
      });

      // Return the full key ONLY on creation (user must save it now)
      res.status(201).json({
        id: apiKey.id,
        name: apiKey.name,
        apiKey: rawKey, // Full key shown only once
        keyPrefix: apiKey.keyPrefix,
        isActive: apiKey.isActive,
        createdAt: apiKey.createdAt,
        expiresAt: apiKey.expiresAt,
        message: "IMPORTANT: Save this API key now. It will not be shown again."
      });
    } catch (error) {
      console.error("Error creating API key:", error);
      res.status(500).json({ message: "Failed to create API key" });
    }
  });

  // Delete an API key (admin only)
  app.delete("/api/company/:companyId/api-keys/:keyId", requireAuthentication, requireCompanyAdminAccess, async (req, res) => {
    try {
      const keyId = parseInt(req.params.keyId);
      const deleted = await storage.deleteApiKey(keyId);
      
      if (deleted) {
        res.json({ message: "API key deleted successfully" });
      } else {
        res.status(404).json({ message: "API key not found" });
      }
    } catch (error) {
      console.error("Error deleting API key:", error);
      res.status(500).json({ message: "Failed to delete API key" });
    }
  });

  // ────────────────────────────────────────────
  // External Work Order API (for CRM Integration)
  // ────────────────────────────────────────────
  
  // Create work order via external API with API key authentication
  app.post("/api/external/work-orders", requireApiKey, async (req, res) => {
    try {

      // Parse and validate the request body
      const externalWorkOrderSchema = z.object({
        customer: z.object({
          name: z.string().min(1, "Customer name is required"),
          email: z.string().email().optional(),
          phone: z.string().optional(),
          address: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          zip: z.string().optional()
        }),
        workOrder: z.object({
          title: z.string().min(1, "Work order title is required"),
          description: z.string().optional(),
          priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
          scheduledDate: z.string().optional(), // ISO date string
          estimatedHours: z.number().nullable().optional(),
          location: z.string().optional(),
          notes: z.string().optional(),
          externalReferenceId: z.string().optional() // ID from the external CRM
        })
      });

      const validationResult = externalWorkOrderSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Invalid request data",
          details: validationResult.error.flatten()
        });
        return;
      }

      const { customer, workOrder } = validationResult.data;
      const companyId = req.apiKeyCompanyId!;

      // Find or create the customer
      let existingCustomer = null;
      const allCustomers = await storage.getCustomers(companyId);
      
      // Try to match by email or name
      if (customer.email) {
        existingCustomer = allCustomers.find(c => 
          c.email?.toLowerCase() === customer.email?.toLowerCase()
        );
      }
      if (!existingCustomer) {
        existingCustomer = allCustomers.find(c => 
          c.name.toLowerCase() === customer.name.toLowerCase()
        );
      }

      let customerId: number;
      
      if (existingCustomer) {
        customerId = existingCustomer.id;
      } else {
        // Create new customer
        const newCustomer = await storage.createCustomer({
          companyId,
          name: customer.name,
          email: customer.email || '',
          phone: customer.phone || undefined,
          address: customer.address || undefined,
          notes: `Created via API integration on ${new Date().toISOString()}`
        });
        customerId = newCustomer.id;
      }

      // Find the irrigation manager for auto-assignment
      const irrigationManager = await storage.getIrrigationManagerForCompany(companyId);
      
      // Get full customer data (either existing or newly created)
      const customerData = existingCustomer || await storage.getCustomer(customerId);

      // Create the work order with all required fields
      const newWorkOrder = await storage.createWorkOrder({
        customerId,
        companyId: customerData?.companyId ?? companyId,
        customerName: customerData?.name || customer.name,
        customerEmail: customerData?.email || customer.email || '',
        customerPhone: customer.phone || customerData?.phone || null,
        projectName: workOrder.title, // Use title as project name
        projectAddress: workOrder.location || customer.address || null,
        workType: 'direct_billing', // API-created work orders are direct billing
        status: 'pending',
        priority: workOrder.priority,
        scheduledDate: workOrder.scheduledDate ? new Date(workOrder.scheduledDate) : null,
        assignedTechnicianId: irrigationManager?.id || null, // Auto-assign to irrigation manager
        assignedTechnicianName: irrigationManager?.name || null,
        description: workOrder.description || null,
        notes: workOrder.notes ? 
          `${workOrder.notes}\n\n---\nExternal Reference: ${workOrder.externalReferenceId || 'N/A'}` : 
          workOrder.externalReferenceId ? `External Reference: ${workOrder.externalReferenceId}` : null,
        estimateId: null
      });

      // Create notification for the assigned manager
      if (irrigationManager) {
        await storage.createNotification({
          userId: irrigationManager.id,
          type: 'work_order_assigned',
          title: 'New Work Order Assigned via API',
          message: `A new work order "${workOrder.title}" has been assigned to you for customer ${customer.name}`,
          relatedEntityType: 'work_order',
          relatedEntityId: newWorkOrder.id,
          isRead: false
        });
      }

      res.status(201).json({
        success: true,
        data: {
          workOrderId: newWorkOrder.id,
          workOrderNumber: newWorkOrder.workOrderNumber,
          customerId,
          customerName: existingCustomer ? existingCustomer.name : customer.name,
          customerCreated: !existingCustomer,
          assignedTo: irrigationManager ? {
            id: irrigationManager.id,
            name: irrigationManager.name
          } : null,
          status: newWorkOrder.status,
          createdAt: newWorkOrder.createdAt
        },
        message: "Work order created successfully"
      });

    } catch (error) {
      console.error("External API - Error creating work order:", error);
      res.status(500).json({ 
        error: "SERVER_ERROR",
        message: "Failed to create work order" 
      });
    }
  });

  // Get work order status via external API
  app.get("/api/external/work-orders/:workOrderId", requireApiKey, async (req, res) => {
    try {
      const workOrderId = parseInt(String(req.params.workOrderId));
      const workOrder = await storage.getWorkOrder(workOrderId, req.apiKeyCompanyId ?? null);

      if (!workOrder) {
        res.status(404).json({ 
          error: "NOT_FOUND",
          message: "Work order not found" 
        });
        return;
      }

      // Verify the work order belongs to the API key's company through customer
      const customer = await storage.getCustomer(workOrder.customerId);
      if (!customer || customer.companyId !== req.apiKeyCompanyId) {
        res.status(403).json({ 
          error: "FORBIDDEN",
          message: "Access denied to this work order" 
        });
        return;
      }

      res.json({
        success: true,
        data: {
          id: workOrder.id,
          workOrderNumber: workOrder.workOrderNumber,
          projectName: workOrder.projectName,
          status: workOrder.status,
          priority: workOrder.priority,
          scheduledDate: workOrder.scheduledDate,
          startedAt: workOrder.startedAt,
          completedAt: workOrder.completedAt,
          totalHours: workOrder.totalHours,
          totalPartsCost: workOrder.totalPartsCost,
          createdAt: workOrder.createdAt,
          updatedAt: workOrder.updatedAt
        }
      });

    } catch (error) {
      console.error("External API - Error fetching work order:", error);
      res.status(500).json({ 
        error: "SERVER_ERROR",
        message: "Failed to fetch work order" 
      });
    }
  });

  // External Parts Catalog API (CRM delta-poll endpoint)
  registerExternalPartsRoute(app, { requireApiKey });

  if (process.env.NODE_ENV !== 'production') {
    app.post("/api/dev/seed-billing-month", async (req, res) => {
      try {
        const { seedBillingMonth } = await import("../seed");
        await seedBillingMonth();
        res.json({ message: "Billing month seed data created successfully" });
      } catch (error) {
        console.error("Error seeding billing month:", error);
        res.status(500).json({ message: "Failed to seed billing month data" });
      }
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // AI Work Description Generator
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/ai/generate-work-description", requireAuthentication, async (req: any, res) => {
    try {
      const {
        locationZone,
        issueFound,
        workPerformed,
        partsUsed,
        laborTime,
        outcomeStatus,
        followUpNeeded,
        technicianNotes,
        entityType,
        entityId,
      } = req.body;

      // Validate entityType and entityId for clean audit logs
      const validEntityTypes = ["billing_sheet", "work_order"];
      const safeEntityType: string = validEntityTypes.includes(entityType) ? entityType : "unknown";
      const safeEntityId: number | null = entityId && Number.isInteger(Number(entityId)) && Number(entityId) > 0
        ? Number(entityId)
        : null;

      const inputs: WorkDescriptionInputs = {
        locationZone: locationZone?.trim() || undefined,
        issueFound: issueFound?.trim() || undefined,
        workPerformed: workPerformed?.trim() || undefined,
        partsUsed: partsUsed?.trim() || undefined,
        laborTime: laborTime?.trim() || undefined,
        outcomeStatus: outcomeStatus?.trim() || undefined,
        followUpNeeded: followUpNeeded?.trim() || undefined,
        technicianNotes: technicianNotes?.trim() || undefined,
      };

      // Check for missing critical fields
      const missingCritical: string[] = [];
      for (const field of CRITICAL_FIELDS) {
        if (!inputs[field]) {
          const labels: Record<string, string> = {
            workPerformed: "Work Performed",
            outcomeStatus: "Outcome/Current Status",
          };
          missingCritical.push(`Missing critical field: "${labels[field] || field}"`);
        }
      }

      if (missingCritical.length > 0) {
        // Log the failed/blocked generation attempt for auditability
        try {
          await storage.createAiGenerationLog({
            userId: req.authenticatedUserId || null,
            entityType: safeEntityType,
            entityId: safeEntityId,
            inputs: JSON.stringify(inputs),
            rawOutput: JSON.stringify({ warnings: missingCritical, blocked: true }),
            templateVersion: TEMPLATE_VERSION,
          });
        } catch (logErr) {
          console.error("[AI] Failed to write audit log for blocked request:", logErr);
        }
        res.json({
          short_work_completed_description: "",
          detailed_work_completed_description: "",
          missing_info_warnings: missingCritical,
        });
        return;
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error("[AI] OPENAI_API_KEY environment secret not configured");
        res.status(503).json({ 
          message: "AI generation is not configured. Please set the OPENAI_API_KEY environment secret." 
        });
        return;
      }

      const prompt = buildWorkDescriptionPrompt(inputs);

      // Call OpenAI API using native fetch
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: 600,
          temperature: 0.3,
        }),
      });

      if (!openaiResponse.ok) {
        const errText = await openaiResponse.text();
        console.error("[AI] OpenAI API error:", openaiResponse.status, errText);
        res.status(502).json({ message: "AI service returned an error. Please try again." });
        return;
      }

      const openaiData: any = await openaiResponse.json();
      const rawOutput = openaiData?.choices?.[0]?.message?.content || "";

      // Parse the JSON response from GPT
      let parsed: any = {};
      try {
        // Remove any markdown fences in case model adds them
        const cleaned = rawOutput.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch (parseError) {
        console.error("[AI] Failed to parse GPT JSON response:", rawOutput);
        res.status(502).json({ message: "AI returned an unexpected response format. Please try again." });
        return;
      }

      // Log the generation for audit
      try {
        await storage.createAiGenerationLog({
          userId: req.authenticatedUserId || null,
          entityType: safeEntityType,
          entityId: safeEntityId,
          inputs: JSON.stringify(inputs),
          rawOutput,
          templateVersion: TEMPLATE_VERSION,
        });
      } catch (logError) {
        console.error("[AI] Failed to write audit log:", logError);
        // Non-fatal — don't block the response
      }

      const warnings: string[] = [
        ...(missingCritical),
        ...(Array.isArray(parsed.missing_info_warnings) ? parsed.missing_info_warnings : []),
      ].filter(Boolean);

      console.log(`[AUDIT] ai_description_generated entityType=${entityType || "unknown"} entityId=${entityId || "none"} userId=${req.authenticatedUserId} templateVersion=${TEMPLATE_VERSION}`);

      res.json({
        short_work_completed_description: parsed.short_work_completed_description || "",
        detailed_work_completed_description: parsed.detailed_work_completed_description || "",
        missing_info_warnings: warnings,
      });
      return;

    } catch (error) {
      console.error("[AI] Unexpected error in generate-work-description:", error);
      res.status(500).json({ message: "Failed to generate description. Please try again." });
      return;
    }
  });

  app.post("/api/ai/expand-description", requireAuthentication, async (req: any, res) => {
    try {
      const { rawDescription } = req.body;
      const raw = typeof rawDescription === "string" ? rawDescription.trim() : "";
      if (!raw) {
        res.status(400).json({ message: "rawDescription is required" });
        return;
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.status(503).json({ message: "AI generation is not configured. Please set the OPENAI_API_KEY environment secret." });
        return;
      }

      const prompt = buildExpandDescriptionPrompt(raw);

      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
          temperature: 0.3,
        }),
      });

      if (!openaiResponse.ok) {
        const errText = await openaiResponse.text();
        console.error("[AI expand] OpenAI API error:", openaiResponse.status, errText);
        res.status(502).json({ message: "AI service returned an error. Please try again." });
        return;
      }

      const openaiData: any = await openaiResponse.json();
      const rawOutput = openaiData?.choices?.[0]?.message?.content || "";

      let parsed: any = {};
      try {
        const cleaned = rawOutput.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        console.error("[AI expand] Failed to parse GPT JSON response:", rawOutput);
        res.status(502).json({ message: "AI returned an unexpected response format. Please try again." });
        return;
      }

      const expanded = typeof parsed.expanded === "string" ? parsed.expanded.trim() : "";
      if (!expanded) {
        res.status(502).json({ message: "AI returned an empty result. Please try again." });
        return;
      }

      res.json({ expanded });
      return;

    } catch (error) {
      console.error("[AI expand] Unexpected error:", error);
      res.status(500).json({ message: "Failed to expand description. Please try again." });
      return;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QB7 / T8 — Background health-check / keep-alive job
  //
  // Runs once at startup and then every 24 hours thereafter.
  // Proactively refreshes any connected realm whose token is within the
  // 5-minute expiry buffer or that is approaching the 100-day idle threshold.
  // Uses runProactiveRefreshForRealm from qb-token-utils.ts (testable).
  // ─────────────────────────────────────────────────────────────────────────

  // Storage adapter bridge for qb-token-utils (decouples logic from DatabaseStorage)
  const qbStorageAdapter: QbStorageAdapter = {
    getIntegration: (realmId) => storage.getQuickBooksIntegration(realmId),
    saveIntegration: (data) => storage.saveQuickBooksIntegration(data),
    markReconnectRequired: (realmId, reason) => storage.markQuickBooksReconnectRequired(realmId, reason),
  };

  // Injected Intuit refresh function (uses real token endpoint)
  const realRefreshFn: QbRefreshFn = (refreshToken: string, signal: AbortSignal) =>
    refreshQuickBooksToken(refreshToken, signal, { calledFrom: 'health-job' });

  const _qbHealthTimer = startQbTokenHealthJob(
    () => storage.getAllActiveQuickBooksIntegrations(),
    realRefreshFn,
    qbStorageAdapter,
    24 * 60 * 60 * 1000
  );
  if (typeof _qbHealthTimer.unref === "function") _qbHealthTimer.unref();

  // ─────────────────────────────────────────────────────────────────────────
  // QB Harden #4 — External daily health probe
  //
  // POST /api/internal/qb/health-sweep
  //
  // Called by an external cron / Replit Scheduled Task to guarantee the QB
  // token sweep runs at least once per day even when the server has been idle
  // (which would reset the in-process setInterval above).
  //
  // Auth: Authorization: Bearer <QB_HEALTH_PROBE_TOKEN>
  //   - 503 {"error":"not configured"} if the env var is absent
  //   - 401 {"error":"unauthorized"}   if the token doesn't match
  //
  // Response: { checked: N, refreshed: N, reconnect_required: string[] }
  //
  // The two-deploy rule applies: set QB_HEALTH_PROBE_TOKEN in Replit Secrets
  // and configure the cron AFTER this code is deployed (not in the same deploy).
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/api/internal/qb/health-sweep", async (req, res) => {
    const probeToken = process.env.QB_HEALTH_PROBE_TOKEN;
    if (!probeToken) {
      res.status(503).json({ error: "not configured" });
      return;
    }

    const authHeader = req.headers["authorization"] ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!provided || provided !== probeToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    let integrations: Array<{
      realmId: string;
      connectionStatus: string;
      expiresAt: Date;
      lastRefreshSuccess: Date | null;
    }> = [];

    try {
      integrations = await storage.getAllActiveQuickBooksIntegrations();
    } catch (e) {
      req.log.error({ err: e }, "[QB probe] Failed to fetch active integrations");
      res.status(500).json({ error: "failed to fetch integrations" });
      return;
    }

    const idleThresholdMs = QB_IDLE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    let checked = 0;
    let refreshed = 0;
    const reconnectRequired: string[] = [];

    for (const integ of integrations) {
      if (integ.connectionStatus === "reconnect_required") {
        reconnectRequired.push(integ.realmId);
        continue;
      }

      checked++;

      const msUntilExpiry = integ.expiresAt.getTime() - Date.now();
      const isNearExpiry = msUntilExpiry <= QB_PROACTIVE_REFRESH_BUFFER_MS;

      const lastSuccessMs = integ.lastRefreshSuccess ? integ.lastRefreshSuccess.getTime() : 0;
      const idleMs = Date.now() - lastSuccessMs;
      const isApproachingIdleThreshold = idleMs >= idleThresholdMs;

      if (!isNearExpiry && !isApproachingIdleThreshold) {
        req.log.info({ realmId: integ.realmId }, "[QB probe] realm healthy — skipping");
        continue;
      }

      const effectiveBufferMs = isApproachingIdleThreshold
        ? Math.max(QB_PROACTIVE_REFRESH_BUFFER_MS, msUntilExpiry + 1)
        : QB_PROACTIVE_REFRESH_BUFFER_MS;

      const result = await runProactiveRefreshForRealm(integ.realmId, realRefreshFn, qbStorageAdapter, effectiveBufferMs);

      if (result.refreshed) {
        refreshed++;
        req.log.info({ realmId: integ.realmId }, "[QB probe] refreshed successfully");
      } else if (result.isUnrecoverable) {
        reconnectRequired.push(integ.realmId);
        req.log.warn({ realmId: integ.realmId, err: result.error }, "[QB probe] unrecoverable error — reconnect required");
      } else if (result.skipped) {
        req.log.info({ realmId: integ.realmId, skipReason: result.skipReason }, "[QB probe] skipped");
      }
    }

    res.json({ checked, refreshed, reconnect_required: reconnectRequired });
  });

  // One-time data fix: correct the 7 pending billing sheets with wrong labor rates.
  // These were created with a hardcoded $45 default instead of the customer's actual rate.
  // Uses the app_settings table as a completion marker so it only runs once.
  (async () => {
    const DATA_FIX_KEY = 'fix-pending-billing-sheet-labor-rates-v1';
    try {
      // Check if this fix has already run successfully
      const existingMarker = await db.execute(
        sql`SELECT value FROM app_settings WHERE key = ${DATA_FIX_KEY}`
      );
      if (existingMarker.rows.length > 0 && existingMarker.rows[0].value === 'completed') {
        console.log(`[DATA FIX] '${DATA_FIX_KEY}': already completed, skipping`);
        return;
      }

      const sheetsToFix = [
        { billingNumber: 'BS-2026-0020', correctRate: '85.00', correctHours: '5', correctLaborSubtotal: '425.00' },
        { billingNumber: 'BS-2026-0021', correctRate: '85.00', correctHours: '1', correctLaborSubtotal: '85.00' },
        { billingNumber: 'BS-2026-0016', correctRate: '80.00', correctHours: '5', correctLaborSubtotal: '400.00' },
        { billingNumber: 'BS-2026-0015', correctRate: '80.00', correctHours: '6', correctLaborSubtotal: '480.00' },
        { billingNumber: 'BS-2026-0011', correctRate: '80.00', correctHours: '5', correctLaborSubtotal: '400.00' },
        { billingNumber: 'BS-2026-0014', correctRate: '80.00', correctHours: '6', correctLaborSubtotal: '480.00' },
        { billingNumber: 'BS-2026-0006', correctRate: '80.00', correctHours: '1', correctLaborSubtotal: '80.00' },
      ];

      let correctedCount = 0;
      const allSheets = await storage.getAllBillingSheets(null);
      for (const fix of sheetsToFix) {
        const sheet = allSheets.find(s => s.billingNumber === fix.billingNumber);
        if (!sheet) continue;
        // Only fix sheets that are still pending manager review (not yet billed or approved)
        if (sheet.status !== 'pending_manager_review' && sheet.status !== 'submitted') continue;
        // Skip if the rate is already correct
        if (parseFloat(sheet.laborRate || '0').toFixed(2) === fix.correctRate) continue;

        const partsSubtotal = parseFloat(sheet.partsSubtotal || '0');
        const laborSubtotal = parseFloat(fix.correctLaborSubtotal);
        const totalAmount = (laborSubtotal + partsSubtotal).toFixed(2);

        await storage.updateBillingSheet(sheet.id, {
          laborRate: fix.correctRate,
          laborSubtotal: fix.correctLaborSubtotal,
          totalAmount,
        });
        console.log(`[DATA FIX] Corrected billing sheet ${fix.billingNumber}: laborRate=${fix.correctRate}, laborSubtotal=${fix.correctLaborSubtotal}, totalAmount=${totalAmount}`);
        correctedCount++;
      }

      // Mark as completed so it does not re-run on subsequent startups
      await db.execute(
        sql`INSERT INTO app_settings (key, value, updated_at) VALUES (${DATA_FIX_KEY}, 'completed', NOW())
            ON CONFLICT (key) DO UPDATE SET value = 'completed', updated_at = NOW()`
      );
      console.log(`[DATA FIX] '${DATA_FIX_KEY}': completed (${correctedCount} sheet(s) corrected)`);
    } catch (err) {
      console.error('[DATA FIX] Failed to run billing sheet labor rate correction:', err);
    }
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // Slice 2A — Wet Check capture endpoints (Task #229)
  // All scoped by req.authenticatedUserCompanyId, all idempotent on clientId.
  // ─────────────────────────────────────────────────────────────────────────
  const requireCompanyId = (req: any, res: any): number | null => {
    const cid = req.authenticatedUserCompanyId;
    if (!cid) { res.status(403).json({ message: "Company scope required" }); return null; }
    return cid;
  };
  const isFieldRole = (role: string | undefined) =>
    role === "field_tech" || role === "irrigation_manager" || role === "company_admin" || role === "super_admin" || role === "billing_manager";
  // Manager-level routes (review / route / approve / convert) — explicitly
  // exclude field_tech.
  const isWetCheckManagerRole = (role: string | undefined) =>
    role === "irrigation_manager" || role === "company_admin" || role === "super_admin" || role === "billing_manager";

  app.get("/api/wet-checks/issue-types", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    try {
      const rows = await storage.listIssueTypeConfigs(cid);
      res.json(rows);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "listIssueTypeConfigs",
        ctx: { cid },
        fallbackMessage: "Couldn't load issue types — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ─── Admin CRUD for issue type configs (Task #268, #277, #336) ───────────
  // company_admin, super_admin, irrigation_manager, and billing_manager —
  // scoped to the caller's company. Managers manage the issue list their
  // techs see in the field; field techs remain locked out.
  const requireIssueTypeAdminAccess = (req: any, res: any, next: any) => {
    const userRole = req.authenticatedUserRole;
    if (
      userRole === "company_admin" ||
      userRole === "irrigation_manager" ||
      userRole === "billing_manager" ||
      userRole === "super_admin"
    ) {
      return next();
    }
    res.status(403).json({
      message: "Access denied. Only company administrators, super administrators, irrigation managers, and billing managers can manage wet check issue types.",
    });
    return;
  };

  const issueTypeAdminBodySchema = insertIssueTypeConfigSchema
    .omit({ companyId: true })
    .extend({
      issueType: z.string().trim().min(1, "issueType is required").max(64)
        .regex(/^[a-z0-9_]+$/i, "issueType may only contain letters, numbers, and underscores"),
      issueGroup: z.enum(["quick_fix", "advanced", "zone_issue"]),
      displayLabel: z.string().trim().min(1, "displayLabel is required").max(64),
      defaultLaborHours: z.union([z.string(), z.number()])
        .transform((v) => typeof v === "number" ? v.toFixed(2) : v.trim())
        .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "defaultLaborHours must be a non-negative number with up to 2 decimals")
        .refine((v) => parseFloat(v) >= 0.25, "defaultLaborHours must be at least 0.25")
        .refine((v) => parseFloat(v) <= 999.99, "defaultLaborHours is too large")
        .refine((v) => Math.abs(Math.round(parseFloat(v) * 4) - parseFloat(v) * 4) < 1e-9, "defaultLaborHours must be a multiple of 0.25"),
      partCategoryFilter: z.string().trim().max(64).nullish()
        .transform((v) => (v == null || v === "") ? null : v),
      sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
      isActive: z.boolean().optional(),
    });

  // Super-admin may pass ?companyId=N (or body.companyId) to scope to a
  // specific company; all other roles use their session company scope.
  const resolveIssueTypeCompanyId = (req: any, res: any): number | null => {
    if (req.authenticatedUserRole === "super_admin") {
      const raw = req.query?.companyId ?? req.body?.companyId;
      const n = raw !== undefined ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n <= 0) {
        res.status(400).json({ message: "companyId query param required for super_admin" });
        return null;
      }
      return n;
    }
    return requireCompanyId(req, res);
  };

  app.get("/api/admin/issue-types", requireAuthentication, requireIssueTypeAdminAccess, async (req, res) => {
    const cid = resolveIssueTypeCompanyId(req, res); if (!cid) return;
    try {
      const rows = await storage.listAllIssueTypeConfigs(cid);
      res.json(rows);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "listAllIssueTypeConfigs",
        ctx: { cid },
        fallbackMessage: "Couldn't load issue types — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.post("/api/admin/issue-types", requireAuthentication, requireIssueTypeAdminAccess, async (req, res) => {
    const cid = resolveIssueTypeCompanyId(req, res); if (!cid) return;
    const parsed = issueTypeAdminBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid input", issues: parsed.error.issues });
      return;
    }
    try {
      const row = await storage.createIssueTypeConfig(cid, parsed.data);
      res.status(201).json(row);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "createIssueTypeConfig",
        ctx: { cid },
        fallbackMessage: "Couldn't create issue type — please retry",
        recognized: [
          {
            test: (err, raw) => err?.code === "23505" || /unique/i.test(raw),
            status: 409,
            message: "An issue type with that key already exists for this company.",
          },
        ],
      });
      res.status(status).json({ message });
    }
  });

  const issueTypePatchSchema = issueTypeAdminBodySchema.partial();
  app.patch("/api/admin/issue-types/:id", requireAuthentication, requireIssueTypeAdminAccess, async (req, res) => {
    const cid = resolveIssueTypeCompanyId(req, res); if (!cid) return;
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ message: "Invalid id" }); return; }
    const parsed = issueTypePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid input", issues: parsed.error.issues });
      return;
    }
    try {
      const row = await storage.updateIssueTypeConfig(cid, id, parsed.data);
      if (!row) { res.status(404).json({ message: "Not found" }); return; }
      res.json(row);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "updateIssueTypeConfig",
        ctx: { cid, id },
        fallbackMessage: "Couldn't update issue type — please retry",
        recognized: [
          {
            test: (err, raw) => err?.code === "23505" || /unique/i.test(raw),
            status: 409,
            message: "An issue type with that key already exists for this company.",
          },
        ],
      });
      res.status(status).json({ message });
    }
  });

  // Soft-delete via deactivation — preserves historical references.
  app.delete("/api/admin/issue-types/:id", requireAuthentication, requireIssueTypeAdminAccess, async (req, res) => {
    const cid = resolveIssueTypeCompanyId(req, res); if (!cid) return;
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ message: "Invalid id" }); return; }
    try {
      const row = await storage.updateIssueTypeConfig(cid, id, { isActive: false });
      if (!row) { res.status(404).json({ message: "Not found" }); return; }
      res.json(row);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "deactivateIssueTypeConfig",
        ctx: { cid, id },
        fallbackMessage: "Couldn't deactivate issue type — please retry",
      });
      res.status(status).json({ message });
    }
  });

  const issueTypeReorderSchema = z.object({
    orderedIds: z.array(z.coerce.number().int().positive()).min(1),
  });
  app.post("/api/admin/issue-types/reorder", requireAuthentication, requireIssueTypeAdminAccess, async (req, res) => {
    const cid = resolveIssueTypeCompanyId(req, res); if (!cid) return;
    const parsed = issueTypeReorderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid input", issues: parsed.error.issues });
      return;
    }
    try {
      const rows = await storage.reorderIssueTypeConfigs(cid, parsed.data.orderedIds);
      res.json(rows);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "reorderIssueTypeConfigs",
        ctx: { cid },
        fallbackMessage: "Couldn't reorder issue types — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.get("/api/wet-checks/parts/by-issue", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    const issueType = String(req.query.issueType ?? "");
    if (!issueType) { res.status(400).json({ message: "issueType required" }); return; }
    const customerId = req.query.customerId ? parseInt(String(req.query.customerId)) : null;
    try {
      const result = await storage.getPartsByIssueType(cid, issueType, customerId);
      res.json(result);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "getPartsByIssueType",
        ctx: { cid, issueType, customerId },
        fallbackMessage: "Couldn't load parts for that issue — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.get("/api/properties/:customerId/controllers", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    const customerId = parseInt(req.params.customerId);
    // Task #315 — optional ?branch= query param for multi-branch customers.
    // When provided, return only that branch's controllers (and lazily
    // bootstrap them if the branch has no rows yet). When absent, preserve
    // the pre-Task-#315 behaviour: return the customer-level (empty-string)
    // bucket only, exposing branchName: null on the wire.
    const branchParam = typeof req.query.branch === "string" ? req.query.branch.trim() : null;
    try {
      if (branchParam !== null) {
        // Branch-scoped fetch: return the named branch's controllers.
        // Lazily bootstrap if the branch is empty (new branch, first tech visit).
        const customer = await storage.getCustomer(customerId);
        if (!customer || customer.companyId !== cid) {
          res.status(404).json({ message: "Customer not found" });
          return;
        }
        // irrigation_controllers is the single source of truth.
        const irrigCtrlsForBranch = await storage.listIrrigationControllers(cid, customerId, branchParam);
        let { seedConfigs } = buildWetCheckGrid(irrigCtrlsForBranch);
        // When no profile exists yet, seed from customers.totalControllers (clamped 1–26).
        if (seedConfigs.length === 0) {
          const CTRL_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
          const n = Math.min(26, Math.max(1, customer.totalControllers ?? 1));
          seedConfigs = Array.from({ length: n }, (_, i) => ({ name: `Controller ${CTRL_ALPHA[i]}`, zoneCount: null }));
        }
        const irrigCtrls = await storage.ensureIrrigationControllers(cid, customerId, seedConfigs, branchParam);
        // Map IrrigationController → PropertyController-compatible wire shape
        // so all existing wet-check UI consumers continue to work without frontend changes.
        res.json(irrigCtrls.map(ctrl => ({
          id: ctrl.id,
          companyId: ctrl.companyId,
          customerId: ctrl.customerId,
          branchName: branchParam || null,
          controllerLetter: ctrl.letter,
          zoneCount: ctrl.totalZones,
          notes: ctrl.notes ?? null,
        })));
        return;
      }
      // Customer-level endpoint: irrigation_controllers stores customer-level
      // rows under branchName='' (empty string), not null.
      const customerNoBranch = await storage.getCustomer(customerId);
      if (!customerNoBranch || customerNoBranch.companyId !== cid) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }
      const irrigCtrlsNoBranch = await storage.listIrrigationControllers(cid, customerId, "");
      let { seedConfigs: seedConfigsNoBranch } = buildWetCheckGrid(irrigCtrlsNoBranch);
      // When no profile exists yet, seed from customers.totalControllers (clamped 1–26).
      if (seedConfigsNoBranch.length === 0) {
        const NB_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const n = Math.min(26, Math.max(1, customerNoBranch.totalControllers ?? 1));
        seedConfigsNoBranch = Array.from({ length: n }, (_, i) => ({ name: `Controller ${NB_ALPHA[i]}`, zoneCount: null }));
      }
      const seededNoBranch = await storage.ensureIrrigationControllers(cid, customerId, seedConfigsNoBranch, "");
      // Expose customer-level bucket as branchName: null on the wire.
      res.json(seededNoBranch.map(ctrl => ({
        id: ctrl.id,
        companyId: ctrl.companyId,
        customerId: ctrl.customerId,
        branchName: null,
        controllerLetter: ctrl.letter,
        zoneCount: ctrl.totalZones,
        notes: ctrl.notes ?? null,
      })));
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "listControllers",
        ctx: { cid, customerId },
        fallbackMessage: "Couldn't load controllers — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // PATCH /api/properties/:customerId/controllers — body identifies the
  // controller by letter, matching the spec's "get + patch at the same
  // collection path" contract.
  const propertyControllerPatchBody = z.object({
    controllerLetter: z.string().length(1).transform(s => s.toUpperCase())
      .refine(s => s >= "A" && s <= "Z", "controllerLetter must be A-Z"),
    zoneCount: z.coerce.number().int().min(1).max(100).optional(),
    notes: z.string().nullish(),
  });
  app.patch("/api/properties/:customerId/controllers", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const customerId = parseInt(req.params.customerId);
    const parsed = propertyControllerPatchBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const { controllerLetter, zoneCount, notes } = parsed.data;
    try {
      // Verify the customer belongs to the caller's company before any write.
      // The update path is already company-scoped, but the upsert fallback
      // would otherwise allow cross-tenant writes via a foreign customerId.
      const owner = await storage.getCustomer(customerId);
      if (!owner || owner.companyId !== cid) {
        res.status(404).json({ message: "Not found" });
        return;
      }
      // Task #1857: property_controllers is dropped; look up the irrigation_controller by letter.
      const branchParam = typeof req.query.branch === "string" ? req.query.branch.trim() : "";
      const ctrls = await storage.listIrrigationControllers(cid, customerId, branchParam);
      const ctrl = ctrls.find(c => c.letter === controllerLetter);
      if (!ctrl) { res.status(404).json({ message: "Controller not found" }); return; }
      const patch: Record<string, unknown> = { lastUpdatedAt: new Date() };
      if (zoneCount !== undefined) patch.totalZones = zoneCount;
      if (notes !== undefined) patch.notes = notes;
      const [updated] = await db.update(irrigationControllers)
        .set(patch)
        .where(eq(irrigationControllers.id, ctrl.id))
        .returning();
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      res.json({
        id: updated.id,
        companyId: updated.companyId,
        customerId: updated.customerId,
        branchName: branchParam || null,
        controllerLetter: updated.letter,
        zoneCount: updated.totalZones,
        notes: updated.notes ?? null,
      });
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "patchPropertyController",
        ctx: { cid, customerId, controllerLetter },
        fallbackMessage: "Couldn't save controller — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // ─── Needs Review queue (Spec B cross-spec interface) ───────────────────────
  //
  // GET /api/wet-checks/needs-review
  //   Returns wet checks requiring manager attention per the membership rule:
  //     1. status ∈ {submitted, pending_manager_review}  — always in queue
  //     2. status = partially_converted AND ≥1 unrouted non-documented finding
  //     3. wet check has a WCB snapshot with status ∈ PENDING_REVIEW_WCB (pre-approval)
  //   Wet checks with status ∈ {approved, converted} (non-overlapping APPROVED_WC
  //   members) are excluded even when rule 3 fires.
  //   Status constants are imported from manager-workspace-routes (ACTIVE_WC,
  //   APPROVED_WC) and billing-workspace-routes (PENDING_REVIEW_WCB) — never hardcoded.
  //
  // Scoping: super_admin sees every company; all other roles are company-scoped.
  //
  // Response: { count: number, items: NeedsReviewItem[] }
  //   NeedsReviewItem = WetCheck & { outstandingWork: { unroutedFindings: number, snapshotPending: boolean } }
  //
  // The `count` field is the stable Spec B cross-spec interface consumed by
  // the Manager Workspace hub tile. Treat it as a contract: do not rename or
  // remove it without a version bump.
  app.get("/api/wet-checks/needs-review", requireAuthentication, async (req, res) => {
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    // super_admin is unscoped; all other manager roles must have a company.
    const isSuperAdmin = req.authenticatedUserRole === "super_admin";
    const cid = isSuperAdmin ? null : req.authenticatedUserCompanyId;
    if (!isSuperAdmin && !cid) {
      res.status(403).json({ message: "Company scope required" });
      return;
    }

    try {
      // ── Step 1: discover WCB-qualified wet check IDs ────────────────────────
      // A wet check qualifies via rule 3 when it has a WCB snapshot whose
      // status ∈ PENDING_REVIEW_WCB (pre-approval only — submitted or
      // pending_manager_review). Fetch those IDs first so the main query can
      // include them even when the wet check's own status is outside ACTIVE_WC.
      // Simple fetch: company-scoped or all
      const wcbRows = cid != null
        ? await db
            .select({ wetCheckId: wetCheckBillings.wetCheckId, status: wetCheckBillings.status })
            .from(wetCheckBillings)
            .innerJoin(wetChecks, eq(wetCheckBillings.wetCheckId, wetChecks.id))
            .where(and(
              inArray(wetCheckBillings.status, [...PENDING_REVIEW_WCB]),
              eq(wetChecks.companyId, cid),
            ))
        : await db
            .select({ wetCheckId: wetCheckBillings.wetCheckId, status: wetCheckBillings.status })
            .from(wetCheckBillings)
            .where(inArray(wetCheckBillings.status, [...PENDING_REVIEW_WCB]));

      const wcbQualifiedIdSet = new Set(wcbRows.map(r => r.wetCheckId));

      // ── Step 2: fetch all candidate wet checks ──────────────────────────────
      // Candidates are wet checks where:
      //   (status ∈ ACTIVE_WC) OR (id ∈ wcbQualifiedIds)
      // Wet checks with status ∈ {approved, converted} are normally excluded —
      // these are the APPROVED_WC members that do NOT overlap with ACTIVE_WC.
      // EXCEPTION: a wet check with one of those statuses still passes the
      // exclusion guard when it qualifies via rule 3 (id ∈ wcbQualifiedIds).
      // Correct predicate: (status NOT IN excluded) OR (id ∈ wcbQualifiedIds).
      // (partially_converted overlaps both sets and is handled by in-memory rule 2.)
      const excludedStatuses = [...APPROVED_WC].filter(s => !ACTIVE_WC.has(s));

      // Materialise wcbIds early so we can reference them in both the
      // exclusion guard and the inclusion clause below.
      const wcbIds = [...wcbQualifiedIdSet];

      // Build the WHERE conditions piece by piece to stay type-safe.
      const statusInActiveWc = inArray(wetChecks.status, [...ACTIVE_WC]);
      // The exclusion clause must allow through any wet check that qualifies
      // via rule 3 (WCB snapshot), even when its own status is converted/approved.
      const notExcluded = excludedStatuses.length > 0
        ? (wcbIds.length > 0
          ? or(
              sql`${wetChecks.status} NOT IN (${sql.join(excludedStatuses.map(s => sql`${s}`), sql`, `)})`,
              inArray(wetChecks.id, wcbIds),
            )
          : sql`${wetChecks.status} NOT IN (${sql.join(excludedStatuses.map(s => sql`${s}`), sql`, `)})`)
        : undefined;

      // OR-combine the two inclusion paths.
      const inclusionClause = wcbIds.length > 0
        ? or(statusInActiveWc, inArray(wetChecks.id, wcbIds))
        : statusInActiveWc;

      const conditions: (ReturnType<typeof and> | ReturnType<typeof sql.join> | undefined)[] = [
        inclusionClause,
        notExcluded,
      ].filter(Boolean);

      if (cid != null) {
        conditions.push(eq(wetChecks.companyId, cid));
      }

      const candidates = await db.select().from(wetChecks)
        .where(and(...(conditions as Parameters<typeof and>)))
        .orderBy(desc(wetChecks.submittedAt));

      if (candidates.length === 0) {
        res.json({ count: 0, items: [] });
        return;
      }

      // ── Step 3: load findings, WCBs, and inspection estimates ─────────────
      const wcIds = candidates.map(w => w.id);
      const [findings, wcbs, inspectionEstimates] = await Promise.all([
        db.select().from(wetCheckFindings).where(inArray(wetCheckFindings.wetCheckId, wcIds)),
        db.select().from(wetCheckBillings).where(inArray(wetCheckBillings.wetCheckId, wcIds)),
        // Inspection-mode Rule 4: fetch estimates whose origin is one of the
        // candidate wet checks. Used to determine if the estimate still needs
        // manager review (lifecycle != 'approved').
        db.select({
          id: estimates.id,
          originWetCheckId: estimates.originWetCheckId,
          lifecycle: estimates.lifecycle,
        }).from(estimates).where(inArray(estimates.originWetCheckId, wcIds)),
      ]);

      // Index by wet check id for O(1) lookup.
      const findingsByWc = new Map<number, (typeof findings)[number][]>();
      for (const f of findings) {
        const arr = findingsByWc.get(f.wetCheckId) ?? [];
        arr.push(f);
        findingsByWc.set(f.wetCheckId, arr);
      }
      // Keep the highest-id WCB per wet check (one per wet check by design).
      const wcbByWc = new Map<number, (typeof wcbs)[number]>();
      for (const wcb of wcbs) {
        const existing = wcbByWc.get(wcb.wetCheckId);
        if (!existing || wcb.id > existing.id) wcbByWc.set(wcb.wetCheckId, wcb);
      }
      // Index inspection estimate by origin wet check id.
      const inspEstByWc = new Map<number, { lifecycle: string | null }>();
      for (const e of inspectionEstimates) {
        if (e.originWetCheckId != null) inspEstByWc.set(e.originWetCheckId, e);
      }

      // ── Step 4: apply membership rule in-memory and annotate ────────────────
      type ReviewType = "triage" | "snapshot" | "inspection_estimate";
      type NeedsReviewItem = (typeof candidates)[number] & {
        outstandingWork: {
          unroutedFindings: number;
          snapshotPending: boolean;
          inspectionEstimatePending: boolean;
        };
        // Primary action bucket for this item. Deduplication priority:
        // triage > snapshot > inspection_estimate (display order is different).
        reviewType: ReviewType;
      };
      const items: NeedsReviewItem[] = [];

      for (const wc of candidates) {
        const wFindings = findingsByWc.get(wc.id) ?? [];
        const wcb = wcbByWc.get(wc.id);

        // Rule 3 signal: WCB snapshot exists and is in pre-approval state
        // (submitted or pending_manager_review only — not approved_passed_to_billing).
        const snapshotPending = wcb != null && PENDING_REVIEW_WCB.has(wcb.status);

        // Rule 4 signal (Inspection Mode): this is an inspection wet check
        // whose own status is still active (submitted/pending_manager_review/
        // partially_converted). The WC leaves the queue naturally once it
        // transitions to `converted` at the pass-to-estimates hand-off.
        // No estimate-lifecycle check needed — the WC status alone is the gate.
        const inspectionEstimatePending =
          (wc as any).mode === "inspection" &&
          ACTIVE_WC.has(wc.status);

        // Unrouted = finding still needs a manager routing decision AND is not
        // yet stamped to any destination. Uses the shared isUnroutedFinding
        // predicate so this count always agrees with CombinedReviewSurface.tsx.
        const unroutedFindings = wFindings.filter(f => isUnroutedFinding(f)).length;

        const s = wc.status;
        let qualifies = false;

        // Rule 1: freshly submitted or pending manager review.
        if (s === "submitted" || s === "pending_manager_review") qualifies = true;
        // Rule 2: partially converted but still has unrouted findings.
        if (s === "partially_converted" && unroutedFindings > 0) qualifies = true;
        // Rule 3: snapshot exists and is not yet in an approved/billed state.
        if (snapshotPending) qualifies = true;
        // Rule 4: inspection wet check whose estimate has not been approved yet.
        if (inspectionEstimatePending) qualifies = true;

        if (qualifies) {
          // Deduplication priority: triage wins over snapshot wins over inspection_estimate.
          const reviewType: ReviewType =
            unroutedFindings > 0 ? "triage" :
            snapshotPending ? "snapshot" :
            "inspection_estimate";
          items.push({
            ...wc,
            outstandingWork: { unroutedFindings, snapshotPending, inspectionEstimatePending },
            reviewType,
          });
        }
      }

      // `count` is computed from the full filtered set — no cap, no offset.
      // This is the Spec B stable cross-spec contract for the hub tile.
      res.json({ count: items.length, items });
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "listWetChecksNeedsReview",
        ctx: { cid: cid ?? "super_admin" },
        fallbackMessage: "Couldn't load needs review queue — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Manager inbox aggregate: submitted wet checks with per-row issueGroup
  // counts and total estimated billable. Backs the Pending Review summary
  // chips in /wet-checks/pending-review.
  app.get("/api/wet-checks/pending-review", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    try {
      const rows = await storage.listWetChecksPendingReview(cid);
      res.json(rows);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "listWetChecksPendingReview",
        ctx: { cid },
        fallbackMessage: "Couldn't load pending review — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.get("/api/wet-checks", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    try {
      const opts: { status?: string; technicianId?: number; customerId?: number; branchName?: string } = {};
      if (req.query.status) opts.status = String(req.query.status);
      if (req.query.mine === "1" && req.authenticatedUserId) opts.technicianId = req.authenticatedUserId;
      if (req.query.customerId) opts.customerId = parseInt(String(req.query.customerId));
      if (req.query.branchName != null) opts.branchName = String(req.query.branchName);
      const rows = await storage.listWetChecks(cid, opts);
      // When customerId is provided, support offset-based loading so the
      // Customer Hub can page through long histories without loading all
      // records up front. paginate() sets X-Total-Count and slices.
      res.json(opts.customerId ? paginate(req, res, rows, { limit: 10, max: 200 }) : rows);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "listWetChecks",
        ctx: { cid },
        fallbackMessage: "Couldn't load wet checks — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Counts endpoint for the wet-check status tab strip. Runs a single
  // grouped query and buckets results into the five display groups:
  // needsReview, inProgress, readyToBill, billed, all.
  // super_admin: global aggregate across all companies.
  // Other allowed roles: scoped to their own company.
  app.get("/api/wet-checks/admin/counts", requireAuthentication, async (req, res) => {
    const role = req.authenticatedUserRole;
    if (
      role !== "company_admin" &&
      role !== "super_admin" &&
      role !== "irrigation_manager" &&
      role !== "billing_manager"
    ) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    // super_admin sees all companies; everyone else must be scoped to their company.
    let companyCondition: SQL | undefined;
    if (role !== "super_admin") {
      const cid = requireCompanyId(req, res);
      if (!cid) return;
      companyCondition = eq(wetChecks.companyId, cid);
    }
    try {
      const query = db
        .select({
          needsReview: sql<number>`cast(count(*) filter (where ${wetChecks.status} in ('submitted','pending_manager_review')) as int)`,
          inProgress: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'in_progress') as int)`,
          readyToBill: sql<number>`cast(count(*) filter (where ${wetChecks.status} in ('approved','approved_passed_to_billing','partially_converted','converted')) as int)`,
          billed: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'billed') as int)`,
          all: sql<number>`cast(count(*) as int)`,
          // Granular per-status counts for the More Filters panel checkboxes.
          s_in_progress: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'in_progress') as int)`,
          s_submitted: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'submitted') as int)`,
          s_pending_manager_review: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'pending_manager_review') as int)`,
          s_approved: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'approved') as int)`,
          s_approved_passed_to_billing: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'approved_passed_to_billing') as int)`,
          s_partially_converted: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'partially_converted') as int)`,
          s_converted: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'converted') as int)`,
          s_billed: sql<number>`cast(count(*) filter (where ${wetChecks.status} = 'billed') as int)`,
        })
        .from(wetChecks);
      const rows = companyCondition
        ? await query.where(companyCondition)
        : await query;
      const row = rows[0] ?? {
        needsReview: 0, inProgress: 0, readyToBill: 0, billed: 0, all: 0,
        s_in_progress: 0, s_submitted: 0, s_pending_manager_review: 0,
        s_approved: 0, s_approved_passed_to_billing: 0,
        s_partially_converted: 0, s_converted: 0, s_billed: 0,
      };
      res.json({
        needsReview: Number(row.needsReview),
        inProgress: Number(row.inProgress),
        readyToBill: Number(row.readyToBill),
        billed: Number(row.billed),
        all: Number(row.all),
        perStatus: {
          in_progress: Number(row.s_in_progress),
          submitted: Number(row.s_submitted),
          pending_manager_review: Number(row.s_pending_manager_review),
          approved: Number(row.s_approved),
          approved_passed_to_billing: Number(row.s_approved_passed_to_billing),
          partially_converted: Number(row.s_partially_converted),
          converted: Number(row.s_converted),
          billed: Number(row.s_billed),
        },
      });
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "wetCheckAdminCounts",
        ctx: { role },
        fallbackMessage: "Couldn't load wet check counts — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Company-admin-only company-wide management list. Returns every wet
  // check for the company with aggregate child counts so the admin page
  // can render delete affordances without fanning out per-row fetches.
  app.get("/api/wet-checks/admin", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (
      req.authenticatedUserRole !== "company_admin" &&
      req.authenticatedUserRole !== "super_admin" &&
      req.authenticatedUserRole !== "irrigation_manager" &&
      req.authenticatedUserRole !== "billing_manager"
    ) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    try {
      const statusParam = req.query.status;
      const opts: { status?: string | string[] } = {};
      if (Array.isArray(statusParam)) {
        opts.status = statusParam.map(String);
      } else if (statusParam) {
        opts.status = String(statusParam);
      }
      const rows = await storage.listWetChecksForAdmin(cid, opts);
      res.json(rows);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "listWetChecksForAdmin",
        ctx: { cid },
        fallbackMessage: "Couldn't load wet checks — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Bulk hard delete — company_admin only. Each id is processed
  // independently and the response reports per-id outcome so the UI can
  // tell the admin which wet checks could not be deleted (typically
  // because findings have already been routed downstream). Using DELETE
  // with a JSON body matches the existing billing-sheets bulk endpoint.
  app.delete("/api/wet-checks/bulk-delete", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (
      req.authenticatedUserRole !== "company_admin" &&
      req.authenticatedUserRole !== "super_admin" &&
      req.authenticatedUserRole !== "irrigation_manager"
    ) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!rawIds || rawIds.length === 0) {
      res.status(400).json({ message: "ids must be a non-empty array of numbers" });
      return;
    }
    const validIds = Array.from(new Set(
      rawIds
        .map((x: any) => Number(x))
        .filter((n: number) => Number.isInteger(n) && n > 0)
    )) as number[];
    if (validIds.length === 0) {
      res.status(400).json({ message: "No valid IDs provided" });
      return;
    }
    type Outcome = {
      id: number;
      status: 'deleted' | 'blocked' | 'not_found' | 'error';
      message?: string;
      blockers?: WetCheckHasInvoicedRecordsError['blockers'];
      code?: string;
      billingNumbers?: (string | null)[];
    };
    const results: Outcome[] = [];
    for (const id of validIds) {
      try {
        const wcBefore = await storage.getWetCheck(id, cid).catch(() => null);
        const ok = await storage.deleteWetCheck(id, cid);
        if (ok) {
          await recordLifecycleAudit(req, {
            resource: "wet_check",
            action: "wet_check.deleted",
            targetId: id,
            companyId: cid,
            before: { status: wcBefore?.status, customerName: wcBefore?.customerName },
            after: { deleted: true },
            summary: `Wet check ${id} deleted (bulk)`,
          });
        }
        results.push({ id, status: ok ? 'deleted' : 'not_found' });
      } catch (e: any) {
        if (e instanceof WetCheckHasInvoicedRecordsError) {
          results.push({
            id,
            status: 'blocked',
            message: e.message,
            blockers: e.blockers,
          });
        } else if (e instanceof WetCheckHasBillingSheetError) {
          results.push({
            id,
            status: 'blocked',
            message: e.message,
            code: e.code,
            billingNumbers: e.billingNumbers,
          });
        } else if (e instanceof WetCheckHasWetCheckBillingError) {
          results.push({
            id,
            status: 'blocked',
            message: e.message,
            code: e.code,
            billingNumbers: e.billingNumbers,
          });
        } else {
          const raw = typeof e?.message === 'string' ? e.message : '';
          if (/not found for company/.test(raw)) {
            results.push({ id, status: 'not_found', message: 'Not found' });
          } else {
            // SQL-leak guard (Task #502): never echo Drizzle's
            // "Failed query: ..." string in the per-row outcome.
            const cls = classifyAndLog(req, e, {
              op: 'bulkDeleteWetCheck',
              ctx: { cid, id },
              fallbackMessage: "Couldn't delete — please retry",
            });
            results.push({ id, status: 'error', message: cls.message });
          }
        }
      }
    }
    const summary = {
      requested: validIds.length,
      deleted: results.filter(r => r.status === 'deleted').length,
      blocked: results.filter(r => r.status === 'blocked').length,
      notFound: results.filter(r => r.status === 'not_found').length,
      failed: results.filter(r => r.status === 'error').length,
    };
    res.json({ results, summary });
  });

  // Hard delete — company_admin only. 409 when any finding has been
  // routed downstream (billing sheet / estimate / work order).
  app.delete("/api/wet-checks/:id", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (
      req.authenticatedUserRole !== "company_admin" &&
      req.authenticatedUserRole !== "super_admin" &&
      req.authenticatedUserRole !== "irrigation_manager"
    ) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ message: "Invalid id" }); return; }
    try {
      const wcBefore = await storage.getWetCheck(id, cid).catch(() => null);
      const ok = await storage.deleteWetCheck(id, cid);
      if (!ok) { res.status(404).json({ message: "Not found" }); return; }
      await recordLifecycleAudit(req, {
        resource: "wet_check",
        action: "wet_check.deleted",
        targetId: id,
        companyId: cid,
        before: { status: wcBefore?.status, customerName: wcBefore?.customerName },
        after: { deleted: true },
        summary: `Wet check ${id} deleted`,
      });
      res.json({ ok });
    } catch (e: any) {
      if (e instanceof WetCheckHasInvoicedRecordsError) {
        res.status(409).json({
          message: e.message,
          blockers: e.blockers,
        });
        return;
      }
      if (e instanceof WetCheckHasBillingSheetError) {
        res.status(409).json({
          message: e.message,
          code: e.code,
          billingNumbers: e.billingNumbers,
        });
        return;
      }
      if (e instanceof WetCheckHasWetCheckBillingError) {
        res.status(409).json({
          message: e.message,
          code: e.code,
          billingNumbers: e.billingNumbers,
        });
        return;
      }
      const { status, message } = classifyAndLog(req, e, {
        op: "deleteWetCheck",
        ctx: { cid, id },
        fallbackMessage: "Couldn't delete wet check — please retry",
        recognized: [
          { test: (_e, raw) => /not found for company/.test(raw), status: 404, message: "Not found" },
        ],
      });
      res.status(status).json({ message });
    }
  });

  app.get("/api/wet-checks/:id", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    try {
      const wc = await storage.getWetCheck(parseInt(req.params.id), cid);
      if (!wc) { res.status(404).json({ message: "Not found" }); return; }
      res.json(wc);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "getWetCheck",
        ctx: { cid, wetCheckId: req.params.id },
        fallbackMessage: "Couldn't load wet check — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.get("/api/wet-checks/:id/pdf", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) { res.status(400).json({ message: "Invalid id" }); return; }
      const wc = await storage.getWetCheck(id, cid);
      if (!wc) { res.status(404).json({ message: "Not found" }); return; }

      const company = await storage.getCompanyProfile(cid);
      const { renderWetCheckPdf } = await import("../wet-check-pdf");
      const pdf = await renderWetCheckPdf(wc, { company: company ?? null });

      const wantsDownload = String(req.query?.download ?? "") === "1";
      const safeCustomer = (wc.customerName ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const date = wc.startedAt
        ? new Date(wc.startedAt).toISOString().slice(0, 10)
        : "unknown";
      const filename = safeCustomer
        ? `${safeCustomer} - Wet Check ${id} - ${date}.pdf`
        : `wet-check-${id}-${date}.pdf`;
      // eslint-disable-next-line no-control-regex
      const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      const utf8Filename = encodeURIComponent(filename);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `${wantsDownload ? "attachment" : "inline"}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`,
      );
      res.send(pdf);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "wetCheckPdf",
        ctx: { cid, wetCheckId: req.params.id },
        fallbackMessage: "Failed to generate PDF",
      });
      res.status(status).json({ message });
    }
  });

  // ── Customer-facing condition report PDF ──────────────────────────────────
  // Separate from the internal /pdf route — no labor, PSI/GPM, or pricing.
  // Only manager/admin/billing roles may download or send this report.

  app.get("/api/wet-checks/:id/report-pdf", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) {
      res.status(403).json({ message: "Access restricted to manager/admin/billing roles" }); return;
    }
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) { res.status(400).json({ message: "Invalid id" }); return; }
      const wc = await storage.getWetCheck(id, cid);
      if (!wc) { res.status(404).json({ message: "Not found" }); return; }

      const company = await storage.getCompanyProfile(cid);
      const { renderWetCheckReportPdf } = await import("../wet-check-report-pdf");
      const pdf = await renderWetCheckReportPdf(wc, { company: company ?? null });

      const wantsDownload = String(req.query?.download ?? "") === "1";
      const safeCustomer = (wc.customerName ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const date = wc.startedAt
        ? new Date(wc.startedAt).toISOString().slice(0, 10)
        : "unknown";
      const filename = safeCustomer
        ? `${safeCustomer} - Inspection Report - ${date}.pdf`
        : `inspection-report-${id}-${date}.pdf`;
      // eslint-disable-next-line no-control-regex
      const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      const utf8Filename = encodeURIComponent(filename);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `${wantsDownload ? "attachment" : "inline"}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`,
      );
      res.send(pdf);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "wetCheckReportPdf",
        ctx: { cid, wetCheckId: req.params.id },
        fallbackMessage: "Failed to generate customer report PDF",
      });
      res.status(status).json({ message });
    }
  });

  app.post("/api/wet-checks/:id/report/send", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) {
      res.status(403).json({ message: "Access restricted to manager/admin/billing roles" }); return;
    }
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) { res.status(400).json({ message: "Invalid id" }); return; }
      const wc = await storage.getWetCheck(id, cid);
      if (!wc) { res.status(404).json({ message: "Not found" }); return; }

      const { to, note } = req.body ?? {};
      // Determine recipient: explicit override or customer email on file
      let toEmail: string | null = typeof to === "string" && to.trim() ? to.trim() : null;
      if (!toEmail) {
        const customer = await storage.getCustomer(wc.customerId);
        toEmail = customer?.email ?? null;
      }
      if (!toEmail) {
        res.status(422).json({ message: "No email address on file for this customer. Provide a 'to' email." });
        return;
      }

      const company = await storage.getCompanyProfile(cid);
      const { renderWetCheckReportPdf } = await import("../wet-check-report-pdf");
      const pdf = await renderWetCheckReportPdf(wc, { company: company ?? null });

      const inspectionDate = wc.startedAt
        ? new Date(wc.startedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
        : "—";

      await EmailService.sendWetCheckReport({
        to: toEmail,
        customerName: wc.customerName ?? "",
        propertyAddress: wc.propertyAddress ?? null,
        technicianName: wc.technicianName ?? null,
        inspectionDate,
        companyName: company?.name ?? "IrrigoPro",
        companyEmail: company?.email ?? null,
        companyPhone: company?.phone ?? null,
        pdfBuffer: pdf,
        wetCheckId: id,
        note: typeof note === "string" ? note : undefined,
      });

      res.json({ sent: true, to: toEmail });
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "wetCheckReportSend",
        ctx: { cid, wetCheckId: req.params.id },
        fallbackMessage: "Failed to send customer report",
      });
      res.status(status).json({ message });
    }
  });

  // numControllers is intentionally NOT accepted from the client — the
  // server is authoritative and always derives it from the customer record
  // (customer.totalControllers) so a manipulated client cannot under- or
  // over-scope a wet check.
  // Exception: `blankStart: true` is accepted from the Slice 3 controller-
  // selection UI when the customer has no site-map controllers on file. In
  // that case the server skips ensurePropertyControllers and records
  // numControllers=0 so the tech can add zones manually as they go.
  // Schema, branchName normalisation, and branch gate are extracted to
  // wet-check-create-gate.ts so they can be unit-tested without standing
  // up the full registerRoutes() side effects (Task #1463).

  app.post("/api/wet-checks", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const parsed = wetCheckCreateBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const body = parsed.data;
    try {
      const customer = await storage.getCustomer(body.customerId);
      if (!customer || customer.companyId !== cid) { res.status(404).json({ message: "Customer not found" }); return; }
      const techId = req.authenticatedUserId;
      if (!techId) { res.status(401).json({ message: "Authentication required" }); return; }
      const tech = await storage.getUser(techId);
      if (!tech) { res.status(401).json({ message: "User not found" }); return; }

      // Normalise branchName: empty string → null (consistent with
      // wet_check_billings / work_orders convention).
      const branchName = normalizeBranchName(body.branchName);

      // Gate: if the customer has branches, a branch must be selected.
      const customerBranches = Array.isArray(customer.branches) ? customer.branches as string[] : [];
      const branchGateError = checkBranchGate(customerBranches, branchName);
      if (branchGateError) {
        res.status(400).json({ message: branchGateError });
        return;
      }

      // Resume an existing in-progress wet check at this property/branch for this
      // tech before creating a new one. Idempotent for the common "tap New again" case.
      // Branch-scoped so a tech can have one in-progress check per branch.
      const existing = await storage.findActiveWetCheck(cid, body.customerId, tech.id, branchName);
      if (existing) {
        res.status(200).json(existing);
        return;
      }

      // blankStart=true: caller confirmed no site-map controllers.
      // Skip grid seeding entirely; numControllers=0. Profile is NOT consulted.
      let numControllers: number;
      if (body.blankStart) {
        numControllers = 0;
      } else {
        // branchName is null for customer-level; irrigation_controllers stores
        // customer-level rows under branchName='' — use "" as the branchKey so
        // listIrrigationControllers applies the branch filter correctly.
        const branchKey = branchName ?? "";
        const irrigCtrlsForWC = await storage.listIrrigationControllers(cid, body.customerId, branchKey);
        let gridResult = buildWetCheckGrid(irrigCtrlsForWC);
        // When no irrigation profile exists yet, seed from customers.totalControllers
        // (clamped 1–26). property_controllers is no longer available.
        if (gridResult.seedConfigs.length === 0) {
          const WC_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
          const numCtrl = Math.min(26, Math.max(1, customer.totalControllers ?? 1));
          gridResult = {
            numControllers: numCtrl,
            seedConfigs: Array.from({ length: numCtrl }, (_, i) => ({
              name: `Controller ${WC_ALPHABET[i]}`,
              zoneCount: null,
            })),
          };
        }
        numControllers = gridResult.numControllers;
        await storage.ensureIrrigationControllers(cid, body.customerId, gridResult.seedConfigs, branchName);
      }

      const wc = await storage.createWetCheck({
        companyId: cid,
        customerId: body.customerId,
        technicianId: tech.id,
        technicianName: tech.name,
        customerName: customer.name,
        propertyAddress: customer.address ?? null,
        numControllers,
        status: "in_progress",
        weather: body.weather ?? null,
        notes: body.notes ?? null,
        clientId: body.clientId ?? null,
        mode: body.mode ?? "service",
        branchName,
      });
      res.status(201).json(wc);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "createWetCheck",
        ctx: { cid, customerId: body.customerId },
        fallbackMessage: "Couldn't start wet check — please retry",
      });
      res.status(status).json({ message });
    }
  });

  const wetCheckPatchBody = z.object({
    weather: z.string().nullish(),
    notes: z.string().nullish(),
    numControllers: z.coerce.number().int().min(1).max(26).optional(),
  }).partial();

  app.patch("/api/wet-checks/:id", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const parsed = wetCheckPatchBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    try {
      const wcId = parseInt(req.params.id);
      // Billed lock: reject edits if any billing sheet derived from this wet check is billed/invoiced.
      // Mirrors the lock on PATCH /api/work-orders/:id and /api/billing-sheets/:id.
      const billedRows = await db.execute<{ id: number }>(sql`
        SELECT bs.id FROM billing_sheets bs
        JOIN wet_check_billings wcb ON wcb.billing_sheet_id = bs.id
        WHERE wcb.wet_check_id = ${wcId}
          AND (bs.status = 'billed' OR bs.invoice_id IS NOT NULL)
        LIMIT 1
      `);
      if (billedRows.rows.length > 0) {
        res.status(409).json({ message: "This record has been billed and cannot be edited." });
        return;
      }
      const updated = await storage.updateWetCheck(wcId, cid, parsed.data);
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "updateWetCheck",
        ctx: { cid, wetCheckId: req.params.id },
        fallbackMessage: "Couldn't save wet check — please retry",
      });
      res.status(status).json({ message });
    }
  });

  const submitBody = z.object({ clientId: z.string().uuid().nullish() }).partial();
  app.post("/api/wet-checks/:id/submit", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    // Body is optional; if provided, validate clientId shape only.
    if (req.body && Object.keys(req.body).length > 0) {
      const parsed = submitBody.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() }); return; }
    }
    try {
      const wcId = parseInt(req.params.id);
      const wcBefore = await storage.getWetCheck(wcId, cid).catch(() => null);
      const result = await storage.submitWetCheck(wcId, cid);
      if (!result) { res.status(404).json({ message: "Not found" }); return; }
      await recordLifecycleAudit(req, {
        resource: "wet_check",
        action: "wet_check.submitted",
        targetId: wcId,
        companyId: cid,
        before: { status: wcBefore?.status },
        after: {
          status: result.wetCheck.status,
          billingSheetId: result.billingSheetId,
          autoBilledCount: result.autoBilledCount,
          pendingCount: result.pendingCount,
        },
        summary: `Wet check ${wcId} submitted`,
        extra: {
          billingSheetId: result.billingSheetId,
          autoBilledCount: result.autoBilledCount,
          pendingCount: result.pendingCount,
        },
      });
      // Spread wetCheck so legacy clients that read fields directly off the
      // response (status, submittedAt, etc.) keep working; the new
      // billingSheetId / autoBilledCount / pendingCount surface alongside.
      res.json({
        ...result.wetCheck,
        billingSheetId: result.billingSheetId,
        autoBilledCount: result.autoBilledCount,
        pendingCount: result.pendingCount,
      });
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "submitWetCheck",
        ctx: { cid, wetCheckId: req.params.id },
        fallbackMessage: "Couldn't submit wet check — please retry",
        recognized: [
          { test: (_e, raw) => /zero zones checked/.test(raw), status: 400, message: (_e, raw) => raw },
          // Task #600 — auto-bill preconditions thrown from
          // storage.submitWetCheck (missing part, non-positive qty,
          // negative labor hours) are user-fixable, not server faults.
          // Return 400 with the storage-authored instructional message
          // verbatim so the tech sees "add a part / tick No part needed
          // / leave Mark Complete unchecked" instead of a generic toast.
          { test: (_e, raw) => /^Cannot auto-bill finding/.test(raw), status: 400, message: (_e, raw) => raw },
        ],
      });
      res.status(status).json({ message });
    }
  });

  // Slice 3 — Server-authoritative WET_CHECK_AUTO_BILL flag readout. The
  // field UI and manager review consult this to decide whether to use
  // the auto-billing flow (preview + confirm modal + sticky chips +
  // banner) or fall back to the Slice 2 plain-submit / status-only
  // queue behavior. Public to all authenticated users so any role that
  // touches a wet check (tech, billing, admin) gets a consistent view.
  app.get("/api/config/wet-check-auto-bill", requireAuthentication, async (_req, res) => {
    res.json({ enabled: process.env.WET_CHECK_AUTO_BILL !== "false" });
  });

  // Slice 3 — Tech-driven auto-billing: dry-run preview the field UI uses
  // to populate the submit-confirm modal. Computes the same totals the
  // auto-bill path will persist without writes; returns zeros when the
  // WET_CHECK_AUTO_BILL feature flag is off.
  app.post("/api/wet-checks/:id/submit-preview", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    try {
      const preview = await storage.previewWetCheckSubmit(parseInt(req.params.id), cid);
      if (!preview) { res.status(404).json({ message: "Not found" }); return; }
      res.json(preview);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "previewWetCheckSubmit",
        ctx: { cid, wetCheckId: req.params.id },
        fallbackMessage: "Couldn't preview submit — please retry",
      });
      res.status(status).json({ message });
    }
  });

  const zoneRecordBody = z.object({
    controllerLetter: z.string().min(1).transform(s => s.toUpperCase()),
    zoneNumber: z.coerce.number().int().min(1).max(100),
    status: z.enum(["not_checked", "checked_ok", "checked_with_issues", "not_applicable"]).default("checked_ok"),
    ranSuccessfully: z.boolean().nullish(),
    observedPressure: z.union([z.string(), z.number()]).nullish(),
    observedFlow: z.union([z.string(), z.number()]).nullish(),
    notes: z.string().nullish(),
    // Client-supplied capture timestamp (ms or ISO). Server falls back to now()
    // when status moves out of not_checked and the client didn't send one.
    checkedAt: z.union([z.string().datetime(), z.number(), z.date()]).nullish(),
    // Task #458 — Mark Zone Complete badge state. Only meaningful when the
    // zone is in `checked_with_issues`; the server clears it automatically
    // when the status moves to anything else (see below).
    markedCompleteAt: z.union([z.string().datetime(), z.number(), z.date()]).nullish(),
    clientId: z.string().uuid().nullish(),
  });

  app.post("/api/wet-checks/:id/zone-records", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const parsed = zoneRecordBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const body = parsed.data;
    try {
      const wetCheckId = parseInt(req.params.id);
      const checkedAt =
        body.checkedAt != null
          ? new Date(body.checkedAt as string | number | Date)
          : (body.status !== "not_checked" ? new Date() : null);
      // Task #458 — clear `markedCompleteAt` whenever the zone moves out of
      // the Needs Work state, so the badge can never linger on an OK / N/A
      // / Not Checked tile.
      const markedCompleteAt =
        body.status === "checked_with_issues"
          ? (body.markedCompleteAt != null ? new Date(body.markedCompleteAt as string | number | Date) : null)
          : null;
      const created = await storage.upsertWetCheckZoneRecord(wetCheckId, cid, {
        wetCheckId,
        controllerLetter: body.controllerLetter,
        zoneNumber: body.zoneNumber,
        status: body.status,
        ranSuccessfully: body.ranSuccessfully ?? null,
        observedPressure: body.observedPressure != null ? String(body.observedPressure) : null,
        observedFlow: body.observedFlow != null ? String(body.observedFlow) : null,
        notes: body.notes ?? null,
        checkedAt,
        checkedBy: req.authenticatedUserId ?? null,
        markedCompleteAt,
        clientId: body.clientId ?? null,
      });
      res.status(201).json(created);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "upsertWetCheckZoneRecord",
        ctx: { cid, wetCheckId: req.params.id, controllerLetter: body.controllerLetter, zoneNumber: body.zoneNumber },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't save zone — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Task #753 (Slice 4) — reusable Zod schema for repairLaborHours.
  // Accepts a decimal string that is >= 0 and a multiple of 0.25.
  // Rejects: "0.1", "-1", "0.33"; accepts: "0", "0.25", "0.50", "2.00".
  const repairLaborHoursSchema = z
    .string()
    .refine((s) => {
      const n = parseFloat(s);
      return Number.isFinite(n) && n >= 0;
    }, { message: "repairLaborHours must be a non-negative number" })
    .refine((s) => {
      const n = parseFloat(s);
      return Math.abs(Math.round(n * 4) - n * 4) < 0.0001;
    }, { message: "repairLaborHours must be a multiple of 0.25" });

  // PATCH zone-record: strict allow-list — protected linkage fields
  // (wetCheckId, controllerLetter, zoneNumber, clientId) are NOT mutable
  // post-creation; only field-tech-editable observation fields are.
  const zoneRecordPatchBody = z.object({
    status: z.enum(["not_checked", "checked_ok", "checked_with_issues", "not_applicable"]).optional(),
    ranSuccessfully: z.boolean().nullish(),
    observedPressure: z.union([z.string(), z.number()]).nullish(),
    observedFlow: z.union([z.string(), z.number()]).nullish(),
    notes: z.string().nullish(),
    // Task #458 — Mark Zone Complete badge state. Send a timestamp / true to
    // set, `null` to clear. Server forces it to null when the zone is not in
    // `checked_with_issues` so the badge cannot leak onto OK / N/A tiles.
    markedCompleteAt: z.union([z.string().datetime(), z.number(), z.date(), z.boolean()]).nullish(),
    // Task #490 (mobile M5) — accepted but not persisted on PATCH. The mobile
    // helper attaches a UUID `clientId` to every wet-check mutation so an
    // offline-queue retry (M8) can be deduped; for PATCH the (resource id +
    // request payload) is already idempotent so we just allow the field
    // through the strict schema and ignore it.
    clientId: z.string().uuid().nullish(),
    // Task #753 (Slice 4) — optional per-zone repair labor hours field on the
    // general PATCH body so existing zone-update flows can set it in one call.
    repairLaborHours: repairLaborHoursSchema.optional(),
  }).strict();

  app.patch("/api/wet-checks/zone-records/:id", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const parsed = zoneRecordPatchBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const body = parsed.data;
    const patch: Partial<InsertWetCheckZoneRecord> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.ranSuccessfully !== undefined) patch.ranSuccessfully = body.ranSuccessfully ?? null;
    if (body.observedPressure !== undefined) patch.observedPressure = body.observedPressure != null ? String(body.observedPressure) : null;
    if (body.observedFlow !== undefined) patch.observedFlow = body.observedFlow != null ? String(body.observedFlow) : null;
    if (body.notes !== undefined) patch.notes = body.notes ?? null;
    // Stamp checkedAt / checkedBy whenever an active status is set.
    if (body.status === "checked_ok" || body.status === "checked_with_issues" || body.status === "not_applicable") {
      patch.checkedAt = new Date();
      patch.checkedBy = req.authenticatedUserId ?? null;
    }
    // Task #458 — Mark Zone Complete badge state.
    // - Setting it explicitly is allowed only while the zone is (or is moving
    //   to) `checked_with_issues`; otherwise we force-clear it so the badge
    //   never lingers on an OK / N/A / Not Checked tile.
    // - Any status change away from `checked_with_issues` always clears it,
    //   even when the client didn't send `markedCompleteAt`.
    if (body.markedCompleteAt !== undefined) {
      const want = body.markedCompleteAt;
      if (want == null || want === false) {
        patch.markedCompleteAt = null;
      } else if (want === true) {
        patch.markedCompleteAt = new Date();
      } else {
        patch.markedCompleteAt = new Date(want as string | number | Date);
      }
    }
    if (body.status !== undefined && body.status !== "checked_with_issues") {
      patch.markedCompleteAt = null;
    }
    // Task #753 (Slice 4) — pass repairLaborHours through to the patch when present.
    if (body.repairLaborHours !== undefined) {
      patch.repairLaborHours = body.repairLaborHours;
    }
    try {
      const updated = await storage.updateWetCheckZoneRecord(parseInt(req.params.id), cid, patch);
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "updateWetCheckZoneRecord",
        ctx: { cid, zoneRecordId: req.params.id },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't save zone — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Task #753 (Slice 4) — dedicated stepper endpoint for per-zone repair labor.
  // Body: { repairLaborHours: string } — must be >= 0 and a multiple of 0.25.
  // Returns the updated zone record or 404 if not found / not in company scope.
  const repairLaborPatchBody = z.object({ repairLaborHours: repairLaborHoursSchema });

  app.patch("/api/wet-checks/zone-records/:id/repair-labor", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const parsed = repairLaborPatchBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    try {
      const updated = await storage.setZoneRepairLabor(
        parseInt(req.params.id),
        cid,
        parsed.data.repairLaborHours,
      );
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "setZoneRepairLabor",
        ctx: { cid, zoneRecordId: req.params.id },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't save repair labor — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Task #891 — reset zone repair labor to auto-computed default (tech tier,
  // in_progress wet checks only). Clears repairLaborManuallySet and reruns the
  // issueTypeConfigs.defaultLaborHours sum.
  app.post("/api/wet-checks/zone-records/:id/repair-labor/reset", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    try {
      const updated = await storage.resetZoneRepairLabor(parseInt(req.params.id), cid);
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "resetZoneRepairLabor",
        ctx: { cid, zoneRecordId: req.params.id },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't reset repair labor",
      });
      res.status(status).json({ message });
    }
  });

  // Task #891 — manager-tier reset: clear manual flag + recompute.
  // Allowed when wet check is in_progress | submitted | partially_converted.
  app.post("/api/wet-checks/zone-records/:id/repair-labor/reset-manager", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    try {
      const updated = await storage.resetZoneRepairLaborManagerTier(parseInt(req.params.id), cid);
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "resetZoneRepairLaborManagerTier",
        ctx: { cid, zoneRecordId: req.params.id },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't reset repair labor",
      });
      res.status(status).json({ message });
    }
  });

  // Task #891 — manager-tier zone repair labor edit. Allowed when the wet check
  // is in_progress, submitted, or partially_converted (finding-price window).
  // Uses a separate storage method so the route can distinguish role from guard.
  app.patch("/api/wet-checks/zone-records/:id/repair-labor/manager", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const parsed = repairLaborPatchBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    try {
      const updated = await storage.setZoneRepairLaborManagerTier(
        parseInt(req.params.id),
        cid,
        parsed.data.repairLaborHours,
      );
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "setZoneRepairLaborManagerTier",
        ctx: { cid, zoneRecordId: req.params.id },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't save repair labor",
      });
      res.status(status).json({ message });
    }
  });

  const findingCreateBody = z.object({
    issueType: z.string().min(1),
    severity: z.string().nullish(),
    partId: z.coerce.number().int().nullish(),
    partName: z.string().nullish(),
    partPrice: z.union([z.string(), z.number()]).nullish(),
    quantity: z.coerce.number().int().min(1).default(1),
    laborHours: z.union([z.string(), z.number()]).default("0.00"),
    notes: z.string().nullish(),
    repairedInField: z.boolean().optional(),
    // Task #428 — tech intent, persisted independently of `resolution`.
    techDisposition: z.enum(["needs_review", "completed_in_field"]).optional(),
    // Task #464 — labor-only Mark Complete confirmation. Server force-clears
    // it whenever a partId is also present, so the two states cannot both
    // be true on a finding.
    noPartNeeded: z.boolean().optional(),
    clientId: z.string().uuid().nullish(),
  });

  app.post("/api/wet-checks/zone-records/:id/findings", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const parsed = findingCreateBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const body = parsed.data;

    // Task #1735 — enforce complete-or-flag at save time.
    // Guards apply only when the parent wet check is in "service" mode.
    // Inspection wet checks are document-only; their findings save without
    // repairedInField and are exempt from the complete-or-flag requirement.
    const zoneRecordId = parseInt(req.params.id);
    let wcMode: string | null = null;
    try {
      wcMode = await storage.getWetCheckModeForZoneRecord(zoneRecordId, cid);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "getWetCheckModeForZoneRecord",
        ctx: { cid, zoneRecordId },
        fallbackMessage: "Couldn't load wet check — please retry",
      });
      res.status(status).json({ message });
      return;
    }
    if (wcMode == null) { res.status(404).json({ message: "Zone record not found" }); return; }

    if (wcMode === "service") {
      // Non-custom findings MUST be marked complete in the field.
      // custom_review findings (Flag for Manager) are saved as needs_review and are exempt.
      const isCustomFinding = body.issueType === "custom_review";
      if (!isCustomFinding) {
        if (!body.repairedInField) {
          res.status(400).json({
            message: "Non-custom findings must be marked complete. Finished the work? Mark complete. Can't complete it? Flag it for your manager instead.",
          });
          return;
        }
        // Billability: need a part, noPartNeeded, or labor-only issue type.
        const isLaborOnly = LABOR_ONLY_ISSUE_TYPES.has(body.issueType);
        const hasPartId = body.partId != null;
        const noPartNeeded = body.noPartNeeded ?? false;
        if (!hasPartId && !noPartNeeded && !isLaborOnly) {
          res.status(400).json({
            message: "Select a part or confirm no part needed before saving.",
          });
          return;
        }
      }
    }
    // Snap laborHours to nearest 0.25h. Reject NaN/negative.
    // Floor rules (Task #1757 — fix over-application of the 0.25 floor):
    //   custom_review (flag for manager) → always "0.00" (no part/qty/labor stored)
    //   billable service capture (non-custom + service mode + repairedInField) → floor 0.25
    //   all other (inspection mode, or non-billable service) → quantize, no floor
    const rawLaborNum = parseFloat(String(body.laborHours));
    if (!isFinite(rawLaborNum) || rawLaborNum < 0) {
      res.status(400).json({ message: "Labor hours must be a non-negative number." });
      return;
    }
    const isPostCustom = body.issueType === "custom_review";
    const quantizedLaborHours = isPostCustom
      ? "0.00"
      : (wcMode === "service" && body.repairedInField)
        ? Math.max(0.25, Math.round(rawLaborNum * 4) / 4).toFixed(2)
        : (Math.round(rawLaborNum * 4) / 4).toFixed(2);

    try {
      const userId = req.authenticatedUserId ?? null;
      const created = await storage.createWetCheckFinding(parseInt(req.params.id), cid, {
        issueType: body.issueType,
        severity: body.severity ?? null,
        partId: body.partId ?? null,
        partName: body.partName ?? null,
        partPrice: body.partPrice != null ? String(body.partPrice) : null,
        quantity: body.quantity,
        laborHours: quantizedLaborHours,
        notes: body.notes ?? null,
        // Tech can mark "fixed it on the spot" — finding is documented but
        // already resolved (no manager routing required).
        resolution: body.repairedInField ? "repaired_in_field" : "pending",
        resolutionDecidedAt: body.repairedInField ? new Date() : null,
        resolutionDecidedBy: body.repairedInField ? userId : null,
        // Task #428 — tech intent. Explicit value wins; otherwise infer from
        // repairedInField; otherwise default to needs_review.
        techDisposition:
          body.techDisposition
          ?? (body.repairedInField ? "completed_in_field" : "needs_review"),
        // Task #464 — labor-only Mark Complete confirmation. Force-cleared
        // whenever a partId is also present so the two states cannot both
        // be true on a finding.
        noPartNeeded: body.partId != null ? false : (body.noPartNeeded ?? false),
        clientId: body.clientId ?? null,
      });
      res.status(201).json(created);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "createWetCheckFinding",
        ctx: { cid, zoneRecordId: req.params.id, issueType: body.issueType },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't save finding — please retry",
      });
      res.status(status).json({ message });
    }
  });

  app.patch("/api/wet-checks/findings/:id", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    // in_progress → field tech owns it; submitted/partially_converted →
    // manager-only. Per-finding convertedAt/FK lock in storage prevents
    // mutating an already-converted row even during partial-conversion.
    const findingId = parseInt(req.params.id);
    if (Number.isNaN(findingId)) { res.status(400).json({ message: "Invalid id" }); return; }
    const role = req.authenticatedUserRole;
    let wcInfo: { status: string; mode: string } | null = null;
    try {
      wcInfo = await storage.getWetCheckStatusForFinding(findingId, cid);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "getWetCheckStatusForFinding",
        ctx: { cid, findingId },
        fallbackMessage: "Couldn't load finding — please retry",
      });
      res.status(status).json({ message });
      return;
    }
    if (wcInfo == null) { res.status(404).json({ message: "Not found" }); return; }
    const wcStatus = wcInfo.status;
    const wcMode = wcInfo.mode;
    if (wcStatus === "in_progress") {
      if (!isFieldRole(role)) { res.status(403).json({ message: "Forbidden" }); return; }
    } else if (wcStatus === "submitted" || wcStatus === "partially_converted") {
      if (!isWetCheckManagerRole(role)) { res.status(403).json({ message: "Forbidden" }); return; }
    } else {
      res.status(409).json({ message: `Wet check is ${wcStatus}; finding pricing is locked` });
      return;
    }
    const parsed = findingPatchBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const body = parsed.data;

    // Task #1757 — fetch finding snapshot unconditionally. It is needed by:
    //   (a) the service-mode complete-or-flag guards below,
    //   (b) the labor-quantize branch (effective issue type),
    //   (c) the always-force "0.00" for custom_review findings (even notes-only PATCHes).
    let findingSnapshot: { issueType: string; resolution: string; partId: number | null; noPartNeeded: boolean } | null = null;
    try {
      findingSnapshot = await storage.getWetCheckFindingSnapshot(findingId, cid);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "getWetCheckFindingSnapshot",
        ctx: { cid, findingId },
        fallbackMessage: "Couldn't load finding — please retry",
      });
      res.status(status).json({ message });
      return;
    }
    if (findingSnapshot === null) { res.status(404).json({ message: "Not found" }); return; }

    // Effective issue type: body override wins; otherwise use the stored value.
    // Used by every downstream branch so computed once here.
    const effectivePatchIssueType = body.issueType ?? findingSnapshot.issueType;
    const effectivePatchIsCustom = effectivePatchIssueType === "custom_review";

    // Task #1735 — enforce complete-or-flag + billability on PATCH.
    // Guards apply only in "service" mode. Inspection wet checks are document-only
    // and their findings may be saved without repairedInField at any time.
    if (wcMode === "service") {
      // Guard 1: explicit repairedInField: false on a non-custom finding → reject.
      // Conversion to custom_review (flag for manager) is the only allowed path.
      if (body.repairedInField === false && !effectivePatchIsCustom) {
        res.status(400).json({
          message: "Non-custom findings cannot be saved without marking them complete. Mark it complete, or flag it for your manager instead.",
        });
        return;
      }

      // Guard 2: merge-state billability — only fires when the patch touches a
      // billability-relevant field (repairedInField, partId, noPartNeeded, issueType).
      // Notes-only / metadata-only PATCHes on legacy unbillable completed rows
      // pass through unchanged, preserving backward-compatibility.
      const isTouchingBillability =
        body.repairedInField !== undefined ||
        body.partId !== undefined ||
        body.noPartNeeded !== undefined ||
        body.issueType !== undefined;

      if (isTouchingBillability && !effectivePatchIsCustom) {
        const resultResolution =
          body.repairedInField === true ? "repaired_in_field"
          : body.repairedInField === false ? "pending"
          : findingSnapshot.resolution;
        const resultPartId = body.partId !== undefined ? body.partId : findingSnapshot.partId;
        const resultNoPartNeeded = body.noPartNeeded !== undefined ? body.noPartNeeded : findingSnapshot.noPartNeeded;

        if (resultResolution === "repaired_in_field") {
          const isLaborOnly = LABOR_ONLY_ISSUE_TYPES.has(effectivePatchIssueType);
          if (!resultPartId && !resultNoPartNeeded && !isLaborOnly) {
            res.status(400).json({
              message: "Select a part or confirm no part needed before saving.",
            });
            return;
          }
        }
      }
    }
    // Quantize laborHours on PATCH when explicitly provided.
    // Reject NaN/negative. Floor rules (Task #1757 — fix over-application of 0.25 floor):
    //   effective-custom → force "0.00" (also enforced unconditionally below)
    //   billable service (body repairedInField:true, or stored resolution=repaired_in_field) → floor 0.25
    //   inspection mode, or non-billable service → quantize, no floor
    if (body.laborHours !== undefined) {
      const rawPatchLabor = parseFloat(String(body.laborHours));
      if (!isFinite(rawPatchLabor) || rawPatchLabor < 0) {
        res.status(400).json({ message: "Labor hours must be a non-negative number." });
        return;
      }
      const isBillableServicePatch =
        wcMode === "service" &&
        !effectivePatchIsCustom &&
        (body.repairedInField === true || findingSnapshot.resolution === "repaired_in_field");
      if (effectivePatchIsCustom) {
        (body as any).laborHours = "0.00";
      } else if (isBillableServicePatch) {
        (body as any).laborHours = Math.max(0.25, Math.round(rawPatchLabor * 4) / 4).toFixed(2);
      } else {
        (body as any).laborHours = (Math.round(rawPatchLabor * 4) / 4).toFixed(2);
      }
    }

    const userId = req.authenticatedUserId ?? null;
    const patch = buildFindingPatchFromBody(body, userId);
    // Task #1757 — custom_review findings always store 0.00 labor, regardless of
    // whether laborHours was present in the body. This covers notes-only PATCHes
    // to already-custom findings where the client never sends a laborHours field.
    if (effectivePatchIsCustom) {
      patch.laborHours = "0.00";
    }
    // Task #1735 — when converting a finding to custom_review, force-clear
    // billing fields so no orphan part/qty/labor survives the conversion.
    if (body.issueType === "custom_review" && body.repairedInField === false) {
      patch.partId = null;
      patch.partName = null;
      patch.partPrice = null;
      patch.quantity = 1;
      patch.laborHours = "0.00";
      patch.noPartNeeded = false;
    }
    try {
      const updated = await storage.updateWetCheckFinding(parseInt(req.params.id), cid, patch);
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "updateWetCheckFinding",
        ctx: { cid, findingId },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't save finding — please retry",
        recognized: [
          {
            test: (_e, raw) => raw.startsWith("Finding") && raw.includes("already converted"),
            status: 400,
            message: (_e, raw) => raw,
          },
        ],
      });
      res.status(status).json({ message });
    }
  });

  app.delete("/api/wet-checks/findings/:id", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isFieldRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const findingId = parseInt(req.params.id);
    if (!Number.isFinite(findingId) || findingId <= 0) {
      res.status(400).json({ message: "Invalid finding id" }); return;
    }
    try {
      const ok = await storage.deleteWetCheckFinding(findingId, cid);
      // Belt-and-suspenders: with the typed-error refactor a missing row
      // throws WetCheckFindingNotFoundError, but if a future change ever
      // returns false again we still want to surface a 404 instead of
      // the previous silent 200 `{ ok: false }`.
      if (!ok) {
        res.status(404).json({ message: "Wet check finding not found", reason: "not_found" });
        return;
      }
      res.json({ ok: true });
    } catch (e: unknown) {
      // Task #518 — typed-error mapping so the FindingSheet's red trash
      // button can show an actionable toast instead of swallowing a
      // 200 `{ ok: false }`.
      if (e instanceof WetCheckFindingNotFoundError) {
        res.status(404).json({ message: e.message, reason: "not_found" });
        return;
      }
      if (e instanceof WetCheckFindingAlreadyConvertedError) {
        res.status(409).json({
          message: e.message,
          reason: "already_converted",
          target: e.target,
          targetId: e.targetId,
        });
        return;
      }
      if (e instanceof WetCheckFindingNotEditableError) {
        res.status(409).json({
          message: e.message,
          reason: "wet_check_not_editable",
          wetCheckStatus: e.status,
        });
        return;
      }
      const { status, message } = classifyAndLog(req, e, {
        op: "deleteWetCheckFinding",
        ctx: { cid, findingId },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't delete finding — please retry",
        recognized: [
          // The legacy `assertWetCheckEditableByTech` and the
          // tenant-scoping `assertWetCheckBelongsToCompany` both throw
          // bare Errors with these substrings. Map them to 409/404 so a
          // pre-typed-error code path that slips past the explicit
          // `instanceof` guards above still surfaces correctly.
          {
            test: (_e, raw) => /Cannot edit wet check in status/.test(raw),
            status: 409,
            message: (_e, raw) => raw,
          },
          {
            test: (_e, raw) => /not found for company/.test(raw),
            status: 404,
            message: "Wet check finding not found",
          },
        ],
      });
      res.status(status).json({ message });
    }
  });

  // Task #495 / #502 — Generalized SQL-leak guard used throughout the rest
  // of the wet-check / finding / zone-record / submit handlers.
  const classifyAndLog = _classifyAndLog;

  // Photo attach / link / delete routes extracted to a testable module so
  // the FK-anchor write path (zoneRecordId / findingId survive Zod-parse →
  // handler → storage.attachWetCheckPhoto) is locked in by a regression
  // test that imports the REAL production code (not a mirrored copy).
  // See artifacts/api-server/src/routes/wet-check-photo-attach-route.ts
  // and wet-check-photo-attach-regression.test.ts.
  registerWetCheckPhotoAttachRoutes(app, { requireAuthentication, requireCompanyId, isFieldRole, isWetCheckManagerRole });

  // Task #1437 — inspection work-order tech zone checklist: per-item check-off
  // toggle + structured zone-linked completed-work photos. Extracted module so
  // the zone-tag write path and field-tech assignment guard are test-locked.
  registerWorkOrderZoneRoutes(app, { requireAuthentication, requireSameCompanyAsWorkOrder });

  // ─── Manager review / routing / convert ──────────────────────────────────
  // NOTE: /api/wet-checks/:id/approve was removed (Task #1090). The approve
  // status is no longer reachable; wet checks move directly from
  // submitted/partially_converted to converted via the convert route.
  app.post("/api/wet-checks/:id/approve", (_req, res) => {
    res.status(404).json({ message: "This endpoint has been removed. Wet checks are finalized via the convert route." });
  });

  // ── WC Inspection Mode — Slice 2 ─────────────────────────────────────────
  //
  // POST /api/wet-checks/:id/build-inspection-estimate
  //   Idempotent: builds one estimate from the Inspection wet check's findings,
  //   or returns the existing one if it was already built. Returns EstimateWithItems.
  //   Role: any manager-tier role with company scope.
  //
  app.post("/api/wet-checks/:id/build-inspection-estimate", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const userId = req.authenticatedUserId;
    if (!userId) { res.status(401).json({ message: "Authentication required" }); return; }
    const wcId = parseInt(req.params.id);
    if (isNaN(wcId)) { res.status(400).json({ message: "Invalid wet check id" }); return; }
    try {
      const me = await storage.getUser(userId);
      if (!me) { res.status(401).json({ message: "User not found" }); return; }
      const estimate = await storage.buildEstimateFromInspectionWetCheck(wcId, cid, { id: me.id, name: me.name });
      res.json(estimate);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "buildEstimateFromInspectionWetCheck",
        ctx: { cid, wcId },
        fallbackMessage: "Could not build inspection estimate — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // POST /api/wet-checks/:id/pass-to-estimates
  //   Manager internal sign-off for an Inspection wet check. Stamps
  //   estimate.internalStatus='approved_internal' (does NOT customer-approve the
  //   estimate) and flips the wet check to `converted`. Seam 2 self-heal: if the
  //   estimate is already customer-approved/sent, skips the estimate write but
  //   still converts the WC. Idempotent when the WC is already converted.
  //   Role: any manager-tier role with company scope.
  //
  app.post("/api/wet-checks/:id/pass-to-estimates", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const userId = req.authenticatedUserId;
    if (!userId) { res.status(401).json({ message: "Authentication required" }); return; }
    const wcId = parseInt(req.params.id);
    if (isNaN(wcId)) { res.status(400).json({ message: "Invalid wet check id" }); return; }
    try {
      const result = await storage.passInspectionToEstimates(wcId, cid);
      await recordLifecycleAudit(req, {
        resource: "wet_check",
        action: "wet_check.inspection_passed_to_estimates",
        targetId: wcId,
        companyId: cid,
        after: { estimateId: result.estimate.id, estimateInternalStatus: result.estimate.internalStatus, wetCheckStatus: result.wetCheck.status },
        summary: `Inspection wet check ${wcId} passed to estimates → estimate #${result.estimate.id} at approved_internal, WC converted`,
        extra: { estimateId: result.estimate.id },
      });
      res.json(result);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "passInspectionToEstimates",
        ctx: { cid, wcId },
        recognized: [
          {
            test: (_e, raw) =>
              raw.includes("not in pending_approval state") ||
              raw.includes("not in a pending state"),
            status: 409,
            message: (_e, raw) => raw,
          },
          {
            test: (_e, raw) => raw.includes("not found"),
            status: 404,
            message: (_e, raw) => raw,
          },
          {
            test: (_e, raw) => raw.includes("not an inspection"),
            status: 400,
            message: (_e, raw) => raw,
          },
        ],
        fallbackMessage: "Could not pass inspection to estimates — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // POST /api/wet-checks/:id/approve-inspection  ← RETIRED (410)
  //   This endpoint has been superseded by /pass-to-estimates.
  //   The old behaviour (lifecycle='approved' customer-approval impersonation) was
  //   incorrect; the new endpoint only stamps internalStatus='approved_internal'.
  app.post("/api/wet-checks/:id/approve-inspection", (_req, res) => {
    res.status(410).json({
      message: "This endpoint has been retired. Use POST /api/wet-checks/:id/pass-to-estimates instead.",
      replacedBy: "/api/wet-checks/:id/pass-to-estimates",
    });
  });

  // POST /api/wet-checks/:id/revert-inspection
  //   Reverts a pass-to-estimates hand-off. Atomically:
  //     - estimate → internalStatus='pending_approval' (status/lifecycle untouched)
  //     - wet check → status='submitted', fullyConvertedAt=null
  //   Blocked with 409 if:
  //     - any WCB row is already invoiced
  //     - estimate has moved beyond approved_internal (sent/approved/rejected)
  //   Role: company_admin and super_admin only (narrower than pass-to-estimates).
  //
  app.post("/api/wet-checks/:id/revert-inspection", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    const role = req.authenticatedUserRole;
    if (role !== "company_admin" && role !== "super_admin") {
      res.status(403).json({ message: "Forbidden. Reverting an inspection hand-off requires company_admin or super_admin." });
      return;
    }
    const wcId = parseInt(req.params.id);
    if (isNaN(wcId)) { res.status(400).json({ message: "Invalid wet check id" }); return; }
    try {
      const result = await storage.unapproveInspectionEstimate(wcId, cid);
      await recordLifecycleAudit(req, {
        resource: "wet_check",
        action: "wet_check.inspection_pass_reverted",
        targetId: wcId,
        companyId: cid,
        before: { wetCheckStatus: "converted", estimateInternalStatus: "approved_internal" },
        after: { estimateId: result.estimate.id, wetCheckStatus: result.wetCheck.status, estimateInternalStatus: result.estimate.internalStatus },
        summary: `Inspection wet check ${wcId} hand-off reverted → estimate #${result.estimate.id} back to pending_approval, WC back to submitted`,
        extra: { estimateId: result.estimate.id },
      });
      res.json(result);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "unapproveInspectionEstimate",
        ctx: { cid, wcId },
        recognized: [
          {
            test: (_e, raw) =>
              raw.includes("not in a converted state") ||
              raw.includes("already been included in invoice") ||
              raw.includes("Cannot revert:") ||
              raw.includes("not in approved_internal state") ||
              raw.includes("not an inspection wet check"),
            status: 409,
            message: (_e, raw) => raw,
          },
          {
            test: (_e, raw) => raw.includes("not found"),
            status: 404,
            message: (_e, raw) => raw,
          },
        ],
        fallbackMessage: "Could not revert inspection hand-off — please retry",
      });
      res.status(status).json({ message });
    }
  });

  const findingRouteBody = z.object({
    resolution: z.enum(["pending", "repaired_in_field", "sent_to_estimate", "deferred_to_work_order", "documented_only"]),
  }).strict();

  app.patch("/api/wet-checks/findings/:id/route", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const userId = req.authenticatedUserId;
    if (!userId) { res.status(401).json({ message: "Authentication required" }); return; }
    const parsed = findingRouteBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    try {
      const me = await storage.getUser(userId);
      if (!me) { res.status(401).json({ message: "User not found" }); return; }
      const findingId = parseInt(req.params.id);
      const updated = await storage.routeWetCheckFinding(findingId, cid, parsed.data.resolution, { id: me.id, name: me.name });
      if (!updated) { res.status(404).json({ message: "Not found" }); return; }
      const wcIdForAudit = (updated as any).wetCheckId ?? null;
      if (wcIdForAudit) {
        await recordLifecycleAudit(req, {
          resource: "wet_check",
          action: "wet_check.finding_routed",
          targetId: wcIdForAudit,
          companyId: cid,
          after: { findingId, resolution: parsed.data.resolution },
          summary: `Wet check ${wcIdForAudit} finding ${findingId} routed → ${parsed.data.resolution}`,
          extra: { findingId, resolution: parsed.data.resolution },
        });
      }
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "routeWetCheckFinding",
        ctx: { cid, findingId: req.params.id, resolution: parsed.data.resolution },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't route finding — please retry",
      });
      res.status(status).json({ message });
    }
  });

  const convertBody = z.object({
    // Optional per-deferred-finding scheduled date map ({ findingId: ISO }).
    scheduledDates: z.record(z.string(), z.string().nullable()).optional(),
  }).strict();

  app.post("/api/wet-checks/:id/convert", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    if (!isWetCheckManagerRole(req.authenticatedUserRole)) { res.status(403).json({ message: "Forbidden" }); return; }
    const userId = req.authenticatedUserId;
    if (!userId) { res.status(401).json({ message: "Authentication required" }); return; }
    const parsed = convertBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid body", issues: parsed.error.issues }); return; }
    const scheduledDates: Record<number, string | null> = {};
    for (const [k, v] of Object.entries(parsed.data.scheduledDates ?? {})) {
      const fid = parseInt(k);
      if (!isNaN(fid)) scheduledDates[fid] = v;
    }
    try {
      const me = await storage.getUser(userId);
      if (!me) { res.status(401).json({ message: "User not found" }); return; }
      const wcId = parseInt(req.params.id);
      const wcBefore = await storage.getWetCheck(wcId, cid).catch(() => null);
      const result = await storage.convertWetCheckToWetCheckBilling(wcId, cid, { id: me.id, name: me.name }, scheduledDates);
      await recordLifecycleAudit(req, {
        resource: "wet_check",
        action: "wet_check.converted",
        targetId: wcId,
        companyId: cid,
        before: { status: wcBefore?.status },
        after: {
          status: (result as any)?.wetCheck?.status ?? null,
          estimateIds: (result as any)?.estimateIds ?? null,
          workOrderIds: (result as any)?.workOrderIds ?? null,
        },
        summary: `Wet check ${wcId} converted by ${me.name}`,
        extra: {
          estimateIds: (result as any)?.estimateIds ?? null,
          workOrderIds: (result as any)?.workOrderIds ?? null,
        },
      });
      res.json(result);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "convertWetCheck",
        ctx: { cid, wetCheckId: req.params.id },
        fallbackStatus: 400,
        fallbackMessage: "Couldn't convert wet check — please retry",
        recognized: [
          {
            test: (_e: any, raw: string) => raw.startsWith("Cannot auto-bill"),
            status: 400,
            message: (_e: any, raw: string) => raw,
          },
        ],
      });
      res.status(status).json({ message });
    }
  });

  // ── Admin: per-customer controllers & per-controller zones management ────
  // Lightweight admin-only surface so company admins can edit how many
  // controllers each active customer has and how many zones each controller
  // covers without going through the KML / site-map upload flow.
  const isAdminRole = (role: string | undefined) =>
    role === "company_admin" || role === "super_admin";
  const requireAdminRole = (req: any, res: any): boolean => {
    if (!isAdminRole(req.authenticatedUserRole)) {
      res.status(403).json({ message: "Forbidden" });
      return false;
    }
    return true;
  };

  // GET /api/admin/customer-controllers — superseded by
  // GET /api/irrigation-controllers/company-rollup (Task #1653).
  // Returns 410 Gone so callers get an actionable error rather than a silent 404.
  app.get("/api/admin/customer-controllers", requireAuthentication, async (_req, res) => {
    res.status(410).json({
      message: "This endpoint has been removed. Use GET /api/irrigation-controllers/company-rollup instead.",
    });
  });

  // PUT /api/admin/customers/:customerId/controllers — removed (Task #1653).
  // All writes now go through PUT /api/irrigation-controllers/:id (canonical store).
  app.put("/api/admin/customers/:customerId/controllers", requireAuthentication, async (_req, res) => {
    res.status(410).json({
      message: "This endpoint has been removed. Use PUT /api/irrigation-controllers/:id instead.",
    });
  });

  // PUT /api/admin/customers/:customerId/controllers/:letter/zones — removed (Task #1653).
  // All writes now go through PUT /api/irrigation-controllers/:id (canonical store).
  app.put(
    "/api/admin/customers/:customerId/controllers/:letter/zones",
    requireAuthentication,
    async (_req, res) => {
      res.status(410).json({
        message: "This endpoint has been removed. Use PUT /api/irrigation-controllers/:id instead.",
      });
    },
  );

  // Task #1376 — Admin force-submit for in_progress wet checks stuck due to
  // offline-sync failures. Transitions in_progress → submitted without
  // running the field-tech auto-billing pipeline. Company admin / super admin
  // only — field techs and managers use the normal submit flow.
  app.post("/api/wet-checks/:id/force-submit", requireAuthentication, async (req, res) => {
    const cid = requireCompanyId(req, res); if (!cid) return;
    const role = req.authenticatedUserRole;
    if (role !== "company_admin" && role !== "super_admin") {
      res.status(403).json({ message: "Only company admins can force-submit a wet check" });
      return;
    }
    const userId = req.authenticatedUserId;
    if (!userId) { res.status(401).json({ message: "Authentication required" }); return; }
    const wcId = parseInt(req.params.id);
    if (Number.isNaN(wcId)) { res.status(400).json({ message: "Invalid wet check ID" }); return; }
    try {
      const wc = await storage.getWetCheck(wcId, cid);
      if (!wc) { res.status(404).json({ message: "Wet check not found" }); return; }
      if (wc.status !== "in_progress") {
        res.status(409).json({
          message: `Wet check ${wcId} is already ${wc.status} — force-submit only applies to in_progress wet checks`,
        });
        return;
      }
      const updated = await storage.updateWetCheck(wcId, cid, {
        status: "submitted",
        submittedAt: new Date(),
      });
      if (!updated) { res.status(404).json({ message: "Wet check not found" }); return; }
      await recordLifecycleAudit(req, {
        resource: "wet_check",
        action: "wet_check.force_submitted",
        targetId: wcId,
        companyId: cid,
        before: { status: "in_progress" },
        after: { status: "submitted" },
        summary: `Wet check ${wcId} force-submitted by admin (user ${userId}) to unblock triage`,
        extra: { adminUserId: userId },
      });
      res.json(updated);
    } catch (e: any) {
      const { status, message } = classifyAndLog(req, e, {
        op: "forceSubmitWetCheck",
        ctx: { cid, wcId },
        fallbackMessage: "Couldn't force-submit wet check — please retry",
      });
      res.status(status).json({ message });
    }
  });

  // Task #1293 — Wet Check Reconciliation + Reassign-with-Cascade.
  registerWetCheckReconciliationRoutes(app, { requireAuthentication });

  // Irrigation System Profile — Build 1.
  // Controllers, programs, zones, history, and settings photo attach.
  registerIrrigationProfileRoutes(app, { requireAuthentication });

  return httpServer;
}
