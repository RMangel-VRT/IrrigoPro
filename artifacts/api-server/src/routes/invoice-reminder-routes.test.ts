// Task #1887 — HTTP tests for the invoice payment reminder endpoints.
//
// Everything here asserts on the response body and on the mailer spy. Nothing
// asserts on rendered output, and nothing re-implements the handler's own
// logic and then agrees with itself.
//
// Covers:
//   (a) all ten refusals, each asserting its own distinct message, with the
//       two actionable ones naming their alternative action
//   (b) the throttle refusing a second send inside the window, reporting the
//       next allowed time, and then succeeding once the window passes
//   (c) a failed send recorded as failed WITHOUT consuming a sequence number
//   (d) captured balance / days-overdue / recipient surviving later changes to
//       the invoice and the customer
//   (e) days overdue in the email body matching the A/R list for the same
//       invoice on the same day
//   (f) company isolation — and no email attempted
//   (g) the capability guard matrix

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  registerInvoiceReminderRoutes,
  evaluateThrottle,
  DEFAULT_REMINDER_THROTTLE_DAYS,
  type ReminderMailer,
} from "./invoice-reminder-routes";
import { annotateInvoiceForAr } from "./invoice-list-routes";
import {
  hasCapability,
  CAN_SEND_INVOICE_EMAIL,
  CAN_VIEW_REMINDER_HISTORY,
  type Capability,
} from "@workspace/shared";

// ── Harness ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function makeAuth(role: string, companyId: number | null = 1): RequestHandler {
  return (req: any, _res, next) => {
    req.authenticatedUserRole = role;
    req.authenticatedUserId = 7;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
}

/** Guards built from the real capability sets, not a hand-copied mirror. */
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
const requireReminderHistoryRead = capabilityGuard(CAN_VIEW_REMINDER_HISTORY);

interface SentEmail {
  to: string;
  customerName: string;
  invoiceNumber: string;
  pdfUrl: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  categories?: string[];
}

function invoice(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    invoiceNumber: "INV-1",
    companyId: 1,
    customerId: 100,
    customerName: "Acme Grounds",
    customerEmail: "ap@acme.test",
    status: "generated",
    // 45 days before NOW, so the invoice is squarely in the 30–59 bucket.
    createdAt: new Date(NOW.getTime() - 45 * DAY),
    dueDate: new Date(NOW.getTime() - 45 * DAY),
    sentAt: new Date(NOW.getTime() - 44 * DAY),
    paidAt: null,
    paymentStatus: "unpaid",
    // A synced balance, so `balance` is real and not the invoice total
    // standing in for one — the shared resolver only trusts it once a payment
    // sync has run.
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
  sendResult?: { success: boolean; error?: string };
  now?: () => Date;
  throttleDays?: number;
  paymentTerms?: string | null;
}

function harness(opts: HarnessOptions = {}) {
  const sent: SentEmail[] = [];
  const created: any[] = [];
  const rows: Record<number, any> = opts.invoices ?? { 1: invoice() };
  const pdfs: Record<number, any> = opts.pdfs ?? { 1: { id: 9, pdfUrl: "/pdf/1.pdf" } };
  const reminders: any[] = opts.reminders ? [...opts.reminders] : [];
  let nextReminderId = 500;

  const mailer: ReminderMailer = async (to, customerName, invoiceNumber, pdfUrl, o) => {
    sent.push({
      to,
      customerName,
      invoiceNumber,
      pdfUrl,
      subject: o.subject,
      html: o.html,
      text: o.text,
      replyTo: o.replyTo,
      categories: o.categories,
    });
    return opts.sendResult ?? { success: true };
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
  registerInvoiceReminderRoutes(app, {
    requireAuthentication: makeAuth(opts.role ?? "bookkeeper", opts.companyId ?? 1),
    requireInvoiceSend,
    requireReminderHistoryRead,
    _storageApi: storageApi,
    _mailer: mailer,
    _loadPaymentTerms: async () => opts.paymentTerms ?? "net_30",
    _now: opts.now ?? (() => NOW),
    _baseUrl: () => "https://irrigopro.test",
  });

  return { app, sent, created, rows, reminders, storageApi };
}

async function request(
  app: Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, res));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: Record<string, any> = {};
    try {
      parsed = (await r.json()) as Record<string, any>;
    } catch {
      parsed = {};
    }
    return { status: r.status, body: parsed };
  } finally {
    server.close();
  }
}

