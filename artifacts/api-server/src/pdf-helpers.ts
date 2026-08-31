import type {
  PdfViewModel,
  PdfCompanyHeader,
  PdfInvoiceHeader,
  PdfWorkOrderRow,
  PdfBillingSheetRow,
  PdfWetCheckBillingRow,
  PdfTotals,
  PdfBrandColors,
} from './pdf-view-model';
import { DEFAULT_BRAND_COLORS } from './pdf-view-model';
import type { WetCheckBillingView, WcvZone } from './wet-check-billing-view';
import { VRT_LOGO_DATA_URI } from './assets/vrt-logo';
import { IRRIGOPRO_LOGO_DATA_URI } from './assets/irrigopro-logo';
import { WATERMARK_DATA_URI } from './assets/watermark';
import { JOB_TYPE_COLORS, type JobTypeKey } from '@workspace/shared';
import { escapeHtml } from './pdf-escape';
import {
  buildPdfSiteMetadata,
  pdfControllerZoneText,
  pdfLineItemZoneLabel,
  type PdfSiteMetadata,
} from './pdf-site-metadata';
export { JOB_TYPE_COLORS, type JobTypeKey };

/**
 * Task #843 — Resolved (data-URI) version of PdfWcbZonePhotoGroup.
 * Built in pdf-generator.ts after photo URLs are converted to base64 data URIs.
 */
export interface WcbZonePhotoGroupResolved {
  zoneLabel: string;
  /** Data URIs for photos attached at the zone level (no finding link). */
  zonePhotoDataUris: string[];
  /** Data URIs for photos linked to a specific finding. */
  findingGroups: Array<{
    findingId: number;
    issueDisplayLabel: string;
    photoDataUris: string[];
  }>;
}

export const FAILED_PHOTO_SENTINEL = '__PHOTO_UNAVAILABLE__';

export function formatWorkSummaryAsBullets(text: string | null | undefined): string {
  if (!text || text.trim().length === 0) return '';
  const trimmed = text.trim();

  const lines = trimmed.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length > 1) {
    const items = lines.map(l => `<li>${l}</li>`).join('');
    return `<ul class="work-bullet-list">${items}</ul>`;
  }

  const paragraphs = trimmed.split(/\n\n+/);
  if (paragraphs.length > 1) {
    const items = paragraphs.map(p => `<li>${p.trim().replace(/\n/g, ' ')}</li>`).join('');
    return `<ul class="work-bullet-list">${items}</ul>`;
  }

  if (trimmed.length > 200) {
    const sentences = trimmed
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (sentences.length > 1) {
      const items = sentences.map(s => `<li>${s}</li>`).join('');
      return `<ul class="work-bullet-list">${items}</ul>`;
    }
  }

  return `<ul class="work-bullet-list"><li>${trimmed}</li></ul>`;
}

export function formatWorkSummary(text: string | null | undefined): string {
  if (!text || text.trim().length === 0) return '';
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n\n+/);
  if (paragraphs.length > 1) {
    return paragraphs
      .map(p => `<p style="margin: 0 0 8px 0;">${p.trim().replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  if (trimmed.length > 300 && !trimmed.includes('\n')) {
    const sentences = trimmed
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (sentences.length > 1) {
      const items = sentences.map(s => `<li style="margin-bottom: 4px;">${s}</li>`).join('');
      return `<ul style="margin: 0; padding-left: 18px; list-style-type: disc;">${items}</ul>`;
    }
  }
  return `<p style="margin: 0;">${trimmed.replace(/\n/g, '<br>')}</p>`;
}

export async function fetchLogoAsBase64(logoUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(logoUrl, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`[PDF] Logo fetch returned non-OK status ${response.status} for URL: ${logoUrl}`);
      return null;
    }
    const contentType = response.headers.get('content-type') || 'image/png';
    const mimeType = contentType.split(';')[0].trim();
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.warn(`[PDF] Failed to fetch logo from ${logoUrl}:`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function coverPage(
  vm: PdfViewModel
): string {
  const { company, invoice, customerHasBranches, branchSubtotals, totals, workOrders, billingSheets, wetCheckBillings } = vm;
  const navy = vm.brandColors.navy;

  // ── Brand band (Task #1163 — unchanged) ─────────────────────────────────
  const logoTile = company.logoDataUri
    ? `<div class="cover-logo-tile"><img src="${company.logoDataUri}" class="cover-logo" alt="${company.name}"></div>`
    : `<div class="cover-logo-tile cover-logo-tile-empty">${company.name?.charAt(0) || '?'}</div>`;

  // ── Branch summary block (unchanged) ────────────────────────────────────
  const branchSummaryHtml = (customerHasBranches && branchSubtotals.length > 0)
    ? (() => {
        const rows = branchSubtotals.map(group => {
          const ticketCount = group.workOrders.length + group.billingSheets.length;
          return `
            <tr>
              <td class="cover-breakdown-type">${group.branchName}</td>
              <td class="cover-breakdown-count">${ticketCount}</td>
              <td class="cover-breakdown-total">${formatCurrency(group.subtotal)}</td>
            </tr>`;
        }).join('');
        return `
        <div class="cover-breakdown">
          <div class="cover-breakdown-heading">Per-Branch Summary</div>
          <table class="cover-breakdown-table">
            <thead>
              <tr>
                <th>Branch</th>
                <th class="cover-breakdown-count">Tickets</th>
                <th class="cover-breakdown-total">Subtotal</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      })()
    : '';

  // ── Executive summary content ────────────────────────────────────────────

  // Computed figures (all from vm — nothing hardcoded)
  const woCount = workOrders.length;
  const bsCount = billingSheets.length;
  const wcbCount = wetCheckBillings.length;
  const totalJobs = woCount + bsCount + wcbCount;

  // Detect any attached photos for the conditional "Work Photos" included item
  const hasPhotos =
    workOrders.some(wo => wo.photos && wo.photos.length > 0) ||
    billingSheets.some(bs => bs.photos && bs.photos.length > 0) ||
    wetCheckBillings.some(wcb => {
      const urls = wcb.mergedPhotoUrls ?? wcb.photoUrls ?? [];
      return urls.length > 0;
    });

  // Watermark: large droplet logo at low opacity, lower-right, behind content
  const watermarkHtml = WATERMARK_DATA_URI
    ? `<img src="${WATERMARK_DATA_URI}" class="cover-watermark" alt="">`
    : '';

  // Stat tiles using JOB_TYPE_COLORS
  const statTiles = [
    { label: 'Billing Sheets',      count: bsCount,  color: JOB_TYPE_COLORS.billingSheet },
    { label: 'Work Orders',         count: woCount,  color: JOB_TYPE_COLORS.workOrder },
    { label: 'Wet Check Billings',  count: wcbCount, color: JOB_TYPE_COLORS.wetCheck },
  ].map(({ label, count, color }) => `
    <div class="cover-stat">
      <div class="cover-stat-count" style="color:${color};">${count}</div>
      <div class="cover-stat-label">${label}</div>
    </div>`).join('');

  // What's Included list (photos item conditional)
  const photosItem = hasPhotos
    ? `<li><strong>Work Photos</strong> — site and field photos attached to completed tickets</li>`
    : '';

  // ── Standalone invoice cover (Task #1809) ───────────────────────────────
  // Single-ticket invoice: no stat tiles, no branch summary, no exec summary.
  if (invoice.billingType === 'standalone') {
    // Service date: periodStart equals the ticket work date
    const serviceDate = formatDate(invoice.periodStart);
    return `
  <div class="cover-page">
    ${watermarkHtml}

    <div class="cover-brand-band" style="background:${navy};">
      ${logoTile}
      <div class="cover-brand-company">
        <div class="cover-brand-name">${company.name}</div>
        ${company.address ? `<div class="cover-brand-line">${company.address}</div>` : ''}
        ${company.phone ? `<div class="cover-brand-line">${company.phone}</div>` : ''}
        ${company.email ? `<div class="cover-brand-line">${company.email}</div>` : ''}
      </div>
    </div>

    <div class="cover-title-block">
      <div class="cover-doc-title">Service Invoice</div>
      <div class="cover-subtitle">Service documentation for ${invoice.customerName}</div>
      <div class="cover-meta-row">
        <span class="cover-billing-period">Service Date: ${serviceDate}</span>
        <span class="cover-invoice-chip">INVOICE #${invoice.invoiceNumber}</span>
      </div>
      <div class="cover-prepared-for">Prepared for: <strong>${invoice.customerName}</strong></div>
    </div>

    <div class="cover-total-card">
      <div class="cover-total-card-header">Invoice Total</div>
      <div class="cover-total-card-amount">${formatCurrency(totals.grandTotal)}</div>
      <div class="cover-total-card-breakdown">
        <div class="cover-total-card-sub">
          <span class="cover-total-card-sub-label">Labor</span>
          <span class="cover-total-card-sub-value">${formatCurrency(totals.laborSubtotal)}</span>
        </div>
        <div class="cover-total-card-sep"></div>
        <div class="cover-total-card-sub">
          <span class="cover-total-card-sub-label">Parts</span>
          <span class="cover-total-card-sub-value">${formatCurrency(totals.partsSubtotal)}</span>
        </div>
      </div>
    </div>

    <div class="cover-included">
      <div class="cover-included-heading">What\u2019s Included</div>
      <ol class="cover-included-list">
        <li><strong>Service Ticket Detail</strong> — technician notes, parts, and labor for this service visit</li>
        ${photosItem}
      </ol>
    </div>
  </div>`;
  }

  return `
  <div class="cover-page">
    ${watermarkHtml}

    <div class="cover-brand-band" style="background:${navy};">
      ${logoTile}
      <div class="cover-brand-company">
        <div class="cover-brand-name">${company.name}</div>
        ${company.address ? `<div class="cover-brand-line">${company.address}</div>` : ''}
        ${company.phone ? `<div class="cover-brand-line">${company.phone}</div>` : ''}
        ${company.email ? `<div class="cover-brand-line">${company.email}</div>` : ''}
      </div>
    </div>

    <div class="cover-title-block">
      <div class="cover-doc-title">Irrigation Billing Detail</div>
      <div class="cover-subtitle">Monthly service documentation for ${invoice.customerName}</div>
      <div class="cover-meta-row">
        <span class="cover-billing-period">Billing Period: ${formatDate(invoice.periodStart)} \u2013 ${formatDate(invoice.periodEnd)}</span>
        <span class="cover-invoice-chip">INVOICE #${invoice.invoiceNumber}</span>
      </div>
      <div class="cover-prepared-for">Prepared for: <strong>${invoice.customerName}</strong></div>
    </div>

    <div class="cover-total-card">
      <div class="cover-total-card-header">Invoice Total</div>
      <div class="cover-total-card-amount">${formatCurrency(totals.grandTotal)}</div>
      <div class="cover-total-card-breakdown">
        <div class="cover-total-card-sub">
          <span class="cover-total-card-sub-label">Labor</span>
          <span class="cover-total-card-sub-value">${formatCurrency(totals.laborSubtotal)}</span>
        </div>
        <div class="cover-total-card-sep"></div>
        <div class="cover-total-card-sub">
          <span class="cover-total-card-sub-label">Parts</span>
          <span class="cover-total-card-sub-value">${formatCurrency(totals.partsSubtotal)}</span>
        </div>
        <div class="cover-total-card-sep"></div>
        <div class="cover-total-card-sub">
          <span class="cover-total-card-sub-label">Jobs</span>
          <span class="cover-total-card-sub-value">${totalJobs}</span>
        </div>
      </div>
    </div>

    <div class="cover-stat-grid">
      ${statTiles}
    </div>

    <div class="cover-included">
      <div class="cover-included-heading">What\u2019s Included</div>
      <ol class="cover-included-list">
        <li><strong>Reconciliation Summary</strong> — line-item breakdown of all charges for this billing period</li>
        <li><strong>Billing Sheet Detail</strong> — technician notes, parts, and labor for each service ticket</li>
        ${photosItem}
      </ol>
    </div>

    <div class="cover-howto">
      <div class="cover-howto-heading">How to Review</div>
      <p class="cover-howto-body">Start with the <strong>Reconciliation Summary</strong> on the next page for a quick overview of all charges. Then turn to the <strong>Billing Sheet Detail</strong> pages for full technician notes and parts used on each visit.${hasPhotos ? ' Site photos follow each ticket where available.' : ''} Contact us with any questions before your payment due date.</p>
    </div>

    ${branchSummaryHtml}
  </div>`;
}

