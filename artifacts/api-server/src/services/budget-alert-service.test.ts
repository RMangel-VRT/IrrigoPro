// Task #693 — Financial Pulse Slice 4.
//
// Service-level tests for checkBudgetThresholds. Drives the production
// code path against a sqlite-shaped in-memory storage stub plus
// dispatcher seams (push, email), and verifies:
//   1. Single soft cross fires exactly once
//   2. Same soft cross does not fire twice (dedup via unique index)
//   3. Hard cross fires hard + soft (only hard if soft already fired)
//   4. New period rolls over (different periodKey ⇒ new fire allowed)
//   5. No cap configured ⇒ no fire
//   6. customer_notify_contact toggle gates the external email
//   7. Email-channel disabled ⇒ no internal email
//   8. Push failure does not prevent in-app or email dispatch
//   9. Top-level exception in dispatch is swallowed (invoice path not broken)

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../db";
import {
  customerBudgetAlertEvents,
  customerBudgetMonths,
  customers as customersTable,
  type Invoice,
  type Customer,
  type InsertNotification,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

// Real FK targets borrowed from the dev DB. The customer_budget_alert_events
// table has a hard FK to customers(id), so the test inserts a real row per
// test customer id and removes them all in after(). Picked an arbitrary
// existing companyId / userId so the customers FK to companies(id) also
// succeeds.
const TEST_COMPANY_ID = 2;
const TEST_RECIPIENT_USER_ID = 18;
const TEST_CUSTOMER_IDS: number[] = [];

import {
  checkBudgetThresholds,
  setPushDispatcher,
  setEmailDispatcher,
  resetPushDispatcher,
  resetEmailDispatcher,
} from "./budget-alert-service";
import { storage } from "../storage";

// ----- in-memory stubs ---------------------------------------------------

interface StubInvoice extends Omit<Invoice, "createdAt" | "updatedAt"> {
  createdAt: Date;
  updatedAt: Date;
}

const fakeState = {
  customer: null as Customer | null,
  invoices: [] as StubInvoice[],
  notifications: [] as InsertNotification[],
  company: { id: 10, name: "Acme Irrigation" } as any,
  user: { id: 42, email: "ops@acme.com", name: "Ops" } as any,
};

const originalGetCustomer = (storage as any).getCustomer.bind(storage);
const originalGetInvoicesByCustomer = (storage as any).getInvoicesByCustomer.bind(storage);
const originalCreateNotification = (storage as any).createNotification.bind(storage);
const originalGetCompanyProfile = (storage as any).getCompanyProfile.bind(storage);
const originalGetUser = (storage as any).getUser.bind(storage);

async function ensureRealCustomer(id: number) {
  const existing = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, id));
  if (existing.length === 0) {
    await db.execute(
      sql`INSERT INTO customers (id, company_id, name, email)
          VALUES (${id}, ${TEST_COMPANY_ID}, ${"Test Customer " + id}, ${"test" + id + "@example.test"})
          ON CONFLICT (id) DO NOTHING`,
    );
  }
  TEST_CUSTOMER_IDS.push(id);
}

async function cleanupRealCustomers() {
  if (TEST_CUSTOMER_IDS.length === 0) return;
  await db
    .delete(customerBudgetAlertEvents)
    .where(inArray(customerBudgetAlertEvents.customerId, TEST_CUSTOMER_IDS));
  await db
    .delete(customerBudgetMonths)
    .where(inArray(customerBudgetMonths.customerId, TEST_CUSTOMER_IDS));
  await db
    .delete(customersTable)
    .where(inArray(customersTable.id, TEST_CUSTOMER_IDS));
}

function installStubs() {
  (storage as any).getCustomer = async (id: number) =>
    fakeState.customer && fakeState.customer.id === id ? fakeState.customer : undefined;
  (storage as any).getInvoicesByCustomer = async (id: number) =>
    fakeState.invoices.filter((i) => i.customerId === id);
  (storage as any).createNotification = async (n: InsertNotification) => {
    fakeState.notifications.push(n);
    return { id: fakeState.notifications.length, ...n, createdAt: new Date() } as any;
  };
  (storage as any).getCompanyProfile = async (_id: number) => fakeState.company;
  (storage as any).getUser = async (_id: number) => fakeState.user;
}

