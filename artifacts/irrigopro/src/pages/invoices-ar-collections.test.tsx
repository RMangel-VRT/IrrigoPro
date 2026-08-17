/**
 * invoices-ar-collections.test.tsx — Task #1890
 *
 * The A/R collections view on the invoice list, from the browser's side. The
 * server-side query logic (filter composition, whole-set sorting,
 * annotate-before-paginate, company isolation) is covered against a storage
 * spy in `artifacts/api-server/src/routes/invoice-list-routes.test.ts`; what
 * can only be checked here is:
 *
 *  1. every invoice-reading role lands on collections work without touching a
 *     control (Task #1950 expanded this from bookkeeper-only to all roles);
 *  2. every filter survives a URL round-trip and reaches the server as one
 *     AND-ed query;
 *  3. an existing `?aging=` deep link from the Financial Pulse widget still
 *     behaves exactly as it did;
 *  4. flags render as text badges with tooltips — present on a messy invoice,
 *     absent on a clean one, and never "never sent" on a draft;
 *  5. the balance falls back to the invoice total with the stale-sync badge
 *     beside it;
 *  6. no invoice-authoring control renders for the bookkeeper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const { roleRef } = vi.hoisted(() => ({ roleRef: { current: "billing_manager" } }));

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

/** A fully-clean, freshly-synced, sent, paid-up-to-date invoice. */
function cleanInvoice(overrides: Row = {}): Row {
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
    sentAt: new Date(NOW - 5 * DAY).toISOString(),
    quickbooksInvoiceId: "QB-77",
    qbVoidDetectedAt: null,
    qbNote: null,
    invoiceYear: 2026,
    invoiceMonth: 8,
    createdAt: new Date(NOW - 10 * DAY).toISOString(),
    dueDate: new Date(NOW + 20 * DAY).toISOString(),
    effectiveDueDate: new Date(NOW + 20 * DAY).toISOString(),
    isOverdue: false,
    daysOverdue: -20,
    agingBucket: "current",
    arFlags: [],
    ...overrides,
  };
}

// Radix's Select drives its open/close off pointer capture, which jsdom does
// not implement. Without these no-ops, opening the reminder filter throws.
const proto = Element.prototype as any;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};
proto.scrollIntoView ??= () => {};

let requestedUrls: string[] = [];
let rowsForResponse: Row[] = [];
/**
 * Task #1942 — the aging aggregate behind the strip and the header total.
 * Server-shaped: four buckets plus an overall total, all computed there.
 */
let agingSummaryForResponse: Record<string, unknown> = emptyAgingSummary();
/** Task #1942 — the server's refusal payload per invoice. */
let eligibilityForResponse: Record<string, unknown>[] = [];

/**
 * A server eligibility row saying a reminder may go out. The button's state is
 * the server's answer, so a test that wants an enabled button fixtures one.
 */
function eligible(invoiceId: number): Record<string, unknown> {
  return {
    invoiceId,
    canSend: true,
    refusal: null,
    throttle: {
      windowDays: 7,
      lastSentAt: null,
      nextAllowedAt: null,
      throttled: false,
      message: null,
    },
  };
}

function emptyAgingSummary(): Record<string, unknown> {
  return {
    buckets: [
      { key: "current", label: "Not yet due", filterValue: "current", balanceDue: "0.00", count: 0 },
      { key: "days30", label: "1–29 days overdue", filterValue: "days30", balanceDue: "0.00", count: 0 },
      { key: "days60", label: "30–59 days overdue", filterValue: "days60", balanceDue: "0.00", count: 0 },
      { key: "days90", label: "60+ days overdue", filterValue: "days90Plus", balanceDue: "0.00", count: 0 },
    ],
    overall: { balanceDue: "0.00", count: 0 },
  };
}

