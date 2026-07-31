// Task #1831 — QBO Payment-Status Sync: unit tests
//
// Covers:
//   1. derivePaymentStatus() — all threshold cases
//   2. computeEffectiveDueDate() — dueDate present, absent (fallback to createdAt + net_30)
//   3. isInvoiceOverdue() — paid/partial/unpaid × due/not-due
//   4. isThrottled() / recordSyncTime() — throttle logic
//   5. syncPaymentStatusForCompany() — integration scenarios via storage spy

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  derivePaymentStatus,
  computeEffectiveDueDate,
  isInvoiceOverdue,
  isThrottled,
  recordSyncTime,
  resetThrottleForTesting,
  resetInFlightForTesting,
  syncPaymentStatusForCompany,
} from "./qb-payment-sync.js";

// ── 1. derivePaymentStatus ─────────────────────────────────────────────────

describe("derivePaymentStatus", () => {
  it("returns 'paid' when balance is 0", () => {
    assert.equal(derivePaymentStatus(0, 500), "paid");
  });

  it("returns 'paid' when balance is negative (over-payment)", () => {
    assert.equal(derivePaymentStatus(-1, 500), "paid");
  });

  it("returns 'partially_paid' when 0 < balance < totalAmt", () => {
    assert.equal(derivePaymentStatus(200, 500), "partially_paid");
  });

  it("returns 'unpaid' when balance equals totalAmt", () => {
    assert.equal(derivePaymentStatus(500, 500), "unpaid");
  });

  it("returns 'unpaid' when balance > totalAmt (edge: adjustments)", () => {
    assert.equal(derivePaymentStatus(600, 500), "unpaid");
  });

  it("returns 'unpaid' when totalAmt is 0 and balance is 0 (void / $0 invoice)", () => {
    // Task #1848 — a $0 invoice (voided or fully-covered membership) must
    // never be auto-stamped paid. The totalAmt ≤ 0 guard fires first.
    assert.equal(derivePaymentStatus(0, 0), "unpaid");
  });

  it("returns 'unpaid' when totalAmt is 0 and balance is non-zero", () => {
    assert.equal(derivePaymentStatus(100, 0), "unpaid");
  });

  it("returns 'paid' when balance is 0 and totalAmt is positive", () => {
    assert.equal(derivePaymentStatus(0, 100), "paid");
  });

  it("returns 'partially_paid' when 0 < balance < totalAmt (positive total)", () => {
    assert.equal(derivePaymentStatus(40, 100), "partially_paid");
  });
});

// ── 2. computeEffectiveDueDate ─────────────────────────────────────────────

describe("computeEffectiveDueDate", () => {
  const created = new Date("2025-01-01T00:00:00.000Z");

  it("uses dueDate when provided and valid", () => {
    const due = new Date("2025-02-01T00:00:00.000Z");
    const result = computeEffectiveDueDate(due, created, "net_30");
    assert.equal(result.toISOString(), due.toISOString());
  });

  it("uses dueDate string when provided", () => {
    const result = computeEffectiveDueDate("2025-02-01", created, "net_30");
    assert.equal(result.toISOString().slice(0, 10), "2025-02-01");
  });

  it("falls back to createdAt + 30d when dueDate is null", () => {
    const result = computeEffectiveDueDate(null, created, "net_30");
    const expected = new Date(created.getTime() + 30 * 24 * 60 * 60 * 1000);
    assert.equal(result.toISOString(), expected.toISOString());
  });

  it("falls back to createdAt + 30d when paymentTerms is undefined (default net_30)", () => {
    const result = computeEffectiveDueDate(null, created);
    const expected = new Date(created.getTime() + 30 * 24 * 60 * 60 * 1000);
    assert.equal(result.toISOString(), expected.toISOString());
  });

  it("uses net_15 when paymentTerms is net_15", () => {
    const result = computeEffectiveDueDate(null, created, "net_15");
    const expected = new Date(created.getTime() + 15 * 24 * 60 * 60 * 1000);
    assert.equal(result.toISOString(), expected.toISOString());
  });

  it("uses 0d when paymentTerms is due_on_receipt", () => {
    const result = computeEffectiveDueDate(null, created, "due_on_receipt");
    assert.equal(result.toISOString(), created.toISOString());
  });
});

