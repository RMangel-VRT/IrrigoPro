// Task #1888 — HTTP tests for the batch reminder preview and send.
//
// The point of this feature is the interlock, so the assertions that matter
// most here are assertions about the MAILER, not about a response body:
// previewing must not attempt a single email, and an invoice from another
// company must not be reachable by either endpoint.
//
// Covers:
//   (a) a mixed selection previewing into two groups with the correct skip
//       reason per invoice, and ZERO mailer calls before confirmation
//   (b) throttled invoices previewed as skipped, carrying their next-allowed
//       time
//   (c) the confirmed send producing a row per invoice — sent / skipped with
//       reason / failed with error — with one failure not aborting the rest
//   (d) eligibility re-checked at send time rather than trusted from the
//       preview payload
//   (e) company isolation on both endpoints, with no email attempted
//   (f) the capability guard, and the shape refusals (no tone, empty
//       selection, over the cap) — none of which reach the mailer

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createReminderCore,
  registerInvoiceReminderRoutes,
  DEFAULT_REMINDER_THROTTLE_DAYS,
  type ReminderMailer,
} from "./invoice-reminder-routes";
import {
  registerInvoiceReminderBatchRoutes,
  MAX_BATCH_REMINDER_INVOICES,
  REMINDER_CONFIRMATION_TTL_MS,
} from "./invoice-reminder-batch-routes";
import { hasCapability, CAN_SEND_INVOICE_EMAIL, type Capability } from "@workspace/shared";

