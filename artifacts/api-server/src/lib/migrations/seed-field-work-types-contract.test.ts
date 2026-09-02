// The step reporting contract for the field work type seed, and the reconcile
// contract that replaced its idempotency guarantee.
//
// The reporting half (unchanged): the migrations dialog once showed
// "Last run: succeeded" beside a preview reporting 14 missing default field
// work types. These tests pin the half of that fix living in the migration:
//
//   * a run whose insert throws reports failed, writes NO completion marker,
//     and leaves check() at not_started (marker + writes share one
//     transaction, so a rollback takes both);
//   * a successful run's rowsAffected matches the rows actually present
//     afterwards, and check() flips to completed;
//   * a run that *claims* writes it did not make is caught by the migration's
//     own post-commit re-read instead of reporting success.
//
// The reconcile half (deliberate reversal): work types are presets owned by
// `seeds/field-work-types.ts`. The seed used to insert with a
// conflict-do-nothing, so it could only ever ADD a row a company was missing
// and never correct one that already existed — the rename from "Controller
// Repair" to "Controller/Clock Repair" could not reach either seeded company,
// and with the manage capability narrowed to super admin nothing in the app
// could correct it either. The earlier version of this file proved the
// opposite contract: it renamed a type, flipped a requirement flag, re-ran,
// and asserted the customization survived. That guarantee was written to make
// the seed safe to re-run; it is exactly what protected drift from ever being
// corrected, so it has been reversed on purpose. Labels, requirement flags and
// sort order are now reconciled to the source file on every run.
//
// Retirement is the one thing still preserved, and that is not an oversight:
// `active` is the tenant's decision, and writing it would silently un-retire
// every work type anyone had ever turned off.
//
// The fake-deps tests use no database, so "the insert throws" is deterministic
// rather than staged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import {
  runSeedFieldWorkTypes,
  computeFieldWorkTypeSeedState,
  resolveFieldWorkTypeSeedStatus,
  buildFieldWorkTypeSeedWarnings,
  type SeedFieldWorkTypesRunDeps,
  type FieldWorkTypeStateRow,
} from "./seed-field-work-types";
import {
  FIELD_WORK_TYPE_SEEDS,
  FIELD_WORK_TYPE_RECONCILED_COLUMNS,
  seedFieldWorkTypesForCompany,
  type FieldWorkTypeSeed,
} from "../../seeds/field-work-types";
import { db } from "../../db";
import { companies, fieldWorkTypes } from "@workspace/db/schema";

// ── A tiny in-memory database with real transaction semantics ────────────────
//
// `rows` is the committed set of rows keyed "companyId:code"; a transaction
// stages a copy and only publishes it when the body resolves. That is the
// property under test: a throw must leave neither the writes nor the marker.

type FakeStore = { rows: Map<string, FieldWorkTypeStateRow>; marker?: string };

function rowFor(companyId: number, seed: FieldWorkTypeSeed): FieldWorkTypeStateRow {
  return {
    companyId,
    code: seed.code,
    label: seed.label,
    requiresController: seed.requiresController,
    requiresZone: seed.requiresZone,
    requiresDetails: seed.requiresDetails,
    sortOrder: seed.sortOrder,
  };
}

function seededRows(companyIds: number[]): FieldWorkTypeStateRow[] {
  return companyIds.flatMap((id) => FIELD_WORK_TYPE_SEEDS.map((seed) => rowFor(id, seed)));
}

function keyOf(row: { companyId: number; code: string }): string {
  return `${row.companyId}:${row.code}`;
}

