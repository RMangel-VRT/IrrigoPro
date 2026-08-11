/**
 * invoices-draft-editor-line-items.test.tsx — Task #1923
 *
 * The draft-invoice editor's ticket list after the Task #1918 refactor, which
 * moved the row rendering into the shared read-only `InvoiceLineItemsList`
 * and left the editor holding only its per-row Remove via `renderRowAction`.
 * The expanded-row suite covers the shared component from the other side;
 * this one pins the editor's own behaviour so a change to the shared list
 * cannot quietly break the editor while those tests stay green:
 *
 *  1. every attached ticket is rendered exactly once, with its ticket ref,
 *     description and amount;
 *  2. Remove fires the remove-ticket mutation with the right invoice id,
 *     ticket type and ticket id for the row it sits on;
 *  3. the running total reflects the invoice and updates from the server's
 *     answer after a removal;
 *  4. the last remaining ticket's Remove is disabled (void the invoice
 *     instead);
 *  5. an empty draft says so in a plain line instead of an empty box.
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
import { getQueryFn } from "@/lib/queryClient";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type Row = Record<string, unknown>;

function draftInvoice(overrides: Row = {}): Row {
  return {
    id: 1,
    invoiceNumber: "INV-2001",
    customerId: 10,
    customerName: "Acme Grounds",
    customerEmail: "ap@acme.example",
    status: "draft",
    totalAmount: "240.00",
    partsSubtotal: "90.00",
    laborSubtotal: "150.00",
    invoiceYear: 2026,
    invoiceMonth: 8,
    periodStart: new Date(NOW - 30 * DAY).toISOString(),
    periodEnd: new Date(NOW - 1 * DAY).toISOString(),
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    sentAt: null,
    dueDate: null,
    quickbooksInvoiceId: undefined,
    paidAt: null,
    arFlags: [],
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
    totalPrice: "60.00",
    workDate: "2026-06-03T00:00:00.000Z",
  },
  {
    id: 13,
    sourceType: "wet_check_billing",
    billingSheetId: null,
    workOrderId: null,
    wetCheckBillingId: 30,
    sourceNumber: "WCB-030",
    sourceTypeLabel: "WCB",
    description: "Spring wet check",
    totalPrice: "30.00",
    workDate: "2026-06-04T00:00:00.000Z",
  },
];

// Radix drives open/close off pointer capture, which jsdom does not implement.
const proto = Element.prototype as any;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};
proto.scrollIntoView ??= () => {};

interface CapturedRequest {
  url: string;
  method: string;
}

let requests: CapturedRequest[] = [];
let rowsForResponse: Row[] = [];
let itemsResponse: unknown[] = [];
let deleteResponse: Row = {};

beforeEach(() => {
  requests = [];
  rowsForResponse = [draftInvoice()];
  itemsResponse = LINE_ITEMS;
  deleteResponse = { totalAmount: "90.00", partsSubtotal: "40.00", laborSubtotal: "50.00" };
  roleRef.current = "billing_manager";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({ url, method });
      const json = (body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json", ...headers },
        });

      if (method === "DELETE" && /\/api\/invoices\/\d+\/tickets\//.test(url)) {
        return json(deleteResponse);
      }
      if (/\/api\/invoices\/\d+\/items/.test(url)) return json({ items: itemsResponse });
      if (url.includes("/api/invoices?")) {
        return json(rowsForResponse, { "X-Total-Count": String(rowsForResponse.length) });
      }
      return json([]);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderInvoices() {
  const nav = memoryLocation({ path: "/invoices", record: true });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, queryFn: getQueryFn({ on401: "returnNull" }) },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={nav.hook} searchHook={nav.searchHook}>
        <InvoicesPage />
      </Router>
    </QueryClientProvider>,
  );
}

/**
 * jsdom applies no media queries, so the desktop table and the mobile card
 * list both render and every shared row control appears twice. The Sheet the
 * draft editor lives in, however, renders once.
 */
function firstByTestId(testId: string): HTMLElement {
  return screen.getAllByTestId(testId)[0];
}

/** Radix opens its dropdown on pointerdown, which jsdom does not synthesise. */
async function openActionsMenu(invoiceId: number) {
  const trigger = firstByTestId(`button-invoice-actions-${invoiceId}`);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
}

async function openDraftEditor(invoiceId = 1) {
  await waitFor(() =>
    expect(screen.getAllByTestId(`invoice-row-${invoiceId}`).length).toBeGreaterThan(0),
  );
  await openActionsMenu(invoiceId);
  fireEvent.click(screen.getByTestId(`button-manage-tickets-invoice-${invoiceId}`));
  await waitFor(() =>
    expect(screen.getByText(`Edit draft invoice #INV-2001`)).toBeTruthy(),
  );
}

