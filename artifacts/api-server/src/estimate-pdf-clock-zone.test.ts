/**
 * estimate-pdf-clock-zone.test.ts
 *
 * Proves that the estimate PDF renders the Clock / Zone line in the
 * "Project / Work Site" section when controllerLetter / zoneNumber are
 * populated, and omits it entirely when both fields are null/undefined.
 *
 * Imports from estimate-pdf-html.ts (the pure HTML-building module) so the
 * test can run without pulling in puppeteer-core or any other native dep.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEstimateHtml } from './estimate-pdf-html';
import type { EstimateWithItems } from '@workspace/db';

// ── Minimal fixture ───────────────────────────────────────────────────────────

function makeEstimate(
  overrides: Partial<Record<string, unknown>> = {},
): EstimateWithItems {
  return {
    id: 1,
    estimateNumber: 'EST-00001',
    status: 'pending',
    internalStatus: 'pending_review',
    lifecycle: 'pending_review',
    projectName: 'Test Project',
    projectAddress: '123 Main St',
    customerName: 'Acme Corp',
    customerEmail: null,
    customerPhone: null,
    laborRate: '85.00',
    laborMode: 'flat',
    totalLaborHours: '2.00',
    partsSubtotal: '100.00',
    laborSubtotal: '170.00',
    totalAmount: '270.00',
    estimateDate: new Date('2026-06-01'),
    workDescription: null,
    locationNotes: null,
    accessInstructions: null,
    workLocationLat: null,
    workLocationLng: null,
    workLocationAddress: null,
    controllerLetter: null,
    zoneNumber: null,
    items: [],
    ...overrides,
  } as unknown as EstimateWithItems;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildEstimateHtml — Clock / Zone line (Project / Work Site section)', () => {
  it('prefers the pinned work location address over the generic project address', () => {
    const html = buildEstimateHtml(makeEstimate({
      projectAddress: 'Generic Project Address',
      workLocationAddress: 'Specific Pinned Address',
    }));
    assert.ok(html.includes('Specific Pinned Address'));
    assert.ok(!html.includes('Generic Project Address'));
  });
  it('renders "Clock A · Zone 12" when both fields are set', () => {
    const html = buildEstimateHtml(
      makeEstimate({ controllerLetter: 'A', zoneNumber: 12 }),
    );

    assert.ok(html.includes('Clock A'), 'Expected "Clock A" in the output');
    assert.ok(html.includes('Zone 12'), 'Expected "Zone 12" in the output');
    assert.ok(
      html.includes('Clock A \u00b7 Zone 12'),
      'Expected middle-dot separator "Clock A · Zone 12" in the output',
    );
  });

  it('omits the Clock/Zone line entirely when both fields are null', () => {
    const html = buildEstimateHtml(
      makeEstimate({ controllerLetter: null, zoneNumber: null }),
    );

    assert.ok(
      !html.includes('Clock'),
      'Expected no "Clock" text when controllerLetter is null',
    );
    assert.ok(
      !html.includes('Zone'),
      'Expected no "Zone" text when zoneNumber is null',
    );
  });

  it('renders only "Clock B" (no Zone) when zoneNumber is null', () => {
    const html = buildEstimateHtml(
      makeEstimate({ controllerLetter: 'B', zoneNumber: null }),
    );

    assert.ok(html.includes('Clock B'), 'Expected "Clock B" in the output');
    assert.ok(!html.includes('Zone'), 'Expected no "Zone" text when zoneNumber is null');
  });

  it('renders only "Zone 7" (no Clock) when controllerLetter is null', () => {
    const html = buildEstimateHtml(
      makeEstimate({ controllerLetter: null, zoneNumber: 7 }),
    );

    assert.ok(html.includes('Zone 7'), 'Expected "Zone 7" in the output');
    assert.ok(!html.includes('Clock'), 'Expected no "Clock" text when controllerLetter is null');
  });
});
