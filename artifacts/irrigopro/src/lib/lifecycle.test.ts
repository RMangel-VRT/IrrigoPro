// Task #638 — Unit tests for the canonical lifecycle helpers.
//
// `computeLifecycleStatus` + the predicate wrappers below are the only
// way the UI is allowed to reason about estimate state. These tests
// pin every (status, internalStatus, age) combination the rest of the
// app cares about so regressions surface here instead of as visual
// drift across the board / list / dashboard tile.

import { describe, expect, it } from "vitest";

import {
  ESTIMATE_EXPIRATION_DAYS,
  LIFECYCLE_STATUSES,
  canDeleteEstimateAs,
  canDeleteLifecycle,
  computeLifecycleStatus,
  customerResponseLabel,
  customerResponseLabelOf,
  estimateExpiryAnchor,
  isApproved,
  isAwaitingCustomer,
  isAwaitingCustomerReply,
  isAwaitingInternalReview,
  isClosed,
  isConvertedToWorkOrder,
  isDraft,
  isExpired,
  isOpen,
  isPendingReview,
  isReadyToSend,
  isRejected,
  isSent,
  lifecycleOf,
  reviewStageLabel,
  reviewStageLabelOf,
  type LifecycleStatus,
} from "@workspace/shared";

const NOW = new Date("2026-05-15T12:00:00Z");
const FRESH = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day old
const STALE = new Date(
  NOW.getTime() - (ESTIMATE_EXPIRATION_DAYS + 1) * 24 * 60 * 60 * 1000,
);

function buckets(
  status: string,
  internalStatus: string,
  estimateDate: Date | null = FRESH,
): LifecycleStatus {
  return computeLifecycleStatus({ status, internalStatus, estimateDate }, NOW);
}

describe("computeLifecycleStatus", () => {
  it("status='approved' → approved (regardless of internalStatus)", () => {
    expect(buckets("approved", "draft")).toBe("approved");
    expect(buckets("approved", "pending_approval")).toBe("approved");
    expect(buckets("approved", "approved_internal")).toBe("approved");
    expect(buckets("approved", "sent_to_customer")).toBe("approved");
  });

  it("status='converted_to_work_order' → approved (folded into the approved bucket)", () => {
    expect(buckets("converted_to_work_order", "sent_to_customer")).toBe(
      "approved",
    );
    expect(buckets("converted_to_work_order", "approved_internal")).toBe(
      "approved",
    );
  });

  it("status='rejected' → rejected", () => {
    expect(buckets("rejected", "sent_to_customer")).toBe("rejected");
    expect(buckets("rejected", "draft")).toBe("rejected");
  });

  it("internalStatus='draft' (status=pending) → draft", () => {
    expect(buckets("pending", "draft")).toBe("draft");
  });

  it("sent_to_customer + status=pending + fresh → sent", () => {
    expect(buckets("pending", "sent_to_customer", FRESH)).toBe("sent");
  });

  it(`sent_to_customer + status=pending + age > ${ESTIMATE_EXPIRATION_DAYS}d → expired`, () => {
    expect(buckets("pending", "sent_to_customer", STALE)).toBe("expired");
  });

  it("sent_to_customer + status=pending + null date → sent (no age check)", () => {
    expect(buckets("pending", "sent_to_customer", null)).toBe("sent");
  });

  it("pending_approval + status=pending → pending_review", () => {
    expect(buckets("pending", "pending_approval")).toBe("pending_review");
  });

  it("approved_internal + status=pending → pending_review (Task #606 parity)", () => {
    expect(buckets("pending", "approved_internal")).toBe("pending_review");
  });

  it("empty / unknown values fall through to pending_review", () => {
    expect(buckets("pending", "")).toBe("pending_review");
    expect(buckets("", "")).toBe("pending_review");
    expect(buckets("pending", "weird-new-state")).toBe("pending_review");
  });
});

describe("lifecycleOf", () => {
  it("prefers the canonical lifecycle column over (status, internalStatus)", () => {
    expect(
      lifecycleOf(
        {
          status: "pending",
          internalStatus: "draft",
          estimateDate: FRESH,
          lifecycle: "sent",
        },
        NOW,
      ),
    ).toBe("sent");
  });

  it("ignores an invalid lifecycle column value and falls back to compute", () => {
    expect(
      lifecycleOf(
        {
          status: "pending",
          internalStatus: "draft",
          estimateDate: FRESH,
          lifecycle: "garbage",
        },
        NOW,
      ),
    ).toBe("draft");
  });

  it("handles null/undefined safely", () => {
    expect(lifecycleOf(null)).toBe("pending_review");
    expect(lifecycleOf(undefined)).toBe("pending_review");
  });

  it("accepts string date inputs", () => {
    expect(
      lifecycleOf(
        {
          status: "pending",
          internalStatus: "sent_to_customer",
          estimateDate: FRESH.toISOString(),
        },
        NOW,
      ),
    ).toBe("sent");
  });
});

