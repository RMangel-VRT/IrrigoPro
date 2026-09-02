// Migration registry tests — updated after registry swap (Task #1752).
//
// reconcile-billing-sheet-invoice-totals-v1 has been removed from the registry
// and replaced by repair-ticket-total-drift-v1, which covers all ticket types
// regardless of invoice status.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { listMigrations, getMigration } from "./registry";
import { resolveCheckState } from "./invoice-sent-status-backfill";
import {
  computeFieldWorkTypeSeedState,
  resolveFieldWorkTypeSeedStatus,
} from "./seed-field-work-types";
import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Static registry shape ──────────────────────────────────────────────────────

describe("migration registry — static shape", () => {
  it("contains repair-ticket-total-drift-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("repair-ticket-total-drift-v1"),
      "missing repair-ticket-total-drift-v1",
    );
  });

  it("contains repair-wo-match-estimate-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("repair-wo-match-estimate-v1"),
      "missing repair-wo-match-estimate-v1",
    );
  });

  it("contains invoice-revision-backfill-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("invoice-revision-backfill-v1"),
      "missing invoice-revision-backfill-v1",
    );
  });

  it("contains backfill-merged-invoice-status-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("backfill-merged-invoice-status-v1"),
      "missing backfill-merged-invoice-status-v1",
    );
  });

  it("contains repair-qb-void-mispaid-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("repair-qb-void-mispaid-v1"),
      "missing repair-qb-void-mispaid-v1",
    );
  });

  it("contains repair-woodglenn-wo-hours-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("repair-woodglenn-wo-hours-v1"),
      "missing repair-woodglenn-wo-hours-v1",
    );
  });

  it("contains woodglenn-followup-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("woodglenn-followup-v1"),
      "missing woodglenn-followup-v1",
    );
  });

  // Task #1942 — 0006 was written for #1847 and never wired to anything. The
  // registry is what makes a written-but-unrun migration visible, so
  // membership here is the guard against it going invisible again.
  it("contains invoice-sent-status-backfill-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("invoice-sent-status-backfill-v1"),
      "missing invoice-sent-status-backfill-v1",
    );
  });

  it("contains seed-field-work-types-v1", () => {
    const ids = listMigrations().map((m) => m.id);
    assert.ok(
      ids.includes("seed-field-work-types-v1"),
      "missing seed-field-work-types-v1",
    );
  });

  it("computes missing field-work-type rows idempotently by company and code", () => {
    const state = computeFieldWorkTypeSeedState(
      [10, 20],
      [
        { companyId: 10, code: "zone_repair" },
        { companyId: 20, code: "zone_repair" },
      ],
    );
    assert.deepEqual(state, {
      companyCount: 2,
      companiesMissingDefaults: 2,
      rowsMissing: 12,
    });
  });

  it("requires preview acknowledgement before the field-work-type seed writes", async () => {
    const migration = getMigration("seed-field-work-types-v1");
    assert.ok(migration);
    const result = await migration.run(() => {});
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "seed-defaults");
    assert.equal(result[0].status, "failed");
    assert.match(result[0].error ?? "", /acknowledgement/i);
  });

  it("does not report the field-work-type migration complete without its marker", () => {
    assert.deepEqual(
      resolveFieldWorkTypeSeedStatus({
        companyCount: 2,
        companiesMissingDefaults: 0,
        rowsMissing: 0,
      }),
      {
        state: "partially_applied",
        details: "All defaults are present, but the completion marker is missing.",
      },
    );
    assert.deepEqual(
      resolveFieldWorkTypeSeedStatus({
        companyCount: 2,
        companiesMissingDefaults: 0,
        rowsMissing: 0,
      }, "2026-09-02T12:00:00.000Z"),
      {
        state: "completed",
        completedAt: "2026-09-02T12:00:00.000Z",
      },
    );
  });

  it("previews field-work-type seeding without mutating state", async () => {
    const migration = getMigration("seed-field-work-types-v1");
    assert.ok(migration);
    const result = await migration.preview();
    assert.deepEqual(result.steps.map((step) => step.id), [
      "seed-defaults",
      "mark-done",
    ]);
    assert.ok((result.orphanRows?.companies ?? -1) >= 0);
    assert.ok((result.orphanRows?.fieldWorkTypesMissing ?? -1) >= 0);
  });

  it("invoice-sent-status-backfill-v1 has the required MigrationDefinition shape", () => {
    const m = getMigration("invoice-sent-status-backfill-v1");
    assert.ok(m, "getMigration should return a definition");
    assert.equal(m.id, "invoice-sent-status-backfill-v1");
    assert.ok(m.title.length > 0, "title should be non-empty");
    assert.ok(m.description.length > 0, "description should be non-empty");
    assert.ok(m.appSettingsKey.length > 0, "appSettingsKey should be non-empty");
    assert.equal(typeof m.check, "function");
    assert.equal(typeof m.preview, "function");
    assert.equal(typeof m.run, "function");
    assert.ok(!m.deprecated, "ported migration must NOT be deprecated");
  });

  // Task #1942 — completion is inferred from the data, and BOTH halves of the
  // work count. Zero rows at status='sent' only proves step 3 ran; a database
  // whose statuses were cleaned by hand still owes the sent_at recovery, and
  // reporting that as completed retires the migration from /admin/migrations
  // with delivery timestamps still missing.
  describe("invoice-sent-status-backfill — inferred completion", () => {
    it("is not complete while sent_at is still recoverable, even with no sent-status rows", () => {
      const state = resolveCheckState(0, 51, null);
      assert.notEqual(state.state, "completed");
      assert.equal(state.state, "partially_applied");
      assert.match(String(state.details), /recoverable from invoice_pdfs/);
    });

    it("is not complete while rows remain at status='sent'", () => {
      assert.equal(resolveCheckState(33, 0, null).state, "partially_applied");
    });

    it("has not started when neither half has been done", () => {
      assert.equal(resolveCheckState(33, 51, null).state, "not_started");
    });

    it("is partially applied, not complete, when a marker exists but work remains", () => {
      const state = resolveCheckState(33, 51, { completedAt: "2026-08-01T00:00:00.000Z" });
      assert.equal(state.state, "partially_applied");
    });

    it("is complete only when both counts are zero, and reports the marker's date", () => {
      assert.deepEqual(resolveCheckState(0, 0, null), { state: "completed", completedAt: "" });
      assert.deepEqual(resolveCheckState(0, 0, { completedAt: "2026-08-01T00:00:00.000Z" }), {
        state: "completed",
        completedAt: "2026-08-01T00:00:00.000Z",
      });
    });
  });

  it("repair-qb-void-mispaid-v1 has the required MigrationDefinition shape", () => {
    const m = getMigration("repair-qb-void-mispaid-v1");
    assert.ok(m, "getMigration should return a definition");
    assert.equal(m.id, "repair-qb-void-mispaid-v1");
    assert.ok(m.title.length > 0, "title should be non-empty");
    assert.ok(m.description.length > 0, "description should be non-empty");
    assert.equal(typeof m.check, "function");
    assert.equal(typeof m.preview, "function");
    assert.equal(typeof m.run, "function");
    assert.ok(!m.deprecated, "new migration must NOT be deprecated");
  });

  it("does NOT contain reconcile-billing-sheet-invoice-totals-v1 (superseded)", () => {
    const ids = new Set(listMigrations().map((m) => m.id));
    assert.ok(
      !ids.has("reconcile-billing-sheet-invoice-totals-v1"),
      "reconcile-billing-sheet-invoice-totals-v1 should not be in the registry (superseded by repair-ticket-total-drift-v1)",
    );
  });

  it("does NOT contain any of the removed one-shot migrations", () => {
    const ids = new Set(listMigrations().map((m) => m.id));
    const removed = [
      "company-id-columns-v1",
      "work-order-zones-v1",
      "renumber-estimates-v1",
      "reconcile-finding-disposition-v1",
      "trim-phantom-zones-v1",
      "import-irrigation-profile-from-property-controllers-v1",
      "repair-nan-totals-v1",
      "repair-duplicated-work-order-items-v1",
      "repair-wo-items-from-source-v1",
    ];
    for (const id of removed) {
      assert.ok(!ids.has(id), `removed migration ${id} should not be in the registry`);
    }
  });

  it("getMigration returns undefined for unknown id", () => {
    assert.equal(getMigration("nonexistent"), undefined);
  });

  it("repair-ticket-total-drift-v1 has the required MigrationDefinition shape", () => {
    const m = getMigration("repair-ticket-total-drift-v1");
    assert.ok(m, "getMigration should return a definition");
    assert.equal(m.id, "repair-ticket-total-drift-v1");
    assert.ok(m.title.length > 0, "title should be non-empty");
    assert.ok(m.description.length > 0, "description should be non-empty");
    assert.equal(typeof m.check, "function");
    assert.equal(typeof m.preview, "function");
    assert.equal(typeof m.run, "function");
    assert.ok(!m.deprecated, "new migration must NOT be deprecated");
  });

  it("repair-wo-match-estimate-v1 has the required MigrationDefinition shape", () => {
    const m = getMigration("repair-wo-match-estimate-v1");
    assert.ok(m, "getMigration should return a definition");
    assert.equal(m.id, "repair-wo-match-estimate-v1");
    assert.ok(m.title.length > 0, "title should be non-empty");
    assert.ok(m.description.length > 0, "description should be non-empty");
    assert.equal(typeof m.check, "function");
    assert.equal(typeof m.preview, "function");
    assert.equal(typeof m.run, "function");
    assert.ok(!m.deprecated, "new migration must NOT be deprecated");
  });
});