// ── Harness ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function makeAuth(
  role: string,
  companyId: number | null = 1,
  userId = 7,
): RequestHandler {
  return (req: any, _res, next) => {
    req.authenticatedUserRole = role;
    req.authenticatedUserId = userId;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
}

/** Built from the real capability set, not a hand-copied mirror of it. */
function capabilityGuard(capability: Capability): RequestHandler {
  return (req: any, res, next) => {
    if (!hasCapability(req.authenticatedUserRole, capability)) {
      res.status(403).json({ message: "Access denied." });
      return;
    }
    next();
  };
}
const requireInvoiceSend = capabilityGuard(CAN_SEND_INVOICE_EMAIL);

interface SentEmail {
  to: string;
  customerName: string;
  invoiceNumber: string;
  pdfUrl: string;
  subject: string;
}

/** Overdue, sent, has a balance, has a PDF — the eligible baseline. */
function invoice(id: number, overrides: Record<string, any> = {}) {
  const overdueDays = overrides.overdueDays ?? 45;
  delete overrides.overdueDays;
  return {
    id,
    invoiceNumber: `INV-${id}`,
    companyId: 1,
    customerId: 100 + id,
    customerName: `Customer ${id}`,
    customerEmail: `ap${id}@customer.test`,
    status: "generated",
    createdAt: new Date(NOW.getTime() - overdueDays * DAY),
    dueDate: new Date(NOW.getTime() - overdueDays * DAY),
    sentAt: new Date(NOW.getTime() - (overdueDays - 1) * DAY),
    paidAt: null,
    paymentStatus: "unpaid",
    // A synced balance, so `balance` is trusted by the shared resolver.
    paymentSyncedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    balance: "300.00",
    totalAmount: "300.00",
    qbVoidDetectedAt: null,
    ...overrides,
  };
}

interface HarnessOptions {
  role?: string;
  companyId?: number | null;
  invoices?: Record<number, any>;
  pdfs?: Record<number, any>;
  reminders?: any[];
  /** Per-invoice mailer outcome. Default: everything succeeds. */
  sendResultFor?: (invoiceNumber: string) => { success: boolean; error?: string };
  throttleDays?: number;
  userId?: number;
}

function harness(opts: HarnessOptions = {}) {
  const sent: SentEmail[] = [];
  const created: any[] = [];
  const rows: Record<number, any> = opts.invoices ?? {};
  const pdfs: Record<number, any> =
    opts.pdfs ??
    Object.fromEntries(
      Object.keys(rows).map((id) => [id, { id: Number(id) + 900, pdfUrl: `/pdf/${id}.pdf` }]),
    );
  const reminders: any[] = opts.reminders ? [...opts.reminders] : [];
  let nextReminderId = 500;

  const mailer: ReminderMailer = async (to, customerName, invoiceNumber, pdfUrl, o) => {
    sent.push({ to, customerName, invoiceNumber, pdfUrl, subject: o.subject });
    return opts.sendResultFor?.(invoiceNumber) ?? { success: true };
  };

  const storageApi = {
    async getInvoiceById(id: number, companyId: number | null) {
      const row = rows[id];
      if (!row) return undefined;
      if (companyId !== null && row.companyId !== companyId) return undefined;
      return row;
    },
    async getInvoicePdfByInvoiceId(id: number) {
      return pdfs[id];
    },
    async getUser(_id: number) {
      return { id: 7, name: "Dana Books" };
    },
    async getCompanyProfile(_id: number) {
      return {
        id: 1,
        name: "Green Valley Irrigation",
        email: "billing@greenvalley.test",
        phone: "555-0100",
        logo: null,
        invoiceReminderThrottleDays: opts.throttleDays ?? DEFAULT_REMINDER_THROTTLE_DAYS,
      };
    },
    async getInvoiceReminders(invoiceId: number, companyId: number | null) {
      return reminders
        .filter((r) => r.invoiceId === invoiceId)
        .filter((r) => companyId == null || r.companyId === companyId)
        .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
    },
    async getLastDeliveredInvoiceReminder(invoiceId: number) {
      return reminders
        .filter((r) => r.invoiceId === invoiceId && r.deliveryStatus === "sent")
        .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0];
    },
    async createInvoiceReminder(row: any) {
      const saved = { id: nextReminderId++, deliveryError: null, ...row };
      reminders.push(saved);
      created.push(saved);
      return saved;
    },
  };

  const app = express();
  app.use(express.json());
  // Movable so a test can let a confirmation go stale without sleeping.
  const clock = { current: NOW };
  // One core for both registrations, exactly as production wires it.
  const core = createReminderCore({
    _storageApi: storageApi,
    _mailer: mailer,
    _loadPaymentTerms: async () => "net_30",
    _now: () => clock.current,
    _baseUrl: () => "https://irrigopro.test",
  });
  const routeDeps = {
    requireAuthentication: makeAuth(
      opts.role ?? "bookkeeper",
      opts.companyId ?? 1,
      opts.userId ?? 7,
    ),
    requireInvoiceSend,
    _core: core,
    _now: () => clock.current,
  };
  registerInvoiceReminderRoutes(app, routeDeps);
  registerInvoiceReminderBatchRoutes(app, routeDeps);

  return { app, sent, created, rows, reminders, clock };
}

async function request(app: Express, path: string, body?: unknown) {
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, res));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: Record<string, any> = {};
    try {
      parsed = (await r.json()) as Record<string, any>;
    } catch {
      parsed = {};
    }
    return { status: r.status, body: parsed, raw: JSON.stringify(parsed) };
  } finally {
    server.close();
  }
}

const preview = (app: Express, body: unknown) =>
  request(app, "/api/invoices/reminders/preview", body);

/** A raw POST to the send endpoint — what a client that skipped the list does. */
const batchRaw = (app: Express, body: unknown) =>
  request(app, "/api/invoices/reminders/batch", body);

/**
 * The only order the server accepts: read the list, then send exactly what it
 * described. Every send below goes through here, because a send that has not
 * been preceded by a confirmation is refused before it can reach the mailer.
 */
async function batch(app: Express, body: any) {
  const listed = await preview(app, body);
  return batchRaw(app, {
    ...body,
    confirmationToken: listed.body?.confirmationToken,
  });
}

/**
 * A selection a bookkeeper would plausibly make off a Monday aging list: one
 * clean invoice and one of each way an invoice can be un-remindable.
 */
