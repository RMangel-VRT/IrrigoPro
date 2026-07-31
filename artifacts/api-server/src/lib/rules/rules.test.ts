// Task #571 — lock in the 8 incident detection rules so a regression in any
// rule (wrong threshold, wrong fingerprint, missed window) blows up CI
// instead of silently going dark in production.
//
// Each rule is exercised against the real Postgres dev DB. To keep us out
// of the way of real telemetry / other test runs, we tag every row we
// insert with a unique sentinel that lives in `context._test`,
// `details._test`, or a unique fingerprint / clock-number prefix, and we
// scope the time window to a `now` that's set far in the future so the
// rule's `since = now - WINDOW` cutoff is also in the future and excludes
// any pre-existing rows. Cleanup nukes every row carrying our tag.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../../db";
import { photoUploadFailureRateRule } from "./photo-upload-failure-rate";
import { errorRateSpikeRule } from "./error-rate-spike";
import { syncQueueStuckRule } from "./sync-queue-stuck";
import { apiP95BreachRule } from "./api-p95-breach";
import { regressionAfterDeployRule } from "./regression-after-deploy";
import { integrationDownRule } from "./integration-down";
import { authBruteForceRule } from "./auth-brute-force";
import { tenantIsolatedFailureRule } from "./tenant-isolated-failure";

const TAG = `t571-${randomUUID()}`;

// Far-future "now" — the rules' time-windowed queries (`since = now - 10m`)
// will sit ~178 years in the future, so no real telemetry can pollute the
// results.
const FUTURE = new Date("2200-01-01T00:00:00Z");

function fpFor(label: string): string {
  return `${TAG}-${label}`;
}

async function deleteByTag(): Promise<void> {
  // client_errors — rows tagged via context._test
  await db.execute(sql`
    DELETE FROM client_errors WHERE context->>'_test' = ${TAG}
  `);
  // audit_log — rows tagged via details._test
  await db.execute(sql`
    DELETE FROM audit_log WHERE details->>'_test' = ${TAG}
  `);
  // app_event_groups — fingerprints we coined start with our tag
  await db.execute(sql`
    DELETE FROM app_event_groups WHERE fingerprint LIKE ${`${TAG}%`}
  `);
  // field_work_sessions, property_zones, zones dropped by Task #1857 — no cleanup needed.
}

before(async () => {
  await deleteByTag();
});

after(async () => {
  await deleteByTag();
});

