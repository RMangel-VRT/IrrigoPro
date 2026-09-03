/**
 * Batch invoice payment reminders — Task #1888.
 *
 * Two endpoints, and the order between them is the whole feature:
 *
 *   POST /api/invoices/reminders/preview   dry run. Reads only.
 *   POST /api/invoices/reminders/batch     the confirmed send.
 *
 * A batch send is the highest-blast-radius action in the app: one click can
 * put mail in twenty customers' inboxes. So the preview is not a courtesy, it
 * is the safety interlock. It answers, per invoice, either "this address, this
 * tone" or "skipped, and here is why" — and it cannot reach the mailer,
 * because it calls `previewOne`, which has no mailer to reach.
 *
 * Neither endpoint owns any eligibility, throttle or template logic. Both call
 * the same {@link createReminderCore} the single send calls, one invoice at a
 * time, so the preview physically cannot disagree with the send and the batch
 * cannot become a back door around a refusal.
 *
 * The ordering is enforced by the server, not by the dialog: the preview issues
 * a short-lived confirmation token bound to the caller, the company, the exact
 * set of invoice ids and the tone, and the batch refuses to send without a
 * valid one. A client cannot skip the list, and a token cannot be carried over
 * to a different selection, a different tone, a different user or a second run.
 */

import type { Express, RequestHandler } from "express";
import { createSingleUseConfirmation } from "../lib/single-use-confirmation";
import {
  createReminderCore,
  isReminderTemplateChoice,
  type ReminderCore,
  type ReminderCoreDeps,
  type ReminderPreviewRow,
  type ReminderSendOutcome,
  type ReminderTemplateChoice,
} from "./invoice-reminder-routes";
import { REMINDER_TEMPLATE_KEYS } from "../invoice-reminder-templates";

/**
 * A ceiling on one batch. Not a business rule — a blast-radius rule. The
 * confirmation list is only meaningful if a human can actually read it, and
 * the sends run one at a time against a real mail provider.
 */
export const MAX_BATCH_REMINDER_INVOICES = 100;

/**
 * How long a confirmation stays good for. Long enough to actually read a list
 * of twenty recipients and think about it; short enough that a token found in
 * a log or a stale tab is not a licence to mail customers tomorrow.
 */
export const REMINDER_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

/**
 * The signing key for confirmations. Derived from SESSION_SECRET when the
 * deployment has one, so every instance verifies what any instance issued;
 * otherwise a per-process random key, which means a restart invalidates
 * outstanding confirmations. That failure mode is "read the list again", not
 * "send without reading it", so it fails in the safe direction.
 */
const confirmation = createSingleUseConfirmation({
  scope: "invoice-reminder-batch-confirmation-v1",
  ttlMs: REMINDER_CONFIRMATION_TTL_MS,
  messages: {
    required: "Review the list of who will be emailed before sending. No reminders were sent.",
    mismatch: "This selection no longer matches the list that was confirmed. Review it again — no reminders were sent.",
    expired: "The confirmation list has expired. Review it again — no reminders were sent.",
    used: "That batch has already been sent. Review the list again — no reminders were sent.",
  },
});

/**
 * Everything the confirmation is a statement about. All of it is signed, so a
 * token issued for one selection cannot authorise another: change an id, the
 * tone, the user or the company and the signature no longer verifies.
 */
interface ConfirmationClaims {
  userId: unknown;
  companyId: unknown;
  invoiceIds: number[];
  templateKey: ReminderTemplateChoice;
}

function claimsFingerprint(c: ConfirmationClaims): string {
  const ids = [...c.invoiceIds].sort((a, b) => a - b).join(",");
  return `${String(c.userId ?? "")}|${String(c.companyId ?? "global")}|${ids}|${c.templateKey}`;
}

export function issueConfirmationToken(
  claims: ConfirmationClaims,
  now: Date,
): { token: string; expiresAt: Date } {
  return confirmation.issue(claimsFingerprint(claims), now);
}

type ConfirmationCheck =
  | { ok: true }
  | { ok: false; status: number; reason: string; message: string };

/**
 * Note every rejection says no reminders were sent — this runs before the
 * mailer is reachable, and the reader of the error should not have to wonder.
 */
export function verifyConfirmationToken(
  token: unknown,
  claims: ConfirmationClaims,
  now: Date,
): ConfirmationCheck {
  return confirmation.verify(token, claimsFingerprint(claims), now);
}