function mixedSelection() {
  return harness({
    invoices: {
      1: invoice(1),
      2: invoice(2, { paymentStatus: "paid", paidAt: new Date(NOW.getTime() - DAY) }),
      3: invoice(3, { sentAt: null }),
      4: invoice(4, { customerEmail: null }),
      5: invoice(5, { status: "draft" }),
      6: invoice(6, { qbVoidDetectedAt: new Date(NOW.getTime() - DAY) }),
      7: invoice(7),
      8: invoice(8, { status: "merged" }),
      // Another company's invoice, dropped into the selection.
      99: invoice(99, {
        companyId: 2,
        customerName: "Rival Landscaping",
        customerEmail: "ap@rival.test",
      }),
    },
    // Invoice 7 has no stored PDF at all.
    pdfs: {
      1: { id: 901, pdfUrl: "/pdf/1.pdf" },
      2: { id: 902, pdfUrl: "/pdf/2.pdf" },
      3: { id: 903, pdfUrl: "/pdf/3.pdf" },
      4: { id: 904, pdfUrl: "/pdf/4.pdf" },
      5: { id: 905, pdfUrl: "/pdf/5.pdf" },
      6: { id: 906, pdfUrl: "/pdf/6.pdf" },
      8: { id: 908, pdfUrl: "/pdf/8.pdf" },
      99: { id: 999, pdfUrl: "/pdf/99.pdf" },
    },
  });
}

const ALL_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 99];

function bySkipReason(body: any): Record<number, string> {
  const out: Record<number, string> = {};
  for (const row of body.willSkip ?? []) out[row.invoiceId] = row.reason;
  return out;
}

// ── (a) The confirmation list ───────────────────────────────────────────────

describe("POST /api/invoices/reminders/preview — the confirmation list", () => {
  it("attempts no email at all — the preview is a dry run", async () => {
    const h = mixedSelection();
    const res = await preview(h.app, { invoiceIds: ALL_IDS, templateKey: "firm" });

    assert.equal(res.status, 200);
    // The assertion this whole feature exists for, made on the mailer rather
    // than on anything rendered: nothing was attempted before confirmation.
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.created, []);
  });

  it("names every recipient that would be emailed, with the tone", async () => {
    const h = mixedSelection();
    const res = await preview(h.app, { invoiceIds: ALL_IDS, templateKey: "firm" });

    assert.deepEqual(
      res.body.willSend.map((r: any) => r.invoiceId),
      [1],
    );
    const row = res.body.willSend[0];
    // The address is present in full. A count would not be a confirmation.
    assert.equal(row.recipientEmail, "ap1@customer.test");
    assert.equal(row.customerName, "Customer 1");
    assert.equal(row.invoiceNumber, "INV-1");
    assert.equal(row.templateKey, "firm");
    assert.equal(row.templateLabel, "Firm reminder");
    assert.equal(row.balanceDue, "300.00");
    assert.equal(row.daysOverdue, 45);
  });

  it("gives each skipped invoice its own reason", async () => {
    const h = mixedSelection();
    const res = await preview(h.app, { invoiceIds: ALL_IDS, templateKey: "firm" });

    assert.deepEqual(bySkipReason(res.body), {
      2: "paid",
      3: "never_sent",
      4: "no_customer_email",
      5: "draft",
      6: "qb_voided",
      7: "no_pdf",
      8: "merged",
    });
    // Each one explains itself rather than sharing a generic sentence.
    const messages = res.body.willSkip.map((r: any) => r.message);
    assert.equal(new Set(messages).size, messages.length);
    for (const m of messages) assert.ok(m.length > 20, `terse skip reason: ${m}`);
  });

  it("reports a mixed selection as a normal thing to have done", async () => {
    const h = mixedSelection();
    const res = await preview(h.app, { invoiceIds: ALL_IDS, templateKey: "firm" });

    // Ineligible rows neither block the eligible one nor vanish from the
    // answer: every selected id is accounted for exactly once.
    assert.deepEqual(res.body.counts, {
      selected: 9,
      willSend: 1,
      willSkip: 7,
      notFound: 1,
    });
    const seen = [
      ...res.body.willSend.map((r: any) => r.invoiceId),
      ...res.body.willSkip.map((r: any) => r.invoiceId),
      ...res.body.notFound,
    ].sort((a, b) => a - b);
    assert.deepEqual(seen, ALL_IDS);
  });

  it("resolves the suggested tone per invoice, by that invoice's age", async () => {
    const h = harness({
      invoices: {
        // 10 / 45 / 120 days overdue — one invoice in each aging bucket.
        1: invoice(1, { overdueDays: 10 }),
        2: invoice(2, { overdueDays: 45 }),
        3: invoice(3, { overdueDays: 120 }),
      },
    });
    const res = await preview(h.app, { invoiceIds: [1, 2, 3], templateKey: "suggested" });

    assert.deepEqual(
      res.body.willSend.map((r: any) => [r.invoiceId, r.templateKey]),
      [
        [1, "friendly"],
        [2, "firm"],
        [3, "final_notice"],
      ],
    );
    assert.deepEqual(h.sent, []);
  });

  it("applies one chosen tone to every invoice when the sender picks one", async () => {
    const h = harness({
      invoices: { 1: invoice(1, { overdueDays: 10 }), 2: invoice(2, { overdueDays: 120 }) },
    });
    const res = await preview(h.app, { invoiceIds: [1, 2], templateKey: "final_notice" });

    assert.deepEqual(
      res.body.willSend.map((r: any) => r.templateKey),
      ["final_notice", "final_notice"],
    );
  });
});

