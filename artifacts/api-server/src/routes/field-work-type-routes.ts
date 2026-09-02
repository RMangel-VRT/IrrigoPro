import type { Express } from "express";
import { z } from "zod/v4";
import type { FieldWorkType } from "@workspace/db";
import { requireFieldWorkTypeAdmin } from "./role-guards";
import { storage as defaultStorage } from "../storage";

type FieldWorkTypeStorage = Pick<
  typeof defaultStorage,
  "getFieldWorkTypes" | "getFieldWorkTypeById" | "updateFieldWorkType"
> &
  Partial<Pick<typeof defaultStorage, "getCustomerById">>;

export interface FieldWorkTypeRouteDeps {
  requireAuthentication: any;
  storage?: FieldWorkTypeStorage;
  requireAdmin?: any;
}

const updateFieldWorkTypeBody = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
  requiresController: z.boolean().optional(),
  requiresZone: z.boolean().optional(),
  requiresDetails: z.boolean().optional(),
}).strict();

function authenticatedCompanyId(req: any): number | null | undefined {
  if (req.authenticatedUserRole === "super_admin") return null;
  const companyId = req.authenticatedUserCompanyId;
  return Number.isInteger(companyId) && companyId > 0 ? companyId : undefined;
}

function requireTenant(req: any, res: any): number | null | undefined {
  const companyId = authenticatedCompanyId(req);
  if (companyId === undefined) {
    res.status(403).json({ message: "A company scope is required." });
    return undefined;
  }
  return companyId;
}

/**
 * Which tenant's registry the caller is asking about.
 *
 * Super Admin has no company of their own, so the unscoped read answers with
 * every tenant's work types. That matters because the location gate fails open
 * for a company with none: a Super Admin working a record that belongs to an
 * empty tenant would otherwise be shown another tenant's types and be held to
 * a requirement the server has already waived. When the caller names the
 * record's customer, answer for that customer's company instead.
 *
 * For everyone else the parameter is ignored outright — it can never widen a
 * scope or reach across a tenant boundary.
 */
async function resolveActiveListScope(
  req: any,
  res: any,
  routeStorage: FieldWorkTypeStorage,
): Promise<number | null | undefined> {
  const companyId = requireTenant(req, res);
  if (companyId === undefined) return undefined;
  if (companyId !== null) return companyId;

  const customerId = Number(req.query?.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) return null;
  if (typeof routeStorage.getCustomerById !== "function") return null;

  const customer = await routeStorage.getCustomerById(customerId);
  const customerCompanyId = customer?.companyId;
  return Number.isInteger(customerCompanyId) && (customerCompanyId as number) > 0
    ? (customerCompanyId as number)
    : null;
}

/**
 * Whether the caller explicitly asked for the retired rows too.
 *
 * Default stays active-only so every existing caller keeps its behaviour. A
 * caller that has to *render or evaluate* a code already stored on a record —
 * rather than offer a choice — opts in and filters the active rows itself.
 */
function wantsRetired(req: any): boolean {
  const raw = req.query?.includeRetired;
  if (raw === true) return true;
  return ["true", "1", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

export function registerFieldWorkTypeRoutes(
  app: Express,
  deps: FieldWorkTypeRouteDeps,
): void {
  const routeStorage = deps.storage ?? defaultStorage;
  const requireAdmin = deps.requireAdmin ?? requireFieldWorkTypeAdmin;

  app.get(
    "/api/field-work-types",
    deps.requireAuthentication,
    async (req: any, res: any) => {
      let companyId: number | null | undefined;
      try {
        companyId = await resolveActiveListScope(req, res, routeStorage);
      } catch (error: any) {
        res.status(500).json({ message: error?.message ?? "Failed to load field work types" });
        return;
      }
      if (companyId === undefined) return;
      try {
        res.json(await routeStorage.getFieldWorkTypes(companyId, !wantsRetired(req)));
      } catch (error: any) {
        res.status(500).json({ message: error?.message ?? "Failed to load field work types" });
      }
    },
  );

  app.get(
    "/api/admin/field-work-types",
    deps.requireAuthentication,
    requireAdmin,
    async (req: any, res: any) => {
      const companyId = requireTenant(req, res);
      if (companyId === undefined) return;
      try {
        res.json(await routeStorage.getFieldWorkTypes(companyId, false));
      } catch (error: any) {
        res.status(500).json({ message: error?.message ?? "Failed to load field work types" });
      }
    },
  );

  app.patch(
    "/api/admin/field-work-types/:id",
    deps.requireAuthentication,
    requireAdmin,
    async (req: any, res: any) => {
      const companyId = requireTenant(req, res);
      if (companyId === undefined) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ message: "Invalid field work type id" });
        return;
      }
      const parsed = updateFieldWorkTypeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
        return;
      }
      try {
        // A zone is always chosen underneath a controller, on every surface
        // that captures one. Allowing "requires a zone but not its
        // controller" would let a tenant configure a requirement the field
        // UI cannot express, so the combination is refused at the boundary
        // rather than papered over downstream.
        if (
          parsed.data.requiresZone !== undefined ||
          parsed.data.requiresController !== undefined
        ) {
          const current = await routeStorage.getFieldWorkTypeById(id, companyId);
          if (!current) {
            res.status(404).json({ message: "Field work type not found" });
            return;
          }
          const requiresZone = parsed.data.requiresZone ?? current.requiresZone;
          const requiresController =
            parsed.data.requiresController ?? current.requiresController;
          if (requiresZone && !requiresController) {
            res.status(400).json({
              message:
                "A work type that requires a zone must also require its controller.",
            });
            return;
          }
        }
        const updated = await routeStorage.updateFieldWorkType(id, companyId, parsed.data);
        // Deliberately 404 for a foreign tenant: existence must not be disclosed.
        if (!updated) {
          res.status(404).json({ message: "Field work type not found" });
          return;
        }
        res.json(updated satisfies FieldWorkType);
      } catch (error: any) {
        res.status(500).json({ message: error?.message ?? "Failed to update field work type" });
      }
    },
  );
}