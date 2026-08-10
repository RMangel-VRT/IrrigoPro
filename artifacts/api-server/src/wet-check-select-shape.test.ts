import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import * as schema from "@workspace/db/schema";
import { WET_CHECK_ZONE_RECORD_SELECTION } from "./storage";

/**
 * Regression guard for the wet check outage where `getWetCheck` selected five
 * column names that do not exist on `wet_check_zone_records`
 * (`issueSummary`, `resolvedAt`, `resolvedByUserId`, `billingSheetId`,
 * `wetCheckBillingId`).
 *
 * Each one resolved to `undefined`, and Drizzle's `orderSelectedFields`
 * recursed into it — `Object.entries(undefined)` — throwing
 * `TypeError: Cannot convert undefined or null to object` while *preparing*
 * the statement, before any SQL reached the database. Every
 * `GET /api/wet-checks/:id` returned 500 and the field app spun forever.
 *
 * TypeScript does not catch this: `table.nonExistentColumn` on a Drizzle table
 * object is typed `any`/`undefined` rather than a compile error, so the defect
 * is only observable at runtime on the specific route that runs the query.
 */

const COLUMNS_SYMBOL = Symbol.for("drizzle:Columns");
const NAME_SYMBOL = Symbol.for("drizzle:Name");

/** Every exported Drizzle table, keyed by its exported identifier. */
function loadTables(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const [exportName, value] of Object.entries(schema as Record<string, unknown>)) {
    const candidate = value as Record<symbol, unknown> | null;
    if (candidate && typeof candidate === "object" && candidate[COLUMNS_SYMBOL] && candidate[NAME_SYMBOL]) {
      tables.set(exportName, new Set(Object.keys(candidate[COLUMNS_SYMBOL] as object)));
    }
  }
  return tables;
}

describe("wet check zone-record selection", () => {
  test("every selected field resolves to a real Drizzle column", () => {
    const columns = new Set(
      Object.keys((schema.wetCheckZoneRecords as unknown as Record<symbol, object>)[COLUMNS_SYMBOL]),
    );

    const bad: string[] = [];
    for (const [key, value] of Object.entries(WET_CHECK_ZONE_RECORD_SELECTION)) {
      if (value === undefined || value === null) {
        bad.push(`${key} (undefined — not a column on wet_check_zone_records)`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      `getWetCheck selects fields that do not exist. Drizzle throws "Cannot convert undefined or null to object" at prepare time for these:\n  ${bad.join("\n  ")}`,
    );

    // Belt and braces: the key names must match real columns too, so a
    // renamed schema column cannot silently keep an alias alive.
    const unknownKeys = Object.entries(WET_CHECK_ZONE_RECORD_SELECTION)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .filter((key) => !columns.has(key));
    assert.deepEqual(unknownKeys, [], `Selection keys with no matching column: ${unknownKeys.join(", ")}`);
  });
});

describe("hand-written Drizzle selections across the API server", () => {
  /**
   * Broad static sweep for the same defect class anywhere else. Only
   * selection-shaped lines (`alias: someTable.column,`) are inspected, which
   * keeps the scan free of raw-SQL strings, comments, and local variables that
   * happen to share a table's name.
   *
   * BEST-EFFORT TRIPWIRE, NOT A COMPLETE GUARD. Being line-anchored and
   * regex-based, it does not see selections written inline on one line, built
   * from spreads or helper functions, or wrapped in an expression. Treat a
   * pass here as "no obvious phantom column", not as proof that every
   * selection in the server is sound. The assertion above is the real guard
   * for the wet check read path; a table-driven or AST-based sweep would be
   * needed to make this one authoritative.
   */
  test("no selection line references a column that does not exist", () => {
    const tables = loadTables();
    assert.ok(tables.size > 20, "expected to load the Drizzle tables from @workspace/db/schema");

    const srcRoot = join(import.meta.dirname, ".");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "dist") walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(srcRoot);

    // `alias: table.column,` — the shape used inside `db.select({ ... })`.
    const SELECTION_LINE = /^\s*[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*,?\s*$/;

    // A local array/map that shadows a table name (`const users = [...]`,
    // then `{ total: users.length }`) is not a Drizzle selection. These
    // property names are never column names, so treat them as shadowing.
    const JS_MEMBERS = new Set([
      "length", "size", "rows", "map", "filter", "find", "findIndex", "push", "pop",
      "shift", "unshift", "join", "get", "set", "has", "add", "delete", "some",
      "every", "slice", "splice", "sort", "forEach", "reduce", "includes",
      "indexOf", "lastIndexOf", "concat", "keys", "values", "entries", "flat",
      "flatMap", "at", "reverse", "fill", "then", "catch", "finally",
    ]);

    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const match = SELECTION_LINE.exec(line);
        if (!match) return;
        const [, tableName, column] = match;
        if (JS_MEMBERS.has(column)) return;
        const columns = tables.get(tableName);
        if (!columns) return; // not a schema table — a local object, params, etc.
        if (columns.has(column)) return;
        violations.push(`${relative(srcRoot, file)}:${index + 1}  ${tableName}.${column}`);
      });
    }

    assert.deepEqual(
      violations,
      [],
      `Drizzle selections reference columns that do not exist. These throw "Cannot convert undefined or null to object" the moment the query runs:\n  ${violations.join("\n  ")}`,
    );
  });
});
