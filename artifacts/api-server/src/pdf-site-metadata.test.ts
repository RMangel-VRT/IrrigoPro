import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPdfSitePin,
  buildPdfSiteMetadata,
  pdfControllerZoneText,
  pdfLineItemZoneLabel,
  pdfSiteMetadataLines,
} from './pdf-site-metadata';
import { buildFullCSS, JOB_TYPE_COLORS, ticketPageBS, ticketPageWO } from './pdf-helpers';
import { ticketPageWCB } from './pdf-helpers';
import { buildPdfViewModel } from './pdf-view-model';
import type {
  PdfBillingSheetRow,
  PdfWetCheckBillingRow,
  PdfWorkOrderRow,
} from './pdf-view-model';

describe('PDF site metadata contract', () => {
  it('uses the first non-blank location candidate and normalizes partial fields', () => {
    const metadata = buildPdfSiteMetadata({
      locationCandidates: ['  ', '11821 Monroe Way', 'Generic HOA Address'],
      branch: ' North ',
      controllerLabel: ' A ',
      zoneNumber: 7,
    });

    assert.deepEqual(metadata, {
      location: '11821 Monroe Way',
      branch: 'North',
      controller: 'Clock A',
      controllerLocation: null,
      zone: 'Zone 7',
      pin: null,
    });
    assert.equal(pdfControllerZoneText(metadata), 'Clock A · Zone 7');
  });

  it('supports location-only, controller-only, zone-only, and controller-plus-zone', () => {
    assert.deepEqual(
      pdfSiteMetadataLines(buildPdfSiteMetadata({ locationCandidates: ['123 Main'] })),
      [{ label: 'Location', value: '123 Main' }],
    );
    assert.equal(
      pdfControllerZoneText(buildPdfSiteMetadata({ controllerLabel: 'B' })),
      'Clock B',
    );
    assert.equal(pdfControllerZoneText(buildPdfSiteMetadata({ zoneNumber: 3 })), 'Zone 3');
    assert.equal(
      pdfControllerZoneText(buildPdfSiteMetadata({ controllerLabel: 'C', zoneNumber: 4 })),
      'Clock C · Zone 4',
    );
  });

  it('combines a stored clock letter with its controller location', () => {
    const lines = pdfSiteMetadataLines(
      buildPdfSiteMetadata({ controllerLabel: 'D', controllerLocation: 'West mechanical room' }),
    );
    assert.deepEqual(lines, [
      { label: 'Controller', value: 'Clock D — West mechanical room' },
    ]);
  });
});

const baseWorkOrder: PdfWorkOrderRow = {
  workOrderNumber: 'WO-1',
  projectName: 'Project',
  projectAddress: 'Generic HOA Address',
  workLocationAddress: 'Specific Work Site',
  branchName: null,
  controllerLetter: null,
  zoneNumber: null,
  locationNotes: '',
  technicianName: 'Tech',
  completedAt: null,
  totalHours: 0,
  laborRate: 0,
  workDescription: '',
  workSummary: '',
  aiDetailedDescription: '',
  photos: [],
  items: [],
  partsSubtotal: 0,
  laborSubtotal: 0,
  rowTotal: 0,
  approvedBy: null,
  approvedAt: null,
};

const baseBillingSheet: PdfBillingSheetRow = {
  billingNumber: 'BS-1',
  workDescription: '',
  propertyAddress: 'Generic Management Address',
  workLocationAddress: '11821 Monroe Way',
  branchName: null,
  controllerLetter: null,
  zoneNumber: null,
  technicianName: 'Tech',
  workDate: new Date('2026-01-01'),
  totalHours: 0,
  laborRate: 0,
  aiDetailedDescription: '',
  notes: '',
  photos: [],
  items: [],
  partsSubtotal: 0,
  laborSubtotal: 0,
  rowTotal: 0,
  approvedBy: null,
  approvedAt: null,
};

