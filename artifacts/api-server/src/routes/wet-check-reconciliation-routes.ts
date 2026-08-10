// Wet Check Reconciliation + Reassign-with-Cascade (Task #1293)
//
// GET  /api/admin/wet-check-reconciliation?from=&to=&companyId=
//   company_admin + super_admin. Returns flat list of every non-invoiced
//   WCB (snapshot) in the date range, grouped semantically by the UI.
//
// POST /api/wet-checks/:id/reassign-customer
//   company_admin + billing_manager + super_admin. Moves a wet check and
//   all its non-invoiced WCBs to a different customer in a single
//   transaction. Returns moved/skipped/warnings.
//
// Both handlers receive their DB operations via the `queries` dep so tests
// can call registerWetCheckReconciliationRoutes with real Express + stub
// queries, exercising every branch of the actual production handler code
// without needing a real database connection.

import type { Express, RequestHandler } from "express";
import { and, eq, isNull, inArray, or, sql } from "drizzle-orm";
import {
  wetChecks,
  wetCheckBillings,
  wetCheckFindings,
  customers,
} from "@workspace/db/schema";
import { db as productionDb } from "../db";
import { recordAuditEvent } from "./audit-log";
import { z } from "zod/v4";
import { logger } from "../lib/logger";

// ── Shared row shapes (used by both the handler and the injectable queries) ──

export interface WcReconciliationRow {
  wetCheckId: number;
  wetCheckStatus: string;
  wetCheckStartedAt: Date | null;
  wetCheckCompanyId: number;
  customerId: number | null;
  customerName: string | null;
  propertyAddress: string | null;
  technicianId: number | null;
  technicianName: string | null;
  wcbId: number;
  billingNumber: string | null;
  branchName: string | null;
  wcbStatus: string;
  workDate: Date | null;
  totalAmount: string | null;
  invoiceId: number | null;
}

export interface WcRow {
  id: number;
  companyId: number;
  customerId: number | null;
  customerName: string | null;
  propertyAddress: string | null;
  status: string;
}

export interface WcbRow {
  id: number;
  wetCheckId: number;
  billingNumber: string | null;
  status: string;
  invoiceId: number | null;
}

export interface CustomerRow {
  id: number;
  companyId: number;
  name: string;
  address: string | null;
  hiddenFromBilling: boolean | null;
}

export interface FindingRow {
  id: number;
  workOrderId: number | null;
  estimateId: number | null;
}

export interface ReassignParams {
  wetCheckId: number;
  targetCustomerId: number;
  targetCustomerName: string;
  targetCompanyId: number;
  targetAddress: string;
  targetBranchName: string | null;
  moveableIds: number[];
  now: Date;
}

// ── Injectable query interface ────────────────────────────────────────────────

export interface WcReconciliationQueries {
  getUnbilledSnapshots(
    from: Date,
    to: Date,
    scopeCompanyId: number | null,
  ): Promise<WcReconciliationRow[]>;
  getWetCheck(id: number): Promise<WcRow | null>;
  getWcbs(wetCheckId: number): Promise<WcbRow[]>;
  getCustomer(id: number): Promise<CustomerRow | null>;
  getFindingsWithRouting(wetCheckId: number): Promise<FindingRow[]>;
  executeReassign(params: ReassignParams): Promise<void>;
}

// ── Production query implementations (use real drizzle db) ───────────────────

