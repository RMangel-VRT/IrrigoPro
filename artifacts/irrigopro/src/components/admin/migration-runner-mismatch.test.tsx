// Task #1982 — the runner must never show a green banner for a run the
// database does not confirm.
//
// The server marks such a job `mismatched`. Here we drive the runner through a
// real run → poll cycle and assert that the mismatched terminal state renders
// the warning *in place of* "Migration completed successfully", and that the
// runner treats `mismatched` as terminal (stops polling, reports completion).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { MigrationProgress } from "@/types/migrations";

const mockApiRequest = vi.fn<[string, string], Promise<unknown>>();

vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...(args as [string, string])),
}));

const MISMATCHED: MigrationProgress = {
  jobId: "job-1",
  migrationId: "seed-field-work-types-v1",
  startedAt: "2026-09-02T11:06:00.000Z",
  finishedAt: "2026-09-02T11:07:00.000Z",
  state: "mismatched",
  steps: [{ id: "seed-defaults", status: "success", durationMs: 12, rowsAffected: 14 }],
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
};

function setupApi(terminal: MigrationProgress) {
  mockApiRequest.mockImplementation(async (url: string, method?: string) => {
    if (method === "POST") return { jobId: "job-1" };
    return terminal;
  });
}

describe("MigrationRunner — a mismatched job replaces the success banner", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("shows the mismatch warning and never the green 'completed successfully' banner", async () => {
    setupApi(MISMATCHED);
    const onComplete = vi.fn();
    const { MigrationRunner } = await import("./MigrationRunner");

    render(
      <MigrationRunner migrationId="seed-field-work-types-v1" acknowledged onComplete={onComplete} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Run Migration/i }));

    const banner = await screen.findByTestId("migration-mismatch-banner", undefined, { timeout: 3000 });
    expect(banner).toHaveTextContent(/reported success/i);
    expect(banner).toHaveTextContent(/14 default field work type\(s\) are still missing/i);
    expect(screen.queryByTestId("migration-success-banner")).toBeNull();
    expect(screen.queryByText(/Migration completed successfully/i)).toBeNull();

    // Terminal: the runner stops polling and hands the job to its parent.
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0].state).toBe("mismatched");
  });

  it("still shows the green banner for a run the post-run re-read confirms", async () => {
    setupApi({
      ...MISMATCHED,
      state: "succeeded",
      mismatch: undefined,
      postRun: {
        checkedAt: "2026-09-02T11:07:01.000Z",
        status: { state: "completed", completedAt: "2026-09-02T11:07:00.000Z" },
      },
    });
    const { MigrationRunner } = await import("./MigrationRunner");

    render(<MigrationRunner migrationId="seed-field-work-types-v1" acknowledged />);
    await userEvent.click(screen.getByRole("button", { name: /Run Migration/i }));

    const banner = await screen.findByTestId("migration-success-banner", undefined, { timeout: 3000 });
    expect(banner).toHaveTextContent(/Migration completed successfully/i);
    expect(banner).toHaveTextContent(/re-read after the run: completed/i);
    expect(screen.queryByTestId("migration-mismatch-banner")).toBeNull();
  });
});
