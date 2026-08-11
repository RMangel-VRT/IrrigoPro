/**
 * invoices-batch-reminders.test.tsx — Task #1888
 *
 * The batch reminder send from the browser's side. The refusal matrix, the
 * throttle and company isolation are covered against a storage spy and a
 * mailer spy in
 * `artifacts/api-server/src/routes/invoice-reminder-batch-routes.test.ts` —
 * that is where "no email was attempted" is a statement about email. What can
 * only be checked here is the interlock in front of it:
 *
 *  1. selection on the A/R list, with a count, a clear, a select-all bound to
 *     the active filters, and a selection that does not outlive its filter;
 *  2. the confirmation list showing every address and every skip reason in
 *     full, expanded, with no request to the send endpoint before the click;
 *  3. the per-invoice results afterwards, and the A/R list refreshing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const { roleRef } = vi.hoisted(() => ({ roleRef: { current: "bookkeeper" } }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/utils/safeStorage", () => ({
  safeGet: (key: string) =>
    key === "user" ? JSON.stringify({ id: 1, role: roleRef.current }) : null,
  safeSet: vi.fn(),
  safeRemove: vi.fn(),
}));

// Static import AFTER the vi.mock() calls are hoisted.
import InvoicesPage from "./invoices";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type Row = Record<string, unknown>;

function overdueInvoice(overrides: Row = {}): Row {
  return {
    id: 1,
    invoiceNumber: "INV-1001",
    customerId: 10,
    customerName: "Acme Grounds",
    customerEmail: "billing@acme.example",
    status: "generated",
    totalAmount: "500.00",
    balance: "500.00",
    balanceDue: "500.00",
    balanceIsFallback: false,
    paymentStatus: "unpaid",
    paymentSyncedAt: new Date(NOW - 60_000).toISOString(),
    paidAt: null,
    sentAt: new Date(NOW - 40 * DAY).toISOString(),
    quickbooksInvoiceId: "QB-77",
    qbVoidDetectedAt: null,
    qbNote: null,
    invoiceYear: 2026,
    invoiceMonth: 8,
    createdAt: new Date(NOW - 45 * DAY).toISOString(),
    dueDate: new Date(NOW - 45 * DAY).toISOString(),
    effectiveDueDate: new Date(NOW - 45 * DAY).toISOString(),
    isOverdue: true,
    daysOverdue: 45,
    agingBucket: "days60",
    arFlags: ["overdue"],
    ...overrides,
  };
}

// Radix drives open/close off pointer capture, which jsdom does not implement.
const proto = Element.prototype as any;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};
proto.scrollIntoView ??= () => {};

let requestedUrls: string[] = [];
let postedBodies: Record<string, any[]> = {};
let rowsForResponse: Row[] = [];
let previewResponse: any;
let batchResponse: any;

const SEND_ROW = {
  invoiceId: 1,
  invoiceNumber: "INV-1001",
  customerName: "Acme Grounds",
  recipientEmail: "billing@acme.example",
  templateKey: "firm",
  templateLabel: "Firm reminder",
  balanceDue: "500.00",
  daysOverdue: 45,
};

const SKIP_PAID = {
  invoiceId: 2,
  invoiceNumber: "INV-1002",
  customerName: "Bright Lawns",
  reason: "paid",
  message: "Invoice #INV-1002 is already paid in full. There is nothing to remind the customer about.",
  nextAllowedAt: null,
};

const SKIP_THROTTLED = {
  invoiceId: 3,
  invoiceNumber: "INV-1003",
  customerName: "Cedar Park HOA",
  reason: "throttled",
  message: "A reminder for invoice #INV-1003 was sent 2 days ago.",
  nextAllowedAt: new Date(NOW + 5 * DAY).toISOString(),
};

beforeEach(() => {
  requestedUrls = [];
  postedBodies = {};
  roleRef.current = "bookkeeper";
  rowsForResponse = [
    overdueInvoice(),
    overdueInvoice({ id: 2, invoiceNumber: "INV-1002", customerName: "Bright Lawns" }),
    overdueInvoice({ id: 3, invoiceNumber: "INV-1003", customerName: "Cedar Park HOA" }),
  ];
  previewResponse = {
    templateKey: "suggested",
    willSend: [SEND_ROW],
    willSkip: [SKIP_PAID, SKIP_THROTTLED],
    notFound: [],
    // The server will not send without the confirmation its preview issued.
    confirmationToken: "confirmation-from-the-preview",
    confirmationExpiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    counts: { selected: 3, willSend: 1, willSkip: 2, notFound: 0 },
  };
  batchResponse = {
    templateKey: "suggested",
    results: [
      {
        invoiceId: 1,
        invoiceNumber: "INV-1001",
        customerName: "Acme Grounds",
        outcome: "sent",
        recipientEmail: "billing@acme.example",
        templateKey: "firm",
        templateLabel: "Firm reminder",
        reason: null,
        message: "Reminder sent to billing@acme.example.",
        nextAllowedAt: null,
        error: null,
      },
      {
        invoiceId: 2,
        invoiceNumber: "INV-1002",
        customerName: "Bright Lawns",
        outcome: "skipped",
        recipientEmail: null,
        templateKey: null,
        templateLabel: null,
        reason: "paid",
        message: SKIP_PAID.message,
        nextAllowedAt: null,
        error: null,
      },
      {
        invoiceId: 3,
        invoiceNumber: "INV-1003",
        customerName: "Cedar Park HOA",
        outcome: "failed",
        recipientEmail: "ap@cedar.example",
        templateKey: "firm",
        templateLabel: "Firm reminder",
        reason: "send_failed",
        message: "The reminder for invoice #INV-1003 could not be delivered.",
        nextAllowedAt: null,
        error: "550 mailbox unavailable",
      },
    ],
    notFound: [],
    summary: { selected: 3, sent: 1, skipped: 1, failed: 1, notFound: 0 },
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (init?.body) {
        const key = url.includes("/batch") ? "batch" : url.includes("/preview") ? "preview" : url;
        (postedBodies[key] ??= []).push(JSON.parse(String(init.body)));
      }
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (url.includes("/api/invoices/reminders/preview")) return json(previewResponse);
      if (url.includes("/api/invoices/reminders/batch")) return json(batchResponse);
      if (url.includes("/api/invoices")) {
        return new Response(JSON.stringify(rowsForResponse), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Total-Count": String(rowsForResponse.length),
          },
        });
      }
      return json([]);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderInvoices(initialPath = "/invoices") {
  const nav = memoryLocation({ path: initialPath, record: true });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Router hook={nav.hook} searchHook={nav.searchHook}>
        <InvoicesPage />
      </Router>
    </QueryClientProvider>,
  );
  return { ...view, nav: { ...nav, history: nav.history! } };
}

/** jsdom renders the desktop table AND the mobile cards; take the first. */
function firstByTestId(testId: string): HTMLElement {
  return screen.getAllByTestId(testId)[0];
}