export function buildProductionQueries(): WcReconciliationQueries {
  return {
    async getUnbilledSnapshots(from, to, scopeCompanyId) {
      return productionDb
        .select({
          wetCheckId: wetChecks.id,
          wetCheckStatus: wetChecks.status,
          wetCheckStartedAt: wetChecks.startedAt,
          wetCheckCompanyId: wetChecks.companyId,
          customerId: wetChecks.customerId,
          customerName: wetChecks.customerName,
          propertyAddress: wetChecks.propertyAddress,
          technicianId: wetChecks.technicianId,
          technicianName: wetChecks.technicianName,
          wcbId: wetCheckBillings.id,
          billingNumber: wetCheckBillings.billingNumber,
          branchName: wetCheckBillings.branchName,
          wcbStatus: wetCheckBillings.status,
          workDate: wetCheckBillings.workDate,
          totalAmount: wetCheckBillings.totalAmount,
          invoiceId: wetCheckBillings.invoiceId,
        })
        .from(wetChecks)
        .innerJoin(
          wetCheckBillings,
          and(
            eq(wetCheckBillings.wetCheckId, wetChecks.id),
            isNull(wetCheckBillings.invoiceId),
          ),
        )
        .where(
          and(
            sql`${wetCheckBillings.workDate} >= ${from}`,
            sql`${wetCheckBillings.workDate} <= ${to}`,
            scopeCompanyId != null
              ? eq(wetChecks.companyId, scopeCompanyId)
              : undefined,
          ),
        )
        .orderBy(wetChecks.customerId, wetCheckBillings.branchName, wetCheckBillings.workDate);
    },

    async getWetCheck(id) {
      const [row] = await productionDb
        .select({
          id: wetChecks.id,
          companyId: wetChecks.companyId,
          customerId: wetChecks.customerId,
          customerName: wetChecks.customerName,
          propertyAddress: wetChecks.propertyAddress,
          status: wetChecks.status,
        })
        .from(wetChecks)
        .where(eq(wetChecks.id, id));
      return row ?? null;
    },

    async getWcbs(wetCheckId) {
      return productionDb
        .select({
          id: wetCheckBillings.id,
          wetCheckId: wetCheckBillings.wetCheckId,
          billingNumber: wetCheckBillings.billingNumber,
          status: wetCheckBillings.status,
          invoiceId: wetCheckBillings.invoiceId,
        })
        .from(wetCheckBillings)
        .where(eq(wetCheckBillings.wetCheckId, wetCheckId));
    },

    async getCustomer(id) {
      const [row] = await productionDb
        .select({
          id: customers.id,
          companyId: customers.companyId,
          name: customers.name,
          address: customers.address,
          hiddenFromBilling: customers.hiddenFromBilling,
        })
        .from(customers)
        .where(eq(customers.id, id));
      return row ?? null;
    },

    async getFindingsWithRouting(wetCheckId) {
      return productionDb
        .select({
          id: wetCheckFindings.id,
          workOrderId: wetCheckFindings.workOrderId,
          estimateId: wetCheckFindings.estimateId,
        })
        .from(wetCheckFindings)
        .where(
          and(
            eq(wetCheckFindings.wetCheckId, wetCheckId),
            or(
              sql`${wetCheckFindings.workOrderId} IS NOT NULL`,
              sql`${wetCheckFindings.estimateId} IS NOT NULL`,
            ),
          ),
        );
    },

    async executeReassign(params) {
      const {
        wetCheckId,
        targetCustomerId,
        targetCustomerName,
        targetCompanyId,
        targetAddress,
        targetBranchName,
        moveableIds,
        now,
      } = params;
      await productionDb.transaction(async (tx) => {
        await tx
          .update(wetChecks)
          .set({
            customerId: targetCustomerId,
            customerName: targetCustomerName,
            companyId: targetCompanyId,
            propertyAddress: targetAddress,
            updatedAt: now,
          })
          .where(eq(wetChecks.id, wetCheckId));

        if (moveableIds.length > 0) {
          await tx
            .update(wetCheckBillings)
            .set({
              customerId: targetCustomerId,
              customerName: targetCustomerName,
              propertyAddress: targetAddress,
              branchName: targetBranchName,
              updatedAt: now,
            })
            .where(inArray(wetCheckBillings.id, moveableIds));
        }
      });
    },
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export interface RegisterWetCheckReconciliationRoutesDeps {
  requireAuthentication: RequestHandler;
  queries?: WcReconciliationQueries; // defaults to productionDb-backed impl
}

// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const RECONCILE_ROLES = new Set(["company_admin", "super_admin"]);
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const REASSIGN_ROLES = new Set(["company_admin", "billing_manager", "super_admin"]);

function isAllowed(req: any, roles: Set<string>): boolean {
  return roles.has(String(req.authenticatedUserRole ?? ""));
}

function callerCompanyId(req: any): number | null {
  const id = req.authenticatedUserCompanyId;
  if (id == null) return null;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const reassignBodySchema = z.object({
  customerId: z.number().int().positive(),
  branchName: z.string().nullable().optional(),
});

export function registerWetCheckReconciliationRoutes(
  app: Express,
  deps: RegisterWetCheckReconciliationRoutesDeps,
): void {
  const { requireAuthentication } = deps;
  const queries = deps.queries ?? buildProductionQueries();

  // ── GET /api/admin/wet-check-reconciliation ───────────────────────────────
  app.get(
    "/api/admin/wet-check-reconciliation",
    requireAuthentication,
    async (req: any, res) => {
      if (!isAllowed(req, RECONCILE_ROLES)) {
        res.status(403).json({ message: "Forbidden — company admin or super admin required" });
        return;
      }

      const role = String(req.authenticatedUserRole ?? "");
      const cid = callerCompanyId(req);

      // Parse date range — default last 90 days.
      const now = new Date();
      const defaultFrom = new Date(now);
      defaultFrom.setDate(defaultFrom.getDate() - 90);
      defaultFrom.setHours(0, 0, 0, 0);

      const fromRaw = req.query.from as string | undefined;
      const toRaw = req.query.to as string | undefined;
      const from = fromRaw ? new Date(fromRaw) : defaultFrom;
      const to = toRaw ? new Date(toRaw) : now;

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(400).json({ message: "Invalid date range — from/to must be ISO date strings" });
        return;
      }

      // For super_admin an explicit companyId param narrows the scope.
      // For all other roles a valid company context is mandatory.
      let scopeCompanyId: number | null = null;
      if (role === "super_admin") {
        const paramCid = req.query.companyId as string | undefined;
        scopeCompanyId = paramCid ? Number(paramCid) : null;
      } else {
        // Non-super: company context is required; missing/invalid is a hard stop.
        if (!cid) {
          res.status(400).json({ message: "Company context required" });
          return;
        }
        scopeCompanyId = cid;
      }

      try {
        const rows = await queries.getUnbilledSnapshots(from, to, scopeCompanyId);
        res.json(rows);
      } catch (err) {
        logger.error({ err }, "GET /api/admin/wet-check-reconciliation failed");
        res.status(500).json({ message: "Failed to load reconciliation data" });
      }
    },
  );

  // ── POST /api/wet-checks/:id/reassign-customer ─────────────────────────────
  app.post(
    "/api/wet-checks/:id/reassign-customer",
    requireAuthentication,
    async (req: any, res) => {
      if (!isAllowed(req, REASSIGN_ROLES)) {
        res.status(403).json({ message: "Forbidden — company admin, billing manager, or super admin required" });
        return;
      }

      const wetCheckId = parseInt(req.params.id);
      if (!Number.isFinite(wetCheckId) || wetCheckId <= 0) {
        res.status(400).json({ message: "Invalid wet check id" });
        return;
      }

      const parsed = reassignBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
        return;
      }
      const { customerId: targetCustomerId, branchName: targetBranchName } = parsed.data;

      const role = String(req.authenticatedUserRole ?? "");

      // Non-super roles must have a valid company context before any DB work.
      const callerCid = callerCompanyId(req);
      if (role !== "super_admin" && !callerCid) {
        res.status(400).json({ message: "Company context required" });
        return;
      }

      try {
        // 1. Load the wet check.
        const wc = await queries.getWetCheck(wetCheckId);
        if (!wc) {
          res.status(404).json({ message: "Wet check not found" });
          return;
        }

        // Tenant guard: non-super callers must share company with the wet check.
        // callerCid is guaranteed non-null here for non-super roles (checked above).
        if (role !== "super_admin" && wc.companyId !== callerCid) {
          res.status(403).json({ message: "Forbidden — wet check belongs to a different company" });
          return;
        }

        // 2. Load all WCBs for this wet check.
        const wcbs = await queries.getWcbs(wetCheckId);
        if (wcbs.length === 0) {
          res.status(422).json({ message: "This wet check has no billing snapshots to reassign" });
          return;
        }

        // 3. Classify WCBs.
        const moveable = wcbs.filter((w) => !w.invoiceId && w.status !== "billed");
        const skipped = wcbs.filter((w) => w.invoiceId != null || w.status === "billed");

        if (moveable.length === 0) {
          res.status(409).json({
            message: "All snapshots are already billed or invoiced — reassignment is blocked.",
            reason: "all_snapshots_billed",
            skippedIds: skipped.map((w) => w.id),
          });
          return;
        }

        // 4. Resolve target customer — must exist and not be hiddenFromBilling.
        const targetCustomer = await queries.getCustomer(targetCustomerId);
        if (!targetCustomer) {
          res.status(404).json({ message: "Target customer not found" });
          return;
        }
        if (targetCustomer.hiddenFromBilling) {
          res.status(422).json({ message: "Target customer is hidden from billing — choose a billing-visible customer" });
          return;
        }

        // Tenant guard for target: non-super cannot move across companies.
        if (role !== "super_admin" && targetCustomer.companyId !== callerCid) {
          res.status(403).json({ message: "Target customer belongs to a different company" });
          return;
        }

        // 5. Check for derived work orders / estimates (triaged findings).
        //    These are NOT moved — we warn about them.
        const findingsWithRouting = await queries.getFindingsWithRouting(wetCheckId);
        const derivedWorkOrderIds = [
          ...new Set(
            findingsWithRouting
              .map((f) => f.workOrderId)
              .filter((id): id is number => id != null),
          ),
        ];
        const derivedEstimateIds = [
          ...new Set(
            findingsWithRouting
              .map((f) => f.estimateId)
              .filter((id): id is number => id != null),
          ),
        ];

        // 6. Execute the reassignment in a single transaction.
        const targetCompanyId = targetCustomer.companyId;
        const targetAddress = targetCustomer.address ?? wc.propertyAddress ?? "";
        const moveableIds = moveable.map((w) => w.id);
        const now = new Date();

        await queries.executeReassign({
          wetCheckId,
          targetCustomerId,
          targetCustomerName: targetCustomer.name,
          targetCompanyId,
          targetAddress,
          targetBranchName: targetBranchName ?? null,
          moveableIds,
          now,
        });

        // 7. Write audit entries (best-effort — outside the main tx so audit
        //    failures don't roll back the reassignment).
        const actorUserId = req.authenticatedUserId ?? null;
        const actorCompanyId = callerCid ?? null;
        const summary = `Wet check reassigned from customer #${wc.customerId} (${wc.customerName}) to customer #${targetCustomerId} (${targetCustomer.name}) — ${moveableIds.length} snapshot(s) moved, ${skipped.length} skipped (invoiced)`;

        await recordAuditEvent(req, {
          actorUserId,
          actorRole: role,
          actorCompanyId,
          action: "wet_check.customer_reassigned",
          actionType: "update",
          severity: "info",
          targetType: "wet_check",
          targetId: String(wetCheckId),
          summary,
          details: {
            fromCustomerId: wc.customerId,
            fromCustomerName: wc.customerName,
            fromCompanyId: wc.companyId,
            toCustomerId: targetCustomerId,
            toCustomerName: targetCustomer.name,
            toCompanyId: targetCompanyId,
            branchName: targetBranchName ?? null,
            movedWcbIds: moveableIds,
            skippedWcbIds: skipped.map((w) => w.id),
            derivedWorkOrderIds,
            derivedEstimateIds,
          },
        });

        for (const wcbId of moveableIds) {
          await recordAuditEvent(req, {
            actorUserId,
            actorRole: role,
            actorCompanyId,
            action: "wet_check_billing.customer_reassigned",
            actionType: "update",
            severity: "info",
            targetType: "wet_check_billing",
            targetId: String(wcbId),
            summary: `Snapshot reassigned to customer #${targetCustomerId} (${targetCustomer.name}) via wet check #${wetCheckId} reassignment`,
            details: {
              wetCheckId,
              fromCustomerId: wc.customerId,
              toCustomerId: targetCustomerId,
              toCompanyId: targetCompanyId,
            },
          });
        }

        // 8. Return result.
        res.json({
          wetCheckId,
          moved: moveableIds,
          skipped: skipped.map((w) => ({
            id: w.id,
            billingNumber: w.billingNumber,
            reason: w.invoiceId ? "invoiced" : "billed",
          })),
          warnings:
            derivedWorkOrderIds.length > 0 || derivedEstimateIds.length > 0
              ? {
                  message:
                    "Some findings have been routed to work orders or estimates. These were not moved and must be handled separately.",
                  derivedWorkOrderIds,
                  derivedEstimateIds,
                }
              : null,
          targetCustomer: {
            id: targetCustomer.id,
            name: targetCustomer.name,
            companyId: targetCompanyId,
          },
        });
      } catch (err) {
        logger.error({ err }, "POST /api/wet-checks/:id/reassign-customer failed");
        res.status(500).json({ message: "Reassignment failed — please retry" });
      }
    },
  );
}