// ── (b) Throttled invoices ──────────────────────────────────────────────────

describe("batch reminders — the throttle", () => {
  function throttled() {
    return harness({
      invoices: { 1: invoice(1), 2: invoice(2) },
      reminders: [
        {
          id: 1,
          invoiceId: 2,
          companyId: 1,
          sentAt: new Date(NOW.getTime() - 2 * DAY),
          deliveryStatus: "sent",
          sequenceNumber: 1,
          recipientEmail: "ap2@customer.test",
          templateKey: "friendly",
        },
      ],
    });
  }

  it("previews a throttled invoice as skipped, saying when it is next allowed", async () => {
    const h = throttled();
    const res = await preview(h.app, { invoiceIds: [1, 2], templateKey: "firm" });

    const skipped = res.body.willSkip.find((r: any) => r.invoiceId === 2);
    assert.equal(skipped.reason, "throttled");
    assert.equal(
      skipped.nextAllowedAt,
      new Date(NOW.getTime() - 2 * DAY + DEFAULT_REMINDER_THROTTLE_DAYS * DAY).toISOString(),
    );
    assert.match(skipped.message, /INV-2/);
    // And the eligible one beside it is still offered.
    assert.deepEqual(
      res.body.willSend.map((r: any) => r.invoiceId),
      [1],
    );
    assert.deepEqual(h.sent, []);
  });

  it("skips it on the confirmed send too, and mails no one twice", async () => {
    const h = throttled();
    const res = await batch(h.app, { invoiceIds: [1, 2], templateKey: "firm" });

    const row = res.body.results.find((r: any) => r.invoiceId === 2);
    assert.equal(row.outcome, "skipped");
    assert.equal(row.reason, "throttled");
    assert.ok(row.nextAllowedAt, "a throttled result must say when it is next allowed");
    assert.deepEqual(
      h.sent.map((e) => e.invoiceNumber),
      ["INV-1"],
    );
  });

  it("counts a repeated id once rather than mailing twice", async () => {
    const h = harness({ invoices: { 1: invoice(1) } });
    const res = await batch(h.app, { invoiceIds: [1, 1, 1], templateKey: "firm" });

    assert.equal(res.body.summary.sent, 1);
    assert.equal(h.sent.length, 1);
  });
});

// ── (c) The confirmed send ──────────────────────────────────────────────────

