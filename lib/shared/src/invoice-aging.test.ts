// Task #1890 — the shared due-date / aging / flag rules.
//
// This module was extracted from three places that each had their own copy of
// the boundary rule. The point of these tests is that the extraction moved no
// numbers, so they are written against the OLD behaviour, not against what the
// new code happens to do:
//
//   * the five payment-terms cases the QBO payment-sync tests already locked
//     down (explicit dueDate · null with net_30 / net_15 / due_on_receipt ·
//     null terms defaulting to net_30), and
//   * the bucket boundaries at exactly 0, 29, 30, 59 and 60 days, including
//     the day-zero asymmetry (an invoice due today counts as overdue). That
//     asymmetry is deliberately preserved — changing it would move Financial
//     Pulse aging totals and belongs to its own ticket.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGING_BUCKET_KEYS,
  AGING_BUCKET_LABELS,
  AR_FLAGS,
  AR_FLAG_LABELS,
  AR_FLAG_TOOLTIPS,
  agingBucketRank,
  classifyAgingBucket,
  computeArFlags,
  computeEffectiveDueDate,
  daysOverdue,
  isBalanceFallback,
  isInvoiceOverdue,
  resolveBalanceDue,
  PAYMENT_TERMS_DAYS,
} from "./invoice-aging.js";

const DAY = 24 * 60 * 60 * 1000;
const CREATED = new Date("2026-06-01T00:00:00.000Z");
const NOW = new Date("2026-08-10T12:00:00.000Z");

// ── effective due date: the five terms cases ─────────────────────────────────

describe("computeEffectiveDueDate", () => {
  it("uses an explicit due date when one is set", () => {
    const explicit = new Date("2026-07-04T00:00:00.000Z");
    assert.equal(
      computeEffectiveDueDate(explicit, CREATED, "net_15").toISOString(),
      explicit.toISOString(),
    );
  });

  it("accepts an explicit due date as a string", () => {
    assert.equal(
      computeEffectiveDueDate("2026-07-04T00:00:00.000Z", CREATED, null).toISOString(),
      "2026-07-04T00:00:00.000Z",
    );
  });

  it("falls back to createdAt + net_30 when the due date is null", () => {
    assert.equal(
      computeEffectiveDueDate(null, CREATED, "net_30").getTime(),
      CREATED.getTime() + 30 * DAY,
    );
  });

  it("falls back to createdAt + net_15 when the due date is null", () => {
    assert.equal(
      computeEffectiveDueDate(null, CREATED, "net_15").getTime(),
      CREATED.getTime() + 15 * DAY,
    );
  });

  it("falls back to createdAt itself for due_on_receipt", () => {
    assert.equal(
      computeEffectiveDueDate(null, CREATED, "due_on_receipt").getTime(),
      CREATED.getTime(),
    );
  });

  it("defaults to net_30 when the customer has no terms recorded", () => {
    for (const terms of [null, undefined]) {
      assert.equal(
        computeEffectiveDueDate(null, CREATED, terms).getTime(),
        CREATED.getTime() + 30 * DAY,
        `terms=${String(terms)}`,
      );
    }
  });

  it("defaults to net_30 for an unrecognised terms string", () => {
    assert.equal(
      computeEffectiveDueDate(null, CREATED, "net_45_maybe").getTime(),
      CREATED.getTime() + 30 * DAY,
    );
  });

  it("falls back to the terms calculation when the due date is unparseable", () => {
    // The previous inline version in computeArAging produced an Invalid Date
    // here, which fell through to the oldest bucket. This is the one place the
    // extraction is deliberately kinder — and it is unreachable in practice,
    // because dueDate is a timestamp column and arrives as a Date or null.
    assert.equal(
      computeEffectiveDueDate("not-a-date", CREATED, "net_15").getTime(),
      CREATED.getTime() + 15 * DAY,
    );
  });

  it("accepts createdAt as a string", () => {
    assert.equal(
      computeEffectiveDueDate(null, CREATED.toISOString(), "net_15").getTime(),
      CREATED.getTime() + 15 * DAY,
    );
  });

  it("keeps the payment-terms table the three known values", () => {
    assert.deepEqual(PAYMENT_TERMS_DAYS, { net_30: 30, net_15: 15, due_on_receipt: 0 });
  });
});

// ── overdue ──────────────────────────────────────────────────────────────────