// ─── photo_upload_failure_rate ────────────────────────────────────────────
describe("photoUploadFailureRateRule", () => {
  it("does not fire below the minimum-attempts floor", async () => {
    // Tagged window starts cleanly — only 5 failures, well below MIN=20.
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('photo.upload.compress.failed', 'x', ${new Date(FUTURE.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'web')
      `);
    }
    const out = await photoUploadFailureRateRule.evaluate(FUTURE);
    assert.equal(out.firing, false, "must not fire under MIN_ATTEMPTS");
  });

  it("fires when failures exceed 5% of >=20 attempts", async () => {
    // 19 ok + 6 failed = 25 attempts, 24% failure → firing.
    for (let i = 0; i < 19; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source, company_id, user_id)
        VALUES ('photo.upload.compress.ok', 'x', ${new Date(FUTURE.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'web', 9991, 7771)
      `);
    }
    for (let i = 0; i < 6; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source, company_id, user_id)
        VALUES ('photo.upload.compress.failed', 'x', ${new Date(FUTURE.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'web', 9991, 7771)
      `);
    }
    const out = await photoUploadFailureRateRule.evaluate(FUTURE);
    assert.equal(out.firing, true);
    assert.ok(out.summary.includes("Photo upload failures"));
    assert.equal((out.details as { total: number }).total, 30); // 5 fails from prev + 25 here
    assert.ok(out.affectedCompanies?.includes(9991));
    assert.ok(out.affectedUsers?.includes(7771));
  });
});

// ─── error_rate_spike ─────────────────────────────────────────────────────
describe("errorRateSpikeRule", () => {
  const NOW = new Date("2200-01-02T00:00:00Z");
  it("does not fire below the minimum-requests floor", async () => {
    for (let i = 0; i < 10; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('http.5xx', 'x', ${new Date(NOW.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'api')
      `);
    }
    const out = await errorRateSpikeRule.evaluate(NOW);
    assert.equal(out.firing, false);
  });

  it("fires when 5xx exceeds 2% over >=50 requests", async () => {
    // Already 10 5xx in the window; add 40 ok + 5 more 5xx → 55 reqs, 15 5xx (27%)
    for (let i = 0; i < 40; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('http.ok', 'x', ${new Date(NOW.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'api')
      `);
    }
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('http.5xx', 'x', ${new Date(NOW.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'api')
      `);
    }
    const out = await errorRateSpikeRule.evaluate(NOW);
    assert.equal(out.firing, true);
    assert.ok(out.summary.includes("API 5xx rate"));
  });

  it("does not fire when error rate stays under 2%", async () => {
    // Fresh future window — 60 ok + 1 5xx = 1.6%
    const N = new Date("2200-01-03T00:00:00Z");
    for (let i = 0; i < 60; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('http.ok', 'x', ${new Date(N.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'api')
      `);
    }
    await db.execute(sql`
      INSERT INTO client_errors (name, message, occurred_at, context, source)
      VALUES ('http.5xx', 'x', ${new Date(N.getTime() - 60_000)},
              ${{ _test: TAG }}::jsonb, 'api')
    `);
    const out = await errorRateSpikeRule.evaluate(N);
    assert.equal(out.firing, false);
  });
});

// ─── api_p95_breach ───────────────────────────────────────────────────────
describe("apiP95BreachRule", () => {
  const NOW = new Date("2200-02-01T00:00:00Z");
  it("does not fire under MIN_SAMPLES (20) http.slow events", async () => {
    for (let i = 0; i < 10; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('http.slow', 'x', ${new Date(NOW.getTime() - 60_000)},
                ${{ _test: TAG, duration_ms: 5000 }}::jsonb, 'api')
      `);
    }
    const out = await apiP95BreachRule.evaluate(NOW);
    assert.equal(out.firing, false);
  });

  it("fires when p95 exceeds 2000ms with enough samples", async () => {
    // Already 10 @5000ms; add 12 more @5000ms + 3 @100ms = 25 samples,
    // p95 well over 2000ms.
    for (let i = 0; i < 12; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('http.slow', 'x', ${new Date(NOW.getTime() - 60_000)},
                ${{ _test: TAG, duration_ms: 5000 }}::jsonb, 'api')
      `);
    }
    for (let i = 0; i < 3; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('http.slow', 'x', ${new Date(NOW.getTime() - 60_000)},
                ${{ _test: TAG, duration_ms: 100 }}::jsonb, 'api')
      `);
    }
    const out = await apiP95BreachRule.evaluate(NOW);
    assert.equal(out.firing, true);
    assert.ok((out.details as { p95Ms: number }).p95Ms > 2000);
  });

  it("does not fire when p95 is below the threshold", async () => {
    const N = new Date("2200-02-02T00:00:00Z");
    for (let i = 0; i < 25; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source)
        VALUES ('http.slow', 'x', ${new Date(N.getTime() - 60_000)},
                ${{ _test: TAG, duration_ms: 1100 }}::jsonb, 'api')
      `);
    }
    const out = await apiP95BreachRule.evaluate(N);
    assert.equal(out.firing, false);
  });
});

// ─── integration_down ─────────────────────────────────────────────────────
describe("integrationDownRule", () => {
  const NOW = new Date("2200-03-01T00:00:00Z");
  it("does not fire at the threshold (5 events)", async () => {
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source, severity)
        VALUES ('integration.quickbooks.failed', 'x', ${new Date(NOW.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'integration', 'error')
      `);
    }
    const out = await integrationDownRule.evaluate(NOW);
    assert.equal(out.firing, false, "rule wants > 5, exactly 5 should not fire");
  });

  it("fires when an integration crosses 5 failures", async () => {
    // already 5; add 1 more = 6 → > 5
    await db.execute(sql`
      INSERT INTO client_errors (name, message, occurred_at, context, source, severity)
      VALUES ('integration.quickbooks.failed', 'x', ${new Date(NOW.getTime() - 60_000)},
              ${{ _test: TAG }}::jsonb, 'integration', 'error')
    `);
    const out = await integrationDownRule.evaluate(NOW);
    assert.equal(out.firing, true);
    assert.ok(out.summary.includes("integration.quickbooks.failed"));
  });
});

// ─── auth_brute_force ─────────────────────────────────────────────────────
describe("authBruteForceRule", () => {
  const NOW = new Date("2200-04-01T00:00:00Z");
  it("does not fire at <=10 fails for one user", async () => {
    for (let i = 0; i < 10; i++) {
      await db.execute(sql`
        INSERT INTO audit_log (occurred_at, actor_user_id, actor_label, actor_company_id,
                               action_type, action, severity, summary, details)
        VALUES (${new Date(NOW.getTime() - 60_000)}, 90001, 'evil@example.com', 9991,
                'auth', 'auth.login_failed', 'warning', 'fail',
                ${{ _test: TAG }}::jsonb)
      `);
    }
    const out = await authBruteForceRule.evaluate(NOW);
    assert.equal(out.firing, false);
  });

  it("fires when one account crosses 10 failed logins", async () => {
    await db.execute(sql`
      INSERT INTO audit_log (occurred_at, actor_user_id, actor_label, actor_company_id,
                             action_type, action, severity, summary, details)
      VALUES (${new Date(NOW.getTime() - 60_000)}, 90001, 'evil@example.com', 9991,
              'auth', 'auth.login_failed', 'warning', 'fail',
              ${{ _test: TAG }}::jsonb)
    `);
    const out = await authBruteForceRule.evaluate(NOW);
    assert.equal(out.firing, true);
    assert.ok(out.affectedUsers?.includes(90001));
    assert.ok(out.affectedCompanies?.includes(9991));
  });
});

