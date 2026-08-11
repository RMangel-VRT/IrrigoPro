/**
 * invoices-row-expansion.test.tsx — Task #1918
 *
 * Expanding an invoice row in place. The server side of the three reads —
 * the enriched line items, company isolation, and both capability gates — is
 * covered against storage spies in
 * `artifacts/api-server/src/routes/invoice-row-expansion-reads.test.ts`. What
 * can only be checked here is the behaviour of the list around the expansion:
 *
 *  1. clicking a row opens line items, reminder history and A/R notes inline,
 *     and collapsing puts everything back exactly as it was — same filters,
 *     same sort, same month grouping, same selection, same loaded pages;
 *  2. only one row is open at a time, and the version-history expansion keeps
 *     working beside it without the two toggling each other;
 *  3. none of the three reads happens until a row opens — not on mount of a
 *     multi-row list, and not after "Load more" adds another page;
 *  4. reminder history renders as recorded — the address it went to and the
 *     balance at the time — after both have since changed on the invoice;
 *  5. a role without A/R-note access gets no notes section and issues no note
 *     request; a role without the send capability gets no reminder section
 *     rather than an error or a spinner that never resolves;
 *  6. both empty states say so in a plain line;
 *  7. the row is reachable and operable from the keyboard, and the expanded
 *     region is associated with it for a screen reader.
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

// Static imports AFTER the vi.mock() calls are hoisted.
import InvoicesPage from "./invoices";
// The reminder and note panels rely on the app-wide default query function to
// turn their query key into a URL. Using the real one means these tests prove
// the keys actually resolve to /api/invoices/:id/reminders and /ar-notes.
import { getQueryFn } from "@/lib/queryClient";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type Row = Record<string, unknown>;

function invoiceRow(overrides: Row = {}): Row {
  return {
    id: 1,
    invoiceNumber: "INV-1001",
    customerId: 10,
    customerName: "Acme Grounds",
    customerEmail: "new-ap@acme.example",
    status: "generated",
    totalAmount: "500.00",
    balance: "120.00",
    balanceDue: "120.00",
    balanceIsFallback: false,
    paymentStatus: "partially_paid",
    paymentSyncedAt: new Date(NOW - 60_000).toISOString(),
    paidAt: null,
    sentAt: new Date(NOW - 40 * DAY).toISOString(),
    quickbooksInvoiceId: "QB-77",
    qbVoidDetectedAt: null,
    qbNote: null,
    invoiceYear: 2026,
    invoiceMonth: 8,
    createdAt: new Date(NOW - 45 * DAY).toISOString(),
    dueDate: new Date(NOW - 40 * DAY).toISOString(),
    effectiveDueDate: new Date(NOW - 40 * DAY).toISOString(),
    isOverdue: true,
    daysOverdue: 40,
    agingBucket: "30_59",
    arFlags: [],
    lastReminderAt: new Date(NOW - 3 * DAY).toISOString(),
    reminderCount: 1,
    arNoteCount: 1,
    ...overrides,
  };
}

const LINE_ITEMS = [
  {
    id: 11,
    sourceType: "billing_sheet",
    billingSheetId: 10,
    workOrderId: null,
    wetCheckBillingId: null,
    sourceNumber: "BS-010",
    sourceTypeLabel: "BS",
    description: "Zone 3 head replacement",
    totalPrice: "150.00",
    workDate: "2026-06-02T00:00:00.000Z",
  },
  {
    id: 12,
    sourceType: "work_order",
    billingSheetId: null,
    workOrderId: 20,
    wetCheckBillingId: null,
    sourceNumber: "WO-2026-020",
    sourceTypeLabel: "WO",
    description: "Controller diagnostics",
    totalPrice: "90.00",
    workDate: "2026-06-03T00:00:00.000Z",
  },
];

const REMINDER_ROWS = [
  {
    id: 5,
    sentAt: "2026-08-08T15:04:00.000Z",
    sentByUserId: 7,
    sentByName: "Dana Reyes",
    // Deliberately NOT the customerEmail on the invoice row above.
    recipientEmail: "old-ap@acme.example",
    sequenceNumber: 1,
    templateKey: "gentle",
    templateLabel: "Gentle nudge",
    // Deliberately NOT the invoice's current balance.
    balanceAtSend: "500.00",
    daysOverdueAtSend: 37,
    deliveryStatus: "sent",
    deliveryError: null,
  },
];

const NOTE_ROWS = [
  {
    id: 3,
    invoiceId: 1,
    note: "AP says it's in the next cheque run.",
    authorUserId: 7,
    authorName: "Dana Reyes",
    createdAt: "2026-08-10T15:04:00.000Z",
  },
];

// Radix drives open/close off pointer capture, which jsdom does not implement.
const proto = Element.prototype as any;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};
proto.scrollIntoView ??= () => {};

let requestedUrls: string[] = [];
let rowsForResponse: Row[] = [];
let totalCount: number | null = null;
let itemsResponse: unknown[] = [];
let reminderRows: unknown[] = [];
let noteRows: unknown[] = [];

beforeEach(() => {
  requestedUrls = [];
  rowsForResponse = [invoiceRow()];
  totalCount = null;
  itemsResponse = LINE_ITEMS;
  reminderRows = REMINDER_ROWS;
  noteRows = NOTE_ROWS;
  roleRef.current = "billing_manager";

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

      if (/\/api\/invoices\/\d+\/items/.test(url)) return json({ items: itemsResponse });
      if (/\/api\/invoices\/\d+\/ar-notes/.test(url)) {
        return json({ notes: noteRows, internalOnly: true });
      }
      if (/\/api\/invoices\/\d+\/reminders/.test(url)) {
        return json({
          reminders: reminderRows,
          canSend: true,
          refusal: null,
          throttle: {
            windowDays: 7,
            lastSentAt: null,
            nextAllowedAt: null,
            throttled: false,
            message: null,
          },
          suggestedTemplateKey: "firm",
          templates: [
            { key: "gentle", label: "Gentle nudge" },
            { key: "firm", label: "Firm reminder" },
          ],
          balanceDue: "120.00",
          daysOverdue: 40,
          recipientEmail: "new-ap@acme.example",
        });
      }
      if (url.includes("/api/invoices?")) {
        const offset = Number(new URLSearchParams(url.split("?")[1]).get("offset") ?? 0);
        const pageSize = 50;
        const page = rowsForResponse.slice(offset, offset + pageSize);
        return json(page, {
          "X-Total-Count": String(totalCount ?? rowsForResponse.length),
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
    defaultOptions: {
      queries: { retry: false, gcTime: 0, queryFn: getQueryFn({ on401: "returnNull" }) },
    },
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

const isListRequest = (u: string) => u.includes("/api/invoices?");
const itemsRequests = () => requestedUrls.filter((u) => /\/api\/invoices\/\d+\/items/.test(u));
const reminderRequests = () =>
  requestedUrls.filter((u) => /\/api\/invoices\/\d+\/reminders/.test(u));
const noteRequests = () => requestedUrls.filter((u) => /\/api\/invoices\/\d+\/ar-notes/.test(u));
const expansionRequests = () => [...itemsRequests(), ...reminderRequests(), ...noteRequests()];

async function waitForList() {
  await waitFor(() => expect(requestedUrls.some(isListRequest)).toBe(true));
  await waitFor(() => expect(screen.getAllByTestId("invoice-row-1").length).toBeGreaterThan(0));
}

/** Click the row itself, the way a bookkeeper does. */
function clickRow(id: number) {
  fireEvent.click(firstByTestId(`invoice-row-${id}`));
}