/**
 * Task #1959 — the work-site block in a ticket header.
 *
 * The address is the field a customer scans for first on a printed ticket, so
 * it renders as its own emphasized block rather than as another small metadata
 * line. The dropped pin sits beneath it when coordinates were captured.
 *
 * Returns '' when there is neither an address nor a pin, so a ticket with no
 * site data renders no empty container and no orphan label.
 */
function ticketSiteBlock(site: PdfSiteMetadata, locationSuffix?: string | null): string {
  const locationText = [site.location, locationSuffix].filter(Boolean).join(' — ');
  const pin = site.pin;
  if (!locationText && !pin) return '';

  const addressHtml = locationText
    ? `<div class="ticket-site-address">&#128205; ${escapeHtml(locationText)}</div>`
    : '';
  const pinHtml = pin
    ? `<div class="ticket-site-pin">Pin ${escapeHtml(pin.coordinates)} &nbsp;&middot;&nbsp; <a href="${escapeHtml(pin.mapUrl)}">Open in Maps</a></div>`
    : '';

  return `<div class="ticket-site-block">${addressHtml}${pinHtml}</div>`;
}

export function ticketPageWO(wo: PdfWorkOrderRow, invoiceNumber: string, photoDataUris: string[], logoDataUri?: string | null, companyName?: string): string {
  const workText = wo.aiDetailedDescription || wo.workSummary || wo.workDescription;
  const workBullets = workText
    ? `<div class="ticket-section">
         <div class="ticket-section-label">WORK PERFORMED</div>
         <div class="ticket-work-list">${formatWorkSummaryAsBullets(workText)}</div>
       </div>`
    : '';

  const failedPhotoCount = photoDataUris.filter(u => u === FAILED_PHOTO_SENTINEL).length;
  const photoFailWarning = failedPhotoCount > 0
    ? `<div class="ticket-photo-fail-warning">
         &#9888; Warning: ${failedPhotoCount} photo${failedPhotoCount > 1 ? 's' : ''} could not be loaded and ${failedPhotoCount > 1 ? 'were' : 'was'} omitted from this PDF.
       </div>`
    : '';

  // Task #1959 — clock/zone are recorded per line item far more often than on
  // the parent work order, so merge both sources. One distinct value still
  // reads singular; several read as a multi-zone summary.
  const site = buildPdfSiteMetadata({
    locationCandidates: [wo.workLocationAddress, wo.projectAddress],
    branch: wo.branchName,
    controllerLabel: wo.controllerLetter,
    zoneNumber: wo.zoneNumber,
    controllerLabels: (wo.items ?? []).map(item => item.controllerLetter),
    zoneNumbers: (wo.items ?? []).map(item => item.zoneNumber),
    latitude: wo.workLocationLat,
    longitude: wo.workLocationLng,
  });
  const siteBlock = ticketSiteBlock(site, wo.locationNotes);
  const branchLine = site.branch
    ? `<div class="ticket-header-branch">&#127970; Branch: ${escapeHtml(site.branch)}</div>`
    : '';
  const clockZoneText = pdfControllerZoneText(site);
  const clockZoneLine = clockZoneText
    ? `<div class="ticket-header-branch">&#128336; ${escapeHtml(clockZoneText)}</div>`
    : '';

  const logoHtml = logoDataUri
    ? `<img src="${logoDataUri}" class="ticket-header-logo" alt="Company logo">`
    : companyName
      ? `<div class="ticket-header-company-name">${companyName}</div>`
      : '';

  return `
  <div class="ticket-page ticket-type-wo">
    <div class="ticket-header ticket-header-wo">
      <div class="ticket-header-condensed">
        ${logoHtml}
        <div class="ticket-header-line1">Work Order #${wo.workOrderNumber} &nbsp;|&nbsp; Invoice #${invoiceNumber}</div>
        <div class="ticket-header-line2">Date: ${wo.completedAt ? formatDate(wo.completedAt) : 'N/A'} &nbsp;|&nbsp; Technician: ${wo.technicianName} &nbsp;|&nbsp; Hours: ${wo.totalHours} hrs</div>
        ${siteBlock}
        ${branchLine}
        ${clockZoneLine}
      </div>
    </div>

    ${workBullets}

    <div class="ticket-section ticket-financial">
      <div class="ticket-section-label">FINANCIAL BREAKDOWN</div>
      <div class="ticket-fin-rows">
        <div class="ticket-fin-row">
          <span class="ticket-fin-label">Labor (${wo.totalHours} hrs × ${formatCurrency(wo.laborRate)}/hr)</span>
          <span class="ticket-fin-value">${formatCurrency(wo.laborSubtotal)}</span>
        </div>
        <div class="ticket-fin-row">
          <span class="ticket-fin-label">Parts Subtotal</span>
          <span class="ticket-fin-value">${formatCurrency(wo.partsSubtotal)}</span>
        </div>
        <div class="ticket-fin-row ticket-fin-total">
          <span class="ticket-fin-label">TOTAL</span>
          <span class="ticket-fin-value">${formatCurrency(wo.rowTotal)}</span>
        </div>
      </div>
    </div>

    ${partsTableFromWO(wo.items, site.zone)}

    ${photoFailWarning}
    ${photoGridSection(photoDataUris)}
  </div>`;
}

