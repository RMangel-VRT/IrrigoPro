import type { Express, Response } from 'express';
import {
  listMigrations as defaultListMigrations,
  getMigration as defaultGetMigration,
} from '../lib/migrations/registry';
import type {
  MigrationDefinition,
  MigrationPostRunCheck,
  MigrationProgress,
  MigrationStatus,
} from '../lib/migrations/types';
import {
  currentDatabaseTarget as defaultCurrentDatabaseTarget,
  type DatabaseTarget,
} from '../lib/migrations/db-identity';
import { randomUUID } from 'crypto';

// Injectable registry seam so tests can supply a fake migration whose
// check()/preview()/run() throws, without needing a database.
export interface AdminMigrationsDeps {
  listMigrations?: typeof defaultListMigrations;
  getMigration?: typeof defaultGetMigration;
  currentDatabaseTarget?: () => DatabaseTarget;
}

// In-process job store. Migrations are short (< 30s) so persistence
// across server restarts is not required.
const JOBS = new Map<string, MigrationProgress>();

function requireSuperAdmin(req: any, res: Response): boolean {
  if (req.authenticatedUserRole !== 'super_admin') {
    res.status(403).json({ message: 'Super admin only' });
    return false;
  }
  return true;
}

/**
 * Task #1982 — the run's own report is not evidence.
 *
 * After a run finishes the server re-reads the migration's `check()` and
 * `preview()` and attaches the result to the job. A run whose steps all
 * reported success but whose post-run status is anything other than
 * `completed` is marked `mismatched`, carrying the shortfall, so it can never
 * be read as a normal success.
 */
export async function attachPostRunCheck(
  d: MigrationDefinition,
  progress: MigrationProgress,
): Promise<void> {
  const checkedAt = new Date().toISOString();

  // Both halves of the re-read are required evidence: the status says whether
  // the migration considers itself done, the preview supplies the post-run
  // counts the page renders. If either one fails we cannot vouch for the run.
  let status: MigrationStatus | undefined;
  let preview: MigrationPostRunCheck['preview'];
  let error: string | undefined;
  try {
    status = await d.check();
  } catch (err: any) {
    error = `post-run status check failed: ${err?.message ?? String(err)}`;
  }
  if (error === undefined) {
    try {
      preview = await d.preview();
    } catch (err: any) {
      error = `post-run preview re-read failed: ${err?.message ?? String(err)}`;
    }
  }

  if (error !== undefined) {
    progress.postRun = {
      checkedAt,
      // Keep the status we did obtain, if any — it is still information — but
      // the check as a whole is an error.
      status: status ?? { state: 'error', details: error },
      preview: undefined,
      error,
    };
    // An unverifiable success is not a success: if the re-read did not
    // complete we cannot say the writes landed, so it must not render as one.
    if (progress.state === 'succeeded') {
      progress.state = 'mismatched';
      progress.mismatch = {
        summary:
          'The run reported success, but the post-run verification could not be completed. ' +
          'Treat this run as unconfirmed.',
        details: error,
      };
    }
    return;
  }

  const postRun: MigrationPostRunCheck = { checkedAt, status: status!, preview };
  progress.postRun = postRun;

  if (progress.state !== 'succeeded') return;
  if (postRun.status.state === 'completed') return;

  const details =
    postRun.status.state === 'partially_applied' || postRun.status.state === 'error'
      ? postRun.status.details
      : 'The migration reports it has not started.';
  progress.state = 'mismatched';
  progress.mismatch = {
    summary:
      `The run reported success, but re-reading the database says this migration is ` +
      `"${postRun.status.state}". Do not treat this run as done.`,
    details,
  };
}

