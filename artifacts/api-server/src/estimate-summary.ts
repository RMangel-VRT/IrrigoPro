// Task #683 — Pure aggregator for the Estimate Command Center.
//
// `computeEstimateSummary` walks an already-fetched array of estimate
// rows and builds the EstimateSummary payload (byLifecycle, windows,
// attention[], winRate90d). The caller is responsible for the company
// scope at the SQL layer; this helper does not look at companyId.
//
// Kept pure so the windows + attention math can be unit-tested
// without a database.

import {
  ESTIMATE_EXPIRATION_DAYS,
  ESTIMATE_HIGH_VALUE_USD,
  ESTIMATE_STUCK_REVIEW_DAYS,
  estimateExpiryAnchor,
} from "@workspace/shared";
import type {
  EstimateAttentionReason,
  EstimateAttentionRow,
  EstimateLifecycleBucket,
  EstimateSummary,
} from "@workspace/db";

const STORED_LIFECYCLES = new Set<string>([
  "draft",
  "pending_review",
  "sent",
  "approved",
  "rejected",
]);

// Read the canonical, server-stamped lifecycle column. Task #642 made
// `estimates.lifecycle` the single source of truth for every write
// path, so the command-center aggregator trusts it directly instead
// of re-deriving from the legacy `(status, internalStatus)` pair.
// The only view-time computation is "expired", which is a sent row
// last sent more than ESTIMATE_EXPIRATION_DAYS ago — that is
// intentionally derived here rather than stamped so a resend rolls the
// row back to `sent` without a write.
//
// Task #1955 — the expiry clock runs from `approvalSentAt` (falling
// back to `estimateDate` for rows with no recorded send), resolved by
// the shared `estimateExpiryAnchor` so the dashboard agrees with the
// board and the detail view.
function lifecycleFromRow(
  row: {
    lifecycle?: string | null;
    estimateDate?: Date | string | null;
    approvalSentAt?: Date | string | null;
  },
  now: Date,
): EstimateLifecycleBucket {
  const stored = row.lifecycle ?? "";
  if (!STORED_LIFECYCLES.has(stored)) return "pending_review";
  if (stored !== "sent") return stored as EstimateLifecycleBucket;
  const anchor = estimateExpiryAnchor(row);
  if (!anchor) return "sent";
  const ageDays = (now.getTime() - anchor.getTime()) / MS_PER_DAY;
  return ageDays > ESTIMATE_EXPIRATION_DAYS ? "expired" : "sent";
}

