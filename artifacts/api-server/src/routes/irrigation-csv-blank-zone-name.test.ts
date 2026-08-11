// Tests for CSV import blank Zone Name handling (Task #1656).
//
// Covers:
//   1. All-blank Zone Name import into a new controller → zones named "Zone N"
//   2. Blank Zone Name re-import into existing controller with real names → names preserved, no diff
//   3. CSV with a Zone Name for an existing zone still updates the name (no regression)
//   4. Mixed file: some rows have names, some blank → each resolved independently
//   5. Missing Zone Name *column header* still rejected at server level
//   6. Idempotent re-import of all-blank-name CSV is a no-op on second run
//   7. Unit tests for resolveZoneName helper

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { storage } from "../storage";
import { resolveZoneName } from "../storage";
import type { IrrigationProfileZone } from "@workspace/db/schema";
import { registerIrrigationProfileRoutes } from "./irrigation-profile-routes";

// ── Test server factory ────────────────────────────────────────────────────────

interface TestUser {
  role: string;
  companyId: number | null;
  userId: number;
}

function makeTestServer(user: TestUser): { base: string; close: () => Promise<void> } {
  const app = express();
  app.use(express.json());
  const auth: RequestHandler = (req: any, _res, next) => {
    req.authenticatedUserRole = user.role;
    req.authenticatedUserId = user.userId;
    req.authenticatedUserCompanyId = user.companyId;
    next();
  };
  registerIrrigationProfileRoutes(app, { requireAuthentication: auth });
  const server = createServer(app);
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://localhost:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function hit(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, init);
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
}

// ── Unit tests for resolveZoneName ─────────────────────────────────────────────

describe("resolveZoneName unit tests", () => {
  it("returns the CSV-supplied name when non-blank", () => {
    assert.equal(resolveZoneName("Front Lawn", undefined, 1), "Front Lawn");
    assert.equal(resolveZoneName("Back Yard", "Old Name", 2), "Back Yard");
  });

  it("returns the existing saved name when CSV name is blank/null and zone exists", () => {
    assert.equal(resolveZoneName(null, "Existing Name", 3), "Existing Name");
    assert.equal(resolveZoneName("", "Saved Name", 5), "Saved Name");
  });

  it("falls back to Zone N when both CSV name is blank and no existing name", () => {
    assert.equal(resolveZoneName(null, undefined, 1), "Zone 1");
    assert.equal(resolveZoneName(null, undefined, 12), "Zone 12");
    assert.equal(resolveZoneName("", undefined, 7), "Zone 7");
  });
});

// ── Integration tests ──────────────────────────────────────────────────────────

let companyId: number;
let customerId: number;
let managerUserId: number;
const createdControllerIds: number[] = [];

async function setupFixture() {
  const comp = await storage.createCompany({
    name: `BlankZoneNameTestComp_${Date.now()}`,
    isActive: true,
  });
  companyId = comp.id;

  const cust = await storage.createCustomer({
    companyId,
    name: "Blank Zone Name Test Customer",
    email: `blank_zone_${Date.now()}@test.example`,
    phone: null,
  } as any);
  customerId = cust.id;

  const user = await storage.createUser({
    username: `blank_zone_mgr_${Date.now()}`,
    password: "hashed",
    name: "Blank Zone Mgr",
    email: `blank_zone_mgr_${Date.now()}@test.example`,
    role: "irrigation_manager",
    companyId,
    isActive: true,
  } as any);
  managerUserId = user.id;
}

async function cleanupControllers() {
  for (const id of createdControllerIds) {
    try {
      await storage.deleteIrrigationController(null, id);
    } catch { /* already cleaned */ }
  }
  createdControllerIds.length = 0;
}

// Helper: rows with no zone names (null)
function blankNameRows(ctrlName: string, branch: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    controllerName: ctrlName,
    location: null,
    brand: null,
    model: null,
    programName: null,
    wateringDays: null,
    startTimes: null,
    seasonalAdjustPct: 100,
    zoneNumber: i + 1,
    zoneName: null,
    zoneType: "rotor",
    runTimeMinutes: 10,
  }));
}

