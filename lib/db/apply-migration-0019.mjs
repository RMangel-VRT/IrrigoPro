// One-off script to apply migration 0019 non-interactively.
import { readFileSync } from "fs";
import pg from "pg";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(__dir, "migrations/0019_seasonal_budget_model.sql"), "utf8");

const client = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
await client.connect();
try {
  console.log("Applying migration 0019...");
  await client.query(sql);
  console.log("Migration 0019 applied successfully.");
} catch (err) {
  if (String(err).includes("already exists")) {
    console.log("Migration already applied (column/table exists).");
  } else {
    throw err;
  }
} finally {
  await client.end();
}
