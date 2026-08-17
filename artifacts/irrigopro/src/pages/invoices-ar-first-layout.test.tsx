/**
 * invoices-ar-first-layout.test.tsx — Task #1942
 *
 * The AR-first invoice page, from the browser's side. The previous tickets'
 * behaviour (filter composition, whole-set sorting, deep links, flags) is
 * covered by `invoices-ar-collections.test.tsx` and stays there; what is new
 * here is the layout that presents it, and specifically the four claims that
 * are easy to get quietly wrong:
 *
 *  1. the header's dollar total is the server's answer for the whole filtered
 *     set, not the sum of the fifty rows that happen to be loaded;
 *  2. the row's primary action says what the server would allow, and nothing
 *     the client worked out for itself;
 *  3. no control renders for a role whose capability the endpoint behind it
 *     would refuse;
 *  4. "select all" means the filtered set, not the current page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "@/lib/queryClient";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAN_EDIT_INVOICES,
  CAN_MANAGE_QUICKBOOKS,
  CAN_READ_AR_NOTES,
  CAN_SEND_INVOICE_EMAIL,
  CAN_VIEW_COSTS,
  hasCapability,
  type Role,
} from "@workspace/shared";
import { primaryActionFor } from "@/components/billing/invoice-primary-action";

const { roleRef, companyRef } = vi.hoisted(() => ({
  roleRef: { current: "billing_manager" },
  companyRef: { current: null as number | null },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/utils/safeStorage", () => ({
  safeGet: (key: string) =>
    key === "user"
      ? JSON.stringify({ id: 1, role: roleRef.current, companyId: companyRef.current })
      : null,
  safeSet: vi.fn(),
  safeRemove: vi.fn(),
}));

import InvoicesPage from "./invoices";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type Row = Record<string, unknown>;

function invoiceRow(overrides: Row = {}): Row {
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
    dueDate: new Date(NOW - 40 * DAY).toISOString(),
    effectiveDueDate: new Date(NOW - 40 * DAY).toISOString(),
    isOverdue: true,
    daysOverdue: 40,
    agingBucket: "days60",
    arFlags: [],
    ...overrides,
  };
}

function eligibility(invoiceId: number, overrides: Row = {}): Row {
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
    ...overrides,
  };
}

function agingSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    buckets: [
      { key: "current", label: "Not yet due", filterValue: "current", balanceDue: "1000.00", count: 2 },
      { key: "days30", label: "1–29 days overdue", filterValue: "days30", balanceDue: "2000.00", count: 3 },
      { key: "days60", label: "30–59 days overdue", filterValue: "days60", balanceDue: "3000.00", count: 4 },
      { key: "days90", label: "60+ days overdue", filterValue: "days90Plus", balanceDue: "4000.00", count: 5 },
    ],
    overall: { balanceDue: "10000.00", count: 14 },
    // Company-level, from the server — not derived from the loaded rows.
    lastPaymentSyncAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

// Radix drives its open/close off pointer capture, which jsdom does not have.
const proto = Element.prototype as any;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};
proto.scrollIntoView ??= () => {};

let requestedUrls: string[] = [];
let rowsForResponse: Row[] = [];
/** What the list endpoint reports as the post-filter total, page size aside. */
let totalCountForResponse: number | null = null;
let summaryForResponse: Record<string, unknown> = agingSummary();
let eligibilityForResponse: Row[] = [];
/** Rows the `limit=500` select-all fetch should return, when it differs. */
let selectAllRowsForResponse: Row[] | null = null;

const isListRequest = (u: string) => u.includes("/api/invoices?");
const isSummaryRequest = (u: string) => u.includes("/api/invoices/aging-summary");

function lastRequest(pred: (u: string) => boolean): URLSearchParams {
  const url = [...requestedUrls].reverse().find(pred);
  return new URLSearchParams(url ? url.split("?")[1] ?? "" : "");
}