describe("isInvoiceOverdue", () => {
  const past = new Date(NOW.getTime() - DAY);
  const future = new Date(NOW.getTime() + DAY);

  it("is true when unpaid and past the due date", () => {
    assert.equal(isInvoiceOverdue("unpaid", past, NOW), true);
  });

  it("is true for a partially-paid invoice past the due date", () => {
    assert.equal(isInvoiceOverdue("partially_paid", past, NOW), true);
  });

  it("treats a missing payment status as unpaid", () => {
    assert.equal(isInvoiceOverdue(null, past, NOW), true);
    assert.equal(isInvoiceOverdue(undefined, past, NOW), true);
  });

  it("is never true for a paid invoice, however old", () => {
    assert.equal(isInvoiceOverdue("paid", new Date(0), NOW), false);
  });

  it("is false before the due date", () => {
    assert.equal(isInvoiceOverdue("unpaid", future, NOW), false);
  });

  it("is false at the exact due instant", () => {
    assert.equal(isInvoiceOverdue("unpaid", NOW, NOW), false);
  });
});

// ── bucket boundaries ────────────────────────────────────────────────────────

describe("classifyAgingBucket", () => {
  it("puts a not-yet-due invoice in current", () => {
    assert.equal(classifyAgingBucket(-0.001), "current");
    assert.equal(classifyAgingBucket(-30), "current");
  });

  it("locks the boundaries at exactly 0, 29, 30, 59 and 60 days", () => {
    const cases: [number, string][] = [
      [0, "days30"], // day zero is overdue — frozen, see the module header
      [29, "days30"],
      [29.999, "days30"],
      [30, "days60"],
      [59, "days60"],
      [59.999, "days60"],
      [60, "days90"],
      [10_000, "days90"],
    ];
    for (const [days, expected] of cases) {
      assert.equal(classifyAgingBucket(days), expected, `${days} days`);
    }
  });

  it("keeps NaN in the oldest bucket, as the old ternary chain did", () => {
    // `age < 0 ? … : age < 30 ? … : age < 60 ? … : days90` — every comparison
    // against NaN is false, so NaN fell through to the last branch.
    assert.equal(classifyAgingBucket(NaN), "days90");
  });

  it("ranks buckets newest to oldest", () => {
    assert.deepEqual(
      AGING_BUCKET_KEYS.map(agingBucketRank),
      [0, 1, 2, 3],
    );
  });
});

describe("bucket labels", () => {
  it("describe the boundaries the code actually uses", () => {
    assert.deepEqual(AGING_BUCKET_LABELS, {
      current: "Current",
      days30: "0–29 days overdue",
      days60: "30–59 days overdue",
      days90: "60+ days overdue",
    });
  });

  it("covers every bucket key", () => {
    for (const key of AGING_BUCKET_KEYS) {
      assert.equal(typeof AGING_BUCKET_LABELS[key], "string");
    }
  });
});

describe("daysOverdue", () => {
  it("is fractional and signed", () => {
    assert.equal(daysOverdue(new Date(NOW.getTime() - 36 * 60 * 60 * 1000), NOW), 1.5);
    assert.equal(daysOverdue(new Date(NOW.getTime() + DAY), NOW), -1);
    assert.equal(daysOverdue(NOW, NOW), 0);
  });

  it("feeds classifyAgingBucket without rounding", () => {
    // 29.9 days must stay in days30. Rounding here would move it to days60 and
    // change a Financial Pulse total.
    const due = new Date(NOW.getTime() - 29.9 * DAY);
    assert.equal(classifyAgingBucket(daysOverdue(due, NOW)), "days30");
  });
});

// ── balance ──────────────────────────────────────────────────────────────────

describe("resolveBalanceDue", () => {
  const base = { status: "generated", totalAmount: "500.00" };

  it("uses the synced balance when a sync has run", () => {
    const inv = { ...base, balance: "120.00", paymentSyncedAt: NOW };
    assert.equal(resolveBalanceDue(inv), 120);
    assert.equal(isBalanceFallback(inv), false);
  });

  it("falls back to the invoice total when no sync has ever run", () => {
    const inv = { ...base, balance: null, paymentSyncedAt: null };
    assert.equal(resolveBalanceDue(inv), 500);
    assert.equal(isBalanceFallback(inv), true);
  });

  it("falls back when a sync ran but left no balance", () => {
    const inv = { ...base, balance: null, paymentSyncedAt: NOW };
    assert.equal(resolveBalanceDue(inv), 500);
    assert.equal(isBalanceFallback(inv), true);
  });

  it("reads a zero balance as zero, not as missing", () => {
    const inv = { ...base, balance: "0.00", paymentSyncedAt: NOW };
    assert.equal(resolveBalanceDue(inv), 0);
    assert.equal(isBalanceFallback(inv), false);
  });

  it("accepts numeric totals and balances", () => {
    assert.equal(
      resolveBalanceDue({ status: "generated", totalAmount: 42, balance: null, paymentSyncedAt: null }),
      42,
    );
  });
});