function makeFakeDeps(opts: {
  companyIds: number[];
  existing?: FieldWorkTypeStateRow[];
  /** Throw while seeding this company (simulates a write failure). */
  throwOnCompany?: number;
  /** Report inserts without actually writing them (simulates a lying step). */
  lieAboutInserts?: boolean;
  /** Report reconciling updates without actually writing them. */
  lieAboutUpdates?: boolean;
}): { deps: SeedFieldWorkTypesRunDeps; committed: FakeStore; emitted: any[] } {
  const committed: FakeStore = {
    rows: new Map((opts.existing ?? []).map((row) => [keyOf(row), row])),
    marker: undefined,
  };
  const emitted: any[] = [];

  const deps: SeedFieldWorkTypesRunDeps = {
    async withTransaction(body) {
      const staged: FakeStore = { rows: new Map(committed.rows), marker: committed.marker };
      const result = await body(staged);
      // Commit only on success — a throw propagates and publishes nothing.
      committed.rows = staged.rows;
      committed.marker = staged.marker;
      return result;
    },
    async listCompanyIds() {
      return opts.companyIds;
    },
    async seedCompany(tx: FakeStore, companyId: number) {
      if (opts.throwOnCompany === companyId) {
        throw new Error(`insert into field_work_types failed for company ${companyId}`);
      }
      let inserted = 0;
      let updated = 0;
      for (const seed of FIELD_WORK_TYPE_SEEDS) {
        const key = `${companyId}:${seed.code}`;
        const row = tx.rows.get(key);
        if (!row) {
          if (!opts.lieAboutInserts) tx.rows.set(key, rowFor(companyId, seed));
          inserted++;
          continue;
        }
        const drifted = FIELD_WORK_TYPE_RECONCILED_COLUMNS.some(
          (column) => row[column] !== seed[column],
        );
        if (!drifted) continue;
        if (!opts.lieAboutUpdates) tx.rows.set(key, rowFor(companyId, seed));
        updated++;
      }
      return { inserted, updated };
    },
    async writeMarker(tx: FakeStore, completedAt: string) {
      tx.marker = completedAt;
    },
    async loadStateAfterCommit() {
      return computeFieldWorkTypeSeedState(opts.companyIds, [...committed.rows.values()]);
    },
  };

  return { deps, committed, emitted };
}

function statusFor(committed: FakeStore, companyIds: number[]) {
  const state = computeFieldWorkTypeSeedState(companyIds, [...committed.rows.values()]);
  return resolveFieldWorkTypeSeedStatus(state, committed.marker);
}

const ACK = { acknowledged: true };

describe("seed-field-work-types — a failed insert commits nothing and reports nothing", () => {
  it("reports failed, writes no completion marker, and leaves the status at not_started", async () => {
    const companyIds = [1, 2];
    const { deps, committed, emitted } = makeFakeDeps({ companyIds, throwOnCompany: 2 });

    const results = await runSeedFieldWorkTypes(
      (e) => emitted.push(e),
      ACK,
      deps,
    );

    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId["seed-defaults"].status, "failed");
    assert.match(byId["seed-defaults"].error ?? "", /company 2/);
    assert.equal(
      byId["mark-done"].status,
      "failed",
      "the marker step must not report success when its transaction rolled back",
    );

    assert.equal(committed.marker, undefined, "no completion marker may survive the rollback");
    assert.equal(committed.rows.size, 0, "company 1's inserts must roll back with company 2's failure");

    assert.deepEqual(statusFor(committed, companyIds), { state: "not_started" });

    // Nothing was emitted as a success either — the live step list a client
    // watches must not flash green for writes that were undone.
    assert.equal(
      emitted.some((e) => e.status === "success"),
      false,
    );
  });
});

describe("seed-field-work-types — a successful run reports what is actually there", () => {
  it("rowsAffected matches the rows present afterwards and the status flips to completed", async () => {
    const companyIds = [1, 2];
    const { deps, committed, emitted } = makeFakeDeps({ companyIds });

    const results = await runSeedFieldWorkTypes((e) => emitted.push(e), ACK, deps);

    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId["seed-defaults"].status, "success");
    assert.equal(byId["mark-done"].status, "success");

    const expected = companyIds.length * FIELD_WORK_TYPE_SEEDS.length;
    assert.equal(byId["seed-defaults"].rowsAffected, expected);
    assert.equal(
      committed.rows.size,
      expected,
      "rowsAffected must equal the rows genuinely present after the commit",
    );

    const status = statusFor(committed, companyIds);
    assert.equal(status.state, "completed");
  });
});

