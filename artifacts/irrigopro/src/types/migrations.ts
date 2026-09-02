// Shared frontend types for the DB migration admin page.
// Mirror of the server-side types in api-server/src/lib/migrations/types.ts.

export type MigrationStatus =
  | { state: 'not_started' }
  | { state: 'partially_applied'; details: string }
  | { state: 'completed'; completedAt: string }
  // The migration's own check() threw on the server (e.g. it queries a
  // column not yet applied in this environment). Surfaced per-migration so
  // one bad check can't blank the whole page.
  | { state: 'error'; details: string };

export type MigrationStep = {
  id: string;
  description: string;
};

export type MigrationStepResult = {
  id: string;
  status: 'success' | 'skipped' | 'failed' | 'running';
  durationMs: number;
  rowsAffected?: number;
  error?: string;
};

export type MigrationPreview = {
  steps: MigrationStep[];
  orphanRows: Record<string, number>;
  warnings: string[];
};

// Task #1982 — what the server re-read from the database after the run
// finished. The step results are the migration's report about itself; this is
// the independent second opinion, and it is what the page renders.
export type MigrationPostRunCheck = {
  checkedAt: string;
  status: MigrationStatus;
  preview?: MigrationPreview;
  error?: string;
};

export type MigrationProgress = {
  jobId: string;
  migrationId: string;
  startedAt: string;
  // `mismatched` — the run reported success but the post-run re-read says the
  // migration is not completed. Never render this as a success.
  state: 'running' | 'succeeded' | 'failed' | 'aborted' | 'mismatched';
  steps: MigrationStepResult[];
  finishedAt?: string;
  errorMessage?: string;
  postRun?: MigrationPostRunCheck;
  mismatch?: { summary: string; details: string };
};

export type MigrationListItem = {
  id: string;
  title: string;
  description: string;
  status: MigrationStatus;
};

// Redacted identity of the database the API server is acting on. Host and
// database name only — never a user, a password, or a connection string.
export type MigrationTarget = {
  environment: string;
  deployment: boolean;
  host: string;
  database: string;
  port: number | null;
  redacted: true;
};