// ── 3. isInvoiceOverdue ───────────────────────────────────────────────────

describe("isInvoiceOverdue", () => {
  const now = new Date("2025-06-01T00:00:00.000Z");
  const past = new Date("2025-05-01T00:00:00.000Z");
  const future = new Date("2025-07-01T00:00:00.000Z");

  it("not overdue when paid", () => {
    assert.equal(isInvoiceOverdue("paid", past, now), false);
  });

  it("overdue when unpaid and due in past", () => {
    assert.equal(isInvoiceOverdue("unpaid", past, now), true);
  });

  it("overdue when partially_paid and due in past", () => {
    assert.equal(isInvoiceOverdue("partially_paid", past, now), true);
  });

  it("not overdue when unpaid but due in future", () => {
    assert.equal(isInvoiceOverdue("unpaid", future, now), false);
  });

  it("not overdue when partially_paid but due in future", () => {
    assert.equal(isInvoiceOverdue("partially_paid", future, now), false);
  });

  it("defaults to unpaid when paymentStatus is null", () => {
    assert.equal(isInvoiceOverdue(null, past, now), true);
  });
});

// ── 4. Throttle helpers ───────────────────────────────────────────────────

describe("throttle helpers", () => {
  beforeEach(() => resetThrottleForTesting());

  it("not throttled before first sync", () => {
    assert.equal(isThrottled("company-1"), false);
  });

  it("throttled immediately after recordSyncTime", () => {
    recordSyncTime("company-1");
    assert.equal(isThrottled("company-1"), true);
  });

  it("different companies are throttled independently", () => {
    recordSyncTime("company-1");
    assert.equal(isThrottled("company-2"), false);
  });
});

// ── 5. syncPaymentStatusForCompany ────────────────────────────────────────

function makeFakeDb(rows: any[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };
}

