// Repair usernames that carry invisible Unicode.
//
// A production bookkeeper account was stored as "3035480337" + U+202D
// (LEFT-TO-RIGHT OVERRIDE). Login resolves an account by username, so the row
// matched only when the username was pasted (carrying the hidden character) and
// never when it was typed. The symptom presented as a flaky password: it worked
// sporadically for the person who pasted and never for the person who typed,
// with the same credentials. Password resets could not fix it, because password
// writes go by user id while the failing lookup happens earlier, by username.
//
// `lib/normalize-username.ts` now strips these characters on every write, so no
// NEW row can be corrupted. This migration repairs the rows that already exist.
//
// Normalisation is done in JavaScript with the very same helper the login path
// uses, rather than as a hand-written SQL regex. If the two ever disagreed, the
// repair would "fix" a row into a value login still could not find — so there
// is deliberately only one definition of what a clean username is.
//
// Collision safety: normalising could in principle map two distinct rows onto
// the same username (e.g. "bob" and "bob\u200B", or two rows differing only in
// case). Rewriting either one would create an ambiguous login. Such rows are
// reported and skipped rather than merged — deciding which account is the real
// one is a human call, not a migration's.
//
// Idempotent: once every username is already normalised there is nothing to do.

import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { appSettings, users } from '@workspace/db/schema';
import { eq } from 'drizzle-orm';
import { normalizeUsername, describeUsername } from '../normalize-username';
import type {
  MigrationDefinition,
  MigrationStatus,
  MigrationPreview,
  MigrationStepResult,
  ProgressEmitter,
} from './types';

const MIGRATION_ID = 'normalize-usernames-v1';
export const APP_KEY = 'normalizeUsernames.done';

type UserRow = { id: number; username: string };

/** A row whose stored username differs from its normalised form. */
export type Corrupted = {
  id: number;
  stored: string;
  normalized: string;
  /** Human-readable form with invisible characters spelled out. */
  display: string;
};

/**
 * Split the affected rows into those that are safe to rewrite and those whose
 * rewrite would collide with another account.
 *
 * A collision is judged case-insensitively against the post-normalisation value
 * of EVERY row (not just the corrupted ones), because login compares
 * case-insensitively — "Bob" and "bob\u200B" both resolve to the same account
 * as far as the lookup is concerned.
 *
 * Exported for direct testing: this is the part with the interesting edge cases,
 * and it is pure.
 */
export function planRepair(rows: UserRow[]): {
  repairable: Corrupted[];
  colliding: Corrupted[];
} {
  const corrupted: Corrupted[] = [];
  for (const row of rows) {
    const normalized = normalizeUsername(row.username);
    if (normalized !== row.username) {
      corrupted.push({
        id: row.id,
        stored: row.username,
        normalized,
        display: describeUsername(row.username),
      });
    }
  }

  // How many rows would end up on each normalised key once the repair is done.
  const occupancy = new Map<string, number>();
  for (const row of rows) {
    const key = normalizeUsername(row.username).toLowerCase();
    occupancy.set(key, (occupancy.get(key) ?? 0) + 1);
  }

  const repairable: Corrupted[] = [];
  const colliding: Corrupted[] = [];
  for (const row of corrupted) {
    // An empty normalisation (a username made only of invisible characters)
    // is never safe to write — it would be unusable and could match a blank
    // submission.
    if (row.normalized === '' || (occupancy.get(row.normalized.toLowerCase()) ?? 0) > 1) {
      colliding.push(row);
    } else {
      repairable.push(row);
    }
  }
  return { repairable, colliding };
}

async function loadUsers(): Promise<UserRow[]> {
  const rows = await db.select({ id: users.id, username: users.username }).from(users);
  return rows.map((r) => ({ id: r.id, username: r.username ?? '' }));
}

// ── check ───────────────────────────────────────────────────────────────────

async function readMarker(): Promise<{ completedAt: string } | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, APP_KEY))
    .limit(1);
  if (rows.length === 0) return null;
  const raw = rows[0].value as unknown;
  let val: any = raw;
  if (typeof raw === 'string') {
    try {
      val = JSON.parse(raw);
    } catch {
      return { completedAt: raw };
    }
  }
  return { completedAt: (typeof val === 'string' ? val : val?.completedAt) ?? '' };
}

async function writeMarker(payload: Record<string, unknown>): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: APP_KEY, value: payload } as any)
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: payload, updatedAt: new Date() } as any,
    });
}

