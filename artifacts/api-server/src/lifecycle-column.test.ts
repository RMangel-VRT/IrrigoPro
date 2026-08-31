// Task #642 — Unit tests for the dual-write lifecycle column contract.
//
// Two invariants this guards:
//   1. `deriveLifecycleForWrite` maps every legacy (status, internalStatus)
//      pair to the right one of the five *stored* lifecycle values.
//   2. `computeLifecycleStatus` prefers the stored `lifecycle` column
//      when present, but always re-checks the 30-day expiry window for
//      `sent` so a row can flip to `expired` without a write.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeLifecycleStatus,
  deriveLifecycleForWrite,
  ESTIMATE_EXPIRATION_DAYS,
  estimateExpiryAnchor,
} from "@workspace/shared";

describe("deriveLifecycleForWrite (Task #642)", () => {
  it("maps draft internalStatus to draft", () => {
    assert.equal(
      deriveLifecycleForWrite({ status: "pending", internalStatus: "draft" }),
      "draft",
    );
  });

  it("maps pending_approval / approved_internal to pending_review", () => {
    assert.equal(
      deriveLifecycleForWrite({ status: "pending", internalStatus: "pending_approval" }),
      "pending_review",
    );
    assert.equal(
      deriveLifecycleForWrite({ status: "pending", internalStatus: "approved_internal" }),
      "pending_review",
    );
  });

  it("maps sent_to_customer + pending to sent", () => {
    assert.equal(
      deriveLifecycleForWrite({ status: "pending", internalStatus: "sent_to_customer" }),
      "sent",
    );
  });

  it("maps approved/rejected status regardless of internalStatus", () => {
    assert.equal(
      deriveLifecycleForWrite({ status: "approved", internalStatus: "sent_to_customer" }),
      "approved",
    );
    assert.equal(
      deriveLifecycleForWrite({ status: "rejected", internalStatus: "sent_to_customer" }),
      "rejected",
    );
  });

  it("never returns expired (read-time view only)", () => {
    // Even pre-migration rows whose legacy `status='expired'` was set on
    // token expiry must derive to one of the five stored buckets.
    const out = deriveLifecycleForWrite({
      status: "expired",
      internalStatus: "sent_to_customer",
    });
    assert.notEqual(out, "expired");
    assert.equal(out, "pending_review");
  });
});

describe("computeLifecycleStatus prefers stored lifecycle column (Task #642)", () => {
  it("returns the stored value when present (approved)", () => {
    // Stored column says approved, legacy axes still pending — the
    // column wins. This is the post-backfill steady state.
    assert.equal(
      computeLifecycleStatus({
        status: "pending",
        internalStatus: "pending_approval",
        lifecycle: "approved",
      }),
      "approved",
    );
  });

  it("falls back to deriving when the column is missing", () => {
    assert.equal(
      computeLifecycleStatus({
        status: "approved",
        internalStatus: "sent_to_customer",
      }),
      "approved",
    );
  });

  it("ignores an invalid stored value and falls back to derivation", () => {
    assert.equal(
      computeLifecycleStatus({
        status: "rejected",
        internalStatus: "sent_to_customer",
        lifecycle: "garbage",
      }),
      "rejected",
    );
  });

  it("re-checks expiry for stored 'sent' against estimateDate when never-recorded send", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const oldDate = new Date(
      now.getTime() - (ESTIMATE_EXPIRATION_DAYS + 1) * 86400 * 1000,
    );
    assert.equal(
      computeLifecycleStatus(
        {
          status: "pending",
          internalStatus: "sent_to_customer",
          lifecycle: "sent",
          estimateDate: oldDate,
        },
        now,
      ),
      "expired",
    );
    // A freshly-sent estimate stays `sent`.
    assert.equal(
      computeLifecycleStatus(
        {
          status: "pending",
          internalStatus: "sent_to_customer",
          lifecycle: "sent",
          estimateDate: now,
        },
        now,
      ),
      "sent",
    );
  });

  it("does not re-check expiry for non-sent stored values", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const oldDate = new Date(
      now.getTime() - (ESTIMATE_EXPIRATION_DAYS + 1) * 86400 * 1000,
    );
    assert.equal(
      computeLifecycleStatus(
        {
          status: "pending",
          internalStatus: "pending_approval",
          lifecycle: "pending_review",
          estimateDate: oldDate,
        },
        now,
      ),
      "pending_review",
    );
  });
});

