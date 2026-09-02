/**
 * pdf-cover-header.test.ts
 *
 * Tests for Invoice PDF Slice 1152:
 *   Part A — colored cover brand band + below-band invoice block
 *   Part B — fixed job-type colors on reconciliation summary
 *
 * Task #1192 — Slice D (executive summary cover page):
 *   Part C — total card / stat counts, conditional photos line, logo binding
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coverPage, buildFullCSS, JOB_TYPE_COLORS, reconciliationPage } from './pdf-helpers';
import { DEFAULT_BRAND_COLORS } from './pdf-view-model';
import type { PdfViewModel } from './pdf-view-model';
import { resolveLogoToFetchableUrl } from './invoice-pdf-service';

// ── Minimal PdfViewModel fixture ──────────────────────────────────────────────

function makeVm(overrides: {
  logoDataUri?: string | null;
  companyName?: string;
  navy?: string;
  invoiceNumber?: string;
  totals?: Partial<PdfViewModel['totals']>;
  workOrders?: PdfViewModel['workOrders'];
  billingSheets?: PdfViewModel['billingSheets'];
  wetCheckBillings?: PdfViewModel['wetCheckBillings'];
  customerHasBranches?: boolean;
  branchSubtotals?: PdfViewModel['branchSubtotals'];
} = {}): PdfViewModel {
  const navy = overrides.navy ?? '#1E5A99';
  return {
    company: {
      name: overrides.companyName ?? 'Test Company',
      logo: '',
      logoDataUri: overrides.logoDataUri ?? null,
      address: '123 Main St',
      phone: '555-1234',
      email: 'info@test.com',
    },
    invoice: {
      invoiceNumber: overrides.invoiceNumber ?? 'INV-00001',
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      generatedAt: new Date('2026-06-01'),
      customerName: 'Acme Corp',
      customerEmail: 'acme@example.com',
      customerPhone: '555-9999',
    },
    workOrders: overrides.workOrders ?? [],
    billingSheets: overrides.billingSheets ?? [],
    wetCheckBillings: overrides.wetCheckBillings ?? [],
    totals: {
      grandTotal: 0,
      laborSubtotal: 0,
      partsSubtotal: 0,
      storedTotalAmount: 0,
      ...(overrides.totals ?? {}),
    },
    totalJobs: 0,
    validationWarning: null,
    brandColors: {
      ...DEFAULT_BRAND_COLORS,
      navy,
    },
    customerHasBranches: overrides.customerHasBranches ?? false,
    branchSubtotals: overrides.branchSubtotals ?? [],
  } as unknown as PdfViewModel;
}

// ── Part A: Cover brand band ──────────────────────────────────────────────────

describe('coverPage — brand band (Part A)', () => {
  it('renders cover-brand-band with inline background matching navy brand color', () => {
    const html = coverPage(makeVm({ navy: '#123456' }));
    assert.ok(
      html.includes('cover-brand-band'),
      'Expected cover-brand-band class in output',
    );
    assert.ok(
      html.includes('background:#123456'),
      'Expected inline background style to match navy color #123456',
    );
  });

  it('renders logo tile with src when logoDataUri is present', () => {
    const html = coverPage(makeVm({ logoDataUri: 'data:image/png;base64,AAA' }));
    assert.ok(
      html.includes('cover-logo-tile'),
      'Expected cover-logo-tile class when logo is present',
    );
    assert.ok(
      html.includes('src="data:image/png;base64,AAA"'),
      'Expected img src to contain the logo data URI',
    );
    assert.ok(
      !html.includes('cover-logo-tile-empty'),
      'Expected cover-logo-tile-empty to be absent when logo is present',
    );
  });

  it('renders no-logo fallback tile with company initial when logoDataUri is null', () => {
    const html = coverPage(makeVm({ logoDataUri: null, companyName: 'Greenfield' }));
    assert.ok(
      html.includes('cover-logo-tile-empty'),
      'Expected cover-logo-tile-empty class for no-logo fallback',
    );
    assert.ok(
      html.includes('>G<'),
      'Expected company initial "G" inside the fallback tile',
    );
  });

  it('renders invoice number and billing period below the band', () => {
    const html = coverPage(makeVm({ invoiceNumber: 'INV-20418' }));
    assert.ok(
      html.includes('INVOICE #INV-20418'),
      'Expected "INVOICE #INV-20418" in the invoice block',
    );
    assert.ok(
      html.includes('Billing Period:'),
      'Expected "Billing Period:" label in the invoice block',
    );
  });
});

// ── Part B: Job-type colors ───────────────────────────────────────────────────

describe('JOB_TYPE_COLORS — fixed constants (Part B)', () => {
  it('exports exact job-type color values', () => {
    assert.equal(JOB_TYPE_COLORS.workOrder, '#1E5A99', 'Work Order color must be #1E5A99');
    assert.equal(JOB_TYPE_COLORS.billingSheet, '#B06820', 'Billing Sheet color must be #B06820');
    assert.equal(JOB_TYPE_COLORS.wetCheck, '#5E8C2A', 'Wet Check color must be #5E8C2A');
  });
});

describe('buildFullCSS — job-type colors in recon rules (Part B)', () => {
  it('contains .recon-type-wcb with color #5E8C2A and #B06820 for billing-sheet rules', () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    assert.ok(
      css.includes('.recon-type-wcb') && css.includes('#5E8C2A'),
      'Expected .recon-type-wcb rule with color #5E8C2A in CSS',
    );
    assert.ok(
      css.includes('#B06820'),
      'Expected #B06820 (Billing Sheet amber) to appear in CSS',
    );
  });

  it('job-type colors are unchanged when navy and green brand colors are overridden to #000000', () => {
    const css = buildFullCSS({
      ...DEFAULT_BRAND_COLORS,
      navy: '#000000',
      green: '#000000',
    });
    assert.ok(
      css.includes('#1E5A99'),
      'Expected Work Order color #1E5A99 to remain when navy is overridden',
    );
    assert.ok(
      css.includes('#B06820'),
      'Expected Billing Sheet color #B06820 to remain when navy is overridden',
    );
    assert.ok(
      css.includes('#5E8C2A'),
      'Expected Wet Check color #5E8C2A to remain when green is overridden',
    );
  });
});

describe('buildFullCSS — ticket header color classes (Task #1164)', () => {
  it('.ticket-header-wo uses JOB_TYPE_COLORS.workOrder (#1E5A99)', () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    const woRuleMatch = css.match(/\.ticket-header-wo\s*\{[^}]+\}/);
    assert.ok(woRuleMatch, 'Expected .ticket-header-wo rule in CSS');
    assert.ok(
      woRuleMatch[0].includes('#1E5A99'),
      'Expected .ticket-header-wo background to be #1E5A99',
    );
  });

  it('.ticket-header-bs uses JOB_TYPE_COLORS.billingSheet (#B06820)', () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    const bsRuleMatch = css.match(/\.ticket-header-bs\s*\{[^}]+\}/);
    assert.ok(bsRuleMatch, 'Expected .ticket-header-bs rule in CSS');
    assert.ok(
      bsRuleMatch[0].includes('#B06820'),
      'Expected .ticket-header-bs background to be #B06820',
    );
  });

  it('.ticket-header-wcb uses JOB_TYPE_COLORS.wetCheck (#5E8C2A)', () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    const wcbRuleMatch = css.match(/\.ticket-header-wcb\s*\{[^}]+\}/);
    assert.ok(wcbRuleMatch, 'Expected .ticket-header-wcb rule in CSS');
    assert.ok(
      wcbRuleMatch[0].includes('#5E8C2A'),
      'Expected .ticket-header-wcb background to be #5E8C2A',
    );
  });

  it('ticket header colors are fixed regardless of brand navy/green overrides', () => {
    const css = buildFullCSS({ ...DEFAULT_BRAND_COLORS, navy: '#000000', green: '#000000' });
    const woMatch = css.match(/\.ticket-header-wo\s*\{[^}]+\}/);
    const bsMatch = css.match(/\.ticket-header-bs\s*\{[^}]+\}/);
    const wcbMatch = css.match(/\.ticket-header-wcb\s*\{[^}]+\}/);
    assert.ok(woMatch?.[0].includes('#1E5A99'), '.ticket-header-wo must stay #1E5A99 when navy is overridden');
    assert.ok(bsMatch?.[0].includes('#B06820'), '.ticket-header-bs must stay #B06820 when navy is overridden');
    assert.ok(wcbMatch?.[0].includes('#5E8C2A'), '.ticket-header-wcb must stay #5E8C2A when green is overridden');
  });
});

// ── Part C: Executive summary cover page (Task #1192, Slice D) ───────────────

describe('coverPage — total card and stat counts (Part C)', () => {
  it('renders grand total, labor subtotal, and parts subtotal from vm.totals', () => {
    const vm = makeVm({
      totals: { grandTotal: 4875.50, laborSubtotal: 1200.00, partsSubtotal: 3675.50 },
    });
    const html = coverPage(vm);
    assert.ok(html.includes('cover-total-card'), 'Expected cover-total-card element');
    assert.ok(html.includes('$4,875.50'), 'Expected grand total $4,875.50');
    assert.ok(html.includes('$1,200.00'), 'Expected labor subtotal $1,200.00');
    assert.ok(html.includes('$3,675.50'), 'Expected parts subtotal $3,675.50');
  });

  it('renders all three stat tiles even when counts are 0', () => {
    const vm = makeVm();
    const html = coverPage(vm);
    const statMatches = html.match(/class="cover-stat"/g);
    assert.ok(statMatches !== null && statMatches.length >= 3, 'Expected at least 3 cover-stat tiles');
    assert.ok(html.includes('Billing Sheets'), 'Expected Billing Sheets tile label');
    assert.ok(html.includes('Work Orders'), 'Expected Work Orders tile label');
    assert.ok(html.includes('Wet Check Billings'), 'Expected Wet Check Billings tile label');
  });

  it('stat tile counts match the workOrders, billingSheets, and wetCheckBillings arrays', () => {
    const vm = makeVm({
      workOrders: [
        { photos: [] } as unknown as PdfViewModel['workOrders'][0],
        { photos: [] } as unknown as PdfViewModel['workOrders'][0],
      ],
      billingSheets: [
        { photos: [] } as unknown as PdfViewModel['billingSheets'][0],
      ],
      wetCheckBillings: [
        { mergedPhotoUrls: [] } as unknown as PdfViewModel['wetCheckBillings'][0],
        { mergedPhotoUrls: [] } as unknown as PdfViewModel['wetCheckBillings'][0],
        { mergedPhotoUrls: [] } as unknown as PdfViewModel['wetCheckBillings'][0],
      ],
    });
    const html = coverPage(vm);
    const stat2 = html.match(/cover-stat-count[^>]*>2</g);
    const stat1 = html.match(/cover-stat-count[^>]*>1</g);
    const stat3 = html.match(/cover-stat-count[^>]*>3</g);
    assert.ok(stat2 !== null, 'Expected a stat tile with count 2 (work orders)');
    assert.ok(stat1 !== null, 'Expected a stat tile with count 1 (billing sheets)');
    assert.ok(stat3 !== null, 'Expected a stat tile with count 3 (wet check billings)');
  });
});

describe('coverPage — conditional Work Photos item (Part C)', () => {
  it('omits Work Photos item when no job has photos', () => {
    const vm = makeVm({
      workOrders: [{ photos: [] } as unknown as PdfViewModel['workOrders'][0]],
      billingSheets: [{ photos: [] } as unknown as PdfViewModel['billingSheets'][0]],
      wetCheckBillings: [{ mergedPhotoUrls: [] } as unknown as PdfViewModel['wetCheckBillings'][0]],
    });
    const html = coverPage(vm);
    assert.ok(!html.includes('Work Photos'), 'Expected Work Photos item to be absent when no photos');
  });

  it('includes Work Photos item when a work order has photos', () => {
    const vm = makeVm({
      workOrders: [{ photos: ['http://example.com/photo.jpg'] } as unknown as PdfViewModel['workOrders'][0]],
    });
    const html = coverPage(vm);
    assert.ok(html.includes('Work Photos'), 'Expected Work Photos item when a work order has photos');
  });

  it('includes Work Photos item when a billing sheet has photos', () => {
    const vm = makeVm({
      billingSheets: [{ photos: ['http://example.com/photo.jpg'] } as unknown as PdfViewModel['billingSheets'][0]],
    });
    const html = coverPage(vm);
    assert.ok(html.includes('Work Photos'), 'Expected Work Photos item when a billing sheet has photos');
  });

  it('includes Work Photos item when a WCB has mergedPhotoUrls', () => {
    const vm = makeVm({
      wetCheckBillings: [{
        mergedPhotoUrls: ['http://example.com/photo.jpg'],
      } as unknown as PdfViewModel['wetCheckBillings'][0]],
    });
    const html = coverPage(vm);
    assert.ok(html.includes('Work Photos'), 'Expected Work Photos item when a WCB has mergedPhotoUrls');
  });
});

describe('coverPage — logo binding (Part C)', () => {
  it('resolveLogoToFetchableUrl maps company-logos/<uuid> to /api/company-logo/<uuid>', () => {
    const uuid = 'abc123-def456';
    const storedPath = `company-logos/${uuid}`;
    const resolved = resolveLogoToFetchableUrl(storedPath);
    assert.ok(
      resolved.includes(`/api/company-logo/${uuid}`),
      `Expected resolved URL to contain /api/company-logo/${uuid}, got: ${resolved}`,
    );
  });

  it('resolveLogoToFetchableUrl handles /api/company-logo/<uuid> path stored by older clients', () => {
    // Some paths may be stored in the DB as /api/company-logo/<uuid> (API-relative)
    const uuid = 'xyz789';
    const storedPath = `/api/company-logo/${uuid}`;
    const resolved = resolveLogoToFetchableUrl(storedPath);
    assert.ok(
      resolved.includes(`/api/company-logo/${uuid}`),
      `Expected /api/company-logo/${uuid} to resolve correctly, got: ${resolved}`,
    );
  });

  it('renders img src when logoDataUri is provided (cover logo tile)', () => {
    const html = coverPage(makeVm({ logoDataUri: 'data:image/png;base64,XYZ' }));
    assert.ok(html.includes('src="data:image/png;base64,XYZ"'), 'Expected logo img src in cover page output');
    assert.ok(!html.includes('cover-logo-tile-empty'), 'Expected no empty fallback tile when logoDataUri is set');
  });
});

// ── Task #1302: transparent logo tile + page-1 fit ───────────────────────────

describe('buildFullCSS — logo tile transparency (Task #1302)', () => {
  it('.cover-logo-tile has no background:white (populated tile is fully transparent)', () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    const tileMatch = css.match(/\.cover-logo-tile\s*\{[^}]+\}/);
    assert.ok(tileMatch, 'Expected .cover-logo-tile rule in CSS');
    assert.ok(
      !tileMatch[0].includes('background: white') && !tileMatch[0].includes('background:white'),
      '.cover-logo-tile must not contain "background: white" — the populated tile should be transparent',
    );
  });

  it('.cover-logo-tile-empty has a contrasting light-plate background (fallback still legible)', () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    const emptyMatch = css.match(/\.cover-logo-tile-empty\s*\{[^}]+\}/);
    assert.ok(emptyMatch, 'Expected .cover-logo-tile-empty rule in CSS');
    assert.ok(
      emptyMatch[0].includes('rgba(255,255,255,0.15)'),
      '.cover-logo-tile-empty must have rgba(255,255,255,0.15) background for legibility on the navy band',
    );
  });
});

describe('reconciliation pagination protection (Task #1967)', () => {
  it('protects the totals card and bordered rows with modern and legacy print-break rules', () => {
    const css = buildFullCSS(DEFAULT_BRAND_COLORS);
    const totalsBoxRule = css.match(/\.recon-totals-box\s*\{[^}]+\}/)?.[0];
    const bodyRowRule = css.match(/\.recon-table tbody tr\s*\{[^}]+\}/)?.[0];
    const grandTotalRule = css.match(/\.recon-grand-total\s*\{[^}]+\}/)?.[0];

    assert.ok(totalsBoxRule, 'Expected .recon-totals-box rule in CSS');
    assert.ok(bodyRowRule, 'Expected .recon-table tbody tr rule in CSS');
    assert.ok(grandTotalRule, 'Expected .recon-grand-total rule in CSS');

    assert.match(totalsBoxRule, /display:\s*inline-block/);
    assert.match(totalsBoxRule, /page-break-before:\s*avoid/);
    assert.match(totalsBoxRule, /break-before:\s*avoid-page/);
    assert.match(totalsBoxRule, /page-break-inside:\s*avoid/);
    assert.match(totalsBoxRule, /break-inside:\s*avoid/);

    for (const [name, rule] of [
      ['body row', bodyRowRule],
      ['grand-total row', grandTotalRule],
    ] as const) {
      assert.match(rule, /page-break-inside:\s*avoid/, `${name} needs the legacy inside-break guard`);
      assert.match(rule, /break-inside:\s*avoid/, `${name} needs the modern inside-break guard`);
    }
  });

  it('uses one intact totals card for both branch-grouped and flat layouts', () => {
    const branchVm = makeVm({
      customerHasBranches: true,
      branchSubtotals: [{ branchName: 'North', workOrders: [], billingSheets: [], subtotal: 0 }],
      totals: { laborSubtotal: 125, partsSubtotal: 75, grandTotal: 200 },
    });
    const flatVm = makeVm({
      totals: { laborSubtotal: 125, partsSubtotal: 75, grandTotal: 200 },
    });

    for (const [layout, vm] of [['branch-grouped', branchVm], ['flat', flatVm]] as const) {
      const html = reconciliationPage(vm);
      const cardStart = html.indexOf('<div class="recon-totals-box">');
      const cardEnd = html.lastIndexOf('</div>');
      const cardHtml = cardStart >= 0 && cardEnd > cardStart ? html.slice(cardStart, cardEnd) : '';

      assert.equal(
        (html.match(/class="recon-totals-box"/g) ?? []).length,
        1,
        `${layout} layout should emit exactly one totals card`,
      );
      assert.ok(cardHtml.includes('Total Labor'), `${layout} card should contain Total Labor`);
      assert.ok(cardHtml.includes('Total Parts'), `${layout} card should contain Total Parts`);
      assert.ok(cardHtml.includes('Invoice Total'), `${layout} card should contain Invoice Total`);
    }
  });
});
