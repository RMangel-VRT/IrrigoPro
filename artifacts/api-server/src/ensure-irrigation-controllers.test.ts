// Tests for the ensureIrrigationControllers redirect.
//
// Verifies that:
//  1. ensureIrrigationControllers creates irrigation_controllers rows (not property_controllers).
//  2. Zone placeholder rows (irrigation_profile_zones) are seeded 1..zoneCount from each config.
//  3. A second call for the same tuple is a no-op (idempotent).
//  4. The zone-count trim in updateIrrigationController removes only empty trailing zones.
//  5. Growing zone count seeds new placeholder rows for the added zones.
//
// All tests hit the real dev DB (shared pattern) and clean up after themselves.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";

// Use a stable (companyId, customerId) pair that won't collide with live data.
// companyId 999999 is guaranteed to have no real company in dev.
const TEST_COMPANY_ID = 999999;
const TEST_CUSTOMER_ID = 999998;

async function ensureTestCompanyAndCustomer() {
  await db.execute(sql`
    INSERT INTO companies (id, name, subscription, is_active)
    VALUES (${TEST_COMPANY_ID}, 'Test Company (unit tests)', 'basic', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO customers (id, company_id, name, email)
    VALUES (${TEST_CUSTOMER_ID}, ${TEST_COMPANY_ID}, 'Test Customer (unit tests)', 'test@example.com')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup() {
  await db.execute(sql`
    DELETE FROM irrigation_profile_zones
    WHERE company_id = ${TEST_COMPANY_ID}
  `);
  await db.execute(sql`
    DELETE FROM irrigation_controllers
    WHERE company_id = ${TEST_COMPANY_ID}
  `);
}

async function fullCleanup() {
  await cleanup();
  await db.execute(sql`
    DELETE FROM customers WHERE id = ${TEST_CUSTOMER_ID}
  `);
  await db.execute(sql`
    DELETE FROM companies WHERE id = ${TEST_COMPANY_ID}
  `);
}

describe("ensureIrrigationControllers — basic seeding", () => {
  before(async () => { await ensureTestCompanyAndCustomer(); await cleanup(); });
  after(cleanup);

  it("seeds irrigation_controllers rows honoring passed-in zone counts", async () => {
    const configs = [
      { name: "Controller A", zoneCount: 7 },
      { name: "Controller B", zoneCount: 9 },
    ];
    const rows = await storage.ensureIrrigationControllers(
      TEST_COMPANY_ID,
      TEST_CUSTOMER_ID,
      configs,
      null,
    );

    assert.equal(rows.length, 2);
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(sorted[0].name, "Controller A");
    assert.equal(sorted[0].totalZones, 7, "totalZones should be 7, not a hardcoded default");
    assert.equal(sorted[1].name, "Controller B");
    assert.equal(sorted[1].totalZones, 9, "totalZones should be 9, not a hardcoded default");
    assert.equal(rows[0].companyId, TEST_COMPANY_ID);
    assert.equal(rows[0].customerId, TEST_CUSTOMER_ID);
  });

  it("seeds null totalZones when zoneCount is null (no silent default)", async () => {
    const configs = [{ name: "Controller C", zoneCount: null }];
    const rows = await storage.ensureIrrigationControllers(
      TEST_COMPANY_ID,
      TEST_CUSTOMER_ID,
      configs,
      null,
    );

    const ctrl = rows.find((r) => r.name === "Controller C");
    assert.ok(ctrl, "Controller C should be seeded");
    assert.equal(ctrl!.totalZones, null, "totalZones should be null, not 12");
  });

  it("seeds irrigation_profile_zones placeholder rows matching each zone count", async () => {
    const zoneRows = await db.execute<{ controller_name: string; zone_number: string }>(sql`
      SELECT ic.name AS controller_name, ipz.zone_number
      FROM irrigation_controllers ic
      JOIN irrigation_profile_zones ipz ON ipz.controller_id = ic.id
      WHERE ic.company_id  = ${TEST_COMPANY_ID}
        AND ic.customer_id = ${TEST_CUSTOMER_ID}
      ORDER BY ic.name, ipz.zone_number
    `);

    const byController = new Map<string, number[]>();
    for (const r of zoneRows.rows) {
      const name = String(r.controller_name);
      if (!byController.has(name)) byController.set(name, []);
      byController.get(name)!.push(Number(r.zone_number));
    }

    // Controller A: 7 zones, Controller B: 9 zones, Controller C: 0 zones (null count)
    assert.deepEqual(byController.get("Controller A"), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(byController.get("Controller B"), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(byController.has("Controller C"), false, "no zones for null-count controller");
  });
});

describe("ensureIrrigationControllers — idempotency", () => {
  before(async () => { await ensureTestCompanyAndCustomer(); await cleanup(); });
  after(cleanup);

  it("calling twice for the same tuple creates no duplicate rows", async () => {
    const configs = [
      { name: "Controller A", zoneCount: 5 },
      { name: "Controller B", zoneCount: 8 },
    ];
    await storage.ensureIrrigationControllers(TEST_COMPANY_ID, TEST_CUSTOMER_ID, configs, null);
    await storage.ensureIrrigationControllers(TEST_COMPANY_ID, TEST_CUSTOMER_ID, configs, null);

    const ctrlCount = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*) AS cnt FROM irrigation_controllers
      WHERE company_id = ${TEST_COMPANY_ID} AND customer_id = ${TEST_CUSTOMER_ID}
    `);
    assert.equal(Number(ctrlCount.rows[0]?.cnt), 2, "should still have exactly 2 controllers");
  });

  it("growing config list adds missing entries without duplicating existing ones", async () => {
    await storage.ensureIrrigationControllers(TEST_COMPANY_ID, TEST_CUSTOMER_ID, [
      { name: "Controller A", zoneCount: 5 },
      { name: "Controller B", zoneCount: 8 },
    ], null);
    const rows = await storage.ensureIrrigationControllers(TEST_COMPANY_ID, TEST_CUSTOMER_ID, [
      { name: "Controller A", zoneCount: 5 },
      { name: "Controller B", zoneCount: 8 },
      { name: "Controller C", zoneCount: 10 },
    ], null);

    assert.equal(rows.length, 3);
    const names = rows.map((r) => r.name).sort();
    assert.deepEqual(names, ["Controller A", "Controller B", "Controller C"]);
    const ctrlC = rows.find((r) => r.name === "Controller C");
    assert.equal(ctrlC?.totalZones, 10, "new controller should have passed-in zone count");
  });
});

