// Slice 4a — Database migration registry types.

export type MigrationStatus =
  | { state: 'not_started' }
  | { state: 'partially_applied'; details: string }
  | { state: 'completed'; completedAt: string }
  // The migration's own check() threw (e.g. it queries a column that does
  // not exist yet in this environment). Surfaced per-migration so one bad
  // check can't blank the whole admin page.
  | { state: 'error'; details: string };

export type MigrationStep = {
  id: string;
  description: string;
};

/**
 * Step reporting contract (Task #1982)
 * ------------------------------------
 * A step result is a claim about the database, so it must only be made about
 * writes the database has already accepted:
 *
 *  1. Report `success` **after** the writes it vouches for are committed.
 *     Inside a `db.transaction(...)` callback nothing is committed yet, so a
 *     `success` result (or a `success` emit) built there can still be undone
 *     by a rollback. Collect what happened inside the callback, return it, and
 *     push the result after `db.transaction()` resolves.
 *  2. `rowsAffected` counts rows that are actually present afterwards — the
 *     committed row count, not the number of statements attempted.
 *  3. When a migration writes a completion marker, that marker is written in
 *     the **same transaction** as the writes it vouches for. A marker in its
 *     own autocommit statement can outlive rolled-back writes and turn the
 *     migration's own `check()` into a lie.
 *
 * Migrations that do all their work in autocommit satisfy (1) trivially: each
 * statement is committed as it returns.
 */
export type MigrationStepResult = {
  id: string;
  status: 'success' | 'skipped' | 'failed';
  durationMs: number;
  rowsAffected?: number;
  error?: string;
};

export type MigrationPreview = {
  steps: MigrationStep[];
  orphanRows: Record<string, number>;
  warnings: string[];
};

/**
 * What the server re-read from the database *after* the run finished.
 *
 * The step results are the migration's report about itself; this is the
 * independent second opinion the client renders instead of trusting it.
 */
export type MigrationPostRunCheck = {
  /** When the re-read happened. */
  checkedAt: string;
  /** The migration's own check(), re-evaluated after the run. */
  status: MigrationStatus;
  /** Freshly re-read preview counts, so the client never shows pre-run numbers. */
  preview?: MigrationPreview;
  /** Set when the post-run re-read itself failed. */
  error?: string;
};

export type MigrationProgress = {
  jobId: string;
  migrationId: string;
  startedAt: string;
  /**
   * `mismatched` — every step reported success but the post-run re-read says
   * the migration is not completed. This is the signature of a run that
   * reported writes it did not make, and must never render as a success.
   */
  state: 'running' | 'succeeded' | 'failed' | 'aborted' | 'mismatched';
  steps: MigrationStepResult[];
  finishedAt?: string;
  errorMessage?: string;
  postRun?: MigrationPostRunCheck;
  /** Present exactly when `state === 'mismatched'`; names the shortfall. */
  mismatch?: { summary: string; details: string };
};

export type ProgressEmitter = (event: {
  step: string;
  status: 'running' | 'success' | 'skipped' | 'failed';
  rowsAffected?: number;
  error?: string;
}) => void;

export type MigrationRunOptions = {
  /** Caller must set this to `true` for money-changing migrations (repairs/de-dups).
   * Migrations that mutate financial data MUST refuse to write unless acknowledged. */
  acknowledged?: boolean;
};

export type MigrationDefinition = {
  id: string;
  title: string;
  description: string;
  appSettingsKey: string;
  /** When true the migration has been superseded and its run() refuses execution. */
  deprecated?: boolean;
  deprecationReason?: string;
  check(): Promise<MigrationStatus>;
  preview(): Promise<MigrationPreview>;
  run(emit: ProgressEmitter, opts?: MigrationRunOptions): Promise<MigrationStepResult[]>;
};
