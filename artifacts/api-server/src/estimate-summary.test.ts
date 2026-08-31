// Task #1955 — the Estimate Command Center aggregator must measure
// expiry (and the "expiring in the next 7 days" window, and the age it
// reports on attention rows) from the last send, exactly like the
// shared lifecycle helper the board uses. Otherwise the same estimate
// reads as "expiring in 3 days" on the dashboard and fresh on the board.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ESTIMATE_EXPIRATION_DAYS } from "@workspace/shared";

import { computeEstimateSummary } from "./estimate-summary.js";

const NOW = new Date("2026-02-01T00:00:00Z");
const daysBefore = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function sentRow(fields: {
  id?: number;
  totalAmount?: string;
  estimateDate?: Date | null;
  approvalSentAt?: Date | null;
}) {
  return {
    id: fields.id ?? 1,
    estimateNumber: "EST-1",
    customerName: "Acme",
    totalAmount: fields.totalAmount ?? "100.00",
    status: "pending",
    internalStatus: "sent_to_customer",
    lifecycle: "sent",
    createdAt: fields.estimateDate ?? null,
    estimateDate: fields.estimateDate ?? null,
    approvalSentAt: fields.approvalSentAt ?? null,
  };
}

describe("computeEstimateSummary expiry anchor (Task #1955)", () => {
  it("counts an old estimate sent today as awaiting-customer, not expired", () => {
    const summary = computeEstimateSummary(
      [sentRow({ estimateDate: daysBefore(40), approvalSentAt: NOW })],
      NOW,
    );
    assert.equal(summary.byLifecycle.sent.count, 1);
    assert.equal(summary.byLifecycle.expired.count, 0);
    assert.equal(summary.windows.expiringNext7Days.count, 0);
  });

  it("counts an estimate sent 31 days ago as expired", () => {
    const summary = computeEstimateSummary(
      [
        sentRow({
          estimateDate: daysBefore(1),
          approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS + 1),
        }),
      ],
      NOW,
    );
    assert.equal(summary.byLifecycle.expired.count, 1);
    assert.equal(summary.byLifecycle.sent.count, 0);
  });

  it("keeps an estimate sent exactly 30 days ago in the sent bucket", () => {
    const summary = computeEstimateSummary(
      [
        sentRow({
          estimateDate: daysBefore(90),
          approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS),
        }),
      ],
      NOW,
    );
    assert.equal(summary.byLifecycle.sent.count, 1);
    assert.equal(summary.byLifecycle.expired.count, 0);
  });

  it("measures 'expiring in the next 7 days' from the send date", () => {
    // Created 60 days ago, sent 27 days ago → 3 days of window left.
    const summary = computeEstimateSummary(
      [
        sentRow({
          totalAmount: "250.00",
          estimateDate: daysBefore(60),
          approvalSentAt: daysBefore(27),
        }),
      ],
      NOW,
    );
    assert.equal(summary.windows.expiringNext7Days.count, 1);
    assert.equal(summary.windows.expiringNext7Days.totalAmount, 250);
    const row = summary.attention.find((a) => a.reason === "expiring_soon");
    assert.ok(row, "expected an expiring_soon attention row");
    // Age reported is time since the send, not since the estimate date.
    assert.equal(row.sinceDays, 27);
  });

  it("reports high-value silence from the send date too", () => {
    // Sent 2 days ago on a 60-day-old estimate — not silent yet.
    const summary = computeEstimateSummary(
      [
        sentRow({
          totalAmount: "9000.00",
          estimateDate: daysBefore(60),
          approvalSentAt: daysBefore(2),
        }),
      ],
      NOW,
    );
    assert.equal(
      summary.attention.filter((a) => a.reason === "high_value_silent").length,
      0,
    );
  });

  it("falls back to the estimate date when there is no recorded send time", () => {
    const expired = computeEstimateSummary(
      [
        sentRow({
          estimateDate: daysBefore(ESTIMATE_EXPIRATION_DAYS + 1),
          approvalSentAt: null,
        }),
      ],
      NOW,
    );
    assert.equal(expired.byLifecycle.expired.count, 1);

    const live = computeEstimateSummary(
      [
        sentRow({
          estimateDate: daysBefore(ESTIMATE_EXPIRATION_DAYS),
          approvalSentAt: null,
        }),
      ],
      NOW,
    );
    assert.equal(live.byLifecycle.sent.count, 1);
  });

  it("a re-send rolls an expired row back into the sent bucket", () => {
    const before = sentRow({
      estimateDate: daysBefore(60),
      approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS + 5),
    });
    assert.equal(
      computeEstimateSummary([before], NOW).byLifecycle.expired.count,
      1,
    );
    const after = { ...before, approvalSentAt: NOW };
    const summary = computeEstimateSummary([after], NOW);
    assert.equal(summary.byLifecycle.sent.count, 1);
    assert.equal(summary.byLifecycle.expired.count, 0);
  });
});
