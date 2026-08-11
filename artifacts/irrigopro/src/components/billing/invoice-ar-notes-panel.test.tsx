/**
 * invoice-ar-notes-panel.test.tsx — Task #1889
 *
 * The server side of the note thread — the guard, the append-only shape, the
 * cross-company scoping, and the proof that nothing reaches a customer — is
 * covered in `artifacts/api-server/src/routes/invoice-ar-notes.test.ts`. What
 * can only be checked here is what a bookkeeper actually reads on screen:
 *
 *  1. the thread renders attributed and timestamped, newest first;
 *  2. the panel says "internal" and "permanent" BEFORE the compose box, so the
 *     mistake it exists to prevent — typing candid commentary into what turns
 *     out to be the customer-visible notes field — is warned about in time;
 *  3. there is no edit control and no delete control on any entry;
 *  4. composing posts the note and nothing else.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { InvoiceArNotesPanel } from "./invoice-ar-notes-panel";
// The panel relies on the app-wide default query function, which turns the
// query key into a URL. Using the real one here means the test proves the key
// actually resolves to /api/invoices/:id/ar-notes.
import { getQueryFn } from "@/lib/queryClient";

const NOTES = [
  {
    id: 2,
    invoiceId: 42,
    note: "AP says it's in the next check run.",
    authorUserId: 7,
    authorName: "Dana Reyes",
    createdAt: "2026-08-10T15:04:00.000Z",
  },
  {
    id: 1,
    invoiceId: 42,
    note: "Left a voicemail for accounts payable.",
    authorUserId: 8,
    authorName: null,
    createdAt: "2026-08-04T09:12:00.000Z",
  },
];

let requests: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (method === "POST") {
        return new Response(JSON.stringify({ note: NOTES[0], internalOnly: true }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ notes: NOTES, internalOnly: true }), {
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

function renderPanel(open = true) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, queryFn: getQueryFn({ on401: "returnNull" }) },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <InvoiceArNotesPanel invoiceId={42} invoiceNumber="INV-0042" open={open} />
    </QueryClientProvider>,
  );
}

describe("InvoiceArNotesPanel", () => {
  it("renders the thread attributed and timestamped", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("ar-notes-thread")).toBeTruthy());

    const newest = screen.getByTestId("ar-note-row-2");
    expect(newest.textContent).toContain("AP says it's in the next check run.");
    expect(newest.textContent).toContain("Dana Reyes");
    // The timestamp is rendered from the stored row, in the reader's locale.
    expect(newest.textContent).toContain(String(new Date(NOTES[0].createdAt).getFullYear()));

    // A note whose author has since been renamed away still reads as history.
    expect(screen.getByTestId("ar-note-row-1").textContent).toContain("A former user");
  });

  it("says internal and permanent before the compose box", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("ar-notes-panel")).toBeTruthy());

    const banner = screen.getByTestId("ar-notes-internal-banner");
    expect(banner.textContent).toMatch(/customer never sees/i);
    expect(banner.textContent).toMatch(/not the invoice's notes field/i);
    expect(banner.textContent).toMatch(/cannot be edited or deleted/i);

    // "Before" is literal: the warning must precede the input in the DOM, or a
    // reader meets the box first and the warning arrives too late.
    const input = screen.getByTestId("input-ar-note");
    expect(banner.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers no way to edit or delete an entry", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("ar-notes-thread")).toBeTruthy());

    const thread = screen.getByTestId("ar-notes-thread");
    expect(thread.querySelectorAll("button").length).toBe(0);
    expect(thread.querySelectorAll("textarea, input").length).toBe(0);
    expect(thread.textContent).not.toMatch(/\b(edit|delete|remove)\b/i);
  });

  it("appends a note and sends nothing but the text", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("ar-notes-thread")).toBeTruthy());

    fireEvent.change(screen.getByTestId("input-ar-note"), {
      target: { value: "  Disputing the second ticket.  " },
    });
    fireEvent.click(screen.getByTestId("button-add-ar-note"));

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    const post = requests.find((r) => r.method === "POST")!;
    expect(post.url).toContain("/api/invoices/42/ar-notes");
    // Author, company and timestamp come off the session on the server.
    expect(post.body).toEqual({ note: "Disputing the second ticket." });
  });

  it("will not send an empty note", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("ar-notes-thread")).toBeTruthy());

    fireEvent.change(screen.getByTestId("input-ar-note"), { target: { value: "   " } });
    expect((screen.getByTestId("button-add-ar-note") as HTMLButtonElement).disabled).toBe(true);
  });

  it("fetches nothing while the invoice detail is closed", () => {
    renderPanel(false);
    expect(screen.queryByTestId("ar-notes-panel")).toBeNull();
    expect(requests).toEqual([]);
  });
});
