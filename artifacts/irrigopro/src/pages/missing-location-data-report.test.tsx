import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getQueryFn } from "@/lib/queryClient";
import MissingLocationDataReportPage from "./missing-location-data-report";

const row = {
  ticketType: "work_order",
  ticketId: 42,
  ticketNumber: "WO-0042",
  customerName: "Acme Grounds",
  branchName: "North",
  technicianId: 7,
  technicianName: "Alex Tech",
  workDate: "2026-08-15T12:00:00.000Z",
  status: "billed",
  violations: ["controller_missing", "zone_missing"],
  confidence: "low",
  companyId: 3,
  companyName: "Irrigo North",
  canonicalPath: "/work-orders?openWorkOrder=42",
};

let responseStatus = 200;
let responseBody: unknown = { count: 1, rows: [row] };
let requestedUrls: string[] = [];

beforeEach(() => {
  responseStatus = 200;
  responseBody = { count: 1, rows: [row] };
  requestedUrls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { "Content-Type": "application/json" },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderReport() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: getQueryFn({ on401: "throw" }),
        retry: false,
        gcTime: 0,
      },
    },
  });
  const nav = memoryLocation({ path: "/reports/missing-location-data" });
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={nav.hook}>
        <MissingLocationDataReportPage />
      </Router>
    </QueryClientProvider>,
  );
}

describe("Missing Location Data report page", () => {
  it("renders company identity, readable violation badges, confidence, and canonical deep link", async () => {
    renderReport();

    expect(await screen.findByText("WO-0042")).toBeInTheDocument();
    expect(screen.getByText("Acme Grounds")).toBeInTheDocument();
    expect(screen.getByText("Irrigo North")).toBeInTheDocument();
    expect(screen.getByText("Controller missing")).toBeInTheDocument();
    expect(screen.getByText("Zone missing")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "WO-0042" })).toHaveAttribute(
      "href",
      "/work-orders?openWorkOrder=42",
    );
  });

  it("sends technician, date, and low-confidence filters to the report endpoint", async () => {
    renderReport();
    await screen.findByText("WO-0042");

    fireEvent.change(screen.getByTestId("input-technician"), {
      target: { value: "Alex" },
    });
    fireEvent.change(screen.getByTestId("input-from-date"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByTestId("input-to-date"), {
      target: { value: "2026-08-31" },
    });
    fireEvent.click(screen.getByTestId("checkbox-low-confidence"));

    await waitFor(
      () => {
        expect(requestedUrls.some((url) =>
          url.includes("technician=Alex") &&
          url.includes("from=2026-08-01") &&
          url.includes("to=2026-08-31") &&
          url.includes("lowConfidenceOnly=true"),
        )).toBe(true);
      },
      { timeout: 2_000 },
    );
  });

  it("renders empty and error states without inventing ticket data", async () => {
    responseBody = { count: 0, rows: [] };
    renderReport();
    expect(await screen.findByTestId("report-empty")).toHaveTextContent("All clear");
  });

  it("renders a retryable error state", async () => {
    responseStatus = 500;
    responseBody = { message: "boom" };
    renderReport();
    expect(await screen.findByTestId("report-error")).toBeInTheDocument();
    expect(screen.getByTestId("button-retry-report")).toBeEnabled();
  });
});