export interface RegisterInvoiceReminderBatchRoutesDeps extends ReminderCoreDeps {
  requireAuthentication: RequestHandler;
  /** CAN_SEND_INVOICE_EMAIL, via the shared capability guard — never a role set. */
  requireInvoiceSend: RequestHandler;
  /** Share the single send's core rather than building a second one. */
  _core?: ReminderCore;
}

type ParsedBody =
  | { ok: true; invoiceIds: number[]; templateKey: ReminderTemplateChoice }
  | { ok: false; status: number; message: string };

/**
 * Both endpoints take the same body, and both refuse the same nonsense, so a
 * preview can never be obtained under looser rules than the send it precedes.
 */
function parseBody(body: any): ParsedBody {
  const raw = body ?? {};
  const ids = raw.invoiceIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return {
      ok: false,
      status: 400,
      message: "Select at least one invoice to send reminders for.",
    };
  }
  const invoiceIds: number[] = [];
  for (const value of ids) {
    const id = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
      return { ok: false, status: 400, message: "Invalid invoice ID in selection." };
    }
    // Deduped, so a doubled id can never mean a doubled email.
    if (!invoiceIds.includes(id)) invoiceIds.push(id);
  }
  if (invoiceIds.length > MAX_BATCH_REMINDER_INVOICES) {
    return {
      ok: false,
      status: 400,
      message: `Select at most ${MAX_BATCH_REMINDER_INVOICES} invoices at a time.`,
    };
  }
  // The tone is an explicit choice here exactly as it is for a single send.
  // "suggested" is a choice too — it says "each invoice gets the tone this
  // module already suggests for its age" — but silence is not.
  const templateKey = raw.templateKey;
  if (!isReminderTemplateChoice(templateKey)) {
    return {
      ok: false,
      status: 400,
      message: `Choose which reminder to send: ${REMINDER_TEMPLATE_KEYS.join(", ")}, or suggested.`,
    };
  }
  return { ok: true, invoiceIds, templateKey };
}

/** The result row the bookkeeper reads after the fact. */
export interface BatchReminderResultRow {
  invoiceId: number;
  invoiceNumber: string;
  customerName: string;
  outcome: "sent" | "skipped" | "failed";
  recipientEmail: string | null;
  templateKey: string | null;
  templateLabel: string | null;
  reason: string | null;
  message: string;
  nextAllowedAt: string | null;
  error: string | null;
}

function toResultRow(outcome: Exclude<ReminderSendOutcome, { outcome: "not_found" }>): BatchReminderResultRow {
  const head = {
    invoiceId: outcome.invoiceId,
    invoiceNumber: outcome.invoiceNumber,
    customerName: outcome.customerName,
  };
  if (outcome.outcome === "skipped") {
    return {
      ...head,
      outcome: "skipped",
      recipientEmail: null,
      templateKey: null,
      templateLabel: null,
      reason: outcome.reason,
      message: outcome.message,
      nextAllowedAt: outcome.throttle?.nextAllowedAt?.toISOString() ?? null,
      error: null,
    };
  }
  if (outcome.outcome === "failed") {
    return {
      ...head,
      outcome: "failed",
      recipientEmail: outcome.recipientEmail,
      templateKey: outcome.templateKey,
      templateLabel: outcome.templateLabel,
      reason: "send_failed",
      message: outcome.message,
      nextAllowedAt: null,
      error: outcome.error,
    };
  }
  return {
    ...head,
    outcome: "sent",
    recipientEmail: outcome.recipientEmail,
    templateKey: outcome.templateKey,
    templateLabel: outcome.templateLabel,
    reason: null,
    message: outcome.message,
    nextAllowedAt: null,
    error: null,
  };
}