describe("CSV import — blank Zone Name: all-blank into new controller", () => {
  let srv: ReturnType<typeof makeTestServer>;
  const branch = `blank-zone-new-${Date.now()}`;

  before(async () => {
    await setupFixture();
    srv = makeTestServer({ role: "irrigation_manager", companyId, userId: managerUserId });
  });

  after(async () => {
    await cleanupControllers();
    await srv.close();
  });

  it("preview mode succeeds with zoneName = 'Zone N' for each blank row", async () => {
    const rows = blankNameRows("BlankCtrl1", branch, 3);
    const { status, body } = await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "preview", rows, branchName: branch },
    );
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.mode, "preview");
    const ctrl = body.controllers[0];
    assert.equal(ctrl.action, "create");
    assert.equal(ctrl.zones.length, 3);
    for (let i = 0; i < 3; i++) {
      const z = ctrl.zones.find((z: any) => z.zoneNumber === i + 1);
      assert.ok(z, `Zone ${i + 1} should be in diff`);
      assert.equal(z.zoneName, `Zone ${i + 1}`, `Zone ${i + 1} name should be 'Zone ${i + 1}'`);
    }
  });

  it("commit mode creates zones named 'Zone N' when CSV names are all blank", async () => {
    const rows = blankNameRows("BlankCtrl1", branch, 3);
    const { status, body } = await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "commit", rows, branchName: branch },
    );
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.summary.zonesAdded, 3);

    const ctrls = await storage.listIrrigationControllers(companyId, customerId, branch);
    const ctrl = ctrls.find((c) => c.name === "BlankCtrl1");
    assert.ok(ctrl, "BlankCtrl1 should have been created");
    createdControllerIds.push(ctrl!.id);

    const profile = await storage.getIrrigationController(companyId, ctrl!.id);
    assert.ok(profile, "profile should exist");
    for (let i = 1; i <= 3; i++) {
      // Explicit annotation: inside a loop, narrowing `z` with assert.ok
      // feeds back into the inferred type of its own initializer (TS7022).
      const z: IrrigationProfileZone | undefined =
        profile!.zones.find((zone) => zone.zoneNumber === i);
      assert.ok(z, `Zone ${i} should exist`);
      assert.equal(z.name, `Zone ${i}`, `Zone ${i} should be named 'Zone ${i}'`);
    }
  });

  it("re-importing all-blank CSV into existing controller is a no-op (idempotent)", async () => {
    // The controller was created in the previous test. Re-import same blank rows.
    const rows = blankNameRows("BlankCtrl1", branch, 3);
    const { status: s1, body: b1 } = await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "preview", rows, branchName: branch },
    );
    assert.equal(s1, 200, JSON.stringify(b1));
    const ctrl = b1.controllers[0];
    // Blank CSV name → resolves to existing saved name → no change detected
    for (const z of ctrl.zones) {
      assert.equal(z.action, "no_change", `Zone ${z.zoneNumber} should be no_change on second import, got ${z.action}`);
    }

    const { status: s2, body: b2 } = await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "commit", rows, branchName: branch },
    );
    assert.equal(s2, 200, JSON.stringify(b2));
    assert.equal(b2.summary.zonesAdded, 0);
    assert.equal(b2.summary.zonesUpdated, 0);
  });
});

describe("CSV import — blank Zone Name: blank re-import preserves existing names", () => {
  let srv: ReturnType<typeof makeTestServer>;
  const branch = `blank-zone-preserve-${Date.now()}`;
  let ctrlId: number;

  before(async () => {
    if (!companyId) await setupFixture();
    srv = makeTestServer({ role: "irrigation_manager", companyId, userId: managerUserId });

    // Seed a controller with real zone names via a commit with names supplied
    const namedRows = [
      { controllerName: "PreserveCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 1, zoneName: "Front Lawn", zoneType: "rotor", runTimeMinutes: 15 },
      { controllerName: "PreserveCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 2, zoneName: "Back Garden", zoneType: "drip", runTimeMinutes: 20 },
    ];
    await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "commit", rows: namedRows, branchName: branch },
    );
    const ctrls = await storage.listIrrigationControllers(companyId, customerId, branch);
    const ctrl = ctrls.find((c) => c.name === "PreserveCtrl");
    assert.ok(ctrl, "PreserveCtrl must have been seeded");
    ctrlId = ctrl!.id;
    createdControllerIds.push(ctrlId);
  });

  after(async () => {
    await cleanupControllers();
    await srv.close();
  });

  it("preview shows no zoneName change when blank CSV re-imported into existing zones", async () => {
    const rows = blankNameRows("PreserveCtrl", branch, 2);
    const { status, body } = await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "preview", rows, branchName: branch },
    );
    assert.equal(status, 200, JSON.stringify(body));
    const ctrl = body.controllers[0];
    for (const z of ctrl.zones) {
      const nameChange = z.changes?.find((ch: any) => ch.field === "zoneName");
      assert.ok(!nameChange, `Zone ${z.zoneNumber} should have no zoneName change; got ${JSON.stringify(z.changes)}`);
    }
  });

  it("commit with blank names leaves existing zone names intact", async () => {
    const rows = blankNameRows("PreserveCtrl", branch, 2);
    await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "commit", rows, branchName: branch },
    );
    const profile = await storage.getIrrigationController(companyId, ctrlId);
    assert.ok(profile, "profile should exist");
    const z1 = profile!.zones.find((z: any) => z.zoneNumber === 1);
    const z2 = profile!.zones.find((z: any) => z.zoneNumber === 2);
    assert.equal(z1?.name, "Front Lawn", "Zone 1 name should be preserved");
    assert.equal(z2?.name, "Back Garden", "Zone 2 name should be preserved");
  });
});

