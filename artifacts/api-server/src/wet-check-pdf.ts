import puppeteer from 'puppeteer-core';
import type { Company } from '@workspace/db';
import type { WetCheckWithDetails, WetCheckZoneRecord, WetCheckFinding } from '@workspace/db/schema';
import { resolveChromiumExecutable } from './chromium-resolver';
import { fetchLogoAsBase64 } from './pdf-generator';
import { VRT_LOGO_DATA_URI } from './assets/vrt-logo.js';
import { IRRIGOPRO_LOGO_DATA_URI } from './assets/irrigopro-logo.js';
import { resolveCompanyLogoUrl, pdfLogoBaseUrl } from './logo-url';
import { isEmptyZone } from './wet-check-zone-filter';
import { buildPdfSiteMetadata, pdfControllerZoneText } from './pdf-site-metadata';

const DEFAULT_BRAND_COLOR = '#1E5A99';
const DEFAULT_BRAND_DARK = '#143F6B';

function resolveLogoToFetchableUrl(storedLogo: string): string {
  return resolveCompanyLogoUrl(storedLogo, pdfLogoBaseUrl()) ?? storedLogo;
}

async function extractAccentFromLogo(dataUri: string): Promise<{ accent: string; accentDark: string }> {
  try {
    const { Vibrant } = await import('node-vibrant/node');
    const base64Data = dataUri.replace(/^data:image\/[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const palette = await Vibrant.from(buffer).getPalette();
    const swatch = palette.Vibrant || palette.DarkVibrant || palette.Muted;
    const darkSwatch = palette.DarkVibrant || palette.DarkMuted || swatch;
    if (!swatch) return { accent: DEFAULT_BRAND_COLOR, accentDark: DEFAULT_BRAND_DARK };
    const toHex = (s: { rgb: number[] }) =>
      '#' + s.rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    return {
      accent: toHex(swatch),
      accentDark: darkSwatch ? toHex(darkSwatch) : DEFAULT_BRAND_DARK,
    };
  } catch {
    return { accent: DEFAULT_BRAND_COLOR, accentDark: DEFAULT_BRAND_DARK };
  }
}

function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function statusLabel(status: string): string {
  switch (status) {
    case 'in_progress': return 'In Progress';
    case 'submitted': return 'Submitted';
    case 'approved': return 'Approved';
    case 'partially_converted': return 'Partially Converted';
    case 'converted': return 'Converted';
    default: return status || '—';
  }
}

function issueGroupLabel(group: string): string {
  switch (group) {
    case 'quick_fix': return 'Quick Fix';
    case 'advanced': return 'Advanced';
    case 'zone_issue': return 'Zone Issue';
    default: return group || '—';
  }
}

function resolutionLabel(resolution: string): string {
  switch (resolution) {
    case 'repaired_in_field': return 'Repaired';
    case 'pending': return 'Pending';
    case 'deferred': return 'Deferred';
    case 'no_action': return 'No Action';
    default: return resolution || '—';
  }
}

function zoneStatusLabel(status: string): string {
  switch (status) {
    case 'checked_ok': return 'OK';
    case 'checked_with_issues': return 'Issues';
    case 'not_applicable': return 'N/A';
    case 'not_checked': return 'Not Checked';
    default: return status || '—';
  }
}

function renderFindingRows(findings: WetCheckFinding[]): string {
  if (findings.length === 0) return '';
  return findings.map((f, idx) => `
    <tr class="${idx % 2 === 1 ? 'zebra' : ''}">
      <td class="finding-cell">
        <div class="issue-label">${esc(f.issueType?.replace(/_/g, ' '))}</div>
        ${f.issueGroup ? `<div class="muted">${esc(issueGroupLabel(f.issueGroup))}</div>` : ''}
      </td>
      <td>${f.partName ? esc(f.partName) : '<span class="muted">—</span>'}</td>
      <td class="r">${f.quantity ?? 1}</td>
      <td class="r">${f.laborHours ? Number(f.laborHours).toFixed(2) + 'h' : '—'}</td>
      <td class="r"><span class="status-chip ${esc(f.resolution ?? '')}">${esc(resolutionLabel(f.resolution ?? ''))}</span></td>
      <td>${f.notes ? `<span class="muted">${esc(f.notes)}</span>` : ''}</td>
    </tr>`).join('');
}

function renderZoneBlock(zone: WetCheckZoneRecord & { findings: WetCheckFinding[] }, idx: number): string {
  const statusCls = zone.status === 'checked_ok' ? 'ok'
    : zone.status === 'checked_with_issues' ? 'issues'
    : zone.status === 'not_applicable' ? 'na'
    : '';

  const ranOk = zone.ranSuccessfully === true ? 'Yes' : zone.ranSuccessfully === false ? 'No' : '—';
  const findings = zone.findings ?? [];

  return `
  <tr class="zone-row ${idx % 2 === 1 ? 'zone-alt' : ''}">
    <td class="zone-label-cell">
      <span class="zone-id">${esc(zone.controllerLetter)}-${esc(zone.zoneNumber)}</span>
    </td>
    <td><span class="status-chip ${statusCls}">${esc(zoneStatusLabel(zone.status))}</span></td>
    <td class="r">${ranOk}</td>
    <td class="r">${zone.observedPressure ? Number(zone.observedPressure).toFixed(1) : '—'}</td>
    <td class="r">${zone.observedFlow ? Number(zone.observedFlow).toFixed(1) : '—'}</td>
    <td class="r">${zone.repairLaborHours ? Number(zone.repairLaborHours).toFixed(2) + 'h' : '—'}</td>
    <td class="r">${findings.length > 0 ? findings.length : '—'}</td>
    <td>${zone.notes ? `<span class="muted">${esc(zone.notes)}</span>` : ''}</td>
  </tr>
  ${findings.length > 0 ? `
  <tr>
    <td colspan="8" class="findings-cell">
      <table class="findings-table">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Part</th>
            <th class="r">Qty</th>
            <th class="r">Labor</th>
            <th class="r">Resolution</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${renderFindingRows(findings)}
        </tbody>
      </table>
    </td>
  </tr>` : ''}`;
}

export interface WetCheckPdfOptions {
  company?: Company | null;
  logoDataUri?: string | null;
  accentColor?: string;
  accentDark?: string;
}

export function buildWetCheckHtml(
  wc: WetCheckWithDetails,
  opts: WetCheckPdfOptions = {},
): string {
  const accent = opts.accentColor || DEFAULT_BRAND_COLOR;
  const accentDark = opts.accentDark || DEFAULT_BRAND_DARK;
  const company = opts.company;
  const companyName = company?.name ?? 'IrrigoPro';
  const companyLines = [
    company?.address,
    company?.phone,
    company?.email,
  ].filter(Boolean) as string[];

  const logoBlock = opts.logoDataUri
    ? `<img src="${opts.logoDataUri}" alt="${esc(companyName)}" class="logo" />`
    : '';

  const allZoneRecords = wc.zoneRecords ?? [];
  const zoneRecords = allZoneRecords.filter(z => !isEmptyZone(z));
  const allFindings = zoneRecords.flatMap(z => z.findings ?? []);
  const totalZones = zoneRecords.length;
  const zonesOk = zoneRecords.filter(z => z.status === 'checked_ok').length;
  const zonesIssues = zoneRecords.filter(z => z.status === 'checked_with_issues').length;
  const zonesNA = zoneRecords.filter(z => z.status === 'not_applicable').length;

  const zoneRows = zoneRecords.map((zone, idx) => renderZoneBlock(zone, idx)).join('');
  const site = buildPdfSiteMetadata({
    locationCandidates: [wc.propertyAddress],
    branch: wc.branchName,
  });
  const inspectedControllers = Array.from(
    new Set(zoneRecords.map((zone) => zone.controllerLetter).filter(Boolean)),
  ).join(', ');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Wet Check #${esc(wc.id)}</title>
<style>
  @page { margin: 0.6in 0.5in 0.85in 0.5in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color: #1f2937; margin: 0; padding: 0; font-size: 11px; line-height: 1.4; }
  h1, h2, h3 { margin: 0; }

  .brand-bar { background: ${accent}; color: white; padding: 14px 18px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 16px; }
  .brand-bar .co { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand-bar .logo { max-height: 44px; max-width: 140px; background: white; padding: 4px 6px; border-radius: 4px; object-fit: contain; }
  .brand-bar .co-name { font-size: 16px; font-weight: 700; line-height: 1.2; }
  .brand-bar .co-meta { font-size: 10px; opacity: 0.92; line-height: 1.35; }
  .brand-bar .doc-meta { text-align: right; }
  .brand-bar .doc-label { font-size: 11px; letter-spacing: 0.18em; opacity: 0.85; }
  .brand-bar .doc-number { font-size: 20px; font-weight: 700; }
  .brand-bar .doc-status { display: inline-block; margin-top: 4px; font-size: 10px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.18); }

  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: ${accentDark}; border-bottom: 2px solid ${accent}; padding-bottom: 4px; margin-bottom: 10px; margin-top: 16px; }

  .meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 20px; margin-bottom: 14px; font-size: 11px; }
  .meta-item .k { color: #6b7280; text-transform: uppercase; font-size: 9px; letter-spacing: 0.06em; margin-bottom: 1px; }
  .meta-item .v { color: #111827; font-weight: 600; }

  .summary-bar { display: flex; gap: 12px; margin-bottom: 14px; }
  .summary-chip { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; text-align: center; }
  .summary-chip .num { font-size: 20px; font-weight: 700; color: ${accentDark}; }
  .summary-chip .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-top: 1px; }
  .summary-chip.ok .num { color: #16a34a; }
  .summary-chip.issues .num { color: #dc2626; }

  .notes-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; white-space: pre-wrap; font-size: 11px; }

  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 8px; text-align: left; vertical-align: top; }
  thead th { background: ${accent}; color: white; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .r { text-align: right; }
  .muted { color: #6b7280; font-size: 10px; }
  .zone-row td { border-top: 1px solid #e5e7eb; }
  .zone-alt td { background: #f8fafc; }
  .zone-label-cell { white-space: nowrap; }
  .zone-id { font-weight: 700; font-size: 12px; color: ${accentDark}; }

  .findings-cell { padding: 0 0 8px 24px; background: #f8fafc; }
  .findings-table { width: 100%; border: 1px solid #e5e7eb; border-radius: 4px; margin-top: 4px; font-size: 10px; }
  .findings-table thead th { font-size: 9px; background: ${accentDark}; }
  .findings-table td { border-bottom: 1px solid #eef0f3; padding: 4px 7px; }
  .findings-table tr:last-child td { border-bottom: none; }
  .findings-table .zebra td { background: rgba(0,0,0,0.02); }
  .issue-label { font-weight: 600; text-transform: capitalize; }
  .finding-cell { min-width: 100px; }

  .status-chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 600; }
  .status-chip.ok { background: #dcfce7; color: #166534; }
  .status-chip.issues { background: #fee2e2; color: #991b1b; }
  .status-chip.na { background: #f3f4f6; color: #6b7280; }
  .status-chip.repaired_in_field { background: #dcfce7; color: #166534; }
  .status-chip.pending { background: #fef9c3; color: #854d0e; }
  .status-chip.deferred { background: #f3f4f6; color: #374151; }
  .status-chip.no_action { background: #f3f4f6; color: #6b7280; }
</style>
</head>
<body>
  <div class="brand-bar">
    <div class="co">
      ${logoBlock}
      <div>
        <div class="co-name">${esc(companyName)}</div>
        ${companyLines.length ? `<div class="co-meta">${companyLines.map(esc).join(' · ')}</div>` : ''}
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-label">WET CHECK</div>
      <div class="doc-number">#${esc(wc.id)}</div>
      <div class="doc-status">${esc(statusLabel(wc.status))}</div>
    </div>
  </div>

  <div class="meta-grid">
    <div class="meta-item"><div class="k">Customer</div><div class="v">${esc(wc.customerName)}</div></div>
    ${site.location ? `<div class="meta-item"><div class="k">Location</div><div class="v">${esc(site.location)}</div></div>` : ''}
    ${site.branch ? `<div class="meta-item"><div class="k">Branch</div><div class="v">${esc(site.branch)}</div></div>` : ''}
    <div class="meta-item"><div class="k">Technician</div><div class="v">${esc(wc.technicianName)}</div></div>
    <div class="meta-item"><div class="k">Started</div><div class="v">${esc(fmtDate(wc.startedAt))}</div></div>
    <div class="meta-item"><div class="k">Submitted</div><div class="v">${esc(fmtDate(wc.submittedAt))}</div></div>
    <div class="meta-item"><div class="k">Approved</div><div class="v">${esc(fmtDate(wc.approvedAt))}</div></div>
    ${wc.weather ? `<div class="meta-item"><div class="k">Weather</div><div class="v">${esc(wc.weather)}</div></div>` : ''}
    <div class="meta-item"><div class="k">Inspection Labor</div><div class="v">${Number(wc.totalLaborHours || 0).toFixed(2)}h</div></div>
    <div class="meta-item"><div class="k">Controllers</div><div class="v">${esc(wc.numControllers)}</div></div>
    ${inspectedControllers ? `<div class="meta-item"><div class="k">Controller / Clock</div><div class="v">${esc(inspectedControllers.split(', ').map((letter) => pdfControllerZoneText(buildPdfSiteMetadata({ controllerLabel: letter }))!).join(', '))}</div></div>` : ''}
  </div>

  ${wc.notes ? `
  <div class="notes-card">
    <div class="muted" style="margin-bottom:4px;font-size:9px;text-transform:uppercase;letter-spacing:0.05em;">Notes</div>
    ${esc(wc.notes)}
  </div>` : ''}

  <div class="summary-bar">
    <div class="summary-chip"><div class="num">${totalZones}</div><div class="lbl">Total Zones</div></div>
    <div class="summary-chip ok"><div class="num">${zonesOk}</div><div class="lbl">Checked OK</div></div>
    <div class="summary-chip issues"><div class="num">${zonesIssues}</div><div class="lbl">With Issues</div></div>
    <div class="summary-chip"><div class="num">${zonesNA}</div><div class="lbl">N/A</div></div>
    <div class="summary-chip"><div class="num">${allFindings.length}</div><div class="lbl">Total Findings</div></div>
  </div>

  ${totalZones > 0 ? `
  <h2>Zone &amp; Findings Detail</h2>
  <table>
    <thead>
      <tr>
        <th>Zone</th>
        <th>Status</th>
        <th class="r">Ran OK</th>
        <th class="r">PSI</th>
        <th class="r">GPM</th>
        <th class="r">Repair Labor</th>
        <th class="r">Findings</th>
        <th>Notes</th>
      </tr>
    </thead>
    <tbody>
      ${zoneRows || '<tr><td colspan="8" class="muted">No zones recorded</td></tr>'}
    </tbody>
  </table>` : '<div class="muted" style="margin-top:12px;">No zone data recorded for this wet check.</div>'}

</body>
</html>`;
}

function footerTemplate(companyName: string, wetCheckId: number | null | undefined): string {
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
  <span>${esc(companyName)} &mdash; Wet Check #${esc(wetCheckId ?? '')}</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
}

export async function renderWetCheckPdf(
  wc: WetCheckWithDetails,
  opts: WetCheckPdfOptions = {},
): Promise<Buffer> {
  let logoDataUri = opts.logoDataUri ?? null;
  let accentColor = opts.accentColor;
  let accentDark = opts.accentDark;

  if (!logoDataUri && opts.company?.logo) {
    try {
      const logoUrl = resolveLogoToFetchableUrl(opts.company.logo);
      logoDataUri = await fetchLogoAsBase64(logoUrl);
    } catch {
      logoDataUri = null;
    }
  }

  if (logoDataUri && (!accentColor || !accentDark)) {
    const extracted = await extractAccentFromLogo(logoDataUri);
    accentColor = accentColor || extracted.accent;
    accentDark = accentDark || extracted.accentDark;
  }

  const html = buildWetCheckHtml(wc, {
    ...opts,
    logoDataUri,
    accentColor: accentColor || DEFAULT_BRAND_COLOR,
    accentDark: accentDark || DEFAULT_BRAND_DARK,
  });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveChromiumExecutable(),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const companyName = opts.company?.name ?? 'IrrigoPro';
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: footerTemplate(companyName, wc.id),
      margin: { top: '0.6in', right: '0.5in', bottom: '0.85in', left: '0.5in' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
