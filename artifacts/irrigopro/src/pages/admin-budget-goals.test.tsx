import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach } from "vitest";
import AdminBudgetGoals from "./admin-budget-goals";
import * as authContext from "@/lib/auth-context";
import * as queryClient from "@/lib/queryClient";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/auth-context", () => ({
  useAuth: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe("AdminBudgetGoals", () => {
  const renderPage = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, queryFn: async () => [] } },
    });
    return render(
      <QueryClientProvider client={client}>
        <AdminBudgetGoals />
      </QueryClientProvider>,
    );
  };

  beforeEach(() => {
    vi.mocked(authContext.useAuth).mockReturnValue({
      user: { id: 1, role: "company_admin", companyId: 1, name: "Admin", username: "admin", email: "admin@test.com", isActive: true },
      isLoading: false,
      setUser: vi.fn(),
      logout: vi.fn(),
    });
    
    vi.mocked(queryClient.apiRequest).mockResolvedValue({
      year: 2026,
      companyId: 1,
      rows: [
        {
          rowNumber: 1,
          customerName: "Acme Corp",
          goalText: "1000",
          status: "matched",
          customerId: 10,
          matchedCustomerName: "Acme Corp",
          goal: 1000,
          beforeGoal: null,
          reason: "Exact match",
          months: [{ month: 3, amount: 100, isManualOverride: false }],
          preservedManualOverrides: [],
        }
      ],
      counts: {
        total: 1,
        matched: 1,
        unchanged: 0,
        ambiguous: 0,
        unmatched: 0,
        invalid: 0,
      },
      confirmationToken: "token123",
      confirmationExpiresAt: new Date().toISOString(),
    });
  });

  it("renders the initial state for company_admin", () => {
    renderPage();
    expect(screen.getByText("Annual Budget Planning")).toBeInTheDocument();
    expect(screen.getByText("Paste Budget Data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview Import/i })).toBeDisabled();
  });

  it("denies access to field techs", () => {
    vi.mocked(authContext.useAuth).mockReturnValue({
      user: { id: 2, role: "field_tech", companyId: 1, name: "Tech", username: "tech", email: "tech@test.com", isActive: true },
      isLoading: false,
      setUser: vi.fn(),
      logout: vi.fn(),
    });
    renderPage();
    expect(screen.getByText("Access Restricted")).toBeInTheDocument();
  });

  it("enables preview button after pasting data", async () => {
    const user = userEvent.setup();
    renderPage();
    
    const textarea = screen.getByPlaceholderText("Paste rows here...");
    await user.type(textarea, "Acme Corp\t1000");
    
    const previewBtn = screen.getByRole("button", { name: /Preview Import/i });
    expect(previewBtn).not.toBeDisabled();
    
    await user.click(previewBtn);
    
    expect(queryClient.apiRequest).toHaveBeenCalledWith("/api/admin/budget-goals/preview", "POST", {
      year: new Date().getFullYear(),
      companyId: 1,
      text: "Acme Corp\t1000",
    });
    
    await waitFor(() => {
      expect(screen.getByText(/Preview Results for 2026/)).toBeInTheDocument();
    });
    
    expect(screen.getByText("Confirm 1 Updates")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("$1,000.00")).toBeInTheDocument();
  });

  it("handles confirmation step", async () => {
    const user = userEvent.setup();
    renderPage();
    
    const textarea = screen.getByPlaceholderText("Paste rows here...");
    await user.type(textarea, "Acme Corp\t1000");
    
    await user.click(screen.getByRole("button", { name: /Preview Import/i }));
    
    await waitFor(() => {
      expect(screen.getByText("Confirm 1 Updates")).toBeInTheDocument();
    });
    
    vi.mocked(queryClient.apiRequest).mockResolvedValueOnce({
      results: [
        {
          rowNumber: 1,
          customerName: "Acme Corp",
          customerId: 10,
          outcome: "changed",
          status: "matched",
          beforeGoal: null,
          afterGoal: 1000,
          reason: "Success",
        }
      ]
    });
    
    await user.click(screen.getByText("Confirm 1 Updates"));
    
    expect(queryClient.apiRequest).toHaveBeenCalledWith("/api/admin/budget-goals/confirm", "POST", {
      year: 2026,
      companyId: 1,
      text: "Acme Corp\t1000",
      confirmationToken: "token123",
    });
    
    await waitFor(() => {
      expect(screen.getByText("Import Complete")).toBeInTheDocument();
      expect(screen.getByText("changed")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /copy log/i }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toContain("Goal: — -> $1,000.00");
    });
  });
});
