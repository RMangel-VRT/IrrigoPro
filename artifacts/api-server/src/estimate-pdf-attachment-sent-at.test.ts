/**
 * estimate-pdf-attachment-sent-at.test.ts
 *
 * Task #1955 — wiring proof for the PDF that gets attached to the
 * approval email. The send flow is email-first: it renders the
 * attachment before it persists the new send timestamp, so the estimate
 * row this service reloads still carries the *previous* send time. The
 * flow therefore hands the pending send time down, and this test pins
 * that the service forwards it to the renderer instead of silently
 * letting the stale stored value decide the validity window.
 *
 * Requires --experimental-test-module-mocks (see the registered
 * validation command) so the puppeteer-backed renderer can be stubbed.
 */

import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

type RenderCall = { estimateId: number; sentAt: unknown };
const calls: RenderCall[] = [];

let generateEstimatePdfForEmail: typeof import('./estimate-pdf-service').generateEstimatePdfForEmail;

before(async () => {
  mock.module('./estimate-pdf', {
    namedExports: {
      renderEstimatePdf: async (estimate: any, opts: any) => {
        calls.push({ estimateId: estimate.id, sentAt: opts?.sentAt ?? null });
        return Buffer.from('%PDF-1.4 stub');
      },
    },
  });
  ({ generateEstimatePdfForEmail } = await import('./estimate-pdf-service'));
});

after(() => {
  mock.reset();
});

const storageStub = {
  getEstimate: async (id: number) => ({
    id,
    estimateNumber: 'EST-00001',
    companyId: null,
    approvalSentAt: new Date('2026-07-01T00:00:00Z'),
    estimateDate: new Date('2026-06-01T00:00:00Z'),
    items: [],
  }),
  getCompany: async () => null,
} as unknown as import('./storage').IStorage;

describe('generateEstimatePdfForEmail — pending send time (Task #1955)', () => {
  it('forwards the pending send time to the renderer', async () => {
    calls.length = 0;
    const sentAt = new Date('2026-08-27T15:00:00Z');
    const result = await generateEstimatePdfForEmail(storageStub, 7, { sentAt });
    assert.ok(result, 'expected a PDF result');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].estimateId, 7);
    assert.deepEqual(calls[0].sentAt, sentAt);
  });

  it('passes no override when the caller is not mid-send', async () => {
    calls.length = 0;
    await generateEstimatePdfForEmail(storageStub, 7);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sentAt, null);
  });
});
