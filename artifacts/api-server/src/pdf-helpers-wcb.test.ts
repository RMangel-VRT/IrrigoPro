/**
 * pdf-helpers-wcb.test.ts  (Task #787 Slice 2 + Task #854)
 *
 * Validates ticketPageWCB HTML output:
 *   - billing number and invoice number in header
 *   - technician name, date, hours
 *   - financial breakdown section (labor, parts, total)
 *   - branch name rendered when present, omitted when absent
 *   - approval block rendered when approvedBy is set
 *   - photo-fail warning rendered when sentinel is present
 *   - zone photo groups: photos appear in the correct zone block (Task #854)
 *   - finding-level photo label rendered inside its finding group (Task #854)
 *   - flat gallery falls back when zonePhotoGroups is absent (Task #854)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ticketPageWCB, ticketPageBS, ticketPageWO, partsBlockForWetCheckBS, FAILED_PHOTO_SENTINEL, buildFullCSS, JOB_TYPE_COLORS } from "./pdf-helpers";
import type { WcbZonePhotoGroupResolved } from "./pdf-helpers";
import { DEFAULT_BRAND_COLORS } from "./pdf-view-model";
import type { PdfWorkOrderRow, PdfBillingSheetRow } from "./pdf-view-model";
import type { PdfWetCheckBillingRow } from "./pdf-view-model";
import type { WetCheckBillingView } from "./wet-check-billing-view";

// ── minimal fixture ───────────────────────────────────────────────────────────

function makeRow(overrides: Partial<PdfWetCheckBillingRow> = {}): PdfWetCheckBillingRow {
  const base: PdfWetCheckBillingRow = {
    wetCheckBillingId: 42,
    wetCheckBilling: {
      id: 42,
      billingNumber: "WCB-2026-001",
      wetCheckId: 5,
      customerId: 10,
      technicianName: "Jane Smith",
      workDate: new Date("2026-05-15").toISOString(),
      totalHours: "2.5",
      laborRate: "80.00",
      appliedLaborRate: "80.00",
      laborSubtotal: "200.00",
      partsSubtotal: "75.00",
      totalAmount: "275.00",
      photos: [],
      approvedBy: null,
      approvedAt: null,
      propertyAddress: "99 Drip Lane",
      branchName: null,
      billedAt: null,
      invoiceId: null,
      status: "approved_passed_to_billing",
      createdAt: new Date("2026-05-15"),
      updatedAt: new Date("2026-05-15"),
    } as any,
    wetCheckView: {
      wetCheckBillingId: 42,
      billingNumber: "WCB-2026-001",
      customerId: 10,
      customerName: "Drip Corp",
      workDate: new Date("2026-05-15").toISOString(),
      laborRate: "80.00",
      inspection: {
        wetCheckId: 5,
        technicianName: "Jane Smith",
        inspectionDate: new Date("2026-05-15").toISOString(),
        propertyAddress: "99 Drip Lane",
        weather: "Sunny",
        notes: null,
      },
      zones: [],
    } as any,
  };
  return { ...base, ...overrides } as PdfWetCheckBillingRow;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ticketPageWCB — header color class (Task #1164)", () => {
  it("uses ticket-header-wcb (green) not ticket-header-bs (amber)", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.match(html, /class="[^"]*\bticket-header-wcb\b/, "WCB header must carry ticket-header-wcb class");
    assert.doesNotMatch(html, /class="[^"]*\bticket-header-bs\b/, "WCB header must NOT carry ticket-header-bs class");
  });
});

describe("ticketPageWCB — header fields (Task #787)", () => {
  it("includes billing number and invoice number in header", () => {
    const html = ticketPageWCB(makeRow(), "INV-0042", []);
    assert.match(html, /WCB-2026-001/);
    assert.match(html, /INV-0042/);
  });

  it("includes technician name", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.match(html, /Jane Smith/);
  });

  it("includes total hours", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.match(html, /2\.5/);
  });

  it("includes property address", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.match(html, /99 Drip Lane/);
  });
});

describe("ticketPageWCB — financial section (Task #787)", () => {
  it("renders Irrigation Labor line with hours × rate", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.match(html, /Irrigation Labor/);
    assert.match(html, /\$200\.00/);
  });

  it("renders Parts Subtotal", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.match(html, /Parts Subtotal/);
    assert.match(html, /\$75\.00/);
  });

  it("renders TOTAL", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.match(html, /TOTAL/);
    assert.match(html, /\$275\.00/);
  });
});

describe("ticketPageWCB — branch site chip", () => {
  it("renders a branch chip in the canonical panel when branchName is set", () => {
    const row = makeRow();
    (row.wetCheckBilling as any).branchName = "North Campus";
    const html = ticketPageWCB(row, "INV-1", []);
    assert.match(html, /ticket-site-chip/);
    assert.match(html, /Branch: North Campus/);
    assert.doesNotMatch(html, /ticket-header-branch/);
  });

  it("omits the branch chip when branchName is null", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.doesNotMatch(html, /ticket-header-branch/);
    assert.doesNotMatch(html, /Branch: /);
  });
});

describe("ticketPageWCB — approval block absent from PDF (Task #1193)", () => {
  it("does not render approval block even when approvedBy is set", () => {
    const row = makeRow();
    (row.wetCheckBilling as any).approvedBy = "Manager Bob";
    const html = ticketPageWCB(row, "INV-1", []);
    assert.doesNotMatch(html, /ticket-approval/, "approval block must be absent from PDF");
    assert.doesNotMatch(html, /Approved By:/, "Approved By text must not appear in PDF");
  });

  it("does not render approval block when approvedBy is null and approvedAt is null", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.doesNotMatch(html, /ticket-approval/);
    assert.doesNotMatch(html, /Approved By:/);
  });
});

describe("ticketPageWCB — photo fail warning (Task #787)", () => {
  it("renders photo-fail warning when sentinel is in photoDataUris", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", [
      FAILED_PHOTO_SENTINEL,
      FAILED_PHOTO_SENTINEL,
    ]);
    assert.match(html, /ticket-photo-fail-warning/);
    assert.match(html, /2 photos/);
  });

  it("omits photo-fail warning when no sentinels are present", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.doesNotMatch(html, /ticket-photo-fail-warning/);
  });
});

// ── Task #854: zone photo group rendering ─────────────────────────────────────

// Shared 2-zone WetCheckBillingView fixture for zone-photo tests
function makeWetCheckView(): WetCheckBillingView {
  return {
    wetCheckBillingId: 42,
    billingNumber: "WCB-2026-001",
    customerId: 10,
    customerName: "Drip Corp",
    workDate: new Date("2026-05-15").toISOString(),
    laborRate: "80.00",
    inspection: {
      wetCheckId: 5,
      technicianName: "Jane Smith",
      inspectionDate: new Date("2026-05-15").toISOString(),
      propertyAddress: "99 Drip Lane",
      weather: "Sunny",
      notes: null,
    },
    zones: [
      {
        controllerLetter: "A",
        zoneNumber: 1,
        zoneLabel: "A-1",
        zoneRecordId: 101,
        repairLaborHours: "1.00",
        repairLaborManuallySet: false,
        zonePhotoUrls: [],
        lineItems: [
          {
            findingId: 1,
            issueType: "head_replacement",
            issueDisplayLabel: "Head Replacement",
            partName: "Rotor Head",
            quantity: 1,
            unitPrice: "15.00",
            partsTotal: "15.00",
            laborHours: "0.50",
            laborTotal: "40.00",
            lineTotal: "55.00",
            noPartNeeded: false,
            notes: null,
            findingPhotoUrls: [],
          },
        ],
        zonePartsSubtotal: "15.00",
        zoneLaborSubtotal: "40.00",
        zoneTotal: "55.00",
      },
      {
        controllerLetter: "B",
        zoneNumber: 2,
        zoneLabel: "B-2",
        zoneRecordId: 102,
        repairLaborHours: "0.50",
        repairLaborManuallySet: false,
        zonePhotoUrls: [],
        lineItems: [
          {
            findingId: 2,
            issueType: "valve_repair",
            issueDisplayLabel: "Valve Repair",
            partName: "Solenoid Valve",
            quantity: 1,
            unitPrice: "20.00",
            partsTotal: "20.00",
            laborHours: "0.50",
            laborTotal: "40.00",
            lineTotal: "60.00",
            noPartNeeded: false,
            notes: null,
            findingPhotoUrls: [],
          },
        ],
        zonePartsSubtotal: "20.00",
        zoneLaborSubtotal: "40.00",
        zoneTotal: "60.00",
      },
    ],
    repairsSummary: "2 repairs across 2 zones",
    partsSubtotal: "35.00",
    laborSubtotal: "80.00",
    grandTotal: "115.00",
    totalsSource: "live_derive",
    zonesHaveStaleLaborData: false,
  };
}

describe("partsBlockForWetCheckBS — zone photo groups (Task #854)", () => {
  /**
   * Split the HTML by zone-block wrapper divs to isolate each zone's rendered
   * section.  The template wraps each zone in <div class="zone-block">…</div>,
   * so splitting on that tag gives us one piece per zone (after a leading piece
   * for the Repairs Summary block that precedes all zone blocks).
   *
   * blocks[0] = Repairs Summary
   * blocks[1] = content of zone A-1 zone-block div (including its photo html)
   * blocks[2] = content of zone B-2 zone-block div
   */
  function zoneBlocks(html: string): string[] {
    return html.split('<div class="zone-block">');
  }

  it("places a zone-A-1 photo inside the A-1 zone block, not in B-2", () => {
    const zoneGroups: WcbZonePhotoGroupResolved[] = [
      {
        zoneLabel: "A-1",
        zonePhotoDataUris: ["data:image/jpeg;base64,PHOTO_ONLY_IN_A1"],
        findingGroups: [],
      },
    ];
    const html = partsBlockForWetCheckBS(makeWetCheckView(), undefined as any, zoneGroups);
    const blocks = zoneBlocks(html);

    // blocks[1] = A-1, blocks[2] = B-2
    assert.equal(blocks.length, 3, "Expected 2 zone blocks plus preamble");
    assert.match(blocks[1], /PHOTO_ONLY_IN_A1/, "A-1 photo must appear inside the A-1 zone block");
    assert.doesNotMatch(blocks[2], /PHOTO_ONLY_IN_A1/, "A-1 photo must NOT bleed into B-2 zone block");
  });

  it("places a zone-B-2 photo inside the B-2 zone block, not in A-1", () => {
    const zoneGroups: WcbZonePhotoGroupResolved[] = [
      {
        zoneLabel: "B-2",
        zonePhotoDataUris: ["data:image/jpeg;base64,PHOTO_ONLY_IN_B2"],
        findingGroups: [],
      },
    ];
    const html = partsBlockForWetCheckBS(makeWetCheckView(), undefined as any, zoneGroups);
    const blocks = zoneBlocks(html);

    assert.equal(blocks.length, 3, "Expected 2 zone blocks plus preamble");
    assert.doesNotMatch(blocks[1], /PHOTO_ONLY_IN_B2/, "B-2 photo must NOT appear in A-1 zone block");
    assert.match(blocks[2], /PHOTO_ONLY_IN_B2/, "B-2 photo must appear inside the B-2 zone block");
  });

  it("renders the finding-level photo label inside its zone's section", () => {
    const zoneGroups: WcbZonePhotoGroupResolved[] = [
      {
        zoneLabel: "A-1",
        zonePhotoDataUris: [],
        findingGroups: [
          {
            findingId: 1,
            issueDisplayLabel: "Head Replacement",
            photoDataUris: ["data:image/jpeg;base64,FINDING_PHOTO"],
          },
        ],
      },
    ];
    const html = partsBlockForWetCheckBS(makeWetCheckView(), undefined as any, zoneGroups);
    const blocks = zoneBlocks(html);
    const blockA1 = blocks[1];

    assert.match(
      blockA1,
      /zone-photo-label/,
      "Finding photo section must include a label element inside A-1 block",
    );
    assert.match(
      blockA1,
      /Head Replacement/,
      "Finding label text must appear inside the A-1 zone block",
    );
    assert.match(
      blockA1,
      /FINDING_PHOTO/,
      "Finding photo data URI must appear inside the A-1 zone block",
    );
  });

  it("renders both zone-level and finding-level photos in the same zone block", () => {
    const zoneGroups: WcbZonePhotoGroupResolved[] = [
      {
        zoneLabel: "A-1",
        zonePhotoDataUris: ["data:image/jpeg;base64,ZONE_LEVEL"],
        findingGroups: [
          {
            findingId: 1,
            issueDisplayLabel: "Head Replacement",
            photoDataUris: ["data:image/jpeg;base64,FINDING_LEVEL"],
          },
        ],
      },
    ];
    const html = partsBlockForWetCheckBS(makeWetCheckView(), undefined as any, zoneGroups);
    const blocks = zoneBlocks(html);
    const blockA1 = blocks[1];

    assert.match(blockA1, /ZONE_LEVEL/, "Zone-level photo must appear in A-1 block");
    assert.match(blockA1, /FINDING_LEVEL/, "Finding-level photo must appear in A-1 block");
  });

  it("produces no inline photo html when zonePhotoGroups is absent", () => {
    const html = partsBlockForWetCheckBS(makeWetCheckView(), undefined as any);
    assert.doesNotMatch(html, /zone-photo-section/);
  });

  it("produces no inline photo html when zonePhotoGroups is an empty array", () => {
    const html = partsBlockForWetCheckBS(makeWetCheckView(), undefined as any, []);
    assert.doesNotMatch(html, /zone-photo-section/);
  });
});

