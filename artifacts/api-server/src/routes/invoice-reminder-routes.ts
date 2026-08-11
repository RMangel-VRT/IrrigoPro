// Task #1887 — invoice payment reminders.
//
//   GET  /api/invoices/:id/reminders  — history + whether a reminder can be
//                                       sent right now, and if not, why not.
//   POST /api/invoices/:id/reminders  — send one.
//
// This is the one endpoint in the product where a misclick reaches a
// customer's inbox, so three rules shape the whole module:
//
//   1. The invoice is resolved through the company-scoped fetch BEFORE
//      anything else happens. A bookkeeper in company A asking about a
//      company B invoice gets a 404 and no mailer call is ever made.
//   2. Every refusal has its own message, and the two that a bookkeeper can
//      actually fix name the action that fixes them. A dead button that says
//      "PDF not found" is the failure this work exists to delete.
//   3. Nothing is silent. A throttled request answers with the date the next
//      reminder is allowed — the payment-sync refresh button already taught us
//      what a silent no-op costs.
//
// Nothing here runs on a schedule. Every reminder is a person pressing send.

import type { Express, RequestHandler } from "express";
import { storage as storageModule } from "../storage";
import { db as dbModule } from "../db";
import { customers } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  classifyAgingBucket,
  computeEffectiveDueDate,
  daysOverdue as daysOverdueOf,
  resolveBalanceDue,
  type AgingBucketKey,
} from "@workspace/shared";
import {
  isReminderTemplateKey,
  renderReminderEmail,
  suggestTemplateKey,
  REMINDER_TEMPLATE_KEYS,
  REMINDER_TEMPLATE_LABELS,
  type ReminderTemplateKey,
} from "../invoice-reminder-templates";
import { EmailService } from "../email-service";
import { resolveCompanyLogoUrl } from "../logo-url";

// ── The refusal matrix ──────────────────────────────────────────────────────

export type ReminderRefusalReason =
  | "paid"
  | "zero_balance"
  | "cancelled"
  | "superseded"
  | "merged"
  | "draft"
  | "no_customer_email"
  | "qb_voided"
  | "never_sent"
  | "no_pdf";

/**
 * A refusal the caller can act on. `action` is present only where there is a
 * next step the bookkeeper can actually take from here; the UI renders it in
 * place of the send button rather than leaving a disabled control behind.
 */
export interface ReminderRefusal {
  reason: ReminderRefusalReason;
  message: string;
  action?: { kind: "send_invoice" | "generate_pdf"; label: string };
}

/** The invoice fields the refusal matrix reads. Structural, so tests can fixture it. */
export interface ReminderInvoiceLike {
  id: number;
  invoiceNumber: string;
  status: string;
  customerEmail?: string | null;
  sentAt?: Date | string | null;
  paidAt?: Date | string | null;
  paymentStatus?: string | null;
  balance?: string | number | null;
  totalAmount: string | number;
  paymentSyncedAt?: Date | string | null;
  qbVoidDetectedAt?: Date | string | null;
}

/**
 * The first thing wrong with sending a reminder for this invoice, or null.
 *
 * The order is the order a person would notice the problems in: money first
 * (it is already paid / there is nothing owed), then lifecycle (this invoice
 * is not the live one), then the three things that make the send itself
 * impossible. Each fixture in the tests trips exactly one.
 */