const send = (app: Express, body: unknown = { templateKey: "firm" }) =>
  request(app, "POST", "/api/invoices/1/reminders", body);

// ── (a) The refusal matrix ──────────────────────────────────────────────────
//
// Each case is its own test asserting its own message, because the whole
// promise of this feature is that the bookkeeper is told what is wrong rather
// than handed a generic "cannot send".

describe("POST /api/invoices/:id/reminders — refusals", () => {
  async function refusalFor(overrides: Record<string, any>, pdfs?: Record<number, any>) {
    const h = harness({ invoices: { 1: invoice(overrides) }, ...(pdfs ? { pdfs } : {}) });
    const res = await send(h.app);
    return { ...res, sent: h.sent, created: h.created };
  }

  it("refuses a PAID invoice and says there is nothing to remind about", async () => {
    const { status, body, sent } = await refusalFor({
      status: "paid",
      paymentStatus: "paid",
      paidAt: new Date(NOW.getTime() - DAY),
    });
    assert.equal(status, 422);
    assert.equal(body.reason, "paid");
    assert.match(body.message, /already paid in full/i);
    assert.equal(sent.length, 0);
  });

  it("refuses a ZERO BALANCE invoice and says nothing is outstanding", async () => {
    const { status, body, sent } = await refusalFor({ balance: "0.00" });
    assert.equal(status, 422);
    assert.equal(body.reason, "zero_balance");
    assert.match(body.message, /zero balance/i);
    assert.equal(sent.length, 0);
  });

  it("refuses a CANCELLED invoice and says to reissue it", async () => {
    const { status, body, sent } = await refusalFor({ status: "cancelled" });
    assert.equal(status, 422);
    assert.equal(body.reason, "cancelled");
    assert.match(body.message, /cancelled/i);
    assert.match(body.message, /reissue/i);
    assert.equal(sent.length, 0);
  });

  it("refuses a SUPERSEDED invoice and points at the replacement", async () => {
    const { status, body, sent } = await refusalFor({ status: "superseded" });
    assert.equal(status, 422);
    assert.equal(body.reason, "superseded");
    assert.match(body.message, /replacement invoice/i);
    assert.equal(sent.length, 0);
  });

  it("refuses a MERGED invoice and points at the surviving invoice", async () => {
    const { status, body, sent } = await refusalFor({ status: "merged" });
    assert.equal(status, 422);
    assert.equal(body.reason, "merged");
    assert.match(body.message, /surviving invoice/i);
    assert.equal(sent.length, 0);
  });

  it("refuses a DRAFT invoice and says to finalise it first", async () => {
    const { status, body, sent } = await refusalFor({ status: "draft" });
    assert.equal(status, 422);
    assert.equal(body.reason, "draft");
    assert.match(body.message, /draft/i);
    assert.equal(sent.length, 0);
  });

  it("refuses when the customer has NO BILLING EMAIL and says to add one", async () => {
    const { status, body, sent } = await refusalFor({ customerEmail: "" });
    assert.equal(status, 422);
    assert.equal(body.reason, "no_customer_email");
    assert.match(body.message, /billing email/i);
    assert.equal(sent.length, 0);
  });

  it("refuses when QUICKBOOKS SHOWS IT VOIDED", async () => {
    const { status, body, sent } = await refusalFor({
      qbVoidDetectedAt: new Date(NOW.getTime() - DAY),
    });
    assert.equal(status, 422);
    assert.equal(body.reason, "qb_voided");
    assert.match(body.message, /voided/i);
    assert.equal(sent.length, 0);
  });

  it("refuses a NEVER SENT invoice and names 'send the invoice' as the fix", async () => {
    const { status, body, sent } = await refusalFor({ sentAt: null });
    assert.equal(status, 422);
    assert.equal(body.reason, "never_sent");
    assert.match(body.message, /never been sent/i);
    // The alternative action is the point: the row's call to action here is
    // send, not remind.
    assert.equal(body.action.kind, "send_invoice");
    assert.match(body.action.label, /send the invoice/i);
    assert.equal(sent.length, 0);
  });

  it("refuses when there is NO STORED PDF and names 'generate the PDF first'", async () => {
    // Reachable in real life: mailed on paper, manually marked sent, so sentAt
    // is set and the never-sent check passes while no PDF record exists.
    const { status, body, sent } = await refusalFor({}, {});
    assert.equal(status, 422);
    assert.equal(body.reason, "no_pdf");
    assert.match(body.message, /no saved PDF/i);
    assert.equal(body.action.kind, "generate_pdf");
    assert.match(body.action.label, /generate the pdf/i);
    // Not the bare "PDF not found" 404 dead end this work exists to remove.
    assert.notEqual(status, 404);
    assert.equal(sent.length, 0);
  });

  it("gives every refusal a distinct message", async () => {
    const cases: Record<string, any>[] = [
      { status: "paid" },
      { balance: "0.00" },
      { status: "cancelled" },
      { status: "superseded" },
      { status: "merged" },
      { status: "draft" },
      { customerEmail: null },
      { qbVoidDetectedAt: NOW },
      { sentAt: null },
    ];
    const messages = new Set<string>();
    for (const c of cases) {
      const { body } = await refusalFor(c);
      messages.add(body.message);
    }
    const { body: noPdf } = await refusalFor({}, {});
    messages.add(noPdf.message);
    assert.equal(messages.size, 10, "each refusal must explain itself in its own words");
  });

  it("refuses an unknown template rather than picking a tone for the sender", async () => {
    const h = harness();
    const { status, body } = await send(h.app, {});
    assert.equal(status, 400);
    assert.match(body.message, /choose which reminder/i);
    assert.equal(h.sent.length, 0);
  });
});

