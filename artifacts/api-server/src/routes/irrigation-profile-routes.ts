// Irrigation System Profile — Build 1 + Build 3: Route module.
//
// All routes are company-scoped (companyId from req.authenticatedUserCompanyId).
// super_admin gets cross-tenant access (companyId = null treated as bypass).
// Any row whose companyId doesn't match the caller returns 404 (not 403),
// matching the estimate cross-company ownership guard pattern.
//
// Routes:
//   GET    /api/irrigation-controllers/company-rollup        (admin: company_admin + super_admin)
//   GET    /api/customers/:customerId/controllers-profile
//   POST   /api/customers/:customerId/controllers-profile
//   GET    /api/irrigation-controllers/:id
//   PUT    /api/irrigation-controllers/:id
//   DELETE /api/irrigation-controllers/:id
//   POST   /api/irrigation-controllers/:id/programs
//   PUT    /api/irrigation-programs/:id
//   DELETE /api/irrigation-programs/:id
//   POST   /api/irrigation-controllers/:id/zones
//   PUT    /api/irrigation-zones/:id
//   DELETE /api/irrigation-zones/:id
//   GET    /api/irrigation-controllers/:id/history
//   POST   /api/irrigation-controllers/:id/photo
//   GET    /api/customers/:customerId/irrigation-profile/report-pdf  (Build 3)
//   POST   /api/customers/:customerId/irrigation-profile/report/send (Build 3)

import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { customers, irrigationControllers } from "@workspace/db";
import { storage } from "../storage";
import type { IrrigationImportRow, IrrigationImportRowError, IrrigationZoneTypeEnum } from "../storage";

// ── Role helpers ──────────────────────────────────────────────────────────────

const MANAGER_ROLES = new Set([
  "company_admin",
  "super_admin",
  "irrigation_manager",
  "billing_manager",
]);

const WRITE_ROLES = new Set([
  "company_admin",
  "super_admin",
  "irrigation_manager",
  // field_tech: can create and edit zones, attach photos, and log backflow tests
]);

function isManagerRole(role: string | undefined): boolean {
  return !!role && MANAGER_ROLES.has(role);
}

function canWrite(role: string | undefined): boolean {
  return !!role && (WRITE_ROLES.has(role) || role === "field_tech");
}