const isListRequest = (u: string) => u.includes("/api/invoices?");
const listRequestCount = () => requestedUrls.filter(isListRequest).length;
const sendRequests = () => requestedUrls.filter((u) => u.includes("/reminders/batch"));
const previewRequests = () => requestedUrls.filter((u) => u.includes("/reminders/preview"));

async function waitForRows() {
  await waitFor(() => expect(screen.getAllByTestId("checkbox-select-invoice-1").length).toBeGreaterThan(0));
}

async function selectRows(...ids: number[]) {
  for (const id of ids) fireEvent.click(firstByTestId(`checkbox-select-invoice-${id}`));
}

async function openConfirmation(...ids: number[]) {
  await waitForRows();
  await selectRows(...ids);
  fireEvent.click(await screen.findByTestId("button-batch-remind"));
  await screen.findByTestId("batch-reminder-dialog");
}

// ── 1. Selection ────────────────────────────────────────────────────────────

describe("A/R list selection", () => {
  it("counts what is selected and can clear it", async () => {
    renderInvoices();
    await waitForRows();

    await selectRows(1, 2);
    await waitFor(() =>
      expect(firstByTestId("text-selection-count").textContent).toMatch(/2 selected/),
    );

    fireEvent.click(firstByTestId("button-clear-selection"));
    await waitFor(() => expect(screen.queryByTestId("text-selection-count")).toBeNull());
  });

  it("selects every row the active filters are showing, and unselects them again", async () => {
    renderInvoices();
    await waitForRows();

    fireEvent.click(firstByTestId("checkbox-select-all-invoices"));
    await waitFor(() =>
      expect(firstByTestId("text-selection-count").textContent).toMatch(/3 selected/),
    );

    fireEvent.click(firstByTestId("checkbox-select-all-invoices"));
    await waitFor(() => expect(screen.queryByTestId("text-selection-count")).toBeNull());
  });

  it("drops the selection when the filters change underneath it", async () => {
    const { nav } = renderInvoices();
    await waitForRows();
    await selectRows(1);
    await waitFor(() => expect(screen.queryByTestId("text-selection-count")).toBeTruthy());

    // A different aging bucket is a different question — what was selected is
    // no longer what is on screen.
    nav.navigate("/invoices?aging=days90");

    await waitFor(() => expect(screen.queryByTestId("text-selection-count")).toBeNull());
  });

  it("offers the batch action to a bookkeeper and never to a field tech", async () => {
    roleRef.current = "field_tech";
    renderInvoices();
    await waitFor(() => expect(listRequestCount()).toBeGreaterThan(0));

    expect(screen.queryByTestId("checkbox-select-invoice-1")).toBeNull();
    expect(screen.queryByTestId("button-batch-remind")).toBeNull();
  });
});