function restoreStubs() {
  (storage as any).getCustomer = originalGetCustomer;
  (storage as any).getInvoicesByCustomer = originalGetInvoicesByCustomer;
  (storage as any).createNotification = originalCreateNotification;
  (storage as any).getCompanyProfile = originalGetCompanyProfile;
  (storage as any).getUser = originalGetUser;
}

const pushCalls: any[] = [];
const emailCalls: any[] = [];

function installDispatchers(opts?: { pushThrows?: boolean }) {
  pushCalls.length = 0;
  emailCalls.length = 0;
  setPushDispatcher(async (p) => {
    if (opts?.pushThrows) throw new Error("push down");
    pushCalls.push(p);
  });
  setEmailDispatcher(async (e) => {
    emailCalls.push(e);
  });
}

function makeCustomer(over: Partial<Customer> = {}): Customer {
  // Cast through unknown — we only touch the fields the service reads.
  const c: any = {
    id: 1,
    companyId: TEST_COMPANY_ID,
    name: "Big Lawn Co",
    email: "billing@biglawn.test",
    annualBudgetGoal: "10000.00",
    budgetSoftThresholdPercent: 75,
    budgetHardThresholdPercent: 100,
    budgetAlertRecipientUserIds: [42],
    budgetAlertChannels: { inApp: true, push: true, email: true },
    budgetNotifyCustomerContact: false,
    ...over,
  };
  return c as Customer;
}

function makeInvoice(over: Partial<StubInvoice> = {}): StubInvoice {
  const now = new Date();
  const base: StubInvoice = {
    id: 100,
    invoiceNumber: "INV-100",
    customerId: 1,
    companyId: 1,
    customerName: "Big Lawn Co",
    customerEmail: "billing@biglawn.test",
    customerPhone: null as any,
    invoiceMonth: now.getMonth() + 1,
    invoiceYear: now.getFullYear(),
    periodStart: now,
    periodEnd: now,
    status: "sent",
    partsSubtotal: "0.00" as any,
    laborSubtotal: "0.00" as any,
    totalAmount: "800.00" as any,
    dueDate: null as any,
    sentAt: null as any,
    paidAt: null as any,
    quickbooksInvoiceId: null as any,
    quickbooksSyncToken: null as any,
    revision: 1,
    supersededByInvoiceId: null as any,
    mergedIntoInvoiceId: null as any,
    qbNote: null as any,
    billingType: 'monthly',
    paymentStatus: "unpaid",
    balance: null as any,
    paymentSyncedAt: null as any,
    qbVoidDetectedAt: null as any,
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...over };
}

async function clearAlertRows(customerId: number) {
  await db
    .delete(customerBudgetAlertEvents)
    .where(eq(customerBudgetAlertEvents.customerId, customerId));
}

// ----- tests -------------------------------------------------------------