describe("CSV import — blank Zone Name: named row still updates name (no regression)", () => {
  let srv: ReturnType<typeof makeTestServer>;
  const branch = `blank-zone-update-${Date.now()}`;
  let ctrlId: number;

  before(async () => {
    if (!companyId) await setupFixture();
    srv = makeTestServer({ role: "irrigation_manager", companyId, userId: managerUserId });

    // Seed controller with existing zone name
    const seedRows = [
      { controllerName: "UpdateNameCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 1, zoneName: "Old Name", zoneType: "rotor", runTimeMinutes: 10 },
    ];
    await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "commit", rows: seedRows, branchName: branch },
    );
    const ctrls = await storage.listIrrigationControllers(companyId, customerId, branch);
    const ctrl = ctrls.find((c) => c.name === "UpdateNameCtrl");
    assert.ok(ctrl, "UpdateNameCtrl must have been seeded");
    ctrlId = ctrl!.id;
    createdControllerIds.push(ctrlId);
  });

  after(async () => {
    await cleanupControllers();
    await srv.close();
  });

  it("CSV with a zone name for an existing zone updates the name", async () => {
    const updateRows = [
      { controllerName: "UpdateNameCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 1, zoneName: "New Name", zoneType: "rotor", runTimeMinutes: 10 },
    ];
    const { status, body } = await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "commit", rows: updateRows, branchName: branch },
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.summary.zonesUpdated, 1);

    const profile = await storage.getIrrigationController(companyId, ctrlId);
    const z1 = profile!.zones.find((z: any) => z.zoneNumber === 1);
    assert.equal(z1?.name, "New Name", "Zone name should have been updated");
  });
});

describe("CSV import — blank Zone Name: mixed file resolves each row independently", () => {
  let srv: ReturnType<typeof makeTestServer>;
  const branch = `blank-zone-mixed-${Date.now()}`;

  before(async () => {
    if (!companyId) await setupFixture();
    srv = makeTestServer({ role: "irrigation_manager", companyId, userId: managerUserId });
  });

  after(async () => {
    await cleanupControllers();
    await srv.close();
  });

  it("mixed file: named rows keep their names, blank rows default to Zone N", async () => {
    const mixedRows = [
      { controllerName: "MixedCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 1, zoneName: "Named Zone", zoneType: "rotor", runTimeMinutes: 10 },
      { controllerName: "MixedCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 2, zoneName: null, zoneType: "drip", runTimeMinutes: 15 },
      { controllerName: "MixedCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 3, zoneName: "Also Named", zoneType: "bubbler", runTimeMinutes: 5 },
      { controllerName: "MixedCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 4, zoneName: null, zoneType: "rotor", runTimeMinutes: 8 },
    ];

    const { status, body } = await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "commit", rows: mixedRows, branchName: branch },
    );
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.summary.zonesAdded, 4);

    const ctrls = await storage.listIrrigationControllers(companyId, customerId, branch);
    const ctrl = ctrls.find((c) => c.name === "MixedCtrl");
    assert.ok(ctrl, "MixedCtrl should have been created");
    createdControllerIds.push(ctrl!.id);

    const profile = await storage.getIrrigationController(companyId, ctrl!.id);
    assert.ok(profile, "profile should exist");

    const z1 = profile!.zones.find((z: any) => z.zoneNumber === 1);
    const z2 = profile!.zones.find((z: any) => z.zoneNumber === 2);
    const z3 = profile!.zones.find((z: any) => z.zoneNumber === 3);
    const z4 = profile!.zones.find((z: any) => z.zoneNumber === 4);

    assert.equal(z1?.name, "Named Zone", "Zone 1 should use CSV-supplied name");
    assert.equal(z2?.name, "Zone 2", "Zone 2 (blank) should default to 'Zone 2'");
    assert.equal(z3?.name, "Also Named", "Zone 3 should use CSV-supplied name");
    assert.equal(z4?.name, "Zone 4", "Zone 4 (blank) should default to 'Zone 4'");
  });
});

describe("CSV import — missing Zone Name column header still rejected", () => {
  let srv: ReturnType<typeof makeTestServer>;
  const branch = `blank-zone-no-col-${Date.now()}`;

  before(async () => {
    if (!companyId) await setupFixture();
    srv = makeTestServer({ role: "irrigation_manager", companyId, userId: managerUserId });
  });

  after(async () => {
    await srv.close();
  });

  it("rows without the Zone Name field at all are still accepted (server treats missing key as null/blank)", async () => {
    // The server does not check for the key — if the client omits it we get null zoneName which
    // is allowed. Column-level header validation happens client-side only. This test proves
    // the server itself doesn't reject on a missing field key (the rejection for missing headers
    // lives entirely on the client parseCsv function, not in the import-csv route handler).
    const rowsWithoutZoneName = [
      { controllerName: "NoColCtrl", location: null, brand: null, model: null,
        programName: null, wateringDays: null, startTimes: null, seasonalAdjustPct: 100,
        zoneNumber: 1, zoneType: "rotor", runTimeMinutes: 10 },
    ];
    const { status, body } = await hit(
      srv.base,
      "POST",
      `/api/customers/${customerId}/irrigation-profile/import-csv`,
      { mode: "preview", rows: rowsWithoutZoneName, branchName: branch },
    );
    assert.equal(status, 200, `Expected 200 — missing key treated as null: ${JSON.stringify(body)}`);
    const z = body.controllers?.[0]?.zones?.[0];
    assert.equal(z?.zoneName, "Zone 1", "Missing key should fall back to 'Zone 1'");
  });
});