export function ticketPageBS(bs: PdfBillingSheetRow, invoiceNumber: string, photoDataUris: string[], logoDataUri?: string | null, companyName?: string, brandColors: PdfBrandColors = DEFAULT_BRAND_COLORS): string {
  // WORK PERFORMED is customer-facing. Source ONLY from technician-authored
  // fields (`aiDetailedDescription` then `workDescription`) — never from
  // `bs.notes`, which holds internal manager notes and historically also
  // accumulated `[timestamp] Auto-repriced …` audit lines from the catalog
  // and labor-rate audit jobs (Task #210).
  const workText = bs.aiDetailedDescription || bs.workDescription;
  const workBullets = workText
    ? `<div class="ticket-section">
         <div class="ticket-section-label">WORK PERFORMED</div>
         <div class="ticket-work-list">${formatWorkSummaryAsBullets(workText)}</div>
       </div>`
    : '';

  const failedPhotoCountBS = photoDataUris.filter(u => u === FAILED_PHOTO_SENTINEL).length;
  const photoFailWarningBS = failedPhotoCountBS > 0
    ? `<div class="ticket-photo-fail-warning">
         &#9888; Warning: ${failedPhotoCountBS} photo${failedPhotoCountBS > 1 ? 's' : ''} could not be loaded and ${failedPhotoCountBS > 1 ? 'were' : 'was'} omitted from this PDF.
       </div>`
    : '';

  const bsLogoHtml = logoDataUri
    ? `<img src="${logoDataUri}" class="ticket-header-logo" alt="Company logo">`
    : companyName
      ? `<div class="ticket-header-company-name">${companyName}</div>`
      : '';

  // Task #1959 — billing sheet line items carry no clock/zone columns at all;
  // for wet-check-backed sheets the real values live on the inspected zone
  // records that already drive the Repairs Summary below.
  const bsWetCheckZones = bs.wetCheckView?.zones ?? [];
  const bsSite = buildPdfSiteMetadata({
    locationCandidates: [bs.workLocationAddress, bs.propertyAddress],
    branch: bs.branchName,
    controllerLabel: bs.controllerLetter,
    zoneNumber: bs.zoneNumber,
    controllerLabels: bsWetCheckZones.map(zone => zone.controllerLetter),
    zoneNumbers: bsWetCheckZones.map(zone => zone.zoneNumber),
    latitude: bs.workLocationLat,
    longitude: bs.workLocationLng,
  });
  const bsSiteBlock = ticketSiteBlock(bsSite);
  const bsClockZoneText = pdfControllerZoneText(bsSite);
  const bsClockZoneLine = bsClockZoneText
    ? `<div class="ticket-header-branch">&#128336; ${escapeHtml(bsClockZoneText)}</div>`
    : '';

  return `
  <div class="ticket-page ticket-type-bs">
    <div class="ticket-header ticket-header-bs">
      <div class="ticket-header-condensed">
        ${bsLogoHtml}
        <div class="ticket-header-line1">Billing Sheet #${bs.billingNumber} &nbsp;|&nbsp; Invoice #${invoiceNumber}</div>
        <div class="ticket-header-line2">Date: ${formatDate(bs.workDate)} &nbsp;|&nbsp; Technician: ${bs.technicianName} &nbsp;|&nbsp; Hours: ${bs.totalHours} hrs</div>
        ${bsSiteBlock}
        ${bsSite.branch ? `<div class="ticket-header-branch">&#127970; Branch: ${escapeHtml(bsSite.branch)}</div>` : ''}
        ${bsClockZoneLine}
      </div>
    </div>

    ${workBullets}

    <div class="ticket-section ticket-financial">
      <div class="ticket-section-label">FINANCIAL BREAKDOWN</div>
      <div class="ticket-fin-rows">
        <div class="ticket-fin-row">
          <span class="ticket-fin-label">Irrigation Labor (${bs.totalHours} hrs × ${formatCurrency(bs.laborRate)}/hr)</span>
          <span class="ticket-fin-value">${formatCurrency(bs.laborSubtotal)}</span>
        </div>
        <div class="ticket-fin-row">
          <span class="ticket-fin-label">Parts Subtotal</span>
          <span class="ticket-fin-value">${formatCurrency(bs.partsSubtotal)}</span>
        </div>
        <div class="ticket-fin-row ticket-fin-total">
          <span class="ticket-fin-label">TOTAL</span>
          <span class="ticket-fin-value">${formatCurrency(bs.rowTotal)}</span>
        </div>
      </div>
    </div>

    ${bs.wetCheckView
      ? partsBlockForWetCheckBS(bs.wetCheckView, brandColors, undefined, bs.laborRate)
      : partsTableFromBS(bs.items)}

    ${photoFailWarningBS}
    ${photoGridSection(photoDataUris)}
  </div>`;
}

/**
 * Task #787 (WC Separate System Slice 2) — ticket page for a wet_check_billings
 * row. Header fields come from `row.wetCheckBilling`; the body is the zone-
 * grouped Repairs Summary from `partsBlockForWetCheckBS(row.wetCheckView)`;
 * the financial section uses the same single "Irrigation Labor" pattern as
 * `ticketPageBS` (post-Task #766).
 *
 * Task #843 — when `zonePhotoGroups` is provided, photos are rendered inline
 * under each zone block instead of in a flat gallery at the bottom.
 */
export function ticketPageWCB(
  row: PdfWetCheckBillingRow,
  invoiceNumber: string,
  photoDataUris: string[],
  logoDataUri?: string | null,
  companyName?: string,
  brandColors: PdfBrandColors = DEFAULT_BRAND_COLORS,
  zonePhotoGroups?: WcbZonePhotoGroupResolved[],
): string {
  const { wetCheckBilling: wcb, wetCheckView: view } = row;
  // Task #1959 — clock/zone were previously never passed in here, so these
  // lines could not render at all regardless of the data. They come from the
  // inspected zone records, the same source as the Repairs Summary body.
  const wcbSite = buildPdfSiteMetadata({
    locationCandidates: [wcb.propertyAddress, view.inspection.propertyAddress],
    branch: wcb.branchName,
    controllerLabels: (view.zones ?? []).map(zone => zone.controllerLetter),
    zoneNumbers: (view.zones ?? []).map(zone => zone.zoneNumber),
    // No pin here: wet_check_billings carries no coordinate columns.
  });
  const wcbSiteBlock = ticketSiteBlock(wcbSite);
  const wcbClockZoneText = pdfControllerZoneText(wcbSite);
  const wcbClockZoneLine = wcbClockZoneText
    ? `<div class="ticket-header-branch">&#128336; ${escapeHtml(wcbClockZoneText)}</div>`
    : '';

  const totalHours = parseFloat(String(wcb.totalHours || '0'));
  const laborRate = parseFloat(String(wcb.appliedLaborRate || wcb.laborRate || '0'));
  const laborSubtotal = parseFloat(String(wcb.laborSubtotal || '0'));
  const partsSubtotal = parseFloat(String(wcb.partsSubtotal || '0'));
  const rowTotal = parseFloat(String(wcb.totalAmount || '0'));

  const failedPhotoCount = photoDataUris.filter(u => u === FAILED_PHOTO_SENTINEL).length;
  const photoFailWarning = failedPhotoCount > 0
    ? `<div class="ticket-photo-fail-warning">
         &#9888; Warning: ${failedPhotoCount} photo${failedPhotoCount > 1 ? 's' : ''} could not be loaded and ${failedPhotoCount > 1 ? 'were' : 'was'} omitted from this PDF.
       </div>`
    : '';

  const wcbLogoHtml = logoDataUri
    ? `<img src="${logoDataUri}" class="ticket-header-logo" alt="Company logo">`
    : companyName
      ? `<div class="ticket-header-company-name">${companyName}</div>`
      : '';

  // Task #843: when grouped photos are available, embed them per-zone;
  // otherwise fall back to the flat gallery at the bottom.
  const hasZonePhotos = Array.isArray(zonePhotoGroups) && zonePhotoGroups.length > 0;
  const partsBlock = hasZonePhotos
    ? partsBlockForWetCheckBS(view, brandColors, zonePhotoGroups, laborRate)
    : partsBlockForWetCheckBS(view, brandColors, undefined, laborRate);

  const bottomPhotoSection = hasZonePhotos
    ? ''  // photos are already embedded per-zone
    : photoGridSection(photoDataUris);

  return `
  <div class="ticket-page ticket-type-wcb">
    <div class="ticket-header ticket-header-wcb">
      <div class="ticket-header-condensed">
        ${wcbLogoHtml}
        <div class="ticket-header-line1">WC Billing #${wcb.billingNumber} &nbsp;|&nbsp; Invoice #${invoiceNumber}</div>
        <div class="ticket-header-line2">Date: ${formatDate(new Date(wcb.workDate))} &nbsp;|&nbsp; Technician: ${wcb.technicianName} &nbsp;|&nbsp; Hours: ${totalHours} hrs</div>
        ${wcbSiteBlock}
        ${wcbSite.branch ? `<div class="ticket-header-branch">&#127970; Branch: ${escapeHtml(wcbSite.branch)}</div>` : ''}
        ${wcbClockZoneLine}
      </div>
    </div>

    <div class="ticket-section ticket-financial">
      <div class="ticket-section-label">FINANCIAL BREAKDOWN</div>
      <div class="ticket-fin-rows">
        <div class="ticket-fin-row">
          <span class="ticket-fin-label">Irrigation Labor (${totalHours} hrs × ${formatCurrency(laborRate)}/hr)</span>
          <span class="ticket-fin-value">${formatCurrency(laborSubtotal)}</span>
        </div>
        <div class="ticket-fin-row">
          <span class="ticket-fin-label">Parts Subtotal</span>
          <span class="ticket-fin-value">${formatCurrency(partsSubtotal)}</span>
        </div>
        <div class="ticket-fin-row ticket-fin-total">
          <span class="ticket-fin-label">TOTAL</span>
          <span class="ticket-fin-value">${formatCurrency(rowTotal)}</span>
        </div>
      </div>
    </div>

    ${partsBlock}

    ${photoFailWarning}
    ${bottomPhotoSection}
  </div>`;
}

/**
 * Render a small 3-column photo grid for a set of data URIs.
 * Used inline within zone blocks when grouped photo data is available.
 */
function inlinePhotoGrid(dataUris: string[], label?: string): string {
  const valid = dataUris.filter(u => u && u !== FAILED_PHOTO_SENTINEL);
  if (valid.length === 0) return '';

  const COLS = 3;
  const cells = valid.map(uri =>
    `<div class="photo-cell"><img src="${uri}" alt="Zone photo" class="photo-img"></div>`,
  );
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += COLS) {
    const slice = cells.slice(i, i + COLS);
    while (slice.length < COLS) slice.push(`<div class="photo-cell photo-empty"></div>`);
    rows.push(`<div class="photo-row">${slice.join('')}</div>`);
  }

  const headerHtml = label
    ? `<div class="zone-photo-label">${label}</div>`
    : '';

  return `<div class="zone-photo-section">${headerHtml}<div class="photo-grid">${rows.join('')}</div></div>`;
}

/**
 * Zone-grouped parts block for billing sheets backed by a wet check inspection.
 * Replaces the flat `partsTableFromBS` call when `bs.wetCheckView` is present.
 *
 * Suppression rule (matches task spec):
 *   - $0.00 non-labor-only items are ABSENT.
 *   - labor-only items (noPartNeeded === true) are PRESENT regardless of price.
 *
 * Task #843 — optional `zonePhotoGroups` parameter embeds photos under each
 * zone block (and per-finding within the zone) when present.
 */
export function partsBlockForWetCheckBS(
  view: WetCheckBillingView,
  colors: PdfBrandColors = DEFAULT_BRAND_COLORS,
  zonePhotoGroups?: WcbZonePhotoGroupResolved[],
  laborRate: number = 0,
): string {
  const { navy, green, gray, black, brown } = colors;

  // Build a quick lookup: zoneLabel → resolved photo group
  const photoGroupByZone = new Map<string, WcbZonePhotoGroupResolved>();
  if (zonePhotoGroups) {
    for (const g of zonePhotoGroups) {
      photoGroupByZone.set(g.zoneLabel, g);
    }
  }

  function money(s: string): string {
    return formatCurrency(parseFloat(s) || 0);
  }

  // ── Aggregated Repairs Summary rollup (Change 5a) ─────────────────────────
  // Group by issueDisplayLabel + partName, summing Qty and Parts Total.
  const rollupMap = new Map<string, {
    issueDisplayLabel: string;
    partName: string | null;
    noPartNeeded: boolean;
    qty: number;
    partsTotal: number;
  }>();
  for (const z of view.zones) {
    for (const li of z.lineItems) {
      const show = li.noPartNeeded || parseFloat(li.partsTotal) !== 0;
      if (!show) continue;
      const key = `${li.issueDisplayLabel}||${li.partName ?? ''}||${String(li.noPartNeeded)}`;
      const existing = rollupMap.get(key);
      if (existing) {
        existing.qty += li.quantity;
        existing.partsTotal += parseFloat(li.partsTotal);
      } else {
        rollupMap.set(key, {
          issueDisplayLabel: li.issueDisplayLabel,
          partName: li.partName,
          noPartNeeded: li.noPartNeeded,
          qty: li.quantity,
          partsTotal: parseFloat(li.partsTotal),
        });
      }
    }
  }

  const rollupRows = Array.from(rollupMap.values()).map(r => `
      <tr>
        <td>${r.issueDisplayLabel}</td>
        <td class="text-right">${r.noPartNeeded ? '—' : (r.partName ?? '—')}</td>
        <td class="text-right">${r.noPartNeeded ? '—' : String(r.qty)}</td>
        <td class="text-right">${r.noPartNeeded ? '—' : money(String(r.partsTotal))}</td>
      </tr>`).join('');

  const rollupRepairsTotal = Array.from(rollupMap.values()).reduce((s, r) => s + r.partsTotal, 0);
  const rollupTotalRow = `
      <tr class="zone-subtotal-row">
        <td colspan="3" style="font-weight:700;">Repairs Total</td>
        <td class="text-right" style="font-weight:700; color:${brown};">${money(String(rollupRepairsTotal))}</td>
      </tr>`;

  // Stale labor note shown under the header when zone repair_labor_hours are stale
  const staleLaborNote = view.zonesHaveStaleLaborData
    ? `<div class="zone-labor-note">&#9432; Zone labor data is pending a refresh &mdash; zone subtotals reflect parts only. Labor will appear once the wet check record is updated.</div>`
    : '';

  const repairsSummaryBlock = rollupRows
    ? `
  <div class="ticket-section ticket-parts-section">
    <div class="vrt-section-label">
      ${VRT_LOGO_DATA_URI ? `<img src="${VRT_LOGO_DATA_URI}" class="vrt-section-logo" alt="VRT">` : ''}
      <span>Repairs Summary &mdash; ${view.repairsSummary}</span>
    </div>
    ${staleLaborNote}
    <table class="items-table">
      <thead>
        <tr>
          <th>Repair Type</th>
          <th class="text-right">Part</th>
          <th class="text-right">Qty</th>
          <th class="text-right">Parts Total</th>
        </tr>
      </thead>
      <tbody>${rollupRows}${rollupTotalRow}</tbody>
    </table>
  </div>`
    : `<div class="ticket-section"><p class="no-items-msg">No repairs recorded for this wet check.</p></div>`;

  // ── Per-zone blocks ───────────────────────────────────────────────────────
  const zoneBlocks = view.zones.map((zone: WcvZone) => {
    const visibleItems = zone.lineItems.filter(
      li => li.noPartNeeded || parseFloat(li.partsTotal) !== 0,
    );

    const zoneRows = visibleItems.map(li => `
      <tr>
        <td>${li.issueDisplayLabel}${li.notes ? `<br><small class="item-note">${li.notes}</small>` : ''}</td>
        <td class="text-right">${li.noPartNeeded ? '(labor only)' : li.partName ?? '—'}</td>
        <td class="text-right">${li.noPartNeeded ? '—' : String(li.quantity)}</td>
        <td class="text-right">${li.noPartNeeded ? '—' : money(li.unitPrice)}</td>
        <td class="text-right">${li.noPartNeeded ? '—' : money(li.partsTotal)}</td>
      </tr>`).join('');

    // Per-zone labor row (Change 4) — shown only when zone labor data is fresh
    const zoneLaborAmt = laborRate * parseFloat(zone.repairLaborHours);
    const zoneSubtotalAmt = parseFloat(zone.zonePartsSubtotal) +
      (!view.zonesHaveStaleLaborData ? zoneLaborAmt : 0);

    const laborRow = !view.zonesHaveStaleLaborData
      ? `
      <tr class="zone-labor-row">
        <td colspan="4">Labor (${zone.repairLaborHours} hrs &times; ${formatCurrency(laborRate)}/hr)</td>
        <td class="text-right">${money(String(zoneLaborAmt))}</td>
      </tr>`
      : '';

    const subtotalRow = `
      <tr class="zone-subtotal-row">
        <td colspan="4" style="font-weight:700; color:${black};">Zone ${escapeHtml(zone.zoneLabel)} Subtotal</td>
        <td class="text-right" style="font-weight:700; color:${brown};">${money(String(zoneSubtotalAmt))}</td>
      </tr>`;

    // Task #843 — per-zone photo section (zone-level + per-finding)
    const photoGroup = photoGroupByZone.get(zone.zoneLabel);
    let zonePhotoHtml = '';
    if (photoGroup) {
      zonePhotoHtml += inlinePhotoGrid(photoGroup.zonePhotoDataUris);
      for (const fg of photoGroup.findingGroups) {
        if (fg.photoDataUris.length > 0) {
          zonePhotoHtml += inlinePhotoGrid(fg.photoDataUris, fg.issueDisplayLabel);
        }
      }
    }

    const zoneHeaderLabel = (zone.controllerLetter && zone.zoneNumber != null)
      ? `Clock ${escapeHtml(zone.controllerLetter)} \u00b7 Zone ${escapeHtml(zone.zoneNumber)}`
      : `Zone ${escapeHtml(zone.zoneLabel)}`;

    return `
  <div class="zone-block">
    <div class="ticket-section ticket-parts-section">
      <div class="ticket-section-label">${zoneHeaderLabel}</div>
      <table class="items-table">
        <thead>
          <tr>
            <th>Repair Type</th>
            <th class="text-right">Part</th>
            <th class="text-right">Qty</th>
            <th class="text-right">Unit Price</th>
            <th class="text-right">Parts Total</th>
          </tr>
        </thead>
        <tbody>
          ${zoneRows || '<tr><td colspan="5" class="no-items-msg">No billable items</td></tr>'}
          ${laborRow}
          ${subtotalRow}
        </tbody>
      </table>
    </div>
    ${zonePhotoHtml}
  </div>`;
  }).join('');

  return repairsSummaryBlock + zoneBlocks;
}