describe("budget-alert-service.checkBudgetThresholds", () => {
  before(async () => {
    installStubs();
    installDispatchers();
    // Insert real customer rows so the FK on customer_budget_alert_events
    // is satisfied. Ids are unique to this test file.
    for (const id of [70001, 70002, 70003, 70004, 70005, 70006, 70007, 70008, 70009, 70010, 70011]) {
      await ensureRealCustomer(id);
    }
    const now = new Date();
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    for (const id of [70001, 70002, 70003, 70004, 70006, 70007, 70008, 70009, 70010, 70011]) {
      await db.execute(sql`
        INSERT INTO customer_budget_months
          (company_id, customer_id, year, month, amount, is_manual_override)
        VALUES
          (${TEST_COMPANY_ID}, ${id}, ${now.getFullYear()}, ${now.getMonth() + 1}, 1000.00, false),
          (${TEST_COMPANY_ID}, ${id}, ${previousMonth.getFullYear()}, ${previousMonth.getMonth() + 1}, 1000.00, false)
        ON CONFLICT (company_id, customer_id, year, month)
          DO UPDATE SET amount = 1000.00
      `);
    }
  });
  after(async () => {
    await cleanupRealCustomers();
    restoreStubs();
    resetPushDispatcher();
    resetEmailDispatcher();
  });
  beforeEach(async () => {
    fakeState.customer = null;
    fakeState.invoices = [];
    fakeState.notifications = [];
    pushCalls.length = 0;
    emailCalls.length = 0;
    // Use a unique customer id per test to avoid cross-pollution from
    // the real customer_budget_alert_events unique index in the dev DB.
    // Each test sets its own customer id.
  });

  it("fires soft once when an invoice crosses the soft threshold", async () => {
    const customerId = 70001;
    await clearAlertRows(customerId);
    fakeState.customer = makeCustomer({ id: customerId });
    const inv = makeInvoice({ customerId, totalAmount: "800.00" as any });
    fakeState.invoices = [inv];

    await checkBudgetThresholds(inv as unknown as Invoice);

    assert.equal(fakeState.notifications.length, 1, "one in-app row inserted");
    assert.equal(fakeState.notifications[0].type, "budget_warning");
    assert.equal(pushCalls.length, 1);
    assert.equal(emailCalls.length, 1);
    const rows = await db
      .select()
      .from(customerBudgetAlertEvents)
      .where(eq(customerBudgetAlertEvents.customerId, customerId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].threshold, "soft");
    assert.equal(rows[0].period, "monthly");

    await clearAlertRows(customerId);
  });

  it("is idempotent — second invoice in same period+threshold does not re-fire", async () => {
    const customerId = 70002;
    await clearAlertRows(customerId);
    fakeState.customer = makeCustomer({ id: customerId });
    const inv1 = makeInvoice({ id: 201, customerId, totalAmount: "800.00" as any });
    fakeState.invoices = [inv1];
    await checkBudgetThresholds(inv1 as unknown as Invoice);
    assert.equal(fakeState.notifications.length, 1);

    // Second invoice in the same period (still under hard cap).
    const inv2 = makeInvoice({ id: 202, customerId, totalAmount: "50.00" as any });
    fakeState.invoices.push(inv2);
    fakeState.notifications = [];
    await checkBudgetThresholds(inv2 as unknown as Invoice);
    assert.equal(fakeState.notifications.length, 0, "no new in-app row");
    const rows = await db
      .select()
      .from(customerBudgetAlertEvents)
      .where(eq(customerBudgetAlertEvents.customerId, customerId));
    assert.equal(rows.length, 1, "still only one event row");

    await clearAlertRows(customerId);
  });

  it("fires both soft and hard when the same invoice crosses both", async () => {
    const customerId = 70003;
    await clearAlertRows(customerId);
    fakeState.customer = makeCustomer({ id: customerId });
    const inv = makeInvoice({ customerId, totalAmount: "1500.00" as any });
    fakeState.invoices = [inv];

    await checkBudgetThresholds(inv as unknown as Invoice);

    const rows = await db
      .select()
      .from(customerBudgetAlertEvents)
      .where(eq(customerBudgetAlertEvents.customerId, customerId));
    // monthly soft + monthly hard. Annual stays under (only 1500 / 10000).
    const monthRows = rows.filter((r) => r.period === "monthly");
    assert.equal(monthRows.length, 2);
    const thresholds = monthRows.map((r) => r.threshold).sort();
    assert.deepEqual(thresholds, ["hard", "soft"]);
    const types = fakeState.notifications.map((n) => n.type).sort();
    assert.deepEqual(types, ["budget_exceeded", "budget_warning"]);

    await clearAlertRows(customerId);
  });

  it("rolls over on a new period (different periodKey ⇒ new fire)", async () => {
    const customerId = 70004;
    await clearAlertRows(customerId);
    fakeState.customer = makeCustomer({ id: customerId });

    // Clamp to the 1st before subtracting the month to avoid end-of-month
    // overflow (e.g. July 31 - 1 month = "June 31" → July 1, which is the
    // same month as thisMonth and defeats the periodKey distinction test).
    const lastMonth = new Date();
    lastMonth.setDate(1);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const inv1 = makeInvoice({
      id: 401,
      customerId,
      totalAmount: "800.00" as any,
      createdAt: lastMonth,
    });
    fakeState.invoices = [inv1];
    await checkBudgetThresholds(inv1 as unknown as Invoice);
    assert.equal(fakeState.notifications.length, 1);

    // This month — fresh invoice, periodKey differs, must re-fire.
    fakeState.notifications = [];
    const thisMonth = new Date();
    const inv2 = makeInvoice({
      id: 402,
      customerId,
      totalAmount: "800.00" as any,
      createdAt: thisMonth,
    });
    fakeState.invoices.push(inv2);
    await checkBudgetThresholds(inv2 as unknown as Invoice);
    assert.equal(fakeState.notifications.length, 1, "new period fires again");
    const rows = await db
      .select()
      .from(customerBudgetAlertEvents)
      .where(eq(customerBudgetAlertEvents.customerId, customerId));
    const monthRows = rows.filter((r) => r.period === "monthly" && r.threshold === "soft");
    assert.equal(monthRows.length, 2, "two distinct period rows");
    const keys = new Set(monthRows.map((r) => r.periodKey));
    assert.equal(keys.size, 2, "two distinct period keys");

    await clearAlertRows(customerId);
  });

  it("does nothing when no cap is configured", async () => {
    const customerId = 70005;
    await clearAlertRows(customerId);
    fakeState.customer = makeCustomer({
      id: customerId,
      annualBudgetGoal: null as any,
    });
    const inv = makeInvoice({ customerId, totalAmount: "9999.00" as any });
    fakeState.invoices = [inv];

    await checkBudgetThresholds(inv as unknown as Invoice);
    assert.equal(fakeState.notifications.length, 0);
    assert.equal(pushCalls.length, 0);
    assert.equal(emailCalls.length, 0);
    const rows = await db
      .select()
      .from(customerBudgetAlertEvents)
      .where(eq(customerBudgetAlertEvents.customerId, customerId));
    assert.equal(rows.length, 0);
  });

  it("notifies the customer contact only when the toggle is on", async () => {
    const customerId = 70006;
    await clearAlertRows(customerId);

    // Toggle OFF — no external email sent (only internal).
    fakeState.customer = makeCustomer({
      id: customerId,
      budgetNotifyCustomerContact: false,
    });
    const inv = makeInvoice({ id: 601, customerId, totalAmount: "800.00" as any });
    fakeState.invoices = [inv];
    await checkBudgetThresholds(inv as unknown as Invoice);
    const internalOnly = emailCalls.filter((e) =>
      e.tag.endsWith("-external"),
    );
    assert.equal(internalOnly.length, 0, "no external email when toggle off");
    assert.ok(
      emailCalls.some((e) => e.tag.endsWith("-internal")),
      "internal email still sent",
    );

    // Toggle ON — external email is sent. Use a different customer id
    // so the unique index doesn't dedup the second run.
    await clearAlertRows(customerId);
    const customerId2 = 70007;
    await clearAlertRows(customerId2);
    fakeState.customer = makeCustomer({
      id: customerId2,
      budgetNotifyCustomerContact: true,
    });
    const inv2 = makeInvoice({ id: 602, customerId: customerId2, totalAmount: "800.00" as any });
    fakeState.invoices = [inv2];
    emailCalls.length = 0;
    await checkBudgetThresholds(inv2 as unknown as Invoice);
    const external = emailCalls.filter((e) => e.tag.endsWith("-external"));
    assert.equal(external.length, 1, "external customer email sent");
    assert.equal(external[0].to, "billing@biglawn.test");

    await clearAlertRows(customerId2);
  });

  it("respects the email channel disabled flag (still fires in-app + push)", async () => {
    const customerId = 70008;
    await clearAlertRows(customerId);
    fakeState.customer = makeCustomer({
      id: customerId,
      budgetAlertChannels: { inApp: true, push: true, email: false } as any,
    });
    const inv = makeInvoice({ customerId, totalAmount: "800.00" as any });
    fakeState.invoices = [inv];

    await checkBudgetThresholds(inv as unknown as Invoice);
    assert.equal(fakeState.notifications.length, 1);
    assert.equal(pushCalls.length, 1);
    const internal = emailCalls.filter((e) => e.tag.endsWith("-internal"));
    assert.equal(internal.length, 0, "no internal email when channel disabled");

    await clearAlertRows(customerId);
  });

  it("isolates channel failures — push failure does not block in-app or email", async () => {
    const customerId = 70009;
    await clearAlertRows(customerId);
    installDispatchers({ pushThrows: true });
    fakeState.customer = makeCustomer({ id: customerId });
    const inv = makeInvoice({ customerId, totalAmount: "800.00" as any });
    fakeState.invoices = [inv];

    await checkBudgetThresholds(inv as unknown as Invoice);
    assert.equal(fakeState.notifications.length, 1, "in-app still delivered");
    assert.equal(
      emailCalls.filter((e) => e.tag.endsWith("-internal")).length,
      1,
      "internal email still delivered",
    );
    // Event row still recorded so the next invoice dedups correctly.
    const rows = await db
      .select()
      .from(customerBudgetAlertEvents)
      .where(eq(customerBudgetAlertEvents.customerId, customerId));
    assert.equal(rows.length, 1);

    // Restore non-throwing dispatcher for subsequent tests.
    installDispatchers();
    await clearAlertRows(customerId);
  });

  it("swallows top-level errors — invoice path is never broken", async () => {
    const customerId = 70010;
    await clearAlertRows(customerId);
    // Force getCustomer to throw.
    const prev = (storage as any).getCustomer;
    (storage as any).getCustomer = async () => {
      throw new Error("db down");
    };
    const inv = makeInvoice({ customerId, totalAmount: "800.00" as any });
    // Must not throw.
    await checkBudgetThresholds(inv as unknown as Invoice);
    (storage as any).getCustomer = prev;
  });

  // Task #1864 — pendingNotBilled (uninvoiced WCBs) alone crossing the
  // threshold triggers an alert. Previously only invoiced amounts were
  // counted, so a customer with only WCBs could show "over budget" on the
  // dashboard without ever receiving an alert.
  it("fires when uninvoiced wet-check billings alone push spend over threshold", async () => {
    const customerId = 70009; // reuse slot; clearAlertRows called first
    await clearAlertRows(customerId);
    installDispatchers(); // reset push/email call lists

    // Intercept db.select for the duration of checkBudgetThresholds so the
    // WCB query inside computeCustomerSpend returns a $850 uninvoiced billing
    // (invoiceId=null). We restore the real implementation immediately after
    // so the assertion query hits the real dev DB.
    // ESM module exports are sealed so we cannot patch computeCustomerSpend
    // directly — instead we shim db.select on the db object.
    const realSelect = (db as any).select.bind(db);
    const wcbProxy: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: any[]) => void) =>
            resolve([{ invoiceId: null, totalAmount: "850.00", workDate: new Date() }]);
        }
        return () => wcbProxy;
      },
    });
    let selectCall = 0;
    const allocationProxy: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: any[]) => void) => resolve([{ amount: "1000.00" }]);
        }
        return () => allocationProxy;
      },
    });
    (db as any).select = () => {
      selectCall += 1;
      return selectCall === 1 ? allocationProxy : wcbProxy;
    };

    fakeState.customer = makeCustomer({ id: customerId });
    // Invoice is $0 — all spend comes from the mocked WCB.
    const inv = makeInvoice({ customerId, totalAmount: "0.00" as any });
    fakeState.invoices = [inv];

    await checkBudgetThresholds(inv as unknown as Invoice);

    // Restore real db.select before running assertion queries.
    (db as any).select = realSelect;

    // 850 / 1000 monthly cap = 85% > 75% soft → must fire a soft alert.
    assert.ok(
      fakeState.notifications.some((n) => n.type === "budget_warning"),
      "soft alert must fire when pendingNotBilled alone crosses soft threshold",
    );

    await clearAlertRows(customerId);
    installDispatchers();
  });

  // Task #1864 — Company isolation: alert service must pass customer.companyId
  // (not null) when querying invoices, so a multi-tenant database leak cannot
  // read another company's invoices to inflate a customer's budget spend.
  it("passes customer.companyId (not null) to getInvoicesByCustomer — company scoping", async () => {
    const customerId = 70009; // reuse slot after clearAlertRows
    await clearAlertRows(customerId);

    let capturedCompanyId: number | null | undefined = undefined;
    const originalGetInvoicesByCustomer = (storage as any).getInvoicesByCustomer;
    (storage as any).getInvoicesByCustomer = async (
      id: number,
      companyId: number | null,
    ) => {
      capturedCompanyId = companyId;
      return fakeState.invoices.filter((i) => i.customerId === id);
    };

    const COMPANY_ID = 55;
    fakeState.customer = makeCustomer({ id: customerId, companyId: COMPANY_ID });
    const inv = makeInvoice({ customerId, totalAmount: "800.00" as any });
    fakeState.invoices = [inv];

    await checkBudgetThresholds(inv as unknown as Invoice);

    assert.equal(
      capturedCompanyId,
      COMPANY_ID,
      `expected companyId=${COMPANY_ID} but got ${capturedCompanyId} — null would bypass company scoping`,
    );

    // Restore
    (storage as any).getInvoicesByCustomer = originalGetInvoicesByCustomer;
    await clearAlertRows(customerId);
  });

  // Task #1911 — budget regression guard. Keep this even though the top-level
  // catch already existed: it is what proves the storage reader throwing is
  // *safe* here. getInvoicesByCustomer used to return [] on a database error,
  // which made spend compute to zero — an over-cap customer silently evaluated
  // as healthy and no alert ever fired. Now the query throws, and the required
  // behaviour is "evaluate nothing", not "evaluate against zero".
  it("does not evaluate thresholds against zero spend when the invoice query fails", async () => {
    const customerId = 70011;
    await clearAlertRows(customerId);
    installDispatchers();

    const originalGetInvoicesByCustomer = (storage as any).getInvoicesByCustomer;
    (storage as any).getInvoicesByCustomer = async () => {
      throw new Error("Failed query: timeout exceeded when trying to connect");
    };

    // This customer is way over their $1,000 monthly cap in reality. With the
    // old swallow, spend read as $0 and this call quietly concluded "healthy".
    fakeState.customer = makeCustomer({ id: customerId });
    const inv = makeInvoice({ id: 1101, customerId, totalAmount: "5000.00" as any });
    fakeState.invoices = [inv];

    try {
      // Must not throw — an alert-pipeline problem must never break the
      // invoice write that triggered it.
      await checkBudgetThresholds(inv as unknown as Invoice);

      assert.equal(
        fakeState.notifications.length,
        0,
        "no in-app notification may be raised from an unknown spend",
      );
      assert.equal(pushCalls.length, 0, "no push from an unknown spend");
      assert.equal(emailCalls.length, 0, "no email from an unknown spend");

      const rows = await db
        .select()
        .from(customerBudgetAlertEvents)
        .where(eq(customerBudgetAlertEvents.customerId, customerId));
      assert.equal(
        rows.length,
        0,
        "no threshold may be recorded as evaluated — recording one would " +
          "suppress the real alert once the database recovers",
      );
    } finally {
      (storage as any).getInvoicesByCustomer = originalGetInvoicesByCustomer;
      await clearAlertRows(customerId);
    }
  });
});