const itemsRequests = () =>
  requests.filter((r) => r.method === "GET" && /\/api\/invoices\/\d+\/items/.test(r.url));
const deleteRequests = () =>
  requests.filter((r) => r.method === "DELETE" && /\/tickets\//.test(r.url));

// ── 1. Every ticket, once ────────────────────────────────────────────────────

describe("the draft editor's ticket list", () => {
  it("renders every attached ticket exactly once, with ref, description and amount", async () => {
    renderInvoices();
    await openDraftEditor();

    const list = await screen.findByTestId("draft-line-items");
    // One row per line item, no duplicates.
    for (const item of LINE_ITEMS) {
      expect(screen.getAllByTestId(`draft-line-items-row-${item.id}`).length).toBe(1);
    }
    expect(within(list).getAllByRole("listitem").length).toBe(LINE_ITEMS.length);

    // Each row carries the human-readable ticket ref, description and price.
    const bsRow = within(list).getByTestId("draft-line-items-row-11");
    expect(within(bsRow).getByText("BS-010")).toBeTruthy();
    expect(within(bsRow).getByText("Zone 3 head replacement")).toBeTruthy();
    expect(within(bsRow).getByText("$150.00")).toBeTruthy();

    const woRow = within(list).getByTestId("draft-line-items-row-12");
    expect(within(woRow).getByText("WO-2026-020")).toBeTruthy();
    expect(within(woRow).getByText("$60.00")).toBeTruthy();

    const wcbRow = within(list).getByTestId("draft-line-items-row-13");
    expect(within(wcbRow).getByText("WCB-030")).toBeTruthy();
    expect(within(wcbRow).getByText("$30.00")).toBeTruthy();

    // The items were fetched for this invoice, and only once.
    expect(itemsRequests().map((r) => r.url)).toEqual(["/api/invoices/1/items"]);
  });

  it("shows the invoice's running total", async () => {
    renderInvoices();
    await openDraftEditor();
    await screen.findByTestId("draft-line-items");

    // The list row for the invoice also shows the amount, so scope to the
    // editor's own "Current total" strip.
    const totalStrip = screen.getByText("Current total").parentElement!;
    expect(within(totalStrip).getByText("$240.00")).toBeTruthy();
  });

  // ── 2. Remove is wired to the row it sits on ─────────────────────────────

  it("fires the remove mutation with the right invoice, ticket type and ticket id", async () => {
    renderInvoices();
    await openDraftEditor();
    const list = await screen.findByTestId("draft-line-items");

    // Remove the middle row — the work order — so a right answer cannot be
    // an off-by-one or "always the first row".
    const woRow = within(list).getByTestId("draft-line-items-row-12");
    fireEvent.click(within(woRow).getByRole("button"));

    await waitFor(() => expect(deleteRequests().length).toBe(1));
    expect(deleteRequests()[0].url).toBe("/api/invoices/1/tickets/work_order:20");
  });

  it("updates the running total from the server's answer after a removal", async () => {
    renderInvoices();
    await openDraftEditor();
    const list = await screen.findByTestId("draft-line-items");

    fireEvent.click(within(list).getByTestId("draft-line-items-row-12").querySelector("button")!);
    await waitFor(() => expect(screen.getByText("$90.00")).toBeTruthy());
  });

  it("removes by wet-check-billing id for a WCB row, not the item id", async () => {
    renderInvoices();
    await openDraftEditor();
    const list = await screen.findByTestId("draft-line-items");

    const wcbRow = within(list).getByTestId("draft-line-items-row-13");
    fireEvent.click(within(wcbRow).getByRole("button"));

    await waitFor(() => expect(deleteRequests().length).toBe(1));
    expect(deleteRequests()[0].url).toBe("/api/invoices/1/tickets/wet_check_billing:30");
  });

  // ── 3. The last ticket cannot be removed ──────────────────────────────────

  it("disables Remove on the last remaining ticket", async () => {
    itemsResponse = [LINE_ITEMS[0]];
    renderInvoices();
    await openDraftEditor();
    const list = await screen.findByTestId("draft-line-items");

    const onlyRow = within(list).getByTestId("draft-line-items-row-11");
    const removeButton = within(onlyRow).getByRole("button") as HTMLButtonElement;
    expect(removeButton.disabled).toBe(true);

    fireEvent.click(removeButton);
    expect(deleteRequests().length).toBe(0);
  });

  // ── 4. Empty draft ─────────────────────────────────────────────────────────

  it("says so in a plain line when the draft has no tickets", async () => {
    itemsResponse = [];
    renderInvoices();
    await openDraftEditor();

    const empty = await screen.findByTestId("draft-line-items-empty");
    expect(empty.textContent).toMatch(/no tickets/i);
    expect(screen.queryByTestId("draft-line-items")).toBeNull();
  });
});
