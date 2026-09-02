// Task #1982 — the run's own report is not evidence.
//
// Two things are proved here, both at the HTTP boundary a Super Admin's
// browser actually talks to:
//
//   1. After a run finishes the server re-reads the migration's status and
//      preview and attaches them to the job. A run whose steps all reported
//      success but whose post-run status is not `completed` comes back as
//      `mismatched`, carrying the shortfall — the signature of the incident,
//      and impossible to read as a normal success.
//   2. The environment/database identity read names the environment, the host
//      and the database, and *nothing else*: the database user, the password
//      and the connection string never cross the wire.
//
// A fake registry is injected, so no database is required.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  registerAdminMigrationsRoutes,
  type AdminMigrationsDeps,
} from "./admin-migrations-routes";
import type { MigrationDefinition, MigrationStatus } from "../lib/migrations/types";
import { describeDatabaseTarget, resolveEnvironmentName } from "../lib/migrations/db-identity";

// ── Harness ───────────────────────────────────────────────────────────────────

function makeRequireAuth() {
  return (req: any, res: any, next: any) => {
    req.authenticatedUserRole = req.headers["x-test-role"] ?? null;
    if (!req.authenticatedUserRole) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    next();
  };
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServerWith(deps: AdminMigrationsDeps): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  registerAdminMigrationsRoutes(app, makeRequireAuth(), deps);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function hit(
  base: string,
  method: string,
  path: string,
  opts: { role?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; raw: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.role) headers["x-test-role"] = opts.role;
  const resp = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await resp.text();
  let body: any = null;
  try { body = JSON.parse(raw); } catch { /* non-JSON */ }
  return { status: resp.status, body, raw };
}

/** Poll until the fire-and-forget job settles. */
async function pollToTerminal(base: string, migrationId: string, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const poll = await hit(base, "GET", `/api/admin/migrations/${migrationId}/status?jobId=${jobId}`, {
      role: "super_admin",
    });
    assert.equal(poll.status, 200);
    if (poll.body.state !== "running") return poll.body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job never reached a terminal state");
}

async function runToCompletion(base: string, migrationId: string) {
  const run = await hit(base, "POST", `/api/admin/migrations/${migrationId}/run`, {
    role: "super_admin",
    body: { acknowledged: true },
  });
  assert.equal(run.status, 200);
  return pollToTerminal(base, migrationId, run.body.jobId);
}

// ── Fake migrations ───────────────────────────────────────────────────────────

/**
 * A migration whose reported result and whose post-run truth are set
 * independently — exactly the divergence the self-check exists to catch.
 */
function makeMigration(opts: {
  id: string;
  statusAfterRun: MigrationStatus | (() => never);
  missingAfterRun: number;
  runOutcome?: "success" | "failure";
  /** Make the post-run preview re-read fail. */
  previewThrowsAfterRun?: string;
}): MigrationDefinition {
  let ran = false;
  return {
    id: opts.id,
    title: `Fake ${opts.id}`,
    description: `Fake migration ${opts.id}`,
    appSettingsKey: opts.id,
    check: async () => {
      if (!ran) return { state: "not_started" };
      if (typeof opts.statusAfterRun === "function") return opts.statusAfterRun();
      return opts.statusAfterRun;
    },
    preview: async () => {
      if (ran && opts.previewThrowsAfterRun) throw new Error(opts.previewThrowsAfterRun);
      return {
        steps: [{ id: "seed-defaults", description: "Insert missing defaults" }],
        // Before the run this reports the pre-run shortfall; after it, the
        // post-run number. The job must carry the post-run one.
        orphanRows: { fieldWorkTypesMissing: ran ? opts.missingAfterRun : 14 },
        warnings: [],
      };
    },
    run: async (emit) => {
      ran = true;
      if (opts.runOutcome === "failure") {
        emit({ step: "seed-defaults", status: "failed", error: "insert exploded" });
        return [{ id: "seed-defaults", status: "failed", durationMs: 1, error: "insert exploded" }];
      }
      emit({ step: "seed-defaults", status: "success", rowsAffected: 14 });
      return [{ id: "seed-defaults", status: "success", durationMs: 1, rowsAffected: 14 }];
    },
  };
}

function depsFor(migrations: MigrationDefinition[]): AdminMigrationsDeps {
  return {
    listMigrations: () => migrations,
    getMigration: (id: string) => migrations.find((m) => m.id === id),
  };
}

// ── Post-run self-check ───────────────────────────────────────────────────────

describe("admin-migrations — the server re-reads the truth after every run", () => {
  const honest = makeMigration({
    id: "honest",
    statusAfterRun: { state: "completed", completedAt: "2026-09-02T13:59:28.052Z" },
    missingAfterRun: 0,
  });
  const failing = makeMigration({
    id: "failing",
    statusAfterRun: { state: "not_started" },
    missingAfterRun: 14,
    runOutcome: "failure",
  });

  let harness: Harness;
  before(async () => { harness = await startServerWith(depsFor([honest, failing])); });
  after(async () => { await harness.close(); });

  it("attaches post-run status and freshly re-read preview counts to a successful job", async () => {
    const job = await runToCompletion(harness.baseUrl, "honest");

    assert.equal(job.state, "succeeded");
    assert.ok(job.postRun, "the job must carry a post-run re-read");
    assert.equal(job.postRun.status.state, "completed");
    assert.ok(job.postRun.checkedAt, "the re-read must be timestamped");
    assert.equal(
      job.postRun.preview.orphanRows.fieldWorkTypesMissing,
      0,
      "the attached counts must be the post-run numbers, not the pre-run ones",
    );
    assert.equal(job.mismatch, undefined);
  });

  it("attaches the post-run re-read to a failed job too, without calling it a mismatch", async () => {
    const job = await runToCompletion(harness.baseUrl, "failing");

    assert.equal(job.state, "failed", "a failed run stays failed");
    assert.ok(job.postRun, "a failed run is still re-read, so the operator sees where it left the data");
    assert.equal(job.postRun.status.state, "not_started");
    assert.equal(job.mismatch, undefined, "'mismatched' is reserved for success that isn't");
  });
});

describe("admin-migrations — success the database does not confirm is a mismatch", () => {
  // The incident's shape: every step reports success, the data is still missing.
  const liar = makeMigration({
    id: "liar",
    statusAfterRun: {
      state: "partially_applied",
      details: "14 default field work type(s) are still missing across 2 company/companies",
    },
    missingAfterRun: 14,
  });
  const notStarted = makeMigration({
    id: "not-started-after-run",
    statusAfterRun: { state: "not_started" },
    missingAfterRun: 14,
  });
  const unverifiable = makeMigration({
    id: "unverifiable",
    statusAfterRun: () => { throw new Error('column "code" does not exist'); },
    missingAfterRun: 14,
  });
  // The nastier half: the migration says it is done, but the counts that would
  // corroborate it cannot be read. "Completed" on its own word is not proof.
  const unreadableCounts = makeMigration({
    id: "unreadable-counts",
    statusAfterRun: { state: "completed", completedAt: "2026-09-02T13:59:28.052Z" },
    missingAfterRun: 0,
    previewThrowsAfterRun: "connection terminated while re-reading counts",
  });

  let harness: Harness;
  before(async () => {
    harness = await startServerWith(depsFor([liar, notStarted, unverifiable, unreadableCounts]));
  });
  after(async () => { await harness.close(); });

  it("marks the job 'mismatched' and names the shortfall when the status is partially applied", async () => {
    const job = await runToCompletion(harness.baseUrl, "liar");

    assert.equal(job.state, "mismatched", "this must never surface as 'succeeded'");
    assert.notEqual(job.state, "succeeded");
    assert.ok(job.mismatch, "the shortfall must reach the client");
    assert.match(job.mismatch.summary, /reported success/i);
    assert.match(
      job.mismatch.details,
      /14 default field work type\(s\) are still missing/,
      "the specific shortfall, not a generic warning",
    );
    // The steps still say success — that is the point: the job state, not the
    // step list, is what tells the operator the run cannot be believed.
    assert.equal(job.steps[0].status, "success");
    assert.equal(job.postRun.status.state, "partially_applied");
    assert.equal(job.postRun.preview.orphanRows.fieldWorkTypesMissing, 14);
  });

  it("marks the job 'mismatched' when the post-run status is still not_started", async () => {
    const job = await runToCompletion(harness.baseUrl, "not-started-after-run");
    assert.equal(job.state, "mismatched");
    assert.match(job.mismatch.details, /has not started/i);
  });

  it("marks the job 'mismatched' when the post-run status check itself fails", async () => {
    const job = await runToCompletion(harness.baseUrl, "unverifiable");
    assert.equal(job.state, "mismatched", "an unverifiable success is not a success");
    assert.equal(job.postRun.status.state, "error");
    assert.ok(job.postRun.error, "the re-read failure must be carried to the client");
    assert.match(job.mismatch.details, /column "code" does not exist/);
  });

  it("marks the job 'mismatched' when the post-run counts cannot be re-read", async () => {
    const job = await runToCompletion(harness.baseUrl, "unreadable-counts");

    assert.equal(
      job.state,
      "mismatched",
      "a 'completed' status the counts cannot corroborate is still unverified",
    );
    assert.notEqual(job.state, "succeeded");
    assert.equal(job.postRun.preview, undefined, "no stale preview may be attached");
    assert.match(job.postRun.error, /preview re-read failed/);
    assert.match(job.mismatch.details, /connection terminated while re-reading counts/);
    assert.match(job.mismatch.summary, /could not be completed/i);
  });
});

// ── Environment / database identity ───────────────────────────────────────────

describe("db-identity — describeDatabaseTarget redacts credentials", () => {
  const CREDENTIALED = "postgresql://mig_user:sup3r-s3cret@ep-cool-db.us-east-2.aws.neon.tech:5432/appdb?sslmode=require";

  it("keeps only host, port and database name", () => {
    const target = describeDatabaseTarget(CREDENTIALED, {
      environment: "production",
      deployment: true,
    });
    assert.deepEqual(target, {
      environment: "production",
      deployment: true,
      host: "ep-cool-db.us-east-2.aws.neon.tech",
      database: "appdb",
      port: 5432,
      redacted: true,
    });
  });

  it("never carries the user, the password, or the connection string", () => {
    const serialized = JSON.stringify(
      describeDatabaseTarget(CREDENTIALED, { environment: "production", deployment: true }),
    );
    assert.equal(serialized.includes("mig_user"), false, "database user must be redacted");
    assert.equal(serialized.includes("sup3r-s3cret"), false, "password must be redacted");
    assert.equal(serialized.includes("sslmode"), false, "query parameters must be dropped");
    assert.equal(serialized.includes("postgresql://"), false, "no connection string may leak");
  });

  it("degrades to 'unknown' instead of throwing on a missing or unparsable string", () => {
    for (const value of [undefined, "", "not a url"]) {
      const target = describeDatabaseTarget(value, { environment: "development", deployment: false });
      assert.equal(target.host, "unknown");
      assert.equal(target.database, "unknown");
      assert.equal(target.redacted, true);
    }
  });

  it("names a Replit deployment 'production' and everything else by NODE_ENV", () => {
    assert.deepEqual(
      resolveEnvironmentName({ REPLIT_DEPLOYMENT: "1", NODE_ENV: "production" } as any),
      { environment: "production", deployment: true },
    );
    assert.deepEqual(
      resolveEnvironmentName({ NODE_ENV: "development" } as any),
      { environment: "development", deployment: false },
    );
    assert.deepEqual(
      resolveEnvironmentName({} as any),
      { environment: "development", deployment: false },
    );
  });
});

describe("GET /api/admin/migrations/environment", () => {
  const target = describeDatabaseTarget(
    "postgresql://mig_user:sup3r-s3cret@ep-cool-db.us-east-2.aws.neon.tech:5432/appdb?sslmode=require",
    { environment: "production", deployment: true },
  );

  let harness: Harness;
  before(async () => {
    harness = await startServerWith({
      ...depsFor([]),
      currentDatabaseTarget: () => target,
    });
  });
  after(async () => { await harness.close(); });

  it("returns 401 for an unauthenticated request", async () => {
    const r = await hit(harness.baseUrl, "GET", "/api/admin/migrations/environment");
    assert.equal(r.status, 401);
  });

  for (const role of ["company_admin", "irrigation_manager", "field_tech", "billing_manager"]) {
    it(`returns 403 for ${role}`, async () => {
      const r = await hit(harness.baseUrl, "GET", "/api/admin/migrations/environment", { role });
      assert.equal(r.status, 403);
    });
  }

  it("tells a super admin which environment and database the server is acting on", async () => {
    const r = await hit(harness.baseUrl, "GET", "/api/admin/migrations/environment", {
      role: "super_admin",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.environment, "production");
    assert.equal(r.body.deployment, true);
    assert.equal(r.body.host, "ep-cool-db.us-east-2.aws.neon.tech");
    assert.equal(r.body.database, "appdb");
    assert.equal(r.body.redacted, true);
  });

  it("puts no credential anywhere in the response body", async () => {
    const r = await hit(harness.baseUrl, "GET", "/api/admin/migrations/environment", {
      role: "super_admin",
    });
    assert.equal(r.raw.includes("mig_user"), false);
    assert.equal(r.raw.includes("sup3r-s3cret"), false);
    assert.equal(r.raw.includes("postgresql://"), false);
    assert.equal(Object.keys(r.body).sort().join(","), "database,deployment,environment,host,port,redacted");
  });
});

describe("GET /api/admin/migrations/environment — against the real DATABASE_URL", () => {
  let harness: Harness;
  before(async () => { harness = await startServerWith(depsFor([])); });
  after(async () => { await harness.close(); });

  it("reports this process's real database without leaking its credentials", async () => {
    const r = await hit(harness.baseUrl, "GET", "/api/admin/migrations/environment", {
      role: "super_admin",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.redacted, true);
    assert.ok(typeof r.body.host === "string" && r.body.host.length > 0);
    assert.ok(typeof r.body.database === "string" && r.body.database.length > 0);

    const raw = process.env.DATABASE_URL;
    if (raw) {
      const url = new URL(raw);
      if (url.password) assert.equal(r.raw.includes(url.password), false, "password leaked");
      if (url.username) assert.equal(r.raw.includes(url.username), false, "username leaked");
      assert.equal(r.raw.includes(raw), false, "connection string leaked");
    }
  });
});
