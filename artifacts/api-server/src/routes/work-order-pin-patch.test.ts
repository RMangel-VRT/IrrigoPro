// Task #931 — Behavioral tests for the field-tech pin-patch branch in
// `requireWorkOrderUpdateAccess`.
//
// Field techs can PATCH { workLocationLat, workLocationLng, workLocationAddress }
// on work orders assigned to them (the "I'm here" button on the completion
// screen). The three scenarios that must be denied:
//   • Work order not assigned to the requesting tech → 403 (precise message)
//   • Work order is cancelled → 403 (precise message)
//   • Mix of pin + non-pin fields → 403 (catch-all message)
//
// We mirror the `requireWorkOrderUpdateAccess` logic against a lightweight
// in-memory stub so the test requires no database. The stub structure and
// test harness mirror mobile-auth-refresh.test.ts.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ─── Types ────────────────────────────────────────────────────────────────────

type WorkOrderRow = {
  id: number;
  assignedTechnicianId: number | null;
  status: string;
  workLocationLat: string | null;
  workLocationLng: string | null;
  workLocationAddress: string | null;
};

// ─── Stub storage ─────────────────────────────────────────────────────────────

class StubStorage {
  workOrders: WorkOrderRow[] = [];

  async getWorkOrder(id: number, _companyId: number | null): Promise<WorkOrderRow | undefined> {
    return this.workOrders.find((w) => w.id === id);
  }