describe("predicates accept either an estimate or a lifecycle string", () => {
  const draft = { status: "pending", internalStatus: "draft", estimateDate: FRESH };
  const pendingReview = {
    status: "pending",
    internalStatus: "pending_approval",
    estimateDate: FRESH,
  };
  const readyToSend = {
    status: "pending",
    internalStatus: "approved_internal",
    estimateDate: FRESH,
  };
  const sent = {
    status: "pending",
    internalStatus: "sent_to_customer",
    estimateDate: FRESH,
  };
  const expired = {
    status: "pending",
    internalStatus: "sent_to_customer",
    estimateDate: STALE,
  };
  const approved = {
    status: "approved",
    internalStatus: "sent_to_customer",
    estimateDate: FRESH,
  };
  const converted = {
    status: "converted_to_work_order",
    internalStatus: "sent_to_customer",
    estimateDate: FRESH,
  };
  const rejected = {
    status: "rejected",
    internalStatus: "sent_to_customer",
    estimateDate: FRESH,
  };

  it("isDraft", () => {
    expect(isDraft(draft, NOW)).toBe(true);
    expect(isDraft("draft")).toBe(true);
    expect(isDraft(pendingReview, NOW)).toBe(false);
  });

  it("isPendingReview matches both pending_approval and approved_internal", () => {
    expect(isPendingReview(pendingReview, NOW)).toBe(true);
    expect(isPendingReview(readyToSend, NOW)).toBe(true);
    expect(isPendingReview(sent, NOW)).toBe(false);
  });

  it("isAwaitingCustomer / isSent only matches 'sent' (not expired)", () => {
    expect(isAwaitingCustomer(sent, NOW)).toBe(true);
    expect(isSent(sent, NOW)).toBe(true);
    expect(isAwaitingCustomer(expired, NOW)).toBe(false);
  });

  it("isApproved is true for both raw approved and converted_to_work_order", () => {
    expect(isApproved(approved, NOW)).toBe(true);
    expect(isApproved(converted, NOW)).toBe(true);
    expect(isApproved(rejected, NOW)).toBe(false);
  });

  it("isRejected / isExpired", () => {
    expect(isRejected(rejected, NOW)).toBe(true);
    expect(isExpired(expired, NOW)).toBe(true);
    expect(isExpired(sent, NOW)).toBe(false);
  });

  it("isClosed = approved | rejected | expired; isOpen is its inverse", () => {
    for (const e of [approved, converted, rejected, expired]) {
      expect(isClosed(e, NOW)).toBe(true);
      expect(isOpen(e, NOW)).toBe(false);
    }
    for (const e of [draft, pendingReview, readyToSend, sent]) {
      expect(isClosed(e, NOW)).toBe(false);
      expect(isOpen(e, NOW)).toBe(true);
    }
  });

  it("isReadyToSend distinguishes approved_internal inside pending_review", () => {
    expect(isReadyToSend(readyToSend)).toBe(true);
    expect(isReadyToSend(pendingReview)).toBe(false);
    expect(isReadyToSend(sent)).toBe(false);
  });

  it("isAwaitingInternalReview distinguishes pending_approval inside pending_review", () => {
    expect(isAwaitingInternalReview(pendingReview)).toBe(true);
    expect(isAwaitingInternalReview(readyToSend)).toBe(false);
  });

  it("isConvertedToWorkOrder is true only for the raw converted status", () => {
    expect(isConvertedToWorkOrder(converted)).toBe(true);
    expect(isConvertedToWorkOrder(approved)).toBe(false);
  });

  it("isAwaitingCustomerReply tracks status='pending' (gates Approve/Reject)", () => {
    expect(isAwaitingCustomerReply(sent)).toBe(true);
    expect(isAwaitingCustomerReply(pendingReview)).toBe(true);
    expect(isAwaitingCustomerReply(approved)).toBe(false);
    expect(isAwaitingCustomerReply(rejected)).toBe(false);
  });

  it("predicates safely handle null/undefined estimates", () => {
    // A null/undefined estimate collapses to the `pending_review`
    // bucket (per `toLifecycle`), so the terminal-state predicates
    // return false and the "still open" predicate returns true.
    for (const fn of [isDraft, isAwaitingCustomer, isApproved, isRejected, isExpired, isClosed]) {
      expect(fn(null)).toBe(false);
      expect(fn(undefined)).toBe(false);
    }
    expect(isPendingReview(null)).toBe(true);
    expect(isOpen(null)).toBe(true);
    expect(isReadyToSend(null)).toBe(false);
    expect(isConvertedToWorkOrder(null)).toBe(false);
    expect(isAwaitingCustomerReply(null)).toBe(false);
  });
});

