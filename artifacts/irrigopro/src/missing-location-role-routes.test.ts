import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/App.tsx", "utf8");

function roleBranch(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} exists`).toBeGreaterThanOrEqual(0);
  expect(end, `${endMarker} exists after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Missing Location Data role routes", () => {
  it("gives bookkeepers the report and both canonical ticket targets", () => {
    const branch = roleBranch(
      '// Task #1886 — Bookkeeper:',
      '// Billing manager gets customer billing interface',
    );
    expect(branch).toContain('path="/reports/missing-location-data"');
    expect(branch).toContain('path="/work-orders"');
    expect(branch).toContain('path="/billing-sheets"');
  });

  it("gives Super Admin the cross-company report and both canonical ticket targets", () => {
    const branch = roleBranch(
      '// Super Admin gets system-wide access',
      '// Company Admin gets access to company-specific dashboard and management',
    );
    expect(branch).toContain('path="/reports/missing-location-data"');
    expect(branch).toContain('path="/work-orders"');
    expect(branch).toContain('path="/billing-sheets"');
  });
});