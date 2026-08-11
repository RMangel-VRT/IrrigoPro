/**
 * dashboard-burst.ts — Task #1898 measurement harness.
 *
 * Reproduces the manager-dashboard fan-out that exhausted the pg pool in
 * production and prints per-endpoint timings plus a pool-error tally, so a
 * change can be judged against a recorded baseline instead of a guess.
 *
 * Usage (api-server must already be running and serving on $BURST_BASE_URL,
 * default http://localhost:80):
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/dashboard-burst.ts
 *
 * Options via env:
 *   BURST_BASE_URL   base URL of the running API (default http://localhost:80)
 *   BURST_USERNAME   existing login to use; when unset a throwaway
 *                    company_admin is created for BURST_COMPANY_ID and
 *                    deleted afterwards
 *   BURST_PASSWORD   password for BURST_USERNAME
 *   BURST_COMPANY_ID company to scope the throwaway admin to (default 99,
 *                    the largest tenant in the dev database)
 *   BURST_ROUNDS     how many times to repeat the burst (default 1)
 *   BURST_FANOUT     how many copies of the endpoint list to fire at once
 *                    (default 1; production's dashboard fans out to ~25 calls,
 *                    so 2 approximates a real cold-start mount)
 *
 * The script never writes to any table other than `users` (one temporary row
 * that it removes on exit).
 */

import bcrypt from "bcrypt";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";

const BASE_URL = process.env.BURST_BASE_URL ?? "http://localhost:80";
const COMPANY_ID = Number(process.env.BURST_COMPANY_ID ?? 99);
const ROUNDS = Number(process.env.BURST_ROUNDS ?? 1);
const FANOUT = Number(process.env.BURST_FANOUT ?? 1);

// The set of GETs the manager dashboard fires on mount. Kept deliberately
// wide — the incident was caused by concurrency, not by any single call.
const DASHBOARD_ENDPOINTS: string[] = [
  "/api/financial-pulse/kpis",
  "/api/financial-pulse/kpis?period=ytd",
  "/api/financial-pulse/revenue-trend",
  "/api/financial-pulse/revenue-mix",
  "/api/financial-pulse/top-customers",
  "/api/financial-pulse/by-technician",
  "/api/financial-pulse/by-service-type",
  "/api/financial-pulse/ar-aging",
  "/api/financial-pulse/projections",
  "/api/customers/billing-preview",
  "/api/admin/labor-rate-audit",
  "/api/estimates",
  "/api/estimates/summary",
  "/api/customers",
  "/api/work-orders",
  "/api/billing-sheets",
  "/api/invoices",
];

interface Timing {
  path: string;
  ms: number;
  status: number;
  bytes: number;
  note: string;
}

async function withTempAdmin<T>(
  fn: (creds: { username: string; password: string }) => Promise<T>,
): Promise<T> {
  const supplied = process.env.BURST_USERNAME;
  if (supplied) {
    return fn({ username: supplied, password: process.env.BURST_PASSWORD ?? "" });
  }
  const username = `burst-bench-${Date.now()}`;
  const password = `burst-${Math.random().toString(36).slice(2)}`;
  const hash = await bcrypt.hash(password, 10);
  const rows = await db.execute(sql`
    INSERT INTO users (username, password, name, role, company_id, is_active, email_verified)
    VALUES (${username}, ${hash}, 'Burst Benchmark', 'company_admin', ${COMPANY_ID}, true, true)
    RETURNING id
  `);
  const id = Number((rows.rows[0] as { id: number }).id);
  try {
    return await fn({ username, password });
  } finally {
    await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
  }
}

async function login(creds: { username: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("login succeeded but returned no session cookie");
  return cookie;
}

async function timeGet(path: string, cookie: string): Promise<Timing> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers: { cookie } });
    const body = await res.text();
    return {
      path,
      ms: Date.now() - started,
      status: res.status,
      bytes: body.length,
      note: res.ok ? "" : body.slice(0, 120),
    };
  } catch (err) {
    return {
      path,
      ms: Date.now() - started,
      status: 0,
      bytes: 0,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

function report(label: string, timings: Timing[], wallMs: number): void {
  const sorted = [...timings].sort((a, b) => b.ms - a.ms);
  const pad = Math.max(...timings.map((t) => t.path.length));
  console.log(`\n── ${label} ──`);
  for (const t of sorted) {
    const flag = t.status >= 200 && t.status < 300 ? " " : "!";
    console.log(
      `${flag} ${t.path.padEnd(pad)}  ${String(t.ms).padStart(6)}ms  ${t.status}  ${String(t.bytes).padStart(8)}B  ${t.note}`,
    );
  }
  const total = timings.reduce((s, t) => s + t.ms, 0);
  const failures = timings.filter((t) => t.status < 200 || t.status >= 300);
  console.log(
    `  wall=${wallMs}ms  slowest=${sorted[0]?.ms ?? 0}ms  sum=${total}ms  failures=${failures.length}`,
  );
}

async function main(): Promise<void> {
  await withTempAdmin(async (creds) => {
    const cookie = await login(creds);
    console.log(`Base URL: ${BASE_URL}   pool max=${(pool as unknown as { options: { max: number } }).options.max}`);

    for (let round = 1; round <= ROUNDS; round++) {
      // Warm the connection pool the way a cold start would not: skip it.
      const started = Date.now();
      const burst: string[] = [];
      for (let i = 0; i < FANOUT; i++) burst.push(...DASHBOARD_ENDPOINTS);
      const timings = await Promise.all(burst.map((p) => timeGet(p, cookie)));
      report(`burst round ${round} (${burst.length} concurrent)`, timings, Date.now() - started);
    }
  });
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
