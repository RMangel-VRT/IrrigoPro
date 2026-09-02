// Task #1982 — the migrations page must show post-run facts, not pre-run ones.
//
// The incident screen: "Last run: succeeded at 11:07:00 AM" sitting beside a
// preview reporting `fieldWorkTypesMissing: 14`. Those counts were fetched
// *before* the run and never refetched — the app sets `staleTime: Infinity`
// globally, so nothing on this page refreshes on its own.
//
// These tests pin the client half of the fix:
//   * finishing a run refetches the preview, so the numbers on screen are
//     post-run;
//   * a `mismatched` job renders the shortfall instead of a success line;
//   * the environment and database the server is acting on are named, in the
//     page header and in the run dialog, with no credentials.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

import type { MigrationProgress, MigrationTarget } from "@/types/migrations";

const mockApiRequest = vi.fn<[string, string], Promise<unknown>>();

vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...(args as [string, string])),
}));

// Stand-in runner: a button that hands the modal a finished job, so the test
// drives the completion path without the polling loop.
let completionProgress: MigrationProgress;
vi.mock("@/components/admin/MigrationRunner", () => ({
  MigrationRunner: ({ onComplete }: { onComplete?: (p: MigrationProgress) => void }) => (
    <button data-testid="finish-run" onClick={() => onComplete?.(completionProgress)}>
      finish
    </button>
  ),
}));

const TARGET: MigrationTarget = {
  environment: "production",
  deployment: true,
  host: "ep-cool-db.us-east-2.aws.neon.tech",
  database: "appdb",
  port: 5432,
  redacted: true,
};

function Wrapper({ children }: { children: React.ReactNode }) {
  // Mirror the app's global cache policy: nothing refreshes unless something
  // invalidates it. That is what makes the refetch assertion meaningful.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return (
    <QueryClientProvider client={qc}>
      <Router base="">{children}</Router>
    </QueryClientProvider>
  );
}

function progress(overrides: Partial<MigrationProgress> = {}): MigrationProgress {
  return {
    jobId: "job-1",
    migrationId: "seed-field-work-types-v1",
    startedAt: "2026-09-02T11:06:00.000Z",
    finishedAt: "2026-09-02T11:07:00.000Z",
    state: "succeeded",
    steps: [{ id: "seed-defaults", status: "success", durationMs: 12, rowsAffected: 14 }],
    ...overrides,
  };
}

/**
 * `missingByCall` feeds successive preview reads: the first is the pre-run
 * shortfall, the second is what the database says after the run.
 */
function setupApi(missingByCall: number[]) {
  let call = 0;
  mockApiRequest.mockImplementation(async (url: string) => {
    if (url.endsWith("/environment")) return TARGET;
    if (url.endsWith("/preview")) {
      const missing = missingByCall[Math.min(call, missingByCall.length - 1)];
      call++;
      return {
        steps: [{ id: "seed-defaults", description: "Insert missing defaults" }],
        orphanRows: { fieldWorkTypesMissing: missing },
        warnings: missing > 0 ? [`${missing} row(s) will be inserted.`] : [],
      };
    }
    return [];
  });
}

async function renderModal() {
  const { PreviewModal } = await import("./migrations");
  render(<PreviewModal migrationId="seed-field-work-types-v1" onClose={vi.fn()} />, {
    wrapper: Wrapper,
  });
}

describe("PreviewModal — counts shown after a run are re-read, not the pre-run ones", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completionProgress = progress();
  });

  it("refetches the preview when a run finishes, so 14 missing becomes 0", async () => {
    setupApi([14, 0]);
    await renderModal();

    // Pre-run number is on screen.
    expect(await screen.findByText("14")).toBeInTheDocument();

    // Acknowledge and start the run, then let it finish.
    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /Run Migration/i }));
    await userEvent.click(await screen.findByTestId("finish-run"));

    await waitFor(() => {
      expect(screen.getByText("0")).toBeInTheDocument();
    });
    expect(screen.queryByText("14")).toBeNull();

    const previewCalls = mockApiRequest.mock.calls.filter(([url]) =>
      String(url).endsWith("/preview"),
    );
    expect(previewCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("reports the post-run re-read alongside the run's own result", async () => {
    setupApi([14, 0]);
    completionProgress = progress({
      postRun: {
        checkedAt: "2026-09-02T11:07:01.000Z",
        status: { state: "completed", completedAt: "2026-09-02T11:07:00.000Z" },
      },
    });
    await renderModal();

    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /Run Migration/i }));
    await userEvent.click(await screen.findByTestId("finish-run"));

    const lastRun = await screen.findByTestId("migration-last-run");
    expect(lastRun).toHaveTextContent(/Last run: succeeded/i);
    expect(lastRun).toHaveTextContent(/Verified against the database after the run: status completed/i);
  });
});