// ── flags ────────────────────────────────────────────────────────────────────

describe("computeArFlags", () => {
  const clean = {
    status: "generated",
    totalAmount: "100.00",
    sentAt: NOW,
    customerEmail: "billing@example.com",
    quickbooksInvoiceId: "QB-1",
    qbVoidDetectedAt: null,
    qbNote: null,
    paymentStatus: "unpaid",
    balance: "100.00",
    paymentSyncedAt: NOW,
  };

  it("finds nothing wrong with a clean invoice", () => {
    assert.deepEqual(computeArFlags(clean, NOW, false), []);
  });

  it("flags an invoice that was finalised but never sent", () => {
    assert.ok(computeArFlags({ ...clean, sentAt: null }, NOW, false).includes("never_sent"));
  });

  it("never flags a draft as never sent", () => {
    // A draft has not been finalised, so "never sent" is not a finding.
    const flags = computeArFlags({ ...clean, status: "draft", sentAt: null }, NOW, false);
    assert.equal(flags.includes("never_sent"), false);
  });

  it("reports overdue from the caller rather than recomputing it", () => {
    assert.ok(computeArFlags(clean, NOW, true).includes("overdue"));
    assert.equal(computeArFlags(clean, NOW, false).includes("overdue"), false);
  });

  it("flags a QuickBooks void", () => {
    assert.ok(computeArFlags({ ...clean, qbVoidDetectedAt: NOW }, NOW, false).includes("qb_voided"));
  });

  it("flags an invoice QuickBooks has never seen", () => {
    assert.ok(
      computeArFlags({ ...clean, quickbooksInvoiceId: null }, NOW, false).includes("not_in_qb"),
    );
  });

  it("flags a sync older than 24 hours, and only then", () => {
    const stale = new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1);
    const fresh = new Date(NOW.getTime() - 24 * 60 * 60 * 1000 + 1);
    assert.ok(computeArFlags({ ...clean, paymentSyncedAt: stale }, NOW, false).includes("stale_sync"));
    assert.equal(
      computeArFlags({ ...clean, paymentSyncedAt: fresh }, NOW, false).includes("stale_sync"),
      false,
    );
  });

  it("flags a never-synced invoice as stale", () => {
    assert.ok(computeArFlags({ ...clean, paymentSyncedAt: null }, NOW, false).includes("stale_sync"));
  });

  it("stale sync always accompanies a fallback balance", () => {
    const inv = { ...clean, balance: null, paymentSyncedAt: null };
    assert.equal(isBalanceFallback(inv), true);
    assert.ok(computeArFlags(inv, NOW, false).includes("stale_sync"));
  });

  it("flags a missing or blank billing email", () => {
    for (const email of [null, "", "   "]) {
      assert.ok(
        computeArFlags({ ...clean, customerEmail: email }, NOW, false).includes("no_billing_email"),
        `email=${JSON.stringify(email)}`,
      );
    }
  });

  it("flags an outstanding QuickBooks cleanup note, ignoring whitespace", () => {
    assert.ok(
      computeArFlags({ ...clean, qbNote: "delete QB #123" }, NOW, false).includes("needs_qb_cleanup"),
    );
    assert.equal(
      computeArFlags({ ...clean, qbNote: "  " }, NOW, false).includes("needs_qb_cleanup"),
      false,
    );
  });

  it("returns flags in a stable order", () => {
    const messy = {
      ...clean,
      sentAt: null,
      qbVoidDetectedAt: NOW,
      quickbooksInvoiceId: null,
      paymentSyncedAt: null,
      customerEmail: null,
      qbNote: "cleanup",
    };
    assert.deepEqual(computeArFlags(messy, NOW, true), [
      "never_sent",
      "overdue",
      "qb_voided",
      "not_in_qb",
      "stale_sync",
      "no_billing_email",
      "needs_qb_cleanup",
    ]);
  });

  it("gives every flag readable text and a plain-language tooltip", () => {
    for (const flag of AR_FLAGS) {
      const label = AR_FLAG_LABELS[flag];
      const tooltip = AR_FLAG_TOOLTIPS[flag];
      assert.ok(label && label.length > 0, `${flag} has no label`);
      // Text, never colour alone — and the tooltip has to be a sentence, not a
      // restatement of the badge.
      assert.ok(tooltip && tooltip.length > label.length, `${flag} has no real tooltip`);
      assert.equal(tooltip.includes("_"), false, `${flag} tooltip leaks a field name`);
    }
  });
});