// ── 2. The confirmation list ────────────────────────────────────────────────

describe("the batch confirmation list", () => {
  it("sends nothing when it opens — it only asks", async () => {
    renderInvoices();
    await openConfirmation(1, 2, 3);

    await screen.findByTestId("batch-reminder-will-send");
    expect(previewRequests().length).toBe(1);
    // The interlock: opening the dialog reached the dry run and nothing else.
    expect(sendRequests()).toEqual([]);
    expect(postedBodies.preview?.[0].invoiceIds.sort()).toEqual([1, 2, 3]);
  });

  it("names every address that would be emailed, with the tone", async () => {
    renderInvoices();
    await openConfirmation(1, 2, 3);

    const group = await screen.findByTestId("batch-reminder-will-send");
    expect(group.textContent).toMatch(/Will be emailed \(1\)/);
    const row = within(group).getByTestId("batch-reminder-send-row-1");
    // The actual address, visible without expanding anything.
    expect(within(row).getByTestId("batch-reminder-email-1").textContent).toBe(
      "billing@acme.example",
    );
    expect(row.textContent).toMatch(/Acme Grounds/);
    expect(row.textContent).toMatch(/Firm reminder/);
  });

  it("lists every skipped invoice with its own reason, expanded", async () => {
    renderInvoices();
    await openConfirmation(1, 2, 3);

    const group = await screen.findByTestId("batch-reminder-will-skip");
    expect(group.textContent).toMatch(/Will be skipped \(2\)/);
    // Both reasons are on screen as text, not behind a disclosure and not
    // collapsed into a count.
    expect(screen.getByTestId("batch-reminder-skip-reason-2").textContent).toMatch(
      /already paid in full/,
    );
    expect(screen.getByTestId("batch-reminder-skip-reason-3").textContent).toMatch(
      /was sent 2 days ago/,
    );
    // A throttled row says when it becomes eligible.
    expect(
      within(screen.getByTestId("batch-reminder-skip-row-3")).getByText(/Next allowed/),
    ).toBeTruthy();
  });

  it("re-previews when the tone changes rather than guessing", async () => {
    renderInvoices();
    await openConfirmation(1);

    await waitFor(() => expect(previewRequests().length).toBe(1));
    const trigger = screen.getByTestId("batch-reminder-tone-select");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("batch-reminder-tone-friendly"));

    await waitFor(() => expect(previewRequests().length).toBe(2));
    expect(postedBodies.preview?.[1].templateKey).toBe("friendly");
    expect(sendRequests()).toEqual([]);
  });

  it("has nothing to confirm when nothing is sendable", async () => {
    previewResponse = {
      templateKey: "suggested",
      willSend: [],
      willSkip: [SKIP_PAID],
      notFound: [],
      confirmationToken: "confirmation-from-the-preview",
      confirmationExpiresAt: new Date(NOW + 15 * 60_000).toISOString(),
      counts: { selected: 1, willSend: 0, willSkip: 1, notFound: 0 },
    };
    renderInvoices();
    await openConfirmation(2);

    await screen.findByTestId("batch-reminder-none-sendable");
    expect(screen.getByTestId("batch-reminder-confirm")).toHaveProperty("disabled", true);
  });

  it("cannot be confirmed until the list it belongs to has arrived", async () => {
    // The preview never resolves, so there is no confirmation to send with.
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    const realFetch = globalThis.fetch as any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/reminders/preview")) {
          await held;
        }
        return realFetch(input, init);
      }),
    );

    renderInvoices();
    await openConfirmation(1);

    await waitFor(() =>
      expect(screen.getByTestId("batch-reminder-confirm")).toHaveProperty("disabled", true),
    );
    fireEvent.click(screen.getByTestId("batch-reminder-confirm"));
    expect(sendRequests()).toEqual([]);
    release?.();
  });

  it("closing it sends nothing", async () => {
    renderInvoices();
    await openConfirmation(1, 2, 3);
    fireEvent.click(await screen.findByTestId("batch-reminder-cancel"));

    await waitFor(() => expect(screen.queryByTestId("batch-reminder-dialog")).toBeNull());
    expect(sendRequests()).toEqual([]);
  });
});