async function check(): Promise<MigrationStatus> {
  let plan: ReturnType<typeof planRepair>;
  try {
    plan = planRepair(await loadUsers());
  } catch (err) {
    return {
      state: 'error',
      details: `check() failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (plan.repairable.length === 0 && plan.colliding.length === 0) {
    return { state: 'completed', completedAt: (await readMarker())?.completedAt ?? '' };
  }

  // Rows this migration refuses to touch are reported as partially applied
  // rather than not started, so they stay visible on the admin page instead of
  // looking like work that simply has not been attempted.
  if (plan.repairable.length === 0) {
    return {
      state: 'partially_applied',
      details:
        `${plan.colliding.length} username(s) need manual attention — normalising them would ` +
        `collide with another account: ${plan.colliding.map((r) => `#${r.id} "${r.display}"`).join(', ')}.`,
    };
  }

  const marker = await readMarker();
  if (marker == null) {
    return { state: 'not_started' };
  }

  // A marker exists but corrupted rows remain — a previous run skipped them, or
  // new ones appeared. Report what is outstanding rather than claiming success.
  const details =
    `${plan.repairable.length} username(s) carry invisible characters: ` +
    plan.repairable.map((r) => `#${r.id} "${r.display}" → "${r.normalized}"`).join(', ') +
    (plan.colliding.length > 0
      ? `; ${plan.colliding.length} further row(s) would collide and will be skipped.`
      : '.');
  return { state: 'partially_applied', details };
}

// ── preview ─────────────────────────────────────────────────────────────────

const STEPS = [
  {
    id: 'normalize-usernames',
    description:
      'Rewrite each username that carries invisible Unicode to its normalised form, skipping any rewrite that would collide with another account',
  },
  {
    id: 'mark-done',
    description: 'Stamp completion marker in app_settings',
  },
];

async function preview(): Promise<MigrationPreview> {
  const { repairable, colliding } = planRepair(await loadUsers());

  const warnings: string[] = [];
  if (repairable.length === 0 && colliding.length === 0) {
    warnings.push('Nothing to do — every username is already clean.');
  }
  for (const row of repairable) {
    warnings.push(
      `User #${row.id}: "${row.display}" → "${row.normalized}" ` +
        `(${row.stored.length} chars → ${row.normalized.length}). ` +
        `After this, the username can be typed by hand and still match at login.`,
    );
  }
  for (const row of colliding) {
    warnings.push(
      `SKIPPED — User #${row.id}: "${row.display}" would normalise to "${row.normalized}", ` +
        `which is not uniquely assignable. Resolve this account by hand.`,
    );
  }
  warnings.push(
    'Usernames are login identifiers. Anyone currently signing in by PASTING an affected ' +
      'username will still succeed afterwards, because the login path normalises what it is ' +
      'given before looking the account up. Existing sessions are unaffected.',
  );

  return {
    steps: STEPS,
    orphanRows: {
      usernamesToNormalize: repairable.length,
      usernamesSkippedAsColliding: colliding.length,
    },
    warnings,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

async function run(emit: ProgressEmitter): Promise<MigrationStepResult[]> {
  const results: MigrationStepResult[] = [];

  // No acknowledgement gate: this migration touches no financial data, and the
  // rewrite strictly widens who can sign in (a pasted username still matches
  // afterwards, a typed one starts matching). Leaving it gated would keep
  // locked-out users locked out behind a second click.

  const t1 = Date.now();
  emit({ step: STEPS[0].id, status: 'running' });

  let repaired = 0;
  let skipped = 0;
  try {
    const { repairable, colliding } = planRepair(await loadUsers());
    skipped = colliding.length;

    for (const row of repairable) {
      // Guarded by id, and re-checked against the exact stored value so a
      // concurrent edit cannot be clobbered.
      const result = await db.execute(sql`
        UPDATE users
        SET username = ${row.normalized}, updated_at = NOW()
        WHERE id = ${row.id} AND username = ${row.stored}
      `);
      repaired += Number((result as any)?.rowCount ?? 0);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ step: STEPS[0].id, status: 'failed', error: message });
    results.push({
      id: STEPS[0].id,
      status: 'failed',
      durationMs: Date.now() - t1,
      error: message,
    });
    return results;
  }

  emit({ step: STEPS[0].id, status: 'success', rowsAffected: repaired });
  results.push({
    id: STEPS[0].id,
    status: 'success',
    durationMs: Date.now() - t1,
    rowsAffected: repaired,
  });

  const t2 = Date.now();
  emit({ step: STEPS[1].id, status: 'running' });
  const completedAt = new Date().toISOString();
  await writeMarker({ completedAt, usernamesNormalized: repaired, skippedAsColliding: skipped });
  emit({ step: STEPS[1].id, status: 'success' });
  results.push({ id: STEPS[1].id, status: 'success', durationMs: Date.now() - t2 });

  return results;
}

export const normalizeUsernamesMigration: MigrationDefinition = {
  id: MIGRATION_ID,
  title: 'Repair usernames containing invisible characters',
  description:
    'Strips invisible Unicode (bidi overrides, zero-width spaces, byte order marks, soft hyphens) ' +
    'from stored usernames. Such a username matches at login only when pasted and never when typed, ' +
    'which presents as an account whose password appears to work for one person and not another. ' +
    'Rewrites that would collide with another account are reported and skipped. Idempotent.',
  appSettingsKey: APP_KEY,
  check,
  preview,
  run,
};
