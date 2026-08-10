// Task #1083 — Bulk-approve endpoint for the Billing Workspace.
//
// POST /api/billing-workspace/bulk-approve
//
// Accepts a list of { type, id } items and attempts to approve each one
// using the same storage transitions as the individual approve-routes.ts
// handlers. Returns 200 even when some items are skipped.
//
// Skip reasons:
//   status_not_active   — item is not in an approvable status
//   not_found           — item could not be loaded
//   already_invoiced    — item has a non-null invoiceId
//   transition_failed   — storage update threw

import type { Express, RequestHandler } from "express";
import { ACTIVE_BS, ACTIVE_WO, ACTIVE_WCB } from "./billing-workspace-routes";
import { storage } from "../storage";

// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const ALLOWED_ROLES = new Set([
  "billing_manager",
  "company_admin",
  "super_admin",
  "irrigation_manager",
]);

export interface RegisterBillingWorkspaceBulkApproveRoutesDeps {
  requireAuthentication: RequestHandler;
}

interface BulkApproveItem {
  type: "billing_sheet" | "work_order" | "wet_check_billing";
  id: number;
}

interface SkippedItem {
  id: number;
  type: string;
  reason: string;
}

export function registerBillingWorkspaceBulkApproveRoutes(
  app: Express,
  { requireAuthentication }: RegisterBillingWorkspaceBulkApproveRoutesDeps,
): void {
  app.post(
    "/api/billing-workspace/bulk-approve",
    requireAuthentication,
    async (req: any, res) => {
      try {
        const userRole: string = req.authenticatedUserRole ?? "";
        if (!ALLOWED_ROLES.has(userRole)) {
          res.status(403).json({ message: "Access denied." });
          return;
        }

        const { items } = (req.body ?? {}) as { items?: BulkApproveItem[] };
        if (!Array.isArray(items) || items.length === 0) {
          res.status(400).json({ message: "items array is required." });
          return;
        }

        const userId: number | null = req.authenticatedUserId ?? null;
        const callerCompanyId: number | null =
          userRole === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);

        let approved = 0;
        const skipped: SkippedItem[] = [];

        const approverUser = userId ? await storage.getUser(userId) : undefined;
        const approverName = (approverUser as any)?.name || "Manager";

        for (const item of items) {
          const { type, id } = item;
          if (!id || !type) {
            skipped.push({ id: id ?? 0, type: type ?? "unknown", reason: "not_found" });
            continue;
          }

          try {
            if (type === "billing_sheet") {
              const bs = await (storage as any).getBillingSheetById(id, callerCompanyId);
              if (!bs) {
                skipped.push({ id, type, reason: "not_found" });
                continue;
              }
              if ((bs as any).invoiceId != null) {
                skipped.push({ id, type, reason: "already_invoiced" });
                continue;
              }
              if (!ACTIVE_BS.has(bs.status)) {
                skipped.push({ id, type, reason: "status_not_active" });
                continue;
              }
              const partsSnapshot = JSON.stringify({ partsSubtotal: bs.partsSubtotal });
              const laborSnapshot = JSON.stringify({
                totalHours: bs.totalHours,
                laborRate: bs.laborRate,
                laborSubtotal: bs.laborSubtotal,
              });
              await storage.updateBillingSheet(id, {
                status: "approved_passed_to_billing",
                approvedBy: approverName,
                approvedByUserId: userId ?? undefined,
                approvedAt: new Date(),
                approvedTotal: bs.totalAmount,
                approvedPartsSnapshot: partsSnapshot,
                approvedLaborSnapshot: laborSnapshot,
              });
              approved++;
            } else if (type === "work_order") {
              const wo = await (storage as any).getWorkOrder(id, callerCompanyId);
              if (!wo) {
                skipped.push({ id, type, reason: "not_found" });
                continue;
              }
              if ((wo as any).invoiceId != null) {
                skipped.push({ id, type, reason: "already_invoiced" });
                continue;
              }
              if (!ACTIVE_WO.has(wo.status)) {
                skipped.push({ id, type, reason: "status_not_active" });
                continue;
              }
              const partsSnapshot = JSON.stringify({ partsSubtotal: wo.partsSubtotal });
              const laborSnapshot = JSON.stringify({
                totalHours: wo.totalHours,
                laborRate: (wo as any).appliedLaborRate ?? wo.laborRate,
                laborSubtotal: wo.laborSubtotal,
              });
              await storage.updateWorkOrder(id, {
                status: "approved_passed_to_billing",
                approvedBy: approverName,
                approvedByUserId: userId ?? undefined,
                approvedAt: new Date(),
                approvedTotal: wo.totalAmount,
                approvedPartsSnapshot: partsSnapshot,
                approvedLaborSnapshot: laborSnapshot,
              });
              approved++;
            } else if (type === "wet_check_billing") {
              const wcb = await (storage as any).getWetCheckBillingById(id, callerCompanyId);
              if (!wcb) {
                skipped.push({ id, type, reason: "not_found" });
                continue;
              }
              if ((wcb as any).invoiceId != null) {
                skipped.push({ id, type, reason: "already_invoiced" });
                continue;
              }
              if (!ACTIVE_WCB.has(wcb.status)) {
                skipped.push({ id, type, reason: "status_not_active" });
                continue;
              }
              const partsSnapshot = JSON.stringify({
                partsSubtotal: wcb.partsSubtotal,
                totalAmount: wcb.totalAmount,
              });
              const laborSnapshot = JSON.stringify({
                laborSubtotal: wcb.laborSubtotal,
                totalHours: wcb.totalHours,
                appliedLaborRate: (wcb as any).appliedLaborRate ?? wcb.laborRate,
              });
              await (storage as any).updateWetCheckBilling(id, {
                status: "approved_passed_to_billing",
                approvedBy: approverName,
                approvedByUserId: userId ?? undefined,
                approvedAt: new Date(),
                approvedTotal: wcb.totalAmount,
                approvedLaborSnapshot: laborSnapshot,
                approvedPartsSnapshot: partsSnapshot,
              });
              approved++;
            } else {
              skipped.push({ id, type, reason: "status_not_active" });
            }
          } catch (err: any) {
            skipped.push({
              id,
              type,
              reason: `transition_failed: ${err?.message ?? String(err)}`,
            });
          }
        }

        res.json({ approved, skipped });
      } catch (error: any) {
        req.log?.error?.({ err: error }, "bulk-approve failed");
        res.status(500).json({ message: "Bulk approve failed." });
      }
    },
  );
}