// Task #1955 — the 30-day window runs from the last send
// (`approvalSentAt`), with `estimateDate` kept as the fallback for rows
// that predate reliable send stamping. `lifecycleOf` is the UI entry
// point, so it must forward the send timestamp into the computation.
describe("expiry anchors on the send date (Task #1955)", () => {
  const daysBefore = (n: number) =>
    new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  const sent = (fields: {
    estimateDate?: Date | null;
    approvalSentAt?: Date | null;
  }) => ({
    status: "pending",
    internalStatus: "sent_to_customer",
    lifecycle: "sent",
    estimateDate: fields.estimateDate ?? null,
    approvalSentAt: fields.approvalSentAt ?? null,
  });

  it("created 40 days ago but sent today reads as awaiting-customer", () => {
    const estimate = sent({ estimateDate: daysBefore(40), approvalSentAt: NOW });
    expect(lifecycleOf(estimate, NOW)).toBe("sent");
    expect(isAwaitingCustomer(estimate, NOW)).toBe(true);
    expect(isExpired(estimate, NOW)).toBe(false);
  });

  it("sent 31 days ago is expired even with a fresh estimate date", () => {
    const estimate = sent({
      estimateDate: daysBefore(1),
      approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS + 1),
    });
    expect(lifecycleOf(estimate, NOW)).toBe("expired");
    expect(isExpired(estimate, NOW)).toBe(true);
  });

  it("exactly 30 days after sending is still live", () => {
    expect(
      lifecycleOf(
        sent({
          estimateDate: daysBefore(90),
          approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS),
        }),
        NOW,
      ),
    ).toBe("sent");
  });

  it("falls back to the estimate date when no send time was recorded", () => {
    expect(
      lifecycleOf(
        sent({
          estimateDate: daysBefore(ESTIMATE_EXPIRATION_DAYS + 1),
          approvalSentAt: null,
        }),
        NOW,
      ),
    ).toBe("expired");
    expect(
      lifecycleOf(
        sent({
          estimateDate: daysBefore(ESTIMATE_EXPIRATION_DAYS),
          approvalSentAt: null,
        }),
        NOW,
      ),
    ).toBe("sent");
  });

  it("a re-send restarts the 30-day window", () => {
    const beforeResend = sent({
      estimateDate: daysBefore(60),
      approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS + 5),
    });
    expect(lifecycleOf(beforeResend, NOW)).toBe("expired");
    expect(lifecycleOf({ ...beforeResend, approvalSentAt: NOW }, NOW)).toBe(
      "sent",
    );
  });

  it("estimateExpiryAnchor resolves send date first, estimate date second", () => {
    expect(
      estimateExpiryAnchor({
        approvalSentAt: daysBefore(2),
        estimateDate: daysBefore(40),
      }),
    ).toEqual(daysBefore(2));
    expect(
      estimateExpiryAnchor({ approvalSentAt: null, estimateDate: daysBefore(40) }),
    ).toEqual(daysBefore(40));
    expect(estimateExpiryAnchor({})).toBeNull();
    expect(estimateExpiryAnchor(null)).toBeNull();
  });
});

describe("axis label helpers", () => {
  it("reviewStageLabel covers every internalStatus the wizard produces", () => {
    expect(reviewStageLabel("draft")).toBe("Draft");
    expect(reviewStageLabel("pending_approval")).toBe("Awaiting review");
    expect(reviewStageLabel("approved_internal")).toBe("Ready to send");
    expect(reviewStageLabel("sent_to_customer")).toBe("Sent");
    expect(reviewStageLabel(null)).toBe("—");
    expect(reviewStageLabel("whatever")).toBe("—");
  });

  it("customerResponseLabel folds converted_to_work_order → Approved", () => {
    expect(customerResponseLabel("pending")).toBe("Awaiting reply");
    expect(customerResponseLabel("approved")).toBe("Approved");
    expect(customerResponseLabel("converted_to_work_order")).toBe("Approved");
    expect(customerResponseLabel("rejected")).toBe("Rejected");
    expect(customerResponseLabel("expired")).toBe("Expired");
    expect(customerResponseLabel(null)).toBe("—");
  });

  it("*Of variants read the field off the estimate object", () => {
    expect(
      reviewStageLabelOf({ status: "pending", internalStatus: "draft" }),
    ).toBe("Draft");
    expect(
      customerResponseLabelOf({
        status: "converted_to_work_order",
        internalStatus: "sent_to_customer",
      }),
    ).toBe("Approved");
    expect(reviewStageLabelOf(null)).toBe("—");
    expect(customerResponseLabelOf(undefined)).toBe("—");
  });
});

