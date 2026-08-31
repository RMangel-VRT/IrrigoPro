import type { EstimateWithItems, EstimateItem, Company } from '@workspace/db';
import { FAILED_PHOTO_SENTINEL } from './pdf-helpers';
import { ESTIMATE_EXPIRATION_DAYS, estimateExpiryAnchor, formatEstimateNumber } from '@workspace/shared';
import { VRT_LOGO_DATA_URI } from './assets/vrt-logo.js';
import { IRRIGOPRO_LOGO_DATA_URI } from './assets/irrigopro-logo.js';
import { humanizeIssueType } from './inspection-issue-labels.js';
import { buildPdfSiteMetadata, pdfControllerZoneText } from './pdf-site-metadata.js';

export const DEFAULT_BRAND_COLOR = '#1E5A99';
export const DEFAULT_BRAND_DARK = '#143F6B';

export interface RenderEstimatePdfOptions {
  company?: Company | null;
  logoDataUri?: string | null;
  accentColor?: string;
  accentDark?: string;
  photoDataUris?: string[];
  // Task #1955 — the send flow renders the attached PDF *before* it
  // persists the new send timestamp (the email must succeed first), so
  // the row on disk still carries the previous send time (or none at
  // all). Callers in that flow pass the pending send time here so the
  // attached PDF's validity date matches the window the customer is
  // actually getting. Omitted everywhere else: a PDF downloaded from
  // the app reads the persisted timestamp.
  sentAt?: Date | string | null;
}

export { escapeHtml } from './pdf-escape.js';
import { escapeHtml } from './pdf-escape.js';

export function fmtMoney(value: string | number | null | undefined): string {
  const n = typeof value === 'string' ? parseFloat(value) : (value ?? 0);
  if (!Number.isFinite(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function addDays(value: Date | string | null | undefined, days: number): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d;
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'approved': return 'Approved';
    case 'rejected': return 'Rejected';
    case 'expired': return 'Expired';
    case 'converted_to_work_order': return 'Converted';
    default: return status || '—';
  }
}

export function renderItemRow(item: EstimateItem, laborRate: number, idx: number): string {
  const partPrice = parseFloat(item.partPrice) || 0;
  const quantity = item.quantity || 0;
  const laborHours = parseFloat(item.laborHours) || 0;
  const totalPrice = parseFloat(item.totalPrice) || 0;
  const lineTotal = totalPrice + laborHours * laborRate;
  return `
      <tr class="${idx % 2 === 1 ? 'zebra' : ''}">
        <td>
          <div class="part-name">${escapeHtml(item.partName)}</div>
          ${item.description ? `<div class="muted">${escapeHtml(item.description)}</div>` : ''}
        </td>
        <td class="r">${escapeHtml(quantity)}</td>
        <td class="r">${fmtMoney(partPrice)}</td>
        <td class="r">${laborHours.toFixed(2)}h</td>
        <td class="r b">${fmtMoney(lineTotal)}</td>
      </tr>`;
}

export function attachmentDisplayName(url: string): string {
  if (!url) return 'attachment';
  try {
    const u = new URL(url, 'http://placeholder.local');
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // fall through
  }
  const last = url.split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last) : url;
}

// ── Inspection-origin detection ──────────────────────────────────────────────

/**
 * Returns true when any item carries zone context — which only happens for
 * estimates generated from an Inspection wet check (Slice 1).
 */
export function isInspectionOriginEstimate(items: EstimateItem[]): boolean {
  return items.some(
    (it) => it.controllerLetter != null || it.zoneNumber != null,
  );
}

// ── Zone-grouped data structures ─────────────────────────────────────────────

interface ZoneGroup {
  controllerLetter: string;
  zoneNumber: number;
  zoneKey: string;
  zoneLabel: string;
  items: EstimateItem[];
  partsTotal: number;
  laborHrs: number;
  zoneTotal: number;
}