describe("seed-field-work-types — a step cannot report writes it did not make", () => {
  it("post-commit verification turns a claimed-but-absent insert into a failure", async () => {
    const companyIds = [1, 2];
    // The seed step reports 7 inserts per company but writes none — the exact
    // shape of the incident: a success report with the rows still missing.
    const { deps, committed, emitted } = makeFakeDeps({ companyIds, lieAboutInserts: true });

    const results = await runSeedFieldWorkTypes((e) => emitted.push(e), ACK, deps);

    const seedStep = results.find((r) => r.id === "seed-defaults")!;
    assert.equal(seedStep.status, "failed", "a claimed insert that is not there is not a success");
    assert.match(seedStep.error ?? "", /still missing after the run/);
    assert.equal(
      seedStep.rowsAffected,
      0,
      "rows-affected must reflect rows present afterwards, not statements attempted",
    );
    assert.equal(committed.rows.size, 0);
  });

  it("post-commit verification turns a claimed-but-absent reconcile into a failure too", async () => {
    const companyIds = [1];
    // Every row is present, so nothing is inserted; one has drifted, and the
    // step claims to have corrected it without writing anything.
    const existing = seededRows(companyIds).map((row) =>
      row.code === "controller_repair" ? { ...row, label: "Controller Repair" } : row,
    );
    const { deps, emitted } = makeFakeDeps({ companyIds, existing, lieAboutUpdates: true });

    const results = await runSeedFieldWorkTypes((e) => emitted.push(e), ACK, deps);

    const seedStep = results.find((r) => r.id === "seed-defaults")!;
    assert.equal(seedStep.status, "failed", "a correction that did not land is not a success");
    assert.match(seedStep.error ?? "", /still differ from the source file/);
  });
});

describe("seed-field-work-types — re-run on a fully reconciled set is a zero-row no-op", () => {
  it("writes nothing, still reports success, and stays completed", async () => {
    const companyIds = [1, 2];
    const existing = seededRows(companyIds);
    const { deps, committed, emitted } = makeFakeDeps({ companyIds, existing });

    const results = await runSeedFieldWorkTypes((e) => emitted.push(e), ACK, deps);

    const seedStep = results.find((r) => r.id === "seed-defaults")!;
    assert.equal(seedStep.status, "success");
    assert.equal(
      seedStep.rowsAffected,
      0,
      "a set that already matches the source file inserts and updates nothing",
    );
    assert.equal(committed.rows.size, existing.length);
    assert.equal(statusFor(committed, companyIds).state, "completed");
  });

  it("a drifted-but-complete set is partially applied before the run and completed after", async () => {
    const companyIds = [1, 2];
    const existing = seededRows(companyIds).map((row) =>
      row.code === "controller_repair" ? { ...row, label: "Controller Repair" } : row,
    );
    const { deps, committed, emitted } = makeFakeDeps({ companyIds, existing });

    const before = resolveFieldWorkTypeSeedStatus(
      computeFieldWorkTypeSeedState(companyIds, existing),
      "2026-09-01T00:00:00.000Z",
    );
    assert.equal(
      before.state,
      "partially_applied",
      "no row is missing, but two disagree with the source file — there is still work to do",
    );
    assert.match(String((before as any).details), /differ from the source file/);

    const results = await runSeedFieldWorkTypes((e) => emitted.push(e), ACK, deps);
    const seedStep = results.find((r) => r.id === "seed-defaults")!;
    assert.equal(seedStep.status, "success");
    assert.equal(seedStep.rowsAffected, 2, "one drifted row per company was corrected");
    assert.equal(statusFor(committed, companyIds).state, "completed");
  });
});

// ── The preview names what it is about to change ─────────────────────────────

describe("seed-field-work-types — the preview separates inserts from updates", () => {
  it("names each drifted row and the columns that will change", () => {
    const companyIds = [7];
    const rows = seededRows(companyIds)
      .filter((row) => row.code !== "other")
      .map((row) =>
        row.code === "controller_repair"
          ? { ...row, label: "Controller Repair", requiresZone: true }
          : row,
      );

    const state = computeFieldWorkTypeSeedState(companyIds, rows);
    assert.equal(state.rowsMissing, 1);
    assert.equal(state.rowsDrifted, 1);

    const warnings = buildFieldWorkTypeSeedWarnings(state);
    const joined = warnings.join("\n");
    assert.match(joined, /1 row\(s\) will be INSERTED/);
    assert.match(joined, /1 existing row\(s\) will be UPDATED/);
    assert.match(joined, /controller_repair \(Controller Repair\)/);
    assert.match(joined, /label "Controller Repair" → "Controller\/Clock Repair"/);
    assert.match(
      joined,
      /requiresZone true → false/,
      "a requirement-flag change must be named, not buried in a count",
    );
    assert.match(joined, /Retirement is never written/);
  });

  it("promises nothing when the database already matches the source file", () => {
    const state = computeFieldWorkTypeSeedState([7], seededRows([7]));
    const joined = buildFieldWorkTypeSeedWarnings(state).join("\n");
    assert.match(joined, /Nothing will be inserted or updated/);
    assert.doesNotMatch(joined, /will be UPDATED/);
  });

  it("never claims existing rows are left alone", () => {
    for (const state of [
      computeFieldWorkTypeSeedState([7], []),
      computeFieldWorkTypeSeedState([7], seededRows([7])),
    ]) {
      const joined = buildFieldWorkTypeSeedWarnings(state).join("\n");
      assert.doesNotMatch(joined, /will not be changed/i);
      assert.doesNotMatch(joined, /without overwriting/i);
    }
  });
});