describe("ticketPageWCB — zone photo grouping (Task #854)", () => {
  function makeRowWithView(): PdfWetCheckBillingRow {
    const row = makeRow();
    (row as any).wetCheckView = makeWetCheckView();
    return row;
  }

  it("embeds zone photo inline and omits flat gallery when zonePhotoGroups provided", () => {
    const zoneGroups: WcbZonePhotoGroupResolved[] = [
      {
        zoneLabel: "A-1",
        zonePhotoDataUris: ["data:image/jpeg;base64,INLINE_ZONE_PHOTO"],
        findingGroups: [],
      },
    ];
    const html = ticketPageWCB(makeRowWithView(), "INV-99", [], undefined, undefined, undefined, zoneGroups);

    assert.match(html, /INLINE_ZONE_PHOTO/, "Inline zone photo must appear in output");
    assert.doesNotMatch(
      html,
      /ticket-photos-section/,
      "Flat photo gallery section must be absent when zonePhotoGroups is provided",
    );
  });

  it("renders flat gallery when zonePhotoGroups is absent and photoDataUris are present", () => {
    const html = ticketPageWCB(
      makeRowWithView(),
      "INV-99",
      ["data:image/jpeg;base64,FLAT_PHOTO"],
    );

    assert.match(html, /ticket-photos-section/, "Flat gallery section must appear when no zone groups");
    assert.match(html, /FLAT_PHOTO/, "Flat photo must appear in the gallery");
  });

  it("renders empty photo message in flat gallery when no photos and no zone groups", () => {
    const html = ticketPageWCB(makeRowWithView(), "INV-99", []);
    assert.match(html, /ticket-photos-section/);
    assert.match(html, /No photos captured/);
  });
});

