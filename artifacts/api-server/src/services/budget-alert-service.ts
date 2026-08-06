// Task #693 — Financial Pulse Slice 4.
//
// Budget alert dispatcher. When an invoice is finalized, detect whether the
// customer just crossed a soft (default 75%) or hard (default 100%) budget
// threshold for the current month or year, and — if so — fire alerts
// through the configured channels (in-app, push, email) to the configured
// recipients. The unique index on `customer_budget_alert_events`
// (customerId, period, threshold, periodKey) guarantees the same alert
// never fires twice in the same period without a reset cron.
//
// Failure isolation contract:
//   - The top-level entry point swallows every error so invoice finalization
//     never fails because of an alert pipeline problem.
//   - Each channel call is independently try/caught so a push failure does
//     not block in-app or email delivery.

import { db } from "../db";
import {
  customerBudgetAlertEvents,
  customers as customersTable,
  invoices as invoicesTable,
  users as usersTable,
  notifications as notificationsTable,
  type Invoice,
  type Customer,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  classifyBudgetPercent,
  getMonthWindow,
  getPeriodKeys,
  getYearWindow,
} from "../budget-status";
import { computeCustomerSpend } from "../budget-spend";
import { storage } from "../storage";
import { EmailService } from "../email-service";
import { logger } from "../lib/logger";
import { NOTIFICATION_TYPES } from "@workspace/db";

export type BudgetPeriod = "monthly" | "annual";
export type BudgetThreshold = "soft" | "hard";

interface BudgetAlertContext {
  customer: Customer;
  invoice: Invoice;
  period: BudgetPeriod;
  threshold: BudgetThreshold;
  periodKey: string;
  cap: number;
  spend: number;
  percent: number; // e.g. 1.12 for 112%
}

function parseDecimal(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

function customerUrl(customerId: number): string {
  return `/customers/${customerId}`;
}

function invoiceUrl(invoiceId: number): string {
  return `/invoices/${invoiceId}`;
}

function notificationTypeFor(threshold: BudgetThreshold): string {
  return threshold === "hard"
    ? NOTIFICATION_TYPES.BUDGET_EXCEEDED
    : NOTIFICATION_TYPES.BUDGET_WARNING;
}

function notificationTitle(ctx: BudgetAlertContext): string {
  const periodLabel = ctx.period === "monthly" ? "monthly" : "annual";
  const verb = ctx.threshold === "hard" ? "exceeded" : "approaching";
  return ctx.threshold === "hard"
    ? `Customer ${ctx.customer.name} has exceeded ${periodLabel} budget`
    : `Customer ${ctx.customer.name} is ${verb} ${periodLabel} budget`;
}

function notificationMessage(ctx: BudgetAlertContext): string {
  const periodLabel = ctx.period === "monthly" ? "monthly" : "annual";
  const pct = Math.round(ctx.percent * 100);
  return (
    `${ctx.customer.name} is at ${pct}% of their ${periodLabel} budget cap of $${ctx.cap.toFixed(2)} ` +
    `(spend: $${ctx.spend.toFixed(2)}). Triggered by invoice ${ctx.invoice.invoiceNumber}.`
  );
}

// Injectable push dispatcher so the test suite can force it to throw.
// The default implementation hooks into the existing client-side push
// pipeline: a push payload is just a notifications row tagged so the
// browser collapses repeats, picked up by usePushNotifications via
// polling. We keep it as a separate function call so channel-failure
// isolation can be exercised in tests.
export interface PushPayload {
  recipientUserId: number;
  title: string;
  body: string;
  url: string;
  tag: string;
  type: string;
  customerId: number;
}
let pushDispatcher: (payload: PushPayload) => Promise<void> = async () => {
  // Default no-op — client-side service worker picks up the row via the
  // notifications table polling. The in-app insert is the durable
  // record; this dispatcher is here for channel-isolation hooks and
  // future server-side web-push.
};
export function setPushDispatcher(
  fn: (payload: PushPayload) => Promise<void>,
): void {
  pushDispatcher = fn;
}
export function resetPushDispatcher(): void {
  pushDispatcher = async () => {};
}

// Email dispatcher seam so tests can stub Postmark. Default delegates
// to the existing EmailService.
export interface BudgetEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  tag: string;
}
let emailDispatcher: (args: BudgetEmailArgs) => Promise<void> = async (
  args,
) => {
  // Use EmailService.sendRawEmail if present; otherwise fall back to
  // the Postmark client via the existing service. We import lazily so
  // tests that swap the dispatcher don't pull Postmark.
  await EmailService.sendBudgetAlertEmail(args);
};
export function setEmailDispatcher(
  fn: (args: BudgetEmailArgs) => Promise<void>,
): void {
  emailDispatcher = fn;
}
export function resetEmailDispatcher(): void {
  emailDispatcher = async (args) => {
    await EmailService.sendBudgetAlertEmail(args);
  };
}

interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

function renderTemplate(opts: {
  ctx: BudgetAlertContext;
  audience: "internal" | "external";
  companyName: string;
  baseUrl: string;
}): RenderedTemplate {
  const { ctx, audience, companyName, baseUrl } = opts;
  const periodLabel = ctx.period === "monthly" ? "monthly" : "annual";
  const periodWord = ctx.period === "monthly" ? "month" : "year";
  const pct = Math.round(ctx.percent * 100);
  const customerLink = `${baseUrl}${customerUrl(ctx.customer.id)}`;
  const invoiceLink = `${baseUrl}${invoiceUrl(ctx.invoice.id)}`;
  const isHard = ctx.threshold === "hard";

  const internalSubject = isHard
    ? `[Budget exceeded] ${ctx.customer.name} — ${pct}% of ${periodLabel} cap`
    : `[Budget warning] ${ctx.customer.name} — ${pct}% of ${periodLabel} cap`;
  const externalSubject = isHard
    ? `Courtesy note from ${companyName}: this ${periodWord}'s spending`
    : `Courtesy update from ${companyName}: this ${periodWord}'s spending`;

  const subject = audience === "internal" ? internalSubject : externalSubject;

  const headingInternal = isHard
    ? `${ctx.customer.name} has crossed the ${periodLabel} hard budget threshold (${pct}%).`
    : `${ctx.customer.name} is approaching the ${periodLabel} budget threshold (${pct}%).`;
  const headingExternal = isHard
    ? `A courtesy note from ${companyName}: your ${periodWord}-to-date irrigation spending has reached ${pct}% of the ${periodLabel} budget you set with us.`
    : `A courtesy note from ${companyName}: your ${periodWord}-to-date irrigation spending has reached ${pct}% of the ${periodLabel} budget you set with us.`;

  const heading = audience === "internal" ? headingInternal : headingExternal;

  const tableRows = `
    <tr><td><strong>Customer:</strong></td><td><a href="${customerLink}">${escapeHtml(ctx.customer.name)}</a></td></tr>
    <tr><td><strong>Period:</strong></td><td>${periodLabel} (${escapeHtml(ctx.periodKey)})</td></tr>
    <tr><td><strong>Budget cap:</strong></td><td>$${ctx.cap.toFixed(2)}</td></tr>
    <tr><td><strong>Current spend:</strong></td><td>$${ctx.spend.toFixed(2)}</td></tr>
    <tr><td><strong>Percent of cap:</strong></td><td>${pct}%</td></tr>
    <tr><td><strong>Triggering invoice:</strong></td><td><a href="${invoiceLink}">${escapeHtml(ctx.invoice.invoiceNumber)}</a></td></tr>
  `;

  const closing = audience === "internal"
    ? `<p>Open the customer profile to review the budget configuration and recent invoices.</p>`
    : `<p>If you have any questions about this invoice or your service plan, please reply to this email and we will be happy to help.</p>`;

  const html = `<!doctype html><html><body style="font-family: Arial, sans-serif; color: #333;">
    <h2>${escapeHtml(heading)}</h2>
    <table cellpadding="6" style="border-collapse: collapse;">${tableRows}</table>
    ${closing}
    <p style="color:#888;font-size:12px;">— ${escapeHtml(companyName)}</p>
  </body></html>`;

  const text = [
    heading,
    "",
    `Customer: ${ctx.customer.name} (${customerLink})`,
    `Period: ${periodLabel} (${ctx.periodKey})`,
    `Budget cap: $${ctx.cap.toFixed(2)}`,
    `Current spend: $${ctx.spend.toFixed(2)}`,
    `Percent of cap: ${pct}%`,
    `Triggering invoice: ${ctx.invoice.invoiceNumber} (${invoiceLink})`,
    "",
    audience === "internal"
      ? "Open the customer profile to review the budget configuration and recent invoices."
      : "If you have any questions about this invoice or your service plan, please reply to this email and we will be happy to help.",
    "",
    `— ${companyName}`,
  ].join("\n");

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getCompanyContext(companyId: number | null | undefined): Promise<{
  name: string;
  baseUrl: string;
}> {
  let name = "IrrigoPro";
  if (companyId != null) {
    try {
      const company = await storage.getCompanyProfile(companyId);
      if (company?.name) name = company.name;
    } catch (err) {
      logger.warn({ err, companyId }, "budget-alerts: failed to load company");
    }
  }
  const baseUrl =
    process.env.APP_BASE_URL?.replace(/\/$/, "") ||
    (process.env.NODE_ENV === "production"
      ? "https://irrigopro.com"
      : `https://${process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost"}`);
  return { name, baseUrl };
}

async function dispatchToRecipient(
  ctx: BudgetAlertContext,
  recipientId: number,
  channels: { inApp: boolean; push: boolean; email: boolean },
  companyName: string,
  baseUrl: string,
): Promise<void> {
  const type = notificationTypeFor(ctx.threshold);
  const title = notificationTitle(ctx);
  const body = notificationMessage(ctx);
  const tag = `budget-${ctx.customer.id}-${ctx.period}-${ctx.threshold}-${ctx.periodKey}`;

  // In-app
  if (channels.inApp) {
    try {
      await storage.createNotification({
        userId: recipientId,
        type,
        title,
        message: body,
        relatedEntityType: "customer",
        relatedEntityId: ctx.customer.id,
        isRead: false,
      });
      logger.info(
        { customerId: ctx.customer.id, invoiceId: ctx.invoice.id, recipientId, channel: "inApp" },
        "budget-alerts: in-app notification dispatched",
      );
    } catch (err) {
      logger.error(
        { err, customerId: ctx.customer.id, invoiceId: ctx.invoice.id, recipientId, channel: "inApp" },
        "budget-alerts: in-app dispatch failed",
      );
    }
  }

  // Push
  if (channels.push) {
    try {
      await pushDispatcher({
        recipientUserId: recipientId,
        title,
        body,
        url: customerUrl(ctx.customer.id),
        tag,
        type,
        customerId: ctx.customer.id,
      });
      logger.info(
        { customerId: ctx.customer.id, invoiceId: ctx.invoice.id, recipientId, channel: "push" },
        "budget-alerts: push notification dispatched",
      );
    } catch (err) {
      logger.error(
        { err, customerId: ctx.customer.id, invoiceId: ctx.invoice.id, recipientId, channel: "push" },
        "budget-alerts: push dispatch failed",
      );
    }
  }

  // Email
  if (channels.email) {
    try {
      const user = await storage.getUser(recipientId);
      if (!user?.email) {
        logger.warn(
          { recipientId, customerId: ctx.customer.id },
          "budget-alerts: recipient has no email on file, skipping internal email",
        );
      } else {
        const rendered = renderTemplate({
          ctx,
          audience: "internal",
          companyName,
          baseUrl,
        });
        await emailDispatcher({
          to: user.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          tag: `budget-alert-${ctx.threshold}-internal`,
        });
        logger.info(
          { customerId: ctx.customer.id, invoiceId: ctx.invoice.id, recipientId, channel: "email" },
          "budget-alerts: internal email dispatched",
        );
      }
    } catch (err) {
      logger.error(
        { err, customerId: ctx.customer.id, invoiceId: ctx.invoice.id, recipientId, channel: "email" },
        "budget-alerts: internal email failed",
      );
    }
  }
}

async function maybeFire(
  ctx: BudgetAlertContext,
  channels: { inApp: boolean; push: boolean; email: boolean },
  recipientIds: number[],
  notifyCustomerContact: boolean,
): Promise<void> {
  // Idempotency insert. Returns the inserted row, or empty array when
  // the unique index already had (customerId, period, threshold,
  // periodKey). Only fire dispatch if we actually inserted.
  let inserted: { id: number }[] = [];
  try {
    inserted = await db
      .insert(customerBudgetAlertEvents)
      .values({
        customerId: ctx.customer.id,
        period: ctx.period,
        threshold: ctx.threshold,
        periodKey: ctx.periodKey,
        triggeringInvoiceId: ctx.invoice.id,
      })
      .onConflictDoNothing({
        target: [
          customerBudgetAlertEvents.customerId,
          customerBudgetAlertEvents.period,
          customerBudgetAlertEvents.threshold,
          customerBudgetAlertEvents.periodKey,
        ],
      })
      .returning({ id: customerBudgetAlertEvents.id });
  } catch (err) {
    logger.error(
      { err, customerId: ctx.customer.id, invoiceId: ctx.invoice.id, period: ctx.period, threshold: ctx.threshold },
      "budget-alerts: failed to insert event row",
    );
    return;
  }

  if (inserted.length === 0) {
    // Already fired this period — dedup hit. Nothing to do.
    return;
  }

  const { name: companyName, baseUrl } = await getCompanyContext(ctx.customer.companyId);

  for (const recipientId of recipientIds) {
    await dispatchToRecipient(ctx, recipientId, channels, companyName, baseUrl);
  }

  // Customer-facing email — only when explicitly opted in and the
  // customer has an email on file. Sent regardless of internal
  // recipients (so a customer with no configured internal recipients
  // can still get the courtesy email).
  if (notifyCustomerContact && ctx.customer.email) {
    try {
      const rendered = renderTemplate({
        ctx,
        audience: "external",
        companyName,
        baseUrl,
      });
      await emailDispatcher({
        to: ctx.customer.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tag: `budget-alert-${ctx.threshold}-external`,
      });
      logger.info(
        { customerId: ctx.customer.id, invoiceId: ctx.invoice.id, channel: "external_email" },
        "budget-alerts: external customer email dispatched",
      );
    } catch (err) {
      logger.error(
        { err, customerId: ctx.customer.id, invoiceId: ctx.invoice.id, channel: "external_email" },
        "budget-alerts: external customer email failed",
      );
    }
  }
}

/**
 * Top-level entry point. Called after an invoice row has been persisted
 * (and ideally after the billed-state transition). All errors are
 * swallowed — invoice finalization MUST NOT fail because of an alert
 * pipeline problem.
 */
export async function checkBudgetThresholds(invoice: Invoice): Promise<void> {
  try {
    if (!invoice || !invoice.customerId) return;

    const customer = await storage.getCustomer(invoice.customerId);
    if (!customer) return;

    const monthlyCap = parseDecimal(customer.monthlyBudgetCap);
    const annualCap = parseDecimal(customer.annualBudgetCap);
    if (monthlyCap == null && annualCap == null) return;

    const soft = customer.budgetSoftThresholdPercent ?? 75;
    const hard = customer.budgetHardThresholdPercent ?? 100;

    // Use the invoice's createdAt as the "now" the task spec asks for
    // (referred to as invoice.invoiceDate). The invoices table doesn't
    // have an invoiceDate column — createdAt is the canonical billing
    // timestamp used by the dashboard rollups, so we match that here.
    const now: Date =
      invoice.createdAt instanceof Date
        ? invoice.createdAt
        : new Date(invoice.createdAt as unknown as string);
    const { monthKey, yearKey } = getPeriodKeys(now);
    const monthWin = getMonthWindow(now);
    const yearWin = getYearWindow(now);

    // Use the shared computeCustomerSpend so alerts fire on the same
    // number the Budget card and Financial Pulse show. Tenancy fix:
    // pass customer.companyId (not null) so another company's invoices
    // can never be read here. super_admin can pass null but the alert
    // service always fires on behalf of a real customer with a company.
    const [monthSpendResult, yearSpendResult] = await Promise.all([
      computeCustomerSpend(customer.id, customer.companyId, monthWin),
      computeCustomerSpend(customer.id, customer.companyId, yearWin),
    ]);
    const monthSpend = monthSpendResult.total;
    const yearSpend = yearSpendResult.total;

    const channelsRaw = customer.budgetAlertChannels as
      | { inApp?: boolean; push?: boolean; email?: boolean }
      | null
      | undefined;
    const channels = {
      inApp: channelsRaw?.inApp ?? true,
      push: channelsRaw?.push ?? true,
      email: channelsRaw?.email ?? false,
    };
    const recipientIds: number[] = Array.isArray(customer.budgetAlertRecipientUserIds)
      ? (customer.budgetAlertRecipientUserIds as number[]).filter(
          (n) => typeof n === "number" && Number.isFinite(n),
        )
      : [];
    const notifyCustomerContact = customer.budgetNotifyCustomerContact === true;

    // Four (period × threshold) combinations. Each is independent: the
    // unique index keeps them from re-firing within the same period.
    const combos: Array<{
      cap: number | null;
      spend: number;
      period: BudgetPeriod;
      periodKey: string;
    }> = [
      { cap: monthlyCap, spend: monthSpend, period: "monthly", periodKey: monthKey },
      { cap: annualCap, spend: yearSpend, period: "annual", periodKey: yearKey },
    ];

    for (const combo of combos) {
      if (combo.cap == null || combo.cap <= 0) continue;
      const percent = combo.spend / combo.cap;
      const status = classifyBudgetPercent(percent, soft, hard);
      // Soft fires when status is approaching OR over (any threshold crossed).
      // Hard fires only when status is over.
      if (status === "approaching" || status === "over") {
        await maybeFire(
          {
            customer,
            invoice,
            period: combo.period,
            threshold: "soft",
            periodKey: combo.periodKey,
            cap: combo.cap,
            spend: combo.spend,
            percent,
          },
          channels,
          recipientIds,
          notifyCustomerContact,
        );
      }
      if (status === "over") {
        await maybeFire(
          {
            customer,
            invoice,
            period: combo.period,
            threshold: "hard",
            periodKey: combo.periodKey,
            cap: combo.cap,
            spend: combo.spend,
            percent,
          },
          channels,
          recipientIds,
          notifyCustomerContact,
        );
      }
    }
  } catch (err) {
    // Top-level swallow. Invoice writes MUST NOT fail because of an
    // alert pipeline problem.
    logger.error(
      { err, invoiceId: invoice?.id, customerId: invoice?.customerId },
      "budget-alerts: top-level error (swallowed)",
    );
  }
}

/**
 * Customer-detail "Recent Budget Alerts" feed. Returns the most recent
 * rows from `customer_budget_alert_events` for the customer, joined to
 * `invoices` so the response includes `triggeringInvoiceNumber`.
 */
export async function getRecentBudgetAlertEvents(
  customerId: number,
  limit: number,
): Promise<
  Array<{
    id: number;
    customerId: number;
    period: BudgetPeriod;
    threshold: BudgetThreshold;
    periodKey: string;
    firedAt: Date;
    triggeringInvoiceId: number | null;
    triggeringInvoiceNumber: string | null;
  }>
> {
  const capped = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = await db
    .select({
      id: customerBudgetAlertEvents.id,
      customerId: customerBudgetAlertEvents.customerId,
      period: customerBudgetAlertEvents.period,
      threshold: customerBudgetAlertEvents.threshold,
      periodKey: customerBudgetAlertEvents.periodKey,
      firedAt: customerBudgetAlertEvents.firedAt,
      triggeringInvoiceId: customerBudgetAlertEvents.triggeringInvoiceId,
      triggeringInvoiceNumber: invoicesTable.invoiceNumber,
    })
    .from(customerBudgetAlertEvents)
    .leftJoin(
      invoicesTable,
      eq(customerBudgetAlertEvents.triggeringInvoiceId, invoicesTable.id),
    )
    .where(eq(customerBudgetAlertEvents.customerId, customerId))
    .orderBy(desc(customerBudgetAlertEvents.firedAt))
    .limit(capped);

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    period: r.period as BudgetPeriod,
    threshold: r.threshold as BudgetThreshold,
    periodKey: r.periodKey,
    firedAt: r.firedAt,
    triggeringInvoiceId: r.triggeringInvoiceId,
    triggeringInvoiceNumber: r.triggeringInvoiceNumber ?? null,
  }));
}

// Suppress unused-import warnings for symbols kept for future use.
void usersTable;
void notificationsTable;
void customersTable;
void and;
void inArray;
