// Task #1005 / #1238 — Manager Workspace endpoints (merged).
//
// Contract endpoints that back /manager-workspace (Slice 1 merge):
//   GET /api/manager-workspace/queue
//   GET /api/manager-workspace/status-strip
//
// All endpoints are gated to irrigation_manager / company_admin /
// super_admin / billing_manager; all four roles see the same page.
// billing_manager gets 200 but never receives wet_check items.
// Non-super_admin callers see only their own company's data.

import type { Express, RequestHandler } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  wetChecks,
  wetCheckFindings,
} from "@workspace/db/schema";
import { db } from "../db";
import { storage } from "../storage";
import {
  scopedWetCheckBillings,
  loadQbSyncStatus,
  ACTIVE_WCB,
  ACTIVE_WO,
  ACTIVE_BS,
  APPROVED_WCB,
  APPROVED_BS,
  APPROVED_WO,
  DRAFT_BS,
  DRAFT_WO,
} from "./billing-workspace-routes";

export interface RegisterManagerWorkspaceRoutesDeps {
  requireAuthentication: RequestHandler;
}

// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const MW_ROLES = new Set([
  "irrigation_manager",
  "company_admin",
  "super_admin",
  "billing_manager",
]);

function isManagerAllowed(req: any): boolean {
  return MW_ROLES.has(String(req.authenticatedUserRole || ""));
}

// Days after which an unbilled or unrouted item is considered hanging.
// All aging checks in this file reference this constant — change it here to
// adjust the threshold globally.
const HANGING_THRESHOLD_DAYS = 7;

// Statuses considered "active" for wet checks awaiting manager review.
// partially_converted is included so those wet checks are never silently
// dropped from the queue — they still need a follow-up action.
// Exported for use by the needs-review endpoint in routes.ts.
export const ACTIVE_WC = new Set(["submitted", "pending_manager_review", "partially_converted"]);
// Work-order statuses manager must act on (needs_review).
const ACTIVE_WO_FOR_MANAGER = new Set(["pending_manager_review", "work_completed"]);
// Work-order statuses that appear in the merged queue.
const ALL_WO_STAGES = new Set([
  "pending_manager_review",
  "work_completed",
  "in_progress",
  "approved_passed_to_billing",
  "billed",
]);
// Billing-sheet statuses that appear in the merged queue.
const ALL_BS_STAGES = new Set([
  "pending_manager_review",
  "submitted",
  "completed",
  "draft",
  "approved_passed_to_billing",
  "billed",
]);
// WCB statuses that appear in the merged queue.
const ALL_WCB_STAGES = new Set([
  "submitted",
  "pending_manager_review",
  "approved_passed_to_billing",
  "billed",
]);
// Approved status sets for the "approved this week" tile.
// Exported for use by the needs-review endpoint in routes.ts.
export const APPROVED_WC = new Set(["approved", "partially_converted", "converted"]);

