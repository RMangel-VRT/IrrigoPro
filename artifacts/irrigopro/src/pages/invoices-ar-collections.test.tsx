/**
 * invoices-ar-collections.test.tsx — Task #1890
 *
 * The A/R collections view on the invoice list, from the browser's side. The
 * server-side query logic (filter composition, whole-set sorting,
 * annotate-before-paginate, company isolation) is covered against a storage
 * spy in `artifacts/api-server/src/routes/invoice-list-routes.test.ts`; what
 * can only be checked here is:
 *
 *  1. the bookkeeper lands on collections work without touching a control,
 *     and an existing billing role's landing is untouched;
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

let requestedUrls: string[] = [];
let rowsForResponse: Row[] = [];

beforeEach(() => {
  requestedUrls = [];
  rowsForResponse = [cleanInvoice()];
  roleRef.current = "billing_manager";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
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
      expect(q.get("sort")).toBe("agingBucket");
      expect(q.get("dir")).toBe("desc");
    });

    // …and those same filters are what the server is asked for.
    await waitFor(() => {
      const q = lastInvoiceQuery();
      expect(q.get("aging")).toBe("overdue");
      expect(q.get("sort")).toBe("agingBucket");
    });
  });

  it("leaves an existing billing role's landing exactly as it was", async () => {
    roleRef.current = "billing_manager";
    const { nav } = renderInvoices("/invoices");
    await waitForInvoiceFetch();

    expect(nav.history).toEqual(["/invoices"]);
    const q = lastInvoiceQuery();
    expect(q.get("aging")).toBeNull();
    expect(q.get("paymentStatus")).toBeNull();
    expect(q.get("sort")).toBeNull();
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

    await waitFor(() => expect(nav.history[nav.history.length - 1]).toBe("/invoices"));
  });

  it("a sortable A/R header cycles desc → asc → off in the URL", async () => {
    const { nav } = renderInvoices("/invoices");
    await waitForInvoiceFetch();
    const last = () => nav.history[nav.history.length - 1];

    // Descending first: collections wants the biggest balance at the top.
    fireEvent.click(screen.getByTestId("ar-sort-balanceDue"));
    await waitFor(() => expect(last()).toContain("sort=balanceDue&dir=desc"));

    fireEvent.click(screen.getByTestId("ar-sort-balanceDue"));
    await waitFor(() => expect(last()).toContain("sort=balanceDue&dir=asc"));

    fireEvent.click(screen.getByTestId("ar-sort-balanceDue"));
    await waitFor(() => expect(last()).toBe("/invoices"));
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
    expect(screen.getByTestId("invoices-aging-filter")).toHaveTextContent("60+ days overdue");
  });
});

// ── 4. flag badges ───────────────────────────────────────────────────────────

describe("flag badges", () => {
  it("renders nothing but an em dash for a clean invoice", async () => {
    rowsForResponse = [cleanInvoice()];
    renderInvoices();
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
    renderInvoices();

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
    renderInvoices();

    await waitFor(() => expect(screen.getByTestId("ar-flag-never_sent-1")).toBeTruthy());
    expect(screen.getByTestId("ar-flag-not_in_qb-1")).toBeTruthy();
    expect(screen.getByTestId("ar-flag-stale_sync-1")).toBeTruthy();
  });

  it("never flags a draft as never sent", async () => {
    const { arFlags, ...draft } = cleanInvoice({ status: "draft", sentAt: null }) as Row;
    rowsForResponse = [draft];
    renderInvoices();

    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());
    expect(screen.queryByTestId("ar-flag-never_sent-1")).toBeNull();
  });
});

// ── 5. balance fallback ──────────────────────────────────────────────────────

describe("balance due", () => {
  it("shows the synced balance when a sync has run", async () => {
    rowsForResponse = [cleanInvoice({ balanceDue: "120.00", balanceIsFallback: false })];
    renderInvoices();
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
    renderInvoices();

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
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-bucket-1")).toHaveTextContent("Current"));
    expect(screen.getByTestId("ar-days-overdue-1")).toHaveTextContent("—");
  });

  it("keeps the reminder columns visible but inert", async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-last-reminder-1")).toBeTruthy());
    // Present so the layout does not shift when reminders land, and plainly
    // empty so nobody thinks a reminder was sent.
    expect(screen.getByTestId("ar-last-reminder-1")).toHaveTextContent("—");
    expect(screen.getByTestId("ar-reminder-action-1")).toBeDisabled();
    expect(screen.getByTestId("ar-filter-reminders")).toBeDisabled();
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

  it("offers her no merge checkbox on the row", async () => {
    roleRef.current = "bookkeeper";
    rowsForResponse = [overdueInvoice()];
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());
    expect(screen.queryByTestId("checkbox-merge-invoice-1")).toBeNull();
  });

  it("still offers a billing manager the authoring controls", async () => {
    roleRef.current = "billing_manager";
    rowsForResponse = [cleanInvoice()];
    renderInvoices();
    await waitFor(() => expect(screen.getByTestId("ar-balance-1")).toBeTruthy());

    await openActionsMenu(1);
    expect(screen.getByTestId("button-void-invoice-1")).toBeTruthy();
  });
});
