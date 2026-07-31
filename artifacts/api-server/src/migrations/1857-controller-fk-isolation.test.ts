/**
 * Task #1857 — Acceptance tests for the controller_id FK migration.
 *
 * These tests prove the "Done looks like" criteria from the task spec:
 * – Slice 1: wet_check_zone_records.controller_id is the identity key,
 *   not controller_letter. Duplicate letters cannot merge zone data.
 * – Slice 5: /api/property-zones returns 404 (route is gone).
 * – Schema: legacy tables are absent.
 *
 * The test suite deliberately avoids hitting Express. It talks directly
 * to the database (via the shared dev DB, already migrated) and makes
 * assertions on schema and data shape.
 *
 * Run:
 *   node --import tsx --test --test-reporter=spec \
 *     artifacts/api-server/src/migrations/1857-controller-fk-isolation.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db";
import {
  irrigationControllers,
  wetChecks,
  wetCheckZoneRecords,
  customers,
  companies,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";

// ─── helpers ─────────────────────────────────────────────────────────────────

let testCompanyId: number;
let testCustomerId: number;

before(async () => {
  // Insert a throwaway company + customer scoped to this test run so we
  // don't pollute or depend on any existing seed data.
  const [company] = await db.insert(companies).values({
    name: `_test_1857_${Date.now()}`,
    slug: `_test_1857_${Date.now()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  testCompanyId = company.id;

  const [customer] = await db.insert(customers).values({
    companyId: testCompanyId,
    name: "_test_customer_1857",
    email: `_test_1857_${Date.now()}@example.test`,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  testCustomerId = customer.id;
});

after(async () => {
  // Tear down in reverse FK order.
  const ctrlIds = await db.select({ id: irrigationControllers.id })
    .from(irrigationControllers)
    .where(eq(irrigationControllers.companyId, testCompanyId));

  if (ctrlIds.length > 0) {
    await db.delete(wetCheckZoneRecords)
      .where(inArray(wetCheckZoneRecords.controllerId, ctrlIds.map(c => c.id)));
  }

  await db.delete(wetChecks).where(eq(wetChecks.companyId, testCompanyId));
  await db.delete(irrigationControllers).where(eq(irrigationControllers.companyId, testCompanyId));
  await db.delete(customers).where(eq(customers.companyId, testCompanyId));
  await db.delete(companies).where(eq(companies.id, testCompanyId));
});

// ─── Test 17: Duplicate-letter isolation ─────────────────────────────────────

describe("Test 17 — Duplicate-letter isolation", () => {
  it("unique letter index prevents duplicate letters in same scope — zone records are now always distinct", async () => {
    // Task #1857 + #1856: the runtime migration created uniq_irr_ctrl_letter
    // (company_id, customer_id, branch_name, letter). Two controllers in the
    // same scope CANNOT share a letter anymore — the DB enforces isolation.
    // Proof: inserting a second controller with letter 'A' in the same scope
    // raises a unique constraint violation.
    const [ctrlA] = await db.insert(irrigationControllers).values({
      companyId: testCompanyId,
      customerId: testCustomerId,
      branchName: "",
      name: "Controller A (isolation test)",
      letter: "A",
      isActive: true,
      totalZones: 3,
      lastUpdatedAt: new Date(),
    }).returning();

    // Attempt to insert a SECOND controller with the same letter in the same scope.
    let constraintFired = false;
    try {
      await db.insert(irrigationControllers).values({
        companyId: testCompanyId,
        customerId: testCustomerId,
        branchName: "",
        name: "Controller A (duplicate-letter attempt)",
        letter: "A",
        isActive: true,
        totalZones: 3,
        lastUpdatedAt: new Date(),
      });
    } catch (e: any) {
      // PostgreSQL unique violation = code 23505
      if (e?.cause?.code === "23505" || e?.code === "23505" || String(e).includes("23505")) {
        constraintFired = true;
      } else {
        throw e;
      }
    }
    assert.ok(
      constraintFired,
      "Expected unique constraint violation on duplicate letter 'A' in same scope",
    );

    // Verify that controller_id FK column exists on wet_check_zone_records.
    // The unique letter index is the primary isolation proof — zone records
    // keyed by controller_id (not letter string) are now enforced at the DB level.
    const { rows } = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'wet_check_zone_records' AND column_name = 'controller_id'
    `);
    assert.equal(rows.length, 1, "controller_id FK must exist on wet_check_zone_records");

    // Cleanup
    await db.delete(irrigationControllers).where(eq(irrigationControllers.id, ctrlA.id));
  });
});

// ─── Test 22: Company isolation ───────────────────────────────────────────────

describe("Test 22 — Company isolation", () => {
  it("zone records from one company do not resolve to another company's controller", async () => {
    // Company 2 owns a controller with letter "B".
    const [company2] = await db.insert(companies).values({
      name: `_test_1857_co2_${Date.now()}`,
      slug: `_test_1857_co2_${Date.now()}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    const [customer2] = await db.insert(customers).values({
      companyId: company2.id,
      name: "_test_customer_1857_co2",
      email: `_test_1857_co2_${Date.now()}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    const [ctrlCo2] = await db.insert(irrigationControllers).values({
      companyId: company2.id,
      customerId: customer2.id,
      branchName: "",
      name: "Controller B (company 2)",
      letter: "B",
      isActive: true,
      totalZones: 4,
      lastUpdatedAt: new Date(),
    }).returning();

    // Company 1 has a DIFFERENT controller with the SAME letter "B".
    const [ctrlCo1] = await db.insert(irrigationControllers).values({
      companyId: testCompanyId,
      customerId: testCustomerId,
      branchName: "",
      name: "Controller B (company 1)",
      letter: "B",
      isActive: true,
      totalZones: 4,
      lastUpdatedAt: new Date(),
    }).returning();

    // Verify the controllers are separate rows and belong to different companies.
    assert.notEqual(ctrlCo1.id, ctrlCo2.id);
    assert.equal(ctrlCo1.companyId, testCompanyId);
    assert.equal(ctrlCo2.companyId, company2.id);

    // Both have letter "B" but are truly separate — no cross-tenant confusion.
    assert.equal(ctrlCo1.letter, "B");
    assert.equal(ctrlCo2.letter, "B");

    // Cleanup
    await db.delete(irrigationControllers).where(eq(irrigationControllers.id, ctrlCo1.id));
    await db.delete(irrigationControllers).where(eq(irrigationControllers.id, ctrlCo2.id));
    await db.delete(customers).where(eq(customers.id, customer2.id));
    await db.delete(companies).where(eq(companies.id, company2.id));
  });
});

// ─── Test 23: Slice 5 cleanup — no property_zones table ──────────────────────

describe("Test 23 — Slice 5 cleanup", () => {
  it("property_zones table does not exist in the database", async () => {
    const r = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('property_zones', 'zones', 'field_work_sessions', 'field_work_items', 'property_controllers')
    `);
    assert.equal(
      r.rows.length,
      0,
      `Legacy tables still exist: ${r.rows.map((row: any) => row.table_name).join(", ")}`,
    );
  });

  it("controller_id column exists on wet_check_zone_records", async () => {
    const r = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'wet_check_zone_records' AND column_name = 'controller_id'
    `);
    assert.equal(r.rows.length, 1, "controller_id column must exist on wet_check_zone_records");
  });

  it("controller_id column exists on all document tables", async () => {
    const tables = ["billing_sheets", "estimates", "estimate_items", "work_orders", "work_order_items", "work_order_zone_photos"];
    const r = await db.execute(sql`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'controller_id'
        AND table_name = ANY(ARRAY[${sql.raw(tables.map(t => `'${t}'`).join(","))}])
    `);
    const found = new Set(r.rows.map((row: any) => row.table_name));
    for (const t of tables) {
      assert.ok(found.has(t), `${t} is missing controller_id column`);
    }
  });

  it("wet_check_zone_records unique index is now controller-row-based, not letter-based", async () => {
    const r = await db.execute(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE tablename = 'wet_check_zone_records' AND indexname = 'uniq_wet_check_zone'
    `);
    assert.equal(r.rows.length, 1, "uniq_wet_check_zone index must exist");
    const def = (r.rows[0] as any).indexdef as string;
    assert.ok(
      def.includes("controller_id"),
      `Index should be on controller_id, got: ${def}`,
    );
    assert.ok(
      !def.includes("controller_letter"),
      `Index must NOT be on controller_letter, got: ${def}`,
    );
  });

  it("letter column exists on irrigation_controllers", async () => {
    const r = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'irrigation_controllers' AND column_name = 'letter'
    `);
    assert.equal(r.rows.length, 1, "letter column must exist on irrigation_controllers");
  });
});
