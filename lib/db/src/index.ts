import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function poolIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Connection ceiling per process.
 *
 * The manager dashboard mounts ~25 concurrent API calls. At the previous
 * ceiling of 10 the eleventh call queued, hit the acquisition timeout and
 * threw `timeout exceeded when trying to connect`, which surfaced to users as
 * a silently empty estimate or work-order list.
 *
 * This is a budget, not a wish: the cost to Postgres is
 * `DB_POOL_MAX x replicas`. An Autoscale deployment runs more than one replica
 * against the same database, so before raising this, check it against the
 * database's own `max_connections` and the configured replica ceiling, and
 * leave headroom for migrations, the session store and manual `psql`.
 *
 * 20 x 3 replicas = 60 connections, which fits comfortably inside the
 * project's Neon plan while covering the full dashboard fan-out in a single
 * round of acquisitions. Override per-environment via `DB_POOL_MAX` rather
 * than editing this default.
 *
 * A bigger pool is not a substitute for fast queries. It was raised only
 * after the endpoints that held connections for seconds were fixed; see
 * docs/db-pool-and-dashboard-performance.md.
 */
export const DB_POOL_MAX = poolIntFromEnv("DB_POOL_MAX", 20);

/**
 * How long a caller waits for a free connection before throwing.
 *
 * The old 5s ceiling was shorter than the dashboard's own slowest queries, so
 * a cold start turned normal contention into user-visible failures. 15s is
 * long enough to absorb a burst behind a slow query, and still well under the
 * client's own request timeout so a genuine exhaustion still fails rather
 * than hanging forever.
 */
export const DB_POOL_CONNECT_TIMEOUT_MS = poolIntFromEnv(
  "DB_POOL_CONNECT_TIMEOUT_MS",
  15_000,
);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: DB_POOL_CONNECT_TIMEOUT_MS,
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

const CONNECTION_ACQUISITION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "53300", // too_many_connections
  "57P03", // cannot_connect_now
]);

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

/**
 * True when the error is a failure to *obtain* a connection rather than a
 * failure of the query itself.
 *
 * Callers use this to decide whether to rethrow instead of degrading to an
 * empty result: a missing row is a legitimate empty list, but an unavailable
 * database is not, and returning `[]` for it hides a real outage behind a page
 * that merely looks unpopulated. Drizzle wraps the driver error, so this walks
 * the `cause` chain (depth-capped against cycles).
 */
export function isConnectionAcquisitionError(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; node != null && depth < 5; depth++) {
    const e = node as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && CONNECTION_ACQUISITION_CODES.has(e.code)) {
      return true;
    }
    if (
      typeof e.message === "string" &&
      (e.message.includes("timeout exceeded when trying to connect") ||
        e.message.includes("Connection terminated due to connection timeout"))
    ) {
      return true;
    }
    node = e.cause;
  }
  return false;
}

export * from "./schema";
export * from "./pricing-fields";
export * from "./ar-note-fields";
export * from "./estimate-summary";
export * from "./notification-types";
