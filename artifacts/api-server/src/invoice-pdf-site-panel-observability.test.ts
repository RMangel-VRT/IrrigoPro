import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTicketRowsMissingControllerZoneMetadata,
  logInvoiceTicketMetadataSummary,
} from './invoice-pdf-service';

const rows = {
  workOrders: [
    {
      workOrder: { controllerLetter: null, zoneNumber: null },
      items: [{ controllerLetter: 'A', zoneNumber: 3 }],
    },
    {
      workOrder: { controllerLetter: null, zoneNumber: null },
      items: [],
    },
  ],
  billingSheets: [
    {
      billingSheet: { controllerLetter: null, zoneNumber: null },
      wetCheckView: { zones: [{ controllerLetter: 'B', zoneNumber: 2 }] },
    },
    {
      billingSheet: { controllerLetter: null, zoneNumber: null },
    },
  ],
  wetCheckBillings: [
    { wetCheckView: { zones: [{ controllerLetter: 'C', zoneNumber: 7 }] } },
    { wetCheckView: { zones: [] } },
  ],
};

describe('invoice PDF packet site metadata observability', () => {
  it('counts each ticket row once and uses item or inspected-zone fallback metadata', () => {
    assert.equal(countTicketRowsMissingControllerZoneMetadata(rows), 3);
  });

  it('emits one aggregate informational summary per invoice', () => {
    const messages: string[] = [];
    const count = logInvoiceTicketMetadataSummary('57482', rows, message => messages.push(message));

    assert.equal(count, 3);
    assert.deepEqual(messages, [
      '[PDF] Invoice 57482: 3 ticket row(s) missing controller/zone metadata',
    ]);
  });
});