// ── (f) Company isolation ───────────────────────────────────────────────────

describe("POST /api/invoices/:id/reminders — company isolation", () => {
  it("404s for a company B invoice and attempts no email", async () => {
    const h = harness({ invoices: { 1: invoice({ companyId: 999 }) }, companyId: 1 });
    const { status, body } = await send(h.app);
    assert.equal(status, 404);
    assert.match(body.message, /not found/i);
    assert.equal(h.sent.length, 0, "no email may be attempted for another company's invoice");
    assert.equal(h.created.length, 0, "and nothing may be recorded");
  });

  it("shows a company B invoice no reminder history either", async () => {
    const h = harness({ invoices: { 1: invoice({ companyId: 999 }) }, companyId: 1 });
    const { status } = await request(h.app, "GET", "/api/invoices/1/reminders");
    assert.equal(status, 404);
    assert.equal(h.sent.length, 0);
  });
});

// ── (g) Capability guard matrix ─────────────────────────────────────────────

describe("invoice reminder endpoints — capability matrix", () => {
  const allowed = ["super_admin", "company_admin", "billing_manager", "bookkeeper"];
  const denied = ["field_tech", "irrigation_manager", "nonsense_role"];

  for (const role of allowed) {
    it(`allows ${role} to send`, async () => {
      const h = harness({ role, companyId: role === "super_admin" ? null : 1 });
      const { status } = await send(h.app);
      assert.equal(status, 201);
      assert.equal(h.sent.length, 1);
    });
  }

  for (const role of denied) {
    it(`denies ${role} and never reaches the mailer`, async () => {
      const h = harness({ role });
      const { status } = await send(h.app);
      assert.equal(status, 403);
      assert.equal(h.sent.length, 0);
      // Task #1921 — history is a separate READ capability. A send-denied role
      // that reads invoices (irrigation_manager) still gets the history; roles
      // outside CAN_VIEW_REMINDER_HISTORY are refused the read too.
      const hist = harness({ role });
      const res = await request(hist.app, "GET", "/api/invoices/1/reminders");
      assert.equal(res.status, hasCapability(role, CAN_VIEW_REMINDER_HISTORY) ? 200 : 403);
    });
  }
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("POST /api/invoices/:id/reminders — sending", () => {
  it("sends the chosen tone with the invoice PDF attached and records it", async () => {
    const h = harness();
    const { status, body } = await send(h.app, { templateKey: "final_notice" });
    assert.equal(status, 201);
    assert.equal(h.sent.length, 1);
    const mail = h.sent[0];
    assert.equal(mail.to, "ap@acme.test");
    assert.equal(mail.pdfUrl, "/pdf/1.pdf", "the stored invoice PDF is what gets attached");
    assert.match(mail.subject, /final notice/i);
    assert.match(mail.subject, /INV-1/);
    // Branding and reply-to come from the company profile.
    assert.match(mail.subject, /Green Valley Irrigation/);
    assert.equal(mail.replyTo, "billing@greenvalley.test");
    assert.deepEqual(mail.categories, ["invoice-payment-reminder"]);
    // Recorded exactly once, as reminder number one.
    assert.equal(h.created.length, 1);
    assert.equal(body.reminder.sequenceNumber, 1);
    assert.equal(body.reminder.deliveryStatus, "sent");
    assert.equal(body.reminder.templateKey, "final_notice");
    assert.equal(body.reminder.sentByName, "Dana Books");
  });

  it("honours the sender's tone rather than the bucket's suggestion", async () => {
    // A 45-day-old invoice suggests 'firm'; the sender picked 'friendly'.
    const h = harness();
    const { status } = await send(h.app, { templateKey: "friendly" });
    assert.equal(status, 201);
    assert.match(h.sent[0].subject, /friendly reminder/i);
    assert.equal(h.created[0].templateKey, "friendly");
  });

  it("numbers the second delivered reminder 2", async () => {
    const h = harness({
      reminders: [
        {
          id: 1,
          companyId: 1,
          invoiceId: 1,
          sentAt: new Date(NOW.getTime() - 30 * DAY),
          deliveryStatus: "sent",
          sequenceNumber: 1,
          recipientEmail: "ap@acme.test",
          templateKey: "friendly",
          balanceAtSend: "300.00",
          daysOverdueAtSend: 15,
        },
      ],
    });
    const { status, body } = await send(h.app);
    assert.equal(status, 201);
    assert.equal(body.reminder.sequenceNumber, 2);
  });
});

// ── (e) Days overdue parity with the A/R list ───────────────────────────────

describe("reminder email figures", () => {
  it("states the same days overdue the A/R list shows for the same invoice", async () => {
    const inv = invoice();
    const h = harness({ invoices: { 1: inv } });
    await send(h.app);

    // The A/R list's own annotation, over the same row, the same terms, and
    // the same clock. If either side ever re-derived its own figure, these two
    // numbers would drift and this assertion is where it would show up.
    const annotated = annotateInvoiceForAr(inv as any, "net_30", NOW);
    assert.equal(h.created[0].daysOverdueAtSend, annotated.daysOverdue);
    assert.match(h.sent[0].text, new RegExp(`${annotated.daysOverdue} days overdue`));
  });

  it("states the same balance due the A/R list shows", async () => {
    const inv = invoice({ balance: "175.50" });
    const h = harness({ invoices: { 1: inv } });
    await send(h.app);
    const annotated = annotateInvoiceForAr(inv as any, "net_30", NOW);
    assert.equal(h.created[0].balanceAtSend, annotated.balanceDue);
    assert.match(h.sent[0].text, /\$175\.50/);
  });
});

// ── (b) Throttle ────────────────────────────────────────────────────────────

describe("reminder throttle", () => {
  it("refuses a second reminder inside the window and says when the next is allowed", async () => {
    const lastSent = new Date(NOW.getTime() - 2 * DAY);
    const h = harness({
      reminders: [
        {
          id: 1,
          companyId: 1,
          invoiceId: 1,
          sentAt: lastSent,
          deliveryStatus: "sent",
          sequenceNumber: 1,
          recipientEmail: "ap@acme.test",
          templateKey: "friendly",
          balanceAtSend: "300.00",
          daysOverdueAtSend: 13,
        },
      ],
    });
    const { status, body } = await send(h.app);
    assert.equal(status, 429);
    assert.equal(body.reason, "throttled");
    // Never a silent no-op: the response carries the timestamp the button
    // needs in order to say when the next reminder can go out.
    assert.equal(body.nextAllowedAt, new Date(lastSent.getTime() + 7 * DAY).toISOString());
    assert.match(body.message, /next one can be sent on/i);
    assert.equal(h.sent.length, 0, "a throttled request must not reach the mailer");
    assert.equal(h.created.length, 0);
  });

  it("allows the send once the window has passed", async () => {
    const lastSent = new Date(NOW.getTime() - 8 * DAY);
    const h = harness({
      reminders: [
        {
          id: 1,
          companyId: 1,
          invoiceId: 1,
          sentAt: lastSent,
          deliveryStatus: "sent",
          sequenceNumber: 1,
          recipientEmail: "ap@acme.test",
          templateKey: "friendly",
          balanceAtSend: "300.00",
          daysOverdueAtSend: 7,
        },
      ],
    });
    const { status, body } = await send(h.app);
    assert.equal(status, 201);
    assert.equal(body.reminder.sequenceNumber, 2);
    assert.equal(h.sent.length, 1);
  });

  it("honours a company-configured window that is wider than the default", async () => {
    const lastSent = new Date(NOW.getTime() - 8 * DAY);
    const h = harness({
      throttleDays: 30,
      reminders: [
        {
          id: 1,
          companyId: 1,
          invoiceId: 1,
          sentAt: lastSent,
          deliveryStatus: "sent",
          sequenceNumber: 1,
          recipientEmail: "ap@acme.test",
          templateKey: "friendly",
          balanceAtSend: "300.00",
          daysOverdueAtSend: 7,
        },
      ],
    });
    const { status, body } = await send(h.app);
    assert.equal(status, 429);
    assert.equal(body.windowDays, 30);
    assert.equal(h.sent.length, 0);
  });

  it("does not count a FAILED attempt against the window", async () => {
    const h = harness({
      reminders: [
        {
          id: 1,
          companyId: 1,
          invoiceId: 1,
          sentAt: new Date(NOW.getTime() - DAY),
          deliveryStatus: "failed",
          sequenceNumber: null,
          deliveryError: "550 mailbox unavailable",
          recipientEmail: "ap@acme.test",
          templateKey: "friendly",
          balanceAtSend: "300.00",
          daysOverdueAtSend: 14,
        },
      ],
    });
    const { status } = await send(h.app);
    assert.equal(status, 201, "a bounce must not lock the invoice for a week");
  });

  it("evaluateThrottle reports the window, not just a boolean", () => {
    const last = new Date("2026-08-01T00:00:00.000Z");
    const inside = evaluateThrottle(last, 7, new Date("2026-08-05T00:00:00.000Z"));
    assert.equal(inside.throttled, true);
    assert.equal(inside.nextAllowedAt?.toISOString(), "2026-08-08T00:00:00.000Z");
    const outside = evaluateThrottle(last, 7, new Date("2026-08-09T00:00:00.000Z"));
    assert.equal(outside.throttled, false);
    assert.equal(outside.nextAllowedAt, null);
    const never = evaluateThrottle(null, 7, NOW);
    assert.equal(never.throttled, false);
  });
});

// ── (c) Failed sends ────────────────────────────────────────────────────────

describe("failed reminder sends", () => {
  it("records the failure with its error and consumes no sequence number", async () => {
    const h = harness({ sendResult: { success: false, error: "550 mailbox unavailable" } });
    const { status, body } = await send(h.app);
    assert.equal(status, 502);
    assert.equal(body.reason, "send_failed");
    assert.match(body.message, /does not count as a reminder/i);
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].deliveryStatus, "failed");
    assert.equal(h.created[0].deliveryError, "550 mailbox unavailable");
    assert.equal(h.created[0].sequenceNumber, null);
  });

  it("leaves the next successful send as reminder number one", async () => {
    const failed = {
      id: 1,
      companyId: 1,
      invoiceId: 1,
      sentAt: new Date(NOW.getTime() - 3 * DAY),
      deliveryStatus: "failed",
      sequenceNumber: null,
      deliveryError: "550 mailbox unavailable",
      recipientEmail: "old@acme.test",
      templateKey: "friendly",
      balanceAtSend: "300.00",
      daysOverdueAtSend: 12,
    };
    const h = harness({ reminders: [failed] });
    const { status, body } = await send(h.app);
    assert.equal(status, 201);
    assert.equal(
      body.reminder.sequenceNumber,
      1,
      "a bounce is not a reminder the customer received",
    );
  });
});