describe('invoice ticket location precedence', () => {
  it('prefers work-order work location over project address', () => {
    const html = ticketPageWO(baseWorkOrder, '1', []);
    assert.match(html, /Specific Work Site/);
    assert.doesNotMatch(html, /Generic HOA Address/);
  });

  it('prefers billing-sheet work location over generic property address', () => {
    const html = ticketPageBS(baseBillingSheet, '1', []);
    assert.match(html, /11821 Monroe Way/);
    assert.doesNotMatch(html, /Generic Management Address/);
  });

  it('falls back to generic addresses when no precise work location exists', () => {
    assert.match(
      ticketPageWO({ ...baseWorkOrder, workLocationAddress: '' }, '1', []),
      /Generic HOA Address/,
    );
    assert.match(
      ticketPageBS({ ...baseBillingSheet, workLocationAddress: '' }, '1', []),
      /Generic Management Address/,
    );
  });
});
// ── Task #1959 fixtures ──────────────────────────────────────────────────────

function makeWcbRow(zones: Array<{ controllerLetter: string; zoneNumber: number }>): PdfWetCheckBillingRow {
  return {
    wetCheckBillingId: 42,
    wetCheckBilling: {
      id: 42,
      billingNumber: 'WCB-2026-001',
      wetCheckId: 5,
      customerId: 10,
      technicianName: 'Jane Smith',
      workDate: new Date('2026-05-15').toISOString(),
      totalHours: '2.5',
      laborRate: '80.00',
      appliedLaborRate: '80.00',
      laborSubtotal: '200.00',
      partsSubtotal: '75.00',
      totalAmount: '275.00',
      photos: [],
      approvedBy: null,
      approvedAt: null,
      propertyAddress: '99 Drip Lane',
      branchName: null,
    } as any,
    wetCheckView: {
      wetCheckBillingId: 42,
      billingNumber: 'WCB-2026-001',
      customerId: 10,
      customerName: 'Drip Corp',
      workDate: new Date('2026-05-15').toISOString(),
      laborRate: '80.00',
      inspection: {
        wetCheckId: 5,
        technicianName: 'Jane Smith',
        inspectionDate: new Date('2026-05-15').toISOString(),
        propertyAddress: '99 Drip Lane',
        weather: null,
        notes: null,
      },
      zones: zones.map((zone, index) => ({
        zoneRecordId: index + 1,
        controllerLetter: zone.controllerLetter,
        zoneNumber: zone.zoneNumber,
        zoneLabel: `${zone.controllerLetter}-${zone.zoneNumber}`,
        repairLaborHours: '0.00',
        repairLaborManuallySet: false,
        lineItems: [],
        zonePartsSubtotal: '0.00',
        zoneLaborSubtotal: '0.00',
        zoneTotal: '0.00',
        zonePhotoUrls: [],
      })),
    } as any,
  } as PdfWetCheckBillingRow;
}

describe('dropped pin normalization', () => {
  it('formats coordinates to six decimals and builds a map link', () => {
    const pin = buildPdfSitePin('39.7392358', '-104.9902504');
    assert.deepEqual(pin, {
      latitude: 39.7392358,
      longitude: -104.9902504,
      coordinates: '39.739236, -104.990250',
      mapUrl: 'https://www.google.com/maps/search/?api=1&query=39.739236,-104.990250',
    });
  });

  it('refuses a half-captured or out-of-range pin rather than pointing somewhere wrong', () => {
    assert.equal(buildPdfSitePin('39.7392358', null), null);
    assert.equal(buildPdfSitePin(null, '-104.99'), null);
    assert.equal(buildPdfSitePin('', ''), null);
    assert.equal(buildPdfSitePin('not-a-number', '-104.99'), null);
    assert.equal(buildPdfSitePin(91, 0), null);
    assert.equal(buildPdfSitePin(0, 181), null);
  });

  it('treats a zero-zero pin as real, since it is in range', () => {
    assert.equal(buildPdfSitePin(0, 0)?.coordinates, '0.000000, 0.000000');
  });
});