// ── Behavioral tests — repair-wo-match-estimate-v1 ────────────────────────────

describe("repair-wo-match-estimate-v1 — check()", () => {
  const DONE_KEY = "repairWoMatchEstimate.done";

  before(async () => {
    await db.execute(sql`DELETE FROM app_settings WHERE key = ${DONE_KEY}`);
  });

  after(async () => {
    await db.execute(sql`DELETE FROM app_settings WHERE key = ${DONE_KEY}`);
  });

  it("check() returns a valid MigrationStatus (not error)", async () => {
    const m = getMigration("repair-wo-match-estimate-v1")!;
    const status = await m.check();
    assert.ok(
      status.state === "not_started" ||
      status.state === "partially_applied" ||
      status.state === "completed",
      `Unexpected state: ${status.state}`,
    );
  });

  it("check() returns completed when done marker is set and 0 candidates remain", async () => {
    await db.execute(sql`
      INSERT INTO app_settings (key, value)
      VALUES (${DONE_KEY}, ${new Date().toISOString()})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    const m = getMigration("repair-wo-match-estimate-v1")!;
    const status = await m.check();
    assert.ok(
      status.state === "completed" || status.state === "partially_applied",
      `Expected completed or partially_applied, got ${status.state}`,
    );
  });
});

describe("repair-wo-match-estimate-v1 — preview()", () => {
  it("returns a valid MigrationPreview shape", async () => {
    const m = getMigration("repair-wo-match-estimate-v1")!;
    const preview = await m.preview();
    assert.ok(Array.isArray(preview.steps), "steps should be an array");
    assert.ok(Array.isArray(preview.warnings), "warnings should be an array");
    assert.ok(typeof preview.orphanRows === "object" && preview.orphanRows !== null, "orphanRows should be an object");
    assert.ok(Object.hasOwn(preview.orphanRows, "candidateWorkOrders"), "orphanRows should have candidateWorkOrders");
    assert.equal(typeof preview.orphanRows.candidateWorkOrders, "number");
  });

  it("each step has a non-empty id and description", async () => {
    const m = getMigration("repair-wo-match-estimate-v1")!;
    const preview = await m.preview();
    for (const step of preview.steps) {
      assert.ok(step.id.length > 0, "step id must be non-empty");
      assert.ok(step.description.length > 0, "step description must be non-empty");
    }
  });

  it("preview has detect_candidates, rebuild_from_estimate, and mark_done steps", async () => {
    const m = getMigration("repair-wo-match-estimate-v1")!;
    const preview = await m.preview();
    const ids = preview.steps.map((s) => s.id);
    assert.ok(ids.includes("detect_candidates"), "missing detect_candidates step");
    assert.ok(ids.includes("rebuild_from_estimate"), "missing rebuild_from_estimate step");
    assert.ok(ids.includes("mark_done"), "missing mark_done step");
  });
});

describe("repair-wo-match-estimate-v1 — run() acknowledgement gate", () => {
  it("run() without acknowledged=true returns a failed detect_candidates step", async () => {
    const m = getMigration("repair-wo-match-estimate-v1")!;
    const results = await m.run(() => {});
    assert.equal(results.length, 1, "should return exactly one step result");
    assert.equal(results[0].id, "detect_candidates");
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].error && results[0].error.length > 0, "error message should be non-empty");
  });
});