// ── 3. The confirmed send and its results ───────────────────────────────────

describe("the confirmed batch send", () => {
  it("sends only on confirmation, and reports a row per invoice", async () => {
    renderInvoices();
    await openConfirmation(1, 2, 3);
    await screen.findByTestId("batch-reminder-send-row-1");

    expect(sendRequests()).toEqual([]);
    fireEvent.click(screen.getByTestId("batch-reminder-confirm"));

    const results = await screen.findByTestId("batch-reminder-results");
    expect(sendRequests().length).toBe(1);
    expect(postedBodies.batch?.[0].invoiceIds.sort()).toEqual([1, 2, 3]);
    // …carrying the confirmation the preview issued. Without it the server
    // refuses the send outright, which is what makes the list mandatory
    // rather than merely on offer.
    expect(postedBodies.batch?.[0].confirmationToken).toBe("confirmation-from-the-preview");

    expect(results.textContent).toMatch(/1 sent · 1 skipped · 1 failed/);
    expect(screen.getByTestId("batch-reminder-result-1").textContent).toMatch(
      /Reminder sent to billing@acme.example/,
    );
    expect(screen.getByTestId("batch-reminder-result-2").textContent).toMatch(
      /already paid in full/,
    );
    // The failure names its error rather than disappearing into a summary.
    expect(screen.getByTestId("batch-reminder-error-3").textContent).toMatch(
      /550 mailbox unavailable/,
    );
  });

  it("refreshes the A/R list so the reminder columns catch up", async () => {
    renderInvoices();
    await openConfirmation(1);
    await screen.findByTestId("batch-reminder-send-row-1");
    const before = listRequestCount();

    fireEvent.click(screen.getByTestId("batch-reminder-confirm"));
    await screen.findByTestId("batch-reminder-results");

    await waitFor(() => expect(listRequestCount()).toBeGreaterThan(before));
  });

  it("clears the selection once the batch has run", async () => {
    renderInvoices();
    await openConfirmation(1);
    await screen.findByTestId("batch-reminder-send-row-1");

    fireEvent.click(screen.getByTestId("batch-reminder-confirm"));
    await screen.findByTestId("batch-reminder-results");

    fireEvent.click(screen.getByTestId("batch-reminder-close"));
    await waitFor(() => expect(screen.queryByTestId("text-selection-count")).toBeNull());
  });
});