export function buildZoneGroups(items: EstimateItem[], laborRate: number): ZoneGroup[] {
  const groupMap = new Map<string, ZoneGroup>();

  for (const item of items) {
    const cl = item.controllerLetter ?? '';
    const zn = item.zoneNumber ?? 0;
    const key = `${cl}|${zn}`;

    let group = groupMap.get(key);
    if (!group) {
      const zoneLabel = cl && zn != null
        ? `Controller ${cl} \u00b7 Zone ${zn}`
        : cl ? `Controller ${cl}` : `Zone ${zn}`;
      group = {
        controllerLetter: cl,
        zoneNumber: zn,
        zoneKey: key,
        zoneLabel,
        items: [],
        partsTotal: 0,
        laborHrs: 0,
        zoneTotal: 0,
      };
      groupMap.set(key, group);
    }
    group.items.push(item);
    group.partsTotal += parseFloat(item.totalPrice) || 0;
    group.laborHrs += parseFloat(item.laborHours) || 0;
  }

  for (const g of groupMap.values()) {
    g.zoneTotal = g.partsTotal + g.laborHrs * laborRate;
  }

  return [...groupMap.values()].sort((a, b) => {
    const cl = a.controllerLetter.localeCompare(b.controllerLetter);
    if (cl !== 0) return cl;
    return a.zoneNumber - b.zoneNumber;
  });
}

function isLaborOnlyItem(item: EstimateItem): boolean {
  return (parseFloat(item.partPrice) || 0) === 0;
}

// ── Zone-grouped HTML sections ───────────────────────────────────────────────

function renderRepairsSummaryTable(
  groups: ZoneGroup[],
  accent: string,
  accentDark: string,
): string {
  const totalParts = groups.reduce((s, g) => s + g.partsTotal, 0);
  const totalLaborHrs = groups.reduce((s, g) => s + g.laborHrs, 0);
  const grandTotal = groups.reduce((s, g) => s + g.zoneTotal, 0);

  const rows = groups.map((g, idx) => `
      <tr class="${idx % 2 === 1 ? 'zebra' : ''}">
        <td class="summary-zone">${escapeHtml(g.zoneLabel)}</td>
        <td class="r">${g.items.length}</td>
        <td class="r">${fmtMoney(g.partsTotal)}</td>
        <td class="r">${g.laborHrs.toFixed(2)}&thinsp;hrs</td>
        <td class="r b">${fmtMoney(g.zoneTotal)}</td>
      </tr>`).join('');

  const totalsRow = `
      <tr class="summary-totals-row">
        <td><strong>Totals</strong></td>
        <td class="r"><strong>${groups.reduce((s, g) => s + g.items.length, 0)}</strong></td>
        <td class="r"><strong>${fmtMoney(totalParts)}</strong></td>
        <td class="r"><strong>${totalLaborHrs.toFixed(2)}&thinsp;hrs</strong></td>
        <td class="r b"><strong>${fmtMoney(grandTotal)}</strong></td>
      </tr>`;

  return `
  <section class="zone-summary-section">
    <h2>Repairs Summary by Zone</h2>
    <table>
      <thead>
        <tr>
          <th>Zone</th>
          <th class="r">Repairs</th>
          <th class="r">Parts</th>
          <th class="r">Labor&thinsp;hrs</th>
          <th class="r">Zone Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        ${totalsRow}
      </tbody>
    </table>
  </section>`;
}