export function evaluateReminderEligibility(args: {
  invoice: ReminderInvoiceLike;
  hasStoredPdf: boolean;
}): ReminderRefusal | null {
  const { invoice, hasStoredPdf } = args;
  const num = `#${invoice.invoiceNumber}`;
  const balance = resolveBalanceDue(invoice);

  if (invoice.status === "paid" || invoice.paymentStatus === "paid" || invoice.paidAt) {
    return {
      reason: "paid",
      message: `Invoice ${num} is already paid in full. There is nothing to remind the customer about.`,
    };
  }
  if (balance <= 0) {
    return {
      reason: "zero_balance",
      message: `Invoice ${num} has a zero balance, so there is nothing outstanding to chase.`,
    };
  }
  if (invoice.status === "cancelled") {
    return {
      reason: "cancelled",
      message: `Invoice ${num} was cancelled. Reissue it if this work is still owed — a cancelled invoice must not be chased.`,
    };
  }
  if (invoice.status === "superseded") {
    return {
      reason: "superseded",
      message: `Invoice ${num} was corrected and superseded. Send the reminder from the replacement invoice, which is the one the customer owes.`,
    };
  }
  if (invoice.status === "merged") {
    return {
      reason: "merged",
      message: `Invoice ${num} was merged into another invoice. Send the reminder from the surviving invoice so the customer sees the amount they actually owe.`,
    };
  }
  if (invoice.status === "draft") {
    return {
      reason: "draft",
      message: `Invoice ${num} is still a draft. Finalise and send it before asking the customer to pay it.`,
    };
  }
  if (!invoice.customerEmail || String(invoice.customerEmail).trim() === "") {
    return {
      reason: "no_customer_email",
      message: `There is no billing email on this customer, so a reminder for invoice ${num} has nowhere to go. Add a billing email to the customer first.`,
    };
  }
  if (invoice.qbVoidDetectedAt) {
    return {
      reason: "qb_voided",
      message: `QuickBooks shows invoice ${num} as voided while it is still open here. Settle which one is right before chasing the customer for it.`,
    };
  }
  // Named alternative #1 — the row's call to action here is *send*, not remind.
  if (!invoice.sentAt) {
    return {
      reason: "never_sent",
      message: `Invoice ${num} has never been sent to the customer. Send the invoice first — chasing payment for an invoice they never received is worse than useless.`,
      action: { kind: "send_invoice", label: "Send the invoice" },
    };
  }
  // Named alternative #2 — reachable in real life: an invoice posted on paper
  // and manually marked sent has `sentAt` and no PDF record at all.
  if (!hasStoredPdf) {
    return {
      reason: "no_pdf",
      message: `Invoice ${num} has no saved PDF, so a reminder would arrive with nothing attached. Generate or send the invoice PDF first, then send the reminder.`,
      action: { kind: "generate_pdf", label: "Generate the PDF first" },
    };
  }
  return null;
}

// ── Throttle ────────────────────────────────────────────────────────────────

/** Used when a company has no configured window. One reminder a week. */
export const DEFAULT_REMINDER_THROTTLE_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ThrottleState {
  windowDays: number;
  lastSentAt: Date | null;
  /** When the next reminder becomes allowed. Null when one is allowed now. */
  nextAllowedAt: Date | null;
  throttled: boolean;
}

/**
 * Same shape as the missing-photos notification throttle: read the last send,
 * compare against a window, and report the timestamp rather than swallowing
 * the request.
 */
export function evaluateThrottle(
  lastSentAt: Date | null,
  windowDays: number,
  now: Date,
): ThrottleState {
  const days = Number.isFinite(windowDays) && windowDays > 0
    ? windowDays
    : DEFAULT_REMINDER_THROTTLE_DAYS;
  if (!lastSentAt) {
    return { windowDays: days, lastSentAt: null, nextAllowedAt: null, throttled: false };
  }
  const nextAllowedAt = new Date(lastSentAt.getTime() + days * MS_PER_DAY);
  const throttled = now.getTime() < nextAllowedAt.getTime();
  return {
    windowDays: days,
    lastSentAt,
    nextAllowedAt: throttled ? nextAllowedAt : null,
    throttled,
  };
}