export function registerAdminMigrationsRoutes(
  app: Express,
  requireAuthentication: any,
  deps: AdminMigrationsDeps = {},
) {
  const listMigrations = deps.listMigrations ?? defaultListMigrations;
  const getMigration = deps.getMigration ?? defaultGetMigration;
  const currentDatabaseTarget = deps.currentDatabaseTarget ?? defaultCurrentDatabaseTarget;

  // GET /api/admin/migrations/environment
  //
  // Names the environment and the database this server is acting on, so a
  // production repair can never be mistaken for a dev one. Host and database
  // name only — the user, the password and the connection string never leave
  // the server (see lib/migrations/db-identity.ts).
  app.get('/api/admin/migrations/environment', requireAuthentication, async (req: any, res) => {
    if (!requireSuperAdmin(req, res)) return;
    res.json(currentDatabaseTarget());
  });

  // GET /api/admin/migrations
  app.get('/api/admin/migrations', requireAuthentication, async (req: any, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const defs = listMigrations();
    // Per-migration isolation: one migration's check() throwing (e.g. it
    // queries a column not yet applied in this environment) must not reject
    // the whole list and 500 the page. Each failure becomes an `error` row.
    const rows = await Promise.all(defs.map(async (d) => {
      try {
        return {
          id: d.id,
          title: d.title,
          description: d.description,
          deprecated: d.deprecated ?? false,
          deprecationReason: d.deprecationReason ?? null,
          status: await d.check(),
        };
      } catch (err: any) {
        return {
          id: d.id,
          title: d.title,
          description: d.description,
          deprecated: d.deprecated ?? false,
          deprecationReason: d.deprecationReason ?? null,
          status: { state: 'error' as const, details: err?.message ?? String(err) },
        };
      }
    }));
    res.json(rows);
  });

  // GET /api/admin/migrations/:id/preview
  app.get('/api/admin/migrations/:id/preview', requireAuthentication, async (req: any, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const d = getMigration(req.params.id);
    if (!d) { res.status(404).json({ message: 'Migration not found' }); return; }
    // Isolate this migration's preview() failure into a clean 500 for itself
    // instead of an opaque unhandled rejection.
    try {
      const preview = await d.preview();
      res.json(preview);
    } catch (err: any) {
      res.status(500).json({
        message: 'Migration preview failed',
        migrationId: d.id,
        details: err?.message ?? String(err),
      });
    }
  });

  // POST /api/admin/migrations/:id/run
  app.post('/api/admin/migrations/:id/run', requireAuthentication, async (req: any, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const d = getMigration(req.params.id);
    if (!d) { res.status(404).json({ message: 'Migration not found' }); return; }
    const jobId = randomUUID();
    const progress: MigrationProgress = {
      jobId,
      migrationId: d.id,
      startedAt: new Date().toISOString(),
      state: 'running',
      steps: [],
    };
    JOBS.set(jobId, progress);
    // Fire-and-forget the runner; the client polls /status.
    void (async () => {
      try {
        const opts = { acknowledged: req.body?.acknowledged === true };
        const results = await d.run((event) => {
          // Mirror live events into the job's step list.
          const existing = progress.steps.findIndex((s) => s.id === event.step);
          if (existing >= 0) {
            progress.steps[existing] = {
              ...progress.steps[existing],
              status: event.status as MigrationProgress['steps'][number]['status'],
              error: event.error,
            };
          } else {
            progress.steps.push({
              id: event.step,
              status: event.status as MigrationProgress['steps'][number]['status'],
              durationMs: 0,
              error: event.error,
            });
          }
        }, opts);
        progress.steps = results;
        progress.state = results.some((r) => r.status === 'failed') ? 'failed' : 'succeeded';
        // Re-read the truth before the job is marked finished, so the first
        // terminal poll the client sees already carries post-run facts.
        await attachPostRunCheck(d, progress);
        progress.finishedAt = new Date().toISOString();
      } catch (err: any) {
        progress.state = 'failed';
        progress.errorMessage = err?.message ?? String(err);
        try {
          await attachPostRunCheck(d, progress);
        } catch { /* the failure above is what matters */ }
        progress.finishedAt = new Date().toISOString();
      }
    })();
    res.json({ jobId });
  });

  // GET /api/admin/migrations/:id/status?jobId=...
  app.get('/api/admin/migrations/:id/status', requireAuthentication, async (req: any, res) => {
    if (!requireSuperAdmin(req, res)) return;
    // Validate migration id first (404 on unknown migration, not just on missing job).
    const d = getMigration(req.params.id);
    if (!d) { res.status(404).json({ message: 'Migration not found' }); return; }
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : '';
    const job = JOBS.get(jobId);
    if (!job) { res.status(404).json({ message: 'Job not found' }); return; }
    // Guard: the job must belong to this migration (prevents cross-migration status leakage).
    if (job.migrationId !== req.params.id) {
      res.status(404).json({ message: 'Job not found for this migration' });
      return;
    }
    res.json(job);
  });
}