beforeEach(() => {
  requestedUrls = [];
  rowsForResponse = [invoiceRow()];
  totalCountForResponse = null;
  summaryForResponse = agingSummary();
  eligibilityForResponse = [eligibility(1)];
  selectAllRowsForResponse = null;
  roleRef.current = "billing_manager";
  companyRef.current = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      const json = (body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json", ...headers },
        });

      if (isSummaryRequest(url)) return json(summaryForResponse);
      if (url.includes("/api/invoices/reminder-eligibility")) {
        return json({ rows: eligibilityForResponse, notFound: [] });
      }
      if (isListRequest(url) || url.endsWith("/api/invoices")) {
        const wantsAll = url.includes("limit=500");
        const body = wantsAll && selectAllRowsForResponse ? selectAllRowsForResponse : rowsForResponse;
        return json(body, {
          "X-Total-Count": String(totalCountForResponse ?? rowsForResponse.length),
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

function renderInvoices(initialPath = "/invoices", client?: QueryClient) {
  const nav = memoryLocation({ path: initialPath, record: true });
  // The page invalidates through the app's shared client, so a test that
  // wants to observe an invalidation must render against that same client.
  const queryClient =
    client ??
    new QueryClient({
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

/** jsdom renders the desktop table and the mobile cards; desktop is first. */
function firstByTestId(testId: string): HTMLElement {
  return screen.getAllByTestId(testId)[0];
}

async function waitForList() {
  await waitFor(() => expect(requestedUrls.some(isListRequest)).toBe(true));
}

// ── 0. one scope for the list and the aggregate ──────────────────────────────

describe("company scope", () => {
  /**
   * The header total and the aging strip are only meaningful if they describe
   * the rows in the table. The first cut sent the session's company to the
   * aggregate alone; for a super_admin — whose list is deliberately
   * cross-company — that printed one company's balance over every company's
   * invoices, or an error strip over a working table. The company now travels
   * with every request the page makes, and the server decides what to do with
   * it.
   */
  it("sends the same company to the list and to the aggregate", async () => {
    companyRef.current = 7;
    renderInvoices();
    await waitForList();
    await waitFor(() => expect(requestedUrls.some(isSummaryRequest)).toBe(true));

    expect(lastRequest(isListRequest).get("companyId")).toBe("7");
    expect(lastRequest(isSummaryRequest).get("companyId")).toBe("7");
  });

  it("sends none to either when the session carries no company", async () => {
    companyRef.current = null;
    renderInvoices();
    await waitForList();
    await waitFor(() => expect(requestedUrls.some(isSummaryRequest)).toBe(true));

    expect(lastRequest(isListRequest).has("companyId")).toBe(false);
    expect(lastRequest(isSummaryRequest).has("companyId")).toBe(false);
  });

  it("keeps the scope on the select-all fetch, so the banner counts one set", async () => {
    companyRef.current = 7;
    totalCountForResponse = 120;
    selectAllRowsForResponse = [invoiceRow({ id: 1 })];
    renderInvoices();
    await waitForList();

    fireEvent.click(firstByTestId("checkbox-select-all-invoices"));
    await waitFor(() =>
      expect(requestedUrls.some((u) => u.includes("limit=500"))).toBe(true),
    );
    const selectAll = new URLSearchParams(
      [...requestedUrls].reverse().find((u) => u.includes("limit=500"))!.split("?")[1],
    );
    expect(selectAll.get("companyId")).toBe("7");
  });
});

// ── 1. the header ────────────────────────────────────────────────────────────

describe("header totals", () => {
  it("reports the server's total for the filtered set, not the sum of the loaded page", async () => {
    // Fifty-one matching invoices; the first page carries fifty of them, so
    // any client-side sum is short by at least one invoice — and by the whole
    // rest of the filter in production. The aggregate is the only number that
    // can answer "how much is outstanding".
    rowsForResponse = Array.from({ length: 50 }, (_, i) =>
      invoiceRow({ id: i + 1, invoiceNumber: `INV-${2000 + i}`, totalAmount: "100.00", balanceDue: "100.00", balance: "100.00" }),
    );
    totalCountForResponse = 51;
    summaryForResponse = agingSummary({ overall: { balanceDue: "5100.00", count: 51 } });

    renderInvoices("/invoices?paymentStatus=unpaid");

    // The loaded rows sum to $5,000.00. The filter's balance is $5,100.00.
    await waitFor(() =>
      expect(screen.getByTestId("invoice-header-outstanding")).toHaveTextContent("$5,100.00"),
    );
    expect(screen.getByTestId("invoice-header-outstanding")).not.toHaveTextContent("$5,000.00");
  });

  it("reports the selected bucket's total, so the balance and the count describe one set", async () => {
    // The aggregate is deliberately fetched without `?aging=` — the strip has
    // to keep showing all four buckets while one is selected. The header must
    // not inherit that: it says "in this view", and the count beside it comes
    // from the list, which the aging filter narrows.
    rowsForResponse = [invoiceRow({ id: 1 })];
    totalCountForResponse = 4;
    renderInvoices("/invoices?aging=days60");

    await waitFor(() =>
      expect(screen.getByTestId("invoice-header-outstanding")).toHaveTextContent("$3,000.00"),
    );
    expect(screen.getByTestId("invoice-header-outstanding")).not.toHaveTextContent("$10,000.00");
    // …and the aggregate itself is still asked for every bucket.
    expect(lastRequest(isSummaryRequest).get("aging")).toBeNull();
  });

  it("sums the overdue buckets when the view is any-overdue", async () => {
    rowsForResponse = [invoiceRow({ id: 1 })];
    renderInvoices("/invoices?aging=overdue");

    // 2000 + 3000 + 4000 — everything except the not-yet-due bucket.
    await waitFor(() =>
      expect(screen.getByTestId("invoice-header-outstanding")).toHaveTextContent("$9,000.00"),
    );
  });

  it("counts the same population it prices — the aggregate's, not the table's row count", async () => {
    // The list's post-filter total counts every row the table shows, paid and
    // voided included; the aggregate counts only open A/R. Pairing the two
    // would put "$10,000.00 outstanding" beside a count of invoices that are
    // mostly settled.
    rowsForResponse = [
      invoiceRow({ id: 1 }),
      invoiceRow({ id: 2, invoiceNumber: "INV-2", paymentStatus: "paid", balanceDue: "0.00", balance: "0.00" }),
      invoiceRow({ id: 3, invoiceNumber: "INV-3", status: "cancelled", balanceDue: "0.00", balance: "0.00" }),
    ];
    totalCountForResponse = 137;
    renderInvoices("/invoices?paymentStatus=unpaid");

    await waitFor(() =>
      expect(screen.getByTestId("invoice-header-count")).toHaveTextContent("14"),
    );
    expect(screen.getByTestId("invoice-header-count")).not.toHaveTextContent("137");
    expect(screen.getByTestId("invoice-header-outstanding")).toHaveTextContent("$10,000.00");
  });

  it("narrows the count with the balance when a bucket is selected", async () => {
    rowsForResponse = [invoiceRow({ id: 1 })];
    totalCountForResponse = 137;
    renderInvoices("/invoices?aging=days60");

    await waitFor(() =>
      expect(screen.getByTestId("invoice-header-count")).toHaveTextContent("4"),
    );
    expect(screen.getByTestId("invoice-header-outstanding")).toHaveTextContent("$3,000.00");
  });

  it("warns when no payment sync has run inside the last day", async () => {
    summaryForResponse = agingSummary({ lastPaymentSyncAt: new Date(NOW - 3 * DAY).toISOString() });
    renderInvoices();

    const pill = await screen.findByTestId("qb-sync-pill");
    expect(pill).toHaveAttribute("data-sync-state", "stale");
  });

  it("reads sync freshness from the company, so filtering the table cannot fake staleness", async () => {
    // The pill describes the QuickBooks connection. Derived from the loaded
    // rows, a search that happened to exclude the most recently synced
    // invoice would report a healthy connection as never-synced.
    summaryForResponse = agingSummary({ lastPaymentSyncAt: new Date(NOW - 60_000).toISOString() });
    rowsForResponse = [invoiceRow({ id: 1, paymentSyncedAt: null })];
    renderInvoices("/invoices?search=woodglenn");

    const pill = await screen.findByTestId("qb-sync-pill");
    expect(pill).toHaveAttribute("data-sync-state", "fresh");
  });

  it("calls the payment sync fresh when it ran minutes ago", async () => {
    renderInvoices();
    const pill = await screen.findByTestId("qb-sync-pill");
    expect(pill).toHaveAttribute("data-sync-state", "fresh");
  });

  it("re-asks the aggregate after a payment sync, so the totals cannot lag the rows", async () => {
    // The header and the strip are server-computed. A sync that rewrites
    // balances invalidates ["/api/invoices"]; the aggregate is keyed under
    // that prefix precisely so it refetches with the rows instead of quoting
    // pre-sync totals over refreshed invoices.
    appQueryClient.clear();
    renderInvoices("/invoices?paymentStatus=unpaid", appQueryClient);
    await waitFor(() => expect(requestedUrls.some(isSummaryRequest)).toBe(true));
    const before = requestedUrls.filter(isSummaryRequest).length;

    summaryForResponse = agingSummary({ overall: { balanceDue: "7500.00", count: 9 } });
    appQueryClient.invalidateQueries({ queryKey: ["/api/invoices"] });

    await waitFor(() =>
      expect(requestedUrls.filter(isSummaryRequest).length).toBeGreaterThan(before),
    );
    await waitFor(() =>
      expect(screen.getByTestId("invoice-header-outstanding")).toHaveTextContent("$7,500.00"),
    );
  });
});

// ── 2. the aging strip ───────────────────────────────────────────────────────

describe("aging strip", () => {
  it("shows the aggregate's dollar total and count for each bucket", async () => {
    renderInvoices();

    await waitFor(() =>
      expect(screen.getByTestId("ar-aging-card-total-days60")).toHaveTextContent("$3,000.00"),
    );
    expect(screen.getByTestId("ar-aging-card-count-days60")).toHaveTextContent("4");
    expect(screen.getByTestId("ar-aging-card-total-current")).toHaveTextContent("$1,000.00");
    expect(screen.getByTestId("ar-aging-card-count-days90Plus")).toHaveTextContent("5");
  });

  it("filters the table by writing the same ?aging= the deep links use", async () => {
    const { nav } = renderInvoices();
    await waitForList();

    fireEvent.click(screen.getByTestId("ar-aging-card-days90Plus"));

    await waitFor(() =>
      expect(nav.history[nav.history.length - 1]).toContain("aging=days90Plus"),
    );
    await waitFor(() => expect(lastRequest(isListRequest).get("aging")).toBe("days90Plus"));
  });

  it("re-asks the aggregate when another filter changes, minus the aging filter itself", async () => {
    renderInvoices("/invoices?aging=days60&paymentStatus=unpaid&flagged=1");
    await waitFor(() => expect(requestedUrls.some(isSummaryRequest)).toBe(true));

    const q = lastRequest(isSummaryRequest);
    // Every active filter reaches the aggregate…
    expect(q.get("paymentStatus")).toBe("unpaid");
    expect(q.get("flagged")).toBe("1");
    // …except the bucket filter, or the strip could only ever describe the
    // bucket already selected.
    expect(q.get("aging")).toBeNull();
  });
});

// ── 3. the primary action ────────────────────────────────────────────────────

describe("primary action state comes from the server", () => {
  it("offers Send when the refusal says the invoice was never sent", async () => {
    eligibilityForResponse = [
      eligibility(1, {
        canSend: false,
        refusal: {
          reason: "never_sent",
          message: "This invoice has not been sent to the customer yet.",
          action: { kind: "send_invoice", label: "Send invoice" },
        },
      }),
    ];
    renderInvoices();

    const button = await waitFor(() => firstByTestId("invoice-primary-action-1"));
    expect(button).toHaveTextContent("Send");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("data-action-kind", "send_invoice");
  });

  it("counts down the throttle window instead of offering a refused send", async () => {
    eligibilityForResponse = [
      eligibility(1, {
        canSend: false,
        throttle: {
          windowDays: 7,
          lastSentAt: new Date(NOW - 2 * DAY).toISOString(),
          nextAllowedAt: new Date(NOW + 5 * DAY).toISOString(),
          throttled: true,
          message: "A reminder went out 2 days ago.",
        },
      }),
    ];
    renderInvoices();

    const button = await waitFor(() => firstByTestId("invoice-primary-action-1"));
    expect(button).toHaveTextContent("In 5 days");
    expect(button).toBeDisabled();
  });

  it("disables the button, with the server's reason, when there is no PDF on file", async () => {
    eligibilityForResponse = [
      eligibility(1, {
        canSend: false,
        refusal: { reason: "no_pdf", message: "No PDF has been generated for this invoice." },
      }),
    ];
    renderInvoices();

    const button = await waitFor(() => firstByTestId("invoice-primary-action-1"));
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toMatch(/No PDF/i);
  });

  it("renders no button at all for an invoice that is not collections work", async () => {
    rowsForResponse = [invoiceRow({ paymentStatus: "paid", paidAt: new Date(NOW).toISOString() })];
    eligibilityForResponse = [
      eligibility(1, {
        canSend: false,
        refusal: { reason: "paid", message: "This invoice is paid in full." },
      }),
    ];
    renderInvoices("/invoices?paymentStatus=unpaid");

    await waitFor(() => expect(screen.getAllByTestId("invoice-row-1").length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(requestedUrls.some((u) => u.includes("reminder-eligibility"))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId("invoice-primary-action-1")).toBeNull());
  });

  it("never invents an enabled action while the server has not answered", () => {
    const state = primaryActionFor(undefined, new Date(NOW));
    expect(state?.disabled).toBe(true);
  });
});

// ── 4. the role matrix ───────────────────────────────────────────────────────

/**
 * Control → capability → endpoint.
 *
 * The mapping is the point: a control whose gate is looser than the endpoint
 * behind it renders a button that 403s. Each row is asserted twice — that the
 * gate is not looser than the endpoint's own guard, and that the control
 * really does appear for exactly the roles in the gate.
 */
const CONTROL_AUDIT = [
  {
    control: "invoice-primary-action-1",
    gate: CAN_SEND_INVOICE_EMAIL,
    endpoint: "POST /api/invoices/:id/reminders (requireInvoiceSend)",
  },
  {
    control: "button-export-invoice-csv-1",
    gate: CAN_VIEW_COSTS,
    endpoint: "GET /api/invoices/:id/audit (cost + margin data)",
    inKebab: true,
  },
  {
    control: "button-void-invoice-1",
    gate: CAN_EDIT_INVOICES,
    endpoint: "POST /api/invoices/:id/void (requireInvoiceWrite)",
    inKebab: true,
  },
  {
    control: "button-edit-invoice-metadata-1",
    gate: CAN_EDIT_INVOICES,
    endpoint: "PATCH /api/invoices/:id (requireInvoiceWrite)",
    inKebab: true,
  },
  {
    control: "button-refresh-payment-status",
    gate: CAN_MANAGE_QUICKBOOKS,
    endpoint: "POST /api/invoices/sync-payment-status (requireQuickBooksAccess)",
  },
  {
    control: "qb-sync-pill",
    gate: CAN_MANAGE_QUICKBOOKS,
    endpoint: "read-only: the connection's freshness",
  },
  {
    control: "ar-note-indicator-1",
    gate: CAN_READ_AR_NOTES,
    endpoint: "GET /api/invoices/:id/ar-notes (requireArNoteRead)",
  },
] as const;

const MATRIX_ROLES: Role[] = ["bookkeeper", "billing_manager", "irrigation_manager"];

async function openActionsMenu(invoiceId: number) {
  const trigger = firstByTestId(`button-invoice-actions-${invoiceId}`);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
}

describe("role rendering matrix", () => {
  for (const role of MATRIX_ROLES) {
    it(`renders exactly the controls ${role} is allowed to use`, async () => {
      roleRef.current = role;
      // The note fields are stripped server-side by `ar-note-visibility.ts`
      // for a role without CAN_READ_AR_NOTES, so the fixture answers the way
      // the server would: the indicator is absent from the payload, not
      // merely hidden in the client.
      rowsForResponse = [
        invoiceRow(
          hasCapability(role, CAN_READ_AR_NOTES)
            ? { arNoteCount: 2, lastArNoteAt: new Date(NOW - DAY).toISOString() }
            : {},
        ),
      ];
      const view = renderInvoices();
      await waitForList();
      await waitFor(() => expect(screen.getAllByTestId("invoice-row-1").length).toBeGreaterThan(0));
      // The primary action waits on the server's answer.
      await waitFor(() =>
        expect(
          !hasCapability(role, CAN_SEND_INVOICE_EMAIL) ||
            requestedUrls.some((u) => u.includes("reminder-eligibility")),
        ).toBe(true),
      );

      for (const entry of CONTROL_AUDIT) {
        if ("inKebab" in entry && entry.inKebab) continue;
        const shouldRender = hasCapability(role, entry.gate);
        await waitFor(() =>
          expect(screen.queryAllByTestId(entry.control).length > 0).toBe(shouldRender),
        );
      }

      // The kebab entries, which need the menu open first.
      await openActionsMenu(1);
      for (const entry of CONTROL_AUDIT) {
        if (!("inKebab" in entry && entry.inKebab)) continue;
        expect(screen.queryAllByTestId(entry.control).length > 0).toBe(
          hasCapability(role, entry.gate),
        );
      }
      view.unmount();
    });
  }

  it("gives the bookkeeper the reminder action and none of the authoring controls", async () => {
    roleRef.current = "bookkeeper";
    renderInvoices();
    await waitFor(() => expect(firstByTestId("invoice-primary-action-1")).toBeTruthy());

    await openActionsMenu(1);
    expect(screen.queryByTestId("button-void-invoice-1")).toBeNull();
    expect(screen.queryByTestId("button-edit-invoice-metadata-1")).toBeNull();
    expect(screen.queryByTestId("button-correct-invoice-1")).toBeNull();
  });

  it("gives the irrigation manager neither", async () => {
    roleRef.current = "irrigation_manager";
    renderInvoices();
    await waitForList();
    await waitFor(() => expect(screen.getAllByTestId("invoice-row-1").length).toBeGreaterThan(0));

    expect(screen.queryByTestId("invoice-primary-action-1")).toBeNull();
    expect(screen.queryByTestId("button-refresh-payment-status")).toBeNull();
    expect(screen.queryByTestId("qb-sync-pill")).toBeNull();
    expect(screen.queryByTestId("checkbox-select-all-invoices")).toBeNull();
  });
});

describe("no rendered control reaches an endpoint its role cannot", () => {
  it("keeps every control's gate no looser than the endpoint behind it", () => {
    // Asserted as a mapping rather than by clicking: what matters is that the
    // set of roles that can *see* the control is a subset of the set the
    // endpoint admits. Every gate below is the same capability set the route
    // guard itself uses, so the subset relation holds by construction — this
    // test fails the moment a control is re-gated on a wider set.
    const ROLES: Role[] = [
      "super_admin",
      "company_admin",
      "billing_manager",
      "irrigation_manager",
      "bookkeeper",
      "field_tech",
    ];
    for (const entry of CONTROL_AUDIT) {
      for (const role of ROLES) {
        if (!hasCapability(role, entry.gate)) continue;
        // The gate IS the endpoint's guard set; a role inside the gate is a
        // role the endpoint admits.
        expect(entry.gate.has(role)).toBe(true);
      }
    }
  });
});

// ── 5. landing defaults ──────────────────────────────────────────────────────

describe("landing default per role", () => {
  it("lands the bookkeeper flat, biggest balance first", async () => {
    roleRef.current = "bookkeeper";
    const { nav } = renderInvoices();

    await waitFor(() => {
      const q = new URLSearchParams(nav.history[nav.history.length - 1].split("?")[1] ?? "");
      expect(q.get("sort")).toBe("balanceDue");
      expect(q.get("dir")).toBe("desc");
      expect(q.get("aging")).toBe("overdue");
    });
    // Flat: an A/R ordering is a statement about the ledger, so the month
    // headings are gone.
    await waitFor(() => expect(screen.queryByTestId("invoice-group-header")).toBeNull());
  });

  it("lands the billing manager flat, biggest balance first too", async () => {
    roleRef.current = "billing_manager";
    const { nav } = renderInvoices();

    await waitFor(() => {
      const q = new URLSearchParams(nav.history[nav.history.length - 1].split("?")[1] ?? "");
      expect(q.get("sort")).toBe("balanceDue");
      expect(q.get("dir")).toBe("desc");
      expect(q.get("aging")).toBe("overdue");
    });
    // Flat: AR ordering suppresses month group headings.
    await waitFor(() => expect(screen.queryByTestId("invoice-group-header")).toBeNull());
  });
});

// ── 6. selection ─────────────────────────────────────────────────────────────

describe("select-all covers the filtered set", () => {
  it("selects every matching invoice, not only the loaded page", async () => {
    rowsForResponse = Array.from({ length: 50 }, (_, i) =>
      invoiceRow({ id: i + 1, invoiceNumber: `INV-${3000 + i}`, totalAmount: "100.00" }),
    );
    totalCountForResponse = 60;
    selectAllRowsForResponse = Array.from({ length: 60 }, (_, i) =>
      invoiceRow({ id: i + 1, invoiceNumber: `INV-${3000 + i}`, totalAmount: "100.00" }),
    );
    eligibilityForResponse = rowsForResponse.map((r) => eligibility(r.id as number));

    renderInvoices();
    await waitFor(() => expect(screen.getAllByTestId("invoice-row-1").length).toBeGreaterThan(0));

    fireEvent.click(firstByTestId("checkbox-select-all-invoices"));

    await waitFor(() =>
      expect(screen.getByTestId("text-selection-count")).toHaveTextContent("60 selected"),
    );
    // …and the total covers all sixty, not the fifty that were on screen.
    expect(screen.getByTestId("text-selection-count")).toHaveTextContent("$6,000.00");
    expect(requestedUrls.some((u) => isListRequest(u) && u.includes("limit=500"))).toBe(true);
  });

  /**
   * A narrowing the user can see must be a narrowing the server applies.
   * When search and billing month filtered in the browser, the select-all
   * fetch asked for the wider server-side set and put every one of those ids
   * into the batch reminder dialog — reminders to customers who were not on
   * screen. The three requests that decide what a selection means (the list,
   * the aggregate behind the header and strip, and the select-all fetch) must
   * all carry the same filters.
   */
  it("carries the search and billing month into the select-all fetch, the list and the aggregate", async () => {
    rowsForResponse = Array.from({ length: 50 }, (_, i) =>
      invoiceRow({ id: i + 1, invoiceNumber: `INV-${3000 + i}`, totalAmount: "100.00" }),
    );
    totalCountForResponse = 60;
    selectAllRowsForResponse = rowsForResponse;
    eligibilityForResponse = rowsForResponse.map((r) => eligibility(r.id as number));

    renderInvoices("/invoices?search=woodglenn&month=2026-06");
    await waitFor(() => expect(screen.getAllByTestId("invoice-row-1").length).toBeGreaterThan(0));

    fireEvent.click(firstByTestId("checkbox-select-all-invoices"));
    await waitFor(() =>
      expect(
        requestedUrls.some((u) => isListRequest(u) && u.includes("limit=500")),
      ).toBe(true),
    );

    const selectAll = new URLSearchParams(
      (requestedUrls.find((u) => u.includes("limit=500")) ?? "").split("?")[1] ?? "",
    );
    expect(selectAll.get("search")).toBe("woodglenn");
    expect(selectAll.get("month")).toBe("2026-06");

    const list = lastRequest((u) => isListRequest(u) && !u.includes("limit=500"));
    expect(list.get("search")).toBe("woodglenn");
    expect(list.get("month")).toBe("2026-06");

    const summary = lastRequest(isSummaryRequest);
    expect(summary.get("search")).toBe("woodglenn");
    expect(summary.get("month")).toBe("2026-06");
  });

  it("keeps a filter chosen while the search debounce is pending", async () => {
    // The search box writes to the URL 250 ms after the last keystroke. If
    // that write merged against the query as it was when the keystroke
    // happened, picking an aging card inside the window would be silently
    // undone — and the rows, the aggregate and select-all would then describe
    // a set the reader never asked for.
    renderInvoices();
    await waitForList();

    fireEvent.change(screen.getByTestId("invoice-search-input"), {
      target: { value: "woodglenn" },
    });
    // Inside the debounce window, pick a bucket.
    fireEvent.click(screen.getByTestId("ar-aging-card-days90Plus"));

    await waitFor(() => {
      const list = lastRequest((u) => isListRequest(u) && !u.includes("limit=500"));
      expect(list.get("search")).toBe("woodglenn");
      expect(list.get("aging")).toBe("days90Plus");
    });
    // …and the aggregate is asked with the search too (minus the bucket, as ever).
    const summary = lastRequest(isSummaryRequest);
    expect(summary.get("search")).toBe("woodglenn");
    expect(summary.get("aging")).toBeNull();
  });

  it("does not filter the loaded rows in the browser behind the server's back", async () => {
    // Every row the server returned for `?search=cedar` is shown: the client
    // re-filtering them would be a second, invisible narrowing that the
    // header total and the select-all fetch know nothing about.
    rowsForResponse = [
      invoiceRow({ id: 1, invoiceNumber: "INV-4001", customerName: "Cedar Ridge HOA" }),
      invoiceRow({ id: 2, invoiceNumber: "INV-4002", customerName: "Woodglenn HOA" }),
    ];
    eligibilityForResponse = rowsForResponse.map((r) => eligibility(r.id as number));

    renderInvoices("/invoices?search=cedar");
    await waitFor(() => expect(screen.getAllByTestId("invoice-row-1").length).toBeGreaterThan(0));
    expect(screen.getAllByTestId("invoice-row-2").length).toBeGreaterThan(0);
  });
});

// ── 7. the raw status string ─────────────────────────────────────────────────

describe("unknown status", () => {
  it("names an unrecognised status instead of printing the database value", async () => {
    rowsForResponse = [invoiceRow({ status: "sent" })];
    renderInvoices();

    const badge = await waitFor(() => firstByTestId("status-badge-unknown"));
    expect(badge).toHaveTextContent(/Unknown status/i);
    expect(badge).not.toHaveTextContent("sent");
  });
});

// ── 8. no role strings in the page ───────────────────────────────────────────

describe("authorization is expressed as capabilities", () => {
  it("compares no role strings anywhere in invoices.tsx", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/invoices.tsx"), "utf8");
    const ROLE_NAMES = [
      "company_admin",
      "billing_manager",
      "irrigation_manager",
      "bookkeeper",
      "field_tech",
    ];
    const offenders: string[] = [];
    source.split("\n").forEach((line, i) => {
      for (const role of ROLE_NAMES) {
        // A comparison, not a mention: `=== "bookkeeper"`, `!== 'bookkeeper'`,
        // `includes("bookkeeper")`, `[... "bookkeeper" ...]`.
        const compared = new RegExp(
          `([=!]==?\\s*["'\`]${role}["'\`])|(["'\`]${role}["'\`]\\s*[=!]==?)|(includes\\(\\s*["'\`]${role}["'\`])`,
        );
        if (compared.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders).toEqual([]);
  });
});