function renderZoneDetailBlocks(
  groups: ZoneGroup[],
  laborRate: number,
  accent: string,
  accentDark: string,
): string {
  return groups.map((group) => {
    const workRows = group.items.map((item, idx) => {
      const laborOnly = isLaborOnlyItem(item);
      const issueLabel = humanizeIssueType(item.issueType);
      const partPrice = parseFloat(item.partPrice) || 0;
      const qty = item.quantity || 0;
      const partsTotal = parseFloat(item.totalPrice) || 0;

      if (laborOnly) {
        return `
      <tr class="${idx % 2 === 1 ? 'zebra' : ''}">
        <td>
          <div class="part-name">${escapeHtml(issueLabel)}</div>
          <div class="labor-only-tag">labor only</div>
        </td>
        <td class="r muted">&mdash;</td>
        <td class="r muted">&mdash;</td>
        <td class="r muted">&mdash;</td>
        <td class="r muted">&mdash;</td>
      </tr>`;
      }

      return `
      <tr class="${idx % 2 === 1 ? 'zebra' : ''}">
        <td>
          <div class="part-name">${escapeHtml(issueLabel)}</div>
          ${item.partName && item.partName !== issueLabel ? `<div class="muted part-subline">${escapeHtml(item.partName)}</div>` : ''}
        </td>
        <td class="r">${escapeHtml(qty)}</td>
        <td class="r">${fmtMoney(partPrice)}</td>
        <td class="r">${fmtMoney(partsTotal)}</td>
        <td class="r b">${fmtMoney(partsTotal)}</td>
      </tr>`;
    }).join('');

    const zoneLaborAmt = group.laborHrs * laborRate;
    const laborRow = `
      <tr class="zone-labor-row">
        <td colspan="4">Zone labor &thinsp;&middot;&thinsp; ${group.laborHrs.toFixed(2)}&thinsp;hrs &times; ${fmtMoney(laborRate)}/hr</td>
        <td class="r">${fmtMoney(zoneLaborAmt)}</td>
      </tr>`;

    const subtotalRow = `
      <tr class="zone-subtotal-row">
        <td colspan="4"><strong>${escapeHtml(group.zoneLabel)} Subtotal</strong></td>
        <td class="r b zone-subtotal-amt">${fmtMoney(group.zoneTotal)}</td>
      </tr>`;

    return `
  <div class="zone-detail-block">
    <div class="zone-block-header">
      <span class="zone-block-label">${escapeHtml(group.zoneLabel)}</span>
      <span class="zone-block-total">${fmtMoney(group.zoneTotal)}</span>
    </div>
    <table class="zone-detail-table">
      <thead>
        <tr>
          <th>Work / Finding</th>
          <th class="r">Qty</th>
          <th class="r">Unit Price</th>
          <th class="r">Parts Total</th>
          <th class="r">Zone Total</th>
        </tr>
      </thead>
      <tbody>
        ${workRows || `<tr><td colspan="5" class="muted">No items</td></tr>`}
        ${laborRow}
        ${subtotalRow}
      </tbody>
    </table>
  </div>`;
  }).join('');
}

function inspectionEstimateCss(accent: string, accentDark: string): string {
  return `
  /* ── Inspection estimate — zone-grouped styles ── */
  .lineage-banner {
    background: #f0f6ff;
    border-left: 3px solid ${accent};
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 10.5px;
    color: ${accentDark};
    margin-bottom: 14px;
  }
  .zone-summary-section {
    margin-bottom: 18px;
  }
  .zone-summary-section thead th {
    background: ${accent};
    color: white;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .summary-zone { font-weight: 600; }
  .summary-totals-row td { background: #f0f6ff; border-top: 2px solid ${accent}; }
  .zone-detail-block {
    margin-bottom: 18px;
    border: 1px solid #dce8f7;
    border-radius: 6px;
    overflow: hidden;
  }
  .zone-block-header {
    background: ${accent};
    color: white;
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .zone-block-label { font-weight: 700; font-size: 12px; letter-spacing: 0.02em; }
  .zone-block-total { font-weight: 700; font-size: 13px; }
  .zone-detail-table { width: 100%; border-collapse: collapse; }
  .zone-detail-table th, .zone-detail-table td { padding: 7px 9px; text-align: left; vertical-align: top; }
  .zone-detail-table thead th { background: ${accentDark}; color: white; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .zone-detail-table tbody td { border-bottom: 1px solid #eef0f3; }
  .zone-detail-table tbody tr.zebra td { background: #f8fafc; }
  .labor-only-tag {
    display: inline-block;
    background: #e0f2fe;
    color: #0369a1;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 999px;
    margin-top: 2px;
    text-transform: uppercase;
  }
  .part-subline { font-size: 10.5px; margin-top: 1px; }
  .zone-labor-row td { background: #f8fafc; color: #374151; font-size: 10.5px; font-style: italic; border-top: 1px dashed #d1d5db; }
  .zone-subtotal-row td { background: #f0f6ff; border-top: 2px solid ${accent}; }
  .zone-subtotal-amt { color: ${accentDark}; }
  `;
}