describe("POST /api/invoices/reminders/batch — the confirmed send", () => {
  it("emails exactly the invoices the preview said it would", async () => {
    const h = mixedSelection();
    const res = await batch(h.app, { invoiceIds: ALL_IDS, templateKey: "firm" });

    assert.equal(res.status, 200);
    assert.deepEqual(h.sent.map((e) => e.to), ["ap1@customer.test"]);
    assert.deepEqual(res.body.summary, {
      selected: 9,
      sent: 1,
      skipped: 7,
      failed: 0,
      notFound: 1,
    });
  });

  it("returns a readable row per invoice — sent, skipped with reason, or failed", async () => {
    const h = mixedSelection();
    const res = await batch(h.app, { invoiceIds: ALL_IDS, templateKey: "firm" });

    const byId: Record<number, any> = {};
    for (const r of res.body.results) byId[r.invoiceId] = r;

    assert.equal(byId[1].outcome, "sent");
    assert.equal(byId[1].recipientEmail, "ap1@customer.test");
    assert.equal(byId[1].templateLabel, "Firm reminder");
    assert.equal(byId[2].outcome, "skipped");
    assert.equal(byId[2].reason, "paid");
    assert.match(byId[2].message, /already paid/i);
    assert.equal(byId[7].reason, "no_pdf");
    // Every selected, visible invoice has a row. Nothing is silently dropped.
    assert.deepEqual(
      Object.keys(byId).map(Number).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    for (const row of res.body.results) {
      assert.ok(row.message, `invoice ${row.invoiceId} came back with no explanation`);
    }
  });

  it("records each send through the single-send path's reminder history", async () => {
    const h = harness({ invoices: { 1: invoice(1), 2: invoice(2) } });
    await batch(h.app, { invoiceIds: [1, 2], templateKey: "firm" });

    assert.equal(h.created.length, 2);
    for (const row of h.created) {
      assert.equal(row.deliveryStatus, "sent");
      assert.equal(row.sequenceNumber, 1);
      assert.equal(row.templateKey, "firm");
      assert.equal(row.sentByUserId, 7);
      assert.equal(row.sentByName, "Dana Books");
      assert.equal(row.balanceAtSend, "300.00");
    }
  });

  it("keeps going after one invoice fails, and reports the error against it", async () => {
    const h = harness({
      invoices: { 1: invoice(1), 2: invoice(2), 3: invoice(3) },
      sendResultFor: (number) =>
        number === "INV-2"
          ? { success: false, error: "550 mailbox unavailable" }
          : { success: true },
    });
    const res = await batch(h.app, { invoiceIds: [1, 2, 3], templateKey: "firm" });

    assert.equal(res.status, 200);
    // The other two still went out — a bounce is not a batch abort.
    assert.deepEqual(h.sent.map((e) => e.invoiceNumber), ["INV-1", "INV-2", "INV-3"]);
    assert.deepEqual(res.body.summary, {
      selected: 3,
      sent: 2,
      skipped: 0,
      failed: 1,
      notFound: 0,
    });
    const failed = res.body.results.find((r: any) => r.invoiceId === 2);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.error, "550 mailbox unavailable");
    assert.match(failed.message, /INV-2/);
    // Recorded as a failed attempt, consuming no sequence number, exactly as
    // the single send records one.
    const record = h.created.find((r) => r.invoiceId === 2);
    assert.equal(record.deliveryStatus, "failed");
    assert.equal(record.sequenceNumber, null);
  });

  it("survives an unexpected throw on one invoice", async () => {
    const h = harness({
      invoices: { 1: invoice(1), 2: invoice(2) },
      sendResultFor: (number) => {
        if (number === "INV-1") throw new Error("mail provider exploded");
        return { success: true };
      },
    });
    const res = await batch(h.app, { invoiceIds: [1, 2], templateKey: "firm" });

    assert.equal(res.status, 200);
    assert.equal(res.body.summary.sent, 1);
    const failed = res.body.results.find((r: any) => r.invoiceId === 1);
    assert.equal(failed.outcome, "failed");
    assert.match(failed.error, /exploded/);
  });
});

// ── (d) Re-checked at send time ─────────────────────────────────────────────