describe('multi-value controller and zone summarization', () => {
  it('reads singular for one distinct value and plural for several', () => {
    assert.equal(
      buildPdfSiteMetadata({ zoneNumbers: [3, 3, null, undefined, ''] }).zone,
      'Zone 3',
    );
    assert.equal(buildPdfSiteMetadata({ zoneNumbers: [5, 3, 7] }).zone, 'Zones 3, 5, 7');
    assert.equal(buildPdfSiteMetadata({ controllerLabels: ['A', 'A'] }).controller, 'Clock A');
    assert.equal(
      buildPdfSiteMetadata({ controllerLabels: ['B', 'A'] }).controller,
      'Clocks A, B',
    );
  });

  it('merges the parent row value with the per-item values', () => {
    const metadata = buildPdfSiteMetadata({
      controllerLabel: 'A',
      zoneNumber: 2,
      controllerLabels: ['A', 'B'],
      zoneNumbers: [10, 2],
    });
    assert.equal(pdfControllerZoneText(metadata), 'Clocks A, B · Zones 2, 10');
  });

  it('sorts zones numerically, not as text, and keeps odd labels rather than dropping them', () => {
    assert.equal(buildPdfSiteMetadata({ zoneNumbers: [10, 9, 1] }).zone, 'Zones 1, 9, 10');
    assert.equal(buildPdfSiteMetadata({ zoneNumbers: [2, 'Drip line'] }).zone, 'Zones 2, Drip line');
  });

  it('produces no controller or zone text when nothing was recorded', () => {
    const metadata = buildPdfSiteMetadata({ controllerLabels: [null, ' '], zoneNumbers: [null] });
    assert.equal(metadata.controller, null);
    assert.equal(metadata.zone, null);
    assert.equal(pdfControllerZoneText(metadata), null);
  });
});

describe('per-line-item clock/zone label', () => {
  it('renders whichever parts exist, and nothing when neither does', () => {
    assert.equal(pdfLineItemZoneLabel('A', 3), 'Clock A · Zone 3');
    assert.equal(pdfLineItemZoneLabel('A', null), 'Clock A');
    assert.equal(pdfLineItemZoneLabel(null, 3), 'Zone 3');
    assert.equal(pdfLineItemZoneLabel(null, null), null);
    assert.equal(pdfLineItemZoneLabel(' ', ''), null);
  });
});

describe('ticket rendering — canonical site panel and pin', () => {
  it('renders the work site in one full-width panel immediately after the identity header', () => {
    const html = ticketPageWO(baseWorkOrder, '1', []);
    assert.match(html, /ticket-header-group/);
    assert.match(html, /ticket-site-panel ticket-site-panel-workOrder/);
    assert.match(html, /<div class="ticket-site-address">[\s\S]*Specific Work Site[\s\S]*<\/div>/);
    assert.ok(html.indexOf('ticket-site-panel') > html.indexOf('ticket-header ticket-header-wo'));
    assert.equal((html.match(/class="ticket-site-panel /g) ?? []).length, 1);
    assert.doesNotMatch(html, /ticket-site-block/);
    assert.doesNotMatch(html, /ticket-header-branch/);
    assert.doesNotMatch(html, /ticket-header-line3/);
  });

  it('shows the dropped pin with coordinates and a map link when one was captured', () => {
    const html = ticketPageWO(
      { ...baseWorkOrder, workLocationLat: '39.7392358', workLocationLng: '-104.9902504' },
      '1',
      [],
    );
    assert.match(html, /39\.739236, -104\.990250/);
    assert.match(html, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=39\.739236,-104\.990250/);
    assert.match(html, /Open in Maps/);
  });

  it('renders no pin markup at all when no coordinates were captured', () => {
    const html = ticketPageWO(baseWorkOrder, '1', []);
    assert.doesNotMatch(html, /ticket-site-pin/);
    assert.doesNotMatch(html, /Open in Maps/);
  });

  it('carries the billing-sheet pin onto its ticket too', () => {
    const html = ticketPageBS(
      { ...baseBillingSheet, workLocationLat: 40.5, workLocationLng: -105.25 },
      '1',
      [],
    );
    assert.match(html, /40\.500000, -105\.250000/);
  });

  it('renders a clean header with no empty labels when a ticket has no site data at all', () => {
    const html = ticketPageWO(
      { ...baseWorkOrder, projectAddress: '', workLocationAddress: '' },
      '1',
      [],
    );
    assert.doesNotMatch(html, /ticket-site-panel/);
    assert.doesNotMatch(html, /ticket-site-address/);
    assert.doesNotMatch(html, /ticket-site-pin/);
    assert.doesNotMatch(html, /Branch:/);
    assert.doesNotMatch(html, /Clock /);
    assert.doesNotMatch(html, /Zone /);
  });

  it('still shows the pin when an address was never recorded', () => {
    const html = ticketPageWO(
      { ...baseWorkOrder, projectAddress: '', workLocationAddress: '', workLocationLat: 39.5, workLocationLng: -104.5 },
      '1',
      [],
    );
    assert.match(html, /ticket-site-panel/);
    assert.doesNotMatch(html, /ticket-site-address/);
    assert.match(html, /39\.500000, -104\.500000/);
  });

  it('uses the job-type accent and keeps the header-plus-panel group together for print', () => {
    const css = buildFullCSS();
    assert.match(
      ticketPageWO(baseWorkOrder, '1', []),
      new RegExp(`--ticket-site-accent:${JOB_TYPE_COLORS.workOrder}`),
    );
    assert.match(css, /\.ticket-header-group\s*\{[^}]*page-break-inside:\s*avoid[^}]*break-inside:\s*avoid[^}]*page-break-after:\s*avoid[^}]*break-after:\s*avoid/s);
    assert.match(css, /\.ticket-site-panel\s*\{[^}]*border-left:\s*4px solid var\(--ticket-site-accent\)/s);
  });
});