function formatWhen(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export function throttleMessage(invoiceNumber: string, state: ThrottleState): string {
  const last = state.lastSentAt ? formatWhen(state.lastSentAt) : "recently";
  const next = state.nextAllowedAt ? formatWhen(state.nextAllowedAt) : "shortly";
  return (
    `A reminder for invoice #${invoiceNumber} already went out on ${last}. ` +
    `This company allows one reminder every ${state.windowDays} days, so the next one can be sent on ${next}.`
  );
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

export interface ReminderHistoryRow {
  id: number;
  sentAt: string;
  sentByUserId: number | null;
  sentByName: string | null;
  recipientEmail: string;
  sequenceNumber: number | null;
  templateKey: string;
  templateLabel: string;
  balanceAtSend: string;
  daysOverdueAtSend: number;
  deliveryStatus: string;
  deliveryError: string | null;
}

function toHistoryRow(r: any): ReminderHistoryRow {
  return {
    id: r.id,
    sentAt: new Date(r.sentAt).toISOString(),
    sentByUserId: r.sentByUserId ?? null,
    sentByName: r.sentByName ?? null,
    // Every value below is read straight off the row. Recomputing any of them
    // from today's invoice would rewrite what the customer was told.
    recipientEmail: r.recipientEmail,
    sequenceNumber: r.sequenceNumber ?? null,
    templateKey: r.templateKey,
    templateLabel:
      REMINDER_TEMPLATE_LABELS[r.templateKey as ReminderTemplateKey] ?? r.templateKey,
    balanceAtSend: String(r.balanceAtSend),
    daysOverdueAtSend: Number(r.daysOverdueAtSend),
    deliveryStatus: r.deliveryStatus,
    deliveryError: r.deliveryError ?? null,
  };
}

// ── Dependencies ────────────────────────────────────────────────────────────

/** The mailer seam. Production is `EmailService.sendInvoiceDetailPdf`. */
export type ReminderMailer = (
  customerEmail: string,
  customerName: string,
  invoiceNumber: string,
  pdfUrl: string,
  overrides: {
    subject: string;
    html: string;
    text: string;
    replyTo?: string | null;
    filename?: string;
    categories?: string[];
  },
) => Promise<{ success: boolean; error?: string }>;

export interface RegisterInvoiceReminderRoutesDeps {
  requireAuthentication: RequestHandler;
  /** CAN_SEND_INVOICE_EMAIL — the same capability the PDF-send route uses. */
  requireInvoiceSend: RequestHandler;
  /** Test seams. Production passes none of these. */
  _storageApi?: any;
  _mailer?: ReminderMailer;
  _loadPaymentTerms?: (customerId: number) => Promise<string | null>;
  _now?: () => Date;
  _baseUrl?: () => string;
}

async function loadPaymentTermsFromDb(customerId: number): Promise<string | null> {
  const [row] = await dbModule
    .select({ paymentTerms: customers.paymentTerms })
    .from(customers)
    .where(eq(customers.id, customerId));
  return row?.paymentTerms ?? null;
}

function emailBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (replitDomain) return `https://${replitDomain}`;
  return "https://irrigopro.com";
}

const defaultMailer: ReminderMailer = (to, name, number, pdfUrl, overrides) =>
  EmailService.sendInvoiceDetailPdf(to, name, number, pdfUrl, overrides);

// ── Registration ────────────────────────────────────────────────────────────

export function registerInvoiceReminderRoutes(
  app: Express,
  deps: RegisterInvoiceReminderRoutesDeps,
): void {
  const storage = deps._storageApi ?? storageModule;
  const mailer = deps._mailer ?? defaultMailer;
  const loadPaymentTerms = deps._loadPaymentTerms ?? loadPaymentTermsFromDb;
  const nowFn = deps._now ?? (() => new Date());
  const baseUrlFn = deps._baseUrl ?? emailBaseUrl;

  /** Company scope for the fetch. super_admin sees every company. */
  function callerCompanyId(req: any): number | null {
    return req.authenticatedUserRole === "super_admin"
      ? null
      : (req.authenticatedUserCompanyId ?? null);
  }

  /**
   * Everything both endpoints need about one invoice, resolved once.
   * Returns null when the invoice is not visible to this caller — the caller
   * then 404s WITHOUT touching the mailer.
   */
  async function resolveContext(req: any, invoiceId: number) {
    const invoice = await storage.getInvoiceById(invoiceId, callerCompanyId(req));
    if (!invoice) return null;
    const pdf = await storage.getInvoicePdfByInvoiceId(invoiceId);
    const paymentTerms = await loadPaymentTerms(invoice.customerId);
    const now = nowFn();
    const effectiveDueDate = computeEffectiveDueDate(
      invoice.dueDate,
      invoice.createdAt,
      paymentTerms,
    );
    const rawDays = daysOverdueOf(effectiveDueDate, now);
    // Floored, exactly as the A/R list floors it, so the number in the email
    // and the number in the Days overdue column are the same number.
    const days = Number.isFinite(rawDays) ? Math.floor(rawDays) : 0;
    const bucket: AgingBucketKey = classifyAgingBucket(rawDays);
    return {
      invoice,
      pdf,
      now,
      effectiveDueDate,
      daysOverdue: days,
      agingBucket: bucket,
      balanceDue: resolveBalanceDue(invoice),
      refusal: evaluateReminderEligibility({ invoice, hasStoredPdf: !!pdf }),
    };
  }

  async function throttleFor(invoiceId: number, companyId: number | null, now: Date) {
    const last = await storage.getLastDeliveredInvoiceReminder(invoiceId);
    let windowDays = DEFAULT_REMINDER_THROTTLE_DAYS;
    if (companyId != null) {
      try {
        const company = await storage.getCompanyProfile(companyId);
        const configured = (company as any)?.invoiceReminderThrottleDays;
        if (typeof configured === "number" && configured > 0) windowDays = configured;
      } catch {
        // A missing company profile must not open the throttle — fall through
        // to the default window rather than allowing an unlimited send rate.
      }
    }
    return evaluateThrottle(last ? new Date(last.sentAt) : null, windowDays, now);
  }

  function parseId(req: any, res: any): number | null {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ message: "Invalid invoice ID" });
      return null;
    }
    return id;
  }

  // ── History + send-ability ────────────────────────────────────────────────

  app.get(
    "/api/invoices/:id/reminders",
    deps.requireAuthentication,
    deps.requireInvoiceSend,
    async (req: any, res) => {
      try {
        const id = parseId(req, res);
        if (id == null) return;
        const ctx = await resolveContext(req, id);
        if (!ctx) {
          res.status(404).json({ message: "Invoice not found" });
          return;
        }
        const rows = await storage.getInvoiceReminders(id, callerCompanyId(req));
        const throttle = await throttleFor(id, ctx.invoice.companyId ?? null, ctx.now);
        res.json({
          reminders: (rows ?? []).map(toHistoryRow),
          canSend: !ctx.refusal && !throttle.throttled,
          refusal: ctx.refusal ?? null,
          throttle: {
            windowDays: throttle.windowDays,
            lastSentAt: throttle.lastSentAt ? throttle.lastSentAt.toISOString() : null,
            nextAllowedAt: throttle.nextAllowedAt
              ? throttle.nextAllowedAt.toISOString()
              : null,
            throttled: throttle.throttled,
            message: throttle.throttled
              ? throttleMessage(ctx.invoice.invoiceNumber, throttle)
              : null,
          },
          // A suggestion, nothing more. The sender picks the tone.
          suggestedTemplateKey: suggestTemplateKey(ctx.agingBucket),
          templates: REMINDER_TEMPLATE_KEYS.map((key) => ({
            key,
            label: REMINDER_TEMPLATE_LABELS[key],
          })),
          balanceDue: ctx.balanceDue.toFixed(2),
          daysOverdue: ctx.daysOverdue,
          agingBucket: ctx.agingBucket,
          effectiveDueDate: ctx.effectiveDueDate.toISOString(),
          recipientEmail: ctx.invoice.customerEmail ?? null,
        });
      } catch (error) {
        console.error("Error loading invoice reminders:", error);
        res.status(500).json({ message: "Failed to load reminder history" });
      }
    },
  );

  // ── Send ──────────────────────────────────────────────────────────────────

  app.post(
    "/api/invoices/:id/reminders",
    deps.requireAuthentication,
    deps.requireInvoiceSend,
    async (req: any, res) => {
      try {
        const id = parseId(req, res);
        if (id == null) return;

        // Company-scoped resolution first, before anything reads a template or
        // touches the mailer. Cross-company gets a 404 and nothing is sent.
        const ctx = await resolveContext(req, id);
        if (!ctx) {
          res.status(404).json({ message: "Invoice not found" });
          return;
        }

        if (ctx.refusal) {
          res.status(422).json(ctx.refusal);
          return;
        }

        const throttle = await throttleFor(id, ctx.invoice.companyId ?? null, ctx.now);
        if (throttle.throttled) {
          res.status(429).json({
            reason: "throttled",
            message: throttleMessage(ctx.invoice.invoiceNumber, throttle),
            lastSentAt: throttle.lastSentAt?.toISOString() ?? null,
            nextAllowedAt: throttle.nextAllowedAt?.toISOString() ?? null,
            windowDays: throttle.windowDays,
          });
          return;
        }

        // The tone is always an explicit choice. Nothing picks it for the
        // sender, so an absent or unknown key is a refusal, not a default.
        const templateKey = (req.body ?? {}).templateKey;
        if (!isReminderTemplateKey(templateKey)) {
          res.status(400).json({
            message: `Choose which reminder to send: ${REMINDER_TEMPLATE_KEYS.join(", ")}.`,
          });
          return;
        }

        const company = ctx.invoice.companyId
          ? await storage.getCompanyProfile(ctx.invoice.companyId)
          : null;
        const logo = company?.logo
          ? resolveCompanyLogoUrl(company.logo, baseUrlFn())
          : null;

        const rendered = renderReminderEmail({
          templateKey,
          customerName: ctx.invoice.customerName,
          invoiceNumber: ctx.invoice.invoiceNumber,
          effectiveDueDate: ctx.effectiveDueDate,
          daysOverdue: ctx.daysOverdue,
          balanceDue: ctx.balanceDue,
          company: {
            name: company?.name || "IrrigoPro",
            logo,
            email: company?.email ?? null,
            phone: company?.phone ?? null,
          },
        });

        const recipientEmail = String(ctx.invoice.customerEmail);
        const sendResult = await mailer(
          recipientEmail,
          ctx.invoice.customerName,
          ctx.invoice.invoiceNumber,
          // Non-null by construction: the no_pdf refusal above returned early.
          ctx.pdf!.pdfUrl,
          {
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            replyTo: company?.email ?? null,
            filename: `Invoice_${ctx.invoice.invoiceNumber}.pdf`,
            categories: ["invoice-payment-reminder"],
          },
        );

        const existing = (await storage.getInvoiceReminders(id, callerCompanyId(req))) ?? [];
        const deliveredCount = existing.filter(
          (r: any) => r.deliveryStatus === "sent",
        ).length;

        // Who sent it, captured by name as well as id: the history has to stay
        // readable after a user is deactivated or renamed.
        const sentByUserId: number | null =
          typeof req.authenticatedUserId === "number" ? req.authenticatedUserId : null;
        let sentByName: string | null = null;
        if (sentByUserId != null) {
          try {
            sentByName = (await storage.getUser(sentByUserId))?.name ?? null;
          } catch {
            sentByName = null;
          }
        }

        const base = {
          companyId: ctx.invoice.companyId,
          invoiceId: id,
          sentByUserId,
          sentByName,
          sentAt: ctx.now,
          recipientEmail,
          templateKey,
          // Captured, not looked up. This is what makes the history readable
          // after the balance moves and after the customer's email changes.
          balanceAtSend: ctx.balanceDue.toFixed(2),
          daysOverdueAtSend: ctx.daysOverdue,
        };

        if (!sendResult.success) {
          // Recorded as failed, with the reason, and WITHOUT a sequence
          // number — a bounce is not a reminder the customer received, so the
          // next successful send is still reminder number one.
          const failed = await storage.createInvoiceReminder({
            ...base,
            sequenceNumber: null,
            deliveryStatus: "failed",
            deliveryError: sendResult.error ?? "Send failed",
          });
          res.status(502).json({
            reason: "send_failed",
            message: `The reminder for invoice #${ctx.invoice.invoiceNumber} could not be delivered to ${recipientEmail}. It has been recorded as a failed attempt and does not count as a reminder.`,
            error: sendResult.error ?? "Send failed",
            reminder: toHistoryRow(failed),
          });
          return;
        }

        const saved = await storage.createInvoiceReminder({
          ...base,
          sequenceNumber: deliveredCount + 1,
          deliveryStatus: "sent",
          deliveryError: null,
        });

        res.status(201).json({
          message: `Reminder sent to ${recipientEmail}.`,
          reminder: toHistoryRow(saved),
        });
      } catch (error) {
        console.error("Error sending invoice reminder:", error);
        res.status(500).json({ message: "Failed to send reminder" });
      }
    },
  );
}
