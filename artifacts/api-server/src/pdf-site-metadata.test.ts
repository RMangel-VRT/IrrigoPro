import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPdfSiteMetadata,
  pdfControllerZoneText,
  pdfSiteMetadataLines,
} from './pdf-site-metadata';
import { ticketPageBS, ticketPageWO } from './pdf-helpers';
import type { PdfBillingSheetRow, PdfWorkOrderRow } from './pdf-view-model';

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