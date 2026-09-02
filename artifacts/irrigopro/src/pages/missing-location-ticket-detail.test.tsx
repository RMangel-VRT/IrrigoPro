import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getQueryFn } from "@/lib/queryClient";
import MissingLocationTicketDetail from "./missing-location-ticket-detail";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bookkeeper location-audit ticket detail", () => {
  it("fetches only the selected report row and exposes no ticket mutations", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      count: 1,
      rows: [{
        ticketType: "work_order",
        ticketId: 42,
        ticketNumber: "WO-0042",
        customerName: "Acme Grounds",
        branchName: "North",
        technicianName: "Alex Tech",
        workDate: "2026-08-15T12:00:00.000Z",
        status: "billed",
        violations: ["controller_missing"],
        confidence: "high",
        companyName: "Irrigo North",
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/work-orders?openWorkOrder=42");

    const client = new QueryClient({
      defaultOptions: {
        queries: {
          queryFn: getQueryFn({ on401: "throw" }),
          retry: false,
        },
      },
    });
    const nav = memoryLocation({ path: "/work-orders" });

    render(
      <QueryClientProvider client={client}>
        <Router hook={nav.hook}>
          <MissingLocationTicketDetail ticketType="work_order" />
        </Router>
      </QueryClientProvider>,
    );

    expect(await screen.findAllByText("WO-0042")).toHaveLength(2);
    expect(screen.getByText("Controller missing")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reports/missing-location-data?ticketType=work_order&ticketId=42",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(screen.queryByRole("button", { name: /new|create|edit|delete/i })).not.toBeInTheDocument();
  });
});