// Schema drift check — verifies that every table/column defined in the Drizzle
// schema actually exists in the connected (development) database.
//
// Why this exists: `drizzle-kit push` stops at an interactive confirmation
// prompt when the diff contains data-loss statements and exits 0 WITHOUT
// applying anything, so a post-merge push can silently no-op and leave the dev
// DB behind the schema. Because Replit's publish flow applies the dev↔prod
// schema diff, that drift then propagates to production as missing columns
// (500s like `column "controller_id" does not exist`). This check runs after
// the post-merge push and fails loudly if the dev DB does not match.
//
// Read-only: only queries information_schema. Never issues DDL.
import { getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import * as appSchema from "./schema/index";
import * as internalSchema from "./schema/web-sessions-internal";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Collect every pgTable exported by the schema barrels (same two files
  // drizzle.config.ts points at).
  const expected = new Map<string, Set<string>>();
  for (const mod of [appSchema, internalSchema]) {
    for (const value of Object.values(mod as Record<string, unknown>)) {
      let config;
      try {
        config = getTableConfig(value as never);
      } catch {
        continue; // not a pgTable export
      }
      const cols = expected.get(config.name) ?? new Set<string>();
      for (const col of config.columns) cols.add(col.name);
      expected.set(config.name, cols);
    }
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`
    );
    const actual = new Map<string, Set<string>>();
    for (const row of res.rows) {
      const cols = actual.get(row.table_name) ?? new Set<string>();
      cols.add(row.column_name);
      actual.set(row.table_name, cols);
    }

    const problems: string[] = [];
    for (const [table, cols] of expected) {
      const actualCols = actual.get(table);
      if (!actualCols) {
        problems.push(`missing table: ${table}`);
        continue;
      }
      for (const col of cols) {
        if (!actualCols.has(col)) problems.push(`missing column: ${table}.${col}`);
      }
    }

    if (problems.length > 0) {
      console.error(
        `SCHEMA DRIFT: development database is missing ${problems.length} object(s) defined in the Drizzle schema:`
      );
      for (const p of problems) console.error(`  - ${p}`);
      console.error(
        "The schema push did not fully apply (drizzle-kit push exits 0 when it aborts at a data-loss prompt). " +
          "Run `pnpm --filter db push-force` and re-run this check before publishing."
      );
      process.exit(1);
    }
    console.log(
      `Schema check OK: ${expected.size} tables verified against the development database.`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("verify-schema failed:", err);
  process.exit(1);
});
