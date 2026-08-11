/**
 * estimate-list-error-state.test.tsx (Task #1898)
 *
 * Production logs showed `getEstimates` failing with
 * "timeout exceeded when trying to connect" during the manager dashboard's
 * ~25-call fan-out. The user saw an estimate list that simply wasn't there,
 * with no error, and a reload usually fixed it — so it was never reported.
 *
 * Two things had to be true for that to be silent, and this file pins the
 * frontend half: a failed fetch must NOT render the empty state.
 * (The backend half — the pool acquisition failure reaching the route instead
 * of being swallowed into `[]` — is covered by db-connection-errors.test.ts.)
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EstimateList } from "./estimate-list";

const noop = () => {};
const emptyFilters = { customerIds: [], statuses: [] };

function renderList(props: Partial<React.ComponentProps<typeof EstimateList>> = {}) {
  // EstimateList reaches for the resend mutation hook, so it needs a client
  // in context even when it renders nothing but the failure state.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EstimateList
        estimates={[]}
        filters={emptyFilters}
        onOpen={noop}
        onEdit={noop}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("EstimateList failure state (Task #1898)", () => {
  it("shows an error, not the empty state, when the fetch failed", () => {
    renderList({ isError: true });

    expect(screen.getByTestId("estimate-list-error")).toBeInTheDocument();
    expect(screen.queryByText(/No estimates yet/i)).not.toBeInTheDocument();
  });

  it("still shows the empty state when the fetch succeeded with no rows", () => {
    // The regression guard runs both ways: an account that genuinely has no
    // estimates must not be told something went wrong.
    renderList({ isError: false });

    expect(screen.queryByTestId("estimate-list-error")).not.toBeInTheDocument();
    expect(screen.getByText(/No estimates yet/i)).toBeInTheDocument();
  });

  it("treats a missing isError prop as success", () => {
    renderList();

    expect(screen.queryByTestId("estimate-list-error")).not.toBeInTheDocument();
    expect(screen.getByText(/No estimates yet/i)).toBeInTheDocument();
  });

  it("offers a retry that refetches", async () => {
    const onRetry = vi.fn();
    renderList({ isError: true, onRetry });

    await userEvent.click(screen.getByTestId("estimate-list-error-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the error without a retry button when no handler is supplied", () => {
    renderList({ isError: true });

    expect(screen.getByTestId("estimate-list-error")).toBeInTheDocument();
    expect(screen.queryByTestId("estimate-list-error-retry")).not.toBeInTheDocument();
  });
});