async function expandRow(id: number) {
  clickRow(id);
  await waitFor(() => expect(screen.getAllByTestId(`invoice-row-expansion-${id}`).length).toBe(1));
}

// ── 1. Expand, collapse, and what survives ───────────────────────────────────

describe("expanding a row in place", () => {
  it("shows line items, reminder history and notes without leaving the list", async () => {
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(1);

    const region = screen.getByTestId("invoice-row-expansion-1");
    await waitFor(() => expect(within(region).getByTestId("expansion-line-items")).toBeTruthy());
    expect(within(region).getByText("BS-010")).toBeTruthy();
    expect(within(region).getByText("Zone 3 head replacement")).toBeTruthy();
    await waitFor(() => expect(within(region).getByTestId("reminder-panel")).toBeTruthy());
    await waitFor(() => expect(within(region).getByTestId("ar-notes-panel")).toBeTruthy());

    // The list is still the list — the row above the region is untouched.
    expect(screen.getAllByTestId("invoice-row-1").length).toBeGreaterThan(0);
  });

  it("renders the source ticket number, work date, description and amount", async () => {
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(1);

    const region = screen.getByTestId("invoice-row-expansion-1");
    await waitFor(() => expect(within(region).getByTestId("expansion-line-items")).toBeTruthy());

    const row = within(region).getByTestId("expansion-line-items-row-11");
    // The human-readable number, not the internal id.
    expect(within(row).getByText("BS-010")).toBeTruthy();
    expect(within(row).queryByText("BS #10")).toBeNull();
    expect(
      within(region).getByTestId("expansion-line-items-work-date-11").textContent,
    ).toBe(new Date("2026-06-02T00:00:00.000Z").toLocaleDateString());
    expect(within(row).getByText("Zone 3 head replacement")).toBeTruthy();
    expect(within(row).getByText("$150.00")).toBeTruthy();
  });

  it("collapsing leaves filters, sort, grouping, selection and loaded pages exactly as they were", async () => {
    // Two pages, so "Load more" has something to add.
    rowsForResponse = Array.from({ length: 60 }, (_, i) =>
      invoiceRow({
        id: i + 1,
        invoiceNumber: `INV-${1000 + i}`,
        invoiceMonth: i < 30 ? 8 : 7,
      }),
    );
    totalCount = 60;

    const { nav } = renderInvoices("/invoices?aging=overdue&paymentStatus=unpaid&sort=agingBucket&dir=desc");
    await waitForList();

    fireEvent.click(screen.getByTestId("button-load-more-invoices"));
    await waitFor(() => expect(screen.getAllByTestId("invoice-row-55").length).toBeGreaterThan(0));

    // Tick a row for the batch actions, then note the state to be preserved.
    fireEvent.click(firstByTestId("checkbox-select-invoice-2"));
    await waitFor(() => expect(screen.getAllByTestId("invoice-row-2").length).toBeGreaterThan(0));

    const listRequestsBefore = requestedUrls.filter(isListRequest).length;
    const historyBefore = [...nav.history];
    const rowCountBefore = screen.getAllByTestId(/^invoice-row-\d+$/).length;
    const checkbox = firstByTestId("checkbox-select-invoice-2");
    expect(checkbox.getAttribute("data-state")).toBe("checked");

    await expandRow(1);
    clickRow(1);
    await waitFor(() => expect(screen.queryAllByTestId("invoice-row-expansion-1").length).toBe(0));

    // Nothing was written to the URL…
    expect(nav.history).toEqual(historyBefore);
    // …the list query never refetched, so no loaded page was dropped…
    expect(requestedUrls.filter(isListRequest).length).toBe(listRequestsBefore);
    expect(screen.getAllByTestId(/^invoice-row-\d+$/).length).toBe(rowCountBefore);
    // …the month grouping is intact…
    expect(screen.getAllByTestId(/^invoice-row-55$/).length).toBeGreaterThan(0);
    // …and the tick she made is still ticked.
    expect(firstByTestId("checkbox-select-invoice-2").getAttribute("data-state")).toBe("checked");
  });

  it("opening a second row closes the first", async () => {
    rowsForResponse = [invoiceRow(), invoiceRow({ id: 2, invoiceNumber: "INV-1002" })];
    renderInvoices("/invoices");
    await waitForList();

    await expandRow(1);
    await expandRow(2);

    expect(screen.queryAllByTestId("invoice-row-expansion-1").length).toBe(0);
    expect(screen.getAllByTestId("invoice-row-expansion-2").length).toBe(1);
  });
});

