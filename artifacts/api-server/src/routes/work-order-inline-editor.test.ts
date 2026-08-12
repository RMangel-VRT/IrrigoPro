// Work order inline editor route contract tests.
//
// Tests that:
//   (a) GET /api/work-orders/:id embeds items (calls getWorkOrderItems) so the
//       LineItemsEditor and TotalHoursEditor in the command center inline pane
//       receive the data they need.
//   (b) PATCH /api/work-orders/:id/labor-hours calls storage.updateWorkOrderLaborHours.
//   (c) PATCH /api/work-orders/:id/items calls storage.replaceWorkOrderItemsWithResync.
//   (d) Both PATCH endpoints guard field_tech callers (403).
//   (e) Both PATCH endpoints surface WO_LOCKED → 409.
//   (f) Both PATCH endpoints validate the request body with Zod (400/422 on bad input).
//
// Routes live inline in routes.ts (monolith); we verify expected contracts via
// source-code scanning — same approach as rate-mode-routes.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROUTES_SRC = readFileSync(
  path.join(import.meta.dirname ?? __dirname, "routes.ts"),
  "utf8",
);

// ── helpers ───────────────────────────────────────────────────────────────────

function regionAround(anchor: string, chars = 1500): string {
  const idx = ROUTES_SRC.indexOf(anchor);
  if (idx === -1) return "";
  return ROUTES_SRC.slice(Math.max(0, idx - 200), idx + chars);
}

// ── GET /api/work-orders/:id — items embed ────────────────────────────────────

describe("Work-order inline editor — GET items embed", () => {
  it("GET /api/work-orders/:id is registered", () => {
    assert.ok(
      ROUTES_SRC.includes('app.get("/api/work-orders/:id"'),
      "GET /api/work-orders/:id not found in routes.ts",
    );
  });

  it("GET handler calls getWorkOrderItems to embed items", () => {
    assert.ok(
      ROUTES_SRC.includes("getWorkOrderItems"),
      "routes.ts must call storage.getWorkOrderItems inside the GET /api/work-orders/:id handler",
    );
  });

  it("GET handler maps partPrice to unitPrice for the InlineItem shape", () => {
    assert.ok(
      ROUTES_SRC.includes("unitPrice: item.partPrice"),
      "GET handler must remap partPrice → unitPrice so the frontend InlineItem shape is satisfied",
    );
  });

  it("GET handler includes items in the response JSON", () => {
    assert.ok(
      ROUTES_SRC.includes("items: woItems"),
      "GET /api/work-orders/:id must include items in the response object",
    );
  });
});

// ── PATCH /api/work-orders/:id/labor-hours ────────────────────────────────────

describe("Work-order inline editor — PATCH labor-hours", () => {
  it("PATCH /api/work-orders/:id/labor-hours is registered", () => {
    assert.ok(
      ROUTES_SRC.includes('app.patch("/api/work-orders/:id/labor-hours"'),
      "PATCH /api/work-orders/:id/labor-hours not found in routes.ts",
    );
  });

  it("labor-hours handler calls storage.updateWorkOrderLaborHours", () => {
    assert.ok(
      ROUTES_SRC.includes("updateWorkOrderLaborHours"),
      "routes.ts must call storage.updateWorkOrderLaborHours",
    );
  });

  it("labor-hours handler forbids field_tech (403 guard present)", () => {
    const ctx = regionAround('app.patch("/api/work-orders/:id/labor-hours"');
    assert.ok(
      ctx.includes("field_tech") || (ctx.includes("403") && ctx.includes("Forbidden")),
      "PATCH /api/work-orders/:id/labor-hours must return 403 for field_tech callers",
    );
  });

  it("labor-hours handler maps WO_LOCKED to 409", () => {
    const ctx = regionAround("updateWorkOrderLaborHours");
    assert.ok(
      ctx.includes('"WO_LOCKED"') && (ctx.includes("status(409)") || ctx.includes(".status(409)")),
      "PATCH /api/work-orders/:id/labor-hours must map WO_LOCKED → 409",
    );
  });

  it("labor-hours body is validated with Zod", () => {
    const ctx = regionAround('app.patch("/api/work-orders/:id/labor-hours"');
    assert.ok(
      ctx.includes("safeParse") || ctx.includes("laborHoursBody"),
      "PATCH /api/work-orders/:id/labor-hours must validate the request body with Zod",
    );
  });
});

// ── PATCH /api/work-orders/:id/items ─────────────────────────────────────────