describe('ticket rendering — controller and zone from where techs actually record them', () => {
  const woItem = {
    partName: 'Rotor',
    partDescription: '',
    quantity: '1',
    unitPrice: 10,
    laborHours: 0,
    rowTotal: 10,
    notes: '',
  };

  it('shows a work order clock/zone sourced only from its line items', () => {
    const html = ticketPageWO(
      {
        ...baseWorkOrder,
        controllerLetter: null,
        zoneNumber: null,
        items: [{ ...woItem, controllerLetter: 'A', zoneNumber: 3 }],
      },
      '1',
      [],
    );
    assert.match(html, /Clock A · Zone 3/);
  });

  it('summarizes a work order whose line items span several zones', () => {
    const html = ticketPageWO(
      {
        ...baseWorkOrder,
        controllerLetter: null,
        zoneNumber: null,
        items: [
          { ...woItem, partName: 'Rotor', controllerLetter: 'A', zoneNumber: 5 },
          { ...woItem, partName: 'Nozzle', controllerLetter: 'A', zoneNumber: 3 },
          { ...woItem, partName: 'Valve', controllerLetter: 'B', zoneNumber: 3 },
        ],
      },
      '1',
      [],
    );
    assert.match(html, /Clocks A, B · Zones 3, 5/);
  });

  it('labels individual line items only on a multi-zone ticket', () => {
    const multiZone = ticketPageWO(
      {
        ...baseWorkOrder,
        items: [
          { ...woItem, partName: 'Rotor', controllerLetter: 'A', zoneNumber: 5 },
          { ...woItem, partName: 'Nozzle', controllerLetter: 'A', zoneNumber: 3 },
        ],
      },
      '1',
      [],
    );
    assert.match(multiZone, /item-zone-tag">Clock A · Zone 5</);
    assert.match(multiZone, /item-zone-tag">Clock A · Zone 3</);

    const singleZone = ticketPageWO(
      { ...baseWorkOrder, items: [{ ...woItem, controllerLetter: 'A', zoneNumber: 3 }] },
      '1',
      [],
    );
    assert.doesNotMatch(singleZone, /item-zone-tag/);
  });

  it('falls back to the wet-check zone records for a billing sheet with no sheet-level values', () => {
    const html = ticketPageBS(
      {
        ...baseBillingSheet,
        controllerLetter: null,
        zoneNumber: null,
        wetCheckView: makeWcbRow([
          { controllerLetter: 'C', zoneNumber: 4 },
          { controllerLetter: 'C', zoneNumber: 9 },
        ]).wetCheckView,
      },
      '1',
      [],
    );
    assert.match(html, /Clock C · Zones 4, 9/);
  });

  it('shows clock and zone on a wet-check billing ticket, which previously could not render them', () => {
    const html = ticketPageWCB(makeWcbRow([{ controllerLetter: 'D', zoneNumber: 2 }]), 'INV-1', []);
    assert.match(html, /Clock D · Zone 2/);
  });

  it('omits the clock/zone line on a wet-check billing ticket with no inspected zones', () => {
    const html = ticketPageWCB(makeWcbRow([]), 'INV-1', []);
    assert.doesNotMatch(html, /Clock /);
    assert.doesNotMatch(html, /Zone /);
  });
});

describe('site text is escaped, not rendered as markup', () => {
  const HOSTILE = '<script>alert(1)</script>';

  it('escapes a hostile work-site address instead of injecting it into the PDF document', () => {
    const html = ticketPageWO(
      { ...baseWorkOrder, workLocationAddress: HOSTILE, projectAddress: '' },
      '1',
      [],
    );
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('escapes hostile location notes, branch names, and controller labels', () => {
    const html = ticketPageWO(
      {
        ...baseWorkOrder,
        locationNotes: HOSTILE,
        branchName: '<b>North</b>',
        controllerLetter: '<i>A</i>',
        zoneNumber: 3,
      },
      '1',
      [],
    );
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<b>North<\/b>/);
    assert.doesNotMatch(html, /<i>A<\/i>/);
    assert.match(html, /&lt;b&gt;North&lt;\/b&gt;/);
    assert.match(html, /&lt;i&gt;A&lt;\/i&gt;/);
  });

  it('escapes a hostile controller label inside a per-line zone tag', () => {
    const html = ticketPageWO(
      {
        ...baseWorkOrder,
        controllerLetter: null,
        zoneNumber: null,
        items: [
          { partName: 'Rotor', partDescription: '', quantity: '1', unitPrice: 10, laborHours: 0, rowTotal: 10, notes: '', controllerLetter: '"><script>x</script>', zoneNumber: 5 },
          { partName: 'Nozzle', partDescription: '', quantity: '1', unitPrice: 10, laborHours: 0, rowTotal: 10, notes: '', controllerLetter: 'A', zoneNumber: 9 },
        ],
      } as PdfWorkOrderRow,
      '1',
      [],
    );
    assert.doesNotMatch(html, /<script>x<\/script>/);
    assert.match(html, /item-zone-tag/);
  });

  it('escapes hostile wet-check zone data on the WCB ticket', () => {
    const html = ticketPageWCB(
      makeWcbRow([{ controllerLetter: '<img src=x onerror=y>', zoneNumber: 4 }]),
      'INV-1',
      [],
    );
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=y&gt;/);
  });

  it('leaves a legitimate generated map link intact and clickable', () => {
    const html = ticketPageWO(
      { ...baseWorkOrder, workLocationLat: 39.5, workLocationLng: -104.5 },
      '1',
      [],
    );
    assert.match(html, /<a href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=39\.500000,-104\.500000">Open in Maps<\/a>/);
  });
});

describe('end-to-end — raw invoice data reaches the rendered ticket', () => {
  it('carries coordinates and per-item clock/zone from raw rows through buildPdfViewModel into the ticket', () => {
    const result = buildPdfViewModel({
      invoice: {
        invoiceNumber: 'INV-E2E',
        periodStart: new Date('2026-05-01'),
        periodEnd: new Date('2026-05-31'),
        customerName: 'Acme',
        customerEmail: '',
        customerPhone: '',
        items: [],
      },
      company: { name: 'Verde' },
      workOrders: [
        {
          workOrder: {
            id: 1,
            workOrderNumber: 'WO-E2E',
            workLocationAddress: '11821 Monroe Way',
            workLocationLat: '39.7392358',
            workLocationLng: '-104.9902504',
            controllerLetter: null,
            zoneNumber: null,
            totalHours: '2',
            appliedLaborRate: '85',
            laborSubtotal: '170',
            totalPartsCost: '40',
            totalAmount: '210',
            photos: [],
          },
          items: [
            { partName: 'Rotor', quantity: '1', partPrice: '20', totalPrice: '20', controllerLetter: 'A', zoneNumber: 7 },
            { partName: 'Nozzle', quantity: '1', partPrice: '20', totalPrice: '20', controllerLetter: 'B', zoneNumber: 2 },
          ],
        },
      ],
      billingSheets: [],
      laborRate: '85',
    } as any);

    const row = result.viewModel.workOrders[0];
    const html = ticketPageWO(row, 'INV-E2E', []);

    // Site details survive the mapper.
    assert.match(html, /11821 Monroe Way/);
    assert.match(html, /39\.739236, -104\.990250/);
    assert.match(html, /Clocks A, B · Zones 2, 7/);
    assert.match(html, /item-zone-tag">Clock A · Zone 7</);

    // The financial snapshot is untouched by any of it.
    assert.match(html, /\$170\.00/);
    assert.match(html, /\$40\.00/);
    assert.match(html, /\$210\.00/);
  });
});