describe("ensureIrrigationControllers — branch isolation", () => {
  before(async () => { await ensureTestCompanyAndCustomer(); await cleanup(); });
  after(cleanup);

  it("seeds with branchName scoped separately from the null branch", async () => {
    const nullBranch = await storage.ensureIrrigationControllers(
      TEST_COMPANY_ID, TEST_CUSTOMER_ID, [{ name: "Controller A", zoneCount: 6 }], null,
    );
    const namedBranch = await storage.ensureIrrigationControllers(
      TEST_COMPANY_ID, TEST_CUSTOMER_ID, [{ name: "Controller A", zoneCount: 4 }], "East",
    );

    assert.equal(nullBranch.length, 1);
    assert.equal(namedBranch.length, 1);
    assert.equal(nullBranch[0].branchName, "");
    assert.equal(namedBranch[0].branchName, "East");
    assert.notEqual(nullBranch[0].id, namedBranch[0].id, "should be distinct rows");
  });
});

describe("updateIrrigationController — non-destructive zone trim", () => {
  let controllerId: number;

  before(async () => {
    await ensureTestCompanyAndCustomer();
    await cleanup();
    // Create a controller with 5 empty placeholder zones.
    const [ctrl] = await storage.ensureIrrigationControllers(
      TEST_COMPANY_ID, TEST_CUSTOMER_ID, [{ name: "Controller A", zoneCount: 5 }], null,
    );
    controllerId = ctrl!.id;
    // Override totalZones to 5 for our test scenario.
    await db.execute(sql`
      UPDATE irrigation_controllers SET total_zones = 5 WHERE id = ${controllerId}
    `);
    await db.execute(sql`
      DELETE FROM irrigation_profile_zones WHERE controller_id = ${controllerId}
    `);
    // Insert exactly 5 empty placeholder zones.
    for (let z = 1; z <= 5; z++) {
      await db.execute(sql`
        INSERT INTO irrigation_profile_zones
          (company_id, controller_id, zone_number, name, zone_type, run_time_minutes, zone_order, is_active, created_at, updated_at)
        VALUES
          (${TEST_COMPANY_ID}, ${controllerId}, ${z}, ${"Zone " + z}, 'other', 0, ${z}, true, NOW(), NOW())
      `);
    }
  });

  after(cleanup);

  it("shrinking totalZones removes empty trailing zones", async () => {
    await storage.updateIrrigationController(TEST_COMPANY_ID, controllerId, {
      totalZones: 3,
    });

    const remaining = await db.execute<{ zone_number: string }>(sql`
      SELECT zone_number FROM irrigation_profile_zones
      WHERE controller_id = ${controllerId}
      ORDER BY zone_number
    `);
    const nums = remaining.rows.map((r) => Number(r.zone_number));
    assert.deepEqual(nums, [1, 2, 3], "Only zones 1-3 should remain");
  });

  it("shrinking does NOT remove a zone that has non-zero runTimeMinutes", async () => {
    // Reset to 5 zones, make zone 4 have data.
    await db.execute(sql`
      UPDATE irrigation_controllers SET total_zones = 5 WHERE id = ${controllerId}
    `);
    for (let z = 1; z <= 5; z++) {
      await db.execute(sql`
        INSERT INTO irrigation_profile_zones
          (company_id, controller_id, zone_number, name, zone_type, run_time_minutes, zone_order, is_active, created_at, updated_at)
        VALUES
          (${TEST_COMPANY_ID}, ${controllerId}, ${z}, ${"Zone " + z}, 'other', ${z === 4 ? 15 : 0}, ${z}, true, NOW(), NOW())
        ON CONFLICT (company_id, controller_id, zone_number)
        DO UPDATE SET run_time_minutes = EXCLUDED.run_time_minutes
      `);
    }

    await storage.updateIrrigationController(TEST_COMPANY_ID, controllerId, {
      totalZones: 3,
    });

    const remaining = await db.execute<{ zone_number: string }>(sql`
      SELECT zone_number FROM irrigation_profile_zones
      WHERE controller_id = ${controllerId}
      ORDER BY zone_number
    `);
    const nums = remaining.rows.map((r) => Number(r.zone_number));
    // Zone 4 has runTimeMinutes=15 and should be preserved.
    assert.ok(nums.includes(4), "Zone 4 with runTimeMinutes=15 should be preserved");
  });
});

