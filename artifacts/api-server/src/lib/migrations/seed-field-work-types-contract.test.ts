// Task #1982 — the step reporting contract for the field work type seed.
//
// The incident: the migrations dialog showed "Last run: succeeded" beside a
// preview reporting 14 missing default field work types. These tests pin the
// half of the fix that lives in the migration itself:
//
//   * a run whose insert throws reports failed, writes NO completion marker,
//     and leaves check() at not_started (marker + inserts share one
//     transaction, so a rollback takes both);
//   * a successful run's rowsAffected matches the rows actually present
//     afterwards, and check() flips to completed;
//   * a run that *claims* inserts it did not make is caught by the migration's
//     own post-commit re-read instead of reporting success;
//   * a re-run on a fully seeded company inserts zero rows and mutates no
//     existing label or requirement flag (proved against the real database in
//     a rolled-back transaction).
//
// The first four use injected deps — no database — so "the insert throws" is
// deterministic rather than staged.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import {
  runSeedFieldWorkTypes,
  computeFieldWorkTypeSeedState,
  resolveFieldWorkTypeSeedStatus,
  type SeedFieldWorkTypesRunDeps,
} from "./seed-field-work-types";
import { FIELD_WORK_TYPE_SEEDS, seedFieldWorkTypesForCompany } from "../../seeds/field-work-types";
import { db } from "../../db";
import { companies, fieldWorkTypes } from "@workspace/db/schema";

// ── A tiny in-memory database with real transaction semantics ────────────────
//
// `rows` is the committed set of "companyId:code" pairs; a transaction stages
// a copy and only publishes it when the body resolves. That is the property
// under test: a throw must leave both the inserts and the marker behind.

type FakeStore = { rows: Set<string>; marker?: string };

function makeFakeDeps(opts: {
  companyIds: number[];
  existing?: string[];
  /** Throw while seeding this company (simulates an insert failure). */
  throwOnCompany?: number;
  /** Report inserts without actually writing them (simulates a lying step). */
  lieAboutInserts?: boolean;
}): { deps: SeedFieldWorkTypesRunDeps; committed: FakeStore; emitted: any[] } {
  const committed: FakeStore = { rows: new Set(opts.existing ?? []), marker: undefined };
  const emitted: any[] = [];

  const deps: SeedFieldWorkTypesRunDeps = {
    async withTransaction(body) {
      const staged: FakeStore = { rows: new Set(committed.rows), marker: committed.marker };
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
      for (const seed of FIELD_WORK_TYPE_SEEDS) {
        const key = `${companyId}:${seed.code}`;
        if (tx.rows.has(key)) continue;
        if (!opts.lieAboutInserts) tx.rows.add(key);
        inserted++;
      }
      return inserted;
    },
    async writeMarker(tx: FakeStore, completedAt: string) {
      tx.marker = completedAt;
    },
    async loadStateAfterCommit() {
      return computeFieldWorkTypeSeedState(
        opts.companyIds,
        [...committed.rows].map((key) => {
          const [companyId, code] = key.split(":");
          return { companyId: Number(companyId), code };
        }),
      );
    },
  };

  return { deps, committed, emitted };
}

function statusFor(committed: FakeStore, companyIds: number[]) {
  const state = computeFieldWorkTypeSeedState(
    companyIds,
    [...committed.rows].map((key) => {
      const [companyId, code] = key.split(":");
      return { companyId: Number(companyId), code };
    }),
  );
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

describe("seed-field-work-types — a step cannot report inserts it did not make", () => {
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
});

describe("seed-field-work-types — re-run on a fully seeded set is a zero-row no-op", () => {
  it("inserts nothing, still reports success, and stays completed", async () => {
    const companyIds = [1, 2];
    const existing = companyIds.flatMap((id) =>
      FIELD_WORK_TYPE_SEEDS.map((seed) => `${id}:${seed.code}`),
    );
    const { deps, committed, emitted } = makeFakeDeps({ companyIds, existing });

    const results = await runSeedFieldWorkTypes((e) => emitted.push(e), ACK, deps);

    const seedStep = results.find((r) => r.id === "seed-defaults")!;
    assert.equal(seedStep.status, "success");
    assert.equal(seedStep.rowsAffected, 0, "a fully seeded set must insert zero rows");
    assert.equal(committed.rows.size, existing.length);
    assert.equal(statusFor(committed, companyIds).state, "completed");
  });
});

// ── Idempotency against the real database ─────────────────────────────────────
//
// The "no existing label or requirement flag is changed" claim is about
// `onConflictDoNothing` semantics in Postgres, so a fake cannot prove it. This
// runs against the real database inside a transaction that is always rolled
// back, so it leaves the shared dev database exactly as it found it.

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

describe("seed-field-work-types — re-seeding never overwrites a tenant customization", () => {
  it("inserts zero rows and leaves customized labels and requirement flags untouched", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [company] = await tx
        .insert(companies)
        .values({ name: `#1982 seed idempotency probe ${Date.now()}` })
        .returning({ id: companies.id });

      const firstPass = await seedFieldWorkTypesForCompany(company.id, tx);
      assert.equal(firstPass, FIELD_WORK_TYPE_SEEDS.length, "first seed inserts every default");

      // A tenant renames one type and flips a requirement flag.
      const customized = FIELD_WORK_TYPE_SEEDS[0];
      await tx
        .update(fieldWorkTypes)
        .set({ label: "Zone Repair (Crew A only)", requiresZone: false })
        .where(and(
          eq(fieldWorkTypes.companyId, company.id),
          eq(fieldWorkTypes.code, customized.code),
        ));

      const secondPass = await seedFieldWorkTypesForCompany(company.id, tx);
      assert.equal(secondPass, 0, "re-running on a fully seeded company inserts nothing");

      const rows = await tx
        .select({
          code: fieldWorkTypes.code,
          label: fieldWorkTypes.label,
          requiresZone: fieldWorkTypes.requiresZone,
          requiresController: fieldWorkTypes.requiresController,
          requiresDetails: fieldWorkTypes.requiresDetails,
        })
        .from(fieldWorkTypes)
        .where(eq(fieldWorkTypes.companyId, company.id));

      assert.equal(rows.length, FIELD_WORK_TYPE_SEEDS.length, "no duplicate rows were created");

      const byCode = Object.fromEntries(rows.map((r: any) => [r.code, r]));
      assert.equal(byCode[customized.code].label, "Zone Repair (Crew A only)");
      assert.equal(byCode[customized.code].requiresZone, false);

      // Every untouched default still matches its seed definition.
      for (const seed of FIELD_WORK_TYPE_SEEDS.slice(1)) {
        assert.equal(byCode[seed.code].label, seed.label);
        assert.equal(byCode[seed.code].requiresZone, seed.requiresZone);
        assert.equal(byCode[seed.code].requiresController, seed.requiresController);
        assert.equal(byCode[seed.code].requiresDetails, seed.requiresDetails);
      }
    });
  });
});