function isSuperAdmin(role: string | undefined): boolean {
  return role === "super_admin";
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

export const createControllerBody = z.object({
  name: z.string().min(1).max(200),
  branchName: z.string().optional(),
  location: z.string().nullish(),
  brand: z.string().nullish(),
  model: z.string().nullish(),
  totalZones: z.coerce.number().int().nonnegative().nullish(),
  notes: z.string().nullish(),
  settingsPhotoUrl: z.string().nullish(),
  isActive: z.boolean().optional(),
});

export const updateControllerBody = createControllerBody.partial().extend({
  // Task #1856: letter can be changed via the update route; it is NOT part of
  // createControllerBody (auto-assigned on create). A-Z only, case-insensitive
  // on input; server normalises to uppercase. Collision check done in the route.
  letter: z.string().optional(),
});

export const createProgramBody = z.object({
  name: z.string().min(1).max(100),
  wateringDays: z.array(z.string()).nullish(),
  startTimes: z.array(z.string()).nullish(),
  seasonalAdjustPct: z.coerce.number().int().min(0).max(500).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

export const updateProgramBody = createProgramBody.partial();

export const createZoneBody = z.object({
  zoneNumber: z.coerce.number().int().positive(),
  name: z.string().min(1).max(200),
  zoneType: z
    .enum(["pop_up_spray", "rotor", "drip", "netafim", "bubbler", "other"])
    .optional(),
  runTimeMinutes: z.coerce.number().int().nonnegative().optional(),
  zoneOrder: z.coerce.number().int().optional(),
  programId: z.coerce.number().int().positive().nullish(),
  isActive: z.boolean().optional(),
  notes: z.string().nullish(),
  overrideStartTime: z.string().nullish(),
  overrideDays: z.array(z.string()).nullish(),
});

export const updateZoneBody = createZoneBody.partial();

export const attachPhotoBody = z.object({
  url: z.string().min(1),
});

// ── Deps interface (injected so tests can swap requireAuthentication) ─────────

export interface IrrigationProfileRouteDeps {
  requireAuthentication: RequestHandler;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getCallerCompanyId(req: any): number | null {
  const cid = req.authenticatedUserCompanyId;
  return cid != null ? Number(cid) : null;
}

function badId(res: any, entity: string): void {
  res.status(400).json({ message: `Invalid ${entity} id` });
}

function notFound(res: any, entity: string): void {
  res.status(404).json({ message: `${entity} not found` });
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerIrrigationProfileRoutes(
  app: Express,
  deps: IrrigationProfileRouteDeps,
): void {
  const { requireAuthentication } = deps;

  // ── GET /api/irrigation-controllers/company-rollup ─────────────────────────
  // Company-wide roll-up of all customers and their canonical irrigation
  // controllers (from irrigation_controllers — the single source of truth).
  // Registered BEFORE /:id so the literal path is not swallowed by the param.
  // Access: company_admin (own company) and super_admin (all companies).
  app.get(
    "/api/irrigation-controllers/company-rollup",
    requireAuthentication,
    async (req: any, res: any) => {
      const role = req.authenticatedUserRole as string | undefined;
      if (role !== "company_admin" && role !== "super_admin") {
        return res.status(403).json({ message: "Access denied. Company admin or super admin required." });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!callerCompanyId && !isSuperAdmin(role)) {
        return res.status(401).json({ message: "Authentication required" });
      }

      try {
        // Fetch all non-hidden customers scoped to caller's company.
        const custConditions: any[] = [
          sql`coalesce(${customers.hiddenFromBilling}, false) = false`,
        ];
        if (!isSuperAdmin(role)) {
          custConditions.push(eq(customers.companyId, callerCompanyId!));
        }

        const custs = await db
          .select({
            id: customers.id,
            name: customers.name,
            irrigoName: customers.irrigoName,
            companyId: customers.companyId,
          })
          .from(customers)
          .where(and(...custConditions))
          .orderBy(customers.name);

        if (custs.length === 0) {
          return res.json([]);
        }

        // Fetch all irrigation controllers for these customers in one query.
        const custIds = custs.map((c) => c.id);
        const ctrlConditions: any[] = [inArray(irrigationControllers.customerId, custIds)];
        if (!isSuperAdmin(role)) {
          ctrlConditions.push(eq(irrigationControllers.companyId, callerCompanyId!));
        }

        const allCtrls = await db
          .select()
          .from(irrigationControllers)
          .where(and(...ctrlConditions))
          .orderBy(irrigationControllers.customerId, irrigationControllers.name, irrigationControllers.id);

        // Group controllers by customerId.
        const byCustomer = new Map<number, typeof allCtrls>();
        for (const ctrl of allCtrls) {
          const arr = byCustomer.get(ctrl.customerId) ?? [];
          arr.push(ctrl);
          byCustomer.set(ctrl.customerId, arr);
        }

        const rollup = custs.map((customer) => ({
          customer,
          controllers: byCustomer.get(customer.id) ?? [],
        }));

        res.json(rollup);
      } catch (e: any) {
        req.log?.error?.({ err: e }, "companyRollup failed");
        res.status(500).json({ message: "Could not load controllers rollup — please retry" });
      }
    },
  );

  // ── GET /api/customers/:customerId/controllers-profile ──────────────────────
  app.get(
    "/api/customers/:customerId/controllers-profile",
    requireAuthentication,
    async (req: any, res: any) => {
      const customerId = parseId(req.params.customerId);
      if (!customerId) return badId(res, "customer");

      const role = req.authenticatedUserRole as string | undefined;
      if (!isManagerRole(role) && role !== "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      // Company guard: verify the customer belongs to the caller's company.
      // super_admin can access any customer.
      if (!isSuperAdmin(role)) {
        if (!callerCompanyId) {
          return res.status(401).json({ message: "Authentication required" });
        }
        const customer = await storage.getCustomer(customerId);
        if (!customer || customer.companyId !== callerCompanyId) {
          return notFound(res, "Customer");
        }
      }

      try {
        const branchName =
          typeof req.query.branchName === "string"
            ? req.query.branchName
            : undefined;

        let controllers = await storage.listIrrigationControllers(
          callerCompanyId,
          customerId,
          branchName,
        );

        // Lazy seed: when no irrigation profile exists yet for this customer/branch,
        // check if property_controllers has legacy data and bootstrap irrigation_controllers
        // from it. This is the automated forward-compat bridge so the profile page
        // shows controllers that were set up via the wet-check flow before unification.
        if (controllers.length === 0 && callerCompanyId !== null) {
          const legacyRows = await storage.listPropertyControllers(callerCompanyId, customerId);
          const branchFilter = branchName ?? "";
          const branchRows = legacyRows.filter((r) => (r.branchName ?? "") === branchFilter);
          if (branchRows.length > 0) {
            // Task #1856: carry the legacy controllerLetter forward so the
          // allocator preserves non-sequential legacy assignments (e.g. A, C)
          // rather than compacting them to A, B.
          const configs = branchRows.map((r) => ({
              name: `Controller ${r.controllerLetter}`,
              zoneCount: r.zoneCount,
              letter: r.controllerLetter,
            }));
            controllers = await storage.ensureIrrigationControllers(
              callerCompanyId,
              customerId,
              configs,
              branchName ?? null,
            );
          }
        }

        res.json(controllers);
      } catch (e: any) {
        req.log?.error?.({ err: e, customerId }, "listIrrigationControllers failed");
        res.status(500).json({ message: "Could not load controllers — please retry" });
      }
    },
  );

  // ── POST /api/customers/:customerId/controllers-profile ─────────────────────
  app.post(
    "/api/customers/:customerId/controllers-profile",
    requireAuthentication,
    async (req: any, res: any) => {
      const customerId = parseId(req.params.customerId);
      if (!customerId) return badId(res, "customer");

      const role = req.authenticatedUserRole as string | undefined;
      if (!canWrite(role)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      // field_tech cannot create controllers (only zones and photos).
      if (role === "field_tech") {
        return res.status(403).json({ message: "Field technicians cannot create controllers" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!callerCompanyId && !isSuperAdmin(role)) {
        return res.status(401).json({ message: "Authentication required" });
      }

      // Customer ownership guard.
      if (!isSuperAdmin(role)) {
        const customer = await storage.getCustomer(customerId);
        if (!customer || customer.companyId !== callerCompanyId!) {
          return notFound(res, "Customer");
        }
      }

      const parsed = createControllerBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const companyIdForCreate = isSuperAdmin(role)
          ? (callerCompanyId ?? (await storage.getCustomer(customerId))?.companyId!)
          : callerCompanyId!;

        const effectiveBranch = parsed.data.branchName ?? "";
        const controller = await storage.createIrrigationController({
          companyId: companyIdForCreate,
          customerId,
          branchName: effectiveBranch,
          name: parsed.data.name,
          location: parsed.data.location ?? null,
          brand: parsed.data.brand ?? null,
          model: parsed.data.model ?? null,
          totalZones: parsed.data.totalZones ?? null,
          notes: parsed.data.notes ?? null,
          settingsPhotoUrl: parsed.data.settingsPhotoUrl ?? null,
          isActive: parsed.data.isActive ?? true,
          lastUpdatedByUserId: me?.id ?? null,
          lastUpdatedByName: me?.name ?? null,
          lastUpdatedAt: new Date(),
        });

        // Task #1857: stop syncing customers.totalControllers — count is now
        // derived from COUNT(*) on irrigation_controllers.

        res.status(201).json(controller);
      } catch (e: any) {
        req.log?.error?.({ err: e, customerId }, "createIrrigationController failed");
        res.status(500).json({ message: "Could not create controller — please retry" });
      }
    },
  );

  // ── GET /api/irrigation-controllers/:id ────────────────────────────────────
  app.get(
    "/api/irrigation-controllers/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "controller");

      const role = req.authenticatedUserRole as string | undefined;
      if (!isManagerRole(role) && role !== "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      try {
        const controller = await storage.getIrrigationController(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
        );
        if (!controller) return notFound(res, "Controller");
        res.json(controller);
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "getIrrigationController failed");
        res.status(500).json({ message: "Could not load controller — please retry" });
      }
    },
  );

  // ── PUT /api/irrigation-controllers/:id ────────────────────────────────────
  app.put(
    "/api/irrigation-controllers/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "controller");

      const role = req.authenticatedUserRole as string | undefined;
      if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!callerCompanyId && !isSuperAdmin(role)) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const parsed = updateControllerBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      // Task #1856 — letter change: validate + collision check before the update.
      const patchData: typeof parsed.data = { ...parsed.data };
      if (patchData.letter !== undefined) {
        const normalized = patchData.letter.toUpperCase();
        if (!/^[A-Z]$/.test(normalized)) {
          return res.status(400).json({ message: "Letter must be a single uppercase character A–Z" });
        }
        // Collision check: another controller in the same (company, customer, branch) scope.
        const callerCompanyIdForCheck = isSuperAdmin(role) ? null : callerCompanyId;
        const currentCtrl = await storage.getIrrigationController(callerCompanyIdForCheck, id);
        if (!currentCtrl) return notFound(res, "Controller");
        const conflicting = await db
          .select({ id: irrigationControllers.id, name: irrigationControllers.name })
          .from(irrigationControllers)
          .where(and(
            eq(irrigationControllers.companyId, currentCtrl.companyId),
            eq(irrigationControllers.customerId, currentCtrl.customerId),
            eq(irrigationControllers.branchName, currentCtrl.branchName),
            eq(irrigationControllers.letter, normalized),
            sql`${irrigationControllers.id} <> ${id}`,
          ));
        if (conflicting.length > 0) {
          return res.status(409).json({
            message: `Letter ${normalized} is already used by "${conflicting[0].name}"`,
            holdingController: conflicting[0].name,
          });
        }
        patchData.letter = normalized;
      }

      try {
        const updated = await storage.updateIrrigationController(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
          { ...patchData },
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!updated) return notFound(res, "Controller");
        res.json(updated);
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "updateIrrigationController failed");
        res.status(500).json({ message: "Could not update controller — please retry" });
      }
    },
  );

  // ── DELETE /api/irrigation-controllers/:id ─────────────────────────────────
  app.delete(
    "/api/irrigation-controllers/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "controller");

      const role = req.authenticatedUserRole as string | undefined;
      if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      try {
        // Fetch before delete so we know branchName/customerId for the sync.
        const controllerToDelete = await storage.getIrrigationController(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
        );
        if (!controllerToDelete) return notFound(res, "Controller");

        const ok = await storage.deleteIrrigationController(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
        );
        if (!ok) return notFound(res, "Controller");

        // Task #1857: stop syncing customers.totalControllers — count is now
        // derived from COUNT(*) on irrigation_controllers.

        res.json({ ok: true });
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "deleteIrrigationController failed");
        res.status(500).json({ message: "Could not delete controller — please retry" });
      }
    },
  );

  // ── POST /api/irrigation-controllers/:id/programs ──────────────────────────
  app.post(
    "/api/irrigation-controllers/:id/programs",
    requireAuthentication,
    async (req: any, res: any) => {
      const controllerId = parseId(req.params.id);
      if (!controllerId) return badId(res, "controller");

      const role = req.authenticatedUserRole as string | undefined;
      if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      const parsed = createProgramBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const program = await storage.createIrrigationProgram(
          isSuperAdmin(role) ? null : callerCompanyId,
          controllerId,
          {
            name: parsed.data.name,
            wateringDays: parsed.data.wateringDays ?? null,
            startTimes: parsed.data.startTimes ?? null,
            seasonalAdjustPct: parsed.data.seasonalAdjustPct ?? 100,
            isActive: parsed.data.isActive ?? true,
            sortOrder: parsed.data.sortOrder ?? 0,
          },
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!program) return notFound(res, "Controller");
        res.status(201).json(program);
      } catch (e: any) {
        req.log?.error?.({ err: e, controllerId }, "createIrrigationProgram failed");
        res.status(500).json({ message: "Could not create program — please retry" });
      }
    },
  );

  // ── PUT /api/irrigation-programs/:id ──────────────────────────────────────
  app.put(
    "/api/irrigation-programs/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "program");

      const role = req.authenticatedUserRole as string | undefined;
      if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      const parsed = updateProgramBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const updated = await storage.updateIrrigationProgram(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
          parsed.data,
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!updated) return notFound(res, "Program");
        res.json(updated);
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "updateIrrigationProgram failed");
        res.status(500).json({ message: "Could not update program — please retry" });
      }
    },
  );

  // ── DELETE /api/irrigation-programs/:id ───────────────────────────────────
  app.delete(
    "/api/irrigation-programs/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "program");

      const role = req.authenticatedUserRole as string | undefined;
      if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const ok = await storage.deleteIrrigationProgram(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!ok) return notFound(res, "Program");
        res.json({ ok: true });
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "deleteIrrigationProgram failed");
        res.status(500).json({ message: "Could not delete program — please retry" });
      }
    },
  );

  // ── POST /api/irrigation-controllers/:id/zones ─────────────────────────────
  app.post(
    "/api/irrigation-controllers/:id/zones",
    requireAuthentication,
    async (req: any, res: any) => {
      const controllerId = parseId(req.params.id);
      if (!controllerId) return badId(res, "controller");

      const role = req.authenticatedUserRole as string | undefined;
      if (!canWrite(role)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      const parsed = createZoneBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const zone = await storage.createIrrigationZone(
          isSuperAdmin(role) ? null : callerCompanyId,
          controllerId,
          {
            zoneNumber: parsed.data.zoneNumber,
            name: parsed.data.name,
            zoneType: parsed.data.zoneType ?? "other",
            runTimeMinutes: parsed.data.runTimeMinutes ?? 0,
            zoneOrder: parsed.data.zoneOrder ?? parsed.data.zoneNumber,
            programId: parsed.data.programId ?? null,
            isActive: parsed.data.isActive ?? true,
            notes: parsed.data.notes ?? null,
            overrideStartTime: parsed.data.overrideStartTime ?? null,
            overrideDays: parsed.data.overrideDays ?? null,
          },
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!zone) return notFound(res, "Controller");
        res.status(201).json(zone);
      } catch (e: any) {
        req.log?.error?.({ err: e, controllerId }, "createIrrigationZone failed");
        res.status(500).json({ message: "Could not create zone — please retry" });
      }
    },
  );

  // ── PUT /api/irrigation-zones/:id ─────────────────────────────────────────
  app.put(
    "/api/irrigation-zones/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "zone");

      const role = req.authenticatedUserRole as string | undefined;
      if (!canWrite(role)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      const parsed = updateZoneBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const updated = await storage.updateIrrigationZone(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
          parsed.data,
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!updated) return notFound(res, "Zone");
        res.json(updated);
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "updateIrrigationZone failed");
        res.status(500).json({ message: "Could not update zone — please retry" });
      }
    },
  );

  // ── DELETE /api/irrigation-zones/:id ──────────────────────────────────────
  app.delete(
    "/api/irrigation-zones/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "zone");

      const role = req.authenticatedUserRole as string | undefined;
      if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const ok = await storage.deleteIrrigationZone(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!ok) return notFound(res, "Zone");
        res.json({ ok: true });
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "deleteIrrigationZone failed");
        res.status(500).json({ message: "Could not delete zone — please retry" });
      }
    },
  );

  // ── GET /api/irrigation-controllers/:id/history ────────────────────────────
  app.get(
    "/api/irrigation-controllers/:id/history",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "controller");

      const role = req.authenticatedUserRole as string | undefined;
      // History is read-only: all authenticated roles (including field_tech)
      // may view a controller's history within their company scope.
      if (!role) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      const scopedCompanyId = isSuperAdmin(role) ? null : callerCompanyId;

      try {
        // Verify the controller exists and belongs to the caller's company
        // before returning history — same guard pattern as GET controller.
        const ctrl = await storage.getIrrigationController(scopedCompanyId, id);
        if (!ctrl) return res.status(404).json({ message: "Controller not found" });

        const history = await storage.getIrrigationHistory(scopedCompanyId, id);
        res.json(history);
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "getIrrigationHistory failed");
        res.status(500).json({ message: "Could not load history — please retry" });
      }
    },
  );

  // ── POST /api/irrigation-controllers/:id/photo ─────────────────────────────
  // Attach a settings photo URL (already uploaded via /api/upload/photo) to
  // the controller's settingsPhotoUrl field.
  app.post(
    "/api/irrigation-controllers/:id/photo",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "controller");

      const role = req.authenticatedUserRole as string | undefined;
      if (!canWrite(role)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      const parsed = attachPhotoBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const updated = await storage.updateIrrigationController(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
          { settingsPhotoUrl: parsed.data.url },
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!updated) return notFound(res, "Controller");
        res.json(updated);
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "attachIrrigationControllerPhoto failed");
        res.status(500).json({ message: "Could not attach photo — please retry" });
      }
    },
  );

  // ── GET /api/customers/:customerId/irrigation-profile/export-csv ────────────
  // Serialises the current irrigation profile (controllers → programs → zones)
  // to a CSV file in the same format as the import template so the file can be
  // edited and re-imported without modification (round-trip safe).
  // Access: same manager-tier guard as import (company_admin, super_admin,
  // irrigation_manager — billing_manager and field_tech are excluded).
  app.get(
    "/api/customers/:customerId/irrigation-profile/export-csv",
    requireAuthentication,
    async (req: any, res: any) => {
      const customerId = parseId(req.params.customerId);
      if (!customerId) return badId(res, "customer");

      const role = req.authenticatedUserRole as string | undefined;
      if (!role || !MANAGER_ROLES.has(role) || role === "billing_manager") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!callerCompanyId && !isSuperAdmin(role)) {
        return res.status(401).json({ message: "Authentication required" });
      }

      if (!isSuperAdmin(role)) {
        const customer = await storage.getCustomer(customerId);
        if (!customer || customer.companyId !== callerCompanyId!) {
          return notFound(res, "Customer");
        }
      }

      try {
        const customer = await storage.getCustomer(customerId);
        if (!customer) return notFound(res, "Customer");

        const companyId = isSuperAdmin(role)
          ? (customer.companyId ?? callerCompanyId!)
          : callerCompanyId!;

        const ctrlList = await storage.listIrrigationControllers(companyId, customerId);
        const detailedControllers = await Promise.all(
          ctrlList.map((c: any) => storage.getIrrigationController(companyId, c.id)),
        );
        const validControllers = detailedControllers.filter(
          (c: any): c is NonNullable<typeof c> => c !== null,
        );

        // ── CSV serialisation ────────────────────────────────────────────────
        const HEADERS = [
          "Controller",
          "Location",
          "Brand",
          "Model",
          "Program",
          "Watering Days",
          "Start Time",
          "Seasonal %",
          "Zone #",
          "Zone Name",
          "Zone Type",
          "Run Time (min)",
        ];

        function csvCell(val: string | number | null | undefined): string {
          const s = val == null ? "" : String(val);
          // Wrap in quotes when the value contains commas, double-quotes, or newlines
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        }

        function csvRow(cells: (string | number | null | undefined)[]): string {
          return cells.map(csvCell).join(",");
        }

        const lines: string[] = [HEADERS.join(",")];

        for (const ctrl of validControllers) {
          const zones: any[] = ctrl.zones ?? [];
          const programs: any[] = ctrl.programs ?? [];

          const programMap = new Map<number, any>();
          for (const prog of programs) {
            programMap.set(prog.id, prog);
          }

          if (zones.length === 0) {
            // Controller with no zones: emit a single placeholder row so the
            // controller name is preserved in the export.
            lines.push(
              csvRow([
                ctrl.name,
                ctrl.location ?? "",
                ctrl.brand ?? "",
                ctrl.model ?? "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
              ]),
            );
          } else {
            // Sort zones by zoneNumber for a predictable, human-readable order.
            const sortedZones = [...zones].sort(
              (a: any, b: any) => (a.zoneNumber ?? 0) - (b.zoneNumber ?? 0),
            );
            for (const zone of sortedZones) {
              const prog = zone.programId ? programMap.get(zone.programId) : null;
              lines.push(
                csvRow([
                  ctrl.name,
                  ctrl.location ?? "",
                  ctrl.brand ?? "",
                  ctrl.model ?? "",
                  prog?.name ?? "",
                  Array.isArray(prog?.wateringDays) && prog.wateringDays.length > 0
                    ? (prog.wateringDays as string[]).join(",")
                    : "",
                  Array.isArray(prog?.startTimes) && prog.startTimes.length > 0
                    ? (prog.startTimes as string[]).join(",")
                    : "",
                  prog != null ? (prog.seasonalAdjustPct ?? 100) : "",
                  zone.zoneNumber,
                  zone.name,
                  zone.zoneType ?? "other",
                  zone.runTimeMinutes ?? 0,
                ]),
              );
            }
          }
        }

        const csv = lines.join("\n");

        // eslint-disable-next-line no-control-regex
        const safeCustomer = customer.name
          .replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const date = new Date().toISOString().slice(0, 10);
        const filename = safeCustomer
          ? `${safeCustomer} - Irrigation Profile - ${date}.csv`
          : `irrigation-profile-${customerId}-${date}.csv`;
        // eslint-disable-next-line no-control-regex
        const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
        const utf8Filename = encodeURIComponent(filename);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`,
        );
        res.send(csv);
      } catch (e: any) {
        req.log?.error?.({ err: e, customerId }, "irrigationProfileExportCsv failed");
        res.status(500).json({ message: "Failed to export irrigation profile CSV" });
      }
    },
  );

  // ── POST /api/customers/:customerId/irrigation-profile/import-csv ───────────
  // Parse, validate, and optionally apply a flat one-row-per-zone CSV import.
  // Body: { mode: 'preview'|'commit', rows: ParsedRow[], branchName?: string }
  // In preview mode: returns the diff, never writes.
  // In commit mode: applies the non-destructive merge and appends history snapshots.
  app.post(
    "/api/customers/:customerId/irrigation-profile/import-csv",
    requireAuthentication,
    async (req: any, res: any) => {
      const customerId = parseId(req.params.customerId);
      if (!customerId) return badId(res, "customer");

      const role = req.authenticatedUserRole as string | undefined;
      // Only manager-tier roles (not field_tech) may import
      if (!role || !MANAGER_ROLES.has(role) || role === "billing_manager") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!callerCompanyId && !isSuperAdmin(role)) {
        return res.status(401).json({ message: "Authentication required" });
      }

      // Customer ownership guard
      if (!isSuperAdmin(role)) {
        const customer = await storage.getCustomer(customerId);
        if (!customer || customer.companyId !== callerCompanyId!) {
          return notFound(res, "Customer");
        }
      }

      const { mode, rows, branchName, replaceControllers } = req.body ?? {};

      if (mode !== "preview" && mode !== "commit") {
        return res.status(400).json({ message: "mode must be 'preview' or 'commit'" });
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "rows must be a non-empty array" });
      }

      // ── Server-side row validation ─────────────────────────────────────────
      const VALID_ZONE_TYPES = new Set([
        "pop_up_spray", "rotor", "drip", "netafim", "bubbler", "other",
      ]);
      const VALID_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
      const TIME_RE = /^\d{1,2}:\d{2}$/;

      const validRows: IrrigationImportRow[] = [];
      const rowErrors: IrrigationImportRowError[] = [];

      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i];
        const rowNum = i + 2; // header = row 1

        if (!raw.controllerName || typeof raw.controllerName !== "string") {
          rowErrors.push({ row: rowNum, field: "Controller", message: "Controller name is required" });
          continue;
        }
        if (!Number.isInteger(raw.zoneNumber) || raw.zoneNumber < 1) {
          rowErrors.push({ row: rowNum, field: "Zone #", message: "Zone # must be a positive integer" });
          continue;
        }
        if (!raw.zoneType || !VALID_ZONE_TYPES.has(raw.zoneType)) {
          rowErrors.push({
            row: rowNum,
            field: "Zone Type",
            message: `Unknown zone type "${raw.zoneType}". Valid: pop_up_spray, rotor, drip, netafim, bubbler, other`,
          });
          continue;
        }
        if (typeof raw.runTimeMinutes !== "number" || raw.runTimeMinutes < 0) {
          rowErrors.push({ row: rowNum, field: "Run Time (min)", message: "Run Time must be ≥ 0" });
          continue;
        }
        if (Array.isArray(raw.startTimes)) {
          const bad = raw.startTimes.find((t: unknown) => typeof t !== "string" || !TIME_RE.test(t));
          if (bad !== undefined) {
            rowErrors.push({ row: rowNum, field: "Start Time", message: `Invalid time format "${bad}"` });
            continue;
          }
        }
        if (Array.isArray(raw.wateringDays) && raw.wateringDays.length > 0) {
          const badDay = (raw.wateringDays as unknown[]).find(
            (d) => typeof d !== "string" || !VALID_DAYS.has(d as string),
          );
          if (badDay !== undefined) {
            rowErrors.push({
              row: rowNum,
              field: "Watering Days",
              message: `Invalid watering day "${badDay}". Valid: Mon, Tue, Wed, Thu, Fri, Sat, Sun`,
            });
            continue;
          }
        }

        validRows.push({
          controllerName: String(raw.controllerName).trim(),
          location: raw.location ? String(raw.location).trim() || null : null,
          brand: raw.brand ? String(raw.brand).trim() || null : null,
          model: raw.model ? String(raw.model).trim() || null : null,
          programName: raw.programName ? String(raw.programName).trim() || null : null,
          wateringDays: Array.isArray(raw.wateringDays) ? raw.wateringDays : null,
          startTimes: Array.isArray(raw.startTimes) ? raw.startTimes : null,
          seasonalAdjustPct: typeof raw.seasonalAdjustPct === "number" ? raw.seasonalAdjustPct : 100,
          zoneNumber: raw.zoneNumber,
          zoneName: raw.zoneName ? String(raw.zoneName).trim() || null : null,
          zoneType: raw.zoneType as IrrigationZoneTypeEnum,
          runTimeMinutes: raw.runTimeMinutes,
        });
      }

      // If no valid rows remain, return errors
      if (validRows.length === 0) {
        return res.status(422).json({
          message: "No valid rows found — fix the errors below and retry",
          rowErrors,
        });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;
      const actor = me ? { id: me.id, name: me.name } : undefined;

      const effectiveCompanyId = isSuperAdmin(role)
        ? (callerCompanyId ?? (await storage.getCustomer(customerId))?.companyId!)
        : callerCompanyId!;

      const safeReplaceControllers: string[] = Array.isArray(replaceControllers)
        ? replaceControllers.filter((n: unknown) => typeof n === "string")
        : [];

      try {
        const result = await storage.importIrrigationProfile(
          effectiveCompanyId,
          customerId,
          typeof branchName === "string" ? branchName : "",
          validRows,
          mode as "preview" | "commit",
          actor,
          safeReplaceControllers,
        );
        return res.json({ ...result, rowErrors });
      } catch (e: any) {
        req.log?.error?.({ err: e, customerId }, "importIrrigationProfile failed");
        return res.status(500).json({ message: "Import failed — please retry" });
      }
    },
  );

  // ── GET /api/customers/:customerId/irrigation-profile/report-pdf ────────────
  // Generates and streams a branded PDF for the customer's full irrigation
  // profile. Company-scoped; returns 404 on company mismatch.
  app.get(
    "/api/customers/:customerId/irrigation-profile/report-pdf",
    requireAuthentication,
    async (req: any, res: any) => {
      const customerId = parseId(req.params.customerId);
      if (!customerId) return badId(res, "customer");

      const role = req.authenticatedUserRole as string | undefined;
      if (!isManagerRole(role)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      // Company guard: verify customer belongs to caller's company.
      if (!isSuperAdmin(role)) {
        if (!callerCompanyId) {
          return res.status(401).json({ message: "Authentication required" });
        }
        const customer = await storage.getCustomer(customerId);
        if (!customer || customer.companyId !== callerCompanyId) {
          return notFound(res, "Customer");
        }
      }

      try {
        const customer = await storage.getCustomer(customerId);
        if (!customer) return notFound(res, "Customer");

        const companyId = isSuperAdmin(role)
          ? (customer.companyId ?? callerCompanyId)
          : callerCompanyId!;

        const ctrlList = await storage.listIrrigationControllers(companyId, customerId);
        const detailedControllers = await Promise.all(
          ctrlList.map((c: any) => storage.getIrrigationController(companyId, c.id)),
        );
        const validControllers = detailedControllers.filter(
          (c: any): c is NonNullable<typeof c> => c !== null,
        );

        const company = companyId ? await storage.getCompanyProfile(companyId) : null;

        const { renderIrrigationProfilePdf } = await import("../irrigation-profile-pdf");
        const pdf = await renderIrrigationProfilePdf(customer.name, validControllers, {
          company: company ?? null,
          propertyAddress: (customer as any).address ?? null,
        });

        const wantsDownload = String(req.query?.download ?? "") === "1";
        const safeCustomer = customer.name
          // eslint-disable-next-line no-control-regex
          .replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const date = new Date().toISOString().slice(0, 10);
        const filename = safeCustomer
          ? `${safeCustomer} - Irrigation Profile - ${date}.pdf`
          : `irrigation-profile-${customerId}-${date}.pdf`;
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
        req.log?.error?.({ err: e, customerId }, "irrigationProfileReportPdf failed");
        res.status(500).json({ message: "Failed to generate irrigation profile PDF" });
      }
    },
  );

  // ── POST /api/customers/:customerId/irrigation-profile/report/send ──────────
  // Generates the irrigation profile PDF and emails it to the customer.
  // Company-scoped; returns 404 on company mismatch.
  app.post(
    "/api/customers/:customerId/irrigation-profile/report/send",
    requireAuthentication,
    async (req: any, res: any) => {
      const customerId = parseId(req.params.customerId);
      if (!customerId) return badId(res, "customer");

      const role = req.authenticatedUserRole as string | undefined;
      if (!isManagerRole(role)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!isSuperAdmin(role) && !callerCompanyId) {
        return res.status(401).json({ message: "Authentication required" });
      }

      try {
        const customer = await storage.getCustomer(customerId);
        if (!customer) return notFound(res, "Customer");
        if (!isSuperAdmin(role) && customer.companyId !== callerCompanyId) {
          return notFound(res, "Customer");
        }

        const companyId = isSuperAdmin(role)
          ? (customer.companyId ?? callerCompanyId!)
          : callerCompanyId!;

        // Determine recipient: explicit override or customer email on file.
        const { to } = req.body ?? {};
        let toEmail: string | null =
          typeof to === "string" && to.trim() ? to.trim() : null;
        if (!toEmail) toEmail = (customer as any).email ?? null;
        if (!toEmail) {
          return res.status(422).json({
            message:
              "No email address on file for this customer. Provide a 'to' email.",
          });
        }

        const ctrlList = await storage.listIrrigationControllers(companyId, customerId);
        const detailedControllers = await Promise.all(
          ctrlList.map((c: any) => storage.getIrrigationController(companyId, c.id)),
        );
        const validControllers = detailedControllers.filter(
          (c: any): c is NonNullable<typeof c> => c !== null,
        );

        const company = await storage.getCompanyProfile(companyId);

        const { renderIrrigationProfilePdf } = await import("../irrigation-profile-pdf");
        const pdf = await renderIrrigationProfilePdf(customer.name, validControllers, {
          company: company ?? null,
          propertyAddress: (customer as any).address ?? null,
        });

        const { EmailService } = await import("../email-service");
        await EmailService.sendIrrigationProfileReport({
          to: toEmail,
          customerName: customer.name,
          propertyAddress: (customer as any).address ?? null,
          companyName: company?.name ?? "IrrigoPro",
          companyEmail: company?.email ?? null,
          companyPhone: company?.phone ?? null,
          pdfBuffer: pdf,
          customerId,
        });

        res.json({ sent: true, to: toEmail });
      } catch (e: any) {
        req.log?.error?.({ err: e, customerId }, "irrigationProfileReportSend failed");
        res
          .status(500)
          .json({ message: e?.message ?? "Failed to send irrigation profile report" });
      }
    },
  );

  // ── Backflow Preventer Routes ─────────────────────────────────────────────
  //
  // GET    /api/customers/:customerId/backflows  (list)
  // POST   /api/customers/:customerId/backflows  (create)
  // PUT    /api/backflows/:id                    (update)
  // DELETE /api/backflows/:id
  // POST   /api/backflows/:id/log-test

  const backflowCreateBody = z.object({
    name: z.string().min(1).max(200),
    branchName: z.string().optional(),
    brand: z.string().nullish(),
    model: z.string().nullish(),
    size: z.string().nullish(),
    deviceType: z.enum(["rpz", "double_check", "pvb", "spill_resistant_pvb", "other"]).optional(),
    serialNumber: z.string().nullish(),
    location: z.string().nullish(),
    installDate: z.string().nullish(),
    photoUrl: z.string().nullish(),
    notes: z.string().nullish(),
    lastTestedDate: z.string().nullish(),
    nextTestDueDate: z.string().nullish(),
    lastTestResult: z.enum(["pass", "fail"]).nullish(),
    lastTestedBy: z.string().nullish(),
    isActive: z.boolean().optional(),
  });

  const backflowUpdateBody = backflowCreateBody.partial();

  const logTestBody = z.object({
    lastTestedDate: z.string().min(1),
    lastTestResult: z.enum(["pass", "fail"]),
    lastTestedBy: z.string().nullish(),
    nextTestDueDate: z.string().nullish(),
  });

  // ── GET /api/customers/:customerId/backflows ────────────────────────────────
  app.get(
    "/api/customers/:customerId/backflows",
    requireAuthentication,
    async (req: any, res: any) => {
      const customerId = parseId(req.params.customerId);
      if (!customerId) return badId(res, "customer");

      const role = req.authenticatedUserRole as string | undefined;
      if (!isManagerRole(role) && role !== "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);

      if (!isSuperAdmin(role)) {
        if (!callerCompanyId) {
          return res.status(401).json({ message: "Authentication required" });
        }
        const customer = await storage.getCustomer(customerId);
        if (!customer || customer.companyId !== callerCompanyId) {
          return notFound(res, "Customer");
        }
      }

      try {
        const branchName =
          typeof req.query.branchName === "string" ? req.query.branchName : undefined;
        const rows = await storage.listBackflows(
          isSuperAdmin(role) ? null : callerCompanyId,
          customerId,
          branchName,
        );
        res.json(rows);
      } catch (e: any) {
        req.log?.error?.({ err: e, customerId }, "listBackflows failed");
        res.status(500).json({ message: "Could not load backflows — please retry" });
      }
    },
  );

  // ── POST /api/customers/:customerId/backflows ───────────────────────────────
  app.post(
    "/api/customers/:customerId/backflows",
    requireAuthentication,
    async (req: any, res: any) => {
      const customerId = parseId(req.params.customerId);
      if (!customerId) return badId(res, "customer");

      const role = req.authenticatedUserRole as string | undefined;
      if (!canWrite(role) || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!callerCompanyId && !isSuperAdmin(role)) {
        return res.status(401).json({ message: "Authentication required" });
      }

      if (!isSuperAdmin(role)) {
        const customer = await storage.getCustomer(customerId);
        if (!customer || customer.companyId !== callerCompanyId!) {
          return notFound(res, "Customer");
        }
      }

      const parsed = backflowCreateBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const companyIdForCreate = isSuperAdmin(role)
          ? (callerCompanyId ?? (await storage.getCustomer(customerId))?.companyId!)
          : callerCompanyId!;

        const row = await storage.createBackflow({
          companyId: companyIdForCreate,
          customerId,
          branchName: parsed.data.branchName ?? "",
          name: parsed.data.name,
          brand: parsed.data.brand ?? null,
          model: parsed.data.model ?? null,
          size: parsed.data.size ?? null,
          deviceType: parsed.data.deviceType ?? "other",
          serialNumber: parsed.data.serialNumber ?? null,
          location: parsed.data.location ?? null,
          installDate: parsed.data.installDate ?? null,
          photoUrl: parsed.data.photoUrl ?? null,
          notes: parsed.data.notes ?? null,
          lastTestedDate: parsed.data.lastTestedDate ?? null,
          nextTestDueDate: parsed.data.nextTestDueDate ?? null,
          lastTestResult: parsed.data.lastTestResult ?? null,
          lastTestedBy: parsed.data.lastTestedBy ?? null,
          isActive: parsed.data.isActive ?? true,
          lastUpdatedByUserId: me?.id ?? null,
          lastUpdatedByName: me?.name ?? null,
          lastUpdatedAt: new Date(),
        });
        res.status(201).json(row);
      } catch (e: any) {
        req.log?.error?.({ err: e, customerId }, "createBackflow failed");
        res.status(500).json({ message: "Could not create backflow — please retry" });
      }
    },
  );

  // ── PUT /api/backflows/:id ──────────────────────────────────────────────────
  app.put(
    "/api/backflows/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "backflow");

      const role = req.authenticatedUserRole as string | undefined;
      if (!canWrite(role) || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!callerCompanyId && !isSuperAdmin(role)) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const parsed = backflowUpdateBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const updated = await storage.updateBackflow(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
          { ...parsed.data },
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!updated) return notFound(res, "Backflow");
        res.json(updated);
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "updateBackflow failed");
        res.status(500).json({ message: "Could not update backflow — please retry" });
      }
    },
  );

  // ── DELETE /api/backflows/:id ───────────────────────────────────────────────
  app.delete(
    "/api/backflows/:id",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "backflow");

      const role = req.authenticatedUserRole as string | undefined;
      if (!canWrite(role) || role === "field_tech") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!isSuperAdmin(role) && !callerCompanyId) {
        return res.status(401).json({ message: "Authentication required" });
      }

      try {
        const ok = await storage.deleteBackflow(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
        );
        if (!ok) return notFound(res, "Backflow");
        res.json({ ok: true });
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "deleteBackflow failed");
        res.status(500).json({ message: "Could not delete backflow — please retry" });
      }
    },
  );

  // ── POST /api/backflows/:id/log-test ───────────────────────────────────────
  // Quick-action: stamps the test date/result and rolls nextTestDueDate +1yr.
  // field_tech may log tests (same pattern as controller zone photos).
  app.post(
    "/api/backflows/:id/log-test",
    requireAuthentication,
    async (req: any, res: any) => {
      const id = parseId(req.params.id);
      if (!id) return badId(res, "backflow");

      const role = req.authenticatedUserRole as string | undefined;
      if (!canWrite(role)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const callerCompanyId = getCallerCompanyId(req);
      if (!isSuperAdmin(role) && !callerCompanyId) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const parsed = logTestBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      }

      const userId = req.authenticatedUserId as number | undefined;
      const me = userId ? await storage.getUser(userId) : undefined;

      try {
        const updated = await storage.logBackflowTest(
          isSuperAdmin(role) ? null : callerCompanyId,
          id,
          {
            lastTestedDate: parsed.data.lastTestedDate,
            lastTestResult: parsed.data.lastTestResult,
            lastTestedBy: parsed.data.lastTestedBy ?? null,
            nextTestDueDate: parsed.data.nextTestDueDate ?? null,
          },
          me ? { id: me.id, name: me.name } : undefined,
        );
        if (!updated) return notFound(res, "Backflow");
        res.json(updated);
      } catch (e: any) {
        req.log?.error?.({ err: e, id }, "logBackflowTest failed");
        res.status(500).json({ message: "Could not log test — please retry" });
      }
    },
  );
}
