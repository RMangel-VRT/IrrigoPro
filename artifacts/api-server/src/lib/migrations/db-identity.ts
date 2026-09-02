// Task #1982 — "which database am I about to repair?"
//
// The Super Admin migrations page previously said nothing about *where* it was
// acting. An operator could run a repair against the development database,
// read a green banner and believe production was fixed (or the reverse, which
// is worse). This module resolves a **redacted** identity for the database the
// server is connected to: host and database name only.
//
// Redaction is the whole point: the connection string carries the database
// user and password. Neither may ever reach the client, a log line, or a test
// snapshot, so `describeDatabaseTarget` extracts three fields by hand rather
// than passing anything through that could carry credentials along with it.

export type DatabaseTarget = {
  /** Human-readable environment name, e.g. "production" or "development". */
  environment: string;
  /** True when this process is running as a Replit deployment (published app). */
  deployment: boolean;
  /** Database host, no credentials. "unknown" when it cannot be parsed. */
  host: string;
  /** Database name, no credentials. "unknown" when it cannot be parsed. */
  database: string;
  /** Port, when the connection string carries one. */
  port: number | null;
  /**
   * Always true. A literal marker that this payload is the redacted view and
   * never the connection string, so a reader (or a test) can assert on it.
   */
  redacted: true;
};

/**
 * Extract host + database name from a Postgres connection string.
 *
 * Everything else — user, password, query parameters — is dropped on the
 * floor. An unparsable or missing string yields "unknown" rather than an
 * exception, because a migrations page that cannot name its database must
 * still render (and say so) instead of 500ing.
 */
export function describeDatabaseTarget(
  connectionString: string | undefined,
  opts: { environment: string; deployment: boolean },
): DatabaseTarget {
  const base = {
    environment: opts.environment,
    deployment: opts.deployment,
    redacted: true as const,
  };
  if (!connectionString) {
    return { ...base, host: 'unknown', database: 'unknown', port: null };
  }
  try {
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return {
      ...base,
      host: url.hostname || 'unknown',
      database: database || 'unknown',
      port: url.port ? Number.parseInt(url.port, 10) : null,
    };
  } catch {
    return { ...base, host: 'unknown', database: 'unknown', port: null };
  }
}

/** Environment name for this process. Deployments are "production". */
export function resolveEnvironmentName(env: NodeJS.ProcessEnv = process.env): {
  environment: string;
  deployment: boolean;
} {
  const deployment = env.REPLIT_DEPLOYMENT === '1';
  if (deployment) return { environment: 'production', deployment: true };
  return { environment: env.NODE_ENV || 'development', deployment: false };
}

/** The redacted identity of the database this process is connected to. */
export function currentDatabaseTarget(env: NodeJS.ProcessEnv = process.env): DatabaseTarget {
  return describeDatabaseTarget(env.DATABASE_URL, resolveEnvironmentName(env));
}
