/**
 * db-connection-errors.test.ts (Task #1898)
 *
 * A failure to *obtain* a pooled connection is not a query error: the data is
 * fine, the server just could not get a client. Several storage list readers
 * catch-and-return-[] so a transient hiccup does not blank a page — but that
 * turned a pool timeout into HTTP 200 with an empty list, which the UI drew
 * as "No work orders yet". Silent, intermittent, never reported.
 *
 * `isConnectionAcquisitionError` is the narrow classifier those catch blocks
 * consult before degrading. Getting it wrong in either direction is bad:
 *   - too narrow, and pool timeouts stay silent;
 *   - too broad, and ordinary query failures start 500ing pages that used to
 *     survive them.
 * These tests pin both edges.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isConnectionAcquisitionError } from "@workspace/db";

describe("isConnectionAcquisitionError (Task #1898)", () => {
  it("matches node-postgres' pool queue timeout", () => {
    // This is the literal error from the production incident. pg-pool throws
    // a bare Error with no `code`, so message matching is the only signal.
    assert.equal(
      isConnectionAcquisitionError(new Error("timeout exceeded when trying to connect")),
      true,
    );
  });

  it("matches the connection-establishment timeout", () => {
    assert.equal(
      isConnectionAcquisitionError(
        new Error("Connection terminated due to connection timeout"),
      ),
      true,
    );
  });

  it("unwraps a drizzle-wrapped cause chain", () => {
    // Drizzle wraps driver errors in DrizzleQueryError and hangs the original
    // off `cause`. Matching only the outer message would miss every real case.
    const inner = new Error("timeout exceeded when trying to connect");
    const outer = new Error("Failed query: select * from work_orders", { cause: inner });
    assert.equal(isConnectionAcquisitionError(outer), true);
  });

  it("unwraps more than one level of cause", () => {
    const inner = new Error("timeout exceeded when trying to connect");
    const mid = new Error("driver error", { cause: inner });
    const outer = new Error("Failed query", { cause: mid });
    assert.equal(isConnectionAcquisitionError(outer), true);
  });

  it("matches socket-level failures to reach the database", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND"]) {
      const err = Object.assign(new Error("socket failure"), { code });
      assert.equal(isConnectionAcquisitionError(err), true, `expected ${code} to match`);
    }
  });

  it("matches the server refusing new connections", () => {
    for (const code of ["53300", "57P03"]) {
      const err = Object.assign(new Error("server said no"), { code });
      assert.equal(isConnectionAcquisitionError(err), true, `expected ${code} to match`);
    }
  });

  it("does NOT match an ordinary query error", () => {
    // 42703 = undefined_column. These must keep degrading to [] exactly as
    // before — this change is deliberately scoped to acquisition failures.
    const err = Object.assign(new Error('column "nope" does not exist'), { code: "42703" });
    assert.equal(isConnectionAcquisitionError(err), false);
  });

  it("does NOT match a constraint violation or a plain error", () => {
    const unique = Object.assign(new Error("duplicate key"), { code: "23505" });
    assert.equal(isConnectionAcquisitionError(unique), false);
    assert.equal(isConnectionAcquisitionError(new Error("something else broke")), false);
  });

  it("tolerates non-error values without throwing", () => {
    assert.equal(isConnectionAcquisitionError(null), false);
    assert.equal(isConnectionAcquisitionError(undefined), false);
    assert.equal(isConnectionAcquisitionError("timeout exceeded when trying to connect"), false);
    assert.equal(isConnectionAcquisitionError(42), false);
  });

  it("terminates on a self-referential cause chain", () => {
    // Defensive: a cycle here would hang a request thread inside a catch block.
    const err: Error & { cause?: unknown } = new Error("boom");
    err.cause = err;
    assert.equal(isConnectionAcquisitionError(err), false);
  });
});