/**
 * Task #1959 — `ticketZoneSummary` is the ticket-level zone string. When a
 * ticket spans several zones the per-line label is what makes the table
 * readable, so it is emitted only where it adds information: a single-zone
 * ticket already says so in its header.
 */
export function partsTableFromWO(items: PdfWorkOrderRow['items'], ticketZoneSummary?: string | null): string {
  if (!items || items.length === 0) {
    return `<div class="ticket-section"><p class="no-items-msg">No parts recorded for this work order.</p></div>`;
  }
  const isMultiZoneTicket = typeof ticketZoneSummary === 'string' && ticketZoneSummary.startsWith('Zones ');
  const rows = items.map(item => {
    const zoneLabel = isMultiZoneTicket
      ? pdfLineItemZoneLabel(item.controllerLetter, item.zoneNumber)
      : null;
    const zoneTag = zoneLabel ? `<span class="item-zone-tag">${escapeHtml(zoneLabel)}</span>` : '';
    const subLines = [item.partDescription, item.notes].filter(Boolean).map(s => `<small class="item-note">${s}</small>`).join('');
    return `
      <tr>
        <td>${item.partName}${zoneTag}${subLines ? `<br>${subLines}` : ''}</td>
        <td class="text-right">${item.quantity}</td>
        <td class="text-right">${formatCurrency(item.unitPrice)}</td>
        <td class="text-right">${formatCurrency(item.rowTotal)}</td>
      </tr>`;
  }).join('');
  return `
  <div class="ticket-section ticket-parts-section">
    <div class="ticket-section-label">PARTS &amp; LABOR DETAILS</div>
    <table class="items-table">
      <thead>
        <tr>
          <th>Part Description</th>
          <th class="text-right">Qty</th>
          <th class="text-right">Unit Price</th>
          <th class="text-right">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

export function partsTableFromBS(items: PdfBillingSheetRow['items']): string {
  if (!items || items.length === 0) {
    return `<div class="ticket-section"><p class="no-items-msg">No parts recorded for this billing sheet.</p></div>`;
  }
  const rows = items.map(item => {
    // Only emit partDescription / notes as sub-lines when they differ from partName
    const extras = [
      item.partDescription && item.partDescription !== item.partName ? item.partDescription : null,
      item.notes ?? null,
    ].filter(Boolean).map(s => `<small class="item-note">${s}</small>`).join('');
    return `
      <tr>
        <td>${item.partName}${extras ? `<br>${extras}` : ''}</td>
        <td class="text-right">${item.quantity}</td>
        <td class="text-right">${formatCurrency(item.unitPrice)}</td>
        <td class="text-right">${formatCurrency(item.rowTotal)}</td>
      </tr>`;
  }).join('');
  return `
  <div class="ticket-section ticket-parts-section">
    <div class="ticket-section-label">PARTS &amp; LABOR DETAILS</div>
    <table class="items-table">
      <thead>
        <tr>
          <th>Part Description</th>
          <th class="text-right">Qty</th>
          <th class="text-right">Unit Price</th>
          <th class="text-right">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

export function photoGridSection(dataUris: string[]): string {
  const validUris = dataUris.filter(uri => uri !== FAILED_PHOTO_SENTINEL);

  if (!dataUris || dataUris.length === 0 || validUris.length === 0) {
    return `
    <div class="ticket-section ticket-photos-section">
      <div class="ticket-section-label">WORK PHOTOS</div>
      <div class="photo-no-photos">No photos captured for this service</div>
    </div>`;
  }

  const COLS = 3;
  const cells = validUris.map(uri =>
    `<div class="photo-cell"><img src="${uri}" alt="Work photo" class="photo-img"></div>`
  );

  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += COLS) {
    const slice = cells.slice(i, i + COLS);
    while (slice.length < COLS) slice.push(`<div class="photo-cell photo-empty"></div>`);
    rows.push(`<div class="photo-row">${slice.join('')}</div>`);
  }

  return `
  <div class="ticket-section ticket-photos-section">
    <div class="ticket-section-label">WORK PHOTOS</div>
    <div class="photo-grid">${rows.join('')}</div>
  </div>`;
}