beforeEach(() => {
  requestedUrls = [];
  rowsForResponse = [cleanInvoice()];
  agingSummaryForResponse = emptyAgingSummary();
  eligibilityForResponse = [];
  roleRef.current = "billing_manager";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      // Both of these contain "/api/invoices", so they are matched first.
      if (url.includes("/api/invoices/aging-summary")) {
        return new Response(JSON.stringify(agingSummaryForResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/invoices/reminder-eligibility")) {
        return new Response(JSON.stringify({ rows: eligibilityForResponse, notFound: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/invoices")) {
        return new Response(JSON.stringify(rowsForResponse), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Total-Count": String(rowsForResponse.length) },
        });
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderInvoices(initialPath = "/invoices") {
  // `memoryLocation` keeps the path and the search string separately and
  // exposes a matching `searchHook`. Both have to be handed to the Router:
  // without the search hook, `useSearch` falls through to the real browser
  // location and every A/R parameter reads as absent — and the URL is exactly
  // what is under test here.
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

/**
 * jsdom applies no media queries, so the desktop table and the mobile card
 * list both render and every shared control appears twice. The desktop one is
 * first in the DOM.
 */
function firstByTestId(testId: string): HTMLElement {
  return screen.getAllByTestId(testId)[0];
}

// The list endpoint specifically — `/api/invoices/:id/...` sub-resources also
// contain "/api/invoices" and would otherwise be mistaken for it.
const isListRequest = (u: string) => u.includes("/api/invoices?");

/** The query string of the most recent invoice-list request. */
function lastInvoiceQuery(): URLSearchParams {
  const url = [...requestedUrls].reverse().find(isListRequest);
  return new URLSearchParams(url ? url.split("?")[1] ?? "" : "");
}

async function waitForInvoiceFetch() {
  await waitFor(() => expect(requestedUrls.some(isListRequest)).toBe(true));
}

/**
 * Task #1942 — the filter controls live inside a popover now. Same testids,
 * same parameters, one click further in.
 */
async function openFiltersPopover() {
  fireEvent.click(firstByTestId("invoice-filters-button"));
  await waitFor(() => expect(screen.getByTestId("ar-filter-payment-status")).toBeTruthy());
}

/** Radix opens its dropdown on pointerdown, which jsdom does not synthesise. */
async function openActionsMenu(invoiceId: number) {
  const trigger = firstByTestId(`button-invoice-actions-${invoiceId}`);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
}

// ── 1. landing defaults ──────────────────────────────────────────────────────

describe("collections landing default", () => {
  it("drops the bookkeeper on unpaid-and-overdue, biggest balance in the oldest bucket", async () => {
    roleRef.current = "bookkeeper";
    const { nav } = renderInvoices("/invoices");

    await waitFor(() => {
      const q = new URLSearchParams(nav.history[nav.history.length - 1].split("?")[1] ?? "");
      expect(q.get("aging")).toBe("overdue");
      expect(q.get("paymentStatus")).toBe("unpaid");
      expect(q.get("sort")).toBe("balanceDue");
      expect(q.get("dir")).toBe("desc");
    });

    // …and those same filters are what the server is asked for.
    await waitFor(() => {
      const q = lastInvoiceQuery();
      expect(q.get("aging")).toBe("overdue");
      expect(q.get("sort")).toBe("balanceDue");
    });
  });

  it("also drops billing_manager on unpaid-and-overdue, biggest balance first", async () => {
    roleRef.current = "billing_manager";
    const { nav } = renderInvoices("/invoices");

    await waitFor(() => {
      const q = new URLSearchParams(nav.history[nav.history.length - 1].split("?")[1] ?? "");
      expect(q.get("aging")).toBe("overdue");
      expect(q.get("paymentStatus")).toBe("unpaid");
      expect(q.get("sort")).toBe("balanceDue");
      expect(q.get("dir")).toBe("desc");
    });
    await waitFor(() => {
      const q = lastInvoiceQuery();
      expect(q.get("aging")).toBe("overdue");
      expect(q.get("sort")).toBe("balanceDue");
    });
  });

  it("does not override a view the bookkeeper arrived with", async () => {
    roleRef.current = "bookkeeper";
    const { nav } = renderInvoices("/invoices?aging=days90Plus");
    await waitForInvoiceFetch();

    // A shared link wins over the landing default.
    expect(nav.history).toEqual(["/invoices?aging=days90Plus"]);
    expect(lastInvoiceQuery().get("aging")).toBe("days90Plus");
  });
});

// ── 2. filters in the URL ────────────────────────────────────────────────────

describe("A/R filters and the URL", () => {
  it("round-trips every filter from the query string into the request", async () => {
    const url =
      "/invoices?aging=days60&paymentStatus=partially_paid&sent=unsent&customerId=10" +
      "&dateFrom=2026-01-01&dateTo=2026-06-30&amountMin=100&amountMax=900&flagged=1" +
      "&sort=balanceDue&dir=asc";
    renderInvoices(url);
    await waitForInvoiceFetch();

    const q = lastInvoiceQuery();
    expect(Object.fromEntries(q.entries())).toMatchObject({
      aging: "days60",
      paymentStatus: "partially_paid",
      sent: "unsent",
      customerId: "10",
      dateFrom: "2026-01-01",
      dateTo: "2026-06-30",
      amountMin: "100",
      amountMax: "900",
      flagged: "1",
      sort: "balanceDue",
      dir: "asc",
    });
  });

  it("writes a changed filter back to the URL, keeping the others", async () => {
    const { nav } = renderInvoices("/invoices?aging=days60&flagged=1");
    await waitForInvoiceFetch();

    await openFiltersPopover();
    fireEvent.click(screen.getByTestId("ar-filter-flagged"));

    await waitFor(() => {
      const q = new URLSearchParams(nav.history[nav.history.length - 1].split("?")[1] ?? "");
      expect(q.get("flagged")).toBeNull();
      expect(q.get("aging")).toBe("days60"); // untouched
    });
  });

  it("clearing everything returns the role's default list", async () => {
    const { nav } = renderInvoices("/invoices?aging=days60&flagged=1&sort=balanceDue&dir=desc");
    await waitForInvoiceFetch();

    fireEvent.click(screen.getByTestId("ar-filter-clear"));

    // After clearing, the role lands on its default: unpaid-and-overdue, biggest
    // balance first (Task #1950 — now universal across all invoice-reading roles).
    await waitFor(() => {
      const q = new URLSearchParams(nav.history[nav.history.length - 1].split("?")[1] ?? "");
      expect(q.get("aging")).toBe("overdue");
      expect(q.get("paymentStatus")).toBe("unpaid");
      expect(q.get("sort")).toBe("balanceDue");
      expect(q.get("dir")).toBe("desc");
    });
  });

  it("a sortable A/R header cycles desc → asc → off in the URL", async () => {
    // Use ?paymentStatus=unpaid so the landing-default effect fires but returns
    // early (non-empty query) without triggering an extra fetch.  We do NOT
    // use ?aging=overdue here because the client-side aging filter would drop
    // cleanInvoice() (agingBucket="current"), leaving the table empty.
    const { nav } = renderInvoices("/invoices?paymentStatus=unpaid");
    // Wait for the table and its sort headers to appear.
    await waitFor(() => screen.getAllByTestId("ar-sort-balanceDue")[0]);
    const last = () => nav.history[nav.history.length - 1];

    // Descending first: collections wants the biggest balance at the top.
    fireEvent.click(screen.getAllByTestId("ar-sort-balanceDue")[0]);
    await waitFor(() => expect(last()).toContain("sort=balanceDue&dir=desc"));
    // The new query key triggers a re-fetch; wait for the table to reappear
    // before clicking again — the header is absent during the loading state.
    await waitFor(() => screen.getAllByTestId("ar-sort-balanceDue")[0]);

    fireEvent.click(screen.getAllByTestId("ar-sort-balanceDue")[0]);
    await waitFor(() => expect(last()).toContain("sort=balanceDue&dir=asc"));
    await waitFor(() => screen.getAllByTestId("ar-sort-balanceDue")[0]);

    // "Off" removes the sort columns; other filters stay intact.
    fireEvent.click(screen.getAllByTestId("ar-sort-balanceDue")[0]);
    await waitFor(() => {
      const q = new URLSearchParams(last().split("?")[1] ?? "");
      expect(q.get("sort")).toBeNull();
      expect(q.get("dir")).toBeNull();
      expect(q.get("paymentStatus")).toBe("unpaid"); // untouched
    });
  });
});

// ── 3. the existing Financial Pulse deep link ────────────────────────────────

describe("existing ?aging= deep links", () => {
  it("still select their bucket, unchanged", async () => {
    for (const bucket of ["current", "days30", "days60", "days90Plus"]) {
      requestedUrls = [];
      const view = renderInvoices(`/invoices?aging=${bucket}`);
      await waitForInvoiceFetch();
      expect(lastInvoiceQuery().get("aging")).toBe(bucket);
      view.unmount();
    }
  });

  it("shows the deep-linked bucket as the selected value of the same control", async () => {
    renderInvoices("/invoices?aging=days90Plus");
    await waitForInvoiceFetch();
    // One `aging` parameter, shared by the widget's links and the new view.
    // Task #1942 — the aging strip is now where the current bucket is stated,
    // and the same parameter still drives it.
    await waitFor(() =>
      expect(screen.getByTestId("ar-aging-card-days90Plus")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    // …and there is no second, differently shaped control for the same
    // parameter hiding in the Filters popover: the cards are the aging control.
    await openFiltersPopover();
    expect(screen.queryByTestId("invoices-aging-filter")).toBeNull();
  });
});

// ── 4. flag badges ───────────────────────────────────────────────────────────

describe("flag badges", () => {
  it("renders nothing but an em dash for a clean invoice", async () => {
    rowsForResponse = [cleanInvoice()];
    // Use ?paymentStatus=unpaid so the landing-default effect fires but returns
    // early (non-empty query) and the client-side aging filter (all) passes the
    // cleanInvoice() fixture (agingBucket="current").
    renderInvoices("/invoices?paymentStatus=unpaid");
    await waitFor(() => expect(screen.getByTestId("ar-flags-none-1")).toBeTruthy());
  });

  it("renders each flagged condition as text with a plain-language tooltip", async () => {
    rowsForResponse = [
      cleanInvoice({
        arFlags: [
          "never_sent",
          "overdue",
          "qb_voided",
          "not_in_qb",
          "stale_sync",
          "no_billing_email",
          "needs_qb_cleanup",
        ],
      }),
    ];
    renderInvoices("/invoices?paymentStatus=unpaid");

    await waitFor(() => expect(screen.getByTestId("ar-flags-1")).toBeTruthy());
    for (const flag of [
      "never_sent",
      "overdue",
      "qb_voided",
      "not_in_qb",
      "stale_sync",
      "no_billing_email",
      "needs_qb_cleanup",
    ]) {
      const badge = screen.getByTestId(`ar-flag-${flag}-1`);
      // Text, not colour alone.
      expect(badge.textContent?.trim().length).toBeGreaterThan(0);
      // And a sentence explaining it, not a repeat of the badge.
      const tooltip = badge.getAttribute("title") ?? "";
      expect(tooltip.length).toBeGreaterThan(badge.textContent!.trim().length);
    }
  });

  it("derives the flags itself when the server did not send them", async () => {
    // A cached payload from before this change carries no `arFlags`.
    const { arFlags, ...withoutFlags } = cleanInvoice({
      sentAt: null,
      quickbooksInvoiceId: null,
      paymentSyncedAt: null,
    }) as Row;
    rowsForResponse = [withoutFlags];
    renderInvoices("/invoices?paymentStatus=unpaid");

    await waitFor(() => expect(screen.getByTestId("ar-flag-never_sent-1")).toBeTruthy());
    expect(screen.getByTestId("ar-flag-not_in_qb-1")).toBeTruthy();
    expect(screen.getByTestId("ar-flag-stale_sync-1")).toBeTruthy();
  });

  it("never flags a draft as never sent", async () => {
    const { arFlags, ...draft } = cleanInvoice({ status: "draft", sentAt: null }) as Row;
    rowsForResponse = [draft];
    renderInvoices("/invoices?paymentStatus=unpaid");

    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());
    expect(screen.queryByTestId("ar-flag-never_sent-1")).toBeNull();
  });
});

// ── 5. balance fallback ──────────────────────────────────────────────────────

describe("balance due", () => {
  it("shows the synced balance when a sync has run", async () => {
    rowsForResponse = [cleanInvoice({ balanceDue: "120.00", balanceIsFallback: false })];
    renderInvoices("/invoices?paymentStatus=unpaid");
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toHaveTextContent("$120.00"));
  });

  it("falls back to the invoice total, with the stale-sync badge beside it", async () => {
    rowsForResponse = [
      cleanInvoice({
        balance: null,
        balanceDue: "500.00",
        balanceIsFallback: true,
        paymentSyncedAt: null,
        arFlags: ["stale_sync"],
      }),
    ];
    renderInvoices("/invoices?paymentStatus=unpaid");

    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toHaveTextContent("$500.00"));
    // The figure may be wrong, and the row says so rather than implying
    // precision it does not have.
    expect(screen.getByTestId("ar-balance-1").getAttribute("title")).toMatch(/may not reflect/i);
    expect(screen.getByTestId("ar-flag-stale_sync-1")).toBeTruthy();
  });
});

// ── 6. the columns themselves ────────────────────────────────────────────────

describe("A/R columns", () => {
  it("shows balance, due date, days overdue, bucket, payment status and sent", async () => {
    rowsForResponse = [
      cleanInvoice({
        isOverdue: true,
        daysOverdue: 42,
        agingBucket: "days60",
        effectiveDueDate: new Date(NOW - 42 * DAY).toISOString(),
        paymentStatus: "partially_paid",
      }),
    ];
    renderInvoices();

    await waitFor(() => expect(screen.getByTestId("ar-days-overdue-1")).toHaveTextContent("42"));
    expect(screen.getByTestId("ar-bucket-1")).toHaveTextContent("30–59 days overdue");
    expect(screen.getByTestId("ar-payment-status-1")).toHaveTextContent("Partially paid");
    expect(screen.getByTestId("ar-sent-1")).toBeTruthy();
    expect(screen.getByTestId("ar-due-1")).toBeTruthy();
  });

  it("leaves days overdue blank for an invoice that is not yet due", async () => {
    rowsForResponse = [cleanInvoice()];
    renderInvoices("/invoices?paymentStatus=unpaid");
    await waitFor(() => expect(screen.getByTestId("ar-bucket-1")).toHaveTextContent("Current"));
    // Task #1942 — the balance cell says so in words rather than with a dash.
    expect(screen.getByTestId("ar-days-overdue-1")).toHaveTextContent("Not yet due");
  });

  // Task #1887 — the two columns and the filter above them used to render
  // permanently inert. These are the tests that they carry real data now.
  it("shows the recorded last reminder and count", async () => {
    rowsForResponse = [
      cleanInvoice({
        lastReminderAt: new Date(NOW - 3 * DAY).toISOString(),
        reminderCount: 2,
      }),
    ];
    eligibilityForResponse = [eligible(1)];
    renderInvoices("/invoices?paymentStatus=unpaid");
    // Task #1942 — the reminder history moved into the status cell's second
    // line; the action it used to sit beside is now the row's named primary
    // action, and its state comes from the server.
    await waitFor(() =>
      expect(firstByTestId("ar-last-reminder-1")).toHaveTextContent("Reminded"),
    );
    expect(firstByTestId("ar-last-reminder-1")).toHaveTextContent("2×");
    await waitFor(() => expect(firstByTestId("invoice-primary-action-1")).not.toBeDisabled());
  });

  it("says so and offers the send action when no reminder has gone out", async () => {
    rowsForResponse = [cleanInvoice({ lastReminderAt: null, reminderCount: 0 })];
    eligibilityForResponse = [eligible(1)];
    renderInvoices("/invoices?paymentStatus=unpaid");
    await waitFor(() =>
      expect(firstByTestId("ar-last-reminder-1")).toHaveTextContent("No reminders"),
    );
    await waitFor(() =>
      expect(firstByTestId("invoice-primary-action-1")).toHaveTextContent("Remind"),
    );
  });

  it("sends the reminder filter to the server rather than filtering the loaded page", async () => {
    const { nav } = renderInvoices();
    await waitForInvoiceFetch();

    await openFiltersPopover();
    const select = firstByTestId("ar-filter-reminders");
    expect(select).not.toBeDisabled();
    fireEvent.pointerDown(select, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(select);
    await waitFor(() => expect(screen.getByTestId("ar-filter-reminders-thrice")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ar-filter-reminders-thrice"));

    await waitFor(() => expect(lastInvoiceQuery().get("reminders")).toBe("thrice"));
    // …and it survives the URL round-trip like every other A/R filter.
    const q = new URLSearchParams(nav.history[nav.history.length - 1].split("?")[1] ?? "");
    expect(q.get("reminders")).toBe("thrice");
  });

  it("restores the reminder filter from a deep link", async () => {
    renderInvoices("/invoices?reminders=never");
    await waitFor(() => expect(lastInvoiceQuery().get("reminders")).toBe("never"));
  });

  it("flags a reminded invoice that is still overdue, and only that one", async () => {
    // No `arFlags` on either row, so the client-side fallback is what runs —
    // the same rule the server applies, applied here.
    rowsForResponse = [
      cleanInvoice({
        id: 1,
        invoiceNumber: "INV-1",
        isOverdue: true,
        daysOverdue: 40,
        agingBucket: "days60",
        dueDate: new Date(NOW - 40 * DAY).toISOString(),
        effectiveDueDate: new Date(NOW - 40 * DAY).toISOString(),
        reminderCount: 1,
        lastReminderAt: new Date(NOW - 2 * DAY).toISOString(),
        arFlags: undefined,
      }),
      cleanInvoice({
        id: 2,
        invoiceNumber: "INV-2",
        isOverdue: true,
        daysOverdue: 40,
        agingBucket: "days60",
        dueDate: new Date(NOW - 40 * DAY).toISOString(),
        effectiveDueDate: new Date(NOW - 40 * DAY).toISOString(),
        reminderCount: 0,
        lastReminderAt: null,
        arFlags: undefined,
      }),
    ];
    renderInvoices();
    await waitFor(() => expect(screen.getAllByTestId("ar-flag-reminded_still_unpaid-1").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("ar-flag-reminded_still_unpaid-2")).toBeNull();
  });
});

// ── 7. the bookkeeper's read-only view ───────────────────────────────────────

describe("bookkeeper controls", () => {
  // The bookkeeper lands on unpaid-and-overdue, so a fixture she can actually
  // see has to be overdue and unpaid.
  const overdueInvoice = (overrides: Row = {}) =>
    cleanInvoice({
      isOverdue: true,
      daysOverdue: 45,
      agingBucket: "days60",
      effectiveDueDate: new Date(NOW - 45 * DAY).toISOString(),
      dueDate: new Date(NOW - 45 * DAY).toISOString(),
      arFlags: ["overdue"],
      ...overrides,
    });

  it("renders no invoice-authoring control", async () => {
    roleRef.current = "bookkeeper";
    // Unsent, so the mark-sent action she IS granted is on offer and its
    // absence would be a real regression rather than a state quirk.
    rowsForResponse = [overdueInvoice({ sentAt: null, arFlags: ["overdue", "never_sent"] })];
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());

    await openActionsMenu(1);

    for (const authoring of [
      "button-void-invoice-1",
      "button-finalize-invoice-1",
      "button-return-to-draft-invoice-1",
      "button-correct-invoice-1",
      "button-edit-invoice-metadata-1",
      "button-manage-tickets-invoice-1",
    ]) {
      expect(screen.queryByTestId(authoring)).toBeNull();
    }
    // …but the action the registry deliberately grants her is still there.
    expect(screen.getByTestId("button-mark-sent-invoice-1")).toBeTruthy();
  });

  // Task #1888 opened the row checkbox to CAN_SEND_INVOICE_EMAIL, so it is no
  // longer merge-specific. What must stay true is that selecting rows never
  // hands her the merge action itself.
  it("offers her the row checkbox but never the merge action", async () => {
    roleRef.current = "bookkeeper";
    rowsForResponse = [overdueInvoice()];
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());

    const checkbox = firstByTestId("checkbox-select-invoice-1");
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox);

    await waitFor(() => expect(screen.getByTestId("button-batch-remind")).toBeTruthy());
    expect(screen.queryByTestId("button-merge-invoices")).toBeNull();
  });

  it("still offers a billing manager the authoring controls", async () => {
    roleRef.current = "billing_manager";
    rowsForResponse = [cleanInvoice()];
    renderInvoices("/invoices?paymentStatus=unpaid");
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());

    await openActionsMenu(1);
    expect(screen.getByTestId("button-void-invoice-1")).toBeTruthy();
  });
});

// ── 7. internal A/R note indicator (Task #1889) ─────────────────────────────
//
// The server decides who may know a note exists; these tests check the client
// honours the payload it is given. The critical case is the one in the middle:
// an ABSENT count and a ZERO count must both render nothing, but they mean
// different things and neither may produce a badge.

describe("internal A/R note indicator", () => {
  // The bookkeeper lands on unpaid-and-overdue, so a row she can see at all
  // has to be overdue and unpaid.
  const overdueInvoice = (overrides: Row = {}) =>
    cleanInvoice({
      isOverdue: true,
      daysOverdue: 45,
      agingBucket: "days60",
      effectiveDueDate: new Date(NOW - 45 * DAY).toISOString(),
      dueDate: new Date(NOW - 45 * DAY).toISOString(),
      arFlags: ["overdue"],
      ...overrides,
    });

  it("shows the count and a hover preview when the server sent them", async () => {
    roleRef.current = "bookkeeper";
    rowsForResponse = [
      overdueInvoice({
        arNoteCount: 3,
        lastArNoteAt: new Date(NOW - 2 * DAY).toISOString(),
        lastArNotePreview: "AP says it's in the next check run",
      }),
    ];
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());

    const badge = firstByTestId("ar-note-indicator-1");
    expect(badge.textContent).toContain("3");
    // The preview rides along with the row, so hovering costs no request.
    expect(badge.getAttribute("title")).toContain("AP says it's in the next check run");
    expect(badge.getAttribute("title")).toContain("Internal only");
  });

  it("renders nothing when the row carries no notes", async () => {
    roleRef.current = "bookkeeper";
    rowsForResponse = [overdueInvoice({ arNoteCount: 0, lastArNoteAt: null, lastArNotePreview: null })];
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());
    expect(screen.queryByTestId("ar-note-indicator-1")).toBeNull();
  });

  it("renders nothing when the server stripped the fields for this role", async () => {
    // What an irrigation_manager actually receives: the keys are simply not
    // there. No badge, no placeholder, no "0" — nothing that hints a
    // conversation about this customer exists.
    roleRef.current = "irrigation_manager";
    rowsForResponse = [cleanInvoice()];
    renderInvoices("/invoices?paymentStatus=unpaid");
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());
    expect(screen.queryByTestId("ar-note-indicator-1")).toBeNull();
    expect(screen.queryByTestId("ar-note-indicator-mobile-1")).toBeNull();
  });

  it("appears on the mobile card too", async () => {
    roleRef.current = "bookkeeper";
    rowsForResponse = [overdueInvoice({ arNoteCount: 1, lastArNotePreview: "Left a voicemail" })];
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());
    expect(screen.getByTestId("ar-note-indicator-mobile-1")).toBeTruthy();
  });
});