describe("batch reminders — the preview payload is never trusted", () => {
  it("re-checks eligibility at send time, not against what the preview said", async () => {
    const h = harness({ invoices: { 1: invoice(1), 2: invoice(2) } });

    const before = await preview(h.app, { invoiceIds: [1, 2], templateKey: "firm" });
    assert.equal(before.body.counts.willSend, 2);

    // Someone posts a payment between the confirmation list and the click.
    h.rows[2].paymentStatus = "paid";
    h.rows[2].paidAt = NOW;

    const res = await batch(h.app, { invoiceIds: [1, 2], templateKey: "firm" });
    const row = res.body.results.find((r: any) => r.invoiceId === 2);
    assert.equal(row.outcome, "skipped");
    assert.equal(row.reason, "paid");
    assert.deepEqual(h.sent.map((e) => e.invoiceNumber), ["INV-1"]);
  });

  it("ignores an address supplied by the caller and uses the invoice's own", async () => {
    const h = harness({ invoices: { 1: invoice(1) } });
    await batch(h.app, {
      invoiceIds: [1],
      templateKey: "firm",
      recipientEmail: "attacker@evil.test",
      willSend: [{ invoiceId: 1, recipientEmail: "attacker@evil.test" }],
    });

    assert.deepEqual(h.sent.map((e) => e.to), ["ap1@customer.test"]);
  });
});

// ── (e) Company isolation ───────────────────────────────────────────────────

describe("batch reminders — company isolation", () => {
  const foreign = () =>
    harness({
      invoices: {
        1: invoice(1),
        99: invoice(99, {
          companyId: 2,
          customerName: "Rival Landscaping",
          customerEmail: "ap@rival.test",
        }),
      },
    });

  it("does not preview another company's invoice, or name it", async () => {
    const h = foreign();
    const res = await preview(h.app, { invoiceIds: [1, 99], templateKey: "firm" });

    assert.deepEqual(res.body.notFound, [99]);
    assert.equal(
      res.body.willSend.find((r: any) => r.invoiceId === 99),
      undefined,
    );
    assert.equal(
      res.body.willSkip.find((r: any) => r.invoiceId === 99),
      undefined,
    );
    // Nothing about that customer crosses the boundary — not the name, not
    // the address, not even as a skip reason.
    assert.ok(!res.raw.includes("Rival"));
    assert.ok(!res.raw.includes("rival.test"));
    assert.deepEqual(h.sent, []);
  });

  it("does not send to another company's invoice", async () => {
    const h = foreign();
    const res = await batch(h.app, { invoiceIds: [99], templateKey: "firm" });

    assert.deepEqual(res.body.notFound, [99]);
    assert.deepEqual(res.body.results, []);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.created, []);
    assert.ok(!res.raw.includes("rival.test"));
  });

  it("still sends the caller's own invoices in the same selection", async () => {
    const h = foreign();
    const res = await batch(h.app, { invoiceIds: [1, 99], templateKey: "firm" });

    assert.deepEqual(h.sent.map((e) => e.to), ["ap1@customer.test"]);
    assert.equal(res.body.summary.sent, 1);
    assert.equal(res.body.summary.notFound, 1);
  });

  it("lets a super_admin reach both companies", async () => {
    const h = harness({
      role: "super_admin",
      companyId: null,
      invoices: { 1: invoice(1), 99: invoice(99, { companyId: 2 }) },
    });
    const res = await preview(h.app, { invoiceIds: [1, 99], templateKey: "firm" });

    assert.deepEqual(res.body.notFound, []);
    assert.equal(res.body.counts.willSend, 2);
    assert.deepEqual(h.sent, []);
  });
});

// ── (f) The guard and the shape refusals ────────────────────────────────────

describe("batch reminders — capability matrix", () => {
  for (const role of ["super_admin", "company_admin", "billing_manager", "bookkeeper"]) {
    it(`allows ${role}`, async () => {
      const h = harness({
        role,
        companyId: role === "super_admin" ? null : 1,
        invoices: { 1: invoice(1) },
      });
      const res = await preview(h.app, { invoiceIds: [1], templateKey: "firm" });
      assert.equal(res.status, 200);
    });
  }

  for (const role of ["field_tech", "supervisor", "customer", "nonsense_role"]) {
    it(`denies ${role} on both endpoints and never reaches the mailer`, async () => {
      const h = harness({ role, invoices: { 1: invoice(1) } });

      const p = await preview(h.app, { invoiceIds: [1], templateKey: "firm" });
      const b = await batch(h.app, { invoiceIds: [1], templateKey: "firm" });

      assert.equal(p.status, 403);
      assert.equal(b.status, 403);
      assert.deepEqual(h.sent, []);
      assert.deepEqual(h.created, []);
    });
  }
});