  async updateWorkOrder(id: number, patch: Partial<WorkOrderRow>): Promise<WorkOrderRow | undefined> {
    const row = this.workOrders.find((w) => w.id === id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  }
}

// ─── Middleware mirror ─────────────────────────────────────────────────────────

// This mirrors `requireWorkOrderUpdateAccess` from routes.ts exactly —
// updating here requires updating there and vice versa.
function buildRequireWorkOrderUpdateAccess(storage: StubStorage) {
  const PIN_KEYS = new Set([
    "workLocationLat",
    "workLocationLng",
    "workLocationAddress",
    "controllerLetter",
    "zoneNumber",
    "fieldWorkType",
    "fieldWorkTypeDetails",
    "workLocationSource",
    "workLocationAccuracyM",
    "workLocationGpsError",
  ]);

  return async (req: any, res: any, next: any) => {
    const userRole = req.authenticatedUserRole;
    const userId = req.authenticatedUserId;
    const workOrderId = parseInt(req.params.id);
    const updateData = req.body;

    if (
      userRole === "company_admin" ||
      userRole === "super_admin" ||
      userRole === "billing_manager" ||
      userRole === "irrigation_manager"
    ) {
      return next();
    }

    if (userRole === "field_tech") {
      if (!userId) {
        res.status(401).json({ message: "Authentication required - user ID not found." });
        return;
      }

      // Start-work branch (status → in_progress only)
      if (updateData.status === "in_progress" && Object.keys(updateData).length <= 2) {
        try {
          const workOrder = await storage.getWorkOrder(workOrderId, null);
          const userIdNum = parseInt(userId as string);
          if (workOrder && workOrder.assignedTechnicianId === userIdNum) {
            return next();
          }
        } catch {
          // fall through
        }
      }

      const updateKeys =
        updateData && typeof updateData === "object" ? Object.keys(updateData) : [];

      // Photos-only branch
      const isPhotosOnlyEdit =
        updateKeys.length === 1 && updateKeys[0] === "photos" && Array.isArray(updateData.photos);
      if (isPhotosOnlyEdit) {
        try {
          const workOrder = await storage.getWorkOrder(workOrderId, null);
          const userIdNum = parseInt(userId as string);
          if (
            workOrder &&
            workOrder.assignedTechnicianId === userIdNum &&
            workOrder.status !== "cancelled"
          ) {
            return next();
          }
        } catch {
          // fall through
        }
      }

      // Pin-only branch
      const isPinOnlyEdit = updateKeys.length > 0 && updateKeys.every((k) => PIN_KEYS.has(k));
      if (isPinOnlyEdit) {
        try {
          const workOrder = await storage.getWorkOrder(workOrderId, null);
          const userIdNum = parseInt(userId as string);
          if (
            !workOrder ||
            workOrder.assignedTechnicianId !== userIdNum ||
            workOrder.status === "cancelled"
          ) {
            res.status(403).json({
              message: "You can only update the pin on a work order assigned to you.",
            });
            return;
          }
          return next();
        } catch {
          // fall through
        }
      }
    }

    res.status(403).json({
      message:
        "Field technicians can only start a work order, update its photos, or move its pin on tickets assigned to them.",
    });
    return;
  };
}

// ─── App factory ──────────────────────────────────────────────────────────────

function attachRoutes(app: Express, storage: StubStorage) {
  const guard = buildRequireWorkOrderUpdateAccess(storage);

  app.patch("/api/work-orders/:id", guard, async (req, res) => {
    const id = parseInt(req.params.id);
    const updated = await storage.updateWorkOrder(id, req.body);
    if (!updated) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    res.json(updated);
  });
}

interface Harness {
  baseUrl: string;
  storage: StubStorage;
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const app = express();
  app.use(express.json());
  const storage = new StubStorage();
  attachRoutes(app, storage);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    storage,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TECH_ID = 42;
const OTHER_TECH_ID = 99;

function makeTechHeaders() {
  return {
    "Content-Type": "application/json",
    "x-authenticated-user-role": "field_tech",
    "x-authenticated-user-id": String(TECH_ID),
  };
}

function makeAdminHeaders() {
  return {
    "Content-Type": "application/json",
    "x-authenticated-user-role": "company_admin",
    "x-authenticated-user-id": "1",
  };
}

// Attach auth headers into req so the middleware can read them.
// We wire them through custom middleware that reads our test-only headers.
function withAuthMiddleware(app: Express) {
  app.use((req: any, _res: any, next: any) => {
    req.authenticatedUserRole = req.headers["x-authenticated-user-role"];
    req.authenticatedUserId = req.headers["x-authenticated-user-id"];
    next();
  });
}

// Rebuild a server with auth shim applied before routes
async function startServerWithAuth(): Promise<Harness> {
  const app = express();
  app.use(express.json());
  withAuthMiddleware(app);
  const storage = new StubStorage();
  attachRoutes(app, storage);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    storage,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function seedWorkOrder(
  storage: StubStorage,
  overrides: Partial<WorkOrderRow> = {},
): WorkOrderRow {
  const row: WorkOrderRow = {
    id: 1,
    assignedTechnicianId: TECH_ID,
    status: "in_progress",
    workLocationLat: null,
    workLocationLng: null,
    workLocationAddress: null,
    ...overrides,
  };
  storage.workOrders.push(row);
  return row;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PATCH /api/work-orders/:id — field-tech pin-patch branch (Task #931)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startServerWithAuth();
  });
  afterEach(async () => {
    await h.close();
  });

  it("assigned tech with all 3 pin fields → 200 and row updated", async () => {
    seedWorkOrder(h.storage, { id: 1, assignedTechnicianId: TECH_ID, status: "in_progress" });

    const res = await fetch(`${h.baseUrl}/api/work-orders/1`, {
      method: "PATCH",
      headers: makeTechHeaders(),
      body: JSON.stringify({
        workLocationLat: 40.123456,
        workLocationLng: -105.654321,
        workLocationAddress: "123 Main St",
      }),
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = (await res.json()) as WorkOrderRow;
    assert.equal(String(body.workLocationLat), "40.123456");
    assert.equal(String(body.workLocationLng), "-105.654321");
    assert.equal(body.workLocationAddress, "123 Main St");
  });

  it("assigned tech with 2 pin fields (lat + lng only) → 200", async () => {
    seedWorkOrder(h.storage, { id: 2, assignedTechnicianId: TECH_ID, status: "in_progress" });

    const res = await fetch(`${h.baseUrl}/api/work-orders/2`, {
      method: "PATCH",
      headers: makeTechHeaders(),
      body: JSON.stringify({
        workLocationLat: 39.7,
        workLocationLng: -104.9,
      }),
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it("assigned tech may save an incomplete location subset without completing", async () => {
    seedWorkOrder(h.storage, { id: 7, assignedTechnicianId: TECH_ID, status: "in_progress" });

    const res = await fetch(`${h.baseUrl}/api/work-orders/7`, {
      method: "PATCH",
      headers: makeTechHeaders(),
      body: JSON.stringify({
        fieldWorkType: "zone_repair",
        controllerLetter: "A",
      }),
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = (await res.json()) as WorkOrderRow & {
      fieldWorkType?: string;
      controllerLetter?: string;
    };
    assert.equal(body.fieldWorkType, "zone_repair");
    assert.equal(body.controllerLetter, "A");
  });

  it("unassigned tech → 403 with precise message", async () => {
    seedWorkOrder(h.storage, { id: 3, assignedTechnicianId: OTHER_TECH_ID, status: "in_progress" });

    const res = await fetch(`${h.baseUrl}/api/work-orders/3`, {
      method: "PATCH",
      headers: makeTechHeaders(),
      body: JSON.stringify({ workLocationLat: 40.0, workLocationLng: -105.0 }),
    });

    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    const body = (await res.json()) as { message: string };
    assert.equal(
      body.message,
      "You can only update the pin on a work order assigned to you.",
      `Unexpected message: ${body.message}`,
    );
  });

  it("assigned tech on cancelled ticket → 403 with precise message", async () => {
    seedWorkOrder(h.storage, { id: 4, assignedTechnicianId: TECH_ID, status: "cancelled" });

    const res = await fetch(`${h.baseUrl}/api/work-orders/4`, {
      method: "PATCH",
      headers: makeTechHeaders(),
      body: JSON.stringify({ workLocationLat: 40.0, workLocationLng: -105.0 }),
    });

    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    const body = (await res.json()) as { message: string };
    assert.equal(
      body.message,
      "You can only update the pin on a work order assigned to you.",
      `Unexpected message: ${body.message}`,
    );
  });

  it("mixed pin + non-pin fields → 403 with catch-all message", async () => {
    seedWorkOrder(h.storage, { id: 5, assignedTechnicianId: TECH_ID, status: "in_progress" });

    const res = await fetch(`${h.baseUrl}/api/work-orders/5`, {
      method: "PATCH",
      headers: makeTechHeaders(),
      body: JSON.stringify({ workLocationLat: 40.0, status: "completed" }),
    });

    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    const body = (await res.json()) as { message: string };
    assert.equal(
      body.message,
      "Field technicians can only start a work order, update its photos, or move its pin on tickets assigned to them.",
      `Unexpected message: ${body.message}`,
    );
  });

  it("company admin with pin fields → 200 (full-access bypass)", async () => {
    seedWorkOrder(h.storage, { id: 6, assignedTechnicianId: OTHER_TECH_ID, status: "in_progress" });

    const res = await fetch(`${h.baseUrl}/api/work-orders/6`, {
      method: "PATCH",
      headers: makeAdminHeaders(),
      body: JSON.stringify({ workLocationLat: 41.0, workLocationLng: -106.0 }),
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });
});