// ── 2. Coexisting with the version-history expansion ─────────────────────────

describe("version history and row expansion side by side", () => {
  it("the version chevron toggles only the version rows, never the expanded region", async () => {
    rowsForResponse = [
      invoiceRow({ id: 1, invoiceNumber: "INV-1001", revision: 2 }),
      invoiceRow({
        id: 2,
        invoiceNumber: "INV-1000",
        status: "superseded",
        supersededByInvoiceId: 1,
      }),
    ];
    renderInvoices("/invoices");
    await waitForList();

    const chevron = screen.getAllByLabelText(/Show 1 prior version/)[0];
    fireEvent.click(chevron);

    // The version chain opened, and the row expansion did not.
    await waitFor(() => expect(screen.getAllByLabelText(/Hide version history/).length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId("invoice-row-expansion-1").length).toBe(0);
    expect(expansionRequests()).toEqual([]);
  });

  it("expanding the row leaves an open version chain open", async () => {
    rowsForResponse = [
      invoiceRow({ id: 1, invoiceNumber: "INV-1001", revision: 2 }),
      invoiceRow({
        id: 2,
        invoiceNumber: "INV-1000",
        status: "superseded",
        supersededByInvoiceId: 1,
      }),
    ];
    renderInvoices("/invoices");
    await waitForList();

    fireEvent.click(screen.getAllByLabelText(/Show 1 prior version/)[0]);
    await waitFor(() => expect(screen.getAllByLabelText(/Hide version history/).length).toBeGreaterThan(0));

    await expandRow(1);

    expect(screen.getAllByLabelText(/Hide version history/).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("invoice-row-expansion-1").length).toBe(1);
  });
});

// ── 3. Nothing is fetched until a row opens ──────────────────────────────────

describe("fetch only on expand", () => {
  it("a fifty-row list issues none of the three reads on mount", async () => {
    rowsForResponse = Array.from({ length: 50 }, (_, i) =>
      invoiceRow({ id: i + 1, invoiceNumber: `INV-${1000 + i}` }),
    );
    renderInvoices("/invoices");
    await waitForList();

    expect(expansionRequests()).toEqual([]);
  });

  it("loading another page still issues none of them", async () => {
    rowsForResponse = Array.from({ length: 60 }, (_, i) =>
      invoiceRow({ id: i + 1, invoiceNumber: `INV-${1000 + i}` }),
    );
    totalCount = 60;
    renderInvoices("/invoices");
    await waitForList();

    fireEvent.click(screen.getByTestId("button-load-more-invoices"));
    await waitFor(() => expect(screen.getAllByTestId("invoice-row-55").length).toBeGreaterThan(0));

    expect(expansionRequests()).toEqual([]);
  });

  it("expanding one row fetches for that row and no other", async () => {
    rowsForResponse = [
      invoiceRow({ id: 1 }),
      invoiceRow({ id: 2, invoiceNumber: "INV-1002" }),
      invoiceRow({ id: 3, invoiceNumber: "INV-1003" }),
    ];
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(2);

    await waitFor(() => expect(itemsRequests().length).toBeGreaterThan(0));
    await waitFor(() => expect(noteRequests().length).toBeGreaterThan(0));

    for (const url of expansionRequests()) {
      expect(url).toMatch(/\/api\/invoices\/2\//);
    }
  });
});

// ── 4. Reminder history is what was recorded ─────────────────────────────────

describe("reminder history, presented as recorded", () => {
  it("shows the address it went to and the balance then, not today's", async () => {
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(1);

    const region = screen.getByTestId("invoice-row-expansion-1");
    await waitFor(() => expect(within(region).getByTestId("reminder-history-row-5")).toBeTruthy());
    const row = within(region).getByTestId("reminder-history-row-5");

    // The invoice now carries new-ap@acme.example and a $120.00 balance.
    expect(row.textContent).toContain("old-ap@acme.example");
    expect(row.textContent).toContain("$500.00");
    expect(row.textContent).not.toContain("new-ap@acme.example");
    expect(row.textContent).toContain("Gentle nudge");
    expect(row.textContent).toContain("Dana Reyes");
  });

  it("carries no send control and no current-state line", async () => {
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(1);

    const region = screen.getByTestId("invoice-row-expansion-1");
    await waitFor(() => expect(within(region).getByTestId("reminder-panel")).toBeTruthy());

    expect(within(region).queryByTestId("button-send-reminder")).toBeNull();
    expect(within(region).queryByTestId("reminder-template-select")).toBeNull();
    expect(within(region).queryByTestId("reminder-current-state")).toBeNull();
    expect(within(region).queryByTestId("reminder-throttled")).toBeNull();
  });
});

// ── 5. Role gating ───────────────────────────────────────────────────────────

describe("what each role's expanded row contains", () => {
  it("a role without A/R-note access gets no notes section and no note request", async () => {
    roleRef.current = "irrigation_manager";
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(1);

    const region = screen.getByTestId("invoice-row-expansion-1");
    await waitFor(() => expect(within(region).getByTestId("expansion-line-items")).toBeTruthy());

    expect(within(region).queryByTestId("ar-notes-panel")).toBeNull();
    expect(within(region).queryByTestId("ar-notes-panel-loading")).toBeNull();
    expect(noteRequests()).toEqual([]);
  });

  it("a role without the send capability gets no reminder section, not an error or a spinner", async () => {
    roleRef.current = "irrigation_manager";
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(1);

    const region = screen.getByTestId("invoice-row-expansion-1");
    await waitFor(() => expect(within(region).getByTestId("expansion-line-items")).toBeTruthy());

    expect(within(region).queryByTestId("reminder-panel")).toBeNull();
    expect(within(region).queryByTestId("reminder-panel-loading")).toBeNull();
    expect(reminderRequests()).toEqual([]);
    // Line items are all she gets, and she does get them.
    expect(within(region).getByText("BS-010")).toBeTruthy();
  });

  it("a bookkeeper gets all three", async () => {
    roleRef.current = "bookkeeper";
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(1);

    const region = screen.getByTestId("invoice-row-expansion-1");
    await waitFor(() => expect(within(region).getByTestId("reminder-panel")).toBeTruthy());
    await waitFor(() => expect(within(region).getByTestId("ar-notes-panel")).toBeTruthy());
    expect(within(region).getByTestId("expansion-line-items")).toBeTruthy();
  });
});

// ── 6. Empty states ──────────────────────────────────────────────────────────

describe("empty states inside the expanded region", () => {
  it("says so plainly when there are no reminders and no notes", async () => {
    reminderRows = [];
    noteRows = [];
    itemsResponse = [];
    renderInvoices("/invoices");
    await waitForList();
    await expandRow(1);

    const region = screen.getByTestId("invoice-row-expansion-1");
    await waitFor(() => expect(within(region).getByTestId("reminder-history-empty")).toBeTruthy());
    await waitFor(() => expect(within(region).getByTestId("ar-notes-empty")).toBeTruthy());
    expect(within(region).getByTestId("expansion-line-items-empty")).toBeTruthy();

    // Not a blank region, and not a spinner left running.
    expect(within(region).queryByTestId("reminder-panel-loading")).toBeNull();
    expect(within(region).queryByTestId("ar-notes-panel-loading")).toBeNull();
    expect(within(region).queryByTestId("expansion-line-items-loading")).toBeNull();
  });
});

// ── 7. Keyboard and screen reader ────────────────────────────────────────────

describe("the row as a control", () => {
  it("is focusable and opens on Enter and on Space", async () => {
    renderInvoices("/invoices");
    await waitForList();

    const row = firstByTestId("invoice-row-1");
    expect(row.getAttribute("tabindex")).toBe("0");
    row.focus();
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByTestId("invoice-row-expansion-1").length).toBe(1));

    fireEvent.keyDown(row, { key: " " });
    await waitFor(() => expect(screen.queryAllByTestId("invoice-row-expansion-1").length).toBe(0));
  });

  it("announces its expanded state and points at the region it controls", async () => {
    renderInvoices("/invoices");
    await waitForList();

    const row = firstByTestId("invoice-row-1");
    expect(row.getAttribute("aria-expanded")).toBe("false");

    await expandRow(1);

    const expandedRow = firstByTestId("invoice-row-1");
    expect(expandedRow.getAttribute("aria-expanded")).toBe("true");
    const regionId = expandedRow.getAttribute("aria-controls");
    expect(regionId).toBe("invoice-row-region-1");

    const region = document.getElementById(regionId!);
    expect(region).toBeTruthy();
    expect(region!.getAttribute("role")).toBe("region");
    // Named by the row it belongs to, so the region is not an unlabelled void.
    expect(region!.getAttribute("aria-labelledby")).toBe(expandedRow.getAttribute("id"));
  });

  it("the mobile card list expands the same way", async () => {
    renderInvoices("/invoices");
    await waitForList();

    const card = screen.getByTestId("invoice-row-mobile-1");
    expect(card.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(card);

    await waitFor(() =>
      expect(screen.getAllByTestId("invoice-row-expansion-mobile-1").length).toBe(1),
    );
    const region = screen.getByTestId("invoice-row-expansion-mobile-1");
    await waitFor(() =>
      expect(within(region).getByTestId("expansion-line-items-mobile")).toBeTruthy(),
    );
    expect(screen.getByTestId("invoice-row-mobile-1").getAttribute("aria-expanded")).toBe("true");
  });
});