// ── Task #1173: job-type modifier classes + scoped CSS ────────────────────────

const minimalWO: PdfWorkOrderRow = {
  workOrderNumber: "WO-001",
  projectName: "Test Project",
  projectAddress: "1 Main St",
  branchName: null,
  controllerLetter: null,
  zoneNumber: null,
  locationNotes: "",
  technicianName: "Tech A",
  completedAt: null,
  totalHours: 1,
  laborRate: 80,
  workDescription: "",
  workSummary: "",
  aiDetailedDescription: "",
  photos: [],
  items: [],
  partsSubtotal: 0,
  laborSubtotal: 80,
  rowTotal: 80,
  approvedBy: null,
  approvedAt: null,
};

const minimalBS: PdfBillingSheetRow = {
  billingNumber: "BS-001",
  workDescription: "",
  propertyAddress: "1 Main St",
  branchName: null,
  controllerLetter: null,
  zoneNumber: null,
  technicianName: "Tech B",
  workDate: new Date("2026-05-15"),
  totalHours: 1,
  laborRate: 80,
  aiDetailedDescription: "",
  notes: "",
  photos: [],
  items: [],
  partsSubtotal: 0,
  laborSubtotal: 80,
  rowTotal: 80,
  approvedBy: null,
  approvedAt: null,
};