describe("batch reminders — refused requests", () => {
  it("refuses an empty selection", async () => {
    const h = harness({ invoices: { 1: invoice(1) } });
    const res = await batch(h.app, { invoiceIds: [], templateKey: "firm" });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /at least one invoice/i);
    assert.deepEqual(h.sent, []);
  });

  it("refuses to pick a tone for the sender", async () => {
    const h = harness({ invoices: { 1: invoice(1) } });
    const noTone = await batch(h.app, { invoiceIds: [1] });
    const nonsense = await batch(h.app, { invoiceIds: [1], templateKey: "shouty" });

    assert.equal(noTone.status, 400);
    assert.equal(nonsense.status, 400);
    assert.match(noTone.body.message, /friendly/);
    assert.deepEqual(h.sent, []);
  });

  it("refuses a selection larger than one readable confirmation list", async () => {
    const h = harness({ invoices: { 1: invoice(1) } });
    const ids = Array.from({ length: MAX_BATCH_REMINDER_INVOICES + 1 }, (_, i) => i + 1);
    const res = await batch(h.app, { invoiceIds: ids, templateKey: "firm" });

    assert.equal(res.status, 400);
    assert.match(res.body.message, new RegExp(String(MAX_BATCH_REMINDER_INVOICES)));
    assert.deepEqual(h.sent, []);
  });

  it("refuses a non-numeric invoice id", async () => {
    const h = harness({ invoices: { 1: invoice(1) } });
    const res = await batch(h.app, { invoiceIds: [1, "; drop"], templateKey: "firm" });

    assert.equal(res.status, 400);
    assert.deepEqual(h.sent, []);
  });
});

// ── (g) The confirmation interlock ──────────────────────────────────────────
//
// The dialog is not the safety mechanism — the server is. A batch send is only
// accepted when it is carrying a confirmation the preview issued for that exact
// reader, company, selection and tone, and only once. Every assertion here is
// about the MAILER: a refused confirmation must cost nobody an email.