// Task #658 — Role × lifecycle delete matrix. Must agree with the server's
// ESTIMATE_DELETE_ROLES + ESTIMATE_PENDING_DELETE_ROLES sets so the UI
// never surfaces a Delete control the server would refuse.
describe("canDeleteLifecycle (Task #658)", () => {
  it("returns true for draft and pending_review only", () => {
    expect(canDeleteLifecycle({ status: "draft", internalStatus: "draft", estimateDate: FRESH }, NOW)).toBe(true);
    expect(canDeleteLifecycle({ status: "pending", internalStatus: "pending_approval", estimateDate: FRESH }, NOW)).toBe(true);
    expect(canDeleteLifecycle({ status: "pending", internalStatus: "approved_internal", estimateDate: FRESH }, NOW)).toBe(true);
  });

  it("returns false for sent / approved / rejected / expired", () => {
    expect(canDeleteLifecycle({ status: "pending", internalStatus: "sent_to_customer", estimateDate: FRESH }, NOW)).toBe(false);
    expect(canDeleteLifecycle({ status: "approved", internalStatus: "sent_to_customer", estimateDate: FRESH }, NOW)).toBe(false);
    expect(canDeleteLifecycle({ status: "rejected", internalStatus: "sent_to_customer", estimateDate: FRESH }, NOW)).toBe(false);
    expect(canDeleteLifecycle({ status: "pending", internalStatus: "sent_to_customer", estimateDate: STALE }, NOW)).toBe(false);
  });
});

describe("canDeleteEstimateAs (Task #658)", () => {
  const draft = { status: "draft", internalStatus: "draft", estimateDate: FRESH };
  const pending = { status: "pending", internalStatus: "pending_approval", estimateDate: FRESH };
  const approvedInternal = { status: "pending", internalStatus: "approved_internal", estimateDate: FRESH };
  const sent = { status: "pending", internalStatus: "sent_to_customer", estimateDate: FRESH };
  const approved = { status: "approved", internalStatus: "sent_to_customer", estimateDate: FRESH };
  const rejected = { status: "rejected", internalStatus: "sent_to_customer", estimateDate: FRESH };

  it("manager / admin / billing can delete draft AND pending_review", () => {
    for (const role of ["super_admin", "company_admin", "irrigation_manager", "billing_manager"]) {
      expect(canDeleteEstimateAs(role, draft, NOW)).toBe(true);
      expect(canDeleteEstimateAs(role, pending, NOW)).toBe(true);
      expect(canDeleteEstimateAs(role, approvedInternal, NOW)).toBe(true);
    }
  });

  it("field_tech can delete drafts but NOT pending_review", () => {
    expect(canDeleteEstimateAs("field_tech", draft, NOW)).toBe(true);
    expect(canDeleteEstimateAs("field_tech", pending, NOW)).toBe(false);
    expect(canDeleteEstimateAs("field_tech", approvedInternal, NOW)).toBe(false);
  });

  it("nobody can delete sent / approved / rejected", () => {
    for (const role of ["super_admin", "company_admin", "irrigation_manager", "billing_manager", "field_tech"]) {
      expect(canDeleteEstimateAs(role, sent, NOW)).toBe(false);
      expect(canDeleteEstimateAs(role, approved, NOW)).toBe(false);
      expect(canDeleteEstimateAs(role, rejected, NOW)).toBe(false);
    }
  });

  it("unknown / missing role is always refused", () => {
    expect(canDeleteEstimateAs(null, draft, NOW)).toBe(false);
    expect(canDeleteEstimateAs(undefined, draft, NOW)).toBe(false);
    expect(canDeleteEstimateAs("guest", draft, NOW)).toBe(false);
    expect(canDeleteEstimateAs("manager", pending, NOW)).toBe(false); // retired alias (Task #643)
  });
});

describe("LIFECYCLE_STATUSES export", () => {
  it("contains every bucket the predicates / detail modal rely on", () => {
    const expected: LifecycleStatus[] = [
      "draft",
      "pending_review",
      "sent",
      "approved",
      "rejected",
      "expired",
    ];
    for (const s of expected) {
      expect(LIFECYCLE_STATUSES).toContain(s);
    }
  });
});