export function buildEstimateHtml(
  estimate: EstimateWithItems,
  opts: RenderEstimatePdfOptions = {},
): string {
  const items = estimate.items ?? [];
  const laborRate = parseFloat(estimate.laborRate) || 0;
  const accent = opts.accentColor || DEFAULT_BRAND_COLOR;
  const accentDark = opts.accentDark || DEFAULT_BRAND_DARK;

  const partsSubtotal = parseFloat(estimate.partsSubtotal) || 0;
  const laborSubtotal = parseFloat(estimate.laborSubtotal) || 0;
  const grandTotal = parseFloat(estimate.totalAmount) || (partsSubtotal + laborSubtotal);
  const totalLaborHours = parseFloat(estimate.totalLaborHours) || 0;
  const laborRateLabel = `Labor (${totalLaborHours.toFixed(2)}h \u00d7 ${fmtMoney(laborRate)}/hr)`;

  // Task #1959 — the pin is normalized by the shared site-metadata contract so
  // estimates and invoice tickets format coordinates and map links identically.
  const site = buildPdfSiteMetadata({
    locationCandidates: [estimate.workLocationAddress, estimate.projectAddress],
    branch: estimate.branchName,
    controllerLabel: estimate.controllerLetter,
    zoneNumber: estimate.zoneNumber,
    latitude: estimate.workLocationLat,
    longitude: estimate.workLocationLng,
  });
  const pin = site.pin;
  const mapLink = pin ? pin.mapUrl : '';
  const coordsText = pin ? pin.coordinates : '';

  const pinSection = pin ? `
    <section class="card pin-card">
      <h2>Pinned Work Location</h2>
       ${site.location ? `<div><span class="lbl">Location:</span> ${escapeHtml(site.location)}</div>` : ''}
      <div><span class="lbl">Coordinates:</span> <span class="mono">${escapeHtml(coordsText)}</span></div>
      <div><span class="lbl">Map link:</span> <a href="${escapeHtml(mapLink)}">${escapeHtml(mapLink)}</a></div>
       ${pdfControllerZoneText(site) ? `<div><span class="lbl">Controller / Zone:</span> ${escapeHtml(pdfControllerZoneText(site))}</div>` : ''}
    </section>` : '';

  const company = opts.company;
  const logoBlock = opts.logoDataUri
    ? `<img src="${opts.logoDataUri}" alt="${escapeHtml(company?.name ?? 'Logo')}" class="logo" />`
    : '';
  const companyName = company?.name ?? 'IrrigoPro';
  const companyLines = [
    company?.address,
    company?.phone,
    company?.email,
  ].filter(Boolean) as string[];

  // Task #1955 — the validity window runs from the date the estimate was
  // sent to the customer, matching what the app enforces. `opts.sentAt`
  // is the pending send time when this PDF is being attached to the
  // outgoing email (not yet persisted); otherwise we read the stored
  // anchor. An unsent estimate (or a row sent before send times were
  // recorded) falls back to the estimate date.
  const expirationDate = addDays(
    estimateExpiryAnchor({
      approvalSentAt: opts.sentAt ?? estimate.approvalSentAt,
      estimateDate: estimate.estimateDate,
    }) ?? estimate.estimateDate,
    ESTIMATE_EXPIRATION_DAYS,
  );
  const validityTerms =
    `This estimate is valid for ${ESTIMATE_EXPIRATION_DAYS} days from the date it was sent to you. Pricing is ` +
    'based on the scope of work above; additional findings discovered on ' +
    'site may adjust the final invoice.';

  const termsBlock = (estimate.locationNotes || estimate.accessInstructions) ? `
    <section class="card">
      <h2>Terms &amp; Notes</h2>
      ${estimate.locationNotes ? `<div><span class="lbl">Location notes:</span> ${escapeHtml(estimate.locationNotes)}</div>` : ''}
      ${estimate.accessInstructions ? `<div style="margin-top:6px;"><span class="lbl">Access:</span> ${escapeHtml(estimate.accessInstructions)}</div>` : ''}
      <div class="muted" style="margin-top:10px;">
        ${validityTerms}
      </div>
    </section>` : `
    <section class="card">
      <h2>Terms &amp; Notes</h2>
      <div class="muted">
        ${validityTerms}
      </div>
    </section>`;

  // ── Branch: inspection-origin vs. flat ──────────────────────────────────
  const isInspection = isInspectionOriginEstimate(items);

  let lineItemsSection: string;

  if (isInspection) {
    const zoneGroups = buildZoneGroups(items, laborRate);

    const originId = (estimate as unknown as Record<string, unknown>).originWetCheckId;
    const lineageBanner = originId != null
      ? `<div class="lineage-banner">From wet check: Inspection #${escapeHtml(String(originId))}</div>`
      : '';

    const summaryTable = renderRepairsSummaryTable(zoneGroups, accent, accentDark);
    const detailBlocks = renderZoneDetailBlocks(zoneGroups, laborRate, accent, accentDark);

    const totalsBlock = `
    <div class="totals-wrap">
      <div class="totals">
        <div class="row"><span>Parts Subtotal</span><span>${fmtMoney(partsSubtotal)}</span></div>
        <div class="row"><span>${escapeHtml(laborRateLabel)}</span><span>${fmtMoney(laborSubtotal)}</span></div>
        <div class="grand row"><span class="label">Grand Total</span><span>${fmtMoney(grandTotal)}</span></div>
      </div>
    </div>`;

    lineItemsSection = `
  ${lineageBanner}
  ${summaryTable}
  <section>
    <h2>Zone Detail</h2>
    ${detailBlocks}
    ${totalsBlock}
  </section>`;
  } else {
    const itemsRows = items
      .map((it, idx) => renderItemRow(it, laborRate, idx))
      .join('');

    lineItemsSection = `
  <section>
    <h2>Line Items</h2>
    <table>
      <thead>
        <tr>
          <th>Part / Description</th>
          <th class="r">Qty</th>
          <th class="r">Unit Price</th>
          <th class="r">Labor</th>
          <th class="r">Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsRows || `<tr><td colspan="5" class="muted">No line items</td></tr>`}
      </tbody>
    </table>
    <div class="totals-wrap">
      <div class="totals">
        <div class="row"><span>Parts Subtotal</span><span>${fmtMoney(partsSubtotal)}</span></div>
        <div class="row"><span>${escapeHtml(laborRateLabel)}</span><span>${fmtMoney(laborSubtotal)}</span></div>
        <div class="grand row"><span class="label">Grand Total</span><span>${fmtMoney(grandTotal)}</span></div>
      </div>
    </div>
  </section>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Estimate ${escapeHtml(formatEstimateNumber(estimate.estimateNumber))}</title>
<style>
  @page { margin: 0.6in 0.5in 0.85in 0.5in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color: #1f2937; margin: 0; padding: 0; font-size: 11.5px; line-height: 1.45; }
  h1, h2, h3 { margin: 0; }
  a { color: ${accent}; text-decoration: underline; word-break: break-all; }
  .muted { color: #6b7280; font-size: 10.5px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  /* Branded header bar */
  .brand-bar { background: ${accent}; color: white; padding: 14px 18px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 16px; }
  .brand-bar .co { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand-bar .logo { max-height: 44px; max-width: 140px; background: white; padding: 4px 6px; border-radius: 4px; object-fit: contain; }
  .brand-bar .co-name { font-size: 16px; font-weight: 700; line-height: 1.2; }
  .brand-bar .co-meta { font-size: 10.5px; opacity: 0.92; line-height: 1.35; }
  .brand-bar .doc-meta { text-align: right; }
  .brand-bar .doc-label { font-size: 11px; letter-spacing: 0.18em; opacity: 0.85; }
  .brand-bar .doc-number { font-size: 20px; font-weight: 700; }
  .brand-bar .doc-status { display: inline-block; margin-top: 4px; font-size: 10.5px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.18); }

  /* Section titles */
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: ${accentDark}; border-bottom: 2px solid ${accent}; padding-bottom: 4px; margin-bottom: 8px; }

  .meta-row { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 14px; font-size: 11px; }
  .meta-row .item .k { color: #6b7280; text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.06em; }
  .meta-row .item .v { color: #111827; font-weight: 600; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  .card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; }
  .pin-card { margin-bottom: 14px; }
  .lbl { color: #6b7280; font-weight: 600; }

  .scope { white-space: pre-wrap; }

  /* Items table */
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 7px 9px; text-align: left; vertical-align: top; }
  thead th { background: ${accent}; color: white; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  tbody td { border-bottom: 1px solid #eef0f3; }
  tbody tr.zebra td { background: #f8fafc; }
  td.r, th.r { text-align: right; }
  td.b { font-weight: 600; }
  .part-name { font-weight: 600; color: #111827; }

  /* Totals */
  .totals-wrap { display: flex; justify-content: flex-end; margin-top: 12px; }
  .totals { width: 280px; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
  .totals .row { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 11.5px; }
  .totals .row + .row { border-top: 1px solid #eef0f3; }
  .totals .grand { background: ${accentDark}; color: white; padding: 10px 12px; font-size: 13.5px; font-weight: 700; }
  .totals .grand .label { letter-spacing: 0.03em; }

  /* Photo grid (Task #666) */
  .photo-grid { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .photo-row { display: flex; gap: 6px; }
  .photo-cell { flex: 1; aspect-ratio: 1 / 1; border: 1px solid #e5e7eb; border-radius: 4px; overflow: hidden; background: #f8fafc; display: flex; align-items: center; justify-content: center; }
  .photo-cell.empty { border-style: dashed; background: transparent; }
  .photo-cell img { width: 100%; height: 100%; object-fit: cover; }

  /* Attachments list (Task #666) */
  .att-list { margin: 0; padding-left: 18px; }
  .att-list li { margin: 2px 0; }
  .att-name { color: #111827; word-break: break-all; }

  /* Signature */
  .sig { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 22px; }
  .sig .block { border-top: 1px solid #9ca3af; padding-top: 4px; }
  .sig .lbl-sm { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; }
  .sig .name { font-size: 11.5px; color: #111827; margin-top: 2px; }

  ${inspectionEstimateCss(accent, accentDark)}
</style>
</head>
<body>
  <div class="brand-bar">
    <div class="co">
      ${logoBlock}
      <div>
        <div class="co-name">${escapeHtml(companyName)}</div>
        ${companyLines.length ? `<div class="co-meta">${companyLines.map(escapeHtml).join(' \u00b7 ')}</div>` : ''}
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-label">ESTIMATE</div>
      <div class="doc-number">${escapeHtml(formatEstimateNumber(estimate.estimateNumber))}</div>
      <div class="doc-status">${escapeHtml(statusLabel(estimate.status))}</div>
    </div>
  </div>

  <div class="meta-row">
    <div class="item"><div class="k">Estimate Date</div><div class="v">${escapeHtml(fmtDate(estimate.estimateDate))}</div></div>
    <div class="item"><div class="k">Valid Until</div><div class="v">${escapeHtml(fmtDate(expirationDate))}</div></div>
    <div class="item"><div class="k">Project</div><div class="v">${escapeHtml(estimate.projectName)}</div></div>
    ${estimate.createdBy ? `<div class="item"><div class="k">Prepared By</div><div class="v">${escapeHtml(estimate.createdBy)}</div></div>` : ''}
  </div>

  <div class="grid">
    <section class="card">
      <h2>Bill To</h2>
      <div class="part-name">${escapeHtml(estimate.customerName)}</div>
      ${estimate.customerEmail ? `<div class="muted">${escapeHtml(estimate.customerEmail)}</div>` : ''}
      ${estimate.customerPhone ? `<div class="muted">${escapeHtml(estimate.customerPhone)}</div>` : ''}
    </section>
    <section class="card">
      <h2>Project / Work Site</h2>
      <div class="part-name">${escapeHtml(estimate.projectName)}</div>
      ${site.location ? `<div class="muted">${escapeHtml(site.location)}</div>` : ''}
      ${site.branch ? `<div class="muted">Branch: ${escapeHtml(site.branch)}</div>` : ''}
      ${pdfControllerZoneText(site) ? `<div class="muted">${escapeHtml(pdfControllerZoneText(site))}</div>` : ''}
    </section>
  </div>

  ${estimate.workDescription ? `
  <section class="card" style="margin-bottom: 14px;">
    <h2>Scope of Work</h2>
    <div class="scope">${escapeHtml(estimate.workDescription)}</div>
  </section>` : ''}

  ${pinSection}

  ${lineItemsSection}

  ${(() => {
    const photoUris = (opts.photoDataUris ?? []).filter(
      (u) => u && u !== FAILED_PHOTO_SENTINEL,
    );
    if (photoUris.length === 0) return '';
    const COLS = 3;
    const cells = photoUris.map(
      (uri) => `<div class="photo-cell"><img src="${uri}" alt="Site photo" /></div>`,
    );
    const rows: string[] = [];
    for (let i = 0; i < cells.length; i += COLS) {
      const slice = cells.slice(i, i + COLS);
      while (slice.length < COLS) slice.push('<div class="photo-cell empty"></div>');
      rows.push(`<div class="photo-row">${slice.join('')}</div>`);
    }
    return `
  <section style="margin-top: 14px;">
    <h2>Site Photos</h2>
    <div class="photo-grid">${rows.join('')}</div>
  </section>`;
  })()}

  ${(() => {
    const atts = estimate.attachments ?? [];
    if (!atts || atts.length === 0) return '';
    const rows = atts
      .map((url) => {
        const name = attachmentDisplayName(url);
        return `<li><span class="att-name">${escapeHtml(name)}</span></li>`;
      })
      .join('');
    return `
  <section class="card" style="margin-top: 14px;">
    <h2>Attachments</h2>
    <ul class="att-list">${rows}</ul>
  </section>`;
  })()}

  ${termsBlock}

  ${(() => {
    // Task #1513 — Render a "Approved By" signature block when the estimate
    // has a stored approval signature. Drawn signatures are embedded as a PNG
    // data URI; typed names render in a script font. The block appears
    // whenever approvalSignatureData is present; unsigned estimates fall
    // through to the blank approval lines below.
    const sigData = estimate.approvalSignatureData;
    const sigType = estimate.approvalSignatureType;
    const signerName = estimate.approvalSignerName;
    const signedAt = estimate.approvalSignedAt;
    const signerIp = estimate.approvalSignerIp;
    const consentText = estimate.approvalConsentText;

    if (sigData) {
      const signedDate = signedAt ? fmtDate(signedAt instanceof Date ? signedAt : new Date(signedAt as string)) : '';
      const sigDisplay = sigType === 'drawn'
        ? `<img src="${escapeHtml(sigData)}" alt="Customer signature" style="max-height:60px;max-width:280px;display:block;margin-bottom:4px;" />`
        : `<div style="font-family:'Dancing Script',cursive,serif;font-size:22px;color:#111827;margin-bottom:4px;">${escapeHtml(sigData)}</div>`;
      return `
  <section class="card" style="margin-top: 18px; background: #f0fdf4; border-color: #86efac;">
    <h2 style="color: #15803d; border-color: #22c55e;">Approved By</h2>
    <div style="display:flex;gap:32px;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;">
        <div class="lbl-sm" style="margin-bottom:4px;">Signature</div>
        ${sigDisplay}
        ${signerName ? `<div class="lbl-sm" style="margin-top:6px;">Signed by</div><div class="name">${escapeHtml(signerName)}</div>` : ''}
        ${signedDate ? `<div class="muted" style="margin-top:2px;">Date: ${escapeHtml(signedDate)}</div>` : ''}
        ${signerIp ? `<div class="muted">IP: ${escapeHtml(signerIp)}</div>` : ''}
      </div>
      ${consentText ? `<div style="flex:2;min-width:200px;">
        <div class="lbl-sm" style="margin-bottom:4px;">Consent Statement</div>
        <div class="muted" style="font-size:9.5px;line-height:1.5;">${escapeHtml(consentText)}</div>
      </div>` : ''}
    </div>
  </section>`;
    }

    // Fallback: blank approval lines for unsigned / internal estimates
    return `
  <div class="sig">
    <div class="block">
      <div class="lbl-sm">Customer Approval</div>
      <div class="name">Signature &amp; Date</div>
    </div>
    <div class="block">
      <div class="lbl-sm">Prepared By</div>
      <div class="name">${escapeHtml(estimate.createdBy || companyName)}</div>
    </div>
  </div>`;
  })()}

</body>
</html>`;
}

export function footerTemplate(companyName: string, estimateNumber: string): string {
  const vrtLogoHtml = VRT_LOGO_DATA_URI
    ? `<img src="${VRT_LOGO_DATA_URI}" style="height:16px;" alt="VRT Sync" />`
    : `<span style="color:#9ca3af;">VRT Sync</span>`;
  const irrigoLogoHtml = IRRIGOPRO_LOGO_DATA_URI
    ? `<img src="${IRRIGOPRO_LOGO_DATA_URI}" style="height:14px;" alt="IrrigoPro" />`
    : '';
  return `
<div style="width:100%; font-size:8.5px; color:#9ca3af; padding:0 0.5in; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; display:flex; justify-content:space-between; align-items:center; box-sizing:border-box;">
  <div style="display:flex;align-items:center;gap:6px;">
    ${irrigoLogoHtml}
    <span style="color:#9ca3af;font-size:8.5px;">Powered by</span>
    ${vrtLogoHtml}
  </div>
  <span>${escapeHtml(companyName)} &mdash; Estimate ${escapeHtml(formatEstimateNumber(estimateNumber))}</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
}