describe("batch reminders — the confirmation interlock", () => {
  const one = () => harness({ invoices: { 1: invoice(1), 2: invoice(2) } });

  it("refuses a send from a client that never asked for the list", async () => {
    const h = one();
    const res = await batchRaw(h.app, { invoiceIds: [1, 2], templateKey: "firm" });

    assert.equal(res.status, 400);
    assert.equal(res.body.reason, "confirmation_required");
    assert.match(res.body.message, /no reminders were sent/i);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.created, []);
  });

  it("refuses a made-up confirmation", async () => {
    const h = one();
    for (const token of ["", "nonsense", `${Date.now() + 60_000}.abc.def`, 42]) {
      const res = await batchRaw(h.app, {
        invoiceIds: [1],
        templateKey: "firm",
        confirmationToken: token,
      });
      assert.ok(res.status === 400 || res.status === 409, `accepted ${String(token)}`);
    }
    assert.deepEqual(h.sent, []);
  });

  it("sends once the list has actually been read", async () => {
    const h = one();
    const listed = await preview(h.app, { invoiceIds: [1, 2], templateKey: "firm" });
    assert.ok(listed.body.confirmationToken, "the preview must issue a confirmation");
    // Reading the list sent nothing.
    assert.equal(h.sent.length, 0, "the preview must not attempt an email");

    const res = await batchRaw(h.app, {
      invoiceIds: [1, 2],
      templateKey: "firm",
      confirmationToken: listed.body.confirmationToken,
    });

    assert.equal(res.status, 200);
    assert.deepEqual(h.sent.map((e) => e.invoiceNumber).sort(), ["INV-1", "INV-2"]);
  });

  it("refuses a confirmation issued for a different selection", async () => {
    const h = one();
    // She previewed one invoice and posted two.
    const listed = await preview(h.app, { invoiceIds: [1], templateKey: "firm" });
    const res = await batchRaw(h.app, {
      invoiceIds: [1, 2],
      templateKey: "firm",
      confirmationToken: listed.body.confirmationToken,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.reason, "confirmation_mismatch");
    assert.deepEqual(h.sent, []);
  });

  it("refuses a confirmation issued for a different tone", async () => {
    const h = one();
    const listed = await preview(h.app, { invoiceIds: [1], templateKey: "friendly" });
    const res = await batchRaw(h.app, {
      invoiceIds: [1],
      templateKey: "final_notice",
      confirmationToken: listed.body.confirmationToken,
    });

    assert.equal(res.status, 409);
    assert.deepEqual(h.sent, []);
  });

  it("refuses a confirmation issued to somebody else", async () => {
    const hers = harness({ invoices: { 1: invoice(1) }, userId: 7 });
    const his = harness({ invoices: { 1: invoice(1) }, userId: 8 });

    const listed = await preview(hers.app, { invoiceIds: [1], templateKey: "firm" });
    const res = await batchRaw(his.app, {
      invoiceIds: [1],
      templateKey: "firm",
      confirmationToken: listed.body.confirmationToken,
    });

    assert.equal(res.status, 409);
    assert.deepEqual(his.sent, []);
    assert.deepEqual(hers.sent, []);
  });

  it("refuses a confirmation carried across a company boundary", async () => {
    const a = harness({ invoices: { 1: invoice(1) }, companyId: 1 });
    const b = harness({ invoices: { 1: invoice(1, { companyId: 2 }) }, companyId: 2 });

    const listed = await preview(a.app, { invoiceIds: [1], templateKey: "firm" });
    const res = await batchRaw(b.app, {
      invoiceIds: [1],
      templateKey: "firm",
      confirmationToken: listed.body.confirmationToken,
    });

    assert.equal(res.status, 409);
    assert.deepEqual(b.sent, []);
  });

  it("spends a confirmation on one run — a replay mails nobody twice", async () => {
    const h = one();
    const listed = await preview(h.app, { invoiceIds: [1, 2], templateKey: "firm" });
    const body = {
      invoiceIds: [1, 2],
      templateKey: "firm",
      confirmationToken: listed.body.confirmationToken,
    };

    const first = await batchRaw(h.app, body);
    const replay = await batchRaw(h.app, body);

    assert.equal(first.status, 200);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.reason, "confirmation_used");
    assert.deepEqual(h.sent.map((e) => e.invoiceNumber).sort(), ["INV-1", "INV-2"]);
  });

  it("refuses a confirmation left sitting past its window", async () => {
    const h = one();
    const listed = await preview(h.app, { invoiceIds: [1], templateKey: "firm" });

    // She walked away from the open dialog.
    h.clock.current = new Date(NOW.getTime() + REMINDER_CONFIRMATION_TTL_MS + 60_000);

    const res = await batchRaw(h.app, {
      invoiceIds: [1],
      templateKey: "firm",
      confirmationToken: listed.body.confirmationToken,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.reason, "confirmation_expired");
    assert.deepEqual(h.sent, []);
  });

  it("does not mind the order or the duplicates in the selection it confirmed", async () => {
    const h = one();
    const listed = await preview(h.app, { invoiceIds: [1, 2], templateKey: "firm" });
    const res = await batchRaw(h.app, {
      invoiceIds: [2, 1, 2],
      templateKey: "firm",
      confirmationToken: listed.body.confirmationToken,
    });

    assert.equal(res.status, 200);
    assert.deepEqual(h.sent.map((e) => e.invoiceNumber).sort(), ["INV-1", "INV-2"]);
  });

  it("refuses the selection before it asks about the confirmation", async () => {
    // A shape refusal must keep saying what is wrong with the selection rather
    // than blaming a confirmation the caller could not have obtained anyway.
    const h = one();
    const res = await batchRaw(h.app, { invoiceIds: [], templateKey: "firm" });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /at least one invoice/i);
    assert.deepEqual(h.sent, []);
  });
});