export function registerInvoiceReminderBatchRoutes(
  app: Express,
  deps: RegisterInvoiceReminderBatchRoutesDeps,
): void {
  const core = deps._core ?? createReminderCore(deps);
  const now = () => deps._now?.() ?? new Date();
  const claimsFor = (req: any, invoiceIds: number[], templateKey: ReminderTemplateChoice) => ({
    userId: req.authenticatedUserId,
    companyId: req.authenticatedUserCompanyId,
    invoiceIds,
    templateKey,
  });

  // ── Dry run ───────────────────────────────────────────────────────────────
  //
  // Everything the confirmation list shows comes from here, and nothing here
  // sends. The two groups are returned pre-split so the client cannot show a
  // count where it owes the reader an address.

  app.post(
    "/api/invoices/reminders/preview",
    deps.requireAuthentication,
    deps.requireInvoiceSend,
    async (req: any, res) => {
      try {
        const parsed = parseBody(req.body);
        if (!parsed.ok) {
          res.status(parsed.status).json({ message: parsed.message });
          return;
        }

        const rows: ReminderPreviewRow[] = [];
        for (const invoiceId of parsed.invoiceIds) {
          rows.push(await core.previewOne(req, invoiceId, parsed.templateKey));
        }

        const willSend = rows.filter((r) => r.outcome === "send");
        const willSkip = rows.filter((r) => r.outcome === "skip");
        // An id from another company is neither previewed nor named — it is
        // reported as a bare number so nothing is silently dropped, and no
        // customer, address or balance crosses the company boundary.
        const notFound = rows
          .filter((r) => r.outcome === "not_found")
          .map((r) => r.invoiceId);

        // Reading the list is what authorises the send, so the token is issued
        // here and nowhere else. It is bound to this reader, this company,
        // these exact ids and this tone.
        const confirmation = issueConfirmationToken(
          claimsFor(req, parsed.invoiceIds, parsed.templateKey),
          now(),
        );

        res.json({
          templateKey: parsed.templateKey,
          willSend,
          willSkip,
          notFound,
          confirmationToken: confirmation.token,
          confirmationExpiresAt: confirmation.expiresAt.toISOString(),
          counts: {
            selected: parsed.invoiceIds.length,
            willSend: willSend.length,
            willSkip: willSkip.length,
            notFound: notFound.length,
          },
        });
      } catch (error) {
        console.error("Error previewing batch invoice reminders:", error);
        res.status(500).json({ message: "Failed to preview reminders" });
      }
    },
  );

  // ── The confirmed send ────────────────────────────────────────────────────

  app.post(
    "/api/invoices/reminders/batch",
    deps.requireAuthentication,
    deps.requireInvoiceSend,
    async (req: any, res) => {
      try {
        const parsed = parseBody(req.body);
        if (!parsed.ok) {
          res.status(parsed.status).json({ message: parsed.message });
          return;
        }

        // The interlock, enforced here rather than in the dialog: without a
        // confirmation issued by the preview for this exact selection, this
        // request does not reach the mailer at all.
        const confirmed = verifyConfirmationToken(
          (req.body ?? {}).confirmationToken,
          claimsFor(req, parsed.invoiceIds, parsed.templateKey),
          now(),
        );
        if (!confirmed.ok) {
          res.status(confirmed.status).json({
            message: confirmed.message,
            reason: confirmed.reason,
          });
          return;
        }

        const results: BatchReminderResultRow[] = [];
        const notFound: number[] = [];

        // Sequential and independently guarded: one invoice's failure — a
        // bounce, a provider error, an unexpected throw — must not cost the
        // other nineteen their reminder. Every invoice gets a row either way.
        for (const invoiceId of parsed.invoiceIds) {
          try {
            // `sendOne` re-resolves and re-checks eligibility and the throttle
            // at send time. The preview payload is never trusted; it is not
            // even sent back to us.
            const outcome = await core.sendOne(req, invoiceId, parsed.templateKey);
            if (outcome.outcome === "not_found") {
              notFound.push(invoiceId);
              continue;
            }
            results.push(toResultRow(outcome));
          } catch (error) {
            console.error(`Batch reminder failed for invoice ${invoiceId}:`, error);
            results.push({
              invoiceId,
              invoiceNumber: String(invoiceId),
              customerName: "",
              outcome: "failed",
              recipientEmail: null,
              templateKey: null,
              templateLabel: null,
              reason: "send_failed",
              message: "The reminder could not be sent.",
              nextAllowedAt: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // 200 with per-invoice rows, always. A batch is not pass/fail: the
        // bookkeeper needs to read what each invoice did, and a blanket error
        // status would throw that away at the client's catch.
        res.json({
          templateKey: parsed.templateKey,
          results,
          notFound,
          summary: {
            selected: parsed.invoiceIds.length,
            sent: results.filter((r) => r.outcome === "sent").length,
            skipped: results.filter((r) => r.outcome === "skipped").length,
            failed: results.filter((r) => r.outcome === "failed").length,
            notFound: notFound.length,
          },
        });
      } catch (error) {
        console.error("Error sending batch invoice reminders:", error);
        res.status(500).json({ message: "Failed to send reminders" });
      }
    },
  );
}