/**
 * Compact 4-column photo grid used exclusively on WCB ticket pages.
 * Thumbnails are ~110px tall (vs 160px for the standard grid) to save
 * page space on longer inspection reports.
 * Label reads "WET CHECK PHOTOS" to distinguish it from work order
 * photo sections.
 */
export function photoGridSectionWCB(dataUris: string[]): string {
  const validUris = dataUris.filter(uri => uri !== FAILED_PHOTO_SENTINEL);

  if (!dataUris || dataUris.length === 0 || validUris.length === 0) {
    return `
    <div class="ticket-section ticket-photos-section">
      <div class="ticket-section-label">WET CHECK PHOTOS</div>
      <div class="photo-no-photos">No photos captured for this inspection</div>
    </div>`;
  }

  const COLS = 4;
  const cells = validUris.map(uri =>
    `<div class="photo-cell"><img src="${uri}" alt="Wet check photo" class="photo-img-compact"></div>`
  );

  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += COLS) {
    const slice = cells.slice(i, i + COLS);
    while (slice.length < COLS) slice.push(`<div class="photo-cell photo-empty-compact"></div>`);
    rows.push(`<div class="photo-row-compact">${slice.join('')}</div>`);
  }

  return `
  <div class="ticket-section ticket-photos-section">
    <div class="ticket-section-label">WET CHECK PHOTOS</div>
    <div class="photo-grid-compact">${rows.join('')}</div>
  </div>`;
}