describe("updateIrrigationController — zone count increase seeding", () => {
  let controllerId: number;

  before(async () => {
    await ensureTestCompanyAndCustomer();
    await cleanup();
    const [ctrl] = await storage.ensureIrrigationControllers(
      TEST_COMPANY_ID, TEST_CUSTOMER_ID, [{ name: "Controller A", zoneCount: 3 }], null,
    );
    controllerId = ctrl!.id;
    // Ensure the DB reflects exactly 3 zones and 3 zone rows.
    await db.execute(sql`
      UPDATE irrigation_controllers SET total_zones = 3 WHERE id = ${controllerId}
    `);
    await db.execute(sql`
      DELETE FROM irrigation_profile_zones WHERE controller_id = ${controllerId}
    `);
    for (let z = 1; z <= 3; z++) {
      await db.execute(sql`
        INSERT INTO irrigation_profile_zones
          (company_id, controller_id, zone_number, name, zone_type, run_time_minutes, zone_order, is_active, created_at, updated_at)
        VALUES
          (${TEST_COMPANY_ID}, ${controllerId}, ${z}, ${"Zone " + z}, 'other', 0, ${z}, true, NOW(), NOW())
      `);
    }
  });

  after(fullCleanup);

  it("bumping totalZones from 3 to 5 seeds placeholder rows for zones 4 and 5", async () => {
    await storage.updateIrrigationController(TEST_COMPANY_ID, controllerId, {
      totalZones: 5,
    });

    const rows = await db.execute<{
      zone_number: string;
      name: string;
      zone_type: string;
      run_time_minutes: string;
      zone_order: string;
      is_active: boolean;
    }>(sql`
      SELECT zone_number, name, zone_type, run_time_minutes, zone_order, is_active
      FROM irrigation_profile_zones
      WHERE controller_id = ${controllerId}
      ORDER BY zone_number
    `);

    const nums = rows.rows.map((r) => Number(r.zone_number));
    assert.deepEqual(nums, [1, 2, 3, 4, 5], "All 5 zone rows should exist");

    // Original zones 1-3 are untouched.
    for (const r of rows.rows.filter((r) => Number(r.zone_number) <= 3)) {
      assert.equal(r.zone_type, "other");
      assert.equal(Number(r.run_time_minutes), 0);
    }

    // New zones 4 and 5 have the expected placeholder defaults.
    for (const r of rows.rows.filter((r) => Number(r.zone_number) >= 4)) {
      assert.equal(r.name, `Zone ${r.zone_number}`, "name should match Zone N pattern");
      assert.equal(r.zone_type, "other");
      assert.equal(Number(r.run_time_minutes), 0);
      assert.equal(Number(r.zone_order), Number(r.zone_number));
      assert.equal(r.is_active, true);
    }
  });

  it("calling updateIrrigationController again with the same totalZones is idempotent", async () => {
    // Zone count is already 5 from the previous test; re-applying 5 should not create duplicates.
    await storage.updateIrrigationController(TEST_COMPANY_ID, controllerId, {
      totalZones: 5,
    });

    const count = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*) AS cnt FROM irrigation_profile_zones
      WHERE controller_id = ${controllerId}
    `);
    assert.equal(Number(count.rows[0]?.cnt), 5, "should still have exactly 5 zone rows");
  });
});