describe("PreviewModal — a mismatched run is not a success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completionProgress = progress({
      state: "mismatched",
      postRun: {
        checkedAt: "2026-09-02T11:07:01.000Z",
        status: {
          state: "partially_applied",
          details: "14 default field work type(s) are still missing across 2 company/companies",
        },
      },
      mismatch: {
        summary: 'The run reported success, but re-reading the database says this migration is "partially_applied".',
        details: "14 default field work type(s) are still missing across 2 company/companies",
      },
    });
  });

  it("names the shortfall and never says the run succeeded", async () => {
    setupApi([14, 14]);
    await renderModal();

    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /Run Migration/i }));
    await userEvent.click(await screen.findByTestId("finish-run"));

    const lastRun = await screen.findByTestId("migration-last-run");
    expect(lastRun).toHaveTextContent(/mismatched/i);
    expect(lastRun).toHaveTextContent(/14 default field work type\(s\) are still missing/i);
    expect(lastRun).not.toHaveTextContent(/Last run: succeeded/i);
  });
});

describe("PreviewModal — an unverifiable run shows no success and no stale counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completionProgress = progress({
      state: "mismatched",
      postRun: {
        checkedAt: "2026-09-02T11:07:01.000Z",
        status: { state: "completed", completedAt: "2026-09-02T11:07:00.000Z" },
        error: "post-run preview re-read failed: connection terminated",
      },
      mismatch: {
        summary:
          "The run reported success, but the post-run verification could not be completed. Treat this run as unconfirmed.",
        details: "post-run preview re-read failed: connection terminated",
      },
    });
  });

  it("keeps the warning on screen when the post-run count refetch also fails", async () => {
    // First preview read succeeds (pre-run), the post-run refetch fails — the
    // same outage that stopped the server re-reading the counts.
    let call = 0;
    mockApiRequest.mockImplementation(async (url: string) => {
      if (url.endsWith("/environment")) return TARGET;
      if (url.endsWith("/preview")) {
        if (call++ > 0) throw new Error("connection terminated");
        return {
          steps: [{ id: "seed-defaults", description: "Insert missing defaults" }],
          orphanRows: { fieldWorkTypesMissing: 14 },
          warnings: ["14 row(s) will be inserted."],
        };
      }
      return [];
    });
    await renderModal();

    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /Run Migration/i }));
    await userEvent.click(await screen.findByTestId("finish-run"));

    await waitFor(() => {
      expect(screen.getByText(/Failed to load preview/i)).toBeInTheDocument();
    });
    // No green success, and no pre-run count left standing in for a post-run one.
    expect(screen.queryByTestId("migration-success-banner")).toBeNull();
    expect(screen.queryByText(/Migration completed successfully/i)).toBeNull();
    expect(screen.queryByText("14")).toBeNull();
  });
});

describe("PreviewModal — names the database it is acting on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completionProgress = progress();
  });

  it("shows the environment, database name and host, and no credentials", async () => {
    setupApi([14]);
    await renderModal();

    const banner = await screen.findByTestId("migration-target");
    expect(banner).toHaveTextContent(/production/i);
    expect(banner).toHaveTextContent("appdb");
    expect(banner).toHaveTextContent("ep-cool-db.us-east-2.aws.neon.tech");
    expect(banner.textContent ?? "").not.toContain("postgres://");
  });
});

describe("AdminMigrationsPage — header names the environment and database", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("user", JSON.stringify({ id: 1, role: "super_admin" }));
  });

  it("renders the target banner above the migration list", async () => {
    mockApiRequest.mockImplementation(async (url: string) => {
      if (url.endsWith("/environment")) return TARGET;
      return [
        {
          id: "seed-field-work-types-v1",
          title: "Seed default field work types",
          description: "Add the seven defaults.",
          status: { state: "not_started" },
        },
      ];
    });

    const AdminMigrationsPage = (await import("./migrations")).default;
    render(<AdminMigrationsPage />, { wrapper: Wrapper });

    const banner = await screen.findByTestId("migration-target");
    expect(banner).toHaveTextContent(/production/i);
    expect(banner).toHaveTextContent("appdb");
  });
});