// ── (d) History stays truthful ──────────────────────────────────────────────

describe("GET /api/invoices/:id/reminders — history", () => {
  it("keeps the captured balance, days overdue and address after the invoice and customer change", async () => {
    const h = harness();
    await send(h.app, { templateKey: "firm" });
    const recorded = h.created[0];
    assert.equal(recorded.balanceAtSend, "300.00");
    assert.equal(recorded.recipientEmail, "ap@acme.test");
    const capturedDays = recorded.daysOverdueAtSend;

    // The customer part-pays and someone updates the billing email. Today's
    // invoice state is now different in every respect that the reminder
    // captured.
    h.rows[1].balance = "50.00";
    h.rows[1].customerEmail = "newap@acme.test";

    const later = () => new Date(NOW.getTime() + 20 * DAY);
    const h2 = harness({
      invoices: h.rows,
      reminders: h.reminders,
      now: later,
    });
    const { status, body } = await request(h2.app, "GET", "/api/invoices/1/reminders");
    assert.equal(status, 200);
    const row = body.reminders.find((r: any) => r.id === recorded.id);
    assert.ok(row, "the reminder is still in the history");
    assert.equal(row.balanceAtSend, "300.00", "history must not be restated at today's balance");
    assert.equal(row.recipientEmail, "ap@acme.test", "history keeps the address actually used");
    assert.equal(row.daysOverdueAtSend, capturedDays, "history keeps the age at send time");
    // Today's live figures did move — proving the two are genuinely separate.
    assert.equal(body.balanceDue, "50.00");
    assert.ok(body.daysOverdue > capturedDays);
  });

  it("reports who sent it, to where, which template and when", async () => {
    const h = harness();
    await send(h.app, { templateKey: "firm" });
    const { body } = await request(h.app, "GET", "/api/invoices/1/reminders");
    const row = body.reminders[0];
    assert.equal(row.sentByName, "Dana Books");
    assert.equal(row.sentByUserId, 7);
    assert.equal(row.recipientEmail, "ap@acme.test");
    assert.equal(row.templateKey, "firm");
    assert.equal(row.templateLabel, "Firm reminder");
    assert.ok(row.sentAt);
  });

  it("shows a refusal in place of a send control rather than a dead button", async () => {
    const h = harness({ invoices: { 1: invoice({ sentAt: null }) } });
    const { status, body } = await request(h.app, "GET", "/api/invoices/1/reminders");
    assert.equal(status, 200);
    assert.equal(body.canSend, false);
    assert.equal(body.refusal.reason, "never_sent");
    assert.equal(body.refusal.action.kind, "send_invoice");
  });

  it("reports the throttle state so the button can say when the next is allowed", async () => {
    const lastSent = new Date(NOW.getTime() - DAY);
    const h = harness({
      reminders: [
        {
          id: 1,
          companyId: 1,
          invoiceId: 1,
          sentAt: lastSent,
          deliveryStatus: "sent",
          sequenceNumber: 1,
          recipientEmail: "ap@acme.test",
          templateKey: "friendly",
          balanceAtSend: "300.00",
          daysOverdueAtSend: 14,
        },
      ],
    });
    const { body } = await request(h.app, "GET", "/api/invoices/1/reminders");
    assert.equal(body.canSend, false);
    assert.equal(body.throttle.throttled, true);
    assert.equal(
      body.throttle.nextAllowedAt,
      new Date(lastSent.getTime() + 7 * DAY).toISOString(),
    );
    assert.ok(body.throttle.message);
  });

  it("suggests a tone without choosing one", async () => {
    // 45 days overdue → the 30–59 bucket → 'firm' suggested.
    const h = harness();
    const { body } = await request(h.app, "GET", "/api/invoices/1/reminders");
    assert.equal(body.agingBucket, "days60");
    assert.equal(body.suggestedTemplateKey, "firm");
    assert.deepEqual(
      body.templates.map((t: any) => t.key),
      ["friendly", "firm", "final_notice"],
    );
    assert.equal(h.sent.length, 0, "asking about tone must not send anything");
  });

  it("lists a failed attempt in the history, marked failed", async () => {
    const h = harness({ sendResult: { success: false, error: "domain not found" } });
    await send(h.app);
    const { body } = await request(h.app, "GET", "/api/invoices/1/reminders");
    const row = body.reminders[0];
    assert.equal(row.deliveryStatus, "failed");
    assert.equal(row.deliveryError, "domain not found");
    assert.equal(row.sequenceNumber, null);
  });
});
