/**
 * estimate-pdf-validity-window.test.ts
 *
 * Task #1955 — the estimate PDF's "Valid Until" date must describe the
 * 30-day window the app actually enforces, which runs from the last time
 * the estimate was emailed to the customer.
 *
 * The send flow is email-first: the attachment is rendered *before* the
 * new send timestamp is persisted, so the row reloaded for the PDF still
 * carries the previous send time (or none). The flow therefore passes the
 * pending send time in as `opts.sentAt`, and these tests pin that a first
 * send, a live re-delivery, and an expired resend all attach a PDF whose
 * validity date is 30 days from the send that is going out right now —
 * never a date already in the past.
 *
 * Imports the pure HTML-building module so no puppeteer/native dep is
 * pulled in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ESTIMATE_EXPIRATION_DAYS } from '@workspace/shared';
import { buildEstimateHtml, fmtDate, addDays } from './estimate-pdf-html';
import type { EstimateWithItems } from '@workspace/db';

const NOW = new Date('2026-08-27T15:00:00Z');
const daysBefore = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function makeEstimate(
  overrides: Partial<Record<string, unknown>> = {},
): EstimateWithItems {
  return {
    id: 1,
    estimateNumber: 'EST-00001',
    status: 'pending',
    internalStatus: 'sent_to_customer',
    lifecycle: 'sent',
    projectName: 'Test Project',
    projectAddress: '123 Main St',
    customerName: 'Acme Corp',
    customerEmail: 'ops@acme.test',
    customerPhone: null,
    laborRate: '85.00',
    laborMode: 'flat',
    totalLaborHours: '2.00',
    partsSubtotal: '100.00',
    laborSubtotal: '170.00',
    totalAmount: '270.00',
    estimateDate: daysBefore(40),
    approvalSentAt: null,
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

function validUntil(html: string): string {
  const match = html.match(
    /<div class="k">Valid Until<\/div><div class="v">([^<]*)<\/div>/,
  );
  assert.ok(match, 'expected a "Valid Until" field in the PDF');
  return match[1];
}

const expectedFor = (sent: Date) =>
  fmtDate(addDays(sent, ESTIMATE_EXPIRATION_DAYS));

describe('estimate PDF validity window (Task #1955)', () => {
  it('first send of an old draft is valid 30 days from today, not from the estimate date', () => {
    const html = buildEstimateHtml(
      makeEstimate({ estimateDate: daysBefore(40), approvalSentAt: null }),
      { sentAt: NOW },
    );
    assert.equal(validUntil(html), expectedFor(NOW));
  });

  it('re-delivery of a live estimate restarts the window on the attached PDF', () => {
    const html = buildEstimateHtml(
      makeEstimate({
        estimateDate: daysBefore(20),
        approvalSentAt: daysBefore(10),
      }),
      { sentAt: NOW },
    );
    assert.equal(validUntil(html), expectedFor(NOW));
  });

  it('resend of an expired estimate never attaches a PDF that is already expired', () => {
    const html = buildEstimateHtml(
      makeEstimate({
        estimateDate: daysBefore(60),
        approvalSentAt: daysBefore(ESTIMATE_EXPIRATION_DAYS + 10),
      }),
      { sentAt: NOW },
    );
    assert.equal(validUntil(html), expectedFor(NOW));
    assert.ok(
      new Date(validUntil(html)).getTime() > NOW.getTime(),
      'validity date must be in the future for a fresh resend',
    );
  });

  it('a PDF downloaded from the app reads the stored send date', () => {
    const sent = daysBefore(3);
    const html = buildEstimateHtml(
      makeEstimate({ estimateDate: daysBefore(40), approvalSentAt: sent }),
    );
    assert.equal(validUntil(html), expectedFor(sent));
  });

  it('an unsent estimate still measures from the estimate date', () => {
    const estimateDate = daysBefore(5);
    const html = buildEstimateHtml(
      makeEstimate({
        estimateDate,
        approvalSentAt: null,
        internalStatus: 'pending_review',
        lifecycle: 'pending_review',
      }),
    );
    assert.equal(validUntil(html), expectedFor(estimateDate));
  });

  it('states the terms in the same words the app enforces', () => {
    const html = buildEstimateHtml(makeEstimate({}), { sentAt: NOW });
    assert.match(
      html,
      new RegExp(
        `valid for ${ESTIMATE_EXPIRATION_DAYS} days from the date it was sent to you`,
      ),
    );
    assert.doesNotMatch(html, /from the date issued/);
  });
});
