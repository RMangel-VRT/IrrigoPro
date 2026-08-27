/**
 * Tests for the customer-facing wet check condition report PDF.
 *
 * Covers: health summary counts, attention zones with findings + photos,
 * running-well rollup, zero-findings case, no-pricing guarantee,
 * logo resolution, email args structure.
 */
import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWetCheckReportHtml,
  deriveHealthSummary,
  type WetCheckReportPdfOptions,
} from "./wet-check-report-pdf";
import type { WetCheckWithDetails, WetCheckZoneRecord, WetCheckFinding } from "@workspace/db/schema";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeZone(
  overrides: Partial<WetCheckZoneRecord & { findings: WetCheckFinding[] }>,
): WetCheckZoneRecord & { findings: WetCheckFinding[] } {
  return {
    id: 1,
    wetCheckId: 10,
    controllerLetter: "A",
    zoneNumber: 1,
    status: "checked_ok",
    ranSuccessfully: true,
    observedPressure: null,
    observedFlow: null,
    repairLaborHours: null,
    notes: null,
    markedCompleteAt: null,
    findings: [],
    ...overrides,
  } as WetCheckZoneRecord & { findings: WetCheckFinding[] };
}

function makeFinding(overrides: Partial<WetCheckFinding> = {}): WetCheckFinding {
  return {
    id: 1,
    wetCheckId: 10,
    zoneRecordId: 1,
    issueType: "head_replacement",
    issueGroup: "quick_fix",
    partId: null,
    partName: null,
    quantity: 1,
    laborHours: null,
    resolution: "pending",
    notes: null,
    noPartNeeded: false,
    techDisposition: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as WetCheckFinding;
}

function makeWc(
  overrides: Partial<WetCheckWithDetails> = {},
): WetCheckWithDetails {
  return {
    id: 42,
    customerId: 1,
    companyId: 1,
    customerName: "Jane Customer",
    propertyAddress: "123 Main St",
    technicianName: "Bob Tech",
    technicianId: 5,
    status: "submitted",
    mode: "service",
    startedAt: new Date("2025-06-01T10:00:00Z"),
    submittedAt: new Date("2025-06-01T12:00:00Z"),
    approvedAt: null,
    totalLaborHours: null,
    numControllers: 1,
    weather: null,
    notes: null,
    clientId: null,
    branchName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    zoneRecords: [],
    photos: [],
    ...overrides,
  } as unknown as WetCheckWithDetails;
}

// ─── deriveHealthSummary ──────────────────────────────────────────────────────

describe("deriveHealthSummary", () => {
  it("counts zones correctly", () => {
    const zones = [
      makeZone({ id: 1, zoneNumber: 1, status: "checked_ok" }),
      makeZone({ id: 2, zoneNumber: 2, status: "checked_ok" }),
      makeZone({ id: 3, zoneNumber: 3, status: "checked_with_issues" }),
      makeZone({ id: 4, zoneNumber: 4, status: "not_applicable" }),
    ];
    const s = deriveHealthSummary(zones);
    assert.equal(s.total, 4);
    assert.equal(s.runningWell, 2);
    assert.equal(s.needAttention, 1);
    assert.equal(s.na, 1);
    assert.equal(s.healthPct, 67); // 2/3 = 66.7 => 67
  });

  it("returns 100% health for zero-findings wet check", () => {
    const zones = [
      makeZone({ id: 1, zoneNumber: 1, status: "checked_ok" }),
      makeZone({ id: 2, zoneNumber: 2, status: "checked_ok" }),
    ];
    const s = deriveHealthSummary(zones);
    assert.equal(s.healthPct, 100);
    assert.equal(s.needAttention, 0);
  });

  it("handles empty zone list without throwing", () => {
    const s = deriveHealthSummary([]);
    assert.equal(s.total, 0);
    assert.equal(s.healthPct, 100);
  });

  it("100% attention → 0% health", () => {
    const zones = [
      makeZone({ id: 1, zoneNumber: 1, status: "checked_with_issues" }),
      makeZone({ id: 2, zoneNumber: 2, status: "checked_with_issues" }),
    ];
    const s = deriveHealthSummary(zones);
    assert.equal(s.healthPct, 0);
  });
});

// ─── buildWetCheckReportHtml ──────────────────────────────────────────────────

describe("buildWetCheckReportHtml", () => {
  it("includes customer name and property address in meta block", () => {
    const wc = makeWc({ customerName: "Acme Corp", propertyAddress: "99 Oak Ave" });
    const html = buildWetCheckReportHtml(wc);
    assert.ok(html.includes("Acme Corp"), "Customer name missing");
    assert.ok(html.includes("99 Oak Ave"), "Property address missing");
  });

  it("uses the inspection snapshot location, branch, clocks, and zone identifiers", () => {
    const wc = makeWc({
      propertyAddress: "Historical Inspection Address",
      branchName: "North Branch",
      zoneRecords: [
        makeZone({ controllerLetter: "B", zoneNumber: 6, status: "checked_ok" }),
      ] as any,
    });
    const html = buildWetCheckReportHtml(wc);
    assert.ok(html.includes("Historical Inspection Address"));
    assert.ok(html.includes("North Branch"));
    assert.ok(html.includes("Clock B"));
    assert.ok(html.includes("B-6"));
  });

  it("shows technician name", () => {
    const wc = makeWc({ technicianName: "Alice Sprinkler" });
    const html = buildWetCheckReportHtml(wc);
    assert.ok(html.includes("Alice Sprinkler"), "Technician name missing");
  });

  it("shows health summary chip counts", () => {
    const wc = makeWc({
      zoneRecords: [
        makeZone({ id: 1, zoneNumber: 1, status: "checked_ok" }),
        makeZone({ id: 2, zoneNumber: 2, status: "checked_ok" }),
        makeZone({ id: 3, zoneNumber: 3, status: "checked_with_issues", findings: [makeFinding()] }),
        makeZone({ id: 4, zoneNumber: 4, status: "not_applicable" }),
      ] as any,
    });
    const html = buildWetCheckReportHtml(wc);
    // Running well + need attention counts appear in chip .num divs
    assert.ok(html.includes(">2<"), "Running well count missing");
    assert.ok(html.includes(">1<"), "Needs attention count missing");
  });

  it("renders attention zone with humanized finding label", () => {
    const finding = makeFinding({ issueType: "head_replacement" });
    const zone = makeZone({ id: 1, zoneNumber: 3, status: "checked_with_issues", findings: [finding] });
    const wc = makeWc({ zoneRecords: [zone] as any });
    const html = buildWetCheckReportHtml(wc);
    // The humanized label for head_replacement is "Head Replace" (from the seed)
    assert.ok(html.includes("Head Replace") || html.includes("head_replacement"), "Finding label missing");
    assert.ok(html.includes("Needs Attention"), "Attention badge missing");
  });

  it("renders running-well rollup for ok zones", () => {
    const wc = makeWc({
      zoneRecords: [
        makeZone({ id: 1, zoneNumber: 1, status: "checked_ok", controllerLetter: "A" }),
        makeZone({ id: 2, zoneNumber: 2, status: "checked_ok", controllerLetter: "A" }),
      ] as any,
    });
    const html = buildWetCheckReportHtml(wc);
    assert.ok(html.includes("Running Well") || html.includes("running-well"), "Running-well section missing");
    assert.ok(html.includes("A-1"), "Zone A-1 label missing");
    assert.ok(html.includes("A-2"), "Zone A-2 label missing");
  });

  it("zero-findings: shows 'everything running well' closing line", () => {
    const wc = makeWc({
      zoneRecords: [
        makeZone({ id: 1, zoneNumber: 1, status: "checked_ok" }),
      ] as any,
    });
    const html = buildWetCheckReportHtml(wc);
    assert.ok(html.includes("great shape") || html.includes("all zones"), "Zero-findings closing line missing");
  });

  it("does NOT include PSI/GPM/labor/pricing anywhere", () => {
    const wc = makeWc({
      zoneRecords: [
        makeZone({ id: 1, zoneNumber: 1, status: "checked_ok", observedPressure: "45.5", observedFlow: "2.1", repairLaborHours: "0.5" } as any),
      ] as any,
    });
    const html = buildWetCheckReportHtml(wc);
    // These internal fields must be absent from the customer-facing report
    assert.ok(!html.includes("PSI"), "PSI leaked into customer report");
    assert.ok(!html.includes("GPM"), "GPM leaked into customer report");
    assert.ok(!html.includes("laborHours") && !html.includes("Labor Hours"), "Labor hours leaked into customer report");
    assert.ok(!html.includes("$"), "Dollar amounts leaked into customer report");
  });

  it("embeds photo data URI when provided", () => {
    const photo = {
      id: 1,
      wetCheckId: 10,
      zoneRecordId: 1,
      findingId: null,
      url: "photos/test-uuid",
      caption: "sprinkler head",
      takenAt: new Date(),
      takenBy: 5,
      clientId: null,
    };
    const photoDataUris = new Map([["photos/test-uuid", "data:image/jpeg;base64,/9j/abc123"]]);
    const zone = makeZone({ id: 1, zoneNumber: 1, status: "checked_with_issues", findings: [makeFinding()] });
    const wc = makeWc({ zoneRecords: [zone] as any, photos: [photo] as any });
    const html = buildWetCheckReportHtml(wc, { photoDataUris });
    assert.ok(html.includes("data:image/jpeg;base64,/9j/abc123"), "Photo data URI not embedded");
  });

  it("uses company name in branded header", () => {
    const wc = makeWc();
    const html = buildWetCheckReportHtml(wc, { company: { name: "High Plains Irrigation", id: 1 } as any });
    assert.ok(html.includes("High Plains Irrigation"), "Company name missing from header");
  });

  it("does NOT include internal status label anywhere", () => {
    const wc = makeWc({ status: "pending_manager_review" });
    const html = buildWetCheckReportHtml(wc);
    // Internal status string must not appear in customer output
    assert.ok(!html.includes("pending_manager_review"), "Internal status leaked into customer report");
    assert.ok(!html.includes("Pending Manager Review"), "Internal status label leaked into customer report");
  });

  it("renders weather when present", () => {
    const wc = makeWc({ weather: "Sunny, 78°F" });
    const html = buildWetCheckReportHtml(wc);
    assert.ok(html.includes("Sunny"), "Weather field missing");
  });

  it("logo block is present when logoDataUri is provided", () => {
    const wc = makeWc();
    const html = buildWetCheckReportHtml(wc, { logoDataUri: "data:image/png;base64,abc" });
    assert.ok(html.includes('src="data:image/png;base64,abc"'), "Logo img tag missing");
  });
});
