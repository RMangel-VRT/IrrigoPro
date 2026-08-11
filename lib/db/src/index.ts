import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
});

pool.on("error", (err: Error & { code?: string }) => {
  process.stderr.write(
    JSON.stringify({
      level: "error",
      msg: "pg pool idle-connection error",
      pgCode: err.code ?? null,
      pgMessage: err.message ?? null,
    }) + "\n",
  );
});

export const db = drizzle(pool, { schema });

const CONNECTION_TERMINATION_CODES = new Set(["57P01", "08006", "08003"]);

export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const pgCode = (err as { cause?: { code?: string } })?.cause?.code;
    if (pgCode && CONNECTION_TERMINATION_CODES.has(pgCode)) {
      return await fn();
    }
    throw err;
  }
}

export * from "./schema";
export * from "./pricing-fields";
export * from "./ar-note-fields";
export * from "./estimate-summary";
export * from "./notification-types";