function numOr0(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseIntOr(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

// -----------------------------------------------------------------------
// Test override slots — allow unit tests to inject fixtures without a
// live database.
// -----------------------------------------------------------------------
let _wetCheckOverride: (() => Promise<any[]>) | null = null;
let _workOrderOverride: (() => Promise<any[]>) | null = null;
let _billingSheetOverride: (() => Promise<any[]>) | null = null;
let _wcbOverride: (() => Promise<any[]>) | null = null;
let _partsOverride: (() => Promise<any[]>) | null = null;
let _reviewsOverride: (() => Promise<any[]>) | null = null;
// Returns the set of wetCheckIds already invoiced via a billing sheet
// (wet_check_findings.billingSheetId → billing_sheets.invoiceId IS NOT NULL).
// Tests inject this directly to avoid hitting the real DB.
let _invoicedBsWcIdsOverride: (() => Promise<Set<number>>) | null = null;

export function _setWetChecksForTests(fn: () => Promise<any[]>): void {
  _wetCheckOverride = fn;
}
export function _setWorkOrdersForTests(fn: () => Promise<any[]>): void {
  _workOrderOverride = fn;
}
export function _setBilingSheetsForTests(fn: () => Promise<any[]>): void {
  _billingSheetOverride = fn;
}
export function _setWcbForTests(fn: () => Promise<any[]>): void {
  _wcbOverride = fn;
}
export function _setPartsForTests(fn: () => Promise<any[]>): void {
  _partsOverride = fn;
}
export function _setReviewsForTests(fn: () => Promise<any[]>): void {
  _reviewsOverride = fn;
}
export function _setInvoicedBsWcIdsForTests(fn: () => Promise<Set<number>>): void {
  _invoicedBsWcIdsOverride = fn;
}
export function _resetManagerWorkspaceOverridesForTests(): void {
  _wetCheckOverride = null;
  _workOrderOverride = null;
  _billingSheetOverride = null;
  _wcbOverride = null;
  _partsOverride = null;
  _reviewsOverride = null;
  _invoicedBsWcIdsOverride = null;
}

// -----------------------------------------------------------------------
// Scoping helpers
// -----------------------------------------------------------------------

async function scopedWetChecks(req: any): Promise<any[]> {
  if (_wetCheckOverride) return _wetCheckOverride();
  const role = req.authenticatedUserRole;
  const cid: number | null = req.authenticatedUserCompanyId ?? null;
  if (role === "super_admin") {
    return await db.select().from(wetChecks);
  }
  if (cid == null) return [];
  return await db
    .select()
    .from(wetChecks)
    .where(eq(wetChecks.companyId, cid));
}

async function scopedWorkOrdersForManager(req: any): Promise<any[]> {
  if (_workOrderOverride) return _workOrderOverride();
  const role = req.authenticatedUserRole;
  const cid: number | null = req.authenticatedUserCompanyId ?? null;
  const all = await storage.getWorkOrders(role === "super_admin" ? null : cid);
  if (role === "super_admin") return all as any[];
  if (cid == null) return [];
  // storage.getWorkOrders(cid) already scopes by company — return directly.
  // A previous version re-filtered by resolving each row's assignedTechnicianId
  // to a company, which silently dropped unassigned work orders (null tech → null
  // company → never equal to cid). The storage layer is the correct scoping boundary.
  return all as any[];
}

async function scopedBillingSheets(req: any): Promise<any[]> {
  if (_billingSheetOverride) return _billingSheetOverride();
  const role = req.authenticatedUserRole;
  const cid: number | null = req.authenticatedUserCompanyId ?? null;
  const all = await storage.getAllBillingSheets(role === "super_admin" ? null : cid);
  if (role === "super_admin") return all as any[];
  if (cid == null) return [];
  // storage.getAllBillingSheets(cid) already scopes by company — return directly.
  // A previous version re-filtered by resolving each row's technicianId to a
  // company, which silently dropped unassigned billing sheets (null tech → null
  // company → never equal to cid). The storage layer is the correct scoping boundary.
  return all as any[];
}

async function scopedWcb(req: any): Promise<any[]> {
  if (_wcbOverride) return _wcbOverride();
  return scopedWetCheckBillings(req);
}

async function scopedParts(req: any): Promise<any[]> {
  if (_partsOverride) return _partsOverride();
  const cid: number | null = req.authenticatedUserCompanyId ?? null;
  const role = req.authenticatedUserRole;
  if (cid == null && role !== "super_admin") return [];
  return (await storage.getPendingParts(cid ?? 0)) as any[];
}

async function scopedManualReviews(req: any): Promise<any[]> {
  if (_reviewsOverride) return _reviewsOverride();
  const cid: number | null = req.authenticatedUserCompanyId ?? null;
  const role = req.authenticatedUserRole;
  if (cid == null && role !== "super_admin") return [];
  return (await storage.getManualPartReviews(cid ?? 0)) as any[];
}

// Returns the set of wetCheckIds that are already invoiced because one of
// their findings was routed to a billing sheet that now has an invoiceId.
// Link chain: wet_check_findings.billingSheetId → billing_sheets.invoiceId.
async function getWetCheckIdsInvoicedViaBillingSheets(
  req: any,
): Promise<Set<number>> {
  if (_invoicedBsWcIdsOverride) return _invoicedBsWcIdsOverride();

  // Derive invoiced BS ids from the already-scoped billing-sheet list so we
  // honour company scope without a separate query.
  const bss = await scopedBillingSheets(req);
  const invoicedBsIds = bss
    .filter((bs: any) => bs.invoiceId != null)
    .map((bs: any) => bs.id as number);

  if (invoicedBsIds.length === 0) return new Set();

  const rows = await db
    .select({ wetCheckId: wetCheckFindings.wetCheckId })
    .from(wetCheckFindings)
    .where(inArray(wetCheckFindings.billingSheetId, invoicedBsIds));

  const out = new Set<number>();
  for (const r of rows) {
    if (r.wetCheckId != null) out.add(r.wetCheckId);
  }
  return out;
}

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export type Stage =
  | "needs_review"
  | "waiting_on_tech"
  | "passed_to_billing"
  | "billed_7d";

export interface ManagerQueueItem {
  id: string;
  type:
    | "wet_check"
    | "work_order"
    | "billing_sheet"
    | "wet_check_billing"
    | "part"
    | "manual_review";
  stage: Stage;
  refId: number;
  number: string | null;
  customerId: number | null;
  customerName: string | null;
  technicianId: number | null;
  technicianName: string | null;
  total: number;
  status: string;
  hasPhotos: boolean | null;
  flags: string[];
  ageDays: number | null;
  createdAt: string | null;
  href: string;
  wetCheckId?: number | null;
  returnedForCorrectionAt?: string | null;
  invoiceId?: number | null;
  // Slice 2: true when the item was billed after a billing-side actor
  // (billing_manager / company_admin) approved it without irrigation_manager
  // review. NULL approvedByRole (legacy rows) yields false ("unknown").
  billedWithoutReview?: boolean;
}

// -----------------------------------------------------------------------
// Stage assignment
// -----------------------------------------------------------------------

function assignStage(
  type: ManagerQueueItem["type"],
  status: string,
  returnedForCorrectionAt: string | null | undefined,
  invoiceId: number | null | undefined,
  ageDays: number | null,
  now: number,
  billedAt?: string | null,
): Stage {
  // Any item that has been attached to an invoice is already billed,
  // regardless of what status string it carries.  Route to billed_7d
  // so it drops off naturally after the 7-day window.
  if (invoiceId != null) return "billed_7d";

  // Kicked-back items — returnedForCorrectionAt is set and status is
  // the "returned" status (in_progress for WO, draft for BS).
  if (returnedForCorrectionAt) return "waiting_on_tech";

  // Billed within 7 days (use billedAt if available, else updatedAt proxy)
  if (status === "billed") return "billed_7d";

  // Passed to billing — approved but not yet invoiced
  if (status === "approved_passed_to_billing") return "passed_to_billing";

  // Everything else is needs_review
  return "needs_review";
}

// -----------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------

export function registerManagerWorkspaceRoutes(
  app: Express,
  { requireAuthentication }: RegisterManagerWorkspaceRoutesDeps,
): void {
  // -------------------------------------------------------------------
  // GET /api/manager-workspace/queue
  //
  // Query params:
  //   type     : all | wc | wo | bs | wcb | part | manual (default all)
  //   stage    : all | needs_review | waiting_on_tech | passed_to_billing
  //              | billed_7d                                        (default all)
  //   q        : free-text (number / customer / tech)
  //   customer : numeric customer id
  //   tech     : numeric technician id
  //   age      : <1 | 1-3 | 3-7 | 7+                               (days)
  //   status   : exact status string
  //   sort     : age_desc | age_asc | total_desc | total_asc
  //              | customer | tech                                   (default age_desc)
  //   page     : 1-based page number                                (default 1)
  //   pageSize : rows per page                                       (default 200, max 500)
  //
  // Response: { items: ManagerQueueItem[], page, pageSize, total }
  // Also sets X-Total-Count.
  // -------------------------------------------------------------------
  app.get(
    "/api/manager-workspace/queue",
    requireAuthentication,
    async (req: any, res) => {
      try {
        if (!isManagerAllowed(req)) {
          res.status(403).json({ message: "Access denied." });
          return;
        }

        const role = req.authenticatedUserRole;
        const isBillingManager = role === "billing_manager";

        const type = String(req.query.type ?? "all").toLowerCase();
        const stageFilter = String(req.query.stage ?? "all").toLowerCase();
        const q = String(req.query.q ?? "").trim().toLowerCase();
        const customerFilter =
          req.query.customer != null && req.query.customer !== ""
            ? parseIntOr(req.query.customer, NaN)
            : NaN;
        const techFilter =
          req.query.tech != null && req.query.tech !== ""
            ? parseIntOr(req.query.tech, NaN)
            : NaN;
        const ageFilter = String(req.query.age ?? "").trim();
        const statusFilter = String(req.query.status ?? "").trim();
        const sort = String(req.query.sort ?? "age_desc").trim();
        const page = Math.max(1, parseIntOr(req.query.page, 1));
        const pageSize = Math.min(500, Math.max(1, parseIntOr(req.query.pageSize, 200)));

        const wantWc = !isBillingManager && (type === "all" || type === "wc");
        const wantWo = type === "all" || type === "wo";
        const wantBs = type === "all" || type === "bs";
        const wantWcb = type === "all" || type === "wcb";
        const wantPart = type === "all" || type === "part";
        const wantManual = type === "all" || type === "manual";

        const now = Date.now();
        const SEVEN_DAYS_MS = 7 * 86_400_000;

        const ageDays = (iso: string | null | undefined): number | null => {
          if (!iso) return null;
          const t = new Date(iso).getTime();
          if (!Number.isFinite(t)) return null;
          return Math.floor((now - t) / 86_400_000);
        };

        const items: ManagerQueueItem[] = [];

        // Build the set of wetCheckIds already invoiced — either via a WCB
        // (direct wetCheckId link) or via a billing sheet (findings bridge).
        // Load both sources in parallel so we suppress all invoiced wet checks
        // from the needs_review bucket regardless of how they were billed.
        let invoicedWetCheckIds = new Set<number>();
        if (wantWc) {
          const [wcbRows, bsWcIds] = await Promise.all([
            scopedWcb(req),
            getWetCheckIdsInvoicedViaBillingSheets(req),
          ]);
          for (const w of wcbRows) {
            if (w.invoiceId != null && w.wetCheckId != null) {
              invoicedWetCheckIds.add(w.wetCheckId as number);
            }
          }
          for (const id of bsWcIds) invoicedWetCheckIds.add(id);
        }

        // ── Wet checks (irrigation_manager / company_admin / super_admin only) ──
        if (wantWc) {
          for (const wc of await scopedWetChecks(req)) {
            if (!ACTIVE_WC.has(wc.status)) continue;
            // Skip wet checks already invoiced via WCB or billing sheet.
            if (invoicedWetCheckIds.has(wc.id)) continue;
            const created = wc.createdAt
              ? new Date(wc.createdAt).toISOString()
              : null;
            const age = ageDays(created);
            const flags: string[] = [];
            if (age != null && age > HANGING_THRESHOLD_DAYS) flags.push("stale");
            if (wc.status === "partially_converted") flags.push("partially_converted");
            if (age != null && age > HANGING_THRESHOLD_DAYS) flags.push("cold_review");
            items.push({
              id: `wc-${wc.id}`,
              type: "wet_check",
              stage: "needs_review",
              refId: wc.id,
              number: wc.workOrderNumber ?? wc.checkNumber ?? null,
              customerId: wc.customerId ?? null,
              customerName: wc.customerName ?? null,
              technicianId: wc.technicianId ?? null,
              technicianName: wc.technicianName ?? null,
              total: 0,
              status: wc.status,
              hasPhotos: null,
              flags,
              ageDays: age,
              createdAt: created,
              href: `/wet-checks/${wc.id}`,
            });
          }
        }

        // ── Work orders ───────────────────────────────────────────────────────
        if (wantWo) {
          for (const w of await scopedWorkOrdersForManager(req)) {
            if (!ALL_WO_STAGES.has(w.status)) continue;
            const photos = Array.isArray(w.photos) ? w.photos : [];
            const created = w.createdAt
              ? new Date(w.createdAt).toISOString()
              : null;
            const age = ageDays(created);
            const flags: string[] = [];
            if (photos.length === 0) flags.push("missing_photos");
            if (age != null && age > HANGING_THRESHOLD_DAYS) flags.push("stale");

            const rfcAt: string | null = w.returnedForCorrectionAt
              ? new Date(w.returnedForCorrectionAt).toISOString()
              : null;

            const stage = assignStage(
              "work_order",
              w.status,
              rfcAt,
              w.invoiceId ?? null,
              age,
              now,
              w.billedAt ? new Date(w.billedAt).toISOString() : null,
            );

            // Slice 2: detect billing-side approval bypassing irrigation_manager.
            // NULL approvedByRole (legacy rows) → false ("unknown", not flagged).
            const billedWithoutReview =
              stage === "billed_7d" &&
              (w.invoiceId != null) &&
              (w.approvedByRole != null) &&
              (w.approvedByRole !== "irrigation_manager");

            // billed_7d: include if within 7 days, OR billed-without-review
            // for irrigation_manager / company_admin / super_admin callers.
            if (stage === "billed_7d") {
              const billedTs = w.billedAt
                ? new Date(w.billedAt).getTime()
                : w.updatedAt
                ? new Date(w.updatedAt).getTime()
                : NaN;
              if (!billedWithoutReview || isBillingManager) {
                if (!Number.isFinite(billedTs) || now - billedTs > SEVEN_DAYS_MS) continue;
              }
            }

            if (rfcAt) flags.push("kicked_back");
            if (billedWithoutReview && !isBillingManager) flags.push("no_manager_review");
            if (stage === "passed_to_billing" && age != null && age > HANGING_THRESHOLD_DAYS) {
              flags.push("aging_unbilled");
            }
            if (stage === "needs_review" && age != null && age > HANGING_THRESHOLD_DAYS) {
              flags.push("cold_review");
            }

            items.push({
              id: `wo-${w.id}`,
              type: "work_order",
              stage,
              refId: w.id,
              number: w.workOrderNumber ?? null,
              customerId: w.customerId ?? null,
              customerName: w.customerName ?? null,
              technicianId: w.assignedTechnicianId ?? null,
              technicianName: w.assignedTechnicianName ?? null,
              total: numOr0(w.totalAmount),
              status: w.status,
              hasPhotos: photos.length > 0,
              flags,
              ageDays: age,
              createdAt: created,
              href: `/work-orders?id=${w.id}`,
              returnedForCorrectionAt: rfcAt,
              invoiceId: w.invoiceId ?? null,
              billedWithoutReview: billedWithoutReview || false,
            });
          }
        }

        // ── Billing sheets ────────────────────────────────────────────────────
        if (wantBs) {
          for (const s of await scopedBillingSheets(req)) {
            if (!ALL_BS_STAGES.has(s.status)) continue;
            const photos = Array.isArray(s.photos) ? s.photos : [];
            const flags: string[] = [];
            if (photos.length === 0) flags.push("missing_photos");
            const created = s.createdAt ? new Date(s.createdAt).toISOString() : null;
            const age = ageDays(created);
            if (age != null && age > HANGING_THRESHOLD_DAYS) flags.push("stale");

            const rfcAt: string | null = s.returnedForCorrectionAt
              ? new Date(s.returnedForCorrectionAt).toISOString()
              : null;

            const stage = assignStage(
              "billing_sheet",
              s.status,
              rfcAt,
              s.invoiceId ?? null,
              age,
              now,
              s.billedAt ? new Date(s.billedAt).toISOString() : null,
            );

            // Slice 2: detect billing-side approval bypassing irrigation_manager.
            // NULL approvedByRole (legacy rows) → false ("unknown", not flagged).
            const billedWithoutReview =
              stage === "billed_7d" &&
              (s.invoiceId != null) &&
              (s.approvedByRole != null) &&
              (s.approvedByRole !== "irrigation_manager");

            // billed_7d: include if within 7 days, OR billed-without-review
            // for irrigation_manager / company_admin / super_admin callers.
            if (stage === "billed_7d") {
              const billedTs = s.billedAt
                ? new Date(s.billedAt).getTime()
                : s.updatedAt
                ? new Date(s.updatedAt).getTime()
                : NaN;
              if (!billedWithoutReview || isBillingManager) {
                if (!Number.isFinite(billedTs) || now - billedTs > SEVEN_DAYS_MS) continue;
              }
            }

            // draft without returnedForCorrectionAt → skip (not a stage we show)
            if (s.status === "draft" && !rfcAt) continue;

            if (rfcAt) flags.push("kicked_back");
            if (billedWithoutReview && !isBillingManager) flags.push("no_manager_review");
            if (stage === "passed_to_billing" && age != null && age > HANGING_THRESHOLD_DAYS) {
              flags.push("aging_unbilled");
            }
            if (stage === "needs_review" && age != null && age > HANGING_THRESHOLD_DAYS) {
              flags.push("cold_review");
            }

            items.push({
              id: `bs-${s.id}`,
              type: "billing_sheet",
              stage,
              refId: s.id,
              number: s.billingNumber ?? s.billingSheetNumber ?? null,
              customerId: s.customerId ?? null,
              customerName: s.customerName ?? null,
              technicianId: s.technicianId ?? null,
              technicianName: s.technicianName ?? null,
              total: numOr0(s.totalAmount ?? s.grandTotal),
              status: s.status,
              hasPhotos: photos.length > 0,
              flags,
              ageDays: age,
              createdAt: created,
              href: `/billing-sheets?id=${s.id}`,
              returnedForCorrectionAt: rfcAt,
              invoiceId: s.invoiceId ?? null,
              billedWithoutReview: billedWithoutReview || false,
            });
          }
        }

        // ── Wet-check billings ────────────────────────────────────────────────
        if (wantWcb) {
          for (const w of await scopedWcb(req)) {
            if (!ALL_WCB_STAGES.has(w.status)) continue;
            const created = w.createdAt ? new Date(w.createdAt).toISOString() : null;
            const age = ageDays(created);
            const flags: string[] = [];
            if (age != null && age > HANGING_THRESHOLD_DAYS) flags.push("stale");

            const stage = assignStage(
              "wet_check_billing",
              w.status,
              null,
              w.invoiceId ?? null,
              age,
              now,
              w.updatedAt ? new Date(w.updatedAt).toISOString() : null,
            );

            // Slice 2: detect billing-side approval bypassing irrigation_manager.
            // NULL approvedByRole (legacy rows) → false ("unknown", not flagged).
            const billedWithoutReview =
              stage === "billed_7d" &&
              (w.invoiceId != null) &&
              (w.approvedByRole != null) &&
              (w.approvedByRole !== "irrigation_manager");

            // billed_7d: include if within 7 days, OR billed-without-review
            // for irrigation_manager / company_admin / super_admin callers.
            if (stage === "billed_7d") {
              const billedTs = w.billedAt
                ? new Date(w.billedAt).getTime()
                : w.updatedAt
                ? new Date(w.updatedAt).getTime()
                : NaN;
              if (!billedWithoutReview || isBillingManager) {
                if (!Number.isFinite(billedTs) || now - billedTs > SEVEN_DAYS_MS) continue;
              }
            }

            if (billedWithoutReview && !isBillingManager) flags.push("no_manager_review");
            if (stage === "passed_to_billing" && age != null && age > HANGING_THRESHOLD_DAYS) {
              flags.push("aging_unbilled");
            }
            if (stage === "needs_review" && age != null && age > HANGING_THRESHOLD_DAYS) {
              flags.push("cold_review");
            }

            items.push({
              id: `wcb-${w.id}`,
              type: "wet_check_billing",
              stage,
              refId: w.id,
              number: w.billingNumber ?? null,
              customerId: w.customerId ?? null,
              customerName: w.customerName ?? null,
              technicianId: w.technicianId ?? null,
              technicianName: w.technicianName ?? null,
              total: numOr0(w.totalAmount),
              status: w.status,
              hasPhotos: null,
              flags,
              ageDays: age,
              createdAt: created,
              href: `/wet-check-billings/${w.id}`,
              wetCheckId: w.wetCheckId ?? null,
              invoiceId: w.invoiceId ?? null,
              billedWithoutReview: billedWithoutReview || false,
            });
          }
        }

        // ── Parts pending approval ────────────────────────────────────────────
        if (wantPart) {
          for (const p of await scopedParts(req)) {
            const created = p.createdAt ? new Date(p.createdAt).toISOString() : null;
            items.push({
              id: `part-${p.id}`,
              type: "part",
              stage: "needs_review",
              refId: p.id,
              number: p.sku ?? p.partNumber ?? null,
              customerId: null,
              customerName: null,
              technicianId: null,
              technicianName: null,
              total: numOr0(p.price),
              status: "pending_approval",
              hasPhotos: null,
              flags: ["unpriced"],
              ageDays: ageDays(created),
              createdAt: created,
              href: `/parts-pending-approval`,
            });
          }
        }

        // ── Manual part reviews ───────────────────────────────────────────────
        if (wantManual) {
          for (const r of await scopedManualReviews(req)) {
            const created = r.createdAt ? new Date(r.createdAt).toISOString() : null;
            items.push({
              id: `review-${r.id}`,
              type: "manual_review",
              stage: "needs_review",
              refId: r.id,
              number: r.partSku ?? r.partName ?? null,
              customerId: r.customerId ?? null,
              customerName: r.customerName ?? null,
              technicianId: null,
              technicianName: null,
              total: numOr0(r.submittedPrice ?? r.suggestedPrice),
              status: "pending_review",
              hasPhotos: null,
              flags: ["unpriced"],
              ageDays: ageDays(created),
              createdAt: created,
              href: `/parts-pending-approval`,
            });
          }
        }

        // ---- Billed-without-review 50-item cap ---------------------------
        // For non-billing_manager callers, billed-without-review items bypass
        // the normal 7-day cutoff and accumulate indefinitely. Cap them at the
        // 50 newest (smallest ageDays) so the payload stays bounded.
        if (!isBillingManager) {
          const bwrItems = items.filter((it) => it.billedWithoutReview);
          if (bwrItems.length > 50) {
            bwrItems.sort((a, b) => (a.ageDays ?? 999999) - (b.ageDays ?? 999999));
            const keepIds = new Set(bwrItems.slice(0, 50).map((it) => it.id));
            for (let i = items.length - 1; i >= 0; i--) {
              if (items[i].billedWithoutReview && !keepIds.has(items[i].id)) {
                items.splice(i, 1);
              }
            }
          }
        }

        // ---- Stage filter -----------------------------------------------
        let filtered = items;
        if (stageFilter && stageFilter !== "all") {
          filtered = filtered.filter((it) => it.stage === stageFilter);
        }

        // ---- Text / field filters ----------------------------------------
        if (q) {
          filtered = filtered.filter((it) => {
            const hay = [it.number, it.customerName, it.technicianName]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return hay.includes(q);
          });
        }
        if (Number.isFinite(customerFilter)) {
          filtered = filtered.filter((it) => it.customerId === customerFilter);
        }
        if (Number.isFinite(techFilter)) {
          filtered = filtered.filter((it) => it.technicianId === techFilter);
        }
        if (statusFilter) {
          filtered = filtered.filter((it) => it.status === statusFilter);
        }
        if (ageFilter) {
          filtered = filtered.filter((it) => {
            const a = it.ageDays;
            if (a == null) return false;
            if (ageFilter === "<1") return a < 1;
            if (ageFilter === "1-3") return a >= 1 && a < 3;
            if (ageFilter === "3-7") return a >= 3 && a < 7;
            if (ageFilter === "7+") return a >= 7;
            return true;
          });
        }

        // ---- Sort -------------------------------------------------------
        const cmpStr = (a: string | null, b: string | null) =>
          (a ?? "").localeCompare(b ?? "");
        filtered.sort((a, b) => {
          switch (sort) {
            case "age_asc":
              return (a.ageDays ?? -1) - (b.ageDays ?? -1);
            case "total_desc":
              return b.total - a.total;
            case "total_asc":
              return a.total - b.total;
            case "customer":
              return cmpStr(a.customerName, b.customerName);
            case "tech":
              return cmpStr(a.technicianName, b.technicianName);
            case "age_desc":
            default:
              return (b.ageDays ?? -1) - (a.ageDays ?? -1);
          }
        });

        const total = filtered.length;
        const start = (page - 1) * pageSize;
        const slice = filtered.slice(start, start + pageSize);

        res.setHeader("X-Total-Count", String(total));
        res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
        res.json({ items: slice, page, pageSize, total });
      } catch (error) {
        req.log?.error?.({ err: error }, "manager-workspace queue failed");
        res.status(500).json({ message: "Failed to load manager queue" });
      }
    },
  );

  // -------------------------------------------------------------------
  // GET /api/manager-workspace/needs-approval
  //
  // Returns Work Orders and Billing Sheets awaiting manager approval:
  //   workOrders   — status in pending_manager_review | work_completed, no invoiceId
  //   billingSheets — status in pending_manager_review | submitted, no invoiceId
  //
  // Both arrays are sorted oldest-first (createdAt asc).
  // -------------------------------------------------------------------
  // ACTIVE_WO and ACTIVE_BS are imported from billing-workspace-routes.ts.
  // Using the canonical constants (rather than local copies) ensures the
  // needs-approval list stays in sync with the billing workspace queue,
  // including the "completed" status that was previously missing.

  app.get(
    "/api/manager-workspace/needs-approval",
    requireAuthentication,
    async (req: any, res) => {
      try {
        if (!isManagerAllowed(req)) {
          res.status(403).json({ message: "Access denied." });
          return;
        }

        const [wos, bss] = await Promise.all([
          scopedWorkOrdersForManager(req),
          scopedBillingSheets(req),
        ]);

        const workOrders = wos
          .filter((w: any) => ACTIVE_WO.has(w.status) && !w.invoiceId)
          .sort((a: any, b: any) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return ta - tb;
          });

        const billingSheets = bss
          .filter((s: any) => ACTIVE_BS.has(s.status) && !s.invoiceId)
          .sort((a: any, b: any) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return ta - tb;
          });

        res.json({ workOrders, billingSheets });
      } catch (error) {
        req.log?.error?.({ err: error }, "manager-workspace needs-approval failed");
        res.status(500).json({ message: "Failed to load needs-approval list" });
      }
    },
  );

  // -------------------------------------------------------------------
  // GET /api/manager-workspace/needs-approval/count
  //
  // Lightweight badge-count variant — returns only three numbers so
  // the nav badge doesn't pull down full record payloads every 60 s.
  // Uses the same auth guard and the same filtering logic as the
  // parent needs-approval endpoint.
  // -------------------------------------------------------------------

  app.get(
    "/api/manager-workspace/needs-approval/count",
    requireAuthentication,
    async (req: any, res) => {
      try {
        if (!isManagerAllowed(req)) {
          res.status(403).json({ message: "Access denied." });
          return;
        }

        const [wos, bss] = await Promise.all([
          scopedWorkOrdersForManager(req),
          scopedBillingSheets(req),
        ]);

        const workOrderCount = wos.filter(
          (w: any) => ACTIVE_WO.has(w.status) && !w.invoiceId,
        ).length;
        const billingSheetCount = bss.filter(
          (s: any) => ACTIVE_BS.has(s.status) && !s.invoiceId,
        ).length;

        res.json({
          workOrderCount,
          billingSheetCount,
          total: workOrderCount + billingSheetCount,
        });
      } catch (error) {
        req.log?.error?.({ err: error }, "manager-workspace needs-approval/count failed");
        res.status(500).json({ message: "Failed to load needs-approval count" });
      }
    },
  );

  // -------------------------------------------------------------------
  // POST /api/manager-workspace/findings/bulk-route
  //
  // REMOVED in Slice 1 (Manager Workspace Simplification).
  // Returns 404 so any stale client references surface a clear error.
  // -------------------------------------------------------------------
  app.post(
    "/api/manager-workspace/findings/bulk-route",
    requireAuthentication,
    (_req: any, res) => {
      res.status(404).json({ message: "This endpoint has been removed. Use the wet-check review screen to route findings." });
    },
  );


  // -------------------------------------------------------------------
  // GET /api/manager-workspace/status-strip
  //
  // Returns:
  //   indicators  — legacy 4-tile indicators (preserved for back-compat)
  //   stageCounts — per-stage item counts for all roles
  //   oldestAgeHours — oldest item in each active bucket
  //   quickbooks  — QB sync status (from billing-workspace)
  // -------------------------------------------------------------------
  app.get(
    "/api/manager-workspace/status-strip",
    requireAuthentication,
    async (req: any, res) => {
      try {
        if (!isManagerAllowed(req)) {
          res.status(403).json({ message: "Access denied." });
          return;
        }

        const role = req.authenticatedUserRole;
        const isBillingManager = role === "billing_manager";

        const now = Date.now();
        // ISO week boundary: Monday 00:00:00 UTC of the current week.
        const isoWeekStart = (() => {
          const d = new Date(now);
          const day = d.getUTCDay();
          const daysToMonday = day === 0 ? 6 : day - 1;
          d.setUTCDate(d.getUTCDate() - daysToMonday);
          d.setUTCHours(0, 0, 0, 0);
          return d.getTime();
        })();
        const SEVEN_DAYS_MS = 7 * 86_400_000;

        const tsOf = (v: any): number => {
          if (!v) return NaN;
          const t = new Date(v).getTime();
          return Number.isFinite(t) ? t : NaN;
        };

        // Fetch all data in parallel
        const [wos, bss, wcbs] = await Promise.all([
          scopedWorkOrdersForManager(req),
          scopedBillingSheets(req),
          scopedWcb(req),
        ]);

        const wcs = isBillingManager ? [] : await scopedWetChecks(req);

        // Build the same invoicedWetCheckIds set the queue uses so that
        // attentionCount never counts a WC that is already suppressed.
        // Load from WCBs (already available) + billed-via-billing-sheet bridge.
        let stripInvoicedWcIds = new Set<number>();
        if (!isBillingManager) {
          const bsWcIds = await getWetCheckIdsInvoicedViaBillingSheets(req);
          for (const w of wcbs) {
            if (w.invoiceId != null && w.wetCheckId != null) {
              stripInvoicedWcIds.add(w.wetCheckId as number);
            }
          }
          for (const id of bsWcIds) stripInvoicedWcIds.add(id);
        }

        // ── Legacy indicators ──
        const activeWcs = wcs.filter((w) => ACTIVE_WC.has(w.status));
        const activeWos = wos.filter((w) => ACTIVE_WO_FOR_MANAGER.has(w.status));

        const wcsPendingReview = activeWcs.length;
        const wosAwaitingApproval = activeWos.length;

        const approvedThisWeek =
          wcs.filter(
            (w) =>
              APPROVED_WC.has(w.status) &&
              tsOf(w.approvedAt ?? w.updatedAt) >= isoWeekStart,
          ).length +
          wos.filter(
            (w) =>
              APPROVED_WO.has(w.status) &&
              tsOf(w.approvedAt ?? w.updatedAt) >= isoWeekStart,
          ).length +
          bss.filter(
            (s) =>
              APPROVED_BS.has(s.status) &&
              tsOf(s.approvedAt ?? s.updatedAt) >= isoWeekStart,
          ).length;

        // ── Stage counts ──
        let needsReview = 0;
        let waitingOnTech = 0;
        let passedToBilling = 0;
        let billed7d = 0;

        // WCs
        if (!isBillingManager) {
          needsReview += activeWcs.length;
        }

        // WOs — mirror assignStage catch-all so strip agrees with queue
        for (const w of wos) {
          if (w.returnedForCorrectionAt) {
            waitingOnTech++;
          } else if (w.status === "billed") {
            const billedTs = tsOf(w.billedAt ?? w.updatedAt);
            if (Number.isFinite(billedTs) && now - billedTs <= SEVEN_DAYS_MS) billed7d++;
          } else if (w.status === "approved_passed_to_billing") {
            if (!w.invoiceId) passedToBilling++;
            else {
              const billedTs = tsOf(w.billedAt ?? w.updatedAt);
              if (Number.isFinite(billedTs) && now - billedTs <= SEVEN_DAYS_MS) billed7d++;
            }
          } else {
            needsReview++; // catch-all — same as assignStage
          }
        }

        // BSs — mirror assignStage catch-all so strip agrees with queue
        for (const s of bss) {
          if (s.returnedForCorrectionAt) {
            waitingOnTech++;
          } else if (s.status === "billed") {
            const billedTs = tsOf(s.billedAt ?? s.updatedAt);
            if (Number.isFinite(billedTs) && now - billedTs <= SEVEN_DAYS_MS) billed7d++;
          } else if (s.status === "approved_passed_to_billing") {
            if (!s.invoiceId) passedToBilling++;
            else {
              const billedTs = tsOf(s.billedAt ?? s.updatedAt);
              if (Number.isFinite(billedTs) && now - billedTs <= SEVEN_DAYS_MS) billed7d++;
            }
          } else if (s.status === "draft" && !s.returnedForCorrectionAt) {
            // draft without kickback — not shown in queue, skip
          } else {
            needsReview++; // pending_manager_review, submitted, completed, etc.
          }
        }

        // WCBs — mirror assignStage catch-all
        for (const w of wcbs) {
          if (w.status === "billed") {
            const billedTs = tsOf(w.updatedAt ?? w.createdAt);
            if (Number.isFinite(billedTs) && now - billedTs <= SEVEN_DAYS_MS) billed7d++;
          } else if (w.status === "approved_passed_to_billing") {
            if (!w.invoiceId) passedToBilling++;
            else {
              const billedTs = tsOf(w.updatedAt ?? w.createdAt);
              if (Number.isFinite(billedTs) && now - billedTs <= SEVEN_DAYS_MS) billed7d++;
            }
          } else {
            needsReview++; // submitted, pending_manager_review, etc.
          }
        }

        // ── attentionCount — hanging / never-billed items ──
        // Counts every queue item that would carry an anti-leakage flag:
        // aging_unbilled, cold_review, or partially_converted.
        const msPerDay = 86_400_000;
        const ageFromCreatedAt = (v: any): number => {
          const t = new Date(v).getTime();
          return Number.isFinite(t) ? (now - t) / msPerDay : 0;
        };
        let attentionCount = 0;

        if (!isBillingManager) {
          for (const wc of wcs) {
            if (!ACTIVE_WC.has(wc.status)) continue;
            // Mirror the queue's invoiced-WC suppression — don't count items
            // that are already suppressed from the queue.
            if (stripInvoicedWcIds.has(wc.id)) continue;
            // partially_converted always counts; old active WCs get cold_review
            if (wc.status === "partially_converted") {
              attentionCount++;
            } else if (ageFromCreatedAt(wc.createdAt) > HANGING_THRESHOLD_DAYS) {
              attentionCount++;
            }
          }
        }

        for (const w of wos) {
          const age = ageFromCreatedAt(w.createdAt);
          if (w.status === "approved_passed_to_billing" && !w.invoiceId && age > HANGING_THRESHOLD_DAYS) {
            attentionCount++; // aging_unbilled
          } else if (
            w.invoiceId == null &&
            !w.returnedForCorrectionAt &&
            w.status !== "billed" &&
            w.status !== "approved_passed_to_billing" &&
            ALL_WO_STAGES.has(w.status) &&
            age > HANGING_THRESHOLD_DAYS
          ) {
            attentionCount++; // cold_review
          }
        }

        for (const s of bss) {
          const age = ageFromCreatedAt(s.createdAt);
          if (s.status === "approved_passed_to_billing" && !s.invoiceId && age > HANGING_THRESHOLD_DAYS) {
            attentionCount++; // aging_unbilled
          } else if (
            s.invoiceId == null &&
            !s.returnedForCorrectionAt &&
            s.status !== "billed" &&
            s.status !== "approved_passed_to_billing" &&
            s.status !== "draft" &&
            ALL_BS_STAGES.has(s.status) &&
            age > HANGING_THRESHOLD_DAYS
          ) {
            attentionCount++; // cold_review
          }
        }

        for (const w of wcbs) {
          const age = ageFromCreatedAt(w.createdAt);
          if (w.status === "approved_passed_to_billing" && !w.invoiceId && age > HANGING_THRESHOLD_DAYS) {
            attentionCount++; // aging_unbilled
          } else if (
            w.invoiceId == null &&
            w.status !== "billed" &&
            w.status !== "approved_passed_to_billing" &&
            ALL_WCB_STAGES.has(w.status) &&
            age > HANGING_THRESHOLD_DAYS
          ) {
            attentionCount++; // cold_review
          }
        }

        // Compute oldest createdAt for each active indicator bucket.
        const oldestHours = (rows: any[]): number | null => {
          let oldest: number | null = null;
          for (const r of rows) {
            const t = tsOf(r.createdAt);
            if (!Number.isFinite(t)) continue;
            if (oldest === null || t < oldest) oldest = t;
          }
          if (oldest === null) return null;
          return (now - oldest) / 3_600_000;
        };

        // QuickBooks status (best-effort)
        let qbStatus: Awaited<ReturnType<typeof loadQbSyncStatus>> | null = null;
        try {
          qbStatus = await loadQbSyncStatus(req);
        } catch {
          qbStatus = null;
        }

        const stageCounts: Record<string, number | undefined> = {
          needsReview,
          waitingOnTech,
          passedToBilling,
          billed7d,
        };

        res.json({
          indicators: {
            wcsPendingReview,
            wosAwaitingApproval,
            approvedThisWeek,
          },
          attentionCount,
          stageCounts,
          oldestAgeHours: {
            wcsPendingReview: oldestHours(activeWcs),
            wosAwaitingApproval: oldestHours(activeWos),
          },
          quickbooks: qbStatus
            ? {
                state: qbStatus.state,
                lastSyncAt: qbStatus.lastSyncAt,
                pendingSync: qbStatus.pendingSync,
                connectionStatus: qbStatus.connectionStatus,
                recentErrorCount: qbStatus.recentErrors.length,
              }
            : null,
        });
      } catch (error) {
        req.log?.error?.({ err: error }, "manager-workspace status-strip failed");
        res.status(500).json({ message: "Failed to load manager status strip" });
      }
    },
  );
}