interface EstimateRow {
  id: number;
  estimateNumber?: string | null;
  customerName?: string | null;
  totalAmount?: string | number | null;
  status?: string | null;
  internalStatus?: string | null;
  lifecycle?: string | null;
  createdAt?: Date | string | null;
  estimateDate?: Date | string | null;
  // Task #1955 — last send; the anchor for the expiry windows below.
  approvalSentAt?: Date | string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function emptyBucket() {
  return { count: 0, totalAmount: 0 };
}

export function computeEstimateSummary(
  rows: EstimateRow[],
  now: Date = new Date(),
): EstimateSummary {
  const byLifecycle: Record<EstimateLifecycleBucket, { count: number; totalAmount: number }> = {
    draft: emptyBucket(),
    pending_review: emptyBucket(),
    sent: emptyBucket(),
    approved: emptyBucket(),
    rejected: emptyBucket(),
    expired: emptyBucket(),
  };
  const expiringNext7Days = emptyBucket();
  const stuckInReviewOver3Days = emptyBucket();
  const approvedLast30Days = emptyBucket();
  const attention: EstimateAttentionRow[] = [];

  let win = 0;
  let winDenom = 0;

  for (const row of rows) {
    const lifecycle = lifecycleFromRow(row, now);

    const total = parseFloat(String(row.totalAmount ?? "0")) || 0;
    byLifecycle[lifecycle].count += 1;
    byLifecycle[lifecycle].totalAmount += total;

    const createdAt = toDate(row.createdAt ?? null);
    const estimateDate = toDate(row.estimateDate ?? null);
    // Task #1955 — every expiry / customer-silence window below is
    // measured from the last send, not the estimate date.
    const sentAnchor = estimateExpiryAnchor(row);

    if (lifecycle === "sent" && sentAnchor) {
      const ageDays = (now.getTime() - sentAnchor.getTime()) / MS_PER_DAY;
      if (ageDays > ESTIMATE_EXPIRATION_DAYS - 7 && ageDays <= ESTIMATE_EXPIRATION_DAYS) {
        expiringNext7Days.count += 1;
        expiringNext7Days.totalAmount += total;
        attention.push({
          estimateId: row.id,
          estimateNumber: row.estimateNumber ?? null,
          customerName: row.customerName ?? null,
          totalAmount: total,
          reason: "expiring_soon",
          sinceDays: Math.floor(ageDays),
          lifecycle,
        });
      }
    }

    if (lifecycle === "pending_review" && createdAt) {
      const ageDays = (now.getTime() - createdAt.getTime()) / MS_PER_DAY;
      if (ageDays > ESTIMATE_STUCK_REVIEW_DAYS) {
        stuckInReviewOver3Days.count += 1;
        stuckInReviewOver3Days.totalAmount += total;
        attention.push({
          estimateId: row.id,
          estimateNumber: row.estimateNumber ?? null,
          customerName: row.customerName ?? null,
          totalAmount: total,
          reason: "stuck_in_review",
          sinceDays: Math.floor(ageDays),
          lifecycle,
        });
      }
    }

    if (lifecycle === "sent" && total >= ESTIMATE_HIGH_VALUE_USD && sentAnchor) {
      const ageDays = (now.getTime() - sentAnchor.getTime()) / MS_PER_DAY;
      if (ageDays >= 7) {
        attention.push({
          estimateId: row.id,
          estimateNumber: row.estimateNumber ?? null,
          customerName: row.customerName ?? null,
          totalAmount: total,
          reason: "high_value_silent",
          sinceDays: Math.floor(ageDays),
          lifecycle,
        });
      }
    }

    if (lifecycle === "approved" && createdAt) {
      const ageDays = (now.getTime() - createdAt.getTime()) / MS_PER_DAY;
      if (ageDays <= 30) {
        approvedLast30Days.count += 1;
        approvedLast30Days.totalAmount += total;
      }
    }

    if (estimateDate) {
      const ageDays = (now.getTime() - estimateDate.getTime()) / MS_PER_DAY;
      if (ageDays <= 90) {
        if (lifecycle === "approved") {
          win += 1;
          winDenom += 1;
        } else if (lifecycle === "rejected" || lifecycle === "expired") {
          winDenom += 1;
        }
      }
    }
  }

  const PRIORITY: Record<EstimateAttentionReason, number> = {
    expiring_soon: 0,
    stuck_in_review: 1,
    high_value_silent: 2,
  };
  attention.sort((a, b) => {
    const p = PRIORITY[a.reason] - PRIORITY[b.reason];
    if (p !== 0) return p;
    return b.sinceDays - a.sinceDays;
  });
  const cappedAttention = attention.slice(0, 8);

  return {
    byLifecycle,
    windows: {
      expiringNext7Days,
      stuckInReviewOver3Days,
      approvedLast30Days,
      openPipeline: {
        count: byLifecycle.sent.count + byLifecycle.pending_review.count,
        totalAmount: byLifecycle.sent.totalAmount + byLifecycle.pending_review.totalAmount,
      },
      awaitingReview: { ...byLifecycle.pending_review },
      awaitingCustomer: { ...byLifecycle.sent },
    },
    attention: cappedAttention,
    winRate90d: winDenom === 0 ? 0 : win / winDenom,
  };
}