describe("Work-order inline editor — PATCH items", () => {
  it("PATCH /api/work-orders/:id/items is registered", () => {
    assert.ok(
      ROUTES_SRC.includes('app.patch("/api/work-orders/:id/items"'),
      "PATCH /api/work-orders/:id/items not found in routes.ts",
    );
  });

  it("items handler calls storage.replaceWorkOrderItemsWithResync", () => {
    assert.ok(
      ROUTES_SRC.includes("replaceWorkOrderItemsWithResync"),
      "routes.ts must call storage.replaceWorkOrderItemsWithResync",
    );
  });

  it("items handler forbids field_tech (403 guard present)", () => {
    const ctx = regionAround('app.patch("/api/work-orders/:id/items"');
    assert.ok(
      ctx.includes("field_tech") || (ctx.includes("403") && ctx.includes("Forbidden")),
      "PATCH /api/work-orders/:id/items must return 403 for field_tech callers",
    );
  });

  it("items handler maps WO_LOCKED to 409", () => {
    // Use the PATCH /items route anchor with a wider window (2000 chars) so we
    // capture the full handler body; the WO_LOCKED check lives after the storage
    // call which pushes it past the default 1500-char window.
    const ctx = regionAround('app.patch("/api/work-orders/:id/items"', 2000);
    assert.ok(
      ctx.includes('"WO_LOCKED"') && (ctx.includes("status(409)") || ctx.includes(".status(409)")),
      "PATCH /api/work-orders/:id/items must map WO_LOCKED → 409",
    );
  });

  it("items body is validated with Zod (items array)", () => {
    assert.ok(
      ROUTES_SRC.includes('app.patch("/api/work-orders/:id/items"') &&
      ROUTES_SRC.includes("itemsBody.safeParse") &&
      ROUTES_SRC.includes("z.array("),
      "PATCH /api/work-orders/:id/items must validate items array with Zod",
    );
  });

  it("items handler maps partPrice from unitPrice before passing to storage", () => {
    assert.ok(
      ROUTES_SRC.includes("partPrice: String(i.unitPrice)"),
      "items handler must translate unitPrice → partPrice when building insert rows",
    );
  });
});

// ── replaceWorkOrderItemsWithResync — per_part inspection regression ──────────
// Task #1933: the storage method must use sumCompletionLaborHours (not a plain
// Σ laborHours) for per_part work orders, and must PERSIST issueType/findingId
// from existing rows into the newly-inserted rows so that a second inline edit
// or completion still classifies inspection-derived rows as line totals.
//
// The fix: enrichment from prior rows happens BEFORE the INSERT (not only in
// the in-memory labor computation), so persisted rows retain the discriminator.

const STORAGE_SRC = readFileSync(
  path.join(import.meta.dirname ?? __dirname, "../storage.ts"),
  "utf8",
);

describe("replaceWorkOrderItemsWithResync — per_part inspection regression (Task #1933)", () => {
  // Find the implementation body (skip the interface declaration).
  const implStart = STORAGE_SRC.lastIndexOf("replaceWorkOrderItemsWithResync");
  const implCtx = STORAGE_SRC.slice(implStart, implStart + 5000);

  it("uses sumCompletionLaborHours instead of a plain reduce for per_part mode", () => {
    assert.ok(
      implCtx.includes("sumCompletionLaborHours"),
      "replaceWorkOrderItemsWithResync must call sumCompletionLaborHours for per_part labor re-sum",
    );
  });

  it("reads existing items before deletion to retain inspection lineage", () => {
    // The method must SELECT existing rows before the DELETE so it can
    // carry issueType / findingId into the new rows even when the caller
    // (e.g. PATCH /items) did not propagate those fields.
    const selectBeforeDelete =
      implCtx.indexOf("select()") < implCtx.indexOf("delete(") &&
      implCtx.indexOf("select()") !== -1 &&
      implCtx.indexOf("delete(") !== -1;
    assert.ok(
      selectBeforeDelete,
      "replaceWorkOrderItemsWithResync must SELECT existing items before the DELETE for lineage retention",
    );
  });

  it("enriches items with issueType/findingId from prior rows BEFORE insertion (not just in-memory)", () => {
    // Critical: the enrichment must happen on the items array BEFORE the
    // INSERT call so that the database rows themselves carry issueType/findingId.
    // If enrichment only happens after insertion (in-memory for the labor sum),
    // subsequent edits lose the discriminator and re-introduce the doubling bug.
    //
    // Verify by confirming that enrichment code (spread of prior issueType into
    // item) appears before the INSERT values construction in the source.
    const enrichIdx = implCtx.indexOf("issueType: (prior as any).issueType");
    const insertIdx = implCtx.indexOf("tx.insert(workOrderItems)");
    assert.ok(
      enrichIdx !== -1,
      "replaceWorkOrderItemsWithResync must spread prior.issueType into the enriched item",
    );
    assert.ok(
      insertIdx !== -1,
      "replaceWorkOrderItemsWithResync must call tx.insert(workOrderItems)",
    );
    assert.ok(
      enrichIdx < insertIdx,
      "issueType enrichment from prior rows must happen BEFORE the tx.insert call so it is persisted",
    );
  });

  it("enriches items without issueType/findingId from prior rows by partId", () => {
    assert.ok(
      implCtx.includes("issueType") && implCtx.includes("findingId") && implCtx.includes("partId"),
      "replaceWorkOrderItemsWithResync must enrich items with issueType/findingId from prior rows",
    );
  });
});
