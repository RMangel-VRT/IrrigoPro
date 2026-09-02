/**
 * pdf-ticket-parity.test.ts  (Slice 4)
 *
 * Pins the shared structural contract between ticketPageBS and ticketPageWCB.
 * Both renderers share the same outer chrome, financial layout,
 * and photo gallery pattern. This file asserts 15 shared CSS classes, 4 shared
 * labels, the three intentional differences, and a TOTAL value sanity check, then
 * snapshots both renderers so any future drift is caught in CI.
 *
 * Intentional differences (by design):
 *   - Title: "Billing Sheet #…" vs "WC Billing #…"
 *   - BS includes a WORK PERFORMED section; WCB does not
 *   - WCB parts block uses zone-block divs; BS (no wetCheckView) uses a flat <table>
 *
 * No production file under artifacts/api-server/src/pdf-*.ts is modified.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ticketPageBS,
  ticketPageWCB,
  ticketPageWO,
  partsBlockForWetCheckBS,
  reconciliationPage,
  buildFullCSS,
  FAILED_PHOTO_SENTINEL,
  PDF_PIN_ICON,
  PDF_BRANCH_ICON,
  PDF_CLOCK_ICON,
  PDF_WARNING_ICON,
  PDF_INFO_ICON,
  JOB_TYPE_COLORS,
} from "./pdf-helpers.js";
import { DEFAULT_BRAND_COLORS } from "./pdf-view-model.js";
import type { PdfWorkOrderRow, PdfBillingSheetRow, PdfBillingSheetItemRow } from "./pdf-view-model.js";
import type { PdfWetCheckBillingRow } from "./pdf-view-model.js";

// ── snapshot helper ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SNAP_DIR = resolve(__dirname, "__snapshots__");
const SNAP_FILE = resolve(SNAP_DIR, "pdf-ticket-parity.test.ts.snap");

type SnapStore = Record<string, string>;

function loadSnapStore(): SnapStore {
  if (existsSync(SNAP_FILE)) {
    try {
      return JSON.parse(readFileSync(SNAP_FILE, "utf8")) as SnapStore;
    } catch {
      return {};
    }
  }
  return {};
}

const snapStore: SnapStore = loadSnapStore();
let snapDirty = false;

function toMatchSnapshot(name: string, value: string): void {
  if (snapStore[name] === undefined || process.env.UPDATE_SNAPSHOTS === "1") {
    snapStore[name] = value;
    snapDirty = true;
  } else {
    assert.equal(value, snapStore[name], `Snapshot "${name}" has changed`);
  }
}

process.on("exit", () => {
  if (snapDirty) {
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(SNAP_FILE, JSON.stringify(snapStore, null, 2) + "\n");
  }
});

// ── shared constants ──────────────────────────────────────────────────────────

const SHARED_CLASSES: string[] = [
  "ticket-page",
  "ticket-header",
  "ticket-header-group",
  "ticket-header-condensed",
  "ticket-header-line1",
  "ticket-header-line2",
  "ticket-site-panel",
  "ticket-site-address",
  "ticket-section",
  "ticket-financial",
  "ticket-section-label",
  "ticket-fin-rows",
  "ticket-fin-row",
  "ticket-fin-label",
  "ticket-fin-value",
  "ticket-fin-total",
];

const SHARED_LABELS: string[] = [
  "FINANCIAL BREAKDOWN",
  "Irrigation Labor",
  "Parts Subtotal",
  "TOTAL",
];

// ── fixtures ──────────────────────────────────────────────────────────────────
// Identical financial values: 3 hrs × $85 = $255 labor, $100 parts, $355 total
// Same approval state and property address for structural parity.

const INVOICE_NUMBER = "INV-PARITY-001";
const APPROVED_BY = "Manager Parity";
const APPROVED_AT = new Date("2026-05-20T10:00:00.000Z");
const PROPERTY_ADDRESS = "42 Parity Lane, Springfield";

const BS_ITEM: PdfBillingSheetItemRow = {
  partName: "Rotor Head",
  partDescription: "Hunter PGP Rotor",
  quantity: "2",
  unitPrice: 50,
  laborHours: 1,
  rowTotal: 100,
  notes: "",
};

const bsFixture: PdfBillingSheetRow = {
  billingNumber: "BS-PARITY-TEST",
  workDescription: "Replaced rotor heads and adjusted zones",
  aiDetailedDescription: "",
  propertyAddress: PROPERTY_ADDRESS,
  branchName: null,
  controllerLetter: null,
  zoneNumber: null,
  technicianName: "Parity Tech",
  workDate: new Date("2026-05-20"),
  totalHours: 3,
  laborRate: 85,
  notes: "",
  photos: [],
  items: [BS_ITEM],
  partsSubtotal: 100,
  laborSubtotal: 255,
  rowTotal: 355,
  approvedBy: APPROVED_BY,
  approvedAt: APPROVED_AT,
  // no wetCheckView — ensures flat partsTableFromBS path
};

const wcbFixture: PdfWetCheckBillingRow = {
  wetCheckBillingId: 99,
  wetCheckBilling: {
    id: 99,
    billingNumber: "WCB-PARITY-TEST",
    wetCheckId: 7,
    customerId: 20,
    technicianName: "Parity Tech",
    workDate: new Date("2026-05-20").toISOString(),
    totalHours: "3",
    laborRate: "85.00",
    appliedLaborRate: "85.00",
    laborSubtotal: "255.00",
    partsSubtotal: "100.00",
    totalAmount: "355.00",
    photos: [],
    approvedBy: APPROVED_BY,
    approvedAt: APPROVED_AT.toISOString(),
    propertyAddress: PROPERTY_ADDRESS,
    branchName: null,
    billedAt: null,
    invoiceId: null,
    status: "approved_passed_to_billing",
    createdAt: new Date("2026-05-20"),
    updatedAt: new Date("2026-05-20"),
  } as any,
  wetCheckView: {
    wetCheckBillingId: 99,
    billingNumber: "WCB-PARITY-TEST",
    customerId: 20,
    customerName: "Parity Corp",
    workDate: new Date("2026-05-20").toISOString(),
    laborRate: "85.00",
    inspection: {
      wetCheckId: 7,
      technicianName: "Parity Tech",
      inspectionDate: new Date("2026-05-20").toISOString(),
      propertyAddress: PROPERTY_ADDRESS,
      weather: "Sunny",
      notes: null,
    },
    zones: [
      {
        controllerLetter: "A",
        zoneNumber: 1,
        zoneLabel: "A-1",
        repairLaborHours: "3.00",
        lineItems: [
          {
            findingId: 10,
            issueType: "head_replacement",
            issueDisplayLabel: "Head Replacement",
            partName: "Rotor Head",
            quantity: 2,
            unitPrice: "50.00",
            partsTotal: "100.00",
            laborHours: "3.00",
            laborTotal: "255.00",
            lineTotal: "355.00",
            noPartNeeded: false,
            notes: null,
          },
        ],
        zonePartsSubtotal: "100.00",
        zoneLaborSubtotal: "255.00",
        zoneTotal: "355.00",
      },
    ],
    repairsSummary: "1 repair across 1 zone",
    partsSubtotal: "100.00",
    laborSubtotal: "255.00",
    grandTotal: "355.00",
  } as any,
};

const woFixture: PdfWorkOrderRow = {
  workOrderNumber: "WO-PARITY-TEST",
  projectName: "Parity Project",
  projectAddress: PROPERTY_ADDRESS,
  branchName: "North Campus",
  controllerLetter: "B",
  zoneNumber: 2,
  locationNotes: "",
  technicianName: "Parity Tech",
  completedAt: APPROVED_AT,
  totalHours: 3,
  laborRate: 85,
  workDescription: "Replaced rotor heads",
  workSummary: "",
  aiDetailedDescription: "",
  photos: [],
  items: [],
  partsSubtotal: 100,
  laborSubtotal: 255,
  rowTotal: 355,
  approvedBy: null,
  approvedAt: null,
};

// ── render once, reuse across all assertions ──────────────────────────────────

const bsHtml = ticketPageBS(bsFixture, INVOICE_NUMBER, [], null, undefined, DEFAULT_BRAND_COLORS);
const wcbHtml = ticketPageWCB(wcbFixture, INVOICE_NUMBER, [], null, undefined, DEFAULT_BRAND_COLORS);
const pinnedQrHtml = ticketPageWO(
  {
    ...woFixture,
    workLocationLat: 39.7392364,
    workLocationLng: -104.9902508,
  },
  INVOICE_NUMBER,
  [],
  null,
  undefined,
  "data:image/png;base64,QR-SNAPSHOT",
);

// ── shared structural assertions ──────────────────────────────────────────────

describe("ticketPageBS + ticketPageWCB — shared CSS classes (Slice 4)", () => {
  for (const cls of SHARED_CLASSES) {
    it(`both renderers contain class "${cls}"`, () => {
      assert.match(bsHtml, new RegExp(`class="[^"]*\\b${cls}\\b`), `BS missing class ${cls}`);
      assert.match(wcbHtml, new RegExp(`class="[^"]*\\b${cls}\\b`), `WCB missing class ${cls}`);
    });
  }
});

describe("ticketPageBS + ticketPageWCB — shared labels (Slice 4)", () => {
  for (const label of SHARED_LABELS) {
    it(`both renderers contain label "${label}"`, () => {
      assert.ok(bsHtml.includes(label), `BS missing label: ${label}`);
      assert.ok(wcbHtml.includes(label), `WCB missing label: ${label}`);
    });
  }
});

// ── intentional differences ───────────────────────────────────────────────────

describe("ticketPageBS + ticketPageWCB — intentional differences (Slice 4)", () => {
  it("BS title starts with 'Billing Sheet #'; WCB title starts with 'WC Billing #'", () => {
    assert.match(bsHtml, /Billing Sheet #BS-PARITY-TEST/, "BS must show 'Billing Sheet #...' in header");
    assert.match(wcbHtml, /WC Billing #WCB-PARITY-TEST/, "WCB must show 'WC Billing #...' in header");
    assert.doesNotMatch(bsHtml, /WC Billing #/, "BS must NOT contain 'WC Billing #'");
    assert.doesNotMatch(wcbHtml, /Billing Sheet #/, "WCB must NOT contain 'Billing Sheet #'");
  });

  it("BS includes WORK PERFORMED section; WCB does not", () => {
    assert.match(bsHtml, /WORK PERFORMED/, "BS must include WORK PERFORMED section");
    assert.doesNotMatch(wcbHtml, /WORK PERFORMED/, "WCB must NOT include WORK PERFORMED section");
  });

  it("BS uses ticket-header-bs (amber); WCB uses ticket-header-wcb (green)", () => {
    assert.match(bsHtml, /class="[^"]*\bticket-header-bs\b/, "BS must use ticket-header-bs class");
    assert.doesNotMatch(bsHtml, /class="[^"]*\bticket-header-wcb\b/, "BS must NOT use ticket-header-wcb class");
    assert.match(wcbHtml, /class="[^"]*\bticket-header-wcb\b/, "WCB must use ticket-header-wcb class");
    assert.doesNotMatch(wcbHtml, /class="[^"]*\bticket-header-bs\b/, "WCB must NOT use ticket-header-bs class");
  });

  it("WCB parts block uses zone-block divs; BS (no wetCheckView) uses a flat table", () => {
    assert.match(wcbHtml, /class="[^"]*\bzone-block\b/, "WCB must render zone-block div for parts");
    assert.doesNotMatch(bsHtml, /class="[^"]*\bzone-block\b/, "BS without wetCheckView must NOT render zone-block");
    assert.match(bsHtml, /<table/, "BS without wetCheckView must render a flat <table> for parts");
  });
});

describe("ticketPageWCB — historical snapshot metadata", () => {
  it("prefers the billing snapshot address over a later inspection address", () => {
    const html = ticketPageWCB({
      ...wcbFixture,
      wetCheckBilling: {
        ...wcbFixture.wetCheckBilling,
        propertyAddress: "Captured Billing Address",
      },
      wetCheckView: {
        ...wcbFixture.wetCheckView,
        inspection: {
          ...wcbFixture.wetCheckView.inspection,
          propertyAddress: "Later Inspection Address",
        },
      },
    }, INVOICE_NUMBER, [], null, undefined, DEFAULT_BRAND_COLORS);

    assert.match(html, /Captured Billing Address/);
    assert.doesNotMatch(html, /Later Inspection Address/);
  });
});

describe("all invoice ticket families — canonical site panel", () => {
  const woHtml = ticketPageWO(woFixture, INVOICE_NUMBER, []);
  const tickets = [woHtml, bsHtml, wcbHtml];

  it("renders exactly one panel after the identity header and no legacy in-header site markup", () => {
    for (const html of tickets) {
      assert.equal((html.match(/class="ticket-site-panel /g) ?? []).length, 1);
      assert.ok(html.indexOf("ticket-site-panel") > html.indexOf("ticket-header ticket-header-"));
      assert.doesNotMatch(html, /ticket-site-block|ticket-header-branch/);
    }
  });

  it("uses each ticket family's fixed accent", () => {
    assert.match(woHtml, new RegExp(`--ticket-site-accent:${JOB_TYPE_COLORS.workOrder}`));
    assert.match(bsHtml, new RegExp(`--ticket-site-accent:${JOB_TYPE_COLORS.billingSheet}`));
    assert.match(wcbHtml, new RegExp(`--ticket-site-accent:${JOB_TYPE_COLORS.wetCheck}`));
  });
});

// ── approval text absent from PDF (Task #1193) ────────────────────────────────

describe("ticketPageBS + ticketPageWCB — approval text absent from PDF (Task #1193)", () => {
  it("BS does not contain 'Approved By:' or 'Approved At:'", () => {
    assert.doesNotMatch(bsHtml, /Approved By:/, "BS must not render Approved By in PDF");
    assert.doesNotMatch(bsHtml, /Approved At:/, "BS must not render Approved At in PDF");
    assert.doesNotMatch(bsHtml, /ticket-approval/, "BS must not render ticket-approval block in PDF");
  });

  it("WCB does not contain 'Approved By:' or 'Approved At:'", () => {
    assert.doesNotMatch(wcbHtml, /Approved By:/, "WCB must not render Approved By in PDF");
    assert.doesNotMatch(wcbHtml, /Approved At:/, "WCB must not render Approved At in PDF");
    assert.doesNotMatch(wcbHtml, /ticket-approval/, "WCB must not render ticket-approval block in PDF");
  });
});

// ── TOTAL value sanity ────────────────────────────────────────────────────────

describe("ticketPageBS + ticketPageWCB — TOTAL value sanity (Slice 4)", () => {
  it("both renderers show $355.00 as the TOTAL", () => {
    assert.match(bsHtml, /TOTAL[\s\S]*?\$355\.00/, "BS TOTAL must be $355.00");
    assert.match(wcbHtml, /TOTAL[\s\S]*?\$355\.00/, "WCB TOTAL must be $355.00");
  });
});

describe("invoice ticket metadata — font-independent icons (Task #1968)", () => {
  it("uses inline SVG pin, branch, and clock icons in all three ticket builders", () => {
    const bsWithMetadata = ticketPageBS(
      { ...bsFixture, branchName: "North Campus", controllerLetter: "A", zoneNumber: 1 },
      INVOICE_NUMBER,
      [],
      null,
      undefined,
      DEFAULT_BRAND_COLORS,
    );
    const wcbWithMetadata = ticketPageWCB(
      {
        ...wcbFixture,
        wetCheckBilling: { ...wcbFixture.wetCheckBilling, branchName: "North Campus" },
      },
      INVOICE_NUMBER,
      [],
      null,
      undefined,
      DEFAULT_BRAND_COLORS,
    );
    const woHtml = ticketPageWO(woFixture, INVOICE_NUMBER, []);
    const ticketHtml = [bsWithMetadata, wcbWithMetadata, woHtml];

    for (const html of ticketHtml) {
      assert.match(html, /class="pdf-inline-icon"/, "ticket must contain inline SVG metadata icons");
      assert.match(html, /aria-hidden="true"/, "metadata icons must be hidden from assistive technology");
      assert.match(html, /stroke="currentColor"/, "metadata icons must inherit surrounding text color");
      assert.doesNotMatch(html, /&#(?:128205|127970|128336);/, "ticket must not contain known emoji entity glyphs");
    }

    assert.match(bsWithMetadata, new RegExp(PDF_PIN_ICON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(bsWithMetadata, new RegExp(PDF_BRANCH_ICON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(bsWithMetadata, new RegExp(PDF_CLOCK_ICON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("includes one shared print alignment rule for metadata icons", () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    const rule = css.match(/\.pdf-inline-icon\s*\{[^}]+\}/)?.[0];

    assert.ok(rule, "shared .pdf-inline-icon rule must be present");
    assert.match(rule, /display:\s*inline-block/);
    assert.match(rule, /width:\s*1em/);
    assert.match(rule, /height:\s*1em/);
    assert.match(rule, /vertical-align:\s*-0\.15em/);
    assert.match(rule, /flex:\s*0 0 auto/);
  });

  it("uses inline SVGs in photo, stale-labor, and reconciliation warnings", () => {
    const photoWarningHtml = [
      ticketPageWO(woFixture, INVOICE_NUMBER, [FAILED_PHOTO_SENTINEL]),
      ticketPageBS(bsFixture, INVOICE_NUMBER, [FAILED_PHOTO_SENTINEL]),
      ticketPageWCB(wcbFixture, INVOICE_NUMBER, [FAILED_PHOTO_SENTINEL]),
    ];
    const staleLaborHtml = partsBlockForWetCheckBS({
      ...wcbFixture.wetCheckView,
      zonesHaveStaleLaborData: true,
    });
    const reconciliationHtml = reconciliationPage({
      workOrders: [],
      billingSheets: [],
      wetCheckBillings: [],
      totals: {
        laborSubtotal: 0,
        partsSubtotal: 0,
        grandTotal: 0,
      },
      validationWarning: "Invoice totals need review",
      customerHasBranches: false,
      branchSubtotals: [],
      invoice: {
        invoiceNumber: INVOICE_NUMBER,
        periodStart: new Date("2026-05-01"),
        periodEnd: new Date("2026-05-31"),
      },
    } as any);

    for (const html of photoWarningHtml) {
      assert.ok(html.includes(PDF_WARNING_ICON), "photo warning must use the shared SVG warning icon");
    }
    assert.ok(staleLaborHtml.includes(PDF_INFO_ICON), "stale labor note must use the shared SVG info icon");
    assert.ok(reconciliationHtml.includes(PDF_WARNING_ICON), "reconciliation warning must use the shared SVG warning icon");

    for (const html of [...photoWarningHtml, staleLaborHtml, reconciliationHtml]) {
      assert.doesNotMatch(
        html,
        /&#(?:128205|127970|128336|9888|9432);/,
        "invoice PDF HTML must not contain known emoji entity glyphs",
      );
    }
  });
});

// ── snapshots ─────────────────────────────────────────────────────────────────

describe("ticketPageBS — snapshot (Slice 4)", () => {
  it("matches stored snapshot", () => {
    toMatchSnapshot("ticketPageBS", bsHtml);
  });
});

describe("ticketPageWCB — snapshot (Slice 4)", () => {
  it("matches stored snapshot", () => {
    toMatchSnapshot("ticketPageWCB", wcbHtml);
  });
});

describe("ticket pin QR — focused snapshot", () => {
  it("matches the reviewed QR-only block", () => {
    const qrBlock = pinnedQrHtml.match(
      /<div class="ticket-site-qr">[\s\S]*?<\/div>/,
    )?.[0];
    assert.ok(qrBlock, "pinned ticket must contain the QR block");
    toMatchSnapshot("ticketPinQrBlock", qrBlock);
  });
});
