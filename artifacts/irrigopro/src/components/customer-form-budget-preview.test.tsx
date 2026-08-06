// Task #687 — Financial Pulse Slice 1.
//
// Guard the LiveBudgetPreview re-fetch contract: when the user types a
// new cap or threshold into the form, the preview MUST re-classify
// against the latest server-side spend. The card uses React Query's
// `refetch()` inside a `useEffect` keyed on cap/threshold values. If a
// future refactor drops that hook (or stops including the watched
// values in the dep array) this static-source guard fails fast.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "customer-form.tsx"),
  "utf8",
);

describe("LiveBudgetPreview re-fetch contract", () => {
  it("calls refetch() inside a useEffect whose deps include caps + thresholds", () => {
    // Pull out the LiveBudgetPreview function body.
    const start = SRC.indexOf("function LiveBudgetPreview");
    expect(start).toBeGreaterThan(-1);
    const next = SRC.indexOf("\nfunction ", start + 1);
    const body = SRC.slice(start, next === -1 ? undefined : next);

    // The form values that drive the preview must all be watched.
    expect(body).toMatch(/form\.watch\(\s*"monthlyBudgetCap"\s*\)/);
    expect(body).toMatch(/form\.watch\(\s*"annualBudgetCap"\s*\)/);
    expect(body).toMatch(/form\.watch\(\s*"budgetSoftThresholdPercent"\s*\)/);
    expect(body).toMatch(/form\.watch\(\s*"budgetHardThresholdPercent"\s*\)/);

    // The useEffect must call refetch and list all four watched values
    // in its dependency array so a change re-triggers the fetch.
    const effectMatch = body.match(
      /useEffect\(\s*\(\)\s*=>\s*\{[^}]*refetch\(\)[^}]*\}\s*,\s*\[([^\]]+)\]\s*\)/,
    );
    expect(effectMatch, "useEffect calling refetch() not found").not.toBeNull();
    const deps = effectMatch![1];
    expect(deps).toMatch(/monthlyCap/);
    expect(deps).toMatch(/annualCap/);
    expect(deps).toMatch(/softPct/);
    expect(deps).toMatch(/hardPct/);
    expect(deps).toMatch(/refetch/);
  });

  it("renders a Progress meter for capped buckets (parity with profile card)", () => {
    // The detail card on customer-profile.tsx uses <Progress /> to
    // show cap utilization. The live preview must do the same so the
    // two surfaces visually agree.
    expect(SRC).toMatch(/import\s+\{\s*Progress\s*\}\s+from\s+"@\/components\/ui\/progress"/);
    const previewStart = SRC.indexOf("function PreviewRow");
    expect(previewStart).toBeGreaterThan(-1);
    const previewBody = SRC.slice(previewStart);
    expect(previewBody).toMatch(/<Progress/);
  });
});