// ── Reconciliation against the real database ─────────────────────────────────
//
// The reconcile is about real UPDATE semantics against the unique
// (company_id, code) index, so a fake cannot prove it. This runs against the
// real database inside a transaction that is always rolled back, so it leaves
// the shared dev database exactly as it found it.

const ROLLBACK = Symbol("rollback");

async function inRolledBackTransaction(body: (tx: any) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

async function makeSeededCompany(tx: any): Promise<number> {
  const [company] = await tx
    .insert(companies)
    .values({ name: `field work type reconcile probe ${process.pid}-${Date.now()}` })
    .returning({ id: companies.id });
  const first = await seedFieldWorkTypesForCompany(company.id, tx);
  assert.deepEqual(
    first,
    { inserted: FIELD_WORK_TYPE_SEEDS.length, updated: 0 },
    "first seed inserts every default and corrects nothing",
  );
  return company.id;
}

async function rowsFor(tx: any, companyId: number) {
  const rows = await tx
    .select({
      code: fieldWorkTypes.code,
      label: fieldWorkTypes.label,
      requiresZone: fieldWorkTypes.requiresZone,
      requiresController: fieldWorkTypes.requiresController,
      requiresDetails: fieldWorkTypes.requiresDetails,
      sortOrder: fieldWorkTypes.sortOrder,
      active: fieldWorkTypes.active,
    })
    .from(fieldWorkTypes)
    .where(eq(fieldWorkTypes.companyId, companyId));
  return Object.fromEntries(rows.map((row: any) => [row.code, row])) as Record<string, any>;
}

describe("seed-field-work-types — re-seeding corrects a drifted preset", () => {
  // This replaces the test that proved the opposite. See the reversal note at
  // the top of this file: presets are owned by the source file, so a re-run
  // must be able to correct a row that no longer matches it.
  it("brings a renamed label and a flipped requirement flag back to the source file", async () => {
    await inRolledBackTransaction(async (tx) => {
      const companyId = await makeSeededCompany(tx);

      // The shape of the real incident: a company seeded before the rename
      // still reads "Controller Repair", plus a stale requirement flag.
      await tx
        .update(fieldWorkTypes)
        .set({ label: "Controller Repair", requiresZone: true, sortOrder: 999 })
        .where(and(
          eq(fieldWorkTypes.companyId, companyId),
          eq(fieldWorkTypes.code, "controller_repair"),
        ));

      const second = await seedFieldWorkTypesForCompany(companyId, tx);
      assert.deepEqual(
        second,
        { inserted: 0, updated: 1 },
        "the drifted row is reported as an update, not an insert",
      );

      const byCode = await rowsFor(tx, companyId);
      assert.equal(Object.keys(byCode).length, FIELD_WORK_TYPE_SEEDS.length, "no duplicate rows");
      assert.equal(byCode.controller_repair.label, "Controller/Clock Repair");
      assert.equal(byCode.controller_repair.requiresZone, false);
      assert.equal(byCode.controller_repair.sortOrder, 40);

      // Every other row still matches its seed definition.
      for (const seed of FIELD_WORK_TYPE_SEEDS) {
        assert.equal(byCode[seed.code].label, seed.label);
        assert.equal(byCode[seed.code].requiresZone, seed.requiresZone);
        assert.equal(byCode[seed.code].requiresController, seed.requiresController);
        assert.equal(byCode[seed.code].requiresDetails, seed.requiresDetails);
      }
    });
  });

  it("names the drifted row in the pre-run state before it is corrected", async () => {
    await inRolledBackTransaction(async (tx) => {
      const companyId = await makeSeededCompany(tx);
      await tx
        .update(fieldWorkTypes)
        .set({ label: "Controller Repair" })
        .where(and(
          eq(fieldWorkTypes.companyId, companyId),
          eq(fieldWorkTypes.code, "controller_repair"),
        ));

      const rows = await tx
        .select({
          companyId: fieldWorkTypes.companyId,
          code: fieldWorkTypes.code,
          label: fieldWorkTypes.label,
          requiresController: fieldWorkTypes.requiresController,
          requiresZone: fieldWorkTypes.requiresZone,
          requiresDetails: fieldWorkTypes.requiresDetails,
          sortOrder: fieldWorkTypes.sortOrder,
        })
        .from(fieldWorkTypes)
        .where(eq(fieldWorkTypes.companyId, companyId));

      const state = computeFieldWorkTypeSeedState([companyId], rows);
      assert.equal(state.rowsMissing, 0);
      assert.equal(state.rowsDrifted, 1);
      assert.equal(
        resolveFieldWorkTypeSeedStatus(state, "2026-09-01T00:00:00.000Z").state,
        "partially_applied",
        "a drifted company still owes this migration a run",
      );

      const joined = buildFieldWorkTypeSeedWarnings(state).join("\n");
      assert.match(joined, /controller_repair/);
      assert.match(joined, /"Controller Repair" → "Controller\/Clock Repair"/);
    });
  });

  it("reports zero and zero once the company is fully reconciled", async () => {
    await inRolledBackTransaction(async (tx) => {
      const companyId = await makeSeededCompany(tx);
      assert.deepEqual(
        await seedFieldWorkTypesForCompany(companyId, tx),
        { inserted: 0, updated: 0 },
        "a reconciled company must write nothing on a re-run",
      );
    });
  });

  it("inserts a preset the company is missing while correcting one that drifted", async () => {
    await inRolledBackTransaction(async (tx) => {
      const companyId = await makeSeededCompany(tx);
      await tx
        .delete(fieldWorkTypes)
        .where(and(
          eq(fieldWorkTypes.companyId, companyId),
          eq(fieldWorkTypes.code, "other"),
        ));
      await tx
        .update(fieldWorkTypes)
        .set({ requiresDetails: true })
        .where(and(
          eq(fieldWorkTypes.companyId, companyId),
          eq(fieldWorkTypes.code, "backflow"),
        ));

      assert.deepEqual(
        await seedFieldWorkTypesForCompany(companyId, tx),
        { inserted: 1, updated: 1 },
        "insertions and corrections are counted separately",
      );

      const byCode = await rowsFor(tx, companyId);
      assert.equal(byCode.other.label, "Other");
      assert.equal(byCode.backflow.requiresDetails, false, "the flag change reached the company");
    });
  });
});

describe("seed-field-work-types — a retired row stays retired", () => {
  it("reconciles a retired row's label and flags without ever writing active", async () => {
    await inRolledBackTransaction(async (tx) => {
      const companyId = await makeSeededCompany(tx);

      // A tenant retires a type and, separately, its row has drifted.
      await tx
        .update(fieldWorkTypes)
        .set({ active: false, label: "Old Backflow", requiresController: true, sortOrder: 3 })
        .where(and(
          eq(fieldWorkTypes.companyId, companyId),
          eq(fieldWorkTypes.code, "backflow"),
        ));

      assert.deepEqual(
        await seedFieldWorkTypesForCompany(companyId, tx),
        { inserted: 0, updated: 1 },
      );

      const byCode = await rowsFor(tx, companyId);
      assert.equal(
        byCode.backflow.active,
        false,
        "one re-run must never un-retire a type someone turned off",
      );
      assert.equal(byCode.backflow.label, "Backflow");
      assert.equal(byCode.backflow.requiresController, false);
      assert.equal(byCode.backflow.sortOrder, 50);

      // And a second pass still leaves it retired and now writes nothing.
      assert.deepEqual(
        await seedFieldWorkTypesForCompany(companyId, tx),
        { inserted: 0, updated: 0 },
      );
      assert.equal((await rowsFor(tx, companyId)).backflow.active, false);
    });
  });

  it("a retired row that already matches the source file is not counted as drift", async () => {
    await inRolledBackTransaction(async (tx) => {
      const companyId = await makeSeededCompany(tx);
      await tx
        .update(fieldWorkTypes)
        .set({ active: false })
        .where(and(
          eq(fieldWorkTypes.companyId, companyId),
          eq(fieldWorkTypes.code, "backflow"),
        ));

      assert.deepEqual(
        await seedFieldWorkTypesForCompany(companyId, tx),
        { inserted: 0, updated: 0 },
        "retirement is not drift — it is the tenant's decision, not the file's",
      );
      assert.equal((await rowsFor(tx, companyId)).backflow.active, false);
    });
  });
});
