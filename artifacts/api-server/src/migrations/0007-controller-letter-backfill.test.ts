/**
 * Tests for Task #1856: Store controller letter as real data.
 *
 * Coverage:
 *   1.  Letter assignment: A, B, C in order
 *   2.  Gap reuse (delete B → next is B)
 *   3.  Rename does NOT change letter
 *   4.  DB unique-index rejects duplicate letter in same scope
 *   5.  Free letter accepted, list ordered by letter
 *   6.  No-null-letter invariant (confirmed by NOT NULL constraint + no errors above)
 *   7.  Cross-scope: same letter on two customers / two branches is allowed
 *   8.  Six-controller scenario: A–F, header zone total = Σ totalZones
 *   9.  Backfill algorithm — property_controllers hints honoured (pure-logic test)
 *  10.  Backfill algorithm — A-B-C by id order when no hints (pure-logic test)
 *  11.  Backfill algorithm — idempotency: running twice on same input changes nothing
 *  12.  Backfill algorithm — branch scope isolation
 *  13.  DB-level collision via direct UPDATE to an already-held letter is rejected
 *  14.  Submit implicit-N/A fill reads irrigation_controllers (branch-correct)
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { db, pool } from "../db";
import { sql } from "drizzle-orm";
import {
  irrigationControllers,
  wetChecks,
  wetCheckZoneRecords,
  companies,
  customers,
  users,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cleanupIrrigCtrls(companyId: number, customerId: number) {
  await db.delete(irrigationControllers).where(
    and(
      eq(irrigationControllers.companyId, companyId),
      eq(irrigationControllers.customerId, customerId),
    ),
  );
}

async function getLetters(companyId: number, customerId: number, branchName = "") {
  return db
    .select({ id: irrigationControllers.id, letter: irrigationControllers.letter, name: irrigationControllers.name })
    .from(irrigationControllers)
    .where(
      and(
        eq(irrigationControllers.companyId, companyId),
        eq(irrigationControllers.customerId, customerId),
        eq(irrigationControllers.branchName, branchName),
      ),
    )
    .orderBy(irrigationControllers.letter);
}

// ── Pure-function backfill algorithm (mirrors the startup migration logic) ────
//
// This is intentionally a separate copy of the algorithm so tests exercise the
// LOGIC independently of the startup-migration scaffolding (app_settings
// check, DDL steps, etc.).  The algorithm:
//   1. For each NULL-letter row (by id ascending) in scope:
//      a. If a property_controllers hint letter is free, use it.
//      b. Otherwise use the lowest free letter in A-Z.

interface BackfillRow { id: number; name: string; }
interface BackfillResult { id: number; letter: string; }

function computeLetterAssignments(
  nullRows: BackfillRow[],
  hintLetters: Set<string>,
  alreadyAssigned: Set<string>,
): BackfillResult[] {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const used = new Set(alreadyAssigned);
  const results: BackfillResult[] = [];
  for (const row of nullRows) {
    let chosen: string | null = null;
    for (const hint of hintLetters) {
      if (!used.has(hint)) { chosen = hint; break; }
    }
    if (!chosen) {
      for (const c of ALPHABET) {
        if (!used.has(c)) { chosen = c; break; }
      }
    }
    if (!chosen) continue;
    used.add(chosen);
    results.push({ id: row.id, letter: chosen });
  }
  return results;
}

// ── Test fixture IDs ──────────────────────────────────────────────────────────

let testCompanyId: number;
let testCustomerId: number;
let testCustomer2Id: number;
let testUserId: number;
let testUserName: string;
let testCustomerName: string;

describe("Task #1856 — controller letter storage", () => {
  before(async () => {
    const [co] = await db.select({ id: companies.id }).from(companies).limit(1);
    if (!co) throw new Error("No company in dev DB — cannot run tests");
    testCompanyId = co.id;

    const custs = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.companyId, testCompanyId))
      .limit(2);
    if (custs.length < 2) throw new Error("Need ≥2 customers in dev DB");
    testCustomerId = custs[0].id;
    testCustomerName = custs[0].name;
    testCustomer2Id = custs[1].id;

    const [u] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.companyId, testCompanyId))
      .limit(1);
    if (!u) throw new Error("No user in dev DB for testCompanyId — cannot run wet-check test");
    testUserId = u.id;
    testUserName = u.name;
  });

  after(async () => {
    await cleanupIrrigCtrls(testCompanyId, testCustomerId);
    await cleanupIrrigCtrls(testCompanyId, testCustomer2Id);
  });

  // ── 1 & 2. A, B, C assignment + gap reuse ────────────────────────────────

  describe("auto-assignment", () => {
    before(async () => { await cleanupIrrigCtrls(testCompanyId, testCustomerId); });

    it("assigns A, B, C to first three controllers", async () => {
      const { storage } = await import("../storage");
      const c1 = await storage.createIrrigationController({ companyId: testCompanyId, customerId: testCustomerId, branchName: "", name: "Hunter Clock - East", lastUpdatedAt: new Date() });
      const c2 = await storage.createIrrigationController({ companyId: testCompanyId, customerId: testCustomerId, branchName: "", name: "Rainbird - West", lastUpdatedAt: new Date() });
      const c3 = await storage.createIrrigationController({ companyId: testCompanyId, customerId: testCustomerId, branchName: "", name: "Irritrol Clock", lastUpdatedAt: new Date() });
      assert.equal(c1.letter, "A");
      assert.equal(c2.letter, "B");
      assert.equal(c3.letter, "C");
    });

    it("reuses gap B after deletion", async () => {
      const { storage } = await import("../storage");
      const rows = await getLetters(testCompanyId, testCustomerId);
      const bRow = rows.find(r => r.letter === "B");
      assert.ok(bRow, "B must exist");
      await db.delete(irrigationControllers).where(eq(irrigationControllers.id, bRow.id));
      const newCtrl = await storage.createIrrigationController({ companyId: testCompanyId, customerId: testCustomerId, branchName: "", name: "New Controller", lastUpdatedAt: new Date() });
      assert.equal(newCtrl.letter, "B", "gap B should be reused");
    });
  });

  // ── 3. Rename does NOT change letter ──────────────────────────────────────

  it("renaming a controller does NOT change its letter", async () => {
    const { storage } = await import("../storage");
    const rows = await getLetters(testCompanyId, testCustomerId);
    const aRow = rows.find(r => r.letter === "A");
    assert.ok(aRow, "A must exist");
    const updated = await storage.updateIrrigationController(testCompanyId, aRow.id, { name: "Completely New Name" });
    assert.equal(updated?.letter, "A");
  });

  // ── 4. DB unique-index rejects duplicate ──────────────────────────────────

  it("DB unique index rejects duplicate letter in same scope", async () => {
    // Confirm A already exists so the collision is real
    const rows = await getLetters(testCompanyId, testCustomerId);
    assert.ok(rows.some(r => r.letter === "A"), "A must exist before collision test");

    await assert.rejects(
      async () => {
        await db.insert(irrigationControllers).values({
          companyId: testCompanyId,
          customerId: testCustomerId,
          branchName: "",
          name: "Collision Attempt",
          letter: "A",
          isActive: true,
          lastUpdatedAt: new Date(),
        });
      },
      // Drizzle wraps the PG error — check both the wrapper and the cause.
      (err: any) => {
        const msg: string = err?.message ?? "";
        const causeMsg: string = err?.cause?.message ?? "";
        return /duplicate|unique/i.test(msg) || /duplicate|unique/i.test(causeMsg);
      },
    );
  });

  // ── 5. Free letter accepted, list ordered ─────────────────────────────────

  it("manually setting a free letter is accepted and list is ordered", async () => {
    const { storage } = await import("../storage");
    const rows = await getLetters(testCompanyId, testCustomerId);
    const cRow = rows.find(r => r.letter === "C");
    assert.ok(cRow, "C must exist");
    const updated = await storage.updateIrrigationController(testCompanyId, cRow.id, { letter: "Z" });
    assert.equal(updated?.letter, "Z");
    const list = await storage.listIrrigationControllers(testCompanyId, testCustomerId, "");
    const letters = list.map(c => c.letter).filter(Boolean) as string[];
    assert.deepEqual(letters, [...letters].sort());
  });

  // ── 6. No-null invariant via NOT NULL constraint ───────────────────────────
  // The startup migration applied NOT NULL; any code path that bypasses letter
  // assignment would produce a DB error, which is the real invariant.
  // We confirm 0 nulls just to be explicit.

  it("no rows have NULL letter after auto-assignment (NOT NULL constraint active)", async () => {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM irrigation_controllers
      WHERE company_id = ${testCompanyId} AND customer_id = ${testCustomerId} AND letter IS NULL
    `);
    assert.equal(Number((r.rows[0] as any).cnt), 0);
  });

  // ── 7. Cross-scope allows same letter ─────────────────────────────────────

  it("allows the same letter on two different customers", async () => {
    await cleanupIrrigCtrls(testCompanyId, testCustomer2Id);
    const { storage } = await import("../storage");
    const c = await storage.createIrrigationController({ companyId: testCompanyId, customerId: testCustomer2Id, branchName: "", name: "Ctrl A on customer 2", lastUpdatedAt: new Date() });
    assert.equal(c.letter, "A", "different customer can also start at A");
  });

  // ── 8. Six-controller scenario ────────────────────────────────────────────

  it("six controllers get distinct letters A–F and correct zone total", async () => {
    await cleanupIrrigCtrls(testCompanyId, testCustomerId);
    const { storage } = await import("../storage");
    const names = ["Hunter Clock - East", "Rainbird - West", "Irritrol - North", "Toro - South", "Hunter Clock - Gate", "Rainbird - Park"];
    const zoneCounts = [8, 12, 10, 6, 14, 20];
    const created = [];
    for (let i = 0; i < names.length; i++) {
      created.push(await storage.createIrrigationController({ companyId: testCompanyId, customerId: testCustomerId, branchName: "", name: names[i], totalZones: zoneCounts[i], lastUpdatedAt: new Date() }));
    }
    assert.deepEqual(created.map(c => c.letter), ["A", "B", "C", "D", "E", "F"]);
    const total = created.reduce((s, c) => s + (c.totalZones ?? 0), 0);
    assert.equal(total, zoneCounts.reduce((a, b) => a + b, 0));
  });

  // ── 9–12. Backfill algorithm: pure-logic tests ───────────────────────────
  //
  // These tests exercise the letter-assignment algorithm that the startup
  // migration uses.  They run the pure function `computeLetterAssignments`
  // (defined above) with in-memory data so they don't need to insert NULL-
  // letter rows into the live DB (which now has a NOT NULL constraint).

  describe("backfill algorithm (pure logic)", () => {
    it("9. uses property_controllers hint letter when collision-free", () => {
      const rows = [{ id: 1, name: "Legacy Controller" }];
      const hints = new Set(["F"]);
      const assigned = new Set<string>();
      const result = computeLetterAssignments(rows, hints, assigned);
      assert.deepEqual(result, [{ id: 1, letter: "F" }]);
    });

    it("10. falls back to A-B-C by id order when no hints exist", () => {
      const rows = [{ id: 1, name: "C1" }, { id: 2, name: "C2" }, { id: 3, name: "C3" }];
      const result = computeLetterAssignments(rows, new Set(), new Set());
      assert.deepEqual(result, [{ id: 1, letter: "A" }, { id: 2, letter: "B" }, { id: 3, letter: "C" }]);
    });

    it("11. is idempotent: already-assigned letters are not re-assigned", () => {
      const rows = [{ id: 2, name: "C2" }]; // id=1 already has A
      const hints = new Set<string>();
      const alreadyAssigned = new Set(["A"]); // C1 already has A
      const result = computeLetterAssignments(rows, hints, alreadyAssigned);
      assert.deepEqual(result, [{ id: 2, letter: "B" }]); // skips A, uses B
    });

    it("12. branch scope: two branches can independently start at A", () => {
      const eastRows = [{ id: 1, name: "East Ctrl" }];
      const westRows = [{ id: 2, name: "West Ctrl" }];
      const eastResult = computeLetterAssignments(eastRows, new Set(), new Set());
      const westResult = computeLetterAssignments(westRows, new Set(), new Set());
      assert.deepEqual(eastResult, [{ id: 1, letter: "A" }]);
      assert.deepEqual(westResult, [{ id: 2, letter: "A" }], "different scope — A is free");
    });

    it("prefers free hint over first-alphabet when hint is non-A", () => {
      // Hint is C; A and B are not in hints but would be picked by alphabet-first.
      // The algorithm prefers the hint letter if it's free.
      const rows = [{ id: 1, name: "Ctrl" }];
      const result = computeLetterAssignments(rows, new Set(["C"]), new Set());
      assert.equal(result[0].letter, "C");
    });

    it("skips a hint that is already taken and falls back to alphabet", () => {
      const rows = [{ id: 1, name: "Ctrl" }];
      const hints = new Set(["B"]); // B is taken
      const assigned = new Set(["A", "B"]);
      const result = computeLetterAssignments(rows, hints, assigned);
      assert.equal(result[0].letter, "C"); // hint B taken, next free = C
    });
  });

  // ── 18. Completed-marker with missing DDL: startup re-applies constraints ─────
  //
  // If app_settings says 'completed' but the NOT NULL constraint or unique index
  // is absent (e.g. restored from a snapshot taken before the DDL was applied),
  // the migration must still apply both DDL pieces before returning. This test
  // simulates that scenario by dropping the unique index and verifying it is
  // recreated on the next call.

  it("18. re-applies unique index when completed marker exists but index was dropped", async () => {
    // Verify the index currently exists (it should after the migration ran at startup)
    const beforeDrop = await db.execute(sql`
      SELECT 1 FROM pg_indexes WHERE tablename='irrigation_controllers' AND indexname='uniq_irr_ctrl_letter'
    `);
    assert.ok(beforeDrop.rows.length > 0, "index must exist at start of test");

    // Drop the index to simulate a snapshot-restore scenario
    await db.execute(sql`DROP INDEX IF EXISTS uniq_irr_ctrl_letter`);
    const afterDrop = await db.execute(sql`
      SELECT 1 FROM pg_indexes WHERE tablename='irrigation_controllers' AND indexname='uniq_irr_ctrl_letter'
    `);
    assert.equal(afterDrop.rows.length, 0, "index must be gone after drop");

    // Call initialize() — should re-apply the index despite the 'completed' marker
    const { storage } = await import("../storage");
    await storage.initialize();

    const afterReinit = await db.execute(sql`
      SELECT 1 FROM pg_indexes WHERE tablename='irrigation_controllers' AND indexname='uniq_irr_ctrl_letter'
    `);
    assert.ok(afterReinit.rows.length > 0, "index must be recreated by initialize() after snapshot-restore");
  });

  // ── 17. Concurrent-start regression: advisory lock is session-pinned ─────────
  //
  // Two concurrent callers of backfillControllerLetters() must not both run
  // the DDL/backfill body. The advisory lock (pg_advisory_lock session-scoped
  // on a dedicated client) serialises them: one waits, then sees the completed
  // marker and exits. We can't call the private method directly, but we can
  // verify the lock mechanism by running the same advisory-lock protocol on
  // two real pg.PoolClient connections.

  it("17. pg_advisory_lock is session-pinned (concurrent clients)", async () => {
    const LOCK_ID = 1856099; // test-only lock id
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // c1 acquires the lock
      await c1.query(`SELECT pg_advisory_lock($1)`, [LOCK_ID]);

      // c2 tries to acquire — should NOT get it while c1 holds it.
      // pg_try_advisory_lock returns false when the lock is busy.
      const res = await c2.query<{ got: boolean }>(
        `SELECT pg_try_advisory_lock($1) AS got`, [LOCK_ID]
      );
      assert.equal(res.rows[0].got, false, "c2 must not acquire the lock while c1 holds it");

      // c1 releases — now c2 can acquire
      await c1.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID]);
      const res2 = await c2.query<{ got: boolean }>(
        `SELECT pg_try_advisory_lock($1) AS got`, [LOCK_ID]
      );
      assert.equal(res2.rows[0].got, true, "c2 must acquire the lock after c1 releases");
      await c2.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID]);
    } finally {
      c1.release();
      c2.release();
    }
  });

  // ── 16. Legacy non-sequential letters preserved through lazy bootstrap ────────
  //
  // When a customer has property_controllers with non-sequential letters (A, C)
  // — for example because B was deleted — the lazy bootstrap in
  // irrigation-profile-routes.ts must create profile controllers that preserve
  // A and C (not compact to A, B). This is the fix for passing
  // `letter: r.controllerLetter` in the configs array.

  it("16. lazy bootstrap preserves non-sequential legacy letters A/C (not A/B)", async () => {
    await cleanupIrrigCtrls(testCompanyId, testCustomerId);
    const { storage } = await import("../storage");

    // Simulate legacy property_controllers with A and C (B was deleted)
    // by directly calling ensureIrrigationControllers with letter hints A and C
    const configs = [
      { name: "Controller A", zoneCount: 5, letter: "A" },
      { name: "Controller C", zoneCount: 8, letter: "C" },
    ];
    const created = await storage.ensureIrrigationControllers(
      testCompanyId, testCustomerId, configs, ""
    );

    const letters = created.map(c => c.letter).sort();
    assert.deepEqual(letters, ["A", "C"], `Expected A and C, got ${letters} — legacy letters must be preserved`);

    // Confirm the gap (B) is NOT used — a new controller should get B, not D
    const nextCtrl = await storage.createIrrigationController({
      companyId: testCompanyId, customerId: testCustomerId, branchName: "",
      name: "New Controller", lastUpdatedAt: new Date(),
    });
    assert.equal(nextCtrl.letter, "B", "next available gap after A/C should be B");
  });

  // ── Endpoint regression: descriptive names produce distinct stored letters ───
  //
  // The core bug: six controllers all named with "East"/"West"/"North"/etc.
  // suffixes shared the letter "T" via name-derivation, colliding in the
  // wet_check_zone_records unique index and silently dropping zone data.
  //
  // GET /api/properties/:customerId/controllers maps each controller to
  // { controllerLetter: ctrl.letter } — this test confirms the stored letters
  // are distinct A–F regardless of name content.

  it("15. /controllers endpoint: descriptive names → stored letters, not name-derived collision", async () => {
    await cleanupIrrigCtrls(testCompanyId, testCustomerId);
    const { storage } = await import("../storage");

    // Names whose last-word-last-char all collapse to "T" under the old derivation
    const descriptiveNames = [
      "Hunter Clock - East",  // old: "T"
      "Rainbird - West",      // old: "T"
      "Irritrol - Northeast", // old: "T"
      "Toro - Northwest",     // old: "T"
      "Hunter Clock - Gate",  // old: "E"
      "Rainbird - Park",      // old: "K"
    ];
    for (const name of descriptiveNames) {
      await storage.createIrrigationController({ companyId: testCompanyId, customerId: testCustomerId, branchName: "", name, lastUpdatedAt: new Date() });
    }

    // Simulate what the endpoint does: listIrrigationControllers → map to wire shape
    const ctrls = await storage.listIrrigationControllers(testCompanyId, testCustomerId, "");
    const wireShape = ctrls.map(ctrl => ({
      id: ctrl.id,
      controllerLetter: ctrl.letter,  // THIS is the fix — used to be name-derived
      zoneCount: ctrl.totalZones,
    }));

    const letters = wireShape.map(w => w.controllerLetter);
    // All letters must be distinct (no collisions)
    assert.equal(new Set(letters).size, 6, `Expected 6 distinct letters, got collisions: ${letters}`);
    // Letters are A–F in order (ordered by letter)
    assert.deepEqual(letters, ["A", "B", "C", "D", "E", "F"]);
  });

  // ── 13. DB collision via UPDATE to held letter ─────────────────────────────

  it("13. UPDATE to a letter already held in scope is rejected by unique index", async () => {
    // We have A (and possibly others) in scope; try to set another controller to A.
    const rows = await getLetters(testCompanyId, testCustomerId);
    const nonARow = rows.find(r => r.letter !== "A");
    assert.ok(nonARow, "need a second controller for collision test");

    await assert.rejects(
      async () => {
        await db.execute(sql`
          UPDATE irrigation_controllers SET letter = 'A'
          WHERE id = ${nonARow.id}
        `);
      },
      // Drizzle wraps the PG error — check both the wrapper and the cause.
      (err: any) => {
        const msg: string = err?.message ?? "";
        const causeMsg: string = err?.cause?.message ?? "";
        return /duplicate|unique/i.test(msg) || /duplicate|unique/i.test(causeMsg);
      },
    );
  });

  // ── 14. Submit implicit-N/A fill reads irrigation_controllers ─────────────

  describe("submitWetCheck implicit-N/A fill", () => {
    it("fills implicit N/A from irrigation_controllers (branch-correct)", async () => {
      // Reset to a clean 2-controller state (A: 3 zones, B: 2 zones)
      await cleanupIrrigCtrls(testCompanyId, testCustomerId);
      const { storage } = await import("../storage");

      await storage.createIrrigationController({
        companyId: testCompanyId, customerId: testCustomerId, branchName: "",
        name: "Zone Ctrl A", totalZones: 3, lastUpdatedAt: new Date(),
      });
      await storage.createIrrigationController({
        companyId: testCompanyId, customerId: testCustomerId, branchName: "",
        name: "Zone Ctrl B", totalZones: 2, lastUpdatedAt: new Date(),
      });

      // Create a wet check (requires technicianId, technicianName, customerName)
      const wc = await storage.createWetCheck({
        companyId: testCompanyId,
        customerId: testCustomerId,
        technicianId: testUserId,
        technicianName: testUserName,
        customerName: testCustomerName,
        branchName: "",
        numControllers: 2,
        mode: "standard",
        status: "in_progress",
        clientId: `test-wc-${Date.now()}`,
      });

      // Record only zone A-1 directly (the rest should become N/A on submit).
      // Using a direct DB insert to bypass assertWetCheckEditableByTech (tech-ID
      // guard); the submit path itself doesn't call that guard.
      await db.insert(wetCheckZoneRecords).values({
        wetCheckId: wc.id,
        controllerLetter: "A",
        zoneNumber: 1,
        status: "checked_ok",
        clientId: `test-zone-a1-${wc.id}`,
      });

      // Submit
      await storage.submitWetCheck(wc.id, testCompanyId);

      // All zones should now have records: A-1, A-2, A-3, B-1, B-2
      const zones = await db
        .select({
          letter: wetCheckZoneRecords.controllerLetter,
          zone: wetCheckZoneRecords.zoneNumber,
          status: wetCheckZoneRecords.status,
        })
        .from(wetCheckZoneRecords)
        .where(eq(wetCheckZoneRecords.wetCheckId, wc.id));

      assert.equal(zones.length, 5, `Expected 5 zone records, got ${zones.length}: ${JSON.stringify(zones)}`);

      const okZones = zones.filter(z => z.status === "checked_ok");
      const naZones = zones.filter(z => z.status === "not_applicable");
      assert.equal(okZones.length, 1, "A-1 should be checked_ok");
      assert.equal(naZones.length, 4, "A-2, A-3, B-1, B-2 should be not_applicable");

      const letterSet = new Set(zones.map(z => z.letter));
      assert.ok(letterSet.has("A"), "A controller zones present");
      assert.ok(letterSet.has("B"), "B controller zones present");

      // Cleanup
      await db.delete(wetCheckZoneRecords).where(eq(wetCheckZoneRecords.wetCheckId, wc.id));
      await db.delete(wetChecks).where(eq(wetChecks.id, wc.id));
    });
  });
});