export function reconciliationPage(vm: PdfViewModel): string {
  const { workOrders, billingSheets, wetCheckBillings, totals, validationWarning, customerHasBranches, branchSubtotals } = vm;

  const warningRow = validationWarning ? `
    <tr class="recon-warning">
      <td colspan="3">
        <span class="recon-warning-icon">&#9888;</span>
        ${validationWarning}
      </td>
    </tr>` : '';

  // ── WCB section (shared by both branch and flat paths) ────────────────────
  const wcbList = wetCheckBillings ?? [];
  const wcbGroupTotal = wcbList.reduce(
    (s, r) => s + (parseFloat(String(r.wetCheckBilling.totalAmount || '0')) || 0),
    0,
  );
  const wcbSectionHeader = wcbList.length > 0 ? `
    <tr class="recon-group-header recon-group-wcb">
      <td colspan="3">Wet Check Billings</td>
    </tr>` : '';
  const wcbRows = wcbList.map(r => `
    <tr>
      <td class="recon-ref recon-ref-wcb">${r.wetCheckBilling.billingNumber}</td>
      <td class="recon-type recon-type-wcb">WC Billing</td>
      <td class="recon-total">${formatCurrency(parseFloat(String(r.wetCheckBilling.totalAmount || '0')) || 0)}</td>
    </tr>`).join('');
  const wcbSubtotal = wcbList.length > 0 ? `
    <tr class="recon-subtotal">
      <td colspan="2" class="recon-subtotal-label">Wet Check Billings Subtotal</td>
      <td class="recon-total">${formatCurrency(wcbGroupTotal)}</td>
    </tr>` : '';

  if (customerHasBranches && branchSubtotals.length > 0) {
    const branchBlocks = branchSubtotals.map(group => {
      const woRowsB = group.workOrders.map(wo => `
        <tr>
          <td class="recon-ref recon-ref-wo">${wo.workOrderNumber}</td>
          <td class="recon-type recon-type-wo">Work Order</td>
          <td class="recon-total">${formatCurrency(wo.rowTotal)}</td>
        </tr>`).join('');
      const bsRowsB = group.billingSheets.map(bs => `
        <tr>
          <td class="recon-ref recon-ref-bs">${bs.billingNumber}</td>
          <td class="recon-type recon-type-bs">Billing Sheet</td>
          <td class="recon-total">${formatCurrency(bs.rowTotal)}</td>
        </tr>`).join('');
      return `
        <tr class="recon-group-header recon-group-branch">
          <td colspan="3">Branch: ${group.branchName}</td>
        </tr>
        ${woRowsB}
        ${bsRowsB}
        <tr class="recon-subtotal">
          <td colspan="2" class="recon-subtotal-label">${group.branchName} Subtotal</td>
          <td class="recon-total">${formatCurrency(group.subtotal)}</td>
        </tr>`;
    }).join('');

    return `
    <div class="recon-page">
      <div class="recon-title">Invoice Reconciliation Summary</div>
      <div class="recon-subtitle">Invoice #${vm.invoice.invoiceNumber} &nbsp;·&nbsp; ${formatDate(vm.invoice.periodStart)} – ${formatDate(vm.invoice.periodEnd)}</div>

      <table class="recon-table">
        <thead>
          <tr>
            <th class="recon-ref">Reference #</th>
            <th class="recon-type">Type</th>
            <th class="recon-total">Total</th>
          </tr>
        </thead>
        <tbody>
          ${branchBlocks}
          ${wcbSectionHeader}
          ${wcbRows}
          ${wcbSubtotal}
          ${warningRow}
          <tr class="recon-grand-total">
            <td colspan="2" class="recon-grand-label">GRAND TOTAL</td>
            <td class="recon-total recon-grand-amount">${formatCurrency(totals.grandTotal)}</td>
          </tr>
        </tbody>
      </table>

      <div class="recon-totals-box">
        <div class="recon-totals-row">
          <span>Total Labor</span>
          <span>${formatCurrency(totals.laborSubtotal)}</span>
        </div>
        <div class="recon-totals-row">
          <span>Total Parts</span>
          <span>${formatCurrency(totals.partsSubtotal)}</span>
        </div>
        <div class="recon-totals-row recon-totals-grand">
          <span>Invoice Total</span>
          <span>${formatCurrency(totals.grandTotal)}</span>
        </div>
      </div>
    </div>`;
  }

  const woGroupTotal = workOrders.reduce((s, wo) => s + wo.rowTotal, 0);
  const bsGroupTotal = billingSheets.reduce((s, bs) => s + bs.rowTotal, 0);

  const woSectionHeader = workOrders.length > 0 ? `
    <tr class="recon-group-header recon-group-wo">
      <td colspan="3">Work Orders</td>
    </tr>` : '';

  const woRows = workOrders.map(wo => `
    <tr>
      <td class="recon-ref recon-ref-wo">${wo.workOrderNumber}</td>
      <td class="recon-type recon-type-wo">Work Order</td>
      <td class="recon-total">${formatCurrency(wo.rowTotal)}</td>
    </tr>`).join('');

  const woSubtotal = workOrders.length > 0 ? `
    <tr class="recon-subtotal">
      <td colspan="2" class="recon-subtotal-label">Work Orders Subtotal</td>
      <td class="recon-total">${formatCurrency(woGroupTotal)}</td>
    </tr>` : '';

  const bsSectionHeader = billingSheets.length > 0 ? `
    <tr class="recon-group-header recon-group-bs">
      <td colspan="3">Billing Sheets</td>
    </tr>` : '';

  const bsRows = billingSheets.map(bs => `
    <tr>
      <td class="recon-ref recon-ref-bs">${bs.billingNumber}</td>
      <td class="recon-type recon-type-bs">Billing Sheet</td>
      <td class="recon-total">${formatCurrency(bs.rowTotal)}</td>
    </tr>`).join('');

  const bsSubtotal = billingSheets.length > 0 ? `
    <tr class="recon-subtotal">
      <td colspan="2" class="recon-subtotal-label">Billing Sheets Subtotal</td>
      <td class="recon-total">${formatCurrency(bsGroupTotal)}</td>
    </tr>` : '';

  return `
  <div class="recon-page">
    <div class="recon-title">Invoice Reconciliation Summary</div>
    <div class="recon-subtitle">Invoice #${vm.invoice.invoiceNumber} &nbsp;·&nbsp; ${formatDate(vm.invoice.periodStart)} – ${formatDate(vm.invoice.periodEnd)}</div>

    <table class="recon-table">
      <thead>
        <tr>
          <th class="recon-ref">Reference #</th>
          <th class="recon-type">Type</th>
          <th class="recon-total">Total</th>
        </tr>
      </thead>
      <tbody>
        ${woSectionHeader}
        ${woRows}
        ${woSubtotal}
        ${bsSectionHeader}
        ${bsRows}
        ${bsSubtotal}
        ${wcbSectionHeader}
        ${wcbRows}
        ${wcbSubtotal}
        ${warningRow}
        <tr class="recon-grand-total">
          <td colspan="2" class="recon-grand-label">GRAND TOTAL</td>
          <td class="recon-total recon-grand-amount">${formatCurrency(totals.grandTotal)}</td>
        </tr>
      </tbody>
    </table>

    <div class="recon-totals-box">
      <div class="recon-totals-row">
        <span>Total Labor</span>
        <span>${formatCurrency(totals.laborSubtotal)}</span>
      </div>
      <div class="recon-totals-row">
        <span>Total Parts</span>
        <span>${formatCurrency(totals.partsSubtotal)}</span>
      </div>
      <div class="recon-totals-row recon-totals-grand">
        <span>Invoice Total</span>
        <span>${formatCurrency(totals.grandTotal)}</span>
      </div>
    </div>
  </div>`;
}