describe("ticketPageWO — approval text absent from PDF (Task #1193)", () => {
  it("does not render approval block even when approvedBy is set", () => {
    const woWithApproval = { ...minimalWO, approvedBy: "Manager Alice", approvedAt: new Date("2026-05-20") };
    const html = ticketPageWO(woWithApproval, "INV-1", []);
    assert.doesNotMatch(html, /ticket-approval/, "approval block must be absent from WO PDF");
    assert.doesNotMatch(html, /Approved By:/, "Approved By text must not appear in WO PDF");
    assert.doesNotMatch(html, /Approved At:/, "Approved At text must not appear in WO PDF");
  });

  it("does not render approval block when approvedBy is null", () => {
    const html = ticketPageWO(minimalWO, "INV-1", []);
    assert.doesNotMatch(html, /ticket-approval/);
    assert.doesNotMatch(html, /Approved By:/);
  });
});

describe("job-type modifier classes (Task #1173)", () => {
  it("tags each ticket page with its job-type modifier", () => {
    const woHtml = ticketPageWO(minimalWO, "INV-1", []);
    assert.match(woHtml, /class="[^"]*\bticket-type-wo\b/, "WO ticket page must carry ticket-type-wo class");

    const bsHtml = ticketPageBS(minimalBS, "INV-2", []);
    assert.match(bsHtml, /class="[^"]*\bticket-type-bs\b/, "BS ticket page must carry ticket-type-bs class");

    const wcbHtml = ticketPageWCB(makeRow(), "INV-3", []);
    assert.match(wcbHtml, /class="[^"]*\bticket-type-wcb\b/, "WCB ticket page must carry ticket-type-wcb class");
  });

  it("WCB header uses the wcb class, not bs", () => {
    const html = ticketPageWCB(makeRow(), "INV-1", []);
    assert.match(html, /class="[^"]*\bticket-header-wcb\b/, "WCB header must carry ticket-header-wcb class");
    assert.doesNotMatch(html, /class="[^"]*\bticket-header-bs\b/, "WCB header must NOT carry ticket-header-bs class");
  });

  it("scopes section labels and table headers per type in CSS", () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    assert.ok(
      css.includes(`.ticket-type-bs .items-table thead { background: ${JOB_TYPE_COLORS.billingSheet}`),
      "CSS must scope BS table header background to billingSheet color",
    );
    assert.ok(
      css.includes(`.ticket-type-wcb .ticket-section-label { color: ${JOB_TYPE_COLORS.wetCheck}`),
      "CSS must scope WCB section label color to wetCheck color",
    );
  });
});
