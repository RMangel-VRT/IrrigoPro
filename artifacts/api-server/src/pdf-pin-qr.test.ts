import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import {
  PDF_PIN_QR_SIZE,
  generatePdfPinQrDataUri,
  preloadPinQrs,
} from './pdf-generator';
import { buildPdfWorkOrderSiteMetadata, buildFullCSS, ticketPageWO } from './pdf-helpers';
import type { PdfWorkOrderRow } from './pdf-view-model';

const pinnedWorkOrder: PdfWorkOrderRow = {
  workOrderNumber: 'WO-QR-1',
  projectName: 'QR Project',
  projectAddress: '123 Long Address Boulevard, Suite 400, Denver, Colorado 80202',
  workLocationLat: 39.7392364,
  workLocationLng: -104.9902508,
  branchName: null,
  controllerLetter: null,
  zoneNumber: null,
  locationNotes: '',
  technicianName: 'QR Tech',
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

describe('billing PDF pin QR generator', () => {
  it('generates the requested URL as a 148px medium-error-correction PNG data URI', async () => {
    const mapUrl = buildPdfWorkOrderSiteMetadata(pinnedWorkOrder).pin?.mapUrl;
    assert.ok(mapUrl);

    const actual = await generatePdfPinQrDataUri(mapUrl);
    const expected = await QRCode.toDataURL(mapUrl, {
      type: 'image/png',
      width: PDF_PIN_QR_SIZE,
      errorCorrectionLevel: 'M',
      margin: 1,
    });

    assert.equal(actual, expected);
    assert.match(actual, /^data:image\/png;base64,/);

    const png = Buffer.from(actual.slice(actual.indexOf(',') + 1), 'base64');
    assert.equal(png.readUInt32BE(16), 148);
    assert.equal(png.readUInt32BE(20), 148);
  });

  it('hands the exact normalized visible-link URL to the QR generator', async () => {
    const site = buildPdfWorkOrderSiteMetadata(pinnedWorkOrder);
    assert.ok(site.pin);
    const received: string[] = [];

    const [qrDataUri] = await preloadPinQrs(
      [{
        mapUrl: site.pin.mapUrl,
        invoiceNumber: '57482',
        ticketLabel: 'Work Order WO-QR-1',
      }],
      async mapUrl => {
        received.push(mapUrl);
        return 'data:image/png;base64,QRDATA';
      },
    );
    const html = ticketPageWO(
      pinnedWorkOrder,
      '57482',
      [],
      null,
      undefined,
      qrDataUri,
    );

    assert.deepEqual(received, [site.pin.mapUrl]);
    assert.ok(html.includes(`href="${site.pin.mapUrl.replace('&', '&amp;')}"`));
    assert.match(html, /src="data:image\/png;base64,QRDATA"/);
  });

  it('starts every pinned row concurrently and skips rows without pins', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const started: string[] = [];

    const pending = preloadPinQrs(
      [
        { mapUrl: 'https://maps.example/1', invoiceNumber: '57482', ticketLabel: 'Work Order 1' },
        { mapUrl: null, invoiceNumber: '57482', ticketLabel: 'Work Order 2' },
        { mapUrl: 'https://maps.example/3', invoiceNumber: '57482', ticketLabel: 'Billing Sheet 3' },
        { mapUrl: 'https://maps.example/4', invoiceNumber: '57482', ticketLabel: 'Billing Sheet 4' },
      ],
      async mapUrl => {
        started.push(mapUrl);
        await gate;
        return `data:image/png;base64,${mapUrl.at(-1)}`;
      },
    );

    await Promise.resolve();
    assert.deepEqual(started, [
      'https://maps.example/1',
      'https://maps.example/3',
      'https://maps.example/4',
    ]);

    release();
    assert.deepEqual(await pending, [
      'data:image/png;base64,1',
      null,
      'data:image/png;base64,3',
      'data:image/png;base64,4',
    ]);
  });

  it('isolates one failure, identifies its invoice and ticket, and preserves other QRs', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const result = await preloadPinQrs(
        [
          { mapUrl: 'https://maps.example/ok-1', invoiceNumber: '57482', ticketLabel: 'Work Order WO-1' },
          { mapUrl: 'https://maps.example/fail', invoiceNumber: '57482', ticketLabel: 'Billing Sheet BS-2' },
          { mapUrl: 'https://maps.example/ok-3', invoiceNumber: '57482', ticketLabel: 'Work Order WO-3' },
        ],
        async mapUrl => {
          if (mapUrl.endsWith('/fail')) throw new Error('encoder unavailable');
          return `data:image/png;base64,${mapUrl.slice(-4)}`;
        },
      );

      assert.deepEqual(result, [
        'data:image/png;base64,ok-1',
        null,
        'data:image/png;base64,ok-3',
      ]);
      assert.deepEqual(warnings, [[
        '[PDF] Invoice 57482: Billing Sheet BS-2 pin QR generation failed — encoder unavailable',
      ]]);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('billing PDF pin QR panel', () => {
  it('renders a decorative 74px QR and caption only when both pin and asset exist', () => {
    const html = ticketPageWO(
      pinnedWorkOrder,
      '57482',
      [],
      null,
      undefined,
      'data:image/png;base64,QRDATA',
    );

    assert.match(html, /class="ticket-site-qr"/);
    assert.match(html, /class="ticket-site-qr-image" width="74" height="74" alt="" aria-hidden="true"/);
    assert.match(html, /Scan for pin/);
  });

  it('reserves no QR space without a valid pin, even if an asset is supplied', () => {
    const html = ticketPageWO(
      { ...pinnedWorkOrder, workLocationLat: null, workLocationLng: null },
      '57482',
      [],
      null,
      undefined,
      'data:image/png;base64,SHOULD_NOT_RENDER',
    );

    assert.doesNotMatch(html, /ticket-site-qr|SHOULD_NOT_RENDER|Scan for pin/);
  });

  it('keeps coordinates and map link after QR failure without a broken placeholder', () => {
    const html = ticketPageWO(pinnedWorkOrder, '57482', [], null, undefined, null);

    assert.match(html, /Pin 39\.739236, -104\.990251/);
    assert.match(html, /Open in Maps/);
    assert.doesNotMatch(html, /ticket-site-qr|Scan for pin|alt="QR|QR unavailable/);
  });

  it('keeps the QR fixed and lets adjacent content shrink and wrap', () => {
    const css = buildFullCSS();

    assert.match(css, /\.ticket-site-pin\s*\{[^}]*min-width:\s*0/s);
    assert.match(css, /\.ticket-site-qr\s*\{[^}]*flex:\s*0 0 74px[^}]*width:\s*74px/s);
    assert.match(css, /\.ticket-site-qr-image\s*\{[^}]*width:\s*74px[^}]*height:\s*74px[^}]*image-rendering:\s*pixelated/s);
  });
});