export function buildFullCSS(colors: PdfBrandColors = DEFAULT_BRAND_COLORS): string {
  const { navy, brown, green, black, gray } = colors;

  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: ${black};
    line-height: 1.5;
    background: white;
    font-size: 13px;
  }

  .container {
    max-width: 100%;
    padding: 0 20px 20px 20px;
  }

  /* ═══════════════════════════════════
     COVER PAGE
  ═══════════════════════════════════ */
  .cover-page {
    min-height: 95vh;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 24px 0 24px;
    page-break-after: always;
    break-after: page;
    page-break-inside: avoid;
    break-inside: avoid;
    overflow: hidden;
  }

  .cover-brand-band {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 20px 28px;
    border-radius: 8px;
  }

  .cover-logo-tile {
    width: 96px;
    height: 96px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .cover-logo-tile-empty {
    background: rgba(255,255,255,0.15);
    border-radius: 8px;
    overflow: hidden;
    font-size: 42px;
    font-weight: 800;
    color: white;
  }

  .cover-logo {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }

  .cover-brand-company {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cover-brand-name {
    font-size: 22px;
    font-weight: 700;
    color: white;
  }

  .cover-brand-line {
    font-size: 12px;
    color: rgba(255,255,255,0.85);
  }

  .cover-invoice-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cover-invoice-number {
    font-size: 20px;
    font-weight: 700;
    color: ${brown};
  }

  .cover-invoice-period {
    font-size: 13px;
    color: #6b7280;
  }

  .cover-bill-to {
    background: ${gray};
    border-radius: 8px;
    padding: 18px 22px;
    border-left: 4px solid ${green};
  }

  .cover-bill-to-label {
    font-size: 10px;
    font-weight: 700;
    color: ${navy};
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 6px;
  }

  .cover-bill-to-name {
    font-size: 20px;
    font-weight: 700;
    color: ${black};
    margin-bottom: 4px;
  }

  .cover-bill-to-detail {
    font-size: 13px;
    color: #4b5563;
  }

  .cover-total-block {
    background: ${navy};
    border-radius: 12px;
    padding: 32px 36px;
    text-align: center;
    color: white;
  }

  .cover-total-label {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 2px;
    opacity: 0.85;
    margin-bottom: 10px;
  }

  .cover-total-amount {
    font-size: 52px;
    font-weight: 900;
    letter-spacing: -1px;
    line-height: 1;
    margin-bottom: 10px;
    color: ${brown};
  }

  .cover-total-period {
    font-size: 13px;
    opacity: 0.75;
  }

  .cover-breakdown {
    border: 1.5px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
  }

  .cover-breakdown-heading {
    font-size: 13px;
    font-weight: 700;
    color: ${navy};
    padding: 12px 18px;
    background: ${gray};
    border-bottom: 1px solid #e5e7eb;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .cover-breakdown-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .cover-breakdown-table thead tr {
    background: ${navy};
    color: white;
  }

  .cover-breakdown-table th {
    padding: 10px 16px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    text-align: left;
  }

  .cover-breakdown-table th.cover-breakdown-count,
  .cover-breakdown-table th.cover-breakdown-amount,
  .cover-breakdown-table th.cover-breakdown-total {
    text-align: right;
  }

  .cover-breakdown-table tbody tr {
    border-bottom: 1px solid #e5e7eb;
  }

  .cover-breakdown-table td {
    padding: 12px 16px;
    color: ${black};
  }

  .cover-breakdown-type {
    font-weight: 600;
  }

  .cover-breakdown-type-wo { color: ${navy}; }
  .cover-breakdown-type-bs { color: ${navy}; }

  .cover-breakdown-count,
  .cover-breakdown-amount,
  .cover-breakdown-total {
    text-align: right;
    font-weight: 500;
  }

  .cover-breakdown-total {
    font-weight: 700;
  }

  .cover-breakdown-grand td {
    background: ${navy};
    color: white;
    font-weight: 700;
    font-size: 14px;
    padding: 14px 16px;
    border-top: 2px solid ${green};
    text-align: right;
  }

  .cover-breakdown-grand-label {
    text-align: left !important;
    font-size: 13px;
    letter-spacing: 0.5px;
  }

  .cover-breakdown-table tfoot td.cover-breakdown-type,
  .cover-breakdown-table tfoot td.cover-breakdown-count {
    text-align: left;
  }

  /* ── Executive summary cover additions (Task #1192) ── */

  .cover-watermark {
    position: absolute;
    bottom: -20px;
    right: -20px;
    width: 320px;
    height: auto;
    opacity: 0.07;
    z-index: 0;
    pointer-events: none;
    user-select: none;
  }

  .cover-title-block {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cover-doc-title {
    font-size: 30px;
    font-weight: 900;
    color: ${navy};
    letter-spacing: -0.5px;
    line-height: 1.1;
  }

  .cover-subtitle {
    font-size: 14px;
    color: #6b7280;
    font-weight: 400;
  }

  .cover-meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 4px;
  }

  .cover-billing-period {
    font-size: 13px;
    color: #374151;
    font-weight: 500;
  }

  .cover-invoice-chip {
    font-size: 11px;
    font-weight: 700;
    color: white;
    background: ${brown};
    border-radius: 20px;
    padding: 4px 12px;
    letter-spacing: 0.5px;
    white-space: nowrap;
  }

  .cover-prepared-for {
    font-size: 13px;
    color: #4b5563;
    margin-top: 2px;
  }

  .cover-total-card {
    position: relative;
    z-index: 1;
    background: ${navy};
    border-radius: 12px;
    padding: 20px 28px;
    color: white;
    border: 2px solid ${green};
  }

  .cover-total-card-header {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 2px;
    opacity: 0.8;
    margin-bottom: 8px;
  }

  .cover-total-card-amount {
    font-size: 40px;
    font-weight: 900;
    letter-spacing: -1px;
    line-height: 1;
    color: white;
    margin-bottom: 12px;
  }

  .cover-total-card-breakdown {
    display: flex;
    align-items: center;
    gap: 0;
    border-top: 1px solid rgba(255,255,255,0.2);
    padding-top: 10px;
    flex-wrap: wrap;
  }

  .cover-total-card-sub {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 80px;
  }

  .cover-total-card-sub-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    opacity: 0.7;
  }

  .cover-total-card-sub-value {
    font-size: 16px;
    font-weight: 700;
  }

  .cover-total-card-sep {
    width: 1px;
    height: 36px;
    background: rgba(255,255,255,0.2);
    margin: 0 20px;
  }

  .cover-stat-grid {
    position: relative;
    z-index: 1;
    display: flex;
    gap: 16px;
  }

  .cover-stat {
    flex: 1;
    background: ${gray};
    border-radius: 8px;
    padding: 12px 12px;
    text-align: center;
    border-top: 3px solid transparent;
  }

  .cover-stat-count {
    font-size: 30px;
    font-weight: 900;
    line-height: 1;
    margin-bottom: 4px;
  }

  .cover-stat-label {
    font-size: 11px;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .cover-included {
    position: relative;
    z-index: 1;
    border: 1.5px solid #e5e7eb;
    border-radius: 8px;
    padding: 12px 18px;
    background: white;
  }

  .cover-included-heading {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: ${navy};
    margin-bottom: 6px;
  }

  .cover-included-list {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    color: #374151;
  }

  .cover-included-list li {
    line-height: 1.4;
  }

  .cover-howto {
    position: relative;
    z-index: 1;
    background: ${gray};
    border-radius: 8px;
    padding: 12px 18px;
    border-left: 4px solid ${green};
  }

  .cover-howto-heading {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: ${navy};
    margin-bottom: 6px;
  }

  .cover-howto-body {
    font-size: 13px;
    color: #374151;
    line-height: 1.6;
    margin: 0;
  }

  /* ═══════════════════════════════════
     TICKET PAGES
  ═══════════════════════════════════ */
  .ticket-page {
    page-break-before: always;
    break-before: page;
    padding: 16px 0 20px;
  }

  .ticket-header {
    padding: 12px 16px;
    border-radius: 6px 6px 0 0;
    border-bottom: 1px solid rgba(0,0,0,0.1);
    page-break-inside: avoid;
    break-inside: avoid;
    break-after: avoid;
    page-break-after: avoid;
  }

  .ticket-header-wo {
    background: ${JOB_TYPE_COLORS.workOrder};
    color: white;
  }

  .ticket-header-bs {
    background: ${JOB_TYPE_COLORS.billingSheet};
    color: white;
  }

  .ticket-header-wcb {
    background: ${JOB_TYPE_COLORS.wetCheck};
    color: white;
  }

  .ticket-header-condensed {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .ticket-header-logo {
    max-width: 80px;
    max-height: 30px;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    margin-bottom: 4px;
  }

  .ticket-header-company-name {
    font-size: 12px;
    font-weight: 700;
    color: rgba(255,255,255,0.9);
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }

  .ticket-header-line1 {
    font-size: 14px;
    font-weight: 800;
    color: white;
    line-height: 1.2;
  }

  .ticket-header-line2 {
    font-size: 11px;
    font-weight: 500;
    color: rgba(255,255,255,0.85);
    line-height: 1.3;
  }

  /* Task #1959 — the work site reads as its own block, not as another small
     metadata line. Emphasis is the point: this is what a customer scans for. */
  .ticket-site-block {
    margin-top: 5px;
    padding: 5px 8px;
    background: rgba(255,255,255,0.15);
    border-left: 3px solid rgba(255,255,255,0.9);
    border-radius: 2px;
  }

  .ticket-site-address {
    font-size: 13px;
    font-weight: 700;
    color: #ffffff;
    line-height: 1.3;
    letter-spacing: 0.01em;
  }

  .ticket-site-pin {
    margin-top: 2px;
    font-size: 9px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: rgba(255,255,255,0.85);
    line-height: 1.3;
  }

  .ticket-site-pin a {
    color: rgba(255,255,255,0.95);
    text-decoration: underline;
  }

  .ticket-header-branch {
    font-size: 11px;
    font-weight: 600;
    color: rgba(255,255,255,0.95);
    line-height: 1.3;
    margin-top: 2px;
  }

  /* ── Ticket Sections ── */
  .ticket-section {
    border: 1px solid #e5e7eb;
    border-top: none;
    padding: 10px 14px;
  }

  .ticket-section:first-of-type {
    border-top: 1px solid #e5e7eb;
  }

  .ticket-section-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: ${navy};
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid ${green};
  }
  .ticket-type-wo .ticket-section-label { color: ${JOB_TYPE_COLORS.workOrder}; }
  .ticket-type-bs .ticket-section-label { color: ${JOB_TYPE_COLORS.billingSheet}; }
  .ticket-type-wcb .ticket-section-label { color: ${JOB_TYPE_COLORS.wetCheck}; }

  /* Work bullet list */
  .ticket-work-list {
    font-size: 12px;
    color: ${black};
  }

  .work-bullet-list {
    margin: 0;
    padding-left: 18px;
    list-style-type: disc;
  }

  .work-bullet-list li {
    margin-bottom: 3px;
    line-height: 1.4;
    color: ${black};
  }

  /* Financial breakdown */
  .ticket-financial {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .ticket-fin-rows {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .ticket-fin-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 0;
    border-bottom: 1px solid ${gray};
    font-size: 12px;
    color: ${black};
  }

  .ticket-fin-row:last-child {
    border-bottom: none;
  }

  .ticket-fin-label {
    font-weight: 500;
    color: ${black};
  }

  .ticket-fin-value {
    font-weight: 600;
    min-width: 90px;
    text-align: right;
    color: ${black};
  }

  .ticket-fin-total {
    margin-top: 4px;
    padding-top: 8px;
    border-top: 2px solid ${green} !important;
    font-size: 14px;
    font-weight: 800;
    color: ${black};
  }

  .ticket-fin-total .ticket-fin-label {
    color: ${black};
  }

  .ticket-fin-total .ticket-fin-value {
    color: ${brown};
    font-size: 16px;
  }

  /* Parts table */
  .ticket-parts-section {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .items-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .items-table thead { background: ${navy}; color: white; }
  .ticket-type-wo .items-table thead { background: ${JOB_TYPE_COLORS.workOrder}; }
  .ticket-type-bs .items-table thead { background: ${JOB_TYPE_COLORS.billingSheet}; }
  .ticket-type-wcb .items-table thead { background: ${JOB_TYPE_COLORS.wetCheck}; }
  .items-table th { padding: 7px 10px; text-align: left; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }
  .items-table th.text-right { text-align: right; }
  .items-table tbody tr { border-bottom: 1px solid #e5e7eb; }
  .items-table tbody tr:nth-child(even) { background: ${gray}; }
  .items-table td { padding: 6px 10px; color: ${black}; }
  .items-table td.text-right { text-align: right; }
  .item-note { color: #6b7280; font-size: 10px; }

  /* Task #1959 — per-line clock/zone on multi-zone work-order tickets. */
  .item-zone-tag {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 5px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #f3f4f6;
    color: #374151;
    font-size: 8.5px;
    font-weight: 600;
    white-space: nowrap;
  }
  .no-items-msg { color: #9ca3af; font-size: 11px; font-style: italic; }

  /* Photos */
  .ticket-photos-section {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .photo-no-photos {
    background: ${gray};
    border: 2px dashed #d1d5db;
    border-radius: 8px;
    padding: 28px;
    text-align: center;
    color: #9ca3af;
    font-size: 13px;
    font-style: italic;
  }

  .photo-grid { display: flex; flex-direction: column; gap: 6px; }
  .photo-row { display: flex; gap: 6px; }
  .photo-cell { flex: 1; }
  .photo-img { width: 100%; height: 160px; object-fit: cover; border-radius: 5px; border: 1px solid #e5e7eb; display: block; }
  .photo-empty { height: 160px; }

  /* Compact 4-column grid for WCB ticket pages */
  .photo-grid-compact { display: flex; flex-direction: column; gap: 5px; }
  .photo-row-compact { display: flex; gap: 5px; }
  .photo-img-compact { width: 100%; height: 110px; object-fit: cover; border-radius: 4px; border: 1px solid #e5e7eb; display: block; }
  .photo-empty-compact { height: 110px; }

  .ticket-photo-fail-warning {
    background: #fef3c7;
    border: 1px solid #f59e0b;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 12px;
    color: #92400e;
    margin-bottom: 8px;
  }

  /* ═══════════════════════════════════
     RECONCILIATION PAGE
  ═══════════════════════════════════ */
  .recon-page {
    page-break-before: always;
    break-before: page;
    padding: 32px 0 40px;
  }

  .recon-title {
    font-size: 24px;
    font-weight: 800;
    color: ${navy};
    margin-bottom: 4px;
  }

  .recon-subtitle {
    font-size: 13px;
    color: #6b7280;
    margin-bottom: 28px;
  }

  .recon-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-bottom: 24px;
  }

  .recon-table thead tr {
    background: ${navy};
    color: white;
  }

  .recon-table th {
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    text-align: left;
  }

  .recon-table th.recon-total {
    text-align: right;
  }

  .recon-table tbody tr {
    border-bottom: 1px solid #e5e7eb;
  }

  .recon-table td {
    padding: 10px 14px;
    color: ${black};
  }

  .recon-ref { font-weight: 600; }
  .recon-ref-wo { color: #1E5A99; }
  .recon-ref-bs { color: #B06820; }

  .recon-type { font-weight: 500; font-size: 12px; }
  .recon-type-wo { color: #1E5A99; }
  .recon-type-bs { color: #B06820; }

  .recon-total {
    text-align: right;
    font-weight: 600;
  }

  .recon-group-header td {
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 8px 14px;
  }

  .recon-group-wo td {
    background: #1E5A99;
    color: #ffffff;
    border-left: 4px solid rgba(0,0,0,0.18);
  }

  .recon-group-bs td {
    background: #B06820;
    color: #ffffff;
    border-left: 4px solid rgba(0,0,0,0.18);
  }

  .recon-group-branch td {
    background: ${navy};
    color: white;
    border-top: 2px solid ${green};
    font-size: 12px;
  }

  .recon-subtotal td {
    background: ${gray};
    font-weight: 700;
    font-size: 12px;
    padding: 9px 14px;
    border-top: 1px solid #d1d5db;
    border-bottom: 2px solid #d1d5db;
    color: ${black};
  }

  .recon-subtotal-label {
    font-style: italic;
  }

  .recon-warning td {
    background: #fef3c7;
    color: #92400e;
    font-size: 12px;
    font-weight: 600;
    padding: 10px 14px;
    border-top: 2px solid #fbbf24;
    border-bottom: 2px solid #fbbf24;
  }

  .recon-warning-icon {
    margin-right: 6px;
    font-size: 14px;
  }

  .recon-grand-total td {
    background: ${navy};
    color: white;
    font-weight: 800;
    font-size: 15px;
    padding: 14px 14px;
    border-top: 3px solid ${green};
  }

  .recon-grand-label {
    letter-spacing: 0.5px;
  }

  .recon-grand-amount {
    text-align: right;
    font-size: 18px;
    color: ${brown};
  }

  .recon-totals-box {
    border: 2px solid ${navy};
    border-radius: 8px;
    padding: 18px 22px;
    background: ${gray};
    max-width: 360px;
    margin-left: auto;
  }

  .recon-totals-row {
    display: flex;
    justify-content: space-between;
    padding: 7px 0;
    font-size: 14px;
    color: ${black};
    border-bottom: 1px solid #e5e7eb;
  }

  .recon-totals-row:last-child {
    border-bottom: none;
  }

  .recon-totals-grand {
    border-top: 2px solid ${green} !important;
    margin-top: 8px;
    padding-top: 12px;
    font-size: 18px;
    font-weight: 800;
    color: ${black};
  }

  .recon-totals-grand span:last-child {
    color: ${brown};
  }

  /* ═══════════════════════════════════
     PAGE NUMBERING
  ═══════════════════════════════════ */
  @page { margin: 0.5in 0.5in 0.5in 0.5in; }

  .text-right { text-align: right; }

  /* ═══════════════════════════════════
     WET CHECK ZONE BLOCKS
  ═══════════════════════════════════ */
  .zone-block {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .zone-subtotal-row td {
    background: ${gray};
    border-top: 2px solid ${green};
    border-bottom: 2px solid ${green};
    padding-top: 8px;
    padding-bottom: 8px;
  }

  /* Per-zone labor line (Change 4) */
  .zone-labor-row td {
    font-style: italic;
    color: #4b5563;
    font-size: 11px;
    background: ${gray};
  }

  /* Stale labor note under Repairs Summary header */
  .zone-labor-note {
    font-size: 11px;
    font-style: italic;
    color: #92400e;
    background: #fef3c7;
    border: 1px solid #fbbf24;
    border-radius: 4px;
    padding: 6px 10px;
    margin-bottom: 8px;
  }

  /* VRT logo header for Repairs Summary (Change 3) */
  .vrt-section-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: ${navy};
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid ${green};
  }

  .vrt-section-logo {
    max-width: 56px;
    max-height: 14px;
    width: auto;
    height: auto;
    object-fit: contain;
    display: inline-block;
    vertical-align: middle;
  }

  /* Reconciliation — Wet Check Billing rows (Change 1) */
  .recon-group-wcb td {
    background: #5E8C2A;
    color: #ffffff;
    border-left: 4px solid rgba(0,0,0,0.18);
  }

  .recon-ref-wcb { color: #5E8C2A; }
  .recon-type-wcb { color: #5E8C2A; font-style: italic; }

  /* Task #843 — inline per-zone photo grids */
  .zone-photo-section {
    margin: 6px 0 10px 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .zone-photo-label {
    font-size: 10px;
    font-weight: 600;
    color: ${navy};
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }
  `;
}