// ─── tenant_isolated_failure ──────────────────────────────────────────────
describe("tenantIsolatedFailureRule", () => {
  const NOW = new Date("2200-05-01T00:00:00Z");
  it("does not fire when errors are evenly distributed", async () => {
    for (const co of [11001, 11002, 11003]) {
      for (let i = 0; i < 25; i++) {
        await db.execute(sql`
          INSERT INTO client_errors (name, message, occurred_at, context, source, severity, company_id)
          VALUES ('boom', 'x', ${new Date(NOW.getTime() - 60_000)},
                  ${{ _test: TAG }}::jsonb, 'web', 'error', ${co})
        `);
      }
    }
    const out = await tenantIsolatedFailureRule.evaluate(NOW);
    assert.equal(out.firing, false);
  });

  it("fires when one tenant produces >=5x the cross-tenant average", async () => {
    // Use a fresh future window so we control the entire denominator.
    // Need >= MIN_TENANT_ERRORS=20 from the breaching tenant AND its
    // count >= 5x the cross-tenant average. With 1 big tenant (200) and
    // 9 small tenants (1 each), avg = 209/10 ≈ 20.9, 200/20.9 ≈ 9.6x → fires.
    const N = new Date("2200-05-15T00:00:00Z");
    for (let i = 0; i < 200; i++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source, severity, company_id)
        VALUES ('boom', 'x', ${new Date(N.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'web', 'error', 12001)
      `);
    }
    for (let co = 12002; co <= 12010; co++) {
      await db.execute(sql`
        INSERT INTO client_errors (name, message, occurred_at, context, source, severity, company_id)
        VALUES ('boom', 'x', ${new Date(N.getTime() - 60_000)},
                ${{ _test: TAG }}::jsonb, 'web', 'error', ${co})
      `);
    }
    const out = await tenantIsolatedFailureRule.evaluate(N);
    assert.equal(out.firing, true);
    assert.ok(out.affectedCompanies?.includes(12001));
  });
});

// ─── sync_queue_stuck ─────────────────────────────────────────────────────
// Task #1857: field_work_sessions dropped → rule always returns non-firing.
describe("syncQueueStuckRule", () => {
  it("always returns non-firing after field_work_sessions was retired", async () => {
    const out = await syncQueueStuckRule.evaluate(new Date());
    assert.equal(out.firing, false, "Rule must not fire — field portal retired");
  });
});

// ─── regression_after_deploy ──────────────────────────────────────────────
describe("regressionAfterDeployRule", () => {
  it("does not fire without a recent deploy", async () => {
    // Make sure there's no fake deploy row from us; the rule uses now()
    // (DB time) so unrelated real deploys could in theory cause it to
    // fire. We can't blindly assert false in a shared DB — instead we
    // assert that absence-of-our-fingerprints means our regression
    // groups never appear in the details.
    const out = await regressionAfterDeployRule.evaluate(new Date());
    if (out.firing) {
      const regs = (out.details as { regressions: { fingerprint: string }[] }).regressions;
      for (const r of regs) {
        assert.equal(r.fingerprint.startsWith(TAG), false);
      }
    }
  });

  it("fires when a fresh fingerprint crosses the user threshold post-deploy", async () => {
    // Fake a deploy in the audit_log, then create an app_event_groups
    // row with first_seen_at after the deploy and user_count > 5 and
    // severity in (error,fatal). The rule should pick it up and flip
    // is_regression on the group.
    // Insert our deploy at "now()" so it wins LIMIT 1 ORDER BY occurred_at DESC
    // even if a real deploy.production row exists in the dev DB.
    await db.execute(sql`
      INSERT INTO audit_log (occurred_at, action_type, action, severity, summary, details)
      VALUES (now(), 'system', 'deploy.production', 'info',
              'test deploy', ${{ _test: TAG, appVersion: TAG }}::jsonb)
    `);
    const fp = fpFor("regression");
    // first_seen_at must be >= the deploy's occurred_at. Use now() so it
    // reads as "after" or simultaneous with the deploy row above.
    await db.execute(sql`
      INSERT INTO app_event_groups
        (fingerprint, name, severity, type, source, first_seen_at, last_seen_at,
         event_count, user_count, company_count, status, is_regression)
      VALUES (${fp}, 'TypeError: oops', 'error', 'error', 'web',
              now(), now(),
              25, 9, 3, 'open', false)
    `);
    const out = await regressionAfterDeployRule.evaluate(new Date());
    assert.equal(out.firing, true, `expected firing=true, got ${JSON.stringify(out)}`);
    const fingerprints = (out.details as {
      regressions: { fingerprint: string }[];
    }).regressions.map((r) => r.fingerprint);
    assert.ok(fingerprints.includes(fp));
    // The rule's side-effect must have flipped the flag.
    const flagged = await db.execute<{ isRegression: boolean }>(sql`
      SELECT is_regression AS "isRegression" FROM app_event_groups
      WHERE fingerprint = ${fp}
    `);
    assert.equal(flagged.rows![0].isRegression, true,
      `expected is_regression=true after rule fired, got ${JSON.stringify(flagged.rows![0])}`);
  });
});