// Task #1955 — the 30-day expiry window runs from the last send
// (`approvalSentAt`), not from `estimateDate` (which defaults to
// creation). `estimateDate` remains the fallback for rows sent before
// the send timestamp was reliably recorded.
describe("expiry anchors on the send date (Task #1955)", () => {
  const NOW = new Date("2026-02-01T00:00:00Z");
  const daysBefore = (n: number) =>
    new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  const sentEstimate = (fields: {
    estimateDate?: Date | null;
    approvalSentAt?: Date | null;
  }) => ({
    status: "pending",
    internalStatus: "sent_to_customer",
    lifecycle: "sent",
    estimateDate: fields.estimateDate ?? null,
    approvalSentAt: fields.approvalSentAt ?? null,
  });

  it("created 40 days ago but sent today is still awaiting the customer", () => {
    assert.equal(
      computeLifecycleStatus(
        sentEstimate({ estimateDate: daysBefore(40), approvalSentAt: NOW }),
        NOW,
      ),
      "sent",
    );
  });

  it("sent 31 days ago is expired even with a fresh estimate date", () => {
    assert.equal(
      computeLifecycleStatus(
        sentEstimate({
          estimateDate: daysBefore(1),
          approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS + 1),
        }),
        NOW,
      ),
      "expired",
    );
  });

  it("exactly 30 days after sending is still live (inclusive boundary)", () => {
    assert.equal(
      computeLifecycleStatus(
        sentEstimate({
          estimateDate: daysBefore(90),
          approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS),
        }),
        NOW,
      ),
      "sent",
    );
  });

  it("falls back to the estimate date when there is no recorded send time", () => {
    assert.equal(
      computeLifecycleStatus(
        sentEstimate({
          estimateDate: daysBefore(ESTIMATE_EXPIRATION_DAYS + 1),
          approvalSentAt: null,
        }),
        NOW,
      ),
      "expired",
    );
    assert.equal(
      computeLifecycleStatus(
        sentEstimate({
          estimateDate: daysBefore(ESTIMATE_EXPIRATION_DAYS),
          approvalSentAt: null,
        }),
        NOW,
      ),
      "sent",
    );
  });

  it("a re-send moves the expiry boundary forward without a write", () => {
    const beforeResend = sentEstimate({
      estimateDate: daysBefore(60),
      approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS + 5),
    });
    assert.equal(computeLifecycleStatus(beforeResend, NOW), "expired");
    // Re-delivering a still-live estimate re-stamps `approvalSentAt`
    // only — `estimateDate` is untouched — and the row rolls back to
    // `sent`.
    const afterResend = { ...beforeResend, approvalSentAt: NOW };
    assert.equal(computeLifecycleStatus(afterResend, NOW), "sent");
  });

  it("accepts ISO string send timestamps (JSON-serialized rows)", () => {
    assert.equal(
      computeLifecycleStatus(
        {
          status: "pending",
          internalStatus: "sent_to_customer",
          lifecycle: "sent",
          estimateDate: daysBefore(60).toISOString(),
          approvalSentAt: daysBefore(1).toISOString(),
        },
        NOW,
      ),
      "sent",
    );
  });

  it("estimateExpiryAnchor prefers the send time and ignores invalid dates", () => {
    assert.deepEqual(
      estimateExpiryAnchor({
        approvalSentAt: daysBefore(2),
        estimateDate: daysBefore(40),
      }),
      daysBefore(2),
    );
    assert.deepEqual(
      estimateExpiryAnchor({ approvalSentAt: null, estimateDate: daysBefore(40) }),
      daysBefore(40),
    );
    assert.equal(
      estimateExpiryAnchor({ approvalSentAt: "not-a-date", estimateDate: null }),
      null,
    );
    assert.equal(estimateExpiryAnchor(null), null);
  });
});