function makeRequest(overrides: Partial<{
  status: number;
  body: object;
}> = {}) {
  const status = overrides.status ?? 200;
  const body = overrides.body ?? { QueryResponse: { Invoice: [] } };
  return async () =>
    ({
      ok: status < 400,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as any;
}

describe("syncPaymentStatusForCompany", () => {
  beforeEach(() => { resetThrottleForTesting(); resetInFlightForTesting(); });

  it("returns skippedNoQb=true when no QB integration found", async () => {
    const result = await syncPaymentStatusForCompany("42", {
      makeRequest: makeRequest() as any,
      getQbIntegration: async () => null,
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: makeFakeDb([]),
    });
    assert.equal(result.skippedNoQb, true);
    assert.equal(result.invoicesChecked, 0);
  });

  it("returns skippedNoQb=true when connection is reconnect_required", async () => {
    const result = await syncPaymentStatusForCompany("42", {
      makeRequest: makeRequest() as any,
      getQbIntegration: async () => ({
        realmId: "realm-1",
        accessToken: "tok",
        connectionStatus: "reconnect_required",
      }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: makeFakeDb([]),
    });
    assert.equal(result.skippedNoQb, true);
  });

  it("returns invoicesChecked=0 when no QB-linked invoices", async () => {
    const result = await syncPaymentStatusForCompany("42", {
      makeRequest: makeRequest() as any,
      getQbIntegration: async () => ({
        realmId: "realm-1",
        accessToken: "tok",
        connectionStatus: "connected",
      }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: makeFakeDb([]),
    });
    assert.equal(result.invoicesChecked, 0);
    assert.equal(result.skippedNoQb, false);
  });

  it("marks paid=1 when QBO Balance is 0", async () => {
    const updates: any[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 1, quickbooksInvoiceId: "QB-1", totalAmount: "500.00", paymentStatus: "unpaid", status: "generated" },
            ]),
        }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => {
            updates.push(vals);
            return Promise.resolve();
          },
        }),
      }),
    };

    const result = await syncPaymentStatusForCompany("42", {
      makeRequest: makeRequest({
        body: {
          QueryResponse: {
            Invoice: [{ Id: "QB-1", Balance: 0, TotalAmt: 500 }],
          },
        },
      }) as any,
      getQbIntegration: async () => ({
        realmId: "realm-1",
        accessToken: "tok",
        connectionStatus: "connected",
      }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    assert.equal(result.paid, 1);
    assert.equal(result.partiallyPaid, 0);
    assert.equal(updates[0].paymentStatus, "paid");
    assert.equal(updates[0].status, "paid");
    assert.ok(updates[0].paidAt instanceof Date);
    // Task #1847 regression: the QB payment sync must NEVER overwrite sentAt.
    // sentAt is the single source of delivery truth and is managed exclusively
    // by mark-sent / mark-unsent. The sync should not include sentAt in updates.
    assert.equal(updates[0].sentAt, undefined, "QB payment sync must not overwrite sentAt");
  });

  it("marks partiallyPaid=1 when QBO Balance is partial", async () => {
    const updates: any[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 2, quickbooksInvoiceId: "QB-2", totalAmount: "500.00", paymentStatus: "unpaid", status: "sent" },
            ]),
        }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => {
            updates.push(vals);
            return Promise.resolve();
          },
        }),
      }),
    };

    const result = await syncPaymentStatusForCompany("42", {
      makeRequest: makeRequest({
        body: {
          QueryResponse: {
            Invoice: [{ Id: "QB-2", Balance: 200, TotalAmt: 500 }],
          },
        },
      }) as any,
      getQbIntegration: async () => ({
        realmId: "realm-1",
        accessToken: "tok",
        connectionStatus: "connected",
      }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    assert.equal(result.partiallyPaid, 1);
    assert.equal(result.paid, 0);
    assert.equal(updates[0].paymentStatus, "partially_paid");
    assert.equal(updates[0].balance, "200.00");
    assert.equal(updates[0].status, undefined);
  });

  it("marks unpaid=1 when QBO Balance matches totalAmt", async () => {
    const updates: any[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 3, quickbooksInvoiceId: "QB-3", totalAmount: "300.00", paymentStatus: "unpaid", status: "generated", qbVoidDetectedAt: null },
            ]),
        }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => {
            updates.push(vals);
            return Promise.resolve();
          },
        }),
      }),
    };

    const result = await syncPaymentStatusForCompany("42", {
      makeRequest: makeRequest({
        body: {
          QueryResponse: {
            Invoice: [{ Id: "QB-3", Balance: 300, TotalAmt: 300 }],
          },
        },
      }) as any,
      getQbIntegration: async () => ({
        realmId: "realm-1",
        accessToken: "tok",
        connectionStatus: "connected",
      }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    assert.equal(result.unpaid, 1);
    assert.equal(updates[0].paymentStatus, "unpaid");
    assert.equal(updates[0].status, undefined);
  });

  // ── Void detection tests ───────────────────────────────────────────────

  it("sets qbVoidDetectedAt on first detection; does NOT change paymentStatus or status", async () => {
    const updates: any[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 10, quickbooksInvoiceId: "QB-V1", totalAmount: "500.00", paymentStatus: "unpaid", status: "sent", qbVoidDetectedAt: null },
            ]),
        }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => {
            updates.push(vals);
            return Promise.resolve();
          },
        }),
      }),
    };

    const result = await syncPaymentStatusForCompany("99", {
      makeRequest: makeRequest({
        body: {
          QueryResponse: {
            Invoice: [{ Id: "QB-V1", Balance: 0, TotalAmt: 0, PrivateNote: "Voided" }],
          },
        },
      }) as any,
      getQbIntegration: async () => ({ realmId: "r1", accessToken: "t1", connectionStatus: "connected" }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    assert.equal(result.qbVoided, 1, "qbVoided counter should be 1");
    assert.equal(result.paid, 0, "paid counter must not increment for voided invoices");
    assert.ok(updates.length === 1, "should have exactly one DB update");
    assert.ok(updates[0].qbVoidDetectedAt instanceof Date, "qbVoidDetectedAt should be set to a Date");
    assert.equal(updates[0].paymentStatus, undefined, "paymentStatus must not be changed");
    assert.equal(updates[0].status, undefined, "status must not be changed");
  });

  it("preserves existing qbVoidDetectedAt on repeat detection (first-detection semantics)", async () => {
    const originalDate = new Date("2026-01-15T10:00:00Z");
    const updates: any[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 11, quickbooksInvoiceId: "QB-V2", totalAmount: "200.00", paymentStatus: "unpaid", status: "sent", qbVoidDetectedAt: originalDate },
            ]),
        }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => { updates.push(vals); return Promise.resolve(); },
        }),
      }),
    };

    await syncPaymentStatusForCompany("99", {
      makeRequest: makeRequest({
        body: { QueryResponse: { Invoice: [{ Id: "QB-V2", Balance: 0, TotalAmt: 0, PrivateNote: "Voided" }] } },
      }) as any,
      getQbIntegration: async () => ({ realmId: "r1", accessToken: "t1", connectionStatus: "connected" }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    // qbVoidDetectedAt should preserve the original timestamp (not be overwritten)
    assert.deepEqual(updates[0].qbVoidDetectedAt, originalDate);
  });

  it("clears qbVoidDetectedAt when invoice is no longer voided on re-sync", async () => {
    const updates: any[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 12, quickbooksInvoiceId: "QB-V3", totalAmount: "300.00", paymentStatus: "unpaid", status: "sent", qbVoidDetectedAt: new Date() },
            ]),
        }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => { updates.push(vals); return Promise.resolve(); },
        }),
      }),
    };

    await syncPaymentStatusForCompany("99", {
      makeRequest: makeRequest({
        body: { QueryResponse: { Invoice: [{ Id: "QB-V3", Balance: 300, TotalAmt: 300, PrivateNote: "" }] } },
      }) as any,
      getQbIntegration: async () => ({ realmId: "r1", accessToken: "t1", connectionStatus: "connected" }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    assert.equal(updates[0].qbVoidDetectedAt, null, "void flag should be cleared when invoice is no longer voided");
  });

  it("does NOT set void flag for $0 invoice without 'Voided' in PrivateNote", async () => {
    const updates: any[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 13, quickbooksInvoiceId: "QB-ZERO", totalAmount: "0.00", paymentStatus: "unpaid", status: "sent", qbVoidDetectedAt: null },
            ]),
        }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => { updates.push(vals); return Promise.resolve(); },
        }),
      }),
    };

    const result = await syncPaymentStatusForCompany("99", {
      makeRequest: makeRequest({
        body: { QueryResponse: { Invoice: [{ Id: "QB-ZERO", Balance: 0, TotalAmt: 0, PrivateNote: "" }] } },
      }) as any,
      getQbIntegration: async () => ({ realmId: "r1", accessToken: "t1", connectionStatus: "connected" }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    assert.equal(result.qbVoided, 0, "no void flag for $0 invoice without Voided marker");
    assert.equal(updates[0].paymentStatus, "unpaid", "paymentStatus should be 'unpaid' (not paid) for $0 invoice");
  });

  it("skips no-QBO company and stamps throttle timestamp (prevents repeated integration lookup)", async () => {
    const result = await syncPaymentStatusForCompany("77", {
      makeRequest: makeRequest() as any,
      getQbIntegration: async () => null,
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: makeFakeDb([]),
    });

    assert.equal(result.skippedNoQb, true);
    // After the skip, the company should be throttled so repeated mounts
    // don't re-run the integration lookup within the throttle window.
    assert.equal(isThrottled("77"), true, "company should be throttled after no-QB skip");
  });

  it("skips invoices not returned by QBO (unknown/voided)", async () => {
    const updates: any[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 4, quickbooksInvoiceId: "QB-MISSING", totalAmount: "500.00", paymentStatus: "unpaid", status: "generated" },
            ]),
        }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => {
            updates.push(vals);
            return Promise.resolve();
          },
        }),
      }),
    };

    const result = await syncPaymentStatusForCompany("42", {
      makeRequest: makeRequest({
        body: { QueryResponse: { Invoice: [] } },
      }) as any,
      getQbIntegration: async () => ({
        realmId: "realm-1",
        accessToken: "tok",
        connectionStatus: "connected",
      }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    assert.equal(result.invoicesChecked, 1);
    assert.equal(updates.length, 0);
  });

  it("returns skippedNoQb=true when QBO returns 401 (expired/revoked token)", async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 10, quickbooksInvoiceId: "QB-10", totalAmount: "300.00", paymentStatus: "unpaid", status: "generated" },
            ]),
        }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    };

    const result = await syncPaymentStatusForCompany("42", {
      makeRequest: makeRequest({ status: 401 }) as any,
      getQbIntegration: async () => ({
        realmId: "realm-1",
        accessToken: "expired-tok",
        connectionStatus: "connected",
      }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: fakeDb,
    });

    // Must be a graceful skip — not a thrown error / 502.
    // invoicesChecked reflects candidates found locally before QBO was contacted.
    assert.equal(result.skippedNoQb, true);
    assert.equal(result.invoicesChecked, 1);
    assert.equal(result.paid, 0);
  });

  it("throws when QBO returns non-OK response", async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: 5, quickbooksInvoiceId: "QB-5", totalAmount: "500.00", paymentStatus: "unpaid", status: "generated" },
            ]),
        }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    };

    await assert.rejects(
      () =>
        syncPaymentStatusForCompany("42", {
          makeRequest: makeRequest({ status: 500 }) as any,
          getQbIntegration: async () => ({
            realmId: "realm-1",
            accessToken: "tok",
            connectionStatus: "connected",
          }),
          apiBase: "https://sandbox-quickbooks.api.intuit.com",
          _db: fakeDb,
        }),
      (err: any) => {
        assert.ok(err.message.includes("500"));
        return true;
      },
    );
  });

  it("two simultaneous sync requests for the same company issue only one QBO batch query", async () => {
    // This exercises the per-company in-flight Promise guard. When two callers
    // hit syncPaymentStatusForCompany for the same company concurrently, the
    // second should attach to the first's in-flight Promise rather than issuing
    // a second QBO request.
    let qboQueryCount = 0;

    // makeRequest that counts QBO calls and resolves asynchronously so both
    // callers are guaranteed to be in flight before either returns.
    let resolveQbo!: (v: any) => void;
    const qboLatch = new Promise<any>((res) => { resolveQbo = res; });

    const slowMakeRequest = async (_url: string, _opts: any) => {
      qboQueryCount++;
      return qboLatch;
    };

    const deps = {
      makeRequest: slowMakeRequest as any,
      getQbIntegration: async () => ({
        realmId: "r-conc",
        accessToken: "t-conc",
        connectionStatus: "connected",
      }),
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      _db: makeFakeDb([
        { id: 77, quickbooksInvoiceId: "QB-77", totalAmount: "100.00", paymentStatus: "unpaid", status: "sent", qbVoidDetectedAt: null },
      ]),
    };

    // Start both calls simultaneously before unlocking QBO.
    const call1 = syncPaymentStatusForCompany("company-concurrent-test", deps);
    const call2 = syncPaymentStatusForCompany("company-concurrent-test", deps);

    // Allow the QBO call to complete once both callers are in flight.
    resolveQbo({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ QueryResponse: { Invoice: [{ Id: "QB-77", Balance: 100, TotalAmt: 100 }] } }),
      text: async () => "{}",
    });

    const [r1, r2] = await Promise.all([call1, call2]);

    assert.equal(qboQueryCount, 1, "QBO should only be queried once despite two simultaneous calls");
    assert.equal(r1.invoicesChecked, r2.invoicesChecked, "both callers should see the same invoicesChecked");
    assert.equal(r1.unpaid, r2.unpaid, "both callers should see the same unpaid count");
  });
});
